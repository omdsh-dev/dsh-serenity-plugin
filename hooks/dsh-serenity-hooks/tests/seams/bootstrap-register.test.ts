/**
 * bootstrap-register.test.ts — 拦截缝 `registerBootstrap` 的 **行为**测试（S142 ⑤ 分层单元测试·第 2 件）
 *
 * 🔴 **为何单开一个文件**：`tests/bootstrap.test.ts` 只覆盖纯函数
 * （`createEpochPromotion` / `hasUserMessageHistory` / `resolveBootstrapSettings`）；
 * 而 `registerBootstrap` 在全仓**只被 `src/index.ts` 调用**（grep 实证：无任何测试调它）
 * ⇒ **四条缝的处理器体（"首锚"机制的实际效果）无直接测试**。
 * 本文件补的正是这一块：**目录窄化**（system-prompt/assemble）＋ **剥离自动注入上下文**
 * （agent/pre-step）＋ **锚定轮注入**（agent/inbox/inserted）。
 *
 * **分层**：L2（服务与适配）的装配测试（约束文档 §5.2 / §5.1-T3），与纯函数测试分开。
 *
 * **替身与安全性**（读源码后确认，非猜测）：
 *   · `ctx` = 只记录 handler 的最小对象（第三参 `{prepend:true}` 被忽略，符合替身「同形」原则）
 *   · `agent` = `{ session, inbox?, id? }`；`agentRoot()` 靠 `session.header.cwd` → `cccRootForCwd`
 *   · `bootstrap.ts` 对宿主的引用**全是 `import type`**（Context / Agent / UserMessage /
 *     PromptAssembly）⇒ 运行时无需 mock 任何宿主包
 *   · `SETTINGS` 是**模块级固化常量**（协议固有、零配置面）⇒ 测试断言对**导出常量**取，
 *     不硬编码字面量（`DEFAULT_ANCHOR_MESSAGES` / `DEFAULT_COMPACTION_TOOLS`），改常量不会假红
 *   · ⚠️ `warnOnce` 是"只喊一次"的模块级函数 ⇒ **本文件不断言日志**（否则用例间互相干扰）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { registerBootstrap, DEFAULT_ANCHOR_MESSAGES, DEFAULT_COMPACTION_TOOLS } from '../../src/seams/bootstrap.js'
// 不硬编码字面量：插件来源 kind 的**单一真相源**在 message-source.ts
import { ACC_MESSAGE_KIND } from '../../src/message-source.js'

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

/** 假 agent：`events` 供 createEpochPromotion 的 scan 读（session/event 走 sessionEvents） */
function fakeAgent(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { session: { id, ...extra } }
}

function first(ctx: FakeCtx, name: string): Handler {
  const h = (ctx.handlers.get(name) ?? [])[0]
  if (!h) throw new Error(`handler not registered: ${name}`)
  return h
}

let dir: string
let outside: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hooks-bootseam-')) // 有 .serenity ⇒ 认作 CCC 根
  writeFileSync(join(dir, '.serenity'), 'test')
  outside = mkdtempSync(join(tmpdir(), 'hooks-bootout-')) // 无 .serenity ⇒ 不在任何 CCC
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

// ── 接线 ────────────────────────────────────────────────────────────────────

describe('registerBootstrap: 接线', () => {
  it('装四条缝：session/event ／ agent/inbox/inserted ／ system-prompt/assemble ／ agent/pre-step', () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    for (const name of ['session/event', 'agent/inbox/inserted', 'system-prompt/assemble', 'agent/pre-step']) {
      expect(ctx.handlers.get(name), name).toHaveLength(1)
    }
  })
})

// ── system-prompt/assemble：首锚「目录窄化」 ────────────────────────────────

describe('registerBootstrap: system-prompt/assemble —— 首锚目录窄化', () => {
  /** 造一条 assemble 调用：返回处理器结果 */
  async function assemble(ctx: FakeCtx, agent: unknown, tools: unknown): Promise<unknown> {
    const h = first(ctx, 'system-prompt/assemble')
    return h({}, { agent }, async () => ({ tools }))
  }

  const fullCatalog = () => [
    { name: 'read' }, { name: 'write' }, { name: 'edit' }, { name: 'glob' }, { name: 'grep' },
    { name: 'todo_write' }, { name: 'unrelated_tool' },
  ]

  it('CCC 内、未晋升、boundary < 0 ⇒ **首请求 0 工具**（纯文字锚定轮）', async () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    const agent = fakeAgent('main-boot-1', { header: { cwd: dir } }) // 无 events ⇒ boundary -1

    const out = (await assemble(ctx, agent, fullCatalog())) as { tools: unknown[] }
    expect(out.tools).toEqual([]) // zeroTools + 首锚轮 ⇒ 目录清空
  })

  it('非 CCC（cwd 无 .serenity）⇒ 原样返回完整目录', async () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    const agent = fakeAgent('main-boot-2', { header: { cwd: outside } })

    const out = (await assemble(ctx, agent, fullCatalog())) as { tools: unknown[] }
    expect(out.tools).toHaveLength(fullCatalog().length)
  })

  it('handyman/skiff 会话**恒晋升** ⇒ 原样返回完整目录（无锚定轮）', async () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    for (const id of ['handyman-worker-1', 'skiff-qa-boot-1']) {
      const out = (await assemble(ctx, fakeAgent(id, { header: { cwd: dir } }), fullCatalog())) as { tools: unknown[] }
      expect(out.tools, id).toHaveLength(fullCatalog().length)
    }
  })

  it('已达 requiredSignals（= 锚定消息条数）⇒ 晋升 ⇒ 原样返回完整目录', async () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    // boundary 5 之后再攒够 requiredSignals 条 assistant/message
    const events = [
      { type: 'compaction/end', seq: 5 },
      ...DEFAULT_ANCHOR_MESSAGES.map((_, i) => ({ type: 'assistant/message', seq: 6 + i })),
    ]
    const out = (await assemble(ctx, fakeAgent('main-boot-3', { header: { cwd: dir }, events }), fullCatalog())) as { tools: unknown[] }
    expect(out.tools).toHaveLength(fullCatalog().length)
  })

  it('boundary ≥ 0 且 compactionTools 齐全 ⇒ 窄化到 compactionTools（压缩后继续任务）', async () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    const events = [{ type: 'compaction/end', seq: 5 }] // boundary 5、未晋升
    const out = (await assemble(ctx, fakeAgent('main-boot-4', { header: { cwd: dir }, events }), fullCatalog())) as { tools: { name: string }[] }

    const kept = out.tools.map((t) => t.name).sort()
    expect(kept).toEqual([...DEFAULT_COMPACTION_TOOLS].sort())
    expect(kept).not.toContain('unrelated_tool')
  })

  it('boundary ≥ 0 但 compactionTools **缺一** ⇒ 降级完整目录（组合漂移不锁死会话）', async () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    const events = [{ type: 'compaction/end', seq: 5 }]
    // 故意去掉 DEFAULT_COMPACTION_TOOLS 的最后一个
    const missingName = DEFAULT_COMPACTION_TOOLS[DEFAULT_COMPACTION_TOOLS.length - 1]!
    const tools = fullCatalog().filter((t) => t.name !== missingName)

    const out = (await assemble(ctx, fakeAgent('main-boot-5', { header: { cwd: dir }, events }), tools)) as { tools: unknown[] }
    expect(out.tools).toHaveLength(tools.length) // 原样返回，不窄化
  })

  it('tools 不是数组 ⇒ 原样返回（防御）', async () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    const assembled = { tools: 'not-an-array' }
    const h = first(ctx, 'system-prompt/assemble')
    const out = await h({}, { agent: fakeAgent('main-boot-6', { header: { cwd: dir } }) }, async () => assembled)
    expect(out).toEqual(assembled)
  })
})

// ── agent/pre-step：首锚「剥离自动注入上下文」 ──────────────────────────────

describe('registerBootstrap: agent/pre-step —— 首锚剥离注入上下文', () => {
  async function preStep(ctx: FakeCtx, agent: unknown, decision: unknown): Promise<unknown> {
    const h = first(ctx, 'agent/pre-step')
    return h({ agent }, async () => decision)
  }

  const msg = (kind?: string) => ({ source: kind === undefined ? undefined : { kind } })

  it('未晋升 + 含 suppressedSources（skill-catalog / agent-instructions）⇒ 剥掉它们', async () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    const decision = {
      kind: 'enter',
      messages: [msg('skill-catalog'), msg('user'), msg('agent-instructions'), msg(undefined)],
    }

    const out = (await preStep(ctx, fakeAgent('main-boot-7', { header: { cwd: dir } }), decision)) as { messages: unknown[] }
    expect(out.messages).toHaveLength(2) // 只剩 user 与无 source 的那条
    expect(out.messages[0]).toEqual(msg('user'))
    expect(out.messages[1]).toEqual(msg(undefined))
  })

  it('未晋升 + 无被抑制来源 ⇒ **返回同一个对象**（不重建，零漂移）', async () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    const decision = { kind: 'enter', messages: [msg('user'), msg('assistant')] }

    const out = await preStep(ctx, fakeAgent('main-boot-8', { header: { cwd: dir } }), decision)
    expect(out).toBe(decision) // 身份相同 ⇒ 证明走的是 early-return 而非重建
  })

  it('已晋升（handyman/skiff 恒晋升）⇒ 原样返回，不剥离', async () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    const decision = { kind: 'enter', messages: [msg('skill-catalog')] }

    const out = await preStep(ctx, fakeAgent('handyman-worker-2', { header: { cwd: dir } }), decision)
    expect(out).toBe(decision)
  })

  it('非 CCC ⇒ 原样返回', async () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    const decision = { kind: 'enter', messages: [msg('skill-catalog')] }

    const out = await preStep(ctx, fakeAgent('main-boot-9', { header: { cwd: outside } }), decision)
    expect(out).toBe(decision)
  })

  it('下游 kind=reject ⇒ 原样返回（不干预拒绝）', async () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    const decision = { kind: 'reject', messages: [msg('skill-catalog')] }

    const out = await preStep(ctx, fakeAgent('main-boot-10', { header: { cwd: dir } }), decision)
    expect(out).toBe(decision)
  })

  it('messages 不是数组 ⇒ 原样返回（防御）', async () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    const decision = { kind: 'enter', messages: 'nope' }

    const out = await preStep(ctx, fakeAgent('main-boot-11', { header: { cwd: dir } }), decision)
    expect(out).toBe(decision)
  })
})

// ── agent/inbox/inserted：锚定轮注入 ────────────────────────────────────────

describe('registerBootstrap: agent/inbox/inserted —— 锚定轮注入', () => {
  function inboxAgent(id: string, extra: Record<string, unknown> = {}): { agent: Record<string, unknown>; prepends: Array<{ queue: string; text: string }> } {
    const prepends: Array<{ queue: string; text: string }> = []
    const agent = {
      session: { id, ...extra },
      inbox: {
        prepend: (queue: string, m: unknown) => {
          const text = (m as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? ''
          prepends.push({ queue, text })
        },
      },
    }
    return { agent, prepends }
  }

  it('新根会话首条用户消息 ⇒ 按**逆序** prepend 锚定消息（最终队列 = 锚定消息顺序 + 真实消息）', async () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    const { agent, prepends } = inboxAgent('main-boot-12', { header: { cwd: dir }, events: [] })

    await first(ctx, 'agent/inbox/inserted')({ agent, message: { source: { kind: 'user' } } })

    expect(prepends).toHaveLength(DEFAULT_ANCHOR_MESSAGES.length)
    expect(prepends.every((p) => p.queue === 'next-turn')).toBe(true)
    // 逆序 prepend ⇒ 记录到的调用顺序是倒过来的
    expect(prepends.map((p) => p.text)).toEqual([...DEFAULT_ANCHOR_MESSAGES].reverse())
  })

  it('已有 user/message 历史 ⇒ 不锚定（resume/续跑不重锚）', async () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    const { agent, prepends } = inboxAgent('main-boot-13', {
      header: { cwd: dir },
      events: [{ type: 'user/message' }],
    })

    await first(ctx, 'agent/inbox/inserted')({ agent, message: { source: { kind: 'user' } } })

    expect(prepends).toHaveLength(0)
  })

  it('handyman / skiff 会话 ⇒ 不锚定（autonomous worker 与角色会话不需锚定轮）', async () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    for (const id of ['handyman-worker-3', 'skiff-qa-boot-2']) {
      const { agent, prepends } = inboxAgent(id, { header: { cwd: dir }, events: [] })
      await first(ctx, 'agent/inbox/inserted')({ agent, message: { source: { kind: 'user' } } })
      expect(prepends, id).toHaveLength(0)
    }
  })

  it('插件来源消息（ACC_MESSAGE_KIND）⇒ 不递归锚定', async () => {
    const ctx = fakeCtx()
    registerBootstrap(ctx as never)
    const { agent, prepends } = inboxAgent('main-boot-14', { header: { cwd: dir }, events: [] })

    // 用 ACC_MESSAGE_KIND 的**真值**（不从源码注释猜）：插件来源消息不得递归锚定
    await first(ctx, 'agent/inbox/inserted')({
      agent,
      message: { source: { kind: ACC_MESSAGE_KIND } },
    })

    expect(prepends).toHaveLength(0)
  })
})
