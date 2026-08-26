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
  return `[SESSION-KEEPER] Score threshold reached (${score}). Please acknowledge with [SESSION-KEEPER-recorded-${code}] once progress is synced to the working session (acc-session show). No need to interrupt your work — just acknowledge inline and keep going.`
}

/** F2 rebuild 提示（v1.21；v1.22.1 对齐"轨迹跟踪器"概念）：
 * SESSION.md = 持久 agent（轨迹），自身会话 = 临时可重建（工作副本）。
 * 上下文接近上限时引导 LLM 主动触发 session_rebuild。 */
export function rebuildReminderText(ratio: number): string {
  return `[TRAJECTORY] 上下文占用已达 ${(ratio * 100).toFixed(0)}%（轨迹跟踪器阈值）。` +
    `SESSION.md 是持久轨迹，本会话只是临时可重建的工作副本——无需压缩，` +
    `可在适当时机调用 session_rebuild 清空重建（归档当前副本，身份从 SESSION.md 自动延续）。`
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
    if (readSimpleSettings().rebuildEnabled) {
      const session = (exec as { agent?: { session?: unknown } }).agent?.session
      if (session) {
        const pressure = readContextPressure(ctx, session)
        if (pressure && pressure.contextWindow && pressure.contextWindow > 0) {
          const ratio = pressure.projectedTokens / pressure.contextWindow
          const threshold = readSimpleSettings().rebuildThreshold
          if (ratio >= threshold) {
            blocks.push({ type: 'text', text: rebuildReminderText(ratio) })
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
