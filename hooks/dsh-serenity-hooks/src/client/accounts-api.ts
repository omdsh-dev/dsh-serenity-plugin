/**
 * accounts-api.ts — 账号配置的浏览器操作面（v1.22 plugin 全局）
 *
 * 归属原则（v1.22）：账号密码是 **plugin 全局配置**（~/.dsh/serenity-hooks.json），
 * 不依赖任何具体 CCC——GET/PUT 不带 sessionId/workspace。
 * 数据通道：同源 HTTP /serenity/config（node half api.ts；x-serenity-ui 头）。
 *  GET → wire 形态（accounts: {id, user, hasPassword}[]；无 hash）
 *  PUT → wire patch（账号数组整体替换；pass 空=保留原 hash；新账号必带 pass）
 *
 * 纯转换（可单测）：本地编辑状态 ↔ wire patch。
 */

/** wire 账号（服务端 GET 返回；无 hash/secret） */
export interface WireAccount {
  id: string
  user: string
  hasPassword: boolean
  /** 已绑定 TOTP（v1.22.4） */
  hasTotp: boolean
}

/** wire 配置（GET /serenity/config 的 config 字段） */
export interface WireConfig {
  gateway: {
    enabled: boolean
    host: string
    port: number
    accounts: WireAccount[]
    workspaces: string[]
    cookieSecure: boolean
    allowWorkspaceCreate: boolean
    totpEnabled: boolean
  }
  rebuild: { enabled: boolean; thresholdRatio: number }
  naming: { enabled: boolean }
  persona: { mode: string; overrideText: string }
  publicAsk: {
    /** 开放容器白名单（v1.26.2：容器名数组；空 = 全部开放） */
    allowed: string[]
  }
}

/** 本地编辑行（面板表单状态；pass 仅写方向） */
export interface AccountDraft {
  id: string
  user: string
  /** 非空 → 更新密码；空 → 保留原 hash（既有账号）或报错（新账号） */
  pass: string
  isNew: boolean
  /** 原账号是否已有密码（placeholder 显示） */
  hasPassword: boolean
  /** 原账号是否已绑定 TOTP（v1.22.4） */
  hasTotp: boolean
  /** TOTP 绑定状态（v1.22.4）：undefined=无操作；'pending'=已生成 secret 待保存 */
  totpState: 'none' | 'pending' | 'clear'
  /** pending 时的新 secret（base32，展示二维码 + 文本录入 Authenticator） */
  totpSecret?: string
}

/** wire 账号 → 本地编辑行 */
export function accountDraftFromWire(a: WireAccount): AccountDraft {
  return {
    id: a.id,
    user: a.user,
    pass: '',
    isNew: false,
    hasPassword: a.hasPassword,
    hasTotp: a.hasTotp,
    totpState: 'none',
  }
}

/** 生成新账号 id（本地编辑用；提交时若为空由服务端拒绝） */
export function newAccountId(): string {
  return `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

// ── v1.22.4 TOTP（浏览器侧生成 secret；RFC 4648 base32，与 node 端算法一致）──

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** 字节 → base32（无填充） */
function bytesToBase32(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

/** 生成 20 字节随机 TOTP secret（Web Crypto getRandomValues） */
export function newTotpSecret(): string {
  const bytes = new Uint8Array(20)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    // 非安全上下文兜底（不应发生——DSH client 均需 secure context；防御性）
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  return bytesToBase32(bytes)
}

/** 构造 otpauth URI（Authenticator 扫码/手动录入） */
export function otpauthUriClient(secret: string, label: string, issuer = 'Serenity Home'): string {
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' })
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`
}

// v1.24.6 二维码绑定：qrcode-generator（MIT，零依赖）经 tsdown noExternal 内联进 client bundle。
import qrcode from 'qrcode-generator'

/**
 * 生成 otpauth URI 的二维码 SVG（v1.24.6：配置 TOTP 时**扫码绑定**——
 * Authenticator 扫二维码即录入 secret，替代手动输入）。
 * typeNumber 0 = 自动选最小版本；纠错 M（平衡）。scalable SVG → CSS 控制显示尺寸。
 */
export function totpQrSvg(secret: string, label: string, issuer = 'Serenity Home'): string {
  const uri = otpauthUriClient(secret, label, issuer)
  const qr = qrcode(0, 'M')
  qr.addData(uri)
  qr.make()
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
}

/** 本地编辑行 → wire 账号（提交时；pass 字段携带） */
export function accountToWire(d: AccountDraft): {
  id: string
  user: string
  pass: string
  totpSecret?: string
  totpReset?: boolean
} {
  return {
    id: d.id,
    user: d.user,
    pass: d.pass,
    ...(d.totpState === 'pending' && d.totpSecret !== undefined && d.totpSecret !== ''
      ? { totpSecret: d.totpSecret }
      : d.totpState === 'clear'
        ? { totpReset: true }
        : {}),
  }
}

/** 校验本地编辑行：user 非空；新账号必须设密码（v1.24.7：TOTP 生成即绑定，无确认码要求） */
export function validateDraft(d: AccountDraft): string | null {
  if (d.user.trim() === '') return '用户名不能为空'
  if (d.isNew && d.pass === '') return '新账号必须设置密码'
  return null
}

// ── HTTP 操作（plugin 全局：不带 sessionId） ──

const CONFIG_PATH = '/serenity/config'

/**
 * 获取已有工作区列表（需求 1：白名单从已有工作区选择而非手输）。
 * 走 DSH 原生 RPC `POST /api/workspace.list`（JSON RPC 形态）。
 * 信封必须是完整 ClientRequest：`{ type: 'client-request', rpcId, method, payload }`
 * （api/rpc.ts wire 契约——缺 type/method → clientRequestSchema 校验失败 → bad-request）。
 * 返回 { path, title }[]；失败返回空数组（面板显示"暂无可选工作区"）。
 */
export async function fetchWorkspaces(): Promise<{ path: string; title: string }[]> {
  try {
    const res = await fetch('/api/workspace.list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `ws-${Date.now().toString(36)}`,
        method: 'workspace.list',
        payload: {},
      }),
    })
    if (!res.ok) return []
    const body = (await res.json()) as { result?: { ok?: boolean; value?: { items?: Array<{ path?: string; title?: string }> } } }
    const items = body?.result?.value?.items
    if (!Array.isArray(items)) return []
    return items
      .filter((i): i is { path: string; title: string } => typeof i.path === 'string' && i.path !== '')
      .map((i) => ({ path: i.path, title: typeof i.title === 'string' && i.title !== '' ? i.title : i.path }))
  } catch {
    return []
  }
}

/** GET 配置（含账号列表；无 hash） */
export async function fetchConfig(): Promise<WireConfig | null> {
  const res = await fetch(CONFIG_PATH, {
    headers: { accept: 'application/json', 'x-serenity-ui': '1' },
  })
  if (!res.ok) return null
  const body = (await res.json()) as { config?: WireConfig | null }
  return body.config ?? null
}

/** PUT 配置（账号 patch + 工作区白名单 + persona 彩蛋 + 开放容器白名单）→ 返回保存后的 wire */
export async function saveConfig(
  patch: {
    gateway?: {
      host?: string
      port?: number
      accounts?: { id: string; user: string; pass: string; totpSecret?: string; totpReset?: boolean }[]
      workspaces?: string[]
      cookieSecure?: boolean
      allowWorkspaceCreate?: boolean
      totpEnabled?: boolean
    }
    persona?: { mode?: string; overrideText?: string }
    publicAsk?: { allowed?: string[] }
  },
): Promise<WireConfig | null> {
  const res = await fetch(CONFIG_PATH, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-serenity-ui': '1' },
    body: JSON.stringify({ config: patch }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `保存失败（${res.status}）`)
  }
  const body = (await res.json()) as { config?: WireConfig }
  return body.config ?? null
}
