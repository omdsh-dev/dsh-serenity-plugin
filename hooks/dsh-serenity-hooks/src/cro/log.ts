/**
 * cro/log.ts — CRO 唤起日志（**ACC 侧**，每轨迹一份固定名文件，2026-09-20 S142 §7.16）
 *
 * ## 所有者令（本模块的存在理由）
 *
 * 「S151 和 S185 的验证都说明，认知轨迹倾向于自己做个结构化记录来记录自身 CRO 的执行情况，
 * 这是个结构化流水账；**我们 ACC 有必要进行 CRO 唤醒的日志记录**，当 CRO 存在时，每次**成功唤醒**
 * 写相关信息，但是保留数量要少，**只保留仅两日**的记录即可，**这个时间是程序化的**」
 * ＋「**这个日志写结构化文件到认知轨迹目录，文件名固定即可**」
 * ＋「**失败成功都记录**」。
 *
 * ## 它解决什么麻烦（白话）
 *
 * 在此之前「ACC 到底叫过谁、叫了几次、哪次**没叫成**」**ACC 自己一个字都不留** ——
 * 要查只能去读**被叫的那个程序**写的记录；程序没写 / 写坏 / 被换掉 ⇒ **这段历史就是空白**。
 * ⇒ 本模块让 ACC **自己那一侧**留一份只记两天的流水，使「唤起历史」**不再依赖被观测者是否老实**。
 *
 * ## 🔴 为什么**不是**第二真相源（本容器铁律，勿删此论证）
 *
 * 轨迹目录里因此**并排两个文件、主语各一**：
 *
 * | 文件 | 谁写 | 主语 | 回答 |
 * |---|---|---|---|
 * | `<轨迹目录>/cro-state.json`（CCC 侧程序自建，名字自定） | **CCC 的 CRO 程序** | 程序 | 「**我判了什么**」（含"没叫"的判定、心跳阈值、环境谓词） |
 * | `<轨迹目录>/cro-wake-log.log`（**本模块**） | **ACC** | ACC | 「**我把什么送出去了、送成没有**」 |
 *
 * **内容不重叠**：本模块**不复制**判定细节（不存 `lastDecision` / 阈值 / 谓词）；
 * 而程序**不可能**知道投递结果（CRO 投递是 fire-and-forget）。
 * ⇒ 两者**互补**：完整审计 = 两者合看（本模块 = 投递面｜程序状态 = 判定面）。
 *
 * ## 🔴 形态 = 纯文本行，不是 JSON（owner 2026-10-19 裁 Q1）
 *
 * owner 原话：「**日志不要写 json，不合适，日志直接写纯文本 `.log` 就行**」。
 * ⇒ 一行一条，**tab 分隔**（终端里按制表位对齐，`grep` / `cut` / `awk` 直接可用）：
 *
 * ```text
 * # ACC CRO 唤起流水（纯文本 · tab 分隔 · 时间 / 结果 / tick / 方式 / 理由 / 提示词摘要）
 * 2026-10-19T22:15:03+08:00	ok	tick=82	已投递（live）	reason=心跳：距上次 44m	prompt=17:请先整理你的 SESSION.md
 * ```
 *
 * 🔴 **`#` 开头是注释 / 表头行，解析时跳过** —— 纯文本档案缺了表头，下一个人（或半年后的我）
 * 打开只看到一堆制表符，那是把 R 推给读者。
 * 🔴 **坏行跳过而非报错**（与 JSON 版的 `asEntry()` 同口径）：手改 / 半行 / 截断都不得让整档失效。
 *
 * ## 🔴 两代并读（**不硬切**，本容器反复栽过的形态）
 *
 * 旧名 `cro-wake-log.json` **仍然读**（存量轨迹里可能正有那份）；
 * **只写新 `.log`**。读侧判据 = **「新档在就只读新档，否则回落旧档」**。
 *
 * 🔴 **首次写入 = 迁移，不是覆盖**：那一刻 `loadCroWakeLog` 读到的仍是旧档条目，
 * 它们与新条目一起过裁剪、一起落进新档 ⇒ **窗内的旧记录不会凭空消失**；
 * 而旧档此后不再被读（新档已在）⇒ **不会重复计入**，也不需要删除动作。
 * ⚠️ 这条**只能靠读源码知道**（写出来的档看不出它继承过谁）⇒ 故在此明写。
 *
 * ## 🔴 轮转（所有者明示「程序化的」）
 *
 * **写入时按窗裁剪**：每次落盘只保留 `at >= now - CRO_LOG_RETENTION_MS` 的条目，
 * 随后**原子写**（`tmp + rename`，与 `wake/registry.ts` 同款形态）。
 * ⇒ 清理与写入**是同一笔操作** ⇒ **结构上不存在"忘了清"的可能**（比"另设一个每 tick 的清理步"更硬：
 * 那多一个"可能忘了跑"的面）。窗宽是**常量**，**无配置键、无人工清理动作**。
 *
 * ## 🔴 铁律（与 `cro/core.ts` 同族）
 *
 * **本模块的每个导出函数都不抛错**：写盘 / 裁剪 / 解析失败一律返回结构化失败，
 * 由调用方只记一行 tick 日志 ⇒ **CRO 流水的问题绝不影响投递与既有链路**（设计 §5）。
 *
 * ## 保留量级（实测，非估计）
 *
 * 实测最高 = S185 的 40min 心跳（≈36 条/天）；两天窗 ⇒ **≤ ~80 条、< 20 KB**。
 * 最坏（某程序每 5min 都叫）⇒ 288 条/天 ⇒ 两天 **≤ ~600 条、< 100 KB** —— 轮转**自带上限**。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { sessionsRoot } from '../trajectory/core.js'
import { isoLocal } from '../kernel/time.js'

/** 固定文件名（所有者令：「文件名固定即可」）——与程序自建的 `cro-state.json` 并排、主语分明 */
export const CRO_LOG_FILENAME = 'cro-wake-log.log'

/**
 * 🔴 **读取族 = 新名在前、旧名在后**（认族，不认"当前叫什么"）。
 *
 * 本容器已两次栽在"上游改名、下游写死旧名"：`skiff.json` → `trajectory-constraint.json` 那次，
 * 症状是「写不进去」，而真因是「文件名对不上」，两者在读数上完全不像。
 * ⇒ 上游再改名只往族里加一项。
 */
export const CRO_LOG_LEGACY_FILENAMES = ['cro-wake-log.json'] as const

/** 保留窗 = 2 日（所有者令「只保留仅两日」）；**常量** ⇒ 「这个时间是程序化的」 */
export const CRO_LOG_RETENTION_MS = 2 * 24 * 60 * 60 * 1000

/** 提示词摘要取前多少字（**只存摘要，不搬第二份全文**——全文属程序那侧的产物） */
export const CRO_PROMPT_HEAD_MAX = 80

/** 纯文本档案的表头行（解析时跳过；人打开时先看到它） */
export const CRO_LOG_HEADER =
  '# ACC CRO 唤起流水（纯文本 · tab 分隔 · 时间 / 结果 / tick / 方式 / 理由 / 提示词摘要）'

/** 一条唤起**尝试**（成功与失败**都记**，所有者令 2026-09-20） */
export interface CroWakeLogEntry {
  /** 时刻（当地 RFC3339 带偏移，遵 D67） */
  at: string
  /** 投递是否成功 */
  ok: boolean
  /**
   * 🔴 **"没送成、但这不算失败"**（`ok=false` 时才有意义）—— 2026-10-23 guard 实测逼出。
   *
   * 现状：宿主重启窗口里 `sessionController` 还没就绪 ⇒ 投递取不到载体 ⇒ `notReady`。
   * 那不是"投递失败"（下个 tick 会重试，且**每次都真的重试**），
   * 但也**不是"没发生"** —— 原先整条不落档 ⇒ 该轨迹的流水里**一个字都没有**
   * ⇒ 读日志的人无法区分「CRO 从没工作过」与「CRO 工作了、投递被挡住」。
   *
   * 🔴 **判据（D186 的又一次应用）**：可以不算失败，**但不许不出声**。
   * 三态因此显式分开：`ok` ／ `fail` ／ `not-ready`（`ok:false` ＋ `notReady:true`）。
   * ⛔ 不要把它折回 `ok:true`（那是假成功），也不要折成 `fail`（那是假失败，见 `:171` 语义）。
   */
  notReady?: true
  /**
   * 🔴 **"我判了，但决定不叫"**（`ok=false` 时才有意义）—— 2026-10-23 A102。
   *
   * 现状（修前）：`no-wake` 只累加调度器的一个计数，**一个字都不落本档**
   * ⇒ 该轨迹的流水**永久停在上一次真唤起处**。
   * ⇒ 于是 **「我判了、只是不叫」与「我根本没被评估」在读数上完全一样** ——
   *    实测：某轨迹的流水停在 `01:40`，owner 据此认为"守卫从那以后就没工作过"，
   *    而真相是它**此后每个 tick 都在被评估**，只是判定为"不打扰"。
   *
   * 🔴 **这是 D209 的同族第三条**，判据同源：**可以不出声地判"不打扰"，但"判过"本身要留痕**。
   * 四态因此显式分开：`ok` ／ `fail` ／ `not-ready` ／ `no-wake`。
   * ⛔ 不要把它折进 `ok`（那会让人以为"叫过了"），也不要折进 `fail`（它不是失败）。
   */
  noWake?: true
  /** 投递方式（`已投递（live）` / `已投递（冷载入）`）或失败原因 */
  detail: string
  /** 调度器 tick 计数（便于与 `acc-diag` ①b 对齐） */
  tick: number
  /** 程序自报理由；**取不到写 `null`，不留空白**（同 §4.5.4 纪律：留空白等于把缺口也丢了） */
  reason: string | null
  /** 唤起提示词**摘要**（长度 + 前 N 字） */
  promptDigest: { length: number; head: string }
}

/** 内存形态（**不再落盘**；读取器与裁剪器都吃它 ⇒ 换载体不改上层契约） */
export interface CroWakeLog {
  version: number
  entries: CroWakeLogEntry[]
}

/** 追加所需的输入（`at` 由本模块按当地时区生成，不劳调用方） */
export interface CroWakeLogInput {
  ok: boolean
  /** 🔴 `true` ⇒ 记作 `not-ready`（没送成，但**不算失败**）。见 {@link CroWakeLogEntry.notReady} */
  notReady?: boolean
  /** 🔴 `true` ⇒ 记作 `no-wake`（**判了、但不叫**，不是失败）。见 {@link CroWakeLogEntry.noWake} */
  noWake?: boolean
  detail: string
  tick: number
  reason: string | null
  /** 唤起提示词原文（本模块只留摘要） */
  prompt?: string
}

/** 日志绝对路径（**写入目标** = 新名） */
export function croWakeLogPath(root: string, dirName: string): string {
  return join(sessionsRoot(root), dirName, CRO_LOG_FILENAME)
}

/** 旧档绝对路径（**只读**，用于两代并读） */
export function croWakeLogLegacyPath(root: string, dirName: string, filename: string): string {
  return join(sessionsRoot(root), dirName, filename)
}

function emptyLog(): CroWakeLog {
  return { version: 1, entries: [] }
}

/**
 * 抹掉会破坏**行结构**的字符（tab / CR / LF）。
 *
 * 🔴 只抹这三个：它们是**分隔符**，混进来会让一行变成两行或错位；
 * 其余字符（`|`、`]`、中文标点）**原样保留** —— 那些是内容，抹了就是把 E 降了。
 */
function oneline(text: string): string {
  return text.replace(/[\t\r\n]+/g, ' ')
}

/** 一条记录 → 纯文本行（tab 分隔、字段带前缀便于人读） */
export function formatCroLogLine(entry: CroWakeLogEntry): string {
  const reason = entry.reason === null ? '' : oneline(entry.reason)
  const head = oneline(entry.promptDigest.head)
  return [
    oneline(entry.at),
    // 🔴 四态，不是两态：`ok` ／ `fail` ／ `not-ready` ／ `no-wake`。
    //    写成两态就会把 `notReady` 折进其中一边 —— 折进 ok 是假成功，折进 fail 是假失败。
    //    同理 `noWake`（判了但不叫）**既不是成功也不是失败**，必须独立成态：
    //    折进 ok ⇒ 读日志的人以为"叫过了"；折进 fail ⇒ 每次都像在报错（最坏：把真失败淹掉）。
    entry.ok ? 'ok' : entry.notReady === true ? 'not-ready' : entry.noWake === true ? 'no-wake' : 'fail',
    `tick=${entry.tick}`,
    oneline(entry.detail),
    `reason=${reason}`,
    `prompt=${entry.promptDigest.length}:${head}`,
  ].join('\t')
}

/**
 * 纯文本行 → 记录（**坏行返回 null 而不是抛**）。
 *
 * 判据：字段数不足 / 时间不可解析 / `ok` 标记不认识 ⇒ `null`（跳过该行，其余照读）。
 * 🔴 `at` 必须**可被 `Date.parse` 解析**才收 —— 那是裁剪的前提，
 * 收一条解析不了的时间等于让它在此档里永久驻留（轮转对它失效）。
 */
export function parseCroLogLine(line: string): CroWakeLogEntry | null {
  if (line === '' || line.startsWith('#')) return null
  const parts = line.split('\t')
  if (parts.length < 6) return null
  const at = parts[0]!
  if (Number.isNaN(Date.parse(at))) return null
  const mark = parts[1]
  // 🔴 **旧档只认识两态** ⇒ `not-ready`／`no-wake` 是**新增**取值，读侧必须同时认它们；
  //    不认的后果不是报错，而是**整行被当成坏行静默丢弃**（历史记录凭空消失，零信号）。
  if (mark !== 'ok' && mark !== 'fail' && mark !== 'not-ready' && mark !== 'no-wake') return null
  const tickM = /^tick=(\d+)$/.exec(parts[2]!)
  if (!tickM) return null
  const reasonRaw = parts[4]!.startsWith('reason=') ? parts[4]!.slice('reason='.length) : ''
  const promptM = /^prompt=(\d+):([\s\S]*)$/.exec(parts[5]!)
  return {
    at,
    ok: mark === 'ok',
    ...(mark === 'not-ready' ? { notReady: true as const } : {}),
    ...(mark === 'no-wake' ? { noWake: true as const } : {}),
    detail: parts[3]!,
    tick: Number(tickM[1]),
    // 空串 ⇒ null（与"取不到写 null，不留空白"同口径）
    reason: reasonRaw === '' ? null : reasonRaw,
    promptDigest: {
      length: promptM ? Number(promptM[1]) : 0,
      head: promptM ? promptM[2]! : '',
    },
  }
}

/** 全文 → 记录（跳过表头与坏行；**永不抛**） */
function parseCroLogText(text: string): CroWakeLogEntry[] {
  const entries: CroWakeLogEntry[] = []
  for (const line of text.split('\n')) {
    const e = parseCroLogLine(line)
    if (e) entries.push(e)
  }
  return entries
}

/** JSON 旧档 → 记录（字段缺失/类型不符 ⇒ 丢弃该条，不阻断整档） */
function parseCroLogJson(text: string): CroWakeLogEntry[] {
  const parsed = JSON.parse(text) as { entries?: unknown }
  const raw = Array.isArray(parsed.entries) ? parsed.entries : []
  const entries: CroWakeLogEntry[] = []
  for (const item of raw) {
    const e = asEntry(item)
    if (e) entries.push(e)
  }
  return entries
}

/** 旧档条目形状校验（容忍手改） */
function asEntry(value: unknown): CroWakeLogEntry | null {
  const e = value as Partial<CroWakeLogEntry> | null | undefined
  if (!e || typeof e !== 'object') return null
  if (typeof e.at !== 'string' || e.at === '') return null
  if (typeof e.ok !== 'boolean') return null
  if (typeof e.detail !== 'string') return null
  const digest = (e.promptDigest ?? {}) as { length?: unknown; head?: unknown }
  return {
    at: e.at,
    ok: e.ok,
    detail: e.detail,
    tick: typeof e.tick === 'number' ? e.tick : 0,
    reason: typeof e.reason === 'string' ? e.reason : null,
    promptDigest: {
      length: typeof digest.length === 'number' ? digest.length : 0,
      head: typeof digest.head === 'string' ? digest.head : '',
    },
  }
}

/** 提示词摘要（长度 + 前 N 字；超长不截断标记——长度字段本身就是信号） */
export function summarizeCroPrompt(prompt: string | undefined): { length: number; head: string } {
  const text = typeof prompt === 'string' ? prompt : ''
  return { length: [...text].length, head: [...text].slice(0, CRO_PROMPT_HEAD_MAX).join('') }
}

/**
 * 读取日志（**永不抛**；读坏 ⇒ 当作空档 + 返回 error 文本）。
 *
 * 🔴 **两代并读的判据**：新档在 ⇒ **只读新档**；否则按族回落旧档。
 * 这样首次写入之后旧档自然退场，**不需要删除动作、也不会重复计入**。
 *
 * @param root CCC 根
 * @param dirName 轨迹目录名
 */
export function loadCroWakeLog(root: string, dirName: string): { log: CroWakeLog; error: string | null } {
  const path = croWakeLogPath(root, dirName)
  if (existsSync(path)) {
    try {
      return { log: { version: 1, entries: parseCroLogText(readFileSync(path, 'utf-8')) }, error: null }
    } catch (err) {
      return { log: emptyLog(), error: `CRO 流水解析失败（${String((err as Error)?.message ?? err)}）` }
    }
  }
  for (const legacy of CRO_LOG_LEGACY_FILENAMES) {
    const legacyPath = croWakeLogLegacyPath(root, dirName, legacy)
    if (!existsSync(legacyPath)) continue
    try {
      return { log: { version: 1, entries: parseCroLogJson(readFileSync(legacyPath, 'utf-8')) }, error: null }
    } catch (err) {
      return { log: emptyLog(), error: `CRO 流水解析失败（${String((err as Error)?.message ?? err)}）` }
    }
  }
  return { log: emptyLog(), error: null }
}

/**
 * 按窗裁剪（**纯函数** ⇒ 可穷举测试）。
 *
 * 判据：`Date.parse(at) >= nowMs - windowMs` 保留；反之丢弃。
 * 🔴 **`at` 不可解析者一律丢弃**（本模块只写 `isoLocal()` 产物 ⇒ 不可解析 = 被手改或损坏），
 * **并在返回值里报数**（`dropped`）——**不静默吞掉**（本容器反复栽的"安静失败"纪律）。
 */
export function pruneCroLogEntries(
  entries: CroWakeLogEntry[],
  nowMs: number,
  windowMs: number = CRO_LOG_RETENTION_MS,
): { kept: CroWakeLogEntry[]; pruned: number; dropped: number } {
  const floor = nowMs - windowMs
  const kept: CroWakeLogEntry[] = []
  let pruned = 0
  let dropped = 0
  for (const e of entries) {
    const t = Date.parse(e.at)
    if (Number.isNaN(t)) {
      dropped += 1
      continue
    }
    if (t >= floor) kept.push(e)
    else pruned += 1
  }
  return { kept, pruned, dropped }
}

/** 记录集 → 落盘全文（表头 ＋ 逐行 ＋ 末尾换行） */
function renderCroLogText(entries: CroWakeLogEntry[]): string {
  const lines = [CRO_LOG_HEADER, ...entries.map(formatCroLogLine)]
  return `${lines.join('\n')}\n`
}

/**
 * 追加一条唤起记录并按窗裁剪（**本模块主入口；永不抛**）。
 *
 * 顺序 = 读 → 追加 → 裁剪 → **原子写**。任一步失败 ⇒ `{ok:false, error}`，
 * **不抛**（调用方只记一行 tick 日志；**绝不影响投递**）。
 *
 * 无 CRO 的轨迹**不会**因本函数产生文件：只有真的发生过一次唤起尝试才会建/写该档
 * （所有者令「**当 CRO 存在时**」）。
 *
 * @param root CCC 根
 * @param dirName 轨迹目录名
 * @param input 本次唤起尝试（成败都记）
 * @param nowMs 当前毫秒（可注入 ⇒ 便于测裁剪边界）
 * @returns 写入结果与裁剪计数
 */
export function appendCroWakeLog(
  root: string,
  dirName: string,
  input: CroWakeLogInput,
  nowMs: number = Date.now(),
): { ok: boolean; error: string | null; kept: number; pruned: number; dropped: number } {
  const path = croWakeLogPath(root, dirName)
  try {
    const loaded = loadCroWakeLog(root, dirName)
    const entry: CroWakeLogEntry = {
      at: isoLocal(nowMs),
      ok: input.ok,
      // 🔴 **这一行是 D209 的承重点**：接口加了 `notReady`、格式化也认了它，
      //    但若**构造 entry 时不搬过来**，它就在这一步被丢掉 ⇒ 永远落成 `fail`
      //    ⇒ 整个三态改动静默失效（本轮实测：测试红在 "expected undefined to be true"）。
      //    ⇒ 判据：**加一个可选字段，要同时改「类型 ＋ 构造 ＋ 格式化 ＋ 解析」四处**；
      //      少任何一处都不会报错，只会静默降级。
      ...(input.notReady === true ? { notReady: true as const } : {}),
      // 🔴 **A102 的承重点**：接口加了 `noWake`、格式化也认了它，
      //    但若**构造 entry 时不搬过来**，它就在这一步被丢掉 ⇒ 永远落成 `fail`
      //    ⇒ 整个改动静默失效（D209 那次正是漏在「构造」这一处）。
      ...(input.noWake === true ? { noWake: true as const } : {}),
      detail: input.detail,
      tick: input.tick,
      reason: input.reason,
      promptDigest: summarizeCroPrompt(input.prompt),
    }
    const { kept, pruned, dropped } = pruneCroLogEntries([...loaded.log.entries, entry], nowMs)
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, renderCroLogText(kept), 'utf-8')
    renameSync(tmp, path)
    return { ok: true, error: null, kept: kept.length, pruned, dropped }
  } catch (err) {
    return {
      ok: false,
      error: `CRO 流水写入失败（${String((err as Error)?.message ?? err)}）`,
      kept: 0,
      pruned: 0,
      dropped: 0,
    }
  }
}
