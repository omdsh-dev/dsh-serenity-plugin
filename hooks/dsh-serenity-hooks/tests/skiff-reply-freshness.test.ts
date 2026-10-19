/**
 * skiff-reply-freshness.test.ts —— 「本轮答案必须是本轮产出的」回归钉（S142 2026-10-19）
 *
 * ## 缺陷形态（owner 报「微信桥变成复读机」）
 *
 * 实测：同一段文本连发三条，**间隔仅 300~400ms、逐字相同**，`source: reply-fallback`。
 * 模型跑一轮不可能这么快 ⇒ 那不是"回答"，是**旧答案被反复重发**。
 *
 * 根因（`role/skiff/core.ts` 的 `askSkiff`）：`followup()` 是**异步投递** —— 刚投出去的那一刻
 * `agent.status` **仍是 `idle`**，而 `waitAgentIdle` 的首行就是
 * `if (agent.status === 'idle') finish()` ⇒ 等待**立刻结算** ⇒ `lastAssistantText()` 读到的是
 * **上一轮**的 `assistant/message` ⇒ 桥把它当"本轮答案"；CCC 又开着 `fallbackOnNoSend`
 * ⇒ 同一条旧答案被一遍遍重发。
 *
 * ## 判据（三条，互相独立）
 *
 * ① **正控**：本轮真产出 ⇒ 答案就是本轮的（证明"读答案"这条链没被改坏）；
 * ② **负控（缺陷本身）**：本轮**没有任何新产出** ⇒ `answer` 必须是**空串**，
 *    ⛔ 绝不能是上一轮那句。这一条是本次修复的核心 —— 它在旧实现下**必然失败**
 *    （旧实现会把 '上一轮的答案' 原样返回）。
 * ③ 超时有界：本轮不产出时，调用必须**有限时间返回**（不是挂住）。
 */
import { describe, it, expect } from 'vitest'
import { askSkiff } from '../src/role/skiff/core.js'

/** fake ctx：不主动触发 idle（模拟"这一轮压根没起来"） */
const ctxNoIdle = { on: () => () => {} } as never

/** fake ctx：立刻报 idle（正常路径） */
function ctxIdle(agent: unknown): never {
  return {
    on: (_e: string, cb: (p: { agent: unknown; status: string }) => void) => {
      cb({ agent, status: 'idle' })
      return () => {}
    },
  } as never
}

/** 造一个带历史事件的 agent */
function makeAgent(events: unknown[], onFollowup?: () => void): never {
  return {
    session: { id: 'skiff-weixin-test-1', events },
    followup: () => { onFollowup?.() },
  } as never
}

describe('askSkiff：本轮答案必须来自本轮（复读缺陷回归钉）', () => {
  it('① 正控：本轮真产出一条 assistant ⇒ 答案就是本条（不是历史里那条）', async () => {
    const events: unknown[] = [
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '上一轮的答案' }] } } },
    ]
    const agent = makeAgent(events, () => {
      events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '本轮的答案' }] } } })
    })
    // 🔴 2026-10-19：`askSkiff` 的签名已是 `(ctx, agent, question, options?)` ——
    //    旧的第 5 参 `{ includeCognitiveTrajectory }`（连同 `serenity.json` 的 `skiff.roles`
    //    配置面）随 skiff 重做整体退役 ⇒ 继续写旧形只会让 `options` 变 undefined，
    //    落进 180s 的缺省上限 ⇒ 表现为**用例超时**（而不是断言失败，更难定位）。
    const r = await askSkiff(ctxIdle(agent), agent, 'q', { timeoutMs: 2000 })
    expect(r.answer).toBe('本轮的答案')
  })

  it('🔴 ② 负控（本次缺陷本身）：本轮**无产出** ⇒ 答案必须是空串，⛔ 不得重发旧答案', async () => {
    // 旧实现：followup 推不出事件 ⇒ waitAgentIdle 立刻结算 ⇒ lastAssistantText 读到旧答案 ⇒
    // 返回 '上一轮的答案' ⇒ 桥把它转发出去 = 复读。**本用例在旧实现下必红。**
    const events: unknown[] = [
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '上一轮的答案' }] } } },
    ]
    const agent = makeAgent(events) // followup 什么都不推（模拟本轮跑了但没产出/被 guard 全拒）
    const r = await askSkiff(ctxNoIdle, agent, 'q', { timeoutMs: 150 })
    expect(r.answer).toBe('')
  })

  it('③ 有界：本轮不产出时必须在超时内返回（不挂住桥）', async () => {
    const events: unknown[] = []
    const agent = makeAgent(events)
    const t0 = Date.now()
    const r = await askSkiff(ctxNoIdle, agent, 'q', { timeoutMs: 120 })
    expect(r.answer).toBe('')
    expect(Date.now() - t0).toBeLessThan(3000)
  })
})
