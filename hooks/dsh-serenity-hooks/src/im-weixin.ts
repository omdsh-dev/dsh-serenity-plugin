/**
 * im-weixin.ts — 微信通道实现（`im-bridge` 的通道之一，v1.31.0）
 *
 * 能力归 ACC（S142 用户洞察）：本文件吸收原 CCC MSM `.opencode/skills/home-serenity/scripts/
 * weixin-send.ts` 的 `send` / `send-file` / `users` 语义——协议、凭据、账号选择、别名解析、
 * 记录全部落在 ACC 侧；CCC 只保留「何时发 / 发什么 / 怎么写」。
 *
 * 通道内部契约：
 * - `isEnabled(root)` = 该 CCC 的 `weixin.enabled`（可见性判据，im-bridge 用它决定工具是否可见）
 * - `send` 复用 `sendProactiveText`（唯一文本发送实现 + 唯一记录点）
 * - `sendFile` 走 iLink 上传（`weixin-api.sendFileMessage`）+ 同一 outgoing hook（带 `file` 元数据）
 */

import { readStore } from './localstore-ops.js'
import { readWeixinSettings, weixinSessionIdFor, matchWeixinRoute } from './weixin-route.js'
import { sendProactiveText, weixinBridgeStatus, resolveWeixinAccount } from './weixin-bridge.js'
import { sendFileMessage, sendTextMessage } from './weixin-api.js'
import { invokeWeixinHook, buildOutgoingHookEvent } from './weixin-hook.js'
import type { ImChannel, ImUserEntry, ImJson } from './im-bridge.js'

/**
 * 别名 → CCC localstore 凭据键（与 v1.30.9 CCC MSM 逐字一致，迁移零认知成本）。
 * 别名解析属"数据填值"，归 ACC（D23）。
 */
export const WEIXIN_ALIAS_MAP: Record<string, string> = {
  yh: 'WEIXIN_USER_YH',
  danica: 'WEIXIN_USER_DANICA',
  xiaowang: 'WEIXIN_USER_DANICA',
}

/** 读该 CCC 的一个凭据值（空/缺失 → null） */
function credentialValue(root: string, key: string): string | null {
  try {
    const store = readStore(root, 'credential') as Record<string, string>
    const value = store[key]
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
  } catch {
    return null
  }
}

/** 把通道层的失败码转成一句可读错误（工具面统一映射为 SEND_FAILED） */
function channelError(code: string, error: string, remediation?: string): Error {
  return new Error(`${code}: ${error}${remediation ? ` — ${remediation}` : ''}`)
}

export const weixinChannel: ImChannel = {
  id: 'weixin',

  isEnabled(root: string): boolean {
    return readWeixinSettings(root).enabled === true
  },

  resolveUser(root: string, input: string): ImUserEntry | null {
    const raw = input.trim()
    if (raw === '') return null
    const alias = raw.toLowerCase()
    const key = WEIXIN_ALIAS_MAP[alias]
    if (key) {
      const id = credentialValue(root, key)
      return id ? { alias, id } : null
    }
    // 裸 iLink 用户 id（形如 xxx@im.wechat）直接透传
    if (raw.includes('@')) return { alias: raw, id: raw }
    return null
  },

  listUsers(root: string): ImUserEntry[] {
    const out: ImUserEntry[] = []
    for (const [alias, key] of Object.entries(WEIXIN_ALIAS_MAP)) {
      const id = credentialValue(root, key)
      if (id) out.push({ alias, id })
    }
    return out
  },

  async send(input) {
    const result = await sendProactiveText({
      root: input.root,
      toUserId: input.userId,
      text: input.text,
      ...(input.accountId ? { accountId: input.accountId } : {}),
    })
    if (!result.ok) throw channelError(result.code, result.error, result.remediation)
    return { accountId: result.accountId, userId: result.userId, sessionId: result.sessionId, role: result.role }
  },

  async sendFile(input) {
    const settings = readWeixinSettings(input.root)
    if (!settings.enabled) throw channelError('BRIDGE_DISABLED', `微信桥未启用（ccc=${input.root}）`)
    const account = resolveWeixinAccount(input.root, input.accountId)
    if (!account.ok) throw channelError(account.code, account.error, account.remediation)

    const sent = await sendFileMessage({
      baseUrl: account.cred.baseUrl,
      token: account.cred.token,
      toUserId: input.userId,
      data: input.data,
      fileName: input.fileName,
    })
    if (input.caption) {
      await sendTextMessage({
        baseUrl: account.cred.baseUrl,
        token: account.cred.token,
        toUserId: input.userId,
        text: input.caption,
      })
    }
    // 记录（与对话回复同源；source=proactive + file 元数据——CCC 侧只读勿改）
    if (settings.hook) {
      const role = matchWeixinRoute(settings.routes ?? [], input.userId) ?? ''
      void invokeWeixinHook(input.root, settings.hook, buildOutgoingHookEvent({
        cccRoot: input.root,
        accountId: account.accountId,
        userId: input.userId,
        sessionId: weixinSessionIdFor(input.userId),
        role,
        reply: input.caption ? `[文件] ${sent.fileName} — ${input.caption}` : `[文件] ${sent.fileName}`,
        source: 'proactive',
        file: { name: sent.fileName, size: sent.size, ...(input.caption ? { caption: input.caption } : {}) },
      })).catch((err) => {
        console.log(`[serenity-hooks] weixin hook outgoing(file) error: ${err instanceof Error ? err.message : String(err)}`)
      })
    }
    return sent
  },

  /**
   * 通道健康快照（`status` 动作）。
   *
   * 显式映射为 JSON 安全形状（而非把内部结构直接返回）：内部类型含 `undefined`
   * 可选字段与 interface（无隐式索引签名）→ 直接返回既过不了 `ImJson` 类型门，
   * 也会让工具返回值出现不可序列化字段。缺省用条件展开去掉 undefined。
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
    const routes: ImJson[] = (settings.routes ?? []).map((route) => ({ user: route.user, role: route.role }))
    return {
      enabled: settings.enabled === true,
      autoReplyWithLastMessage: settings.autoReplyWithLastMessage !== false,
      fallbackOnNoSend: settings.fallbackOnNoSend === true,
      routes,
      accounts,
    }
  },
}
