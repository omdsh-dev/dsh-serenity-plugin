/**
 * skiff-admin.ts — skiff_admin ACC 工具（F4a'，v1.25.0 实验性，第 12 个工具）
 *
 * 教 CCC 如何定义 Skiff 角色（仿 session 工具 hook-develop-guide 的 SEP 教学模式，
 * 用户拍板 2026-08-28：guide 定义教程 / validate 配置校验 / list 角色摘要）。
 *
 * 归属：ACC 机制工具（教会 + 校验），角色内容仍归 CCC 配置（.opencode/serenity.json skiff.roles）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '../json.js'
import { findSerenityRoot, readHandymanConfig } from '../ccc.js'
import { readSkiffRoles, resolveRoleSystemPrompt, systemPromptSource } from '../skiff-role.js'
import { loadMsmEntries } from '../msm-ops.js'

function agentCwd(exec: { agent?: { session?: { header?: { cwd?: string } } } }): string {
  return exec.agent?.session?.header?.cwd ?? process.cwd()
}

function renderText(value: unknown): ContentBlock[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

/** Skiff 定义教程（核心）：概念 / schema / 认知 MSM 写法 / 双白名单 / 轨迹纪律 / 示例角色 */
export const SKIFF_GUIDE = `═══ Skiff Definition Guide (F4, experimental) ═══

Skiff = 宁静号放出的独立小艇——完整 trajectory（在宁静号内全知全能）的**任意子集角色**。
由本 CCC（.opencode/serenity.json skiff.roles）定义：能力面（双白名单）+ 轨迹纪律子集 + 系统提示词。
dsp 只提供机制（双白名单强制 + 基础提示词 + 调试问答页）；角色内容完全由 CCC 发挥。

── 角色配置 schema ──
  { "skiff": { "roles": {
      "<role-name>": {
        "model": "provider/model",             // 角色模型（CCC 直接指定，无白名单校验；缺省回退 handyman.defaultModel）
        "msms": ["msm-a", "msm-b"],            // MSM 白名单（独立）：acc_msm exec 只能跑这些；register/deregister 必拒；list 只显示这些
        "tools": ["read","grep","glob",...],   // 非 MSM 工具白名单（独立）：白名单外工具一律不可用（guard 强制）
        "trajectory": { "session": false, "keeper": false, "rebuild": false },  // 轨迹纪律子集（缺省全关 = 完全独立）
        // 角色人格/认知边界/风格（CCC 完整定义；dsp 只给基础提示词）
        "systemPromptFile": ".opencode/skiff/<role>.md"   // ★ 推荐：引用 md 文件（相对 CCC 根；超长提示词在 JSON 内嵌不可读）
        // "systemPrompt": "..."                          // 兼容：内嵌字符串仍可用；两者都设时 systemPromptFile 优先
      }
  } } }

── 双白名单语义（全按白名单暴露，白名单外全隐藏）──
  - tools 空 + msms 非空 = 纯 MSM 角色（认知问答典型形态）
  - msms 非空 → acc_msm 工具自动可用（MSM 通道）
  - 白名单外工具即使 DSH 未来新增也自动被挡（guard 按角色判定，不枚举工具名——完备性）

── 认知 MSM 写法（读知识 / 操作能力）──
  - 读知识：脚本读 CCC 内文件（SERENITY_ROOT env 注入）→ 输出答案/摘要（如 cognitive-qa）
  - 操作能力：脚本调用既有家庭工具/服务（SSH/API/文件操作）——角色能力上限 = 白名单 MSM 的实际行为
  - 例：cognitive-qa（读 docs/references 回答）、review-scan（读代码出审查意见）、review-fix（写修复）
  - 注意：MSM 在脚本层执行（bun），文件访问不受 agent 工具面约束——"只读"语义靠 CCC 自写 MSM 自觉

── 轨迹纪律子集（trajectory）──
  - session/keeper/rebuild 默认 false：Skiff 完全独立（不建 SESSION.md、无 keeper 提醒、无 rebuild 压力检测）
  - 开启某项 = 该角色参与对应轨迹机制（如 keeper=true 计分提醒按角色生效）

── 示例角色 ──
  qa-readonly: { "msms": ["cognitive-qa"], "tools": [], "trajectory": {} }
      → 认知问答（仅 MSM 通道，无直接工具，完全独立）
  code-review: { "msms": ["review-scan","review-fix"], "tools": ["read","grep","glob","write","edit"], "trajectory": { "keeper": true } }
      → 有操作能力（可写修复），参与 keeper 轨迹机制

── 运行 ──
  调试：设置面板「Serenity」页 Skiff 区块开启 → http://127.0.0.1:<debugPort> 问答页实测
  ACP 程序化面（v1.26.0）：设置面板「ACP」区块开启 → HTTP JSON-RPC 端点（默认 3100）——
    POST /  {jsonrpc, id, method, params}
    session/new {ccc, role, sessionId?}  → 创建/延续会话（sessionId 可选=进程内追问）
    session/prompt {sessionId, question} → {answer, trajectory}
    session/cancel / session/close / session/list / request_permission（恒 allow）
  启停 = 人工（设置面板开关，不随插件加载自动启动）；未开启零资源占用
  生效机制：角色配置**实时读取**（改 .opencode/serenity.json → 刷新调试页即生效）；
  改配置后用 skiff_admin apply 做显式校验 + 应用确认（绑定 CCC + 角色清单）
  会话追问（v1.25.10）：调试页持有当前会话，追问自动续接（同会话上下文延续）；
  「新对话」按钮开新会话；进程重启后旧会话不可续（WebUI 仍可见历史）
  注意：skill 加载对 skiff **恒可用**（不设白名单——读知识面，无写能力）`

/** 校验当前 CCC 的 skiff 配置：roles schema 合法 / msms 均已注册 / model ∈ handyman.models / systemPrompt 非空 */
export function validateSkiffConfig(root: string): JsonValue {
  const roles = readSkiffRoles(root)
  const issues: string[] = []
  if (roles.size === 0) {
    return { ok: true, issues: [], roleCount: 0, note: 'no skiff roles defined (skiff disabled — zero impact)' }
  }
  const registered = new Set(loadMsmEntries(root).map((e) => e.name))
  const hc = readHandymanConfig(root)
  const allowedModels = hc ? new Set(hc.models) : null
  for (const [name, role] of roles) {
    // v1.25.10：systemPrompt 来源解析——systemPromptFile（推荐）缺失/逃逸 → issue；
    // 两者都无 → issue（CCC 应完整定义角色人格）
    try {
      if (!resolveRoleSystemPrompt(root, role).trim()) {
        issues.push(`role "${name}": system prompt is empty (define systemPromptFile (recommended) or systemPrompt)`)
      }
    } catch (err) {
      issues.push(`role "${name}": ${String((err as Error)?.message ?? err)}`)
    }
    for (const m of role.msms ?? []) {
      if (!registered.has(m)) issues.push(`role "${name}": msms "${m}" is not registered in mech-registry.json`)
    }
    if (role.model && allowedModels && !allowedModels.has(role.model)) {
      issues.push(`role "${name}": model "${role.model}" not in handyman.models (${[...allowedModels].join(', ') || '(none)'})`)
    }
  }
  return { ok: issues.length === 0, issues, roleCount: roles.size }
}

/** 列出当前 CCC 已定义角色（名 / 模型 / msms / tools / 轨迹纪律摘要） */
export function listSkiffRoles(root: string): JsonValue {
  const roles = readSkiffRoles(root)
  if (roles.size === 0) {
    return { roles: [], note: 'no skiff roles defined (skiff disabled)' }
  }
  const items = [...roles.entries()].map(([name, role]) => ({
    name,
    model: role.model ?? '(handyman default)',
    msms: role.msms ?? [],
    tools: role.tools ?? [],
    trajectory: {
      session: role.trajectory?.session === true,
      keeper: role.trajectory?.keeper === true,
      rebuild: role.trajectory?.rebuild === true,
    } satisfies Record<string, boolean>,
    promptSource: systemPromptSource(role),
    ...(role.systemPromptFile ? { systemPromptFile: role.systemPromptFile } : {}),
  }))
  return { roles: items, count: items.length }
}

/**
 * 应用当前 skiff 配置（v1.25.3，S142 用户：改了 json 应该有个生效机制）。
 *
 * 语义：配置是**每次请求实时读取**的（v1.25.2）——apply 不是"推送"，而是**显式校验 + 应用确认**：
 * ① 校验配置合法（复用 validate：msms 注册 / model 白名单 / systemPrompt 非空）
 * ② 非法 → 报告问题清单，不应用（提示修复后重跑 apply）
 * ③ 合法 → 应用确认：绑定 CCC + 角色清单 + 说明（调试页刷新即生效）
 */
export function applySkiffConfig(root: string): JsonValue {
  const validation = validateSkiffConfig(root) as { ok: boolean; issues: string[]; roleCount: number }
  const roles = readSkiffRoles(root)
  if (!validation.ok) {
    return {
      applied: false,
      cccRoot: root,
      roleCount: roles.size,
      issues: validation.issues,
      hint: 'fix the issues above, then run skiff_admin apply again',
    }
  }
  return {
    applied: true,
    cccRoot: root,
    roleCount: roles.size,
    roles: [...roles.keys()],
    note: 'roles are read live from .opencode/serenity.json — the skiff debug page reflects changes on refresh; skill loading is always available to skiff sessions (not whitelisted)',
  }
}

export const skiffAdminTool = defineTool({
  name: 'skiff_admin',
  description:
    'Skiff (F4, experimental): CCC cognitive-subset roles (subsets of the full serenity trajectory). guide: definition tutorial (concept/role schema/cognitive MSM writing/dual whitelist/trajectory subset/examples); validate: check the CCC skiff config (roles schema legal / msms registered / model in handyman.models / system prompt resolvable — systemPromptFile (recommended) or systemPrompt non-empty); apply: validate then confirm the config is live (bound CCC + role list; roles are read live on every request); list: role summary (name/model/msms/tools/trajectory/prompt source). Roles are defined by the CCC in .opencode/serenity.json skiff.roles; skill loading is always available to skiff sessions (not whitelisted).',
  parameters: {
    action: {
      type: 'string',
      enum: ['guide', 'validate', 'apply', 'list'],
      required: true,
      description: 'Subcommand: guide (definition tutorial) / validate (config check) / apply (validate + confirm live) / list (role summary)',
    },
  },
  output: {
    schema: { type: 'json' },
    render: (args, value) => renderText(value),
  },
  async execute(args, exec): Promise<JsonValue> {
    const root = findSerenityRoot(agentCwd(exec))
    if (!root) throw new Error('No CCC found: no .serenity file from agent cwd')
    const action = args.action as 'guide' | 'validate' | 'apply' | 'list' | undefined
    switch (action) {
      case 'guide':
        return { guide: SKIFF_GUIDE }
      case 'validate':
        return validateSkiffConfig(root)
      case 'apply':
        return applySkiffConfig(root)
      case 'list':
        return listSkiffRoles(root)
      default:
        throw new Error('skiff_admin requires action: guide | validate | apply | list')
    }
  },
})
