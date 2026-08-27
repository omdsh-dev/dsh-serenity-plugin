/**
 * neat.ts — Neat 设计协作协议工具（渐进式披露，ACC 标准工具化）
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

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

function renderText(value: unknown): ContentBlock[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

export const neatTool = defineTool({
  name: 'neat',
  description: 'Neat design collaboration protocol (progressive disclosure): small-step alignment / explicit decisions / document-driven / no level-skipping (requirements→scope→solution→interface→implementation). No section returns the full protocol.',
  parameters: {
    section: {
      type: 'string',
      enum: ['rules', 'layers'],
      description: 'Focus section: rules (four iron rules) / layers (five-layer progression)',
    },
  },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => renderText(value),
  },
  async execute(args) {
    if (args.section === 'rules') {
      const m = NEAT_CONTENT.match(/## Four Iron Rules[\s\S]*?(?=## )/)
      return m?.[0] ?? NEAT_CONTENT
    }
    if (args.section === 'layers') {
      const m = NEAT_CONTENT.match(/## Five-Layer Progression[\s\S]*?(?=## )/)
      return m?.[0] ?? NEAT_CONTENT
    }
    return NEAT_CONTENT
  },
})
