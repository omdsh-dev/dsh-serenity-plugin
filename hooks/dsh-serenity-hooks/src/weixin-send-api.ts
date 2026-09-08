/**
 * weixin-send-api.ts — 主动发送入口（S142 v1.30.9，用户需求"微信桥支持被调用发消息给指定用户"）
 *
 * 形态（用户拍板 A2）：**独立监听器，只绑 127.0.0.1**（默认 3082，plugin 全局配置 weixinApi）。
 * 为什么不挂在主 webServer(3080) 上：3080 会被 3081 公网网关原样反代（含全部请求头），
 * 而 3081 的登录态属于"家庭账号"——一旦挂上去，任何已登录的外部用户都能冒充 bot 发消息。
 * 独立 loopback 监听器则**不经网关、公网不可达**，因此不做共享密钥；仍校验来源地址。
 *
 * 调用者 = CCC 自己的 MSM（`msm weixin-send ...`）：ACC **不新增工具**，只多一个本机 HTTP 面。
 * 发送与记录都经 `weixin-bridge.sendProactiveText` → 复用既有 outgoing hook（`source: 'proactive'`）。
 *
 * 契约：
 *   POST /send   { ccc: "<名称|绝对路径>", user: "<from_user_id>", text: "...", accountId?: "wechat-1" }
 *     → 200 { ok: true, accountId, userId, sessionId, role }
 *     → 4xx/5xx { ok: false, code, error, remediation? }
 *   GET  /health → 200 { ok: true, port }
 *
 * 职责切分（E↑）：**别名 → id 的解析归 CCC**（MSM 读该 CCC localstore 的 WEIXIN_USER_*）；
 * 本入口只接受 iLink 形式的 id。协议、账号选择、记录归桥。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Context } from 'cordis'
import { basename } from 'node:path'
import { findSerenityRoot, readCccName } from './ccc.js'
import { readAdvancedSettings } from './config-ops.js'
import { registerDisposer } from './host/effect.js'
import { sendProactiveText } from './weixin-bridge.js'
import { setWeixinSendEndpoint, weixinSendEndpoint } from './weixin-send-endpoint.js'

export { weixinSendEndpoint }

/** 请求体上限（文本消息远小于此；防滥用） */
const MAX_BODY_BYTES = 64 * 1024
/** 文本长度上限（微信侧单条消息实践上限；超限拒绝而非静默截断） */
export const WEIXIN_SEND_MAX_TEXT = 4000

/** 运行中的入口（null = 未启动） */
let active: { server: Server; port: number } | null = null

/** 当前入口地址（MSM 环境变量注入用；未启动 → null）——状态在叶模块（msm-ops 零依赖读取） */

/** 测试辅助：读取当前监听端口（生产零调用） */
export function weixinSendPort(): number | null {
  return active?.port ?? null
}

/** 来源必须是 loopback（127.0.0.1 / ::1 / IPv4-mapped） */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (typeof address !== 'string' || address === '') return false
  const a = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  return a === '127.0.0.1' || a === '::1'
}

export interface ParsedSendRequest {
  ok: true
  ccc: string
  user: string
  text: string
  accountId?: string
}

export type ParseResult = ParsedSendRequest | { ok: false; error: string; remediation?: string }

/**
 * 校验并归一 /send 请求体（纯函数，可测）。
 * 只做**结构**校验：ccc 必填（无隐式当前 CCC——用户拍板）、user 必须是 iLink id 形式、text 非空且不超限。
 */
export function parseSendRequest(body: unknown): ParseResult {
  if (body === null || typeof body !== 'object') {
    return { ok: false, error: 'body must be a JSON object' }
  }
  const o = body as Record<string, unknown>
  const ccc = typeof o.ccc === 'string' ? o.ccc.trim() : ''
  if (ccc === '') {
    return { ok: false, error: 'missing "ccc"', remediation: 'ccc = CCC 名称或绝对路径（必填，无默认值）' }
  }
  const user = typeof o.user === 'string' ? o.user.trim() : ''
  if (user === '') {
    return { ok: false, error: 'missing "user"', remediation: 'user = iLink from_user_id（形如 xxx@im.wechat）；别名解析归调用方' }
  }
  if (!user.includes('@')) {
    return { ok: false, error: `invalid "user": ${user}`, remediation: '需为 iLink from_user_id（含 @）；别名（yh/danica）请在调用方解析' }
  }
  const text = typeof o.text === 'string' ? o.text.trim() : ''
  if (text === '') {
    return { ok: false, error: 'missing "text"', remediation: 'text = 要发送的文本（非空）' }
  }
  if (text.length > WEIXIN_SEND_MAX_TEXT) {
    return { ok: false, error: `text too long: ${text.length} > ${WEIXIN_SEND_MAX_TEXT}` }
  }
  const accountId = typeof o.accountId === 'string' && o.accountId.trim() !== '' ? o.accountId.trim() : undefined
  return { ok: true, ccc, user, text, ...(accountId ? { accountId } : {}) }
}

/** CCC 候选（名称/路径解析用） */
export interface CccCandidate {
  root: string
  /** basename（工作目录名） */
  dirName: string
  /** `.serenity` 首行声明的 CCC 名（可能为 null） */
  cccName: string | null
}

/**
 * 按名称/路径解析 CCC 根（纯函数，可测）。
 * 匹配顺序：① 绝对路径精确/上溯 ② 目录名 ③ `.serenity` 首行名（大小写不敏感）。
 * 歧义（多个同名）→ 报错并列出候选（不猜——用户拍板"ccc 必须指定"）。
 */
export function matchCcc(input: string, candidates: CccCandidate[]): { ok: true; root: string } | { ok: false; error: string; remediation?: string } {
  const trimmed = input.trim()
  if (trimmed === '') return { ok: false, error: 'empty ccc' }
  if (trimmed.startsWith('/')) {
    const root = findSerenityRoot(trimmed)
    if (!root) return { ok: false, error: `no CCC found from path: ${trimmed}`, remediation: '确认该路径在某个 CCC 内（含 .serenity 标记）' }
    return { ok: true, root }
  }
  const lower = trimmed.toLowerCase()
  const exactPath = candidates.find((c) => c.root.toLowerCase() === lower)
  if (exactPath) return { ok: true, root: exactPath.root }
  const byName = candidates.filter((c) =>
    c.dirName.toLowerCase() === lower || (c.cccName !== null && c.cccName.toLowerCase() === lower))
  if (byName.length === 1) return { ok: true, root: byName[0]!.root }
  if (byName.length > 1) {
    return {
      ok: false,
      error: `ambiguous ccc name: ${trimmed}`,
      remediation: `同名多个，请用绝对路径：${byName.map((c) => c.root).join(' | ')}`,
    }
  }
  return {
    ok: false,
    error: `unknown ccc: ${trimmed}`,
    remediation: candidates.length === 0
      ? '当前进程未发现任何 CCC（打开一个 CCC 会话后重试）'
      : `已知 CCC: ${candidates.map((c) => c.dirName).join(', ')}`,
  }
}

/** 组装候选列表（discoverCccs 投影 + `.serenity` 名；动态 import 保持本模块静态依赖轻量） */
async function collectCandidates(ctx: Context): Promise<CccCandidate[]> {
  const { discoverCccs } = await import('./skiff-debug.js')
  const entries = await discoverCccs(ctx, process.cwd())
  const seen = new Set<string>()
  const out: CccCandidate[] = []
  for (const e of entries) {
    if (!e?.root || seen.has(e.root)) continue
    seen.add(e.root)
    out.push({ root: e.root, dirName: e.name || basename(e.root), cccName: readCccName(e.root) })
  }
  return out
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    total += buf.length
    if (total > MAX_BODY_BYTES) throw new Error(`body too large (> ${MAX_BODY_BYTES} bytes)`)
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf-8')
}

/** HTTP 状态映射（失败 code → 语义化状态；调用方按 code 判定，不看文案） */
function statusForCode(code: string): number {
  switch (code) {
    case 'ACCOUNT_NOT_BOUND':
    case 'BRIDGE_DISABLED':
    case 'NO_ACCOUNT':
      return 409
    case 'ACCOUNT_NOT_FOUND':
      return 400
    case 'SEND_FAILED':
      return 502
    default:
      return 400
  }
}

/** 单请求处理（导出供测试直接驱动，不经真实端口） */
export async function handleWeixinSendRequest(
  ctx: Context,
  req: { method?: string; url?: string; socket?: { remoteAddress?: string }; [Symbol.asyncIterator]?: unknown },
  res: ServerResponse,
): Promise<void> {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) {
    sendJson(res, 403, { ok: false, code: 'FORBIDDEN', error: 'only loopback clients allowed' })
    return
  }
  const path = (req.url ?? '/').split('?')[0]
  if (req.method === 'GET' && path === '/health') {
    sendJson(res, 200, { ok: true, port: weixinSendPort() })
    return
  }
  if (path !== '/send') {
    sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: `unknown path: ${path}` })
    return
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: 'use POST /send' })
    return
  }
  let raw: string
  try {
    raw = await readBody(req as IncomingMessage)
  } catch (err) {
    sendJson(res, 413, { ok: false, code: 'BODY_TOO_LARGE', error: String((err as Error)?.message ?? err) })
    return
  }
  let body: unknown
  try {
    body = JSON.parse(raw === '' ? '{}' : raw)
  } catch (err) {
    sendJson(res, 400, { ok: false, code: 'BAD_JSON', error: `invalid JSON: ${String((err as Error)?.message ?? err)}` })
    return
  }
  const parsed = parseSendRequest(body)
  if (!parsed.ok) {
    sendJson(res, 400, { ok: false, code: 'BAD_REQUEST', error: parsed.error, remediation: parsed.remediation })
    return
  }
  let root: string
  try {
    const matched = matchCcc(parsed.ccc, await collectCandidates(ctx))
    if (!matched.ok) {
      sendJson(res, 404, { ok: false, code: 'UNKNOWN_CCC', error: matched.error, remediation: matched.remediation })
      return
    }
    root = matched.root
  } catch (err) {
    sendJson(res, 500, { ok: false, code: 'CCC_DISCOVERY_FAILED', error: String((err as Error)?.message ?? err) })
    return
  }
  const result = await sendProactiveText({
    root,
    toUserId: parsed.user,
    text: parsed.text,
    ...(parsed.accountId ? { accountId: parsed.accountId } : {}),
  })
  if (result.ok) {
    sendJson(res, 200, { ok: true, accountId: result.accountId, userId: result.userId, sessionId: result.sessionId, role: result.role })
    return
  }
  sendJson(res, statusForCode(result.code), { ok: false, code: result.code, error: result.error, remediation: result.remediation })
}

/** 启动监听器（仅 127.0.0.1）；已启动 → 幂等返回 */
export async function startWeixinSendApi(ctx: Context, port: number): Promise<number> {
  if (active) return active.port
  const server = createServer((req, res) => {
    void handleWeixinSendRequest(ctx, req, res).catch((err) => {
      // 单请求异常不得杀进程（gateway ECONNRESET 同类教训）：记录并回 500
      console.warn(`[serenity-hooks] ✗ weixin send api 处理失败: ${String((err as Error)?.message ?? err)}`)
      try {
        sendJson(res, 500, { ok: false, code: 'INTERNAL', error: 'internal error' })
      } catch {
        /* 响应已发出/连接已断 */
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  server.unref()
  const addr = server.address()
  const actualPort = typeof addr === 'object' && addr !== null ? addr.port : port
  active = { server, port: actualPort }
  setWeixinSendEndpoint(`http://127.0.0.1:${actualPort}`)
  console.log(`[serenity-hooks] ✓ 微信主动发送入口: http://127.0.0.1:${actualPort}/send（仅 loopback；CCC MSM 调用）`)
  return actualPort
}

/** 停止监听器（幂等） */
export function stopWeixinSendApi(): void {
  if (!active) return
  try {
    active.server.close()
  } catch {
    /* 已关闭 */
  }
  active = null
  setWeixinSendEndpoint(null)
}

/**
 * 装配（index.ts apply 调用）：按 plugin 全局配置 weixinApi 启停，配置变化热同步。
 * 默认启用（仅 loopback，零公网暴露）；`enabled:false` 或 `port:0` 关闭。
 */
export function registerWeixinSendApi(ctx: Context): void {
  const sync = (): void => {
    let cfg: { enabled: boolean; port: number }
    try {
      cfg = readAdvancedSettings().weixinApi
    } catch (err) {
      console.warn(`[serenity-hooks] ✗ weixin send api 配置读取失败，跳过同步: ${String((err as Error)?.message ?? err)}`)
      return
    }
    const want = cfg.enabled && cfg.port > 0
    if (want && !active) {
      void startWeixinSendApi(ctx, cfg.port).catch((err) => {
        console.warn(`[serenity-hooks] ✗ 微信主动发送入口启动失败（port=${cfg.port}）: ${String((err as Error)?.message ?? err)}`)
      })
      return
    }
    if (!want && active) stopWeixinSendApi()
  }
  try {
    ctx.on('serenity/config-updated', sync)
  } catch {
    /* 事件通道缺失不阻断（启动时 sync 仍执行） */
  }
  try {
    ctx.on('serenity/settings-changed', sync)
  } catch {
    /* 同上 */
  }
  sync()
  registerDisposer(ctx, 'weixin send api', () => stopWeixinSendApi())
}
