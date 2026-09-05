import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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
  return { default: { object: (s: unknown) => s, array: () => chain, string: () => chain, boolean: () => chain, number: () => chain } }
})

vi.mock('@deepseek-ai/dsh-settings', () => ({
  installSettingsSection: () => {},
  settingsNamespace: (v: string) => v,
}))

import { KeeperTracker, scoreTool, reminderText, rebuildReminderText, readContextPressure, registerKeeper } from '../src/seams/keeper.js'
import { registerSkiffSession, unregisterSkiffSession } from '../src/skiff-core.js'

describe('keeper: 纯跟踪器', () => {
  it('计分表：write=3, task=10, read=1', () => {
    expect(scoreTool('write')).toBe(3)
    expect(scoreTool('task')).toBe(10)
    expect(scoreTool('read')).toBe(1)
    expect(scoreTool('unknown-tool')).toBe(0)
  })

  it('达到阈值触发提醒，ack 后清零', () => {
    let now = 0
    const t = new KeeperTracker(10, () => now)
    expect(t.step('write')).toBe(false) // 3
    expect(t.step('write')).toBe(false) // 6
    expect(t.step('write')).toBe(false) // 9
    expect(t.step('write')).toBe(true) // 12 ≥ 10
    const code = t.ack()
    expect(code).toBe('K1')
    expect(t.currentScore).toBe(0)
    expect(t.step('read')).toBe(false) // 1
  })

  it('经过时间计分：+1 分/分钟', () => {
    let now = 0
    const t = new KeeperTracker(5, () => now)
    t.step('read') // 1, now=0
    now = 120_000 // +2 分钟
    expect(t.step('read')).toBe(false) // 1+2+1 = 4
    now = 240_000
    expect(t.step('read')).toBe(true) // 4+2+1 = 7 ≥ 5
  })

  it('reminderText 含确认码（trajectory-assistant checkpoint 前缀）', () => {
    expect(reminderText('K1', 150)).toContain('[TRAJECTORY-ASSISTANT-recorded-K1]')
    expect(reminderText('K1', 150)).toContain('[TRAJECTORY-ASSISTANT · CHECKPOINT]')
    expect(reminderText('K1', 150)).not.toContain('SESSION-KEEPER')
    expect(reminderText('K1', 150)).not.toContain('[TRAJECTORY-STEWARD]')
  })
})

describe('轨迹跟踪器（Trajectory Tracker）— v1.22.1 概念命名', () => {
  it('rebuildReminderText：SESSION.md=持久轨迹，会话=临时可重建工作副本（需求① K 数值化）', () => {
    // 需求①：参数从 (ratio, threshold 比例) 改为 (tokensK, thresholdK 千 token)
    const text = rebuildReminderText(412, 400)
    expect(text).toContain('[TRAJECTORY-ASSISTANT · LIMIT]')
    expect(text).toContain('412K')
    expect(text).toContain('threshold 400K')
    expect(text).toContain('persistent body')
    expect(text).toContain('rebuildable carrier')
    expect(text).toContain('ACT NOW')
    expect(text).toContain('session_rebuild')
    expect(text).toContain('not an option')
    // v1.24.12 沉淀协议：rebuild 前修订现有 skill（eap 结构化）；新建 skill 写 SESSION 提案不自行创建
    expect(text).toContain('revise the relevant existing skill of this CCC')
    expect(text).toContain('write a short proposal into SESSION.md')
    expect(text).toContain('do not create it yourself')
    // v1.28.0 需求②（P0-1 审计补断言）：文案必须指导带 --summary（重建后标题重命名）——
    // 若删指引，模型裸调 session_rebuild 会被 summary 必填拒绝（2026-09-05 rebuild bug 教训）
    expect(text).toContain('--summary')
    expect(text).toContain('≤20 chars')
    expect(text).toContain('renamed to S###-YYYY-MM-DD-<summary>')
    // v1.23.3：不向 LLM 植入阈值建议（设定是用户自由）
    expect(text).not.toContain('0.75~0.9')
  })

  it('rebuildReminderText 升级语气（escalated=true，需求① K 数值化）', () => {
    const text = rebuildReminderText(460, 400, true)
    expect(text).toContain('[TRAJECTORY-ASSISTANT · LIMIT · MANDATORY]')
    expect(text).toContain('460K')
    expect(text).toContain('threshold 400K')
    expect(text).toContain('mandatory')
    expect(text).toContain('STOP')
    expect(text).toContain('session_rebuild')
    expect(text).toContain('persists until you call session_rebuild')
    // v1.24.12：升级版同样带紧凑沉淀指令（修订 skill / 新建 skill 提案进 SESSION）
    expect(text).toContain('preserve valuable cognition')
    expect(text).toContain('new-skill proposal into SESSION.md')
    // v1.28.0 需求②（P0-1 审计补断言）：升级版同样指导带 --summary
    expect(text).toContain('--summary')
    expect(text).toContain('renamed to S###-YYYY-MM-DD-<summary>')
  })

  it('readContextPressure：sessionProjections 装配时读取投影', () => {
    const session = { id: 's1' }
    const ctx = {
      get: (name: string) => name === 'sessionProjections'
        ? { snapshot: () => ({ values: { contextPressure: { projectedTokens: 9000, contextWindow: 10000 } } }) }
        : undefined,
    }
    const pressure = readContextPressure(ctx as never, session)
    expect(pressure).toEqual({ projectedTokens: 9000, contextWindow: 10000 })
  })

  it('readContextPressure：未装配 / 无压力值 → null（不抛错）', () => {
    const session = { id: 's1' }
    const noService = { get: () => undefined }
    expect(readContextPressure(noService as never, session)).toBeNull()
    const noPressure = {
      get: (name: string) => name === 'sessionProjections'
        ? { snapshot: () => ({ values: {} }) }
        : undefined,
    }
    expect(readContextPressure(noPressure as never, session)).toBeNull()
  })
})

describe('keeper: Skiff 轨迹纪律子集旁路（F4b ⑩）', () => {
  let dir: string
  let handler: ((exec: unknown, result: unknown, next: () => Promise<unknown>) => Promise<unknown>) | null = null

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'keeper-skiff-'))
    writeFileSync(join(dir, '.serenity'), 'test')
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(
      join(dir, '.opencode', 'serenity.json'),
      JSON.stringify({ sessionKeeper: { threshold: 1 }, skiff: { roles: { qa: { msms: ['x'] }, tracked: { msms: ['y'], trajectory: { keeper: true } } } } }),
    )
    handler = null
    const fakeCtx = {
      on: (name: string, fn: unknown) => {
        if (name === 'tools/post-execute') handler = fn as typeof handler
      },
    }
    registerKeeper(fakeCtx as never, { defaultThreshold: 1 })
  })

  afterEach(() => {
    unregisterSkiffSession('skiff-qa-1')
    unregisterSkiffSession('skiff-tracked-1')
    rmSync(dir, { recursive: true, force: true })
  })

  it('Skiff 会话（keeper 子集关）→ 计分不触发提醒（完全独立）', async () => {
    registerSkiffSession('skiff-qa-1', 'qa', dir, { session: { id: 'skiff-qa-1' } } as never)
    const exec = { name: 'read', agent: { session: { id: 'skiff-qa-1', header: { cwd: dir } } } }
    const result = (await handler!(exec, {}, async () => ({ kind: 'enter' }))) as { additionalContexts?: unknown[] }
    expect(result.additionalContexts ?? []).toHaveLength(0)
  })

  it('Skiff 会话（keeper 子集开）→ 计分提醒生效（按角色配置）', async () => {
    registerSkiffSession('skiff-tracked-1', 'tracked', dir, { session: { id: 'skiff-tracked-1' } } as never)
    const exec = { name: 'read', agent: { session: { id: 'skiff-tracked-1', header: { cwd: dir } } } }
    const result = (await handler!(exec, {}, async () => ({ kind: 'enter' }))) as { additionalContexts?: unknown[] }
    expect(result.additionalContexts ?? []).toHaveLength(1)
  })

  it('非 skiff 会话 → 计分提醒正常（不受影响）', async () => {
    const exec = { name: 'read', agent: { session: { id: 'normal-1', header: { cwd: dir } } } }
    const result = (await handler!(exec, {}, async () => ({ kind: 'enter' }))) as { additionalContexts?: unknown[] }
    expect(result.additionalContexts ?? []).toHaveLength(1)
  })
})
