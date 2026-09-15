/**
 * skiff-startup-retry.test.ts — Skiff 调试页 CCC root 定位（S142 诊断 D1，v1.30.13；C2 后重写）
 *
 * 被验证的缺陷（实证）：`registerSkiff` 只在 apply 时同步一次 `resolveSkiffRoot`——
 * 此刻通常还没有 live 会话，进程 cwd 也不在 CCC 内 → 返回 null → 打印一行警告后
 * **永不重试**（重启日志 `✗ Skiff 调试服务未启动：无法定位 CCC root`，`ss -ltn` 无 3099）。
 *
 * **三条触发路径（本文件的核心契约，任何一条都不得丢）**：
 *   ① 启动时同步一次
 *   ② **反应式再触发**（`agent/session-start` / `session/created`）
 *   ③ **持久来源兜底**（`resolveSkiffRoot` 第 ④ 档：ccc-roots 的并集枚举，含
 *      工作区注册表 / 持久化会话——**不依赖任何 live 会话**，apply 时刻即可解析）
 *
 * v1.35（C2 块 C3）变更：**退避重试定时器已删除**——它存在的理由（"apply 时刻解析不到根"）
 * 由第 ③ 条从源头消掉。原"重试耗尽 → 响亮告警"用例按新语义删除（该告警路径不复存在）。
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
  /** 额外可解析的 CCC 根（多候选场景用；默认只认 cccDir） */
  extraRoots: [] as string[],
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
    findSerenityRoot: (cwd: string) => {
      if (typeof cwd !== 'string') return null
      const all = [h.cccDir, ...h.extraRoots].filter((r) => r !== '')
      for (const r of all) if (cwd.startsWith(r)) return r
      return null
    },
  }
})

import { apply, type Config } from '../src/index.ts'

const CONFIG: Config = { tools: false, guards: false, serenityConfigPaths: [] }

let cccDir: string
let sessions: Array<{ header: { cwd: string } }>
/** 持久来源替身：`workspaceRegistry.list()` 返回值（第 ③ 条路径的输入） */
let workspaces: Array<{ path: string }>
let handlers: Map<string, Array<(p?: unknown) => void>>
/** plugin 全局配置路径的原始值（测试卫生：本文件注入临时配置，结束还原） */
const prevCfgEnv = process.env.SERENITY_HOOKS_CONFIG

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
    get: (name: string) => (name === 'workspaceRegistry' ? { list: () => workspaces } : undefined),
  } as never
  return { ctx, on }
}

function fire(name: string): void {
  for (const fn of handlers.get(name) ?? []) fn()
}

/** 等微任务链 settle（`sync` 为 async；启动/事件触发的解析不止一个 await） */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  cccDir = mkdtempSync(join(tmpdir(), 'hooks-skiff-retry-'))
  writeFileSync(join(cccDir, '.serenity'), 'test')
  h.cccDir = cccDir
  h.extraRoots = []
  sessions = []
  workspaces = []
  handlers = new Map()
  h.settings = { skiffEnabled: true, skiffDebugPort: 3099 }
  h.start.mockClear()
  h.start.mockImplementation(async () => {})
  h.stop.mockClear()
  // C4 块 A 测试卫生：`apply` 会装配微信主动发送面，其 sync 读 plugin 全局配置——
  // 不隔离就会去真绑生产端口 3082（本机真插件在跑时是占用告警，不在跑时**抢走生产端口**）。
  // 注入临时配置（面关）→ 不绑端口、无重试噪音。
  process.env.SERENITY_HOOKS_CONFIG = join(cccDir, 'serenity-hooks.json')
  writeFileSync(join(cccDir, 'serenity-hooks.json'), JSON.stringify({ weixinApi: { enabled: false, port: 0 } }))
})

afterEach(() => {
  h.cccDir = ''
  vi.useRealTimers()
  if (prevCfgEnv === undefined) delete process.env.SERENITY_HOOKS_CONFIG
  else process.env.SERENITY_HOOKS_CONFIG = prevCfgEnv
  rmSync(cccDir, { recursive: true, force: true })
})

describe('Skiff 调试服务 CCC root 定位（D1；C2 后语义）', () => {
  it('触发路径①：无任何 CCC 来源 → 信息级日志（非失败）+ 不启动', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx } = mockCtx()
    apply(ctx, CONFIG)
    await settle()
    expect(h.start).not.toHaveBeenCalled()
    // 首次未定位 = 常态（apply 阶段无 live 会话）→ **信息级**，不是失败
    expect(log.mock.calls.some((c) => String(c[0]).includes('等待 CCC root'))).toBe(true)
    expect(warn.mock.calls.some((c) => String(c[0]).includes('Skiff 调试服务未启动'))).toBe(false)
    // 只说明一次（不刷屏）
    expect(log.mock.calls.filter((c) => String(c[0]).includes('等待 CCC root'))).toHaveLength(1)
    log.mockRestore()
    warn.mockRestore()
  })

  it('触发路径②：live 会话就绪事件（session/created）→ 立即启动', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { ctx } = mockCtx()
    apply(ctx, CONFIG)
    await settle()
    expect(h.start).not.toHaveBeenCalled()
    sessions.push({ header: { cwd: cccDir } })
    fire('session/created')
    await settle()
    expect(h.start).toHaveBeenCalledTimes(1)
    expect(h.start.mock.calls[0]![1]).toBe(cccDir)
    log.mockRestore()
  })

  it('触发路径②（另一事件）：agent/session-start → 立即启动；已启动后不重复启动', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { ctx } = mockCtx()
    apply(ctx, CONFIG)
    await settle()
    sessions.push({ header: { cwd: cccDir } })
    fire('agent/session-start')
    await settle()
    expect(h.start).toHaveBeenCalledTimes(1)
    expect(h.start.mock.calls[0]![1]).toBe(cccDir)
    // started 守卫：再来一次事件不重复启动
    fire('agent/session-start')
    await settle()
    expect(h.start).toHaveBeenCalledTimes(1)
    log.mockRestore()
  })

  it('🔴 触发路径③：**无 live 会话** 但持久来源唯一 → 启动时即可解析（退避重试得以退场的原因）', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { ctx } = mockCtx()
    // 只有持久来源（工作区注册表），**零 live 会话**、进程 cwd 不在 CCC 内
    workspaces = [{ path: cccDir }]
    apply(ctx, CONFIG)
    await settle()
    expect(h.start).toHaveBeenCalledTimes(1)
    expect(h.start.mock.calls[0]![1]).toBe(cccDir)
    expect(h.start.mock.calls[0]![2]).toBe(3099)
    log.mockRestore()
  })

  it('触发路径③ 的收敛条件：持久来源**多个候选** → 不猜（保持 null，不启动）', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const other = mkdtempSync(join(tmpdir(), 'hooks-skiff-other-'))
    writeFileSync(join(other, '.serenity'), 'test')
    // 两个候选**都必须可解析**（否则退化为单候选 → 会启动，测不到收敛条件）
    h.extraRoots = [other]
    try {
      const { ctx } = mockCtx()
      workspaces = [{ path: cccDir }, { path: other }]
      apply(ctx, CONFIG)
      await settle()
      expect(h.start).not.toHaveBeenCalled()
    } finally {
      h.extraRoots = []
      rmSync(other, { recursive: true, force: true })
      log.mockRestore()
    }
  })

  it('并发触发只启动一次（v1.30.14：定时/事件同拍 → 不得重复 start）', async () => {
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
    workspaces = [{ path: cccDir }]
    apply(ctx, CONFIG)
    // 启动 sync 仍在飞（未 settle）时，两个就绪事件同拍到达
    fire('session/created')
    fire('agent/session-start')
    await settle()
    expect(h.start).toHaveBeenCalledTimes(1)
    resolveStart?.()
    await settle()
    // 不得出现"启动失败"（重复 start 会 EADDRINUSE）；apply 期间其它模块的日志不在此断言范围
    expect(err.mock.calls.some((c) => String(c[0]).includes('Skiff 调试服务启动失败'))).toBe(false)
    log.mockRestore()
    err.mockRestore()
    h.start.mockImplementation(async () => {})
  })

  it('关闭开关 → 不起服务（不因"根可解析"而启动）', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { ctx } = mockCtx()
    workspaces = [{ path: cccDir }]
    h.settings = { skiffEnabled: false, skiffDebugPort: 3099 }
    apply(ctx, CONFIG)
    await settle()
    // 即便持久来源可解析，闸关即不启
    expect(h.start).not.toHaveBeenCalled()
    // 随后开启（settings-changed 热同步）→ 启动
    h.settings = { skiffEnabled: true, skiffDebugPort: 3099 }
    fire('serenity/settings-changed')
    await settle()
    expect(h.start).toHaveBeenCalledTimes(1)
    // 再关 → 停服
    h.settings = { skiffEnabled: false, skiffDebugPort: 3099 }
    fire('serenity/settings-changed')
    await settle()
    expect(h.stop).toHaveBeenCalledTimes(1)
    // 关着时事件再触发也不起
    fire('session/created')
    await settle()
    expect(h.start).toHaveBeenCalledTimes(1)
    log.mockRestore()
  })
})
