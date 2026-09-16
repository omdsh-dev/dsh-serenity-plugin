import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('@deepseek-ai/dsh-llm', () => ({
  createUserMessage: (o: unknown) => o,
}))

import { accIdentityText, accMessage, shouldAutoRestore, shouldRestoreActive } from '../src/seams/context.js'
import { ACC_VERSION } from '../src/constants.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hooks-ctx-'))
  writeFileSync(join(dir, '.serenity'), 'test')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('context: ACC 身份文本', () => {
  it('包含 CCC 根与版本', () => {
    const t = accIdentityText(dir)
    expect(t).toContain(dir)
    expect(t).toContain(ACC_VERSION)
    expect(t).toContain('[ACC] Serenity cognitive container active')
  })

  // 🔴 2026-09-16（S142 §0e-G，所有者令）：**不再**注入 handyman 默认模型。
  //    判据（R↓）：模型名对 LLM 不构成可执行动作——调 handyman 时不由它选模型
  //    （默认值由 `handyman.ts` 自己读配置决定），拿到名字也无法据此决策 ⇒ 纯噪音。
  //    ⚠️ 机制与面板**未受影响**（`status.ts` 仍把它喂给 WebUI 面板，那是给人看的）。
  //    本用例由「应包含 mock-model」**反转为「不得包含」**——留下回归钉，防它悄悄回来。
  it('不注入 handyman 默认模型（§0e-G 反转钉）', () => {
    mkdirSync(join(dir, '.opencode'))
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({ handyman: { models: ['mock-model'], defaultModel: 'mock-model' } }))
    const t = accIdentityText(dir)
    expect(t).not.toContain('mock-model')
    expect(t).not.toContain('handyman default model')
    // 身份锚点的既有内容不受影响（CCC 根 / 约束 / 知识指引仍在）
    expect(t).toContain(dir)
    expect(t).toContain('[ACC] Serenity cognitive container active')
  })

  it('存在 PHASE2-PROMPT.md 时提示访谈', () => {
    mkdirSync(join(dir, '.dsh'))
    writeFileSync(join(dir, '.dsh', 'PHASE2-PROMPT.md'), 'T1')
    expect(accIdentityText(dir)).toContain('Phase 2')
  })
})

describe('context: 重启自动恢复的根会话判定（shouldAutoRestore）', () => {
  const fakeAgent = (session: unknown) => ({ session }) as never

  it('conversation 根会话 → 恢复', () => {
    expect(shouldAutoRestore(fakeAgent({ id: 'main-session-abc' }))).toBe(true)
  })

  it('subagent（origin=subagent）→ 不恢复', () => {
    expect(shouldAutoRestore(fakeAgent({ id: 'child-1', header: { origin: 'subagent' } }))).toBe(false)
  })

  it('派生会话（parentSession 存在）→ 不恢复', () => {
    expect(shouldAutoRestore(fakeAgent({ id: 'child-2', header: { parentSession: 'main-session-abc' } }))).toBe(false)
  })

  it('handyman 杂工（id 以 handyman- 开头）→ 不恢复', () => {
    expect(shouldAutoRestore(fakeAgent({ id: 'handyman-sqc-scan-1234' }))).toBe(false)
  })

  it('Skiff 会话（id 以 skiff- 开头）→ 不恢复（完全独立，F4b 旁路）', () => {
    expect(shouldAutoRestore(fakeAgent({ id: 'skiff-qa-readonly-uuid' }))).toBe(false)
    expect(shouldAutoRestore(fakeAgent({ id: 'skiff-review-1' }))).toBe(false)
  })

  it('无 session → 不恢复', () => {
    expect(shouldAutoRestore(fakeAgent(undefined))).toBe(false)
  })
})

describe('context: 恢复触发判定（S134 泄漏修复：有历史才恢复）', () => {
  const fakeAgent = (session: unknown) => ({ session }) as never

  it('全新会话（无历史）→ 不恢复（新任务不继承旧 SESSION）', () => {
    expect(shouldRestoreActive(fakeAgent({ id: 'main-session-new', events: [] }))).toBe(false)
    expect(shouldRestoreActive(fakeAgent({ id: 'main-session-new' }))).toBe(false) // 无 events 字段
  })

  it('续跑/恢复的会话（有对话历史）→ 恢复', () => {
    expect(shouldRestoreActive(fakeAgent({ id: 'main-session-resume', events: [{ type: 'user/message' }] }))).toBe(true)
  })

  it('续跑会话以 snapshotEvents() 形态提供历史 → 恢复（v1.28.1 rc.1 适配回归：裸读 .events 恒 undefined 会漏恢复）', () => {
    const session = { id: 'main-session-resume-snap', snapshotEvents: () => [{ type: 'user/message' }] }
    expect(shouldRestoreActive(fakeAgent(session))).toBe(true)
  })

  it('snapshotEvents() 为空 → 不恢复（全新会话语义）', () => {
    const session = { id: 'main-session-new-snap', snapshotEvents: () => [] }
    expect(shouldRestoreActive(fakeAgent(session))).toBe(false)
  })

  it('subagent / handyman（有历史但非根会话）→ 不恢复', () => {
    expect(shouldRestoreActive(fakeAgent({ id: 'child-1', header: { origin: 'subagent' }, events: [{ type: 'user/message' }] }))).toBe(false)
    expect(shouldRestoreActive(fakeAgent({ id: 'handyman-x-1', events: [{ type: 'user/message' }] }))).toBe(false)
  })

  it('Skiff 会话（有历史但独立）→ 不恢复（F4b 旁路）', () => {
    expect(shouldRestoreActive(fakeAgent({ id: 'skiff-qa-1', events: [{ type: 'user/message' }] }))).toBe(false)
  })
})

describe('context: ACC 注入消息（S134 去重：对话流只含简短身份锚点）', () => {
  it('accMessage 只含简短头——不含完整系统提示词 5 块 / SKILL 原文（由系统提示词层注入）', () => {
    // .serenity 记号 = 顶层入口 skill 名（对齐真实 CCC 约定）
    writeFileSync(join(dir, '.serenity'), 'tg-serenity')
    mkdirSync(join(dir, '.opencode', 'skills', 'tg-serenity'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'skills', 'tg-serenity', 'SKILL.md'), '---\nname: tg-serenity\n---\n顶层入口原文内容')

    const msg = accMessage(dir, ['.opencode/serenity.json'], 30000) as { content: Array<{ text: string }> }
    const text = msg.content[0].text
    // 简短身份锚点
    expect(text).toContain('[ACC] Serenity cognitive container active')
    expect(text).toContain(dir)
    // 完整身份不再重复注入（系统提示词层承担）
    expect(text).not.toContain('=== Serenity ACC ===')
    expect(text).not.toContain('=== Serenity CCE ===')
    expect(text).not.toContain('=== Serenity Constraints ===')
    expect(text).not.toContain('顶层入口原文内容')
    expect(text).not.toContain('Active session:')
  })

  it('Session 块由系统提示词层注入（sessionBlock 独立验证见 osp-alignment；accMessage 不含 Session）', () => {
    writeFileSync(join(dir, '.serenity'), 'tg-serenity')
    const dirName = '2026-08-14--S127--scope-a'
    mkdirSync(join(dir, 'AGENT_SESSIONS', dirName), { recursive: true })
    writeFileSync(join(dir, 'AGENT_SESSIONS', dirName, 'SESSION.md'), '# test')
    mkdirSync(join(dir, '.dsh', 'active-sessions'), { recursive: true })
    writeFileSync(join(dir, '.dsh', 'active-sessions', 'agent-A'), join('AGENT_SESSIONS', dirName, 'SESSION.md'))

    const text = (accMessage(dir, [], 30000) as { content: Array<{ text: string }> }).content[0].text
    expect(text).not.toContain('Active session:')
    expect(text).not.toContain('SESSION.md path:')
  })
})
