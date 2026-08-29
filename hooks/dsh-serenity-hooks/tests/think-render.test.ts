/**
 * think-render.test.ts — renderSkiffMarkdown 可靠性测试（v1.26.8 状态机提取，弃正则）
 *
 * 覆盖：基础折叠 / hideThink 移除 / 未闭合优雅截断 / 嵌套按内容 / 属性变体 / 大小写 /
 * 占位符不冲突 / markdown 渲染完整性 / XSS 注入防护。
 */
import { describe, it, expect, vi } from 'vitest'

// 与 acp-core.test 同款：skiff-debug → skiff-core → dsh-llm 依赖链在测试环境需 mock
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

import { renderSkiffMarkdown } from '../src/skiff-debug.js'

describe('renderSkiffMarkdown: 状态机 think 提取（v1.26.8）', () => {
  it('基础：think 块提取为折叠卡（🧠 默认收起）', () => {
    const html = renderSkiffMarkdown('答案\n\n<think>分析</think>\n\n后续')
    expect(html).toContain('<details class="think">')
    expect(html).toContain('🧠 思考过程')
    expect(html).not.toContain('<think>')
    expect(html).toContain('答案')
    expect(html).toContain('后续')
  })

  it('hideThink=true（public 口）→ think 内容完全移除，正文保留', () => {
    const html = renderSkiffMarkdown('答案\n\n<think>秘密分析</think>\n\n后续', true)
    expect(html).not.toContain('details class="think"')
    expect(html).not.toContain('秘密分析')
    expect(html).not.toContain('<think>')
    expect(html).toContain('答案')
    expect(html).toContain('后续')
  })

  it('未闭合 <think> → 优雅截断为 think 内容（不泄漏标记）', () => {
    const html = renderSkiffMarkdown('前文 <think>未闭合的内容', true)
    expect(html).not.toContain('<think>')
    expect(html).not.toContain('未闭合的内容') // hideThink 移除
    expect(html).toContain('前文')
  })

  it('未闭合 <think>（hideThink=false）→ 折叠卡包含剩余内容', () => {
    const html = renderSkiffMarkdown('前文 <think>未闭合的内容')
    expect(html).toContain('<details class="think">')
    expect(html).toContain('未闭合的内容')
  })

  it('嵌套 <think> → 内层按内容处理（不递归崩溃）', () => {
    const html = renderSkiffMarkdown('<think>外层 <think>内层</think> 尾巴</think>正文')
    expect(html).toContain('外层')
    expect(html).toContain('内层')
    expect(html).toContain('尾巴')
    expect(html).toContain('正文')
    expect(html).not.toContain('<think>')
    expect(html).not.toContain('</think>')
  })

  it('属性变体 <think lang="zh"> → 正常提取', () => {
    const html = renderSkiffMarkdown('<think lang="zh">带属性</think>正文')
    expect(html).toContain('带属性')
    expect(html).not.toContain('lang=')
  })

  it('大小写不敏感 <THINK>/</THINK>', () => {
    const html = renderSkiffMarkdown('<THINK>大写</THINK>正文')
    expect(html).toContain('大写')
    expect(html).not.toContain('<THINK>')
  })

  it('</think > 尾随空格变体 → 正常闭合', () => {
    const html = renderSkiffMarkdown('<think>内容</think >正文')
    expect(html).toContain('内容')
    expect(html).not.toContain('</think')
  })

  it('多 think 块 → 保序提取', () => {
    const html = renderSkiffMarkdown('<think>一</think>A<think>二</think>B')
    expect(html).toContain('一')
    expect(html).toContain('二')
    expect(html).toContain('A')
    expect(html).toContain('B')
  })

  it('占位符字面量正文 → 不被误替换（\u0001 控制字符冲突）', () => {
    const html = renderSkiffMarkdown('正文含 \u0001T0\u0001 字面')
    expect(html).toContain('字面')
  })

  it('markdown 渲染完整（标题/列表/代码块）', () => {
    const html = renderSkiffMarkdown('# 标题\n\n- 甲\n- 乙\n\n```js\nconst a = 1\n```')
    expect(html).toContain('<h1')
    expect(html).toContain('<li>甲</li>')
    expect(html).toContain('<code')
  })

  it('XSS 注入防护（原始 HTML 被转义）', () => {
    const html = renderSkiffMarkdown('正常内容 <script>alert(1)</script>')
    expect(html).not.toContain('<script>')
  })

  it('think 内容含 markdown → 折叠卡内渲染', () => {
    const html = renderSkiffMarkdown('<think>**重点** 和 `代码`</think>正文')
    expect(html).toContain('<strong>重点</strong>')
    expect(html).toContain('<code>代码</code>')
  })

  it('空 think → 折叠卡空 body 不崩溃', () => {
    expect(() => renderSkiffMarkdown('<think></think>正文')).not.toThrow()
    expect(() => renderSkiffMarkdown('<think>  </think>正文')).not.toThrow()
  })

  it('长文本压力（200 段）不崩溃', () => {
    const input = '<think>思考</think>' + '段落 '.repeat(200)
    expect(() => renderSkiffMarkdown(input, true)).not.toThrow()
  })

  it('CRLF 换行 + 零宽字符 → 不崩溃', () => {
    expect(() => renderSkiffMarkdown('<think>a\r\nb</think>\r\n正文\u200c', true)).not.toThrow()
  })
})
