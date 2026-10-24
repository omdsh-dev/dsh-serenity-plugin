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

/**
 * 每次从文件尾部读取的字节数。
 *
 * 🔴 **2026-10-24 从 1 MiB 提到 8 MiB**：与 `TAIL_EVENT_TARGET` 提到 400 配套。
 * 1 MiB 常常装不下 400 个事件（大 step 的 `tool/result` 单条就可几十 KB）——
 * 那样"要 400 个"只是愿望，实际被字节数截断（**两种上限里小的那个说了算**）。
 */
const TAIL_WINDOW_BYTES = 8 << 20 // 8 MiB

/**
 * 需要凑够的末尾事件数。
 *
 * 🔴🔴 **2026-10-24 从 60 提到 400 —— 这是"啥都扫不到"的直接成因（实测，不是估算）**。
 *
 * 原值 60 的前提是「`turn/end` + `step/end` + `end-seed` 三个事件就在尾部附近」——
 * 那个前提**在"轮内被打断"时完全不成立**：
 *   · 一轮跑到一半死掉 ⇒ 尾部全是 `tool/call` / `tool/result` / `assistant/message` / `step/start`，
 *     **一条 `turn/start`／`turn/end` 都凑不齐**；
 *   · 实测本机 10 个窗口内会话，**4 个**在 60 事件窗口里凑不到 `turn/start`
 *     （被误判成"没开轮"）⇒ 换成 400 事件**全部命中**（turn=56/105/192/24）。
 *   · 最坏一条：57 MB 的日志里，一个 step 就可能塞进几十个 `tool/call`。
 *
 * ⚠️ **这不是"调参"，是判据前提变了**：一旦允许"轮内任意位置中断"这个形态，
 *    尾部窗口就**必须**宽到能跨过一整轮的碎片。
 * 💰 成本：解压帧数上升（实测 6 会话 × 400 事件仍是**几十毫秒**量级）——
 *    用几十毫秒换"不再漏掉一整类"，划算。
 */
const TAIL_EVENT_TARGET = 400

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
  /**
   * 🔴 **命中形态**（D244 输出面，guard 2026-10-24 要的判别式 Y 的一半）。
   *
   * | 值 | 含义 | 末条 `turn/end` |
   * |---|---|---|
   * | `interrupted-end` | 形态 A：日志**有** `turn/end`，其 `reason.kind ∈ {interrupted, aborted}` | 存在，见 {@link lastTurnEndKind} |
   * | `unclosed` | 形态 B：**开了没收** —— 窗口内最后一条 `turn/start` 之后没有 `turn/end` | **可能不存在** |
   *
   * 🔴 **为什么必须暴露它**：调用方（如 guard 的守护程序）要能自己判「该不该注入」，
   * 而这两种形态的**可用判据完全不同** —— 形态 B 连"末条 turn/end 的 kind"都不存在。
   * 把决定权留在 ACC 里 = 让调用方没法自己躲开误注入（D237 同族：读数要能改变下一步）。
   */
  form: 'interrupted-end' | 'unclosed'
  /**
   * 形态 A：末条 `turn/end` 的 `reason.kind`；形态 B：**恒为 `null`**（那时没有末条 turn/end）。
   * ⚠️ `null` 在这里**承载语义**（"该格不存在"），不是"没读到"（D233 同族）——
   * 两种成因在读数上不同：形态 B 的 `form` 会是 `unclosed`。
   */
  lastTurnEndKind: string | null
  /**
   * 日志尾部窗口里**最后一条 `turn/start` 的轮号**；窗口内没有则 `null`。
   * 与 {@link turn} 对照可看出「窗口是否把这一轮的起点挤出去了」（A108 的现场判据）。
   */
  lastTurnStartTurn: number | null
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
  /**
   * 🔴🔴 **D245（2026-10-24）：被"在跑"排除掉的会话 id** —— 必须报告，不能静默跳过。
   *
   * **为什么这个字段是必需的**（真机实测，owner 报障「唤起了没有成功恢复」）：
   * 修前 `if (liveIds.has(sessionId)) continue` 是**静默**跳过 —— 既不计数也不报告。
   * 于是同一次扫描出现两个读数：
   * - 生产 tick 日志：`扫 11 个 · 排除在跑 4 个`（**知道**有 4 个被藏起来）
   * - 工具输出（guard 查的那个）：`检查 7 个 · 命中 0 · 跳过 7`（**完全看不到**那 4 个）
   * ⇒ guard 判「没事」⇒ 该救的没人救。
   *
   * ⇒ **判据（D237 同族）**：`scanned + excluded.size` 才是**窗口内总数**；
   *   只报 `scanned` 会让读者以为"就这么点会话"。
   * ⚠️ 这不是"多给一个诊断字段"——**它是"排除"这个动作的可见性**：
   *   任何"我替你把某些东西藏起来"的实现，都必须报告藏了几个、藏了谁。
   */
  excluded: string[]
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
 * 尾部窗口里**最后一条 `turn/start` 的轮号**（D244 输出面，给调用方做 A108 的现场判断）。
 *
 * ⚠️ 与 {@link detectUnclosedTurn} 不同：**它不判"是否未收尾"**，只**如实报告窗口里有什么**。
 * 分开的理由：前者是判据（会 deciding 命中），后者是读数（零判据风险）——
 * 把读数塞进判据函数，调用方就没法在"判据因为窗口截断而沉默"时看出**为什么**沉默。
 *
 * @returns 轮号；窗口内没有 `turn/start` 或轮号缺失 ⇒ `null`
 */
export function lastTurnStartTurnOf(events: SessionEvent[]): number | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'turn/start') {
      const t = events[i]?.data?.turn
      return typeof t === 'number' ? t : null
    }
  }
  return null
}

/**
 * 尾部窗口里**最后一条 `turn/end` 的 `reason.kind`**（同上：读数，不是判据）。
 * @returns kind；窗口内没有 `turn/end`（形态 B 的典型）或 kind 缺失 ⇒ `null`
 */
export function lastTurnEndKindOf(events: SessionEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'turn/end') {
      const k = events[i]?.data?.reason?.kind
      return typeof k === 'string' ? k : null
    }
  }
  return null
}

/**
 * 命中判定（**形态 A：靠 `turn/end.reason.kind`**）。
 *
 * ⚠️ **本函数刻意不判「开了没收」** —— 那种形态与「此刻正在跑」在日志读数上**不可分**，
 * 只有扫描层手里有 `liveIds`（正在跑的会话 id）才判得准。
 * ⇒ 分工：**本函数判"收尾原因"，`scanInterruptedSessions` 判"开了没收"**（见 `detectUnclosedTurn`）。
 * ⛔ 不要把这些情形塞进本函数 —— 会让它同时依赖"日志形态"与"进程状态"，那种判据无法单独证伪。
 *
 * @returns 命中时给出被中断的轮次与"可能有副作用"的工具名；不命中 null
 */
export function detectInterruptedEnd(events: SessionEvent[]): { turn: number | null; pendingTools: string[] } | null {
  if (events.length === 0) return null

  // 判据 1／2：找**最后一条** turn/end，要求它属于「没跑完」的取值域，且其后没有新的 turn/start。
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
  // 之后若又开了新轮 ⇒ 旧轮已封口、且新一轮由 `detectUnclosedTurn` 负责判
  for (let i = idx + 1; i < events.length; i++) {
    if (events[i]?.type === 'turn/start') return null
  }

  const turn = typeof turnEnd?.data?.turn === 'number' ? turnEnd.data.turn : null
  return { turn, pendingTools: findPendingTools(events, turn) }
}

/**
 * 命中判定（**形态 B：一轮开了却没收**）—— 🔴🔴 **2026-10-24 owner 报障的正解**。
 *
 * ## 为什么这一格以前整类漏掉
 *
 * 进程在**轮内任意位置**死掉时，宿主**永远没机会写 `turn/end`**
 * ⇒ 日志就停在 `tool/call` ／ `step/start` ／ `assistant/message` 上。
 * 修前 `detectInterruptedEnd` 首行是 `if (idx < 0) return null`（找不到 turn/end 就放弃）
 * ⇒ **这一整类被判成"没中断"**。
 *
 * ## 判据
 * **最后一条 `turn/start` 之后没有 `turn/end`** ⇒ 那一轮开了没收。
 *
 * ## 为什么必须由**扫描层**调用（而不是并进 `detectInterruptedEnd`）
 * 「开了没收」与「此刻正在跑」在**日志读数上完全一样**。
 * 唯一能分开它们的东西是 `liveIds`（宿主报的"此刻在跑的会话"）——
 * 而那是**扫描层**的参数，不是日志的属性。
 * ⇒ 本函数只回答"日志形态是不是开了没收"，**由调用方保证已排除在跑的会话**。
 * ⚠️ 判据纪律：两个不同的问题（日志形态 ／ 进程状态）**不许塞进同一个函数**，
 *    否则那个函数无法被单独证伪（改任一侧都可能让测试红，而说不清是哪侧错了）。
 *
 * @param events 尾部事件
 * @returns 命中时给出未收尾的轮次与"可能有副作用"的工具名；没有未收尾的轮次 ⇒ null
 */
export function detectUnclosedTurn(events: SessionEvent[]): { turn: number | null; pendingTools: string[] } | null {
  if (events.length === 0) return null

  let lastEnd = -1
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'turn/end') {
      lastEnd = i
      break
    }
  }
  // 最后一条 turn/start 必须晚于最后一条 turn/end
  let startIdx = -1
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'turn/start') {
      startIdx = i
      break
    }
  }
  if (startIdx < 0 || startIdx < lastEnd) return null

  /**
   * ⚠️ **不要拿 `session/end-seed` 当"已封口"判据**（我第一版这样写，当场被真机用例打红）。
   *
   * 真实日志里最常见的恢复形态就是
   *   `turn/end[interrupted] → session/end-seed → turn/start(新轮)`
   * —— `end-seed` 是**上一轮**的收尾标记，**不是新一轮的**。
   * 拿它判"新一轮已封口" ⇒ 会把「新一轮开了就死」误判成"已接续" ⇒ **又回到"啥都扫不到"**。
   *
   * ⇒ 判据保持最简：**最后一条 `turn/start` 是否晚于最后一条 `turn/end`**。
   *   "会不会重复拉起正在跑的会话"由 `liveIds` 负责（扫描层），不是本函数的事。
   */
  const t = events[startIdx]?.data?.turn
  const turn = typeof t === 'number' ? t : null
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

  const result: ScanResult = { sessions: [], scanned: 0, skipped: 0, errors: [], elapsedMs: 0, excluded: [] }

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
    // 🔴🔴 D245：排除**必须登记**，不能静默 continue（见 `ScanResult.excluded` 的注释）。
    //    ⚠️ 只登记**落在回看窗口内**的那些 —— 窗口外的会话本来就不在该关心，
    //    把它们也算进 excluded 会让「窗口内总数」这个读数失真。
    if (liveIds.has(sessionId)) {
      const lp = findSessionLog(join(projectDir, sessionId))
      if (lp !== null) {
        try {
          if (statSync(lp).mtimeMs >= cutoff) result.excluded.push(sessionId)
        } catch {
          /* 读不到 mtime ⇒ 不登记（它连"是不是窗口内"都判不了） */
        }
      }
      continue
    }

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
      /**
       * 🔴🔴 **两种形态都要接**（2026-10-24 owner 报障：「我要求你抓到非工具调用的中断，
       * 现在什么都抓不到了」）。
       *
       * - 形态 A `detectInterruptedEnd`：日志里有 `turn/end`，且它的 `reason.kind` 是
       *   `interrupted`（崩溃后被 resume 补收尾）／`aborted`（被正常终止）。
       * - 形态 B `detectUnclosedTurn`：**日志里压根没有 `turn/end`** —— 进程在轮内任意位置死掉，
       *   宿主没机会写收尾 ⇒ 日志停在 `tool/call` / `step/start` / `assistant/message`。
       *   ⚠️ **这一格必须靠"已排除在跑的会话"才成立**，而 `liveIds` 恰好在本函数手里
       *   （循环开头 `if (liveIds.has(sessionId)) continue`）⇒ 这就是它该待在这里、而不是
       *   并进 `detectInterruptedEnd` 的原因。
       *
       * 实测（本机 10 个窗口内会话）：**4 条**只能由形态 B 抓到（末条 `tool/call` / `step/start`），
       * 修前全落到 `skipped`。
       */
      const formA = detectInterruptedEnd(events)
      const formB = formA === null ? detectUnclosedTurn(events) : null
      const hit = formA ?? formB
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
        // 🔴 D244 输出面（guard 判别式 Y）：把「哪一形态」与「窗口里到底有什么」如实交出去，
        //   让调用方能自己判该不该注入 —— 而不是把这层判断藏在 ACC 里。
        form: formA !== null ? 'interrupted-end' : 'unclosed',
        lastTurnEndKind: lastTurnEndKindOf(events),
        lastTurnStartTurn: lastTurnStartTurnOf(events),
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
