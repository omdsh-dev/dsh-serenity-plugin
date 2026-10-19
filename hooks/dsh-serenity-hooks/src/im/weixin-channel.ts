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

import { readStore } from '../kernel/localstore.js'
import { readWeixinSettings, weixinSessionIdFor, matchWeixinRoute } from './route.js'
import { sendProactiveText, weixinBridgeStatus, resolveWeixinAccount } from './bridge.js'
import { sendFileMessage, sendTextMessage } from './ilink.js'
import { invokeWeixinHook, buildOutgoingHookEvent } from './hook.js'
import type { ImChannel, ImUserEntry, ImJson } from './channels.js'

/**
 * 解析该 CCC 的别名表（v1.56.10）。
 *
 * 🔴 **为什么不再硬编码**（2026-10-14 隐私核查）：别名是**使用者自己的称呼**，属 CCC 的数据
 * （D23：加一个别名不该要发版）。此前硬编码在 ACC 源码 ⇒ **这些称呼随 npm 包公开发布**。
 * 现在别名**只**来自该 CCC 的 `.opencode/serenity.json` → `weixin.aliases`；
 * ACC 不认识任何具体名字。未配置 ⇒ `{}`（此时只能用裸 iLink 用户 id）。
 *
 * ⚠️ **迁移**：升级前用过别名的部署，需把原表补进自己的 CCC 配置，否则别名解析不到
 * （见 CHANGELOG v1.56.10 的迁移段；裸 `xxx@im.wechat` 形式始终可用）。
 */
export function weixinAliasMap(root: string): Record<string, string> {
  return readWeixinSettings(root).aliases ?? {}
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
    const key = weixinAliasMap(root)[alias]
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
    for (const [alias, key] of Object.entries(weixinAliasMap(root))) {
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
