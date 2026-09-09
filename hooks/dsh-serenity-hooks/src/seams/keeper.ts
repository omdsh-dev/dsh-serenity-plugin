/**
 * keeper.ts — 拦截缝：session-keeper（DCP 提醒，post-execute observe-and-enrich）
 *
 * 照 dsh-external/tool-failure-guard 模式：先检测计分，`next()` 委托，
 * 再把提醒折叠到返回决策的 additionalContexts（绝不 veto）。
 *
 * 计分（对齐 opencode-serenity-plugin session-keeper）：
 *   write/edit=3, task=10, read/grep/glob/msm=1, 经过时间 +1 分/分钟
 * 阈值：.opencode/serenity.json sessionKeeper.threshold（规范位置，.dsh 回退；缺省 150）
 * 提醒要求模型回应 [TRAJECTORY-ASSISTANT-recorded-{code}] 确认（DCP 模式）。
 */

import type { Context } from 'cordis'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource, ContentBlock } from '@deepseek-ai/dsh-llm'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { hostService } from '../host/access.js'
import { findSerenityRoot, loadSerenityConfig } from '../ccc.js'
import { readSimpleSettings } from '../settings-section.js'
import { skiffTrajectoryEnabled } from '../skiff-core.js'
import { getActiveSessionInfo } from '../session-ops.js'
import { readLastBound } from '../session-bound.js'
import { eventToken, ACK_PREFIX, ACK_SKIP_PREFIX, IN_FLIGHT_HEADING } from '../trajectory-assistant.js'

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
  msm: 1,
  container_fs: 1,
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
  // v0.3/v1.29：统一进 trajectory-assistant（TRAJECTORY-STEWARD → TRAJECTORY-ASSISTANT · CHECKPOINT）
  return `${eventToken('checkpoint')} Score threshold reached (${score}). Please acknowledge with [${ACK_PREFIX}-${code}] once progress is synced to the working session (acc-session show). No need to interrupt your work — just acknowledge inline and keep going.`
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
 * （STOP and rebuild now，持续注入直到调用 logbook rebuild）。
 *
 * 需求①（S142 用户拍板）：百分比比例 → K 数值——tokensK = 实际占用（千 token），
 * thresholdK = 配置阈值（千 token）；文案 `Context usage at NNNK (threshold NNNK)`。
 *
 * v1.31.1 交接协议（S142 用户需求"要求 LLM 将当前手头事项写在 SESSION.md 尾部，并要求
 * rebuild 后去读并处理"）：**写侧** = 这里（两条文案都要求把 in-flight 事项写在
 * SESSION.md 末尾的 `IN_FLIGHT_HEADING` 之下）；**读侧** = rebuild 锚点（rebuild.ts）。
 * 两侧共用 trajectory-assistant 的标题常量（单一真相源）。
 */
export function rebuildReminderText(tokensK: number, thresholdK: number, escalated = false): string {
  const handover =
    ` Before rebuilding, write your current in-flight items (the exact step you are in the middle of, `
    + `what is not finished yet, and what the next action is) at the very end of SESSION.md under the heading `
    + `"${IN_FLIGHT_HEADING}" — the rebuilt conversation reads that section first and continues from it.`
  if (escalated) {
    return `${eventToken('limitMandatory')} Context usage at ${Math.round(tokensK)}K (threshold ${Math.round(thresholdK)}K) — you have been reminded repeatedly and have NOT called the logbook rebuild action. This is now mandatory: STOP at the current task step, preserve valuable cognition into the CCC skills (or write a new-skill proposal into SESSION.md), then call logbook rebuild immediately, passing --summary "<content summary ≤20 chars>" (required; the dsh session title is renamed to S###-YYYY-MM-DD-<summary> after rebuild).${handover} The conversation will be cleared and rebuilt in place; SESSION.md is the persistent trajectory and stays in place — identity continues from it. Do not continue working without rebuilding; this reminder persists until you call logbook rebuild.`
  }
  return `${eventToken('limit')} Context usage at ${Math.round(tokensK)}K (threshold ${Math.round(thresholdK)}K). This session is the rebuildable carrier of the trajectory: SESSION.md is the persistent body, this conversation is only a temporary work copy. Before rebuilding: if this conversation produced valuable cognition, revise the relevant existing skill of this CCC (structure it with eap); if a new skill is warranted, write a short proposal into SESSION.md for the user to review — do not create it yourself.${handover} ACT NOW: at the next natural pause (end of the current task step), call the logbook rebuild action — passing --summary "<content summary ≤20 chars>" describing the next work phase (required; the dsh session title is renamed to S###-YYYY-MM-DD-<summary> after rebuild) — to clear and rebuild this conversation: the current copy is discarded, identity continues from SESSION.md. If you are in the middle of an unbreakable step, continue it, then rebuild at its end. Do not ignore this; rebuild is the expected action, not an option.`
}

/** 读取会话 contextPressure 投影（sessionProjections 可选服务；未装配返回 null） */
export function readContextPressure(
  ctx: Context,
  session: unknown,
): { projectedTokens: number; contextWindow: number | undefined } | null {
  try {
    const projections = hostService<{ snapshot?: (s: unknown) => { values?: Record<string, unknown> } }>(ctx, 'sessionProjections')
    if (!projections) return null
    const snap = projections.snapshot?.(session)
    const pressure = snap?.values?.contextPressure as { projectedTokens?: number; contextWindow?: number } | undefined
    if (!pressure || typeof pressure.projectedTokens !== 'number') return null
    return { projectedTokens: pressure.projectedTokens, contextWindow: pressure.contextWindow }
  } catch {
    return null
  }
}

// ── SESSION.md 体积超限 → LOGBOOK COMPACTION 提醒（v1.31.1，S142 用户需求）──

/**
 * 活跃 SESSION.md 体积上限缺省值（KB）。
 * CCC 级可覆盖：`.opencode/serenity.json` → `sessionKeeper.sessionMdMaxKB`（0 = 关闭）。
 */
export const DEFAULT_SESSION_MD_MAX_KB = 100

/** 连续超限轮数达此值 → 升级强制语气（对齐 rebuild 提醒的 REBUILD_ESCALATE_AFTER） */
const COMPACTION_ESCALATE_AFTER = 3

/** 路径/配置缓存 TTL（避免每次工具调用都解析路径与读配置；stat 每次都做，很便宜） */
const MD_CACHE_TTL_MS = 60_000

interface MdPathCacheEntry {
  mdPath: string | null
  at: number
}

const mdPathCache = new Map<string, MdPathCacheEntry>()
const mdLimitCache = new Map<string, { limitKB: number; at: number }>()

interface CompactionState {
  /** 连续超限轮数（文件降回限内即清零 → 重写完成后自动停止提醒） */
  consecutive: number
}

const compactionStates = new Map<string, CompactionState>()

/** 测试/调试：查看超限提醒状态 */
export function compactionStateSnapshot(): ReadonlyMap<string, CompactionState> {
  return new Map(compactionStates)
}

/** 会话销毁/测试重置：清理路径缓存与超限计数（防 per-会话 Map 无界增长，review F-08 同族） */
export function forgetLogbookCompactionState(scope: string): void {
  mdPathCache.delete(scope)
  compactionStates.delete(scope)
}

/** 测试辅助：清空全部缓存（含 root 维度的阈值缓存） */
export function __resetLogbookCompactionForTest(): void {
  mdPathCache.clear()
  mdLimitCache.clear()
  compactionStates.clear()
}

/**
 * 解析**活跃** SESSION.md 绝对路径（缓存 60s）。
 *
 * 候选链（刻意比 rebuild 的完整链短——这里每个工具调用都要跑，贵候选不划算）：
 * ① `getActiveSessionInfo(scope).mdPath`（`logbook use` / skiff 绑定 / 重启恢复都会写）
 * ② `readLastBound(session).mdPath`（`.bindings.json` 权威绑定——重启后内存空时兜底）
 * 两者都拿不到 → null（**不猜**：宁可不提醒，也不去猜别的轨迹——对齐 v1.30.13 D4 的教训）。
 */
export function resolveActiveSessionMdPath(
  root: string,
  scope: string,
  session: unknown,
  now: () => number = Date.now,
): string | null {
  const t = now()
  const cached = mdPathCache.get(scope)
  if (cached && t - cached.at < MD_CACHE_TTL_MS) return cached.mdPath
  let candidate: string | null = null
  try {
    candidate = getActiveSessionInfo(scope)?.mdPath ?? null
  } catch {
    candidate = null
  }
  if (!candidate) {
    try {
      candidate = readLastBound(session as never)?.mdPath ?? null
    } catch {
      candidate = null
    }
  }
  let abs: string | null = null
  if (candidate) {
    const p = candidate.startsWith(root) ? candidate : resolve(root, candidate)
    abs = existsSync(p) ? p : null
  }
  mdPathCache.set(scope, { mdPath: abs, at: t })
  return abs
}

/** 读文件字节数（读不到 → null，不抛错） */
export function readFileSize(absPath: string): number | null {
  try {
    return statSync(absPath).size
  } catch {
    return null
  }
}

/** 读该 CCC 的 SESSION.md 体积上限（KB；缓存 60s；0 = 关闭提醒） */
export function readSessionMdMaxKB(root: string, configPaths?: string[], now: () => number = Date.now): number {
  const t = now()
  const cached = mdLimitCache.get(root)
  if (cached && t - cached.at < MD_CACHE_TTL_MS) return cached.limitKB
  let limitKB = DEFAULT_SESSION_MD_MAX_KB
  try {
    const configured = loadSerenityConfig(root, configPaths).sessionKeeper?.sessionMdMaxKB
    if (typeof configured === 'number' && Number.isFinite(configured) && configured >= 0) limitKB = configured
  } catch {
    /* 配置读不到 → 缺省值 */
  }
  mdLimitCache.set(root, { limitKB, at: t })
  return limitKB
}

/**
 * LOGBOOK COMPACTION 提醒文案（v1.31.1）。
 *
 * 归属（D23 + 用户 2026-09-09 拍板）：**ACC 内嵌机制事实 + 4 条重写原则**——理由：这 4 条是
 * 认知质量规范（与 EAP 同层，不是会随角色迭代的措辞），且未配置任何 CCC 文档的容器也要立刻可用。
 *
 * 四条原则（用户原话逐条落成可执行判据）：
 * ① 保留 EAP 分层骨架（不许压成时间流水账）
 * ② 内容可外移到 references 文件（证据链/日志/参考资料 → `AGENT_SESSIONS/<会话>/references/*.md`，
 *    在 SESSION.md 里留链接）
 * ③ 允许整合不重要事项（被取代的决策 / 已解决问题 / 中间态）
 * ④ 自主裁量权充分允许（唯一硬要求 = 骨架 + 未决项/决策理由/下一步仍可重建）
 */
export function logbookCompactionReminderText(input: {
  sizeKB: number
  limitKB: number
  mdPath: string
  escalated?: boolean
}): string {
  const { sizeKB, limitKB, mdPath, escalated = false } = input
  const facts = `SESSION.md is ${sizeKB} KB (limit ${limitKB} KB): ${mdPath}`
  const principles =
    'Load eap (praxis eap) first, then rewrite SESSION.md under these principles: '
    + '(1) keep the EAP layered skeleton — a stable section structure, not a chronological dump; '
    + '(2) move detail out — long evidence chains, logs and reference material belong in separate files '
    + '(e.g. AGENT_SESSIONS/<session>/references/*.md) linked from SESSION.md; '
    + '(3) merge or drop what no longer matters — superseded decisions, resolved issues, intermediate states; '
    + '(4) you have full discretion on how far to go: the only hard requirements are the skeleton and that every '
    + 'still-open item, decision rationale and next step stays recoverable (reconstruction over preservation).'
  if (escalated) {
    return `${eventToken('compaction')} ${facts} — you have been reminded repeatedly and have NOT compacted the logbook. This is now mandatory: STOP the current task step, load eap (praxis eap), rewrite SESSION.md, then resume. ${principles} This reminder persists until the file is under the limit.`
  }
  return `${eventToken('compaction')} ${facts}. Pause the current work and compact the trajectory logbook before continuing — the logbook is the persistent body of this trajectory, and its size is operational entropy (H_op) the container pays on every read. ${principles} After rewriting, resume the paused work; this reminder stops once the file is under the limit.`
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
  //    contextPressure 投影，超 rebuildThresholdK（K 数值）追加 rebuild 提示——**不依赖计分达标**
  //    （此前嵌套在 shouldRemind 内 + inject 缺 sessionProjections → 永不触发）。
  ctx.on('tools/post-execute', async (exec, _result, next): Promise<PostToolDecision> => {
    if (!exec.agent) return next()
    // 激活门控：只在 .serenity 存在的 CCC 目录计分/提醒；其他目录零干预
    const cwd = (exec as { agent?: { session?: { header?: { cwd?: string } } } }).agent?.session?.header?.cwd ?? process.cwd()
    const root = findSerenityRoot(cwd)
    if (!root) return next()
    // F4 Skiff 旁路（F4b ⑩）：计分提醒按角色 trajectory.keeper、重建压力检测按
    // trajectory.rebuild 决定参与（默认全关 = Skiff 完全独立）；非 skiff 恒参与。
    const sessionId = (exec as { agent?: { session?: { id?: string } } }).agent?.session?.id
    const skiffKeeper = skiffTrajectoryEnabled(root, sessionId, 'keeper')
    const skiffRebuild = skiffTrajectoryEnabled(root, sessionId, 'rebuild')
    const tracker = trackerFor(exec)
    const shouldRemind = skiffKeeper ? tracker.step(exec.name) : false
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
    // 强制语气，此后持续升级催（不重置，直到 agent 调用 logbook rebuild 压力自然回落）。
    // 需求①（S142 用户拍板）：判定从窗口比例改为绝对 K——projectedTokens ≥ thresholdK*1000
    // （纯绝对，无窗口比例上限保护；contextWindow 不再参与判定，压力缺失 contextWindow 也照常触发）
    if (skiffRebuild && readSimpleSettings().rebuildEnabled) {
      const session = (exec as { agent?: { session?: unknown } }).agent?.session
      if (session) {
        const pressure = readContextPressure(ctx, session)
        if (pressure && pressure.projectedTokens > 0) {
          const tokensK = pressure.projectedTokens / 1000
          const thresholdK = readSimpleSettings().rebuildThresholdK
          if (pressure.projectedTokens >= thresholdK * 1000) {
            const key = (exec as { agent?: { session?: { id?: string } } }).agent?.session?.id ?? 'global'
            const st = rebuildReminderStates.get(key) ?? { consecutive: 0 }
            st.consecutive += 1
            const escalated = st.consecutive >= REBUILD_ESCALATE_AFTER
            blocks.push({ type: 'text', text: rebuildReminderText(tokensK, thresholdK, escalated) })
            rebuildReminderStates.set(key, st)
          }
        }
      }
    }

    // ③ SESSION.md 体积检查（v1.31.1，S142 用户需求）：活跃轨迹工作台超限 → 提示暂停重写。
    // 独立于①②（与上下文压力无关——rebuild 只换载体，不会让 SESSION.md 变小）。
    // 门控按角色 trajectory.session（工作台参与项），非 skiff 会话恒参与。
    if (skiffTrajectoryEnabled(root, sessionId, 'session')) {
      const limitKB = readSessionMdMaxKB(root, opts.configPaths)
      if (limitKB > 0) {
        const scope = sessionId ?? 'global'
        const session = (exec as { agent?: { session?: unknown } }).agent?.session
        const mdPath = resolveActiveSessionMdPath(root, scope, session)
        const size = mdPath ? readFileSize(mdPath) : null
        if (mdPath && size !== null && size > limitKB * 1024) {
          const st = compactionStates.get(scope) ?? { consecutive: 0 }
          st.consecutive += 1
          blocks.push({
            type: 'text',
            text: logbookCompactionReminderText({
              sizeKB: Math.round(size / 1024),
              limitKB,
              mdPath,
              escalated: st.consecutive >= COMPACTION_ESCALATE_AFTER,
            }),
          })
          compactionStates.set(scope, st)
        } else {
          // 文件已回到限内（重写完成）→ 清零，提醒自动停止
          compactionStates.delete(scope)
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
