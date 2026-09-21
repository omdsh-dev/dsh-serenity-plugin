/**
 * trajectory-bound.ts — SESSION 绑定持久化（CCC 内 `AGENT_SESSIONS/.bindings.json`）
 *
 * 目标（S142 用户拍板，方案 v1.0）：让「dsh 会话（载体）↔ SESSION（宁静号轨迹）」
 * 的绑定坚固——LLM 不能因智力因素（幻觉/理解偏差）在过程中或 container_trajectory rebuild 后
 * 自行更换 SESSION。
 *
 * 存储形态（v1.30.6 起，S142 review F-01）：绑定**不再写入 dsh 会话日志**。
 * 原因（宿主契约实证）：dsp 的自定义事件 `serenity/bound` 既不在宿主的
 * `KNOWN_SESSION_EVENT_TYPES`（生成静态集，明确说明 out-of-repo 插件事件不在其中），
 * 而 `Session.append` 构造事件时只写 `{type,seq,time,data,surfaceOp?,sourceEventSeqs?}`
 * ——**没有写入 envelope `ignorable` 标记的通道**；宿主的 `assertEventsSupported`
 * （session-persistence/coordinator.ts:1248-1252，调用点含恢复/HMR 路径）会拒绝任何
 * "未知且非 ignorable" 的事件 → 含该事件的会话在冷加载时可能抛
 * `SessionFormatUnsupportedError`。v1.29.1~v1.30.5 的设计文档虽写明要带
 * `ignorable: true`（docs/session-binding-hardening-research.md:53），但类型层声明
 * 不等于持久层标记，实际从未落盘。
 *
 * 现形态：每 CCC 一个 JSON 文件 `AGENT_SESSIONS/.bindings.json`（原子写：tmp + rename），
 * 以 dsh 会话 id 为键，latest-wins 覆盖。**向后兼容**：读取时若文件中无该会话记录，
 * 仍回落到扫描会话日志中的旧 `serenity/bound` 事件（老会话的绑定不丢）。
 *
 * 编码无关（U4）：绑定锚 = **完整 AGENT_SESSIONS 目录名**（磁盘唯一存在），
 * sessionId（S###/apaas-xxx/自定义）仅是派生展示字段——绝不假设 S 前缀。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { cccRootForCwd } from './ccc-roots.js'
import { type BindingStore, type BindingRecord } from './host/storage-domain.js'
import { getActiveSessionInfo, getLastActiveSessionInfo, sessionEvents } from './trajectory-ops.js'

type SessionBoundAction = 'activate' | 'switch' | 'create' | 'rebuild' | 'reconcile' | 'release'

interface SessionBoundRecord {
  dirName: string
  mdPath: string
  sessionId?: string
  action: SessionBoundAction
  at: number
  note?: string
  /**
   * **(b) 已被取代标记**（S142 §0y，所有者 2026-09-18 裁「b 做」）。
   *
   * 语义：这条绑定**仍然存在**（沿革不丢、正向 `readLastBound` 仍能查到"我曾属于哪条轨迹"），
   * 但**不再作为唤醒候选**（{@link listBoundSessionIds} 过滤掉）——这正是"解绑"的机械形态。
   *
   * 为什么需要（实证）：`.bindings.json` 只增不清——实测 S142 名下挂 **4 代**、S185 挂 **2 代**，
   * 同一 trajectory 因此可以有**两条 live 会话**：各持一份完整上下文（内存翻倍）
   * 且**都在写同一批文件**（双写者）。
   */
  supersededAt?: number
}

/** 旧形态事件类型（v1.29.1~v1.30.5 写入会话日志；v1.30.6 起只读不写——兼容存量绑定） */
const SESSION_BOUND_EVENT = 'serenity/bound' as const

/** 绑定文件相对 CCC 根的路径 */
export const BINDINGS_REL_PATH = 'AGENT_SESSIONS/.bindings.json'

const BINDINGS_VERSION = 1

// ── §0L（S142 2026-09-19）：宿主存储域作为**权威载体**，旧文件作**兜底** ──────────────
//
// 为什么是"域优先、文件兜底"而不是"二选一"（R↓，owner 硬约束「向前兼容」）：
//  · **域不可用**（宿主未装载 storage-domain / 老宿主 / open 失败）⇒ 必须仍能工作
//    ⇒ **读回落到旧文件**，行为与升级前**完全一致**（零回归）；
//  · **域可用** ⇒ 以域为准（这是 owner 要的"放对地方"），同时**继续写旧文件**
//    （迁移期双写：万一域出问题，旧表仍是完整的可用副本）。
//
// 句柄是**模块级**的：由 `index.ts` 装载期 `setBindingStore(await openBindingDomain(ctx))` 注入。
// 为什么模块级而不是逐调用点传 ctx：`readLastBound(session)` 等 **10 个调用点全是同步签名**
// 且多数拿不到插件 ctx（如 system-prompt 的每轮求值、keeper）——句柄驻留模块级
// 是"签名不变"这一硬要求的唯一实现方式（域读是同步的，见 host/storage-domain.ts）。

let domainStore: BindingStore | null = null

/**
 * 注入域句柄（装载期调用一次）。传 `null` = 域不可用 ⇒ 全部退回旧文件行为。
 * 幂等：重复调用以后者为准（HMR / 重载场景）。
 */
export function setBindingStore(store: BindingStore | null): void {
  domainStore = store
}

/** 当前域句柄（诊断用；`null` = 未接线/不可用） */
export function getBindingStore(): BindingStore | null {
  return domainStore
}

/** 域记录 → 本模块记录形状（同名字段，无需映射表；见 host/storage-domain.ts 头注） */
function fromDomainRecord(rec: BindingRecord): SessionBoundRecord {
  return {
    dirName: rec.dirName,
    mdPath: rec.mdPath,
    ...(rec.sessionId ? { sessionId: rec.sessionId } : {}),
    action: (rec.action ?? 'activate') as SessionBoundAction,
    at: typeof rec.at === 'number' ? rec.at : 0,
    ...(rec.note ? { note: rec.note } : {}),
    ...(rec.supersededAt !== undefined ? { supersededAt: rec.supersededAt } : {}),
  }
}

/** 本模块记录 → 域记录形状 */
function toDomainRecord(rec: SessionBoundRecord): BindingRecord {
  return {
    dirName: rec.dirName,
    mdPath: rec.mdPath,
    ...(rec.sessionId ? { sessionId: rec.sessionId } : {}),
    action: rec.action,
    at: rec.at,
    ...(rec.note ? { note: rec.note } : {}),
    ...(rec.supersededAt !== undefined ? { supersededAt: rec.supersededAt } : {}),
  }
}

/**
 * §0L **一次性迁移**：把某个 CCC 的旧 `.bindings.json` 全量灌入宿主存储域。
 *
 * 设计要点（R↓）：
 *  - **幂等**：只写域里**尚不存在**的键（`skip existing`）。⇒ 重复调用（每次启动都调）
 *    不会覆盖域里的新状态，也不会因并发而互相踩踏。
 *  - **不删旧文件**：迁移只读不写旧表（owner「向前兼容」的第二道保险仍在）。
 *  - **不丢绑定**：逐条迁移，单条失败不影响其余（返回计数供诊断）。
 *  - **失败静默**：域写不可用 ⇒ 返回 `{migrated:0, skipped:0, failed:0}`，不抛错
 *    （装载期调用，不能成为启动单点）。
 *
 * @param root CCC 根（`AGENT_SESSIONS/.bindings.json` 所在）
 * @returns 迁移计数（诊断用；`migrated` = 本次真正灌入的条数）
 */
export function migrateBindingsToDomain(root: string): { migrated: number; skipped: number; failed: number } {
  const out = { migrated: 0, skipped: 0, failed: 0 }
  if (!domainStore?.available) return out
  let file: BindingsFile
  try {
    file = readBindingsFile(join(root, BINDINGS_REL_PATH))
  } catch {
    return out
  }
  for (const [id, raw] of Object.entries(file.sessions)) {
    const rec = asBoundRecord(raw)
    if (!rec) continue
    // 幂等判据：域里已有该会话 ⇒ 跳过（**不覆盖**域中的现行状态）
    if (domainStore.get(id)) {
      out.skipped += 1
      continue
    }
    try {
      void domainStore.put(id, toDomainRecord(rec)).catch(() => {
        /* 单条域写失败：不影响其余（计数已在同步段体现，此处为异步兜底） */
      })
      out.migrated += 1
    } catch {
      out.failed += 1
    }
  }
  // 🔴 已迁移过的 CCC 记一笔（进程内去重）：避免同一 CCC 在每轮读路径上重复扫旧表
  // （幂等本身已保证正确性；去重只为省 IO）。
  if (out.migrated > 0) migratedRoots.add(root)
  return out
}

/** 已补过迁移的 CCC 根（进程内去重；跨进程各补一次是可接受的——迁移幂等） */
const migratedRoots = new Set<string>()

/**
 * **按 CCC 惰性补迁移**（§0L 修正，S142 2026-09-19）。
 *
 * 🔴 为什么需要它（实测缺陷，R↓）：
 * 装载期那次迁移用的是 `process.cwd()` —— 而 dsh **服务进程的 cwd 是 `/home/yh`**，
 * **不是 CCC 根**（实测 `acc-diag`：`进程 cwd: /home/yh ｜ 进程 CCC: （无）`）。
 * ⇒ 迁移读的是一个**不存在的文件**，静默迁移 0 条
 * （症状：发布后 `~/.dsh/storages/serenity_bindings.json` **没出现**）。
 *
 * 现在改为：**任何一次能定位到 CCC 根的路径**都顺手补一次迁移（幂等 + 进程内去重）。
 * 这样无论服务从哪个 cwd 启动，只要那条 CCC 有会话活动，它的绑定就会被带上。
 *
 * @param root CCC 根
 */
export function ensureBindingsMigrated(root: string): void {
  if (!domainStore?.available) return
  if (migratedRoots.has(root)) return
  try {
    migrateBindingsToDomain(root)
  } catch {
    /* 惰性迁移失败不阻断读路径（旧文件仍完整可用） */
  }
}

/**
 * 域内读一条（同步）。域不可用 → `undefined`（调用方据此回落文件）。
 * @param sessionId dsh 会话 id
 */
function readFromDomain(sessionId: string): SessionBoundRecord | undefined {
  if (!domainStore?.available) return undefined
  const rec = domainStore.get(sessionId)
  return rec ? fromDomainRecord(rec) : undefined
}

/**
 * 域内取**某轨迹的全部绑定**（同步；已排除 superseded —— 与 `listBoundSessionIds` 同判据）。
 * 域不可用 → `null`（**注意与"空结果"区分**：null = 回落文件，[] = 域里确实没有）。
 */
function listFromDomain(dirName: string): Array<{ id: string; rec: SessionBoundRecord }> | null {
  if (!domainStore?.available) return null
  const out: Array<{ id: string; rec: SessionBoundRecord }> = []
  for (const [id, raw] of domainStore.entries()) {
    const rec = fromDomainRecord(raw)
    if (rec.dirName !== dirName) continue
    out.push({ id, rec })
  }
  return out
}

interface BindingsFile {
  version: number
  sessions: Record<string, SessionBoundRecord>
}

function sessionHeader(session: unknown): { id?: string; cwd?: string } | null {
  const header = (session as { header?: unknown } | null | undefined)?.header
  if (!header || typeof header !== 'object') return null
  return header as { id?: string; cwd?: string }
}

/** 绑定文件绝对路径（由会话 cwd 上溯 .serenity 定位 CCC 根）；无法定位返回 null */
export function bindingsPathFor(session: unknown): string | null {
  const header = sessionHeader(session)
  if (typeof header?.cwd !== 'string') return null
  const root = cccRootForCwd(header.cwd)
  if (!root) return null
  // §0L 惰性补迁移（§0L 修正）：**这是每次绑定的读/写都会经过的收口点**，
  // 也是本模块唯一能稳定拿到 CCC 根的地方 ⇒ 把"该 CCC 的历史绑定补灌进域"挂在这里。
  // 幂等 + 进程内去重 ⇒ 首次之后是零成本的分支判断。
  ensureBindingsMigrated(root)
  return join(root, BINDINGS_REL_PATH)
}

function readBindingsFile(path: string): BindingsFile {
  if (!existsSync(path)) return { version: BINDINGS_VERSION, sessions: {} }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<BindingsFile>
    const sessions = parsed.sessions
    if (!sessions || typeof sessions !== 'object') return { version: BINDINGS_VERSION, sessions: {} }
    return { version: BINDINGS_VERSION, sessions: sessions as Record<string, SessionBoundRecord> }
  } catch {
    /* 文件损坏 → 视为空（不阻断；下次写入重建） */
    return { version: BINDINGS_VERSION, sessions: {} }
  }
}

/** 原子写：同目录 tmp + rename（避免半写文件被后续读取） */
function writeBindingsFile(path: string, data: BindingsFile): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf-8')
  renameSync(tmp, path)
}

/** 记录形状校验（容忍手改/旧数据） */
function asBoundRecord(value: unknown): SessionBoundRecord | null {
  const r = value as SessionBoundRecord | null | undefined
  if (!r || typeof r.dirName !== 'string' || typeof r.mdPath !== 'string') return null
  return r
}

/** 旧形态：从会话日志扫最后一条 `serenity/bound`（兼容 v1.30.5 及更早写入的绑定） */
function readLegacyBoundFromEvents(session: unknown): SessionBoundRecord | null {
  const events = sessionEvents<unknown>(session)
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i] as { type?: unknown; data?: unknown } | null | undefined
    if (!ev || ev.type !== SESSION_BOUND_EVENT) continue
    const rec = asBoundRecord(ev.data)
    if (rec) return rec
  }
  return null
}

/**
 * 读取会话当前绑定（权威，latest-wins）。
 *
 * 读取顺序（§0L，S142 2026-09-19）：
 *  1. **宿主存储域**（域可用时的权威来源）；
 *  2. **旧文件** `.bindings.json`（域不可用 ⇒ 零回归回落；域可用但该会话未迁移 ⇒ 兜底）；
 *  3. **旧事件形态** `serenity/bound`（v1.30.5 及更早的存量）。
 * 无绑定返回 null。
 */
export function readLastBound(session: unknown): SessionBoundRecord | null {
  const id = sessionHeader(session)?.id
  // ① 域优先
  if (typeof id === 'string') {
    const fromDomain = readFromDomain(id)
    if (fromDomain) return fromDomain
  }
  // ② 旧文件兜底
  const path = bindingsPathFor(session)
  if (path && typeof id === 'string') {
    const rec = asBoundRecord(readBindingsFile(path).sessions[id])
    if (rec) return rec
  }
  // ③ 旧事件形态
  return readLegacyBoundFromEvents(session)
}

/** 判定会话是否已有绑定（供 reconcile 判定：无绑定才标题升级）。 */
export function hasAnyBound(session: unknown): boolean {
  return readLastBound(session) !== null
}

/** 目录名 → 轨迹标签（`--S###--` 命中取 `S###`；未命中原样返回——编码无关 U4） */
function trajectoryLabel(dirName: string): string {
  const m = dirName.match(/--S(\d{3,})--/)
  return m ? `S${m[1]}` : dirName
}

/**
 * **调用方自身**所属 trajectory 的标签（审计字段 `createdBy` 的唯一正解）。
 *
 * 三级来源，逐级回退（R↓：为什么不用单一来源）：
 *  1. `readLastBound(session)` —— **持久 bound**，权威（重启存活、不受别的会话激活污染）
 *  2. `getActiveSessionInfo(scope)` —— 本 dsh 会话的**内存**激活（按 scope 隔离）
 *  3. `getLastActiveSessionInfo()` —— **全局**最近激活指针（无绑定的会话兼容回退）
 *
 * ⚠️ 为何单列成本函数（S142 §30.12.1 实测缺陷）：唤醒注册表的 `createdBy` 原先直接取第 3 级
 * 全局指针，而它记录的是"**进程内最近一次被激活的 trajectory**"——多会话并发时必然张冠李戴
 * （实测：S142 登记唤醒被写成 `by=S060`）。`createdBy` 是 D60「以可审计替代入口栅」的**唯一凭证**，
 * 失真即替代控制失效 ⇒ 必须以"调用方自己是谁"为准，全局指针只作最后兜底。
 *
 * @param session 调用方 dsh 会话对象（需 `header.id` + `header.cwd`）
 * @param scope 调用方 dsh 会话 id（取不到传空串）
 * @returns 轨迹标签（`S###` 或完整目录名）；三级全落空 → 空串（渲染为 `?`）
 */
export function resolveSessionTrajectoryLabel(session: unknown, scope: string): string {
  const bound = session ? readLastBound(session) : null
  if (bound?.dirName) return trajectoryLabel(bound.dirName)
  const scoped = scope !== '' ? getActiveSessionInfo(scope) : null
  if (scoped) return scoped.sessionId
  return getLastActiveSessionInfo()?.sessionId ?? ''
}

/**
 * 反向查：绑定到某 trajectory 目录名的 dsh 会话 id（**按绑定时间倒序，最新在前**）。
 *
 * 用途（wake-scheduler 冷唤醒）：.bindings.json 以 **sessionId 为键**，而唤醒条目的
 * target 是**目录名**——需要值侧扫描做反向索引。冷会话被唤醒时必须先知道"哪个 dsh
 * 会话承载这条轨迹"，这是唯一的权威来源（标题只作回退，见 v1.29.2 R2）。
 *
 * @param root CCC 根
 * @param dirName AGENT_SESSIONS 目录名（完整名，如 `2026-09-01--S151--x--auto`）
 * @returns 会话 id 列表（最新绑定在前）；无绑定 → `[]`
 */
export function listBoundSessionIds(root: string, dirName: string): string[] {
  const hits: Array<{ id: string; at: number }> = []

  // §0L：域优先。注意 `listFromDomain` 返回 `null` = **域不可用**（回落文件），
  // 返回 `[]` = 域可用但该轨迹无绑定 —— 两者语义不同，不可混用。
  const fromDomain = listFromDomain(dirName)
  if (fromDomain !== null) {
    for (const { id, rec } of fromDomain) {
      if (rec.supersededAt !== undefined) continue
      hits.push({ id, at: typeof rec.at === 'number' ? rec.at : 0 })
    }
    // 域可用但该轨迹无记录 ⇒ 仍回落文件（迁移期：域尚未灌入该轨迹的历史绑定）
    if (hits.length > 0) return hits.sort((a, b) => b.at - a.at).map((h) => h.id)
  }

  const file = readBindingsFile(join(root, BINDINGS_REL_PATH))
  for (const [id, raw] of Object.entries(file.sessions)) {
    const rec = asBoundRecord(raw)
    if (!rec || rec.dirName !== dirName) continue
    // (b) 守卫：已被取代的绑定**不再作为唤醒候选**（记录仍在 → 沿革与正向查询不受影响）
    if (rec.supersededAt !== undefined) continue
    if (hits.some((h) => h.id === id)) continue // 域已给出的不重复
    hits.push({ id, at: typeof rec.at === 'number' ? rec.at : 0 })
  }
  return hits.sort((a, b) => b.at - a.at).map((h) => h.id)
}

/**
 * 🔴 **「只留一条」的唯一判据**（2026-09-21 收进单一实现；此前同一判据在域侧/文件侧各写一遍）。
 *
 * 判据：同 `dirName` ∧ **不是** `keepIds` 里的 ∧ **尚未** `supersededAt`。
 * 域侧与文件侧**同判据**——历史缺陷（2026-09-19）正是"只在一侧收集 ⇒ 返回值恒空"，
 * 见 {@link supersedeOtherBindings} 的注释。
 *
 * @param fileSessions 旧文件表的记录集
 * @param domainEntries 域侧条目（域不可用时传 `undefined` = 不参与判定）
 */
function collectSupersedeTargets(
  dirName: string,
  keepIds: ReadonlySet<string>,
  fileSessions: Record<string, unknown>,
  domainEntries: Iterable<[string, BindingRecord]> | undefined,
): Set<string> {
  const toMark = new Set<string>()
  if (domainEntries) {
    for (const [id, raw] of domainEntries) {
      const rec = fromDomainRecord(raw)
      if (rec.dirName !== dirName) continue
      if (keepIds.has(id) || rec.supersededAt !== undefined) continue
      toMark.add(id)
    }
  }
  for (const [id, raw] of Object.entries(fileSessions)) {
    const rec = asBoundRecord(raw)
    if (!rec || rec.dirName !== dirName) continue
    if (keepIds.has(id) || rec.supersededAt !== undefined) continue
    toMark.add(id)
  }
  return toMark
}

/**
 * **(b) 同一 trajectory 多 live 会话的机械守卫**（S142 §0y，所有者 2026-09-18 裁「b 做」）。
 *
 * 把绑定到 `dirName` 的**其它**会话 id 标记为 `supersededAt` —— **保留记录**（沿革/正向查询不丢），
 * 只切断"**唤醒还会找到它**"这条路。语义上即"解绑"，且**不动那个会话本身**（它仍可被人工使用）。
 *
 * 为什么必须有机制（R↓）：`.bindings.json` 的语义是"latest-wins 覆盖**本条会话记录**"，
 * 对**同一 trajectory 的其它会话**没有任何约束 ⇒ 多代会话自然堆积（实测 S142 4 代 / S185 2 代），
 * 而 `acquireWakeAgent` 是"遍历全部绑定 id、任一条 live 就用它"——**两条 live 都能被选中**。
 *
 * @param root CCC 根
 * @param dirName 目标 trajectory 目录名
 * @param keepIds 保留（不标记）的会话 id 集合——通常是"当前正在 use 的这条"
 * @returns **实际被标记**的会话 id（升序稳定；供调用方如实报告，未标记任何一条 → `[]`）
 */
export function supersedeOtherBindings(
  root: string,
  dirName: string,
  keepIds: ReadonlySet<string>,
): string[] {
  const path = join(root, BINDINGS_REL_PATH)
  const file = readBindingsFile(path)
  const at = Date.now()
  /**
   * 需要退休的会话 id 集合。
   *
   * 🔴 必须取**域 ∪ 文件的并集**（实测缺陷，2026-09-19）：
   * 首版实现只在**文件循环**里 `marked.push(id)`，于是"记录只在域里"时
   * 返回值恒为 `[]` —— 而调用方（`tools/trajectory.ts` 的 `use`）**靠这个返回值**决定
   * 是否回报 `supersededBindings`，并且早先用 `marked.length === 0` 短路**跳过了写盘**。
   * ⇒ 症状是"D69 只留一条**静默不生效**"（记录没被标记，返回也看不出异常）。
   * 由 `tests/trajectory-bound.test.ts` 的 D69 域路径用例抓到。
   */
  const toMark = collectSupersedeTargets(
    dirName,
    keepIds,
    file.sessions,
    domainStore?.available ? domainStore.entries() : undefined,
  )

  if (toMark.size === 0) return []

  // 域侧施加（异步 fire-and-forget；失败只影响域，旧文件仍同步更新）
  if (domainStore?.available) {
    for (const id of toMark) {
      const raw = domainStore.get(id)
      if (!raw) continue
      void domainStore.put(id, toDomainRecord({ ...fromDomainRecord(raw), supersededAt: at })).catch(() => {})
    }
  }

  // 文件侧施加
  for (const id of toMark) {
    const rec = asBoundRecord(file.sessions[id])
    if (!rec) continue
    rec.supersededAt = at
    file.sessions[id] = rec
  }
  try {
    writeBindingsFile(path, file)
  } catch {
    /* 写盘失败不阻断主流程（与 appendBound 同款"尽力而为"口径）；
       域侧已施加成功的话语义仍达成，故**不**在此清空返回值以免谎报"什么都没做" */
  }
  return [...toMark].sort()
}

/**
 * **(c) 绑定一致性兜底**（S142 §0y，所有者 2026-09-18 裁「c 也算个兜底」）：
 * 删除指向**已不存在**的 dsh 会话的绑定记录。
 *
 * 为什么需要：`.bindings.json` **只增不清**，而 DSH 会话目录会被
 * `session-cleanup`（本仓既有机制）物理删除 ⇒ 表里必然残留**悬空 id**。
 * 悬空记录本身无害，但它会**污染反向索引**（`listBoundSessionIds` 是唤醒选人的唯一入口），
 * 让"这条轨迹到底还有没有可用会话"变得不可判。
 *
 * 🔴 **安全性由调用方的判据负责**（本函数是纯函数，不认识文件系统）：
 * `isMissing` 必须是 **fail-closed** 的（读不到 ⇒ 返回 false = "不当作缺失"），
 * 见 `hasSessionLogById`。判据写错会**清掉整张表**，故此处刻意不提供默认实现。
 *
 * @param root CCC 根
 * @param isMissing 判据：该会话 id 是否**确认**已不存在（false = 保留）
 * @returns 被删除的会话 id（升序稳定；未删任何一条 → `[]`）
 */
export function pruneMissingBindings(
  root: string,
  isMissing: (sessionId: string) => boolean,
): string[] {
  const path = join(root, BINDINGS_REL_PATH)
  const file = readBindingsFile(path)

  // 🔴 与 supersedeOtherBindings 同款修正（同一实测缺陷族，2026-09-19）：
  // 返回值必须取**域 ∪ 文件的并集**，否则"只在域里"的悬空记录虽被删掉，
  // 但调用方看到 `[]` ⇒ 回报不出 `prunedBindings`（静默）。
  const toRemove = new Set<string>()
  const judge = (id: string): boolean => {
    try {
      return isMissing(id)
    } catch {
      return false // 判据自身出错 ⇒ 保留（fail-closed）
    }
  }

  if (domainStore?.available) {
    for (const [id] of domainStore.entries()) {
      if (judge(id)) toRemove.add(id)
    }
  }
  for (const id of Object.keys(file.sessions)) {
    if (judge(id)) toRemove.add(id)
  }

  if (toRemove.size === 0) return []

  // 域侧删除（异步；判据已在上一步统一判过，fail-closed 语义已落实）
  if (domainStore?.available) {
    for (const id of toRemove) {
      void domainStore.delete(id).catch(() => {})
    }
  }
  // 文件侧删除
  for (const id of toRemove) {
    delete file.sessions[id]
  }
  try {
    writeBindingsFile(path, file)
  } catch {
    /* 写盘失败不阻断主流程；域侧已删的话语义仍达成，故不清空返回值以免谎报 */
  }
  return [...toRemove].sort()
}

/**
 * 写入绑定（latest-wins 覆盖该会话记录）。
 *
 * 绑定持久化尽力而为：无法定位 CCC 根 / 无会话 id / 写盘失败 → 返回 false，不阻断主流程。
 *
 * 🔴 **同时是「只留一条」（D69）的唯一写入口**（2026-09-21 起）：每写一条，就在**同一次 RMW** 里
 * 把同轨迹的**其它**条标 `supersededAt`（自己除外）。⇒ 任何调用路径（`create`/`activate`/`switch`/
 * `rebuild`/`reconcile`）**都自动满足"只留一条"**，调用方**不需要**（也**不应当**）自己算 selfId。
 *
 * @param session 目标 dsh 会话（需 `header.id` + `header.cwd` 可定位 CCC 根）
 * @param action 绑定动作
 * @param rec 绑定记录（dirName + mdPath 必填；sessionId 可选展示码）
 */
export function appendBound(
  session: unknown,
  action: SessionBoundAction,
  rec: { dirName: string; mdPath: string; sessionId?: string; note?: string },
): boolean {
  const path = bindingsPathFor(session)
  const id = sessionHeader(session)?.id
  if (typeof id !== 'string') return false
  const record: SessionBoundRecord = {
    dirName: rec.dirName,
    mdPath: rec.mdPath,
    ...(rec.sessionId ? { sessionId: rec.sessionId } : {}),
    action,
    at: Date.now(),
    ...(rec.note ? { note: rec.note } : {}),
  }

  // §0L 双写：域（权威，异步落盘 fire-and-forget）+ 旧文件（兜底，同步）。
  // 为什么域写**不 await**：本函数是同步签名（10 个调用点依赖），且绑定的可靠性由
  // "旧文件同步写成功" 保底——域写失败只损失"新载体"，不损失绑定本身。
  if (domainStore?.available) {
    void domainStore.put(id, toDomainRecord(record)).catch(() => {
      /* 域写失败静默：旧文件已写，绑定不丢 */
    })
  }

  // 旧文件兜底写（**永久保留**：owner「向前兼容」的第二道保险）
  if (!path) return domainStore?.available === true
  try {
    const file = readBindingsFile(path)
    file.sessions[id] = record
    // 🔴 **「只留一条」收进本单一入口**（2026-09-21 修 F1/F2）：
    //   在同**一次 RMW** 里把同轨迹的**其它**条标 `supersededAt`（自己排除在外）。
    //
    //   为什么收进来（而不是让调用方再调一次 `supersedeOtherBindings`）——两个真缺陷（§7.4）：
    //    · **F1（多退）**：调用方要自己算 selfId，而 `use` 路径拿到的 dsh 会话对象是**只带
    //      `append` 的包装** ⇒ 读 `.header.id` **恒为 `''`** ⇒ 保留集为空 ⇒ 把**自己刚写的那条**
    //      也标掉 ⇒ 该轨迹**瞬间零可用绑定** ⇒ 唤醒 / `send-now` / `send-later` 全部报
    //      「无绑定会话记录」。**本函数自己就持有 `id`** ⇒ 判据在这里是天然的，不需要调用方传。
    //    · **F2（少退）**：`rebuild` 换代**根本不调用**退休 ⇒ 旧载体永不退休、多载体堆积
    //      （正是 D69 要消灭的"两条 live 各持一份上下文 + 双写者"）。收进入口 ⇒
    //      `create` / `activate` / `switch` / `rebuild` / `reconcile` **全部路径一致生效**。
    //
    //   ⚠️ 必须并入**同一次** load→modify→save：再调一次 `supersedeOtherBindings` 会
    //      二次读盘/写盘 + 域侧二次 `put`（本仓既有教训：**RMW 无锁 ⇒ 别自造丢更新窗口**）。
    const targets = collectSupersedeTargets(
      rec.dirName,
      new Set([id]),
      file.sessions,
      domainStore?.available ? domainStore.entries() : undefined,
    )
    for (const other of targets) {
      const otherRec = asBoundRecord(file.sessions[other])
      // 只存在于域侧的条目：文件侧无行可标，交给下面的域侧分支
      if (!otherRec) continue
      otherRec.supersededAt = record.at
      file.sessions[other] = otherRec
    }
    writeBindingsFile(path, file)
    // 域侧退休：与自身那条**同口径**（fire-and-forget；失败静默——旧文件侧语义已达成）
    if (domainStore?.available) {
      for (const other of targets) {
        const raw = domainStore.get(other)
        if (!raw) continue
        void domainStore
          .put(other, toDomainRecord({ ...fromDomainRecord(raw), supersededAt: record.at }))
          .catch(() => {})
      }
    }
    return true
  } catch {
    /* 写盘失败（权限/磁盘）不阻断主流程——绑定持久化尽力而为 */
    return domainStore?.available === true
  }
}
