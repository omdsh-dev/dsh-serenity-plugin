/**
 * role/skiff/core.ts — skiff 会话核心（**2026-10-19 重做**：skiff = 带 `skiff.json` 的认知轨迹）
 *
 * ## 与旧版的根本差别（R↓，这是本次重做的全部内容）
 *
 * 旧版：skiff 是**一个角色**（`serenity.json` 的 `skiff.roles.<name>`），会话身份由
 * dsh sessionId 前缀 `skiff-` 判定，工作台由 `ensureSkiffSession` **另建一个 SESSION**。
 *
 * 新版：skiff 是**一条认知轨迹**（目录里有 `skiff.json`）——
 * · **身份 = 轨迹编码**（不是角色名，不是 sessionId 前缀）；
 * · **工作台 = 该轨迹自己的 SESSION.md**（不再另建，`ensureSkiffSession` 已删除）；
 * · **判据 = 绑定的轨迹有没有 `skiff.json`**（唯一入口 `profile.ts` 的 `skiffProfileForSession`）。
 *
 * ⇒ 删掉的东西（它们只是旧模型的补丁，不是通用机制）：
 * `SKIFF_SESSION_PREFIX` 判定 ／ `ensureSkiffSession` 自动建工作台 ／
 * `kind: temporary|persistent` ／ 换代计数器（`im/route.ts` 的 `.weixin-session-gen.json`）。
 *
 * ## 本文件仍负责
 * agent 创建/复用（resume-or-create）／系统提示词段注册／提问与等本轮回答／守门查询。
 */

import type { Context } from 'cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import {
  profileCognitiveTrajectory,
  profileMsmWhitelist,
  profileToolWhitelist,
  buildSkiffBasePrompt,
  resolveProfileSystemPrompt,
  createProfilePromptReader,
} from './config.js'
import { readSkiffProfileAt, readSkiffProfileByCode, skiffProfileForSession, findDirNameByCode, type SkiffProfile } from './profile.js'
import {
  registerSkiffSession as registryRegister,
  unregisterSkiffSession as registryUnregister,
  skiffTrajectoryDirNameFor as registryTrajectoryDirName,
  skiffSessionInfo as registrySessionInfo,
  skiffSessionSnapshot as registrySnapshot,
} from './registry.js'
import { sessionsRoot } from '../../trajectory/core.js'
import { hasTrajectoryPrompt } from '../../trajectory/prompt.js'
import { hostAgents } from '../../host/access.js'
import { waitAgentIdle } from '../worker/idle.js'
import { registerCognitiveTrajectorySkillSection } from '../../seams/system-prompt.js'
import { PLUGIN_SOURCE } from '../../kernel/message-source.js'

export type { SkiffProfile }

// ── 会话注册表（sessionId → 轨迹目录名 ＋ CCC；见 registry.ts 的 R↓）──

const skiffAgents = new Map<string, Agent>()

/** 查 sessionId 承载的轨迹目录名（无 → null） */
export function skiffTrajectoryDirNameFor(sessionId: string): string | null {
  return registryTrajectoryDirName(sessionId)
}

/** 查 sessionId 的会话绑定（轨迹 ＋ ccc；无 → null）——追问校验 */
export function skiffSessionInfo(sessionId: string): { trajectoryDirName: string; ccc: string } | null {
  return registrySessionInfo(sessionId)
}

/** 查 sessionId 的活体 agent（进程内会话延续用；未注册/已清理 → undefined） */
export function getSkiffAgent(sessionId: string): Agent | undefined {
  return skiffAgents.get(sessionId)
}

/** 该会话当前绑定的 skiff 约束面（不是 skiff → null）。**守门与提示词的唯一查询入口。** */
export function skiffProfileFor(root: string, sessionId: string | undefined): SkiffProfile | null {
  if (sessionId === undefined) return null
  return skiffProfileForSession(root, sessionId, registryTrajectoryDirName(sessionId))
}

export function registerSkiffSession(sessionId: string, trajectoryDirName: string, ccc: string, agent: Agent): void {
  skiffAgents.set(sessionId, agent)
  registryRegister(sessionId, trajectoryDirName, ccc)
}

export function unregisterSkiffSession(sessionId: string): void {
  skiffAgents.delete(sessionId)
  registryUnregister(sessionId)
}

/** 测试/调试：注册表快照 */
export function skiffSessionSnapshot(): ReadonlyMap<string, { trajectoryDirName: string; ccc: string }> {
  return new Map(registrySnapshot())
}

// ── 工作台（= 该轨迹自己的 SESSION.md，不再另建）──

/**
 * 该 skiff 会话的**工作台路径** = 它自己轨迹的 SESSION.md。
 *
 * 🔴 与旧版的差别：旧版会在这里**自动新建**一个 SESSION（`ensureSkiffSession`）；
 * 新版**没有新建这个动作** —— 轨迹就是工作台，`skiff.json` 与 `SESSION.md` 同处一个目录。
 * ⇒ 语义变成纯粹的"查询：我自己的身体在哪"。
 *
 * @returns SESSION.md 绝对路径；不是 skiff / 文件不在 → null
 */
export function skiffWorkspaceMdPath(root: string, sessionId: string | undefined): string | null {
  if (sessionId === undefined) return null
  const dirName = registryTrajectoryDirName(sessionId)
  if (dirName === null) return null
  const md = join(sessionsRoot(root), dirName, 'SESSION.md')
  return existsSync(md) ? md : null
}

/**
 * 系统提示词中的**工作台纪律块**（S142 用户：只给路径 LLM 不会主动用）。
 *
 * SESSION = 工作台 —— skiff 与主舱同一套机制（**零特调**，用户拍板）：
 * SESSION.md 是持久记忆载体、rebuild 自动从本 SESSION 续接。
 * 注入 agent 系统提示词（用户对话面不可见）。
 *
 * v1.30.13（S142 诊断 D5）：写入纪律**不点名具体工具** —— 旧文案写死 "with write/edit"，
 * 而某个 skiff 的工具白名单里根本没有 write/edit ⇒ 指令指向它没有的工具
 * （注入纪律与能力面矛盾，模型只能猜）。现文案改为「用本轨迹被授权的写入通道」。
 */
export function workspaceCognitiveTrajectoryLine(mdPath: string): string {
  return [
    '── Serenity Session Workspace ──',
    'You ARE a cognitive trajectory: this workspace SESSION is your own persistent body.',
    `  SESSION.md: ${mdPath}`,
    '',
    'Rules of the workspace:',
    '  1. This SESSION.md is your persistent memory carrier (like the main cabin SESSION) — ',
    '     read it first when context feels thin or work spans turns.',
    '  2. Record key decisions/progress/unresolved items INTO this SESSION.md using the write channel',
    '     your trajectory is actually granted (use whatever write tool or MSM you have — never assume',
    '     a specific write tool exists; if none is granted, report that instead of pretending to write).',
    '     Sections: 身份与边界 / 权威锚点 / 工作纪律 / 决策 / 日志 / 当前状态 / 待 owner 裁决.',
    '     Keep entries at milestone level (one line + evidence pointer); execution detail',
    '     belongs in commit messages. Keep it current — it is what a rebuild resumes from.',
    '  3. When context pressure is high, run cognitive_trajectory rebuild — it auto-resumes from THIS SESSION.md.',
    '  4. Never expose this internal path in user-facing replies (chat stays clean).',
    '── ──',
  ].join('\n')
}

/** 已挂工作台提示词段的 agent（幂等：同一 agent 只注册一次，避免 duplicate section） */
const workspaceSectionAgents = new WeakSet<object>()

/** systemPrompt.section 的最小结构（宿主成员，不可假定存在） */
interface SectionCapable {
  systemPrompt?: { section?: (section: { name: string; order?: number; text: () => string }) => unknown }
}

/**
 * 把**工作台纪律块**挂到 agent 的系统提示词段（单一注入点）。
 *
 * 用户原话（S142，2026-09-08）："微信桥的注入机制，每个用户消息都会注入，skiff 本身也会注入，
 * 这样就重复，能否微信桥情况下，注入内容直接取 skiff 的，这样不用配两遍"。
 *
 * 现形态：工作台行**只**经本函数挂系统提示词段（name `serenity-skiff-workspace`，
 * 动态 `text()` 每轮按 scope 读当前活跃 mdPath）。
 *
 * @returns true = 段已在位；false = 该 agent 挂不上（调用方降级为 question 前缀注入）
 */
export function ensureWorkspacePromptSection(agent: Agent, scope: string, root: string): boolean {
  if (!agent || typeof agent !== 'object') return false
  if (workspaceSectionAgents.has(agent)) return true
  const api = (agent.ctx as SectionCapable | undefined)?.systemPrompt
  if (typeof api?.section !== 'function') return false
  try {
    api.section({
      name: 'serenity-skiff-workspace',
      // 排在基础段（serenity-skiff，-60）之后、CCC 提示词段之前
      order: -55,
      text: () => {
        const mdPath = skiffWorkspaceMdPath(root, scope)
        return mdPath ? workspaceCognitiveTrajectoryLine(mdPath) : ''
      },
    })
    workspaceSectionAgents.add(agent)
    return true
  } catch (err) {
    console.warn(`[serenity-hooks] skiff 工作台提示词段注册失败（回退 question 注入）: ${String((err as Error)?.message ?? err)}`)
    return false
  }
}

// ── agent 生命周期 ──

interface SkiffAgentRef {
  handle: AgentHandle
  agent: Agent
  sessionId: string
  /** true = 从持久化恢复既有会话（历史延续，非新对话）；false = 新建 */
  resumed: boolean
}

/** skiff agent 挂载的 DSH preset（平台工具面由 preset 决定；白名单再按轨迹过滤） */
const SKIFF_PRESET = 'standard'

/**
 * 创建（或复用）一个 skiff 会话。
 *
 * **固定 sessionId 的 resume-or-create**（v1.27.2）：指定 sessionId 且磁盘已有持久化 log →
 * `ctx.agents.resume`（DSH 持久化语义：sessionId 即身份，历史 + turn 续号延续）；
 * 无 log（首次）→ `ctx.agents.create`。不指定 → 随机 id 恒 create（调试页路径）。
 *
 * @param profile 该 skiff 的约束面（来自 `skiff.json`）
 * @param sessionId 指定会话 id（可选；微信桥等外部面用固定 id 实现"轨迹 ↔ 会话"长期映射）
 */
export async function createSkiffAgent(
  ctx: Context,
  root: string,
  profile: SkiffProfile,
  defaultModel?: string,
  sessionId?: string,
): Promise<SkiffAgentRef> {
  if (!ctx.agents) throw new Error('skiff: ctx.agents unavailable')
  const model = profile.model?.trim() || defaultModel || ''
  const id = (sessionId ?? `skiff-${profile.code}-${randomUUID()}`) as SessionId
  const setup = async (agentCtx: Context) => {
    try {
      // 挂载 standard preset → agent 工具面含 read/grep/glob/web_search 等平台工具；
      // agentPresets 可选服务缺失（未装配）→ 跳过（回退全局工具层，不阻断创建）
      const presets = agentCtx.get('agentPresets') as { mount?: (c: Context, id: string) => Promise<unknown> } | undefined
      await presets?.mount?.(agentCtx, SKIFF_PRESET)
    } catch {
      /* preset 挂载失败不影响 agent 创建（白名单仍兜底约束） */
    }
  }
  const handle = await createOrResumeAgent(ctx, id, root, model, setup, sessionId !== undefined)
  const agent = handle.agent
  // scoped 系统提示词：基础段（动态发现路径）+ CCC 的提示词段。
  //
  // 🔴 热生效的**唯一判据 = 每次求值都重读配置**（owner 2026-10-19 令「工具清单也要热加载」）。
  //   两个事实：① 本 `text()` **每轮都被调用**；② 但 `profile` 是入参 = **创建时的快照**
  //   ⇒ 旧版即使每轮重算，算的也是冻结对象 ⇒ CCC 改了配置必须重启才生效。
  //   ⇒ 现在每轮按 `profile.path` 重读 `skiff.json`；读不到（文件被删）就退回创建时那份。
  //   ⚠️ 提示词**文件**另有它自己的热重载（createProfilePromptReader 按 mtime+size），
  //   但那份 reader 是用创建时的 profile 造的 ⇒ `systemPromptFile` 路径本身变了不生效
  //   ⇒ 这里按路径缓存 reader：路径不变就复用（保住 mtime 缓存），变了重建。
  let readerPath: string | undefined = profile.systemPromptFile?.trim()
  let reader = createProfilePromptReader(root, profile)
  const livePrompt = (): string => {
    let live = profile
    try {
      const fresh = readSkiffProfileAt(join(sessionsRoot(root), profile.dirName), root)
      if (fresh) live = fresh
    } catch {
      /* 配置读取失败 ⇒ 沿用创建时那份（不阻断本轮） */
    }
    const wantPath = live.systemPromptFile?.trim()
    if (wantPath !== readerPath) {
      reader = createProfilePromptReader(root, live)
      readerPath = wantPath
    }
    return reader()
  }
  // 首次求值（文件缺失/逃逸在创建时即告警；reader 内部对失败已降级为上次成功内容）
  void livePrompt()
  try {
    agent.ctx.systemPrompt.section({
      name: 'serenity-skiff',
      order: -60,
      // 🔴 **T2（2026-10-19）：本段不再"立人格"，只剩两件窄事** ——
      //   ① 基础段 `buildSkiffBasePrompt`：**身份边界与能力发现路径**（"这是你，不是你演的角色"、
      //      "能力面由机制强制、按 schema 与 msm() 目录现取"）；
      //   ② **兼容期**：旧 `skiff.json` 的 `systemPromptFile` 正文。
      //
      // 为什么②还留着：存量 CCC 的章程仍写在 `.opencode/skiff/<name>.md`，
      // 不迁也能继续工作 —— **不静默坏**。
      // 新形态是轨迹目录里的 `PROMPT.md`（`trajectory/prompt.ts`），由主装配的第 ⑧ 段注入。
      //
      // ⚠️ **两者同时存在时**：`PROMPT.md` 走第 ⑧ 段、`systemPromptFile` 走本段，
      //    会出现两份章程。⇒ 若该轨迹已有 `PROMPT.md`，本段的②**让位**（`livePrompt()` 返回空），
      //    判据由 `hasTrajectoryPrompt()` 给出（单一判据，不在这里自己拼路径）。
      text: () => {
        const legacy = hasTrajectoryPrompt(root, profile.dirName) ? '' : livePrompt()
        return [buildSkiffBasePrompt(profile.code), legacy].filter(Boolean).join('\n')
      },
    })
  } catch (err) {
    console.warn(`[serenity-hooks] skiff 系统提示词注册失败: ${String((err as Error)?.message ?? err)}`)
  }
  // CCC 级 `cognitiveTrajectory.skills` 与轨迹级 frontmatter 声明，同样送到 skiff 会话。
  //
  // 为什么这不与"skiff 旁路 ACC 身份注入"矛盾（R↓）：旁路掉的是**ACC 身份与纪律**
  // （skiff 用 CCC 自己的提示词立人格）；而 skill 供给是**工作资料**（"这件事按哪套方法做"），
  // 与人格无关 ⇒ 照给。判据是「旁路的是谁的身份」，不是「凡是 ACC 的 section 都旁路」。
  if (agent?.session) {
    try {
      registerCognitiveTrajectorySkillSection(agent, root)
    } catch (err) {
      console.warn(`[serenity-hooks] skiff 轨迹 skill 注入注册失败（不影响 agent 创建）: ${String((err as Error)?.message ?? err)}`)
    }
  }
  // 工作台纪律块**只**经 ensureWorkspacePromptSection 挂（单一注入点）
  if (skiffWorkspaceMdPath(root, id) !== null) ensureWorkspacePromptSection(agent, id, root)
  registerSkiffSession(id, profile.dirName, root, agent)
  return { handle, agent, sessionId: id, resumed: handle.resumed }
}

/** 取 live agent（DSH 文档：`ctx.agents.get(id)` 返回 bare Agent；会话 live 时 resume/create 均不可用） */
function getLiveAgent(ctx: Context, id: string): Agent | undefined {
  try {
    return hostAgents(ctx)?.get?.(id) as Agent | undefined
  } catch {
    return undefined
  }
}

/** live 复用返回（resumed:true 历史延续；dispose 空操作——live agent 不归本模块所有，不能拆） */
function liveReuseRef(live: Agent, setup: (agentCtx: Context) => Promise<void>): Promise<AgentHandle & { resumed: boolean }> {
  // 重挂 standard preset：恢复后 agent 上下文重建，平台工具面（read/grep/glob 等）可能缺失；
  // setup 内部已吞错——已挂载则无害，服务缺失则跳过
  return setup(live.ctx).catch(() => {}).then(() => ({ agent: live, dispose: async () => {}, resumed: true }))
}

/**
 * resume-or-create 分派：固定 id → 优先 resume（持久化历史延续），失败降级 create；
 * 随机 id（无固定 sessionId）→ 恒 create。
 *
 * **v1.27.3 修复（微信桥"重启后不响应"根因）：live 会话优先复用**——重启后 DSH 把
 * 关闭时仍 live 的持久化会话恢复为 live。此时 resume 报
 * "cannot prepare session X while it is live"、create 报 "session X already exists"
 * ⇒ 唯一可行路径 = `ctx.agents.get(id)` 取 live agent 直接续用。
 */
async function createOrResumeAgent(
  ctx: Context,
  id: SessionId,
  root: string,
  model: string,
  setup: (agentCtx: Context) => Promise<void>,
  fixedId: boolean,
): Promise<AgentHandle & { resumed: boolean }> {
  if (!fixedId) {
    return {
      ...await ctx.agents.create({
        sessionId: id,
        meta: { cwd: root, agentPreset: SKIFF_PRESET },
        setup,
        ...(model ? { agentOptions: splitModel(model) } : {}),
      }),
      resumed: false,
    }
  }
  const liveAgent = getLiveAgent(ctx, id)
  if (liveAgent) {
    return liveReuseRef(liveAgent, setup)
  }
  // resume 可用性守卫：旧版 dsh / 测试环境无 resume 方法 → 直接 create
  const agentsWithResume = ctx.agents as { resume?: (o: { resumeSessionId: SessionId; setup?: (c: Context) => Promise<void>; agentOptions?: unknown }) => Promise<AgentHandle> }
  if (typeof agentsWithResume.resume !== 'function') {
    return {
      ...await ctx.agents.create({
        sessionId: id,
        meta: { cwd: root, agentPreset: SKIFF_PRESET },
        setup,
        ...(model ? { agentOptions: splitModel(model) } : {}),
      }),
      resumed: false,
    }
  }
  try {
    // 方法调用（this = ctx.agents）——⛔ 不要解构！DSH 的 resume 内部用 `this.ctx`。
    return {
      ...await agentsWithResume.resume({
        resumeSessionId: id,
        setup,
        ...(model ? { agentOptions: splitModel(model) } : {}),
      }),
      resumed: true,
    }
  } catch (err) {
    // 竞态兜底：live 检查与 resume 之间会话可能变 live（多消息并发）→ 复用 live agent
    const liveNow = getLiveAgent(ctx, id)
    if (liveNow) {
      return liveReuseRef(liveNow, setup)
    }
    // v1.27.2 用户拍板：**resume 失败一律降级新建**（透传会让桥静默"不唤醒"）+ 打印堆栈定位
    const msg = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? (err.stack ?? '') : ''
    console.log(`[serenity-hooks] skiff resume 失败降级 create (id=${id}): ${msg}`)
    if (stack) console.log(`[serenity-hooks] skiff resume stack:\n${stack.slice(0, 1200)}`)
    return {
      ...await ctx.agents.create({
        sessionId: id,
        meta: { cwd: root, agentPreset: SKIFF_PRESET },
        setup,
        ...(model ? { agentOptions: splitModel(model) } : {}),
      }),
      resumed: false,
    }
  }
}

/** `provider/model` → agentOptions（由 worker/core 提供，保持单一实现） */
import { splitModel } from '../worker/core.js'

// ── 提问（followup → 等本轮回答）──

interface SkiffAskResult {
  answer: string
  sessionId: string
}

/** 会话事件读取（兼容 `snapshotEvents()` 与测试替身的 `.events`） */
function sessionEvents(session: unknown): readonly unknown[] {
  const s = session as { snapshotEvents?: () => readonly unknown[]; events?: readonly unknown[] }
  if (typeof s.snapshotEvents === 'function') return s.snapshotEvents()
  return s.events ?? []
}

/** 读会话最后一个 assistant/message 文本 */
function lastAssistantText(agent: Agent): string {
  const events = sessionEvents(agent.session)
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as { type?: string; data?: { message?: { content?: unknown }; content?: unknown } } | undefined
    if (e && e.type === 'assistant/message') {
      const blocks = (e.data?.message?.content ?? e.data?.content ?? []) as Array<{ type?: string; text?: string }>
      const text = blocks.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n')
      if (text) return text
    }
  }
  return ''
}

/** 本轮等待上限（毫秒）：超时即判「本轮无产出」——**绝不**把上一轮的旧答案当本轮答案 */
const ASK_TURN_TIMEOUT_MS = 180_000

/** 会话里 `assistant/message` 的条数（判「本轮是否真的产出了回答」） */
function countAssistantMessages(session: unknown): number {
  let n = 0
  for (const e of sessionEvents(session)) {
    if ((e as { type?: string } | undefined)?.type === 'assistant/message') n += 1
  }
  return n
}

/**
 * 等**本轮**产出一条 assistant 消息。
 *
 * ## 为什么不能用 `waitAgentIdle` 单独当判据（2026-10-19 复读缺陷）
 *
 * `waitAgentIdle` 的首行是 `if (agent.status === 'idle') finish()` —— 而 `followup()`
 * 是**异步投递**：刚投出去的这一刻 agent 状态**仍是 idle** ⇒ 等待**立刻结算** ⇒
 * `lastAssistantText()` 读到的是**上一轮的** `assistant/message` ⇒ 桥把它当"本轮答案"转发。
 * 若 CCC 又开了 `fallbackOnNoSend`，同一条旧答案会被反复重发（实测三次间隔 300~400ms、逐字相同）。
 *
 * ## 判据（`idle` 只是"可以开始看"的信号，不是成功信号）
 *
 * ① 期望值 = 调用前 `assistant/message` 的**条数**；
 * ② 成功 ⟺ 该计数**增长**；
 * ③ 超时或有界轮询耗尽 ⇒ `false`（调用方据此给空答案，兜底不触发）。
 */
export async function waitForTurnAssistant(
  ctx: unknown,
  agent: Agent,
  beforeAssistantCount: number,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? ASK_TURN_TIMEOUT_MS
  const grew = (): boolean => countAssistantMessages(agent.session) > beforeAssistantCount
  // ① 先与超时赛跑等一次 idle。**idle = 这一轮结束了**，是"可以结算"的信号。
  // 🔴 必须有界：若这一轮压根没起来（如被白名单全拒、宿主不发 idle），旧实现会永远挂着。
  const idleReached = await Promise.race([
    waitAgentIdle(ctx, agent).then(() => true),
    new Promise<boolean>((resolve) => { setTimeout(() => resolve(false), timeoutMs) }),
  ])
  // ② **idle 一到就结算**（不再空等）：有产出 = 成功；没产出 = 这一轮没答，立刻判失败。
  if (idleReached) return grew()
  // ③ idle 没来（超时）：最后再看一眼计数，避免"产出已落盘但 idle 事件丢了"被误判为失败。
  return grew()
}

/**
 * 提问一轮：followup → 等**本轮**回答 → 读答案。
 *
 * @param options.timeoutMs 本轮等待上限（测试注入；生产用缺省）
 */
export async function askSkiff(
  ctx: Context,
  agent: Agent,
  question: string,
  options?: { timeoutMs?: number },
): Promise<SkiffAskResult> {
  const beforeAssistant = countAssistantMessages(agent.session)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: question }], source: PLUGIN_SOURCE }))
  const produced = await waitForTurnAssistant(ctx, agent, beforeAssistant, { timeoutMs: options?.timeoutMs })
  // 🔴 本轮没产出 ⇒ **空答案**（绝不退回上一轮的旧文本：那正是复读的形态）
  const answer = produced ? lastAssistantText(agent) : ''
  return { answer, sessionId: String((agent.session as { id?: unknown }).id ?? '') }
}

// ── 守门查询（seams / guards 用；全部走 profile.ts 的单一判据）──

/**
 * skiff 会话的轨迹纪律参与判定：**不是 skiff 恒 true**（正常参与）；
 * skiff 按 `skiff.json` 的 `cognitiveTrajectory` 子集决定。
 *
 * 注册表缺失（进程刚重启、绑定还没读）⇒ 由 `skiffProfileForSession` 回落持久绑定；
 * 两者都不中 ⇒ 判"不是 skiff" ⇒ 恒 true（正常参与）。**fail-open 是有意的**：
 * 纪律参与项的失败不该让会话失去 keeper/rebuild（那是能力倒退，比多跑一次更糟）。
 */
export function skiffCognitiveTrajectoryEnabled(
  root: string,
  sessionId: string | undefined,
  key: 'session' | 'keeper' | 'rebuild',
): boolean {
  if (sessionId === undefined) return true
  const profile = skiffProfileFor(root, sessionId)
  if (profile === null) return true
  return profileCognitiveTrajectory(profile)[key]
}

interface SkiffMsmGate {
  /** 拒绝原因（有则拒绝执行） */
  reject?: string
  /** list 显示白名单（msms）；仅 action==='list' 时有值 */
  whitelist?: Set<string>
}

/**
 * `msm` 工具的 skiff 门控：非 skiff 恒放行；skiff 会话——
 * exec 非白名单 MSM 拒绝（**不列名单**）、register/deregister 必拒、
 * list 白名单过滤、check/guide/ccc-config 只读放行。
 */
export function skiffMsmGate(root: string, sessionId: string | undefined, action: string, name?: string): SkiffMsmGate {
  if (sessionId === undefined) return {}
  const profile = skiffProfileFor(root, sessionId)
  if (profile === null) return {}
  if (action === 'register' || action === 'deregister') {
    return { reject: 'register/deregister is not allowed in skiff sessions' }
  }
  if (action === 'exec') {
    if (!name || !profile.msms.includes(name)) return { reject: 'MSM not allowed' }
    return {}
  }
  if (action === 'list') return { whitelist: profileMsmWhitelist(profile) }
  return {} // check / guide / ccc-config：只读放行
}

/** 该 skiff 会话的工具白名单（guards 的 schema 收窄用） */
export function skiffToolWhitelist(root: string, sessionId: string | undefined): Set<string> | null {
  if (sessionId === undefined) return null
  const profile = skiffProfileFor(root, sessionId)
  return profile === null ? null : profileToolWhitelist(profile)
}

/** 按编码解析 skiff（路由/调试页/审计用） */
export function skiffProfileByCode(root: string, code: string): SkiffProfile | null {
  return readSkiffProfileByCode(root, code)
}

/** 编码 → 轨迹目录名（路由用；只做精确匹配） */
export function skiffDirNameByCode(root: string, code: string): string | null {
  return findDirNameByCode(root, code)
}

/** 一次性解析提示词全文（admin/validate 用；热路径不要用） */
export function skiffSystemPrompt(root: string, profile: SkiffProfile | null | undefined): string {
  return resolveProfileSystemPrompt(root, profile)
}
