/**
 * rebuild.ts — session_rebuild 工具定义（F2，v1.21）
 *
 * LLM 主动触发清空重建（用户决策：keeper 超阈值提示，不自动执行——防误清空）。
 * 执行：归档当前会话 → 创建新会话（宁静号 SESSION 目录 + dsh agent）→ 锚点注入。
 * 服务端逻辑在 ../rebuild.ts（executeRebuild，可单测）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from 'cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '../json.js'
import { findSerenityRoot } from '../ccc.js'
import { executeRebuild } from '../rebuild.js'
import { getActiveSessionInfo } from '../session-ops.js'

function agentCwd(exec: { agent?: { session?: { header?: { cwd?: string } } } }): string {
  return exec.agent?.session?.header?.cwd ?? process.cwd()
}

function agentScope(exec: { agent?: { session?: { id?: string } } }): string {
  return exec.agent?.session?.id ?? 'default'
}

function renderText(value: unknown): ContentBlock[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

/** 创建 session_rebuild 工具（闭包捕获 ctx → ctx.agents.create 新会话） */
export function createRebuildTool(ctx: Context): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'session_rebuild',
    description:
      '上下文超限清空重建（Ship of Theseus）：归档当前宁静号会话（SESSION.md 标记 completed + 移 _archived/），' +
      '创建新会话并注入重建锚点（SESSION.md 路径 + 摘要 + 重建指令）。' +
      '用途：SESSION-KEEPER 提示上下文接近上限时，在任务自然停顿点主动调用。' +
      '触发后请先读取旧会话 SESSION.md 从上次进度继续。',
    parameters: {
      note: { type: 'string', description: '可选：给新会话的一句话背景（重建后 LLM 的起始上下文）' },
    },
    output: {
      schema: { type: 'json' },
      render: (args, value) => renderText(value),
    },
    async execute(args, exec): Promise<JsonValue> {
      const root = findSerenityRoot(agentCwd(exec))
      if (!root) throw new Error('No CCC found: no .serenity file from agent cwd')

      // 当前激活的宁静号会话（use 过的那个）；无则只建新会话
      const scope = agentScope(exec)
      const active = getActiveSessionInfo(scope)
      const parentSessionId = (exec.agent?.session as { id?: string } | undefined)?.id

      const result = await executeRebuild(ctx, {
        root,
        activeDirName: active?.dirName ?? null,
        note: args.note as string | undefined,
        agentCwd: agentCwd(exec),
        parentSessionId,
      })

      return {
        ok: true,
        oldSession: result.oldSession,
        newSession: result.newSession,
        anchor: result.anchor,
        instruction: '已归档旧会话并创建新会话。新会话将自动获得重建锚点；请在新会话中继续工作（可用 session use 激活它）。',
      }
    },
  })
}
