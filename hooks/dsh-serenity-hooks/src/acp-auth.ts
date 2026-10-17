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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, isAbsolute, resolve, resolve as resolvePath } from 'node:path'
import { readStore, writeEntry, getEntry, unsetEntry } from './localstore-ops.js'
import { loadSerenityConfig, DEFAULT_SERENITY_CONFIG_PATHS, type ImSettings, type ImAcpSettings, type ImAcpAccount } from './ccc.js'

/** 多账户凭据键前缀（`IM_ACP_TOKEN_<ACCOUNT_ID>`；与微信桥 `WEIXIN_<ID>_<FIELD>` 同构） */
const ACP_TOKEN_PREFIX = 'IM_ACP_TOKEN_'

/**
 * `accountId` → UPPER_SNAKE 片段（`agmente-phone` → `AGMENTE_PHONE`）。
 *
 * 🔴 **与 `weixin-route.ts` 的 `accountKeyPart` 逐字同规则** —— 刻意复制而非共享：
 *    两者属不同子域（微信 vs ACP），共享会让"改微信键规则"意外改掉 ACP 的既有凭据键，
 *    而凭据键**改一次就等于全体客户端掉线**。⇒ 用"同规则的两份"换"互不牵连"。
 */
function accountKeyPart(accountId: string): string {
  return accountId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
}

/** 该账户的凭据键（`IM_ACP_TOKEN_<ACCOUNT_ID>`）；`accountId` 必填 */
export function acpTokenKeyFor(accountId: string): string {
  return `${ACP_TOKEN_PREFIX}${accountKeyPart(accountId)}`
}

/** token 字节数（32 B = 256 bit；hex 后 64 字符） */
const TOKEN_BYTES = 32

/**
 * 该**账户**的 ACP token（**读**；不存在返回 null）。
 *
 * 🔴 **不自动生成** —— 生成是**写操作**，只在显式要求时做（`ensureAcpToken`）。
 *    读路径永远无副作用：否则每次判定都会改 localstore。
 *
 * @param accountId 账户键（必填 —— 凭据按账户分离，没有"CCC 默认 token"这回事）
 */
export function readAcpToken(root: string, accountId: string): string | null {
  try {
    const value = getEntry(root, 'credential', acpTokenKeyFor(accountId))
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
 *
 * @param accountId 多账户时指明哪个账户；省略 ＝ 单账户简写键
 */
export function ensureAcpToken(root: string, accountId: string): string {
  const existing = readAcpToken(root, accountId)
  if (existing) return existing
  const token = randomBytes(TOKEN_BYTES).toString('hex')
  writeEntry(root, 'credential', acpTokenKeyFor(accountId), token)
  return token
}

/**
 * 轮换 token（显式动作；返回新值）。旧 token 立即失效。
 * @param accountId 账户键
 */
export function resetAcpToken(root: string, accountId: string): string {
  const token = randomBytes(TOKEN_BYTES).toString('hex')
  writeEntry(root, 'credential', acpTokenKeyFor(accountId), token)
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
 * 一个"可接受 token 的账户"——**认证闸真正比对的单元**。
 *
 * 🔴 v1.59.1 的关键抽象变更：原先是"CCC ↔ 一枚 token"，现在是
 *    **"（CCC, 账户）↔ 一枚 token ↔ 一个角色"**。同一个 CCC 可以有多个账户
 *    （一台手机、一个脚本各一枚），彼此**互不影响**：撤一个不动另一个。
 */
export interface AcpAccount {
  /** 归属 CCC 根 */
  root: string
  /** 账户键（单账户简写 ⇒ `''`） */
  accountId: string
  /** 凭据键（localstore） */
  tokenKey: string
  /** 该账户的 token（**读时现取**；不缓存） */
  token: string
  /** 该账户绑定的 skiff 角色名 */
  role: string
}

/**
 * 把该 CCC 的配置**展开成账户列表**（读时现算，**无快照**）。
 *
 * 🔴 **`im.acp.accounts` 是必填项** —— 没有它就没有账户，**一个都认证不了**。
 *    刻意**不提供**"单账户简写"退回路径（v1.59.1）：那会多出一条永不生效的分支，
 *    而它的唯一作用是把"配置写错了"伪装成"用了简写"。
 *
 * 判据（三条都由调用方以 fail-closed 消费）：
 *  - `enabled !== false`（缺省 true）
 *  - `role` 非空（空 ⇒ 该账户**不出现**在列表里 ⇒ 必然登录失败）
 *  - token 存在（不存在 ⇒ 同样不出现）
 *
 * ⚠️ 本函数**纯读，绝不生成 token** —— 生成是写操作，归 `ensureAcpChannelTokens`。
 *    这样 upgrade 路径可以随时现算而不冒"每次连接都写 localstore"的风险。
 */
export function expandAcpAccounts(root: string, paths: string[] = DEFAULT_SERENITY_CONFIG_PATHS): AcpAccount[] {
  const im = readImSettings(root, paths)
  if (im.channel !== 'acp' || im.acp.enabled !== true) return []

  const declared = Array.isArray(im.acp.accounts) ? im.acp.accounts : []
  const out: AcpAccount[] = []
  for (const a of declared) {
    if (typeof a !== 'object' || a === null) continue
    if (a.enabled === false) continue
    const accountId = typeof a.accountId === 'string' ? a.accountId.trim() : ''
    if (accountId === '') continue // 账户必须具名（凭据键由它派生）
    const role = typeof a.role === 'string' ? a.role.trim() : ''
    if (role === '') continue // 无角色 ⇒ 不给一个无身份的 agent（fail-closed）
    const token = readAcpToken(root, accountId)
    if (!token) continue // 未生成 ⇒ 该账户此刻不可用（生成归 ensureAcpChannelTokens）
    out.push({ root, accountId, tokenKey: acpTokenKeyFor(accountId), token, role })
  }
  return out
}

/**
 * **让配置里声明的账户都拥有 token**（写操作；幂等；由装配层与配置变更时调用）。
 *
 * 🔴 owner 令「**随即生成**认证用的 token」的落地点。与 v1.59.0 的差别：
 *    那时只在**启动**时跑一次 ⇒ 加一台设备要重启；现在**任何一次判定前都可以跑**，
 *    且撤账户后不会被"复活"（只对**当前声明里**的账户生成）。
 *
 * @returns 本次**新生成**的账户键列表（已存在的原样返回，不轮换）
 */
export function ensureAcpChannelTokens(root: string, paths: string[] = DEFAULT_SERENITY_CONFIG_PATHS): string[] {
  const im = readImSettings(root, paths)
  if (im.channel !== 'acp' || im.acp.enabled !== true) return []

  const declared = Array.isArray(im.acp.accounts) ? im.acp.accounts : []
  const created: string[] = []
  for (const a of declared) {
    if (typeof a !== 'object' || a === null) continue
    if (a.enabled === false) continue
    const accountId = typeof a.accountId === 'string' ? a.accountId.trim() : ''
    if (accountId === '') continue
    try {
      if (!readAcpToken(root, accountId)) {
        ensureAcpToken(root, accountId)
        created.push(accountId)
      }
    } catch {
      /* 写失败不抛：本面是可选面；失败会表现为"该账户连不上"，由诊断面报 */
    }
  }
  return created
}

/**
 * 校验一枚候选 token，返回它归属的**账户**（未命中返回 null）。
 *
 * @param candidate 客户端出示的 token
 * @param roots 候选 CCC 根集合（由调用方枚举——本模块不认识"CCC 在哪"）
 */
export function resolveTokenAccount(
  candidate: string,
  roots: readonly string[],
  paths: string[] = DEFAULT_SERENITY_CONFIG_PATHS,
): AcpAccount | null {
  if (!candidate) return null
  for (const root of roots) {
    for (const acct of expandAcpAccounts(root, paths)) {
      if (safeEqual(candidate, acct.token)) return acct
    }
  }
  return null
}

/**
 * 枚举**有可用 ACP 账户**的 CCC（供准入名单用）。
 *
 * 判据：`im.channel === 'acp'` ∧ `im.acp.enabled === true` ∧ **至少一个账户有 token 且配了角色**。
 * ⚠️ 缺一即不算（fail-closed：宁可连不上，不可放行一个半配置的通道）。
 */
export function listAcpRoots(roots: readonly string[], paths: string[] = DEFAULT_SERENITY_CONFIG_PATHS): string[] {
  const out: string[] = []
  for (const root of roots) {
    if (expandAcpAccounts(root, paths).length > 0) out.push(root)
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
 * 一次性解析：候选 token → 归属 **账户**（含 CCC 根、账户键、角色）。
 *
 * @returns 账户；token 无效 ／ 通道未启用 ／ 无角色 → null（**调用方一律拒绝连接**）
 */
export function authorizeAcpConnection(
  candidate: string | null,
  roots: readonly string[],
  paths: string[] = DEFAULT_SERENITY_CONFIG_PATHS,
): AcpAccount | null {
  if (!candidate) return null
  return resolveTokenAccount(candidate, listAcpRoots(roots, paths), paths)
}

// ── 内部：给单测/诊断用的只读快照 ───────────────────────────────────────────────

/** 单个账户的对外可见形态（**绝不含 token 明文**） */
export interface AcpAccountStatus {
  accountId: string
  name: string | null
  role: string | null
  enabled: boolean
  hasToken: boolean
  tokenFingerprint: string | null
  /** 该账户此刻**能不能被认证闸接受**（三条判据全真） */
  usable: boolean
  /** 不能用的原因（能用 ⇒ null）—— 直接指向该改哪个字段 */
  blockedBy: string | null
}

/** 该 CCC 的 ACP 通道对外**可见形态**（诊断面用；**绝不含 token 明文**） */
export function acpChannelStatus(root: string, paths: string[] = DEFAULT_SERENITY_CONFIG_PATHS): {
  channel: 'weixin' | 'acp'
  enabled: boolean
  accounts: AcpAccountStatus[]
} {
  const im = readImSettings(root, paths)
  const declared = Array.isArray(im.acp.accounts) ? im.acp.accounts : []
  const usable = new Set(expandAcpAccounts(root, paths).map((a) => a.accountId))

  const accounts: AcpAccountStatus[] = []
  for (const a of declared) {
    if (typeof a !== 'object' || a === null) continue
    const accountId = typeof a.accountId === 'string' ? a.accountId.trim() : ''
    if (accountId === '') continue
    const role = typeof a.role === 'string' && a.role.trim() !== '' ? a.role.trim() : null
    const token = readAcpToken(root, accountId)
    const enabled = a.enabled !== false
    let blockedBy: string | null = null
    if (!enabled) blockedBy = '该账户 enabled=false'
    else if (!role) blockedBy = '未配 role'
    else if (!token) blockedBy = '尚无 token（保存配置后自动生成）'
    accounts.push({
      accountId,
      name: typeof a.name === 'string' && a.name.trim() !== '' ? a.name.trim() : null,
      role,
      enabled,
      hasToken: token !== null,
      tokenFingerprint: token ? tokenFingerprint(token) : null,
      usable: usable.has(accountId),
      blockedBy,
    })
  }

  return { channel: im.channel, enabled: acpChannelEnabled(root, paths), accounts }
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

/** 排重后的 token 归属表（诊断用；同一 token 出现在两个账户 ⇒ 响亮暴露，不静默取第一个） */
export function tokenOwnerAudit(roots: readonly string[]): {
  owners: Array<{ root: string; accountId: string; fingerprint: string }>
  duplicates: Array<{ fingerprint: string; owners: string[] }>
} {
  const owners: Array<{ root: string; accountId: string; fingerprint: string }> = []
  const byToken = new Map<string, string[]>()
  for (const root of roots) {
    for (const acct of expandAcpAccounts(root)) {
      const label = `${root}#${acct.accountId}`
      owners.push({ root, accountId: acct.accountId, fingerprint: tokenFingerprint(acct.token) })
      const list = byToken.get(acct.token) ?? []
      list.push(label)
      byToken.set(acct.token, list)
    }
  }
  const duplicates = [...byToken.entries()]
    .filter(([, ls]) => ls.length > 1)
    .map(([t, ls]) => ({ fingerprint: tokenFingerprint(t), owners: ls }))
  return { owners, duplicates }
}

/** 测试辅助：读 store 里该账户键的原始值（绕开 getEntry 的归一） */
export function __rawTokenForTest(root: string, accountId: string): string | undefined {
  try {
    const store = readStore(root, 'credential') as Record<string, string>
    return store[acpTokenKeyFor(accountId)]
  } catch {
    return undefined
  }
}

// ── CCC 配置写入（面板保存；serenity.json 的 `im.acp.accounts` 部分）──────────────

/**
 * 读取 serenity.json 原文（不存在 → 空对象）。
 *
 * ⚠️ 与 `weixin-route.ts` 的同名函数**刻意各写一份**：两者写的是**不同段**
 * （`weixin` vs `im.acp.accounts`），共用一个会在"某天只想改其中一段"时
 * 意外把另一段也重写一遍。同规则两份 > 一个会互相牵连的共用件。
 */
function readRawConfig(root: string, paths: string[] = DEFAULT_SERENITY_CONFIG_PATHS): Record<string, unknown> {
  for (const candidate of paths) {
    const p = resolve(root, candidate)
    if (existsSync(p)) {
      try {
        const v = JSON.parse(readFileSync(p, 'utf-8').replace(/^\uFEFF/, '')) as unknown
        if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
      } catch {
        return {}
      }
    }
  }
  return {}
}

/**
 * 写回 `im.acp.accounts`（保留文件里其余所有字段）。
 *
 * 🔴 **只碰这一个键**：`im.channel` / `im.acp.enabled` 归面板总开关与人工配置，
 *    本函数不越权改它们（否则"加一台设备"会顺手把通道开关也改了）。
 */
export function saveAcpAccounts(
  root: string,
  accounts: ImAcpAccount[],
  paths: string[] = DEFAULT_SERENITY_CONFIG_PATHS,
): ImAcpAccount[] {
  const target = resolve(root, paths[0] ?? '.opencode/serenity.json')
  const raw = readRawConfig(root, paths)
  const im = (raw.im && typeof raw.im === 'object' ? raw.im : {}) as Record<string, unknown>
  const acp = (im.acp && typeof im.acp === 'object' ? im.acp : {}) as Record<string, unknown>
  acp.accounts = accounts
  im.acp = acp
  raw.im = im
  const dir = resolve(target, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(target, JSON.stringify(raw, null, 2) + '\n', 'utf-8')
  return accounts
}

/**
 * 规范化一条账户声明（面板传入的任意形状 → 合法声明；非法 ⇒ null）。
 *
 * 🔴 返回类型里 `role` 是**必填**（不是 `ImAcpAccount` 的可选形态）——
 *    本函数的契约就是"要么给一个角色齐备的账户，要么给 null"。
 *    这样调用方**不必再判一次** `role` 有没有（那正是会漂的第二处判据）。
 */
export function normalizeAcpAccount(input: unknown): (ImAcpAccount & { accountId: string; role: string }) | null {
  if (typeof input !== 'object' || input === null) return null
  const a = input as Record<string, unknown>
  const accountId = typeof a.accountId === 'string' ? a.accountId.trim() : ''
  if (accountId === '') return null
  const role = typeof a.role === 'string' ? a.role.trim() : ''
  if (role === '') return null
  const out: ImAcpAccount & { accountId: string; role: string } = { accountId, role }
  if (typeof a.name === 'string' && a.name.trim() !== '') out.name = a.name.trim()
  if (a.enabled === false) out.enabled = false
  return out
}

/** 增／改一条账户（按 accountId 定位；写入后返回全表） */
export function upsertAcpAccount(
  root: string,
  account: ImAcpAccount,
  paths: string[] = DEFAULT_SERENITY_CONFIG_PATHS,
): ImAcpAccount[] {
  const current = readImSettings(root, paths).acp.accounts ?? []
  const list = [...current]
  const idx = list.findIndex((a) => a.accountId === account.accountId)
  if (idx >= 0) list[idx] = { ...list[idx], ...account }
  else list.push(account)
  return saveAcpAccounts(root, list, paths)
}

/** 删一条账户（**同时清掉它的 token**，避免留死键） */
export function removeAcpAccount(
  root: string,
  accountId: string,
  paths: string[] = DEFAULT_SERENITY_CONFIG_PATHS,
): ImAcpAccount[] {
  const current = readImSettings(root, paths).acp.accounts ?? []
  const next = saveAcpAccounts(root, current.filter((a) => a.accountId !== accountId), paths)
  try {
    unsetEntry(root, 'credential', acpTokenKeyFor(accountId))
  } catch {
    /* 键本就不存在 ⇒ 无事 */
  }
  return next
}
