/**
 * autopilot-chain.ts — **唤起条件链的唯一实现**（"为什么这轮没被唤起"）
 *
 * 为什么单独成模块（R↓，⑥ C6a 的硬约束）：
 * C6 裁决把 autopilot 拆两半——**入口**分两处（CCC 工具面 / 开发面），但**判据只能有一份**。
 * 若开发面另写"文件读取版"，刚消掉的分歧会在开发面复活。故：
 *   · `acc-diag` ④ 段（进程内，带运行态事实）—— `./diag-ops.ts` 调 {@link buildWakeChain}
 *   · 开发面 `dsh-develop diag [--ccc <path>]`（离线 bun 进程，无运行态事实）—— **import 同一实现**
 * 两者的差别**只是传入的 facts**（进程内三项已知 / 离线三项不可知），判据本身不复制。
 *
 * 本模块**零 DSH 依赖**（只 node:fs/path + `ccc.js` + `autopilot-core.js`）——离线 bun 进程
 * 才 import 得动。判据一律取自 {@link judgeWake}（判据唯一真相源），本模块只做**分解与分类**。
 *
 * 判决语义（§12.7 修复，**不得回退**）：
 *   `✗` = 配置/环境问题（需人改，如 enabled=false / session 未命中 / agent 未加载）
 *   `⏸` = 等待中（到点/出窗口/上一轮跑完自会满足——**非**配置问题）
 *   `?` = 不可知（离线通道看不到的运行态；**不**当成满足）
 *   **只有 `✗` 与 `⏸` 都为空、且无 `?` 时才印 ✅**——旧实现只统计 `✗` ⇒ 每天北京 8~18 点
 *   （10 小时）都印「✅ 唤起条件全部满足」而插件实际不唤起（假阳性，已实测复现）。
 */

import { basename, dirname } from 'node:path'
import {
  AUTO_DIR_SUFFIX,
  DEFAULT_BIAS_PROVIDER,
  TICK_MINUTES,
  beijingHour,
  fetchBiasContent,
  isAutopilotSession,
  judgeWake,
  readAutopilotSettings,
  resolveTargetMd,
} from './autopilot-core.js'

/**
 * 条件链的**运行态事实**（只有插件进程知道的那部分；离线通道传 null = 不可知）。
 * 由 `autopilot-trajectory.ts` 的 `autopilotRuntimeFacts(ctx, root)` 产出。
 */
export interface WakeChainFacts {
  /** 周期自唤醒全局闸（`autopilotGloballyEnabled()`）；null = 不可知（离线通道） */
  globalGate: boolean | null
  /** 该 CCC 是否已有唤起轮在进行中（重入守卫）；null = 不可知 */
  running: boolean | null
  /** live 运行态；null = 不可知（离线通道） */
  live: {
    /** 该 CCC 的 live 会话数 */
    sessionCount: number
    /** 目标 agent 能否解析；null = 不适用（目标会话未命中，已由 session 条件判 ✗） */
    agentResolved: boolean | null
    /** agent 不可解析时的诊断文本（`diagnoseTargetUnavailable`） */
    diagnosis: string | null
  } | null
}

/** 离线通道事实（三项运行态全不可知） */
export const NO_RUNTIME_FACTS: WakeChainFacts = { globalGate: null, running: null, live: null }

/** 判决档（`ready` 只有在**没有** unknowns 时才可能给出——离线通道永远不会印 ✅） */
export type WakeChainVerdict = 'ready' | 'waiting' | 'blocked' | 'unknown'

export interface WakeChainReport {
  root: string
  /** 逐条件行（人读；行首 = ✓/✗/⏸/?/·） */
  lines: string[]
  /** `✗` 行（配置/环境问题，需人改） */
  blockers: string[]
  /** `⏸` 行（等待中） */
  waiting: string[]
  /** `?` 行（不可知——不当作满足） */
  unknowns: string[]
  /** 修复建议（仅在存在阻断点时输出） */
  suggestions: string[]
  verdict: WakeChainVerdict
  /** 判决行原文 */
  judgement: string
}

/** 运行偏见脚本的注入点（测试可替换；生产 = `fetchBiasContent`——插件 tick 的同一执行路径） */
export type BiasProbe = (root: string, providerRel: string) => Promise<{ text: string | null; error: string | null }>

/**
 * 组装条件链（**唯一实现**）。
 *
 * @param root CCC 根
 * @param facts 运行态事实（离线通道传 {@link NO_RUNTIME_FACTS}）
 * @param now 当前时刻（测试注入）
 * @param biasProbe 偏见执行（默认 {@link fetchBiasContent}——**不另写 spawn**）
 * @returns 结构化报告（渲染见 {@link renderWakeChain}）
 */
export async function buildWakeChain(
  root: string,
  facts: WakeChainFacts = NO_RUNTIME_FACTS,
  now: number = Date.now(),
  biasProbe: BiasProbe = fetchBiasContent,
): Promise<WakeChainReport> {
  const lines: string[] = [`═══ 自主轨迹唤起诊断：${basename(root)}（${root}）═══`]
  const blockers: string[] = []
  const waiting: string[] = []
  const unknowns: string[] = []
  const suggestions: string[] = []

  const mark = (kind: 'ok' | 'bad' | 'wait' | 'unknown' | 'info', text: string): void => {
    const prefix = kind === 'ok' ? '✓' : kind === 'bad' ? '✗' : kind === 'wait' ? '⏸' : kind === 'unknown' ? '?' : '·'
    const line = `${prefix} ${text}`
    lines.push(`  ${line}`)
    if (kind === 'bad') blockers.push(line)
    if (kind === 'wait') waiting.push(line)
    if (kind === 'unknown') unknowns.push(line)
  }

  // ⓪ 周期自唤醒全局闸（旧脚本**缺此判据**——闸关着也印 ✅，8 项分歧之首）
  if (facts.globalGate === null) {
    mark('unknown', '周期自唤醒全局闸：不可知（离线通道——只有插件进程能读 DSH 设置）')
  } else if (!facts.globalGate) {
    mark('bad', '周期自唤醒全局闸关闭（autopilotWakeEnabled=false）——时钟不武装，绝不唤起')
    suggestions.push('在 DSH 设置面板打开「周期自唤醒」（autopilotWakeEnabled）——关着则本 CCC 永不唤起')
  } else {
    mark('ok', '周期自唤醒全局闸开启（autopilotWakeEnabled=true）')
  }

  // ① enabled（该 CCC 的 trajectory.autopilot 配置）
  const cfg = readAutopilotSettings(root)
  if (!cfg) {
    mark('bad', 'trajectory.autopilot 未配置（.opencode/serenity.json 缺段）')
    suggestions.push('配置：container_admin autopilot init 一键写入 trajectory.autopilot 段')
  } else if (!cfg.enabled) {
    mark('bad', 'enabled = false（该 CCC 的周期自唤醒关闭）')
    suggestions.push('置 trajectory.autopilot.enabled = true')
  } else {
    mark('ok', 'enabled = true')
  }
  if (cfg) {
    lines.push(`    配置: intervalHours=${cfg.intervalHours ?? 12} | biasProvider=${cfg.biasProvider?.trim() || DEFAULT_BIAS_PROVIDER}${cfg.session ? ` | session=${cfg.session}` : ' | session=未配置'}`)
    const avoid = cfg.avoidWakeHours
    lines.push(`    窗口避开北京 ${avoid?.start ?? 8}~${avoid?.end ?? 18} 点`)
  }

  // ② session（必填——不默认任何会话）+ 目标命中
  const md = resolveTargetMd(root, cfg ?? {})
  if (!cfg?.session) {
    mark('bad', 'session 未配置（必填——自动唤起不默认任何会话）')
    suggestions.push('配置 trajectory.autopilot.session: "S###"（目标会话 S###/目录名）')
  } else if (!md) {
    mark('bad', `session=${cfg.session} 未命中（AGENT_SESSIONS 无匹配目录；匹配规则 = findSession：补零/去大小写）`)
    suggestions.push('确认目标会话存在（目录名含该关键字；S### 可省略补零）')
  } else {
    mark('ok', `session=${cfg.session} 命中（${basename(dirname(md))}）`)
  }

  // ③ --auto 会话标志
  if (md) {
    if (isAutopilotSession(md)) {
      mark('ok', '会话目录带 --auto 标志')
    } else {
      mark('bad', `会话目录无 --auto 标志（${basename(dirname(md))}）`)
      suggestions.push(`目录名加 ${AUTO_DIR_SUFFIX} 后缀：AGENT_SESSIONS/<date>--<desc>${AUTO_DIR_SUFFIX}/`)
    }
  }

  // ④⑤ 间隔 + 窗口（判据 = `judgeWake`，与 tick/status **同一份**）
  const j = judgeWake(cfg, md, now)
  if (md && j.idleHours !== null) {
    if (j.intervalOk) {
      mark('ok', `距上次轨迹活动 ${j.idleHours.toFixed(1)}h ≥ 阈值 ${j.interval}h`)
    } else {
      mark('wait', `距上次轨迹活动 ${j.idleHours.toFixed(1)}h < 阈值 ${j.interval}h（等待中——不满足不唤起）`)
    }
  }
  const h = beijingHour(now)
  if (j.windowOk) {
    mark('ok', `当前北京 ${h} 点——在唤起窗口内`)
  } else {
    mark('wait', `当前北京 ${h} 点——高峰避开中（缺省 8~18，用量峰谷省钱）`)
  }

  // ⑥ 偏见内容提供者脚本
  if (cfg?.enabled) {
    const provider = cfg.biasProvider?.trim() || DEFAULT_BIAS_PROVIDER
    const bias = await biasProbe(root, provider)
    if (bias.error) {
      mark('bad', `偏见脚本: ${bias.error}`)
      suggestions.push('实现偏见脚本（container_admin autopilot init 生成模板后编辑）')
    } else {
      mark('ok', `偏见脚本可运行（输出: ${bias.text ?? '（空）'}）`)
    }
  }

  // ⑦ live 运行态：目标会话是否已在 WebUI 打开 + agent 能否解析（旧脚本**缺此判据**）
  if (facts.live === null) {
    mark('unknown', '目标会话 live 运行态：不可知（离线通道——live 会话/agent 只有插件进程能看到）')
  } else if (facts.live.agentResolved === null) {
    lines.push(`  · live 会话: 本 CCC ${facts.live.sessionCount} 个（agent 可解析性不适用——目标会话未命中）`)
  } else if (facts.live.agentResolved) {
    mark('ok', `目标会话 agent 已定位（本 CCC live 会话 ${facts.live.sessionCount} 个）`)
  } else {
    mark('bad', `目标会话 agent 未定位（本 CCC live 会话 ${facts.live.sessionCount} 个）`)
    if (facts.live.diagnosis) lines.push(`    ${facts.live.diagnosis}`)
    suggestions.push('在 WebUI 打开目标会话（唤起需要 live agent 接收注入）')
  }

  // ⑧ 重入守卫（旧脚本**缺此判据**）
  if (facts.running === null) {
    mark('unknown', '重入守卫：不可知（离线通道——进行中的唤起轮只有插件进程知道）')
  } else if (facts.running) {
    mark('wait', '该 CCC 已有一轮唤起在进行中（本轮跳过——跑完自然恢复）')
  } else {
    mark('ok', '无进行中的唤起轮')
  }

  // 判决（§12.7 语义：`✗` 与 `⏸` 都表示"此刻尚未满足"，性质不同故分开呈现）
  lines.push('')
  let verdict: WakeChainVerdict
  let judgement: string
  if (blockers.length === 0 && waiting.length === 0 && unknowns.length === 0) {
    verdict = 'ready'
    judgement = `✅ 唤起条件全部满足——等待下一个 ${TICK_MINUTES}min tick 自动唤起（前台可见）`
  } else if (blockers.length === 0 && waiting.length === 0) {
    verdict = 'unknown'
    judgement = `? 已知条件全部满足——但有 ${unknowns.length} 项不可知（${unknowns.length > 0 ? '离线通道看不到运行态' : ''}）；是否真会唤起需插件进程判定（acc-diag）`
  } else if (blockers.length === 0) {
    verdict = 'waiting'
    judgement = `⏸ 尚未满足 ${waiting.length} 项（等待中——到点/出窗口后自动满足，**非**配置问题；见上方 ⏸ 行）`
  } else {
    verdict = 'blocked'
    judgement = `⚠️ 阻断点 ${blockers.length} 项${waiting.length > 0 ? `（另 ${waiting.length} 项等待中）` : ''}（全部满足才唤起）：`
  }
  lines.push(judgement)
  if (verdict === 'blocked') for (const s of suggestions) lines.push(`  → ${s}`)
  if (verdict !== 'blocked' && unknowns.length > 0) {
    lines.push(`  · 不可知项：${unknowns.length} 项（见上方 ? 行——离线通道看不到运行态，**不**当作满足）`)
  }
  return { root, lines, blockers, waiting, unknowns, suggestions, verdict, judgement }
}

/** 条件链渲染（④ 段文本；`renderAccDiag` 与开发面 `diag` 共用） */
export function renderWakeChain(r: WakeChainReport): string {
  return r.lines.join('\n')
}
