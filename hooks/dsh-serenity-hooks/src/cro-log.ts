/**
 * cro-log.ts — CRO 唤起日志（**ACC 侧**，每轨迹一份固定名文件，2026-09-20 S142 §7.16）
 *
 * ## 所有者令（本模块的存在理由）
 *
 * 「S151 和 S185 的验证都说明，trajectory 倾向于自己做个结构化记录来记录自身 CRO 的执行情况，
 * 这是个结构化流水账；**我们 ACC 有必要进行 CRO 唤醒的日志记录**，当 CRO 存在时，每次**成功唤醒**
 * 写相关信息，但是保留数量要少，**只保留仅两日**的记录即可，**这个时间是程序化的**」
 * ＋「**这个日志写结构化文件到 trajectory 目录，文件名固定即可**」
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
 * | `<轨迹目录>/cro-wake-log.json`（**本模块**） | **ACC** | ACC | 「**我把什么送出去了、送成没有**」 |
 *
 * **内容不重叠**：本模块**不复制**判定细节（不存 `lastDecision` / 阈值 / 谓词）；
 * 而程序**不可能**知道投递结果（CRO 投递是 fire-and-forget）。
 * ⇒ 两者**互补**：完整审计 = 两者合看（本模块 = 投递面｜程序状态 = 判定面）。
 *
 * ## 🔴 轮转（所有者明示「程序化的」）
 *
 * **写入时按窗裁剪**：每次落盘只保留 `at >= now - CRO_LOG_RETENTION_MS` 的条目，
 * 随后**原子写**（`tmp + rename`，与 `wake-registry.ts` 同款形态）。
 * ⇒ 清理与写入**是同一笔操作** ⇒ **结构上不存在"忘了清"的可能**（比"另设一个每 tick 的清理步"更硬：
 * 那多一个"可能忘了跑"的面）。窗宽是**常量**，**无配置键、无人工清理动作**。
 *
 * ## 🔴 铁律（与 `cro.ts` 同族）
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
import { sessionsRoot } from './trajectory-ops.js'
import { isoLocal } from './time.js'

/** 固定文件名（所有者令：「文件名固定即可」）——与程序自建的 `cro-state.json` 并排、主语分明 */
export const CRO_LOG_FILENAME = 'cro-wake-log.json'

/** 保留窗 = 2 日（所有者令「只保留仅两日」）；**常量** ⇒ 「这个时间是程序化的」 */
export const CRO_LOG_RETENTION_MS = 2 * 24 * 60 * 60 * 1000

/** 提示词摘要取前多少字（**只存摘要，不搬第二份全文**——全文属程序那侧的产物） */
export const CRO_PROMPT_HEAD_MAX = 80

const CRO_LOG_VERSION = 1

/** 一条唤起**尝试**（成功与失败**都记**，所有者令 2026-09-20） */
export interface CroWakeLogEntry {
  /** 时刻（当地 RFC3339 带偏移，遵 D67） */
  at: string
  /** 投递是否成功 */
  ok: boolean
  /** 投递方式（`已投递（live）` / `已投递（冷载入）`）或失败原因 */
  detail: string
  /** 调度器 tick 计数（便于与 `acc-diag` ①b 对齐） */
  tick: number
  /** 程序自报理由；**取不到写 `null`，不留空白**（同 §4.5.4 纪律：留空白等于把缺口也丢了） */
  reason: string | null
  /** 唤起提示词**摘要**（长度 + 前 N 字） */
  promptDigest: { length: number; head: string }
}

/** 文件形态（与 `wake-registry.json` 同款：`{version, entries}`） */
export interface CroWakeLog {
  version: number
  entries: CroWakeLogEntry[]
}

/** 追加所需的输入（`at` 由本模块按当地时区生成，不劳调用方） */
export interface CroWakeLogInput {
  ok: boolean
  detail: string
  tick: number
  reason: string | null
  /** 唤起提示词原文（本模块只留摘要） */
  prompt?: string
}

/** 日志绝对路径 */
export function croWakeLogPath(root: string, dirName: string): string {
  return join(sessionsRoot(root), dirName, CRO_LOG_FILENAME)
}

function emptyLog(): CroWakeLog {
  return { version: CRO_LOG_VERSION, entries: [] }
}

/** 条目形状校验（容忍手改：字段缺失/类型不符 → 丢弃该条，不阻断整档） */
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
 * @param root CCC 根
 * @param dirName 轨迹目录名
 */
export function loadCroWakeLog(root: string, dirName: string): { log: CroWakeLog; error: string | null } {
  const path = croWakeLogPath(root, dirName)
  if (!existsSync(path)) return { log: emptyLog(), error: null }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<CroWakeLog>
    const raw = Array.isArray(parsed.entries) ? parsed.entries : []
    const entries: CroWakeLogEntry[] = []
    for (const item of raw) {
      const e = asEntry(item)
      if (e) entries.push(e)
    }
    return { log: { version: CRO_LOG_VERSION, entries }, error: null }
  } catch (err) {
    return { log: emptyLog(), error: `CRO 流水解析失败（${String((err as Error)?.message ?? err)}）` }
  }
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
      detail: input.detail,
      tick: input.tick,
      reason: input.reason,
      promptDigest: summarizeCroPrompt(input.prompt),
    }
    const { kept, pruned, dropped } = pruneCroLogEntries([...loaded.log.entries, entry], nowMs)
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, `${JSON.stringify({ version: CRO_LOG_VERSION, entries: kept }, null, 2)}\n`, 'utf-8')
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
