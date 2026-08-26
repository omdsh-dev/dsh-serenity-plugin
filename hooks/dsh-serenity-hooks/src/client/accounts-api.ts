/**
 * accounts-api.ts — 账号配置的浏览器操作面（v1.21 面板账号 tab）
 *
 * 数据通道：同源 HTTP /serenity/config（node half api.ts；x-serenity-ui 头）。
 *  GET → wire 形态（accounts: {id, user, hasPassword}[]；无 hash）
 *  PUT → wire patch（账号数组整体替换；pass 空=保留原 hash；新账号必带 pass）
 *
 * 纯转换（可单测）：本地编辑状态 ↔ wire patch。
 */

/** wire 账号（服务端 GET 返回；无 hash） */
export interface WireAccount {
  id: string
  user: string
  hasPassword: boolean
}

/** wire 配置（GET /serenity/config 的 config 字段） */
export interface WireConfig {
  gateway: {
    enabled: boolean
    host: string
    port: number
    accounts: WireAccount[]
  }
  rebuild: { enabled: boolean; thresholdRatio: number }
  naming: { enabled: boolean }
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
}

/** wire 账号 → 本地编辑行 */
export function accountDraftFromWire(a: WireAccount): AccountDraft {
  return { id: a.id, user: a.user, pass: '', isNew: false, hasPassword: a.hasPassword }
}

/** 生成新账号 id（本地编辑用；提交时若为空由服务端拒绝） */
export function newAccountId(): string {
  return `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/** 本地编辑行 → wire 账号（提交时；pass 字段携带） */
export function accountToWire(d: AccountDraft): { id: string; user: string; pass: string } {
  return { id: d.id, user: d.user, pass: d.pass }
}

/** 校验本地编辑行：user 非空；新账号必须设密码 */
export function validateDraft(d: AccountDraft): string | null {
  if (d.user.trim() === '') return '用户名不能为空'
  if (d.isNew && d.pass === '') return '新账号必须设置密码'
  return null
}

// ── HTTP 操作 ──

const CONFIG_PATH = '/serenity/config'

/** GET 配置（含账号列表；无 hash） */
export async function fetchConfig(sessionId: string): Promise<WireConfig | null> {
  const qs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
  const res = await fetch(`${CONFIG_PATH}${qs}`, {
    headers: { accept: 'application/json', 'x-serenity-ui': '1' },
  })
  if (!res.ok) return null
  const body = (await res.json()) as { config?: WireConfig | null }
  return body.config ?? null
}

/** PUT 配置（账号 patch）→ 返回保存后的 wire */
export async function saveConfig(
  sessionId: string,
  patch: { gateway?: { host?: string; port?: number; accounts?: { id: string; user: string; pass: string }[] } },
): Promise<WireConfig | null> {
  const res = await fetch(CONFIG_PATH, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-serenity-ui': '1' },
    body: JSON.stringify({ sessionId, config: patch }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `保存失败（${res.status}）`)
  }
  const body = (await res.json()) as { config?: WireConfig }
  return body.config ?? null
}
