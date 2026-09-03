/**
 * weixin-hook.test.ts — 微信桥消息记录 hook 测试（v1.27.13）
 *
 * 覆盖：
 * - 事件构造（incoming/outgoing schema：字段齐全 + **不含会话凭据**——最小暴露面 H5）
 * - 真实执行（spawn CCC 脚本 → stdin 收到事件 JSON）
 * - 旁路容忍（H3）：脚本缺失 / 路径逃逸 / 超时 kill / 非 0 退出 → ok:false 不抛
 * - runner 注入（setWeixinHookRunnerForTest——bridge 集成在 weixin.test.ts 用捕获）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  buildIncomingHookEvent,
  buildOutgoingHookEvent,
  runWeixinHook,
  setWeixinHookRunnerForTest,
  invokeWeixinHook,
  type WeixinHookIncomingEvent,
  type WeixinHookOutgoingEvent,
} from '../src/weixin-hook.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weixin-hook-'))
  writeFileSync(join(dir, '.serenity'), 'test')
  mkdirSync(join(dir, '.opencode'), { recursive: true })
})

afterEach(() => {
  setWeixinHookRunnerForTest(null)
  rmSync(dir, { recursive: true, force: true })
})

/** 每用例现构造（dir 在 beforeEach 初始化——顶层引用会拿到 undefined） */
function mkIncomingInput(overrides: Partial<typeof incomingBase> = {}): typeof incomingBase & { cccRoot: string } {
  return { ...incomingBase, cccRoot: dir, ...overrides }
}

const incomingBase = {
  accountId: 'wechat-1',
  userId: 'u1@im.wechat',
  sessionId: 'skiff-weixin-abc123',
  role: 'zhaocai',
  text: '你好',
  media: [{ kind: 'image' as const, relPath: '_tmp/weixin-inbound/h1/img_x.jpg' }],
}

describe('weixin-hook: 事件构造（schema）', () => {
  it('incoming 事件：字段齐全 + 类型正确', () => {
    const ev = buildIncomingHookEvent(mkIncomingInput())
    expect(ev.event).toBe('incoming')
    expect(ev.cccRoot).toBe(dir)
    expect(ev.accountId).toBe('wechat-1')
    expect(ev.userId).toBe('u1@im.wechat')
    expect(ev.sessionId).toBe('skiff-weixin-abc123')
    expect(ev.role).toBe('zhaocai')
    expect(ev.ts).toBeGreaterThan(0)
    expect(ev.message.text).toBe('你好')
    expect(ev.message.media).toEqual([{ kind: 'image', relPath: '_tmp/weixin-inbound/h1/img_x.jpg' }])
  })

  it('incoming 无文本无媒体 → text:null media:[]', () => {
    const ev = buildIncomingHookEvent(mkIncomingInput({ text: null, media: [] }))
    expect(ev.message.text).toBeNull()
    expect(ev.message.media).toEqual([])
  })

  it('outgoing 事件：回复文本（已剥离 think 语义由 bridge 保证）', () => {
    const ev = buildOutgoingHookEvent({
      cccRoot: dir,
      accountId: 'wechat-1',
      userId: 'u1@im.wechat',
      sessionId: 'skiff-weixin-abc123',
      role: 'zhaocai',
      reply: '好的，已记录',
    })
    expect(ev.event).toBe('outgoing')
    expect(ev.reply).toBe('好的，已记录')
  })

  it('序列化 JSON **不含会话凭据**（无 context_token / bot_token / token 字段）', () => {
    const incoming = JSON.stringify(buildIncomingHookEvent(mkIncomingInput()))
    const outgoing = JSON.stringify(buildOutgoingHookEvent({
      cccRoot: dir,
      accountId: 'wechat-1',
      userId: 'u1@im.wechat',
      sessionId: 'skiff-weixin-abc123',
      role: 'zhaocai',
      reply: 'x',
    }))
    for (const json of [incoming, outgoing]) {
      expect(json).not.toContain('context_token')
      expect(json).not.toContain('bot_token')
      expect(json).not.toContain('"token"')
      expect(json).not.toContain('aes_key')
    }
  })
})

describe('weixin-hook: 执行（真实 spawn）', () => {
  it('脚本收到 stdin 事件 JSON（写文件验证）', async () => {
    // 脚本：读 stdin → 写 JSON 到固定输出文件（runWeixinHook 只传脚本路径——输出路径写死）
    const script = join(dir, 'hook-log.js')
    const outFile = join(dir, 'hook-out.json')
    writeFileSync(script, [
      "const fs = require('node:fs');",
      `const out = ${JSON.stringify(outFile)};`,
      "let s = '';",
      "process.stdin.on('data', (d) => { s += d.toString(); });",
      "process.stdin.on('end', () => { fs.writeFileSync(out, s); });",
    ].join('\n'))

    const ev = buildIncomingHookEvent(mkIncomingInput())
    const res = await runWeixinHook(dir, 'hook-log.js', ev, 10_000)
    expect(res.ok).toBe(true)
    const received = JSON.parse(readFileSync(outFile, 'utf-8')) as WeixinHookIncomingEvent
    expect(received.event).toBe('incoming')
    expect(received.userId).toBe('u1@im.wechat')
    expect(received.message.text).toBe('你好')
  })

  it('脚本缺失 → ok:false 不抛', async () => {
    const res = await runWeixinHook(dir, 'missing-hook.js', buildIncomingHookEvent(mkIncomingInput()), 1_000)
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('不存在')
  })

  it('路径逃逸 → ok:false（resolveInside 拒绝）', async () => {
    const res = await runWeixinHook(dir, '../escape.js', buildIncomingHookEvent(mkIncomingInput()), 1_000)
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('逃逸')
  })

  it('超时 → kill + ok:false（防挂死脚本）', async () => {
    const script = join(dir, 'sleep-forever.js')
    writeFileSync(script, 'setInterval(() => {}, 1000)')
    const res = await runWeixinHook(dir, 'sleep-forever.js', buildIncomingHookEvent(mkIncomingInput()), 300)
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('超时')
  })

  it('非 0 退出 → ok:false 不抛', async () => {
    const script = join(dir, 'fail.js')
    writeFileSync(script, "process.stderr.write('boom'); process.exit(3);")
    const res = await runWeixinHook(dir, 'fail.js', buildIncomingHookEvent(mkIncomingInput()), 1_000)
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('exit=3')
  })
})

describe('weixin-hook: runner 注入', () => {
  it('invokeWeixinHook 转发 activeRunner（测试捕获，还原后走真实执行）', async () => {
    const received: unknown[] = []
    setWeixinHookRunnerForTest(async (_root, _hook, ev) => {
      received.push(ev)
      return { ok: true }
    })
    const ev = buildOutgoingHookEvent({
      cccRoot: dir,
      accountId: 'wechat-1',
      userId: 'u1@im.wechat',
      sessionId: 'skiff-weixin-abc123',
      role: 'zhaocai',
      reply: 'x',
    })
    await invokeWeixinHook(dir, 'hook.js', ev)
    expect(received).toHaveLength(1)
    expect((received[0] as WeixinHookOutgoingEvent).event).toBe('outgoing')

    // 还原 → 真实执行路径（脚本缺失 → ok:false 不抛）
    setWeixinHookRunnerForTest(null)
    const res = await invokeWeixinHook(dir, 'missing.js', ev)
    expect(res.ok).toBe(false)
  })
})
