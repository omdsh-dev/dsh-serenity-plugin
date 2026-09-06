/**
 * session-bound.ts — SESSION 绑定持久化（serenity/bound 会话事件）
 *
 * 目标（S142 用户拍板，方案 v1.0）：让「dsh 会话（载体）↔ SESSION（宁静号轨迹）」
 * 的绑定坚固——LLM 不能因智力因素（幻觉/理解偏差）在过程中或 logbook rebuild 后
 * 自行更换 SESSION。
 *
 * 机制（DSH 原生，零改 harness）：
 *   `SessionEventMap` 是 merge-extensible（先例：dsh-compaction 扩展 compaction/*；
 *   dsp 已在 append compaction/prune）——插件可 declare module 自定义事件，
 *   `Session.append(type, data)` 将其写入会话 append-only 日志，随 session.jsonl
 *   持久化落盘，进程重启后 snapshotEvents() 可完整读取。
 *
 * 权威绑定 = 会话日志中**最后一条** `serenity/bound`（append-only latest-wins）。
 * 本事件是 log-only 元数据（无 surfaceOp——永不上模型可见面，不进系统提示词）。
 *
 * 编码无关（U4）：绑定锚 = **完整 AGENT_SESSIONS 目录名**（磁盘唯一存在），
 * sessionId（S###/apaas-xxx/自定义）仅是派生展示字段——绝不假设 S 前缀。
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionEventMap } from '@deepseek-ai/dsh-session/types'
import { sessionEvents } from './session-ops.js'

// ── 事件类型声明（merge-extensible）──

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Serenity SESSION binding — authoritative; appended on every binding change.
     * Code-agnostic (keyed by full dir name), log-only (no surfaceOp).
     */
    'serenity/bound': {
      /** Full AGENT_SESSIONS dir name — the ONLY hard identity. */
      dirName: string
      /** SESSION.md absolute path. */
      mdPath: string
      /** Display code when parseable (S142 / apaas-26116 / custom); informational. */
      sessionId?: string
      /** Why this binding record was written. */
      action: 'activate' | 'switch' | 'create' | 'rebuild' | 'reconcile' | 'release'
      /** Epoch ms. */
      at: number
      /** Optional reason (e.g. 'auto from title'). */
      note?: string
    }
  }
}

export type SessionBoundAction = SessionEventMap['serenity/bound']['action']

export interface SessionBoundRecord {
  dirName: string
  mdPath: string
  sessionId?: string
  action: SessionBoundAction
  at: number
  note?: string
}

/** 事件 type 常量（声明 + 读取共用） */
export const SESSION_BOUND_EVENT = 'serenity/bound' as const

// ── 纯读取（可单测）──

/** 事件形状归一（运行时数据经 session.append 深冻结，此处仅类型收窄） */
function asBoundEvent(e: unknown): SessionBoundRecord | null {
  const ev = e as { type?: unknown; data?: unknown } | null | undefined
  if (!ev || ev.type !== SESSION_BOUND_EVENT) return null
  const d = ev.data as SessionBoundRecord | null | undefined
  if (!d || typeof d.dirName !== 'string' || typeof d.mdPath !== 'string') return null
  return d
}

/**
 * 读取会话日志中**最后一条** `serenity/bound`（权威绑定，latest-wins）。
 * 尾到头扫描（时间序最新在后）；无 bound 事件返回 null。
 * 纯逻辑零 DSH 依赖（经 sessionEvents helper 读 snapshotEvents/events 兜底）。
 */
export function readLastBound(session: unknown): SessionBoundRecord | null {
  const events = sessionEvents<unknown>(session)
  for (let i = events.length - 1; i >= 0; i--) {
    const b = asBoundEvent(events[i])
    if (b) return b
  }
  return null
}

/**
 * 判定会话日志是否已有任何 bound 事件（供 reconcile 判定：无绑定才标题升级）。
 */
export function hasAnyBound(session: unknown): boolean {
  return readLastBound(session) !== null
}

// ── append（写入点调用）──

/**
 * append 一条 `serenity/bound` 绑定事件（log-only，无 surfaceOp——元数据不进模型可见面）。
 * @param session 目标 dsh 会话（真实 Session；append 泛型经内部断言兼容——类型由
 *   `serenity/bound` 声明面保证，append 接受已声明事件）
 * @param action 绑定动作
 * @param rec 绑定记录（dirName + mdPath 必填；sessionId 可选展示码）
 * @returns 是否成功（append 抛错/会话不可用时 false——绑定失败不阻断主流程）
 */
export function appendBound(
  session: Session | { append: (type: string, data: unknown) => unknown } | null | undefined,
  action: SessionBoundAction,
  rec: { dirName: string; mdPath: string; sessionId?: string; note?: string },
): boolean {
  if (!session || typeof (session as { append?: unknown }).append !== 'function') return false
  try {
    const append = (session as unknown as { append: (type: string, data: unknown) => unknown }).append
    append(SESSION_BOUND_EVENT, {
      dirName: rec.dirName,
      mdPath: rec.mdPath,
      ...(rec.sessionId ? { sessionId: rec.sessionId } : {}),
      action,
      at: Date.now(),
      ...(rec.note ? { note: rec.note } : {}),
    })
    return true
  } catch {
    /* append 失败（会话关闭/不可写）不阻断主流程——绑定持久化尽力而为 */
    return false
  }
}
