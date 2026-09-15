/**
 * wake-registry.ts — trajectory 唤醒注册表（D58，S142 2026-09-13）
 *
 * 需求（用户原话）：一个 CCC 内允许多个 trajectory 任意形态并行；某个 trajectory 可以
 * **预定未来唤醒自己或别人**，本质上是一次「未来时刻 + 一条 message」的投递；「周期自唤醒」
 * 曾是它的特例（原 ACC autopilot / D59，该机制已于 2026-09-15 整段退场）。协作边界：
 * 互相可见、**无阻塞无等待**。
 *
 * 本模块只负责**注册表本身**（纯数据层，无宿主依赖，可单测）：
 *  - 落点：CCC 内 `AGENT_SESSIONS/wake-registry.json`（随 CCC git，人可读可审计）
 *  - 状态机：`pending` →（投递成功）`delivered`｜（超补跑窗口）`missed`｜（`wake rm` 物理移除）
 *  - 投递即终结：一次性，不重投（无回执语义——发起方不 await，见设计文档 §2）
 *
 * 调度与投递在 `wake-scheduler.ts`（需要 ctx），本模块保持纯净。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 注册表相对 CCC 根的路径（与 `.bindings.json` 同居 AGENT_SESSIONS/） */
const WAKE_REGISTRY_REL_PATH = 'AGENT_SESSIONS/wake-registry.json'

/** 注册表格式版本（结构变更时 +1；读取端只接受本版本） */
const WAKE_REGISTRY_VERSION = 1

/**
 * 补跑窗口（缺省 2h）：dsh 停机期间到期的条目，若迟到不超过本窗口则补投，
 * 超过则置 `missed` 留痕（不补投——避免"半夜该做的事早上突然连环跑"）。
 */
export const WAKE_CATCH_UP_MS = 2 * 60 * 60 * 1000

/** 条目状态：一次性唤醒只有这四种归宿 */
type WakeState = 'pending' | 'delivered' | 'missed' | 'cancelled'

/** 一条唤醒条目 */
export interface WakeEntry {
  /** 稳定 id（不复用；`w-<UTC 到分钟>-<4 hex>`） */
  id: string
  /** 目标 trajectory：`S###` 或完整 AGENT_SESSIONS 目录名（编码无关，与绑定锚一致） */
  target: string
  /** 绝对时刻（UTC RFC3339，如 `2026-09-14T01:00:00.000Z`） */
  at: string
  /** 唤醒 message（投递给目标 trajectory 的正文） */
  message: string
  /** 状态 */
  state: WakeState
  /** 发起者（轨迹标识，如 `S142`；可见性/审计用） */
  createdBy: string
  /** 登记时刻（UTC RFC3339） */
  createdAt: string
  /** 已尝试投递次数 */
  attempts: number
  /** 最近一次投递结果（人读；失败必须留痕——禁止静默） */
  lastResult: string | null
  /** 投递成功时刻（UTC RFC3339） */
  deliveredAt: string | null
}

/** 注册表文件形态 */
interface WakeRegistry {
  version: number
  entries: WakeEntry[]
}

/** 注册表绝对路径 */
export function wakeRegistryPath(root: string): string {
  return join(root, WAKE_REGISTRY_REL_PATH)
}

/** 空注册表 */
function emptyRegistry(): WakeRegistry {
  return { version: WAKE_REGISTRY_VERSION, entries: [] }
}

/** 条目形状校验（容忍手改：字段缺失/类型不符 → 丢弃该条，不阻断整表） */
function asEntry(value: unknown): WakeEntry | null {
  const e = value as Partial<WakeEntry> | null | undefined
  if (!e || typeof e.id !== 'string' || typeof e.target !== 'string') return null
  if (typeof e.at !== 'string' || typeof e.message !== 'string') return null
  const state = e.state === 'delivered' || e.state === 'missed' || e.state === 'cancelled' ? e.state : 'pending'
  return {
    id: e.id,
    target: e.target,
    at: e.at,
    message: e.message,
    state,
    createdBy: typeof e.createdBy === 'string' ? e.createdBy : '',
    createdAt: typeof e.createdAt === 'string' ? e.createdAt : '',
    attempts: typeof e.attempts === 'number' && Number.isFinite(e.attempts) ? e.attempts : 0,
    lastResult: typeof e.lastResult === 'string' ? e.lastResult : null,
    deliveredAt: typeof e.deliveredAt === 'string' ? e.deliveredAt : null,
  }
}

/**
 * 读注册表。文件缺失 → 空表；损坏 → 空表 + error（不抛错，调用方决定是否告警）。
 * @param root CCC 根
 * @returns 注册表与读取错误（无错为 null）
 */
export function loadWakeRegistry(root: string): { registry: WakeRegistry; error: string | null } {
  const path = wakeRegistryPath(root)
  if (!existsSync(path)) return { registry: emptyRegistry(), error: null }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<WakeRegistry>
    const raw = Array.isArray(parsed.entries) ? parsed.entries : []
    const entries: WakeEntry[] = []
    for (const item of raw) {
      const e = asEntry(item)
      if (e) entries.push(e)
    }
    return { registry: { version: WAKE_REGISTRY_VERSION, entries }, error: null }
  } catch (err) {
    return { registry: emptyRegistry(), error: `唤醒注册表解析失败（${String((err as Error)?.message ?? err)}）` }
  }
}

/** 原子写（tmp + rename；与 .bindings.json 同款形态） */
function saveWakeRegistry(root: string, registry: WakeRegistry): { ok: boolean; error: string | null } {
  const path = wakeRegistryPath(root)
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, `${JSON.stringify({ version: WAKE_REGISTRY_VERSION, entries: registry.entries }, null, 2)}\n`, 'utf-8')
    renameSync(tmp, path)
    return { ok: true, error: null }
  } catch (err) {
    return { ok: false, error: `唤醒注册表写入失败（${String((err as Error)?.message ?? err)}）` }
  }
}

/** 条目 id：`w-<UTC 到分钟>-<4 hex>`（可读 + 低碰撞；不复用由"物理移除"保证） */
export function newWakeId(nowMs: number, rand: () => number = Math.random): string {
  const iso = new Date(nowMs).toISOString()
  const stamp = `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 16).replace(':', '')}`
  const hex = Math.floor(rand() * 0x10000).toString(16).padStart(4, '0')
  return `w-${stamp}-${hex}`
}

/**
 * 解析唤醒时刻。接受两种写法（设计文档 §7）：
 *  - 绝对：RFC3339（含时区偏移，如 `2026-09-14T09:00:00+08:00`）
 *  - 相对：`+30m` / `+2h`（便于 agent 直接登记"半小时后"）
 * @param input 用户/agent 传入的时刻串
 * @param nowMs 当前时刻（相对写法基准）
 * @returns `{ ok, ms }` 或 `{ ok: false, error }`
 */
export function parseWakeAt(input: string, nowMs: number): { ok: true; ms: number } | { ok: false; error: string } {
  const raw = input.trim()
  if (raw === '') return { ok: false, error: '时刻为空' }
  const rel = /^\+(\d+(?:\.\d+)?)([mhd])$/.exec(raw)
  if (rel) {
    const n = Number(rel[1])
    const unit = rel[2]
    const mult = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000
    return { ok: true, ms: nowMs + n * mult }
  }
  const ms = Date.parse(raw)
  if (!Number.isFinite(ms)) return { ok: false, error: `时刻无法解析（须 RFC3339 或 +30m/+2h）: ${raw}` }
  return { ok: true, ms }
}

/**
 * 登记一条唤醒。
 * @param root CCC 根
 * @param input 目标 trajectory / 时刻串 / message / 发起者 / 当前时刻
 * @returns 成功返回条目，失败返回稳定错误文案（不抛错）
 */
export function addWake(
  root: string,
  input: { target: string; at: string; message: string; createdBy: string; nowMs: number },
): { ok: true; entry: WakeEntry } | { ok: false; error: string } {
  const target = input.target.trim()
  if (target === '') return { ok: false, error: 'target 为空（须 S### 或 AGENT_SESSIONS 目录名）' }
  const message = input.message.trim()
  if (message === '') return { ok: false, error: 'message 为空（唤醒必须携带一条信息）' }
  const parsed = parseWakeAt(input.at, input.nowMs)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  if (parsed.ms <= input.nowMs) return { ok: false, error: '时刻必须在未来（唤醒只允许可预期的未来）' }
  const { registry, error } = loadWakeRegistry(root)
  if (error) return { ok: false, error }
  const entry: WakeEntry = {
    id: newWakeId(input.nowMs),
    target,
    at: new Date(parsed.ms).toISOString(),
    message,
    state: 'pending',
    createdBy: input.createdBy,
    createdAt: new Date(input.nowMs).toISOString(),
    attempts: 0,
    lastResult: null,
    deliveredAt: null,
  }
  registry.entries.push(entry)
  const saved = saveWakeRegistry(root, registry)
  if (!saved.ok) return { ok: false, error: saved.error ?? '写入失败' }
  return { ok: true, entry }
}

/**
 * 物理移除一条（`wake rm`）。审计由 SESSION.md 与工具输出承担——注册表只保留在办项。
 * @param root CCC 根
 * @param id 条目 id
 * @returns 移除结果（不存在 → 稳定错误码文案）
 */
export function removeWake(root: string, id: string): { ok: boolean; error: string | null; removed: WakeEntry | null } {
  const { registry, error } = loadWakeRegistry(root)
  if (error) return { ok: false, error, removed: null }
  const idx = registry.entries.findIndex((e) => e.id === id)
  if (idx < 0) return { ok: false, error: `wake_not_found: ${id}`, removed: null }
  const [removed] = registry.entries.splice(idx, 1)
  const saved = saveWakeRegistry(root, registry)
  if (!saved.ok) return { ok: false, error: saved.error, removed: null }
  return { ok: true, error: null, removed: removed ?? null }
}

/**
 * 到期切分（纯函数，可单测）：
 *  - `due`：`state === 'pending'` 且 `now >= at`（在补跑窗口内）→ 应投递
 *  - `expired`：`state === 'pending'` 且 `now - at > catchUpMs` → 应置 missed（不投递）
 * @param registry 注册表
 * @param nowMs 当前时刻
 * @param catchUpMs 补跑窗口
 */
export function splitDueWakes(
  registry: WakeRegistry,
  nowMs: number,
  catchUpMs: number = WAKE_CATCH_UP_MS,
): { due: WakeEntry[]; expired: WakeEntry[] } {
  const due: WakeEntry[] = []
  const expired: WakeEntry[] = []
  for (const e of registry.entries) {
    if (e.state !== 'pending') continue
    const at = Date.parse(e.at)
    if (!Number.isFinite(at) || nowMs < at) continue
    if (nowMs - at > catchUpMs) expired.push(e)
    else due.push(e)
  }
  return { due, expired }
}

/**
 * 更新一条（状态推进；调用方给最终状态与结果文案）。
 * @param root CCC 根
 * @param id 条目 id
 * @param patch 要写入的字段
 * @returns 写入结果
 */
export function updateWake(
  root: string,
  id: string,
  patch: Partial<Pick<WakeEntry, 'state' | 'attempts' | 'lastResult' | 'deliveredAt'>>,
): { ok: boolean; error: string | null } {
  const { registry, error } = loadWakeRegistry(root)
  if (error) return { ok: false, error }
  const entry = registry.entries.find((e) => e.id === id)
  if (!entry) return { ok: false, error: `wake_not_found: ${id}` }
  Object.assign(entry, patch)
  return saveWakeRegistry(root, registry)
}

/** 列条目（默认全量；`pendingOnly` 只列在办项——面板/工具用） */
export function listWakes(root: string, opts: { pendingOnly?: boolean } = {}): { entries: WakeEntry[]; error: string | null } {
  const { registry, error } = loadWakeRegistry(root)
  const entries = opts.pendingOnly ? registry.entries.filter((e) => e.state === 'pending') : registry.entries
  return { entries: [...entries].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)), error }
}
