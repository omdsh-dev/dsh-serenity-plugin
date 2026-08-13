/**
 * eap.ts — EAP 认知质量框架工具（渐进式披露，ACC 标准工具化）
 *
 * 内嵌框架内容（自包含，不依赖已安装技能）；可选 section 参数聚焦某原则。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

export const EAP_CONTENT = `# EAP 认知质量框架（显式抽象原则）

> "思维的功能价值与其外部可重建性成正比。"

## 三变量
| 变量 | 含义 | 提升手段 |
|------|------|---------|
| E↑ 显式度 | 变量/实体/关系被明确定义的程度 | 定义变量、指明关系方向与基数、划定边界 |
| R↓ 重建成本 | 未来重建原始推理的成本 | 记录决策理由、上下文、约束、备选方案 |
| S↑ 稳定性 | 同一输入反复产生一致结果的程度 | 结构固化、协议化、避免依赖隐含上下文 |

## 输出前自检清单
- [ ] 变量/实体明确定义（E↑）
- [ ] 关系指明方向/基数（E↑）
- [ ] 边界划定——什么在范围内/什么不在（E↑）
- [ ] 不使用歧义词汇："处理""优化""问题"→ 具体化（E↑）
- [ ] 关键决策记录理由与备选（R↓）
- [ ] 不跳级讨论——先对齐上层再进入下层（R↓）
- [ ] 结构可重复执行/生成（S↑）

## 与 ACC 的关系
ACC（插件/模板）结构编码为代码（E↑）；从 ACC 生成 CCC 确定（R↓）；多 CCC 一致（S↑）。
CCC（home-serenity 等）认知内容编码为 skill/SESSION/设计文档。产出物用本清单自检。

## 参考
https://github.com/tellmewhattodo/theory-eap`

function renderText(value: unknown): ContentBlock[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

export const eapTool = defineTool({
  name: 'eap',
  description: 'EAP 认知质量框架（渐进式披露）：定义 E↑ 显式度 / R↓ 重建成本 / S↑ 稳定性 + 输出前自检清单。无 section 返回完整框架；指定 section 聚焦对应内容。',
  parameters: {
    section: {
      type: 'string',
      enum: ['variables', 'checklist', 'acc'],
      description: '聚焦片段：variables（三变量）/ checklist（自检清单）/ acc（与 ACC 关系）',
    },
  },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => renderText(value),
  },
  async execute(args) {
    if (args.section === 'variables') return EAP_CONTENT.split('## 输出前自检清单')[0]!
    if (args.section === 'checklist') {
      const m = EAP_CONTENT.match(/## 输出前自检清单[\s\S]*?(?=## )/)
      return m?.[0] ?? EAP_CONTENT
    }
    if (args.section === 'acc') {
      const m = EAP_CONTENT.match(/## 与 ACC 的关系[\s\S]*/)
      return m?.[0] ?? EAP_CONTENT
    }
    return EAP_CONTENT
  },
})
