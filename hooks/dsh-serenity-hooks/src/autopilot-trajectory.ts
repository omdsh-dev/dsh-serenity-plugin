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
import { basename, dirname } from 'node:path'
import { statSync } from 'node:fs'
import type { AutopilotTrajectorySettings } from './ccc.js'
import {
  DEFAULT_BIAS_PROVIDER,
  DEFAULT_AVOID_HOURS,
  MIN_INTERVAL_HOURS,
  AUTO_DIR_SUFFIX,
  beijingHour,
  inAllowedWakeWindow,
  isAutopilotSession,
  readAutopilotSettings,
  resolveTargetMd,
  shouldWake,
  readSelfGeneratedMotivation,
  fetchBiasContent,
  type WakeRecord,
} from './autopilot-core.js'
import { createClock, type ClockOptions, type ClockRuntime } from './clock-runtime.js'
import type { WakeChainFacts } from './autopilot-chain.js'
import { cccRootForCwd } from './ccc-roots.js'
import { sessionEvents } from './trajectory-ops.js'
import { readLastBound } from './trajectory-bound.js'
import { readSimpleSettings } from './settings-section.js'
import { hostAgents, hostSessions } from './host/access.js'
import { registerDisposer } from './host/effect.js'

const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'dsh-serenity-hooks' }

/**
 * 判据原语（`readAutopilotSettings` / `beijingHour` / `inAllowedWakeWindow` /
 * `isAutopilotSession` / `resolveTargetMd` / `judgeWake` / `shouldWake` /
 * `readSelfGeneratedMotivation` / `fetchBiasContent` / 常量）**已提取至
 * `autopilot-core.ts`**（S142 §12.13 ⑥ C6a）——本文件是它们的**组合方之一**
 * （tick + 面板 + agent 定位），不再自持判据副本。
 * 提取理由与"三处消费方共用一份判据"的约束见该文件头部注释。
 */

/** 审计历史 ring 上限（每 CCC 保留最近 N 条唤起记录） */
export const AUDIT_HISTORY_MAX = 50

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
    `[Autopilot Trajectory · 唤起] — 距上次轨迹活动已满 ${intervalLabel}，自动继续。`,
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
interface WakeResult {
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
 * - force=false（时钟）：完整校验——enabled / 目标命中 / --auto 标志 / 窗口 / 间隔 / 偏见脚本
 * - force=true（手动调试，用户在场）：跳过窗口/间隔，仍校验 enabled / 目标命中 / --auto / 偏见脚本
 *   （v1.27.12 移除每日唤起预算——force 无预算可跳，时钟也不受限）
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
 * **周期自唤醒全局闸**（v1.34 更名收窄，原 `autopilotEnabled`）：关 = 定时器不武装 + tick 不唤起。
 *
 * 语义边界（用户 2026-09-15 裁决 S-1）：**只管周期自唤醒** —— 一次性唤醒（`container_trajectory wake-later`）
 * 归 `wakeSchedulerEnabled`，两者**互不连带**（旧实现共用一闸是缺陷，见 wake-scheduler 注释）。
 *
 * 读取顺序（迁移期，不回写）：`autopilotWakeEnabled`（新键）→ `autopilotEnabled`（旧键）→ false。
 * 用 `??` 而非 `||` 的理由：**新键显式 false 必须能覆盖旧键 true**（否则"关不掉"）。
 * 抽成模块级函数是为了让 {@link autopilotClockState}（诊断）与 tick 读**同一判据**。
 *
 * v1.34.1（⑥ C6a）：**导出**——CCC 工具面（`container_admin autopilot status`）与条件链
 * （{@link autopilotRuntimeFacts}）必须读**这一份**闸值。旧独立脚本读不到它 ⇒ 闸关着也印
 * 「✅ 唤起条件全部满足」（8 项分歧之首，见 SESSION §12.13 与现状稿 §4.4）。
 */
export function autopilotGloballyEnabled(): boolean {
  try {
    const s = readSimpleSettings()
    return s.autopilotWakeEnabled ?? s.autopilotEnabled ?? false
  } catch {
    return false // settings 服务不可用 → 默认关（保守：未明确开启不自动跑）
  }
}

/**
 * autopilot **进程态**类型（诊断用，模块级 = 进程级）。
 *
 * C6b（P2）：字段由 {@link ClockRuntime}（**工厂那份**）提供，**字段名与语义一个字未改**。
 * 与 {@link wakeSchedulerState} 的差别只有一项：本钟**没有** `lastTickLog`（结果进下方
 * `wakeHistory` 审计 ring，不走 tick 日志）——故 `ClockRuntime.lastTickLog` 在工厂里是可选的。
 */
export type AutopilotClockRuntime = ClockRuntime

/**
 * 🔴 **本钟的串行域**（C6b 硬约束）：`clock.chain` 是**本实例私有**的——
 * 与唤醒调度器的串行链**零共享**。本钟每轮要跑 CCC 的偏见脚本（`fetchBiasContent`，
 * 超时 60s），可能阻塞数十秒；共用链会把另一条钟一起卡住（这正是 P1 被否、取 P2 的理由，
 * 见 SESSION §12.8②）。**这就是"两条时钟不共用排队执行链"的落点。**
 *
 * **为什么这里是模块级常量**（而不是 `registerAutopilot` 的局部量）：本钟的进程态是
 * **进程级可观测面**（`acc-diag` ①b / `containerClocks` / `autopilot-ops.runtimeBlock` 在读），
 * 且 `autopilotClockState()` / `__resetAutopilotClockStateForTest()` 是**公开导出**、
 * 可在未装配时被调用 ⇒ 实例必须**恒在**（旧实现的 `clockRuntime` 也正是模块级常量）。
 * 装配只做 `clock.start()`。
 */
const clockOpts: ClockOptions<void> = {
  label: 'Autopilot Trajectory 时钟',
  ctx: undefined, // 装配点填入（见 registerAutopilot 首行）
  events: ['session/created', 'serenity/settings-changed'],
  gate: autopilotGloballyEnabled,
  gateOffReason: '周期自唤醒闸关闭（autopilotWakeEnabled=false）',
  // `bodyCountsTick: true`：**本钟自己**在"枚举到 live+enabled CCC 之后"记账
  // （见 runAutopilotBegin）。不交给工厂的原因：工厂无法知道"这一拍有没有目标"，
  // 若由它无条件 +1，就会把"无 CCC 可扫不计 tick"这条既有语义改掉（两条回归钉会红）。
  bodyCountsTick: true,
  // 不给 `logFrom`：本钟无 `lastTickLog`（结果走 wakeHistory 审计 ring）
  // `begin` 是**同步前置阶段**：本钟的 ticks/lastSkipReason 必须在 tick 的同步段定下来
  // （既有行为；`body` 只负责投递，见 runAutopilotBegin / runAutopilotTick）
  begin: () => runAutopilotBegin(clockOpts.ctx as Context),
  body: () => runAutopilotTick(clockOpts.ctx as Context),
  startLog: () =>
    `[serenity-hooks] ✓ Autopilot Trajectory 定时器启动（${collectAutopilotCccs(clockOpts.ctx as Context).length} 个 CCC 启用）`,
  onReset: () => runningByRoot.clear(),
}
const clock = createClock(clockOpts)

/**
 * autopilot **进程态**快照（只读；`enabled` = 全局闸**当前**值）。
 * ⚠️ 与 {@link wakeSchedulerState} 同规格，但**本钟无 `lastTickLog`**（见 {@link ClockOptions.logFrom}）。
 */
export function autopilotClockState(): ReturnType<typeof clock.snapshot> {
  return clock.snapshot()
}

/** 测试用：复位进程态（含 per-CCC 重入守卫，避免用例间串味） */
export function __resetAutopilotClockStateForTest(): void {
  clock.reset()
}

/**
 * **重入守卫状态**（per-CCC：该 CCC 是否有一轮唤起正在进行）。
 *
 * 模块级而非常量闭包（⑥ C6a）：条件链要如实回答"此刻是否已有唤起在跑"——旧独立脚本
 * **完全没有这一判据**（8 项分歧之一）。若在 `registerAutopilot` 闭包里再造一份镜像 map，
 * 就是"两份判断"；故状态**提到模块级**，tick 与诊断读**同一张表**。
 * 与既有 `wakeHistory` 同规格（它本就是模块级进程态）。
 */
const runningByRoot = new Map<string, boolean>()

/** 该 CCC 是否有唤起轮正在进行中（tick 的 per-CCC 防重入判据；诊断读同一份） */
export function autopilotWakeInFlight(root: string): boolean {
  return runningByRoot.get(root) === true
}

/**
 * 装配（index.ts apply 调用）。时钟唤起（v1.26.14 修复 + v1.27.4 多 CCC 独立）：
 *
 * v1.26.14 根因：旧实现启动时一次性解析 root——web 进程启动时 live 会话往往为空 → 定时器不启动。
 * 修复：① 每次 tick 动态解析 root+settings ② 监听 session/created 启动定时器 ③ 优先实验 CCC。
 *
 * **v1.27.4 多 CCC 独立（用户"4个CCC能各自有autotrajectory吗"）**：
 * - 单定时器保留（TICK_MS 5min），每次 tick **遍历所有 live+enabled CCC**（collectAutopilotCccs）
 *   各自评估 shouldWake + 各自唤起——每 CCC 的 interval/session/bias/topPrompt/窗口独立
 * - `running` 守卫 **per-CCC**（不同 CCC 唤起互不阻塞）
 * - **全局串行化**（wakeChain：同 tick 多 CCC 到点 → 依次唤起，防模型并发挤兑）
 *
 * 零资源占用语义保留：无 enabled CCC → tick 内直接 return（定时器存在但每 5min 一次空检查，
 * unref 不阻塞进程退出）。
 */
export function registerAutopilot(ctx: Context): void {
  clockOpts.ctx = ctx
  clock.start()
  // F-08（v1.30.8）：插件卸载/HMR → 停掉时钟。此前 timer 无人拆卸——profile 重载后
  // 旧定时器仍在 tick（重复唤起 + 内存泄漏），且 clearInterval 只能靠进程退出。
  // C6b：clearInterval + armed/armedAt 复位已收进工厂 `dispose()`（`onReset` 之外无额外清理）。
  registerDisposer(ctx, 'autopilot 时钟', () => clock.dispose())
}

/**
 * tick 的**同步前置阶段**（`clock-runtime` 在 body 前同步调用）——判据**一行未改**：
 * 枚举 live+enabled CCC；为空 ⇒ 记跳过原因且**不计 tick**；非空 ⇒ 清空跳过原因并记一次 tick。
 *
 * ⚠️ 为什么与 {@link runAutopilotTick} 分开（不是风格，是**观测面正确性**）：
 * 本钟的 `ticks` / `lastSkipReason` 在旧实现里是在 tick 的**同步段**定下来的——诊断
 * （`autopilot-ops.runtimeBlock` / `autopilotClockState()`）在"启动即 tick"的那一瞬间就要读到
 * 本拍的值。若把它们挪进 async body，那一瞬间会读到上一拍的旧值（假报告）。
 * 两条回归钉守着这一点：『启动时无 live 会话 ⇒ ticks=0 + skipReason 留痕』
 * 与『配置关闭 ⇒ ticks=0』（`tests/autopilot-trajectory.test.ts`）。
 * @param ctx 插件上下文
 */
function runAutopilotBegin(ctx: Context): void {
  const roots = collectAutopilotCccs(ctx)
  if (roots.length === 0) {
    clock.noteSkipReason('无 live+enabled CCC（等会话出现 / 配置生效）')
    return
  }
  clock.noteSkipReason(null)
  clock.countTick() // 有目标 ⇒ 本拍算一次 tick（同步，早于任何 await）
}

/**
 * 一次 autopilot tick 的**业务体**（引擎外壳由 `clock-runtime` 提供）。
 *
 * 判据**一行未改**，仍全部本函数自持：枚举 live+enabled CCC → 逐 CCC 防重入 +
 * `shouldWake` 评估 → 命中者接到**本钟私有**串行链尾（`clock.enqueue`）。
 * 同步的"记账/跳过留痕"在 {@link runAutopilotBegin}。
 * @param ctx 插件上下文
 */
function runAutopilotTick(ctx: Context): void {
  // 遍历所有 live+enabled CCC（v1.27.4：多 CCC 各自独立唤起）
  const roots = collectAutopilotCccs(ctx)
  if (roots.length === 0) return // 与 begin 同判据；此处只是不在空集上白跑循环
  for (const root of roots) {
    if (runningByRoot.get(root)) continue // per-CCC 防重入
    const settings = readAutopilotSettings(root)
    if (!settings?.enabled) continue
    const mdPath = resolveTargetMd(root, settings)
    if (!shouldWake(settings, mdPath, Date.now(), false, wakeHistoryFor(root))) continue
    runningByRoot.set(root, true)
    // 全局串行：接到 wakeChain 尾（同 tick 多 CCC 依次唤起，防模型并发挤兑）
    clock.enqueue(async () => {
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

/**
 * 目标 agent：从 SESSION.md 反向定位 dsh 会话（cwd 归属校验 + **bound 精确匹配优先**，
 * 标题 F3 命名回退）；不可得 → null。
 *
 * v1.29.2（R2，用户"autopilot 会话绑定应当更稳固——唤起的时候能唤起最新的、
 * 绑定 autopilot SESSION 的会话"）：v1.29.1 `serenity/bound` 事件是权威绑定
 * （session use 激活时 append，dirName = 完整 AGENT_SESSIONS 目录名，编码无关 U4）。
 * 旧实现只按标题猜（=== sid / startsWith(sid-)）——若绑定该 SESSION 的 dsh 会话
 * 标题不是 S###- 前缀（LLM 改过/重建后 rename 异常），绑定明明在却唤起失败。
 * 加强：**bound.dirName 精确匹配优先**（权威证据），标题匹配降级为回退（存量
 * 无 bound 的 live 会话兼容）；多候选（罕见：同 SESSION 绑定多个 live 会话）取
 * **绑定最新**（bound.at 最大——最近 use 过 = 最可能当前在用）。
 */
function resolveTargetAgent(ctx: Context, mdPath: string): Agent | null {
  const dirName = basename(dirname(mdPath))
  const idMatch = dirName.match(/--S(\d{3,})--/)
  const sid = idMatch ? `S${idMatch[1]}` : null
  const targetRoot = cccRootForCwd(mdPath)
  const sessions = hostSessions(ctx)
  const agents = hostAgents(ctx)
  // 候选池：{ session, boundAt|null, titleMatched } —— bound 命中优先，其次标题命中
  type Candidate = { session: { id?: string }; boundAt: number | null; titleMatched: boolean }
  const candidates: Candidate[] = []
  try {
    for (const s of sessions?.list?.() ?? []) {
      const sess = s as { id?: string; header?: { cwd?: string } }
      // cwd 归属校验：同实例多 CCC 时不误匹配（只找目标 SESSION 所在 CCC 的会话）。
      const cwd = sess?.header?.cwd ?? ''
      if (targetRoot) {
        if (cccRootForCwd(cwd) !== targetRoot) continue
      } else if (cwd !== '' && !mdPath.startsWith(cwd.endsWith('/') ? cwd : cwd + '/')) {
        continue
      }
      const bound = readLastBound(sess)
      const title = readSessionTitle(sess)
      const boundMatched = bound !== null && bound.dirName === dirName
      const titleMatched = sid !== null && title !== null && (title === sid || title.startsWith(`${sid}-`))
      if (boundMatched) candidates.push({ session: sess, boundAt: bound?.at ?? null, titleMatched })
      else if (titleMatched) candidates.push({ session: sess, boundAt: null, titleMatched })
    }
  } catch {
    /* 遍历失败忽略 */
  }
  if (candidates.length === 0) return null
  // bound 候选优先于纯标题候选；同类内取绑定/标题最新（bound.at 大者 = 最近 use）
  candidates.sort((a, b) => {
    const aBound = a.boundAt !== null
    const bBound = b.boundAt !== null
    if (aBound !== bBound) return aBound ? -1 : 1
    return (b.boundAt ?? 0) - (a.boundAt ?? 0)
  })
  for (const c of candidates) {
    const agent = agents?.get?.(c.session.id ?? '') as Agent | undefined
    if (agent) return agent
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
    const events = sessionEvents<{ type?: string; data?: { title?: unknown } }>(session)
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
 * 区分"无 live 会话" / "标题不匹配" / "bound 或标题命中但 agent 未加载"）。
 * v1.29.2（R2）：bound 命中但 agent 未加载也归入「已匹配未加载」（原只查标题）。
 * 返回诊断文本（无则 null）。
 */
function diagnoseTargetUnavailable(ctx: Context, mdPath: string): string | null {
  const dirName = basename(dirname(mdPath))
  const idMatch = dirName.match(/--S(\d{3,})--/)
  const sid = idMatch ? `S${idMatch[1]}` : null
  const targetRoot = cccRootForCwd(mdPath)
  const sameCccTitles: string[] = []
  const agentMissing = { matched: false }
  try {
    const sessions = hostSessions(ctx)
    for (const s of sessions?.list?.() ?? []) {
      const sess = s as { id?: string; header?: { cwd?: string } }
      const cwd = sess?.header?.cwd ?? ''
      if (targetRoot) {
        if (cccRootForCwd(cwd) !== targetRoot) continue
      } else if (cwd !== '' && !mdPath.startsWith(cwd.endsWith('/') ? cwd : cwd + '/')) {
        continue
      }
      const bound = readLastBound(sess)
      const title = readSessionTitle(sess)
      if (title) sameCccTitles.push(title)
      const boundMatched = bound !== null && bound.dirName === dirName
      const titleMatched = sid !== null && title !== null && (title === sid || title.startsWith(`${sid}-`))
      if (boundMatched || titleMatched) {
        const agent = hostAgents(ctx)?.get?.(sess.id ?? '') as Agent | undefined
        if (!agent) agentMissing.matched = true
      }
    }
  } catch {
    /* 遍历失败忽略 */
  }
  if (agentMissing.matched) return `会话已绑定/匹配 ${sid ?? dirName} 但 agent 未加载（会话可能刚创建/正在恢复——稍后重试）`
  if (sameCccTitles.length > 0) {
    return `目标 CCC 内 live 会话标题: [${sameCccTitles.join(', ')}]——均不匹配 ${sid ?? dirName}（目标会话未在 WebUI 打开，或绑定/命名未生效）`
  }
  return `目标 CCC 内无 live 会话（先在 WebUI 打开 ${sid ?? dirName} 会话后重试）`
}

/** Autopilot 绑定的回退 CCC 根：进程 cwd 上溯 .serenity 优先，回退任一 live 会话 root */
function resolveAutopilotRoot(ctx: Context): string | null {
  const fromCwd = cccRootForCwd(process.cwd())
  if (fromCwd) return fromCwd
  try {
    const sessions = hostSessions(ctx)
    for (const s of sessions?.list?.() ?? []) {
      const r = cccRootForCwd(s?.header?.cwd ?? '')
      if (r) return r
    }
  } catch {
    /* 遍历失败忽略 */
  }
  return null
}

/**
 * 面板状态（GET /serenity/trajectory 数据源；纯逻辑，可单测）——
 * WebUI 设置面板「Autopilot Trajectory」只读区块展示的完整状态：配置摘要 + 目标会话
 * 命中/标志/空闲时长 + 当前窗口/可唤起判定 + 审计（最近唤起）。
 * 不运行偏见脚本（只报脚本是否就绪——运行验证走 trajectory random）。
 */
interface AutopilotTrajectoryStatus {
  /** 是否配置了 trajectory.autopilot 段（.opencode/serenity.json；旧键 autopilotTrajectory / autotrajectory 回退） */
  configured: boolean
  /** 总开关（缺省 false——未开零资源占用） */
  enabled: boolean
  /** 无人类活动 N 小时后自动唤起（缺省 12） */
  intervalHours: number
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
    /** 当前时刻是否满足唤起条件（标志+间隔+窗口，未运行中；v1.27.12 移除每日预算） */
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
interface LiveSessionEntry {
  id: string
  cwd: string | null
  cccRoot: string | null
  title: string | null
}

/**
 * live 会话清单（诊断/面板解析用；标题从 events 读）——**只枚举 live 会话本身**。
 *
 * C2：CCC 枚举（"本机有哪些 CCC"）**不在这里**，归 `ccc-roots.listCccs`（并集）。
 * 本函数保留的是它**独有**的那部分：逐条 live 会话 + cwd 归属 + 标题 + id
 * （诊断页需要"哪个会话属于哪个 CCC"，那是会话维度、不是 CCC 维度）。
 * @param ctx 插件上下文
 * @returns 逐条 live 会话（`cccRoot` = 该会话 cwd 的 CCC 归属，无 → null）
 */
export function listLiveSessions(ctx: Context): LiveSessionEntry[] {
  const out: LiveSessionEntry[] = []
  try {
    const sessions = hostSessions(ctx)
    for (const s of sessions?.list?.() ?? []) {
      const cwd = s?.header?.cwd ?? null
      out.push({
        id: s?.id ?? '',
        cwd,
        cccRoot: cwd ? cccRootForCwd(cwd) : null,
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
 * 进程内诊断（trajectory diag-live 数据源；用户"排查访问不到 pangu 写个 msm"）——
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
  const processCcc = cccRootForCwd(processCwd)
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

/**
 * **条件链的运行态事实**（⑥ C6a 的核心出口）——把只有插件进程能看到的判据交给
 * 条件链（{@link buildWakeChain} 的输入）：全局闸 / 重入守卫 / live 运行态。
 *
 * 为什么必须有（这是 C6 的动机本身）：旧独立脚本只能读文件 ⇒ 结构性地看不到这三样，
 * 于是逐条件报告**必然**与实际唤起行为分歧（8 项，见 `acc-component-relations-current-state.md` §4.4）。
 * 搬进进程内之后，`container_admin autopilot status` 与 `acc-diag` ④ 段读的就是**同一份事实**。
 *
 * `ctx` 可传 `null`（**不是**"三项全不可知"）：全局闸（`readSimpleSettings`）与重入守卫
 * （模块级 `runningByRoot`）**都不需要 ctx**，无 ctx 时也应读出真值——只有 live 运行态
 * （live 会话 / agent 可解析）依赖 ctx，那才是真正的"不可知"。
 * 这条区分由 `autopilot-ops.test.ts` 的全局闸可见性用例逼出来（首版把三者一起降级为不可知，
 * 使"闸关"在无 ctx 路径下隐形——正是本轮要消灭的那类假报告）。
 *
 * @param ctx 插件上下文（读 live 会话 + agent）；null = 无进程上下文（live 标不可知）
 * @param root 目标 CCC 根
 * @returns 条件链事实（`live` 为 null 表示"live 运行态不可知"）
 */
export function autopilotRuntimeFacts(ctx: Context | null, root: string): WakeChainFacts {
  const settings = readAutopilotSettings(root)
  const mdPath = settings ? resolveTargetMd(root, settings) : null
  let live: WakeChainFacts['live'] = null
  if (ctx !== null) {
    const sessionCount = listLiveSessions(ctx).filter((s) => s.cccRoot === root).length
    // mdPath 为 null（未配置 session / 未命中）时 agent 可解析性**不适用**（agentResolved=null），
    // 而不是"不可解析"——那种情形已由条件链的 session 条件单独判为 ✗。
    const agentResolved = mdPath ? resolveTargetAgent(ctx, mdPath) !== null : null
    live = {
      sessionCount,
      agentResolved,
      diagnosis: mdPath && agentResolved === false ? diagnoseTargetUnavailable(ctx, mdPath) : null,
    }
  }
  return {
    globalGate: autopilotGloballyEnabled(),
    running: autopilotWakeInFlight(root),
    live,
  }
}
