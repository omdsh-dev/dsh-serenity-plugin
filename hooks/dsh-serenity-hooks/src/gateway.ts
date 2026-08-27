/**
 * gateway.ts — F1 双端口网关（v1.21）+ 安全加固（v1.22.4）——**装配层**
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
 * v1.22.8 熵点治理（S142）：认证域纯逻辑拆到 gateway-auth.ts（会话/锁定/CSRF/Origin/
 * cookie/登录页），代理辅助纯逻辑拆到 gateway-proxy.ts（polyfill/headers/workspace 过滤）；
 * 本文件只保留 HTTP 装配（startGateway/registerGateway/readBody）——re-export 两模块
 * 保持既有 import 面兼容（tests/gateway.test.ts 直接 import 两模块导出）。
 */

import type { Context } from 'cordis'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readAdvancedSettings, migrateLegacyLocalstore, verifyPassword } from './config-ops.js'
import { findSerenityRoot } from './ccc.js'
import { readSimpleSettings } from './settings-section.js'
import { verifyTotpCode } from './totp.js'
import {
  loginPageHtml,
  issueToken,
  revokeToken,
  validateToken,
  type GatewaySession,
  resetFailState,
  recordLoginFailure,
  accountLockRemaining,
  newCsrfToken,
  isCsrfValid,
  csrfFromRequest,
  originAllowed,
  cookieValue,
} from './gateway-auth.js'
import {
  injectPolyfillHtml,
  filterWorkspaceList,
  workspaceAllowed,
  workspaceDenyResponse,
  buildProxyHeaders,
} from './gateway-proxy.js'

// re-export 认证域 + 代理域（兼容既有 import 面；gateway-auth/gateway-proxy 为权威定义）
export {
  RANDOM_UUID_POLYFILL,
  injectPolyfillHtml,
  filterWorkspaceList,
  workspaceAllowed,
  workspaceDenyResponse,
  buildProxyHeaders,
} from './gateway-proxy.js'
export {
  loginPageHtml,
  verifyGatewayLogin,
  SESSION_TTL_MS,
  issueToken,
  revokeToken,
  validateToken,
  FAIL_LOCK_THRESHOLD,
  FAIL_LOCK_BASE_MS,
  FAIL_LOCK_MAX_MS,
  getFailState,
  resetFailState,
  isAccountLocked,
  recordLoginFailure,
  accountLockRemaining,
  newCsrfToken,
  isCsrfValid,
  csrfFromRequest,
  safeEqual,
  originAllowed,
  cookieValue,
} from './gateway-auth.js'

// 自定义事件：配置 PUT 后触发 gateway 重建（跨模块松耦合通知）
declare module 'cordis' {
  interface Events {
    /** /serenity/config PUT（账号/监听/白名单变化）→ 强制重建 gateway（lastSig=null） */
    'serenity/config-updated'(): void
    /** DSH settings 简单配置变化（开关/阈值）→ 重新 sync（sig 判断，无实质变化不重建） */
    'serenity/settings-changed'(): void
  }
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

/**
 * 启动第二监听器。返回 { server, dispose }——dispose 关 server（**不清 token**：
 * token 模块级，进程重启自然清空；热重建清 token → 已登录用户 WS 断 + 重连 cookie 无效）。
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

        // v1.22.4 S3：CSRF 双提交校验——表单字段 csrf 与 cookie serenity_csrf 都必须是
        // 服务端集合中的有效 token（v1.24.9：token 集合替代相等匹配——多标签/刷新时
        // 各自 GET 生成的 token 都有效，不再因 cookie 被最新 GET 覆盖而拒绝旧标签提交）。
        const cookieCsrf = cookieValue(req.headers.cookie, 'serenity_csrf')
        const formCsrf = csrfFromRequest(req, params)
        if (cookieCsrf === undefined || formCsrf === null || !isCsrfValid(formCsrf) || !isCsrfValid(cookieCsrf)) {
          // v1.24.8 诊断增强：cookieSecure=true 时明文 HTTP 会丢 CSRF cookie（浏览器 Secure 语义）
          console.warn(`[serenity-hooks] 登录拒绝（CSRF 校验失败）：user=${user} ip=${remote} cookieSecure=${cookieSecure ? 'on' : 'off'} cookieCsrf=${cookieCsrf === undefined ? 'missing' : 'present'} formCsrf=${formCsrf === null ? 'missing' : 'present'}`)
          // v1.24.9：失败页注入新 csrf（form + cookie 同步）——重试表单带字段，不再 missing
          const retryCsrf = newCsrfToken()
          res.writeHead(403, {
            'content-type': 'text/html; charset=utf-8',
            'set-cookie': `serenity_csrf=${retryCsrf}; HttpOnly; SameSite=Strict; Path=/`,
          })
          res.end(loginPageHtml('会话校验失败，请刷新页面重试' + (cookieSecure ? '（若仍失败：设置面板关闭 Secure Cookie——明文 HTTP 下必须关闭）' : ''), retryCsrf))
          return
        }

        // v1.22.4 S2：账号维度失败锁定（不按 IP——用户要求随时随地访问）。
        const lockedRemaining = accountLockRemaining(user)
        if (lockedRemaining > 0) {
          console.warn(`[serenity-hooks] 登录拒绝（账号锁定中）：user=${user} ip=${remote} 剩余=${Math.ceil(lockedRemaining / 60000)}min`)
          const retryCsrf = newCsrfToken()
          res.writeHead(429, {
            'content-type': 'text/html; charset=utf-8',
            'retry-after': String(Math.ceil(lockedRemaining / 1000)),
            'set-cookie': `serenity_csrf=${retryCsrf}; HttpOnly; SameSite=Strict; Path=/`,
          })
          res.end(loginPageHtml(`账号已锁定，请 ${Math.ceil(lockedRemaining / 60000)} 分钟后再试`, retryCsrf))
          return
        }

        const accounts = getAccounts()
        const account = accounts.find((a) => a.user === user)
        // v1.24.6 用户拍板：登录凭据**二选一**——密码 或 Authenticator 码，任一正确即登录。
        // （此前 v1.22.4 为双因素：密码 && TOTP 都必需；二选一后绑定验证器的账号两种方式皆可）
        const passOk = account !== undefined && password !== '' && verifyPassword(password, account.passHash)

        // TOTP 校验独立于密码（不要求 passOk 前置）——totpEnabled 关闭时完全不接受 TOTP
        // （含已绑定账号；安全默认：未配置即不可用）。防重放：同 counter 30s 窗口内拒绝复用。
        let totpOk = false
        if (totpEnabled && account !== undefined
          && typeof account.totpSecret === 'string' && account.totpSecret !== '') {
          const hit = verifyTotpCode(account.totpSecret, code)
          totpOk = hit !== null
          if (totpOk && hit !== null && lastTotpCounter.get(account.id) === hit) totpOk = false
          if (totpOk && hit !== null) lastTotpCounter.set(account.id, hit)
        }

        if (passOk || totpOk) {
          resetFailState(user)
          const token = issueToken(user)
          res.writeHead(302, {
            location: '/',
            'set-cookie': `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/${cookieSecure ? '; Secure' : ''}`,
          })
          res.end()
          console.log(`[serenity-hooks] 登录成功: user=${user} ip=${remote} via=${passOk ? 'password' : 'totp'}`)
          return
        }

        // 失败路径：密码/TOTP 任一失败都计入账号锁定（防组合爆破）
        const lockMs = recordLoginFailure(user)
        console.warn(`[serenity-hooks] 登录失败: user=${user} ip=${remote}${lockMs > 0 ? ` 锁定=${Math.ceil(lockMs / 60000)}min` : ''}`)
        const msg = lockMs > 0
          ? `尝试过多，账号已锁定 ${Math.ceil(lockMs / 60000)} 分钟`
          : '用户名、密码或验证码错误'
        // v1.24.9：失败页注入新 csrf（form + cookie 同步）——用户重试表单带字段
        const retryCsrf = newCsrfToken()
        res.writeHead(401, {
          'content-type': 'text/html; charset=utf-8',
          'set-cookie': `serenity_csrf=${retryCsrf}; HttpOnly; SameSite=Strict; Path=/`,
        })
        res.end(loginPageHtml(msg, retryCsrf))
      })
      return
    }

    // 其余 → 登录页（v1.22.4：登录页注入 CSRF cookie，供登录表单双提交）
    // v1.24.8 修复：CSRF cookie **不设 Secure**（独立于 cookieSecure）——明文 HTTP 下
    // Secure cookie 浏览器规范不发送 → CSRF 校验永远失败（"会话校验失败"，用户实测）。
    // CSRF token 是短时随机会话防护（HttpOnly + SameSite=Strict + 双提交已足够），
    // 泄露无认证价值；只有登录成功的会话 token cookie 受 cookieSecure 控制。
    const csrf = newCsrfToken()
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'set-cookie': `serenity_csrf=${csrf}; HttpOnly; SameSite=Strict; Path=/`,
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
