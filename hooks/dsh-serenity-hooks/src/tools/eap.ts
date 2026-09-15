/**
 * eap.ts — EAP 内容源（认知质量框架；v1.30 三工具合并为 praxis 后只保留内容常量）
 *
 * 内嵌框架内容（自包含，不依赖已安装技能）。
 */

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
