/**
 * weixin-api.ts — 微信个人号 iLink Bot API 客户端（F4c-3，v1.27.0 实验性）
 *
 * 纯 fetch 客户端（Node ≥ 18 原生 fetch + node:crypto），零第三方依赖——
 * 对齐 openclaw-weixin 插件 api.ts 语义（协议全解见 docs/weixin-bot-api.md）。
 *
 * 定位：**Mech 传输层**——只做 HTTP 编解码与请求头，不含业务逻辑（路由/会话映射
 * 在 weixin-route.ts / weixin-bridge.ts）。所有函数可单测（fetch 注入 mock）。
 *
 * 关键协议事实（实证裸调 2026-08-31）：
 * - get_bot_qrcode 无需任何凭据即可取码（无 OpenClaw 账号体系/平台审核）
 * - 鉴权后请求头：AuthorizationType: ilink_bot_token + X-WECHAT-UIN（随机防重放）
 *   + Authorization: Bearer <bot_token> + iLink-App-Id/ClientVersion
 * - getupdates 长轮询 35s hold；游标 get_updates_buf 从响应原样带回续传
 * - sendmessage 必须回带 context_token 关联对话
 */

import { randomBytes } from 'node:crypto'

/** iLink API Base URL（腾讯官方） */
export const ILINK_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
/** CDN Base（媒体上传/下载；P3 媒体期用） */
export const ILINK_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
/** iLink-App-Id（openclaw-weixin 同款） */
const ILINK_APP_ID = 'bot'
/** 通道版本（对齐 openclaw-weixin 2.1.1；buildClientVersion 编码） */
const CHANNEL_VERSION = '2.1.1'

/** 版本号 → ClientVersion 整数：(major<<16)|(minor<<8)|patch */
export function buildClientVersion(version: string): number {
  const parts = version.split('.').map((p) => parseInt(p, 10))
  const major = parts[0] ?? 0
  const minor = parts[1] ?? 0
  const patch = parts[2] ?? 0
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
}

const CLIENT_VERSION = buildClientVersion(CHANNEL_VERSION)

/** 随机 X-WECHAT-UIN（uint32 → base64；每请求不同，防重放） */
function randomWechatUin(): string {
  const uint32 = randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(uint32), 'utf-8').toString('base64')
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`
}

function buildCommonHeaders(): Record<string, string> {
  return {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(CLIENT_VERSION),
  }
}

function buildHeaders(token?: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...buildCommonHeaders(),
  }
}

/** fetch 注入点（测试替换；生产 = 全局 fetch） */
export type FetchLike = typeof fetch

let currentFetch: FetchLike = (...args) => fetch(...args)

/** 测试注入：替换全局 fetch 实现（生产零调用） */
export function __setWeixinFetchForTest(fn: FetchLike | null): void {
  currentFetch = fn ?? ((...args) => fetch(...args))
}

async function apiGet(params: { baseUrl: string; endpoint: string; timeoutMs: number }): Promise<string> {
  const base = ensureTrailingSlash(params.baseUrl)
  const url = new URL(params.endpoint, base)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), params.timeoutMs)
  try {
    const res = await currentFetch(url.toString(), {
      method: 'GET',
      headers: buildCommonHeaders(),
      signal: controller.signal,
    })
    clearTimeout(timer)
    const rawText = await res.text()
    if (!res.ok) throw new Error(`${params.endpoint} ${res.status}: ${rawText}`)
    return rawText
  } catch (err) {
    clearTimeout(timer)
    throw err
  }
}

async function apiPost(params: { baseUrl: string; endpoint: string; body: string; token?: string; timeoutMs: number }): Promise<string> {
  const base = ensureTrailingSlash(params.baseUrl)
  const url = new URL(params.endpoint, base)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), params.timeoutMs)
  try {
    const res = await currentFetch(url.toString(), {
      method: 'POST',
      headers: buildHeaders(params.token),
      body: params.body,
      signal: controller.signal,
    })
    clearTimeout(timer)
    const rawText = await res.text()
    if (!res.ok) throw new Error(`${params.endpoint} ${res.status}: ${rawText}`)
    return rawText
  } catch (err) {
    clearTimeout(timer)
    throw err
  }
}

// ── 扫码登录 ──

/** 取登录二维码（无需凭据；实证裸调可用） */
export async function fetchQRCode(params: {
  baseUrl?: string
  botType?: string
  timeoutMs?: number
}): Promise<{ qrcode: string; qrcode_img_content: string }> {
  const botType = params.botType ?? '3'
  const rawText = await apiGet({
    baseUrl: params.baseUrl ?? ILINK_DEFAULT_BASE_URL,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    timeoutMs: params.timeoutMs ?? 5_000,
  })
  return JSON.parse(rawText) as { qrcode: string; qrcode_img_content: string }
}

/** 扫码状态（轮询；1s 间隔建议，5min 有效） */
export interface QrStatusResult {
  status: string
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  ilink_user_id?: string
  redirect_host?: string
}

export async function pollQRStatus(params: {
  baseUrl?: string
  qrcode: string
  timeoutMs?: number
}): Promise<QrStatusResult> {
  try {
    const rawText = await apiGet({
      baseUrl: params.baseUrl ?? ILINK_DEFAULT_BASE_URL,
      endpoint: `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(params.qrcode)}`,
      timeoutMs: params.timeoutMs ?? 35_000,
    })
    return JSON.parse(rawText) as QrStatusResult
  } catch {
    // 超时/网络错误 → 视为仍在等待（对齐 openclaw-weixin：AbortError → { status: 'wait' }）
    return { status: 'wait' }
  }
}

// ── 消息收发 ──

export interface WeixinMessageItem {
  type?: number
  msg_id?: string
  text_item?: { text?: string }
  image_item?: Record<string, unknown>
  /** 语音项：**text = 微信服务端自带语音转写**（官方 openclaw-weixin 直接读该字段，无需下载/ASR） */
  voice_item?: { text?: string; media?: Record<string, unknown>; playtime?: number }
  file_item?: Record<string, unknown>
  video_item?: Record<string, unknown>
}

export interface WeixinMessage {
  seq?: number
  message_id?: number
  from_user_id?: string
  to_user_id?: string
  client_id?: string
  create_time_ms?: number
  session_id?: string
  group_id?: string
  message_type?: number
  message_state?: number
  item_list?: WeixinMessageItem[]
  context_token?: string
}

export interface GetUpdatesResp {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: WeixinMessage[]
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}

/** 长轮询收消息（35s hold；超时返回空 msgs 不报错——对齐 openclaw-weixin） */
export async function getUpdates(params: {
  baseUrl: string
  token: string
  getUpdatesBuf?: string
  timeoutMs?: number
}): Promise<GetUpdatesResp> {
  const timeout = params.timeoutMs ?? 35_000
  try {
    const rawText = await apiPost({
      baseUrl: params.baseUrl,
      endpoint: 'ilink/bot/getupdates',
      body: JSON.stringify({ get_updates_buf: params.getUpdatesBuf ?? '' }),
      token: params.token,
      timeoutMs: timeout,
    })
    return JSON.parse(rawText) as GetUpdatesResp
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ret: 0, msgs: [], get_updates_buf: params.getUpdatesBuf }
    }
    throw err
  }
}

// ── 发送 ──

export const MessageType = { NONE: 0, USER: 1, BOT: 2 } as const
export const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 } as const
export const MessageItemType = { NONE: 0, TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const

/** 发文本消息（必须回带 context_token 关联对话；md→plain 内置——微信不支持 Markdown） */
export async function sendTextMessage(params: {
  baseUrl: string
  token: string
  toUserId: string
  text: string
  contextToken?: string
  clientId?: string
  timeoutMs?: number
}): Promise<void> {
  const clientId = params.clientId ?? `dsp-weixin-${randomBytes(4).toString('hex')}`
  await apiPost({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/sendmessage',
    body: JSON.stringify({
      msg: {
        from_user_id: '',
        to_user_id: params.toUserId,
        client_id: clientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [{ type: MessageItemType.TEXT, text_item: { text: markdownToPlainText(params.text) } }],
        ...(params.contextToken ? { context_token: params.contextToken } : {}),
      },
    }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? 15_000,
  })
}

// ── 正在输入 / 对话配置 ──

/** sendtyping status：1=TYPING（开始）0=CANCEL（结束）。
 *  ⚠️ 对齐**官方 openclaw-weixin 参考实现**（index.ts onReplyStart → status 1 /
 *  onCleanup → status 0）——早期协议注释"2=CANCEL"为误记，以参考实现为准。 */
export const TypingStatus = { TYPING: 1, CANCEL: 0 } as const

export interface GetConfigResp {
  ret?: number
  errmsg?: string
  typing_ticket?: string
}

/** 取对话配置（typing_ticket：sendtyping 的前置——先 getconfig 拿 ticket 再发状态） */
export async function getConfig(params: {
  baseUrl: string
  token: string
  ilinkUserId: string
  contextToken: string
  timeoutMs?: number
}): Promise<GetConfigResp> {
  const rawText = await apiPost({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/getconfig',
    body: JSON.stringify({ ilink_user_id: params.ilinkUserId, context_token: params.contextToken }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? 10_000,
  })
  return JSON.parse(rawText) as GetConfigResp
}

/** 发送"正在输入"状态（status: 1=开始 0=结束；ticket 来自 getConfig） */
export async function sendTyping(params: {
  baseUrl: string
  token: string
  ilinkUserId: string
  typingTicket: string
  status: number
  timeoutMs?: number
}): Promise<void> {
  await apiPost({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/sendtyping',
    body: JSON.stringify({ ilink_user_id: params.ilinkUserId, typing_ticket: params.typingTicket, status: params.status }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? 10_000,
  })
}

// ── Markdown → 纯文本（微信不支持 Markdown；对齐 openclaw-weixin messenger.ts）──

/** Markdown → 纯文本（代码块/图片/链接/表格/标题/粗斜体/删除线 7 类） */
export function markdownToPlainText(text: string): string {
  let result = text
  result = result.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code: string) => code.trim())
  result = result.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  // 表格行：以 | 起止的整行删除（内容行含字母——原 openclaw 正则 [\s:|-]+ 匹配不了字母）
  result = result.replace(/^\|.*\|[ \t]*$/gm, '')
  result = result.replace(/^#+\s*/gm, '')
  result = result.replace(/\*\*([^*]+)\*\*/g, '$1')
  result = result.replace(/\*([^*]+)\*/g, '$1')
  result = result.replace(/`([^`]+)`/g, '$1')
  result = result.replace(/~~([^~]+)~~/g, '$1')
  return result.trim()
}
