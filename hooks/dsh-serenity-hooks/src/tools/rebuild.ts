/**
 * rebuild.ts — session_rebuild 工具定义（轨迹跟踪器，v1.22.4 定稿：复用旧会话 + 完全清空重来）
 *
 * LLM 主动触发清空重建（用户决策：keeper 超阈值提示 [TRAJECTORY]，不自动执行——防误清空）。
 * v1.22.4 定稿语义（用户明确）：**复用当前 dsh 会话（同一 id），turn 结束时 surface
 * 完全清空重建**——锚点消息「继续 {宁静号 SESSION 名} 的工作」；SESSION.md 是持久轨迹
 * 永远原位，身份从 SESSION.md 自动延续。同一会话 id → 同工作区天然满足、无新/旧会话
 * 之分、无需销毁/切换/归档。
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

/** 创建 session_rebuild 工具（闭包捕获 ctx → 排队清空重建，turn 结束时同一会话原地重来） */
export function createRebuildTool(ctx: Context): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'session_rebuild',
    description:
      '轨迹跟踪器超限重建（Ship of Theseus）：**完全清空当前 dsh 会话的对话历史**，' +
      '同一会话原地重来——本轮 turn 结束时 surface 替换为锚点消息「继续 {宁静号 SESSION 名} 的工作」。' +
      'SESSION.md 是持久轨迹保持原位；身份从 SESSION.md 自动延续。' +
      '用途：收到 [TRAJECTORY] 提示（上下文超阈值）时，在任务自然停顿点主动调用。' +
      '触发后（本轮 turn 结束后）请读取 SESSION.md 从上次进度继续。',
    parameters: {
      note: { type: 'string', description: '可选：重建背景一句话（给重建后的自己）' },
    },
    output: {
      schema: { type: 'json' },
      render: (args, value) => renderText(value),
    },
    async execute(args, exec): Promise<JsonValue> {
      const root = findSerenityRoot(agentCwd(exec))
      if (!root) throw new Error('No CCC found: no .serenity file from agent cwd')
      const dshSessionId = agentSessionId(exec)
      if (!dshSessionId) throw new Error('无法确定当前 dsh 会话 id')

      const result = await queueRebuild(ctx, {
        root,
        note: args.note as string | undefined,
        agentCwd: agentCwd(exec),
        dshSessionId,
      })

      return {
        ok: true,
        queued: result.queued,
        anchor: result.anchor,
        sessionMdPath: result.sessionMdPath,
        instruction: '已排队清空重建：本轮 turn 结束后同一会话将清空并注入「继续工作」指令。请届时从 SESSION.md 继续。',
      }
    },
  })
}
