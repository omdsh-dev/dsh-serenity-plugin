/**
 * rebuild.ts — session_rebuild 工具定义（轨迹跟踪器，v1.22.1 原地重建语义）
 *
 * LLM 主动触发清空重建（用户决策：keeper 超阈值提示 [TRAJECTORY]，不自动执行——防误清空）。
 * v1.22.1 语义修正：**归档丢掉的是 dsh 会话历史（surface replace 原地重建），
 * 不是宁静号 SESSION.md**——SESSION.md 是持久轨迹永远原位；同一 dsh 会话 id
 * 原地替换 surface 为锚点消息，身份从 SESSION.md 自动延续。
 * 服务端逻辑在 ../rebuild.ts（executeRebuild，可单测）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from 'cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '../json.js'
import { findSerenityRoot } from '../ccc.js'
import { executeRebuild } from '../rebuild.js'

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

/** 创建 session_rebuild 工具（闭包捕获 ctx → 当前会话 surface replace 原地重建） */
export function createRebuildTool(ctx: Context): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'session_rebuild',
    description:
      '轨迹跟踪器超限重建（Ship of Theseus）：**原地清空当前 dsh 会话的对话历史**（surface replace），' +
      '注入锚点消息（SESSION.md 路径 + 摘要 + 重建指令）。' +
      'SESSION.md 是持久轨迹保持原位；本会话是临时可重建的工作副本。' +
      '用途：收到 [TRAJECTORY] 提示（上下文超阈值）时，在任务自然停顿点主动调用。' +
      '触发后请先读取 SESSION.md 从上次进度继续。',
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

      const result = await executeRebuild(ctx, {
        root,
        note: args.note as string | undefined,
        agentCwd: agentCwd(exec),
        dshSessionId,
      })

      return {
        ok: true,
        rebuilt: result.rebuilt,
        replacedNodes: result.replacedNodes,
        sessionMdPath: result.sessionMdPath,
        instruction: '工作副本已原地清空重建（同一会话）。请读取 SESSION.md 从上次进度继续。',
      }
    },
  })
}
