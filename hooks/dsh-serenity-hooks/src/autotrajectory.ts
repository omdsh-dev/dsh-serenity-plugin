/**
 * autotrajectory.ts — 自主轨迹（Self-Sustaining Trajectory）验证机制（v1.26.12）
 *
 * 依据：serenity-acc-specs/docs/self-sustaining-trajectory-hypothesis.md（v0.1 实验提案；
 * S142 2026-08-30 用户提出猜想 + 三项裁决：① 时钟驱动 ② 先验偏见自生+随机（随机充分引入）
 * ③ 人类=反馈来源（不直接参与））。
 *
 * 形态（用户审核定稿 v0.5）：
 *   · **前台运行**：时钟唤起 = 向活跃会话注入唤起消息（agent.steer，v1.22.5 自动继续同款
 *     通道）→ 模型自动继续 → 用户全程可见、随时可介入（人类反馈天然并入——同会话）。
 *   · **偏见内容提供者 = CCC 根目录下脚本**（用户拍板：不再让 CCC 注册 MSM；tool 直接运行脚本；
 *     命名修正：它不是"随机脚本"，本质是**偏见内容提供者**——biasProvider）：
 *     配置 biasProvider（相对 CCC 根，缺省 autotrajectory-bias.ts）——tool 直接运行取
 *     stdout 作为偏见内容；脚本缺失 → **报错要求实现**（偏见内容归 CCC，实现 = 根目录放脚本）。
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
import { spawnSync } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { findSerenityRoot, loadSerenityConfig, resolveInside, type AutoTrajectorySettings } from './ccc.js'
import { findSession, sessionsRoot } from './session-ops.js'

const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'dsh-serenity-hooks' }

/** 偏见内容提供者脚本缺省名（CCC 根目录下；用户拍板：tool 直接运行，缺失报错要求实现） */
export const DEFAULT_BIAS_PROVIDER = 'autotrajectory-bias.ts'
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

/**
 * 目标会话定位：**必须配置 cfg.session**（S###/目录名）——CCC 日常有多条 trajectory 在跑，
 * 绝不默认唤起（缺省最近活跃会误伤其他正在运行的轨迹；用户拍板：必须配置才生效）。
 * 未配置 session 或未命中 → null（不唤起）。
 */
export function resolveTargetMd(root: string, cfg: AutoTrajectorySettings): string | null {
  if (!cfg?.session) return null
  const found = findSession(sessionsRoot(root), cfg.session)
  if (!found) return null
  const md = join(found.path, 'SESSION.md')
  return existsSync(md) ? md : null
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

/**
 * 偏见内容：直接运行 CCC 根目录下偏见提供者脚本（biasProvider，缺省 autotrajectory-bias.ts）→ stdout。
 * 脚本缺失 → 返回 { text: null, error: 提示实现 }（唤起侧报错要求实现，不静默跳过）。
 * 路径逃逸校验（resolveInside）；bun 优先，node 兜底；600s 超时。
 */
export async function fetchBiasContent(root: string, providerRel: string): Promise<{ text: string | null; error: string | null }> {
  let scriptAbs: string
  try {
    scriptAbs = resolveInside(root, providerRel)
  } catch {
    return { text: null, error: `biasProvider 路径逃逸（须在 CCC 根内）: ${providerRel}` }
  }
  if (!existsSync(scriptAbs)) {
    return { text: null, error: `请在 CCC 根目录实现偏见内容提供者脚本: ${providerRel}（stdout 输出偏见内容一行；acc_msm exec autotrajectory-exp init 可生成模板）` }
  }
  const runs: Array<[string, string[]]> = [
    ['bun', [scriptAbs]],
    [process.execPath, [scriptAbs]],
  ]
  for (const [cmd, args] of runs) {
    try {
      const r = spawnSync(cmd, args, { encoding: 'utf-8', timeout: 600_000, stdio: ['ignore', 'pipe', 'pipe'] })
      if (r.status === 0) {
        const text = (r.stdout ?? '').trim()
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

/** 唤起消息（三段式：身份锚定 / 先验偏见[自生动机+偏见内容] / 任务）——注入前台会话，用户可见 */
export function buildWakeMessage(opts: {
  sessionName: string
  mdPath: string
  intervalHours: number
  motivation: string | null
  biasContent: string | null
}): string {
  const lines: string[] = [
    `[自主轨迹唤起] — 距上次轨迹活动已满 ${opts.intervalHours} 小时，自动继续。`,
    '',
    `身份锚定：继续 ${opts.sessionName} 的 trajectory（SESSION.md: ${opts.mdPath}）。`,
    '先验偏见：',
  ]
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

/**
 * 执行一次唤起（时钟 tick 与面板「立即唤起」共用）：
 * - force=false（时钟）：完整校验——enabled / 目标命中 / --auto 标志 / 窗口 / 间隔 / 偏见脚本
 * - force=true（手动调试，用户在场）：跳过窗口与间隔，仍校验 enabled / 目标命中 / --auto / 偏见脚本
 * 成功 → 注入前台会话（agent.steer，用户可见）；返回结果供调用方（tick 打日志 / 面板显示）。
 */
export interface WakeResult {
  ok: boolean
  detail: string
}

export async function performAutoTrajectoryWake(
  ctx: Context,
  root: string,
  settings: AutoTrajectorySettings,
  opts: { force?: boolean } = {},
): Promise<WakeResult> {
  if (!settings?.enabled) return { ok: false, detail: 'autotrajectory 未启用（enabled=false）' }
  const mdPath = resolveTargetMd(root, settings)
  if (!mdPath) return { ok: false, detail: '目标会话未命中（session 未配置或 AGENT_SESSIONS 无匹配）' }
  if (!isAutoTrajectorySession(mdPath)) return { ok: false, detail: '目标会话目录无 --auto 标志（AGENT_SESSIONS/<date>--<desc>--auto/）' }
  if (!opts.force) {
    const now = Date.now()
    if (!inAllowedWakeWindow(now, settings.avoidWakeHours)) return { ok: false, detail: '当前在北京高峰避开窗口内（不唤起）' }
    try {
      const mtime = statSync(mdPath).mtimeMs
      const hours = Math.max(1, settings.intervalHours ?? 12)
      if (now - mtime < hours * 3600_000) return { ok: false, detail: `距上次轨迹活动不足 ${hours}h（等待中）` }
    } catch {
      return { ok: false, detail: 'SESSION.md 读取失败（statSync）' }
    }
  }
  const agent = resolveTargetAgent(ctx, mdPath)
  if (!agent) {
    return { ok: false, detail: '目标会话 agent 不可得（先在会话列表激活目标会话后重试）' }
  }
  const provider = settings.biasProvider?.trim() || DEFAULT_BIAS_PROVIDER
  const biasRes = await fetchBiasContent(root, provider)
  if (biasRes.error) return { ok: false, detail: `偏见内容缺失：${biasRes.error}` }
  const motivation = readSelfGeneratedMotivation(mdPath)
  const message = buildWakeMessage({
    sessionName: basename(dirname(mdPath)),
    mdPath,
    intervalHours: Math.max(1, settings.intervalHours ?? 12),
    motivation,
    biasContent: biasRes.text,
  })
  agent.steer(createUserMessage({ content: [{ type: 'text', text: message }], source: PLUGIN_SOURCE }))
  return { ok: true, detail: `已唤起 ${basename(dirname(mdPath))}（偏见提供者 ${provider}）` }
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
    running = true
    void (async () => {
      try {
        const res = await performAutoTrajectoryWake(ctx, root!, settings!, { force: false })
        if (res.ok) console.log(`[serenity-hooks] ✓ 自主轨迹唤起（${res.detail}）`)
        else console.warn(`[serenity-hooks] ✗ 自主轨迹唤起跳过：${res.detail}`)
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

/**
 * 面板状态（GET /serenity/autotrajectory 数据源；纯逻辑，可单测）——
 * WebUI 设置面板「自主轨迹」只读区块展示的完整状态：配置摘要 + 目标会话
 * 命中/标志/空闲时长 + 当前窗口/可唤起判定（唤起逻辑同 registerAutoTrajectory）。
 * 不运行偏见脚本（只报脚本是否就绪——运行验证走 autotrajectory-exp random）。
 */
export interface AutoTrajectoryStatus {
  /** 是否配置了 autotrajectory 段（.opencode/serenity.json） */
  configured: boolean
  /** 总开关（缺省 false——未开零资源占用） */
  enabled: boolean
  /** 无人类活动 N 小时后自动唤起（缺省 12） */
  intervalHours: number
  /** 偏见内容提供者脚本（相对 CCC 根；缺省 autotrajectory-bias.ts） */
  biasProvider: string
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
    /** 当前时刻是否满足唤起条件（标志+间隔+窗口，未运行中） */
    wakeable: boolean
  } | null
  /** 当前北京时间小时 */
  beijingHour: number
  /** 当前是否在唤起窗口内（避开高峰之外） */
  windowAllowed: boolean
}

export function getAutoTrajectoryStatus(root: string): AutoTrajectoryStatus {
  const cfg = readAutoTrajectorySettings(root)
  const now = Date.now()
  const base = {
    configured: cfg !== null,
    enabled: cfg?.enabled ?? false,
    intervalHours: Math.max(1, cfg?.intervalHours ?? 12),
    biasProvider: cfg?.biasProvider?.trim() || DEFAULT_BIAS_PROVIDER,
    session: cfg?.session ?? null,
    avoidWakeHours: {
      start: cfg?.avoidWakeHours?.start ?? DEFAULT_AVOID_HOURS.start,
      end: cfg?.avoidWakeHours?.end ?? DEFAULT_AVOID_HOURS.end,
    },
    beijingHour: beijingHour(now),
    windowAllowed: inAllowedWakeWindow(now, cfg?.avoidWakeHours),
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
      autoFlag: isAutoTrajectorySession(mdPath),
      idleHours: Math.max(0, idleHours),
      wakeable: shouldWake(cfg, mdPath, now, false),
    },
  }
}
