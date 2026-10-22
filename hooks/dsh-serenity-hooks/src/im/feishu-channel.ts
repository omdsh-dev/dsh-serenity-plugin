/**
 * im/feishu-channel.ts — 飞书**出站**通道实现（`im-bridge` 的通道之二，2026-10-20 Q4）
 *
 * ## 为什么这个文件现在才出现（先摆事实，免得下次重走）
 *
 * 入站那半（P1~P4，2026-10-19）早已完成：`feishu-account.ts` 能建长连接、能收消息、
 * 能**回**消息（`feishuIo()`）。但那是"收到一条消息后回它"，**不是**"agent 主动发一条"。
 * 而 agent 主动发的唯一入口是 `im-bridge` 工具 → 它查的是 `im/channels.ts` 的通道注册表
 * ⇒ 那张表里**只有 `weixin` 一个条目** ⇒ `im-bridge({channel:"feishu"})` 此前恒返回
 * `CHANNEL_UNKNOWN`（尽管发消息的协议形态早就写好并测过）。
 *
 * ⇒ 本文件的全部职责：**把已经存在的飞书发送能力，挂到那张注册表上**。
 * 不是"新做一个能力"，是"把两个各自能用的半件接起来"。
 *
 * ## 与 `weixin-channel.ts` 的刻意差异（三条，各有理由）
 *
 * 1. **`sendFile` 不实现** —— 诚实地说"不支持"，工具会返回 `ACTION_UNSUPPORTED`。
 *    假装支持会得到一条"发出去的文件收不到"的静默故障。
 * 2. **`resolveUser` 做形状校验（`ou_` 前缀）** —— 见下 🔴。
 * 3. **不 fire 记录 hook** —— 见下 🔴。
 *
 * ## 🔴 别名表的跨渠道危险（这是本文件最要紧的一条判据）
 *
 * `im.aliases` 是**一张表服务所有渠道**（`{ "<别名>": "<localstore 凭据键>" }`）。
 * 若只做"按键查值"，把映射到**微信 id** 的那条喂给飞书通道，就会拿别人的 id 跨渠道发消息
 * —— 而飞书 API 会返回一个**读不懂的错误码**，症状是"飞书发不出去"而不是"我配错了渠道"。
 * ⇒ 校验**值的形状**（飞书 open_id 以 `ou_` 开头）：错配在**解析处**就失败，
 *    错误码是 `ALIAS_UNKNOWN` + 可行动提示。
 *
 * ## 🔴 记录 hook：曾经不 fire，2026-10-22 起 fire（A83 已裁）
 *
 * **当时的理由**：`settings.hook` 的契约与消费方都是**微信的**，CCC 的
 * `scripts/weixin-message-hook.ts` 把事件追加进 `AGENT_SESSIONS/_weixin-logs/<日期>.jsonl`。
 * 飞书事件若流进去，那个目录就**同时装两种渠道的数据而名字只说一种**（D151／D179 同族）。
 *
 * **为什么现在可以 fire**：同批给 hook 事件加了 **`channel` 字段**（owner 2026-10-22：
 * 「一个 CCC 绑定多个账户很常见，聊天记录落盘要完善」）⇒ CCC 侧 hook 按渠道分流到
 * `_im-logs/<channel>/`，**目录名不再需要撒谎**。
 * ⇒ 所以这不是"决定记录"，而是"**让记录不再有害**之后才记录"。
 * ⚠️ 顺序有意义：**先有渠道字段，再有记录**。反过来做就会先造出一批分不清渠道的数据。
 */
import { readStore } from '../tools/localstore/service.js'
import {
  readFeishuCredential, readWeixinSettings, weixinSessionIdForTrajectory, matchWeixinRoute, sanitizeFileName,
} from './route.js'
import { weixinBridgeStatus } from './bridge.js'
import { markdownToPlainText } from './ilink.js'
import { invokeWeixinHook, buildOutgoingHookEvent } from './hook.js'
import { loadFeishuSdk } from './feishu-account.js'
import type { ImChannel, ImUserEntry, ImJson } from './channels.js'

/**
 * 飞书 open_id 的形状前缀（官方形态：`ou_` ＋ 一串）。
 *
 * ⚠️ 这是**形状**判据，不是**合法性**判据 —— 它拦的是"把别的渠道的 id 当飞书 id 用"
 * 这一类错配，不负责证明该 id 真在飞书侧存在（那只有调用 API 才知道）。
 */
const FEISHU_USER_ID_PREFIX = 'ou_'

/** 该账号行是否是飞书账号（`channel` 缺省归一为 weixin —— 与 `normalizeAccountChannel` 同口径） */
function isFeishuAccount(row: { channel?: string }): boolean {
  return (row.channel ?? '').trim() === 'feishu'
}

/** 读该 CCC 的一个凭据值（空/缺失 → null；与微信通道同款读法） */
function credentialValue(root: string, key: string): string | null {
  try {
    const store = readStore(root, 'credential') as Record<string, string>
    const value = store[key]
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
  } catch {
    return null
  }
}

/**
 * 该 CCC 里**形状对得上飞书**的别名 → id。
 *
 * 形状不符的别名**不出现**：出现在 `users` 里就等于告诉模型"这个能用"，然后它一定失败。
 */
function feishuUsers(root: string): ImUserEntry[] {
  const aliases = readWeixinSettings(root).aliases ?? {}
  const out: ImUserEntry[] = []
  for (const [alias, key] of Object.entries(aliases)) {
    const id = credentialValue(root, key)
    if (id && id.startsWith(FEISHU_USER_ID_PREFIX)) out.push({ alias, id })
  }
  return out
}

/** 解析结果（与微信侧 `WeixinAccountResolution` 同构） */
type FeishuAccountResolution =
  | { ok: true; accountId: string; appId: string; appSecret: string }
  | { ok: false; code: string; error: string; remediation?: string }

/**
 * 解析该 CCC 的飞书发送账号 ＋ 凭据。
 *
 * 顺序与微信侧 `resolveWeixinAccount` **同构**（桥启用 → 有启用账号 → 指定账号存在且是飞书
 * → 凭据已绑），因为"为什么发不出去"的排查路径必须逐字对应——两个渠道给出不同的失败顺序，
 * 用户就得记两套。
 */
export function resolveFeishuAccount(root: string, accountId?: string): FeishuAccountResolution {
  const settings = readWeixinSettings(root)
  if (settings.enabled !== true) {
    return {
      ok: false,
      code: 'BRIDGE_DISABLED',
      error: `IM 桥未启用（ccc=${root}）`,
      remediation: '在 .opencode/serenity.json 的 im（或 weixin）.enabled 打开',
    }
  }
  const accounts = (settings.accounts ?? []).filter(
    (a) => a.enabled !== false && isFeishuAccount(a as { channel?: string }),
  )
  if (accounts.length === 0) {
    return {
      ok: false,
      code: 'NO_ACCOUNT',
      error: '未配置任何启用中的飞书账号',
      remediation: '在设置面板「IM 桥」用 App ID + App Secret 添加一个飞书账号',
    }
  }
  const id = accountId ?? accounts[0]!.accountId
  if (!accounts.some((a) => a.accountId === id)) {
    return {
      ok: false,
      code: 'ACCOUNT_NOT_FOUND',
      error: `飞书账号不存在或未启用: ${id}`,
      remediation: `可用的飞书账号: ${accounts.map((a) => a.accountId).join(', ')}`,
    }
  }
  const cred = readFeishuCredential(root, id)
  if (!cred) {
    return {
      ok: false,
      code: 'ACCOUNT_NOT_BOUND',
      error: `飞书账号未绑定（缺 appId 或 appSecret）: ${id}`,
      remediation: '在设置面板「IM 桥」重新添加该飞书账号',
    }
  }
  return { ok: true, accountId: id, appId: cred.appId, appSecret: cred.appSecret }
}

/** 把通道层的失败码转成一句可读错误（工具面统一映射为 SEND_FAILED） */
function channelError(code: string, error: string, remediation?: string): Error {
  return new Error(`${code}: ${error}${remediation ? ` — ${remediation}` : ''}`)
}

export const feishuChannel: ImChannel = {
  id: 'feishu',

  /**
   * 可见性判据：**本 CCC 有一条能用的飞书账号**。
   *
   * 🔴 刻意**不**只看 `settings.enabled`：那个开关是**渠道无关**的，只看它会让
   * 一个只配了微信的 CCC 也把 `feishu` 报成"已启用" ⇒ `im-bridge` 的
   * `Channels:` 枚举里出现一个用不了的名字（说明面撒谎，D179）。
   */
  isEnabled(root: string): boolean {
    const settings = readWeixinSettings(root)
    if (settings.enabled !== true) return false
    return (settings.accounts ?? []).some(
      (a) => a.enabled !== false && isFeishuAccount(a as { channel?: string }),
    )
  },

  /**
   * 启用判据不成立时**说清是哪一半不成立**。
   *
   * 🔴 两半的改法完全不同（总开关 vs 加一条账号），合并成一句会让人改错那一半
   * —— 这正是本轮真机验收暴露出来的形态（旧文案只提 `weixin.enabled`）。
   */
  notEnabledReason(root: string): string | undefined {
    const settings = readWeixinSettings(root)
    if (settings.enabled !== true) {
      return 'This CCC has no IM bridge enabled — turn on the IM switch in .opencode/serenity.json (im.enabled, or the legacy weixin.enabled) or in the settings panel'
    }
    return 'The IM bridge is on, but this CCC has no enabled feishu account — add one (App ID + App Secret) in the settings panel, or add a row with channel:"feishu" to im.accounts'
  },

  resolveUser(root: string, input: string): ImUserEntry | null {
    const raw = input.trim()
    if (raw === '') return null
    const alias = raw.toLowerCase()
    const key = (readWeixinSettings(root).aliases ?? {})[alias]
    if (key) {
      const id = credentialValue(root, key)
      // 🔴 形状校验：这个别名指向的是**别的渠道**的 id ⇒ 拒绝，不把错误送到 API
      if (!id || !id.startsWith(FEISHU_USER_ID_PREFIX)) return null
      return { alias, id }
    }
    // 裸飞书 open_id 直接透传（形状对才透传）
    if (raw.startsWith(FEISHU_USER_ID_PREFIX)) return { alias: raw, id: raw }
    return null
  },

  listUsers(root: string): ImUserEntry[] {
    return feishuUsers(root)
  },

  async send(input) {
    const account = resolveFeishuAccount(input.root, input.accountId)
    if (!account.ok) throw channelError(account.code, account.error, account.remediation)

    const Lark = await loadFeishuSdk()
    const client = new Lark.Client({ appId: account.appId, appSecret: account.appSecret })
    const create = client.im?.v1?.message?.create
    if (typeof create !== 'function') throw channelError('SEND_FAILED', '飞书 SDK 缺少 im.v1.message.create')

    try {
      await create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: input.userId,
          msg_type: 'text',
          // 🔴 JSON 字符串，不是裸文本（官方形态；裸文本会被服务端拒且错误码不直观）
          content: JSON.stringify({ text: markdownToPlainText(input.text) }),
        },
      })
    } catch (err) {
      throw channelError('SEND_FAILED', err instanceof Error ? err.message : String(err))
    }

    // 记录用的会话 id / 轨迹编码：与该用户平时对话**同一条轨迹**（与微信侧同口径）
    const settings = readWeixinSettings(input.root)
    const trajectory = matchWeixinRoute(settings.routes ?? [], input.userId) ?? ''
    const sessionId = weixinSessionIdForTrajectory(
      trajectory !== '' ? trajectory : sanitizeFileName(input.userId) || 'unknown',
    )
    // 🔴 2026-10-22（owner：「飞书要记录」＋「一个 CCC 绑定多个账户很常见，落盘要完善」）：
    //    **开始 fire 记录 hook**。上一版不 fire 的理由是"目录名会说谎"（`_weixin-logs` 里装飞书数据）；
    //    那个理由**随事件新增 `channel` 字段而消失** —— 现在事件自带渠道，
    //    CCC 侧的 hook 可以按渠道分流到 `_im-logs/<channel>/`，目录名不再需要撒谎。
    if (settings.hook) {
      void invokeWeixinHook(input.root, settings.hook, buildOutgoingHookEvent({
        cccRoot: input.root,
        // 🔴 渠道**显式声明**，不是从 accountId 名字推断（D167：认族不认名）
        channel: 'feishu',
        accountId: account.accountId,
        userId: input.userId,
        sessionId,
        role: trajectory,
        reply: markdownToPlainText(input.text),
        source: 'proactive',
      })).catch((err) => {
        console.log(`[serenity-hooks] im hook outgoing(feishu) error: ${err instanceof Error ? err.message : String(err)}`)
      })
    }
    return { accountId: account.accountId, userId: input.userId, sessionId, role: trajectory }
  },

  // ⛔ 刻意不实现 `sendFile`：飞书文件要先 `im.v1.file.create` 上传再发 `msg_type:'file'`，
  //    本批不做（A84）。不实现 ⇒ 工具如实返回 `ACTION_UNSUPPORTED`，比假装支持好。

  /**
   * 通道健康快照（`status` 动作）。
   *
   * 与微信通道**同一个数据源**（`weixinBridgeStatus()`）—— 因为长连接的生命周期归
   * 账号实现（`feishu-account.ts`），不归本文件。本文件只做**出站**，
   * 它没有自己的连接状态可报。⇒ 如实转述，不编造一个"出站健康度"。
   */
  status(root: string): ImJson {
    const settings = readWeixinSettings(root)
    const accounts: ImJson[] = weixinBridgeStatus()
      .filter((entry) => entry.ccc === root)
      .flatMap((entry) => entry.accounts.map((account) => ({
        accountId: account.accountId,
        lastPollAt: account.lastPollAt,
        ...(account.lastError ? { lastError: account.lastError } : {}),
      })))
    const routes: ImJson[] = (settings.routes ?? []).map((route) => ({ user: route.user, role: route.trajectory }))
    return {
      enabled: settings.enabled === true,
      autoReplyWithLastMessage: settings.autoReplyWithLastMessage !== false,
      fallbackOnNoSend: settings.fallbackOnNoSend === true,
      routes,
      accounts,
    }
  },
}
