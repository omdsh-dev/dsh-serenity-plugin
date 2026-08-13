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
  description: 'ACC 通用能力工具包：health（CCC 三原则检查 P1/P2/配置）/ time（ISO 时间戳）/ wait（等待 N 秒）。进入 CCC 工作前的例行自检。',
  parameters: {
    action: { type: 'string', enum: [...KIT_ACTIONS], required: true, description: '子命令' },
    seconds: { type: 'number', description: 'wait 的秒数' },
  },
  output: {
    schema: { type: 'json' },
    render: (args, value) => renderText(value),
  },
  async execute(args, exec) {
    const root = findSerenityRoot(agentCwd(exec))
    if (!root) throw new Error('No CCC found: no .serenity file from agent cwd')
    return runKit(root, args)
  },
})
