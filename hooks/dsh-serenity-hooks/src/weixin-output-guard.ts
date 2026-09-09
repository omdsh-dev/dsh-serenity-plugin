/**
 * weixin-output-guard.ts — 手动输出模式的**机械闸门**（v1.30.16，S142 用户"LLM 不听"）
 *
 * 问题（实证）：`weixin.autoReplyWithLastMessage: false` 时桥不回发最终文本，输出权归 agent
 * （必须自己调 `im-bridge` 工具，v1.30.x 为 `msm("weixin-send", …)`）。提示词层面已说明，
 * 但用户实测 **LLM 仍经常不发**——结果用户什么都收不到（静默）。这类"提示词软约束失效"正是 ACC
 * 该用机械守卫兜底的场景（与 output-guard 同一套思路：turn-stopping + agent.steer）。
 *
 * 本模块做三件事（全部是机制，不含任何纪律措辞——措辞归 CCC 角色提示词）：
 *  ① `noteManualOutputSession`：桥每轮把手动模式会话登记进来（含 root/account/user/role）
 *  ② 订阅 `tools/post-execute`：观察本轮是否真的成功调用过输出工具（`im-bridge` 的
 *     `action=send|send-file`，兼容旧 `msm("weixin-send", …)`）——**只在执行成功时**计入
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
/**
 * 本轮是否已成功发送（**由桥在每轮开始时清空** `clearSentThisTurn`；闸门只置位不清空——
 * v1.30.17 起桥要在 `askSkiff` 返回后读它决定是否兜底，故 turn-stopping 不再结算清空）。
 */
const sentThisTurn = new Set<string>()
/** 连续打回计数（成功发送即清零） */
const rebukeCounts = new Map<string, number>()
/** 闸门是否装配成功（v1.30.17：桥据此判断能否信任"未发送"这一判定——未装配时不兜底，防重复发送） */
let guardActive = false

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

/** 本轮是否已成功发送（测试/诊断用；桥在每轮结束时读它决定是否兜底） */
export function hasSentThisTurn(sessionId: string): boolean {
  return sentThisTurn.has(sessionId)
}

/**
 * 桥：**每轮开始时**清空本会话的"已发送"标记（turn 边界由桥掌握——v1.30.17）。
 * 闸门侧不再于 turn-stopping 结算清空，否则桥读不到本轮结果、无法兜底。
 */
export function clearSentThisTurn(sessionId: string): void {
  sentThisTurn.delete(sessionId)
}

/** 闸门是否装配成功（未装配 → 桥不做兜底：宁可静默也不冒重复发送的风险） */
export function isWeixinOutputGuardActive(): boolean {
  return guardActive
}

/** 从 agent / 会话对象取会话 id（形状宽容） */
function sessionIdOf(value: unknown): string | null {
  const v = value as { id?: unknown; session?: { id?: unknown } } | null | undefined
  const id = v?.session?.id ?? v?.id
  return typeof id === 'string' && id !== '' ? id : null
}

/**
 * 工具调用是否为「成功的微信发送」。
 *
 * v1.31.0 起有两种合法形态（标记与闸门同时认，迁移期并存）：
 * - `im-bridge({channel:"weixin", action:"send"|"send-file", …})` —— ACC 工具（推荐）
 * - `msm("weixin-send", ["send"|"send-file", …])` —— CCC MSM（v1.30.x 通道，逐步退役）
 */
export function isSuccessfulWeixinSend(exec: unknown, result: unknown): boolean {
  const e = exec as { name?: unknown; arguments?: unknown } | null | undefined
  const r = result as { isError?: unknown } | null | undefined
  if (r?.isError === true) return false
  const args = e?.arguments as { name?: unknown; action?: unknown; channel?: unknown } | null | undefined
  if (e?.name === 'im-bridge') {
    const channel = typeof args?.channel === 'string' ? args.channel : ''
    if (channel !== 'weixin') return false
    const action = typeof args?.action === 'string' ? args.action : ''
    return action === 'send' || action === 'send-file'
  }
  if (e?.name === 'msm') return args?.name === 'weixin-send'
  return false
}

/** 打回消息（机制事实 + 标记；怎么做由 CCC 角色提示词定义） */
export function buildManualOutputRebuke(session: ManualOutputSession): string {
  return [
    '[serenity:weixin-manual-output] no send detected in this turn — the user has received NOTHING.',
    `ccc=${session.root} account=${session.accountId} user=${session.userId}`,
    `im-bridge({channel:"weixin", action:"send", account:"${session.accountId}", user:"${session.userId}", text:"<回复>"})`,
  ].join('\n')
}

/** 测试辅助：清空全部状态 */
export function __resetWeixinOutputGuardForTest(): void {
  manualSessions.clear()
  sentThisTurn.clear()
  rebukeCounts.clear()
  guardActive = false
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
      // v1.30.17：**不清空**——桥在 askSkiff 返回后读 hasSentThisTurn 决定是否兜底转发
      if (sent) return

      const count = (rebukeCounts.get(sessionId) ?? 0) + 1
      if (count > WEIXIN_OUTPUT_REBUKE_MAX) {
        rebukeCounts.delete(sessionId)
        // 达上限：放弃打回但**响亮告警**（若 CCC 开了 fallbackOnNoSend，桥随后会兜底转发）
        console.warn(
          `[serenity-hooks] ✗ weixin 输出闸门：连续 ${WEIXIN_OUTPUT_REBUKE_MAX} 次打回后仍未发送（session=${sessionId}, role=${session.role}）——本轮用户将收不到 agent 自己发的消息`,
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
    return
  }
  // 两个事件通道都装配成功 → 桥可信任"未发送"判定（v1.30.17 兜底前置条件）
  guardActive = true
}
