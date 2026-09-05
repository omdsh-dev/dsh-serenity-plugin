/**
 * guards.ts — 拦截缝：安全模式 + 路径守卫（P3 语义的机械层）
 *
 * 纯决策逻辑（decideGuard）与 DSH 注册（registerGuards）分离：
 * 前者零 DSH 依赖可单测，后者把决策接到 tools/pre-execute 瀑布 + ctx.tools.guard 终局。
 *
 * 对应 opencode-serenity-plugin 的 tool.execute.before 路径守卫 + bash 开关 + 黑名单。
 */

import { resolve, relative } from 'node:path'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import type { Context } from 'cordis'
import type { ToolExecution, PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  findSerenityRoot,
  isSafeModeOn,
  matchBlacklist,
  readBlacklist,
  pathInside,
  readCccName,
  type BlacklistRule,
} from '../ccc.js'
import { isSkiffSessionId, roleToolWhitelist, readSkiffRoles } from '../skiff-role.js'
import { skiffRoleFor } from '../skiff-registry.js'

// ── 纯决策（可单测）──

export interface GuardInput {
  root: string
  toolName: string
  safeModeOn: boolean
  blacklist: BlacklistRule[]
  /** 工具参数中可能携带的路径（write/edit 等）；无则 undefined */
  pathArg?: string
  /** cc_fs 等复合工具的子命令 action（只读子命令不查黑名单） */
  action?: string
  /** 当前 agent 的 dsh 会话 id（Skiff 角色白名单判定；非 skiff 会话不判定） */
  skiffSessionId?: string
}

/** 写类工具名（黑名单/治理文件只拦这些；读工具只做路径越界检查——对齐 osp） */
const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor', 'cc_fs', 'bash', 'append', 'touch'])

/** cc_fs 的写类子命令（mkdir/rm/mv/cp/touch/append）；其余 9 子命令（root/resolve/exists/
 *  list/tree/relative/reveal/info/find）为只读——只读子命令不查黑名单（同 read 语义） */
const CC_FS_WRITE_ACTIONS = new Set(['mkdir', 'rm', 'mv', 'cp', 'touch', 'append'])

/**
 * 凭据文件硬名单（数据面守卫，v1.26.3，S142 用户：localstore.json 需要在 read 工具的黑名单里）：
 * **任何工具**（含 read/grep/glob/cc_fs 只读子命令）命中这些相对 CCC 根的路径 → deny。
 *
 * 与 safeMode.blacklist（写黑名单，v1.18.5 决策只拦写）语义独立：
 * - 黑名单 = 用户可配置的写保护（REPOSITORIES/ 等只读参考源不误伤读）
 * - 凭据硬名单 = **结构性数据面边界**（不依赖 safe-mode 开关，凭据文件任何时候不可读）——
 *   对齐 CCE Bounded Space + wardn "structural guarantee, not policy"：localstore.json
 *   含 API keys/tokens/SSH 密码，即使 prompt 纪律失败也无值可吐（机械保证）。
 */
export const SENSITIVE_CREDENTIAL_FILES = new Set(['localstore.json'])

/**
 * MSM 注册表写保护（需求⑤b S142 用户拍板："msm注册的文件需要写保护起来，避免CCC意外写坏搞崩自己"）：
 * mech-registry.json 是 CCC 执行层地基（坏 → loadMsmEntries 抛 → acc_msm/skiff/output-guard 全崩，
 * register 也崩 → 自锁）。**写 deny、读 allow**（与 localstore 读 deny 语义区分 R6——注册表是
 * 结构核心不是秘密，需被 output-guard/skiff-admin 读取建 MSM 词表）。
 *
 * 单级化（需求⑤a）后**唯一合法注册表 = cccName 聚合档**
 * `.opencode/skills/<cccName>/references/mech-registry.json`（cccName = .serenity 首行）。
 * 历史 root 级 `mech-registry.json` 与各 skill 分散注册表已废弃：**不再保护**
 * （review P1：保护一个永不被读的文件 = 死锁——MSM 既不可见又不可删/迁移）。
 * 写工具命中聚合档 → deny（唯一合法写通道 = acc_msm register/deregister 内部 writeRegistry，
 * 走工具实现不经 pre-execute → 天然豁免）；读工具放行。
 */
export function isProtectedRegistryRel(root: string, rel: string): boolean {
  const lower = (s: string): string => (process.platform === 'win32' ? s.toLowerCase() : s)
  const relCi = lower(rel)
  // cccName 聚合档：.opencode/skills/<cccName>/references/mech-registry.json
  // 注：大小写比较按平台（win32 不敏感 / posix 敏感）——review P2-1：Linux 大写 CCC 名不得误放行
  // cccName 解析统一走 ccc.ts readCccName（review P2-2：跳过 # 注释/空行首非空行，四处单源）
  try {
    const marker = resolve(root, '.serenity')
    if (existsSync(marker)) {
      const line = readCccName(root)
      if (line) {
        const aggregate = `.opencode/skills/${line}/references/mech-registry.json`
        const aggregateCi = lower(aggregate)
        if (relCi === aggregateCi) return true
        // review P2-2：精确文件保护可被 `rm -r references/`（删父目录）绕过——
        // **references/ 目录本身**纳入保护（rm -r references/ 即毁注册表）。
        // review P1-1（复验收窄）：只保护 references/ **目录节点本身**（rm -r / mv 目录 deny），
        // **不含子树前缀**——references/ 内与 mech-registry.json 并置的合法知识文档
        // （msm-writing-standards.md 等，home-serenity 实测 8 个）必须可正常维护。
        // 防绕过语义 = 目录节点相等已足够（删目录 rm -r/mv 目标恰是 references/ 自身）；
        // 前缀会把"删目录"放大成"子树内任何写"= 过保护（复验 P1-1，09-05）。
        const refsDir = `.opencode/skills/${line}/references`
        if (relCi === lower(refsDir)) return true
      }
    }
  } catch {
    /* 读标记失败 → 无法定位聚合档 → 不保护（保守放行删除，避免死锁） */
  }
  // root 级 + 其他 skill 目录分散注册表 = 废弃形态：不保护（允许删除/迁移）
  return false
}

/** 判定工具是否为读类（read/grep/glob + cc_fs 只读子命令）：凭据文件对读工具同样 deny */
export function isReadTool(toolName: string, action?: string): boolean {
  if (toolName === 'read' || toolName === 'grep' || toolName === 'glob') return true
  if (toolName === 'cc_fs') return action !== undefined && !CC_FS_WRITE_ACTIONS.has(action)
  return false
}

/** 判定工具是否为写类：普通工具按名；cc_fs 复合工具按子命令 action */
export function isWriteTool(toolName: string, action?: string): boolean {
  if (!WRITE_TOOLS.has(toolName)) return false
  if (toolName === 'cc_fs') return action !== undefined && CC_FS_WRITE_ACTIONS.has(action)
  return true
}

export interface GuardDecisionResult {
  deny?: string
  kind: 'allow' | 'deny'
}

/**
 * 安全模式 + 黑名单 + P3 路径守卫的纯决策。
 * 对齐 opencode-serenity-plugin 标准：安全模式 = **bash 禁用** + 写入黑名单；
 * write/edit 等工具仅受路径逃逸与黑名单约束（不整体禁用）。
 * 优先级：safe-mode bash > 路径越界 > 黑名单命中。
 */
export function decideGuard(input: GuardInput): GuardDecisionResult {
  const { root, toolName, safeModeOn, blacklist, pathArg, action } = input

  // 0) Skiff 角色白名单（F4b ⑧）：skiff 会话工具必须 ∈ 角色白名单（tools ∪ acc_msm），
  // 白名单外一律 deny（拒绝信息泛化——不泄漏白名单外工具名；完备性：不枚举工具名）。
  // 由调用方（evaluate）传入 sessionId 判定；纯函数内通过 GuardInput.skiffSessionId 支持单测。
  // v1.25.3：skill 加载对 skiff 恒可用（S142 用户——skill 不设白名单；读知识面，无写能力）
  if (input.skiffSessionId !== undefined && isSkiffSessionId(input.skiffSessionId)) {
    if (toolName === 'skill') return { kind: 'allow' }
    const roleName = input.skiffSessionId ? skiffRoleFor(input.skiffSessionId) : null
    const role = roleName ? readSkiffRoles(root).get(roleName) : undefined
    const whitelist = roleToolWhitelist(role)
    if (!whitelist.has(toolName)) {
      return { deny: 'tool not allowed in this skiff role', kind: 'deny' }
    }
  }

  // 1) 安全模式：bash 一律禁用（标准语义）
  // 提示不泄露 safe-mode 机制（safe-mode 对 agent 不可见）：模型视角 = bash 工具不存在
  if (safeModeOn && toolName === 'bash') {
    return { deny: `bash: no such tool`, kind: 'deny' }
  }

  // 2) 携带路径参数：先查越界（读写都拦——安全），再查治理文件/黑名单（仅写类工具，对齐 osp）
  if (pathArg !== undefined) {
    const abs = resolve(root, pathArg)
    // pathInside 前缀+sep 边界+跨盘安全（Windows 兼容：跨盘 relative 返回绝对路径原文，
    // 旧 relative().startsWith('..') 漏判，见 Windows 审计问题 6）
    if (!pathInside(resolve(root), abs)) {
      return { deny: `path escape blocked: "${pathArg}" escapes the CCC root`, kind: 'deny' }
    }
    // 归一化反斜杠（Windows）：凭据文件硬名单与黑名单前缀匹配用正斜杠 rel
    const rel = relative(root, abs).split('\\').join('/')
    // 2a) 凭据文件硬名单（数据面守卫，v1.26.3）：**任何工具**命中 localstore.json →
    //     deny（不依赖 safe-mode 开关、不看工具读写性——凭据文件不可读是结构边界；
    //     read/grep/glob/cc_fs 只读子命令与写工具一视同仁，防凭据值进上下文）
    if (SENSITIVE_CREDENTIAL_FILES.has(rel)) {
      return { deny: `access blocked: "${pathArg}" is a sensitive credential file (${rel})`, kind: 'deny' }
    }
    // 读操作（read/glob/grep 等）不查黑名单/治理文件——对齐 osp（permission-guards 只在
    // write/edit 时查黑名单）；否则 REPOSITORIES/ 这类"只读参考源"黑名单会误伤读操作
    // （用户实测：读 REPOSITORIES/ 下 repo 被拦，见 v1.18.5；cc_fs 只读子命令同语义）
    if (isWriteTool(toolName, action)) {
      // CCC 治理文件永远拒绝写入（safe-mode 是用户能力，agent 不能自行开关/篡改）
      if (rel === '.serenity-safe-on' || rel === '.serenity' || rel.startsWith('.serenity-safe-on/') || rel.startsWith('.serenity/')) {
        return { deny: `CCC governance file "${rel}" is reserved for the user — agent must not write`, kind: 'deny' }
      }
      // 需求⑤b：MSM 注册表写保护（写 deny 读 allow）——acc_msm register/deregister 是唯一合法写通道
      // review P2-2：保护范围含聚合档祖先目录（rm -r references/ / mv references/ 同拦）
      if (isProtectedRegistryRel(root, rel)) {
        const isFile = rel.endsWith('/mech-registry.json')
        return {
          deny: isFile
            ? `mech-registry.json is ACC-managed (${rel}) — use acc_msm register/deregister instead of writing it directly`
            : `"${rel}" is an ancestor of the ACC-managed mech-registry.json — removing/moving it would destroy the registry; the registry is managed by acc_msm register/deregister`,
          kind: 'deny',
        }
      }
      const hit = matchBlacklist(rel, blacklist)
      if (hit) {
        // 对象条目支持自定义提示（对齐 osp：{ pattern, message } → message ?? 默认）
        return { deny: hit.message ?? `blacklist blocked: "${pathArg}" matches rule "${hit.pattern}"`, kind: 'deny' }
      }
    }
  }

  return { kind: 'allow' }
}

// ── DSH 注册 ──

/** 从 exec 提取 agent 会话 cwd（CCC 根检测基准）；无则回退进程 cwd */
function resolveAgentCwd(exec: ToolExecution): string {
  const agent = (exec as { agent?: { session?: { header?: { cwd?: string } } } }).agent
  return agent?.session?.header?.cwd ?? process.cwd()
}

/** 安全模式开启时从模型工具列表隐藏的工具（只隐藏 bash；write/edit 保留） */
const SAFE_MODE_DENY_TOOLS = ['bash']

/** agent key → restrict disposer（安全模式工具隐藏状态） */
const safeModeRestrictions = new Map<string, () => void>()

/** restrict 诊断状态（status API 暴露；排查 restrict 未生效问题） */
export interface RestrictDiagnostics {
  lastKey: string | null
  lastAttemptAt: string | null
  lastSuccess: boolean | null
  lastError: string | null
  activeKeys: string[]
}

const restrictDiag: RestrictDiagnostics = {
  lastKey: null,
  lastAttemptAt: null,
  lastSuccess: null,
  lastError: null,
  activeKeys: [],
}

export function getRestrictDiagnostics(): RestrictDiagnostics {
  return { ...restrictDiag, activeKeys: [...safeModeRestrictions.keys()] }
}

/** 诊断落盘：AGENT_SESSIONS/.restrict-diag.json（文件通道，避免 HTTP 自锁） */
function writeRestrictDiag(root: string): void {
  try {
    const dir = resolve(root, 'AGENT_SESSIONS')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      resolve(dir, '.restrict-diag.json'),
      JSON.stringify({ ...getRestrictDiagnostics(), cccRoot: root }, null, 2) + '\n',
      'utf-8',
    )
  } catch {
    /* 诊断写盘失败忽略 */
  }
}

/**
 * 同步安全模式工具隐藏：标记存在 → agent.ctx.tools.restrict deny 隐藏写工具；
 * 标记消失 → 解除。pre-step 每步调用 → 切换实时生效。
 */
export function syncSafeModeRestriction(agent: Agent, root: string): void {
  const key = (agent.session as { id?: string }).id ?? 'global'
  const on = isSafeModeOn(root)
  const existing = safeModeRestrictions.get(key)
  if (on && !existing) {
    try {
      const dispose = agent.ctx.tools.restrict({ deny: [...SAFE_MODE_DENY_TOOLS] })
      safeModeRestrictions.set(key, dispose)
      restrictDiag.lastKey = key
      restrictDiag.lastAttemptAt = new Date().toISOString()
      restrictDiag.lastSuccess = true
      restrictDiag.lastError = null
    } catch (e) {
      restrictDiag.lastKey = key
      restrictDiag.lastAttemptAt = new Date().toISOString()
      restrictDiag.lastSuccess = false
      restrictDiag.lastError = (e as Error).message
      console.error(`[serenity-hooks] restrict 失败 (key=${key}):`, (e as Error).message)
      /* 限制失败不阻断（守卫仍兜底拦截） */
    }
  } else if (!on && existing) {
    try {
      existing()
    } catch (e) {
      console.error(`[serenity-hooks] restrict 解除失败 (key=${key}):`, (e as Error).message)
    }
    safeModeRestrictions.delete(key)
  }
  writeRestrictDiag(root)
}

/**
 * 从 exec 参数中提取常见路径字段（write/edit 工具）；宽松读取。
 * cc_fs 复合工具：path（单路径）/ paths（数组）/ src / dst——取第一个命中（越界检查
 * 逐路径由 decideGuard 单 pathArg 覆盖；多路径字段取首个，避免漏检主体路径）。
 */
function extractPathArg(exec: ToolExecution): string | undefined {
  const args = exec.arguments
  if (args === null || typeof args !== 'object') return undefined
  const a = args as Record<string, unknown>
  for (const key of ['path', 'file_path', 'target', 'src', 'dst']) {
    const v = a[key]
    if (typeof v === 'string') return v
  }
  const paths = a['paths']
  if (Array.isArray(paths) && paths.length > 0 && typeof paths[0] === 'string') return paths[0]
  return undefined
}

/** 从 exec 参数提取 cc_fs 子命令 action；无则 undefined */
function extractAction(exec: ToolExecution): string | undefined {
  const args = exec.arguments
  if (args === null || typeof args !== 'object') return undefined
  const a = args as Record<string, unknown>
  return typeof a.action === 'string' ? a.action : undefined
}

export interface GuardRegistration {
  /** 配置路径；缺省用 DEFAULT_SERENITY_CONFIG_PATHS */
  configPaths?: string[]
}

/**
 * 注册守卫：tools/pre-execute 瀑布 + ctx.tools.guard 终局。
 * 两者都从 CCC 根实时读取配置（无状态、无缓存）。
 */
export function registerGuards(ctx: Context, opts: GuardRegistration = {}): void {
  const configPaths = opts.configPaths

  const evaluate = (exec: ToolExecution): GuardDecisionResult => {
    const cwd = resolveAgentCwd(exec)
    const root = findSerenityRoot(cwd)
    if (!root) return { kind: 'allow' } // 非 CCC，不干预

    const safeModeOn = isSafeModeOn(root)
    const blacklist = readBlacklist(root, configPaths)
    const pathArg = extractPathArg(exec)
    const action = extractAction(exec)
    const sessionId = (exec as { agent?: { session?: { id?: string } } } | undefined)?.agent?.session?.id
    return decideGuard({ root, toolName: exec.name, safeModeOn, blacklist, pathArg, action, skiffSessionId: sessionId })
  }

  // 瀑布：deny 短路执行
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const d = evaluate(exec)
    if (d.deny) return { kind: 'deny', reason: d.deny }
    return next()
  })

  // 终局 guard：只 deny，不可 allow（顺序无关的终局不变式）
  ctx.tools.guard((exec) => {
    const d = evaluate(exec)
    return d.deny
  })
}
