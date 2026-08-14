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
  return `[SESSION-KEEPER] 积分已达阈值 (${score})。请回应 [SESSION-KEEPER-recorded-${code}] 确认本轮进度已沉淀到工作会话（acc-session show），随后我清零积分。`
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

  // observe-and-enrich：先 next() 委托，再折叠提醒（block 决策也附加 context）
  ctx.on('tools/post-execute', async (exec, _result, next): Promise<PostToolDecision> => {
    if (!exec.agent) return next()
    // 激活门控：只在 .serenity 存在的 CCC 目录计分/提醒；其他目录零干预
    const cwd = (exec as { agent?: { session?: { header?: { cwd?: string } } } }).agent?.session?.header?.cwd ?? process.cwd()
    const root = findSerenityRoot(cwd)
    if (!root) return next()
    const tracker = trackerFor(exec)
    const shouldRemind = tracker.step(exec.name)
    const downstream = await next()
    if (!shouldRemind) return downstream

    const code = tracker.ack()
    const content: ContentBlock[] = [{ type: 'text', text: reminderText(code, tracker.currentScore) }]
    const reminder = createUserMessage({ content, source: PLUGIN_SOURCE })

    if (downstream.kind === 'block') {
      return {
        kind: 'block',
        feedback: downstream.feedback,
        additionalContexts: [reminder, ...(downstream.additionalContexts ?? [])],
      }
    }
    return {
      ...downstream,
      additionalContexts: [reminder, ...(downstream.additionalContexts ?? [])],
    }
  })
}
