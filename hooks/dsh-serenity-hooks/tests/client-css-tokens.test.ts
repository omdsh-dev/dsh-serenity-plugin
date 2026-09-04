/**
 * client-css-tokens.test.ts — client CSS 主题 token 合规测试（S142，2026-09-04）
 *
 * 背景：白色主题通性 bug（用户反馈"纯黑框 + 纯黑字体"）根因 = client CSS 使用了
 * design-platform.css 官方 alias 词汇表中**不存在的自造 token**
 * （bg-module / surface-raised / fill-l1 / text-primary / accent / border /
 *  state-success / state-error / font-mono …）→ var() 永不解析 → 永远走深色 fallback
 * （#1e1e1e 等）→ 浅色主题下弹层/输入框呈黑色块、文字黑字不可读。
 *
 * 本测试机械守卫：client/*.css 中引用的 var(--dsw-alias-*) / var(--ds-*) 名称
 * 必须 ∈ 官方词汇表（内嵌清单，源自 dsh-harness-public design-platform.css +
 * base.css 的 --ds-* 运行时变量）。新增/误用自造 token 立即红。
 */

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const clientDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client')

/** 官方 --dsw-alias-* 词汇表（design-platform.css body / body[data-ds-dark-theme] 两段同名） */
const OFFICIAL_ALIAS_TOKENS: readonly string[] = [
  'bg-base', 'bg-layer-1', 'bg-layer-2', 'bg-layer-3', 'bg-mask-1', 'bg-mask-2', 'bg-mask-3',
  'bg-mask-photo', 'bg-mask-drop', 'bg-module-platform', 'bg-multi-select', 'bg-overlay', 'bg-skeleton',
  'border-inverted2', 'border-inverted', 'border-l1', 'border-l2-darkmode-thin', 'border-l2', 'border-l3', 'border-l4',
  'brand-primary-invert', 'brand-primary-new-colorprimary-new-color', 'brand-primary', 'brand-text',
  'button-contrast-fill', 'button-elevated-fill', 'button-floating-fill', 'button-floating-hover',
  'button-ghost-active-border', 'button-ghost-active-fill', 'button-ghost-active-hover',
  'button-info-fill', 'button-info-hover', 'button-primary-dimmed', 'button-primary-fill', 'button-primary-hover',
  'button-tool-bar-fill-invisible', 'button-tool-bar-fill', 'button-tool-bar-hover',
  'interactive-bg-active', 'interactive-bg-hover-accent', 'interactive-bg-hover-danger',
  'interactive-bg-hover-solid', 'interactive-bg-hover',
  'label-caption', 'label-dimmed', 'label-primary-bluish', 'label-primary-dimmed', 'label-primary-foreground',
  'label-primary-inverted', 'label-primary', 'label-secondary', 'label-tertiary',
  'markdown-citation', 'markdown-code-block-banner', 'markdown-code-block',
  'markdown-code-segment-selected', 'markdown-code-segment-unselected',
  'markdown-inline-code', 'markdown-placeholder', 'markdown-tag',
  'scrollbar-bg-l1', 'scrollbar-bg-l2', 'scrollbar-hover-l1', 'scrollbar-hover-l2',
  'state-business-primary', 'state-business-tertiary', 'state-error-primary', 'state-error-secondary',
  'state-success-primary', 'state-success-secondary', 'state-success-tertiary',
  'state-warn-label', 'state-warn-primary', 'state-warn-secondary', 'state-warn-tertiary',
  'toast-bg', 'tooltip-bg',
]

/** 官方 --ds-* 运行时变量（base.css body） */
const OFFICIAL_DS_TOKENS: readonly string[] = [
  '--ds-font-family-code', '--ds-ease-in-out', '--ds-transition-duration',
  '--ds-transition-duration-fast', '--ds-transition-duration-slow',
]

const officialAliasSet = new Set(OFFICIAL_ALIAS_TOKENS.map((t) => `--dsw-alias-${t}`))
const officialDsSet = new Set(OFFICIAL_DS_TOKENS)

/** 提取 css 中 var(--xxx) 引用名（含 fallback 内嵌套 var） */
function extractVarRefs(css: string): string[] {
  const out: string[] = []
  const re = /var\((--[a-z0-9-]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(css)) !== null) {
    if (!out.includes(m[1])) out.push(m[1])
  }
  return out
}

describe('client CSS token 合规（防自造 token → 浅色主题黑块）', () => {
  const cssFiles = readdirSync(clientDir)
    .filter((f) => f.endsWith('.css'))
    .map((f) => join(clientDir, f))
  expect(cssFiles.length).toBeGreaterThan(0)

  for (const file of cssFiles) {
    const css = readFileSync(file, 'utf-8')
    const refs = extractVarRefs(css)
    const bad = refs.filter(
      (ref) => !officialAliasSet.has(ref) && !officialDsSet.has(ref) && !ref.startsWith('--sp-') && !ref.startsWith('--dsl-'),
    )
    it(`${file.split('/').pop()} 仅引用官方 token（+ --sp-* 自有变量）`, () => {
      expect(bad).toEqual([])
    })
  }
})
