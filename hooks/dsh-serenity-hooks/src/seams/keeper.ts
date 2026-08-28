/**
 * keeper.ts — 拦截缝：session-keeper（DCP 提醒，post-execute observe-and-enrich）
 *
 * 照 dsh-external/tool-failure-guard 模式：先检测计分，`next()` 委托，
 * 再把提醒折叠到返回决策的 additionalContexts（绝不 veto）。
 *
 * 计分（对齐 opencode-serenity-plugin session-keeper）：
 *   write/edit=3, task=10, read/grep/glob/msm=1, 经过时间 +1 分/分钟
 * 阈值：.opencode/serenity.json sessionKeeper.threshold（规范位置，.dsh 回退；缺省 150）
 * 提醒要求模型回应 [SESSION-KEEPER-recorded-{code}] 确认（DCP 模式）。
 */

import type { Context } from 'cordis'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource, ContentBlock } from '@deepseek-ai/dsh-llm'
import { findSerenityRoot, loadSerenityConfig } from '../ccc.js'
import { readSimpleSettings } from '../settings-section.js'

// ── 纯跟踪器（可单测）──

const SCORES: Record<string, number> = {
  write: 3,
  edit: 3,
  str_replace_editor: 3,
  task: 10,
  read: 1,
  grep: 1,
  glob: 1,
  skill: 1,
  acc_msm: 1,
  cc_fs: 1,
}

export function scoreTool(toolName: string): number {
  return SCORES[toolName] ?? 0
}

export class KeeperTracker {
  private score = 0
  private lastTs = 0
  private counter = 0
  constructor(
    private threshold: number,
    private now: () => number = Date.now,
  ) {}

  /** 记录一次工具调用 + 经过时间；返回是否应触发提醒 */
  step(toolName: string): boolean {
    const now = this.now()
    if (this.lastTs > 0) {
      this.score += Math.floor((now - this.lastTs) / 60_000) // +1 分/分钟
    }
    this.lastTs = now
    this.score += scoreTool(toolName)
    return this.score >= this.threshold
  }

  /** 生成确认码并清零积分 */
  ack(): string {
    this.counter += 1
    this.score = 0
    this.lastTs = 0
    return `K${this.counter}`
  }

  get currentScore(): number {
    return this.score
  }
}

export function reminderText(code: string, score: number): string {
  // v1.18.7：英文 + 不中断工作语气（用户要求）——无需停下，顺手回应即可
  // v1.23.0：前缀 SESSION-KEEPER → TRAJECTORY-STEWARD（用户定名：trajectory 维护机制）
  return `[TRAJECTORY-STEWARD] Score threshold reached (${score}). Please acknowledge with [TRAJECTORY-STEWARD-recorded-${code}] once progress is synced to the working session (acc-session show). No need to interrupt your work — just acknowledge inline and keep going.`
}

/**
 * F2 rebuild 提示（v1.21；v1.22.1 对齐"轨迹跟踪器"概念；v1.23.0 英化 + 载体关系；
 * v1.23.3 行动指令化——用户反馈"一直在触发为啥没执行"：旧文案是状态播报式
 * （"[TRAJECTORY] Context usage at N%..."），模型当成系统状态而非行动请求，可一直忽略。
 * 新文案 = 明确的行动指令（ACT NOW + 何时执行 + 必须执行），对齐 steward ACK 协议风格。
 *
 * v1.24.12 沉淀协议（S142 用户需求）：rebuild 前若掌握值得沉淀的认知——修订 CCC 现有
 * skill（eap 结构化）；若需新建 skill——**不自行创建**，写提案进 SESSION.md 供用户参考。
 * 简短留自由度（不提"加载 eap 工具"，模型自知；只说修订 skill + 新建 skill 落 SESSION）。
 *
 * escalated=true（v1.23.3）：连续多轮超阈值仍未 rebuild → 升级强制语气
 * （STOP and rebuild now，持续注入直到调用 session_rebuild）。
 */
export function rebuildReminderText(ratio: number, threshold: number, escalated = false): string {
  const pct = (ratio * 100).toFixed(0)
  const thr = (threshold * 100).toFixed(0)
  if (escalated) {
    return `[TRAJECTORY-ESCALATED] Context usage at ${pct}% (threshold ${thr}%) — you have been reminded repeatedly and have NOT called session_rebuild. This is now mandatory: STOP at the current task step, preserve valuable cognition into the CCC skills (or write a new-skill proposal into SESSION.md), then call the session_rebuild tool immediately. The conversation will be cleared and rebuilt in place; SESSION.md is the persistent trajectory and stays in place — identity continues from it. Do not continue working without rebuilding; this reminder persists until you call session_rebuild.`
  }
  return `[TRAJECTORY] Context usage at ${pct}% (threshold ${thr}%). This session is the rebuildable carrier of the trajectory: SESSION.md is the persistent body, this conversation is only a temporary work copy. Before rebuilding: if this conversation produced valuable cognition, revise the relevant existing skill of this CCC (structure it with eap); if a new skill is warranted, write a short proposal into SESSION.md for the user to review — do not create it yourself. ACT NOW: at the next natural pause (end of the current task step), call the session_rebuild tool to clear and rebuild this conversation — the current copy is discarded, identity continues from SESSION.md. If you are in the middle of an unbreakable step, continue it, then rebuild at its end. Do not ignore this; rebuild is the expected action, not an option.`
}

/** 读取会话 contextPressure 投影（sessionProjections 可选服务；未装配返回 null） */
export function readContextPressure(
  ctx: Context,
  session: unknown,
): { projectedTokens: number; contextWindow: number | undefined } | null {
  try {
    const projections = (ctx as unknown as { get?: (name: string) => unknown }).get?.('sessionProjections')
    if (!projections) return null
    const snap = (projections as { snapshot?: (s: unknown) => { values?: Record<string, unknown> } }).snapshot?.(session)
    const pressure = snap?.values?.contextPressure as { projectedTokens?: number; contextWindow?: number } | undefined
    if (!pressure || typeof pressure.projectedTokens !== 'number') return null
    return { projectedTokens: pressure.projectedTokens, contextWindow: pressure.contextWindow }
  } catch {
    return null
  }
}

// ── DSH 注册 ──

const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'dsh-serenity-hooks' }

export interface KeeperRegistration {
  /** 缺省阈值（serenity.json sessionKeeper.threshold 优先，其次此值） */
  defaultThreshold?: number
  /** CCC 配置相对路径 */
  configPaths?: string[]
}

/** 每 agent 一个跟踪器（进程内存态，agent token 维度） */
const trackers = new Map<string, KeeperTracker>()

/** v1.23.3 重建提醒状态：agentId → 连续超阈值累计轮数（进程内存态） */
interface RebuildReminderState {
  /** 连续超阈值未 rebuild 的累计轮数（达阈值 → 升级强制提醒） */
  consecutive: number
}
/** 连续超阈值轮数达此值 → 升级为 [TRAJECTORY-ESCALATED] 强制语气（此后持续升级催，直到 rebuild） */
const REBUILD_ESCALATE_AFTER = 3
const rebuildReminderStates = new Map<string, RebuildReminderState>()

/** 测试/调试：查看重建提醒状态 */
export function rebuildReminderStateSnapshot(): ReadonlyMap<string, RebuildReminderState> {
  return new Map(rebuildReminderStates)
}

export function registerKeeper(ctx: Context, opts: KeeperRegistration = {}): void {
  const defaultThreshold = opts.defaultThreshold ?? 150

  const trackerFor = (exec: ToolExecution): KeeperTracker => {
    const key = (exec as { agent?: { session?: { id?: string } } }).agent?.session?.id ?? 'global'
    let t = trackers.get(key)
    if (!t) {
      const root = findSerenityRoot((exec as { agent?: { session?: { header?: { cwd?: string } } } }).agent?.session?.header?.cwd ?? process.cwd())
      const threshold = root ? (loadSerenityConfig(root, opts.configPaths).sessionKeeper?.threshold ?? defaultThreshold) : defaultThreshold
      t = new KeeperTracker(threshold)
      trackers.set(key, t)
    }
    return t
  }

  // observe-and-enrich：先 next() 委托，再折叠提醒（block 决策也附加 context）。
  // v1.22.1 重构：**两个独立机制**——
  // ① SESSION-KEEPER 计分提醒（DCP 确认码，阈值 150 缺省）
  // ② 轨迹跟踪器（Trajectory Tracker）上下文压力检测：每次工具调用后独立检查
  //    contextPressure 投影，超 rebuildThreshold 追加 rebuild 提示——**不依赖计分达标**
  //    （此前嵌套在 shouldRemind 内 + inject 缺 sessionProjections → 永不触发）。
  ctx.on('tools/post-execute', async (exec, _result, next): Promise<PostToolDecision> => {
    if (!exec.agent) return next()
    // 激活门控：只在 .serenity 存在的 CCC 目录计分/提醒；其他目录零干预
    const cwd = (exec as { agent?: { session?: { header?: { cwd?: string } } } }).agent?.session?.header?.cwd ?? process.cwd()
    const root = findSerenityRoot(cwd)
    if (!root) return next()
    const tracker = trackerFor(exec)
    const shouldRemind = tracker.step(exec.name)
    const downstream = await next()

    const blocks: ContentBlock[] = []

    // ① 计分达标 → SESSION-KEEPER 确认码提醒
    if (shouldRemind) {
      const code = tracker.ack()
      blocks.push({ type: 'text', text: reminderText(code, tracker.currentScore) })
    }

    // ② 轨迹跟踪器：上下文压力检测（独立——每次工具调用后都查，不依赖计分）
    // v1.23.3 用户拍板：**不做节流，催就行了**——每次超阈值都注入（每轮都催）；
    // 连续超阈值 REBUILD_ESCALATE_AFTER 轮仍未 rebuild → 升级 [TRAJECTORY-ESCALATED]
    // 强制语气，此后持续升级催（不重置，直到 agent 调用 session_rebuild 压力自然回落）。
    if (readSimpleSettings().rebuildEnabled) {
      const session = (exec as { agent?: { session?: unknown } }).agent?.session
      if (session) {
        const pressure = readContextPressure(ctx, session)
        if (pressure && pressure.contextWindow && pressure.contextWindow > 0) {
          const ratio = pressure.projectedTokens / pressure.contextWindow
          const threshold = readSimpleSettings().rebuildThreshold
          if (ratio >= threshold) {
            const key = (exec as { agent?: { session?: { id?: string } } }).agent?.session?.id ?? 'global'
            const st = rebuildReminderStates.get(key) ?? { consecutive: 0 }
            st.consecutive += 1
            const escalated = st.consecutive >= REBUILD_ESCALATE_AFTER
            blocks.push({ type: 'text', text: rebuildReminderText(ratio, threshold, escalated) })
            rebuildReminderStates.set(key, st)
          }
        }
      }
    }

    if (blocks.length === 0) return downstream
    const reminderAll = createUserMessage({ content: blocks, source: PLUGIN_SOURCE })

    if (downstream.kind === 'block') {
      return {
        kind: 'block',
        feedback: downstream.feedback,
        additionalContexts: [reminderAll, ...(downstream.additionalContexts ?? [])],
      }
    }
    return {
      ...downstream,
      additionalContexts: [reminderAll, ...(downstream.additionalContexts ?? [])],
    }
  })
}
