/**
 * rebuild.ts — 轨迹跟踪器（Trajectory Tracker）超限重建：session_rebuild
 *
 * 概念（S142 用户拍板命名，v1.22.1 语义修正；v1.22.4 定稿语义）：
 *   **SESSION.md = 持久 agent（轨迹）**——身份/决策/进度/未解决问题的本体，
 *   永远留在 AGENT_SESSIONS/ 原位，**不归档、不移动**。
 *   **自身 dsh 会话 = 临时可重建（工作副本）**——上下文超阈值时**完全清空重来**，
 *   身份从 SESSION.md 自动延续。
 *
 * v1.22.4 定稿语义（用户明确：**复用旧会话 + 完全清空重来**，不要新建会话）：
 *   ① rebuild 工具执行时**只排队**（pending map：sessionId → 锚点文本），不立即改 surface
 *   ② `agent/turn-stopping`（turn 结束前 serial 触发）时真正执行：
 *      surface replace 全部节点 → 锚点 user/message（「继续 {SESSION 名} 的工作」）
 *   ③ 同一会话 id 不变 → 同工作区天然满足、无新/旧会话之分、无需销毁/切换/归档
 *
 * 为何不在工具执行时立即 replace（v1.22.2 方案废弃）：
 *   S141 实测崩溃——rebuild 工具在 turn 中途执行 surface replace，把**当前 turn
 *   的 assistant tool-call 节点**也 shadow 掉；工具返回后 agent-loop append
 *   tool/result（sourceEventSeqs 引用被 shadow 的 callSeq），deriveMessages 折叠出
 *   孤儿 tool 消息 → LLM API 报 "Messages with role 'tool' must be a response to
 *   a preceding message with 'tool_calls'"（INVALID_REQUEST）。
 *   **延迟到 turn 结束清空**：届时当前 turn 所有 tool/result 已完整 append，replace
 *   一并 shadow，无孤儿。
 *
 * 触发：LLM 主动调用（keeper 超阈值后提示 [TRAJECTORY]，不自动执行——防误清空）。
 * 门控：仅 CCC 内 + 简单配置 rebuild.enabled。
 */

import type { Context } from 'cordis'
import type { SessionId, Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { join } from 'node:path'
import { findSerenityRoot } from './ccc.js'
import { readSimpleSettings } from './settings-section.js'
import { getActiveSessionInfo } from './session-ops.js'

/**
 * 构建重建锚点消息（v1.22.4 定稿语义）：「继续 {SESSION 名} 的工作」+ 持久轨迹路径。
 * @param root - CCC 根
 * @param sessionName - 当前 use 的宁静号 SESSION 名（如 S142）；无激活则通用指令
 * @param activeMdPath - 持久轨迹 SESSION.md 绝对路径（保持原位）
 */
export function buildRebuildAnchor(
  root: string,
  sessionName: string,
  activeMdPath: string,
): string {
  const rel = activeMdPath.startsWith(root) ? activeMdPath.slice(root.length + 1) : activeMdPath
  const lines = [
    sessionName !== '' ? `继续 ${sessionName} 的工作。` : '继续当前工作。',
    `- 持久轨迹（SESSION.md，未移动）：${rel}`,
    `- 请先读取该 SESSION.md（目标/决策/进度/未解决问题），从上次进度继续。`,
  ]
  return lines.join('\n')
}

export interface RebuildResult {
  /** 是否成功排队（turn 结束时执行清空重建） */
  queued: boolean
  /** 锚点消息文本（将在 turn 结束时注入） */
  anchor: string
  /** 宁静号 SESSION.md（持久轨迹，保持原位） */
  sessionMdPath: string | null
}

// ── pending 队列：sessionId → 待重建锚点（turn-stopping 时消费）──

interface PendingRebuild {
  /** 锚点消息文本 */
  anchor: string
  /** 排队时间（防陈旧队列误清空——超时丢弃） */
  queuedAt: number
}

const pendingRebuilds = new Map<string, PendingRebuild>()
/** 陈旧队列存活时长（毫秒）：超过则丢弃（turn 异常结束/agent 崩溃时防残留误清空） */
const PENDING_TTL_MS = 10 * 60 * 1000

/** 测试/调试：查看 pending 队列内容 */
export function pendingRebuildSnapshot(): ReadonlyMap<string, PendingRebuild> {
  return new Map(pendingRebuilds)
}

/**
 * 排队一次重建（v1.22.4 定稿语义第一步）：
 * ① 门控校验（rebuild.enabled + 会话定位）
 * ② 构建锚点（激活会话名 + 持久轨迹路径）
 * ③ 写入 pending 队列——**不立即改 surface**（等 turn-stopping 执行）
 * @returns 排队结果；rebuild.enabled=false 或非 CCC 抛错
 */
export async function queueRebuild(
  ctx: Context,
  opts: { root: string; note?: string; agentCwd: string; dshSessionId: string },
): Promise<RebuildResult> {
  if (!readSimpleSettings().rebuildEnabled) {
    throw new Error('session_rebuild 已禁用（rebuild.enabled=false，可在 dsh 设置面板开启）')
  }
  const { root, note, dshSessionId } = opts

  // ① 定位 dsh 会话（turn-stopping 时按 agent 匹配；此处先验证存在）
  const session = (ctx.sessions as { get?: (id: SessionId) => Session | undefined } | undefined)
    ?.get?.(dshSessionId as SessionId)
  if (!session) {
    throw new Error(`无法定位 dsh 会话 ${dshSessionId}（会话可能已关闭）`)
  }

  // ② 当前 use 的宁静号 SESSION（持久轨迹路径；scope 与 session 工具 agentScope 一致=裸 id）
  const scope = dshSessionId
  let sessionMdPath: string | null = null
  let sessionName = ''
  try {
    const active = getActiveSessionInfo(scope)
    if (active?.mdPath) {
      sessionMdPath = active.mdPath
      sessionName = active.sessionId ?? ''
    }
  } catch {
    /* 激活信息缺失 → 仅注入通用锚点 */
  }
  const mdPath = sessionMdPath ?? join(root, 'AGENT_SESSIONS', 'SESSION.md')
  const anchor = buildRebuildAnchor(root, sessionName, mdPath)

  // ③ 排队（覆盖同会话旧队列）
  pendingRebuilds.set(dshSessionId, { anchor, queuedAt: Date.now() })
  void note
  return { queued: true, anchor, sessionMdPath }
}

/**
 * 执行真正的 surface replace（v1.22.4 定稿语义第二步，turn-stopping 时调用）：
 * 当前 turn 已完整结束（所有 tool/result 已 append）→ 全部节点替换为锚点消息。
 * 同一会话 id 原地重建——同工作区天然满足，无新/旧会话之分。
 * @returns 是否执行了 replace（false = 无 pending 或 surface 空）
 */
export function performRebuild(session: Session, pending: PendingRebuild): boolean {
  const nodes = [...session.surface.nodes]
  if (nodes.length === 0) return false
  session.append('user/message', {
    content: [{ type: 'text', text: pending.anchor }],
    // source 必填（UserMessage 契约）——缺失会使 session.list sessionListMetadata 抛 TypeError
    source: { kind: 'user' },
  } as never, {
    surfaceOp: { op: 'replace', start: nodes[0]!, end: nodes[nodes.length - 1]! },
    sourceEventSeqs: nodes,
  } as never)
  return true
}

/**
 * 注册 turn-stopping 钩子（index.ts apply 调用）：
 * agent 每轮 turn 结束前（serial）检查 pending 队列——有该会话的重建请求 → 执行清空。
 * 陈旧队列（超 TTL）丢弃防误清空；无 pending 零开销。
 */
export function registerRebuildTurnHook(ctx: Context): void {
  ctx.on('agent/turn-stopping', (payload: { agent?: Agent; turn?: number }) => {
    const agent = payload?.agent
    if (!agent) return
    const id = agent.id
    const pending = pendingRebuilds.get(id)
    if (pending === undefined) return
    // 陈旧队列丢弃（turn 异常结束/agent 崩溃后残留不应误清空）
    if (Date.now() - pending.queuedAt > PENDING_TTL_MS) {
      pendingRebuilds.delete(id)
      return
    }
    pendingRebuilds.delete(id)
    try {
      performRebuild(agent.session, pending)
      console.log(`[serenity-hooks] session_rebuild 已执行（turn ${payload.turn ?? '?'} 结束）：${id}`)
    } catch (error) {
      console.warn(`[serenity-hooks] session_rebuild 执行失败: ${String((error as Error)?.message ?? error)}`)
    }
  })
}
