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

import { registerKeeper } from '../src/seams/keeper.js'

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

  it('CCC 目录：达阈值注入 [SESSION-KEEPER] 提醒', async () => {
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
      expect(texts).toContain('[SESSION-KEEPER-recorded-K1]')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
