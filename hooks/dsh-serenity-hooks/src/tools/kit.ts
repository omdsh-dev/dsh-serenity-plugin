/**
 * kit.ts — acc_kit 真实 DSH 工具定义（defineTool）
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { findSerenityRoot } from '../ccc.js'
import { runKit, KIT_ACTIONS } from '../kit-ops.js'

function agentCwd(exec: { agent?: { session?: { header?: { cwd?: string } } } }): string {
  return exec.agent?.session?.header?.cwd ?? process.cwd()
}

function renderText(value: unknown): ContentBlock[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

export const kitTool = defineTool({
  name: 'acc_kit',
  description: 'ACC general-purpose utility kit: health (CCC three-principle check P1/P2/config, healthy/degraded report) / time (now_iso/now_local/epoch_ms) / wait (wait N seconds, default 1). Routine self-check before entering a CCC.',
  parameters: {
    action: { type: 'string', enum: [...KIT_ACTIONS], required: true, description: 'Subcommand' },
    seconds: { type: 'integer', description: 'Seconds to wait (positive integer, default 1)' },
  },
  output: {
    schema: { type: 'json' },
    render: (args, value) => renderText(value),
  },
  async execute(args, exec) {
    // CCC 缺失时不抛错——health 返回 degraded 报告（对齐 osp 未激活语义）
    const root = findSerenityRoot(agentCwd(exec))
    return await runKit(root, args)
  },
})
