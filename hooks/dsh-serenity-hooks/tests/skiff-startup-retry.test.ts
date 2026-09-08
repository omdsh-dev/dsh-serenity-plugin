/**
 * skiff-startup-retry.test.ts — Skiff 调试页 CCC root 定位重试（S142 诊断 D1，v1.30.13）
 *
 * 被验证的缺陷（实证）：`registerSkiff` 只在 apply 时同步一次 `resolveSkiffRoot`——
 * 此刻通常还没有 live 会话，进程 cwd 也不在 CCC 内 → 返回 null → 打印一行警告后
 * **永不重试**（重启日志 `✗ Skiff 调试服务未启动：无法定位 CCC root`，`ss -ltn` 无 3099）。
 *
 * 修复后被验证的三条触发路径：① 启动同步 ② 退避重试定时器 ③ live 会话就绪事件。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const h = vi.hoisted(() => ({
  settings: { skiffEnabled: true, skiffDebugPort: 3099 } as Record<string, unknown>,
  start: vi.fn(async () => {}),
  stop: vi.fn(),
  cccDir: '',
}))

vi.mock('@deepseek-ai/dsh-tools', () => ({ defineTool: (opts: unknown) => opts }))
vi.mock('@deepseek-ai/dsh-llm', () => ({ createUserMessage: (o: unknown) => o }))
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
vi.mock('@deepseek-ai/dsh-session', () => ({
  deriveEventMessage: (event: unknown) => (event as { data?: { message?: unknown } })?.data?.message ?? null,
}))
// 简单配置源（skiffEnabled 由本测试控制；避免读真实 settings.yaml）
vi.mock('../src/settings-section.js', () => ({
  readSimpleSettings: () => h.settings,
  registerSettingsSection: () => {},
  defaultSimpleSettings: () => h.settings,
}))
// 调试服务启动替身（不真的绑端口）
vi.mock('../src/skiff-debug.js', () => ({
  startSkiffDebugServer: h.start,
  stopSkiffDebugServer: h.stop,
}))
// CCC 根解析：只认本测试的临时 CCC（真实 findSerenityRoot(process.cwd()) 会命中
// 开发机上的真实 CCC → "无可解析 CCC"前提变成假阴性；worker 里不能 chdir，故替换纯函数）
vi.mock('../src/ccc.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ccc.js')>()
  return {
    ...actual,
    findSerenityRoot: (cwd: string) =>
      typeof cwd === 'string' && h.cccDir !== '' && cwd.startsWith(h.cccDir) ? h.cccDir : null,
  }
})

import { apply, type Config } from '../src/index.ts'

const CONFIG: Config = { tools: false, guards: false, serenityConfigPaths: [] }

let cccDir: string
let sessions: Array<{ header: { cwd: string } }>
let handlers: Map<string, Array<(p?: unknown) => void>>

function mockCtx() {
  const on = vi.fn((name: string, fn: (p?: unknown) => void) => {
    const list = handlers.get(name) ?? []
    list.push(fn)
    handlers.set(name, list)
  })
  const ctx = {
    tools: { register: vi.fn(() => () => {}), guard: vi.fn() },
    on,
    effect: vi.fn(() => () => {}),
    sessions: { list: () => sessions },
  } as never
  return { ctx, on }
}

function fire(name: string): void {
  for (const fn of handlers.get(name) ?? []) fn()
}

beforeEach(() => {
  vi.useFakeTimers()
  cccDir = mkdtempSync(join(tmpdir(), 'hooks-skiff-retry-'))
  writeFileSync(join(cccDir, '.serenity'), 'test')
  h.cccDir = cccDir
  sessions = []
  handlers = new Map()
  h.settings = { skiffEnabled: true, skiffDebugPort: 3099 }
  h.start.mockClear()
  h.stop.mockClear()
})

afterEach(() => {
  h.cccDir = ''
  vi.useRealTimers()
  rmSync(cccDir, { recursive: true, force: true })
})

describe('Skiff 调试服务 CCC root 定位重试（D1）', () => {
  it('无 CCC 可解析 → 信息级日志（非失败）+ 不启动（排入退避重试，不再"永不重试"）', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx } = mockCtx()
    apply(ctx, CONFIG)
    expect(h.start).not.toHaveBeenCalled()
    // 首次未定位 = 常态（apply 阶段无 live 会话）→ 信息级；失败语义只留给"重试耗尽"
    expect(log.mock.calls.some((c) => String(c[0]).includes('等待 CCC root'))).toBe(true)
    expect(warn.mock.calls.some((c) => String(c[0]).includes('Skiff 调试服务未启动'))).toBe(false)
    // 只说明一次（不随重试刷屏）
    expect(log.mock.calls.filter((c) => String(c[0]).includes('等待 CCC root'))).toHaveLength(1)
    log.mockRestore()
    warn.mockRestore()
  })

  it('重试耗尽（始终无 CCC）→ 响亮告警', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx } = mockCtx()
    apply(ctx, CONFIG)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.start).not.toHaveBeenCalled()
    expect(warn.mock.calls.some((c) => String(c[0]).includes('重试 5 次仍无法定位 CCC root'))).toBe(true)
    log.mockRestore()
    warn.mockRestore()
  })

  it('并发触发只启动一次（v1.30.14：重试定时器 + 就绪事件同时到达 → 不得重复 start）', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    // 启动 Promise 延迟结算 → 制造"在飞"窗口（真实宿主里 listen 是异步的）
    let resolveStart: (() => void) | undefined
    h.start.mockImplementation(
      () =>
        new Promise<void>((res) => {
          resolveStart = () => res()
        }),
    )
    const { ctx } = mockCtx()
    apply(ctx, CONFIG)
    sessions.push({ header: { cwd: cccDir } })
    // 重试定时器到点 + 就绪事件连续到达（同一 tick 内）
    await vi.advanceTimersByTimeAsync(1000)
    fire('session/created')
    fire('agent/session-start')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.start).toHaveBeenCalledTimes(1)
    resolveStart?.()
    await vi.advanceTimersByTimeAsync(0)
    // 不得出现"启动失败"（重复 start 会 EADDRINUSE）；apply 期间其它模块的日志不在此断言范围
    expect(err.mock.calls.some((c) => String(c[0]).includes('Skiff 调试服务启动失败'))).toBe(false)
    log.mockRestore()
    err.mockRestore()
    h.start.mockImplementation(async () => {})
  })

  it('退避重试：定时器到点后 CCC 已可解析 → 启动调试服务', async () => {
    const { ctx } = mockCtx()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    apply(ctx, CONFIG)
    expect(h.start).not.toHaveBeenCalled()
    // CCC 变为可解析（live 会话出现）
    sessions.push({ header: { cwd: cccDir } })
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.start).toHaveBeenCalledTimes(1)
    expect(h.start.mock.calls[0]![1]).toBe(cccDir)
    expect(h.start.mock.calls[0]![2]).toBe(3099)
    log.mockRestore()
  })

  it('live 会话就绪事件（agent/session-start / session/created）→ 立即重试启动', async () => {
    const { ctx } = mockCtx()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    apply(ctx, CONFIG)
    sessions.push({ header: { cwd: cccDir } })
    fire('session/created')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.start).toHaveBeenCalledTimes(1)
    expect(h.start.mock.calls[0]![1]).toBe(cccDir)
    // 已启动后事件再触发不重复启动（started 守卫）
    fire('agent/session-start')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.start).toHaveBeenCalledTimes(1)
    log.mockRestore()
  })

  it('关闭开关 → 清掉待执行的重试（不会"关了还起服务"）', async () => {
    const { ctx } = mockCtx()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    apply(ctx, CONFIG)
    sessions.push({ header: { cwd: cccDir } })
    h.settings = { skiffEnabled: false, skiffDebugPort: 3099 }
    fire('serenity/settings-changed')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.start).not.toHaveBeenCalled()
    log.mockRestore()
  })
})
