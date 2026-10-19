/**
 * surface/text.ts — 输出文本的清洗原语（**纯函数，零 listener、零宿主依赖**，可独立单测）
 *
 * ## 为什么它从调试面里拆出来（S11，2026-10-19，轨迹中心重构）
 *
 * 拆之前它是 `role/轨迹约束/debug.ts` 的**后半段**，而那份文件是**混装件**：
 *   · 前半段 = **面 D** 的 HTTP 调试页（自起 listener，端口见 `kernel/ports.ts`）
 *   · 后半段 = **通用文本清洗**（本文件，已随重构搬到 `surface/text.ts`）
 *
 * 判据（实测，不是猜）：本文件的导出被**两个与 轨迹约束 无关的模块**直接使用 ——
 * `im/bridge.ts`（微信桥：回复前剥 think）与 `guard/seam.ts`（输出守卫：检测前剥 think）。
 * ⇒ 它不属于"某一条轨迹的调试面"，它是**任何输出面都会用的清洗**。
 *
 * ## 与面的关系（单向）
 *
 *   `surface/debug.ts`（面 D）──► 本文件
 *   本文件 ──► 无（不 import 任何面）
 *
 * ⛔ **反向依赖会立刻建立环**：本文件若为了"方便"去 import 面 D 的 sendJson 之类，
 * 就把纯函数拖进了 HTTP 生命周期。
 */

import { marked } from 'marked'

/**
 * Markdown 渲染（v1.25.9，正经库 marked 服务端渲染——替代手写正则渲染器，S142 用户要求）：
 * ① 提取 `<think>…</think>` 块（v1.26.8 状态机扫描，占位符 \u0001T<idx>\u0001）
 * ② 正文与 think 内容**先 escapeHtml 再 marked.parse**（GFM + breaks）——markdown 语法不受
 *    转义影响，原始 HTML 注入被消除（安全）；代码块内 `<` 显示为实体（可接受）
 * ③ think 占位符：默认还原为 `<details class="think">` 折叠卡（🧠 思考过程，默认收起）；
 *    **hideThink=true（v1.26.4，public 口）→ 直接移除**（思考过程对普通用户不展示）
 * @param hideThink 为 true 时 `<think>` 内容完全不渲染（public 问答页体验）
 */
export function renderTrajectoryMarkdown(raw: string, hideThink = false): string {
  const { body, thinks } = extractThinkBlocks(raw)
  const parsed = marked.parse(escapeHtml(body), { breaks: true, gfm: true })
  const html = typeof parsed === 'string' ? parsed : ''
  return html.replace(/\u0001T(\d+)\u0001/g, (_m, idx: string) => {
    if (hideThink) return '' // v1.26.4：public 口不渲染思考过程
    const inner = thinks[Number(idx)] ?? ''
    const innerHtml = inner === '' ? '' : marked.parse(escapeHtml(inner), { breaks: true, gfm: true })
    return `<details class="think"><summary>🧠 思考过程</summary><div class="think-body">${typeof innerHtml === 'string' ? innerHtml : ''}</div></details>`
  })
}

/**
 * 剥离 `<think>…</think>` 块（v1.27.1，微信桥用户反馈："过微信桥回复给用户的消息，
 * 要去掉 think 标签，用户不应看到"）。复用 extractThinkBlocks 状态机（v1.26.8，
 * 弃正则）——提取后**只保留正文**（占位符替换为空，think 内容丢弃），
 * 未闭合 think 优雅截断。适用于纯文本输出面（微信等不支持 think 折叠的通道）。
 */
export function stripThink(raw: string): string {
  const { body } = extractThinkBlocks(raw)
  return body.replace(/\u0001T(\d+)\u0001/g, '')
}

/**
 * JSC (Safari/iOS) JSON.parse 快速路径正则兼容化（v1.26.9，S142 调研定稿）。
 *
 * 背景：WebKit bug 200190「JavaScriptCore's Regex can't match the content」——JSC 的
 * JSON.parse 用**内部正则**预校验字符串；内容含**原始** `\u2028`（行分隔符）/`\u2029`
 * （段分隔符）时正则无法匹配 → 对**合法 JSON** 也抛
 * `SyntaxError: The string did not match the expected pattern`（sentry-javascript #2487 同源）。
 * JSON.stringify **不转义** `\u2028`/`\u2029`/`\uFEFF`（它们都是合法 JSON 字符串字符）→
 * 在 JSON **文本层**把它们替换为 `\uXXXX` 转义序列：JSON.parse 后语义完全一致（还原原字符），
 * 且 JSC 正则看到的是常规 ASCII 转义（与 JSON.stringify 对控制字符的输出同形态，安全）。
 *
 * 3099 调试页客户端 `await res.json()` 与页面内嵌 JSON 均需此兼容层
 * ——iOS Safari 用户实测"复杂回答"触发。（原同批还列了 3100 问答页，该面已退役，2026-10-15）
 *
 * @param jsonText JSON.stringify 的输出文本；原地等价替换，返回 JSC 安全文本
 */
export function jscSafeJsonText(jsonText: string): string {
  // 全局替换原始字符为字面转义序列（字符集不相交，顺序无关）；已存在的 \\uXXXX 不误伤
  return jsonText
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
    .replace(/\uFEFF/g, '\\uFEFF')
}

/** HTML 文本/属性转义（本文件的唯一转义口径；面 D 渲染时也用这一个，不另写） */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
}

/**
 * 提取 `<think>…</think>` 块（v1.26.8：**状态机扫描，弃正则**——用户批评"老用正则不是个办法"）。
 *
 * 逐字符扫描识别开/闭标签（大小写不敏感；`<think ...>` 允许属性变体；`</think >` 允许尾随空格），
 * 不依赖正则回溯，天然处理：
 *  - **嵌套 `<think>`**（内层按内容处理，不递归——DeepSeek think 不会嵌套）
 *  - **未闭合 `<think>`**（优雅截断：剩余全部作为 think 内容，不泄漏标记）
 *  - **占位符冲突**（用 \u0001T<idx>\u0001——ASCII 控制字符，正文几乎不可能出现）
 *
 * @returns body（占位符替换后的正文）+ thinks（提取的 think 内容数组，保序）
 */
export function extractThinkBlocks(raw: string): { body: string; thinks: string[] } {
  const thinks: string[] = []
  const parts: string[] = []
  let i = 0
  while (i < raw.length) {
    const openTag = matchOpenThink(raw, i) // { tagStart, contentStart } 或 null
    if (!openTag) break
    parts.push(raw.slice(i, openTag.tagStart)) // 开标签前正文
    const closeTag = matchCloseThink(raw, openTag.contentStart) // 闭合标签起点或 -1
    if (closeTag < 0) {
      // 未闭合：剩余全部作为 think 内容（不泄漏标记）
      const inner = raw.slice(openTag.contentStart)
      thinks.push(inner.trim())
      parts.push(`\u0001T${thinks.length - 1}\u0001`)
      i = raw.length
      break
    }
    const inner = raw.slice(openTag.contentStart, closeTag)
    thinks.push(inner.trim())
    parts.push(`\u0001T${thinks.length - 1}\u0001`)
    // 跳到闭合标签的 `>` 之后（处理 `</think>` 与 `</think >` 变体）
    let j = closeTag + 7 // `</think` 后
    while (j < raw.length && (raw[j] === ' ' || raw[j] === '\t' || raw[j] === '\n' || raw[j] === '\r')) j++
    i = raw[j] === '>' ? j + 1 : closeTag + 8
  }
  if (i < raw.length) parts.push(raw.slice(i)) // 尾部正文
  return { body: parts.join(''), thinks }
}

/** 从 from 起找 `<think` 开标签（大小写不敏感，允许属性）；返回标签起点与内容起点，或 null */
function matchOpenThink(s: string, from: number): { tagStart: number; contentStart: number } | null {
  for (let i = from; i <= s.length - 7; i++) {
    if (s[i] !== '<' || (s[i + 1] !== 't' && s[i + 1] !== 'T')) continue
    if (s.slice(i + 1, i + 6).toLowerCase() !== 'think') continue // `<think`：t 在 i+1，5 字符到 i+5
    const after = s[i + 6]
    if (after === '>') return { tagStart: i, contentStart: i + 7 } // `<think>` 内容起点
    if (after === ' ' || after === '\t' || after === '\n' || after === '\r') {
      // `<think attr...>`：跳到 `>` 后
      const gt = s.indexOf('>', i + 7)
      if (gt < 0) return null // 无 `>`，非合法标签
      return { tagStart: i, contentStart: gt + 1 }
    }
  }
  return null
}

/** 从 contentStart 起找 `</think>` 闭合标签（大小写不敏感，允许 `</think >` 尾随空格）；返回闭合标签起点或 -1 */
function matchCloseThink(s: string, contentStart: number): number {
  for (let i = contentStart; i <= s.length - 8; i++) {
    if (s[i] !== '<' || s[i + 1] !== '/') continue
    if (s.slice(i + 2, i + 7).toLowerCase() !== 'think') continue // `</think`：t 在 i+2，5 字符到 i+6
    const after = s[i + 7]
    if (after === '>') return i
    if (after === ' ' || after === '\t' || after === '\n' || after === '\r') {
      // `</think >`：跳过空白到 `>`
      let j = i + 8
      while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '\r')) j++
      if (s[j] === '>') return i
    }
  }
  return -1
}
