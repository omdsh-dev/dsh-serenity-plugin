/**
 * usage-stats.ts — ACC 用量统计（**skill 加载次数** ＋ **MSM 执行次数**；落该 CCC 的 `_tmp`）
 *
 * ## 所有者令（本模块的存在理由）
 *
 * 「我需要对 ACC 增加一个统计功能，包括 **skill 加载次数统计，msm 执行次数统计**；
 *  要求这个统计**自动生成在 CCC 的 `_tmp` 内的指定文件**」
 * ＋（对齐时确认）「**skill 加载**两个口径**都记、用字段区分**」「**只记名字、不记参数**」
 * 「**重启后读旧文件续算**」。
 *
 * ## 它解决什么麻烦（白话）
 *
 * 在此之前，「**哪些 skill 真的被加载过、哪些 MSM 真的在跑**」在 ACC 侧**一个数都没有** ——
 * 要判断「这东西还有人用吗」，只能靠翻会话记录**猜**。
 * ⇒ 本模块让每个 CCC 留下一份**纯计数**账本：**用了哪个、多少次、第一次和最近一次是什么时候**。
 * 用途 = 清理/精简的**依据**（没有人用的东西与天天在用的东西，不再靠猜）。
 *
 * ## 🔴 铁律（与 `cro-log.ts` 同族）
 *
 * **本模块每个导出函数都不抛错**：读盘 / 解析 / 写盘失败一律返回结构化失败，
 * 由调用方只记一行日志（或什么都不做）⇒ **统计的问题绝不影响工具执行与既有链路**。
 * 调用点在 `tools/post-execute` 的中途 ⇒ **更不能抛**（否则等于用统计打断会话）。
 *
 * ## 🔴 只记名字（所有者令；也是本模块唯一的"不入盘"约束）
 *
 * **绝不写 `arguments`**：MSM 参数里可能有凭据 / 路径 / 正文。
 * ⇒ 本模块只保留**计数键**（skill 名 / MSM 名），并对其做**长度与数量上限**（见常量），
 * 使文件规模**结构上有界**（不需要轮转，也不会被异常名字撑爆）。
 *
 * ## 🔴 重启后必须续算（所有者令）
 *
 * 宿主会被重启（本容器实测 24h 内 3 次）⇒ 计数**不能只活在内存里**：
 * 每次写盘 = **读旧文件 → 在旧值上自增 → 原子写**（`tmp + rename`，与 `wake-registry.ts` /
 * `cro-log.ts` 同款形态）⇒ **进程重启后计数自然延续**，无需额外的 flush/落盘时机。
 *
 * ## 口径（两个字段，勿合并）
 *
 * | 字段 | 含义 | 喂它的地方 |
 * |---|---|---|
 * | `skill.loads` | 模型**主动**调宿主 `skill` 工具（把某 skill 的 `SKILL.md` 全文载入） | `tools/post-execute`（工具名 = `skill`） |
 * | `skill.injections` | ACC **每请求注入**的 skill 段（`trajectory.skills` / 轨迹 frontmatter 声明） | `seams/system-prompt.ts` 的 trajectory-skills section 求值回调 |
 * | `msm` | `msm` 工具的一次执行，按 **MSM 名**分桶 | `tools/post-execute`（工具名 = `msm`） |
 *
 * 🔴 **两者差好几个数量级**：`loads` 是模型的**动作**（稀疏），`injections` 是**请求的属性**（稠密）。
 * 合并成一个数就**再也读不出**「这个 skill 是被人主动用的，还是只是被配上了」。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isoLocal } from './time.js'

/** 落点目录（所有者令：CCC 的 `_tmp` 内） */
export const USAGE_STATS_SUBDIR = '_tmp'

/** 固定文件名（所有者令「指定文件」；对齐时我取的名字，owner 未反对 ⇒ 定为常量） */
export const USAGE_STATS_FILENAME = 'acc-usage.json'

/** 单个计数的形态 */
export interface UsageCounter {
  /** 累计次数 */
  count: number
  /** 首次计入时刻（当地 RFC3339 带偏移，遵 D67） */
  firstAt: string
  /** 最近一次计入时刻 */
  lastAt: string
}

/** 文件形态（`{version, updatedAt, skill:{loads,injections}, msm}`） */
export interface UsageStats {
  version: number
  /** 最近一次写盘时刻 */
  updatedAt: string
  skill: {
    /** 模型主动调 `skill` 工具（全文载入） */
    loads: Record<string, UsageCounter>
    /** ACC 每请求注入的 skill 段 */
    injections: Record<string, UsageCounter>
  }
  /** 按 MSM 名分桶的执行次数 */
  msm: Record<string, UsageCounter>
}

/** 计数键长度上限（防异常名字把文件撑大；超长 ⇒ **不记**，不截断成假名字） */
export const USAGE_NAME_MAX_CHARS = 120

/** 每个桶的键数上限（**结构上界**，见文件头"只记名字"节） */
export const USAGE_MAX_KEYS_PER_BUCKET = 1000

const USAGE_STATS_VERSION = 1

/** 统计文件绝对路径（**纯函数**） */
export function usageStatsPath(root: string): string {
  return join(root, USAGE_STATS_SUBDIR, USAGE_STATS_FILENAME)
}

/** 空账本（**纯函数**） */
export function emptyUsageStats(): UsageStats {
  return { version: USAGE_STATS_VERSION, updatedAt: isoLocal(0), skill: { loads: {}, injections: {} }, msm: {} }
}

/** 单条计数形状校验（容忍手改：字段缺失/类型不符 ⇒ 丢弃该条，不阻断整档） */
function asCounter(value: unknown): UsageCounter | null {
  const c = value as Partial<UsageCounter> | null | undefined
  if (!c || typeof c !== 'object') return null
  if (typeof c.count !== 'number' || !Number.isFinite(c.count) || c.count < 0) return null
  const firstAt = typeof c.firstAt === 'string' ? c.firstAt : ''
  const lastAt = typeof c.lastAt === 'string' ? c.lastAt : firstAt
  return { count: Math.floor(c.count), firstAt, lastAt }
}

/** 桶校验（非对象 ⇒ 空桶；逐键过滤非法条） */
function asBucket(value: unknown): Record<string, UsageCounter> {
  const out: Record<string, UsageCounter> = {}
  if (!value || typeof value !== 'object') return out
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const c = asCounter(v)
    if (c) out[k] = c
  }
  return out
}

/**
 * 读取账本（**永不抛**；读坏 ⇒ 空账本 + 返回 error 文本，**不静默吞掉**）。
 * 文件不存在 = 正常初态（`error: null` 且空账本）。
 */
export function loadUsageStats(root: string): { stats: UsageStats; error: string | null } {
  const path = usageStatsPath(root)
  if (!existsSync(path)) return { stats: emptyUsageStats(), error: null }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<UsageStats>
    const skill = (parsed.skill ?? {}) as Partial<UsageStats['skill']>
    return {
      stats: {
        version: USAGE_STATS_VERSION,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : isoLocal(0),
        skill: { loads: asBucket(skill.loads), injections: asBucket(skill.injections) },
        msm: asBucket(parsed.msm),
      },
      error: null,
    }
  } catch (err) {
    return { stats: emptyUsageStats(), error: `用量统计解析失败（${String((err as Error)?.message ?? err)}）` }
  }
}

/** 键是否可记（非空 + 不超长；**不截断**——截断会造出一个不存在的名字） */
export function isRecordableUsageName(name: unknown): name is string {
  return typeof name === 'string' && name !== '' && [...name].length <= USAGE_NAME_MAX_CHARS
}

/**
 * 在桶上自增一格（**纯函数**：不改入参，返回新桶）。
 * 新键超桶上限 ⇒ **不新增**（但仍自增已有键）⇒ 键数**结构上有界**。
 */
export function bumpBucket(
  bucket: Record<string, UsageCounter>,
  name: string,
  at: string,
  maxKeys: number = USAGE_MAX_KEYS_PER_BUCKET,
): Record<string, UsageCounter> {
  const prev = bucket[name]
  if (!prev && Object.keys(bucket).length >= maxKeys) return bucket
  const next: UsageCounter = prev
    ? { count: prev.count + 1, firstAt: prev.firstAt || at, lastAt: at }
    : { count: 1, firstAt: at, lastAt: at }
  return { ...bucket, [name]: next }
}

/** 从工具入参里取名字（首个命中的键胜出；取不到 ⇒ `null`） */
export function nameFromArgs(args: unknown, keys: readonly string[]): string | null {
  if (args === null || typeof args !== 'object') return null
  const a = args as Record<string, unknown>
  for (const k of keys) {
    if (isRecordableUsageName(a[k])) return a[k]
  }
  return null
}

/** `msm` 工具的名字键（`msm(name, args)` 的第一个参数） */
export const MSM_NAME_KEYS = ['name'] as const

/** `skill` 工具的名字键（宿主 `skill` 工具用 `name`；另两个是防御性容错） */
export const SKILL_NAME_KEYS = ['name', 'skill', 'skillName'] as const

/** 一次记录的结论（供调用方决定要不要留痕；**本模块不自己打日志**） */
export interface UsageRecordResult {
  ok: boolean
  error: string | null
  /** 记入的是哪一类；`null` = 本次没有可记的东西（不算失败） */
  recorded: 'skill.load' | 'skill.injection' | 'msm' | null
  /** 记入的键（`recorded` 为 `null` 时也为 `null`） */
  name: string | null
  /** 本次是否真的落盘（`recorded` 非空即 true；失败时 false） */
  wrote: boolean
}

const NOTHING: UsageRecordResult = { ok: true, error: null, recorded: null, name: null, wrote: false }

/**
 * 读 → 自增 → 原子写（**本模块唯一写盘通道；永不抛**）。
 *
 * @param root CCC 根
 * @param mutate 在已载入的账本上做一次自增（返回值 = 本次记录的结论；返回 `NOTHING` 则不写盘）
 * @param nowMs 当前毫秒（可注入 ⇒ 便于测 firstAt/lastAt）
 */
function writeThrough(
  root: string,
  mutate: (stats: UsageStats, at: string) => UsageRecordResult,
  nowMs: number = Date.now(),
): UsageRecordResult {
  const path = usageStatsPath(root)
  try {
    const at = isoLocal(nowMs)
    const loaded = loadUsageStats(root)
    const outcome = mutate(loaded.stats, at)
    if (outcome.recorded === null) return outcome
    loaded.stats.updatedAt = at
    mkdirSync(join(root, USAGE_STATS_SUBDIR), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, `${JSON.stringify(loaded.stats, null, 2)}\n`, 'utf-8')
    renameSync(tmp, path)
    return { ...outcome, ok: true, error: null, wrote: true }
  } catch (err) {
    return {
      ok: false,
      error: `用量统计写入失败（${String((err as Error)?.message ?? err)}）`,
      recorded: null,
      name: null,
      wrote: false,
    }
  }
}

/**
 * 记录一次工具调用的用量（**`tools/post-execute` 的喂入口**）。
 *
 * 只认两类工具名；其余一律 `NOTHING`（**不产生文件、不产生噪声**）。
 * 🔴 **不看 `arguments` 的其余内容**——只取名字键。
 */
export function recordToolUsage(
  root: string,
  toolName: string,
  args: unknown,
  nowMs: number = Date.now(),
): UsageRecordResult {
  if (toolName === 'msm') {
    const name = nameFromArgs(args, MSM_NAME_KEYS)
    if (!name) return NOTHING
    return writeThrough(root, (stats, at) => {
      stats.msm = bumpBucket(stats.msm, name, at)
      return { ok: true, error: null, recorded: 'msm', name, wrote: false }
    }, nowMs)
  }
  if (toolName === 'skill') {
    const name = nameFromArgs(args, SKILL_NAME_KEYS)
    if (!name) return NOTHING
    return writeThrough(root, (stats, at) => {
      stats.skill.loads = bumpBucket(stats.skill.loads, name, at)
      return { ok: true, error: null, recorded: 'skill.load', name, wrote: false }
    }, nowMs)
  }
  return NOTHING
}

/**
 * 记录一次 **skill 注入**（每个请求的 skill 段装配时调用）。
 *
 * ⚠️ 与 `recordToolUsage` 不同，本函数的调用频度 = **请求频度**（稠密）：
 * 调用方应**只在真的注入了非空内容时**调用（空 section 由宿主丢弃 ⇒ 不产生噪声）。
 * 一次调用只写一次盘（`names` 内的多个 skill 合并在**同一次**读改写里）。
 */
export function recordSkillInjections(
  root: string,
  names: readonly string[],
  nowMs: number = Date.now(),
): UsageRecordResult {
  const usable = names.filter((n) => isRecordableUsageName(n))
  if (usable.length === 0) return NOTHING
  return writeThrough(root, (stats, at) => {
    let bucket = stats.skill.injections
    for (const n of usable) bucket = bumpBucket(bucket, n, at)
    stats.skill.injections = bucket
    return { ok: true, error: null, recorded: 'skill.injection', name: usable.join(','), wrote: false }
  }, nowMs)
}
