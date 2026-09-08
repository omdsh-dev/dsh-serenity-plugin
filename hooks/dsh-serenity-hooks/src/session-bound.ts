/**
 * session-bound.ts — SESSION 绑定持久化（CCC 内 `AGENT_SESSIONS/.bindings.json`）
 *
 * 目标（S142 用户拍板，方案 v1.0）：让「dsh 会话（载体）↔ SESSION（宁静号轨迹）」
 * 的绑定坚固——LLM 不能因智力因素（幻觉/理解偏差）在过程中或 logbook rebuild 后
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
import { findSerenityRoot } from './ccc.js'
import { sessionEvents } from './session-ops.js'

export type SessionBoundAction = 'activate' | 'switch' | 'create' | 'rebuild' | 'reconcile' | 'release'

export interface SessionBoundRecord {
  dirName: string
  mdPath: string
  sessionId?: string
  action: SessionBoundAction
  at: number
  note?: string
}

/** 旧形态事件类型（v1.29.1~v1.30.5 写入会话日志；v1.30.6 起只读不写——兼容存量绑定） */
export const SESSION_BOUND_EVENT = 'serenity/bound' as const

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
  const root = findSerenityRoot(header.cwd)
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
