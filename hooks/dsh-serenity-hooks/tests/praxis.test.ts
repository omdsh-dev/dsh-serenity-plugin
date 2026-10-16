/**
 * praxis.test.ts — praxis（v1.30：eap/neat/cce 三合一；v1.51.5：增 ontology）
 *
 * 覆盖：工具契约（name=praxis + section 参数）+ section 路由
 * （eap/neat/cce/ontology 四框架内容 + 无参目录）
 * ＋ 一条**内容纪律**回归钉：本体方法群是 ACC 层内容，**不得出现任何具体 CCC 的名字**（D23）。
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-tools', () => ({ defineTool: (o: unknown) => o }))
vi.mock('@deepseek-ai/dsh-llm', () => ({ createUserMessage: (o: unknown) => o }))

import { praxisTool, PRAXIS_INDEX } from '../src/tools/praxis.js'
import { ONTOLOGY_CONTENT } from '../src/tools/ontology.js'

describe('praxis（v1.30：eap/neat/cce 三合一；v1.51.5 增 ontology）', () => {
  it('工具名 = praxis；参数含 section（eap/neat/cce/ontology）', () => {
    expect(praxisTool).toMatchObject({ name: 'praxis' })
    const params = (praxisTool as { parameters: Record<string, unknown> }).parameters
    expect(params.section).toBeDefined()
    expect((params.section as { enum?: string[] }).enum).toEqual(['eap', 'neat', 'cce', 'ontology'])
  })

  it('无 section → 返回目录（索引四框架入口）', async () => {
    const v = await (praxisTool as { execute: (a: unknown) => Promise<unknown> }).execute({})
    expect(String(v)).toContain('praxis')
    expect(String(v)).toContain('eap')
    expect(String(v)).toContain('neat')
    expect(String(v)).toContain('cce')
    expect(String(v)).toContain('ontology')
  })

  it('section=eap → 返回 EAP 论文全文（锚点取论文里**真实存在**的章节）', async () => {
    const v = await (praxisTool as { execute: (a: unknown) => Promise<unknown> }).execute({ section: 'eap' })
    const s = String(v)
    // 🔴 锚点判据（2026-10-15，S142 续 125）：这里钉的必须是**论文里逐字存在**的串。
    //    换全文前的旧断言钉的是 `EAP Cognitive Quality Framework` / `E↑ Explicitness` /
    //    `Pre-Output Self-Check Checklist` —— 三个都是当年写「简易说明」时**自造的**
    //    （全文 grep 0 命中）⇒ 换全文后它们当场变红。见 `tests/eap-paper.test.ts` 的保真钉。
    expect(s).toContain('# Explicit Abstraction Principle (EAP)')
    expect(s).toContain('## 1. 引言：前置抽象的无穷性')
    expect(s).toContain('### 2.4 核心变量：显式度(E)、重建成本(R)、稳定性(S)')
    expect(s).toContain('### 2.5 EAP原则：E↑、R↓、S↑')
    expect(s).toContain('## 6. EAP的逻辑证明')
    expect(s).toContain('显式度（Explicitness Degree，E）')
  })

  it('section=eap → 返回的是**论文全文**而非节选（首尾两章都在场）', async () => {
    const v = await (praxisTool as { execute: (a: unknown) => Promise<unknown> }).execute({ section: 'eap' })
    const s = String(v)
    // 尾章（附录）也在场 ⇒ 证明不是只截了开头的"摘要式"内容
    expect(s).toContain('## 附录：EAP的公理化可能性（可选）')
    // 篇幅量级判据（**按字节** —— 论文以中文为主，1 汉字 = 3 字节但只占 1~2 个 UTF-16 码元，
    // 拿 `.length` 当篇幅会少读一半。分母 = 资产实测 58 723 B ／ 25 547 字符）。
    expect(Buffer.byteLength(s, 'utf-8')).toBeGreaterThan(50_000)
  })

  it('🆕 第 7 章（通用技能规范：五层压缩层级）在全文里，且位于第 6 章之后、附录之前', async () => {
    const v = await (praxisTool as { execute: (a: unknown) => Promise<unknown> }).execute({ section: 'eap' })
    const s = String(v)
    // 锚点照旧取**论文里逐字存在**的串（2026-10-16 S142 补章；owner 交来 eap-universal-abstraction 规范）
    const ch7 = '## 7. EAP作为通用技能规范：五层压缩层级与Neat反向约束协议'
    expect(s).toContain(ch7)
    expect(s).toContain('Tier 5 表面与产物层')
    expect(s).toContain('The Law of Adjacent Layer Transitions')
    expect(s).toContain('第3步：结构性征询（高杠杆提问）')
    // 次序判据：7 在 6 之后、附录之前（章序漂了 ⇒ 这里的相对位置会当场红）
    const i6 = s.indexOf('## 6. EAP的逻辑证明')
    const i7 = s.indexOf(ch7)
    const iApp = s.indexOf('## 附录：EAP的公理化可能性（可选）')
    expect(i6).toBeGreaterThan(-1)
    expect(i7).toBeGreaterThan(i6)
    expect(iApp).toBeGreaterThan(i7)
  })

  it('section=neat → 返回 Neat 协议内容（四铁律/五层）', async () => {
    const v = await (praxisTool as { execute: (a: unknown) => Promise<unknown> }).execute({ section: 'neat' })
    expect(String(v)).toContain('Neat Design Collaboration Protocol')
    expect(String(v)).toContain('Four Iron Rules')
  })

  it('section=cce → 返回 CCE 框架内容（5 约束/H_op）', async () => {
    const v = await (praxisTool as { execute: (a: unknown) => Promise<unknown> }).execute({ section: 'cce' })
    expect(String(v)).toContain('Cognitive Continuity Engineering')
    expect(String(v)).toContain('H_op')
  })

  it('section=ontology → 返回本体论工程方法群（四组判据 + OEPE + 公理）', async () => {
    const v = await (praxisTool as { execute: (a: unknown) => Promise<unknown> }).execute({ section: 'ontology' })
    const s = String(v)
    expect(s).toContain('Ontology Engineering — Method Family')
    // 四组判据：结构 / 语义提示 / 语义审查 / 运行时合规
    expect(s).toContain('M1–M10')
    expect(s).toContain('L1–L5')
    expect(s).toContain('D1–D8')
    expect(s).toContain('V1–V4')
    // OntoClean 六元属性 + OEPE 循环 + 通用公理 + 反模式
    expect(s).toContain('OntoClean')
    expect(s).toContain('OEPE')
    expect(s).toContain('Universal axioms')
    expect(s).toContain('Anti-patterns')
    // 与另两个框架的挂接（EAP / CCE）
    expect(s).toContain('ΔH_org')
  })

  it('🔴 公理表达式语法段必须在场，且不得把 `not in` 当运算符宣传（实测：它是死分支、静默截断）', () => {
    // EBNF 在场（写公理的人要照着它写）
    expect(ONTOLOGY_CONTENT).toContain('implication ::=')
    expect(ONTOLOGY_CONTENT).toContain('prop_access ::=')
    // 合法写法在场（正解：用 not ( ... in ... )）
    expect(ONTOLOGY_CONTENT).toContain('not (x in y)')
    // 前缀即通过这条性质必须在场（否则绿检会被当成"整条规则被读懂"）
    expect(ONTOLOGY_CONTENT).toContain('silently dropped')
    // 🔴 回归钉：引擎里那个不可达的 `not in` 分支不得再被抄回语法表 ——
    //    抄了它 = 教人写一条会被静默丢掉的规则（实测 probe：`x not in y` 无任何报错）
    expect(ONTOLOGY_CONTENT).not.toContain("in | 'not in'")
  })

  it('🔴 内容纪律：本体方法群不得出现任何具体 CCC 的名字（D23——机制与措辞归 ACC、数据归 CCC）', () => {
    for (const name of ['home-serenity', 'other-serenity', 'another-serenity', 'third-serenity', 'other-ontology', 'home-ontology']) {
      expect(ONTOLOGY_CONTENT).not.toContain(name)
    }
  })

  it('PRAXIS_INDEX 为纯文本目录常量', () => {
    expect(PRAXIS_INDEX).toContain('可实践理论注入')
    expect(PRAXIS_INDEX).toContain('eap')
    expect(PRAXIS_INDEX).toContain('praxis ontology')
  })
})
