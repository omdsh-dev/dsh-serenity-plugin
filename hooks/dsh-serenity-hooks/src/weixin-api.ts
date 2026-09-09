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

import { randomBytes, createDecipheriv, createCipheriv, createHash } from 'node:crypto'

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

/**
 * iLink 业务层返回码校验（v1.30.9 修复）：`apiPost` 只判 HTTP 状态，而 iLink 在 **HTTP 200**
 * 的响应体里用 `ret` / `errcode` 表达失败（如 `{ret:1,errmsg:"denied"}`）——此前被当作成功，
 * 于是"发送成功"的判定是假的：回复路径会给一条**从未送达**的消息触发 outgoing hook 记录
 * （与 weixin-bridge 注释"发送失败不记录"矛盾）。发送类调用一律经此校验。
 * 非 JSON 的 200 响应保持既有宽容语义（视为成功）。
 * @param endpoint 端点名（错误信息定位用）
 * @param rawText 响应体原文
 */
export function assertIlinkOk(endpoint: string, rawText: string): void {
  let json: { ret?: number; errcode?: number; errmsg?: string }
  try {
    json = JSON.parse(rawText) as { ret?: number; errcode?: number; errmsg?: string }
  } catch {
    return
  }
  const detail = json.errmsg ? `: ${json.errmsg}` : ''
  if (typeof json.ret === 'number' && json.ret !== 0) {
    throw new Error(`${endpoint} ret=${json.ret}${detail}`)
  }
  if (typeof json.errcode === 'number' && json.errcode !== 0) {
    throw new Error(`${endpoint} errcode=${json.errcode}${detail}`)
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

/** CDN 媒体元数据（下载侧；协议见 docs/weixin-bot-api.md §6） */
export interface CDNMedia {
  encrypt_query_param?: string
  aes_key?: string
  encrypt_type?: number
  full_url?: string
}

/** 媒体项引用（extractWeixinMedia 产物：kind + **完整消息项**——downloadMedia 用 item[mediaType] 提取） */
export interface WeixinMediaRef {
  kind: 'image' | 'file'
  fileName?: string
  item: WeixinMessageItem
}

export interface WeixinMessageItem {
  type?: number
  msg_id?: string
  text_item?: { text?: string }
  image_item?: { media?: CDNMedia; thumb_media?: CDNMedia; aeskey?: string; url?: string; mid_size?: number; thumb_size?: number }
  /** 语音项：**text = 微信服务端自带语音转写**（官方 openclaw-weixin 直接读该字段，无需下载/ASR） */
  voice_item?: { text?: string; media?: CDNMedia; playtime?: number }
  file_item?: { media?: CDNMedia; file_name?: string; md5?: string; len?: string }
  video_item?: { media?: CDNMedia; video_size?: number; thumb_media?: CDNMedia }
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

/** 发文本消息（主动发起时可不带 context_token；md→plain 内置——微信不支持 Markdown）。
 *  v1.30.9：HTTP 200 但 `ret/errcode != 0` → 抛错（此前静默当成功，导致"记录已送达"的假象）。 */
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
  const rawText = await apiPost({
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
  assertIlinkOk('ilink/bot/sendmessage', rawText)
}

// ── 文件发送（v1.31.0：从 CCC MSM 迁入——IM 能力归 ACC）──

/** getuploadurl 响应（iLink 业务层） */
interface UploadUrlResp {
  ret?: number
  errcode?: number
  errmsg?: string
  upload_param?: string
  upload_full_url?: string
  filekey?: string
}

/** 文件字节数 → 16 字节对齐（协议要求 filesize 为 padded 长度） */
function padTo16(n: number): number {
  return Math.ceil(n / 16) * 16
}

/**
 * 发送文件：`getuploadurl` → CDN 上传（AES-128-ECB 加密体）→ `sendmessage`（FILE item）。
 *
 * 语义与 v1.30.9 的 CCC MSM 实现逐行一致（协议见 `docs/weixin-bot-api.md` §6）：
 * `media.aes_key` = base64(hex(aesKey))；`filesize` = padded 长度；上传响应的
 * `x-encrypted-param` 头优先，缺失时回退响应体 JSON 的 `encrypted_query_param`。
 *
 * @param params 凭据 + 目标用户 + 本地文件路径（调用方负责 CCC 内路径校验与大小上限）
 * @returns 实际发送的文件名与字节数
 */
export async function sendFileMessage(params: {
  baseUrl: string
  token: string
  toUserId: string
  data: Buffer
  fileName: string
  timeoutMs?: number
}): Promise<{ fileName: string; size: number }> {
  const { data, fileName, toUserId } = params
  const fileSize = data.length
  const rawFileMd5 = createHash('md5').update(data).digest('hex')
  const aesKey = randomBytes(16)
  const aesKeyHex = aesKey.toString('hex')
  const aesKeyB64 = Buffer.from(aesKeyHex, 'utf-8').toString('base64')
  const fileKey = `dsp-${randomBytes(8).toString('hex')}`

  const uplRaw = await apiPost({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/getuploadurl',
    body: JSON.stringify({
      filekey: fileKey,
      media_type: 3, // 3 = 文件
      to_user_id: toUserId,
      rawsize: fileSize,
      rawfilemd5: rawFileMd5,
      filesize: padTo16(fileSize),
      aeskey: aesKeyHex,
      no_need_thumb: true,
    }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? 15_000,
  })
  let upl: UploadUrlResp
  try {
    upl = JSON.parse(uplRaw) as UploadUrlResp
  } catch {
    throw new Error(`getuploadurl 响应非 JSON: ${uplRaw.slice(0, 300)}`)
  }
  assertIlinkOk('ilink/bot/getuploadurl', uplRaw)
  if (!upl.upload_full_url && !upl.upload_param) {
    throw new Error(`getuploadurl 响应缺 upload_full_url/upload_param: ${uplRaw.slice(0, 300)}`)
  }
  const uploadUrl = upl.upload_full_url
    ?? `${ILINK_CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(upl.upload_param ?? '')}&filekey=${encodeURIComponent(upl.filekey ?? fileKey)}`

  const cipher = createCipheriv('aes-128-ecb', aesKey, null)
  const encBody = Buffer.concat([cipher.update(data), cipher.final()])
  const uploadRes = await currentFetch(uploadUrl, {
    method: 'POST',
    body: encBody,
    headers: { 'Content-Type': 'application/octet-stream' },
  })
  const uploadText = await uploadRes.text()
  let encryptQueryParam = uploadRes.headers.get('x-encrypted-param')
  if (!encryptQueryParam) {
    try {
      const j = JSON.parse(uploadText) as { encrypted_query_param?: string; ret?: number; errcode?: number; errmsg?: string }
      encryptQueryParam = j.encrypted_query_param ?? null
      if (!encryptQueryParam && ((j.ret !== undefined && j.ret !== 0) || (j.errcode !== undefined && j.errcode !== 0))) {
        throw new Error(`CDN 上传失败: ret=${j.ret} errcode=${j.errcode}${j.errmsg ? `: ${j.errmsg}` : ''}`)
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('CDN 上传失败')) throw err
      /* 非 JSON 且无响应头 → 按"缺 param"在下面统一报错 */
    }
  }
  if (!encryptQueryParam) {
    throw new Error(`CDN 上传响应缺 encrypt_query_param（HTTP ${uploadRes.status}）: ${uploadText.slice(0, 300)}`)
  }

  const sendRaw = await apiPost({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/sendmessage',
    body: JSON.stringify({
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: `dsp-weixin-${randomBytes(4).toString('hex')}`,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [
          {
            type: MessageItemType.FILE,
            file_item: {
              media: { encrypt_query_param: encryptQueryParam, aes_key: aesKeyB64, encrypt_type: 1 },
              file_name: fileName,
              md5: rawFileMd5,
              len: String(fileSize),
            },
          },
        ],
      },
    }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? 15_000,
  })
  assertIlinkOk('ilink/bot/sendmessage', sendRaw)
  return { fileName, size: fileSize }
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

// ── 媒体接收（CDN 下载 + AES-128-ECB 解密；v1.27.3 图片/文件）──
// 协议（对齐参考实现 downloadAndDecryptMedia + docs/weixin-bot-api.md §6）：
// 收消息 item_list 携带 image_item/file_item.media（CDNMedia）→ CDN GET
// （full_url 或 /download?encrypted_query_param=）→ AES-128-ECB 解密。
// 零鉴权头（encrypt_query_param 自带能力）；失败一律返回 null（不抛）。

/** 构造 CDN 下载 URL（full_url 优先；否则 encrypted_query_param 拼 download 端点；都无 → null） */
export function buildMediaDownloadUrl(media: CDNMedia): string | null {
  if (media.full_url) return media.full_url
  if (media.encrypt_query_param) {
    return `${ILINK_CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`
  }
  return null
}

/**
 * 解析媒体 AES key（兼容三种编码，对齐参考实现）：
 * ① 32+ hex 字符 → hex Buffer(16)  ② base64 解码 = 16 字节直接用
 * ③ base64 解码 = 32 字节 → ascii 是 hex 串 → 再 hex → Buffer(16)；其他 → null
 */
export function parseMediaAesKey(keyText?: string): Buffer | null {
  if (!keyText) return null
  if (/^[0-9a-fA-F]{32,}$/.test(keyText)) {
    const buf = Buffer.from(keyText, 'hex')
    return buf.length === 16 ? buf : null
  }
  try {
    const decoded = Buffer.from(keyText, 'base64')
    if (decoded.length === 16) return decoded
    if (decoded.length === 32) {
      const hexStr = decoded.toString('ascii')
      if (/^[0-9a-fA-F]{32}$/.test(hexStr)) return Buffer.from(hexStr, 'hex')
    }
  } catch {
    /* 无效 base64 */
  }
  return null
}

/** AES-128-ECB 解密（无 IV；node:crypto 内置） */
export function aes128EcbDecrypt(data: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(data), decipher.final()])
}

/** 图片 magic-byte 嗅探（vlm-describe 支持 jpg/png/gif/webp/bmp——比固定 .jpg 可靠） */
export function sniffImageExt(data: Buffer): 'jpg' | 'png' | 'gif' | 'webp' | 'bmp' | 'bin' {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg'
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'png'
  if (data.length >= 3 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return 'gif'
  if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp'
  if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d) return 'bmp'
  return 'bin'
}

/**
 * 下载 + 解密一条媒体（图片/文件）。失败/超时/无 URL → null（不抛——调用方降级）。
 * key 提取：item.aeskey || item.media.aes_key（对齐参考实现）。
 */
export async function downloadMedia(params: {
  item: WeixinMessageItem
  mediaType: 'image_item' | 'file_item'
  timeoutMs?: number
}): Promise<{ data: Buffer; fileName?: string } | null> {
  const mediaItem = params.item[params.mediaType]
  if (!mediaItem) return null
  const media = mediaItem.media
  const url = buildMediaDownloadUrl(media ?? {})
  if (!url) return null
  // aeskey 仅 image_item、file_name 仅 file_item——联合类型窄化（传输层定向读取）
  const itemKey = (mediaItem as { aeskey?: string }).aeskey
  const fileName = (mediaItem as { file_name?: string }).file_name
  const key = parseMediaAesKey(itemKey ?? media?.aes_key)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? 30_000)
  try {
    const res = await currentFetch(url, { signal: controller.signal })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (key) {
      try {
        return { data: aes128EcbDecrypt(buf, key), fileName }
      } catch {
        return null // 解密失败（key 错误/密文损坏）
      }
    }
    return { data: buf, fileName }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
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
