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
import { hostService } from '../host/access.js'
import type { JsonValue } from '../json.js'
import { join } from 'node:path'
import { findSerenityRoot } from '../ccc.js'
import { loadMsmEntries, runMsmAsync, type MsmEntry } from '../msm-ops.js'
import { appendBound, readLastBound } from '../session-bound.js'
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
  findSession,
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

/** 当前 dsh 会话对象（append bound 用）；无 → null */
function agentDshSession(exec: { agent?: { session?: unknown } }): { append: (type: unknown, data: unknown) => unknown } | null {
  const s = exec.agent?.session as { append?: unknown } | undefined
  return s && typeof s.append === 'function'
    ? { append: s.append as (type: unknown, data: unknown) => unknown }
    : null
}

/**
 * 当前绑定的权威 dirName（优先持久化 bound——防内存被误 use 污染；无 bound 回退内存 active）。
 * 供 G1 守卫对比目标会话是否切换。
 */
function currentBoundDirName(exec: { agent?: { session?: unknown } }, scope: string): string | null {
  const dsh = agentDshSession(exec)
  const bound = dsh ? readLastBound(dsh) : null
  if (bound) return bound.dirName
  return getActiveSessionInfo(scope)?.dirName ?? null
}

// ── v1.21 F3：use 后重命名当前 dsh 会话（纯逻辑，可单测）──
// v1.27.1：**永远开启**（S142 用户拍板"开关下掉，永远开启"）——命名是固定行为，
// 移除 naming.enabled 简单配置开关；仅剩 sessionTitle 服务可用性守卫。

export interface RenameOnUseDeps {
  /** sessionTitle 服务可用性 */
  sessionTitleAvailable: boolean
}

/**
 * 清洗 + 截断会话概括（需求② S142 用户拍板：编号日期后加 ≤20 字内容概括）。
 * 规则（服务端统一，不信任 LLM 输入）：
 *   - 去控制字符/换行/回车/制表（防标题注入/多行污染）
 *   - trim（去首尾空白）
 *   - 截断 ≤20 字符（按 Unicode 码点——中英混排统一；emoji 等代理对按码点保留）
 *   - 去 `/`（防标题被误读为路径分隔）
 * @returns 清洗后的概括（空输入 → 空串；调用方决定是否允许空）
 */
export function sanitizeSessionSummary(summary: string): string {
  const cleaned = summary
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\//g, '')
    .trim()
  return [...cleaned].slice(0, 20).join('')
}

/**
 * 从激活会话派生命名标题（v1.22.9 格式修正 + 需求② 概括）：
 * F3 原始需求是 **`S###-日期`**（如 `S143-2026-08-26`）——从 `sessionId` 派生，
 * 而非完整目录名（`2026-08-24--S142--...` 超长 + 中文，不符合用户拍板格式）。
 * 需求②（S142 用户拍板）：编号日期后加 ≤20 字内容概括 → `S###-YYYY-MM-DD-<概括>`
 * ——概括来自显式 summary 参数（服务端截断/清洗，可靠不靠猜）；编号日期仍固定派生。
 * 无 S### 编号（issue 会话等）→ 回退目录名。
 * @param active 激活会话信息（sessionId + dirName）
 * @param summary 内容概括（≤20 字，服务端清洗截断；空 → 不带概括的 `S###-日期`）
 * @returns `S143-2026-08-26-概括` / `S143-2026-08-26` / 原目录名
 */
export function namingTitleFor(active: ActiveSessionInfo, summary?: string): string {
  const sid = active.sessionId
  if (typeof sid === 'string' && /^S\d+$/.test(sid)) {
    const date = active.dirName.match(/^(\d{4}-\d{2}-\d{2})--/)?.[1] ?? ''
    const cleaned = summary ? sanitizeSessionSummary(summary) : ''
    const base = date ? `${sid}-${date}` : sid
    return cleaned ? `${base}-${cleaned}` : base
  }
  return active.dirName
}

/**
 * use 激活宁静号会话后，把当前 dsh 会话重命名为命名标题（`S###-日期[-概括]`）。
 * v1.27.1：**永远开启**（不再有 naming.enabled 门控）——仅 sessionTitle 服务
 * 存在性守卫；失败不静默——返回结果对象而非 null（v1.22.9），调用方决定可见性。
 *
 * 需求②（S142 用户拍板）：summary 参数（≤20 字概括）→ 标题带概括；编号日期固定派生。
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
  summary?: string,
): { ok: true; title: string } | { ok: false; reason: string } {
  if (!deps.sessionTitleAvailable) return { ok: false, reason: 'sessionTitle service unavailable' }
  if (!titles || typeof titles.rename !== 'function') return { ok: false, reason: 'sessionTitle service unavailable' }
  const title = namingTitleFor(active, summary)
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
 * 需求②：summary 参数（≤20 字概括）透传——标题带概括（编号日期固定派生）。
 * 门控/失败可见性与 renameDshSessionOnUse 一致（不静默：成功 log / 失败 warn）。
 * 调用点（use 分支原内联逻辑提取，create 分支复用）：
 *   - use：激活后从 activeStore 取 info
 *   - create：createSession 结果经 activeInfoFromCreate 构造 info
 */
export function renameDshSessionForActive(
  ctx: Context,
  exec: { agent?: { session?: unknown } },
  info: ActiveSessionInfo,
  summary?: string,
): void {
  try {
    // v1.23.2：传整个 sessionTitle 服务对象（不解构 rename 函数）——
    // 旧实现 `titles.rename` 解构后传裸函数，方法内部 this=undefined 抛错
    const titles = hostService(ctx, 'sessionTitle')
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
      summary,
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
    return '\n\n[CCC] To extend session capabilities, register a session-tool MSM (container_admin msm register); see session hook-develop-guide'
  }
  const parts: string[] = []
  if (hooks.length > 0) parts.push(`hooks: ${hooks.join(', ')}`)
  if (subcommands.length > 0) parts.push(`custom subcommands (msm session-tool): ${subcommands.join(', ')}`)
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
    '    Invocation: msm session-tool --hook=create-transform --session-dir=<path>',
    '    Allowed: read SESSION.md and modify it in place (append fields, swap templates, call APIs, etc.)',
    '    Note: ACC has already ensured the directory and SESSION.md exist; the CCC only modifies',
    '',
    '── Extension point 2: Custom subcommands ──',
    '',
    'The LLM can call msm session-tool <subcommand> to run CCC-specific',
    'subcommands such as reindex, export, batch-create. These bypass the ACC session',
    'tool\'s enum.',
    '',
    '── How to register a session-tool MSM ──',
    '',
    '1. Write the script under the CCC skills directory:',
    '     .opencode/skills/<ccc-name>/scripts/session-tool.ts',
    '',
    '2. Register it in mech-registry.json:',
    '     container_admin msm register session-tool \\',
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
    '     The LLM can then call msm session-tool <subcommand>.',
    '',
    (hasSessionTool
      ? '✅ This CCC has a session-tool MSM registered'
      : 'ℹ️  This CCC has no session-tool MSM yet — start with container_admin msm register'),
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
  name: 'logbook',
  description:
    'The Logbook (AGENT_SESSIONS/ trajectory log — the voyage\'s persistent record). Full work-session lifecycle: list/show/create/use/close/health/qa/archive/summary/hook-develop-guide + rebuild (trajectory-tracker overflow: clear and rebuild the current conversation in place, Ship of Theseus). ' +
    'create requires --desc <desc> [--goal] or --issue <ticket> (exactly one) plus --summary (≤20 chars, content summary — required, except --dry-run preview and --issue sessions which are exempt); close requires --confirm; ' +
    'use activates the session for the current dsh conversation (in-memory + events restore, isolated per dsh session) and requires --summary (≤20 chars). ' +
    'rebuild requires --summary (next-phase content summary ≤20 chars) + optional --note (task focus for the rebuilt self). ' +
    'The summary is appended to the dsh session title (S###-YYYY-MM-DD-<summary>); the S### id and date stay server-derived.',
  parameters: {
    action: {
      type: 'string',
      enum: [...SESSION_ACTIONS],
      required: true,
      description:
        'Subcommand: list (status summary) / show (S### or dir name or fuzzy keyword) / create (--desc or --issue) / use (activate context, closed can be reopened) / ' +
        'close (requires --name + --confirm, irreversible) / health (stale/stalled/drift/ghost) / qa (fact check) / archive (archive, name defaults to batch) / ' +
        'summary (dashboard) / rebuild (clear-and-rebuild current conversation, Ship of Theseus — requires --summary + optional --note) / hook-develop-guide (CCC extension guide)',
    },
    name: { type: 'string', description: 'show/use/close/archive/qa session identifier (S### or dir name or keyword)' },
    note: { type: 'string', description: 'rebuild: task focus ≤200 chars for the rebuilt self — what to work on next (short, no history; SESSION.md holds the full history). Injected as "- Task focus: …" into the rebuild anchor.' },
    desc: { type: 'string', description: 'create short description (any language, ≤5 words; mutually exclusive with issue)' },
    issue: { type: 'string', description: 'create ticket number (e.g. apaas-26116; dir named YYYY-MM-DD--<issue>; mutually exclusive with desc)' },
    goal: { type: 'string', description: 'create one-sentence goal (optional)' },
    summary: { type: 'string', description: 'content summary ≤20 chars (REQUIRED for use and create — create exempts --dry-run preview and --issue sessions) — appended to the dsh session title as S###-YYYY-MM-DD-<summary>; the S### id and date stay server-derived; sanitized/truncated server-side' },
    confirm: { type: 'boolean', description: 'close must be true (prevents accidental close)' },
    force: { type: 'boolean', description: 'use: allow switching away from the currently-bound session (binding guard override)' },
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
        // 需求②：create 也加 summary（用户拍板"create 也带概括"）——必填（编号日期固定派生，概括由调用方显式给）
        // P3-① review：dry-run 豁免（未真实创建无命名对象）+ issue 会话豁免（issue 无概括语义，标题回退目录名）
        const isDryRun = args.dryRun ?? false
        const isIssueSession = typeof args.issue === 'string' && args.issue !== ''
        if (!isDryRun && !isIssueSession && (!args.summary || args.summary.trim() === '')) {
          throw new Error('create requires --summary <content summary ≤20 chars> (appended to the dsh session title; the S### id and date stay server-derived)')
        }
        // 对齐 osp：desc/issue 二选一（缺省/互斥均在 createSession 内报错）
        const result = createSession({
          root,
          desc: args.desc,
          issue: args.issue,
          goal: args.goal,
          dryRun: isDryRun,
        })
        let message = result.message
        // U6（方案 v1.0）：create 保留当前绑定——不再 rename 当前 dsh 会话为新目录
        // （v1.25.11 旧行为：create 后立即改名夺绑定——长会话中途误 create 即被夺走）。
        // 新会话仅在后续显式 `session use` 时才绑定；此处只 append create bound 审计记录。
        if (!isDryRun) {
          appendBound(
            agentDshSession(exec),
            'create',
            {
              dirName: result.dirName,
              mdPath: join(result.sessionPath, 'SESSION.md'),
              sessionId: result.sessionId,
              note: 'created (binding unchanged until explicit use)',
            },
          )
        }
        // ---- 钩子：create-transform（对齐 osp；仅非 dry-run 且 CCC 声明了该钩子时执行）----
        if (!isDryRun && cccHooks.includes('create-transform')) {
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
        // 需求②：use 加 summary 必填（用户拍板"做成必填，但只影响那个概括，编号和日期还是固定的"）
        if (!args.summary || args.summary.trim() === '') {
          throw new Error('use requires --summary <content summary ≤20 chars> (appended to the dsh session title as S###-YYYY-MM-DD-<summary>; id and date stay server-derived)')
        }
        const scope = agentScope(exec)
        // 目标目录名：findSession 定位（精确/编码/模糊——编码无关）
        const targetEntry = findSession(join(root, 'AGENT_SESSIONS'), args.name)
        if (!targetEntry) throw new Error(`Session not found: "${args.name}". Use "list" to see available sessions.`)
        const targetDirName = targetEntry.dirName
        // G1 硬守卫（U5）：目标 ≠ 当前绑定 → 拒绝（除非 --force 显式切换）
        const currentDir = currentBoundDirName(exec, scope)
        const switching = currentDir !== null && targetDirName !== currentDir
        const force = args.force === true
        if (switching && !force) {
          throw new Error(
            `Session is bound to ${currentDir}. Switching to ${targetDirName} would orphan the current trajectory. ` +
            `Re-run with --force to switch (or close the current session first).`,
          )
        }
        const active = useSession(root, args.name, scope)
        // v1.21 F3：激活后重命名 dsh 会话标题（S###-日期-概括）
        const info = getActiveSessionInfo(scope)
        if (info) renameDshSessionForActive(ctx, exec, info, args.summary)
        // 持久化绑定（U1）：无先前绑定 → activate；经 force 切换 → switch
        const dsh = agentDshSession(exec)
        if (dsh && info) {
          const prevBound = readLastBound(dsh)
          appendBound(dsh, switching && prevBound ? 'switch' : 'activate', {
            dirName: info.dirName,
            mdPath: info.mdPath,
            sessionId: info.sessionId,
            ...(switching ? { note: 'forced switch' } : {}),
          })
        }
        return active
      }
      case 'close': {
        // U7（方案 v1.0）：close 关闭**当前绑定**会话——无 name = 关绑定；
        // 有 name 时须指向当前绑定（经 findSession 编码无关解析），否则拒绝（防误关别的会话）。
        const scope = agentScope(exec)
        const requested = args.name?.trim() ?? ''
        const boundDir = currentBoundDirName(exec, scope)
        if (boundDir && requested) {
          const target = findSession(join(root, 'AGENT_SESSIONS'), requested)
          const targetDir = target?.dirName ?? requested
          if (targetDir !== boundDir) {
            throw new Error(
              `Session is bound to ${boundDir}. close targets the bound session — pass the bound session (or omit name) to close it; ` +
              `closing ${requested} while bound to another session is not allowed.`,
            )
          }
        }
        if (!boundDir && !requested) {
          throw new Error('close requires name (no active binding to close) — pass the session to close.')
        }
        const nameToClose = boundDir ? boundDir : requested
        const closed = closeSession(root, nameToClose, args.confirm ?? false, scope)
        // release bound（U7 审计）：关闭当前绑定后 append release（closeSession 已清内存）
        const dsh = agentDshSession(exec)
        const bound = dsh ? readLastBound(dsh) : null
        if (bound) {
          appendBound(dsh, 'release', { dirName: bound.dirName, mdPath: bound.mdPath, sessionId: bound.sessionId, note: 'session closed' })
        }
        return closed
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
      case 'rebuild': {
        // v1.30：rebuild 并入 logbook（原独立 session_rebuild 工具）——超限重建：
        // 复用旧 dsh 会话原地清空重来（Ship of Theseus），turn-stopping 时执行真正 replace
        if (!args.summary || args.summary.trim() === '') {
          throw new Error('rebuild requires --summary <content summary ≤20 chars> (the dsh session title is renamed to S###-YYYY-MM-DD-<summary> after rebuild)')
        }
        const dshSessionId = (exec as { agent?: { session?: { id?: string } } }).agent?.session?.id ?? ''
        if (!dshSessionId) throw new Error('Unable to determine the current dsh session id')
        const { queueRebuild } = await import('../rebuild.js')
        const result = await queueRebuild(ctx, {
          root,
          note: args.note as string | undefined,
          summary: args.summary as string,
          agentCwd: agentCwd(exec),
          dshSessionId,
        })
        return {
          ok: true,
          queued: result.queued,
          anchor: result.anchor,
          sessionMdPath: result.sessionMdPath,
          instruction: 'Queued clear-and-rebuild: when this turn ends, the same conversation will be cleared and injected with the "continue the work" anchor (first-anchor protocol body included), then auto-continue — no manual input needed; resume from SESSION.md at that point.',
        }
      }
      default:
        throw new Error(`Unknown action: ${args.action as string}`)
    }
  },
  })
}
