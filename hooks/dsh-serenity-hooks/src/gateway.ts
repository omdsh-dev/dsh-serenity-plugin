/**
 * gateway.ts — F1 双端口网关（v1.21）+ 安全加固（v1.22.4）
 *
 * 需求（S142 用户拍板）：dsh web 维持 127.0.0.1 主端口现状不变，**额外监听一个端口**；
 * 额外端口需网页登录（账号+密码），登录后即原生 Web UI 使用；适应任何部署情况。
 *
 * 实现（零改 DSH）：
 *   - 插件自起第二 node:http server（host/port 走 localstore 配置，默认 0.0.0.0:3081）
 *   - 未登录 → 返回内嵌极简登录页（user + pass + submit）
 *   - POST /serenity/login → 验证账号（localstore accounts，scrypt hash）→ Set-Cookie（HttpOnly）
 *   - 已登录 → 反向代理到 http://127.0.0.1:${ctx.webServer.port}
 *     （Host 头改写成 127.0.0.1:<主端口> → 过信任栅栏；WS upgrade 转发握手 + pipe socket）
 *   - token 内存表 + HttpOnly cookie（重启即失效——用户决策"重启重新登录"）
 *
 * v1.22.4 安全加固（S142 公网审计，用户原则：不体验影响直接修/体验影响改方案/不限制 IP）：
 *   - S5：token 带过期时间（滑动 24h）+ POST /serenity/logout 主动吊销
 *   - S3：登录 POST 与配置写操作校验 Origin（同源/loopback 主端口）+ 双提交 CSRF cookie
 *   - S2：账号维度失败锁定（5 次失败 → 15 分钟，指数退避）——不按 IP（用户要求随时随地访问）
 *   - S1：可选 TOTP 第二因素（账号绑定后登录需 6 位码；Authenticator 兼容，RFC 6238）
 *   - S7：cookieSecure 配置项（反代 TLS 时开启；默认关保持明文 HTTP 可用）
 *   - S9：登录失败审计日志（时间/IP/账号/原因，console.warn）
 *
 * 纯逻辑（可单测）：verifyGatewayLogin / issueToken / validateToken / 登录页 HTML /
 * TOTP 校验 / 失败锁定状态机 / Origin 校验。
 */

import type { Context } from 'cordis'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { verifyPassword, readAdvancedSettings, migrateLegacyLocalstore } from './config-ops.js'
import { findSerenityRoot } from './ccc.js'
import { readSimpleSettings } from './settings-section.js'
import { verifyTotpCode } from './totp.js'

// 自定义事件：配置 PUT 后触发 gateway 重建（跨模块松耦合通知）
declare module 'cordis' {
  interface Events {
    /** /serenity/config PUT（账号/监听/白名单变化）→ 强制重建 gateway（lastSig=null） */
    'serenity/config-updated'(): void
    /** DSH settings 简单配置变化（开关/阈值）→ 重新 sync（sig 判断，无实质变化不重建） */
    'serenity/settings-changed'(): void
  }
}

// ── 外部访问增强（v1.22）──

/**
 * crypto.randomUUID polyfill（浏览器 Web Crypto 仅安全上下文可用；
 * 经第二端口 http://LAN-IP:3081 访问 = 非安全上下文 → DSH client 的
 * `crypto.randomUUID()`（ui-conversation/service.ts 等）抛错，provider 目录加载失败）。
 * 用 `crypto.getRandomValues` 实现（与 DSH 官方 random-uuid.ts 同算法），
 * 零改 DSH——gateway 反代 HTML 时注入。
 */
export const RANDOM_UUID_POLYFILL = `<script>
(function () {
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID === 'function') return
  try {
    crypto.randomUUID = function () {
      var bytes = crypto.getRandomValues(new Uint8Array(16))
      bytes[6] = (bytes[6] & 0x0f) | 0x40
      bytes[8] = (bytes[8] & 0x3f) | 0x80
      var hex = Array.from(bytes, function (b) { return b.toString(16).padStart(2, '0') }).join('')
      return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20)
    }
  } catch (e) { /* getRandomValues 也不可用则放弃 */ }
})()
</script>`

/** 注入标记（幂等：已注入的 HTML 不重复注入） */
const POLYFILL_MARKER = 'data-sp-randomuuid-polyfill'

/**
 * workspace.list 响应过滤（v1.22 白名单）：
 * DSH client→server RPC 全部走 HTTP JSON（`POST /api/workspace.list`，WS 仅下行推送）。
 * 白名单（workspaces 路径前缀）非空 → 只保留匹配前缀的 items；
 * 空 = 全部允许（默认，向后兼容）。
 */
export function filterWorkspaceList(
  body: string,
  allowPrefixes: readonly string[],
): string {
  if (allowPrefixes.length === 0) return body
  try {
    const parsed = JSON.parse(body) as {
      result?: { ok?: boolean; value?: { items?: Array<{ path?: string }> } }
    }
    const value = parsed?.result?.value
    if (parsed?.result?.ok !== true || !value || !Array.isArray(value.items)) return body
    const keep = (path: string | undefined): boolean =>
      typeof path === 'string' && allowPrefixes.some((p) => path.startsWith(p))
    value.items = value.items.filter((item) => keep(item.path))
    return JSON.stringify(parsed)
  } catch {
    return body // 非 JSON / 解析失败 → 原样透传
  }
}

/**
 * 校验 workspace.create 请求路径是否在白名单内（v1.22）：
 * 白名单非空且路径不匹配 → 拒绝（由调用方构造 403 RPC 响应）。
 */
export function workspaceAllowed(
  allowPrefixes: readonly string[],
  path: string | undefined,
): boolean {
  if (allowPrefixes.length === 0) return true
  return typeof path === 'string' && allowPrefixes.some((p) => path.startsWith(p))
}

/** 构造 workspace.create 拒绝的 JSON RPC 响应体（code=forbidden） */
export function workspaceDenyResponse(rpcId: string): string {
  return JSON.stringify({
    type: 'server-response',
    rpcId,
    result: { ok: false, error: { code: 'forbidden', message: 'workspace not in external allowlist', details: {} } },
  })
}

// ── 纯逻辑（可单测）──

/**
 * 登录页（v1.22.1 移动端适配 + v1.22.4 CSRF/TOTP）：内嵌 HTML 无外部资源——适配任何部署。
 * 移动端关键点：
 *  - viewport meta（防止移动浏览器按 980px 视口缩放）
 *  - 触控目标 ≥ 44px（Apple HIG）；输入字号 ≥ 16px（iOS 聚焦不自动放大）
 *  - env(safe-area-inset-*) 适配刘海屏/底部手势条
 *  - color-scheme: dark + 明暗自适应
 * @param extra - 错误提示文案
 * @param csrf - CSRF token（隐藏字段随表单双提交；无 = 旧调用方兼容）
 */
export function loginPageHtml(extra: string, csrf?: string): string {
  const csrfField = csrf ? `<input type="hidden" name="csrf" value="${csrf}">` : ''
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#111114">
<meta name="referrer" content="no-referrer">
<title>Serenity 登录</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
html,body{height:100%}
body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;display:flex;align-items:center;justify-content:center;margin:0;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);background:#111114;color:#eee}
.card{background:#1c1c20;padding:32px 28px;border-radius:16px;width:min(340px,calc(100vw - 48px));box-shadow:0 12px 40px rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.06)}
h1{font-size:20px;margin:0 0 4px;text-align:center;letter-spacing:.02em}
.sub{font-size:13px;color:#999;text-align:center;margin:0 0 24px}
label{display:block;font-size:13px;color:#bbb;margin:14px 0 6px}
input{width:100%;padding:14px 14px;margin:0;border:1px solid #3a3a40;border-radius:10px;background:#141418;color:#eee;font-size:16px;-webkit-appearance:none;appearance:none}
input:focus{outline:none;border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.25)}
input::placeholder{color:#666}
#f-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.35em;text-align:center;font-weight:600}
button{width:100%;padding:15px 14px;margin-top:24px;border:0;border-radius:10px;background:#3b82f6;color:#fff;font-size:16px;font-weight:600;cursor:pointer;min-height:50px;-webkit-appearance:none;appearance:none}
button:active{background:#2563eb}
.error{color:#f87171;font-size:13px;min-height:18px;margin-top:12px;text-align:center}
.hint{color:#777;font-size:12px;margin-top:10px;text-align:center}
.foot{margin-top:20px;text-align:center;font-size:12px;color:#666}
@media (prefers-color-scheme:light){
  body{background:#f4f4f6;color:#1a1a1e}
  .card{background:#fff;border-color:rgba(0,0,0,.08);box-shadow:0 12px 40px rgba(0,0,0,.12)}
  .sub{color:#666}
  label{color:#444}
  input{background:#fafafa;border-color:#d0d0d6;color:#1a1a1e}
  input::placeholder{color:#aaa}
  .hint{color:#999}
  .foot{color:#999}
}
</style></head><body><div class="card">
<h1>🔐 Serenity Web UI</h1>
<p class="sub">宁静号 · 外部访问</p>
<form method="post" action="/serenity/login">
${csrfField}
<label for="f-user">用户名</label>
<input id="f-user" type="text" name="user" placeholder="用户名" autocomplete="username" autocapitalize="none" autocorrect="off" required autofocus enterkeyhint="next">
<label for="f-pass">密码</label>
<input id="f-pass" type="password" name="password" placeholder="密码" autocomplete="current-password" required enterkeyhint="next">
<label for="f-code">验证码（已绑定 Authenticator 时填写）</label>
<input id="f-code" type="text" name="code" placeholder="6 位验证码" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" enterkeyhint="go">
<button type="submit">登录</button>
<div class="error">${extra}</div>
<p class="hint">未绑定验证器的账号只需用户名 + 密码</p>
</form>
<p class="foot">Serenity ACC · dsh-serenity-hooks</p>
</div></body></html>`
}

// ── 账号验证（纯逻辑）：user + password 对 localstore accounts 匹配（scrypt）──
export function verifyGatewayLogin(
  accounts: readonly { user: string; passHash: string }[],
  user: string,
  password: string,
): boolean {
  const account = accounts.find((a) => a.user === user)
  if (!account) return false
  return verifyPassword(password, account.passHash)
}

// ── v1.22.4 会话（token + TTL + 主动登出）──

/** 会话滑动过期时长（毫秒）：24h 无活动 → 失效（用户重新登录） */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000

interface GatewaySession {
  token: string
  /** 最后活动时间（滑动续期：每次校验通过刷新） */
  lastActiveAt: number
  /** 绑定账号（审计/登出定位） */
  user: string
}

/** 内存会话表（重启即清空——用户决策） */
const sessions = new Map<string, GatewaySession>()

/** 颁发会话 token（Hex 32 字节） */
export function issueToken(user: string): string {
  const token = randomBytes(32).toString('hex')
  sessions.set(token, { token, lastActiveAt: Date.now(), user })
  return token
}

/** 主动吊销会话（登出）；返回是否确实存在 */
export function revokeToken(token: string): boolean {
  return sessions.delete(token)
}

/**
 * 校验 token 有效性（滑动过期：有效则刷新 lastActiveAt）。
 * @returns 有效会话或 undefined
 */
export function validateToken(token: string | undefined): GatewaySession | undefined {
  if (typeof token !== 'string' || token === '') return undefined
  const session = sessions.get(token)
  if (session === undefined) return undefined
  if (Date.now() - session.lastActiveAt > SESSION_TTL_MS) {
    sessions.delete(token)
    return undefined
  }
  session.lastActiveAt = Date.now() // 滑动续期
  return session
}

// ── v1.22.4 失败锁定（账号维度；不按 IP——用户要求随时随地访问）──

/** 失败锁定阈值：连续失败 N 次进入锁定 */
export const FAIL_LOCK_THRESHOLD = 5
/** 首次锁定时长（毫秒） */
export const FAIL_LOCK_BASE_MS = 15 * 60 * 1000
/** 锁定时长指数退避上限 */
export const FAIL_LOCK_MAX_MS = 4 * 60 * 60 * 1000

interface FailState {
  /** 连续失败计数（成功登录后清零） */
  count: number
  /** 当前锁定截止时间（0 = 未锁定） */
  lockedUntil: number
  /** 已连续锁定次数（退避指数） */
  lockRound: number
}

/** 账号 → 失败状态（内存；重启清零——攻击者重启服务可绕过，但公网常驻服务下有效） */
const failStates = new Map<string, FailState>()

/** 获取账号失败状态（纯逻辑，供测试注入） */
export function getFailState(user: string): FailState {
  let st = failStates.get(user)
  if (!st) {
    st = { count: 0, lockedUntil: 0, lockRound: 0 }
    failStates.set(user, st)
  }
  return st
}

/** 重置失败状态（登录成功/管理员解封） */
export function resetFailState(user: string): void {
  failStates.delete(user)
}

/** 账号当前是否锁定（含锁定到期自动解锁——到期后读取即解锁） */
export function isAccountLocked(user: string): boolean {
  const st = getFailState(user)
  if (st.lockedUntil === 0) return false
  if (Date.now() >= st.lockedUntil) {
    st.lockedUntil = 0
    st.count = 0
    return false
  }
  return true
}

/** 记录一次失败；达到阈值 → 锁定（指数退避）。返回锁定剩余毫秒（0 = 未锁定） */
export function recordLoginFailure(user: string): number {
  const st = getFailState(user)
  if (st.lockedUntil > 0 && Date.now() < st.lockedUntil) return st.lockedUntil - Date.now()
  st.count += 1
  if (st.count >= FAIL_LOCK_THRESHOLD) {
    const base = FAIL_LOCK_BASE_MS * (2 ** st.lockRound)
    st.lockedUntil = Date.now() + Math.min(base, FAIL_LOCK_MAX_MS)
    st.lockRound += 1
    st.count = 0
    return st.lockedUntil - Date.now()
  }
  return 0
}

/** 剩余锁定毫秒（0 = 未锁定） */
export function accountLockRemaining(user: string): number {
  const st = getFailState(user)
  return st.lockedUntil > 0 && Date.now() < st.lockedUntil ? st.lockedUntil - Date.now() : 0
}

// ── v1.22.4 CSRF（双提交 cookie + Origin 校验）──

/** 生成 CSRF cookie 值（随机 32B hex） */
export function newCsrfToken(): string {
  return randomBytes(32).toString('hex')
}

/** 从请求头取 CSRF token（X-CSRF-Token 或表单字段） */
export function csrfFromRequest(req: IncomingMessage, body: URLSearchParams): string | null {
  const header = req.headers['x-csrf-token']
  if (typeof header === 'string' && header !== '') return header
  const form = body.get('csrf')
  return form && form !== '' ? form : null
}

/** 常量时间比较（token 校验用） */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/**
 * Origin 校验（S3）：跨站 POST 被浏览器强制带 Origin（同源 GET/导航除外）。
 * 允许：① 同源（Origin.host === 网关自身 host）② 主端口 loopback（127.0.0.1:mainPort）。
 * 无 Origin（curl/非浏览器直连）→ 仅当携带有效 CSRF 双提交时放行（脚本无 cookie 无法伪造）。
 * @returns 是否通过
 */
export function originAllowed(
  originHeader: string | undefined,
  reqHost: string,
  mainPort: number,
): boolean {
  if (originHeader === undefined || originHeader === 'null') return true // 非浏览器/隐私模式降级由 CSRF 兜底
  try {
    const originHost = new URL(originHeader).host
    return originHost === reqHost || originHost === `127.0.0.1:${mainPort}` || originHost === `localhost:${mainPort}`
  } catch {
    return false
  }
}

/** 从 Cookie 头解析指定 cookie 值（纯逻辑，可单测） */
export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    const key = part.slice(0, idx).trim()
    if (key === name) return part.slice(idx + 1).trim()
  }
  return undefined
}

// ── 服务注册 ──

export interface GatewayConfig {
  host: string
  port: number
  /** 登录态 cookie 名 */
  cookieName: string
  /** 主端口（ctx.webServer.port） */
  mainPort: number
  /** 登录失败后的重定向延迟（秒） */
  loginDelayMs: number
  /** 外部可访问的工作区路径前缀白名单（v1.22；空 = 全部允许） */
  allowWorkspaces?: string[]
  /** Cookie Secure 属性（v1.22.4；反代 TLS 时开启；明文 HTTP 下必须关，否则 cookie 不落） */
  cookieSecure?: boolean
  /** 允许外部新建工作区（v1.22.4；false = workspace.create 一律 403 RPC error） */
  allowWorkspaceCreate?: boolean
  /** 启用 Authenticator 第二因素（v1.22.4；false = TOTP 完全禁用） */
  totpEnabled?: boolean
}

/** 读取请求体（≤ maxBytes；超限 reject） */
function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf-8')
      if (data.length > maxBytes) {
        reject(new Error('body too large'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

/** 在 HTML 的 </head> 前注入 polyfill（幂等：含 marker 则跳过） */
export function injectPolyfillHtml(html: string): string {
  if (html.includes(POLYFILL_MARKER)) return html
  const head = RANDOM_UUID_POLYFILL.replace('<script>', `<script ${POLYFILL_MARKER}="1">`)
  if (html.includes('</head>')) return html.replace('</head>', `${head}\n</head>`)
  return `${head}\n${html}` // 无 head → 前置
}

/**
 * 反代请求头构造（v1.22.1 信任栅栏修复，纯逻辑可测）：
 * DSH isTrustedApiRequest 要求 Origin.host === Host.host——Host 改写为 loopback 后
 * Origin 必须同步改写（浏览器 POST 必带 Origin，透传外部地址 → 403）。
 */
export function buildProxyHeaders(
  reqHeaders: Record<string, string | string[] | undefined>,
  mainPort: number,
  bodyOverride?: string,
): Record<string, string | number | string[]> {
  const headers: Record<string, string | number | string[]> = {
    ...reqHeaders as Record<string, string | string[]>,
    host: `127.0.0.1:${mainPort}`,
    origin: `http://127.0.0.1:${mainPort}`,
  }
  if (bodyOverride !== undefined) headers['content-length'] = Buffer.byteLength(bodyOverride)
  return headers
}

/**
 * 启动第二监听器。返回 { server, dispose }——dispose 关 server + 清 token。
 * @param config - 监听/代理配置。
 * @param getAccounts - 运行时读取账号列表（plugin 全局文件；gateway.enabled 开关在调用方判）。
 */
export function startGateway(
  config: GatewayConfig,
  getAccounts: () => readonly { id: string; user: string; passHash: string; totpSecret?: string }[],
): { server: Server; dispose: () => void } {
  const { host, port, cookieName, mainPort, loginDelayMs } = config
  const allowWorkspaces = config.allowWorkspaces ?? []
  const cookieSecure = config.cookieSecure === true
  const allowWorkspaceCreate = config.allowWorkspaceCreate !== false
  const totpEnabled = config.totpEnabled === true

  /** 校验请求 Cookie 是否含有效 token（v1.22.4：滑动过期 + 返回会话供审计） */
  const authed = (req: IncomingMessage): GatewaySession | undefined =>
    validateToken(cookieValue(req.headers.cookie, cookieName))

  /**
   * 反向代理：改写 Host + Origin 头 → 主端口（loopback 过信任栅栏）。
   * v1.22.1 修复：DSH 信任栅栏（api-request-trust.ts isTrustedApiRequest）要求
   * **Origin.host === Host.host**——仅改写 Host（127.0.0.1:3080）而 Origin 透传
   * （http://192.168.x.x:3081）→ 不一致 → 所有 /api RPC 403（host.pickDirectory 首个暴露）。
   * 增强：
   *  - HTML 响应 → 注入 crypto.randomUUID polyfill（非安全上下文修复）
   *  - /api/workspace.list 响应 → 白名单过滤 items
   * @param bodyOverride - workspace.create 已读 body 时的重放（白名单检查后转发）
   */
  const proxy = (req: IncomingMessage, res: ServerResponse, bodyOverride?: string): void => {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`)
    const method = req.method === 'POST' && url.pathname.startsWith('/api/')
      ? url.pathname.slice('/api/'.length)
      : null
    const loopbackOrigin = `http://127.0.0.1:${mainPort}`
    const headers = buildProxyHeaders(req.headers as Record<string, string | string[] | undefined>, mainPort, bodyOverride)
    // v1.22.3 崩溃修复（S142 实测：外部连接中断 → Unhandled 'error' event → 进程崩溃）：
    // 反代链路的**客户端侧** req/res 必须挂 error 监听。外部客户端（浏览器/手机）随时会
    // 中断连接（切网络/关页面/锁屏/超时）→ socket 收到 ECONNRESET/EPIPE → 若无人监听
    // 'error' 事件，Node 直接 throw → 整个 dsh web 进程崩溃。代理语义下这些错误是
    // 正常现象：吞掉并销毁对端即可（与上游 target.on('error') 同款处理）。
    const target = httpRequest({
      host: '127.0.0.1',
      port: mainPort,
      path: req.url ?? '/',
      method: req.method,
      headers,
    }, (upstream) => {
      const status = upstream.statusCode ?? 502
      const ct = String(upstream.headers['content-type'] ?? '')

      // HTML → polyfill 注入（幂等）
      if (status === 200 && ct.includes('text/html')) {
        const chunks: Buffer[] = []
        upstream.on('data', (c: Buffer) => chunks.push(c))
        upstream.on('end', () => {
          const transformed = injectPolyfillHtml(Buffer.concat(chunks).toString('utf-8'))
          const out = { ...upstream.headers, 'content-length': Buffer.byteLength(transformed) }
          res.writeHead(status, out)
          res.end(transformed)
        })
        upstream.on('error', () => { try { res.destroy() } catch { /* noop */ } })
        return
      }

      // workspace.list → 白名单过滤（JSON RPC 响应）
      if (method === 'workspace.list' && status === 200 && ct.includes('application/json')) {
        const chunks: Buffer[] = []
        upstream.on('data', (c: Buffer) => chunks.push(c))
        upstream.on('end', () => {
          const transformed = filterWorkspaceList(Buffer.concat(chunks).toString('utf-8'), allowWorkspaces)
          const out = { ...upstream.headers, 'content-length': Buffer.byteLength(transformed) }
          res.writeHead(status, out)
          res.end(transformed)
        })
        upstream.on('error', () => { try { res.destroy() } catch { /* noop */ } })
        return
      }

      // 其余 → 原样透传
      res.writeHead(status, upstream.headers)
      upstream.pipe(res)
      // 透传路径的 upstream error（对端中断）→ 静默销毁，不成为 unhandled 'error'
      upstream.on('error', () => { try { res.destroy() } catch { /* noop */ } })
    })
    target.on('error', () => {
      try {
        res.writeHead(502, { 'content-type': 'text/plain' })
        res.end('502 Bad Gateway: dsh web 主端口不可达')
      } catch { /* res 已关闭 */ }
    })
    // 客户端侧 req/res error（外部连接中断）→ 静默销毁对端（代理场景正常现象）
    req.on('error', () => { try { target.destroy() } catch { /* noop */ } })
    res.on('error', () => { try { target.destroy() } catch { /* noop */ } })
    if (bodyOverride !== undefined) target.end(bodyOverride)
    else req.pipe(target)
  }

  // v1.22.4 S1b：账号 id → 最近成功 TOTP counter（防重放；模块级，重启清空）
  const lastTotpCounter = new Map<string, number>()

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`)

    // ── 登出（v1.22.4 S5）：主动吊销会话 → 清除 cookie → 回登录页 ──
    if (req.method === 'POST' && url.pathname === '/serenity/logout') {
      const cookie = cookieValue(req.headers.cookie, cookieName)
      if (cookie !== undefined) revokeToken(cookie)
      res.writeHead(302, {
        location: '/',
        'set-cookie': `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${cookieSecure ? '; Secure' : ''}`,
      })
      res.end()
      return
    }

    // 已登录 → 全量反代（含 /serenity/* 配置接口——第二端口登录后同样可管理）
    const session = authed(req)
    if (session !== undefined) {
      // workspace.create：① 外部新建开关（allowWorkspaceCreate=false → 一律拒绝）
      // ② 白名单校验（读 body → 检查路径 → 转发或拒绝）
      if (req.method === 'POST' && url.pathname === '/api/workspace.create') {
        if (!allowWorkspaceCreate) {
          void readBody(req, 128 * 1024).then((body) => {
            let rpcId = 'unknown'
            try {
              const parsed = JSON.parse(body) as { rpcId?: unknown }
              if (typeof parsed.rpcId === 'string') rpcId = parsed.rpcId
            } catch { /* 解析失败 → 用 unknown */ }
            res.writeHead(403, { 'content-type': 'application/json' })
            res.end(JSON.stringify({
              type: 'server-response',
              rpcId,
              result: { ok: false, error: { code: 'forbidden', message: 'workspace creation disabled for external access', details: {} } },
            }))
          }).catch(() => {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ type: 'server-response', rpcId: 'unknown', result: { ok: false, error: { code: 'bad-request', message: 'body too large', details: {} } } }))
          })
          return
        }
        void readBody(req, 128 * 1024).then((body) => {
          let rpcId = 'unknown'
          let path: string | undefined
          try {
            const parsed = JSON.parse(body) as { rpcId?: unknown; payload?: { path?: unknown } }
            if (typeof parsed.rpcId === 'string') rpcId = parsed.rpcId
            if (typeof parsed.payload?.path === 'string') path = parsed.payload.path
          } catch { /* 解析失败 → 放行（主端口会 400） */ }
          if (!workspaceAllowed(allowWorkspaces, path)) {
            res.writeHead(403, { 'content-type': 'application/json' })
            res.end(workspaceDenyResponse(rpcId))
            return
          }
          proxy(req, res, body)
        }).catch(() => {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ type: 'server-response', rpcId: 'unknown', result: { ok: false, error: { code: 'bad-request', message: 'body too large', details: {} } } }))
        })
        return
      }
      // v1.22.4 S3：配置写接口（PUT /serenity/config）需 Origin 校验（防跨站 RPC 改写凭据）。
      // GET/其余透传不受影响（读操作无状态变更，跨站读取受 SameSite=Strict 保护）。
      if (req.method === 'PUT' && url.pathname === '/serenity/config') {
        if (!originAllowed(req.headers.origin, req.headers.host ?? '', mainPort)) {
          console.warn(`[serenity-hooks] 拒绝跨源配置写（Origin=${String(req.headers.origin)}）：session=${session.user}`)
          res.writeHead(403, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'cross-origin config write rejected' }))
          return
        }
      }
      proxy(req, res)
      return
    }

    // 登录 POST
    if (req.method === 'POST' && url.pathname === '/serenity/login') {
      let body = ''
      // v1.22.3 崩溃修复：登录 POST 的外部连接中断同样会触发 socket 'error' → 挂监听静默吞掉
      req.on('error', () => { try { res.destroy() } catch { /* noop */ } })
      res.on('error', () => { try { req.destroy() } catch { /* noop */ } })
      req.on('data', (chunk: Buffer) => { body += chunk.toString('utf-8') })
      req.on('end', () => {
        const params = new URLSearchParams(body)
        const user = params.get('user') ?? ''
        const password = params.get('password') ?? ''
        const code = params.get('code') ?? ''
        const remote = req.socket.remoteAddress ?? 'unknown'

        // v1.22.4 S3：CSRF 双提交校验——表单字段 csrf 必须与 cookie serenity_csrf 一致。
        // 跨站表单无法读取 cookie（SameSite=Strict + HttpOnly），因此攻击者无法提交有效对。
        const cookieCsrf = cookieValue(req.headers.cookie, 'serenity_csrf')
        const formCsrf = csrfFromRequest(req, params)
        if (cookieCsrf === undefined || formCsrf === null || !safeEqual(cookieCsrf, formCsrf)) {
          console.warn(`[serenity-hooks] 登录拒绝（CSRF 校验失败）：user=${user} ip=${remote}`)
          res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' })
          res.end(loginPageHtml('会话校验失败，请刷新页面重试'))
          return
        }

        // v1.22.4 S2：账号维度失败锁定（不按 IP——用户要求随时随地访问）。
        const lockedRemaining = accountLockRemaining(user)
        if (lockedRemaining > 0) {
          console.warn(`[serenity-hooks] 登录拒绝（账号锁定中）：user=${user} ip=${remote} 剩余=${Math.ceil(lockedRemaining / 60000)}min`)
          res.writeHead(429, { 'content-type': 'text/html; charset=utf-8', 'retry-after': String(Math.ceil(lockedRemaining / 1000)) })
          res.end(loginPageHtml(`账号已锁定，请 ${Math.ceil(lockedRemaining / 60000)} 分钟后再试`))
          return
        }

        const accounts = getAccounts()
        const account = accounts.find((a) => a.user === user)
        const passOk = account !== undefined && verifyGatewayLogin(accounts, user, password)

        // v1.22.4 S1：TOTP 第二因素——totpEnabled 开启且账号绑定后必须验证 6 位码。
        // 禁用时（totpEnabled=false）完全不要求 TOTP（含已绑定账号——安全默认：未配置即不可用）。
        let totpOk = true
        if (totpEnabled && passOk && account !== undefined
          && typeof account.totpSecret === 'string' && account.totpSecret !== '') {
          const hit = verifyTotpCode(account.totpSecret, code)
          totpOk = hit !== null
          // S1b：防重放——同 counter 短期内不重复接受（30s 窗口内同码拒绝）
          if (totpOk && hit !== null && lastTotpCounter.get(account.id) === hit) totpOk = false
          if (totpOk && hit !== null) lastTotpCounter.set(account.id, hit)
        }

        if (passOk && totpOk) {
          resetFailState(user)
          const token = issueToken(user)
          res.writeHead(302, {
            location: '/',
            'set-cookie': `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/${cookieSecure ? '; Secure' : ''}`,
          })
          res.end()
          console.log(`[serenity-hooks] 登录成功: user=${user} ip=${remote}`)
          return
        }

        // 失败路径：记录计数（仅密码错误计入；TOTP 错误同样计入——防组合爆破）
        const lockMs = recordLoginFailure(user)
        const reason = !passOk ? 'bad-password' : 'bad-totp'
        console.warn(`[serenity-hooks] 登录失败: user=${user} ip=${remote} reason=${reason}${lockMs > 0 ? ` 锁定=${Math.ceil(lockMs / 60000)}min` : ''}`)
        const msg = lockMs > 0
          ? `尝试过多，账号已锁定 ${Math.ceil(lockMs / 60000)} 分钟`
          : (passOk ? '验证码错误' : '用户名或密码错误')
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' })
        res.end(loginPageHtml(msg))
      })
      return
    }

    // 其余 → 登录页（v1.22.4：登录页注入 CSRF cookie，供登录表单双提交）
    const csrf = newCsrfToken()
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'set-cookie': `serenity_csrf=${csrf}; HttpOnly; SameSite=Strict; Path=/${cookieSecure ? '; Secure' : ''}`,
    })
    res.end(loginPageHtml('', csrf))
  })

  // WS upgrade 转发：主端口握手 + socket pipe
  // v1.22.1：upgrade 也过 DSH isTrustedApiRequest（Host/Origin 一致）——
  // 除 Host 外 **Origin 必须同步改写**为 loopback（浏览器 WS 握手带 Origin）。
  // v1.22.2 决定性修复（ERR_INVALID_HTTP_RESPONSE 根因）：
  //  - **必须把上游 101 状态行 + 响应头写回客户端 socket**（Node http upgrade
  //    事件不自动回写；只 pipe 数据 → 浏览器收到无头响应 → handshake 失败）
  //  - 监听 'response'（DSH 返回 403/404/426 等非 101）→ 透传普通 HTTP 响应
  //    （此前只监听 upgrade/error，非 101 时连接挂起 → ERR_INVALID_HTTP_RESPONSE）
  server.on('upgrade', (req, socket, head) => {
    if (!authed(req)) {
      socket.destroy()
      return
    }
    // v1.22.3 崩溃修复（S142 实测）：upgrade 后客户端 socket 脱离 http 生命周期，
    // pipe 不传播 'error'——外部 WS 连接中断（切网络/锁屏/关页面）→ socket 收到
    // ECONNRESET/EPIPE → 无人监听 'error' → Node throw → 进程崩溃。必须在 pipe
    // 前为双向 socket 挂 error 监听（代理语义：对端断开是正常现象，静默销毁即可）。
    socket.on('error', () => {
      try { usocket?.destroy() } catch { /* noop */ }
    })
    let usocket: import('node:net').Socket | undefined
    const upstream = httpRequest({
      host: '127.0.0.1',
      port: mainPort,
      path: req.url ?? '/',
      method: req.method,
      headers: buildProxyHeaders(req.headers as Record<string, string | string[] | undefined>, mainPort),
    })
    upstream.on('upgrade', (ures, usock, uhead) => {
      usocket = usock
      // 上游 socket 同样挂 error 监听（主端口侧断开 → 静默销毁客户端侧）
      usock.on('error', () => {
        try { socket.destroy() } catch { /* noop */ }
      })
      // ① 回写 101 状态行 + 响应头（含 Sec-WebSocket-Accept 等握手字段）
      const statusLine = `HTTP/1.1 ${ures.statusCode ?? 101} ${ures.statusMessage ?? 'Switching Protocols'}\r\n`
      const headerLines = Object.entries(ures.headers)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}\r\n`)
        .join('')
      try {
        socket.write(statusLine + headerLines + '\r\n')
      } catch {
        usock.destroy()
        socket.destroy()
        return
      }
      // ② 双向 pipe：客户端 socket ↔ 上游 socket
      usock.pipe(socket)
      socket.pipe(usock)
      // ③ 握手后缓冲数据按方向转发：head=客户端已发数据 → 上游；uhead=上游已发数据 → 客户端
      if (head.length > 0) usock.write(head)
      if (uhead.length > 0) socket.write(uhead)
    })
    // ③ 非 101 响应（DSH rejectWebSocketUpgrade=403 / 426 / 404）→ 透传普通 HTTP 响应
    upstream.on('response', (ures) => {
      const chunks: Buffer[] = []
      ures.on('data', (c: Buffer) => chunks.push(c))
      ures.on('end', () => {
        const body = Buffer.concat(chunks)
        const statusLine = `HTTP/1.1 ${ures.statusCode ?? 502} ${ures.statusMessage ?? ''}\r\n`
        const headerLines = Object.entries(ures.headers)
          .filter(([k]) => !['transfer-encoding', 'connection', 'upgrade'].includes(k.toLowerCase()))
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}\r\n`)
          .join('')
        try {
          socket.write(statusLine + headerLines + `content-length: ${body.length}\r\n\r\n`)
          socket.write(body)
          socket.end()
        } catch {
          socket.destroy()
        }
      })
      ures.on('error', () => socket.destroy())
    })
    upstream.on('error', () => socket.destroy())
    upstream.end()
  })

  // v1.22.1 稳定性：listen 加 error 监听——EADDRINUSE（旧进程未释放）时**不崩溃**，
  // 记录并延迟重试（最多 10 次，间隔 1s）；其余错误记录后放弃。
  // 根因：restart-web 曾因 3081 被旧进程占用直接抛 unhandled 'error' 导致 Node 进程崩溃。
  const listenWithRetry = (attempt = 0): void => {
    const onError = (err: NodeJS.ErrnoException): void => {
      if (err.code === 'EADDRINUSE' && attempt < 10) {
        console.warn(`[serenity-hooks] gateway 端口 ${port} 被占用（${err.code}），1s 后重试（${attempt + 1}/10）…`)
        setTimeout(() => listenWithRetry(attempt + 1), 1000)
        return
      }
      console.warn(`[serenity-hooks] gateway 监听 ${host}:${port} 失败: ${err.message ?? String(err)}`)
    }
    server.removeAllListeners('error')
    server.on('error', onError)
    // v1.22.3 崩溃修复：server 级 clientError 兜底——http server 解析失败/连接异常时
    // 会 emit 'clientError'（如外部客户端半开连接、畸形请求后断开）。不监听则 Node
    // 对无 'error' 监听器的 socket 直接 throw → 进程崩溃。这里静默销毁即可。
    server.removeAllListeners('clientError')
    server.on('clientError', (_err: Error, socket: import('node:net').Socket) => {
      try { socket.destroy() } catch { /* noop */ }
    })
    server.listen(port, host)
  }
  listenWithRetry()

  return {
    server,
    dispose: () => {
      // v1.22.1 稳定性：**不再清空 token**——token 是模块级集合，进程重启自然清空
      // （用户决策"重启重新登录"仍满足）；热重建（settings/配置变化 → gateway 重建）
      // 若清 token 会把所有已登录用户踢下线（WS 断 + 重连 cookie 无效 → ERR_INVALID_HTTP_RESPONSE）。
      server.close()
    },
  }
}

/** 注册 gateway（index.ts apply 调用）。
 * 归属原则（v1.22）：gateway 是 plugin 全局能力——enabled 开关读 DSH settings
 * （readSimpleSettings().gatewayEnabled），host/port/accounts 读 plugin 全局文件
 * （readAdvancedSettings()，~/.dsh/serenity-hooks.json）。**不依赖任何具体 CCC**。
 * 幂等 sync：仅当 配置/端口/开关 变化时重建监听器。
 * 事件驱动：config-updated（/serenity/config PUT 后 emit）+ DSH settings 变化（onChange emit）触发重新 sync。
 */
export function registerGateway(ctx: Context): void {
  let current: { dispose: () => void } | null = null
  let lastSig: string | null = null

  const sync = (): void => {
    try {
      const webServer = (ctx as unknown as { get?: (name: string) => unknown }).get?.('webServer') as
        | { port?: number }
        | undefined
      if (!webServer?.port) return

      const enabled = readSimpleSettings().gatewayEnabled
      const settings = readAdvancedSettings()
      // 签名：enabled + host + port + 账号数 + 白名单（配置变化才重启）
      const sig = `${enabled}|${settings.gateway.host}|${settings.gateway.port}|${settings.gateway.accounts.length}|${settings.gateway.workspaces.join(',')}|${webServer.port}`
      if (sig === lastSig) return
      lastSig = sig

      // 停旧
      if (current) {
        current.dispose()
        current = null
      }
      if (!enabled) {
        console.log('[serenity-hooks] gateway 已停止（gatewayEnabled=false，可在 dsh 设置面板开启）')
        return
      }
      const started = startGateway(
        {
          host: settings.gateway.host,
          port: settings.gateway.port,
          cookieName: 'serenity_session',
          mainPort: webServer.port,
          loginDelayMs: 0,
          allowWorkspaces: settings.gateway.workspaces,
          cookieSecure: settings.gateway.cookieSecure === true,
          allowWorkspaceCreate: settings.gateway.allowWorkspaceCreate !== false,
          totpEnabled: settings.gateway.totpEnabled === true,
        },
        () => readAdvancedSettings().gateway.accounts,
      )
      current = started
      const accounts = settings.gateway.accounts.length
      const wsNote = settings.gateway.workspaces.length === 0
        ? ''
        : `；工作区白名单 ${settings.gateway.workspaces.length} 条`
      console.log(
        `[serenity-hooks] gateway 已启动: http://${settings.gateway.host}:${settings.gateway.port} → 127.0.0.1:${webServer.port}` +
        (accounts === 0 ? '（⚠️ 未配置账号，登录页将提示）' : `（${accounts} 个账号）`) + wsNote,
      )
    } catch (err) {
      console.warn(`[serenity-hooks] gateway 同步失败: ${String((err as Error)?.message ?? err)}`)
    }
  }

  // apply 即尝试（webServer 已 inject；若尚未就绪由事件兜底）
  sync()

  // 会话出现 → ① 一次性迁移旧 CCC localstore 配置（v1.21.x → v1.22 全局文件）② 兜底重同步
  ctx.on('agent/session-start', (payload) => {
    try {
      const cwd = (payload as { agent?: { session?: { header?: { cwd?: string } } } }).agent?.session?.header?.cwd
      if (cwd) {
        const root = findSerenityRoot(cwd)
        if (root && migrateLegacyLocalstore(root)) {
          console.log(`[serenity-hooks] ✓ 已迁移 serenityAdvanced（CCC localstore → plugin 全局文件）`)
        }
      }
    } catch {
      /* 迁移失败不影响会话 */
    }
    sync()
  })

  // 配置变化（/serenity/config PUT 后 emit 'serenity/config-updated'）→ 强制重建
  ctx.on('serenity/config-updated', () => {
    lastSig = null
    sync()
  })

  // DSH settings 简单配置变化（开关/阈值；settings-section onChange emit）→ 重新 sync
  // （不强制 lastSig=null——无实质变化的设置（如阈值拖动）不重建，避免无谓断 WS）
  ctx.on('serenity/settings-changed', () => {
    sync()
  })
}

