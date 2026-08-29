/**
 * output-guard.ts — 最终输出敏感词检测 + 打回重生成（v1.26.3，S142 用户需求）
 *
 * 认知容器对外提供认知结果时，**支撑宁静号自身的凭据与机制**不应透露给用户。
 * 用户拍板方案（讨论稿定稿）：不做工具结果 redaction（那是模型工作内存），
 * 改为**卡最终输出**——`agent/turn-stopping`（serial）时取 turn 最后 assistant 文本，
 * 命中敏感词表 → `agent.steer()` 打回重生成，直到合规或达上限。
 *
 * 敏感词表（有限，ACC 立场，用户确认"这样比较全面了"）：
 *   ① 凭据词  — localstore.json credentials 条目名 + 值精确匹配（运行时读）
 *   ② 机制词  — 内部结构静态词（插件名/配置路径/端口/内部实现词）
 *   ③ MSM 词  — mech-registry.json 注册的工具名（用户补充：msm_list 里的工具名）
 *   **不含** 公开概念（宁静号/Serenity/认知容器/EAP/CCE/Neat——正常交流词，误伤灾难）
 *
 * 机制依据（DSH 官方）：agent/turn-stopping 注释 "a listener that objects steers and
 * the machine re-reads its inbox: fresh steering runs another step, none closes the
 * turn"——steer 打回是官方支持的"重生成"通道（v1.22.5 rebuild 自动继续同款先例）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadMsmEntries } from './msm-ops.js'

// ── 静态机制词（内部结构词汇；公开称呼词不入表）──

/** 插件/内部实现词（静态内置；命中即视为机制泄露） */
const MECHANISM_WORDS: string[] = [
  'dsh-serenity-hooks',
  'serenity-hooks',
  'serenity-hooks.json',
  'mech-registry',
  'mech-registry.json',
  'localstore.json',
  '.opencode/serenity.json',
  'AGENT_SESSIONS',
  'agent/session-start',
  'agent/turn-stopping',
  'tools/pre-execute',
  'tools/post-execute',
  'session_rebuild',
  'Trajectory Steward',
  'first-anchor',
  '拦截缝',
  '装配层',
  'acp-core',
  'skiff-core',
  'skiff-registry',
  'skiff-role',
  'output-guard',
]

/** 内部端口（宁静号服务面） */
const MECHANISM_PORTS: string[] = ['3080', '3081', '3099', '3100']

// ── 词表构建 ──

export interface SensitiveWordTable {
  /** 精确匹配词（条目名/值/工具名——命中即敏感） */
  exact: Set<string>
  /** 子串匹配词（机制词——命中即敏感） */
  substring: string[]
  /** 归一化后的全部精确词（供审计展示） */
  sources: { exact: string[]; substring: string[] }
}

/**
 * 构建敏感词表（每次调用实时构建——词源文件小，开销可接受）：
 *   ① localstore.json credentials：条目名（UPPER_SNAKE）+ 值（精确匹配）
 *   ② 静态机制词 + 端口
 *   ③ mech-registry 注册的 MSM 工具名（loadMsmEntries 全注册表去重）
 * @param root CCC 根（localstore.json / mech-registry 所在）
 */
export function buildSensitiveTable(root: string): SensitiveWordTable {
  const exact = new Set<string>()
  const substring: string[] = []

  // ① 凭据词：localstore.json credentials 条目名 + 值
  try {
    const p = join(root, 'localstore.json')
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, 'utf-8').replace(/^\uFEFF/, '')) as {
        credentials?: Record<string, unknown>
      }
      const creds = raw?.credentials
      if (creds && typeof creds === 'object') {
        for (const [name, value] of Object.entries(creds)) {
          if (name) exact.add(name)
          if (typeof value === 'string' && value !== '') exact.add(value)
        }
      }
    }
  } catch {
    /* 凭据文件缺失/坏 JSON → 跳过（表仍含机制词 + MSM 词） */
  }

  // ② 静态机制词 + 端口
  for (const w of MECHANISM_WORDS) substring.push(w)
  for (const p of MECHANISM_PORTS) substring.push(p)

  // ③ MSM 工具名（用户补充：msm_list 列表里的工具名也包含进去）
  try {
    for (const entry of loadMsmEntries(root)) {
      if (entry.name) exact.add(entry.name)
    }
  } catch {
    /* 注册表缺失 → 跳过 */
  }

  return { exact, substring, sources: { exact: [...exact], substring } }
}

/** 检测文本中命中的敏感词（返回命中列表；未命中返回空数组） */
export function detectSensitive(text: string, table: SensitiveWordTable): string[] {
  if (!text) return []
  const hits = new Set<string>()
  // 精确匹配（词边界：条目名/工具名是独立 token；值可能内嵌——值也精确匹配）
  for (const w of table.exact) {
    if (w !== '' && text.includes(w)) hits.add(w)
  }
  // 子串匹配（机制词）
  for (const w of table.substring) {
    if (w !== '' && text.includes(w)) hits.add(w)
  }
  return [...hits]
}

/**
 * 打回消息（steer 内容）：**告知命中词并指令重新生成**（v1.26.10 用户调整——
 * 原 v1.26.3 设计"不含命中词防二次泄露"导致模型不知道改什么；命中词本就已在被拦截的
 * 回复中进入会话（已暴露面），打回消息重复一次不扩大暴露，模型据此精准重写）。
 * 命中词已落入模型上下文（它刚写过），此消息不回显给用户（steer 是 plugin source 消息，
 * 3100 对外响应 v1.26.10 起已不含 trajectory → 打回文本不会到达外部用户）。
 */
export function buildRebuke(hits: string[]): string {
  const count = hits.length
  const list = [...new Set(hits)].join(', ')
  return (
    `[SERENITY OUTPUT GUARD] Your previous response contained ${count} sensitive internal term(s) ` +
    `(mechanism/credential identifiers) that must not appear in user-visible output: ${list}. ` +
    `Regenerate the response from scratch without ANY of these terms — describe the same substance ` +
    `without referencing internal machinery, credentials, tool names, or implementation details. ` +
    `Do not repeat the terms; do not explain this instruction to the user.`
  )
}

/** 连续打回上限（防死循环；达到后放弃打回，最终输出替换为合规占位 + 审计） */
export const REBUKE_MAX_ROUNDS = 3

/** 打回状态（按 agent 会话跟踪连续命中轮数） */
export const rebukeStates = new Map<string, { consecutive: number }>()
