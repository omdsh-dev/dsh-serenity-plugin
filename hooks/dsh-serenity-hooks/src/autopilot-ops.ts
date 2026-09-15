/**
 * autopilot-ops.ts — `container_admin autopilot` 三动作的**进程内实现**（⑥ C6a 块 A）
 *
 * 为什么搬到进程内（R↓，S142 §12.8 裁决「拆两半、退掉独立脚本」）：
 * 三个动作（`status` / `init` / `generate-bias`）的逻辑原先**全在**独立脚本
 * `experiments/autopilot-trajectory/scripts/autopilot-trajectory.ts` 里，插件只 spawn 转发。
 * 该脚本是独立进程 ⇒ **只能读文件** ⇒ 看不到全局闸 / live 会话 / agent 可解析性 ⇒
 * 它印出的"状态"与插件实际行为**结构性分歧**（8 项，见现状稿 §4.4；含"闸关着也印 ✅"
 * 这种用户可见的假报告）。搬进进程内后，`status`/`check` 读的就是
 * {@link autopilotRuntimeFacts}——**与 tick 同一份判据**。
 *
 * 三个动作（对外名字与语义不变）：
 *   · `status`        —— 一站式全报告：背景 + 就绪检查（条件链）+ 进程态 + 状态快照 + 下一步 + 指引
 *   · `init`          —— 写/迁移 CCC 配置 `trajectory.autopilot`（**迁移后删旧键**）+ 生成偏见脚本模板
 *   · `generate-bias` —— 运行偏见提供者脚本，输出本轮偏见内容（**复用 tick 的 `fetchBiasContent`**）
 *
 * 边界（**不碰 tick**）：本模块只做"报告 / 配置 / 跑偏见"，**不参与**真正的唤起决策——
 * 唤起决策仍在 `autopilot-trajectory.ts` 的 tick（D59 单例语义、串行链、per-CCC 重入守卫未动）。
 */

import type { Context } from 'cordis'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  DEFAULT_BIAS_PROVIDER,
  biasProviderAbsPath,
  fetchBiasContent,
  readAutopilotSettings,
  readUtf8,
  resolveTargetMd,
  judgeWake,
  isAutopilotSession,
} from './autopilot-core.js'
import {
  buildWakeChain,
  renderWakeChain,
  type WakeChainFacts,
  type WakeChainReport,
} from './autopilot-chain.js'
import {
  autopilotClockState,
  autopilotGloballyEnabled,
  autopilotRuntimeFacts,
  autopilotWakeInFlight,
} from './autopilot-trajectory.js'

/**
 * CCC 配置路径回退链（与 `ccc.ts` 的 `DEFAULT_SERENITY_CONFIG_PATHS` 同序）：
 * `.opencode/serenity.json` 优先，不存在则 `.dsh/serenity.json`（**沿用旧脚本语义**）。
 */
const CONFIG_PATHS = ['.opencode/serenity.json', '.dsh/serenity.json'] as const

/** 偏见内容提供者脚本脚手架模板（init 生成；CCC 按自己的反馈信息来源改写） */
const BIAS_TEMPLATE = `#!/usr/bin/env bun
/**
 * autopilot-bias.ts — 自主轨迹偏见内容提供者（CCC 实现）
 *
 * stdout 输出一行/一段文本 = 本轮唤起注入的偏见内容（反事实问题 / 探索方向 /
 * 任何让轨迹偏离既有路径的输入）。偏见内容归 CCC——用本 CCC 自己的反馈信息来源
 * 保证"足够随机"（历史会话 / 技能 / 文档 / 外部信息 / 真随机源……）。
 *
 * 本文件为脚手架——请按本 CCC 的信息来源改写。
 */
const sources = [
  'AGENT_SESSIONS 中的历史会话',
  '.opencode/skills 技能目录',
  'docs/ 设计文档',
  '…（CCC 自己的信息来源）',
]
const pick = sources[Math.floor(Math.random() * sources.length)]
console.log(\`反事实：如果「\${pick}」换个做法会怎样？\`)
`

/** 背景摘要（一站式报告的第一节——CCC agent 快速理解"为什么/验证什么"） */
const BACKGROUND = [
  '═══ 自主轨迹实验（Self-Sustaining Trajectory）═══',
  '背景：Trajectory 是主体（Agent 可替换、Session 载体可重建）。瓶颈 = 人类 waiting——',
  '      轨迹以"等待人类"为推进条件时，事件序列时间被人类响应间隔锚定，运转被拖慢。',
  '猜想：无人等待的 trajectory——时钟自动唤起 + 先验偏见（自生动机 + 偏见内容）→ 运转加速。',
  '验证：P4 可自动唤起并携带偏见 / P5 速度提升→更快产生满意效果；反证=熵增失控/自我确认/噪音化。',
  '理论：specs §0.7 记录器→校准器（预测加工）。完整定义：experiments/autopilot-trajectory/SKILL.md。',
  '',
].join('\n')

/** 步骤指引（`status` 末节；与 SKILL.md §3「参与方式」同源） */
const GUIDE = [
  '[autopilot-trajectory] 实验步骤指引',
  '',
  '① 初始化（一键）：container_admin autopilot init',
  '   ——写配置（.opencode/serenity.json 的 trajectory.autopilot 段）+ 生成偏见提供者脚本模板（CCC 根 autopilot-bias.ts）',
  '② **定义轨迹焦点（topPrompt）**：编辑配置中的 topPrompt——**CCC 自己填写**本轨迹的核心',
  '   目标/纪律/质量要求（示例："持续深化某领域认知，产出可重建的结论与决策记录"）。',
  '   它会在每次唤起时最先注入（[轨迹焦点] 段），作为稳定焦点锚定 trajectory 防漂移——',
  '   **实验观察：无焦点锚定时多轮唤起轨迹腐化严重（焦点丢失）**。勿留空。',
  '③ 实现偏见内容提供者：编辑 autopilot-bias.ts，stdout 输出偏见内容（反事实方向/探索动机，',
  '   用本 CCC 自己的信息来源保证"足够随机"）；container_admin autopilot generate-bias 验证',
  '④ 标记目标会话：目录名加 --auto 后缀 AGENT_SESSIONS/<date>--<desc>--auto/',
  '   （可选）该 SESSION.md 写「下一轮动机」段作自生偏见',
  '⑤ 验证就绪：container_admin autopilot status（一站式报告应为 ✅；topPrompt 未定义会 ⚠ 提示）',
  '⑥ **确认全局闸已开**：DSH 设置面板「周期自唤醒」（autopilotWakeEnabled）——关着则本 CCC 永不唤起',
  '⑦ 观察：无人类活动满 intervalHours 且北京非高峰 → 前台会话自动出现 [自主轨迹唤起]',
  '   产出落 SESSION.md「自主探索日志」+ 预写「下一轮动机」',
  '',
  '分工：焦点（topPrompt）= 稳定锚，每轮不变；偏见（biasProvider）= 随机探索方向，每轮不同——两者都由 CCC 定义。',
  '定义全文见 experiments/autopilot-trajectory/SKILL.md（仓库内文档，不再有可执行脚本 entry）',
  '运行态诊断（live 会话 / agent 定位 / 唤醒注册表 / 本条件链）：专属工具 acc-diag（ACC 负责人）',
].join('\n')

/** 一次动作的结果（`container_admin` 直接透出；`error` 非空即失败，不静默） */
export interface AutopilotActionResult {
  action: 'status' | 'init' | 'generate-bias'
  output: string
  error?: string
}

/**
 * 条件链事实：全局闸与重入守卫**恒为真值**（二者不需要 ctx）；live 运行态在无 ctx 时标"不可知"。
 * 即"闸关着"在任何进程中路径都**不会**被降级成 `?`（假报告的正是这一类）。
 */
function factsFor(root: string, ctx?: Context): WakeChainFacts {
  return autopilotRuntimeFacts(ctx ?? null, root)
}

/** 就绪检查（= 旧脚本 `check`）：条件链的逐条件报告 + 判决（判据单一真相源 = `buildWakeChain`） */
export async function autopilotCheck(root: string, ctx?: Context): Promise<WakeChainReport> {
  return buildWakeChain(root, factsFor(root, ctx))
}

/**
 * 进程态区块（**进程内新增的增益**——旧脚本永远看不到这一行）：
 * 全局闸 / 时钟是否武装 / 已 tick 次数 / 上次 tick / 上次跳过原因 / 是否有唤起在进行中。
 * "为什么没唤起"的第一手判据：闸关着、时钟没武装时，条件再全绿也不会唤起。
 */
function runtimeBlock(root: string): string {
  const s = autopilotClockState()
  const ts = (ms: number | null): string => (ms === null ? '（从未）' : new Date(ms).toISOString())
  const parts = [
    `全局闸=${s.enabled ? '开' : '关'}`,
    `时钟已武装=${s.armed}`,
    `tick 次数=${s.ticks}`,
    `上次 tick=${ts(s.lastTickAt)}`,
  ]
  if (s.lastSkipReason) parts.push(`上次跳过: ${s.lastSkipReason}`)
  parts.push(`本轮唤起进行中=${autopilotWakeInFlight(root)}`)
  return `进程态（本插件进程）：${parts.join(' ｜ ')}`
}

/** 状态快照区块（配置 / 目标 / 空闲时长 / 窗口——数值取自 `autopilot-core` 的同一判据） */
function stateBlock(root: string): string {
  const cfg = readAutopilotSettings(root)
  const now = Date.now()
  const hour = Math.floor(((now + 8 * 3600_000) % 86400_000) / 3600_000)
  const head = `[autopilot-trajectory] 实验状态（CCC: ${basename(root)}，北京 ${hour} 点）`
  if (!cfg?.enabled) {
    return [head, '', 'trajectory.autopilot 未启用（enabled=false 或未配置）——零资源占用'].join('\n')
  }
  const lines = [
    head,
    '',
    `配置: intervalHours=${cfg.intervalHours ?? 12} | biasProvider=${cfg.biasProvider?.trim() || DEFAULT_BIAS_PROVIDER}` +
      `${cfg.session ? ` | session=${cfg.session}` : ''}${cfg.topPrompt?.trim() ? ' | topPrompt ✓' : ''}`,
  ]
  const md = resolveTargetMd(root, cfg)
  if (!md) {
    lines.push('目标会话：未找到')
    return lines.join('\n')
  }
  const j = judgeWake(cfg, md, now)
  lines.push(`目标会话：${basename(dirname(md))}${isAutopilotSession(md) ? '（--auto ✓）' : '（无 --auto 标志）'}`)
  lines.push(`上次轨迹活动：${j.idleHours === null ? '（不可读）' : `${j.idleHours.toFixed(1)} 小时前`}（阈值 ${j.interval}h）`)
  lines.push(`唤起窗口：${j.windowOk ? '✅ 允许唤起' : '⏸ 高峰避开中（北京 8~18）'}`)
  lines.push(
    `是否可唤起：${j.wakeable ? `✅ 时间条件满足（仍须全局闸开 + agent 已定位；见上/下）` : !j.intervalOk ? `否——距上次活动不足 ${j.interval}h` : '否——高峰避开中'}`,
  )
  return lines.join('\n')
}

/** 下一步判据（与旧脚本 `all` 的「下一步」同语义，但改读**条件链判决**——不再自己判一遍） */
function nextSteps(chain: WakeChainReport): string {
  const lines = ['═══ 下一步 ═══']
  const noCfg = chain.blockers.some((b) => b.includes('trajectory.autopilot 未配置'))
  const disabled = chain.blockers.some((b) => b.includes('enabled = false'))
  if (noCfg) {
    lines.push('→ 本 CCC 尚未配置 trajectory.autopilot。开始实验：container_admin autopilot init 一键初始化。')
  } else if (disabled) {
    lines.push('→ trajectory.autopilot.enabled 为 false——置 true 开启实验（或 init 重新初始化）。')
  } else if (chain.verdict === 'blocked') {
    lines.push('→ 存在未就绪项（见上）。补齐后重跑本命令确认。')
  } else if (chain.verdict === 'waiting') {
    lines.push('→ 条件尚未到点（见上 ⏸ 行）——等待中，非配置问题；到点/出窗口后自动唤起。')
  } else {
    lines.push('→ 已就绪。保持会话空闲满 intervalHours 且北京非高峰 → 自动唤起（前台可见）。')
    lines.push('→ 之后可随时 container_admin autopilot status 查看距下次唤起的进度。')
  }
  return lines.join('\n')
}

/**
 * `status` —— 一站式全报告（背景 + 就绪检查 + 进程态 + 状态 + 下一步 + 指引）。
 * 由进程内数据组装（旧实现是 `bun` 子进程跑脚本，故看不到任何运行态）。
 */
export async function autopilotStatus(root: string, ctx?: Context): Promise<AutopilotActionResult> {
  const chain = await autopilotCheck(root, ctx)
  const output = [
    BACKGROUND,
    renderWakeChain(chain),
    '',
    runtimeBlock(root),
    '',
    stateBlock(root),
    '',
    nextSteps(chain),
    '',
    GUIDE,
  ].join('\n')
  return { action: 'status', output }
}

/**
 * `init` —— 写/迁移 CCC 配置 + 生成偏见脚本模板。
 *
 * 迁移语义（沿用旧脚本，理由写在码内）：写入**新键** `trajectory.autopilot`（D58）；
 * 旧键 `autopilotTrajectory` / `autotrajectory` 存在则**迁移并删除**——保留两处会形成
 * "改了不生效"的双真相源（读侧新键优先，旧键是死数据）。
 */
export function autopilotInit(root: string): AutopilotActionResult {
  const out: string[] = ['[autopilot-trajectory] 初始化实验', '']

  // ① 写配置（合并，不覆盖其他段；CONFIG_PATHS 回退与读侧同序）
  let cfgPath = join(root, CONFIG_PATHS[0])
  if (!existsSync(cfgPath)) {
    const alt = join(root, CONFIG_PATHS[1])
    cfgPath = existsSync(alt) ? alt : cfgPath
  }
  mkdirSync(dirname(cfgPath), { recursive: true })
  let merged: Record<string, unknown> = {}
  if (existsSync(cfgPath)) {
    try {
      merged = JSON.parse(readUtf8(cfgPath)) as Record<string, unknown>
    } catch {
      /* 损坏则重建 */
    }
  }
  const traj = (merged.trajectory as Record<string, unknown> | undefined) ?? {}
  const legacy =
    (merged.autopilotTrajectory as Record<string, unknown> | undefined) ??
    (merged.autotrajectory as Record<string, unknown> | undefined)
  const at = (traj.autopilot as Record<string, unknown> | undefined) ?? legacy ?? {}
  merged.trajectory = {
    ...traj,
    autopilot: {
      enabled: true,
      intervalHours: 12,
      biasProvider: DEFAULT_BIAS_PROVIDER,
      // 轨迹焦点（topPrompt）：**CCC 自己定义**本轨迹的核心目标/纪律/质量要求——每次唤起最先
      // 注入，作为稳定焦点锚定 trajectory，防止多轮自主唤起中焦点丢失（腐化）。请按本 CCC
      // 的轨迹目标改写，不要留空（留空 = 唤起无焦点锚定，轨迹易漂移）。
      topPrompt: '本轨迹的核心焦点：<CCC 填写——例如：持续深化某领域认知，产出可重建的结论与决策记录>',
      ...at,
    },
  }
  const migrated = Boolean(legacy)
  delete merged.autopilotTrajectory
  delete merged.autotrajectory
  writeFileSync(cfgPath, `${JSON.stringify(merged, null, 2)}\n`)
  out.push(`✓ 配置写入: ${cfgPath}`)
  out.push(`  trajectory.autopilot = ${JSON.stringify((merged.trajectory as Record<string, unknown>).autopilot)}`)
  if (migrated) out.push('  ↑ 已从旧键 autopilotTrajectory/autotrajectory 迁移到 trajectory.autopilot（旧键已删除，避免双真相源）')
  out.push('  ⚠ 请编辑 topPrompt 为**本 CCC 的轨迹焦点**（现为占位——每次唤起最先注入，防轨迹漂移，勿留空）')

  // ② 生成偏见提供者脚本模板（已存在则保留）
  const scriptAbs = biasProviderAbsPath(root, DEFAULT_BIAS_PROVIDER)
  if (existsSync(scriptAbs)) {
    out.push(`· 偏见提供者脚本已存在（保留）: ${DEFAULT_BIAS_PROVIDER}`)
  } else {
    writeFileSync(scriptAbs, BIAS_TEMPLATE)
    out.push(`✓ 已生成偏见提供者脚本模板: ${DEFAULT_BIAS_PROVIDER}（编辑它，stdout 输出偏见内容）`)
  }

  // ③ 全局闸提示（进程内增益：旧脚本不知道闸存在 ⇒ 初始化完也可能永不唤起）
  const gate = autopilotGloballyEnabled()
  out.push(
    gate
      ? '✓ 周期自唤醒全局闸已开（autopilotWakeEnabled=true）'
      : '✗ 周期自唤醒全局闸**关着**（autopilotWakeEnabled=false）——配置写完也不会唤起，请在 DSH 设置面板打开「周期自唤醒」',
  )

  out.push('', '下一步：② 编辑配置 topPrompt（轨迹焦点——CCC 自己填写本轨迹核心目标，勿留空）→ ③ 标记目标会话 --auto 后缀 → ⑤ container_admin autopilot status 验证就绪')
  return { action: 'init', output: out.join('\n') }
}

/**
 * `generate-bias` —— 运行偏见提供者脚本并打印本轮内容（验证用）。
 * **复用 tick 的 {@link fetchBiasContent}**（同一份执行代码：60s 超时 / 8KB 截断 /
 * 旧默认名回退）——不另写 spawn（§12.13）。
 */
export async function autopilotGenerateBias(root: string): Promise<AutopilotActionResult> {
  const cfg = readAutopilotSettings(root)
  const provider = cfg?.biasProvider?.trim() || DEFAULT_BIAS_PROVIDER
  const bias = await fetchBiasContent(root, provider)
  if (bias.error) return { action: 'generate-bias', output: '', error: bias.error }
  return {
    action: 'generate-bias',
    output: `[autopilot-trajectory] 当前偏见内容（${provider}）:\n${bias.text ?? '（空输出）'}`,
  }
}
