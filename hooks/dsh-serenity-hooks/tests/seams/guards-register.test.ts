/**
 * guards-register.test.ts — ⑤ 第 35 件：**拦截缝的装配面**（`registerGuards`）
 *
 * 挑靶依据 = §3-9b 的 C 类，优先子集 = `seams/guards.ts` 的 **4 处 `fstat-no`**：
 *   `resolveAgentCwd` ／ `extractPathArg` ／ `extractAction` ／ `evaluate`。
 *
 * 🔴 **它们为什么从未被执行（可达性取证，不是推测）**：三个断言取值的私有助手**只被 `evaluate` 调用**
 * （`guards.ts` 的 472／478／479 行），而 `evaluate` **只被 `registerGuards` 内部创建的两个处理函数调用**
 * —— ① `ctx.on('tools/pre-execute', …)` 的**瀑布**（deny 短路执行）② `ctx.tools.guard(…)` 的**终局守卫**。
 * ⇒ 既有 `tests/guards.test.ts`（714 行）测的是**纯函数 `decideGuard`** 与几个可见性助手，
 * **全仓没有任何测试调用过 `registerGuards`**（grep `registerGuards` 在 `tests/**` = 0 命中）
 * ⇒ 这条**决定"工具调用是否被拒"的衔接缝**此前**零行为证据**。
 *
 * 🔵 打法 = 本会话既有的 L2 装配测试形态（同 `tests/seams/context-register.test.ts`）：
 * 用一个**能捕获处理器的 ctx** 调 `registerGuards`，再把那两个处理器**真调**起来。
 * 🔵 **密闭性**：`DEFAULT_SERENITY_CONFIG_PATHS` 是**相对 CCC 根**的（`.opencode/serenity.json` ／
 * `.dsh/serenity.json`）⇒ 指向临时 CCC 时**不会读真机配置**（本文件全程只碰临时目录）。
 *
 * ⚠️ **本件的诚实边界**：本文件**不重测 `decideGuard` 的决策语义**（那是既有 714 行测试的职责），
 * 只钉**装配面契约**（谁被调用、cwd/路径/action 怎么取出、deny 怎么短路、终局守卫只 deny 不可 allow）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { registerGuards } from '../../src/seams/guards.js'

let ccc = ''      // 有 `.serenity` 的真 CCC
let outside = ''  // 无 `.serenity`

beforeEach(() => {
  ccc = mkdtempSync(join(tmpdir(), 'guards-reg-ccc-'))
  writeFileSync(join(ccc, '.serenity'), 'home-serenity\n', 'utf-8')
  outside = mkdtempSync(join(tmpdir(), 'guards-reg-out-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(ccc, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

/** 捕获型 ctx：`registerGuards` 只会碰 `ctx.on` 与 `ctx.tools.guard` 两个面 */
function rig(): {
  events: string[]
  pre: Array<(exec: unknown, next: () => Promise<unknown>) => Promise<unknown>>
  terminal: Array<(exec: unknown) => string | undefined>
} {
  const events: string[] = []
  const pre: Array<(exec: unknown, next: () => Promise<unknown>) => Promise<unknown>> = []
  const terminal: Array<(exec: unknown) => string | undefined> = []
  const ctx = {
    on: (name: string, fn: never) => { events.push(name); if (name === 'tools/pre-execute') pre.push(fn) },
    tools: { guard: (fn: never) => { terminal.push(fn) } },
  }
  registerGuards(ctx as never)
  return { events, pre, terminal }
}

/** 真值形态的 ToolExecution：`resolveAgentCwd` 读 `agent.session.header.cwd` */
function execIn(cwd: string | null, args: unknown, name = 'container_fs'): unknown {
  return {
    name,
    arguments: args,
    ...(cwd === null ? {} : { agent: { session: { header: { cwd }, id: 'S900' } } }),
  }
}

/** `next()` 的哨兵值 + 调用计数（瀑布契约的判据） */
function nextStub(): { next: () => Promise<unknown>; calls: () => number } {
  let n = 0
  const sentinel = { kind: 'continue-sentinel' }
  return { next: async () => { n++; return sentinel }, calls: () => n }
}

describe('seams/guards：`registerGuards` 装配面（⑤ 第 35 件）', () => {
  it('① 接线自证：只订阅 `tools/pre-execute` 一次，并注册恰好一个终局 guard', () => {
    const { events, pre, terminal } = rig()
    expect(events).toEqual(['tools/pre-execute'])
    expect(pre).toHaveLength(1)
    expect(terminal).toHaveLength(1)
  })

  it('② 🔴 CCC 根取自 `exec.agent.session.header.cwd`（判别性：同参数换个 cwd ⇒ 结论翻转）', async () => {
    const { pre } = rig()
    const args = { path: '../escape.txt' } // 越界路径

    // cwd 指向真 CCC ⇒ 越界 ⇒ deny
    const inCcc = nextStub()
    await expect(pre[0]!(execIn(ccc, args), inCcc.next)).resolves.toMatchObject({ kind: 'deny' })
    expect(inCcc.calls(), 'deny 路径不得调用 next').toBe(0)

    // **同一个 exec 形状**，只把 cwd 换成非 CCC ⇒ 在 474 行就 allow 返回（判别性）
    const outsideCcc = nextStub()
    await expect(pre[0]!(execIn(outside, args), outsideCcc.next)).resolves.toMatchObject({ kind: 'continue-sentinel' })
    expect(outsideCcc.calls()).toBe(1)
  })

  it('③ 非 CCC ⇒ 两个处理器都放行，且不抛（`cccRootForCwd` 解析不到根）', async () => {
    const { pre, terminal } = rig()
    const s = nextStub()
    const out = await pre[0]!(execIn(outside, { path: '../escape.txt' }, 'bash'), s.next)
    expect(out).toMatchObject({ kind: 'continue-sentinel' })
    expect(s.calls()).toBe(1)
    expect(terminal[0]!(execIn(outside, { path: '../escape.txt' }, 'bash'))).toBeUndefined()
  })

  it('④ 无 `exec.agent` ⇒ 回落 `process.cwd()`（用 spy 控住，判别性两读）', async () => {
    const { pre } = rig()
    const args = { path: '../escape.txt' }

    vi.spyOn(process, 'cwd').mockReturnValue(ccc)
    await expect(pre[0]!(execIn(null, args), nextStub().next)).resolves.toMatchObject({ kind: 'deny' })

    vi.spyOn(process, 'cwd').mockReturnValue(outside)
    await expect(pre[0]!(execIn(null, args), nextStub().next)).resolves.toMatchObject({ kind: 'continue-sentinel' })
  })

  it('⑤ 越界路径 ⇒ 瀑布返回 deny ＋ 终局守卫返回**同一句** reason（逐字含 `path escape blocked`）', async () => {
    const { pre, terminal } = rig()
    const exec = execIn(ccc, { path: '../escape.txt' })

    const out = (await pre[0]!(exec, nextStub().next)) as { kind: string; reason: string }
    expect(out.kind).toBe('deny')
    expect(out.reason).toContain('path escape blocked')

    // 终局守卫只回 reason 串（不是对象）—— 契约与瀑布不同
    const g = terminal[0]!(exec)
    expect(typeof g).toBe('string')
    expect(g).toContain('path escape blocked')
  })

  it('⑥ 瀑布契约：deny ⇒ **不调用** `next()`；放行 ⇒ **恰好调用一次**（正控）', async () => {
    const { pre } = rig()
    const h = pre[0]!

    const denied = nextStub()
    await h(execIn(ccc, { path: '../escape.txt' }), denied.next)
    expect(denied.calls(), 'deny 短路执行').toBe(0)

    const allowed = nextStub()
    const out = await h(execIn(ccc, { path: 'inside.txt' }), allowed.next)
    expect(allowed.calls()).toBe(1)
    expect(out).toMatchObject({ kind: 'continue-sentinel' })
  })

  it('⑦ 终局守卫**只 deny 不可 allow**：放行时返回 `undefined`（不是 allow 对象）', () => {
    const { terminal } = rig()
    expect(terminal[0]!(execIn(ccc, { path: 'inside.txt' }))).toBeUndefined()
  })

  it('⑧ `extractPathArg` 键序：命中**先出现**的键（`path` 优先于 `file_path`）', async () => {
    const { pre } = rig()
    // path 合法、file_path 越界 ⇒ 取到 path ⇒ 放行（若取 file_path 则会 deny）
    const s = nextStub()
    await expect(pre[0]!(execIn(ccc, { path: 'ok.txt', file_path: '../escape.txt' }), s.next))
      .resolves.toMatchObject({ kind: 'continue-sentinel' })

    // 只给 file_path（键序第 2）⇒ 仍会被取出 ⇒ deny
    await expect(pre[0]!(execIn(ccc, { file_path: '../escape.txt' }), nextStub().next))
      .resolves.toMatchObject({ kind: 'deny' })
  })

  it('⑨ `extractPathArg` 的 `paths` 兜底：取**首个**元素（数组形态的批量路径）', async () => {
    const { pre } = rig()
    await expect(pre[0]!(execIn(ccc, { paths: ['../escape.txt', 'ok.txt'] }), nextStub().next))
      .resolves.toMatchObject({ kind: 'deny' })
    await expect(pre[0]!(execIn(ccc, { paths: ['ok.txt', '../escape.txt'] }), nextStub().next))
      .resolves.toMatchObject({ kind: 'continue-sentinel' })
  })

  it('⑩ `arguments` 不是对象 ⇒ 两个提取器都回 undefined ⇒ 不因路径拒绝（且不抛）', async () => {
    const { pre } = rig()
    for (const args of ['not-an-object', null, 42]) {
      await expect(pre[0]!(execIn(ccc, args), nextStub().next), String(args))
        .resolves.toMatchObject({ kind: 'continue-sentinel' })
    }
  })

  it('⑪ `extractAction` 被真进入（`arguments.action` 一路带到决定处）；语义归 `decideGuard`', async () => {
    const { pre } = rig()
    // 🔵 诚实边界：本件只保证**它被进入**并随参数带下去；`action` 的具体决策语义
    //    由既有 `tests/guards.test.ts` 的 `decideGuard` 组负责，这里不重复也不硬凑。
    await expect(pre[0]!(execIn(ccc, { path: 'inside.txt', action: 'list' }), nextStub().next))
      .resolves.toMatchObject({ kind: 'continue-sentinel' })
    await expect(pre[0]!(execIn(ccc, { path: 'inside.txt', action: 'rm' }), nextStub().next))
      .resolves.toMatchObject({ kind: 'continue-sentinel' })
  })

  it('⑫ 端到端：真写 `.serenity-safe-on` ＋ toolName=bash ⇒ 两个处理器都拒（真故障形态）', async () => {
    const { pre, terminal } = rig()
    writeFileSync(join(ccc, '.serenity-safe-on'), '', 'utf-8') // 真标记文件，不是打桩

    const s = nextStub()
    const out = (await pre[0]!(execIn(ccc, {}, 'bash'), s.next)) as { kind: string; reason: string }
    expect(out.kind).toBe('deny')
    expect(out.reason).toContain('bash: no such tool')
    expect(s.calls()).toBe(0)
    expect(terminal[0]!(execIn(ccc, {}, 'bash'))).toContain('bash: no such tool')
  })
})
