/**
 * skiff-core.ts — Skiff 会话核心（F4，v1.25.0 实验性）
 *
 * Skiff agent = 标准 DSH agent（ctx.agents.create，跑 DSH agent-loop）：
 * 一次提问（followup）→ 模型自主循环调用工具直到 turn 结束（idle）→
 * 读 session.events 取 committed 答案 + 完整轨迹（与 dsh WebUI 同源数据）。
 *
 * 实验性质：仅当 Skiff 调试服务开启（设置面板人工开关）且 CCC 配置了角色时才创建
 * agent；未启用时本模块零副作用（无监听、无 agent、无会话注册）。
 */

import type { Context } from 'cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import { SKIFF_SESSION_PREFIX, isSkiffSessionId, readSkiffRoles, trajectorySubset, roleMsmWhitelist, buildSkiffBasePrompt, resolveRoleSystemPrompt, type SkiffRoleConfig } from './skiff-role.js'
import { splitModel } from './handyman-ops.js'
import { skiffRoleFor as registryRoleFor, skiffSessionInfo as registrySessionInfo, registerSkiffSession as registryRegister, unregisterSkiffSession as registryUnregister, skiffSessionSnapshot as registrySnapshot } from './skiff-registry.js'

const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'dsh-serenity-hooks' }

// ── 会话注册表（sessionId → role + agent；ACP/调试页会话映射，页面/连接关闭时清理）──
// 角色名 + CCC 根存 skiff-registry（零依赖，guards 等 seams 可安全查询；v1.25.10 起
// 值含 ccc——追问延续时校验 (role, ccc) 绑定）；agent 句柄存本模块

const skiffAgents = new Map<string, Agent>()

/** 查 sessionId 的 Skiff 角色名（无 → null） */
export function skiffRoleFor(sessionId: string): string | null {
  return registryRoleFor(sessionId)
}

/** 查 sessionId 的会话绑定（role + ccc；无 → null）——v1.25.10 追问校验 */
export function skiffSessionInfo(sessionId: string): { role: string; ccc: string } | null {
  return registrySessionInfo(sessionId)
}

/** 查 sessionId 的活体 agent（进程内会话延续用；未注册/已清理 → undefined） */
export function getSkiffAgent(sessionId: string): Agent | undefined {
  return skiffAgents.get(sessionId)
}

export function registerSkiffSession(sessionId: string, role: string, ccc: string, agent: Agent): void {
  skiffAgents.set(sessionId, agent)
  registryRegister(sessionId, role, ccc)
}

export function unregisterSkiffSession(sessionId: string): void {
  skiffAgents.delete(sessionId)
  registryUnregister(sessionId)
}

/** 测试/调试：注册表快照（sessionId → {role} 兼容展示） */
export function skiffSessionSnapshot(): ReadonlyMap<string, { role: string; ccc: string }> {
  const out = new Map<string, { role: string; ccc: string }>()
  for (const [id, b] of registrySnapshot()) out.set(id, { role: b.role, ccc: b.ccc })
  return out
}

// ── agent 生命周期 ──

export interface SkiffAgentRef {
  handle: AgentHandle
  agent: Agent
  sessionId: string
  /** true = 从持久化恢复既有会话（历史延续，非新对话）；false = 新建（首次/无持久化） */
  resumed: boolean
}

/**
 * resume 失败是否应降级 create：仅当会话无持久化 log（首次）或持久化未配置时。
 * 其他错误（损坏/版本不符/live 占用）→ 透传（真问题不掩盖）。
 */
function isResumeFallbackError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err.name === 'SessionPersistenceNotFoundError') return true
  if (/session persistence is not configured/.test(err.message)) return true
  return false
}

/** Skiff agent 挂载的 DSH preset（v1.25.3 修复：read/grep/glob 等平台工具由 preset 决定工具面；
 *  handyman 经 composeFrom 继承父、skiff 无父上下文——直接挂 DSH 默认 standard preset；
 *  guard 角色白名单再按角色过滤可见/可用面——白名单外工具仍 deny） */
const SKIFF_PRESET = 'standard'

/**
 * 创建 Skiff agent：标准 DSH agent + cwd=CCC root + 角色模型 +
 * standard preset（平台工具面）+ scoped 系统提示词（基础提示词 + CCC 定义段，全替换 ACC 默认注入）。
 *
 * **固定 sessionId 的 resume-or-create（v1.27.2，微信桥 id collision 修复）**：
 * 指定 sessionId 且磁盘已有持久化 log → `ctx.agents.resume`（DSH 持久化语义：
 * sessionId 即身份，已持久化会话必须 resume——历史 + turn 续号延续，同用户长期记忆保留）；
 * 无 log（首次）/持久化未配置 → `ctx.agents.create`（新建）。不指定 sessionId →
 * 随机 id 恒 create（ACP/调试页默认路径）。
 *
 * @param sessionId 指定会话 id（可选；微信桥等外部面用固定 id 实现用户↔会话长期映射——
 *   不传则随机生成 skiff-<role>-<uuid>，ACP/调试页默认路径）
 */
export async function createSkiffAgent(
  ctx: Context,
  root: string,
  roleName: string,
  role: SkiffRoleConfig,
  defaultModel?: string,
  sessionId?: string,
): Promise<SkiffAgentRef> {
  if (!ctx.agents) throw new Error('skiff: ctx.agents unavailable')
  const model = role.model?.trim() || defaultModel || ''
  const id = (sessionId ?? `${SKIFF_SESSION_PREFIX}${roleName}-${randomUUID()}`) as SessionId
  const setup = async (agentCtx: Context) => {
    try {
      // 挂载 standard preset → agent 工具面含 read/grep/glob/web_search 等平台工具；
      // agentPresets 可选服务缺失（未装配）→ 跳过（回退全局工具层，不阻断创建）
      const presets = agentCtx.get('agentPresets') as { mount?: (c: Context, id: string) => Promise<unknown> } | undefined
      await presets?.mount?.(agentCtx, SKIFF_PRESET)
    } catch {
      /* preset 挂载失败不影响 agent 创建（guard 白名单仍兜底约束） */
    }
  }
  const handle = await createOrResumeAgent(ctx, id, root, model, setup, sessionId !== undefined)
  const agent = handle.agent
  // scoped 系统提示词：基础段（动态白名单清单）+ CCC 完整定义段
  // v1.25.10：CCC 段经 resolveRoleSystemPrompt——systemPromptFile 优先（md 文件，推荐），
  // 文件缺失/逃逸 → catch 降级（console.warn + 仅基础段），不阻断 agent 创建
  let cccPrompt = ''
  try {
    cccPrompt = resolveRoleSystemPrompt(root, role)
  } catch (err) {
    console.warn(`[serenity-hooks] skiff 角色 "${roleName}" 系统提示词解析失败（回退仅基础段）: ${String((err as Error)?.message ?? err)}`)
  }
  try {
    agent.ctx.systemPrompt.section({
      name: 'serenity-skiff',
      order: -60,
      text: () => [buildSkiffBasePrompt(roleName, role), cccPrompt].filter(Boolean).join('\n'),
    })
  } catch (err) {
    console.warn(`[serenity-hooks] skiff 系统提示词注册失败: ${String((err as Error)?.message ?? err)}`)
  }
  registerSkiffSession(id, roleName, root, agent)
  return { handle, agent, sessionId: id, resumed: handle.resumed }
}

/** 取 live agent（DSH 文档：`ctx.agents.get(id)` 返回 bare Agent；会话 live 时 resume/create 均不可用） */
function getLiveAgent(ctx: Context, id: string): Agent | undefined {
  try {
    return (ctx as unknown as { agents?: { get?: (id: string) => Agent | undefined } }).agents?.get?.(id)
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
 * 随机 id（无固定 sessionId）→ 恒 create。返回 handle + resumed 标志。
 *
 * **v1.27.3 修复（微信桥"重启后不响应"根因）：live 会话优先复用**——重启后 DSH 把
 * 关闭时仍 live 的持久化会话恢复为 live（crash/restart 恢复语义）。此时 resume 报
 * "cannot prepare session X while it is live"（session-persistence coordinator 显式
 * 拒绝 live 会话）、create 报 "session X already exists"（磁盘有持久化 log 必拒）→
 * 微信桥 catch 吞错 → 用户消息无回复。唯一可行路径 = `ctx.agents.get(id)` 取 live
 * agent 直接续用（resumed:true；角色提示词重挂与内存注册表登记由 createSkiffAgent 统一做）。
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
  // live 会话优先复用（见函数头注释——v1.27.3 修复）
  const liveAgent = getLiveAgent(ctx, id)
  if (liveAgent) {
    return liveReuseRef(liveAgent, setup)
  }
  // resume 可用性守卫：旧版 dsh / 测试环境无 resume 方法 → 直接 create（原 v1.27.0 行为）。
  // **v1.27.2 this 绑定修复**：不得解构 `ctx.agents.resume` 到局部变量再裸调用——
  // DSH 的 resume 内部用 `this.ctx`（AgentRegistry），解构后 this 丢失 →
  // "Cannot read properties of undefined (reading 'ctx')"（v1.23.2 同病第三次）。
  // 通过类型断言访问 `ctx.agents.resume` 并**直接以方法调用形式执行**（this 保持绑定）。
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
    // 方法调用（this = ctx.agents）——不要解构！
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
    // v1.27.2 用户拍板：**resume 失败一律降级新建**（不再透传——透传会让微信桥静默"不唤醒"）+ 打印堆栈定位
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

// ── 提问（followup → idle → 答案 + 轨迹）──

export interface SkiffTrajectoryEntry {
  role: 'user' | 'assistant' | 'tool'
  text: string
  /** assistant 的工具调用名（有则填） */
  tool?: string
}

export interface SkiffAskResult {
  answer: string
  sessionId: string
  trajectory: SkiffTrajectoryEntry[]
}

/** 等待 agent 空闲（agent/status → idle）；无超时（agent 工作多久等多久，handyman 同款） */
function waitIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    // dispose 先声明后赋值：ctx.on 可能同步触发回调（测试 fake），TDZ 会导致 finish 访问未初始化
    let dispose: () => void = () => {}
    const finish = (): void => {
      if (settled) return
      settled = true
      dispose()
      resolve()
    }
    dispose = ctx.on('agent/status', (payload: { agent: Agent; status: string }) => {
      if (payload.agent === agent && payload.status === 'idle') finish()
    })
  })
}

/** 读会话最后一个 assistant/message 文本（handyman 同款） */
function lastAssistantText(agent: Agent): string {
  const events = agent.session.events
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

/** events → 可读轨迹（user/assistant 文本 + 工具调用 + 工具结果；单条解析失败跳过） */
function eventsToTrajectory(events: readonly unknown[]): SkiffTrajectoryEntry[] {
  const out: SkiffTrajectoryEntry[] = []
  for (const raw of events) {
    try {
      const ev = raw as { type?: string; data?: Record<string, unknown> }
      if (ev.type === 'user/message') {
        const text = extractText(ev.data)
        if (text) out.push({ role: 'user', text })
      } else if (ev.type === 'assistant/message') {
        const d = ev.data as { message?: Record<string, unknown>; content?: unknown } | undefined
        const blocks = (d?.message?.content ?? d?.content ?? []) as Array<{ type?: string; text?: string }>
        const text = blocks.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n')
        const calls = (d?.message?.tool_calls ?? []) as Array<{ name?: string; arguments?: unknown }> | undefined
        if (text) out.push({ role: 'assistant', text })
        for (const c of calls ?? []) {
          const args = typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {})
          out.push({ role: 'assistant', text: `→ ${c.name ?? '(tool)'} ${truncate(args, 300)}`, tool: c.name })
        }
      } else if (ev.type === 'tool/result') {
        const outText = extractText(ev.data)
        if (outText) out.push({ role: 'tool', text: truncate(outText, 500), tool: String(ev.data?.name ?? '') })
      }
    } catch {
      /* 单条事件解析失败跳过（轨迹尽力而为，不影响答案） */
    }
  }
  return out
}

function extractText(data: Record<string, unknown> | undefined): string {
  const content = data?.content as Array<{ type?: string; text?: string }> | undefined
  if (!Array.isArray(content)) return ''
  return content.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n')
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

/**
 * 提问一轮：followup → 等 idle → 读答案 + 轨迹。
 * @param eventsStart 轨迹起点：显式传 0 = 全量轨迹（会话追问时页面重绘完整时间线，
 *   v1.25.10 用户拍板）；不传（undefined）= 本轮增量（followup 前 events 之后）
 * @param options.includeTrajectory 是否计算轨迹（v1.26.10：**3100 对外只提供问答**——
 *   公开问答页 / ACP JSON-RPC 不返回 trajectory，传 false 跳过计算；3099 调试页默认 true 保留）
 */
export async function askSkiff(
  ctx: Context,
  agent: Agent,
  question: string,
  eventsStart?: number,
  options?: { includeTrajectory?: boolean },
): Promise<SkiffAskResult> {
  const before = eventsStart === undefined ? agent.session.events.length : eventsStart
  agent.followup(createUserMessage({ content: [{ type: 'text', text: question }], source: PLUGIN_SOURCE }))
  await waitIdle(ctx, agent)
  const answer = lastAssistantText(agent)
  const trajectory =
    options?.includeTrajectory === false ? [] : eventsToTrajectory(agent.session.events.slice(before))
  return { answer, sessionId: String((agent.session as { id?: unknown }).id ?? ''), trajectory }
}

// ── 轨迹纪律子集参与判定（seams 旁路用，F4b）──

/**
 * Skiff 会话的轨迹纪律参与判定：非 skiff 会话恒 true（正常参与）；
 * skiff 会话按角色 trajectory 子集（session/keeper/rebuild）决定；
 * 注册表缺失（进程重启遗留等）→ 保守旁路（false，完全独立）。
 */
export function skiffTrajectoryEnabled(
  root: string,
  sessionId: string | undefined,
  key: 'session' | 'keeper' | 'rebuild',
): boolean {
  if (!isSkiffSessionId(sessionId)) return true
  const roleName = sessionId ? skiffRoleFor(sessionId) : null
  if (!roleName) return false
  const role = readSkiffRoles(root).get(roleName)
  return trajectorySubset(role)[key]
}

// ── acc_msm 白名单门控（F4b ⑨）──

export interface SkiffMsmGate {
  /** 拒绝原因（有则拒绝执行） */
  reject?: string
  /** list 显示白名单（msms）；仅 action==='list' 时有值 */
  whitelist?: Set<string>
}

/**
 * acc_msm 的 Skiff 门控：非 skiff 会话恒放行；skiff 会话——
 * exec 非白名单 MSM 拒绝（不列名单）、register/deregister 必拒、
 * list 白名单过滤、check/guide/ccc-config 只读放行。
 */
export function skiffMsmGate(root: string, sessionId: string | undefined, action: string, name?: string): SkiffMsmGate {
  if (!isSkiffSessionId(sessionId)) return {}
  const roleName = sessionId ? skiffRoleFor(sessionId) : null
  const role = roleName ? readSkiffRoles(root).get(roleName) : undefined
  if (!roleName || !role) return { reject: 'MSM not allowed in this skiff session' }
  if (action === 'register' || action === 'deregister') {
    return { reject: 'register/deregister is not allowed in skiff sessions' }
  }
  if (action === 'exec') {
    if (!name || !(role.msms ?? []).includes(name)) return { reject: 'MSM not allowed' }
    return {}
  }
  if (action === 'list') return { whitelist: roleMsmWhitelist(role) }
  return {} // check / guide / ccc-config：只读放行
}
