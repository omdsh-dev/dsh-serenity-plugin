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
import { SKIFF_SESSION_PREFIX, buildSkiffBasePrompt, type SkiffRoleConfig } from './skiff-role.js'
import { splitModel } from './handyman-ops.js'

const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'dsh-serenity-hooks' }

// ── 会话注册表（sessionId → 角色；ACP/调试页会话映射，页面/连接关闭时清理）──

const skiffSessions = new Map<string, { role: string; agent: Agent }>()

/** 查 sessionId 的 Skiff 角色名（无 → null） */
export function skiffRoleFor(sessionId: string): string | null {
  return skiffSessions.get(sessionId)?.role ?? null
}

export function registerSkiffSession(sessionId: string, role: string, agent: Agent): void {
  skiffSessions.set(sessionId, { role, agent })
}

export function unregisterSkiffSession(sessionId: string): void {
  skiffSessions.delete(sessionId)
}

/** 测试/调试：注册表快照 */
export function skiffSessionSnapshot(): ReadonlyMap<string, { role: string }> {
  return new Map([...skiffSessions].map(([id, v]) => [id, { role: v.role }]))
}

// ── agent 生命周期 ──

export interface SkiffAgentRef {
  handle: AgentHandle
  agent: Agent
  sessionId: string
}

/**
 * 创建 Skiff agent：标准 DSH agent + cwd=CCC root + 角色模型 +
 * scoped 系统提示词（基础提示词 + CCC 定义段，全替换 ACC 默认注入）。
 */
export async function createSkiffAgent(
  ctx: Context,
  root: string,
  roleName: string,
  role: SkiffRoleConfig,
  defaultModel?: string,
): Promise<SkiffAgentRef> {
  if (!ctx.agents) throw new Error('skiff: ctx.agents unavailable')
  const model = role.model?.trim() || defaultModel || ''
  const sessionId = `${SKIFF_SESSION_PREFIX}${roleName}-${randomUUID()}` as SessionId
  const handle = await ctx.agents.create({
    sessionId,
    meta: { cwd: root },
    ...(model ? { agentOptions: splitModel(model) } : {}),
  })
  const agent = handle.agent
  // scoped 系统提示词：基础段（动态白名单清单）+ CCC 完整定义段
  try {
    agent.ctx.systemPrompt.section({
      name: 'serenity-skiff',
      order: -60,
      text: () => [buildSkiffBasePrompt(roleName, role), role.systemPrompt ?? ''].filter(Boolean).join('\n'),
    })
  } catch (err) {
    console.warn(`[serenity-hooks] skiff 系统提示词注册失败: ${String((err as Error)?.message ?? err)}`)
  }
  registerSkiffSession(sessionId, roleName, agent)
  return { handle, agent, sessionId }
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
    const finish = (): void => {
      if (settled) return
      settled = true
      dispose()
      resolve()
    }
    const dispose = ctx.on('agent/status', (payload: { agent: Agent; status: string }) => {
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
 * 提问一轮：followup → 等 idle → 读答案 + 本 turn 轨迹（增量 = followup 前 events 之后）。
 * @param eventsStart 本轮开始前的 events 长度（0 = 全量轨迹）
 */
export async function askSkiff(ctx: Context, agent: Agent, question: string, eventsStart = 0): Promise<SkiffAskResult> {
  const before = eventsStart > 0 ? eventsStart : agent.session.events.length
  agent.followup(createUserMessage({ content: [{ type: 'text', text: question }], source: PLUGIN_SOURCE }))
  await waitIdle(ctx, agent)
  const answer = lastAssistantText(agent)
  const trajectory = eventsToTrajectory(agent.session.events.slice(before))
  return { answer, sessionId: String((agent.session as { id?: unknown }).id ?? ''), trajectory }
}
