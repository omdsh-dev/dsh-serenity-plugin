import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('@deepseek-ai/dsh-llm', () => ({
  createUserMessage: (o: unknown) => o,
}))

import { accIdentityText, accMessage, shouldAutoRestore, shouldRestoreActive } from '../src/seams/context.js'
import { ACC_VERSION } from '../src/kernel/constants.js'
import { resetTrajectorySessions } from '../src/trajectory/policy/window.js'
import { make轨迹约束Session, 轨迹约束Json } from './helpers/trajectory-constraint-fixture.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hooks-ctx-'))
  writeFileSync(join(dir, '.serenity'), 'test')
})

afterEach(() => {
  resetTrajectorySessions() // 进程级注册表（会话 → 轨迹），用例间必须复位
  rmSync(dir, { recursive: true, force: true })
})

describe('context: ACC 身份文本', () => {
  it('包含 CCC 根与版本', () => {
    const t = accIdentityText(dir)
    expect(t).toContain(dir)
    expect(t).toContain(ACC_VERSION)
    expect(t).toContain('[ACC] Serenity cognitive container active')
  })

  // 🔴 2026-09-16（S142 §0e-G，所有者令）：**不再**注入 cheap-worker 默认模型。
  // 🔴 2026-10-28（cheap-worker 整条下线）：读取器 `readCheapWorkerConfig()` 已随工具删除，
  //    注入源根本不存在 ⇒ 原「不含 mock-model」断言**退化为恒真**（D253：永久为空的读数是伪证据）。
  //    ⇒ 改成**差异判据**：同一个 CCC，**配置里有那一段** vs **没有那一段**，
  //      身份锚点必须**逐字相同**。这条仍可证伪 —— 任何人把任何配置派生值注回
  //      `accIdentityText()`，两边的差异就会当场炸出来（比钉一个具体模型名更强）。
  it('身份锚点不随 cheap-worker 配置变化（差异判据；注入源已随工具删除）', () => {
    const withoutCfg = accIdentityText(dir)
    mkdirSync(join(dir, '.opencode'))
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({ 'cheap-worker': { models: ['mock-model'], defaultModel: 'mock-model' } }))
    const withCfg = accIdentityText(dir)
    expect(withCfg).toBe(withoutCfg)
    expect(withCfg).not.toContain('mock-model')
    // 身份锚点的既有内容不受影响（CCC 根 / 约束 / 知识指引仍在）
    expect(withCfg).toContain(dir)
    expect(withCfg).toContain('[ACC] Serenity cognitive container active')
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

  it('cheap-worker 杂工（id 以 cheap-worker- 开头）→ 不恢复', () => {
    expect(shouldAutoRestore(fakeAgent({ id: 'cheap-worker-sqc-scan-1234' }))).toBe(false)
  })

  it('轨迹**自带章程**（selfPromptFile）→ 不恢复（D183 旁路判据）', () => {
    // 🔴 2026-10-20 D183：判据从「有 trajectory-constraint.json」收窄为「**自带章程**」。
    //    只收窄能力（tools）或不改身份（model/resident）的声明**不**旁路自动恢复。
    const dirName = make轨迹约束Session(dir, 'sess-轨迹约束-auto-restore', 'qa', 轨迹约束Json({ tools: [], systemPromptFile: 'charter.md' }))
    const 轨迹约束Session = { id: 'sess-轨迹约束-auto-restore', header: { cwd: dir } }
    expect(shouldAutoRestore(fakeAgent(轨迹约束Session))).toBe(false)
    // 正交的第二条：同一判据下，**带 `轨迹约束-` 前缀但没挂轨迹**的会话按普通会话处理
    //（前缀在新模型里不表达身份 —— 保留这格可防"前缀判据悄悄回来"）
    expect(shouldAutoRestore(fakeAgent({ id: '轨迹约束-review-1' }))).toBe(true)
    expect(dirName).toContain('qa')
  })

  it('🔴 D183 反向钉：只写 tools（无章程）⇒ **照常恢复**（不写就是不设定）', () => {
    make轨迹约束Session(dir, 'sess-tools-only-restore', 'tools-only', 轨迹约束Json({ tools: ['read'] }))
    expect(shouldAutoRestore(fakeAgent({ id: 'sess-tools-only-restore', header: { cwd: dir } }))).toBe(true)
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

  it('subagent / cheap-worker（有历史但非根会话）→ 不恢复', () => {
    expect(shouldRestoreActive(fakeAgent({ id: 'child-1', header: { origin: 'subagent' }, events: [{ type: 'user/message' }] }))).toBe(false)
    expect(shouldRestoreActive(fakeAgent({ id: 'cheap-worker-x-1', events: [{ type: 'user/message' }] }))).toBe(false)
  })

  it('轨迹自带章程（有历史但独立）→ 不恢复（D183 旁路判据）', () => {
    // 🔴 2026-10-20 D183：同上一处 —— 判据 = 「**自带章程**」，不再等于「有 trajectory.json」。
    make轨迹约束Session(dir, 'sess-轨迹约束-restore-active', 'qa', 轨迹约束Json({ tools: [], systemPromptFile: 'charter.md' }))
    const 轨迹约束Session = {
      id: 'sess-轨迹约束-restore-active',
      header: { cwd: dir },
      events: [{ type: 'user/message' }],
    }
    expect(shouldRestoreActive(fakeAgent(轨迹约束Session))).toBe(false)
  })
})

describe('context: ACC 注入消息（S134 去重：对话流只含简短身份锚点）', () => {
  it('accMessage 只含简短头——不含完整系统提示词 5 块 / SKILL 原文（由系统提示词层注入）', () => {
    // .serenity 记号 = 顶层入口 skill 名（对齐真实 CCC 约定）
    writeFileSync(join(dir, '.serenity'), 'other-serenity')
    mkdirSync(join(dir, '.opencode', 'skills', 'other-serenity'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'skills', 'other-serenity', 'SKILL.md'), '---\nname: other-serenity\n---\n顶层入口原文内容')

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
    writeFileSync(join(dir, '.serenity'), 'other-serenity')
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
