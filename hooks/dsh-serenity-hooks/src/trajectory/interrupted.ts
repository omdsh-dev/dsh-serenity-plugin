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
 * 1. 日志里**最后一条 `turn/end`** 的 `reason.kind` ∈ {@link UNFINISHED_KINDS}
 *    （= `interrupted` 崩溃补收尾 ／ `aborted` 正常终止，两者都是"这一轮没收完"）；
 * 2. 该 `turn/end` **之后没有新的 `turn/start`**（否则已被后续轮次接续）；
 * 3. ⛔ **不要求**末条是 `session/end-seed`（2026-10-23 放宽，原因见 {@link detectInterruptedEnd}）。
 *
 * 🔴 **2026-10-24 补入 `aborted`**：修前只认 `interrupted` ⇒「被正常终止」整类漏扫
 * （发布重启／换宿主最常见的形态）。判据问的是「这一轮收完了吗」，**不是"进程死得惨不惨"**。
 *
 * ⚠️ **为什么不能只看"存在过 interrupted"**：一个长会话历史上可能中断几十次
 * （本容器实测单会话 33 次）。只看"曾经中断"会把早已恢复的会话全部当成待续 ⇒ 灾难。
 *
 * 🔴 **为什么原判据要求"末条 = end-seed"是错的**（实测 26 条里漏 2 条）：
 * 重启后宿主会在 end-seed **之后**追加 `agent/inbox/spliced`（把待办消息重新塞进收件箱）
 * ⇒ "末条必须 end-seed"**在恢复动作发生之后就恒不成立**，
 * 而"被恢复过又再次被打断"恰恰是守护最该覆盖的形态。
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
 * 判定一组尾部事件是否「以未完成的轮次结尾」。
 * 不命中 → null。
 *
 * ## 🔴🔴 2026-10-24 判据放宽（owner 报障：「有的会话在重启时不是崩溃的就扫不到，还是没修好」）
 *
 * ### 漏的是什么（宿主源码实读，非推测）
 *
 * 宿主只有**两条**会写出「轮次没收完」的 `turn/end`，而它们的 `kind` **不是同一个词**：
 *
 * | 形态 | 写谁 | `reason.kind` | 修前是否命中 |
 * |---|---|---|---|
 * | 进程**崩溃**／被强杀，下一轮 resume 时补收尾 | `interruptedTurnClosers()` → `openTurnClosers(events,{kind:'interrupted'})` | **`interrupted`** | ✅ |
 * | 进程**正常退出**（`restart-web` 的 SIGTERM、`agent/disposed`、用户中断） | 驱动 catch 里 `abortedCancelCause(signal)` | **`aborted`** ＋ 内层 `reason:{kind:'user'\|'parent'\|'disposed'\|'hook'}` | ❌ **漏** |
 *
 * ⇒ 修前只认 `interrupted` ⇒ **「被正常终止」这一大类全部漏掉**，而它恰恰是
 * **发布重启／换宿主** 最常见的形态（比崩溃常见得多）。
 *
 * 🔴 **这两条是同一个状态的两种成因，不是"一个对一个不对"**：
 * 判据问的是「**这一轮有没有收完**」，不是「进程死得惨不惨」。
 * 拿死法当判据 ⇒ 换一种死法就漏一批（这正是 owner 反复看到的"还是没修好"）。
 *
 * ### 为什么不能只加 `aborted` 就完事
 * `aborted.reason.kind` 里还可能有 `hook`（宿主主动 hook 取消）——它同属"没跑完"。
 * ⇒ 本判据**只看外层 `kind`**，理由：外层已经回答了"这一轮收完了吗"，
 *   内层回答的是"谁让它停的"，**那是另一个问题**，混进来会让判据随"谁取消的"漂移。
 *
 * ### ⛔ 刻意**不**纳入的形态（保守边界，写明理由）
 * - `error`：本轮**收完了**（宿主记了错误收尾），它不是"停在这里等人续"；
 * - 完全没有 `turn/end` 的开轮（例如日志末尾是 `turn/start` 后再无事件）：
 *   那**也可能是"进程正活着、这一轮正在跑"**，与真中断在读数上不可分
 *   ⇒ 纳入会误唤醒在跑的会话。⚠️ 这是**已知边界**，不是遗漏。
 *
 * ### 为什么不会误报"曾经中断但已恢复"
 * 恢复一定伴随 `turn/start`（新一轮）或新的 `turn/end`（`completed` 等）⇒ 判据 1／2 各自挡住。
 */
/**
 * 「这一轮没跑完」的 `turn/end.reason.kind` 取值域。
 *
 * 🔴🔴 **2026-10-24（owner 报障）**：原判据只认 `'interrupted'` 一个词 ⇒
 * **「被正常终止」整类漏扫**。两个值对应的形态见 {@link detectInterruptedEnd} 的头注。
 *
 * ⚠️ **这是判据的唯一取值点** —— 别在别处再写一份字面量（两份会漂）。
 */
const UNFINISHED_KINDS: ReadonlySet<string> = new Set(['interrupted', 'aborted'])

/**
 * 命中判定。
 *
 * @returns 命中时给出被中断的轮次与"可能有副作用"的工具名；不命中 null
 */
export function detectInterruptedEnd(events: SessionEvent[]): { turn: number | null; pendingTools: string[] } | null {
  if (events.length === 0) return null

  // 🔴 判据 1／2：找**最后一条** turn/end，要求它属于「没跑完」的取值域，且其后没有新的 turn/start。
  //    ⛔ 不要退回"末条必须 end-seed"：那是载体形态判据，被恢复动作打破（见上方缺陷说明）。
  let idx = -1
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'turn/end') {
      idx = i
      break
    }
  }
  if (idx < 0) return null
  const turnEnd = events[idx]
  const kind = turnEnd?.data?.reason?.kind
  if (typeof kind !== 'string' || !UNFINISHED_KINDS.has(kind)) return null
  // 之后若又开了新轮 ⇒ 已被接续，不是"停在这里"
  for (let i = idx + 1; i < events.length; i++) {
    if (events[i]?.type === 'turn/start') return null
  }

  const turn = typeof turnEnd?.data?.turn === 'number' ? turnEnd.data.turn : null
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

// ── 续跑（continue-all-interrupted）────────────────────────────────────────

/** 单条续跑结果 */
export interface ResumeOutcome {
  sessionId: string
  /** 是否已把消息投进该会话 */
  ok: boolean
  /** 投递路径：live = 已在跑（直接注入）｜cold-resume = 冷载入后注入 */
  how?: string
  /** 失败原因 */
  error?: string
}

/**
 * 续跑正文（**简单、稳定、不含版本号**）。
 *
 * 判据（为什么这么短）：本动作的用途是**把被打断的会话推回工作状态**，
 * 不是替它重述任务 —— 被打断那一轮的上下文就在它自己的日志里。
 * ⇒ 正文只做三件事：① 说明发生了什么；② 提示**先核对副作用**；③ 让它接着做。
 *
 * 🔴 **为什么要写"先核对副作用"**：中断时可能有「有 call 无 result」的工具调用，
 * 它们的副作用**未知**（可能已写文件 / 已发消息）。若模型把那一轮整段重放，
 * 会**重复执行**。这句话是给模型的护栏，不是客套。
 */
export function buildContinueText(sessionId: string, turn: number | null, pendingTools: string[]): string {
  const lines: string[] = []
  lines.push('[中断续跑] 上一条进程在本轮完成前退出，该轮已被中止。现在继续。')
  lines.push('')
  lines.push(`会话: ${sessionId}${turn === null ? '' : ` ／ 被中断的轮次: turn ${turn}`}`)
  if (pendingTools.length > 0) {
    lines.push('')
    lines.push(`⚠️ 中断时这些工具「有调用、无结果」（副作用未知，**可能已经执行**）: ${pendingTools.join(', ')}`)
    lines.push('   ⇒ 先核对它们是否已生效（文件是否已写、消息是否已发），再决定要不要重做。')
    lines.push('   ⛔ 不要把被中断的那一轮整段重放。')
  }
  lines.push('')
  lines.push('请接着完成该轮未完成的工作；完成后把进展写入本轨迹的 SESSION.md。')
  return lines.join('\n')
}

/**
 * 把一个 agent 唤醒（注入一条续跑消息）。
 *
 * 两条路径（与 `wake/scheduler.ts` 的 `sendToCognitiveTrajectory` 同源判据）：
 * - **live**：`agents.get(id)` 拿得到 ⇒ 目标在跑（或被加载）⇒ `steer` 当场注入当前轮；
 *   `steer` 不可用则退回 `followup`（宁可排队，不可静默丢）。
 * - **cold-resume**：`sessionController.resolveAgent(id)` 冷载入后同样注入。
 *
 * ⚠️ 冷会话载入**会真起一个 agent**（消耗真实算力）⇒ 调用方必须自己决定要不要，
 * 本函数不做数量限制（那是策略，归调用者）。
 */
export function createResumeOne(deps: {
  agents: { get?: (id: string) => unknown } | undefined
  sessionController: { resolveAgent?: (id: string) => Promise<{ agent?: unknown; error?: string }> } | undefined
  makeMessage: (text: string) => unknown
}): (hit: { sessionId: string; turn: number | null; pendingTools: string[] }) => Promise<ResumeOutcome> {
  return async (hit) => {
    const { sessionId } = hit
    const text = buildContinueText(sessionId, hit.turn, hit.pendingTools)

    let agent: unknown
    let how: string

    // ① live 优先
    const live = deps.agents?.get?.(sessionId)
    if (live) {
      agent = live
      how = 'live'
    } else {
      // ② 冷恢复
      const sc = deps.sessionController
      const resolve = sc?.resolveAgent
      if (typeof resolve !== 'function' || sc === undefined) {
        return { sessionId, ok: false, error: '宿主 sessionController 不可用（重启启动窗口？）—— 稍后重试' }
      }
      try {
        const out = await resolve.call(sc, sessionId)
        if (!out?.agent) {
          return { sessionId, ok: false, error: `冷载入未返回 agent: ${String(out?.error ?? '未知原因')}` }
        }
        agent = out.agent
        how = 'cold-resume'
      } catch (err) {
        return { sessionId, ok: false, error: `冷载入失败: ${err instanceof Error ? err.message : String(err)}` }
      }
    }

    // ③ 注入：steer 优先（当场进当前轮），失败退回 followup（排队，不丢）
    const a = agent as { steer?: (m: unknown) => void; followup?: (m: unknown) => void; status?: string }
    try {
      if (typeof a.steer === 'function' && a.status === 'running') {
        a.steer(deps.makeMessage(text))
        return { sessionId, ok: true, how: `${how}+steer` }
      }
      if (typeof a.followup === 'function') {
        a.followup(deps.makeMessage(text))
        return { sessionId, ok: true, how: `${how}+followup` }
      }
      if (typeof a.steer === 'function') {
        a.steer(deps.makeMessage(text))
        return { sessionId, ok: true, how: `${how}+steer` }
      }
      return { sessionId, ok: false, how, error: 'agent 既无 steer 也无 followup（宿主契约漂移）' }
    } catch (err) {
      // steer 抛错 → 退 followup
      if (typeof a.followup === 'function') {
        try {
          a.followup(deps.makeMessage(text))
          return { sessionId, ok: true, how: `${how}+followup(steer 失败后退回)` }
        } catch (err2) {
          return { sessionId, ok: false, error: `steer 与 followup 均失败: ${String((err2 as Error)?.message ?? err2)}` }
        }
      }
      return { sessionId, ok: false, error: `注入失败: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
}
