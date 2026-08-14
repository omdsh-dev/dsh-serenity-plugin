/**
 * compact.ts — 拦截缝：压缩保留（P2，osp session.compacting 的 DSH 等价）
 *
 * 问题：ACC 身份消息（[ACC] 注入）是早期注入的历史消息；上下文压缩（compaction-basic）
 * 会把它们折叠进摘要，模型上下文丢失 ACC 身份 → 后续行为偏离 CCC 约束。
 *
 * 方案：监听 `compaction/end`（成功，无 error）→ 对 agent 重新注入 ACC 身份消息
 * （agent.inject，追加到下一个模型请求）。与 context.ts 的注入共用同一文本构建，
 * 但**不重复计数**（压缩后的重注入是恢复性注入，不依赖 injected Set）。
 *
 * session → agent 关联：session.id 即 agent id（goal-session 用 ctx.agents.get(session.id)）。
 *
 * 时机依据（DSH 公开版 compaction 类型，事件名 compact/* → compaction/*）：
 * - `compaction/start`: { compactionId, sourceCommandId?, turn: number | null } — 压缩开始（log-only，持锁）
 * - `compaction/summary`: { compactionId, summary, ... } — 摘要完成（log-only）
 * - `compaction/end`: { compactionId, sourceCommandId?, turn, error? } — 压缩结束，error 记录失败
 * 成功判定：compaction/end 无 error。
 */

import type { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
// 类型扩展：拉入 @deepseek-ai/dsh-compaction 对 SessionEventMap 的 declare module 合并
// （compact/start | compact/summary | compact/end 事件类型；公开版由 dsh-compact 改名而来）
import type {} from '@deepseek-ai/dsh-compaction'
import { findSerenityRoot, DEFAULT_SERENITY_CONFIG_PATHS } from '../ccc.js'
// 复用 context.ts 的完整 ACC 注入消息（简短头 + ACC 5 块 + CCC 顶层 skill 原文）
import { accMessage } from './context.js'

export interface CompactRegistration {
  /** CCC 配置相对路径；缺省用 DEFAULT_SERENITY_CONFIG_PATHS */
  configPaths?: string[]
  /** 入口 skill 内容注入上限（与 context.ts 对齐） */
  entrySkillMaxChars?: number
}

/**
 * 注册压缩保留：compact/end（成功）后重注入 ACC 身份。
 * 仅当 agent 工作目录在 CCC 内时生效（激活门控）。
 */
export function registerCompactRetention(ctx: Context, opts: CompactRegistration = {}): void {
  const configPaths = opts.configPaths ?? DEFAULT_SERENITY_CONFIG_PATHS
  const entrySkillMaxChars = opts.entrySkillMaxChars ?? 30000

  // compaction/end：log-only session 事件。payload: { compactionId, sourceCommandId?, turn, error? }
  // （公开版事件名：compact/* → compaction/*，语义不变）
  // session → agent 关联：session.id 即 agent id（goal-session 同款：ctx.agents.get(session.id)）
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type !== 'compaction/end') return
    // 失败不重注入（上下文未被折叠；下次成功再补）
    if (event.data.error) return

    const agent = ctx.agents.get(session.id) as Agent | undefined
    if (!agent) return

    const cwd = (agent.session as { header?: { cwd?: string } } | undefined)?.header?.cwd ?? process.cwd()
    const root = findSerenityRoot(cwd)
    if (!root) return
    const scope = (agent.session as { id?: string } | undefined)?.id ?? 'default'

    try {
      agent.inject(accMessage(root, configPaths, entrySkillMaxChars, scope))
    } catch {
      /* 重注入失败不阻断（守卫仍兜底） */
    }
  })
}
