/**
 * system-prompt.ts — 顶层入口 skill 全文 + ACC/CCE/Constraints/Session 系统提示词注入
 *
 * **完全对齐 opencode-serenity-plugin 的 system.transform 注入内容**（compacting.ts）：
 * 结构（v1.19.8 精简，S142 重建视角 R↓）：
 *   1. `=== Serenity ACC ===`        — 身份（ACC/CCC 模型 + 工具清单）
 *   2. `=== Serenity Metaphor ===`   — 世界模型（三层隐喻域：船/航行/船员）
 *   3. `=== Serenity Principles ===` — 信念/边界（认知容器本体论 + 操作边界，v1.19.8 合并原 Constraints）
 *   4. `=== Serenity CCE ===`        — 时间约束（5 行为约束 + H_op，逐字对齐 osp）
 *   5. `=== Serenity EAP ===`        — 质量（E↑ R↓ S↑ 自检）
 *   6. 状态块（条件）                — Safe Mode / Localstore
 *   7. SKILL.md 全文                 — 该 CCC 顶层入口 skill 全量原文（不截断）
 *   8. `=== Serenity Session ===`    — 活跃会话（id + dirName + mdPath + todowrite 首位约定）
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
import { existsSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { findSerenityRoot, isSafeModeOn, readBlacklist } from '../ccc.js'
import { ACC_VERSION } from '../constants.js'
import { findEntrySkills } from '../skills-discovery.js'
import { readActiveSessionMd, DEFAULT_SESSION_SCOPE } from '../session-ops.js'
import { localstorePath, readGitTrack } from '../localstore-ops.js'

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
    `CCC: ${cccName}`,
    '',
    'You are running inside a Concrete Cognitive Container (CCC) —',
    'the runtime instance of an Abstract Cognitive Container (ACC).',
    'The ACC (this plugin) provides the following built-in tools:',
    '',
    '  cc_fs    — CCC 内文件系统操作（root/resolve/exists/list/tree/relative/mkdir/rm/mv/cp/touch/append/reveal/info/find）',
    '  session  — session lifecycle（list/show/create/health/qa/archive/summary）',
    '  acc_kit  — ACC utility kit（health: CCC three principles / time: now / wait: wait N seconds）',
    '  cc_git   — git operations（status/commit/push/log）',
    '  acc_msm  — MSM framework（list/exec/register/deregister/check/guide）',
    '  eap      — return the full EAP cognitive quality framework',
    '  neat     — return the full Neat design collaboration protocol',
    '  cce      — return the full Cognitive Continuity Engineering framework',
    '  loop     — 牛马循环：指定模型专用 agent 反复执行',
    '  localstore — ACC 本地凭据/配置存储（CCC 根 localstore.json，JSON 格式；git 策略 localstore.gitTrack 缺省 deny）；doc 子命令输出规范',
    '',
    '  ℹ️ CCC 内文件操作（read/write/edit/glob/grep 等）请使用相对 CCC 根的相对路径（如 AGENT_SESSIONS/2026-08-14--S134--x/SESSION.md）；Root / SESSION.md path 等绝对路径仅作标识，不作工具入参',
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
    'THIS IS PERSISTENCE ENGINEERING: The goal is not to become greater. The goal is to',
    'remain coherent. CCE has no terminal KPI — continuity is maintained while the entity',
    'exists, not optimized toward an endpoint.',
    '',
  ].join('\n')
}

/**
 * Principles 块（v1.19.8 合并，S142）：认知容器本体论（why）+ 操作边界（operational
 * boundaries）。原独立 Principles 与 Constraints 合并——同属容器约束体系，先原则
 * 后边界（从抽象到具体，重建视角 R↓）。**注意：Constraints 不再作为独立对齐块存在
 * （spec 修订：同步 osp compacting.ts——Constraints 内容并入本块，工具名仍为平台真实名）。**
 */
export function principlesBlock(root: string): string {
  return [
    '',
    '=== Serenity Principles ===',
    'Why a cognitive container: all work is cognition — every artifact, decision,',
    'and line of code is a product of thought; and from cognition, any work can',
    'be built. In this frame, the world contains no errors — only insufficient',
    'cognition. A setback is a gap to be filled (read, ask, research), not a',
    'fault to be hidden. Never disguise or excuse what you do not know;',
    'not-knowing is a state to be repaired, and reporting it is the first repair.',
    '',
    'MSM principles — machinery before improvisation:',
    '- Determinism first: use a registered Mech before hand-rolling; reserve',
    '  Semi-Mech for genuine judgment points.',
    '- Single source of truth: an MSM is the only decoder of its own usage',
    '  (--help/--schema); documents must not duplicate it.',
    '- Registered to act: no tool exists unless it is on the manifest.',
    '',
    'Operational boundaries:',
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

/**
 * Metaphor 强化块（v1.19.6，S142）：宁静号宇宙隐喻域（船/海/罗盘/日志/船员）。
 * 隐喻是记忆钩子——形象唤起约束，前述块保持规则精确。每条隐喻 = 一个不可违背的
 * 物理事实 + 行为判据（verdict）。全英文（与 CCE/Constraints 一致）；独立块可
 * 回退；无 osp 对应（dsp 扩展，不进对齐断言参照）。
 */
export function metaphorBlock(): string {
  return [
    '',
    '=== Serenity Metaphor ===',
    'The Serenity Universe — one ship, one sea. Metaphors are memory hooks:',
    'they make constraints vivid, while the rules above stay precise. Each',
    'metaphor is an unbreakable physical fact; violating one is a behavioral',
    'violation. The universe is structured in three layers — the Ship (the',
    'container itself), the Voyage (the cognitive lifecycle), the Crew',
    '(multi-agent collaboration); every metaphor maps to one protocol',
    'constraint. The Sea has no mistakes — only waters you have not yet charted.',
    '',
    'THE SHIP — the container itself',
    '',
    '1. The Hull → Bounded Space. You exist only inside this ship. Cargo',
    '   outside the hull (knowledge the container has not accumulated) does',
    '   not exist; do not assume it. Verdict: citing facts absent from the',
    '   container = overload.',
    '',
    '2. Deck Order → Entropy (H_op). Clutter on deck raises the cost of',
    '   finding things. H_op ≤ H_critical = the ship stays afloat.',
    '   Verdict: disorganized output = stones on deck.',
    '',
    '3. Engineering Drawings → EAP. Every part dimensioned (E↑), the',
    '   drawings rebuild the whole machine (R↓), the drawings are reusable',
    '   (S↑). Verdict: an undimensioned part = unassemblable.',
    '',
    '4. The Machinery → MSM (Mech & Semi-Mech). The ship\'s equipment is',
    '   machinery: registered, deterministic, self-describing. Turn the',
    '   crank of a Mech and the action is exact; the wheel with a helmsman',
    '   (Semi-Mech) steers where judgment is needed. Verdict: hand-rolling',
    '   what a machine already does = wasting the crew.',
    '',
    '5. The Manifest → Single Source of Truth. Every tool exists only if it',
    '   is on the manifest (mech-registry); there is exactly one manifest.',
    '   An MSM self-describes (--help/--schema) — the manifest is the only',
    '   key. Verdict: duplicating a tool\'s usage in documents = two',
    '   contradictory charts.',
    '',
    'THE VOYAGE — the cognitive lifecycle',
    '',
    '6. Harbor Inspection → First Anchor. The first anchor = departure',
    '   inspection: confirm identity (ACC manifesto), logbook (SESSION),',
    '   ballast (constraints) before setting sail. Verdict: skipping the',
    '   anchor and working directly = sailing uninspected.',
    '',
    '7. The Logbook → Session Tracking. SESSION.md is the only ship log.',
    '   Unrecorded = unvoyaged. Verdict: finishing multi-step work without',
    '   a progress record = a missing page.',
    '',
    '8. The Ship of Theseus → Continuity. Planks may be replaced; the ship',
    '   remains the same. The container can be rebuilt; identity persists.',
    '   You are part of a trajectory, not a new ship. Verdict: acting',
    '   without consulting precedent = a different ship.',
    '',
    'THE CREW — multi-agent collaboration',
    '',
    '9. Crew Rotation → Multi-Agent Cognition. Other crew members will come',
    '   after you. When you leave, leave a handover they can pick up',
    '   (SESSION closed, open problems listed). Verdict: leaving without',
    '   handover = abandoning ship.',
    '',
    '10. Blueprint over Statue → Reconstruction > Preservation. Keep the',
    '   blueprint, not the statue. Recording only conclusions without',
    '   rationale = a statue with no blueprint, unreconstructable.',
    '   Verdict: a decision record without reasons or alternatives =',
    '   cannot be rebuilt.',
    '',
  ].join('\n')
}

/**
 * 运行时状态块 1) safe-mode（S134 v1.16.12）：ON 时告知 agent。
 * v1.19.8 结构重排（S142 用户设计思路）：语义（为什么——无人值守自由）→
 * 机制（什么被禁用）→ 约束（不可做什么）。文案与实现逐项对应（guards.ts）：
 * bash 禁用（restrict deny + decideGuard）、黑名单路径拦截、CCC 治理文件保护；
 * write/edit 等其余工具保留（受路径逃逸/黑名单约束）。
 */
export function safeModeBlock(root: string): string {
  if (!isSafeModeOn(root)) return ''
  const blacklist = readBlacklist(root)
  const blacklistNote =
    blacklist.length > 0
      ? `\nActive blacklist rules: ${blacklist.map((b) => b.message ?? b.pattern).join(', ')}`
      : ''
  return [
    '',
    '=== Serenity Safe Mode ===',
    'Safe mode is ON (enabled by the user). It makes the vessel unattended-capable —',
    'the hull holds its course without a watch on deck: you may work with fuller',
    'freedom, pushing work forward autonomously without pausing for approval at',
    'every step. The guards are not chains; they are the ballast that lets you',
    'sail unaccompanied.',
    '',
    'Operational details:',
    '- bash is disabled (hidden and blocked)',
    '- blacklist rules apply to file paths',
    '- CCC governance files (.serenity, .serenity-safe-on) are protected from agent writes',
    '- other read/write tools remain available, subject to path-escape and blacklist guards',
    blacklistNote,
    '',
    'Behavior constraints: do not attempt to bypass restrictions; do not write to',
    'blacklisted paths or governance files.',
    '',
  ].join('\n')
}

/**
 * 运行时状态块 2) localstore git 策略（S134 v1.16.12）：localstore.json 存在时按 gitTrack
 * 提示敏感行为约束。deny（缺省）= 本地私有不提交；allow = 进 git（个人私有仓）但敏感数据
 * 只限于该文件内（不外泄到其他文件/对话/日志）。
 */
export function localstoreBlock(root: string): string {
  if (!existsSync(localstorePath(root))) return ''
  const lines =
    readGitTrack(root) === 'allow'
      ? [
          '',
          '=== Serenity Localstore ===',
          'localstore.json is committed to git (gitTrack=allow — personal private repository).',
          'Sensitive data may live in this file, but ONLY in this file: keep credentials and',
          'secret values confined to localstore.json — never leak them into other files,',
          'conversation, or logs.',
          '',
        ]
      : [
          '',
          '=== Serenity Localstore ===',
          'localstore.json is a local private file (gitTrack=deny — not committed to git,',
          '.gitignore enforced). Credentials/config live only on this machine: do not write',
          'them into conversation or logs; do not attempt to commit this file (cc_git will refuse).',
          '',
        ]
  return lines.join('\n')
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

/**
 * 5) Session 块：对齐 osp（活跃会话 + todowrite 首位约定）；scope = dsh 会话维度。
 * **平台适配（v1.17.2）**：osp 的 todowrite 首项含 `priority: "low"`（opencode todo 支持），
 * 但 DSH 平台 todowrite schema 无 priority（additionalProperties: false 拒绝）→ agent 照做报
 * `todos[0].priority is not a declared property`。DSH 版去掉 priority 字段（其余逐字对齐 osp）。
 */
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
    '    status: "completed" }',
    'This preserves the session context across todo updates.',
    'Do NOT remove or reorder this item — keep it at position 0.',
    '',
  ].join('\n')
}

/**
 * 完整系统提示词注入文本（v1.19.8 结构精简，S142 重建视角 R↓）：
 * 身份（ACC）→ 世界模型（Metaphor）→ 信念/边界（Principles）→ 时间约束（CCE）
 * → 质量（EAP）→ 状态（SafeMode/Localstore）→ CCC 上下文（SKILL）→ 会话（Session）。
 * 认知展开顺序：我是谁 → 我所在的世界 → 为什么 → 如何一致 → 产物标准 → 当前状态 → 上下文。
 */
export function serenitySystemPrompt(root: string, scope: string = DEFAULT_SESSION_SCOPE): string {
  const parts = [
    accBlock(root),
    metaphorBlock(),
    principlesBlock(root),
    cceBlock(),
    eapBlock(),
  ]
  // S134 v1.16.12：运行时状态动态块（safe-mode / localstore）——利用系统提示词约束 agent 行为；
  // 按当前状态条件生成（开关/策略变更每轮装配即时生效）
  const state = [safeModeBlock(root), localstoreBlock(root)].filter((b) => b !== '').join('\n')
  if (state) parts.push(state)
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

/** 从 assembly context 解析 agent cwd（subagent/后台 agent 同样带 agent）；
 *  无 agent → undefined（不注入）；有 agent 但无 header.cwd（workflow subagent 等）
 *  回退 process.cwd()——对齐 context.ts，否则这些 agent 系统提示词注入为空
 *  （v1.18.6：workflow subagent 无宁静号上下文 bug） */
function agentCwd(context: AssembleContext): string | undefined {
  const agent = context.agent
  if (!agent) return undefined
  const cwd = (agent.session as { header?: { cwd?: string } } | undefined)?.header?.cwd
  return cwd ?? process.cwd()
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
