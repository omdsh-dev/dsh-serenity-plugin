/**
 * bootstrap.ts — Anchored Standard 两阶段工具目录（S137）
 *
 * 移植自 xiaobright/dsh-anchored-standard（preset/tool-bootstrap.mjs + compaction-epoch.mjs）：
 * 首请求暴露最小工具集（锚定轨迹——V4 Pro 强依赖 API 可见工具目录选轨迹），
 * 会话出现首次持久晋升信号（tool/call 或 assistant/message，先到者为准）后开放完整工具。
 *
 * 严格对齐 anchored 语义：
 *  - 阶段从持久 session events 推导（resume/reload 不丢状态）
 *  - epoch 感知：compaction/end 后回落受控阶段（bootstrap 集 + compactionTools），
 *    需新的晋升信号才重新晋升（压缩后首请求 = "第二次首请求"）
 *  - 子 agent（delegationDepth > 0）恒为 promoted（完整目录）
 *  - bootstrap 阶段剥离自动注入上下文（suppressedContextSources，默认
 *    skill-catalog + agent-instructions——即 Standard 比 Minimal 多出的两类注入）
 *  - 降级：过滤器出错绝不吞上下文（pre-step 保留全部）/ 工具缺失降级完整目录 + 一次性告警
 *
 * 协议固有（用户原则 2026-08-24，S142）：first-anchor 属 ACC 协议层——任何 CCC
 * 在抽象层都是宁静号/ACC，机制与内容均不可配置（零配置面）。旧版 serenity.json
 * bootstrap 段（S137 引入的调参入口）已移除，遗留字段静默忽略。
 */

import type { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { findSerenityRoot } from '../ccc.js'
import { sessionEvents } from '../session-ops.js'
import { isSkiffSessionId } from '../skiff-role.js'

export interface BootstrapSettings {
  /** 首请求（bootstrap 阶段）工具集（缺省 dsp 核心；zeroTools 时忽略——0 工具） */
  bootstrapTools: string[]
  /** 晋升信号类型集合 */
  promoteEvents: Set<'tool/call' | 'assistant/message'>
  /** 晋升所需信号数（boundary 后累计；多轮锚定时 = 锚定轮数） */
  requiredSignals: number
  /** bootstrap 阶段剥离的注入源 */
  suppressedSources: Set<string>
  /** compaction 后（重新晋升前）额外保留的工具集 */
  compactionTools: string[]
  /** 锚定消息序列（v4 两轮递进：按序 prepend 到 next-turn 队列，每条一轮 0 工具回复） */
  anchorMessages: string[]
  /** Zero-Anchored 变体：首请求 0 工具（晋升信号仅 assistant/message，对齐 zero-anchored-standard） */
  zeroTools: boolean
}

/** 默认首请求工具集：dsp 平台 Minimal 等价核心（anchored 是 bash+str_replace_editor） */
export const DEFAULT_BOOTSTRAP_TOOLS = ['read', 'write', 'edit', 'glob', 'grep']

/** 默认剥离的自动注入源（anchored 默认：可用技能目录提醒 + 工作区指令摘要） */
export const DEFAULT_SUPPRESSED_SOURCES = ['skill-catalog', 'agent-instructions']

/** 默认 compaction 恢复工作集（anchored 默认 read/write/edit/glob/grep/todo_write/ask_user_question） */
export const DEFAULT_COMPACTION_TOOLS = ['read', 'write', 'edit', 'glob', 'grep', 'todo_write']

/**
 * 协议级锚定消息序列（用户确认固化，2026-08-24 S142）：任何 CCC 在抽象层都是
 * 宁静号/ACC——首轮锚定话语统一，无 CCC 配置面。两轮递进：
 *  ① ACC 身份 + EAP 原则 + we/us 人称 + 先锚定后行动
 *  ② 协作协议 5 条 + acknowledge 要求（只回确认，不做事）
 * 文本 = 原 home-serenity CCC 配置（anchorMessages），随零配置化固化进代码。
 */
export const DEFAULT_ANCHOR_MESSAGES: string[] = [
  'You are the operator agent of Serenity — a cognitive container governed by the Abstract Cognitive Container (ACC) protocol.\nWe operate under the Explicit Abstraction Principle (EAP): the functional value of a thought equals its external reconstructability — every output we produce must be explicit (E↑), reconstructable (R↓), and stable (S↑).\nThe personal pronoun is us/we.\nWe anchor first, then act: the abstract layer precedes the concrete.\nPlease simply reply "acknowledge" — no action needed.',
  'Before we proceed, align on how we work:\n1. We read before we write — every decision grounds in what already exists in the container.\n2. Every output records its reasoning (R↓): decisions carry reasons and alternatives.\n3. We never jump levels — abstract layer first, then specifics.\n4. Every artifact we create is a durable cognitive anchor for the work that follows.\n5. We keep the container\'s state coherent (SESSION.md) as we advance.\nPlease simply reply "acknowledge" — no action needed.',
]

/**
 * 根会话锚定重入判定（v1.28.1 提取导出以便单测）：会话是否已有真实用户消息。
 * resume/续跑的会话已有对话历史 → **不重锚**（first-anchor 只注入一次）。
 *
 * 0.1.2-rc.1 适配教训：裸读 `session.events`（经类型断言）恒 undefined →
 * `!undefined` 恒 true → 有历史也永不跳过 → 任何情况发消息都重插 first-anchor。
 * 统一经 sessionEvents() 读取（snapshotEvents() 优先，.events 兜底）。
 */
export function hasUserMessageHistory(session: unknown): boolean {
  return sessionEvents(session).some((event) => (event as { type?: string }).type === 'user/message')
}

// ── 阶段机（等价 anchored compaction-epoch.mjs createEpochPromotion）──

export interface PromotionStatus {
  /** 最后一次 compaction/end 的 seq（-1 = 未压缩过） */
  boundary: number
  /** 边界后是否存在持久晋升信号 */
  promoted: boolean
}

export interface PromotionTracker {
  status(agent: Agent | undefined): PromotionStatus
  observe(session: unknown, event: unknown): void
}

/**
 * 构建一个 epoch 感知晋升跟踪器（纯逻辑，可单测）。
 * requiredSignals：晋升所需信号数（boundary 后累计；默认 1）。
 * 多轮锚定（v4）：两轮递进锚定时 requiredSignals = 锚定轮数——
 * 每条锚定回复（assistant/message）计一次，最后一条回复后晋升。
 *
 * maxRoundsFallback：**轮次兜底**（v1.19.3 修复 responses API 兼容）。
 * 某些模型/协议（如 opencode-go-responses）的会话可能不产生标准
 * `assistant/message` 晋升信号 → 永不晋升 → bootstrap 阶段工具被裁空
 * （zeroTools 首请求 0 工具，ACC 工具不可见）。兜底：无论晋升信号是否
 * 到达，观察到的模型 step 数（`step/start` 事件计数，平台稳定事件，
 * responses/completions 都触发，独立于 promoteEvents）达到 maxRoundsFallback
 * 即强制 promoted（开放完整工具）。正常模型锚定轮数（requiredSignals）
 * 通常 ≤ 2 < 默认兜底 3，不受影响。
 */
export function createEpochPromotion(
  promoteEvents: Set<'tool/call' | 'assistant/message'>,
  requiredSignals = 1,
  maxRoundsFallback = 3,
): PromotionTracker {
  /** sessionId -> { boundary, signalCount, rounds }（rounds = 兜底用回复轮计数） */
  const state = new Map<string, { boundary: number; signalCount: number; rounds: number }>()

  const sessionIdOf = (session: unknown): string | undefined => {
    if (session && typeof session === 'object') {
      const id = (session as { id?: unknown }).id
      if (typeof id === 'string') return id
    }
    return undefined
  }

  const promotedBy = (entry: { boundary: number; signalCount: number; rounds: number }): boolean =>
    entry.signalCount >= requiredSignals || entry.rounds >= maxRoundsFallback

  const scan = (session: unknown): PromotionStatus => {
    let boundary = -1
    let signalCount = 0
    let rounds = 0
    const events = sessionEvents(session)
    if (events.length > 0) {
      for (const event of events) {
        const e = event as { type?: string; seq?: number }
        const seq = typeof e.seq === 'number' ? e.seq : 0
        if (e.type === 'compaction/end') {
          boundary = seq
          signalCount = 0
          rounds = 0
          continue
        }
        if (promoteEvents.has(e.type as 'tool/call' | 'assistant/message') && seq > boundary) signalCount++
        // 兜底轮次计数：用平台稳定事件 step/start（responses/completions 都触发；
        // assistant/message 在 responses API 下可能延迟/缺失，导致兜底失效——v1.19.4 修复）
        if (e.type === 'step/start' && seq > boundary) rounds++
      }
    }
    const entry = { boundary, signalCount, rounds }
    const sid = sessionIdOf(session)
    if (sid) state.set(sid, entry)
    return { boundary, promoted: promotedBy(entry) }
  }

  return {
    status(agent) {
      if (agent === undefined) return { boundary: -1, promoted: true }
      const session = (agent as { session?: unknown }).session
      if (session === undefined) return { boundary: -1, promoted: true }
      // handyman worker（sessionId 固定 `handyman-` 前缀，tools/handyman.ts 生成）：autonomous 程序化
      // worker，需从第 1 轮起就持有完整工具目录 + 完整 ACC 系统提示词（DCP/标准层）。
      // 它经 ctx.agents.create 直接创建（非 DSH delegation 路径），delegationDepth 为 0，
      // 会绕过下方 delegationDepth>0 的恒 promoted 分支——故显式按 `handyman-` 前缀判 promoted，
      // 与 context.ts shouldAutoRestore 的 `handyman-` 约定保持一致。
      // F4 Skiff（`skiff-` 前缀）：角色 CCC 提示词全替换，无需 whoami 锚定轮——恒 promoted（同 handyman）。
      const loopSid = (session as { id?: string }).id
      if (typeof loopSid === 'string' && (loopSid.startsWith('handyman-') || isSkiffSessionId(loopSid))) return { boundary: -1, promoted: true }
      // 子 agent（delegationDepth > 0）恒为完整目录（anchored 语义）
      const header = (session as { header?: { delegationDepth?: number } }).header
      if ((header?.delegationDepth ?? 0) > 0) return { boundary: -1, promoted: true }
      const sid = sessionIdOf(session)
      if (sid === undefined) return { boundary: -1, promoted: true }
      const s = state.get(sid)
      if (s) return { boundary: s.boundary, promoted: promotedBy(s) }
      return scan(session)
    },
    observe(session, event) {
      const sid = sessionIdOf(session)
      if (sid === undefined) return
      const entry = state.get(sid)
      if (entry === undefined) return
      const e = event as { type?: string; seq?: number }
      const seq = typeof e.seq === 'number' ? e.seq : 0
      if (e.type === 'compaction/end') {
        state.set(sid, { boundary: seq, signalCount: 0, rounds: 0 })
        return
      }
      if (promoteEvents.has(e.type as 'tool/call' | 'assistant/message') && seq > entry.boundary) {
        entry.signalCount++
      }
      // 兜底轮次计数：step/start（平台稳定，responses/completions 都触发）
      if (e.type === 'step/start' && seq > entry.boundary) entry.rounds++
      state.set(sid, entry)
    },
  }
}

// ── 协议固有设置（零配置面：用户原则 2026-08-24 S142）──
// first-anchor 属 ACC 协议层——任何 CCC 抽象层都是宁静号/ACC，机制与内容
// 统一由代码常量决定，无 CCC 配置入口（旧 bootstrap 配置段已移除）。

const PROMOTE_EVENTS: Record<'tool-call' | 'assistant-message' | 'either', Set<'tool/call' | 'assistant/message'>> = {
  'tool-call': new Set(['tool/call']),
  'assistant-message': new Set(['assistant/message']),
  either: new Set(['tool/call', 'assistant/message']),
}

/** 协议固有 bootstrap 设置：zeroTools=true（首请求 0 工具纯文字锚定轮）、
 *  晋升信号仅 assistant/message（对齐 zero-anchored-standard）、
 *  requiredSignals = 锚定轮数（2 条消息 → 2 条回复后晋升）。无参——零配置面。 */
export function resolveBootstrapSettings(): BootstrapSettings {
  return {
    bootstrapTools: [...DEFAULT_BOOTSTRAP_TOOLS],
    promoteEvents: PROMOTE_EVENTS['assistant-message'],
    requiredSignals: DEFAULT_ANCHOR_MESSAGES.length,
    suppressedSources: new Set(DEFAULT_SUPPRESSED_SOURCES),
    compactionTools: [...DEFAULT_COMPACTION_TOOLS],
    anchorMessages: [...DEFAULT_ANCHOR_MESSAGES],
    zeroTools: true,
  }
}

// ── DSH 注册 ──

/**
 * 注册 Anchored bootstrap 机制（协议固有，零配置面——S142；按 agent cwd 定位 CCC root，
 * 晋升状态按 root 隔离，但设置全局一致）：
 *  1. session/event 观察晋升信号（assistant/message + step/start 兜底 + compaction/end）
 *  2. system-prompt/assemble：bootstrap 阶段目录窄化到 bootstrapTools（+compaction 后 compactionTools）
 *  3. agent/pre-step：bootstrap 阶段剥离 suppressedSources 注入消息（降级保留全部）
 *
 * 摘除 = 删除 index.ts 中本注册行（独立模块）。
 */

/** 从 agent 解析 CCC 根（宽松；无 agent/无 CCC 返回 null） */
function agentRoot(agent: unknown): string | null {
  const cwd = (agent as { session?: { header?: { cwd?: string } } } | undefined)?.session?.header?.cwd
  if (typeof cwd !== 'string') return null
  return findSerenityRoot(cwd)
}

/** 协议固有设置（零配置面）：所有 CCC 使用同一固化设置 */
const SETTINGS: BootstrapSettings = resolveBootstrapSettings()

export function registerBootstrap(ctx: Context): void {
  // 每 CCC root 一个 tracker（晋升状态按 root 隔离；设置协议固有全局一致）
  const trackers = new Map<string, PromotionTracker>()
  /** 已锚定会话（进程内防重：子 agent 每会话只锚定一次） */
  const anchoredSessions = new Set<string>()

  const trackerFor = (root: string): PromotionTracker => {
    let t = trackers.get(root)
    if (!t) {
      t = createEpochPromotion(SETTINGS.promoteEvents, SETTINGS.requiredSignals)
      trackers.set(root, t)
    }
    return t
  }

  // session/event 观察：按 session 所属 CCC root 路由到对应 tracker（晋升状态按 root 隔离）
  ctx.on('session/event', (session, event) => {
    try {
      const cwd = (session as { header?: { cwd?: string } } | undefined)?.header?.cwd
      if (typeof cwd !== 'string') return
      const root = findSerenityRoot(cwd)
      if (!root) return
      trackerFor(root).observe(session, event)
    } catch {
      /* 观察失败不阻断 */
    }
  })

  // 首轮锚定注入（对齐 whoami-turn.mjs）：新会话第一条真实用户消息到达时，
  // 把锚定消息 prepend 到 next-turn 队列——dsh 每轮只消费一条 next-turn 消息，
  // 因此锚定轮依次消费（v4 多轮递进：每条锚定消息一轮，0 工具纯文字回复），
  // 最后一条锚定回复后晋升，真实用户消息随后被处理（完整工具已解锁）。
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    try {
      const root = agentRoot(agent)
      if (!root) return
      // 锚定判定（v1.18.6：workflow subagent 也锚定——用户要求）：
      //   - 根会话（delegationDepth 0）：无历史 user/message 才锚定（resume 不重锚）
      //   - 子 agent（workflow subagent 等）：进程内只锚定一次（anchoredSessions Set）
      const session = (agent as { session?: unknown }).session as { header?: { delegationDepth?: number }; id?: string } | undefined
      const depth = session?.header?.delegationDepth ?? 0
      const sid = typeof session?.id === 'string' ? session.id : undefined
      // handyman worker（sessionId `handyman-` 前缀）：autonomous worker，不需要 whoami 锚定轮
      // （锚定轮消耗 2 轮 + 0 工具，浪费；handyman worker 已通过 systemPrompt.section 获得 ACC 5 块）。
      // F4 Skiff（`skiff-` 前缀）：角色 CCC 提示词全替换，同样不需要锚定轮（旁路）。
      // 与 createEpochPromotion.status 的 `handyman-` 恒 promoted 判定保持一致。
      if (sid !== undefined && (sid.startsWith('handyman-') || isSkiffSessionId(sid))) return
      if (depth === 0) {
        // v1.28.1：sessionEvents() 统一读取——rc.1 起 Session 无 .events 属性（snapshotEvents()），
        // 裸读 .events 恒 undefined → `!undefined` 恒 true → **有历史也永不跳过 → 每条消息都重插锚定**。
        // 本判定 = 会话是否已有真实用户消息（resume/续跑不重锚）。
        if (hasUserMessageHistory(session)) return
      } else {
        if (sid !== undefined && anchoredSessions.has(sid)) return
      }
      // 插件来源消息不递归锚定（含我们自己的锚定消息）
      if ((message as { source?: { kind?: string } })?.source?.kind === 'plugin') return
      const inbox = (agent as { inbox?: { prepend?: (queue: string, msg: unknown) => void } }).inbox
      if (!inbox?.prepend) return
      // 逆序 prepend（prepend 插到队首）：最终队列 = [anchorMessages[0], ..., anchorMessages[n-1], 真实消息]
      for (let i = SETTINGS.anchorMessages.length - 1; i >= 0; i--) {
        inbox.prepend('next-turn', {
          id: `bootstrap-anchor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${i}`,
          role: 'user',
          content: [{ type: 'text', text: SETTINGS.anchorMessages[i] }],
          source: { kind: 'plugin', plugin: 'dsh-serenity-hooks', form: 'notice', summary: 'bootstrap anchor turn' },
        })
      }
      if (sid !== undefined) anchoredSessions.add(sid)
      warnOnce(`anchor turns injected: ${SETTINGS.anchorMessages.length} 条（${SETTINGS.anchorMessages[0]!.slice(0, 40)}…）`)
    } catch {
      /* 锚定注入失败不阻断（会话正常处理） */
    }
  })

  let warned = false
  const warnOnce = (message: string): void => {
    if (warned) return
    warned = true
    try {
      console.warn(`[serenity-hooks] bootstrap: ${message}`)
    } catch {
      /* logger 不可用 */
    }
  }

  // system-prompt/assemble：目录窄化（等价 anchored keepTools；按 agent cwd 动态解析配置）
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    try {
      const agent = (context as { agent?: unknown }).agent
      const root = agentRoot(agent)
      if (!root) return assembled
      const status = trackerFor(root).status(agent as Agent)
      if (status.promoted) {
        // promoted：开放完整目录（dsp 无 dev_tool_search 解锁机制——anchored 的
        // resident 集语义由"完整目录"承担；工具缺失不降级）
        return assembled
      }
      const tools = (assembled as PromptAssembly).tools
      if (!Array.isArray(tools)) return assembled
      const available = new Set(tools.map((tool) => tool.name).filter((n): n is string => typeof n === 'string'))
      if (SETTINGS.zeroTools) {
        // Zero-Anchored 变体（对齐 zero-anchored-standard）：首请求 0 工具（boundary < 0）；
        // 压缩后回落 compactionTools 工作集（默认 [] → 0 工具，模型中途继续）
        if (status.boundary < 0) return { ...assembled, tools: [] } as PromptAssembly
        const keep = new Set(SETTINGS.compactionTools)
        const missing = [...keep].filter((name) => !available.has(name))
        if (missing.length > 0) {
          warnOnce(`expected compaction tools missing=${JSON.stringify(missing)} — bootstrap disabled, full catalog exposed`)
          return assembled
        }
        return {
          ...assembled,
          tools: tools.filter((tool) => typeof tool.name === 'string' && keep.has(tool.name)),
        } as PromptAssembly
      }
      // Anchored 变体：bootstrap 集 + compaction 后 compactionTools（中途任务继续）
      const keep = new Set<string>(SETTINGS.bootstrapTools)
      if (status.boundary >= 0) for (const toolName of SETTINGS.compactionTools) keep.add(toolName)
      const missing = [...keep].filter((name) => !available.has(name))
      if (missing.length > 0) {
        // 工具缺失：降级完整目录 + 一次性告警（组合漂移不锁死会话）
        warnOnce(`expected bootstrap tools missing=${JSON.stringify(missing)} — bootstrap disabled, full catalog exposed`)
        return assembled
      }
      return {
        ...assembled,
        tools: tools.filter((tool) => typeof tool.name === 'string' && keep.has(tool.name)),
      } as PromptAssembly
    } catch (error) {
      warnOnce(`assemble filter failed, exposing the full catalog: ${String((error as Error)?.message ?? error)}`)
      return assembled
    }
  })

  // agent/pre-step：bootstrap 阶段剥离自动注入上下文（等价 anchored pre-step strip）
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    try {
      // 非 CCC 不生效
      const root = agentRoot(agent)
      if (!root) return decision
      if (trackerFor(root).status(agent).promoted || SETTINGS.suppressedSources.size === 0) return decision
      const messages = (decision as { messages?: UserMessage[] }).messages
      if (!Array.isArray(messages)) return decision
      const kept = messages.filter((message) => {
        const kind = message?.source?.kind
        return typeof kind !== 'string' || !SETTINGS.suppressedSources.has(kind)
      })
      return kept.length === messages.length ? decision : { ...decision, messages: kept }
    } catch (error) {
      // 过滤器出错绝不吞上下文（降级保留全部）
      warnOnce(`pre-step context filter failed, keeping injected context: ${String((error as Error)?.message ?? error)}`)
      return decision
    }
  }, { prepend: true } as never)
}
