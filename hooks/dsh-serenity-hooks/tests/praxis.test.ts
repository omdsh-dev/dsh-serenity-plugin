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

  it('section=eap → 返回 EAP 框架内容（E↑/R↓/S↑）', async () => {
    const v = await (praxisTool as { execute: (a: unknown) => Promise<unknown> }).execute({ section: 'eap' })
    expect(String(v)).toContain('EAP Cognitive Quality Framework')
    expect(String(v)).toContain('E↑ Explicitness')
    expect(String(v)).toContain('R↓ Reconstructability')
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

  it('🔴 内容纪律：本体方法群不得出现任何具体 CCC 的名字（D23——机制与措辞归 ACC、数据归 CCC）', () => {
    for (const name of ['home-serenity', 'tiangong', 'pangu-serenity', 'sh-serenity', 'tg-ontology', 'home-ontology']) {
      expect(ONTOLOGY_CONTENT).not.toContain(name)
    }
  })

  it('PRAXIS_INDEX 为纯文本目录常量', () => {
    expect(PRAXIS_INDEX).toContain('可实践理论注入')
    expect(PRAXIS_INDEX).toContain('eap')
    expect(PRAXIS_INDEX).toContain('praxis ontology')
  })
})
