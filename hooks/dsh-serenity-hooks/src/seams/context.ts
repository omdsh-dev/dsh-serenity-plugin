/**
 * context.ts — 拦截缝：ACC 上下文注入（agent/session-start + agent/prompt-submit）
 *
 * 对应 opencode-serenity-plugin 的 system.transform（ACC 身份/约束注入）+ Phase 2 访谈提示。
 *
 * 设计：
 * - session-start（emit）：CCC 内新会话一次性播种 ACC 身份（agent.inject）
 * - prompt-submit（waterfall）：每 agent 首次进入 CCC 时附加紧凑身份提示；
 *   只注入一次（Set 跟踪），避免每轮 token 膨胀；context-only 必须 next() 委托
 *   （短路会跳过后续策略监听器，interception-seams 笔记明确警告）。
 */

import type { Context } from 'cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource, ContentBlock } from '@deepseek-ai/dsh-llm'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, basename, dirname } from 'node:path'
import { findSerenityRoot, loadSerenityConfig, readHandymanConfig, DEFAULT_SERENITY_CONFIG_PATHS } from '../ccc.js'
import { ACC_VERSION } from '../constants.js'
import { truncateContent } from '../skills-discovery.js'
import { registerEntrySkillSection } from './system-prompt.js'
import { syncSafeModeRestriction } from './guards.js'
import { parseSessionContextFromEvents, getActiveSessionInfo, setActiveSessionInfo, DEFAULT_SESSION_SCOPE, sessionEvents, resolveSessionByTitle, sessionsRoot } from '../session-ops.js'
import { readLastBound, appendBound } from '../session-bound.js'
import { isSkiffSessionId } from '../skiff-role.js'

// ── 纯文本构建（可单测）──

export const DEFAULT_ENTRY_SKILL_MAX_CHARS = 30000

/** 从 dsh 会话日志读标题（latest-wins `session/title` 事件；无返回 null）——供标题 reconcile（U3） */
export function readDshSessionTitle(session: unknown): string | null {
  try {
    const events = sessionEvents<{ type?: string; data?: { title?: unknown } }>(session)
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (e?.type === 'session/title' && typeof e.data?.title === 'string' && e.data.title.trim() !== '') {
        return e.data.title.trim()
      }
    }
  } catch {
    /* events 访问失败忽略 */
  }
  return null
}

export function accIdentityText(
  root: string,
  configPaths: string[] = DEFAULT_SERENITY_CONFIG_PATHS,
  entrySkillMaxChars: number = DEFAULT_ENTRY_SKILL_MAX_CHARS,
): string {
  const cfg = loadSerenityConfig(root, configPaths)
  // v1.24.0：loop.defaultModel → handyman 配置（模型白名单）
  const hc = readHandymanConfig(root, configPaths)
  const defaultModel = hc?.defaultModel
  const phase2 = existsSync(resolve(root, '.dsh', 'PHASE2-PROMPT.md'))
  const lines = [
    `[ACC] Serenity cognitive container active (dsh-serenity-hooks v${ACC_VERSION})`,
    `- CCC root: ${root}`,
    `- Constraints: path isolation (P3, fs sandbox) + session tracking (AGENT_SESSIONS/)`,
    `- Knowledge: load the acc-serenity entry skill; use acc-eap / acc-neat for design collaboration`,
  ]
  if (defaultModel) lines.push(`- handyman default model: ${defaultModel}`)
  if (phase2) {
    lines.push('- ⚠️ **Phase 2 cognitive alignment interview pending**: work through the 5 Topics below and record answers in an AGENT_SESSIONS/ session')
    try {
      const prompt = readFileSync(resolve(root, '.dsh', 'PHASE2-PROMPT.md'), 'utf-8')
      lines.push(truncateContent(prompt, Math.min(entrySkillMaxChars, 8000)))
    } catch {
      /* 读取失败忽略 */
    }
  }
  return lines.join('\n')
}

// ── DSH 注册 ──

const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'dsh-serenity-hooks' }

/**
 * ACC 注入消息（S134 去重）：**只含简短身份锚点**（[ACC] 已激活 + CCC 根 + 约束 + handyman 模型 + Phase 2）。
 * 完整身份（ACC 5 块 + CCE + Constraints + EAP + SKILL 全文 + Session 块）由**系统提示词层**
 * （systemPrompt.section，每轮 prompt 装配自动注入，含 subagent）承担——对话消息流/压缩重注入
 * 不再重复注入同一内容（token 双倍浪费，见 S134 注入方案梳理）。
 */
export function accMessage(root: string, configPaths: string[], entrySkillMaxChars: number): UserMessage {
  const header = accIdentityText(root, configPaths, entrySkillMaxChars)
  const content: ContentBlock[] = [{ type: 'text', text: header }]
  return createUserMessage({ content, source: PLUGIN_SOURCE })
}

/** 每 agent 是否已注入过（进程内存态） */
const injected = new Set<string>()

function agentKey(agent: Agent): string {
  return (agent.session as { id?: string }).id ?? 'global'
}

function agentScope(agent: Agent): string {
  return (agent.session as { id?: string }).id ?? DEFAULT_SESSION_SCOPE
}

/**
 * 重启恢复的根会话判定（S134 需求）：
 * 只有"conversation 根会话"才自动恢复最近激活的宁静号会话——
 * - subagent：session header `origin === 'subagent'`（DSH 路由语义，agent-lookup.ts）
 * - 派生会话：`parentSession` 存在（任何子会话）
 * - handyman 杂工：sessionId 固定 `handyman-` 前缀（tools/handyman.ts 生成）
 * 三者都不恢复（避免把主会话激活注入子上下文，违背 v1.16.2 scope 隔离）。
 */
export function shouldAutoRestore(agent: Agent): boolean {
  const session = agent.session as { id?: string; header?: { origin?: string; parentSession?: string } } | undefined
  if (!session) return false
  if (session.header?.origin === 'subagent') return false
  if (session.header?.parentSession) return false
  if (session.id?.startsWith('handyman-')) return false
  // F4 Skiff：完全独立会话（角色 CCC 提示词全替换），不自动恢复宁静号会话激活信息
  if (isSkiffSessionId(session.id)) return false
  return true
}

/**
 * 恢复触发判定（S134 泄漏修复 v1.16.13）：根会话 **且已有对话历史**（续跑/恢复的会话）
 * 才自动恢复上次激活的宁静号会话——全新会话（新任务，如 apaas-26116）无历史 → 不恢复，
 * 避免把过去的 SESSION 上下文注入新任务（跨任务污染）。
 */
export function shouldRestoreActive(agent: Agent): boolean {
  if (!shouldAutoRestore(agent)) return false
  const events = sessionEvents(agent.session)
  return events.length > 0
}

export interface ContextRegistration {
  configPaths?: string[]
  /** session-start 播种 */
  seedOnStart?: boolean
  /** prompt-submit 兜底注入 */
  injectOnPrompt?: boolean
  /** 入口 skill 内容注入上限（字符）；0 = 不注入 skill 内容 */
  entrySkillMaxChars?: number
}

export function registerContext(ctx: Context, opts: ContextRegistration = {}): void {
  const configPaths = opts.configPaths ?? DEFAULT_SERENITY_CONFIG_PATHS
  const entrySkillMaxChars = opts.entrySkillMaxChars ?? DEFAULT_ENTRY_SKILL_MAX_CHARS

  const seed = (agent: Agent): void => {
    const cwd = (agent.session as { header?: { cwd?: string } } | undefined)?.header?.cwd ?? process.cwd()
    const root = findSerenityRoot(cwd)
    if (!root) return
    const key = agentKey(agent)
    // F4 Skiff：会话 id `skiff-` 前缀 → 完全旁路（不注入 ACC 身份；角色 CCC 提示词全替换）
    if (isSkiffSessionId(key)) return
    // P0-1：agent 级 scoped 注册身份 section（最近层，抗 preset/动态插件同名 shadow）。
    // 与全局 section 同名 → scoped 胜出；全局保留为冷恢复/未走 session-start 的 fallback。
    registerEntrySkillSection(agent, root)
    // 重启恢复（S134 v1.16.14 内存化，对齐 osp）：进程重启内存 Map 空 + 会话有历史 →
    // 从**当前会话 events** 解析 [SESSION CONTEXT] 标记恢复内存活跃会话（只扫自己会话，
    // 无跨会话串台）；全新会话（无历史）天然不恢复。autoRestoreSession 可关，默认开。
    const scope = agentScope(agent)
    if (shouldRestoreActive(agent) && getActiveSessionInfo(scope) === null) {
      try {
        const cfg = loadSerenityConfig(root, configPaths)
        if (cfg.hooks?.autoRestoreSession ?? true) {
          const dshSession = agent.session
          // v1.0 恢复链（方案：bound 权威 → 文本扫回退 → 标题 reconcile 兼容）——
          // 三层均绝对化 + existsSync 校验（陈旧/归档/删除不污染内存）。
          let restored: { dirName: string; mdPath: string; sessionId?: string } | null = null
          // ① 持久化绑定事件（权威，U1）
          const bound = readLastBound(dshSession)
          if (bound) {
            const abs = bound.mdPath.startsWith(root) ? bound.mdPath : resolve(root, bound.mdPath)
            if (existsSync(abs)) restored = { dirName: bound.dirName, mdPath: abs, sessionId: bound.sessionId }
          }
          // ② 旧会话回退：文本扫描 [SESSION CONTEXT] / SESSION.md path:
          if (!restored) {
            const info = parseSessionContextFromEvents(sessionEvents(dshSession))
            if (info) {
              const abs = info.mdPath.startsWith(root) ? info.mdPath : resolve(root, info.mdPath)
              if (existsSync(abs)) restored = { dirName: info.dirName, mdPath: abs, sessionId: info.sessionId }
            }
          }
          // ③ 标题 reconcile（U3/U4）：无 bound + 标题含 SESSION 引用 → 编码无关解析 + 持久化
          if (!restored) {
            const title = readDshSessionTitle(dshSession)
            if (title) {
              const md = resolveSessionByTitle(title, sessionsRoot(root))
              if (md && existsSync(md)) {
                const dirName = basename(dirname(md))
                restored = { dirName, mdPath: md, sessionId: undefined }
                appendBound(dshSession, 'reconcile', { dirName, mdPath: md, note: 'auto from title' })
                console.log(`[serenity-hooks] ↻ 标题兼容持久化绑定: ${title} → ${dirName}`)
              }
            }
          }
          if (restored) {
            // ActiveSessionInfo.sessionId 必填（展示码）：有则用；无则从目录名派生（S###/自定义编码段）或回退 dirName
            const derived = restored.sessionId
              ?? (restored.dirName.match(/--([^--]+)--/) ? restored.dirName.match(/--([^--]+)--/)![1] : undefined)
              ?? restored.dirName
            setActiveSessionInfo(scope, { ...restored, sessionId: derived })
            console.log(`[serenity-hooks] ↻ 从历史恢复激活会话: ${restored.dirName}`)
          }
        }
      } catch {
        /* 恢复失败不阻断播种（Session 块自然为空，用户可手动 session use） */
      }
    }
    if (injected.has(key)) return
    injected.add(key)
    agent.inject(accMessage(root, configPaths, entrySkillMaxChars))
    syncSafeModeRestriction(agent, root)
  }

  // session-start：emit 通知，CCC 内新会话播种
  if (opts.seedOnStart ?? true) {
    ctx.on('agent/session-start', (payload) => {
      try {
        seed(payload.agent)
      } catch {
        /* 播种失败不阻断启动 */
      }
    })
  }

  // pre-step（DSH v2：prompt-submit → agent/pre-step，step 级准入）：首次进入 CCC 时前置身份消息（必须 next() 委托）
  if (opts.injectOnPrompt ?? true) {
    ctx.on('agent/pre-step', async (payload, next): Promise<PreStepDecision> => {
      const { agent, messages } = payload
      const cwd = (agent.session as { header?: { cwd?: string } } | undefined)?.header?.cwd ?? process.cwd()
      const root = findSerenityRoot(cwd)
      const key = agentKey(agent)
      const downstream = await next()
      // F4 Skiff：完全旁路（不注入 ACC 身份 + 不注册 scoped section；guard 白名单仍兜底约束）
      if (isSkiffSessionId(key)) return downstream
      // 每步无条件同步 safe-mode 工具隐藏（restrict 实时跟随标记文件；必须在 early-return 之前）
      if (root) {
        try {
          syncSafeModeRestriction(agent, root)
        } catch {
          /* 同步失败不阻断 step（守卫仍兜底拦截） */
        }
        // P0-1：pre-step 兜底路径也启用 scoped 身份 section（session-start 之外的 agent）
        registerEntrySkillSection(agent, root)
      }
      if (!root || injected.has(key) || downstream.kind !== 'enter') return downstream
      injected.add(key)
      return { kind: 'enter', messages: [accMessage(root, configPaths, entrySkillMaxChars), ...messages, ...downstream.messages] }
    })
  }
}
