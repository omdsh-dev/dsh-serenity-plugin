/**
 * weixin-route.ts — 微信桥 CCC 配置层纯逻辑（F4c-3，v1.27.0 实验性）
 *
 * 职责（零 DSH 依赖，可独立单测）：
 * - 读取 CCC 的 weixin 配置（.opencode/serenity.json weixin 段——结构/路由/开关）
 * - 读取/写入 CCC localstore 的账号凭据（weixin.accounts.<accountId>.token/.baseUrl/.userId）
 * - 微信用户 → skiff 会话 id 映射（固定可重建：skiff-weixin-<sha256(userid)>.slice(1, 17)；
 *   v1.27.3 错位一位避开损坏 log）
 * - 路由匹配（exact user → 通配 * 兜底）
 *
 * 配置归属（S142 用户拍板）：**CCC 级**——serenity.json 结构 + localstore 凭据分离；
 * 不绑定具体 role（用户自选路由目标）。
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { loadSerenityConfig, DEFAULT_SERENITY_CONFIG_PATHS, type WeixinSettings, type WeixinRouteConfig, type WeixinAccountConfig } from './ccc.js'
import { writeEntry, getEntry, unsetEntry } from './localstore-ops.js'
import type { WeixinMediaRef, WeixinMessageItem } from './weixin-api.js'

/** localstore 凭据键前缀（**credential scope**——token 是凭据，走 UPPER_SNAKE 键；
 *  格式 WEIXIN_<ACCOUNT_ID>_TOKEN / _BASEURL / _USERID（accountId 归一为大写蛇形）） */
const LS_PREFIX = 'WEIXIN_'

/** accountId → UPPER_SNAKE 片段（wechat-1 → WECHAT_1） */
function accountKeyPart(accountId: string): string {
  return accountId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
}

/** 微信桥 skiff 会话 id 前缀（seams 旁路判定；对外面纯净——守卫识别外部面） */
export const WEIXIN_SESSION_PREFIX = 'skiff-weixin-'

/** 判定 sessionId 是否为微信桥会话（外部面——输出守卫/轨迹隐藏生效） */
export function isWeixinSessionId(sessionId: string | undefined): boolean {
  return typeof sessionId === 'string' && sessionId.startsWith(WEIXIN_SESSION_PREFIX)
}

/** 微信用户 → 固定会话 id（同用户长期同一会话，记忆延续；多用户天然隔离）。
 *  **v1.27.2 错位一位（用户拍板）**：`.slice(0, 16)` → `.slice(1, 17)`——旧规则生成的
 *  固定 id 已与磁盘损坏的持久化 log 绑定（dsh 不可硬删，create 同 id 必撞）→
 *  新规则下同用户生成**全新 id**，避开损坏 log；固定可重建语义不变（同用户恒同 id）。 */
export function weixinSessionIdFor(fromUserId: string): string {
  const digest = createHash('sha256').update(fromUserId).digest('hex').slice(1, 17)
  return `${WEIXIN_SESSION_PREFIX}${digest}`
}

/**
 * 读取 CCC 微信桥配置（未配置/未启用 → 归一默认）。
 * @returns 归一化 WeixinSettings（accounts/routes 数组清洗；空段 → 空数组）
 */
export function readWeixinSettings(root: string, paths: string[] = DEFAULT_SERENITY_CONFIG_PATHS): WeixinSettings {
  try {
    const cfg = loadSerenityConfig(root, paths)
    const w = cfg.weixin
    if (!w || typeof w !== 'object') return { enabled: false, accounts: [], routes: [] }
    return {
      enabled: w.enabled === true,
      botType: typeof w.botType === 'string' && w.botType !== '' ? w.botType : undefined,
      hook: typeof w.hook === 'string' && w.hook.trim() !== '' ? w.hook.trim() : undefined,
      accounts: Array.isArray(w.accounts)
        ? w.accounts
            .filter((a): a is { accountId: string; name?: string; enabled?: boolean } =>
              typeof a === 'object' && a !== null && typeof a.accountId === 'string' && a.accountId !== '')
            .map((a) => ({ accountId: a.accountId, name: typeof a.name === 'string' ? a.name : undefined, enabled: a.enabled !== false }))
        : [],
      routes: Array.isArray(w.routes)
        ? w.routes
            .filter((r): r is WeixinRouteConfig =>
              typeof r === 'object' && r !== null && typeof r.user === 'string' && r.user !== '' && typeof r.role === 'string' && r.role !== '')
        : [],
    }
  } catch {
    return { enabled: false, accounts: [], routes: [] }
  }
}

/** 账号凭据（localstore credential scope；baseUrl 缺省 = 官方默认） */
export interface WeixinAccountCredential {
  token: string
  baseUrl: string
  userId?: string
}

/** localstore 凭据键（credential scope: WEIXIN_<ACCOUNT_ID>_<FIELD>） */
function lsKey(accountId: string, field: 'TOKEN' | 'BASEURL' | 'USERID'): string {
  return `${LS_PREFIX}${accountKeyPart(accountId)}_${field}`
}

/** 读取账号凭据（token 缺失 → null——账号未绑定） */
export function readWeixinCredential(root: string, accountId: string): WeixinAccountCredential | null {
  const token = getEntry(root, 'credential', lsKey(accountId, 'TOKEN'))
  if (!token) return null
  const baseUrl = getEntry(root, 'credential', lsKey(accountId, 'BASEURL'))
  const userId = getEntry(root, 'credential', lsKey(accountId, 'USERID'))
  return { token, baseUrl: baseUrl ?? '', userId: userId ?? undefined }
}

/** 写入账号凭据（扫码 confirmed 后；token 必写，baseUrl/userId 可选） */
export function writeWeixinCredential(root: string, accountId: string, cred: WeixinAccountCredential): void {
  writeEntry(root, 'credential', lsKey(accountId, 'TOKEN'), cred.token)
  if (cred.baseUrl) writeEntry(root, 'credential', lsKey(accountId, 'BASEURL'), cred.baseUrl)
  if (cred.userId) writeEntry(root, 'credential', lsKey(accountId, 'USERID'), cred.userId)
}

/** 清除账号凭据（移除账号时） */
export function clearWeixinCredential(root: string, accountId: string): void {
  unsetEntry(root, 'credential', lsKey(accountId, 'TOKEN'))
  unsetEntry(root, 'credential', lsKey(accountId, 'BASEURL'))
  unsetEntry(root, 'credential', lsKey(accountId, 'USERID'))
}

/**
 * 路由匹配：exact user 优先，通配 `*` 兜底。
 * @returns 命中的 role 名；未命中 → null（无路由 → 消息不回复/忽略）
 */
export function matchWeixinRoute(routes: WeixinRouteConfig[], fromUserId: string): string | null {
  if (!Array.isArray(routes) || routes.length === 0) return null
  for (const r of routes) {
    if (r.user === fromUserId) return r.role
  }
  for (const r of routes) {
    if (r.user === '*') return r.role
  }
  return null
}

/**
 * 提取消息文本（文本项 + **语音项的服务端转写**）：
 * - type 1 TEXT → `text_item.text`
 * - type 3 VOICE → `voice_item.text`——**微信服务端自带语音转写**（官方 openclaw-weixin
 *   直接读该字段并入对话文本，无需下载/ASR；对齐参考实现 index.ts voiceTexts）。
 * @returns 纯文本；无文本 → null
 */
export function extractWeixinText(msg: { item_list?: Array<{ type?: number; text_item?: { text?: string }; voice_item?: { text?: string } }> }): string | null {
  const items = msg.item_list
  if (!Array.isArray(items) || items.length === 0) return null
  for (const item of items) {
    if (item.type === 1 && typeof item.text_item?.text === 'string') {
      const text = item.text_item.text.trim()
      if (text !== '') return text
    }
    if (item.type === 3 && typeof item.voice_item?.text === 'string') {
      const text = item.voice_item.text.trim()
      if (text !== '') return text
    }
  }
  return null
}

/** 是否包含语音项（无转写文本时的降级提示判定——bridge 用） */
export function hasVoiceItem(msg: { item_list?: Array<{ type?: number; voice_item?: unknown }> }): boolean {
  return (msg.item_list ?? []).some((item) => item.type === 3 && item.voice_item != null)
}

/**
 * 提取消息媒体项（图片 type 2 / 文件 type 4）：
 * 只收集**带 media 元数据**的项（下载前置条件）；返回 kind + **完整消息项**（downloadMedia 用
 * `item[mediaType]` 取 image_item/file_item）。纯 ACC 层可达性——不做内容处理（v0.2 用户拍板）。
 */
export function extractWeixinMedia(msg: { item_list?: WeixinMessageItem[] }): WeixinMediaRef[] {
  const out: WeixinMediaRef[] = []
  for (const item of msg.item_list ?? []) {
    if (item.type === 2 && item.image_item?.media) {
      out.push({ kind: 'image', fileName: undefined, item })
    } else if (item.type === 4 && item.file_item?.media) {
      out.push({ kind: 'file', fileName: item.file_item.file_name, item })
    }
  }
  return out
}

/** 文件名净化：basename + 去控制字符 + 截断 128（防路径穿越——落盘安全） */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, '').trim()
  return cleaned.slice(0, 128)
}

/** 落盘目录：`<CCC 根>/_tmp/weixin-inbound/<userhash>/`（gitignored ✓；agent read 边界内 ✓；按用户分目录） */
export function weixinInboundDir(root: string, fromUserId: string): string {
  const userHash = createHash('sha256').update(fromUserId).digest('hex').slice(0, 12)
  return join(root, '_tmp', 'weixin-inbound', userHash)
}

// ── CCC 配置写入（面板保存；serenity.json 结构部分）──

/**
 * 读取 serenity.json 文件（原始；不存在 → 空对象）。
 * 注意：loadSerenityConfig 返回解析对象但无法写回——此处直接文件读写。
 */
function readRawConfig(root: string, paths: string[] = DEFAULT_SERENITY_CONFIG_PATHS): Record<string, unknown> {
  for (const candidate of paths) {
    const p = resolve(root, candidate)
    if (existsSync(p)) {
      try {
        const v = JSON.parse(readFileSync(p, 'utf-8').replace(/^\uFEFF/, '')) as unknown
        if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
      } catch {
        return {}
      }
    }
  }
  return {}
}

/** 写入 serenity.json（保留既有字段；weixin 段整体替换） */
function writeWeixinSection(root: string, weixin: WeixinSettings, paths: string[] = DEFAULT_SERENITY_CONFIG_PATHS): void {
  // 写回规范位置（paths[0] = .opencode/serenity.json）；文件不存在则新建
  const target = resolve(root, paths[0] ?? '.opencode/serenity.json')
  const raw = readRawConfig(root, paths)
  raw.weixin = weixin
  const dir = resolve(target, '..')
  if (!existsSync(dir)) {
    // .opencode 目录可能不存在（新 CCC）——创建
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(target, JSON.stringify(raw, null, 2) + '\n', 'utf-8')
}

/** 添加/更新账号（serenity.json 结构部分；凭据单独写 localstore） */
export function upsertWeixinAccount(root: string, account: WeixinAccountConfig): WeixinSettings {
  const settings = readWeixinSettings(root)
  const accounts = settings.accounts ?? []
  const idx = accounts.findIndex((a) => a.accountId === account.accountId)
  if (idx >= 0) accounts[idx] = { ...accounts[idx], ...account }
  else accounts.push(account)
  const next: WeixinSettings = { ...settings, accounts }
  writeWeixinSection(root, next)
  return next
}

/** 移除账号（serenity.json 结构 + localstore 凭据；同时停桥由调用方 syncCccBridge） */
export function removeWeixinAccount(root: string, accountId: string): WeixinSettings {
  const settings = readWeixinSettings(root)
  const accounts = (settings.accounts ?? []).filter((a) => a.accountId !== accountId)
  const next: WeixinSettings = { ...settings, accounts }
  writeWeixinSection(root, next)
  clearWeixinCredential(root, accountId)
  return next
}

/** 保存路由表（整体替换） */
export function saveWeixinRoutes(root: string, routes: WeixinRouteConfig[]): WeixinSettings {
  const settings = readWeixinSettings(root)
  const next: WeixinSettings = { ...settings, routes }
  writeWeixinSection(root, next)
  return next
}

/**
 * 生成下一个可用账号 id（`wechat-N`，N 自增取**最小未占用**）：
 * 多账号支持（S142 用户反馈 ①"要支持添加多个账号，每个都是扫码"）——
 * 移除中间账号后不冲突（wechat-2 被删 → 新账号复用 wechat-2 而非跳到 4）。
 */
export function nextWeixinAccountId(settings: WeixinSettings): string {
  const used = new Set((settings.accounts ?? []).map((a) => a.accountId))
  let n = 1
  while (used.has(`wechat-${n}`)) n++
  return `wechat-${n}`
}

/** 切换总开关 */
export function setWeixinEnabled(root: string, enabled: boolean): WeixinSettings {
  const settings = readWeixinSettings(root)
  const next: WeixinSettings = { ...settings, enabled }
  writeWeixinSection(root, next)
  return next
}
