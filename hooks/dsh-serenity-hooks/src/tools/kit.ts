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
  description: 'ACC 通用能力工具包：health（CCC 三原则检查 P1/P2/配置，healthy/degraded 报告）/ time（now_iso/now_local/epoch_ms）/ wait（等待 N 秒，缺省 1）。进入 CCC 工作前的例行自检。',
  parameters: {
    action: { type: 'string', enum: [...KIT_ACTIONS], required: true, description: '子命令' },
    seconds: { type: 'integer', description: 'wait 的秒数（正整数，缺省 1）' },
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
