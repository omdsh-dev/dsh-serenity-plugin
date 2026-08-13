/**
 * loop.ts — 拦截缝：回合生命周期（agent/turn-stopping 机械落盘）
 *
 * 每个自然停止边界：若 agent 工作目录在 CCC 内且存在 `.dsh/active-session`
 * 标记（内容为相对 CCC 根的 SESSION.md 路径），自动追加心跳行——
 * 会话进度不再依赖模型自觉。
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { findSerenityRoot } from '../ccc.js'
import { appendHeartbeat } from '../session-ops.js'

/** 解析活动会话 SESSION.md 绝对路径；无标记/越界返回 null */
export function resolveActiveSession(root: string): string | null {
  const marker = resolve(root, '.dsh', 'active-session')
  if (!existsSync(marker)) return null
  const rel = readFileSync(marker, 'utf-8').trim()
  if (!rel) return null
  const abs = resolve(root, rel)
  if (!abs.startsWith(resolve(root))) return null
  return abs
}

/** 注册 agent/turn-stopping：CCC 内活动会话自动心跳落盘 */
export function registerTurnFlush(ctx: Context): void {
  ctx.on('agent/turn-stopping', async (payload: { agent: Agent }) => {
    const agent = payload.agent
    const cwd = (agent.session as { header?: { cwd?: string } } | undefined)?.header?.cwd ?? process.cwd()
    const root = findSerenityRoot(cwd)
    if (!root) return
    const sessionMd = resolveActiveSession(root)
    if (sessionMd) appendHeartbeat(sessionMd)
  })
}
