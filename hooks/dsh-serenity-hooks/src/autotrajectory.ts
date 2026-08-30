/**
 * autotrajectory.ts — 自主轨迹（Self-Sustaining Trajectory）验证机制（v1.26.12）
 *
 * 依据：serenity-acc-specs/docs/self-sustaining-trajectory-hypothesis.md（v0.1 实验提案；
 * S142 2026-08-30 用户提出猜想 + 三项裁决：① 时钟驱动 ② 先验偏见自生+随机（随机充分引入）
 * ③ 人类=反馈来源（不直接参与））。
 *
 * 形态（用户审核定稿 v0.4）：
 *   · **前台运行**：时钟唤起 = 向活跃会话注入唤起消息（agent.steer，v1.22.5 自动继续同款
 *     通道）→ 模型自动继续 → 用户全程可见、随时可介入（人类反馈天然并入——同会话）。
 *   · **随机方向 = CCC 自定义 MSM**（用户拍板命名 auto_trajectory_random_basis_provider）：
 *     随机性归 CCC（它有具体反馈信息来源，自己写 MSM 保证"足够随机"），dsp 只机械
 *     exec 该 MSM 取 stdout 作为随机方向注入。未配置/未注册 → 本轮跳过（warn）。
 *   · **会话标志 = 目录名后缀 --auto**（用户拍板：后缀，验证用方便）：
 *     AGENT_SESSIONS/<date>--<desc>--auto/ → 该轨迹为自主形态；无标志会话不受影响。
 *   · **唤起窗口避开北京时间 8~18 点**（用户拍板：用量峰谷省钱）——avoidWakeHours 可覆盖。
 *   · **默认关**：serenity.json autotrajectory.enabled=false → 定时器不启动，零资源占用。
 *   · **零影响**：不修改任何现有工具 / seams / 外部面；新增独立模块 + ccc.ts 纯类型扩展。
 */

import type { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import { basename, dirname, join } from 'node:path'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { findSerenityRoot, loadSerenityConfig, type AutoTrajectorySettings } from './ccc.js'
import { runMsmAsync } from './msm-ops.js'
import { findSession, findLatestActiveSessionMd, sessionsRoot } from './session-ops.js'

const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'dsh-serenity-hooks' }

/** 随机方向 MSM 缺省名（用户拍板命名；CCC 注册同名 MSM 即开箱即用，randomMsm 可覆盖） */
export const DEFAULT_RANDOM_MSM = 'auto_trajectory_random_basis_provider'
/** 自主轨迹会话目录后缀标志（用户拍板：后缀） */
export const AUTO_DIR_SUFFIX = '--auto'
/** 调度 tick 周期（10min——验证形态"一个就够"） */
export const TICK_MS = 10 * 60 * 1000
/** SESSION.md 内「下一轮动机」段标记（自生偏见载体——轨迹预设自己的未来） */
export const MOTIVATION_MARKER = '下一轮动机'
/** 缺省避开的高峰时段（北京时间 [start, end) 不唤起——用量峰谷省钱） */
export const DEFAULT_AVOID_HOURS = { start: 8, end: 18 }

export function readAutoTrajectorySettings(root: string): AutoTrajectorySettings | null {
  return loadSerenityConfig(root).autotrajectory ?? null
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
export function isAutoTrajectorySession(mdPath: string): boolean {
  return basename(dirname(mdPath)).endsWith(AUTO_DIR_SUFFIX)
}

/** 目标会话定位：cfg.session（S###/目录名）优先，缺省最近活跃；无 → null */
export function resolveTargetMd(root: string, cfg: AutoTrajectorySettings): string | null {
  if (cfg?.session) {
    const found = findSession(sessionsRoot(root), cfg.session)
    if (found) {
      const md = join(found.path, 'SESSION.md')
      if (existsSync(md)) return md
    }
  }
  return findLatestActiveSessionMd(root)
}

/**
 * 唤起条件（纯逻辑，可测）：enabled + 未在运行 + 目录标志 + mtime 超间隔 + 窗口允许。
 */
export function shouldWake(
  settings: AutoTrajectorySettings,
  mdPath: string | null,
  nowMs: number,
  running: boolean,
): boolean {
  if (!settings?.enabled || running) return false
  if (!mdPath || !isAutoTrajectorySession(mdPath)) return false
  if (!inAllowedWakeWindow(nowMs, settings.avoidWakeHours)) return false
  try {
    const mtime = statSync(mdPath).mtimeMs
    const hours = Math.max(1, settings.intervalHours ?? 12)
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

/** 随机方向：exec CCC 自定义 MSM（randomMsm，缺省名）→ stdout；失败/非零 → null */
export async function fetchRandomBasis(root: string, msmName: string): Promise<string | null> {
  try {
    const res = (await runMsmAsync(root, { action: 'exec', name: msmName, args: [] })) as {
      exit?: number
      stdout?: string
      stderr?: string
    }
    if (res.exit !== 0) return null
    return res.stdout?.trim() || null
  } catch {
    return null
  }
}

/** 唤起消息（三段式：身份锚定 / 先验偏见[自生+随机] / 任务）——注入前台会话，用户可见 */
export function buildWakeMessage(opts: {
  sessionName: string
  mdPath: string
  intervalHours: number
  motivation: string | null
  randomBasis: string | null
}): string {
  const lines: string[] = [
    `[自主轨迹唤起] — 距上次轨迹活动已满 ${opts.intervalHours} 小时，自动继续。`,
    '',
    `身份锚定：继续 ${opts.sessionName} 的 trajectory（SESSION.md: ${opts.mdPath}）。`,
    '先验偏见：',
  ]
  if (opts.motivation) lines.push(`  · 自生动机：${opts.motivation}`)
  if (opts.randomBasis) lines.push(`  · 随机方向：${opts.randomBasis}`)
  if (!opts.motivation && !opts.randomBasis) lines.push('  · （无——本轮纯自主探索）')
  lines.push(
    '',
    '任务：执行一轮自主认知（探索/反事实检验），把产出写入 SESSION.md',
    '「自主探索日志」段，并预写「下一轮动机」段。完成后自然结束。',
  )
  return lines.join('\n')
}

/**
 * 装配（index.ts apply 调用）：仅当 CCC 配置 autotrajectory.enabled=true 时启动定时器；
 * 否则零资源占用。定时器 tick 检查唤起条件 → 注入活跃会话（agent.steer，前台可见）。
 */
export function registerAutoTrajectory(ctx: Context): void {
  const root = resolveAutoTrajectoryRoot(ctx)
  const settings = root ? readAutoTrajectorySettings(root) : null
  if (!settings?.enabled) return // 默认关
  let running = false

  const tick = (): void => {
    if (running) return // 防重入（一轮唤起进行中不重复触发）
    const mdPath = resolveTargetMd(root!, settings!)
    if (!shouldWake(settings!, mdPath, Date.now(), running)) return
    const agent = resolveTargetAgent(ctx, mdPath!)
    if (!agent) {
      console.warn('[serenity-hooks] ✗ 自主轨迹唤起跳过：目标会话 agent 不可得（session use 激活后重试）')
      return
    }
    running = true
    void (async () => {
      try {
        const msm = settings!.randomMsm?.trim() || DEFAULT_RANDOM_MSM
        const [randomBasis, motivation] = await Promise.all([
          fetchRandomBasis(root!, msm),
          Promise.resolve(readSelfGeneratedMotivation(mdPath!)),
        ])
        const message = buildWakeMessage({
          sessionName: basename(dirname(mdPath!)),
          mdPath: mdPath!,
          intervalHours: settings!.intervalHours ?? 12,
          motivation,
          randomBasis,
        })
        agent.steer(createUserMessage({ content: [{ type: 'text', text: message }], source: PLUGIN_SOURCE }))
        console.log(`[serenity-hooks] ✓ 自主轨迹唤起（${basename(dirname(mdPath!))}，随机源 ${msm}${randomBasis ? '' : '（随机源无输出）'}）`)
      } catch (err) {
        console.warn(`[serenity-hooks] ✗ 自主轨迹唤起失败: ${String((err as Error)?.message ?? err)}`)
      } finally {
        running = false
      }
    })()
  }

  const timer = setInterval(tick, TICK_MS)
  // unref：进程存活时定时器照常触发；进程退出（插件卸载/服务器停止）不阻塞退出——无需 dispose 事件
  timer.unref()
  // 启动时立即检查一次（插件重启后恢复节律，无需等首个 10min）
  tick()
}

/** 目标 agent：从 SESSION.md 反向定位 dsh 会话（标题 F3 命名 S###-日期 匹配）；不可得 → null */
function resolveTargetAgent(ctx: Context, mdPath: string): Agent | null {
  const dirName = basename(dirname(mdPath))
  const idMatch = dirName.match(/--S(\d{3,})--/)
  const sid = idMatch ? `S${idMatch[1]}` : null
  try {
    const sessions = (ctx as unknown as { sessions?: { list?: () => Array<{ id?: string; title?: string }> } }).sessions
    for (const s of sessions?.list?.() ?? []) {
      if (sid && (s.title === sid || s.title?.startsWith(`${sid}-`))) {
        const agent = (ctx as unknown as { agents?: { get?: (id: string) => Agent | undefined } }).agents?.get?.(s.id ?? '')
        if (agent) return agent
      }
    }
  } catch {
    /* 遍历失败忽略 */
  }
  return null
}

/** 自主轨迹绑定的 CCC 根：进程 cwd 上溯 .serenity 优先，回退任一 live 会话 root */
function resolveAutoTrajectoryRoot(ctx: Context): string | null {
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
