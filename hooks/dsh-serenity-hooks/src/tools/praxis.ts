/**
 * praxis.ts — praxis（可实践理论注入工具，v1.30 合并 eap/neat/cce）
 *
 * eap / neat / cce 三个知识工具合并为一个——它们都是「可实践理论」：
 * 调用时把对应框架注入当前认知（指导输出质量 / 协作协议 / 连续性工程）。
 * 名字：praxis（理论与实践的统一——理论注入实践，实践反哺理论）。
 * Metaphor 映射：Engineering Drawings（图纸 = 可实践理论的编码，第 3 条隐喻）。
 *
 * section 参数渐进披露：不传 = 返回精简目录；传 = 返回对应框架全文/章节。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** 知识源：与各原工具内容保持一致（单一真相源——eap/neat/cce 各自源文件已并入此处） */
import { EAP_CONTENT } from './eap.js'
import { NEAT_CONTENT } from './neat.js'
import { CCE_CONTENT } from './cce.js'

export type PraxisSection = 'eap' | 'neat' | 'cce'

/** 框架清单（无参调用时返回的精简目录） */
export const PRAXIS_INDEX = `praxis — 可实践理论注入（认知框架，按需加载）
选择框架：praxis eap（认知质量——E↑/R↓/S↑ 三变量 + 输出前自检）
          praxis neat（Neat 协作协议——小步对齐/显式决策/文档驱动）
          praxis cce（认知连续性工程——容器 5 行为约束 + H_op 操作熵）
无参返回本目录；详情以对应框架原文为准（单一真相源）。
`

function renderText(value: unknown): ContentBlock[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

export const praxisTool = defineTool({
  name: 'praxis',
  description:
    'Praxis — actionable theory injection (cognitive frameworks, loaded on demand): ' +
    'eap (cognitive quality: E↑ explicitness / R↓ reconstructability / S↑ stability + self-check checklist) / ' +
    'neat (Neat design collaboration protocol: small-step alignment, explicit decisions, document-driven) / ' +
    'cce (Cognitive Continuity Engineering: container identity/accessibility/evolution under bounded resources). ' +
    'No section returns the index; pass a section to load that framework.',
  parameters: {
    section: {
      type: 'string',
      enum: ['eap', 'neat', 'cce'],
      description: 'Framework to inject: eap / neat / cce. Omit for the praxis index.',
    },
  },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => renderText(value),
  },
  async execute(args) {
    if (args.section === 'eap') return EAP_CONTENT
    if (args.section === 'neat') return NEAT_CONTENT
    if (args.section === 'cce') return CCE_CONTENT
    return PRAXIS_INDEX
  },
})
