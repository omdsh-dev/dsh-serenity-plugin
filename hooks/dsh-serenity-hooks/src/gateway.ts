/**
 * gateway.ts — F1 双端口网关（v1.21）
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
 * 纯逻辑（可单测）：verifyGatewayLogin / issueToken / validateToken / 登录页 HTML。
 */

import type { Context } from 'cordis'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { verifyPassword, readAdvancedSettings, migrateLegacyLocalstore } from './config-ops.js'
import { findSerenityRoot } from './ccc.js'
import { readSimpleSettings } from './settings-section.js'

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
 * 登录页（v1.22.1 移动端适配）：内嵌 HTML 无外部资源——适配任何部署。
 * 移动端关键点：
 *  - viewport meta（防止移动浏览器按 980px 视口缩放）
 *  - 触控目标 ≥ 44px（Apple HIG）；输入字号 ≥ 16px（iOS 聚焦不自动放大）
 *  - env(safe-area-inset-*) 适配刘海屏/底部手势条
 *  - color-scheme: dark + 明暗自适应
 */
export function loginPageHtml(extra: string): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#111114">
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
button{width:100%;padding:15px 14px;margin-top:24px;border:0;border-radius:10px;background:#3b82f6;color:#fff;font-size:16px;font-weight:600;cursor:pointer;min-height:50px;-webkit-appearance:none;appearance:none}
button:active{background:#2563eb}
.error{color:#f87171;font-size:13px;min-height:18px;margin-top:12px;text-align:center}
.foot{margin-top:20px;text-align:center;font-size:12px;color:#666}
@media (prefers-color-scheme:light){
  body{background:#f4f4f6;color:#1a1a1e}
  .card{background:#fff;border-color:rgba(0,0,0,.08);box-shadow:0 12px 40px rgba(0,0,0,.12)}
  .sub{color:#666}
  label{color:#444}
  input{background:#fafafa;border-color:#d0d0d6;color:#1a1a1e}
  input::placeholder{color:#aaa}
  .foot{color:#999}
}
</style></head><body><div class="card">
<h1>🔐 Serenity Web UI</h1>
<p class="sub">宁静号 · 外部访问</p>
<form method="post" action="/serenity/login">
<label for="f-user">用户名</label>
<input id="f-user" type="text" name="user" placeholder="用户名" autocomplete="username" autocapitalize="none" autocorrect="off" required autofocus enterkeyhint="next">
<label for="f-pass">密码</label>
<input id="f-pass" type="password" name="password" placeholder="密码" autocomplete="current-password" required enterkeyhint="go">
<button type="submit">登录</button>
<div class="error">${extra}</div>
</form>
<p class="foot">Serenity ACC · dsh-serenity-hooks</p>
</div></body></html>`
}

/** 账号验证（纯逻辑）：user + password 对 localstore accounts 匹配（scrypt） */
export function verifyGatewayLogin(
  accounts: readonly { user: string; passHash: string }[],
  user: string,
  password: string,
): boolean {
  const account = accounts.find((a) => a.user === user)
  if (!account) return false
  return verifyPassword(password, account.passHash)
}

/** 内存 token 表（重启即清空——用户决策） */
const tokens = new Set<string>()

/** 颁发 token（Hex 32 字节） */
export function issueToken(): string {
  const token = randomBytes(32).toString('hex')
  tokens.add(token)
  return token
}

/** 校验 token 是否有效 */
export function validateToken(token: string | undefined): boolean {
  return typeof token === 'string' && token !== '' && tokens.has(token)
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
  getAccounts: () => readonly { user: string; passHash: string }[],
): { server: Server; dispose: () => void } {
  const { host, port, cookieName, mainPort, loginDelayMs } = config
  const allowWorkspaces = config.allowWorkspaces ?? []

  /** 校验请求 Cookie 是否含有效 token */
  const authed = (req: IncomingMessage): boolean => validateToken(cookieValue(req.headers.cookie, cookieName))

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
    })
    target.on('error', () => {
      try {
        res.writeHead(502, { 'content-type': 'text/plain' })
        res.end('502 Bad Gateway: dsh web 主端口不可达')
      } catch { /* res 已关闭 */ }
    })
    if (bodyOverride !== undefined) target.end(bodyOverride)
    else req.pipe(target)
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`)

    // 已登录 → 全量反代（含 /serenity/* 配置接口——第二端口登录后同样可管理）
    if (authed(req)) {
      // workspace.create：白名单校验（读 body → 检查路径 → 转发或拒绝）
      if (req.method === 'POST' && url.pathname === '/api/workspace.create') {
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
      proxy(req, res)
      return
    }

    // 登录 POST
    if (req.method === 'POST' && url.pathname === '/serenity/login') {
      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk.toString('utf-8') })
      req.on('end', () => {
        const params = new URLSearchParams(body)
        const user = params.get('user') ?? ''
        const password = params.get('password') ?? ''
        if (verifyGatewayLogin(getAccounts(), user, password)) {
          const token = issueToken()
          res.writeHead(302, {
            location: '/',
            'set-cookie': `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`,
          })
          res.end()
          return
        }
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' })
        res.end(loginPageHtml('用户名或密码错误'))
      })
      return
    }

    // 其余 → 登录页
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(loginPageHtml(''))
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
    const upstream = httpRequest({
      host: '127.0.0.1',
      port: mainPort,
      path: req.url ?? '/',
      method: req.method,
      headers: buildProxyHeaders(req.headers as Record<string, string | string[] | undefined>, mainPort),
    })
    upstream.on('upgrade', (ures, usocket, uhead) => {
      // ① 回写 101 状态行 + 响应头（含 Sec-WebSocket-Accept 等握手字段）
      const statusLine = `HTTP/1.1 ${ures.statusCode ?? 101} ${ures.statusMessage ?? 'Switching Protocols'}\r\n`
      const headerLines = Object.entries(ures.headers)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}\r\n`)
        .join('')
      try {
        socket.write(statusLine + headerLines + '\r\n')
      } catch {
        usocket.destroy()
        socket.destroy()
        return
      }
      // ② 双向 pipe：客户端 socket ↔ 上游 socket
      usocket.pipe(socket)
      socket.pipe(usocket)
      // ③ 握手后缓冲数据按方向转发：head=客户端已发数据 → 上游；uhead=上游已发数据 → 客户端
      if (head.length > 0) usocket.write(head)
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

