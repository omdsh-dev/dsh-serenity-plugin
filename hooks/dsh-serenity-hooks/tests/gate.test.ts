import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
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

import { registerKeeper, rebuildReminderStateSnapshot } from '../src/seams/keeper.js'
import { __setSimpleSourceForTest } from '../src/settings-section.js'

type PostExecuteListener = (
  exec: unknown,
  result: unknown,
  next: () => Promise<{ kind: string; additionalContexts?: unknown[] }>,
) => Promise<unknown>

function captureListener(): PostExecuteListener {
  let captured: PostExecuteListener = async () => undefined
  const ctx = {
    on: (event: string, listener: PostExecuteListener) => {
      if (event === 'tools/post-execute') captured = listener
      return () => {}
    },
  } as any
  registerKeeper(ctx, { defaultThreshold: 2 })
  return captured
}

function fakeExec(cwd: string, name = 'write') {
  return { name, agent: { session: { header: { cwd } } } }
}

const accept = () => Promise.resolve({ kind: 'accept' })

describe('keeper: 激活门控（只在 .serenity 存在的目录生效）', () => {
  it('非 CCC 目录：不计分、不提醒，原样放行', async () => {
    const listener = captureListener()
    const downstream = await listener(fakeExec('/tmp/non-ccc'), {}, accept)
    // 阈值 2，write=3 本应触发；但非 CCC → 直接放行且无提醒
    expect(downstream).toEqual({ kind: 'accept' })
  })

  it('CCC 目录：达阈值注入 [TRAJECTORY-STEWARD] 提醒', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keeper-gate-'))
    writeFileSync(join(dir, '.serenity'), 'test')
    try {
      const listener = captureListener()
      const downstream = (await listener(
        fakeExec(dir),
        {},
        () => Promise.resolve({ kind: 'accept', additionalContexts: [] }),
      )) as { kind: string; additionalContexts: { content: { text: string }[] }[] }
      expect(downstream.kind).toBe('accept')
      const texts = (downstream.additionalContexts ?? [])
        .map((c) => c.content?.map((b) => b.text).join(''))
        .join('\n')
      expect(texts).toContain('[TRAJECTORY-STEWARD-recorded-K1]')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('v1.23.3 重建提醒：不做节流（每轮都催）+ 连续 3 轮升级强制语气（用户拍板）', () => {
  afterEach(() => {
    // 重置注入的简单配置源（防跨用例污染）
    __setSimpleSourceForTest(null)
  })

  // 完整装配：sessionProjections 返回固定高压力（9000 tokens ≥ 阈值 8K*1000 缺省触发——需求① K 数值判定）
  function captureWithPressure(sessionId = 's1'): {
    listener: PostExecuteListener
  } {
    let captured: PostExecuteListener = async () => undefined
    const ctx = {
      on: (event: string, listener: PostExecuteListener) => {
        if (event === 'tools/post-execute') captured = listener
        return () => {}
      },
      get: (name: string) =>
        name === 'sessionProjections'
          ? { snapshot: () => ({ values: { contextPressure: { projectedTokens: 9000, contextWindow: 10000 } } }) }
          : undefined,
    } as any
    registerKeeper(ctx, { defaultThreshold: 200 })
    // 需求①：注入简单配置源（rebuildEnabled + 低 K 阈值 8 → 9000 ≥ 8000 恒触发）
    __setSimpleSourceForTest(() => ({ gatewayEnabled: false, rebuildEnabled: true, rebuildThresholdK: 8, skiffEnabled: false, skiffDebugPort: 3099, acpEnabled: false, acpHttpPort: 3100, publicAskEnabled: false, autopilotEnabled: false }))
    return { listener: captured }
  }

  async function runOnce(listener: PostExecuteListener, sessionId: string, cwd: string): Promise<string> {
    const exec = { name: 'read', agent: { session: { id: sessionId, header: { cwd } } } }
    const downstream = (await listener(
      exec,
      {},
      () => Promise.resolve({ kind: 'accept', additionalContexts: [] }),
    )) as { kind: string; additionalContexts: { content: { text: string }[] }[] }
    return (downstream.additionalContexts ?? [])
      .map((c) => c.content?.map((b) => b.text).join(''))
      .join('\n')
  }

  it('每次超阈值都注入（不做节流）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keeper-rebuild-'))
    writeFileSync(join(dir, '.serenity'), 'test')
    try {
      const { listener } = captureWithPressure()
      // 连续两次工具调用 → 每次都注入 [TRAJECTORY] 提醒（无冷却跳过）
      const t1 = await runOnce(listener, 's1', dir)
      const t2 = await runOnce(listener, 's1', dir)
      expect(t1).toContain('[TRAJECTORY]')
      expect(t2).toContain('[TRAJECTORY]')
      expect(t2).not.toContain('[TRAJECTORY-ESCALATED]') // 第 2 轮仍未升级
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('连续 3 轮超阈值未 rebuild → 升级 [TRAJECTORY-ESCALATED] 强制语气（持续催）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keeper-rebuild-'))
    writeFileSync(join(dir, '.serenity'), 'test')
    try {
      const { listener } = captureWithPressure()
      const t1 = await runOnce(listener, 's2', dir)
      const t2 = await runOnce(listener, 's2', dir)
      const t3 = await runOnce(listener, 's2', dir)
      const t4 = await runOnce(listener, 's2', dir)
      expect(t1).toContain('[TRAJECTORY]')
      expect(t2).toContain('[TRAJECTORY]')
      expect(t3).toContain('[TRAJECTORY-ESCALATED]') // 第 3 轮升级
      expect(t3).toContain('mandatory')
      expect(t4).toContain('[TRAJECTORY-ESCALATED]') // 升级后持续催（不重置）
      // 状态累计可见
      expect(rebuildReminderStateSnapshot().get('s2')?.consecutive).toBeGreaterThanOrEqual(4)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
