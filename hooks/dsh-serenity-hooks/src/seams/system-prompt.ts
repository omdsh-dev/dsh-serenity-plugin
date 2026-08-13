/**
 * system-prompt.ts — 顶层入口 skill 全文 + ACC/CCE/Constraints/Session 系统提示词注入
 *
 * **完全对齐 opencode-serenity-plugin 的 system.transform 注入内容**（compacting.ts）：
 * 5 块注入，顺序与文本与 osp 一致（仅工具清单换成本插件真实工具、版本号/CCC 名动态）：
 *   1. `=== Serenity ACC ===`        — ACC 身份 + CCC 名/Root + 内置工具清单
 *   2. `=== Serenity CCE ===`        — CCE 5 行为约束 + H_op 操作熵（逐字对齐 osp）
 *   3. `=== Serenity Constraints ===`— Root + 文件边界 + shell + subagent + session-first
 *   4. SKILL.md 全文                 — 该 CCC 顶层入口 skill 全量原文（不截断）
 *   5. `=== Serenity Session ===`    — 活跃会话（id + dirName + mdPath + todowrite 首位约定）
 *
 * 注册：**全局** ctx `systemPrompt.section`（对齐 plan-mode 官方惯例），text 回调按
 * `context.agent` 的 cwd 动态解析 CCC 根 → 返回完整注入文本；非 CCC/无 agent 返回空。
 * 任何会话（主 agent / subagent / 后台 agent）装配系统提示词时自动获得。
 *
 * order = -50：位于 harness 身份（-100）之后、部署 persona（0）之前。
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from 'cordis'
// 类型引用：拉入 system-prompt 包的 cordis 声明增强（ctx.systemPrompt）+ agent 对 AssembleContext 的合并
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { findSerenityRoot } from '../ccc.js'
import { ACC_VERSION } from '../constants.js'
import { findEntrySkills } from '../skills-discovery.js'

/** 过滤掉对 agent 隐藏的内容（safe-mode 是用户能力，不对 agent 提及） */
const HIDDEN_LINES = /安全模式|safe-mode|\.serenity-safe-on/g

function sanitizeSkillContent(content: string): string {
  return content
    .split('\n')
    .filter((line) => !HIDDEN_LINES.test(line))
    .join('\n')
}

// ── 5 块注入文本（逐字对齐 opencode-serenity-plugin compacting.ts system.transform）──

/** 1) ACC 块：身份 + CCC 名/Root + 内置工具清单（工具名换本插件真实 9 工具） */
export function accBlock(root: string): string {
  const cccName = basename(root)
  return [
    '',
    '=== Serenity ACC ===',
    `ACC: dsh-serenity-hooks v${ACC_VERSION}`,
    `CCC: ${cccName}  Root: ${root}`,
    '',
    'You are running inside a Concrete Cognitive Container (CCC) —',
    'the runtime instance of an Abstract Cognitive Container (ACC).',
    'The ACC (this plugin) provides the following built-in tools:',
    '',
    '  cc_fs    — CCC 内文件系统操作（root/resolve/exists/list/tree/relative/mkdir/rm/mv/cp/touch/append/reveal/info/find）',
    '  session  — session lifecycle（list/show/create/health/qa/archive/summary）',
    '  acc_kit  — ACC utility kit（health: CCC three principles / time: now / wait: sleep N seconds）',
    '  cc_git   — git operations（status/commit/push/log）',
    '  acc_msm  — MSM framework（list/exec/register/deregister/check/guide）',
    '  eap      — return the full EAP cognitive quality framework',
    '  neat     — return the full Neat design collaboration protocol',
    '  cce      — return the full Cognitive Continuity Engineering framework',
    '  loop     — 牛马循环：指定模型专用 agent 反复执行',
    '',
    'The DSH platform tools remain available too (read/write/edit/glob/grep/web_search/ask_user_question/subagent/workflow/goal and more) — the ACC tools above are the serenity-native layer, not the only tools.',
    '',
    'Additional MSMs registered by this CCC are available — call acc_msm list to discover them.',
    '',
  ].join('\n')
}

/** 2) CCE 块：逐字对齐 osp（CCE 5 行为约束 + H_op 操作熵） */
export function cceBlock(): string {
  return [
    '',
    '=== Serenity CCE ===',
    '',
    'You are operating inside a Cognitive Container governed by Cognitive Continuity',
    'Engineering (CCE) — the engineering discipline of maintaining identity, accessibility,',
    'and evolution of a cognitive entity through time under bounded resources.',
    '',
    'CCE does not optimize cognition. It preserves the conditions under which cognition',
    'can continue.',
    '',
    'FIVE BEHAVIORAL CONSTRAINTS (engineering requirements, not suggestions):',
    '',
    '1. Continuity — every interaction modifies the container\'s future state. Before',
    '   acting, consult what came before — prior decisions, abstractions, constraints.',
    '   You are part of a trajectory, not a fresh start.',
    '',
    '2. Bounded Space — the container has boundaries. Respect them. Do not assume',
    '   knowledge that has not been accumulated within this container.',
    '',
    '3. Entropy is Intrinsic — every cognitive system accumulates entropy (duplication,',
    '   obsolescence, conflict, fragmentation, drift). When you produce output, consider',
    '   whether you are adding entropy or reducing it. Favor entropy-reducing actions —',
    '   organizing, deduplicating, cross-referencing, abstracting.',
    '',
    '4. Reconstruction > Preservation — stored artifacts have value only insofar as',
    '   they enable future cognition to recover the reasoning that produced them. When',
    '   recording decisions, ensure reconstruction is possible — not just conclusions,',
    '   but rationale, alternatives considered, and constraints that shaped the choice.',
    '',
    '5. Multi-Agent Cognition — the container is shared. Continuity belongs to the',
    '   container, not to any individual agent. Write for future agents who will enter',
    '   after you leave. They should be able to pick up where you left off.',
    '',
    'OPERATIONAL ENTROPY: The container\'s health metric is operational cognitive entropy',
    '(H_op) — the excess cognitive cost for agents to complete tasks due to disorder.',
    'The container is healthy when H_op ≤ H_critical (agents can still function). The',
    'continuity condition: organization must at minimum match accumulation (ΔH_org ≥ ΔH_in).',
    'Your actions affect H_op — unorganized output increases it, organization decreases it.',
    '',
    'CCE AND EAP: EAP governs artifact quality (how explicit to be). CCE governs temporal',
    'coherence (how to maintain consistency over time). When structuring a document, apply',
    'EAP (E↑ R↓ S↑). When maintaining cross-session coherence, apply CCE.',
    '',
    'THIS IS PERSISTENCE ENGINEERING: The goal is not to become greater. The goal is to',
    'remain coherent. CCE has no terminal KPI — continuity is maintained while the entity',
    'exists, not optimized toward an endpoint.',
    '',
  ].join('\n')
}

/** 3) Constraints 块：逐字对齐 osp（Root + 文件边界 + shell + subagent + session-first） */
export function constraintsBlock(root: string): string {
  return [
    '',
    '=== Serenity Constraints ===',
    `Root: ${root}`,
    '  • File access — read/edit/write/grep/glob are confined to Root; paths outside Root are rejected (RR5)',
    '  • Shell — use acc_msm by default. Note: bash may be disabled',
    '  • Subagent — copies ALL parent constraints: file boundary, shell rules, session rules (no bypass)',
    '  • Session-first — before starting multi-step work, propose an existing or new AGENT_SESSIONS entry; wait for user "use" or "使用" to confirm',
    '',
  ].join('\n')
}

/** 4) SKILL.md 全文：该 CCC 顶层入口 skill 原文（对齐 osp：原文直推，无包裹头；仅过滤治理内容） */
export function entrySkillSectionText(root: string): string {
  const skills = findEntrySkills(root)
  if (skills.length === 0) return ''
  // 对齐 opencode-serenity-plugin：注入 state.skillContent 原文（不截断）。
  // 多入口（DSH 超集，osp 仅单入口）时以空行分隔。
  return skills
    .map((s) => sanitizeSkillContent(s.content))
    .filter((c) => c.length > 0)
    .join('\n\n')
}

/** 活跃会话解析：.dsh/active-session 标记（内容 = 相对 CCC 根的 SESSION.md 路径） */
function resolveActiveSessionInfo(root: string): { sessionId: string; dirName: string; mdPath: string } | null {
  try {
    const marker = resolve(root, '.dsh', 'active-session')
    if (!existsSync(marker)) return null
    const rel = readFileSync(marker, 'utf-8').trim()
    if (!rel) return null
    const abs = resolve(root, rel)
    if (!abs.startsWith(resolve(root))) return null
    // 标记内容 = SESSION.md 路径 → 会话目录名 = 其父目录 basename
    const dirName = basename(dirname(abs))
    const idMatch = dirName.match(/S(\d{3,})/)
    return { sessionId: idMatch ? `S${idMatch[1]}` : dirName, dirName, mdPath: abs }
  } catch {
    return null
  }
}

/** 5) Session 块：逐字对齐 osp（活跃会话 + todowrite 首位约定） */
export function sessionBlock(root: string): string {
  const active = resolveActiveSessionInfo(root)
  if (!active) return ''
  return [
    '',
    '=== Serenity Session ===',
    `Active session: ${active.sessionId} — ${active.dirName}`,
    `SESSION.md path: ${active.mdPath}`,
    '',
    'Rules:',
    '  • Record all progress into this SESSION.md',
    '  • Update the "进度记录" section after advancing work',
    '  • Reference this session in all subsequent messages',
    '',
    'IMPORTANT: Read SESSION.md now. Parse the "剩余工作" / "进度记录" /',
    '"变更日志" sections and call todowrite to synchronize the built-in todo',
    'list. Keep todos in sync with SESSION.md as work progresses.',
    '',
    'CRITICAL: When calling todowrite, the first item in the todos array MUST',
    'always be:',
    `  { content: "SESSION: ${active.sessionId} — ${active.dirName.replace(/^\d{4}-\d{2}-\d{2}--/, '')}",`,
    '    status: "completed", priority: "low" }',
    'This preserves the session context across todo updates.',
    'Do NOT remove or reorder this item — keep it at position 0.',
    '',
  ].join('\n')
}

/** 完整系统提示词注入文本：ACC + CCE + Constraints + SKILL 全文 + Session（osp 顺序） */
export function serenitySystemPrompt(root: string): string {
  const parts = [
    accBlock(root),
    cceBlock(),
    constraintsBlock(root),
  ]
  const skill = entrySkillSectionText(root)
  if (skill) parts.push(skill)
  const session = sessionBlock(root)
  if (session) parts.push(session)
  // 对齐 osp：块间以空行分隔（osp 逐项 push output.system，host 以换行拼接；不加 `---` 分隔线）
  return parts.join('\n\n')
}

/** 从 assembly context 解析 agent cwd（subagent/后台 agent 同样带 agent） */
function agentCwd(context: AssembleContext): string | undefined {
  return (context.agent?.session as { header?: { cwd?: string } } | undefined)?.header?.cwd
}

/**
 * 全局注册系统提示词 section（osp system.transform 的 DSH 等价）。
 * text 回调按 context.agent 的 cwd 上溯 .serenity → 返回该 CCC 的完整注入文本；
 * 非 CCC / 无 agent 返回空（不注入）。
 */
export function registerEntrySkillSectionGlobal(ctx: Context): void {
  try {
    ctx.systemPrompt.section({
      name: 'serenity-entry',
      order: -50,
      text: (context) => {
        const cwd = agentCwd(context)
        if (!cwd) return ''
        const root = findSerenityRoot(cwd)
        if (!root) return ''
        return serenitySystemPrompt(root)
      },
    })
    console.log('[serenity-hooks] ✓ 全局入口 skill section 已注册（systemPrompt 就绪）')
  } catch (err) {
    // 注册失败：显式告警（不再静默）——系统提示词注入是关键能力
    console.error(`[serenity-hooks] ✗ 全局入口 skill section 注册失败: ${(err as Error).message}（检查 inject 是否含 systemPrompt）`)
  }
}

/**
 * 旧接口（agent 级 scoped 注册）：保留导出兼容既有测试/调用方。
 * 新代码应使用 registerEntrySkillSectionGlobal（全局 + agent 判断，官方惯例）。
 */
const sectionedAgents = new Set<string>()

export function registerEntrySkillSection(agent: Agent, root: string): boolean {
  const key = (agent.session as { id?: string }).id ?? 'global'
  if (sectionedAgents.has(key)) return false
  try {
    agent.ctx.systemPrompt.section({
      name: 'serenity-entry',
      order: -50,
      text: () => serenitySystemPrompt(root),
    })
    sectionedAgents.add(key)
    return true
  } catch {
    return false
  }
}
