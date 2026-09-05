/**
 * gateway-dsh-auth.ts — 3081 网关对 DSH 主端口 BrowserAuth 的适配（v1.28.2，S142 用户 bug）
 *
 * 背景：DSH 0.1.2-rc.1 新增 BrowserAuth（browser-auth.ts）——主端口所有 /api 请求与
 * index 渲染前必须持有 authority 绑定的签名 cookie（`dsh-auth-<sha256(Host)>`）。
 * 3081 网关反代请求到主端口时 Host 已改写为 loopback（127.0.0.1:<mainPort>，过信任栅栏），
 * 但**没有 dsh browser cookie** → 上游 401 "dsh web authentication required"。
 *
 * 方案（S142 用户拍板：不用 cookie 落盘绕，直接解决——内存换取 + 缓存，用户无感）：
 * dsp 与 DSH **同进程** → 经 `ctx.connection`（HostConnectionHandle）官方通道
 * （authenticatedUrl + authorizeIndex——web-app openBrowser 同款）在**内存**换取
 * authority=127.0.0.1:<mainPort> 的 dsh cookie，缓存后注入所有反代上游请求。
 * 零落盘、无 HTTP 往返、不复制官方 HMAC 逻辑（版本漂移风险为零）。
 *
 * 兼容性：connection 服务缺失（旧 dsh / 非 web 装配）→ cookie 换取不可用 →
 * getDshCookie 返回 undefined → 反代不注入（旧形态无 BrowserAuth，天然兼容）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** ctx.connection 服务的最小可测面（HostConnectionHandle 子集；避免硬依赖官方类型） */
export interface DshConnectionLike {
  /** 给干净 baseUrl 追加本进程 launch token → 首次登录 URL */
  authenticatedUrl(baseUrl: string): string
  /** 认证一个 index 请求：token 匹配则种 cookie（写 res）并返回 false；cookie 有效返回 true */
  authorizeIndex(request: IncomingMessage, response: ServerResponse): boolean
}

/** 从一组 set-cookie 头提取 `dsh-auth-*` cookie（browser-auth sessionCookie 首段） */
export function pickDshCookie(setCookieHeader: string | string[] | undefined): string | undefined {
  const entries = Array.isArray(setCookieHeader) ? setCookieHeader : setCookieHeader === undefined ? [] : [setCookieHeader]
  for (const entry of entries) {
    const first = entry.split(';', 1)[0]!.trim()
    if (first.startsWith('dsh-auth-') && first.includes('=')) return first
  }
  return undefined
}

/**
 * 把 dsh browser cookie 合并进现有 Cookie 头（保持外部既有 cookie——serenity_session 等）。
 * 现有头可为 string / string[]（node 头形态）；无现有 → 只返回 dsh cookie。
 */
export function mergeCookieHeader(
  existing: string | string[] | number | undefined,
  dshCookie: string,
): string {
  const existingStr = Array.isArray(existing)
    ? existing.join('; ')
    : typeof existing === 'string' && existing !== ''
      ? existing
      : undefined
  return existingStr !== undefined ? `${existingStr}; ${dshCookie}` : dshCookie
}

/**
 * 内存换取 authority 绑定的 dsh browser cookie（S142 拍板方案核心）。
 * 用官方通道在进程内完成 token→cookie 交换：构造一个对 `http://<authority>/?token=…`
 * 的 index 请求 → connection.authorizeIndex 校验 token → 写 set-cookie → 提取 cookie。
 * @returns cookie 头值（如 `dsh-auth-xxx=v1.…`）；authority/connection 异常 → undefined
 */
export function exchangeDshCookie(
  connection: DshConnectionLike,
  authority: string,
): string | undefined {
  try {
    const url = new URL(connection.authenticatedUrl(`http://${authority}`))
    if (url.searchParams.get('token') === null) return undefined
    const headers: Record<string, string> = { host: authority }
    const request = { url: `${url.pathname}${url.search}`, method: 'GET', headers } as IncomingMessage
    let captured: string | string[] | undefined
    const response = {
      writeHead(_status: number, headers?: Record<string, string | string[]>) {
        if (headers !== undefined) captured = headers['set-cookie']
        return response
      },
      end: () => response,
    } as unknown as ServerResponse
    connection.authorizeIndex(request, response)
    return pickDshCookie(captured)
  } catch {
    return undefined
  }
}

/** 可注入的 cookie 提供者（gateway 反代上游请求头用；无 connection/换取失败 → undefined） */
export type DshCookieProvider = () => string | undefined

/**
 * 构建一个带内存缓存的 dsh cookie 提供者（S142 拍板：内存缓存，不落盘）。
 * 惰性换取：首次调用才向 connection 换；失败返回 undefined（不缓存失败——下次重试）。
 * 调用方可周期性失效缓存重换（cookie 30 天有效；进程重启 token 仍在 → 换一次长期可用）。
 */
export function createDshCookieProvider(
  connection: DshConnectionLike | undefined,
  authority: string,
): DshCookieProvider {
  let cached: string | undefined
  return () => {
    if (connection === undefined) return undefined
    if (cached !== undefined) return cached
    // 换取失败不缓存（下次调用重试）；成功则内存缓存（30 天有效）
    const cookie = exchangeDshCookie(connection, authority)
    if (cookie !== undefined) cached = cookie
    return cookie
  }
}
