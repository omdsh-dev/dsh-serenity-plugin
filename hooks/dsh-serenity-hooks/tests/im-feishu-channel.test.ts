import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 飞书**出站**通道（Q4，2026-10-20）的判据
 *
 * ## 这个文件证明什么 / 不证明什么（分层说清，别把绿读成"飞书能用了"）
 *
 * ✅ **证明**：通道被注册进 `im-bridge` 的注册表、`runImBridge` 能分发到它、
 *    发送形状（`receive_id_type` / `content` 是 JSON 字符串）、
 *    别名的**跨渠道形状校验**、可见性三态、`send-file` 如实不支持。
 * ⛔ **不证明**：真能连上飞书、真能发出去 —— 那要真 appId/appSecret（D141 同族）。
 *
 * ## 为什么用替身 SDK
 *
 * 与入站侧同一个 loader（`installFeishuSdk`）。**这是刻意的一致性**：
 * 若出站自己写一份 `import('@larksuiteoapi/node-sdk')`，注入的替身只对入站生效，
 * 出站会在测试里加载真 SDK（并打真日志证明你没拦住它 —— 入站侧实测过）。
 */

const fakeState = {
  sent: [] as Array<Record<string, unknown>>,
}

const fakeSdk = {
  Client: class {
    im = {
      v1: {
        message: {
          create: async (p: Record<string, unknown>) => {
            fakeState.sent.push(p)
            return { code: 0, data: { message_id: 'om_out' } }
          },
        },
      },
    }
  },
  EventDispatcher: class {
    constructor(_p?: unknown) {}
    register(_h: Record<string, (d: unknown) => unknown>) { return this }
  },
  WSClient: class {
    constructor(_p?: unknown) {}
    async start(_p: { eventDispatcher: unknown }) {}
    close(_p?: { force?: boolean }) {}
  },
}

let dir = ''

/** 写该 CCC 的 serenity.json（统一 `im` 段形态） */
function writeConfig(im: Record<string, unknown>): void {
  writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({ im }, null, 2))
}

/**
 * 写 localstore 凭据 —— **走真正的写入函数**，不手搓 JSON。
 *
 * 🔴 为什么（本轮实测踩过一次）：我第一版夹具手写了 `{"credential": {…}}`，
 * 而真实保留节名是 **`credentials`**（`service.ts` 的 `CREDENTIALS_SECTION`）
 * ⇒ 四条用例同时红，报的全是"飞书账号未绑定"——**读数像被测对象坏了，实为夹具错了**
 * （本轨老坑：读数器坏了 vs 被测对象坏了必须分开判）。
 * ⇒ 夹具只要"造一个合法状态"，就用**生成它的那个函数**造，不要复刻格式。
 */
async function writeCredential(key: string, value: string): Promise<void> {
  const { writeEntry } = await import('../src/tools/localstore/service.js')
  writeEntry(dir, 'credential', key, value)
}

/** 写飞书账号凭据（accountId → appId/appSecret） */
async function writeFeishuCred(accountId: string, appId: string, appSecret: string): Promise<void> {
  const key = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
  await writeCredential(`FEISHU_${key(accountId)}_APPID`, appId)
  await writeCredential(`FEISHU_${key(accountId)}_SECRET`, appSecret)
}

/** 写一个用户 id 进 localstore（别名表指向它） */
async function writeUserId(key: string, value: string): Promise<void> {
  await writeCredential(key, value)
}

let channels: typeof import('../src/im/channels.js')

beforeEach(async () => {
  fakeState.sent = []
  dir = mkdtempSync(join(tmpdir(), 'feishu-channel-'))
  mkdirSync(join(dir, '.opencode'), { recursive: true })
  writeFileSync(join(dir, '.serenity'), 'test')
  channels = await import('../src/im/channels.js')
  channels.__resetImChannelsForTest()
  const { installFeishuSdk } = await import('../src/im/feishu-account.js')
  installFeishuSdk(async () => fakeSdk as never)
})

afterEach(async () => {
  const { installFeishuSdk } = await import('../src/im/feishu-account.js')
  installFeishuSdk(null as never)
  channels.__resetImChannelsForTest()
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/** 装好一个可用的飞书环境（配置 + 凭据） */
async function readyEnv(): Promise<void> {
  writeConfig({
    enabled: true,
    accounts: [{ accountId: 'feishu-1', channel: 'feishu', enabled: true }],
    routes: [{ user: 'ou_abc', trajectory: 'probe' }],
  })
  await writeFeishuCred('feishu-1', 'cli_probe', 'secret_probe')
}

describe('飞书出站通道：ID 与可见性判据', () => {
  it('id 是 `feishu`（= 配置里 accounts[].channel 的取值）', async () => {
    const { feishuChannel } = await import('../src/im/feishu-channel.js')
    expect(feishuChannel.id).toBe('feishu')
  })

  it('🔴 可见性三态：无飞书账号 → false；有但禁用 → false；有且启用 → true', async () => {
    const { feishuChannel } = await import('../src/im/feishu-channel.js')

    // ① 只有微信账号 ⇒ 飞书不可见（渠道无关的 enabled 开关不许把它点亮）
    writeConfig({ enabled: true, accounts: [{ accountId: 'wechat-1', channel: 'weixin', enabled: true }] })
    expect(feishuChannel.isEnabled(dir)).toBe(false)

    // ② 有飞书账号但禁用 ⇒ false
    writeConfig({ enabled: true, accounts: [{ accountId: 'feishu-1', channel: 'feishu', enabled: false }] })
    expect(feishuChannel.isEnabled(dir)).toBe(false)

    // ③ 有飞书账号且启用 ⇒ true
    writeConfig({ enabled: true, accounts: [{ accountId: 'feishu-1', channel: 'feishu', enabled: true }] })
    expect(feishuChannel.isEnabled(dir)).toBe(true)

    // ④ 总开关关掉 ⇒ false（桥没启用就什么都不该亮）
    writeConfig({ enabled: false, accounts: [{ accountId: 'feishu-1', channel: 'feishu', enabled: true }] })
    expect(feishuChannel.isEnabled(dir)).toBe(false)
  })
})

describe('飞书出站通道：用户解析（跨渠道形状校验）', () => {
  it('裸 open_id 直接透传；非 ou_ 前缀 ⇒ null', async () => {
    const { feishuChannel } = await import('../src/im/feishu-channel.js')
    writeConfig({ enabled: true, accounts: [] })
    expect(feishuChannel.resolveUser(dir, 'ou_abc')).toEqual({ alias: 'ou_abc', id: 'ou_abc' })
    expect(feishuChannel.resolveUser(dir, '')).toBeNull()
    expect(feishuChannel.resolveUser(dir, 'someone@im.wechat')).toBeNull()
  })

  it('🔴 别名指向**微信 id** ⇒ 解析失败（否则会拿别人的 id 跨渠道发消息）', async () => {
    const { feishuChannel } = await import('../src/im/feishu-channel.js')
    writeConfig({ enabled: true, accounts: [], aliases: { yh: 'WEIXIN_USER_YH' } })
    await writeUserId('WEIXIN_USER_YH', 'o9cq80wOC2WpIFCK9tmM6BmUyByk@im.wechat')

    // 微信通道认它，飞书通道**不认**（形状不符）
    expect(feishuChannel.resolveUser(dir, 'yh')).toBeNull()
    expect(feishuChannel.listUsers(dir)).toEqual([])
  })

  it('别名指向**飞书 open_id** ⇒ 解析成功，且 listUsers 能列出', async () => {
    const { feishuChannel } = await import('../src/im/feishu-channel.js')
    writeConfig({ enabled: true, accounts: [], aliases: { feishu_yh: 'FEISHU_USER_YH' } })
    await writeUserId('FEISHU_USER_YH', 'ou_abc123')

    expect(feishuChannel.resolveUser(dir, 'feishu_yh')).toEqual({ alias: 'feishu_yh', id: 'ou_abc123' })
    expect(feishuChannel.listUsers(dir)).toEqual([{ alias: 'feishu_yh', id: 'ou_abc123' }])
  })
})

describe('飞书出站通道：发送（形状是官方硬要求）', () => {
  it('🔴 `receive_id_type=open_id`，`content` 是 **JSON 字符串**且 md 已转纯文本', async () => {
    const { feishuChannel } = await import('../src/im/feishu-channel.js')
    await readyEnv()

    const result = await feishuChannel.send({ root: dir, userId: 'ou_abc', text: '**答案**是 42' })
    expect(fakeState.sent).toHaveLength(1)

    const p = fakeState.sent[0] as {
      params: { receive_id_type: string }
      data: { receive_id: string; msg_type: string; content: string }
    }
    expect(p.params.receive_id_type).toBe('open_id')
    expect(p.data.receive_id).toBe('ou_abc')
    expect(p.data.msg_type).toBe('text')
    expect(typeof p.data.content).toBe('string')
    const parsed = JSON.parse(p.data.content) as { text: string }
    expect(parsed.text).toContain('答案')
    // md 已剥离：不应出现 ** 原文
    expect(parsed.text).not.toContain('**')

    // 回执形状与微信通道一致（工具面按同一个形状渲染）
    expect(result.accountId).toBe('feishu-1')
    expect(result.userId).toBe('ou_abc')
    expect(result.sessionId).toContain('skiff-weixin-probe') // 会话 id 由轨迹派生（A85：不改名）
    expect(result.role).toBe('probe')
  })

  /**
   * 🔴🔴 2026-10-22（owner：「飞书要记录」＋「一个 CCC 绑定多个账户很常见，落盘要完善」）：
   * 飞书出站**开始 fire 记录 hook**，且事件必须自带 `channel:"feishu"`。
   *
   * 为什么这条最要紧：`channel` 字段是 **"多渠道落盘分得开"的唯一依据**。
   * 它若缺失，飞书事件写进日志后无法与微信区分（只能靠 `ou_` 前缀猜 = D167 违反），
   * `contacts` 也就没法按渠道分组。⇒ 这里把"带渠道"钉死。
   */
  it('🔴 发送成功 ⇒ fire 记录 hook，且事件带 `channel:"feishu"`', async () => {
    const { feishuChannel } = await import('../src/im/feishu-channel.js')
    await readyEnv()
    // 这条要在**有 hook 配置**的前提下跑（`readyEnv` 默认不配 hook）
    writeConfig({
      enabled: true,
      accounts: [{ accountId: 'feishu-1', channel: 'feishu', enabled: true }],
      routes: [{ user: 'ou_abc', trajectory: 'probe' }],
      hook: 'scripts/fake-hook.ts',
    })

    const { setWeixinHookRunnerForTest } = await import('../src/im/hook.js')
    const captured: Array<Record<string, unknown>> = []
    setWeixinHookRunnerForTest(async (_root, _rel, event) => {
      captured.push(event as unknown as Record<string, unknown>)
      return { ok: true }
    })

    try {
      await feishuChannel.send({ root: dir, userId: 'ou_abc', text: 'hello' })
      expect(captured).toHaveLength(1)
      const ev = captured[0]!
      expect(ev.channel).toBe('feishu')   // ← 本轮新增的判据
      expect(ev.event).toBe('outgoing')
      expect(ev.accountId).toBe('feishu-1')
      expect(ev.userId).toBe('ou_abc')
      expect(ev.reply).toBe('hello')
      expect(ev.source).toBe('proactive')
    } finally {
      setWeixinHookRunnerForTest(null)
    }
  })

  it('无可用账号 / 未绑定 / 指定账号不存在 → 各自稳定码（不触达 SDK）', async () => {    const { feishuChannel } = await import('../src/im/feishu-channel.js')

    // ① 桥未启用
    writeConfig({ enabled: false, accounts: [] })
    await expect(feishuChannel.send({ root: dir, userId: 'ou_abc', text: 'x' }))
      .rejects.toThrow(/BRIDGE_DISABLED/)

    // ② 启用了但没有飞书账号
    writeConfig({ enabled: true, accounts: [{ accountId: 'wechat-1', channel: 'weixin', enabled: true }] })
    await expect(feishuChannel.send({ root: dir, userId: 'ou_abc', text: 'x' }))
      .rejects.toThrow(/NO_ACCOUNT/)

    // ③ 有账号但凭据未写
    writeConfig({ enabled: true, accounts: [{ accountId: 'feishu-1', channel: 'feishu', enabled: true }] })
    await expect(feishuChannel.send({ root: dir, userId: 'ou_abc', text: 'x' }))
      .rejects.toThrow(/ACCOUNT_NOT_BOUND/)

    // ④ 指定了一个不存在的账号
    await readyEnv()
    await expect(feishuChannel.send({ root: dir, userId: 'ou_abc', text: 'x', accountId: 'feishu-9' }))
      .rejects.toThrow(/ACCOUNT_NOT_FOUND/)

    // 全部失败路径都不该触达 SDK
    expect(fakeState.sent).toHaveLength(0)
  })

  it('SDK 抛错 → SEND_FAILED（不把原始错误直抛给工具面）', async () => {
    const { installFeishuSdk } = await import('../src/im/feishu-account.js')
    const brokenSdk = {
      ...fakeSdk,
      Client: class {
        im = { v1: { message: { create: async () => { throw new Error('tenant_access_token invalid') } } } }
      },
    }
    installFeishuSdk(async () => brokenSdk as never)

    const { feishuChannel } = await import('../src/im/feishu-channel.js')
    await readyEnv()
    await expect(feishuChannel.send({ root: dir, userId: 'ou_abc', text: 'x' }))
      .rejects.toThrow(/SEND_FAILED/)
  })
})

describe('飞书出站通道：经 im-bridge 工具面分发', () => {
  it('🔴 `channel:"feishu"` 真的分发到本通道（此前恒 CHANNEL_UNKNOWN）', async () => {
    const { feishuChannel } = await import('../src/im/feishu-channel.js')
    channels.registerImChannel(feishuChannel)
    await readyEnv()

    const r = await channels.runImBridge(dir, { channel: 'feishu', action: 'send', user: 'ou_abc', text: '你好' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.channel).toBe('feishu')
      expect(r.detail).toMatchObject({ accountId: 'feishu-1', userId: 'ou_abc' })
    }
    expect(fakeState.sent).toHaveLength(1)
  })

  it('🔴 别名跨渠道错配 ⇒ ALIAS_UNKNOWN，且**不触达 SDK**', async () => {
    const { feishuChannel } = await import('../src/im/feishu-channel.js')
    channels.registerImChannel(feishuChannel)
    writeConfig({ enabled: true, accounts: [{ accountId: 'feishu-1', channel: 'feishu', enabled: true }], aliases: { yh: 'WEIXIN_USER_YH' } })
    await writeUserId('WEIXIN_USER_YH', 'o9cq80wOC2WpIFCK9tmM6BmUyByk@im.wechat')
    await writeFeishuCred('feishu-1', 'cli_probe', 'secret_probe')

    const r = await channels.runImBridge(dir, { channel: 'feishu', action: 'send', user: 'yh', text: 'hi' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('ALIAS_UNKNOWN')
    expect(fakeState.sent).toHaveLength(0) // 错误在解析处就拦住，没送到 API
  })

  it('send-file ⇒ ACTION_UNSUPPORTED（如实不支持，不假装）', async () => {
    const { feishuChannel } = await import('../src/im/feishu-channel.js')
    channels.registerImChannel(feishuChannel)
    await readyEnv()
    writeFileSync(join(dir, 'a.txt'), 'x')

    const r = await channels.runImBridge(dir, { channel: 'feishu', action: 'send-file', user: 'ou_abc', file: 'a.txt' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('ACTION_UNSUPPORTED')
  })

  it('两个通道并存：注册表枚举里两个都在，且微信行为不变', async () => {
    const { feishuChannel } = await import('../src/im/feishu-channel.js')
    const { weixinChannel } = await import('../src/im/weixin-channel.js')
    channels.registerImChannel(weixinChannel)
    channels.registerImChannel(feishuChannel)
    expect(channels.imChannelIds().sort()).toEqual(['feishu', 'weixin'])
  })
})

describe('飞书出站通道：未配置时的提示必须说清是哪一半（2026-10-20 真机验收暴露）', () => {
  it('🔴 桥开但没飞书账号 ⇒ 提示指向"加账号"，**不指向 weixin.enabled**', async () => {
    const { feishuChannel } = await import('../src/im/feishu-channel.js')
    channels.registerImChannel(feishuChannel)
    // 桥开着，但只有微信账号
    writeConfig({ enabled: true, accounts: [{ accountId: 'wechat-1', channel: 'weixin', enabled: true }] })

    const r = await channels.runImBridge(dir, { channel: 'feishu', action: 'status' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('CHANNEL_NOT_CONFIGURED')
      // 这一半的改法是"加一条飞书账号"，去开 weixin.enabled 不会生效
      expect(r.remediation).toMatch(/feishu account/i)
      expect(r.remediation).not.toContain('weixin.enabled')
    }
  })

  it('🔴 桥没开 ⇒ 提示指向总开关（这时加账号也没用）', async () => {
    const { feishuChannel } = await import('../src/im/feishu-channel.js')
    channels.registerImChannel(feishuChannel)
    writeConfig({ enabled: false, accounts: [{ accountId: 'feishu-1', channel: 'feishu', enabled: true }] })

    const r = await channels.runImBridge(dir, { channel: 'feishu', action: 'status' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('CHANNEL_NOT_CONFIGURED')
      expect(r.remediation).toMatch(/IM switch|im\.enabled/)
    }
  })

  it('反向：未实现 notEnabledReason 的通道仍给通用提示（不点名任何具体字段）', async () => {
    // 这条守着"缺省文案不许再硬写某个渠道的字段名" —— 那正是本轮修掉的缺陷形态
    channels.registerImChannel({
      id: 'probe',
      isEnabled: () => false,
      resolveUser: () => null,
      listUsers: () => [],
      send: async () => { throw new Error('unused') },
      status: () => ({ enabled: false }),
    })
    const r = await channels.runImBridge(dir, { channel: 'probe', action: 'status' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('CHANNEL_NOT_CONFIGURED')
      expect(r.remediation).not.toContain('weixin.enabled')
    }
  })
})
