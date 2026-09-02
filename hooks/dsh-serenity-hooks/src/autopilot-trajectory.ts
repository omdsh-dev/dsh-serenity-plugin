/**
 * autopilot-trajectory.ts — Autopilot Trajectory（自动巡航轨迹，正式版 v1.27.4）
 *
 * 前身：autotrajectory（v1.26.12~17 实验验证机制）。用户拍板正式化：
 * 命名 = Autopilot Trajectory（autotrajectory 是技术代号——"auto" 弱前缀 + "trajectory"
 * 内部术语；Autopilot 契合宁静号 Ship 隐喻：设定目标 → 自主巡航 → 驾驶舱可见 → 人类可接管，
 * 加 Trajectory 明确对象）。成熟度分级：L1 时钟唤起 → L2 焦点+偏见 → **L3 质量反馈环（下一轮）**。
 *
 * 依据：serenity-acc-specs/docs/self-sustaining-trajectory-hypothesis.md（v0.1 实验提案；
 * S142 2026-08-30 用户提出猜想 + 三项裁决：① 时钟驱动 ② 先验偏见自生+随机（随机充分引入）
 * ③ 人类=反馈来源（不直接参与））。
 *
 * 形态（用户拍板 v0.5 + 正式化 v1.27.4）：
 *   · **前台运行**：时钟唤起 = 向活跃会话注入唤起消息（agent.steer，v1.22.5 自动继续同款
 *     通道）→ 模型自动继续 → 用户全程可见、随时可介入（人类反馈天然并入——同会话）。
 *   · **偏见内容提供者 = CCC 根目录下脚本**（biasProvider；缺省 autopilot-bias.ts，
 *     旧默认 autotrajectory-bias.ts 回退——pangu 等已配置 CCC 兼容）：tool 直接运行取
 *     stdout 作为偏见内容；脚本缺失 → **报错要求实现**（偏见内容归 CCC）。
 *   · **会话标志 = 目录名后缀 --auto**：AGENT_SESSIONS/<date>--<desc>--auto/ → 自主形态。
 *   · **轨迹焦点 topPrompt = CCC 定义**：每次唤起最先注入的顶层提示词（稳定焦点锚定防漂移）。
 *   · **唤起窗口避开北京时间 8~18 点**（用量峰谷省钱）——avoidWakeHours 可覆盖。
 *   · **多 CCC 独立（v1.27.4，用户"4个CCC能各自有autotrajectory吗"）**：配置层本就 CCC 级
 *     （enabled/intervalHours/session/biasProvider/topPrompt/窗口）；正式版时钟遍历所有
 *     live+enabled CCC 各自评估唤起（collectAutopilotCccs），running 守卫 per-CCC + 全局
 *     串行化（防模型并发挤兑）。
 *   · **默认关**：serenity.json autopilotTrajectory.enabled=false → 定时器不启动，零资源占用。
 */

import type { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import { spawnSync } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { findSerenityRoot, loadSerenityConfig, resolveInside, type AutopilotTrajectorySettings } from './ccc.js'
import { findSession, sessionsRoot } from './session-ops.js'
import { readSimpleSettings } from './settings-section.js'

const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'dsh-serenity-hooks' }

/** 偏见内容提供者脚本缺省名（CCC 根目录下；正式版 autopilot-bias.ts） */
export const DEFAULT_BIAS_PROVIDER = 'autopilot-bias.ts'
/** 旧默认偏见脚本名（autotrajectory 时代；未显式配置时回退——pangu 等已配置 CCC 零迁移） */
export const LEGACY_BIAS_PROVIDER = 'autotrajectory-bias.ts'
/** 自主轨迹会话目录后缀标志（--auto 保留——简短且历史会话 S060--auto 已存在） */
export const AUTO_DIR_SUFFIX = '--auto'
/** 调度 tick 周期（5min——用户"tick改为5分钟吧"；0.01h 间隔下每 5min 评估一次） */
export const TICK_MS = 5 * 60 * 1000
/** 间隔下限（支持小数——用户"让它支持小数行吗，这样可以配0.01"；0.01h ≈ 36s） */
export const MIN_INTERVAL_HOURS = 0.01
/** SESSION.md 内「下一轮动机」段标记（自生偏见载体——轨迹预设自己的未来） */
export const MOTIVATION_MARKER = '下一轮动机'
/** 缺省避开的高峰时段（北京时间 [start, end) 不唤起——用量峰谷省钱） */
export const DEFAULT_AVOID_HOURS = { start: 8, end: 18 }
/** 偏见脚本输出上限（沙箱：截断防失控——正式版 v1.27.4） */
export const BIAS_OUTPUT_MAX = 8 * 1024
/** 偏见脚本执行超时（正式版沙箱；原 600s 过长阻塞 tick） */
export const BIAS_RUN_TIMEOUT_MS = 60_000
/** 每日唤起预算缺省上限（轮次预算——正式版 v1.27.4；防失控 + 控成本） */
export const DEFAULT_MAX_DAILY_WAKES = 24
/** 审计历史 ring 上限（每 CCC 保留最近 N 条唤起记录） */
export const AUDIT_HISTORY_MAX = 50

/** 读配置：新键 autopilotTrajectory 优先，旧键 autotrajectory 回退（正式化兼容） */
export function readAutopilotSettings(root: string): AutopilotTrajectorySettings | null {
  const cfg = loadSerenityConfig(root)
  return cfg.autopilotTrajectory ?? cfg.autotrajectory ?? null
}

/**
 * 北京时间（UTC+8）当前小时——不依赖服务器时区（服务器可能 UTC/本地任意）。
 */
export function beijingHour(nowMs: number): number {
  return Math.floor(((nowMs + 8 * 3600_000) % 86400_000) / 3600_000)
}

/** 当日已用唤起次数（按北京时间日；轮次预算 maxDailyWakes 判定） */
export function dailyWakeCount(history: readonly WakeRecord[], nowMs: number): number {
  const day = Math.floor((nowMs + 8 * 3600_000) / 86400_000)
  return history.filter((r) => Math.floor((r.time + 8 * 3600_000) / 86400_000) === day).length
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

/**
 * 唤起条件（纯逻辑，可测）：enabled + 未在运行 + 目录标志 + mtime 超间隔 + 窗口允许 + 预算未超。
 */
export function shouldWake(
  settings: AutopilotTrajectorySettings,
  mdPath: string | null,
  nowMs: number,
  running: boolean,
  history: readonly WakeRecord[] = [],
): boolean {
  if (!settings?.enabled || running) return false
  if (!mdPath || !isAutopilotSession(mdPath)) return false
  if (!inAllowedWakeWindow(nowMs, settings.avoidWakeHours)) return false
  // 轮次预算：当日唤起次数达上限 → 跳过（正式版 v1.27.4）
  const maxDaily = Math.max(1, settings.maxDailyWakes ?? DEFAULT_MAX_DAILY_WAKES)
  if (dailyWakeCount(history, nowMs) >= maxDaily) return false
  try {
    const mtime = statSync(mdPath).mtimeMs
    // v1.27.8：支持小数小时（用户配 0.01 ≈ 36s 高频实验）——下限 MIN_INTERVAL_HOURS
    const hours = Math.max(MIN_INTERVAL_HOURS, settings.intervalHours ?? 12)
    return nowMs - mtime >= hours * 3600_000
  } catch {
    return false
  }
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
 */
export async function fetchBiasContent(root: string, providerRel: string): Promise<{ text: string | null; error: string | null }> {
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
    return { text: null, error: `请在 CCC 根目录实现偏见内容提供者脚本: ${providerRel}（或旧默认 ${LEGACY_BIAS_PROVIDER}；stdout 输出偏见内容一行；acc_msm exec autopilot-trajectory init 可生成模板）` }
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

/** 唤起消息（四段式：轨迹焦点[CCC 定义，稳定] / 身份锚定 / 先验偏见[自生动机+偏见内容] / 任务）——注入前台会话，用户可见 */
export function buildWakeMessage(opts: {
  sessionName: string
  mdPath: string
  intervalHours: number
  topPrompt: string | null
  motivation: string | null
  biasContent: string | null
}): string {
  // 间隔人性化显示：>=1h 显示小时数；<1h 显示分钟（v1.27.8 小数配置）
  const intervalLabel = opts.intervalHours >= 1
    ? `${opts.intervalHours} 小时`
    : `约 ${Math.round(opts.intervalHours * 60)} 分钟`
  const lines: string[] = []
  // 轨迹焦点最先注入（影响力最大——CCC 定义的本轨迹核心目标/纪律，每轮不变，锚定防漂移）
  if (opts.topPrompt) {
    lines.push(`[轨迹焦点] ${opts.topPrompt}`)
    lines.push('')
  }
  lines.push(
    `[Autopilot Trajectory 唤起] — 距上次轨迹活动已满 ${intervalLabel}，自动继续。`,
    '',
    `身份锚定：继续 ${opts.sessionName} 的 trajectory（SESSION.md: ${opts.mdPath}）。`,
    '先验偏见：',
  )
  if (opts.motivation) lines.push(`  · 自生动机：${opts.motivation}`)
  if (opts.biasContent) lines.push(`  · 偏见内容：${opts.biasContent}`)
  if (!opts.motivation && !opts.biasContent) lines.push('  · （无——本轮纯自主探索）')
  lines.push(
    '',
    '任务：执行一轮自主认知（探索/反事实检验），把产出写入 SESSION.md',
    '「自主探索日志」段，并预写「下一轮动机」段。完成后自然结束。',
  )
  return lines.join('\n')
}

/** 唤起结果（tick 日志 / 面板显示 / 审计记录共用） */
export interface WakeResult {
  ok: boolean
  detail: string
}

/** 审计记录（每 CCC ring buffer——正式版 v1.27.4：可回看、可分析） */
export interface WakeRecord {
  time: number
  ok: boolean
  detail: string
}

/** 审计历史（root → 最近唤醒记录；进程生命周期；上限 AUDIT_HISTORY_MAX/CCC） */
const wakeHistory = new Map<string, WakeRecord[]>()

/** 追加审计记录（ring 截断） */
export function recordWake(root: string, rec: WakeRecord): void {
  const list = wakeHistory.get(root) ?? []
  list.push(rec)
  if (list.length > AUDIT_HISTORY_MAX) list.splice(0, list.length - AUDIT_HISTORY_MAX)
  wakeHistory.set(root, list)
}

/** 读审计历史（root 的最近记录；无 → []） */
export function wakeHistoryFor(root: string): WakeRecord[] {
  return [...(wakeHistory.get(root) ?? [])]
}

/** 测试辅助：清空审计（生产零调用） */
export function resetWakeHistory(): void {
  wakeHistory.clear()
}

/**
 * 执行一次唤起（时钟 tick 与面板「立即唤起」共用）：
 * - force=false（时钟）：完整校验——enabled / 目标命中 / --auto 标志 / 窗口 / 间隔 / 预算 / 偏见脚本
 * - force=true（手动调试，用户在场）：跳过窗口/间隔/预算，仍校验 enabled / 目标命中 / --auto / 偏见脚本
 * 成功 → 注入前台会话（agent.steer，用户可见）；返回结果供调用方（tick 打日志 / 面板显示 / 审计）。
 */
export async function performAutopilotWake(
  ctx: Context,
  root: string,
  settings: AutopilotTrajectorySettings,
  opts: { force?: boolean } = {},
): Promise<WakeResult> {
  if (!settings?.enabled) return { ok: false, detail: 'Autopilot Trajectory 未启用（enabled=false）' }
  const mdPath = resolveTargetMd(root, settings)
  if (!mdPath) return { ok: false, detail: '目标会话未命中（session 未配置或 AGENT_SESSIONS 无匹配）' }
  if (!isAutopilotSession(mdPath)) return { ok: false, detail: '目标会话目录无 --auto 标志（AGENT_SESSIONS/<date>--<desc>--auto/）' }
  if (!opts.force) {
    const now = Date.now()
    if (!inAllowedWakeWindow(now, settings.avoidWakeHours)) return { ok: false, detail: '当前在北京高峰避开窗口内（不唤起）' }
    try {
      const mtime = statSync(mdPath).mtimeMs
      const hours = Math.max(MIN_INTERVAL_HOURS, settings.intervalHours ?? 12)
      if (now - mtime < hours * 3600_000) return { ok: false, detail: `距上次轨迹活动不足 ${hours}h（等待中）` }
    } catch {
      return { ok: false, detail: 'SESSION.md 读取失败（statSync）' }
    }
  }
  const agent = resolveTargetAgent(ctx, mdPath)
  if (!agent) {
    const diag = diagnoseTargetUnavailable(ctx, mdPath)
    return { ok: false, detail: `目标会话 agent 不可得——${diag ?? '目标会话未打开或命名未生效'}` }
  }
  const provider = settings.biasProvider?.trim() || DEFAULT_BIAS_PROVIDER
  const biasRes = await fetchBiasContent(root, provider)
  if (biasRes.error) return { ok: false, detail: `偏见内容缺失：${biasRes.error}` }
  const motivation = readSelfGeneratedMotivation(mdPath)
  const message = buildWakeMessage({
    sessionName: basename(dirname(mdPath)),
    mdPath,
    intervalHours: Math.max(MIN_INTERVAL_HOURS, settings.intervalHours ?? 12),
    topPrompt: settings.topPrompt?.trim() || null,
    motivation,
    biasContent: biasRes.text,
  })
  agent.steer(createUserMessage({ content: [{ type: 'text', text: message }], source: PLUGIN_SOURCE }))
  return { ok: true, detail: `已唤起 ${basename(dirname(mdPath))}（偏见提供者 ${provider}）` }
}

/**
 * 装配（index.ts apply 调用）。时钟唤起（v1.26.14 修复 + v1.27.4 多 CCC 独立）：
 *
 * v1.26.14 根因：旧实现启动时一次性解析 root——web 进程启动时 live 会话往往为空 → 定时器不启动。
 * 修复：① 每次 tick 动态解析 root+settings ② 监听 session/created 启动定时器 ③ 优先实验 CCC。
 *
 * **v1.27.4 多 CCC 独立（用户"4个CCC能各自有autotrajectory吗"）**：
 * - 单定时器保留（TICK_MS 10min），每次 tick **遍历所有 live+enabled CCC**（collectAutopilotCccs）
 *   各自评估 shouldWake + 各自唤起——每 CCC 的 interval/session/bias/topPrompt/窗口独立
 * - `running` 守卫 **per-CCC**（不同 CCC 唤起互不阻塞）
 * - **全局串行化**（wakeChain：同 tick 多 CCC 到点 → 依次唤起，防模型并发挤兑）
 *
 * 零资源占用语义保留：无 enabled CCC → tick 内直接 return（定时器存在但每 10min 一次空检查，
 * unref 不阻塞进程退出）。
 */
export function registerAutopilot(ctx: Context): void {
  let timer: NodeJS.Timeout | null = null
  // per-CCC running（防同一 CCC 重入）+ 全局串行链（多 CCC 唤起依次执行）
  const runningByRoot = new Map<string, boolean>()
  let wakeChain: Promise<void> = Promise.resolve()

  // 全局总开关（v1.27.9，用户"做全局开关，默认关闭；只在指定电脑进行"）：
  // settings autopilotEnabled（plugin 全局，默认关）——关 = 定时器不启动 + tick 不唤起
  // **双重门控**：全局开关 AND CCC 级 enabled（serenity.json）都满足才运行。
  // CCC 级配置（interval/session/bias/topPrompt）不动——只加一层全局闸。
  const globalOn = (): boolean => {
    try {
      return readSimpleSettings().autopilotEnabled === true
    } catch {
      return false // settings 服务不可用 → 默认关（保守：未明确开启不自动跑）
    }
  }

  const tick = (): void => {
    if (!globalOn()) return // 全局关 → 本 tick 不唤起（中途关闭即停）
    // 遍历所有 live+enabled CCC（v1.27.4：多 CCC 各自独立唤起）
    const roots = collectAutopilotCccs(ctx)
    if (roots.length === 0) return
    for (const root of roots) {
      if (runningByRoot.get(root)) continue // per-CCC 防重入
      const settings = readAutopilotSettings(root)
      if (!settings?.enabled) continue
      const mdPath = resolveTargetMd(root, settings)
      if (!shouldWake(settings, mdPath, Date.now(), false, wakeHistoryFor(root))) continue
      runningByRoot.set(root, true)
      // 全局串行：接到 wakeChain 尾（同 tick 多 CCC 依次唤起，防模型并发挤兑）
      wakeChain = wakeChain.then(async () => {
        try {
          const res = await performAutopilotWake(ctx, root, settings!, { force: false })
          recordWake(root, { time: Date.now(), ok: res.ok, detail: res.detail })
          if (res.ok) console.log(`[serenity-hooks] ✓ Autopilot Trajectory 唤起（${res.detail}）`)
          else console.warn(`[serenity-hooks] ✗ Autopilot Trajectory 唤起跳过：${res.detail}`)
        } catch (err) {
          recordWake(root, { time: Date.now(), ok: false, detail: `唤起异常: ${String((err as Error)?.message ?? err)}` })
          console.warn(`[serenity-hooks] ✗ Autopilot Trajectory 唤起失败: ${String((err as Error)?.message ?? err)}`)
        } finally {
          runningByRoot.set(root, false)
        }
      })
    }
  }

  const startTimer = (): void => {
    if (timer) return
    if (!globalOn()) return // 全局关 → 不启动定时器（零资源占用，v1.27.9）
    if (collectAutopilotCccs(ctx).length === 0) return // 无启用 CCC → 不启动
    timer = setInterval(tick, TICK_MS)
    // unref：进程存活时定时器照常触发；进程退出（插件卸载/服务器停止）不阻塞退出
    timer.unref()
    console.log(`[serenity-hooks] ✓ Autopilot Trajectory 定时器启动（${collectAutopilotCccs(ctx).length} 个 CCC 启用）`)
    // 启动时立即检查一次（插件重启后恢复节律，无需等首个 5min）
    tick()
  }

  // ① 进程启动时：若全局开且已有启用 CCC → 立即启动
  startTimer()
  // ② 会话出现（用户打开实验 CCC）→ 启动定时器（live 会话变化即跟上；
  //    全局未开时 startTimer 直接 return——开全局后需重启生效）
  try {
    ctx.on('session/created', () => startTimer())
  } catch {
    /* 事件通道缺失不阻断（启动时 startTimer 已尝试一次） */
  }
}

/** 目标 agent：从 SESSION.md 反向定位 dsh 会话（标题 F3 命名 S###-日期 匹配 + cwd 归属校验）；不可得 → null */
function resolveTargetAgent(ctx: Context, mdPath: string): Agent | null {
  const dirName = basename(dirname(mdPath))
  const idMatch = dirName.match(/--S(\d{3,})--/)
  const sid = idMatch ? `S${idMatch[1]}` : null
  const targetRoot = findSerenityRoot(mdPath)
  try {
    const sessions = (ctx as unknown as { sessions?: { list?: () => Array<{ id?: string; header?: { cwd?: string } }> } }).sessions
    for (const s of sessions?.list?.() ?? []) {
      // cwd 归属校验：同实例多 CCC 时不误匹配（只找目标 SESSION 所在 CCC 的会话）。
      // targetRoot 可解析（CCC 环境）→ 会话 CCC 根必须一致；不可解析（非 CCC/测试）→
      // 会话 cwd 必须是 mdPath 的祖先路径（覆盖 AGENT_SESSIONS 挂载场景）。
      const cwd = s?.header?.cwd ?? ''
      if (targetRoot) {
        if (findSerenityRoot(cwd) !== targetRoot) continue
      } else if (cwd !== '' && !mdPath.startsWith(cwd.endsWith('/') ? cwd : cwd + '/')) {
        continue
      }
      const title = readSessionTitle(s)
      if (sid && title && (title === sid || title.startsWith(`${sid}-`))) {
        const agent = (ctx as unknown as { agents?: { get?: (id: string) => Agent | undefined } }).agents?.get?.(s.id ?? '')
        if (agent) return agent
      }
    }
  } catch {
    /* 遍历失败忽略 */
  }
  return null
}

/**
 * 从 dsh 会话 log 读取标题（latest-wins `session/title` 事件）——
 * **标题不在 sessions.list() 条目上**（wire/对象均无 title 字段；F3 命名经
 * sessionTitle.rename 写进 session log），必须从 events 提取（rebuild 同款读取模式）。
 */
function readSessionTitle(session: unknown): string | null {
  try {
    const events = (session as { events?: readonly { type?: string; data?: { title?: unknown } }[] } | undefined)?.events
    if (!Array.isArray(events)) return null
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (e?.type === 'session/title' && typeof e.data?.title === 'string' && e.data.title.trim() !== '') {
        return e.data.title.trim()
      }
    }
  } catch {
    /* events 访问失败忽略 */
  }
  return null
}

/**
 * 诊断：目标会话 agent 为何不可得（供 performAutopilotWake 失败信息——
 * 区分"live 会话里无匹配" vs "匹配但 agent 未加载"）。返回诊断文本（无则 null）。
 */
function diagnoseTargetUnavailable(ctx: Context, mdPath: string): string | null {
  const dirName = basename(dirname(mdPath))
  const idMatch = dirName.match(/--S(\d{3,})--/)
  const sid = idMatch ? `S${idMatch[1]}` : null
  const targetRoot = findSerenityRoot(mdPath)
  const sameCccTitles: string[] = []
  const agentMissing = { sid: false }
  try {
    const sessions = (ctx as unknown as { sessions?: { list?: () => Array<{ id?: string; header?: { cwd?: string } }> } }).sessions
    for (const s of sessions?.list?.() ?? []) {
      const cwd = s?.header?.cwd ?? ''
      if (targetRoot) {
        if (findSerenityRoot(cwd) !== targetRoot) continue
      } else if (cwd !== '' && !mdPath.startsWith(cwd.endsWith('/') ? cwd : cwd + '/')) {
        continue
      }
      const title = readSessionTitle(s)
      if (title) sameCccTitles.push(title)
      if (sid && title && (title === sid || title.startsWith(`${sid}-`))) {
        const agent = (ctx as unknown as { agents?: { get?: (id: string) => Agent | undefined } }).agents?.get?.(s.id ?? '')
        if (!agent) agentMissing.sid = true
      }
    }
  } catch {
    /* 遍历失败忽略 */
  }
  if (agentMissing.sid) return `会话 ${sid} 已打开但 agent 未加载（会话可能刚创建/正在恢复——稍后重试）`
  if (sameCccTitles.length > 0) {
    return `目标 CCC 内 live 会话标题: [${sameCccTitles.join(', ')}]——均不匹配 ${sid}（目标会话未在 WebUI 打开，或命名未生效）`
  }
  return `目标 CCC 内无 live 会话（先在 WebUI 打开 ${sid} 会话后重试）`
}

/** Autopilot 绑定的回退 CCC 根：进程 cwd 上溯 .serenity 优先，回退任一 live 会话 root */
function resolveAutopilotRoot(ctx: Context): string | null {
  const fromCwd = findSerenityRoot(process.cwd())
  if (fromCwd) return fromCwd
  try {
    const sessions = (ctx as unknown as { sessions?: { list?: () => Array<{ header?: { cwd?: string } }> } }).sessions
    for (const s of sessions?.list?.() ?? []) {
      const r = findSerenityRoot(s?.header?.cwd ?? '')
      if (r) return r
    }
  } catch {
    /* 遍历失败忽略 */
  }
  return null
}

/**
 * 面板状态（GET /serenity/autopilot-trajectory 数据源；纯逻辑，可单测）——
 * WebUI 设置面板「Autopilot Trajectory」只读区块展示的完整状态：配置摘要 + 目标会话
 * 命中/标志/空闲时长 + 当前窗口/可唤起判定 + 审计（最近唤起）。
 * 不运行偏见脚本（只报脚本是否就绪——运行验证走 autopilot-trajectory random）。
 */
export interface AutopilotTrajectoryStatus {
  /** 是否配置了 autopilotTrajectory 段（.opencode/serenity.json；含旧键回退） */
  configured: boolean
  /** 总开关（缺省 false——未开零资源占用） */
  enabled: boolean
  /** 无人类活动 N 小时后自动唤起（缺省 12） */
  intervalHours: number
  /** 每日唤起预算上限（缺省 24） */
  maxDailyWakes: number
  /** 偏见内容提供者脚本（相对 CCC 根；缺省 autopilot-bias.ts） */
  biasProvider: string
  /** 顶层提示词（每次唤起最先注入的稳定指令；未配置 → null） */
  topPrompt: string | null
  /** 目标会话（S###/目录名；未配置 = 不唤起） */
  session: string | null
  /** 避开唤起的高峰时段（北京时间） */
  avoidWakeHours: { start: number; end: number }
  /** 目标会话状态（未配置/未命中 → null） */
  target: {
    /** 目录名（含 --auto 后缀时为自主形态） */
    dirName: string
    /** 目录名是否带 --auto 标志 */
    autoFlag: boolean
    /** 距上次轨迹活动（小时） */
    idleHours: number
    /** 当前时刻是否满足唤起条件（标志+间隔+窗口+预算，未运行中） */
    wakeable: boolean
  } | null
  /** 当前北京时间小时 */
  beijingHour: number
  /** 当前是否在唤起窗口内（避开高峰之外） */
  windowAllowed: boolean
  /** 审计：最近唤起记录（最多 10 条展示；正式版 v1.27.4） */
  recentWakes: WakeRecord[]
}

export function getAutopilotStatus(root: string): AutopilotTrajectoryStatus {
  const cfg = readAutopilotSettings(root)
  const now = Date.now()
  const base = {
    configured: cfg !== null,
    enabled: cfg?.enabled ?? false,
    intervalHours: Math.max(MIN_INTERVAL_HOURS, cfg?.intervalHours ?? 12),
    maxDailyWakes: Math.max(1, cfg?.maxDailyWakes ?? DEFAULT_MAX_DAILY_WAKES),
    biasProvider: cfg?.biasProvider?.trim() || DEFAULT_BIAS_PROVIDER,
    topPrompt: cfg?.topPrompt?.trim() || null,
    session: cfg?.session ?? null,
    avoidWakeHours: {
      start: cfg?.avoidWakeHours?.start ?? DEFAULT_AVOID_HOURS.start,
      end: cfg?.avoidWakeHours?.end ?? DEFAULT_AVOID_HOURS.end,
    },
    beijingHour: beijingHour(now),
    windowAllowed: inAllowedWakeWindow(now, cfg?.avoidWakeHours),
    recentWakes: wakeHistoryFor(root).slice(-10).reverse(),
  }
  if (!cfg) return { ...base, target: null }
  const mdPath = resolveTargetMd(root, cfg)
  if (!mdPath) return { ...base, target: null }
  let idleHours = 0
  try {
    idleHours = (now - statSync(mdPath).mtimeMs) / 3600_000
  } catch {
    /* 文件消失 → 保持 0 */
  }
  return {
    ...base,
    target: {
      dirName: basename(dirname(mdPath)),
      autoFlag: isAutopilotSession(mdPath),
      idleHours: Math.max(0, idleHours),
      wakeable: shouldWake(cfg, mdPath, now, false, wakeHistoryFor(root)),
    },
  }
}

/** live 会话条目（诊断/面板解析用；标题从 events 读） */
export interface LiveSessionEntry {
  id: string
  cwd: string | null
  cccRoot: string | null
  title: string | null
}

/** 遍历 live 会话（sessions.list()）+ 补标题（events session/title latest-wins）+ ccc 归属 */
export function listLiveSessions(ctx: Context): LiveSessionEntry[] {
  const out: LiveSessionEntry[] = []
  try {
    const sessions = (ctx as unknown as { sessions?: { list?: () => Array<{ id?: string; header?: { cwd?: string } }> } }).sessions
    for (const s of sessions?.list?.() ?? []) {
      const cwd = s?.header?.cwd ?? null
      out.push({
        id: s?.id ?? '',
        cwd,
        cccRoot: cwd ? findSerenityRoot(cwd) : null,
        title: readSessionTitle(s),
      })
    }
  } catch {
    /* 遍历失败忽略 */
  }
  return out
}

/**
 * 收集所有「配置了 Autopilot Trajectory 的 live CCC」——**v1.27.4 多 CCC 独立**：
 * 返回 enabled 的 CCC 列表（时钟 tick 遍历目标）；无 enabled → []。
 * （原 resolveAutoTrajectoryCcc 单目标语义被 collect 取代——面板/诊断用 enableOnly=false 取全量）
 */
export function collectAutopilotCccs(ctx: Context, opts: { includeDisabled?: boolean } = {}): string[] {
  const enabled: string[] = []
  const configured: string[] = []
  for (const s of listLiveSessions(ctx)) {
    if (!s.cccRoot) continue
    const cfg = readAutopilotSettings(s.cccRoot)
    if (!cfg) continue
    if (cfg.enabled) {
      if (!enabled.includes(s.cccRoot)) enabled.push(s.cccRoot)
    } else if (!configured.includes(s.cccRoot)) {
      configured.push(s.cccRoot)
    }
  }
  return opts.includeDisabled ? [...enabled, ...configured] : enabled
}

/**
 * 进程内诊断（autopilot-trajectory diag-live 数据源；用户"排查访问不到 pangu 写个 msm"）——
 * 输出当前实例 live 会话清单（id/cwd/ccc/标题）+ 每个配置了 Autopilot 的 CCC
 * 状态（配置摘要/目标命中/可唤起）+ 目标 agent 定位结果。脚本 diag 看不到运行时，
 * 本函数在插件进程内运行（能读 sessions/agents）。
 */
export interface DiagLiveReport {
  processCwd: string
  processCcc: string | null
  liveSessions: LiveSessionEntry[]
  autopilotCccs: Array<{
    root: string
    enabled: boolean
    session: string | null
    target: AutopilotTrajectoryStatus['target']
    agentResolved: boolean
    agentDiagnosis: string | null
  }>
  panelResolved: string | null
}

export function diagLive(ctx: Context): DiagLiveReport {
  const liveSessions = listLiveSessions(ctx)
  const processCwd = process.cwd()
  const processCcc = findSerenityRoot(processCwd)
  const panelResolved = collectAutopilotCccs(ctx)[0] ?? resolveAutopilotRoot(ctx)
  const autopilotCccs: DiagLiveReport['autopilotCccs'] = []
  const seen = new Set<string>()
  for (const s of liveSessions) {
    if (!s.cccRoot || seen.has(s.cccRoot)) continue
    const cfg = readAutopilotSettings(s.cccRoot)
    if (!cfg) continue
    seen.add(s.cccRoot)
    const status = getAutopilotStatus(s.cccRoot)
    const mdPath = resolveTargetMd(s.cccRoot, cfg)
    const agentResolved = mdPath ? resolveTargetAgent(ctx, mdPath) !== null : false
    const agentDiagnosis = mdPath && !agentResolved ? diagnoseTargetUnavailable(ctx, mdPath) : null
    autopilotCccs.push({
      root: s.cccRoot,
      enabled: status.enabled,
      session: status.session,
      target: status.target,
      agentResolved,
      agentDiagnosis,
    })
  }
  return { processCwd, processCcc, liveSessions, autopilotCccs, panelResolved }
}
