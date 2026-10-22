/**
 * tests/im/contacts.test.ts — `im-bridge action=contacts` 的能力层单测
 *
 * ## 为什么这个动作需要自己的测试（它不是"多列一个字段"）
 *
 * owner 2026-10-22：「配路由需要的是**账户到轨迹**，轨迹 CCC 知道，**账户 CCC 不知道**，
 * 需要有个能力让 CCC 查询用户配好的账户」。⇒ 这个动作是 CCC **唯一**能拿到
 * "对方 id"的入口。它错了，CCC 就只能猜 —— 而猜错的症状是"配了路由却不生效"，**零报错**。
 *
 * ## 三格必钉（缺一即等于没做）
 *
 * ① **unrouted**：有往来、但没配路由 ⇒ 必须被点名（**这就是该配的**）
 * ② **orphanRoutes**：配了路由、但记录里从没出现 ⇒ 必须被点名（**id 可能写错**）
 *    —— 这两格是"配了不生效"的**唯一机械信号**（D179 同族：假入口要能被发现）
 * ③ **sources**：扫描域必须可见（否定性结论的可信度上限 = 扫描域）
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'im-contacts-'))
})

afterEach(() => {
  vi.resetModules()
  rmSync(root, { recursive: true, force: true })
})

/** 写一份日文件 */
function putLog(dirName: string, name: string, events: object[]): void {
  const dir = join(root, 'AGENT_SESSIONS', dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
}

/** 写 CCC 配置（只写 im 段，够用） */
function putConfig(cfg: object): void {
  mkdirSync(join(root, '.opencode'), { recursive: true })
  writeFileSync(join(root, '.opencode', 'serenity.json'), JSON.stringify(cfg))
  writeFileSync(join(root, '.serenity'), '')
}

/** 装一个最小通道（只为 contacts 用：listContacts 标记为"有记录来源"） */
async function setup(cfg: object) {
  vi.resetModules()
  putConfig(cfg)
  const mod = await import('../../src/im/channels.js')
  mod.__resetImChannelsForTest()
  mod.registerImChannel({
    id: 'weixin',
    isEnabled: () => true,
    resolveUser: () => null,
    listUsers: () => [],
    send: async () => ({ accountId: 'w1', userId: 'u', sessionId: 's', role: 'r' }),
    status: () => ({ enabled: true }),
    listContacts: () => [],
  })
  return mod
}

const IM_ON = { im: { enabled: true, accounts: [{ accountId: 'wechat-1' }], routes: [] } }

describe('contacts：列出"有过往来的人"', () => {
  it('🔴 从聊天记录里读出对端 id（CCC 只能从这里拿到它）', async () => {
    putLog('_weixin-logs', '2026-10-01.jsonl', [
      { event: 'incoming', ts: 1000, accountId: 'wechat-1', userId: 'u-a@im.wechat', role: 'S001' },
      { event: 'outgoing', ts: 2000, accountId: 'wechat-1', userId: 'u-a@im.wechat', role: 'S001' },
    ])
    const mod = await setup(IM_ON)
    const r = await mod.runImBridge(root, { channel: 'weixin', action: 'contacts' })
    expect(r.ok).toBe(true)
    const d = (r as { detail: Record<string, unknown> }).detail
    const contacts = d.contacts as Array<Record<string, unknown>>
    expect(contacts).toHaveLength(1)
    expect(contacts[0]).toMatchObject({ userId: 'u-a@im.wechat', messages: 2, route: null })
    expect(contacts[0]!.firstSeen).toBe(new Date(1000).toISOString())
  })

  it('🔴 ① unrouted：有往来但没配路由 ⇒ 必须被点名（这就是该配的）', async () => {
    putLog('_weixin-logs', '2026-10-01.jsonl', [
      { event: 'incoming', ts: 1, accountId: 'wechat-1', userId: 'no-route' },
      { event: 'incoming', ts: 2, accountId: 'wechat-1', userId: 'has-route' },
    ])
    const mod = await setup({
      im: {
        enabled: true,
        accounts: [{ accountId: 'wechat-1' }],
        routes: [{ user: 'has-route', trajectory: 'S001' }],
      },
    })
    const r = await mod.runImBridge(root, { channel: 'weixin', action: 'contacts' })
    const d = (r as { detail: Record<string, unknown> }).detail
    expect(d.unrouted).toEqual(['no-route'])
    // 已配路由的那条，contacts 里 route 字段要给出轨迹编码
    const contacts = d.contacts as Array<Record<string, unknown>>
    expect(contacts.find((c) => c.userId === 'has-route')!.route).toBe('S001')
  })

  it('🔴 ② orphanRoutes：配了路由但记录里从没出现 ⇒ 必须被点名（id 可能写错）', async () => {
    putLog('_weixin-logs', '2026-10-01.jsonl', [
      { event: 'incoming', ts: 1, accountId: 'wechat-1', userId: 'real-user' },
    ])
    const mod = await setup({
      im: {
        enabled: true,
        accounts: [{ accountId: 'wechat-1' }],
        routes: [
          { user: 'real-user', trajectory: 'S001' },
          { user: 'typo-user-never-seen', trajectory: 'S002' },
        ],
      },
    })
    const r = await mod.runImBridge(root, { channel: 'weixin', action: 'contacts' })
    const d = (r as { detail: Record<string, unknown> }).detail
    expect(d.orphanRoutes).toEqual(['typo-user-never-seen'])
    expect(d.unrouted).toEqual([])
  })

  it('🔴 ③ sources：扫描域必须可见（否定性结论的可信度上限）', async () => {
    putLog('_weixin-logs', '2026-10-01.jsonl', [
      { event: 'incoming', ts: 1, accountId: 'wechat-1', userId: 'u' },
    ])
    const mod = await setup(IM_ON)
    const r = await mod.runImBridge(root, { channel: 'weixin', action: 'contacts' })
    const d = (r as { detail: Record<string, unknown> }).detail
    expect(d.sources).toEqual([join('AGENT_SESSIONS', '_weixin-logs', '2026-10-01.jsonl')])
  })

  it('一个新目录 + 一个存量目录 ⇒ 两处都扫（迁移期间历史在两处）', async () => {
    putLog('_weixin-logs', '2026-10-01.jsonl', [
      { event: 'incoming', ts: 1, accountId: 'wechat-1', userId: 'old-one' },
    ])
    const dir = join(root, 'AGENT_SESSIONS', '_im-logs', 'weixin')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, '2026-10-22.jsonl'),
      JSON.stringify({ event: 'incoming', ts: 2, channel: 'weixin', accountId: 'wechat-1', userId: 'new-one' }) + '\n',
    )
    const mod = await setup(IM_ON)
    const r = await mod.runImBridge(root, { channel: 'weixin', action: 'contacts' })
    const d = (r as { detail: Record<string, unknown> }).detail
    expect((d.contacts as unknown[]).length).toBe(2)
    expect(d.sources as string[]).toHaveLength(2)
  })

  it('只返回**本渠道**的联系人（飞书的不混进 weixin）', async () => {
    putLog('_weixin-logs', '2026-10-01.jsonl', [
      { event: 'incoming', ts: 1, channel: 'weixin', accountId: 'w1', userId: 'wx-user' },
      { event: 'incoming', ts: 2, channel: 'feishu', accountId: 'f1', userId: 'ou_feishu' },
    ])
    const mod = await setup(IM_ON)
    const r = await mod.runImBridge(root, { channel: 'weixin', action: 'contacts' })
    const d = (r as { detail: Record<string, unknown> }).detail
    const users = (d.contacts as Array<Record<string, unknown>>).map((c) => c.userId)
    expect(users).toEqual(['wx-user'])
  })

  it('多账户：同一对端被两个账号收过 ⇒ accountIds 两个都列（不合并掉）', async () => {
    putLog('_weixin-logs', '2026-10-01.jsonl', [
      { event: 'incoming', ts: 1, channel: 'weixin', accountId: 'wechat-1', userId: 'shared' },
      { event: 'incoming', ts: 2, channel: 'weixin', accountId: 'wechat-2', userId: 'shared' },
    ])
    const mod = await setup({
      im: {
        enabled: true,
        accounts: [{ accountId: 'wechat-1' }, { accountId: 'wechat-2' }],
        routes: [],
      },
    })
    const r = await mod.runImBridge(root, { channel: 'weixin', action: 'contacts' })
    const d = (r as { detail: Record<string, unknown> }).detail
    const c = (d.contacts as Array<Record<string, unknown>>)[0]!
    expect(c.accountIds).toEqual(['wechat-1', 'wechat-2'])
  })

  it('通道没有记录来源 ⇒ 如实 ACTION_UNSUPPORTED（⛔ 不返回空数组冒充"没有人"）', async () => {
    vi.resetModules()
    putConfig(IM_ON)
    const mod = await import('../../src/im/channels.js')
    mod.__resetImChannelsForTest()
    mod.registerImChannel({
      id: 'weixin',
      isEnabled: () => true,
      resolveUser: () => null,
      listUsers: () => [],
      send: async () => ({ accountId: 'w1', userId: 'u', sessionId: 's', role: 'r' }),
      status: () => ({ enabled: true }),
      // ⛔ 刻意不给 listContacts
    })
    const r = await mod.runImBridge(root, { channel: 'weixin', action: 'contacts' })
    expect((r as { ok: boolean }).ok).toBe(false)
    expect((r as { code: string }).code).toBe('ACTION_UNSUPPORTED')
  })

  it('没有日志目录 ⇒ contacts 空 + sources 空（不是报错）', async () => {
    const mod = await setup(IM_ON)
    const r = await mod.runImBridge(root, { channel: 'weixin', action: 'contacts' })
    expect(r.ok).toBe(true)
    const d = (r as { detail: Record<string, unknown> }).detail
    expect(d.contacts).toEqual([])
    expect(d.sources).toEqual([])
    expect(d.unrouted).toEqual([])
  })
})
