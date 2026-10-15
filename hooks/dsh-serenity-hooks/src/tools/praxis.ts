/**
 * praxis.ts — praxis（可实践理论注入工具，v1.30 合并 eap/neat/cce；v1.51.5 增 ontology）
 *
 * eap / neat / cce / ontology 四个知识源合并为一个——它们都是「可实践理论」：
 * 调用时把对应框架注入当前认知（指导输出质量 / 协作协议 / 连续性工程 / 本体论工程）。
 * 名字：praxis（理论与实践的统一——理论注入实践，实践反哺理论）。
 * Metaphor 映射：Engineering Drawings（图纸 = 可实践理论的编码，第 3 条隐喻）。
 *
 * section 参数渐进披露：不传 = 返回精简目录；传 = 返回对应框架全文/章节。
 * 每个框架一个内容源（单一真相源）：neat.ts / cce.ts / ontology.ts；
 * 🔴 **eap 的内容源是随包资产 `assets/eap-paper.md`**（论文全文，58 KB）——
 *    读它在 `tools/eap.ts`（本文件只路由，不内嵌任何正文；见该文件的成因注释）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** 知识源：与各原工具内容保持一致（单一真相源——neat/cce/ontology 各自源文件已并入此处） */
import { EAP_PAPER_ASSET, eapPaperPath, loadEapPaper } from './eap.js'
import { NEAT_CONTENT } from './neat.js'
import { CCE_CONTENT } from './cce.js'
import { ONTOLOGY_CONTENT } from './ontology.js'

/**
 * 读 EAP 论文全文。
 *
 * 🔴 **绝不降级**：缺资产时抛错（带解析到的绝对路径），不返回空串、不退回"简易说明"——
 * 那种降级会把"资产缺失"伪装成"调用成功"，而本工具的全部价值就是那份正文
 * （这正是 2026-10-15 owner 令要修的缺陷形态）。
 */
function eapPaper(): string {
  try {
    return loadEapPaper()
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`EAP paper asset unavailable (${EAP_PAPER_ASSET}): ${msg} — resolved: ${eapPaperPath()}`)
  }
}

/** 框架清单（无参调用时返回的精简目录） */
export const PRAXIS_INDEX = `praxis — 可实践理论注入（认知框架，按需加载）
选择框架：praxis eap（认知质量——EAP 论文全文）
          praxis neat（Neat 协作协议——小步对齐/显式决策/文档驱动）
          praxis cce（认知连续性工程——容器 5 行为约束 + H_op 操作熵）
          praxis ontology（本体论工程方法群——触发/编码/四组判据 M·L·D·V/OEPE 循环/公理/反模式）
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
    'eap (the EXPLICIT ABSTRACTION PRINCIPLE — the full paper: motivation, definitions, ' +
    'the three variables E↑/R↓/S↑, language-as-interface, empirical cases, theoretical ' +
    'corollaries, formal proof) / ' +
    'neat (Neat design collaboration protocol: small-step alignment, explicit decisions, document-driven) / ' +
    'cce (Cognitive Continuity Engineering: container identity/accessibility/evolution under bounded resources) / ' +
    'ontology (ontology engineering method family: when to model, Turtle encoding, four judgement sets ' +
    'M1-M10 structural / L1-L5 semantic hints / D1-D8 semantic review incl. OntoClean / V1-V4 runtime compliance, ' +
    'the OEPE audit loop, workflows, universal axioms, anti-patterns). ' +
    'No section returns the index; pass a section to load that framework.',
  parameters: {
    section: {
      type: 'string',
      enum: ['eap', 'neat', 'cce', 'ontology'],
      description: 'Framework to inject: eap / neat / cce / ontology. Omit for the praxis index.',
    },
  },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => renderText(value),
  },
  async execute(args) {
    if (args.section === 'eap') return eapPaper()
    if (args.section === 'neat') return NEAT_CONTENT
    if (args.section === 'cce') return CCE_CONTENT
    if (args.section === 'ontology') return ONTOLOGY_CONTENT
    return PRAXIS_INDEX
  },
})
