/**
 * rebuild.ts — session_rebuild 工具定义（轨迹跟踪器，v1.22.4 定稿：复用旧会话 + 完全清空重来）
 *
 * LLM 主动触发清空重建（用户决策：keeper 超阈值提示 [TRAJECTORY]，不自动执行——防误清空）。
 * v1.22.4 定稿语义（用户明确）：**复用当前 dsh 会话（同一 id），turn 结束时 surface
 * 完全清空重建**——锚点消息「继续 {宁静号 SESSION 名} 的工作」；SESSION.md 是持久轨迹
 * 永远原位，身份从 SESSION.md 自动延续。同一会话 id → 同工作区天然满足、无新/旧会话
 * 之分、无需销毁/切换/归档。
 * v1.22.5 增强（S142 用户需求）：① turn-stopping 执行 replace 后 **steer 自动继续**
 * （无需用户手工输入，模型自动读 SESSION.md 接续）；② 锚点消息**保留 first-anchor
 * 协议正文**（ACC 身份/EAP/协作协议，去 acknowledge 尾句——重建后直接干活）。
 * 执行时机：工具只排队（queueRebuild），`agent/turn-stopping` 钩子执行真正 replace
 * （turn 结束前所有 tool/result 已 append → 无孤儿；S141 INVALID_REQUEST 根治）。
 * 服务端逻辑在 ../rebuild.ts（queueRebuild/performRebuild/registerRebuildTurnHook）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from 'cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '../json.js'
import { findSerenityRoot } from '../ccc.js'
import { queueRebuild } from '../rebuild.js'

function agentCwd(exec: { agent?: { session?: { header?: { cwd?: string } } } }): string {
  return exec.agent?.session?.header?.cwd ?? process.cwd()
}

function agentSessionId(exec: { agent?: { session?: { id?: string } } }): string {
  return exec.agent?.session?.id ?? ''
}

function renderText(value: unknown): ContentBlock[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

/** 创建 session_rebuild 工具（闭包捕获 ctx → 排队清空重建，turn 结束时同一会话原地重来并自动继续） */
export function createRebuildTool(ctx: Context): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'session_rebuild',
    description:
      'Trajectory-tracker overflow rebuild (Ship of Theseus): this session is the ' +
      'rebuildable carrier of a trajectory — the current conversation is discarded and ' +
      'rebuilt in place at the end of this turn with the anchor "continue the work of ' +
      '{SESSION name}" (first-anchor protocol body included), then auto-continues. ' +
      'SESSION.md (the trajectory\'s persistent body) stays in place; identity continues ' +
      'from it. Use when you receive a [TRAJECTORY] reminder (context above threshold), ' +
      'at a natural pause point. After triggering, resume from SESSION.md when this turn ends.',
    parameters: {
      note: { type: 'string', description: 'Optional: one-sentence rebuild background note (for the rebuilt self)' },
      summary: { type: 'string', description: 'REQUIRED: content summary ≤20 chars of the next work phase — the dsh session title is renamed to S###-YYYY-MM-DD-<summary> after the rebuild (the rebuilt phase gets a fresh summary); sanitized/truncated server-side' },
    },
    output: {
      schema: { type: 'json' },
      render: (args, value) => renderText(value),
    },
    async execute(args, exec): Promise<JsonValue> {
      const root = findSerenityRoot(agentCwd(exec))
      if (!root) throw new Error('No CCC found: no .serenity file from agent cwd')
      const dshSessionId = agentSessionId(exec)
      if (!dshSessionId) throw new Error('Unable to determine the current dsh session id')
      // 需求②：rebuild summary 必填（重建代表新工作阶段，标题概括应更新）
      if (!args.summary || (args.summary as string).trim() === '') {
        throw new Error('session_rebuild requires --summary <content summary ≤20 chars> (the dsh session title is renamed after rebuild to S###-YYYY-MM-DD-<summary>)')
      }

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
    },
  })
}
