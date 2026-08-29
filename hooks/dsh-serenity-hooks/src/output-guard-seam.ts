/**
 * output-guard-seam.ts — 输出守卫拦截缝（v1.26.3，S142 用户需求）
 *
 * `agent/turn-stopping`（serial）时：取该 turn 最后 assistant 文本 → 敏感词表检测 →
 * 命中 → `agent.steer(buildRebuke(hits))` 打回重生成（turn 不关闭，模型同轮重答）。
 * 连续命中达 REBUKE_MAX_ROUNDS → 放弃打回（防死循环），输出保留 + 审计日志。
 *
 * 作用范围（v1.26.3 用户拍板）：**仅外部面**——skiff/ACP/问答页等对外输出会话
 * （session id `skiff-`/`acp-`/`rebuild-` 前缀；v1.22.4 rebuild 新建会话同面）。
 * **本地维护会话（普通 dsh 会话）不检测**——维护会话必然提及机制词
 * （dsh-serenity-hooks/session_rebuild/mech-registry），打回会瘫痪自身工作。
 */

import type { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import { findSerenityRoot } from './ccc.js'
import { isSkiffSessionId } from './skiff-role.js'
import { buildSensitiveTable, detectSensitive, buildRebuke, rebukeStates, REBUKE_MAX_ROUNDS } from './output-guard.js'

const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'dsh-serenity-hooks' }

/** 外部面会话判定（v1.26.3 用户拍板：仅外部面检测，本地维护会话豁免）：
 *  skiff-（F4 问答）/ acp-（F4c 程序化）/ rebuild-（v1.22.4 重建会话）前缀 */
export function isExternalFaceSession(sessionId: string | undefined): boolean {
  if (!sessionId) return false
  return isSkiffSessionId(sessionId) || sessionId.startsWith('acp-') || sessionId.startsWith('rebuild-')
}

/** 读会话最后一个 assistant/message 文本（skiff-core 同款；仅用于守卫检测，不导出） */
function lastAssistantText(agent: Agent): string {
  const events = (agent.session as { events?: readonly unknown[] }).events ?? []
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

/**
 * 注册输出守卫（index.ts apply 调用）：
 * turn-stopping 时检测最终输出，命中敏感词 → steer 打回重生成（官方机制，零改 DSH）。
 */
export function registerOutputGuardHook(ctx: Context): void {
  ctx.on('agent/turn-stopping', (payload: { agent?: Agent; turn?: number }) => {
    const agent = payload?.agent
    if (!agent) return
    // 作用范围（v1.26.3 用户拍板）：仅外部面（skiff/acp/rebuild 前缀）——
    // 本地维护会话（普通 dsh 会话）豁免：维护会话必然提及机制词，打回会瘫痪自身工作
    const sessionId = String((agent.session as { id?: unknown }).id ?? '')
    if (!isExternalFaceSession(sessionId)) return
    // 激活门控：只在 .serenity 存在的 CCC 目录检测（非 CCC 目录零干预）
    const cwd = (agent.session as { header?: { cwd?: string } }).header?.cwd ?? process.cwd()
    const root = findSerenityRoot(cwd)
    if (!root) return

    const id = agent.id
    const text = lastAssistantText(agent)
    if (!text) return // 无最终输出（工具调用轮等）不检测

    const table = buildSensitiveTable(root)
    const hits = detectSensitive(text, table)
    if (hits.length === 0) {
      rebukeStates.delete(id) // 合规 → 重置连续计数
      return
    }

    const st = rebukeStates.get(id) ?? { consecutive: 0 }
    st.consecutive += 1
    rebukeStates.set(id, st)

    if (st.consecutive > REBUKE_MAX_ROUNDS) {
      // 达上限放弃打回：审计 + 状态清理（输出保留——避免无响应；记录供人工介入）
      rebukeStates.delete(id)
      console.warn(
        `[serenity-hooks] output-guard: giving up after ${REBUKE_MAX_ROUNDS} rebukes (agent=${id}, turn=${payload.turn ?? '?'}) — response kept for manual review`,
      )
      return
    }

    console.log(
      `[serenity-hooks] output-guard: rebuke ${st.consecutive}/${REBUKE_MAX_ROUNDS} (agent=${id}, turn=${payload.turn ?? '?'}, hits=${hits.length})`,
    )
    // 打回：steer 纠正消息 → turn 不关闭 → 模型同轮重生成（DSH 官方机制）
    try {
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: buildRebuke(hits) }],
        source: PLUGIN_SOURCE,
      }))
    } catch (error) {
      console.warn(`[serenity-hooks] output-guard steer failed: ${String((error as Error)?.message ?? error)}`)
    }
  })
}
