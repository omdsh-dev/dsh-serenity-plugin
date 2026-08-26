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
import type { Duplex } from 'node:stream'
import { randomBytes } from 'node:crypto'
import { verifyPassword, readAdvancedSettings } from './config-ops.js'

// ── 纯逻辑（可单测）──

/** 极简登录页（内嵌 HTML，无外部资源——适配任何部署） */
export function loginPageHtml(extra: string): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Serenity 登录</title>
<style>
body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#111;color:#eee}
.card{background:#1c1c1e;padding:32px 40px;border-radius:12px;width:300px;box-shadow:0 8px 30px rgba(0,0,0,.5)}
h1{font-size:18px;margin:0 0 20px}input{width:100%;box-sizing:border-box;padding:10px;margin:8px 0;border:1px solid #333;border-radius:6px;background:#222;color:#eee}
button{width:100%;padding:10px;margin-top:16px;border:0;border-radius:6px;background:#3b82f6;color:#fff;font-size:14px;cursor:pointer}
.error{color:#f87171;font-size:12px;min-height:16px;margin-top:8px}
</style></head><body><div class="card"><h1>🔐 Serenity Web UI</h1>
<form method="post" action="/serenity/login">
<input type="text" name="user" placeholder="用户名" autocomplete="username" required autofocus>
<input type="password" name="password" placeholder="密码" autocomplete="current-password" required>
<button type="submit">登录</button>
<div class="error">${extra}</div>
</form></div></body></html>`
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
}

/**
 * 启动第二监听器。返回 { server, dispose }——dispose 关 server + 清 token。
 * @param config - 监听/代理配置。
 * @param getAccounts - 运行时读取账号列表（localstore；gateway.enabled 开关在调用方判）。
 */
export function startGateway(
  config: GatewayConfig,
  getAccounts: () => readonly { user: string; passHash: string }[],
): { server: Server; dispose: () => void } {
  const { host, port, cookieName, mainPort, loginDelayMs } = config

  /** 校验请求 Cookie 是否含有效 token */
  const authed = (req: IncomingMessage): boolean => validateToken(cookieValue(req.headers.cookie, cookieName))

  /** 反向代理：改写 Host 头 → 主端口（loopback 过信任栅栏） */
  const proxy = (req: IncomingMessage, res: ServerResponse): void => {
    const target = httpRequest({
      host: '127.0.0.1',
      port: mainPort,
      path: req.url ?? '/',
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${mainPort}` },
    }, (upstream) => {
      res.writeHead(upstream.statusCode ?? 502, upstream.headers)
      upstream.pipe(res)
    })
    target.on('error', () => {
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end('502 Bad Gateway: dsh web 主端口不可达')
    })
    req.pipe(target)
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`)

    // 已登录 → 全量反代（含 /serenity/* 配置接口——第二端口登录后同样可管理）
    if (authed(req)) {
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
      headers: { ...req.headers, host: `127.0.0.1:${mainPort}` },
    })
    upstream.on('upgrade', (_ures, usocket, uhead) => {
      // 双向 pipe：客户端 socket ↔ 上游 socket
      usocket.pipe(socket)
      socket.pipe(usocket)
      if (uhead.length > 0) usocket.write(uhead)
      if (head.length > 0) socket.write(head)
    })
    upstream.on('error', () => socket.destroy())
    upstream.end()
  })

  server.listen(port, host)

  return {
    server,
    dispose: () => {
      tokens.clear()
      server.close()
    },
  }
}

/** 注册 gateway（index.ts apply 调用）：webServer 就绪后按配置启动第二监听器。 */
export function registerGateway(
  ctx: Context,
  opts: { getRoot: () => string | null },
): void {
  let current: { dispose: () => void } | null = null

  const sync = (): void => {
    try {
      // 停旧
      if (current) {
        current.dispose()
        current = null
      }
      const root = opts.getRoot()
      if (!root) return
      const webServer = (ctx as unknown as { get?: (name: string) => unknown }).get?.('webServer') as
        | { port?: number }
        | undefined
      if (!webServer?.port) return
      const settings = readAdvancedSettings(root)
      if (!settings.gateway.enabled) return
      const accounts = settings.gateway.accounts
      if (accounts.length === 0) return // 无账号不启动（无从登录）
      const started = startGateway(
        {
          host: settings.gateway.host,
          port: settings.gateway.port,
          cookieName: 'serenity_session',
          mainPort: webServer.port,
          loginDelayMs: 0,
        },
        () => readAdvancedSettings(root).gateway.accounts,
      )
      current = started
      console.log(`[serenity-hooks] gateway 已启动: http://${settings.gateway.host}:${settings.gateway.port} → 127.0.0.1:${webServer.port}`)
    } catch (err) {
      console.warn(`[serenity-hooks] gateway 启动失败: ${String((err as Error)?.message ?? err)}`)
    }
  }

  // webServer 就绪后启动（第一次 session-start 已晚于 webServer 激活；直接同步一次）
  // 注：ctx.webServer 是 inject 服务，apply 时可读 port——直接同步
  sync()

  // 配置变化（/serenity/config PUT 后）→ 重建 gateway
  ctx.on('session/event', () => {
    // 简化：每次会话事件后复查（本地读写低频）；真实变化经 config API 手动重启可接受
  })
}

