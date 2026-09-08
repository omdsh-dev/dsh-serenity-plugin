/**
 * agent-idle.ts — 等待 agent 空闲（含销毁竞速，S142 review F-08）
 *
 * 为什么单独成模块：`askSkiff`（skiff 问答）与 `handyman`（杂工循环）都要"等这一轮做完"，
 * 此前各自复制了一份只监听 `agent/status → idle` 的实现。该实现有一个静默挂死：
 * **agent 先被销毁（会话关闭/进程回收/显式 dispose）就永远不会再发 idle 事件**，
 * 等待方 Promise 永不结算 → 问答/杂工永久卡住（宿主的 disposal 语义：
 * `core/agent-loop/src/agent.ts` 的 wakeDriver 在 disposed 后不再 latch 唤醒）。
 *
 * 结算条件（三者任一，先到先算）：
 *  ① `agent/status` 且 status === 'idle' —— 正常路径（本轮做完）
 *  ② `agent/disposed` 且是同一个 agent —— 销毁竞速（宿主 `runtime-types.ts:175`）
 *  ③ `session/disposed` 且是同一会话 —— 会话先于 agent 消失（宿主 `core/session/src/index.ts:62`）
 *
 * 无超时：agent 工作多久等多久（handyman 可永续）。订阅后再查一次 `agent.status`——
 * 宿主 `followup`/`steer` 会同步把 phase 置为 running（`agent.ts:181-201`），
 * 因此此刻读到 idle 只可能是"唤醒已在订阅前收敛"，立即结算以避免漏事件挂死。
 */

import type { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

/**
 * 等待 agent 空闲或销毁。
 * @param ctx 宿主插件上下文（事件通道来源）
 * @param agent 目标 agent
 * @returns 空闲、agent 销毁、或会话销毁时结算（永不 reject）
 */
export function waitAgentIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const disposers: Array<() => void> = []
    const finish = (): void => {
      if (settled) return
      settled = true
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 退订失败不影响结算（订阅已被宿主回收） */
        }
      }
      resolve()
    }
    const subscribe = (name: string, cb: (payload: unknown) => void): void => {
      try {
        const off = (ctx as unknown as { on?: (n: string, f: (p: unknown) => void) => unknown }).on?.(name, cb)
        if (typeof off === 'function') disposers.push(off as () => void)
      } catch {
        /* 事件通道缺失（旧宿主/测试替身）——其余通道仍可结算 */
      }
    }
    subscribe('agent/status', (payload) => {
      const p = payload as { agent?: unknown; status?: string } | undefined
      if (p?.agent === agent && p?.status === 'idle') finish()
    })
    subscribe('agent/disposed', (payload) => {
      if ((payload as { agent?: unknown } | undefined)?.agent === agent) finish()
    })
    const sessionId = (agent.session as { id?: unknown } | undefined)?.id
    subscribe('session/disposed', (session) => {
      const id = (session as { id?: unknown } | undefined)?.id
      if (typeof id === 'string' && id === sessionId) finish()
    })
    if ((agent as { status?: string }).status === 'idle') finish()
  })
}
