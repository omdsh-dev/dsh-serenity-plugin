/**
 * acp-auth.ts — ACP 面的**认证 ＋ 身份**层（v1.59.0，owner 2026-10-17 令）
 *
 * ## 它解决什么
 *
 * owner 令（逐字）：「将微信桥升级为 IM 桥，每个 CCC 可以选择微信实现或 ACP 实现，
 * 微信实现保留不变向前兼容，**ACP 实现就可以暴露端口并绑定 skiff，并且要随即生成认证用的 token**」。
 *
 * 面 E（`acp-face.ts`）原本**无认证、无 CCC 归属、无角色** —— 本模块补上这三件：
 *   ① **token**：每 CCC 一枚，落**该 CCC 的 localstore**（credential scope）。
 *   ② **CCC 归属**：连接建立时由 token 反查 ⇒ **服务端权威**（不拿客户端自述的 `cwd` 当身份）。
 *   ③ **角色**：该 CCC 的 `im.acp.role` ⇒ 供装配层把 ACP 会话套上 skiff 角色。
 *
 * ## 🔴 架构决策：一面多 token，不是每 CCC 一个端口
 *
 * | | 甲：每 CCC 一个端口 | **乙：一面多 token** ← 选它 |
 * |---|---|---|
 * | 端口 | 随 CCC 数增长 | **固定 3200** |
 * | 身份来源 | 端口号 | **token（一一对应 CCC）** |
 *
 * **判据**：`token → CCC` 是一一对应，而 `cwd` 是**客户端可填的**。
 * ⇒ 用 token 定 CCC 比用 cwd 定 CCC 强：前者**服务端权威**，后者**客户端自述**。
 * ⇒ 连接一建立就知道"这是哪个 CCC"，**该连接的所有会话都归它**，角色绑定无需猜。
 * ⚠️ `cwd` 仍要校验（见 `cwdInsideRoot`）：防一枚 token 越权到别的 CCC。
 *
 * ## 🔴 为什么认证放在 WS upgrade 层，而不在 ACP 协议里
 *
 * `dsh-acp` 的 `authenticate()` **恒成功**且 `authMethods: []`（读其 `lib/index.js` 逐字），
 * 且它**不导出**可替换的认证缝 ⇒ 改协议层要重写它的接线（P0′ 已实测此路不通）。
 * 而**我们自己持有 HTTP server**（自持面）⇒ 在 `upgrade` **升级之前**校验，
 * 失败即 `401 ＋ destroy` ⇒ **连接根本进不来**。
 *
 * ## 边界
 *
 * 本模块**零 DSH 依赖**（只 `node:crypto` ／ `node:fs` ／ `node:path` 与本仓纯逻辑）⇒ 可独立单测。
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join, relative, isAbsolute, resolve as resolvePath } from 'node:path'
import { readStore, writeEntry, getEntry } from './localstore-ops.js'
import { loadSerenityConfig, DEFAULT_SERENITY_CONFIG_PATHS, type ImSettings, type ImAcpSettings } from './ccc.js'

/** localstore 凭据键（credential scope ⇒ UPPER_SNAKE） */
export const ACP_TOKEN_KEY = 'IM_ACP_TOKEN'

/** token 字节数（32 B = 256 bit；hex 后 64 字符） */
const TOKEN_BYTES = 32

/**
 * 该 CCC 的 ACP token（**读**；不存在返回 null）。
 *
 * 🔴 **不自动生成** —— 生成是**写操作**，只在 owner/面板显式要求时做
 * （`ensureAcpToken`）。读路径永远无副作用：否则每次启动都会改 localstore。
 */
export function readAcpToken(root: string): string | null {
  try {
    const value = getEntry(root, 'credential', ACP_TOKEN_KEY)
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
  } catch {
    return null
  }
}

/**
 * 生成（或返回既有）ACP token 并落该 CCC 的 localstore。
 *
 * ⚠️ **幂等**：已有 token 时**原样返回**（不轮换）—— 轮换会让在用的客户端立刻断线，
 *    必须是一次显式动作（`resetAcpToken`）。
 */
export function ensureAcpToken(root: string): string {
  const existing = readAcpToken(root)
  if (existing) return existing
  const token = randomBytes(TOKEN_BYTES).toString('hex')
  writeEntry(root, 'credential', ACP_TOKEN_KEY, token)
  return token
}

/** 轮换 token（显式动作；返回新值）。旧 token 立即失效。 */
export function resetAcpToken(root: string): string {
  const token = randomBytes(TOKEN_BYTES).toString('hex')
  writeEntry(root, 'credential', ACP_TOKEN_KEY, token)
  return token
}

/**
 * 常时比较（防时序侧信道）。
 *
 * 🔴 两个长度不等时 `timingSafeEqual` **会抛** ⇒ 先比长度并立刻返回 false。
 *    ⚠️ 那一步本身**泄漏长度**（可接受：token 长度固定且公开）。
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/** 一枚 token 的归属（用于"谁拥有这个 token"的反查与排重） */
interface TokenOwner {
  root: string
  token: string
  /** token 的 SHA-256（**日志与诊断里只出现它**，绝不出现 token 明文） */
  fingerprint: string
}

/** token 指纹（诊断面用；不可逆） */
export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 12)
}

/**
 * 从一次 HTTP upgrade 请求里取出候选 token。
 *
 * 两种携带方式都认（客户端差异；Agmente 等用具名头，脚本常用查询串）：
 *   ① `Authorization: Bearer <t>`
 *   ② `?token=<t>`（查询串）
 *
 * @returns 取到的 token；两者都无 → null
 */
export function extractToken(headers: Record<string, unknown>, url: string | undefined): string | null {
  const auth = headers['authorization']
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim())
    if (m?.[1]) return m[1].trim()
  }
  if (typeof url === 'string' && url !== '') {
    try {
      // 用哑 base 拿查询串（url 可能是 path-only，形如 `/acp?token=…`）
      const q = new URL(url, 'http://placeholder.invalid').searchParams.get('token')
      if (q && q.trim() !== '') return q.trim()
    } catch {
      /* 畸形 URL ⇒ 当作没带 */
    }
  }
  return null
}

/**
 * 校验一枚候选 token，返回它归属的 CCC 根（**未命中返回 null**）。
 *
 * @param candidate 客户端出示的 token
 * @param roots 候选 CCC 根集合（由调用方枚举——本模块不认识"CCC 在哪"）
 */
export function resolveTokenOwner(candidate: string, roots: readonly string[]): string | null {
  if (!candidate) return null
  for (const root of roots) {
    const token = readAcpToken(root)
    if (token && safeEqual(candidate, token)) return root
  }
  return null
}

/**
 * 枚举**启用了 ACP 通道**的 CCC（供 `resolveTokenOwner` 用）。
 *
 * 判据（与装配层同源，见 `acpChannelEnabled`）：`im.channel === 'acp'` ∧ `im.acp.enabled === true`
 * ∧ token 已生成。⚠️ 三者**缺一即不算**（fail-closed：宁可连不上，不可放行一个半配置的通道）。
 */
export function listAcpRoots(roots: readonly string[], paths: string[] = DEFAULT_SERENITY_CONFIG_PATHS): string[] {
  const out: string[] = []
  for (const root of roots) {
    if (!acpChannelEnabled(root, paths)) continue
    if (!readAcpToken(root)) continue // 未生成 token ⇒ 本 CCC 的 ACP 面不可用（fail-closed）
    out.push(root)
  }
  return out
}

/** 读该 CCC 的 `im` 段（未配置 ⇒ 归一缺省；永不 undefined） */
export function readImSettings(root: string, paths: string[] = DEFAULT_SERENITY_CONFIG_PATHS): Required<Pick<ImSettings, 'channel'>> & { acp: ImAcpSettings } {
  try {
    const cfg = loadSerenityConfig(root, paths)
    const im = cfg.im
    if (!im || typeof im !== 'object') return { channel: 'weixin', acp: {} }
    const channel: 'weixin' | 'acp' = im.channel === 'acp' ? 'acp' : 'weixin'
    const acp = im.acp && typeof im.acp === 'object' ? im.acp : {}
    return { channel, acp }
  } catch {
    // 配置损坏 ⇒ 退回缺省（＝微信，现状行为）。⛔ 绝不因配置读失败而放行 ACP。
    return { channel: 'weixin', acp: {} }
  }
}

/**
 * 该 CCC 是否启用 ACP 入站通道。
 *
 * 🔴 **两个条件都真才算**：`im.channel === 'acp'` **且** `im.acp.enabled === true`。
 *    为什么双键：`channel` 表达"选了哪条路"，`enabled` 表达"现在开不开" ⇒
 *    让 owner 能**选好 ACP 但暂时关着**（不用删配置），与既有各面的 `enabled` 范式一致。
 */
export function acpChannelEnabled(root: string, paths: string[] = DEFAULT_SERENITY_CONFIG_PATHS): boolean {
  const im = readImSettings(root, paths)
  return im.channel === 'acp' && im.acp.enabled === true
}

/** 该 CCC 绑定的 skiff 角色名（未配置 ⇒ null） */
export function acpRoleFor(root: string, paths: string[] = DEFAULT_SERENITY_CONFIG_PATHS): string | null {
  const role = readImSettings(root, paths).acp.role
  return typeof role === 'string' && role.trim() !== '' ? role.trim() : null
}

/**
 * 客户端 `session/new` 传来的 `cwd` 是否落在该 token 归属的 CCC 内。
 *
 * 🔴 **为什么必须校验**：token 定的是"哪个 CCC"，而 `cwd` 由**客户端**指定。
 *    不校验 ⇒ 一枚 CCC A 的 token 可以把会话开到 CCC B（越权读到另一个 CCC 的上下文）。
 *    这与 CCC 自身的路径围墙（P3）是同一条纪律，只是发生在**接入**这一层。
 *
 * 判据用 `relative()` 而非 `startsWith`（后者会把 `/a/bc` 误判为在 `/a/b` 内）。
 */
export function cwdInsideRoot(cwd: string, root: string): boolean {
  if (!isAbsolute(cwd)) return false
  const rel = relative(resolvePath(root), resolvePath(cwd))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * 一次性解析：候选 token → 归属 CCC ＋ 该 CCC 的角色。
 *
 * @returns `{ root, role }`；token 无效 ／ CCC 未启用 ACP ／ 角色未配置 → null（**调用方一律拒绝连接**）
 */
export function authorizeAcpConnection(
  candidate: string | null,
  roots: readonly string[],
  paths: string[] = DEFAULT_SERENITY_CONFIG_PATHS,
): { root: string; role: string } | null {
  if (!candidate) return null
  const root = resolveTokenOwner(candidate, listAcpRoots(roots, paths))
  if (!root) return null
  const role = acpRoleFor(root, paths)
  if (!role) return null // fail-closed：没有角色 ⇒ 不给一个无身份的 agent
  return { root, role }
}

// ── 内部：给单测/诊断用的只读快照 ───────────────────────────────────────────────

/** 该 CCC 的 ACP 通道对外**可见形态**（诊断面用；**绝不含 token 明文**） */
export function acpChannelStatus(root: string, paths: string[] = DEFAULT_SERENITY_CONFIG_PATHS): {
  channel: 'weixin' | 'acp'
  enabled: boolean
  role: string | null
  hasToken: boolean
  tokenFingerprint: string | null
} {
  const im = readImSettings(root, paths)
  const token = readAcpToken(root)
  return {
    channel: im.channel,
    enabled: acpChannelEnabled(root, paths),
    role: acpRoleFor(root, paths),
    hasToken: token !== null,
    tokenFingerprint: token ? tokenFingerprint(token) : null,
  }
}

/** 只读：该 CCC 的 localstore 是否存在（避免对不存在的 CCC 白跑 token 反查） */
export function hasLocalstore(root: string): boolean {
  try {
    return existsSync(join(root, 'localstore.json'))
  } catch {
    return false
  }
}

/** 只读：localstore 所在目录（诊断路径展示；不创建） */
export function localstoreDir(root: string): string {
  return dirname(join(root, 'localstore.json'))
}

/**
 * 该 CCC 是否"看起来像"一个可用 ACP 宿主（只读低成本预筛）。
 * ⚠️ 与 `acpChannelEnabled` 分开：本函数**不读配置**（只判文件存在），用于快速排除。
 */
export function looksLikeCcc(root: string): boolean {
  try {
    return existsSync(root) && (existsSync(join(root, '.serenity')) || existsSync(join(root, '.opencode')))
  } catch {
    return false
  }
}

/** 排重后的 token 归属表（诊断用；同一 token 出现在两个 CCC ⇒ 响亮暴露，不静默取第一个） */
export function tokenOwnerAudit(roots: readonly string[]): {
  owners: TokenOwner[]
  duplicates: Array<{ fingerprint: string; roots: string[] }>
} {
  const owners: TokenOwner[] = []
  const byToken = new Map<string, string[]>()
  for (const root of roots) {
    const token = readAcpToken(root)
    if (!token) continue
    owners.push({ root, token, fingerprint: tokenFingerprint(token) })
    const list = byToken.get(token) ?? []
    list.push(root)
    byToken.set(token, list)
  }
  const duplicates = [...byToken.entries()]
    .filter(([, rs]) => rs.length > 1)
    .map(([t, rs]) => ({ fingerprint: tokenFingerprint(t), roots: rs }))
  return { owners, duplicates }
}

/** 测试辅助：读 store 里该键的原始值（绕开 getEntry 的归一） */
export function __rawTokenForTest(root: string): string | undefined {
  try {
    const store = readStore(root, 'credential') as Record<string, string>
    return store[ACP_TOKEN_KEY]
  } catch {
    return undefined
  }
}
