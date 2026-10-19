/**
 * config-docs.test.ts — 说明菜单的**两层**机制（P3 的纯逻辑层）
 *
 * ## 这份文件钉的是什么（与 container-admin.test.ts 不重复）
 *
 * `container-admin.test.ts` 钉的是**路由**（`config docs` 走哪条分支、未知章节怎么拒）。
 * 本文件钉的是**机制本身**，两条判据在那里没法表达：
 *
 * ① **目录不触发正文** —— 目录若调了 `render()`，两层菜单就退化成一份长文。
 *    这条只能用**副作用探针**证明（把 `render` 换成一个会记账的函数），
 *    断言"返回体里出现了什么"是证明不了的：正文可能只是恰好没写进去。
 * ② **章节查找的语义**（大小写不敏感 / 空串不算 / 不认识返回 null 而不是抛错）。
 *    抛错与返回 null 的区别很重要：调用方要能用后者拼出"带候选清单"的拒绝文案。
 */
import { describe, it, expect, vi } from 'vitest'
import { renderDocsIndex, findDocsChapter, type DocsChapter } from '../src/tools/config-docs.js'

/** 造一份三章菜单；`render` 是**会记账的探针**（用来证明"目录没调它"） */
function makeChapters(): { chapters: DocsChapter[]; calls: string[] } {
  const calls: string[] = []
  const chapters: DocsChapter[] = [
    { id: 'alpha', summary: '第一章：甲', render: () => { calls.push('alpha'); return 'A'.repeat(1000) } },
    { id: 'beta', summary: '第二章：乙', render: () => { calls.push('beta'); return 'B'.repeat(1000) } },
    { id: 'Gamma', summary: '第三章：丙', render: () => { calls.push('gamma'); return 'C'.repeat(1000) } },
  ]
  return { chapters, calls }
}

describe('renderDocsIndex：第一层只索引，不复制', () => {
  it('🔴 目录不得调用任何一章的 render（否则"两层"退化成一份长文）', () => {
    const { chapters, calls } = makeChapters()
    const out = renderDocsIndex(chapters)
    // 副作用判据：一条都不许被调
    expect(calls).toEqual([])
    expect(out).toContain('alpha')
  })

  it('目录列出每一章的 id 与一句话（用户据此决定读不读下去）', () => {
    const { chapters } = makeChapters()
    const out = renderDocsIndex(chapters)
    for (const ch of chapters) {
      expect(out).toContain(ch.id)
      expect(out).toContain(ch.summary)
    }
  })

  it('🔴 目录体量与正文长度无关（换 10 倍长的正文，目录不变大）', () => {
    const shortBody: DocsChapter[] = [{ id: 'x', summary: 's', render: () => 'x'.repeat(10) }]
    const longBody: DocsChapter[] = [{ id: 'x', summary: 's', render: () => 'x'.repeat(100_000) }]
    // 差异只可能来自 id/summary 的排版，不该随正文膨胀
    expect(Math.abs(renderDocsIndex(shortBody).length - renderDocsIndex(longBody).length)).toBeLessThan(50)
  })

  it('目录里给出用法行（两层菜单的"怎么取第二章"必须写在目录里）', () => {
    const { chapters } = makeChapters()
    const out = renderDocsIndex(chapters)
    expect(out).toContain('config docs <章节>')
  })
})

describe('findDocsChapter：第二层的查找语义', () => {
  it('精确命中', () => {
    const { chapters } = makeChapters()
    expect(findDocsChapter(chapters, 'alpha')?.id).toBe('alpha')
  })

  it('🔴 大小写不敏感（打错大小写不该变成"没有这章"）', () => {
    const { chapters } = makeChapters()
    expect(findDocsChapter(chapters, 'GAMMA')?.id).toBe('Gamma')
    expect(findDocsChapter(chapters, 'gamma')?.id).toBe('Gamma')
  })

  it('前后空白被忽略（用户/模型常带空格）', () => {
    const { chapters } = makeChapters()
    expect(findDocsChapter(chapters, '  beta  ')?.id).toBe('beta')
  })

  it('🔴 不认识 ⇒ 返回 null（**不抛错**）；调用方靠它拼带候选的拒绝文案', () => {
    const { chapters } = makeChapters()
    expect(findDocsChapter(chapters, 'nope')).toBeNull()
  })

  it('🔴 空串 / 纯空白 ⇒ 返回 null（"没给章节"由调用方判，本函数不猜）', () => {
    const { chapters } = makeChapters()
    expect(findDocsChapter(chapters, '')).toBeNull()
    expect(findDocsChapter(chapters, '   ')).toBeNull()
  })

  it('空菜单不炸（新 CCC 还没配任何章时的常态）', () => {
    expect(findDocsChapter([], 'anything')).toBeNull()
  })
})
