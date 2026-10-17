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
import { cccRootForCwd } from '../ccc-roots.js'
import { sessionEvents } from '../trajectory-ops.js'
import { isSkiffSessionId } from '../skiff-role.js'
import { ACC_MESSAGE_KIND } from '../message-source.js'

interface BootstrapSettings {
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

// ── 锚定历史「造」而非「跑」（v1.60，owner 令 2026-10-17）──

/** 造出来的 assistant 回复正文。锚定轮要求"只回确认、不做事"。 */
const ANCHOR_ACK_TEXT = 'acknowledge'

/** 占位 system 文本：宿主 `SystemPromptProjection.project()` 会把它**原地 replace** 成真提示词。 */
const ANCHOR_SYSTEM_PLACEHOLDER = '<!-- serenity:anchor-placeholder -->'

/**
 * 把两轮 first-anchor 对话**直接写进会话日志**，取代原来的「真跑两轮」。
 *
 * ## 为什么可以这样（三条取证，全部打在真 `@deepseek-ai/dsh-session` 上）
 *
 * 1. **system 必须是 surface node 0**，而 `agent/pre-step` 跑在宿主提交 system **之前**
 *    ⇒ 若直接写 [anchor…]，system 会被追加到**末尾**（实测：`systemAtIndex: 4`，
 *    且**不报错**、静默走偏）。解法 = **先写一条占位 system**：宿主随后看到 node0
 *    已有 system 且文本不同 ⇒ 走 `replace(head)` 换成真提示词，锚定历史原样留在其后。
 * 2. **`contentGeneration` 只在 replace 时涨，append 不涨**；而 `buildRequest()`
 *    取 generation 快照**晚于** `systemPrompt.project()` ⇒ 那次 replace 不会被
 *    误判成「系列断裂」（不会误触发 `startsSeries`）。
 * 3. **造出来的 `assistant/message` 合法**：`stream: []` 通过校验；整段历史之后
 *    仍可被 compaction 的 `surfaceOp: replace` 整体覆盖（不炸）。
 *
 * ## ⚠️ 为什么不发 turn/start、turn/end
 *
 * 宿主的 turn 计数是**构造时缓存**的：`phase.lastTurn` 在本钩子触发前已读定（0），
 * 之后 `turn()` 恒用 `phase.turn + 1`。我们若自己发 `turn/start{1}{2}`，宿主随后
 * 仍会再发一条 `turn/start{1}` ⇒ **重复编号 ∧ 两个 turn 同时开着**。
 * ⇒ 只给消息打 **turn 标签**（模型可见顺序不依赖 turn 事件，`deriveMessages` 只看
 * surface 节点），**不碰宿主的 turn 账本**。
 *
 * @param session 会话（需有 append）
 * @param provider 当前路由 provider（写入 assistant 消息来源）
 * @param model 当前模型 id
 * @returns 是否成功写入
 */
export function appendAnchorHistory(
  session: unknown,
  provider: string,
  model: string,
  anchorMessages: string[] = DEFAULT_ANCHOR_MESSAGES,
): boolean {
  const target = session as {
    append?: (type: string, data: unknown, opts?: unknown) => { seq?: number }
  } | undefined
  if (typeof target?.append !== 'function') return false
  const append = target.append.bind(target)
  const rid = (prefix: string): string =>
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

  // ① 占位 system —— 抢占 surface node 0，宿主随后原地替换成真提示词
  append(
    'system/message',
    {
      turn: 1,
      step: 1,
      message: {
        id: rid('anchor-system'),
        role: 'system',
        content: [{ type: 'text', text: ANCHOR_SYSTEM_PLACEHOLDER }],
        source: { kind: 'system-prompt' },
      },
    },
    { surfaceOp: 'append' },
  )

  // ② 两轮锚定对话（owner 令「搞两个」＝ 两条独立 turn 标签）
  for (let i = 0; i < anchorMessages.length; i++) {
    const turn = i + 1
    append(
      'user/message',
      {
        id: rid(`anchor-user-${turn}`),
        role: 'user',
        content: [{ type: 'text', text: anchorMessages[i] }],
        source: { kind: 'user' },
      },
      { surfaceOp: 'append' },
    )
    append(
      'assistant/message',
      {
        turn,
        step: 1,
        message: {
          id: rid(`anchor-assistant-${turn}`),
          role: 'assistant',
          content: [{ type: 'text', text: ANCHOR_ACK_TEXT }],
          source: { kind: 'model', provider, model },
        },
        // stream 是宿主必填字段；空数组通过校验（探针 P3 实测）
        stream: [],
      },
      { surfaceOp: 'append' },
    )
  }
  return true
}

// ── 阶段机（等价 anchored compaction-epoch.mjs createEpochPromotion）──

interface PromotionStatus {
  /** 最后一次 compaction/end 的 seq（-1 = 未压缩过） */
  boundary: number
  /** 边界后是否存在持久晋升信号 */
  promoted: boolean
}

interface PromotionTracker {
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
      // cheap-worker worker（sessionId 固定 `cheap-worker-` 前缀，tools/cheap-worker.ts 生成）：autonomous 程序化
      // worker，需从第 1 轮起就持有完整工具目录 + 完整 ACC 系统提示词（DCP/标准层）。
      // 它经 ctx.agents.create 直接创建（非 DSH delegation 路径），delegationDepth 为 0，
      // 会绕过下方 delegationDepth>0 的恒 promoted 分支——故显式按 `cheap-worker-` 前缀判 promoted，
      // 与 context.ts shouldAutoRestore 的 `cheap-worker-` 约定保持一致。
      // F4 Skiff（`skiff-` 前缀）：角色 CCC 提示词全替换，无需 whoami 锚定轮——恒 promoted（同 cheap-worker）。
      const loopSid = (session as { id?: string }).id
      if (typeof loopSid === 'string' && (loopSid.startsWith('cheap-worker-') || isSkiffSessionId(loopSid))) return { boundary: -1, promoted: true }
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

/** 协议固有 bootstrap 设置：**zeroTools=false**（v1.60 起）。
 *
 * 🔴 **为什么从 true 改成 false**（owner 令 2026-10-17，造历史取代真跑）：
 *   锚定历史现在**直接写进日志**，因此 `assistant/message` 晋升信号在首请求前
 *   就已满足 ⇒ `boundary < 0` 分支实际不可达。但**不能依赖"恰好满足"这个副作用**：
 *   若哪天锚定历史没写成（例如非 CCC 会话/异常降级），`zeroTools: true` 会退回到
 *   「首请求 0 工具」，那是**另一种**退化。显式关掉 ⇒ 任何情况下首请求都拿完整目录。
 *
 * ⚠️ 这意味着 `bootstrapTools` 窄化也随之失效 —— 它的作用本来就是"首请求窄目录"，
 *   而造历史的目的正是**取消这个断点**。保留字段只为不破坏旧测试的引用面。 */
export function resolveBootstrapSettings(): BootstrapSettings {
  return {
    bootstrapTools: [...DEFAULT_BOOTSTRAP_TOOLS],
    promoteEvents: PROMOTE_EVENTS['assistant-message'],
    requiredSignals: DEFAULT_ANCHOR_MESSAGES.length,
    suppressedSources: new Set(DEFAULT_SUPPRESSED_SOURCES),
    compactionTools: [...DEFAULT_COMPACTION_TOOLS],
    anchorMessages: [...DEFAULT_ANCHOR_MESSAGES],
    zeroTools: false,
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
  return cccRootForCwd(cwd)
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
      const root = cccRootForCwd(cwd)
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
      // cheap-worker worker（sessionId `cheap-worker-` 前缀）：autonomous worker，不需要 whoami 锚定轮
      // （锚定轮消耗 2 轮 + 0 工具，浪费；cheap-worker worker 已通过 systemPrompt.section 获得 ACC 5 块）。
      // F4 Skiff（`skiff-` 前缀）：角色 CCC 提示词全替换，同样不需要锚定轮（旁路）。
      // 与 createEpochPromotion.status 的 `cheap-worker-` 恒 promoted 判定保持一致。
      if (sid !== undefined && (sid.startsWith('cheap-worker-') || isSkiffSessionId(sid))) return
      if (depth === 0) {
        // v1.28.1：sessionEvents() 统一读取——rc.1 起 Session 无 .events 属性（snapshotEvents()），
        // 裸读 .events 恒 undefined → `!undefined` 恒 true → **有历史也永不跳过 → 每条消息都重插锚定**。
        // 本判定 = 会话是否已有真实用户消息（resume/续跑不重锚）。
        if (hasUserMessageHistory(session)) return
      } else {
        if (sid !== undefined && anchoredSessions.has(sid)) return
      }
      // 插件来源消息不递归锚定（含我们自己的锚定消息）
      if ((message as { source?: { kind?: string } })?.source?.kind === ACC_MESSAGE_KIND) return
      // 🆕 v1.60：**造历史**取代「真跑两轮」（owner 令 2026-10-17）。
      //   旧做法 = 往 next-turn 队列 prepend 2 条锚定消息 ⇒ 模型要真跑 2 个往返
      //   （2 次模型调用 + 2 个 turn），只为让"它认为自己已同意过"。
      //   新做法 = 一次性把 [占位 system, anchor1, ack1, anchor2, ack2] 写进日志：
      //     · 语言学效果不变（模型读到的仍是同样的历史）
      //     · 首请求即 full tools（晋升判据立刻满足，工具断点消失）
      //     · 只剩 1 次真实往返
      //   时机必须在这里（`agent/inbox/inserted` 早于 turn 开立与 system 装配），
      //   详见 appendAnchorHistory 的取值与坑。
      const route = (agent as { options?: { provider?: string; model?: string } }).options
      const wrote = appendAnchorHistory(
        session,
        typeof route?.provider === 'string' ? route.provider : 'unknown',
        typeof route?.model === 'string' ? route.model : 'unknown',
      )
      if (wrote && sid !== undefined) anchoredSessions.add(sid)
      if (wrote) warnOnce(`anchor history fabricated: ${SETTINGS.anchorMessages.length} 轮（不再真跑）`)
      return
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
      // Anchored 变体（v1.60：锚定历史改为"造"进日志）
      // 🔴 **语义已变，必须读**：锚定历史直接写进会话 ⇒ 首请求时晋升信号已满足 ⇒
      //   normal 路径根本到不了这里。真正会到这儿的只有 **compaction/end 之后**
      //   （boundary ≥ 0、signalCount 被清零）⇒ 那正是"压缩后继续任务"的场景，
      //   仍应收窄到 compactionTools（**不放宽**这一档，否则压缩后工具面突变
      //   又造出一次 cache 断点）。
      //   boundary < 0（真·首请求且**没有**造出历史，例如锚定被跳过）⇒ 给完整目录：
      //   此时若再收窄到 5 个工具，等于把"空→满"的断点换成"窄→满"的断点，白改。
      if (status.boundary < 0) return assembled
      const keep = new Set<string>(SETTINGS.compactionTools)
      const missing = [...keep].filter((name) => !available.has(name))
      if (missing.length > 0) {
        // 工具缺失：降级完整目录 + 一次性告警（组合漂移不锁死会话）
        warnOnce(`expected compaction tools missing=${JSON.stringify(missing)} — bootstrap disabled, full catalog exposed`)
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
