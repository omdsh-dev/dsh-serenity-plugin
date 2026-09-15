/**
 * cce.ts — CCE 内容源（认知连续性工程；v1.30 三工具合并为 praxis 后只保留内容常量）
 *
 * 内容：认知连续性工程（Cognitive Continuity Engineering）——在有限资源与
 * 不可逆不确定性约束下，维持认知实体身份、可达性与演化能力的工程学科。
 * 来源：home-serenity `.opencode/skills/cce/SKILL.md` + CCE 理论。
 */

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
