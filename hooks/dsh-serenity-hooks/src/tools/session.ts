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
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '../json.js'
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
} from '../session-ops.js'

function agentCwd(exec: { agent?: { session?: { header?: { cwd?: string } } } }): string {
  return exec.agent?.session?.header?.cwd ?? process.cwd()
}

/** 当前 dsh 会话 id（use/close 按会话隔离的 scope） */
function agentScope(exec: { agent?: { session?: { id?: string } } }): string {
  return exec.agent?.session?.id ?? DEFAULT_SESSION_SCOPE
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
    return '\n\n[CCC] 如需扩展会话能力，可注册 session-tool MSM (acc_msm register)，详见 session hook-develop-guide'
  }
  const parts: string[] = []
  if (hooks.length > 0) parts.push(`钩子: ${hooks.join(', ')}`)
  if (subcommands.length > 0) parts.push(`扩展子命令 (acc_msm exec session-tool): ${subcommands.join(', ')}`)
  const detail = parts.length > 0 ? ` (${parts.join('; ')})` : ''
  return `\n\n[CCC] session-tool MSM 已注册${detail}`
}

/** hook-develop-guide 内容（对齐 osp getHookDevelopGuide） */
function getHookDevelopGuide(hasSessionTool: boolean): string {
  return [
    '═══ Session Extension Protocol (SEP) v1 — 开发指南 ═══',
    '',
    'CCC 可以通过注册 session-tool MSM 来扩展 ACC session 工具的能力，',
    '而无需修改 plugin 代码。ACC 的行为不会缩水——CCC 只在 ACC 完成后做后处理。',
    '',
    '── 口子一：后处理钩子 (Hooks) ──',
    '',
    'ACC 的某些子命令执行完成后，会检查 CCC 的 session-tool MSM 是否',
    '注册了对应的钩子。如果注册了，ACC 会调用 MSM 做后处理。',
    '',
    '可用钩子：',
    '',
    '  create-transform',
    '    触发时机：create 写完默认 SESSION.md 后',
    '    调用方式：acc_msm exec session-tool --hook=create-transform --session-dir=<path>',
    '    允许行为：读取 SESSION.md，原地修改内容（追加字段、换模板、调 API 等）',
    '    注意事项：ACC 已确保目录和 SESSION.md 存在，CCC 只做修改',
    '',
    '── 口子二：新子命令 (Custom Subcommands) ──',
    '',
    'LLM 可以直接调用 acc_msm exec session-tool <subcommand> 来执行 CCC 专属的子命令，',
    '如 reindex、export、batch-create 等。这些子命令不走 ACC session tool 的 enum。',
    '',
    '── 如何注册 session-tool MSM ──',
    '',
    '1. 编写脚本，放在 CCC 的 skills 目录下：',
    '     .opencode/skills/<ccc-name>/scripts/session-tool.ts',
    '',
    '2. 注册到 mech-registry.json：',
    '     acc_msm register session-tool \\',
    '       --skill <ccc-name> --path .opencode/skills/<ccc-name>/scripts/session-tool.ts \\',
    '       --category semi-mech \\',
    '       --description "CCC session 扩展: 钩子 + 自定义子命令" \\',
    '       --flags \'[',
    '         {"name":"hook","type":"string","description":"create-transform"},',
    '         {"name":"subcommand","type":"string","description":"reindex | export"},',
    '         {"name":"session-dir","type":"path","description":"session 目录路径"},',
    '         {"name":"dry-run","type":"boolean","description":"预览模式"}',
    '       ]\'',
    '',
    '3. 钩子声明约定：',
    '     flags 中的 --hook description 字段按 | 分割枚举支持的钩子名。',
    '     ACC 发现 create-transform 在列表中时，就会在 create 后调用。',
    '',
    '4. 子命令声明约定：',
    '     flags 中的 --subcommand description 字段按 | 分割枚举支持的子命令名。',
    '     LLM 看到提示后可调用 acc_msm exec session-tool <subcommand>。',
    '',
    (hasSessionTool
      ? '✅ 当前 CCC 已注册 session-tool MSM'
      : 'ℹ️  当前 CCC 尚未注册 session-tool MSM — 使用 acc_msm register 开始'),
    '',
    '── 更多信息 ──',
    '',
    '参考 ACC 源码: src/tools/session.ts (hook 调用逻辑)',
  ].join('\n')
}

export const sessionTool = defineTool({
  name: 'session',
  description:
    '工作会话全周期管理（AGENT_SESSIONS/，home-session 约定）。list/show/create/use/close/health/qa/archive/summary/hook-develop-guide。' +
    'create 需 --desc <desc> [--goal] 或 --issue <工单号>（二选一）；close 需 --confirm；use 激活当前 dsh 会话的活跃会话（内存 + events 恢复，按 dsh 会话隔离不泄露）。',
  parameters: {
    action: {
      type: 'string',
      enum: [...SESSION_ACTIONS],
      required: true,
      description:
        '子命令：list（状态摘要）/ show（S### 或目录名或模糊关键词）/ create（--desc 或 --issue）/ use（激活上下文，closed 可重开）/ ' +
        'close（需 --name + --confirm，不可撤销）/ health（stale/stalled/drift/ghost）/ qa（事实核对）/ archive（归档，name 缺省批量）/ ' +
        'summary（仪表盘）/ hook-develop-guide（CCC 扩展指南）',
    },
    name: { type: 'string', description: 'show/use/close/archive/qa 的会话标识（S### 或目录名或关键词）' },
    desc: { type: 'string', description: 'create 的短描述（任意语言，≤5 词；与 issue 互斥）' },
    issue: { type: 'string', description: 'create 的工单号（如 apaas-26116；目录命名 YYYY-MM-DD--<issue>；与 desc 互斥）' },
    goal: { type: 'string', description: 'create 的一句话目标（可选）' },
    confirm: { type: 'boolean', description: 'close 必须为 true（防误关）' },
    dryRun: { type: 'boolean', description: 'create/archive 预览模式（不实际修改）' },
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
        if (!args.name) throw new Error('show 需要 name（S### 或目录名）')
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
        if (!args.name) throw new Error('use 需要 name（S### 或目录名）')
        return useSession(root, args.name, agentScope(exec))
      }
      case 'close': {
        if (!args.name) throw new Error('close 需要 name（S### 或目录名）')
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
        if (!args.name) throw new Error('qa 需要 name（S### 或目录名）')
        return qaCheck(root, args.name) + extHint
      }
      default:
        throw new Error(`未知 action: ${args.action as string}`)
    }
  },
})
