/**
 * jsc-json-safe.test.ts — jscSafeJsonText（v1.26.9，Safari/JSC JSON.parse 快速路径正则兼容层）测试
 *
 * 背景（S142 调研定稿）：JSC 的 JSON.parse 用内部正则预校验（WebKit bug 200190），
 * JSON 含原始 \u2028/\u2029（行/段分隔符）时对合法 JSON 也抛
 * "The string did not match the expected pattern"（sentry-javascript #2487 同源）。
 * jscSafeJsonText 在 JSON 文本层把原始字符替换为 \uXXXX 转义——parse 后语义不变。
 */
import { describe, it, expect, vi } from 'vitest'

// 与 think-render.test 同款 mock：skiff-debug → skiff-core → dsh-llm 依赖链在测试环境需 mock
vi.mock('@deepseek-ai/dsh-llm', () => ({
  createUserMessage: (o: unknown) => o,
}))
vi.mock('@deepseek-ai/schemastery', () => {
  const chain: unknown = new Proxy(function () {}, {
    get: (_t, prop) => {
      if (prop === Symbol.toPrimitive) return () => ''
      if (prop === 'valueOf') return () => 0
      if (prop === 'toString') return () => ''
      return chain
    },
    apply: () => chain,
  })
  return {
    default: {
      object: (spec: unknown) => spec,
      array: () => chain,
      string: () => chain,
      boolean: () => chain,
      number: () => chain,
    },
  }
})
vi.mock('@deepseek-ai/dsh-settings', () => ({
  installSettingsSection: () => {},
  settingsNamespace: (v: string) => v,
}))

import { jscSafeJsonText } from '../src/skiff-debug.js'

describe('jscSafeJsonText：JSC JSON.parse 兼容层（v1.26.9）', () => {
  it('原始 \\u2028/\\u2029/\\uFEFF 在文本层替换为字面 \\uXXXX 转义序列', () => {
    const text = '{"a":"前\u2028中\u2029后\uFEFF尾"}'
    const safe = jscSafeJsonText(text)
    expect(safe).not.toContain('\u2028')
    expect(safe).not.toContain('\u2029')
    expect(safe).not.toContain('\uFEFF')
    expect(safe).toContain('\\u2028')
    expect(safe).toContain('\\u2029')
    expect(safe).toContain('\\uFEFF')
  })

  it('parse 后语义完全不变（round-trip 深比较：值/嵌套/键位全覆盖）', () => {
    const payload = {
      answer: '行分隔符\u2028与段分隔符\u2029与BOM\uFEFF的复杂回答',
      answer_html: '<p>HTML 含\u2028分隔</p>',
      sessionId: 'skiff-qa-x',
      continued: false,
      trajectory: [
        { role: 'user', text: '提问\u2028' },
        { role: 'tool', text: '结果\u2029内容\uFEFF', tool: 'web_search' },
        { role: 'assistant', text: '答案' },
      ],
      nested: { deep: '键\u2028\u2029\uFEFF', arr: ['\u2028', '\u2029', '\uFEFF'] },
      '键\u2028名': 'value',
    }
    const json = JSON.stringify(payload)
    // 前提：JSON.stringify 确实不转义这三个字符（本兼容层的存在理由）
    expect(json).toContain('\u2028')
    expect(json).toContain('\u2029')
    expect(json).toContain('\uFEFF')
    const safe = jscSafeJsonText(json)
    expect(JSON.parse(safe)).toEqual(payload)
  })

  it('常规 JSON（无触发字符）逐字节不变', () => {
    const payload = { answer: '普通回答中文😀', answer_html: '<p>hi</p>', trajectory: [] }
    const json = JSON.stringify(payload)
    expect(jscSafeJsonText(json)).toBe(json)
  })

  it('已是 \\uXXXX 转义序列（JSON.stringify 输出形态）不二次转义', () => {
    // 字符串值里含字面 "\u2028"（6 字符）→ JSON.stringify 输出 \\u2028（双反斜杠）
    const payload = { a: '\\u2028', b: '\\u2029', c: '\\uFEFF' }
    const json = JSON.stringify(payload)
    expect(json).toContain('\\\\u2028')
    const safe = jscSafeJsonText(json)
    expect(safe).toBe(json) // 不动已转义形态
    expect(JSON.parse(safe)).toEqual(payload)
  })

  it('3100 ask 响应完整形态（v1.26.10：不含 trajectory）：含触发字符的 payload → 安全文本 parse 等价', () => {
    // 模拟 handleAskParsed 的 200 响应（v1.26.10 起对外仅 answer/answer_html/sessionId/continued）
    const response = {
      answer: '### 标题\u2028\n复杂内容\u2029与\uFEFF混合',
      answer_html: '<h3>标题</h3>\n<p>复杂内容\u2028与\uFEFF混合</p>',
      sessionId: 'skiff-qa-abc',
      continued: true,
    }
    const body = jscSafeJsonText(JSON.stringify(response))
    // 浏览器 res.json() 视角：JSC 正则将看到转义序列而非原始行终止符
    expect(body).not.toMatch(/[\u2028\u2029\uFEFF]/)
    expect(JSON.parse(body)).toEqual(response)
  })
})
