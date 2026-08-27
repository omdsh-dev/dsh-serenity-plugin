/**
 * eap.ts — EAP 认知质量框架工具（渐进式披露，ACC 标准工具化）
 *
 * 内嵌框架内容（自包含，不依赖已安装技能）；可选 section 参数聚焦某原则。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

export const EAP_CONTENT = `# EAP Cognitive Quality Framework (Explicit Abstraction Principle)

> "The functional value of a thought is proportional to its external reconstructability."

## Three Variables
| Variable | Meaning | How to improve |
|----------|---------|----------------|
| E↑ Explicitness | Degree to which variables/entities/relations are clearly defined | Define variables, state relationship direction & cardinality, draw boundaries |
| R↓ Reconstructability | Cost of rebuilding the original reasoning later | Record decision rationale, context, constraints, alternatives |
| S↑ Stability | Degree to which the same input repeatedly produces consistent output | Fix structures, protocolize, avoid relying on implicit context |

## Pre-Output Self-Check Checklist
- [ ] Variables/entities clearly defined (E↑)
- [ ] Relationships state direction/cardinality (E↑)
- [ ] Boundaries drawn — what is in scope / what is not (E↑)
- [ ] No ambiguous words: "handle" "optimize" "problem" → be specific (E↑)
- [ ] Key decisions record rationale and alternatives (R↓)
- [ ] No level-skipping — align the upper layer before descending (R↓)
- [ ] Structures can be regenerated repeatably (S↑)

## Relationship with ACC
ACC (plugin/template) encodes structure as code (E↑); generating a CCC from ACC is deterministic (R↓); consistent across multiple CCCs (S↑).
CCC (home-serenity etc.) encodes cognitive content as skills/SESSIONs/design docs. Use this checklist to self-check outputs.

## Reference
https://github.com/tellmewhattodo/theory-eap`

function renderText(value: unknown): ContentBlock[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

export const eapTool = defineTool({
  name: 'eap',
  description: 'EAP cognitive quality framework (progressive disclosure): defines E↑ explicitness / R↓ reconstructability / S↑ stability + pre-output self-check checklist. No section returns the full framework; specify a section to focus.',
  parameters: {
    section: {
      type: 'string',
      enum: ['variables', 'checklist', 'acc'],
      description: 'Focus section: variables (three variables) / checklist (self-check list) / acc (relationship with ACC)',
    },
  },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => renderText(value),
  },
  async execute(args) {
    if (args.section === 'variables') return EAP_CONTENT.split('## Pre-Output Self-Check Checklist')[0]!
    if (args.section === 'checklist') {
      const m = EAP_CONTENT.match(/## Pre-Output Self-Check Checklist[\s\S]*?(?=## )/)
      return m?.[0] ?? EAP_CONTENT
    }
    if (args.section === 'acc') {
      const m = EAP_CONTENT.match(/## Relationship with ACC[\s\S]*/)
      return m?.[0] ?? EAP_CONTENT
    }
    return EAP_CONTENT
  },
})
