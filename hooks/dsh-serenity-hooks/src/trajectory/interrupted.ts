/**
 * 中断轮次发现（`interrupted` 会话扫描）
 *
 * ## 这个模块解决什么
 *
 * DSH 的会话日志里，**进程在某一轮完成前退出**（被 kill／崩溃／关机超时）时，
 * 宿主重放时会为该轮补上收尾事件：
 *
 * ```jsonl
 * turn/end {"turn":66,"reason":{"kind":"interrupted"}}
 * step/end {"turn":66,"step":85}
 * session/end-seed {}
 * ```
 *
 * 宿主**只补收尾，不续跑** —— 那一轮的工作就此停在那里。本模块负责把这些会话找出来，
 * 交给上层（认知轨迹）决定要不要续。
 *
 * ## 判据（三条同时成立，缺一不可）
 *
 * 1. 日志**最后一条事件是 `session/end-seed`** —— 这是"上一进程已结束、本进程重放"的标记；
 * 2. 该标记**之前最近的 `turn/end`** 的 `reason.kind === 'interrupted'`；
 * 3. `session/end-seed` 之后**没有新事件**（由判据 1 保证）。
 *
 * ⚠️ **为什么不能只看"存在过 interrupted"**：一个长会话历史上可能中断几十次
 * （本容器实测单会话 33 次）。只看"曾经中断"会把早已恢复的会话全部当成待续 ⇒ 灾难。
 *
 * ## 为什么不整文件解压
 *
 * DSH 日志是 **zstd 多帧追加**（实测单会话 24705 帧 / 47 MB）。原生
 * `zlib.zstdDecompressSync` 只解**第一帧**，对多帧直接报 `Unknown frame descriptor`。
 * ⇒ 采用**尾部窗口 + 倒序逐帧解压**：只读文件末尾 N 字节，从后往前找帧魔数，
 *    解到凑够所需事件数即停。实测 8h 窗口 6 个会话 **20 ms**。
 *
 * ## 世代识别复用 `cleanup.ts`
 *
 * 日志文件名有多个世代（`session.jsonl` / `session.v3.jsonl.zstd` / `session.v4.jsonl.zstd`…），
 * 宿主按世代写且**迁移保留源文件**。⇒ 本模块**不硬编码文件名**，走
 * {@link findSessionLog}（与清理／体积统计同一判据），避免"新世代对本模块不可见"。
 *
 * ## 边界
 *
 * - **只读**：不改任何会话日志。
 * - **不判周期**：何时扫、扫完做什么归调用方（CCC 的认知轨迹）。本模块只回答
 *   「此刻哪些会话以 interrupted 结尾」。
 */

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import * as nodeZlib from 'node:zlib'
import { findSessionLog } from './cleanup.js'

/**
 * zstd 解压（**运行时有、类型声明没有**）。
 *
 * 🔴 为什么不能用 `import { zstdDecompressSync } from 'node:zlib'`：
 * 本仓 `@types/node@^20` 的声明里**没有** zstd 系列（Node 22.15+ 才进声明）。
 * 而运行时本机 v22.22.1 **确实有**（实测 `typeof require('zlib').zstdDecompressSync === 'function'`）。
 * ⇒ 用命名空间导入 + 局部断言，并**在运行时校验**；缺失时走明确降级（返回空，不静默瞎猜）。
 */
const zstdDecompressSync: ((buf: Buffer) => Buffer) | undefined = (
  nodeZlib as unknown as { zstdDecompressSync?: (buf: Buffer) => Buffer }
).zstdDecompressSync

/** zstd 是否可用（不可用时扫描会返回"读不到事件"，而不是假装成功） */
export const ZSTD_AVAILABLE = typeof zstdDecompressSync === 'function'

/** zstd 帧魔数（小端 `28 B5 2F FD`） */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 默认回看窗口：8 小时（owner 2026-10-22 定） */
export const DEFAULT_LOOKBACK_MS = 8 * 60 * 60 * 1000

/** 每次从文件尾部读取的字节数（够覆盖数百个末尾事件） */
const TAIL_WINDOW_BYTES = 1 << 20 // 1 MiB

/** 需要凑够的末尾事件数（够跨过 turn/end + step/end + end-seed 即可，留余量） */
const TAIL_EVENT_TARGET = 60

/** 日志里被我们识别的事件形状（只取用得到的字段） */
interface SessionEvent {
  type?: string
  time?: number
  data?: { turn?: number; step?: number; reason?: { kind?: string } }
}

/** 一个"以 interrupted 结尾"的会话 */
export interface InterruptedSession {
  /** 会话目录名（= dsh 会话 id） */
  sessionId: string
  /** 日志绝对路径（当前世代） */
  logPath: string
  /** 被中断的轮次号 */
  turn: number | null
  /** 日志最后一条事件的时间（epoch ms，取不到则 null） */
  lastEventAt: number | null
  /** 日志文件 mtime（epoch ms） */
  mtimeMs: number
  /** 该轮里"有 call 无 result"的工具名（**尽力而为**，可能因尾部窗口截断而不全） */
  pendingTools: string[]
}

/** 扫描结果 */
export interface ScanResult {
  /** 以 interrupted 结尾的会话（最新在前） */
  sessions: InterruptedSession[]
  /** 窗口内实际检查的会话数 */
  scanned: number
  /** 窗口内但未命中（含正常结束）的会话数 */
  skipped: number
  /** 读取失败条目（诊断用，不阻断） */
  errors: Array<{ sessionId: string; message: string }>
  /** 扫描耗时（ms） */
  elapsedMs: number
}

/**
 * 从文件尾部倒序解压，凑够 `want` 个事件。
 *
 * 多帧 zstd 必须**按帧边界**切：从后往前找魔数，每帧用下一帧起始位置当结束边界。
 * 任何一帧解压失败就停下（返回已拿到的）—— 再往前更可能不完整。
 */
function readTailEvents(logPath: string, want: number): SessionEvent[] {
  if (zstdDecompressSync === undefined) return [] // 运行时无 zstd ⇒ 明确返回空（见 ZSTD_AVAILABLE）
  const st = statSync(logPath)
  const windowBytes = Math.min(TAIL_WINDOW_BYTES, st.size)
  if (windowBytes < 8) return []

  const buf = Buffer.alloc(windowBytes)
  const fd = openSync(logPath, 'r')
  try {
    readSync(fd, buf, 0, windowBytes, st.size - windowBytes)
  } finally {
    closeSync(fd)
  }

  const offsets: number[] = []
  for (let i = 0; i <= windowBytes - ZSTD_MAGIC.length; i++) {
    if (
      buf[i] === ZSTD_MAGIC[0] &&
      buf[i + 1] === ZSTD_MAGIC[1] &&
      buf[i + 2] === ZSTD_MAGIC[2] &&
      buf[i + 3] === ZSTD_MAGIC[3]
    ) {
      offsets.push(i)
    }
  }
  if (offsets.length === 0) return []

  const events: SessionEvent[] = []
  for (let k = offsets.length - 1; k >= 0 && events.length < want; k--) {
    const start = offsets[k]
    const end = k + 1 < offsets.length ? offsets[k + 1] : windowBytes
    let text: string
    try {
      text = zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
    } catch {
      break // 帧不完整／损坏 ⇒ 停止回扫；已拿到的仍是更新的
    }
    const batch: SessionEvent[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        batch.push(JSON.parse(line) as SessionEvent)
      } catch {
        /* 单行坏了不该让整个扫描失败 */
      }
    }
    events.unshift(...batch)
  }
  return events.slice(-want)
}

/**
 * 判定一组尾部事件是否「以 interrupted 结尾」。
 * 不命中 → null。
 */
export function detectInterruptedEnd(events: SessionEvent[]): { turn: number | null; pendingTools: string[] } | null {
  if (events.length === 0) return null

  // 判据 1：最后一条必须是 end-seed
  const last = events[events.length - 1]
  if (last?.type !== 'session/end-seed') return null

  // 判据 2：end-seed 之前最近的 turn/end 必须是 interrupted
  let turnEnd: SessionEvent | undefined
  for (let i = events.length - 2; i >= 0; i--) {
    if (events[i]?.type === 'turn/end') {
      turnEnd = events[i]
      break
    }
  }
  if (!turnEnd || turnEnd.data?.reason?.kind !== 'interrupted') return null

  const turn = typeof turnEnd.data?.turn === 'number' ? turnEnd.data.turn : null
  return { turn, pendingTools: findPendingTools(events, turn) }
}

/**
 * 找出末轮里发起了但没有结果的工具调用名。
 *
 * ⚠️ **尽力而为**，非权威：尾部窗口可能截断更早的调用。上层应把它当
 * "**可能**未完成的副作用"清单，而不是"确定未完成"。
 */
function findPendingTools(events: SessionEvent[], turn: number | null): string[] {
  if (turn === null) return []
  const called = new Map<string, string>()
  const resolved = new Set<string>()

  for (const e of events) {
    const data = e.data as { turn?: number; callId?: string; name?: string } | undefined
    if (!data || data.turn !== turn) continue
    if (e.type === 'tool/call' && typeof data.callId === 'string' && typeof data.name === 'string') {
      called.set(data.callId, data.name)
    } else if (e.type === 'tool/result' && typeof data.callId === 'string') {
      resolved.add(data.callId)
    }
  }
  return [...called].filter(([callId]) => !resolved.has(callId)).map(([, name]) => name)
}

/**
 * 扫描一个 **project 目录**（形如 `<sessions-root>/--home-yh-home-home-serenity--/`）。
 *
 * @param projectDir DSH 项目目录（其下每个子目录是一个会话）
 * @param options.lookbackMs 回看窗口（缺省 8h）
 * @param options.now 注入"当前时刻"（测试用）
 * @param options.liveIds 需要跳过的会话 id（正在跑的会话不该被判为待续）
 */
export function scanInterruptedSessions(
  projectDir: string,
  options: { lookbackMs?: number; now?: number; liveIds?: ReadonlySet<string> } = {},
): ScanResult {
  const t0 = Date.now()
  const lookbackMs = options.lookbackMs ?? DEFAULT_LOOKBACK_MS
  const now = options.now ?? Date.now()
  const cutoff = now - lookbackMs
  const liveIds = options.liveIds ?? new Set<string>()

  const result: ScanResult = { sessions: [], scanned: 0, skipped: 0, errors: [], elapsedMs: 0 }

  if (!existsSync(projectDir)) {
    result.elapsedMs = Date.now() - t0
    return result
  }

  let entries: string[]
  try {
    entries = readdirSync(projectDir)
  } catch (err) {
    result.errors.push({ sessionId: '*', message: err instanceof Error ? err.message : String(err) })
    result.elapsedMs = Date.now() - t0
    return result
  }

  for (const sessionId of entries) {
    if (liveIds.has(sessionId)) continue

    const dirPath = join(projectDir, sessionId)
    // 世代识别复用 cleanup 的判据（不硬编码文件名）
    const logPath = findSessionLog(dirPath)
    if (logPath === null) continue

    let mtimeMs: number
    try {
      mtimeMs = statSync(logPath).mtimeMs
    } catch (err) {
      result.errors.push({ sessionId, message: err instanceof Error ? err.message : String(err) })
      continue
    }
    if (mtimeMs < cutoff) continue // 回看窗口

    result.scanned++
    try {
      const events = readTailEvents(logPath, TAIL_EVENT_TARGET)
      const hit = detectInterruptedEnd(events)
      if (!hit) {
        result.skipped++
        continue
      }
      const tailTime = events[events.length - 1]?.time
      result.sessions.push({
        sessionId,
        logPath,
        turn: hit.turn,
        lastEventAt: typeof tailTime === 'number' ? tailTime : null,
        mtimeMs,
        pendingTools: hit.pendingTools,
      })
    } catch (err) {
      result.errors.push({ sessionId, message: err instanceof Error ? err.message : String(err) })
    }
  }

  result.sessions.sort((a, b) => (b.lastEventAt ?? b.mtimeMs) - (a.lastEventAt ?? a.mtimeMs))
  result.elapsedMs = Date.now() - t0
  return result
}

/**
 * 由 CCC 根推导它的 DSH 项目目录名（`--home-yh-home-home-serenity--`）。
 *
 * 规则取自宿主：把绝对路径的 `/` 换成 `-`，并在前后各加 `--`。
 * ⚠️ 这是**推导**，不是真相源 —— 实际目录名以磁盘为准；调用方应在不存在时
 * 回退到"扫整个 sessions root"或直接报未找到。
 */
export function projectDirNameForCwd(cwd: string): string {
  const normalized = cwd.replace(/\/+$/, '')
  return `--${normalized.split('/').filter(Boolean).join('-')}--`
}
