/**
 * rebuild.ts — 轨迹跟踪器（Trajectory Tracker）超限重建：session_rebuild
 *
 * 概念（S142 用户拍板命名，v1.22.1 语义修正）：
 *   **SESSION.md = 持久 agent（轨迹）**——身份/决策/进度/未解决问题的本体，
 *   永远留在 AGENT_SESSIONS/ 原位，**不归档、不移动**。
 *   **自身 dsh 会话 = 临时可重建（工作副本）**——上下文超阈值时清空重建，
 *   归档丢掉的是 dsh 会话的对话历史（surface replace），身份从 SESSION.md 自动延续。
 *
 * 执行链（v1.22.1 修正为原地重建，不再归档 SESSION/创建新会话）：
 *   ① 取当前 dsh 会话的 surface 全部节点（模型可见顺序）
 *   ② `session.append('user/message', anchor, {
 *        surfaceOp: { op:'replace', start: nodes[0], end: nodes[last] },
 *        sourceEventSeqs: [...nodes],   // 覆盖全部被 shadow 节点（surface 硬校验）
 *      })`——同一会话 id 原地替换整个 surface 为锚点消息（Ship of Theseus：
 *      会话副本重建，轨迹不变）
 *   ③ 锚点消息 = 当前激活的宁静号 SESSION.md 路径 + 摘要 + 重建指令
 *     （完整身份由 first-anchor + systemPrompt.section 自动恢复）
 *
 * 触发：LLM 主动调用（keeper 超阈值后提示 [TRAJECTORY]，不自动执行——防误清空）。
 * 门控：仅 CCC 内 + 简单配置 rebuild.enabled。
 */

import type { Context } from 'cordis'
import type { SessionId, Session } from '@deepseek-ai/dsh-session'
import { join } from 'node:path'
import { findSerenityRoot } from './ccc.js'
import { readSimpleSettings } from './settings-section.js'
import { getActiveSessionInfo } from './session-ops.js'

/**
 * 构建重建锚点消息（轨迹跟踪器语义）：SESSION.md 路径 + 摘要 + 重建指令。
 * @param root - CCC 根
 * @param activeMdPath - 当前激活的宁静号 SESSION.md 绝对路径（持久轨迹本体）
 * @param note - 可选重建背景
 */
export function buildRebuildAnchor(root: string, activeMdPath: string, note: string | undefined): string {
  const rel = activeMdPath.startsWith(root) ? activeMdPath.slice(root.length + 1) : activeMdPath
  const lines = [
    '[TRAJECTORY-REBUILD] 工作副本已清空重建（Ship of Theseus：会话历史归档，轨迹延续）。',
    `- 持久轨迹（SESSION.md，未移动）：${rel}`,
    `- 请先读取该 SESSION.md（目标/决策/进度/未解决问题），从上次进度继续。`,
  ]
  if (note) lines.push(`- 重建背景：${note}`)
  return lines.join('\n')
}

export interface RebuildResult {
  /** 是否成功原地重建（surface replace） */
  rebuilt: boolean
  /** 重建前 surface 节点数（被替换的对话历史长度） */
  replacedNodes: number
  /** 锚点消息文本 */
  anchor: string
  /** 宁静号 SESSION.md（持久轨迹，保持原位） */
  sessionMdPath: string | null
}

/**
 * 执行 session_rebuild（v1.22.1 原地重建语义）：
 * ① 定位当前 dsh 会话（执行工具的 agent 会话）——**同一会话 id 原地重建**
 * ② 取 surface 全部节点 → append user/message 锚点（surfaceOp replace 覆盖全部节点）
 * ③ SESSION.md 保持原位不动（持久轨迹）
 * @returns rebuild 结果；rebuild.enabled=false 或非 CCC 抛错
 */
export async function executeRebuild(
  ctx: Context,
  opts: { root: string; note?: string; agentCwd: string; dshSessionId: string },
): Promise<RebuildResult> {
  if (!readSimpleSettings().rebuildEnabled) {
    throw new Error('session_rebuild 已禁用（rebuild.enabled=false，可在 dsh 设置面板开启）')
  }
  const { root, note, dshSessionId } = opts

  // ① 定位 dsh 会话（ctx.sessions.get；同 id 原地重建）
  const session = (ctx.sessions as { get?: (id: SessionId) => Session | undefined } | undefined)
    ?.get?.(dshSessionId as SessionId)
  if (!session) {
    throw new Error(`无法定位 dsh 会话 ${dshSessionId}（会话可能已关闭）`)
  }

  // ② 取 surface 全部节点（模型可见顺序；空 surface = 无历史可清）
  const nodes = [...session.surface.nodes]
  if (nodes.length === 0) {
    throw new Error('会话 surface 为空（无对话历史可清空重建）')
  }

  // ③ 当前激活的宁静号 SESSION.md（持久轨迹路径；无激活会话则跳过路径引用）
  const scope = `session:${dshSessionId}`
  let sessionMdPath: string | null = null
  try {
    const active = getActiveSessionInfo(scope)
    if (active?.mdPath) sessionMdPath = active.mdPath
  } catch {
    /* 激活信息缺失 → 仅注入通用锚点 */
  }
  const anchorText = buildRebuildAnchor(
    root,
    sessionMdPath ?? join(root, 'AGENT_SESSIONS', 'SESSION.md'),
    note,
  )

  // ④ 原地替换：surfaceOp replace 覆盖全部 surface 节点（sourceEventSeqs 硬校验要求全覆盖）
  session.append('user/message', {
    content: [{ type: 'text', text: anchorText }],
  } as never, {
    surfaceOp: { op: 'replace', start: nodes[0]!, end: nodes[nodes.length - 1]! },
    sourceEventSeqs: nodes,
  } as never)

  return {
    rebuilt: true,
    replacedNodes: nodes.length,
    anchor: anchorText,
    sessionMdPath,
  }
}
