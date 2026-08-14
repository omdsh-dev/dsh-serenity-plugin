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
import { basename, dirname } from 'node:path'
import { findSerenityRoot } from '../ccc.js'
import { ACC_VERSION } from '../constants.js'
import { findEntrySkills } from '../skills-discovery.js'
import { readActiveSessionMd, DEFAULT_SESSION_SCOPE } from '../session-ops.js'

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
    '  localstore — ACC 本地凭据/配置存储（credential 0600 + config 0644，~/.serenity/）；doc 子命令输出规范',
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

/**
 * EAP 自检提示块（DSH 扩展，无 osp 对应——osp 无此块）。
 * 每次输出前的机械自检清单，强化 EAP 表现（E↑ 显式/R↓ 可重建/S↑ 稳定）。
 * 独立块而非塞进 CCE/Constraints：后两者受 osp-alignment 逐字节断言约束。
 */
export function eapBlock(): string {
  return [
    '',
    '=== Serenity EAP ===',
    '每次输出前自检（显式抽象原则：思维的价值 = 外部可重建性）:',
    '  • E↑ 显式 — 变量/实体明确定义，关系指明方向/基数，边界划定；不用歧义词（"处理""优化"→具体化）',
    '  • R↓ 可重建 — 关键决策记录理由与备选，不跳级讨论（先对齐上层再进下层）',
    '  • S↑ 稳定 — 结构可重复生成，避免依赖隐含上下文',
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

/** 活跃会话解析：按 dsh 会话 scope 读标记（隔离；不回退旧全局标记） */
function resolveActiveSessionInfo(root: string, scope: string): { sessionId: string; dirName: string; mdPath: string } | null {
  try {
    const abs = readActiveSessionMd(root, scope)
    if (!abs) return null
    // 标记内容 = SESSION.md 路径 → 会话目录名 = 其父目录 basename
    const dirName = basename(dirname(abs))
    const idMatch = dirName.match(/S(\d{3,})/)
    return { sessionId: idMatch ? `S${idMatch[1]}` : dirName, dirName, mdPath: abs }
  } catch {
    return null
  }
}

/** 5) Session 块：逐字对齐 osp（活跃会话 + todowrite 首位约定）；scope = dsh 会话维度 */
export function sessionBlock(root: string, scope: string = DEFAULT_SESSION_SCOPE): string {
  const active = resolveActiveSessionInfo(root, scope)
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

/** 完整系统提示词注入文本：ACC + CCE + Constraints + EAP + SKILL 全文 + Session（osp 顺序 + EAP 扩展） */
export function serenitySystemPrompt(root: string, scope: string = DEFAULT_SESSION_SCOPE): string {
  const parts = [
    accBlock(root),
    cceBlock(),
    constraintsBlock(root),
    eapBlock(),
  ]
  const skill = entrySkillSectionText(root)
  if (skill) parts.push(skill)
  const session = sessionBlock(root, scope)
  if (session) parts.push(session)
  // 对齐 osp：块间以空行分隔（osp 逐项 push output.system，host 以换行拼接；不加 `---` 分隔线）
  return parts.join('\n\n')
}

/**
 * Code Mode 适配行：当前 scope 以 Code Mode 呈现工具时（run_code 可见），
 * ACC 块按 native 语义指引"直接调用工具"会与"只有 run_code 可直接调用"的执行
 * 塌缩冲突（模型直呼工具名 → UNKNOWN_TOOL，拒绝信息误导）。追加一行说明，
 * 引导经 run_code 程序内 tools.* 调用。both 模式不塌缩，该行不误导（程序内
 * 调用同样合法），故按 run_code 可见性（code|both）统一附加。
 * @param ctx - 插件 ctx（读 tools 注册表）。
 * @param scope - 装配 scope（agent）；无则按全局视图判断。
 * @returns 适配行（含换行前缀）；非 code/both 返回空串。
 */
export function codeModeAdaptationLine(ctx: Context, scope?: unknown): string {
  try {
    const codeVisible = ctx.tools.get('run_code', scope as never) !== undefined
    if (!codeVisible) return ''
  } catch {
    return ''
  }
  return [
    '',
    '=== Serenity Code Mode ===',
    '当前会话以 Code Mode 呈现工具：模型直接调用 ACC 工具名（cc_fs/acc_msm 等）会被拒绝（UNKNOWN_TOOL）。',
    '请在一个 run_code 程序内经生成的 SDK 绑定调用：`await tools.cc_fs(...)`、`await tools.acc_msm(...)` 等。',
    '程序只返回你 print/return 的内容——务必 curate 输出。',
    '',
  ].join('\n')
}

/** 从 assembly context 解析 agent cwd（subagent/后台 agent 同样带 agent） */
function agentCwd(context: AssembleContext): string | undefined {
  return (context.agent?.session as { header?: { cwd?: string } } | undefined)?.header?.cwd
}

/** 从 assembly context 解析 dsh 会话 id（Session 块按会话隔离的 scope） */
function agentScope(context: AssembleContext): string {
  return (context.agent?.session as { id?: string } | undefined)?.id ?? DEFAULT_SESSION_SCOPE
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
        const base = serenitySystemPrompt(root, agentScope(context))
        const codeLine = codeModeAdaptationLine(ctx, context.scope)
        return codeLine ? `${base}\n${codeLine}` : base
      },
    })
    console.log('[serenity-hooks] ✓ 全局入口 skill section 已注册（systemPrompt 就绪）')
  } catch (err) {
    // 注册失败：显式告警（不再静默）——系统提示词注入是关键能力
    console.error(`[serenity-hooks] ✗ 全局入口 skill section 注册失败: ${(err as Error).message}（检查 inject 是否含 systemPrompt）`)
  }
}

/**
 * agent 级 scoped 注册（P0-1：抗 preset/动态插件同名 shadow）。
 *
 * 为什么 scoped：DSH 的 systemPrompt section 支持 scoped 层同名 shadow 全局
 * （agent.ctx.systemPrompt.section），且 scope 链最近层胜出。若 ACC 只注册全局
 * section，preset 或动态 Cordis 插件可在 scoped 层注册同名 `serenity-entry`
 * 遮蔽 ACC 身份。scoped 注册在 agent 自身层 = 最近层，任何外部组合无法覆盖。
 * 全局注册保留为 fallback（未走 session-start 的 agent / 冷恢复路径）。
 *
 * text 回调闭包持有 root 与 agent：content 固定（该 agent 的 CCC 身份），
 * code-mode 适配按装配 context.scope 判断（与全局版一致）。
 */
const sectionedAgents = new Set<string>()

export function registerEntrySkillSection(agent: Agent, root: string): boolean {
  const key = (agent.session as { id?: string }).id ?? 'global'
  if (sectionedAgents.has(key)) return false
  try {
    const scope = (agent.session as { id?: string }).id ?? DEFAULT_SESSION_SCOPE
    agent.ctx.systemPrompt.section({
      name: 'serenity-entry',
      order: -50,
      text: (context) => {
        const base = serenitySystemPrompt(root, scope)
        const codeLine = codeModeAdaptationLine(agent.ctx, context.scope)
        return codeLine ? `${base}\n${codeLine}` : base
      },
    })
    sectionedAgents.add(key)
    return true
  } catch {
    return false
  }
}
