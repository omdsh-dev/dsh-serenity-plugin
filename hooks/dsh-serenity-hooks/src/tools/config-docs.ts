/**
 * tools/config-docs.ts — `container_admin config docs` 的**两层菜单**（P3，2026-10-19）
 *
 * ## owner 原话（本文件存在的全部理由，逐字）
 *
 * > 「im 的整体配置方法要在 ACC 级有方法能交代我们的**说明类内容**越来越多了，
 * >   做个**两层菜单**来承载吧，admin 里面搞两个方法，一个是**使用说明目录**，
 * >   一个是**使用说明详情（按章节获得）**」
 *
 * ⇒ 第一层 `docs`（无参）= **目录**：只列"有哪几章、每章一句话、去哪个子命令看详情"。
 *   第二层 `docs <chapter>` = **详情**：该章全文。
 *
 * ## 为什么是"目录 + 按章详情"而不是一坨长文（R↓，这不是排版偏好）
 *
 * 说明类内容已经长到 `ccc-config` 单份约 20 KB。整份塞进一次工具返回有两个真实代价：
 * ① **截断** —— 宿主对工具结果有预算（超了走 head/tail + 落盘）⇒ 用户拿到的**不是全文**，
 *    而是它以为的全文（本轨 A59 记过这一格）。
 * ② **不可发现** —— 一坨长文里"我该看哪一段"要靠通读才知道；目录让模型**先选后读**。
 * ⇒ 判据：**目录只索引，不复制**。每章正文的唯一真相源仍在它自己的产出函数里
 *   （本章 = `ccc-config` 的对应段 / `role guide` 全文），本文件只做**切分与路由**。
 *
 * ## 归属（D23）
 * 机制在 ACC（有哪几章、怎么切、怎么路由）；**章目内容**部分来自 ACC 自己的 guide
 * （那些是机制说明），部分来自 CCC 的配置现状（运行时读取）。
 *
 * ## 与 `msm catalog` 的分工（两个目录不是冗余）
 * - `msm catalog` = **工具/能力**目录（"去哪找功能说明"）
 * - `config docs` = **配置**目录（"这个键怎么填、填错会怎样"）
 * 二者在 ④ 章互指，但**不复制**对方的内容。
 */

/** 一个章节 = 菜单项（第一层）+ 正文（第二层） */
export interface DocsChapter {
  /** 章节 id（稳定标识：`config docs <id>`；**英文短名**，便于逐字敲出来） */
  id: string
  /** 菜单里的一句话（用户据此决定要不要读下去） */
  summary: string
  /** 该章正文（第二层才返回；**惰性**——目录不触发它） */
  render: () => string
}

/**
 * 渲染**目录**（第一层）。
 *
 * 🔴 只调 `summary`，**绝不调 `render`** —— 目录若触发正文，就退化成"整份长文"。
 * 这条不是性能优化，是**判据**：它保证 `docs` 的输出大小与章数成正比，与正文长度无关。
 */
export function renderDocsIndex(chapters: readonly DocsChapter[]): string {
  const lines = [
    '═══ CCC 配置说明 · 目录 ═══',
    '',
    '说明类内容已超过单次返回的合适篇幅 ⇒ 先读目录，再按章取详情。',
    '',
    '用法：container_admin config docs <章节>',
    '',
  ]
  for (const ch of chapters) {
    lines.push(`  ${ch.id.padEnd(14)}${ch.summary}`)
  }
  lines.push('')
  lines.push('相关：container_admin msm catalog（工具/能力目录——与本章录互指，不互相复制）')
  return lines.join('\n')
}

/**
 * 解析一个章节参数（第二层）。
 *
 * 不存在 ⇒ 返回 `null`，由调用方给出**带候选清单**的拒绝 ——
 * "不知道这个章节" 与 "这一章是空的" 必须可区分（否则用户以为功能没有）。
 */
export function findDocsChapter(chapters: readonly DocsChapter[], id: string): DocsChapter | null {
  const want = id.trim().toLowerCase()
  if (want === '') return null
  return chapters.find((c) => c.id.toLowerCase() === want) ?? null
}
