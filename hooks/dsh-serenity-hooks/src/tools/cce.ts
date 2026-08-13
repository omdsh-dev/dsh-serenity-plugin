/**
 * cce.ts — CCE 认知连续性工程工具（渐进式披露，ACC 标准工具化）
 *
 * 内容：认知连续性工程（Cognitive Continuity Engineering）——在有限资源与
 * 不可逆不确定性约束下，维持认知实体身份、可达性与演化能力的工程学科。
 * 来源：home-serenity `.opencode/skills/cce/SKILL.md` + CCE 理论。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

export const CCE_CONTENT = `# CCE — 认知连续性工程（Cognitive Continuity Engineering）

> **认知连续性工程是在有限资源与不可逆不确定性的约束下，维持一个认知实体的身份、可达性与演化能力的工程学科。**
> CCE 不优化认知。它维护认知得以继续的条件。—— 存续工程（Persistence Engineering），非绩效工程

## 核心命题
- **连续性属于容器，而非任何个体参与者**——智能体来来去去，但 CCC 的认知轨迹持续存在
- **组织必须至少与积累同步**——否则操作化认知熵（H_op）无界增长，可达性丧失
- **重建优于保存**——产物的价值由其使未来智能体重建原始推理的能力决定

## 认知容器（Cognitive Container）
一个有界的认知空间，认知可在其中积累、重组和演化。5 个定义属性：
| 属性 | 功能 |
|------|------|
| 身份（Identity） | 区分此认知系统与其他系统 |
| 边界（Boundaries） | 定义什么在认知空间内/外 |
| 持久记忆（Persistent Memory） | 跨时间保留积累的认知 |
| 操作约束（Operational Constraints） | 定义容器内允许哪些操作 |
| 演化历史（Evolutionary History） | 记录认知变化轨迹，使重建可能 |

## 操作化认知熵（H_op）
不度量总体熵（不可操作），只度量智能体在容器内完成任务的**多余认知成本**：
> H_op(C, t) = cost(task | C, t) − cost(task | ideal)
维持条件：**H_op(C, t) ≤ H_critical** —— 智能体仍可在合理成本内完成任务

## 连续性维护条件
> **ΔH_org ≥ ΔH_in** —— 组织必须至少与积累同步

## 六阶段生命周期
Experience → Accumulation → Organization → Abstraction → Reconstruction → Evolution →（循环）
| 阶段 | 工程关切 |
|------|---------|
| Experience | 输入是否携带足够结构 |
| Accumulation | 信息是否无损存储 |
| Organization | 熵管理 — ΔH_org 抵消 ΔH_in |
| Abstraction | 抽象是否显式编码 |
| Reconstruction | 推理结构能否从产物恢复 |
| Evolution | 演化保持连贯还是引入漂移 |

## 与 EAP 的关系
EAP 回答"一段知识应如何被结构化"（显式度 E↑ / 重建成本 R↓ / 稳定性 S↑）；
CCE 回答"有结构的知识应如何跨时间持续演化而不丧失连贯性"。两者互补：EAP 是静态质量，CCE 是动态存续。

## 与 Serenity 的关系
Serenity 的会话系统、会话追踪、熵管理机制（SQC 品质循环）都是 CCE 的工程实现；
CCC 系统提示词中嵌入的行为约束即来自 CCE。`

function renderText(value: unknown): ContentBlock[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

export const cceTool = defineTool({
  name: 'cce',
  description:
    'CCE 认知连续性工程（渐进式披露）：在有限资源与不可逆不确定性约束下，维持认知实体身份/可达性/演化能力的工程学科。无 section 返回完整框架；指定 section 聚焦对应内容。',
  parameters: {
    section: {
      type: 'string',
      enum: ['container', 'entropy', 'lifecycle', 'eap'],
      description: '聚焦片段：container（认知容器 5 属性）/ entropy（操作化认知熵 H_op）/ lifecycle（六阶段）/ eap（与 EAP 关系）',
    },
  },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => renderText(value),
  },
  async execute(args) {
    const section = args.section
    const blocks: Record<string, { start: string; end?: string }> = {
      container: { start: '## 认知容器（Cognitive Container）', end: '## 操作化认知熵' },
      entropy: { start: '## 操作化认知熵（H_op）', end: '## 连续性维护条件' },
      lifecycle: { start: '## 六阶段生命周期' },
      eap: { start: '## 与 EAP 的关系' },
    }
    if (section) {
      const b = blocks[section]
      if (b) {
        const startIdx = CCE_CONTENT.indexOf(b.start)
        if (startIdx >= 0) {
          const slice = b.end ? CCE_CONTENT.slice(startIdx, CCE_CONTENT.indexOf(b.end, startIdx)) : CCE_CONTENT.slice(startIdx)
          return slice.trim()
        }
      }
    }
    return CCE_CONTENT
  },
})
