/**
 * loop.ts — 拦截缝：回合生命周期（agent/turn-stopping 机械落盘）
 *
 * 每个自然停止边界：若 agent 工作目录在 CCC 内且其 dsh 会话有活跃会话
 * 标记（.dsh/active-sessions/<scope>，内容为相对 CCC 根的 SESSION.md 路径），
 * 自动追加心跳行——会话进度不再依赖模型自觉。
 * scope = 当前 dsh 会话 id（agent.session.id），多会话互不串写。
 */

import type { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { findSerenityRoot } from '../ccc.js'
import { appendHeartbeat, readActiveSessionMd, DEFAULT_SESSION_SCOPE } from '../session-ops.js'

/** 解析当前 dsh 会话 scope 的活跃会话 SESSION.md 绝对路径；无标记/越界返回 null */
export function resolveActiveSession(root: string, scope: string = DEFAULT_SESSION_SCOPE): string | null {
  return readActiveSessionMd(root, scope)
}

/** 注册 agent/turn-stopping：CCC 内活动会话自动心跳落盘（按 dsh 会话隔离） */
export function registerTurnFlush(ctx: Context): void {
  ctx.on('agent/turn-stopping', async (payload: { agent: Agent }) => {
    const agent = payload.agent
    const cwd = (agent.session as { header?: { cwd?: string } } | undefined)?.header?.cwd ?? process.cwd()
    const root = findSerenityRoot(cwd)
    if (!root) return
    const scope = (agent.session as { id?: string } | undefined)?.id ?? DEFAULT_SESSION_SCOPE
    const sessionMd = resolveActiveSession(root, scope)
    if (sessionMd) appendHeartbeat(sessionMd)
  })
}
