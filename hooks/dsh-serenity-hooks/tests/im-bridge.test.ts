import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  IM_SEND_MAX_TEXT,
  IM_FILE_MAX_BYTES,
  registerImChannel,
  imChannelIds,
  hasEnabledImChannel,
  runImBridge,
  __resetImChannelsForTest,
  type ImChannel,
} from '../src/im-bridge.js'

/**
 * im-bridge 能力层测试（v1.31.0，S142 P1）。
 *
 * 覆盖：通道注册表 / 可见性判据 / 动作分发矩阵 / 稳定错误码 / CCC 内文件读取的三类拒绝。
 * 通道实现用替身（真实微信通道见 im-weixin.test.ts + weixin.test.ts）——
 * 本模块的契约是"不认识任何具体 IM"，替身正是这条契约的验证方式。
 */

let dir = ''

/** 替身通道（默认全通；用 overrides 造各类失败） */
function fakeChannel(overrides: Partial<ImChannel> = {}): ImChannel {
  return {
    id: 'fake',
    isEnabled: () => true,
    resolveUser: (_root, input) => (input === 'yh' ? { alias: 'yh', id: 'u@im' } : null),
    listUsers: () => [{ alias: 'yh', id: 'u@im' }],
    send: async (input) => ({
      accountId: 'acc-1',
      userId: input.userId,
      sessionId: 'skiff-fake',
      role: 'tester',
    }),
    sendFile: async (input) => ({ fileName: input.fileName, size: input.data.length }),
    status: () => ({ enabled: true, accounts: [{ accountId: 'acc-1', lastPollAt: 1 }] }),
    ...overrides,
  }
}

beforeEach(() => {
  __resetImChannelsForTest()
  dir = mkdtempSync(join(tmpdir(), 'im-bridge-'))
  mkdirSync(join(dir, '.opencode'), { recursive: true })
})

afterEach(() => {
  __resetImChannelsForTest()
  rmSync(dir, { recursive: true, force: true })
})

describe('im-bridge: 通道注册表', () => {
  it('注册后可枚举；重复 id 覆盖（热重载/测试友好）', () => {
    expect(imChannelIds()).toEqual([])
    registerImChannel(fakeChannel())
    expect(imChannelIds()).toEqual(['fake'])
    registerImChannel(fakeChannel({ status: () => ({ v: 2 }) }))
    expect(imChannelIds()).toEqual(['fake'])
  })

  it('可见性判据：任一通道启用 → true；全部未启用 → false', () => {
    expect(hasEnabledImChannel(dir)).toBe(false)
    registerImChannel(fakeChannel({ id: 'off', isEnabled: () => false }))
    registerImChannel(fakeChannel({ id: 'on', isEnabled: () => true }))
    expect(hasEnabledImChannel(dir)).toBe(true)
    __resetImChannelsForTest()
    registerImChannel(fakeChannel({ isEnabled: () => false }))
    expect(hasEnabledImChannel(dir)).toBe(false)
  })

  it('单通道判据抛错不影响其他通道（配置损坏由通道自身响亮处理）', () => {
    registerImChannel(fakeChannel({ id: 'boom', isEnabled: () => { throw new Error('bad config') } }))
    registerImChannel(fakeChannel({ id: 'ok', isEnabled: () => true }))
    expect(hasEnabledImChannel(dir)).toBe(true)
  })

  it('无通道注册时判据为 false（未配置任何 IM → 工具应不可见）', () => {
    expect(hasEnabledImChannel(dir)).toBe(false)
  })
})

describe('im-bridge: runImBridge 参数与错误码矩阵', () => {
  it('缺 channel → CHANNEL_REQUIRED（含可行动提示）', async () => {
    const r = await runImBridge(dir, { action: 'send', user: 'yh', text: 'hi' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('CHANNEL_REQUIRED')
      expect(r.remediation).toContain('channel')
    }
  })

  it('未知 channel → CHANNEL_UNKNOWN（提示已注册通道）', async () => {
    registerImChannel(fakeChannel())
    const r = await runImBridge(dir, { channel: 'nope', action: 'send', user: 'yh', text: 'hi' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('CHANNEL_UNKNOWN')
      expect(r.error).toContain('fake')
    }
  })

  it('通道未配置（isEnabled=false）→ CHANNEL_NOT_CONFIGURED', async () => {
    registerImChannel(fakeChannel({ isEnabled: () => false }))
    const r = await runImBridge(dir, { channel: 'fake', action: 'send', user: 'yh', text: 'hi' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('CHANNEL_NOT_CONFIGURED')
      expect(r.remediation).toContain('serenity.json')
    }
  })

  it('未知 action → ACTION_UNKNOWN（提示四个合法动作）', async () => {
    registerImChannel(fakeChannel())
    const r = await runImBridge(dir, { channel: 'fake', action: 'teleport' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('ACTION_UNKNOWN')
      expect(r.remediation).toContain('send')
    }
  })

  it('users / status → 直接返回通道快照（无需 user/text）', async () => {
    registerImChannel(fakeChannel())
    const users = await runImBridge(dir, { channel: 'fake', action: 'users' })
    expect(users.ok).toBe(true)
    if (users.ok) expect(users.detail).toEqual({ users: [{ alias: 'yh', id: 'u@im' }] })
    const status = await runImBridge(dir, { channel: 'fake', action: 'status' })
    expect(status.ok).toBe(true)
    if (status.ok) expect(status.detail).toMatchObject({ enabled: true })
  })

  it('send 缺 user / 缺 text / 超长 / 别名未知 → 各自稳定码', async () => {
    registerImChannel(fakeChannel())
    const noUser = await runImBridge(dir, { channel: 'fake', action: 'send', text: 'hi' })
    expect(noUser.ok).toBe(false)
    if (!noUser.ok) expect(noUser.code).toBe('USER_REQUIRED')

    const noText = await runImBridge(dir, { channel: 'fake', action: 'send', user: 'yh' })
    expect(noText.ok).toBe(false)
    if (!noText.ok) expect(noText.code).toBe('TEXT_REQUIRED')

    const tooLong = await runImBridge(dir, { channel: 'fake', action: 'send', user: 'yh', text: 'x'.repeat(IM_SEND_MAX_TEXT + 1) })
    expect(tooLong.ok).toBe(false)
    if (!tooLong.ok) expect(tooLong.code).toBe('TEXT_TOO_LONG')

    const badAlias = await runImBridge(dir, { channel: 'fake', action: 'send', user: 'nobody', text: 'hi' })
    expect(badAlias.ok).toBe(false)
    if (!badAlias.ok) {
      expect(badAlias.code).toBe('ALIAS_UNKNOWN')
      expect(badAlias.remediation).toContain('users')
    }
  })

  it('send 成功 → 返回账号/用户/会话/角色 + 别名回显', async () => {
    registerImChannel(fakeChannel())
    const r = await runImBridge(dir, { channel: 'fake', action: 'send', user: 'yh', text: 'hi' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.channel).toBe('fake')
      expect(r.action).toBe('send')
      expect(r.detail).toMatchObject({ accountId: 'acc-1', userId: 'u@im', sessionId: 'skiff-fake', role: 'tester', user: 'yh' })
    }
  })

  it('通道发送抛错 → SEND_FAILED（不向上抛，工具面统一渲染）', async () => {
    registerImChannel(fakeChannel({ send: async () => { throw new Error('ACCOUNT_NOT_BOUND: no token') } }))
    const r = await runImBridge(dir, { channel: 'fake', action: 'send', user: 'yh', text: 'hi' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('SEND_FAILED')
      expect(r.error).toContain('ACCOUNT_NOT_BOUND')
    }
  })

  it('send-file 未实现 → ACTION_UNSUPPORTED；缺 user/file → 各自稳定码', async () => {
    registerImChannel(fakeChannel({ sendFile: undefined }))
    const unsupported = await runImBridge(dir, { channel: 'fake', action: 'send-file', user: 'yh', file: 'a.txt' })
    expect(unsupported.ok).toBe(false)
    if (!unsupported.ok) expect(unsupported.code).toBe('ACTION_UNSUPPORTED')

    registerImChannel(fakeChannel())
    const noUser = await runImBridge(dir, { channel: 'fake', action: 'send-file', file: 'a.txt' })
    expect(noUser.ok).toBe(false)
    if (!noUser.ok) expect(noUser.code).toBe('USER_REQUIRED')

    const noFile = await runImBridge(dir, { channel: 'fake', action: 'send-file', user: 'yh' })
    expect(noFile.ok).toBe(false)
    if (!noFile.ok) expect(noFile.code).toBe('FILE_REQUIRED')
  })

  it('send-file 路径逃逸 / 不存在 / 超限 → 拒绝且不触达通道', async () => {
    const sent: unknown[] = []
    registerImChannel(fakeChannel({ sendFile: async (input) => { sent.push(input); return { fileName: input.fileName, size: input.data.length } } }))

    const escape = await runImBridge(dir, { channel: 'fake', action: 'send-file', user: 'yh', file: '../../etc/passwd' })
    expect(escape.ok).toBe(false)
    if (!escape.ok) {
      expect(escape.code).toBe('FILE_ESCAPE')
      expect(escape.remediation).toContain('inside this CCC')
    }

    const missing = await runImBridge(dir, { channel: 'fake', action: 'send-file', user: 'yh', file: 'nope.txt' })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.code).toBe('FILE_NOT_FOUND')

    // 超限文件用稀疏文件构造（不实际写 20MB+）
    const big = join(dir, 'big.bin')
    writeFileSync(big, '')
    const { truncateSync } = await import('node:fs')
    truncateSync(big, IM_FILE_MAX_BYTES + 1)
    const tooLarge = await runImBridge(dir, { channel: 'fake', action: 'send-file', user: 'yh', file: 'big.bin' })
    expect(tooLarge.ok).toBe(false)
    if (!tooLarge.ok) expect(tooLarge.code).toBe('FILE_TOO_LARGE')

    expect(sent).toHaveLength(0)
  })

  it('send-file 成功 → 传文件名/字节数/caption（相对路径以 CCC 根解析）', async () => {
    writeFileSync(join(dir, 'note.txt'), 'hello')
    registerImChannel(fakeChannel())
    const r = await runImBridge(dir, { channel: 'fake', action: 'send-file', user: 'yh', file: 'note.txt', caption: '看这个' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.detail).toMatchObject({ fileName: 'note.txt', size: 5, user: 'yh' })
  })

  it('日志/工具消费面：错误码稳定（同一失败重复调用码不变）', async () => {
    registerImChannel(fakeChannel({ isEnabled: () => false }))
    const codes = await Promise.all([
      runImBridge(dir, { channel: 'fake', action: 'send', user: 'yh', text: 'a' }),
      runImBridge(dir, { channel: 'fake', action: 'send', user: 'yh', text: 'b' }),
    ])
    expect(codes.map((c) => (c.ok ? 'ok' : c.code))).toEqual(['CHANNEL_NOT_CONFIGURED', 'CHANNEL_NOT_CONFIGURED'])
  })
})

describe('im-bridge: 结果载荷可 JSON 化（工具返回值契约）', () => {
  it('成功与失败结果都能 JSON.stringify 往返（无 undefined 字段）', async () => {
    registerImChannel(fakeChannel())
    const ok = await runImBridge(dir, { channel: 'fake', action: 'users' })
    expect(JSON.parse(JSON.stringify(ok))).toEqual(ok)
    const failed = await runImBridge(dir, { channel: 'nope', action: 'send' })
    expect(JSON.parse(JSON.stringify(failed))).toEqual(failed)
  })
})

describe('im-bridge: 可见性判据与通道注册解耦（无宿主依赖）', () => {
  it('判据只读通道的 isEnabled，不读任何宿主服务（vi 无 mock 亦通过）', () => {
    const spy = vi.fn(() => true)
    registerImChannel(fakeChannel({ isEnabled: spy }))
    expect(hasEnabledImChannel(dir)).toBe(true)
    expect(spy).toHaveBeenCalledWith(dir)
  })
})
