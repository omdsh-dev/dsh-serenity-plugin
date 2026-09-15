/**
 * neat.ts — Neat 内容源（设计协作协议；v1.30 三工具合并为 praxis 后只保留内容常量）
 */

export const NEAT_CONTENT = `# Neat Design Collaboration Protocol

> Complex design is not thought up at once — it is walked out in small aligned steps.

## Four Iron Rules
| Rule | Meaning | Anti-example |
|------|---------|--------------|
| Small-step alignment | Advance one decision at a time; confirm before the next step | Presenting 10 options at once |
| Explicit decisions | Every choice records rationale and alternatives | "I feel this is good" (no rationale) |
| Document-driven | Conclusions land in named files (<subject>-<scope>-<type>.md) | Conclusions exist only in conversation |
| No level-skipping | Advance strictly through the layers | Writing implementation before requirements are aligned |

## Five-Layer Progression (no skipping)
Requirements → Scope → Solution → Interface → Implementation
| Layer | Artifact | Question |
|-------|----------|----------|
| Requirements | Requirements description | "What problem are we solving?" |
| Scope | Scope list (in/out) | "What is in, explicitly what is out?" |
| Solution | Solution comparison + selection | "How? Which one? Why?" |
| Interface | Interface/protocol definition | "How do the boundaries interact?" |
| Implementation | Code/docs | "Land it layer by layer" |

## Collaboration Rhythm
1. Raise one decision point of the current layer (with context + suggestion + rationale)
2. Wait for confirmation or correction (small step)
3. After confirmation, record the decision (into session SESSION.md or a design doc)
4. Move to the next decision point`
