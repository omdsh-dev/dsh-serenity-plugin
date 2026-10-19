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
import { sessionEvents } from '../cognitive-trajectory-ops.js'
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
 * 锚定交换里「模型那半」的回复文本。
 *
 * 只写一个词：锚定话语明确要求 `reply "acknowledge" — no action needed`，
 * 伪造一条更长的回复反而与提示词不符（模型会据历史学样）。
 */
export const ANCHOR_ACK_TEXT = 'acknowledge'

/**
 * 根会话锚定重入判定（v1.28.1 提取导出以便单测）：会话是否已有真实用户消息。
 * resume/续跑的会话已有对话历史 → **不重锚**（first-anchor 只注入一次）。
 *
 * 0.1.2-rc.1 适配教训：裸读 `session.events`（经类型断言）恒 undefined →
 * `!undefined` 恒 true → 有历史也永不跳过 → 任何情况发消息都重插 first-anchor。
 * 统一经 sessionEvents() 读取（snapshotEvents() 优先，.events 兜底）。
 */
export function hasUserMessageHistory(session: unknown): boolean {
  return sessionEvents(session).some((event) => {
    const e = event as { type?: string; data?: { source?: { kind?: string } } }
    if (e.type !== 'user/message') return false
    // 🔴 v1.62：只认**真人**说过话（`source.kind === 'user'`）。
    //    宿主自己会写一批 `user/message`：ACC 横幅（`plugin:*`）、`runtime-context`、
    //    `time-context`、`skill-catalog`… ⇒ 若把它们也算作"历史"，本判定在**首轮就已经为真**，
    //    锚定永不触发（实测：v1.62 首版正是这样静默失效的 —— 会话里 4 条 user 消息，
    //    其中只有 1 条 `kind=user` 是真人说的 `hi`，而它在 system 之后才写）。
    //    ⚠️ 缺 `source` 的条目按"不是真人"处理（宁可重锚一次，也不因形状缺失而漏判）。
    return e.data?.source?.kind === 'user'
  })
}

/**
 * 会话里是否已有模型回复（= 已经不是首轮）。
 *
 * 🔴 这是锚定的**形状判据**（v1.62）：锚定只能在**首轮**造。
 *    ⛔ 不能用 `hasUserMessageHistory`：宿主在 system 之后、真人 prompt 之前就写了
 *    ACC 横幅，而锚定实际执行点（`setTimeout(0)`）更晚 ⇒ 真人历史**必然已存在** ⇒ 恒真。
 *    而 `assistant/message` 只在**模型真的答过一轮之后**才出现 ⇒ 它在首轮时必然为空。
 */
export function hasAssistantHistory(session: unknown): boolean {
  return sessionEvents(session).some((event) => (event as { type?: string }).type === 'assistant/message')
}

// ── 锚定历史「造」而非「跑」（v1.62，D140）──

/**
 * 把 first-anchor 的锚定话语**直接写进会话日志**，取代「真跑两轮」。
 *
 * ## 🔴 两条硬约束（宿主 v4 格式校验器，实测逐条踩过）
 *
 * **约束 A — `system/message` 绝不能代写；`assistant/message` 可以，但必须落在已打开的 turn/step 内**。
 *
 *   🔴 **D140 的理由已由本文件 `tests/anchor-history-shape.test.ts` 当场更正**（探针直调宿主
 *   `assertReleasedV4Relationships()`，不靠读源码推断）：
 *   原记「`system/message` 与 `assistant/message` 都在 `STEP_EVENT_TYPES` 里」—— **只对前半**。
 *   实测 `STEP_EVENT_TYPES` = `{ system/message, developer/message, assistant/attempt }`，
 *   **`assistant/message` 不在其中**。它仍要过 `requireStep`，但走的是另一条路
 *   （`Relationships.accept()` → `case "assistant/message"` → `tool()` → `requireStep`）。
 *
 *   ⇒ **结论保留、理由作废**：`assistant/message` 在**该 system/message 之前**写是非法的
 *   （那时 turn/step 尚未打开）；而在**之后**写是**合法的**（那时两者都已打开）。
 *   探针三态实测：A（仅 user）✅ ／ **B（user ＋ assistant 交替，turn/step 匹配）✅** ／
 *   C（assistant 落在未打开的 turn/step）❌ `does not match an open turn and step`。
 *
 *   ⚠️ 症状（不许省这条）：写通道不校验 ⇒ **首轮看着正常**；**重新进入**时重放才抛
 *   `does not match an open turn and step` ⇒ 会话 corrupt、界面空白。
 *   ⇒ **v1.60 那版「先写占位 system 等宿主 replace」的整套方案仍然作废**
 *     （它写的是 `system/message`，那**确实**在 `STEP_EVENT_TYPES` 里）。
 *
 * **约束 B — 必须写在宿主提交 `system/message` 之后**：格式层有 `protectedHead`
 *   机制 —— `foldSurface()` 里 `system/message` 若在 **surface 非空且尚无 protectedHead**
 *   时到来，直接抛 `system/message requires a protected first surface head`。
 *   也就是说：**surface 的第一个节点必须是 system**。
 *   ⇒ 若我们先写 user 消息，宿主随后的 system 就落不到首位 ⇒ 重放同样判 corrupt。
 *   ⚠️ 这条是**第一次修复后仍然翻车**的原因（同一会话、不同报错），
 *   判据仍是「重启宿主后重新进入该会话」。
 *
 * ⇒ 因此调用时机 = **`session/event` 里看到该会话第一条 `system/message` 之后**（见下方注册处），
 *   而不是 `agent/inbox/inserted`（那太早）。
 *
 * ## 为什么必须成对（user ＋ assistant ack）—— v1.69.4 修正
 *
 * 只造 user 的那一版在**界面上读不成对话**：两条"用户"消息连排在模型回复之前，
 * 看起来像用户自己连说了两句协议、而模型没理。owner 2026-10-19 报的两点
 * （「助手的回应也需要造出来」＋「用户的怎么跑到第一个了」）其实是**同一个缺陷的两面**。
 * ⇒ 造**成对交换**：每条锚定话语后面跟一条 `acknowledge` 回复。
 *
 * 🔴 **前提条件**：`assistant/message` 必须落在**已打开**的 turn/step 内
 *   （探针 S3/S4 实测：未打开/已关闭都抛 `does not match an open turn and step`）。
 *   本函数由 `session/event` 的 `system/message` 分支触发，而**那条事件自己就带着
 *   `data.turn` / `data.step`** —— 且实测此刻 turn/step 确实处于打开态
 *   （真机日志：`step/start` → `system/message` → 锚定写入 → `step/end`）。
 *   ⇒ turn/step **从触发事件透传进来**，不自己猜。
 *
 * ⚠️ **拿不到 turn/step 时退回只造 user**（不抛、不阻断）：宁可少伪造一条 ack，
 *   也绝不在非法坐标上写 `assistant/message` —— 那会让会话在重放时 corrupt。
 *
 * ## 判据（改这个函数前后都必须跑）
 *
 * ① 形状判据 = `tests/anchor-history-shape.test.ts`（直调宿主校验器，正控 ＋ 两种负控）；
 * ② 单测钉事件序列（user/assistant 交替、turn/step 逐条匹配）；
 * ③ **容器内真跑一轮 → 重启宿主 → 重新进入该会话** —— 只有这条路能证明日志合法
 *   （前两次修复都是"单测全绿 + 首轮正常"却仍然 corrupt）。
 *
 * @param session 会话（需有 append）
 * @param anchorMessages 锚定话语序列（缺省协议固有两条）
 * @param slot 触发本轮 `system/message` 所在的 turn/step（缺省或非法 ⇒ 只造 user）
 * @returns 是否成功写入
 */
export function appendAnchorHistory(
  session: unknown,
  anchorMessages: string[] = DEFAULT_ANCHOR_MESSAGES,
  slot?: { turn?: unknown; step?: unknown },
): boolean {
  const target = session as {
    append?: (type: string, data: unknown, opts?: unknown) => { seq?: number }
  } | undefined
  if (typeof target?.append !== 'function') return false
  const append = target.append.bind(target)
  const rid = (prefix: string): string => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  // 坐标必须**成对且为正整数**：宿主 `sessionFormatCount` 对 0/null 一律拒
  const turn = typeof slot?.turn === 'number' ? slot.turn : 0
  const step = typeof slot?.step === 'number' ? slot.step : 0
  const canPlaceAck = turn > 0 && step > 0
  try {
    for (let i = 0; i < anchorMessages.length; i++) {
      append(
        'user/message',
        {
          id: rid(`anchor-user-${i + 1}`),
          role: 'user',
          content: [{ type: 'text', text: anchorMessages[i] }],
          source: { kind: 'user' },
        },
        { surfaceOp: 'append' },
      )
      if (!canPlaceAck) continue
      append(
        'assistant/message',
        {
          turn,
          step,
          message: {
            id: rid(`anchor-ack-${i + 1}`),
            role: 'assistant',
            content: [{ type: 'text', text: ANCHOR_ACK_TEXT }],
            source: { kind: 'model' },
          },
        },
        { surfaceOp: 'append' },
      )
    }
    return anchorMessages.length > 0
  } catch {
    return false
  }
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

/** 协议固有 bootstrap 设置（v1.62 / D140）。
 *
 * 🔴 **zeroTools 必须为 false**：v1.62 起锚定历史**只造 `user/message`**（不含伪造的
 *   `assistant/message`）⇒ **首请求时晋升信号尚未满足** ⇒ 若仍 `zeroTools: true`，
 *   首请求会真的退化成「0 工具」，模型看不到任何 ACC 工具。
 *
 * 🔴 **为什么不改回去伪造一条 assistant**：宿主 v4 校验要求 `assistant/message` 落在
 *   已打开的 turn+step 内（见 `appendAnchorHistory` 头注释），而锚定写入时 turn/step
 *   都还没打开 ⇒ 伪造它**结构性非法**，代价是「重新进入会话即 corrupt」。
 *
 * ⇒ 取舍：**首请求就给完整工具目录**（放弃「首请求窄目录」这个 cache 断点优化），
 *   换来**日志合法**。`bootstrapTools` 因此只是历史字段，`boundary < 0` 分支已让位。 */
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
  // 🆕 v1.62（D140）：**锚定历史也在这里造** —— 时机是本函数最关键的参数，见下。
  ctx.on('session/event', (session, event) => {
    try {
      const cwd = (session as { header?: { cwd?: string } } | undefined)?.header?.cwd
      if (typeof cwd !== 'string') return
      const root = cccRootForCwd(cwd)
      if (!root) return
      trackerFor(root).observe(session, event)
      // 🔴 **必须是 `system/message` 之后**（宿主 v4 的 `protectedHead` 硬约束）：
      //    `foldSurface()` 里 `system/message` 若在 **surface 非空且尚无 protectedHead** 时到来，
      //    直接抛 `system/message requires a protected first surface head`
      //    ⇒ **surface 的第一个节点必须是 system**。
      //    ⇒ 若我们在 `agent/inbox/inserted`（太早，system 还没提交）就写 user 消息，
      //      宿主随后的 system 落不到首位 ⇒ **重放即 corrupt**。
      //    🔵 这条正是"第一次修复后仍然翻车"的第二个缺陷 —— 单测全绿、首轮正常，
      //      只有**重启宿主后重新进入该会话**才暴露。
      if (event.type === 'system/message') {
        // 🔴 **不能在 `session/event` 回调里直接 append**（第三个缺陷，2026-10-17 容器实测）：
        //    宿主的 `publicationEntry()` 会抛 `session append cannot reenter while another
        //    append is being published` —— 此刻它**正在**发布这条 `system/message`。
        //    而该异常会被本回调的 `try/catch` 与宿主的 per-listener containment **双重吞掉**
        //    ⇒ 症状是"首轮完全正常，但锚定就是没发生"，**没有任何报错**。
        //    ⇒ 用 setTimeout(0) 把写入推到**发布完成之后**的下一拍（同一个 Node 事件循环）
        //
        // 🔴 **turn/step 从这条事件自己透传**（v1.69.4）：`system/message` 的 data 里就带着
        //    `{turn, step}`，且宿主的发布顺序使此刻两者**处于打开态**（真机日志实测：
        //    `step/start` → `system/message` → 锚定写入 → `step/end`）。
        //    ⛔ 不要自己从别处猜：`assistant/message` 要求坐标**精确等于当前打开的**。
        const slot = (event as { data?: { turn?: unknown; step?: unknown } }).data
        setTimeout(() => {
          try {
            maybeAnchor(session, root, slot)
          } catch {
            /* 锚定失败不阻断会话 */
          }
        }, 0)
      }
    } catch {
      /* 观察失败不阻断 */
    }
  })

  /** 造锚定历史（幂等；防重靠 `anchoredSessions`）。 */
  const maybeAnchor = (session: unknown, _root: string, slot?: { turn?: unknown; step?: unknown }): void => {
    const s = session as { header?: { delegationDepth?: number }; id?: string } | undefined
    const depth = s?.header?.delegationDepth ?? 0
    const sid = typeof s?.id === 'string' ? s.id : undefined
    if (sid !== undefined && anchoredSessions.has(sid)) return
    // cheap-worker worker / Skiff：autonomous 与角色会话不需要锚定（同 apply 侧判定）
    if (sid !== undefined && (sid.startsWith('cheap-worker-') || isSkiffSessionId(sid))) return
    // 🔴 **不要用 `hasUserMessageHistory` 当防重判据**（v1.62 实测踩到）：
    //    本函数跑在 `setTimeout(0)` 之后，而那一刻**真人消息已经写进日志了**
    //    （宿主的顺序是 system → ACC 横幅 → 真人 prompt → runtime-context …）
    //    ⇒ 若在这里查历史，它**恒为真** ⇒ 锚定永不触发（且**没有任何报错**）。
    //    防重改用进程内 `anchoredSessions`；"resume/续跑不重锚"由**更早**的
    //    `agent/inbox/inserted` 那条路径负责（那里能看到"是否已有真人历史"）。
    //    形状判据：只有**首轮**才锚 —— 即该会话还没有任何 `assistant/message`。
    if (hasAssistantHistory(session)) return
    void depth
    const wrote = appendAnchorHistory(session, SETTINGS.anchorMessages, slot)
    if (wrote && sid !== undefined) anchoredSessions.add(sid)
    if (wrote) {
      const paired = typeof slot?.turn === 'number' && typeof slot?.step === 'number' && slot.turn > 0 && slot.step > 0
      warnOnce(
        `anchor history fabricated: ${SETTINGS.anchorMessages.length} 条 user 消息`
        + (paired ? ` ＋ ${SETTINGS.anchorMessages.length} 条 ack（turn ${String(slot.turn)} / step ${String(slot.step)}）` : '（无打开坐标 ⇒ 未造 ack）')
        + '（不再真跑）',
      )
    }
  }

  // 首轮锚定（v1.62 起**不再**在这里写历史 —— 见上面 `session/event` 的 `system/message` 分支）。
  // 本订阅保留用于：判定「是否该锚定」的**早期信号**（不改日志），以及未来的旁路需求。
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    try {
      const root = agentRoot(agent)
      if (!root) return
      const session = (agent as { session?: unknown }).session as { header?: { delegationDepth?: number }; id?: string } | undefined
      const sid = typeof session?.id === 'string' ? session.id : undefined
      if (sid !== undefined && (sid.startsWith('cheap-worker-') || isSkiffSessionId(sid))) return
      if ((message as { source?: { kind?: string } })?.source?.kind === ACC_MESSAGE_KIND) return
      // ⚠️ **不要在这里写锚定历史**：此刻宿主的 `system/message` 还没提交，
      //    先写 user 消息会把 surface 首节点让给 user ⇒ 重放抛
      //    `system/message requires a protected first surface head`（见头注释约束 B）。
      void session
    } catch {
      /* 不阻断 */
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
      // 🆕 v1.62（D140）：`boundary < 0`（真·首请求）**直接给完整目录**。
      //   为什么：锚定历史现在只造 user 消息 ⇒ 首请求时**晋升信号尚未满足** ⇒ 会落进窄目录分支；
      //   而我们的目的正是**取消那个断点**，若仍收窄成 5 个工具，等于把「空→满」的断点换成
      //   「窄→满」的断点，白改一场。compaction 之后（boundary ≥ 0）仍收窄 —— 那是**另一档**
      //   （压缩后继续任务），不放宽，否则压缩后工具面突变又造一次 cache 断点。
      if (status.boundary < 0) return assembled
      const keep = new Set<string>(SETTINGS.bootstrapTools)
      for (const toolName of SETTINGS.compactionTools) keep.add(toolName)
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
