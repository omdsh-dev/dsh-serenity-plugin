/**
 * session.ts — session 真实 DSH 工具定义（defineTool）
 *
 * AGENT_SESSIONS/ 全周期管理：list/show/create/use/close/health/qa/archive/summary。
 * 行为对齐 osp（opencode-serenity-plugin/src/session/session-tool.ts）——osp 是 ACC 工具 spec：
 *   - create：--desc <desc> [--goal <goal>] 或 --issue <id>（二选一）
 *   - close：需 --confirm 防误关
 *   - archive：name 可缺省（批量归档）
 *   - hook-develop-guide 子命令 + CCC session-tool MSM 扩展提示（extHint）
 * CCC 扩展采用 osp 的"钩子后处理"模型（create-transform），而非整命令委派。
 * 活跃会话跟踪：写内存 Map（.dsh/active-sessions/<scope> 语义）+ events 恢复（S134）。
 *
 * v1.21 F3（用户逻辑修正）：SESSION 是对话过程中创建的——**use 激活宁静号会话时，
 * 同步把当前 dsh 会话重命名为该 SESSION 目录名**（sessionTitle.rename，user source
 * pin 住标题）。非创建时预命名。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from 'cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '../json.js'
import { join } from 'node:path'
import { findSerenityRoot } from '../ccc.js'
import { loadMsmEntries, runMsmAsync, type MsmEntry } from '../msm-ops.js'
import {
  listSessions,
  showSession,
  createSession,
  useSession,
  closeSession,
  archiveSessions,
  healthCheck,
  summarize,
  qaCheck,
  SESSION_ACTIONS,
  DEFAULT_SESSION_SCOPE,
  getActiveSessionInfo,
  type ActiveSessionInfo,
  type CreateSessionResult,
} from '../session-ops.js'

function agentCwd(exec: { agent?: { session?: { header?: { cwd?: string } } } }): string {
  return exec.agent?.session?.header?.cwd ?? process.cwd()
}

/** 当前 dsh 会话 id（use/close 按会话隔离的 scope） */
function agentScope(exec: { agent?: { session?: { id?: string } } }): string {
  return exec.agent?.session?.id ?? DEFAULT_SESSION_SCOPE
}

// ── v1.21 F3：use 后重命名当前 dsh 会话（纯逻辑，可单测）──
// v1.27.1：**永远开启**（S142 用户拍板"开关下掉，永远开启"）——命名是固定行为，
// 移除 naming.enabled 简单配置开关；仅剩 sessionTitle 服务可用性守卫。

export interface RenameOnUseDeps {
  /** sessionTitle 服务可用性 */
  sessionTitleAvailable: boolean
}

/**
 * 从激活会话派生命名标题（v1.22.9 格式修正）：
 * F3 原始需求是 **`S###-日期`**（如 `S143-2026-08-26`）——从 `sessionId` 派生，
 * 而非完整目录名（`2026-08-24--S142--...` 超长 + 中文，不符合用户拍板格式）。
 * 无 S### 编号（issue 会话等）→ 回退目录名。
 * @returns `S143-2026-08-26` 或原目录名
 */
export function namingTitleFor(active: ActiveSessionInfo): string {
  const sid = active.sessionId
  if (typeof sid === 'string' && /^S\d+$/.test(sid)) {
    const date = active.dirName.match(/^(\d{4}-\d{2}-\d{2})--/)?.[1] ?? ''
    if (date) return `${sid}-${date}`
    return sid
  }
  return active.dirName
}

/**
 * use 激活宁静号会话后，把当前 dsh 会话重命名为命名标题（`S###-日期`）。
 * v1.27.1：**永远开启**（不再有 naming.enabled 门控）——仅 sessionTitle 服务
 * 存在性守卫；失败不静默——返回结果对象而非 null（v1.22.9），调用方决定可见性。
 *
 * v1.23.2 修复（this 绑定）：第三参从**解构的裸 rename 函数**改为**整个
 * sessionTitle 服务对象**——内部以 `titles.rename(session, title)` **方法调用**
 * （this = titles 服务实例）。旧实现调用点 `const rename = titles.rename` 解构
 * 后传入，方法内部读 `this.assertServiceActive` → this=undefined 抛错
 * （日志实证：`Cannot read properties of undefined (reading 'assertServiceActive')`；
 * 与 v1.20.2/1.20.3 图片落盘同款解构丢 this bug）。
 * @returns { title, ok } 或 { ok:false, reason }（未执行/失败均返回对象）
 */
export function renameDshSessionOnUse(
  deps: RenameOnUseDeps,
  session: unknown,
  titles: { rename: (session: unknown, title: string) => unknown } | undefined,
  active: ActiveSessionInfo,
): { ok: true; title: string } | { ok: false; reason: string } {
  if (!deps.sessionTitleAvailable) return { ok: false, reason: 'sessionTitle service unavailable' }
  if (!titles || typeof titles.rename !== 'function') return { ok: false, reason: 'sessionTitle service unavailable' }
  const title = namingTitleFor(active)
  try {
    titles.rename(session, title)
    return { ok: true, title }
  } catch (error) {
    return { ok: false, reason: `rename threw: ${String((error as Error)?.message ?? error)}` }
  }
}

/**
 * 从 create 结果构造命名用 ActiveSessionInfo（v1.25.11，S142 用户：create 也要命名）：
 * createSession 返回的 result 已含 sessionId（S###/issue）与 dirName——无需等待 use 激活，
 * 直接构造（mdPath = sessionPath/SESSION.md，与 use 时一致）即可驱动 renameDshSessionOnUse。
 */
export function activeInfoFromCreate(result: CreateSessionResult): ActiveSessionInfo {
  return {
    sessionId: result.sessionId,
    dirName: result.dirName,
    mdPath: join(result.sessionPath, 'SESSION.md'),
  }
}

/**
 * 把当前 dsh 会话重命名为指定 SESSION 的命名标题（use/create 共用；v1.25.11）。
 * 门控/失败可见性与 renameDshSessionOnUse 一致（不静默：成功 log / 失败 warn）。
 * 调用点（use 分支原内联逻辑提取，create 分支复用）：
 *   - use：激活后从 activeStore 取 info
 *   - create：createSession 结果经 activeInfoFromCreate 构造 info
 */
export function renameDshSessionForActive(
  ctx: Context,
  exec: { agent?: { session?: unknown } },
  info: ActiveSessionInfo,
): void {
  try {
    // v1.23.2：传整个 sessionTitle 服务对象（不解构 rename 函数）——
    // 旧实现 `titles.rename` 解构后传裸函数，方法内部 this=undefined 抛错
    const titles = (ctx as unknown as { get?: (name: string) => unknown }).get?.('sessionTitle')
    const dshSession = exec.agent?.session
    if (!dshSession) {
      console.warn(`[serenity-hooks] dsh 会话重命名未执行: 缺少 agent session（info: ${info.sessionId}）`)
      return
    }
    const result = renameDshSessionOnUse(
      { sessionTitleAvailable: true },
      dshSession,
      titles as { rename: (session: unknown, title: string) => unknown } | undefined,
      info,
    )
    if (result.ok) {
      console.log(`[serenity-hooks] dsh 会话已重命名: ${String((dshSession as { id?: string }).id ?? '?')} → ${result.title}`)
    } else {
      console.warn(`[serenity-hooks] dsh 会话重命名未执行: ${result.reason}`)
    }
  } catch (err) {
    // 主流程仍完成（create/use 已执行）；仅重命名失败需要可见
    console.warn(`[serenity-hooks] dsh 会话重命名异常: ${String((err as Error)?.message ?? err)}`)
  }
}

function renderText(value: unknown): ContentBlock[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

// ── CCC session-tool MSM 扩展发现（对齐 osp discoverCccHooks/discoverCccSubcommands）──

/** 从 flags 中查找 name 匹配的 flag，仅在 new-style 对象上检查 */
function findFlagByName(
  flags: MsmEntry['flags'] | undefined, name: string,
): { description?: string } | undefined {
  if (!flags) return undefined
  for (const f of flags) {
    if ('name' in f && f.name === name) return f
  }
  return undefined
}

/** 从 CCC 的 session-tool MSM flags 中提取支持的钩子名列表 */
function discoverCccHooks(entries: MsmEntry[]): string[] {
  const msm = entries.find((e) => e.name === 'session-tool')
  const hookFlag = findFlagByName(msm?.flags, 'hook')
  if (!hookFlag?.description) return []
  return hookFlag.description.split('|').map((s) => s.trim()).filter(Boolean)
}

/** 从 CCC 的 session-tool MSM flags 中提取自定义子命令清单 */
function discoverCccSubcommands(entries: MsmEntry[]): string[] {
  const msm = entries.find((e) => e.name === 'session-tool')
  const subFlag = findFlagByName(msm?.flags, 'subcommand')
  if (!subFlag?.description) return []
  return subFlag.description.split('|').map((s) => s.trim()).filter(Boolean)
}

/** 生成扩展提示（对齐 osp buildExtHint） */
function buildExtHint(hasSessionTool: boolean, hooks: string[], subcommands: string[]): string {
  if (!hasSessionTool) {
    return '\n\n[CCC] To extend session capabilities, register a session-tool MSM (acc_msm register); see session hook-develop-guide'
  }
  const parts: string[] = []
  if (hooks.length > 0) parts.push(`hooks: ${hooks.join(', ')}`)
  if (subcommands.length > 0) parts.push(`custom subcommands (acc_msm exec session-tool): ${subcommands.join(', ')}`)
  const detail = parts.length > 0 ? ` (${parts.join('; ')})` : ''
  return `\n\n[CCC] session-tool MSM registered${detail}`
}

/** hook-develop-guide 内容（对齐 osp getHookDevelopGuide） */
function getHookDevelopGuide(hasSessionTool: boolean): string {
  return [
    '═══ Session Extension Protocol (SEP) v1 — Developer Guide ═══',
    '',
    'A CCC can extend the ACC session tool by registering a session-tool MSM,',
    'without modifying plugin code. ACC behavior is never reduced — the CCC only',
    'does post-processing after ACC completes.',
    '',
    '── Extension point 1: Post-processing hooks ──',
    '',
    'After certain ACC subcommands complete, ACC checks whether the CCC\'s',
    'session-tool MSM has registered a matching hook. If so, ACC invokes the MSM',
    'for post-processing.',
    '',
    'Available hooks:',
    '',
    '  create-transform',
    '    Trigger: after create writes the default SESSION.md',
    '    Invocation: acc_msm exec session-tool --hook=create-transform --session-dir=<path>',
    '    Allowed: read SESSION.md and modify it in place (append fields, swap templates, call APIs, etc.)',
    '    Note: ACC has already ensured the directory and SESSION.md exist; the CCC only modifies',
    '',
    '── Extension point 2: Custom subcommands ──',
    '',
    'The LLM can call acc_msm exec session-tool <subcommand> to run CCC-specific',
    'subcommands such as reindex, export, batch-create. These bypass the ACC session',
    'tool\'s enum.',
    '',
    '── How to register a session-tool MSM ──',
    '',
    '1. Write the script under the CCC skills directory:',
    '     .opencode/skills/<ccc-name>/scripts/session-tool.ts',
    '',
    '2. Register it in mech-registry.json:',
    '     acc_msm register session-tool \\',
    '       --skill <ccc-name> --path .opencode/skills/<ccc-name>/scripts/session-tool.ts \\',
    '       --category semi-mech \\',
    '       --description "CCC session extension: hooks + custom subcommands" \\',
    '       --flags \'[',
    '         {"name":"hook","type":"string","description":"create-transform"},',
    '         {"name":"subcommand","type":"string","description":"reindex | export"},',
    '         {"name":"session-dir","type":"path","description":"session directory path"},',
    '         {"name":"dry-run","type":"boolean","description":"preview mode"}',
    '       ]\'',
    '',
    '3. Hook declaration convention:',
    '     The --hook description field in flags enumerates supported hook names, split by |.',
    '     When ACC finds create-transform in the list, it invokes it after create.',
    '',
    '4. Subcommand declaration convention:',
    '     The --subcommand description field in flags enumerates supported subcommand names, split by |.',
    '     The LLM can then call acc_msm exec session-tool <subcommand>.',
    '',
    (hasSessionTool
      ? '✅ This CCC has a session-tool MSM registered'
      : 'ℹ️  This CCC has no session-tool MSM yet — start with acc_msm register'),
    '',
    '── More information ──',
    '',
    'Reference ACC source: src/tools/session.ts (hook invocation logic)',
  ].join('\n')
}

/**
 * 创建 session 工具（闭包捕获插件 ctx → use 后可调 ctx.sessionTitle.rename）。
 * v1.21 F3：use 激活宁静号会话 → 当前 dsh 会话重命名为该 SESSION 目录名。
 */
export function createSessionTool(ctx: Context): ReturnType<typeof defineTool> {
  return defineTool({
  name: 'session',
  description:
    'Full work-session lifecycle (AGENT_SESSIONS/, home-session convention). list/show/create/use/close/health/qa/archive/summary/hook-develop-guide. ' +
    'create requires --desc <desc> [--goal] or --issue <ticket> (exactly one); close requires --confirm; use activates the session for the current dsh conversation (in-memory + events restore, isolated per dsh session).',
  parameters: {
    action: {
      type: 'string',
      enum: [...SESSION_ACTIONS],
      required: true,
      description:
        'Subcommand: list (status summary) / show (S### or dir name or fuzzy keyword) / create (--desc or --issue) / use (activate context, closed can be reopened) / ' +
        'close (requires --name + --confirm, irreversible) / health (stale/stalled/drift/ghost) / qa (fact check) / archive (archive, name defaults to batch) / ' +
        'summary (dashboard) / hook-develop-guide (CCC extension guide)',
    },
    name: { type: 'string', description: 'show/use/close/archive/qa session identifier (S### or dir name or keyword)' },
    desc: { type: 'string', description: 'create short description (any language, ≤5 words; mutually exclusive with issue)' },
    issue: { type: 'string', description: 'create ticket number (e.g. apaas-26116; dir named YYYY-MM-DD--<issue>; mutually exclusive with desc)' },
    goal: { type: 'string', description: 'create one-sentence goal (optional)' },
    confirm: { type: 'boolean', description: 'close must be true (prevents accidental close)' },
    dryRun: { type: 'boolean', description: 'create/archive preview mode (no actual changes)' },
  },
  output: {
    schema: { type: 'json' },
    render: (args, value) => renderText(value),
  },
  async execute(args, exec) {
    const root = findSerenityRoot(agentCwd(exec))
    if (!root) throw new Error('No CCC found: no .serenity file from agent cwd')

    // 检测 CCC 是否注册了 session-tool MSM（对齐 osp：ACC 总是执行内置逻辑，钩子只做后处理）
    const entries = loadMsmEntries(root)
    const hasSessionTool = entries.some((e) => e.name === 'session-tool')
    const cccHooks = discoverCccHooks(entries)
    const cccSubs = discoverCccSubcommands(entries)
    const extHint = buildExtHint(hasSessionTool, cccHooks, cccSubs)

    if (args.action === 'hook-develop-guide') {
      return getHookDevelopGuide(hasSessionTool)
    }

    switch (args.action) {
      case 'list': {
        return listSessions(root) + extHint
      }
      case 'show': {
        if (!args.name) throw new Error('show requires name (S### or directory name)')
        return showSession(root, args.name) + extHint
      }
      case 'create': {
        // 对齐 osp：desc/issue 二选一（缺省/互斥均在 createSession 内报错）
        const result = createSession({
          root,
          desc: args.desc,
          issue: args.issue,
          goal: args.goal,
          dryRun: args.dryRun ?? false,
        })
        let message = result.message
        // v1.25.11（S142 用户：create 也要命名）：创建成功后立即重命名当前 dsh 会话
        // 为 S###-日期（不再等 use）——createSession result 已含 sessionId/dirName，
        // activeInfoFromCreate 构造命名信息（use/create 共用 renameDshSessionForActive）。
        // dry-run 不命名（未真实创建）。
        if (!(args.dryRun ?? false)) {
          renameDshSessionForActive(ctx, exec, activeInfoFromCreate(result))
        }
        // ---- 钩子：create-transform（对齐 osp；仅非 dry-run 且 CCC 声明了该钩子时执行）----
        if (!(args.dryRun ?? false) && cccHooks.includes('create-transform')) {
          try {
            const hookResult = (await runMsmAsync(root, {
              action: 'exec',
              name: 'session-tool',
              args: ['--hook=create-transform', `--session-dir=${result.sessionPath}`],
            })) as { stdout?: string; data?: string; ok?: boolean }
            const hookOut = hookResult.ok !== undefined && hookResult.ok === false
              ? (hookResult.data ?? '')
              : (hookResult.stdout ?? '')
            message += `\n  [create-transform] ${hookOut.trim()}`
          } catch (err) {
            message += `\n  [WARN] create-transform hook failed: ${err instanceof Error ? err.message : String(err)}`
          }
        }
        return message + extHint
      }
      case 'use': {
        if (!args.name) throw new Error('use requires name (S### or directory name)')
        const scope = agentScope(exec)
        const active = useSession(root, args.name, scope)
        // v1.21 F3：激活宁静号会话后，把当前 dsh 会话重命名为命名标题（S###-日期）
        // v1.25.11：内联逻辑提取为 renameDshSessionForActive（use/create 共用）
        const info = getActiveSessionInfo(scope)
        if (info) renameDshSessionForActive(ctx, exec, info)
        return active
      }
      case 'close': {
        if (!args.name) throw new Error('close requires name (S### or directory name)')
        return closeSession(root, args.name, args.confirm ?? false, agentScope(exec))
      }
      case 'archive': {
        return archiveSessions(root, { name: args.name, dryRun: args.dryRun ?? false }) + extHint
      }
      case 'health':
        return healthCheck(root) + extHint
      case 'summary':
        return summarize(root) + extHint
      case 'qa': {
        if (!args.name) throw new Error('qa requires name (S### or directory name)')
        return qaCheck(root, args.name) + extHint
      }
      default:
        throw new Error(`Unknown action: ${args.action as string}`)
    }
  },
  })
}
