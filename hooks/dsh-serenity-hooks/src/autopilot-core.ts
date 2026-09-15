/**
 * autopilot-core.ts — autopilot **纯判据层**（零 DSH 依赖，可独立单测、可被开发面脚本 import）
 *
 * 为什么单独成模块（R↓，S142 §12.13 ⑥ C6a）：
 * C6 裁决把 autopilot 拆两半——**机制那半**（配置读写 / 状态报告 / 偏见执行 / 唤起判据）
 * 进插件进程，**排障那半**（完整条件链）留开发面。但两侧**必须用同一份判据**——若各自
 * 实现一遍，"为什么这轮没唤起"的报告就会与实际唤起行为分歧（这正是旧
 * `experiments/autopilot-trajectory/scripts/autopilot-trajectory.ts` 的病：它只能读文件，
 * 看不到 live 会话 / 全局闸 / agent 可解析性 ⇒ 8 项结构性分歧）。
 *
 * ⇒ 本模块承载**判据原语**（读配置 / 目标定位 / 间隔+窗口判决 / 偏见脚本执行），
 * 由三个消费方共用，**没有任何一方自算**：
 *   · tick 与面板 —— `autopilot-trajectory.ts`（`shouldWake` / `getAutopilotStatus`）
 *   · CCC 工具面   —— `autopilot-ops.ts`（`container_admin autopilot status|init|generate-bias`）
 *   · 条件链报告   —— `autopilot-chain.ts`（`acc-diag` ④ 段 + 开发面 `dsh-develop diag`）
 *
 * 本模块**零 DSH 依赖**（只 node:fs/path/child_process + `ccc.ts` + `trajectory-ops.ts`）
 * ——这是刻意的：开发面 `dsh-develop diag` 是独立 bun 进程，import 不了 cordis/DSH 面。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { loadSerenityConfig, resolveInside, type AutopilotTrajectorySettings } from './ccc.js'
import { findSession, sessionsRoot } from './trajectory-ops.js'

/** 偏见内容提供者脚本缺省名（CCC 根目录下；正式版 autopilot-bias.ts） */
export const DEFAULT_BIAS_PROVIDER = 'autopilot-bias.ts'
/** 旧默认偏见脚本名（autotrajectory 时代；未显式配置时回退——pangu 等已配置 CCC 零迁移） */
export const LEGACY_BIAS_PROVIDER = 'autotrajectory-bias.ts'
/** 自主轨迹会话目录后缀标志（--auto 保留——简短且历史会话 S060--auto 已存在） */
export const AUTO_DIR_SUFFIX = '--auto'
/** 调度 tick 周期（5min——用户"tick改为5分钟吧"；0.01h 间隔下每 5min 评估一次） */
export const TICK_MS = 5 * 60 * 1000
/**
 * tick 周期（分钟）——**报告文案的唯一来源**：此前脚本文案写死 `10min`，与插件 `TICK_MS`
 * （5min）不符，用户看到"等下个 10min tick"而实际 5min（§12.7 文案纠错）。由 `TICK_MS` 派生。
 */
export const TICK_MINUTES = TICK_MS / 60_000
/** 间隔下限（支持小数——用户"让它支持小数行吗，这样可以配0.01"；0.01h ≈ 36s） */
export const MIN_INTERVAL_HOURS = 0.01
/** SESSION.md 内「下一轮动机」段标记（自生偏见载体——轨迹预设自己的未来） */
export const MOTIVATION_MARKER = '下一轮动机'
/** 缺省避开的高峰时段（北京时间 [start, end) 不唤起——用量峰谷省钱） */
export const DEFAULT_AVOID_HOURS = { start: 8, end: 18 }
/** 偏见脚本输出上限（沙箱：截断防失控——正式版 v1.27.4） */
const BIAS_OUTPUT_MAX = 8 * 1024
/** 偏见脚本执行超时（正式版沙箱；原 600s 过长阻塞 tick） */
const BIAS_RUN_TIMEOUT_MS = 60_000

/** 读配置：`trajectory.autopilot`（D58 新键）优先 → 旧键 autopilotTrajectory → 旧键 autotrajectory */
export function readAutopilotSettings(root: string): AutopilotTrajectorySettings | null {
  const cfg = loadSerenityConfig(root)
  return cfg.trajectory?.autopilot ?? cfg.autopilotTrajectory ?? cfg.autotrajectory ?? null
}

/**
 * 北京时间（UTC+8）当前小时——不依赖服务器时区（服务器可能 UTC/本地任意）。
 */
export function beijingHour(nowMs: number): number {
  return Math.floor(((nowMs + 8 * 3600_000) % 86400_000) / 3600_000)
}

/**
 * 唤起窗口判定：北京时间 [avoidStart, avoidEnd) 内不唤起（缺省 8~18）。
 * 单段避开（start<=end）：窗口 = [0,start) ∪ [end,24)；跨零点避开（start>end）：窗口 = [end,start)。
 */
export function inAllowedWakeWindow(nowMs: number, avoid?: { start?: number; end?: number }): boolean {
  const start = avoid?.start ?? DEFAULT_AVOID_HOURS.start
  const end = avoid?.end ?? DEFAULT_AVOID_HOURS.end
  const h = beijingHour(nowMs)
  if (start <= end) return h < start || h >= end
  return h >= end && h < start
}

/** 标志位判定：SESSION.md 所在目录名以 --auto 结尾 → 自主轨迹形态 */
export function isAutopilotSession(mdPath: string): boolean {
  return basename(dirname(mdPath)).endsWith(AUTO_DIR_SUFFIX)
}

/**
 * 目标会话定位：**必须配置 cfg.session**（S###/目录名）——CCC 日常有多条 trajectory 在跑，
 * 绝不默认唤起（缺省最近活跃会误伤其他正在运行的轨迹；用户拍板：必须配置才生效）。
 * 未配置 session 或未命中 → null（不唤起）。
 */
export function resolveTargetMd(root: string, cfg: AutopilotTrajectorySettings): string | null {
  if (!cfg?.session) return null
  const found = findSession(sessionsRoot(root), cfg.session)
  if (!found) return null
  const md = join(found.path, 'SESSION.md')
  return existsSync(md) ? md : null
}

/** 两次唤起之间的"等待"判据结果（`judgeWake` 返回值） */
export interface WakeJudge {
  /** 生效的间隔阈值（小时；下限 `MIN_INTERVAL_HOURS`） */
  interval: number
  /** 距上次轨迹活动（小时）；目标会话不存在/不可 stat 时为 null */
  idleHours: number | null
  /** 间隔条件是否满足 */
  intervalOk: boolean
  /** 是否在允许唤起的窗口内 */
  windowOk: boolean
  /** 两条件同时满足（"此刻到点了"） */
  wakeable: boolean
}

/**
 * **唤起判据唯一真相源**（间隔 + 窗口）：`shouldWake`（tick / 面板）、`autopilot-ops`
 * （status/check）、`autopilot-chain`（条件链）三处共用本函数——**没有任何一方自算**。
 *
 * 为什么必须共用（v1.34.1 事故留档）：旧实现在同一个脚本里存在**两份判断**——
 * `status()` 算 `intervalOk && windowOk` 而条件链的判决行只统计 `✗` 开头项，把 `⏸`
 * （间隔未到 / 高峰避开）排除在阻断之外 ⇒ **每天北京 8~18 点（10 小时）都印
 * 「✅ 唤起条件全部满足」而插件实际不唤起**（假阳性，已实测复现）。合成一处后不可能再分叉。
 *
 * 间隔下限取 `MIN_INTERVAL_HOURS`（=0.01，与 tick 同源）。旧脚本取 `1`（`SCRIPT_MIN_INTERVAL_HOURS`）
 * ——那会让配置 `intervalHours < 1` 的 CCC 在报告里**假阴性**（报"未到"而插件已唤起）；
 * 该分歧随独立脚本退场一并消失（报告与真实唤起行为同源，正是本轮的目标）。
 */
export function judgeWake(
  settings: { intervalHours?: number; avoidWakeHours?: { start?: number; end?: number } } | null,
  mdPath: string | null,
  now: number = Date.now(),
): WakeJudge {
  const interval = Math.max(MIN_INTERVAL_HOURS, settings?.intervalHours ?? 12)
  let idleHours: number | null = null
  if (mdPath) {
    try {
      idleHours = (now - statSync(mdPath).mtimeMs) / 3600_000
    } catch {
      idleHours = null // 文件消失/不可读 → 间隔条件不成立（与旧 shouldWake 的 catch 同义）
    }
  }
  const intervalOk = idleHours !== null && idleHours >= interval
  const windowOk = inAllowedWakeWindow(now, settings?.avoidWakeHours)
  return { interval, idleHours, intervalOk, windowOk, wakeable: intervalOk && windowOk }
}

/** 审计记录（每 CCC ring buffer——正式版 v1.27.4：可回看、可分析） */
export interface WakeRecord {
  time: number
  ok: boolean
  detail: string
}

/**
 * 唤起条件（纯逻辑，可测）：enabled + 未在运行 + 目录标志 + mtime 超间隔 + 窗口允许。
 * v1.27.12：移除每日唤起预算上限（用户"把这个上限删了吧，没意义"——高频实验不受限）。
 *
 * 判据来源全部来自本模块（`judgeWake` / `isAutopilotSession`）——本函数只做**组合**，
 * 不重复实现时间/窗口计算。
 */
export function shouldWake(
  settings: AutopilotTrajectorySettings,
  mdPath: string | null,
  nowMs: number,
  running: boolean,
  _history: readonly WakeRecord[] = [],
): boolean {
  if (!settings?.enabled || running) return false
  if (!mdPath || !isAutopilotSession(mdPath)) return false
  return judgeWake(settings, mdPath, nowMs).wakeable
}

/** 自生动机读取：SESSION.md「下一轮动机」段内容（到下一个二级标题或文件尾；无 → null） */
export function readSelfGeneratedMotivation(mdPath: string): string | null {
  try {
    const content = readFileSync(mdPath, 'utf-8')
    const idx = content.indexOf(MOTIVATION_MARKER)
    if (idx < 0) return null
    const rest = content.slice(idx + MOTIVATION_MARKER.length)
    const nextHeading = rest.search(/\n## /)
    const seg = (nextHeading >= 0 ? rest.slice(0, nextHeading) : rest).trim()
    return seg || null
  } catch {
    return null
  }
}

/**
 * 偏见内容：直接运行 CCC 根目录下偏见提供者脚本（biasProvider，缺省 autopilot-bias.ts；
 * 未显式配置且新默认缺失 → 回退旧默认 autotrajectory-bias.ts——pangu 兼容）→ stdout。
 * 脚本缺失 → 返回 { text: null, error: 提示实现 }（唤起侧报错要求实现，不静默跳过）。
 * 路径逃逸校验（resolveInside）；bun 优先，node 兜底；**60s 超时 + 8KB 输出截断（沙箱）**。
 *
 * 唯一执行点（不另写 spawn）：tick 的唤起路径（`performAutopilotWake`）、`container_admin
 * autopilot generate-bias`、条件链的偏见就绪探测**三处都调本函数**（§12.13：`random` → 复用
 * 插件 tick 里既有的偏见执行代码）。旧脚本另有一套 spawn 且**参数不同**（600s 超时、无 8KB
 * 截断、无旧默认名回退）⇒ 那是"bias 运行参数"与"仅存旧名 bias 脚本时报假阴性"两项分歧的由来。
 */
export async function fetchBiasContent(
  root: string,
  providerRel: string,
): Promise<{ text: string | null; error: string | null }> {
  let scriptAbs: string
  try {
    scriptAbs = resolveInside(root, providerRel)
  } catch {
    return { text: null, error: `biasProvider 路径逃逸（须在 CCC 根内）: ${providerRel}` }
  }
  // 默认名缺失 → 回退旧默认（未显式配置的存量 CCC 零迁移）
  if (!existsSync(scriptAbs) && providerRel === DEFAULT_BIAS_PROVIDER) {
    const legacy = resolveInside(root, LEGACY_BIAS_PROVIDER)
    if (existsSync(legacy)) scriptAbs = legacy
  }
  if (!existsSync(scriptAbs)) {
    return { text: null, error: `请在 CCC 根目录实现偏见内容提供者脚本: ${providerRel}（或旧默认 ${LEGACY_BIAS_PROVIDER}；stdout 输出偏见内容一行；container_admin autopilot init 可生成模板）` }
  }
  const runs: Array<[string, string[]]> = [
    ['bun', [scriptAbs]],
    [process.execPath, [scriptAbs]],
  ]
  for (const [cmd, args] of runs) {
    try {
      const r = spawnSync(cmd, args, { encoding: 'utf-8', timeout: BIAS_RUN_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] })
      if (r.status === 0) {
        const text = (r.stdout ?? '').trim().slice(0, BIAS_OUTPUT_MAX)
        return { text: text || null, error: null }
      }
      // bun 缺失（ENOENT）→ 试 node；否则视为脚本失败
      if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') continue
      return { text: null, error: `偏见内容提供者脚本执行失败（exit ${r.status ?? '?'}）: ${r.stderr?.trim() || r.stdout?.trim() || ''}` }
    } catch {
      continue
    }
  }
  return { text: null, error: '偏见内容提供者脚本无法运行（bun 与 node 均不可用）' }
}

/** 偏见提供者脚本绝对路径（根内强制——逃逸拒绝）；供文件写入侧（init 生成模板）使用 */
export function biasProviderAbsPath(root: string, providerRel: string): string {
  return resolveInside(root, providerRel)
}

/** 读 UTF-8（去 BOM）——init 写配置前的读回 */
export function readUtf8(p: string): string {
  return readFileSync(p, 'utf-8').replace(/^\uFEFF/, '')
}
