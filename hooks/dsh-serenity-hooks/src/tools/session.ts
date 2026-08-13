/**
 * session.ts — session 真实 DSH 工具定义（defineTool）
 *
 * AGENT_SESSIONS/ 全周期管理：list/show/create/health/qa/archive/summary。
 * 逻辑在 session-ops.ts（可单测）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '../json.js'
import { findSerenityRoot } from '../ccc.js'
import { findEntry, runMsm } from '../msm-ops.js'
import {
  listSessions,
  createSession,
  showSession,
  useSession,
  closeSession,
  archiveSession,
  healthCheck,
  summarize,
  qaCheck,
  SESSION_ACTIONS,
} from '../session-ops.js'

function agentCwd(exec: { agent?: { session?: { header?: { cwd?: string } } } }): string {
  return exec.agent?.session?.header?.cwd ?? process.cwd()
}

function renderText(value: unknown): ContentBlock[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

export const sessionTool = defineTool({
  name: 'session',
  description:
    '工作会话全周期管理（AGENT_SESSIONS/，home-session 约定）。list/show/create/use/close/health/qa/archive/summary。多步骤工作必须先 create 会话，use 激活当前会话（写 .dsh/active-session 标记 → 系统提示词 Session 块生效）。',
  parameters: {
    action: {
      type: 'string',
      enum: [...SESSION_ACTIONS],
      required: true,
      description: '子命令',
    },
    key: { type: 'string', description: 'show/use/archive/qa 的会话标识（S### 或目录名或关键词）' },
    name: { type: 'string', description: 'create 的短描述（小写英文连词符，≤5 词）' },
    title: { type: 'string', description: 'create 的标题' },
  },
  output: {
    schema: { type: 'json' },
    render: (args, value) => renderText(value),
  },
  async execute(args, exec) {
    const root = findSerenityRoot(agentCwd(exec))
    if (!root) throw new Error('No CCC found: no .serenity file from agent cwd')
    // CCC 扩展：若 CCC 注册了自定义 session-tool MSM，优先委派（ACC 标准）；
    // 委派失败（非 0 退出/显式失败）→ 回退内置实现（扩展可用才用，失败用基座）
    const ext = findEntry(root, 'session-tool')
    if (ext) {
      const r = runMsm(root, { action: 'exec', name: 'session-tool', args: [args.action, ...(args.key ? [args.key] : [])] }) as {
        exit?: number
        stdout?: string
        stderr?: string
        ok?: boolean
        data?: string
        error?: string
      }
      const failed = (r.exit !== undefined && r.exit !== 0) || r.ok === false
      if (!failed) {
        const out = r.ok !== undefined ? (r.ok ? r.data : r.error) : r.stdout
        return (out !== undefined ? { delegated: true, exit: r.exit ?? 0, output: out } : { delegated: true, exit: r.exit ?? 0 }) as JsonValue
      }
      // 委派失败 → 回退内置实现（继续走下方 switch）
    }
    switch (args.action) {
      case 'list':
        return listSessions(root)
      case 'create':
        return createSession(root, args.name ?? 'untitled', args.title ?? args.name ?? 'untitled')
      case 'show': {
        if (!args.key) throw new Error('show 需要 key')
        return showSession(root, args.key)
      }
      case 'use': {
        if (!args.key) throw new Error('use 需要 key')
        return useSession(root, args.key)
      }
      case 'close':
        return closeSession(root)
      case 'archive': {
        if (!args.key) throw new Error('archive 需要 key')
        return archiveSession(root, args.key)
      }
      case 'health':
        return { problems: healthCheck(root) }
      case 'summary':
        return summarize(root)
      case 'qa': {
        if (!args.key) throw new Error('qa 需要 key')
        return qaCheck(root, args.key)
      }
      default:
        throw new Error(`未知 action: ${args.action as string}`)
    }
  },
})
