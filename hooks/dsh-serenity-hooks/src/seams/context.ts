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
import { resolve } from 'node:path'
import { findSerenityRoot, loadSerenityConfig, DEFAULT_SERENITY_CONFIG_PATHS } from '../ccc.js'
import { ACC_VERSION } from '../constants.js'
import { truncateContent } from '../skills-discovery.js'
import { serenitySystemPrompt, registerEntrySkillSection } from './system-prompt.js'
import { syncSafeModeRestriction } from './guards.js'
import { DEFAULT_SESSION_SCOPE } from '../session-ops.js'

// ── 纯文本构建（可单测）──

export const DEFAULT_ENTRY_SKILL_MAX_CHARS = 30000

export function accIdentityText(
  root: string,
  configPaths: string[] = DEFAULT_SERENITY_CONFIG_PATHS,
  entrySkillMaxChars: number = DEFAULT_ENTRY_SKILL_MAX_CHARS,
): string {
  const cfg = loadSerenityConfig(root, configPaths)
  const loop = cfg.loop?.defaultModel
  const phase2 = existsSync(resolve(root, '.dsh', 'PHASE2-PROMPT.md'))
  const lines = [
    `[ACC] 宁静号认知容器已激活（dsh-serenity-hooks v${ACC_VERSION}）`,
    `- CCC 根：${root}`,
    `- 约束：路径隔离（P3，fs 沙箱）+ 会话追踪（AGENT_SESSIONS/）`,
    `- 知识：加载 acc-serenity 入口技能；设计协作走 acc-eap / acc-neat`,
  ]
  if (loop) lines.push(`- loop 默认模型：${loop}`)
  if (phase2) {
    lines.push('- ⚠️ **Phase 2 认知对齐访谈待完成**：请按下方 5 个 Topic 逐项访谈并沉淀答案到 AGENT_SESSIONS/ 会话')
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
 * ACC 注入消息：完整内容 = 简短身份头 + 完整系统提示词（ACC 5 块 + CCC 顶层 skill 原文）。
 * 用户要求：在此处注入完整 ACC 系统提示词内容 + CCC 顶层 skill 原文（对齐 osp system.transform）。
 * scope = dsh 会话 id：Session 块按会话隔离，不跨会话泄露。
 */
export function accMessage(root: string, configPaths: string[], entrySkillMaxChars: number, scope: string = DEFAULT_SESSION_SCOPE): UserMessage {
  const header = accIdentityText(root, configPaths, entrySkillMaxChars)
  const full = serenitySystemPrompt(root, scope)
  const text = `${header}\n\n${full}`
  const content: ContentBlock[] = [{ type: 'text', text }]
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
    // P0-1：agent 级 scoped 注册身份 section（最近层，抗 preset/动态插件同名 shadow）。
    // 与全局 section 同名 → scoped 胜出；全局保留为冷恢复/未走 session-start 的 fallback。
    registerEntrySkillSection(agent, root)
    if (injected.has(key)) return
    injected.add(key)
    agent.inject(accMessage(root, configPaths, entrySkillMaxChars, agentScope(agent)))
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
      return { kind: 'enter', messages: [accMessage(root, configPaths, entrySkillMaxChars, agentScope(agent)), ...messages, ...downstream.messages] }
    })
  }
}
