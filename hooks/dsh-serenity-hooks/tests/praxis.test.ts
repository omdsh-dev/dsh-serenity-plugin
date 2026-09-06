/**
 * praxis.test.ts — praxis（v1.30：eap/neat/cce 三合一可实践理论注入工具）
 *
 * 覆盖：工具契约（name=praxis + section 参数）+ section 路由
 * （eap/neat/cce 三框架内容 + 无参目录）。
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-tools', () => ({ defineTool: (o: unknown) => o }))
vi.mock('@deepseek-ai/dsh-llm', () => ({ createUserMessage: (o: unknown) => o }))

import { praxisTool, PRAXIS_INDEX } from '../src/tools/praxis.js'

describe('praxis（v1.30：eap/neat/cce 三合一）', () => {
  it('工具名 = praxis；参数含 section（eap/neat/cce）', () => {
    expect(praxisTool).toMatchObject({ name: 'praxis' })
    const params = (praxisTool as { parameters: Record<string, unknown> }).parameters
    expect(params.section).toBeDefined()
    expect((params.section as { enum?: string[] }).enum).toEqual(['eap', 'neat', 'cce'])
  })

  it('无 section → 返回目录（索引三框架入口）', async () => {
    const v = await (praxisTool as { execute: (a: unknown) => Promise<unknown> }).execute({})
    expect(String(v)).toContain('praxis')
    expect(String(v)).toContain('eap')
    expect(String(v)).toContain('neat')
    expect(String(v)).toContain('cce')
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

  it('PRAXIS_INDEX 为纯文本目录常量', () => {
    expect(PRAXIS_INDEX).toContain('可实践理论注入')
    expect(PRAXIS_INDEX).toContain('eap')
  })
})
