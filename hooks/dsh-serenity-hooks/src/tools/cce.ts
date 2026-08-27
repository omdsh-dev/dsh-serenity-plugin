/**
 * cce.ts — CCE 认知连续性工程工具（渐进式披露，ACC 标准工具化）
 *
 * 内容：认知连续性工程（Cognitive Continuity Engineering）——在有限资源与
 * 不可逆不确定性约束下，维持认知实体身份、可达性与演化能力的工程学科。
 * 来源：home-serenity `.opencode/skills/cce/SKILL.md` + CCE 理论。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

export const CCE_CONTENT = `# CCE — Cognitive Continuity Engineering

> **Cognitive Continuity Engineering is the engineering discipline of maintaining a cognitive entity's identity, accessibility, and capacity to evolve under the constraints of bounded resources and irreversible uncertainty.**
> CCE does not optimize cognition. It preserves the conditions under which cognition can continue. — Persistence Engineering, not performance engineering

## Core Propositions
- **Continuity belongs to the container, not to any individual participant** — agents come and go, but the CCC's cognitive trajectory persists
- **Organization must at minimum keep pace with accumulation** — otherwise operational cognitive entropy (H_op) grows unboundedly and accessibility is lost
- **Reconstruction over preservation** — an artifact's value is determined by its ability to let future agents rebuild the original reasoning

## Cognitive Container
A bounded cognitive space in which cognition can accumulate, reorganize, and evolve. 5 defining properties:
| Property | Function |
|----------|----------|
| Identity | Distinguishes this cognitive system from others |
| Boundaries | Define what is inside/outside the cognitive space |
| Persistent Memory | Retains accumulated cognition across time |
| Operational Constraints | Define which operations are allowed inside the container |
| Evolutionary History | Records the trajectory of cognitive change, making reconstruction possible |

## Operational Cognitive Entropy (H_op)
Does not measure total entropy (not operational); it measures only the **excess cognitive cost** for agents to complete tasks inside the container:
> H_op(C, t) = cost(task | C, t) − cost(task | ideal)
Continuity condition: **H_op(C, t) ≤ H_critical** — agents can still complete tasks at reasonable cost

## Continuity Maintenance Condition
> **ΔH_org ≥ ΔH_in** — organization must at minimum keep pace with accumulation

## Six-Phase Lifecycle
Experience → Accumulation → Organization → Abstraction → Reconstruction → Evolution →（loop）
| Phase | Engineering Concern |
|-------|---------------------|
| Experience | Does input carry enough structure |
| Accumulation | Is information stored losslessly |
| Organization | Entropy management — ΔH_org offsets ΔH_in |
| Abstraction | Is abstraction explicitly encoded |
| Reconstruction | Can reasoning structure be recovered from artifacts |
| Evolution | Does evolution stay coherent or introduce drift |

## Relationship with EAP
EAP answers "how a piece of knowledge should be structured" (explicitness E↑ / reconstructability R↓ / stability S↑);
CCE answers "how structured knowledge should keep evolving across time without losing coherence". They complement each other: EAP is static quality, CCE is dynamic persistence.

## Relationship with Serenity
Serenity's session system, session tracking, and entropy management mechanisms (SQC quality loop) are all engineering implementations of CCE;
the behavioral constraints embedded in CCC system prompts come from CCE.`

function renderText(value: unknown): ContentBlock[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

export const cceTool = defineTool({
  name: 'cce',
  description:
    'CCE cognitive continuity engineering (progressive disclosure): the engineering discipline of maintaining a cognitive entity\'s identity/accessibility/evolution under bounded resources and irreversible uncertainty. No section returns the full framework; specify a section to focus.',
  parameters: {
    section: {
      type: 'string',
      enum: ['container', 'entropy', 'lifecycle', 'eap'],
      description: 'Focus section: container (5 cognitive-container properties) / entropy (operational entropy H_op) / lifecycle (six phases) / eap (relationship with EAP)',
    },
  },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => renderText(value),
  },
  async execute(args) {
    const section = args.section
    const blocks: Record<string, { start: string; end?: string }> = {
      container: { start: '## Cognitive Container', end: '## Operational Cognitive Entropy' },
      entropy: { start: '## Operational Cognitive Entropy (H_op)', end: '## Continuity Maintenance Condition' },
      lifecycle: { start: '## Six-Phase Lifecycle' },
      eap: { start: '## Relationship with EAP' },
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
