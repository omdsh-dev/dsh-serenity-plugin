/**
 * gateway-proxy.ts — F1 双端口网关：代理辅助纯逻辑（v1.22.1-1.22.3 稳定性修复）
 *
 * 从 gateway.ts 拆分（S142 熵点治理，v1.22.8）：
 *  - crypto.randomUUID polyfill（非安全上下文修复，v1.22.0）
 *  - 反代请求头构造（信任栅栏修复：Host + Origin 同步改写 loopback，v1.22.1）
 *  - workspace 白名单过滤（响应 items 前缀过滤 + create 校验 + 403 RPC 响应，v1.22）
 *  - HTML polyfill 注入（幂等 marker）
 * 纯函数设计（可单测）；gateway.ts 装配层 import 使用。
 */

// ── crypto.randomUUID polyfill（浏览器 Web Crypto 仅安全上下文可用）──

/**
 * 经第二端口 http://LAN-IP:3081 访问 = 非安全上下文 → DSH client 的
 * `crypto.randomUUID()`（ui-conversation/service.ts 等）抛错，provider 目录加载失败。
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
