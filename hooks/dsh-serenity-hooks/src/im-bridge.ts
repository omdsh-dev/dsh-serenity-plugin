/**
 * im-bridge.ts — IM 发送能力层（v1.31.0，S142 用户洞察）
 *
 * 用户原话：「既然微信桥是我们 ACC 提供的，那么 weixin-send 应该是我们 ACC 提供的能力，
 * 当用户配置了微信桥则可用，不配置则不可见」＋「设定一个复杂的多层工具，叫 im-bridge，
 * 里面有微信，然后保留后续可能兼容别的 im 的空间」。
 *
 * 分层（E↑）：
 *   `tools/im-bridge.ts`（工具面：参数 → 结果渲染）
 *     → **本模块**（通道注册表 + 可见性判据 + 动作分发 + 错误码翻译）
 *       → 通道实现（`im-weixin.ts`：协议/凭据/账号/记录）
 *
 * 边界（R↓）：
 * - **本模块零宿主依赖**（不 import cordis/agent）——可见性判定与分发都是纯逻辑，可独立单测。
 * - **通道只提供机制**：本模块不认识"微信"；新增 IM 只需注册一个通道实现（R3 家族式扩展）。
 * - **只能操作本会话 CCC**（R4）：`root` 由调用方（工具面）从 agent cwd 解析后传入，
 *   本模块不接受"目标 CCC"参数——跨 CCC 发送不在能力面。
 * - **记录归通道**（R5）：通道实现负责让每次发送都落既有 hook。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve as resolvePath, relative, isAbsolute } from 'node:path'

/** 文本长度上限（微信侧单条实践上限；超限拒绝而非静默截断——与 HTTP 入口同值） */
export const IM_SEND_MAX_TEXT = 4000

/** 文件大小上限（20MB，与媒体接收上限一致） */
export const IM_FILE_MAX_BYTES = 20 * 1024 * 1024

/**
 * 通道内用户（别名 → 通道用户 id）。
 *
 * 用 **type 别名而非 interface**：interface 不获得隐式索引签名，无法赋给 `ImJson`
 * （工具返回值必须可 JSON 化 → 类型层就要挡住"不可序列化"的形状，而不是靠断言绕过）。
 */
export type ImUserEntry = {
  alias: string
  id: string
}

/** 文本发送输入（通道实现负责凭据解析与记录） */
export interface ImSendInput {
  root: string
  /** 通道内用户 id（别名已由本模块解析） */
  userId: string
  text: string
  accountId?: string
}

/** 文本发送结果（与既有主动发送返回一致，便于记录/诊断） */
export interface ImSendResult {
  accountId: string
  userId: string
  sessionId: string
  role: string
}

/** 文件发送输入（`data` 由本模块读盘并校验后传入——通道不碰 CCC 路径） */
export interface ImSendFileInput {
  root: string
  userId: string
  data: Buffer
  fileName: string
  caption?: string
  accountId?: string
}

/**
 * 一个 IM 通道（机制插槽）。
 * `isEnabled` 是**可见性判据**：该 CCC 是否配置了这个通道。
 */
export interface ImChannel {
  /** 通道 id（工具 `channel` 参数的取值，如 `weixin`） */
  id: string
  /** 该 CCC 是否启用了本通道（缺省实现：读该通道的 CCC 配置） */
  isEnabled(root: string): boolean
  /** 别名/裸 id → 通道用户；无法解析返回 null */
  resolveUser(root: string, input: string): ImUserEntry | null
  /** 已配置别名列表（`users` 动作） */
  listUsers(root: string): ImUserEntry[]
  /** 发文本 */
  send(input: ImSendInput): Promise<ImSendResult>
  /** 发文件（可选——未实现则工具返回 `ACTION_UNSUPPORTED`） */
  sendFile?(input: ImSendFileInput): Promise<{ fileName: string; size: number }>
  /** 通道健康快照（`status` 动作）——必须可 JSON 化（工具返回值契约） */
  status(root: string): ImJson
}

const channels = new Map<string, ImChannel>()

/** 注册通道（index.ts apply 调用；重复 id 覆盖——测试与热重载友好） */
export function registerImChannel(channel: ImChannel): void {
  channels.set(channel.id, channel)
}

/** 测试辅助：清空通道注册表 */
export function __resetImChannelsForTest(): void {
  channels.clear()
}

/** 已注册通道 id（工具 `channel` 参数枚举） */
export function imChannelIds(): string[] {
  return [...channels.keys()]
}

/**
 * 可见性判据：本 CCC 是否启用了**任一** IM 通道。
 * 未启用 → 工具面对该 agent **不可见**（`tools.restrict` 移除，而非调用时报错）。
 * @param root 本会话 CCC 根（由调用方解析）
 */
export function hasEnabledImChannel(root: string): boolean {
  for (const channel of channels.values()) {
    try {
      if (channel.isEnabled(root)) return true
    } catch {
      /* 单通道判据失败不影响其他通道（配置损坏由通道自身响亮处理） */
    }
  }
  return false
}

/** 结果载荷（lossless JSON——工具返回值必须可 JSON 化） */
export type ImJson = null | boolean | number | string | ImJson[] | { [key: string]: ImJson }

/** 分发结果（工具面直接渲染；错误码稳定，便于模型与日志消费） */
export type ImToolResult =
  | { ok: true; channel: string; action: string; detail: ImJson }
  | { ok: false; code: string; error: string; remediation?: string }

export interface ImToolRequest {
  channel?: string
  action?: string
  user?: string
  text?: string
  file?: string
  caption?: string
  account?: string
}

/** 错误码 → 可行动提示（模型视角：说清怎么改） */
function remediationFor(code: string): string | undefined {
  switch (code) {
    case 'CHANNEL_UNKNOWN': return 'Use a registered channel id (see the tool description)'
    case 'CHANNEL_NOT_CONFIGURED': return 'This CCC has not configured that channel — enable it in .opencode/serenity.json (weixin.enabled) or the settings panel'
    case 'ACTION_UNKNOWN': return 'Use send / send-file / users / status'
    case 'ACTION_UNSUPPORTED': return 'This channel does not support that action'
    case 'ALIAS_UNKNOWN': return 'Use a configured alias (see action=users) or a raw channel user id'
    case 'TEXT_REQUIRED': return 'Provide text'
    case 'TEXT_TOO_LONG': return `Shorten the text to <= ${IM_SEND_MAX_TEXT} characters`
    case 'USER_REQUIRED': return 'Provide user'
    case 'FILE_REQUIRED': return 'Provide file (a path inside this CCC)'
    case 'FILE_ESCAPE': return 'Use a path inside this CCC'
    case 'FILE_NOT_FOUND': return 'Check the path exists inside this CCC'
    case 'FILE_TOO_LARGE': return `Use a file <= ${Math.round(IM_FILE_MAX_BYTES / (1024 * 1024))} MB`
    default: return undefined
  }
}

function fail(code: string, error: string, remediation?: string): ImToolResult {
  return { ok: false, code, error, ...(remediation ?? remediationFor(code) ? { remediation: remediation ?? remediationFor(code)! } : {}) }
}

/** CCC 内文件读取（路径逃逸/缺失/超限一律拒绝，返回稳定码） */
function readCccFile(root: string, relOrAbs: string): { ok: true; data: Buffer; fileName: string } | { ok: false; code: string; error: string } {
  const abs = isAbsolute(relOrAbs) ? resolvePath(relOrAbs) : resolvePath(root, relOrAbs)
  const rel = relative(resolvePath(root), abs)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, code: 'FILE_ESCAPE', error: `file escapes the CCC root: ${relOrAbs}` }
  }
  if (!existsSync(abs)) return { ok: false, code: 'FILE_NOT_FOUND', error: `file not found: ${relOrAbs}` }
  let size = 0
  try {
    size = statSync(abs).size
  } catch (err) {
    return { ok: false, code: 'FILE_NOT_FOUND', error: `cannot stat file: ${relOrAbs} (${err instanceof Error ? err.message : String(err)})` }
  }
  if (size > IM_FILE_MAX_BYTES) {
    return { ok: false, code: 'FILE_TOO_LARGE', error: `file is ${size} bytes (> ${IM_FILE_MAX_BYTES})` }
  }
  try {
    return { ok: true, data: readFileSync(abs), fileName: abs.split('/').pop() ?? 'file' }
  } catch (err) {
    return { ok: false, code: 'FILE_NOT_FOUND', error: `cannot read file: ${relOrAbs} (${err instanceof Error ? err.message : String(err)})` }
  }
}

/**
 * 执行一次 IM 动作（工具面唯一入口）。
 *
 * 顺序：通道解析 → 动作校验 → 用户解析（别名 → id）→ 输入校验 → 调用通道实现。
 * 任何一步失败都返回**稳定错误码 + 可行动提示**（不抛错——工具面统一渲染）。
 *
 * @param root 本会话 CCC 根（调用方从 agent cwd 解析；本函数不接受目标 CCC）
 * @param req 工具参数
 */
export async function runImBridge(root: string, req: ImToolRequest): Promise<ImToolResult> {
  const channelId = (req.channel ?? '').trim()
  const action = (req.action ?? '').trim()
  if (channelId === '') return fail('CHANNEL_REQUIRED', 'channel is required', 'Provide channel (e.g. "weixin")')
  const channel = channels.get(channelId)
  if (!channel) {
    return fail('CHANNEL_UNKNOWN', `unknown channel "${channelId}" (registered: ${imChannelIds().join(', ') || '(none)'})`)
  }
  if (!channel.isEnabled(root)) {
    return fail('CHANNEL_NOT_CONFIGURED', `channel "${channelId}" is not configured for this CCC (${root})`)
  }
  if (action === 'users') {
    return { ok: true, channel: channelId, action, detail: { users: channel.listUsers(root) } }
  }
  if (action === 'status') {
    return { ok: true, channel: channelId, action, detail: channel.status(root) }
  }
  if (action === 'send') {
    const rawUser = (req.user ?? '').trim()
    if (rawUser === '') return fail('USER_REQUIRED', 'user is required')
    const text = req.text ?? ''
    if (text === '') return fail('TEXT_REQUIRED', 'text is required')
    if (text.length > IM_SEND_MAX_TEXT) return fail('TEXT_TOO_LONG', `text is ${text.length} characters (> ${IM_SEND_MAX_TEXT})`)
    const resolved = channel.resolveUser(root, rawUser)
    if (!resolved) return fail('ALIAS_UNKNOWN', `unknown user "${rawUser}"`)
    try {
      const sent = await channel.send({ root, userId: resolved.id, text, accountId: req.account })
      return { ok: true, channel: channelId, action, detail: { ...sent, user: resolved.alias ?? resolved.id } }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return fail('SEND_FAILED', message)
    }
  }
  if (action === 'send-file') {
    if (!channel.sendFile) return fail('ACTION_UNSUPPORTED', `channel "${channelId}" does not support send-file`)
    const rawUser = (req.user ?? '').trim()
    if (rawUser === '') return fail('USER_REQUIRED', 'user is required')
    const fileArg = (req.file ?? '').trim()
    if (fileArg === '') return fail('FILE_REQUIRED', 'file is required')
    const resolved = channel.resolveUser(root, rawUser)
    if (!resolved) return fail('ALIAS_UNKNOWN', `unknown user "${rawUser}"`)
    const file = readCccFile(root, fileArg)
    if (!file.ok) return fail(file.code, file.error)
    try {
      const sent = await channel.sendFile({
        root,
        userId: resolved.id,
        data: file.data,
        fileName: file.fileName,
        caption: req.caption,
        accountId: req.account,
      })
      return { ok: true, channel: channelId, action, detail: { ...sent, user: resolved.alias ?? resolved.id } }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return fail('SEND_FAILED', message)
    }
  }
  return fail('ACTION_UNKNOWN', `unknown action "${action}"`)
}
