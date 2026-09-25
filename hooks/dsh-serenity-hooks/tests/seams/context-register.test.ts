/**
 * context-register.test.ts — 拦截缝 `registerContext` 的 **行为**测试（S142 ⑤ 分层单元测试）
 *
 * 🔴 **为何单开一个文件**：`tests/context.test.ts` 只覆盖 `seams/context.ts` 的**纯函数**
 * （`accIdentityText` / `accMessage` / `shouldAutoRestore` / `shouldRestoreActive`）⇒
 * coverage 实测该模块 **43.85%**，而 `registerContext`（`src/seams/context.ts` 的 147–285）
 * **从未被执行** —— 那是"缝的接线与效果"，恰是本模块对系统真正起作用的部分。
 * 本文件补的就是这一块。
 *
 * **分层**：本条属 L2（服务与适配）的**装配测试**（约束文档 §5.2），与同目录的纯函数测试分开。
 *
 * **替身与安全性**（读源码后确认，非猜测 —— fake ctx 有已知盲区，故必须逐条核）：
 *   · `ctx` = 只记录 handler 的最小对象（不模拟 cordis Proxy）
 *   · `agent` = `{ session, inject }`
 *   · `registerEntrySkillSection` 内部 **try/catch** ⇒ 缺 `agent.ctx` 只是返回 false，**不抛**
 *   · `registerTrajectorySkillSection` 内部 try/catch ＋ `readLastBound()` 无绑定即**早返回**
 *   ⇒ 二者都在 `agent.inject(...)` **之前**，既然都不抛，注入就一定会发生 ⇒ 断言可靠
 *   · 注入**之后**的 `syncSafeModeRestriction` 等即使抛，也被 `agent/created` 处理器自己的
 *     try/catch 吞掉（不影响已发生的注入）
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// `accMessage` 走宿主构造器；替身让它恒等返回，便于直接读正文
vi.mock('@deepseek-ai/dsh-llm', () => ({
  createUserMessage: (o: unknown) => o,
}))

import { registerContext } from '../../src/seams/context.js'
import { getActiveSessionInfo } from '../../src/trajectory-ops.js'

type Handler = (...args: unknown[]) => unknown

interface FakeCtx {
  handlers: Map<string, Handler[]>
  on: (name: string, fn: Handler) => FakeCtx
}

function fakeCtx(): FakeCtx {
  const handlers = new Map<string, Handler[]>()
  const ctx: FakeCtx = {
    handlers,
    on(name, fn) {
      const list = handlers.get(name) ?? []
      list.push(fn)
      handlers.set(name, list)
      return ctx
    },
  }
  return ctx
}

function fakeAgent(id: string, extra: Record<string, unknown> = {}): { agent: unknown; injected: unknown[] } {
  const injected: unknown[] = []
  return {
    agent: {
      session: { id, ...extra },
      inject: (m: unknown) => {
        injected.push(m)
      },
    },
    injected,
  }
}

/** 取注入消息正文（`createUserMessage` 已被替身改成恒等返回） */
function msgText(msg: unknown): string {
  const m = msg as { content?: Array<{ text?: string }> }
  return (m.content ?? []).map((c) => c.text ?? '').join('')
}

let dir: string
let outside: string

beforeEach(() => {
  // 有 .serenity ⇒ cccRootForCwd 认它是 CCC 根
  dir = mkdtempSync(join(tmpdir(), 'hooks-ctxseam-'))
  writeFileSync(join(dir, '.serenity'), 'test')
  // 无 .serenity ⇒ 不在任何 CCC 内
  outside = mkdtempSync(join(tmpdir(), 'hooks-ctxout-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

async function fireCreated(ctx: FakeCtx, agent: unknown): Promise<void> {
  for (const h of ctx.handlers.get('agent/created') ?? []) await h({ agent })
}

async function firePreStep(
  ctx: FakeCtx,
  agent: unknown,
  messages: unknown[],
  downstream: unknown,
): Promise<{ calls: number; decision: unknown }> {
  const h = (ctx.handlers.get('agent/pre-step') ?? [])[0]
  let calls = 0
  const next = async (): Promise<unknown> => {
    calls += 1
    return downstream
  }
  const decision = await h({ agent, messages }, next)
  return { calls, decision }
}

// ── 接线：哪个开关装哪条缝 ──────────────────────────────────────────────────
// ⚠️ `injected` / `sectionedAgents` 都是**模块级 Set**（无清理路径，见模块图 §3-4）
// ⇒ 每个用例必须用**互不相同**的 session id，否则会被"已注入过"提前返回。

describe('registerContext: 接线（opts 决定装哪条缝）', () => {
  it('默认：两条缝都装（agent/created 播种 ＋ agent/pre-step 兜底）', () => {
    const ctx = fakeCtx()
    registerContext(ctx as never)
    expect(ctx.handlers.get('agent/created')).toHaveLength(1)
    expect(ctx.handlers.get('agent/pre-step')).toHaveLength(1)
  })

  it('seedOnStart=false ⇒ 不装 agent/created（pre-step 仍在）', () => {
    const ctx = fakeCtx()
    registerContext(ctx as never, { seedOnStart: false })
    expect(ctx.handlers.get('agent/created')).toBeUndefined()
    expect(ctx.handlers.get('agent/pre-step')).toHaveLength(1)
  })

  it('injectOnPrompt=false ⇒ 不装 agent/pre-step（created 仍在）', () => {
    const ctx = fakeCtx()
    registerContext(ctx as never, { injectOnPrompt: false })
    expect(ctx.handlers.get('agent/created')).toHaveLength(1)
    expect(ctx.handlers.get('agent/pre-step')).toBeUndefined()
  })
})

// ── agent/created：播种 ACC 身份 ────────────────────────────────────────────

describe('registerContext: agent/created 播种', () => {
  it('CCC 内根会话 ⇒ 注入一次，正文含 ACC 身份锚点与 CCC 根', async () => {
    const { agent, injected } = fakeAgent('main-seam-1', { header: { cwd: dir } })
    const ctx = fakeCtx()
    registerContext(ctx as never, { injectOnPrompt: false })

    await fireCreated(ctx, agent)

    expect(injected).toHaveLength(1)
    const text = msgText(injected[0])
    expect(text).toContain('[ACC] Serenity cognitive container active')
    expect(text).toContain(dir)
  })

  it('同一载体重复触发 ⇒ 只注入一次（`injected` 幂等，防每轮 token 膨胀）', async () => {
    const { agent, injected } = fakeAgent('main-seam-2', { header: { cwd: dir } })
    const ctx = fakeCtx()
    registerContext(ctx as never, { injectOnPrompt: false })

    await fireCreated(ctx, agent)
    await fireCreated(ctx, agent)
    await fireCreated(ctx, agent)

    expect(injected).toHaveLength(1)
  })

  it('不在任何 CCC（cwd 无 .serenity）⇒ 完全不注入', async () => {
    const { agent, injected } = fakeAgent('main-seam-3', { header: { cwd: outside } })
    const ctx = fakeCtx()
    registerContext(ctx as never, { injectOnPrompt: false })

    await fireCreated(ctx, agent)

    expect(injected).toHaveLength(0)
  })

  it('skiff 会话 ⇒ 完全旁路（不注入 ACC 身份，角色提示词全替换）', async () => {
    const { agent, injected } = fakeAgent('skiff-qa-seam-1', { header: { cwd: dir } })
    const ctx = fakeCtx()
    registerContext(ctx as never, { injectOnPrompt: false })

    await fireCreated(ctx, agent)

    expect(injected).toHaveLength(0)
  })
})

// ── 重启恢复：从历史把激活会话捞回内存 ──────────────────────────────────────
// 覆盖 `registerContext` 里此前**零执行**的那一段（恢复链 ①②③ ＋ 展示码派生 ＋ 配置门）。

describe('registerContext: agent/created 重启恢复（覆盖此前零执行的恢复链）', () => {
  /** 造一个真实存在的会话目录，返回 { dirName, mdPath } */
  function makeSessionDir(name: string): { dirName: string; mdPath: string } {
    const sessDir = join(dir, 'AGENT_SESSIONS', name)
    mkdirSync(sessDir, { recursive: true })
    const mdPath = join(sessDir, 'SESSION.md')
    writeFileSync(mdPath, '# test')
    return { dirName: name, mdPath }
  }

  it('② 文本扫回退：events 含「SESSION.md path:」⇒ 恢复激活会话，并从目录名派生 S### 展示码', async () => {
    const { dirName, mdPath } = makeSessionDir('2026-01-01--S042--restore-me')
    const id = 'main-restore-2'
    const { agent } = fakeAgent(id, {
      header: { cwd: dir },
      // 同时带标记行与规范路径行：两种扫描策略下都应能解析
      events: [{ type: 'user/message', text: `[SESSION CONTEXT] Activated: S042\nSESSION.md path: ${mdPath}` }],
    })
    const ctx = fakeCtx()
    registerContext(ctx as never, { injectOnPrompt: false })

    expect(getActiveSessionInfo(id)).toBeNull() // 前置：内存里还没有

    await fireCreated(ctx, agent)

    expect(getActiveSessionInfo(id)).toEqual({ sessionId: 'S042', dirName, mdPath })
  })

  it('② 但 mdPath 已不存在（陈旧/归档/删除）⇒ 不恢复（existsSync 校验拦住污染）', async () => {
    const id = 'main-restore-stale'
    const { agent } = fakeAgent(id, {
      header: { cwd: dir },
      events: [{ type: 'user/message', text: `SESSION.md path: ${join(dir, 'AGENT_SESSIONS', '2026-01-01--S043--gone', 'SESSION.md')}` }],
    })
    const ctx = fakeCtx()
    registerContext(ctx as never, { injectOnPrompt: false })

    await fireCreated(ctx, agent)

    expect(getActiveSessionInfo(id)).toBeNull()
  })

  it('配置门：hooks.autoRestoreSession=false ⇒ 不恢复（即使历史可解析）', async () => {
    const { mdPath } = makeSessionDir('2026-01-01--S044--gated')
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({ hooks: { autoRestoreSession: false } }))

    const id = 'main-restore-gated'
    const { agent } = fakeAgent(id, {
      header: { cwd: dir },
      events: [{ type: 'user/message', text: `SESSION.md path: ${mdPath}` }],
    })
    const ctx = fakeCtx()
    registerContext(ctx as never, { injectOnPrompt: false })

    await fireCreated(ctx, agent)

    expect(getActiveSessionInfo(id)).toBeNull()
  })

  it('全新会话（无历史）⇒ 不恢复（不把过去的 SESSION 注入新任务）', async () => {
    makeSessionDir('2026-01-01--S045--fresh')
    const id = 'main-restore-fresh'
    const { agent } = fakeAgent(id, { header: { cwd: dir }, events: [] })
    const ctx = fakeCtx()
    registerContext(ctx as never, { injectOnPrompt: false })

    await fireCreated(ctx, agent)

    expect(getActiveSessionInfo(id)).toBeNull()
  })
})

// ── agent/pre-step：必须 next() 委托 ＋ 消息顺序 ────────────────────────────

describe('registerContext: agent/pre-step（"context-only 必须 next() 委托"的回归钉）', () => {
  it('下游 kind=enter ⇒ **调用 next()**，且返回 enter：ACC 消息在前、原 messages 居中、下游消息在后', async () => {
    const { agent } = fakeAgent('main-pre-1', { header: { cwd: dir } })
    const ctx = fakeCtx()
    registerContext(ctx as never, { seedOnStart: false })

    const { calls, decision } = await firePreStep(
      ctx,
      agent,
      [{ tag: 'current' }],
      { kind: 'enter', messages: [{ tag: 'downstream' }] },
    )

    // 🔴 核心不变量：context-only 缝**必须**委托，短路会跳过后续策略监听器
    expect(calls).toBe(1)

    const d = decision as { kind: string; messages: unknown[] }
    expect(d.kind).toBe('enter')
    expect(d.messages).toHaveLength(3)
    expect(msgText(d.messages[0])).toContain('[ACC] Serenity cognitive container active')
    expect(d.messages[1]).toEqual({ tag: 'current' })
    expect(d.messages[2]).toEqual({ tag: 'downstream' })
  })

  it('下游非 enter ⇒ 不注入、原样返回 downstream', async () => {
    const { agent } = fakeAgent('main-pre-2', { header: { cwd: dir } })
    const ctx = fakeCtx()
    registerContext(ctx as never, { seedOnStart: false })

    const downstream = { kind: 'skip', messages: [] }
    const { calls, decision } = await firePreStep(ctx, agent, [{ tag: 'current' }], downstream)

    expect(calls).toBe(1) // 仍然委托
    expect(decision).toEqual(downstream)
  })

  it('不在任何 CCC ⇒ 不注入、原样返回 downstream', async () => {
    const { agent } = fakeAgent('main-pre-3', { header: { cwd: outside } })
    const ctx = fakeCtx()
    registerContext(ctx as never, { seedOnStart: false })

    const downstream = { kind: 'enter', messages: [] }
    const { decision } = await firePreStep(ctx, agent, [], downstream)

    expect(decision).toEqual(downstream)
  })

  it('skiff 会话 ⇒ 不注入、原样返回 downstream（F4 完全旁路）', async () => {
    const { agent } = fakeAgent('skiff-qa-pre-1', { header: { cwd: dir } })
    const ctx = fakeCtx()
    registerContext(ctx as never, { seedOnStart: false })

    const downstream = { kind: 'enter', messages: [] }
    const { decision } = await firePreStep(ctx, agent, [], downstream)

    expect(decision).toEqual(downstream)
  })

  it('已经在 agent/created 播过种的同一载体 ⇒ pre-step 不重复注入（仍委托）', async () => {
    const id = 'main-pre-4'
    const { agent } = fakeAgent(id, { header: { cwd: dir } })
    const ctx = fakeCtx()
    registerContext(ctx as never) // 两条缝都装

    await fireCreated(ctx, agent) // 先播种 ⇒ 进 `injected`

    const downstream = { kind: 'enter', messages: [] }
    const { calls, decision } = await firePreStep(ctx, agent, [], downstream)

    expect(calls).toBe(1)
    expect(decision).toEqual(downstream) // 不再前置 ACC 消息
  })
})
