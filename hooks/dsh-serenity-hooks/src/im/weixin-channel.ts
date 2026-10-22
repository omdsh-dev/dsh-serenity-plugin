/**
 * im/weixin-channel.ts — 微信通道实现（`im-bridge` 的通道之一，v1.31.0）
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

import { readStore } from '../tools/localstore/service.js'
import { readWeixinSettings, weixinSessionIdForTrajectory, matchWeixinRoute, sanitizeFileName } from './route.js'
import { findDirNameByCode } from '../trajectory/policy/profile.js'
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

/**
 * 路由目标轨迹**是否存在**（`status` 的自检列）。
 *
 * 🔴 复用既有判据 `findDirNameByCode`（它扫活跃区并按编码解析）—— ⛔ 不在这里另写一套目录扫描，
 *    两份判据会漂（一处认归档、另一处不认，就会出现"这里说有、投递时说没有"）。
 *
 * ⚠️ 解析失败（`findDirNameByCode` 在**重码**时会抛）⇒ 返回 `false` 但**不吞掉原因**：
 *    重码本身也是"这个路由不可信"的一种形态，`status` 里会表现为 `targetExists:false`，
 *    配合 `cognitive_trajectory list` 可定位。不额外造一个错误码（键名已经够直白）。
 */
function trajectoryDirExists(root: string, code: string): boolean {
  if (typeof code !== 'string' || code.trim() === '') return false
  try {
    return findDirNameByCode(root, code.trim()) !== null
  } catch {
    return false
  }
}

export const weixinChannel: ImChannel = {
  id: 'weixin',

  isEnabled(root: string): boolean {
    return readWeixinSettings(root).enabled === true
  },

  /**
   * 微信的启用判据**只有总开关这一半**（有 token 的账号是可选的：条数不限、0 条也能开）。
   * ⇒ 它的提示可以只提这个开关 —— 这与飞书的**两半**不同，别把两家的提示合成一句。
   */
  notEnabledReason(): string | undefined {
    return 'This CCC has no IM bridge enabled — turn on the IM switch in .opencode/serenity.json (im.enabled, or the legacy weixin.enabled) or in the settings panel'
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
      // 会话 id = 该用户当前路由到的**轨迹**（与真实对话同一条轨迹）
      const trajectory = matchWeixinRoute(settings.routes ?? [], input.userId) ?? ''
      void invokeWeixinHook(input.root, settings.hook, buildOutgoingHookEvent({
        cccRoot: input.root,
        // 本文件即 `weixin` 的实现 ⇒ 渠道是**已知常量**，不是从 accountId 名字猜的（D167）
        channel: 'weixin',
        accountId: account.accountId,
        userId: input.userId,
        sessionId: weixinSessionIdForTrajectory(trajectory !== '' ? trajectory : sanitizeFileName(input.userId) || 'unknown'),
        role: trajectory,
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
    // 🔴 2026-10-19：路由目标从「轨迹约束角色名」改为**认知轨迹编码**。
    // `role` 键名保留（下游 hook/台账形状不变），值 = 轨迹编码。
    //
    // 🔴 2026-10-22 新增 `targetExists`：**每条路由的目标轨迹是否真的存在**。
    //    为什么必须加（owner：「配路由」这件事 CCC 此前只能猜）：
    //    路由表里写错一个轨迹编码**不会有任何报错** —— 消息进来时 `resolveInboundTarget`
    //    找不到目标，按既有纪律"不投递但留痕"，而调用方（CCC）看到的只是"没回音"。
    //    ⇒ 那是**配了不生效**的典型形态（D179 同族：假入口必须能被发现）。
    //    ⚠️ 它只做**存在性**检查（该目录在不在），不判断该轨迹是否"该收这条消息"。
    const routes: ImJson[] = (settings.routes ?? []).map((route) => {
      const code = route.trajectory
      return {
        user: route.user,
        role: code,
        targetExists: trajectoryDirExists(root, code),
      }
    })
    return {
      enabled: settings.enabled === true,
      autoReplyWithLastMessage: settings.autoReplyWithLastMessage !== false,
      fallbackOnNoSend: settings.fallbackOnNoSend === true,
      routes,
      accounts,
    }
  },
}
