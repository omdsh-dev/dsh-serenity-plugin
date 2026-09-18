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
 * 读取会话当前绑定（权威，latest-wins）：文件记录优先，无则回落旧事件形态。
 * 无绑定返回 null。
 */
export function readLastBound(session: unknown): SessionBoundRecord | null {
  const path = bindingsPathFor(session)
  const id = sessionHeader(session)?.id
  if (path && typeof id === 'string') {
    const rec = asBoundRecord(readBindingsFile(path).sessions[id])
    if (rec) return rec
  }
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
  const file = readBindingsFile(join(root, BINDINGS_REL_PATH))
  const hits: Array<{ id: string; at: number }> = []
  for (const [id, raw] of Object.entries(file.sessions)) {
    const rec = asBoundRecord(raw)
    if (!rec || rec.dirName !== dirName) continue
    // (b) 守卫：已被取代的绑定**不再作为唤醒候选**（记录仍在 → 沿革与正向查询不受影响）
    if (rec.supersededAt !== undefined) continue
    hits.push({ id, at: typeof rec.at === 'number' ? rec.at : 0 })
  }
  return hits.sort((a, b) => b.at - a.at).map((h) => h.id)
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
  const marked: string[] = []
  const at = Date.now()
  for (const [id, raw] of Object.entries(file.sessions)) {
    const rec = asBoundRecord(raw)
    if (!rec || rec.dirName !== dirName) continue
    if (keepIds.has(id) || rec.supersededAt !== undefined) continue
    rec.supersededAt = at
    file.sessions[id] = rec
    marked.push(id)
  }
  if (marked.length === 0) return []
  try {
    writeBindingsFile(path, file)
  } catch {
    return [] // 写盘失败不阻断主流程（与 appendBound 同款"尽力而为"口径）
  }
  return marked.sort()
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
  const removed: string[] = []
  for (const id of Object.keys(file.sessions)) {
    let missing: boolean
    try {
      missing = isMissing(id)
    } catch {
      continue // 判据自身出错 ⇒ 保留（fail-closed）
    }
    if (!missing) continue
    delete file.sessions[id]
    removed.push(id)
  }
  if (removed.length === 0) return []
  try {
    writeBindingsFile(path, file)
  } catch {
    return []
  }
  return removed.sort()
}

/**
 * 写入绑定（latest-wins 覆盖该会话记录）。
 *
 * 绑定持久化尽力而为：无法定位 CCC 根 / 无会话 id / 写盘失败 → 返回 false，不阻断主流程。
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
  if (!path || typeof id !== 'string') return false
  try {
    const file = readBindingsFile(path)
    file.sessions[id] = {
      dirName: rec.dirName,
      mdPath: rec.mdPath,
      ...(rec.sessionId ? { sessionId: rec.sessionId } : {}),
      action,
      at: Date.now(),
      ...(rec.note ? { note: rec.note } : {}),
    }
    writeBindingsFile(path, file)
    return true
  } catch {
    /* 写盘失败（权限/磁盘）不阻断主流程——绑定持久化尽力而为 */
    return false
  }
}
