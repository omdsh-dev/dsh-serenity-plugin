/**
 * weixin-output-guard.ts — 手动输出模式的**机械闸门**（v1.30.16，S142 用户"LLM 不听"）
 *
 * 问题（实证）：`weixin.autoReplyWithLastMessage: false` 时桥不回发最终文本，输出权归 agent
 * （必须自己调 `msm("weixin-send", …)`）。提示词层面已说明，但用户实测 **LLM 仍经常不发**——
 * 结果用户什么都收不到（静默）。这类"提示词软约束失效"正是 ACC 该用机械守卫兜底的场景
 * （与 output-guard 同一套思路：turn-stopping + agent.steer）。
 *
 * 本模块做三件事（全部是机制，不含任何纪律措辞——措辞归 CCC 角色提示词）：
 *  ① `noteManualOutputSession`：桥每轮把手动模式会话登记进来（含 root/account/user/role）
 *  ② 订阅 `tools/post-execute`：观察本轮是否真的调用了 `msm` 且首个参数为 `weixin-send`
 *     （**只在执行成功时**计入——失败调用不算"已送达"）
 *  ③ 订阅 `agent/turn-stopping`：本轮结束仍没有成功发送 → `agent.steer` 打回一次（≤2 次），
 *     提示内容 = **标记 + 事实**（"本轮未发送，用户什么都没收到"），具体怎么做由 CCC 角色
 *     提示词定义（与 per-message 标记同名 `[serenity:weixin-manual-output]`，模型能对上）。
 *
 * 为什么不直接替 agent 发送（R↓）：用户拍板的语义是"输出权归 agent"——代发会让 agent 误以为
 * 自己发过、也掩盖了"模型没遵守"这一事实；打回让模型自己完成，且留下可观测的日志。
 *
 * 达上限后放弃并**响亮告警**（不静默失败）：宁可让日志里出现一条明确记录，也不要假装正常。
 */

import type { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'

const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'dsh-serenity-hooks' }

/** 打回上限（超过则放弃并告警——避免与模型无限拉扯） */
export const WEIXIN_OUTPUT_REBUKE_MAX = 2

/** 手动模式会话上下文（桥登记） */
export interface ManualOutputSession {
  root: string
  accountId: string
  userId: string
  role: string
}

const manualSessions = new Map<string, ManualOutputSession>()
/** 本轮已成功发送的会话（turn-stopping 时结算并清空） */
const sentThisTurn = new Set<string>()
/** 连续打回计数（成功发送即清零） */
const rebukeCounts = new Map<string, number>()

/** 桥：登记手动模式会话（每轮 incoming 都调用，幂等覆盖） */
export function noteManualOutputSession(sessionId: string, session: ManualOutputSession): void {
  if (typeof sessionId !== 'string' || sessionId === '') return
  manualSessions.set(sessionId, session)
}

/** 桥：非手动模式 / 会话失效 → 注销（闸门随之失效，零干预） */
export function forgetManualOutputSession(sessionId: string): void {
  manualSessions.delete(sessionId)
  sentThisTurn.delete(sessionId)
  rebukeCounts.delete(sessionId)
}

/** 是否手动模式会话（测试/诊断用） */
export function isManualOutputSession(sessionId: string): boolean {
  return manualSessions.has(sessionId)
}

/** 本轮是否已成功发送（测试/诊断用） */
export function hasSentThisTurn(sessionId: string): boolean {
  return sentThisTurn.has(sessionId)
}

/** 从 agent / 会话对象取会话 id（形状宽容） */
function sessionIdOf(value: unknown): string | null {
  const v = value as { id?: unknown; session?: { id?: unknown } } | null | undefined
  const id = v?.session?.id ?? v?.id
  return typeof id === 'string' && id !== '' ? id : null
}

/** 工具调用是否为「成功的 weixin-send」 */
export function isSuccessfulWeixinSend(exec: unknown, result: unknown): boolean {
  const e = exec as { name?: unknown; arguments?: unknown } | null | undefined
  if (e?.name !== 'msm') return false
  const args = e.arguments as { name?: unknown } | null | undefined
  if (args?.name !== 'weixin-send') return false
  const r = result as { isError?: unknown } | null | undefined
  return r?.isError !== true
}

/** 打回消息（机制事实 + 标记；怎么做由 CCC 角色提示词定义） */
export function buildManualOutputRebuke(session: ManualOutputSession): string {
  return [
    '[serenity:weixin-manual-output] no send detected in this turn — the user has received NOTHING.',
    `ccc=${session.root} account=${session.accountId} user=${session.userId}`,
    `msm("weixin-send", ["send", "--ccc", "${session.root}", "--account", "${session.accountId}", "--user", "${session.userId}", "<回复>"])`,
  ].join('\n')
}

/** 测试辅助：清空全部状态 */
export function __resetWeixinOutputGuardForTest(): void {
  manualSessions.clear()
  sentThisTurn.clear()
  rebukeCounts.clear()
}

/**
 * 装配闸门（index.ts apply 调用）。
 * 只对**已登记的手动模式会话**生效——其他会话（主舱/其他 skiff/ACP 临时会话）零干预。
 */
export function registerWeixinOutputGuard(ctx: Context): void {
  // ① 观察工具调用：本轮是否真的发过
  try {
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const downstream = await next()
      try {
        const sessionId = sessionIdOf((exec as { agent?: unknown } | undefined)?.agent)
        if (sessionId && manualSessions.has(sessionId) && isSuccessfulWeixinSend(exec, result)) {
          sentThisTurn.add(sessionId)
          rebukeCounts.delete(sessionId)
        }
      } catch {
        /* 观测失败不影响工具执行 */
      }
      return downstream
    })
  } catch {
    /* 事件通道缺失 → 闸门不可用（退化为纯提示词约束，不阻断装配） */
    console.warn('[serenity-hooks] ✗ weixin 输出闸门未装配：tools/post-execute 不可用')
    return
  }

  // ② turn 结束结算：未发送 → 打回
  try {
    ctx.on('agent/turn-stopping', (payload: { agent?: Agent; turn?: number }) => {
      const agent = payload?.agent
      if (!agent) return
      const sessionId = sessionIdOf(agent)
      if (!sessionId) return
      const session = manualSessions.get(sessionId)
      if (!session) return
      const sent = sentThisTurn.has(sessionId)
      sentThisTurn.delete(sessionId) // 本轮结算（下一轮重新判定）
      if (sent) return

      const count = (rebukeCounts.get(sessionId) ?? 0) + 1
      if (count > WEIXIN_OUTPUT_REBUKE_MAX) {
        rebukeCounts.delete(sessionId)
        // 达上限：放弃打回但**响亮告警**（用户确实什么都收不到——必须可观测）
        console.warn(
          `[serenity-hooks] ✗ weixin 输出闸门：连续 ${WEIXIN_OUTPUT_REBUKE_MAX} 次打回后仍未发送（session=${sessionId}, role=${session.role}）——本轮用户将收不到任何回复`,
        )
        return
      }
      rebukeCounts.set(sessionId, count)
      try {
        agent.steer(createUserMessage({
          content: [{ type: 'text', text: buildManualOutputRebuke(session) }],
          source: PLUGIN_SOURCE,
        }))
        console.log(
          `[serenity-hooks] weixin 输出闸门：打回 ${count}/${WEIXIN_OUTPUT_REBUKE_MAX}（session=${sessionId}, turn=${payload.turn ?? '?'}）`,
        )
      } catch (error) {
        console.warn(`[serenity-hooks] ✗ weixin 输出闸门 steer 失败: ${String((error as Error)?.message ?? error)}`)
      }
    })
  } catch {
    console.warn('[serenity-hooks] ✗ weixin 输出闸门未装配：agent/turn-stopping 不可用')
  }
}
