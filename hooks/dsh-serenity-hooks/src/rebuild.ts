/**
 * rebuild.ts — F2 超限重建工具（v1.21）：session_rebuild
 *
 * 需求（S142 用户拍板）：SESSION.md + SESSION-KEEPER 已是实时上下文整理 →
 * 上下文压缩不再需要，超限时**清空重建**（新会话路线，Ship of Theseus）。
 * 触发：**LLM 主动调用 session_rebuild**（keeper 超阈值后提示，不自动执行——
 * 用户决策，防误清空）。
 *
 * 执行链：
 *  ① 归档当前会话：SESSION.md 标记 completed + 目录移 AGENT_SESSIONS/_archived/
 *     （立即归档，跳过 7 天 grace——重建是显式决策；旧会话完整留存供后续重建推理）
 *  ② 创建新会话：ctx.agents.create（复用 loop.ts 先例；sessionId 走 F3 命名，
 *     origin:'subagent' + parentSession → WebUI 子代理卡可见）
 *  ③ 注入锚点消息：新会话首条 = SESSION.md 路径 + 简短摘要 + 重建指令
 *     （完整身份由 first-anchor + systemPrompt.section 自动恢复）
 *
 * 门控：仅 CCC 内 + 简单配置 rebuild.enabled。
 */

import type { Context } from 'cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { findSerenityRoot } from './ccc.js'
import { readSimpleSettings } from './settings-section.js'
import { sessionsRoot, createSession, type CreateSessionResult } from './session-ops.js'

/** 归档目录名（与 session-ops ARCHIVE_DIR_NAME 一致） */
export const ARCHIVE_DIR = '_archived'

/**
 * 归档旧会话：SESSION.md 标记 completed + 目录移 _archived/（立即，跳过 grace）。
 * 纯逻辑（可单测）；找不到会话/无 SESSION.md 抛错。
 * @returns 归档后的新路径（或 null = 会话已归档/不存在）
 */
export function archiveSessionNow(root: string, key: string): string | null {
  const sessionsDir = sessionsRoot(root)
  const archiveDir = join(sessionsDir, ARCHIVE_DIR)
  // 复用 session-ops 的 findSession（按 S###/目录名/模糊匹配）
  // 直接扫目录找匹配目录（避免依赖未导出的 findSession 内部实现）
  let target: string | null = null
  try {
    const entries = readDirSafe(sessionsDir)
    for (const name of entries) {
      if (!name.includes('--S') && name !== key) continue
      if (name === key || name.endsWith(`--${key}`) || name.includes(`--${key}--`)) {
        target = join(sessionsDir, name)
        break
      }
    }
  } catch {
    return null
  }
  if (target === null) {
    // fallback：S### 精确匹配（key 如 "S001"）
    for (const name of readDirSafe(sessionsDir)) {
      const m = name.match(/--S(\d{3,})--/)
      if (m && `S${m[1]}` === key) {
        target = join(sessionsDir, name)
        break
      }
    }
  }
  if (target === null) return null
  const mdPath = join(target, 'SESSION.md')
  if (existsSync(mdPath)) {
    let content = readFileSync(mdPath, 'utf-8').replace(/\r\n/g, '\n')
    content = content.replace(
      /## 状态\n\n?- \[ \] 进行中/,
      '## 状态\n- [x] 已完成\n- [x] 已关闭（session_rebuild 归档）',
    )
    const now = new Date().toISOString().slice(0, 16).replace('T', ' ')
    if (!content.includes('-- 关闭')) {
      content = content.replace(/(## 进度记录\n)/, `$1- ${now} — 关闭（session_rebuild 归档）\n`)
    }
    writeFileSync(mdPath, content, 'utf-8')
  }
  if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true })
  const dest = join(archiveDir, target.split(/[\\/]/).pop()!)
  renameSync(target, dest)
  return dest
}

function readDirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** 新会话锚点消息（重建指令 + SESSION.md 路径 + 摘要） */
export function buildRebuildAnchor(root: string, oldDirName: string, note: string | undefined): string {
  const mdPath = join(root, 'AGENT_SESSIONS', oldDirName, 'SESSION.md')
  const lines = [
    '[SESSION-REBUILD] 上下文已清空重建（Ship of Theseus：会话归档，身份延续）。',
    `- 旧会话（已归档）：AGENT_SESSIONS/_archived/${oldDirName}`,
    `- 完整上下文：${mdPath}`,
    `- 请先读取旧会话的 SESSION.md（目标/决策/进度/未解决问题），从上次进度继续。`,
  ]
  if (note) lines.push(`- 重建背景：${note}`)
  return lines.join('\n')
}

export interface RebuildResult {
  oldSession: { dirName: string; archivedTo: string | null } | null
  newSession: { sessionId: string; dirName: string }
  anchor: string
}

/**
 * 执行 session_rebuild（服务端逻辑）：
 * ① 归档当前宁静号会话（LLM 经 session use 激活的那个）
 * ② 创建新宁静号 SESSION 目录（createSession）+ dsh agent 会话（ctx.agents.create）
 * ③ 返回锚点文本（调用方负责注入到新 agent）
 * @returns rebuild 结果；rebuild.enabled=false 或非 CCC 抛错
 */
export async function executeRebuild(
  ctx: Context,
  opts: { root: string; activeDirName: string | null; note?: string; agentCwd: string; parentSessionId?: string },
): Promise<RebuildResult> {
  if (!readSimpleSettings().rebuildEnabled) {
    throw new Error('session_rebuild 已禁用（rebuild.enabled=false，可在 dsh 设置面板开启）')
  }
  const { root, activeDirName, note } = opts

  // ① 归档旧会话（有激活会话时）
  let old: RebuildResult['oldSession'] = null
  if (activeDirName) {
    const archivedTo = archiveSessionNow(root, activeDirName)
    old = { dirName: activeDirName, archivedTo }
  }

  // ② 创建新宁静号 SESSION 目录（编号递增）
  const created: CreateSessionResult = createSession({
    root,
    desc: 'rebuild',
    goal: '上下文超限清空重建（session_rebuild）',
    dryRun: false,
  })

  // ③ 创建 dsh agent 会话（复用 loop.ts 模式：origin subagent + parentSession）
  const parentSession = opts.parentSessionId
  const sessionId = `rebuild-${randomUUID()}` as SessionId
  let newSession: RebuildResult['newSession'] = { sessionId: String(sessionId), dirName: created.dirName }
  if (ctx.agents) {
    try {
      const handle: AgentHandle = await ctx.agents.create({
        sessionId,
        meta: {
          cwd: opts.agentCwd,
          origin: 'subagent',
          ...(parentSession ? { parentSession: parentSession as SessionId } : {}),
        },
        agentOptions: undefined,
      })
      newSession = { sessionId: String(sessionId), dirName: created.dirName }
      // ③ 注入锚点消息到新 agent（身份由 first-anchor + systemPrompt 自动恢复）
      const anchor = buildRebuildAnchor(root, created.dirName, note)
      handle.agent.inject({
        content: [{ type: 'text', text: anchor }],
        source: { kind: 'plugin', plugin: 'dsh-serenity-hooks' },
      } as never)
    } catch {
      // agent 创建失败不阻断（新宁静号 SESSION 目录已建；调用方提示用户手动开新会话）
    }
  }

  return { oldSession: old, newSession, anchor: buildRebuildAnchor(root, created.dirName, note) }
}
