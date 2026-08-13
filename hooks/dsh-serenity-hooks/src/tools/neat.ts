/**
 * neat.ts — Neat 设计协作协议工具（渐进式披露，ACC 标准工具化）
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

export const NEAT_CONTENT = `# Neat 设计协作协议

> 复杂设计不是一次想出来的，是小步对齐走出来的。

## 四条铁律
| 铁律 | 含义 | 反例 |
|------|------|------|
| 小步对齐 | 一次只推进一个决策，确认后再走下一步 | 一次抛 10 个方案 |
| 显式决策 | 每个选择记录理由与备选 | "我觉得这样好"（无理由） |
| 文档驱动 | 结论沉淀到具名文件（<subject>-<scope>-<type>.md） | 结论只存在于对话里 |
| 不跳级 | 严格按层级推进 | 需求未对齐就写实现 |

## 五层推进顺序（不跳级）
需求层 → 范围层 → 方案层 → 接口层 → 实现层
| 层 | 产物 | 问题 |
|----|------|------|
| 需求层 | 需求描述 | "要解决什么问题？" |
| 范围层 | 范围清单（in/out） | "做哪些、明确不做哪些？" |
| 方案层 | 方案对比 + 选定 | "怎么做？选哪个？为什么？" |
| 接口层 | 接口/协议定义 | "边界怎么交互？" |
| 实现层 | 代码/文档 | "逐层落地" |

## 协作节奏
1. 提出当前层一个决策点（带上下文 + 建议 + 理由）
2. 等待确认或修正（小步）
3. 确认后记录决策（写入会话 SESSION.md 或设计文档）
4. 推进到下一决策点`

function renderText(value: unknown): ContentBlock[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

export const neatTool = defineTool({
  name: 'neat',
  description: 'Neat 设计协作协议（渐进式披露）：小步对齐 / 显式决策 / 文档驱动 / 不跳级（需求→范围→方案→接口→实现）。无 section 返回完整协议。',
  parameters: {
    section: {
      type: 'string',
      enum: ['rules', 'layers'],
      description: '聚焦片段：rules（四条铁律）/ layers（五层推进）',
    },
  },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => renderText(value),
  },
  async execute(args) {
    if (args.section === 'rules') {
      const m = NEAT_CONTENT.match(/## 四条铁律[\s\S]*?(?=## )/)
      return m?.[0] ?? NEAT_CONTENT
    }
    if (args.section === 'layers') {
      const m = NEAT_CONTENT.match(/## 五层推进顺序[\s\S]*?(?=## )/)
      return m?.[0] ?? NEAT_CONTENT
    }
    return NEAT_CONTENT
  },
})
