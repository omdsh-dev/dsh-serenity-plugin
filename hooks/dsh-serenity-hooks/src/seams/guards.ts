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
  isSafeModeOn,
  matchBlacklist,
  readBlacklist,
  pathInside,
  readCccName,
  readExclusiveTools,
  readSafeModeHiddenTools,
  type BlacklistRule,
} from '../kernel/ccc.js'
import { cccRootForCwd } from '../kernel/ccc-roots.js'
import { trajectoryConstraintForSession, type TrajectoryConstraint } from '../trajectory/policy/profile.js'
import { profileToolWhitelist, profileWriteWhitelist } from '../trajectory/policy/rules.js'
import { hasEnabledImChannel } from '../im/channels.js'
import { REGISTERED_TOOLS, CONDITIONAL_TOOL_COUNT } from '../kernel/invariant.js'
import { isoLocal } from '../kernel/time.js'

// ── 纯决策（可单测）──

export interface GuardInput {
  root: string
  toolName: string
  safeModeOn: boolean
  blacklist: BlacklistRule[]
  /** 工具参数中可能携带的路径（write/edit 等）；无则 undefined */
  pathArg?: string
  /** container_fs 等复合工具的子命令 action（只读子命令不查黑名单） */
  action?: string
  /**
   * 该会话的 轨迹约束面（`null`/`undefined` = 不是 轨迹约束会话 ⇒ 不判定）。
   *
   * 🔴 2026-10-19 起传**已解析好的约束面**，不传 sessionId：解判据（"这条轨迹有没有
   * `trajectory-constraint.json`"）留在唯一入口 `profile.ts`，守卫只消费结果 ⇒ 纯函数里不再做 IO，
   * 也不可能出现"守卫的判据与 schema 收窄的判据不一致"。
   */
  trajectoryConstraint?: TrajectoryConstraint | null
}

/** 写类工具名（黑名单/治理文件只拦这些；读工具只做路径越界检查——对齐 osp） */
const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor', 'container_fs', 'bash', 'append', 'touch'])

/** container_fs 的写类子命令（mkdir/rm/mv/cp/touch/append）；其余 9 子命令（root/resolve/exists/
 *  list/tree/relative/reveal/info/find）为只读——只读子命令不查黑名单（同 read 语义） */
const CC_FS_WRITE_ACTIONS = new Set(['mkdir', 'rm', 'mv', 'cp', 'touch', 'append'])

/**
 * 凭据文件硬名单（数据面守卫，v1.26.3，S142 用户：localstore.json 需要在 read 工具的黑名单里）：
 * **任何工具**（含 read/grep/glob/container_fs 只读子命令）命中这些相对 CCC 根的路径 → deny。
 *
 * 与 safeMode.blacklist（写黑名单，v1.18.5 决策只拦写）语义独立：
 * - 黑名单 = 用户可配置的写保护（REPOSITORIES/ 等只读参考源不误伤读）
 * - 凭据硬名单 = **结构性数据面边界**（不依赖 safe-mode 开关，凭据文件任何时候不可读）——
 *   对齐 CCE Bounded Space + wardn "structural guarantee, not policy"：localstore.json
 *   含 API keys/tokens/SSH 密码，即使 prompt 纪律失败也无值可吐（机械保证）。
 */
const SENSITIVE_CREDENTIAL_FILES = new Set(['localstore.json'])

/**
 * MSM 注册表写保护（需求⑤b S142 用户拍板："msm注册的文件需要写保护起来，避免CCC意外写坏搞崩自己"）：
 * mech-registry.json 是 CCC 执行层地基（坏 → loadMsmEntries 抛 → container_admin/output-guard 全崩，
 * register 也崩 → 自锁）。**写 deny、读 allow**（与 localstore 读 deny 语义区分 R6——注册表是
 * 结构核心不是秘密，需被 output-guard/trajectory-constraint-admin 读取建 MSM 词表）。
 *
 * 单级化（需求⑤a）后**唯一合法注册表 = cccName 聚合档**
 * `.opencode/skills/<cccName>/references/mech-registry.json`（cccName = .serenity 首行）。
 * 历史 root 级 `mech-registry.json` 与各 skill 分散注册表已废弃：**不再保护**
 * （review P1：保护一个永不被读的文件 = 死锁——MSM 既不可见又不可删/迁移）。
 * 写工具命中聚合档 → deny（唯一合法写通道 = container_admin msm register/deregister
 * 内部 writeRegistry，走工具实现不经 pre-execute → 天然豁免）；读工具放行。
 */
function isProtectedRegistryRel(root: string, rel: string): boolean {
  const lower = (s: string): string => (process.platform === 'win32' ? s.toLowerCase() : s)
  const relCi = lower(rel)
  // cccName 聚合档：.opencode/skills/<cccName>/references/mech-registry.json
  // 注：大小写比较按平台（win32 不敏感 / posix 敏感）——review P2-1：Linux 大写 CCC 名不得误放行
  // cccName 解析统一走 kernel/ccc.ts readCccName（review P2-2：跳过 # 注释/空行首非空行，四处单源）
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

/** 判定工具是否为写类：普通工具按名；container_fs 复合工具按子命令 action */
function isWriteTool(toolName: string, action?: string): boolean {
  if (!WRITE_TOOLS.has(toolName)) return false
  if (toolName === 'container_fs') return action !== undefined && CC_FS_WRITE_ACTIONS.has(action)
  return true
}

interface GuardDecisionResult {
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

  // 0) 轨迹约束 约束（2026-10-19 重做）：会话绑定的轨迹有 `trajectory-constraint.json` ⇒ 工具必须 ∈ 白名单。
  //
  // 判据（D23 归属）：**机制在 ACC**（怎么判、怎么拒），**内容在 CCC**（`trajectory-constraint.json` 的白名单）。
  // 🔴 判据从旧版的「sessionId 前缀 `轨迹约束-`」换成「绑定轨迹有 `trajectory-constraint.json`」——
  //    前缀在新模型下会漏掉不带前缀的 轨迹约束会话，且会把**普通会话误判成 轨迹约束**
  //    （只要 id 恰好以 `轨迹约束-` 开头）。两种误判都是权限面问题，故判据必须打在轨迹上。
  // 由调用方（evaluate）传入 trajectoryConstraint；纯函数内通过 GuardInput 支持单测。
  // v1.25.3：skill 加载对 轨迹约束恒可用（S142 用户——skill 不设白名单；读知识面，无写能力）
  if (input.trajectoryConstraint !== undefined && input.trajectoryConstraint !== null) {
    const profile = input.trajectoryConstraint
    if (toolName === 'skill') return { kind: 'allow' }
    // v1.30.2（S142 用户 bug）：模型把 MSM 名（如 memory-tool）当**直接工具**调 →
    // 旧泛化 deny "tool not allowed" 误导成"没权限"。区分：
    // 工具名命中 msms 清单 = 已授权的 MSM 但调用格式错 → 明确提示经 msm() 单入口。
    // 安全：提示不泄漏白名单外的东西（只说"它是 MSM，请走 msm"）。
    // ⚠️ `msms` 现在可能是 `undefined`（D181：字段缺省 = 不收窄）⇒ 必须先兜空
    if ((profile.msms ?? []).includes(toolName)) {
      return {
        deny: `"${toolName}" is a registered MSM, not a direct tool in this trajectory — call it through the msm tool: msm("${toolName}", ["<args>"]) (pass "--help" or inspect=true for usage)`,
        kind: 'deny',
      }
    }
    // 🔴 D181（owner 2026-10-20 裁「不写当然不收窄」）：`null` = 这条轨迹没限制工具面
    //    ⇒ **不进入白名单判定**（继续走后面的 safe-mode / 路径 / 黑名单检查）。
    //    ⛔ 这里若把 `null` 当空集，会重演 S196 被静默锁死的形态（D179(b)）。
    const whitelist = profileToolWhitelist(profile)
    if (whitelist !== null && !whitelist.has(toolName)) {
      return { deny: 'tool not allowed in this 轨迹约束 trajectory', kind: 'deny' }
    }
    // 🔴 写路径白名单（owner 2026-10-20 令「轨迹设定自己的写白名单」）：
    //    给了 `write` **不等于**放开整个容器 —— `tools` 只管工具名，管不了"写到哪儿"。
    //    判据同 D181：**字段在不在**。缺省 ⇒ 不收窄（`profileWriteWhitelist` 返回 `null`）；
    //    `[]` ⇒ 一个写都落不下（显式意图）。
    //    只判**写类工具**且**带路径参数**的那一半：无路径的写（如 `bash`）由后面的守卫管。
    const writeScopes = profileWriteWhitelist(profile)
    if (writeScopes !== null && pathArg !== undefined && isWriteTool(toolName, action)) {
      const abs = resolve(root, pathArg)
      const inside = writeScopes.some((scope) => pathInside(resolve(root, scope), abs))
      if (!inside) {
        // 出声必须指名缺哪一条（D186/D190 同族）：只报"越界"会让人以为 CCC 根不对
        return {
          deny:
            `${toolName}: write outside this trajectory's declared write scope`
            + ` (allowed: ${writeScopes.length > 0 ? writeScopes.join(' / ') : '(none — "writes" is an empty array)'})`
            + `; target: ${pathArg}`
            + ' — add the prefix to this trajectory\'s trajectory.json "writes" if the write is intended',
          kind: 'deny',
        }
      }
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
    //     read/grep/glob/container_fs 只读子命令与写工具一视同仁，防凭据值进上下文）
    if (SENSITIVE_CREDENTIAL_FILES.has(rel)) {
      return { deny: `access blocked: "${pathArg}" is a sensitive credential file (${rel})`, kind: 'deny' }
    }
    // 读操作（read/glob/grep 等）不查黑名单/治理文件——对齐 osp（permission-guards 只在
    // write/edit 时查黑名单）；否则 REPOSITORIES/ 这类"只读参考源"黑名单会误伤读操作
    // （用户实测：读 REPOSITORIES/ 下 repo 被拦，见 v1.18.5；container_fs 只读子命令同语义）
    if (isWriteTool(toolName, action)) {
      // CCC 治理文件永远拒绝写入（safe-mode 是用户能力，agent 不能自行开关/篡改）
      if (rel === '.serenity-safe-on' || rel === '.serenity' || rel.startsWith('.serenity-safe-on/') || rel.startsWith('.serenity/')) {
        return { deny: `CCC governance file "${rel}" is reserved for the user — agent must not write`, kind: 'deny' }
      }
      // 需求⑤b：MSM 注册表写保护（写 deny 读 allow）——container_admin msm register/deregister 是唯一合法写通道
      // review P2-2：保护范围含聚合档祖先目录（rm -r references/ / mv references/ 同拦）
      if (isProtectedRegistryRel(root, rel)) {
        const isFile = rel.endsWith('/mech-registry.json')
        return {
          deny: isFile
            ? `mech-registry.json is ACC-managed (${rel}) — use container_admin msm register/deregister instead of writing it directly`
            : `"${rel}" is an ancestor of the ACC-managed mech-registry.json — removing/moving it would destroy the registry; the registry is managed by container_admin msm register/deregister`,
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

/**
 * 安全模式开启时从模型工具列表隐藏的工具 —— **基础表**（只隐藏 bash；write/edit 保留）。
 * 它**恒隐**、与 CCC 配置无关；CCC 声明的 `safeMode.hiddenTools` 是**附加**项（见下）。
 */
const SAFE_MODE_DENY_TOOLS = ['bash']

/**
 * agent key → 安全模式下的隐藏状态（v1.51.4：由"一次性 disposer"升级为"签名 ＋ 实际 deny ＋ disposer"）。
 *
 * 为什么记签名：CCC 的 `safeMode.hiddenTools` 可被改（配置热更新是既有语义）⇒ 每步必须能判
 * "清单变没变"——变了就重算（解除旧的、应用新的），没变则**一次 restrict 调用都不多发**。
 */
interface SafeModeRestriction {
  /** 本次**期望**的 deny 清单签名（退化时仍记期望值 ⇒ 不每步重试刷屏） */
  signature: string
  /** **实际生效**的 deny 清单（诊断用；退化时 = 基础表） */
  deny: string[]
  dispose: () => void
}

const safeModeRestrictions = new Map<string, SafeModeRestriction>()

/** restrict 诊断状态（status API 暴露；排查 restrict 未生效问题） */
interface RestrictDiagnostics {
  lastKey: string | null
  lastAttemptAt: string | null
  lastSuccess: boolean | null
  lastError: string | null
  activeKeys: string[]
  /** v1.51.4：每个 key **实际生效**的 deny 清单（排查"某工具为什么／为什么没被隐藏"） */
  denyByKey: Record<string, string[]>
}

const restrictDiag: RestrictDiagnostics = {
  lastKey: null,
  lastAttemptAt: null,
  lastSuccess: null,
  lastError: null,
  activeKeys: [],
  denyByKey: {},
}

export function getRestrictDiagnostics(): RestrictDiagnostics {
  return {
    ...restrictDiag,
    activeKeys: [...safeModeRestrictions.keys()],
    denyByKey: Object.fromEntries([...safeModeRestrictions].map(([k, v]) => [k, v.deny])),
  }
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
 * 同步安全模式工具隐藏：标记存在 → `agent.ctx.tools.restrict deny` 隐藏
 * **基础表（bash）∪ CCC 声明的 `safeMode.hiddenTools`**；标记消失 → 全部解除。
 * pre-step 每步调用 ⇒ 开／关／**改声明**三种变化都实时生效（v1.51.4 起含"改声明"）。
 *
 * 与 `readSafeModeHiddenTools` 的分工（R↓）：本函数负责**形状与失败退化**，reader 只管取值。
 * 🔴 退化规则：DSH 契约规定 **未注册的工具名会让整次 restrict 失败**（"unknown names … fail"）
 * ⇒ 绝不能让 CCC 写错一个名字就丢掉 safe-mode 的核心隐藏（bash）。失败时退化为**只隐藏基础表**，
 * 并在日志响亮报错；退化态**按期望签名记账**，不会每步重试刷屏。
 */
export function syncSafeModeRestriction(agent: Agent, root: string): void {
  const key = (agent.session as { id?: string }).id ?? 'global'
  const on = isSafeModeOn(root)
  const existing = safeModeRestrictions.get(key)

  if (!on) {
    if (existing !== undefined) {
      try {
        existing.dispose()
      } catch (e) {
        console.error(`[serenity-hooks] restrict 解除失败 (key=${key}):`, (e as Error).message)
      }
      safeModeRestrictions.delete(key)
    }
    writeRestrictDiag(root)
    return
  }

  // 安全模式开启：deny = 基础表 ∪ CCC 声明（声明只在安全模式期间生效 —— owner 2026-10-09 令）
  let declared: string[] = []
  try {
    declared = readSafeModeHiddenTools(root)
  } catch (e) {
    console.error(`[serenity-hooks] safeMode.hiddenTools 判据读取失败 (key=${key}):`, (e as Error).message)
  }
  const deny = [...new Set([...SAFE_MODE_DENY_TOOLS, ...declared])]
  const signature = deny.join(',')

  if (existing !== undefined && existing.signature === signature) {
    writeRestrictDiag(root)
    return
  }
  if (existing !== undefined) {
    try {
      existing.dispose()
    } catch (e) {
      console.error(`[serenity-hooks] restrict 重算前解除失败 (key=${key}):`, (e as Error).message)
    }
    safeModeRestrictions.delete(key)
  }

  let applied = deny
  let dispose: () => void
  try {
    dispose = agent.ctx.tools.restrict({ deny: [...deny] })
  } catch (e) {
    restrictDiag.lastKey = key
    restrictDiag.lastAttemptAt = isoLocal()
    restrictDiag.lastSuccess = false
    restrictDiag.lastError = (e as Error).message
    console.error(
      `[serenity-hooks] restrict 失败，已退化为基础表（多为 safeMode.hiddenTools 里有本 CCC **未注册**的工具名）(key=${key}):`,
      (e as Error).message,
    )
    applied = [...SAFE_MODE_DENY_TOOLS]
    try {
      dispose = agent.ctx.tools.restrict({ deny: applied })
    } catch (e2) {
      restrictDiag.lastError = `${(e as Error).message} ／ 退化亦失败: ${(e2 as Error).message}`
      console.error(`[serenity-hooks] restrict 退化失败（守卫仍兜底拦截）(key=${key}):`, (e2 as Error).message)
      safeModeRestrictions.set(key, { signature, deny: [], dispose: () => {} })
      writeRestrictDiag(root)
      return
    }
  }
  restrictDiag.lastKey = key
  restrictDiag.lastAttemptAt = isoLocal()
  restrictDiag.lastSuccess = true
  restrictDiag.lastError = null
  safeModeRestrictions.set(key, { signature, deny: applied, dispose })
  writeRestrictDiag(root)
}

// ── im-bridge 条件可见（v1.31.0）──

/** 条件可见的 IM 工具名（与 tools/im/channels.ts 的注册名一致） */
const IM_BRIDGE_TOOL_NAME = 'im-bridge'

/** agent key → restrict disposer（im-bridge 隐藏状态；key 同安全模式 = 会话 id） */
const imBridgeRestrictions = new Map<string, () => void>()

/** im-bridge 隐藏诊断（排查"工具为什么不在清单里"） */
export function getImBridgeVisibilityDiagnostics(): { hiddenKeys: string[] } {
  return { hiddenKeys: [...imBridgeRestrictions.keys()] }
}

/**
 * 同步 im-bridge 可见性（v1.31.0，S142 用户拍板 Q3「未配置则不可见」）。
 *
 * 判据 = 本会话 CCC 是否启用了**任一** IM 通道（`hasEnabledImChannel`，当前只有 weixin）：
 * - 未启用 → `agent.ctx.tools.restrict({ deny: ['im-bridge'] })`：**从 schema 移除**
 *   （模型看不到，而不是看得到但调用被拒——用户原话"不配置则不可见"）
 * - 启用 → 解除隐藏（CCC 配置热更新即时生效）
 *
 * 与 `syncSafeModeRestriction` 同点调用（pre-step 每步 + 会话就绪），失败不阻断
 * （守卫仍兜底；restrict 不可用时最坏是"看得到但通道未配置 → 返回 CHANNEL_NOT_CONFIGURED"）。
 */
export function syncImBridgeVisibility(agent: Agent, root: string): void {
  const key = (agent.session as { id?: string }).id ?? 'global'
  let enabled = false
  try {
    enabled = hasEnabledImChannel(root)
  } catch (e) {
    // 判据失败按"未启用"处理会让工具凭空消失 → 按"启用"放行，由通道自身报未配置
    console.error(`[serenity-hooks] im-bridge 可见性判据失败 (key=${key}):`, (e as Error).message)
    return
  }
  const existing = imBridgeRestrictions.get(key)
  if (!enabled && !existing) {
    try {
      const dispose = agent.ctx.tools.restrict({ deny: [IM_BRIDGE_TOOL_NAME] })
      imBridgeRestrictions.set(key, dispose)
    } catch (e) {
      console.error(`[serenity-hooks] im-bridge 隐藏失败 (key=${key}):`, (e as Error).message)
      /* 隐藏失败不阻断：调用时通道判据仍会拒绝（CHANNEL_NOT_CONFIGURED） */
    }
  } else if (enabled && existing) {
    try {
      existing()
    } catch (e) {
      console.error(`[serenity-hooks] im-bridge 解除隐藏失败 (key=${key}):`, (e as Error).message)
    }
    imBridgeRestrictions.delete(key)
  }
}

/** 会话销毁清理（lifecycle 调用；防 per-会话 Map 无界增长——review F-08 同族） */
export function forgetImBridgeVisibility(sessionId: string): void {
  const existing = imBridgeRestrictions.get(sessionId)
  if (!existing) return
  try {
    existing()
  } catch {
    /* disposer 已失效 */
  }
  imBridgeRestrictions.delete(sessionId)
}

// ── 🆕 宿主自带「定时器」工具在 CCC 内屏蔽（v1.59.5，owner 令 2026-10-17）──

/**
 * 宿主 `dsh-tool-schedule` 注册的 4 个模型可见工具名（**逐字**，来自该包 `lib/index.js` 的
 * `defineTool({ name: … })`：`schedule_create` / `schedule_list` / `schedule_update` / `schedule_delete`）。
 *
 * 🔴 **为什么要在 CCC 内屏蔽（owner 原话：「这和 CRO 冲突，要求在宁静号激活情况下屏蔽掉」）**：
 * 宿主从 `0.2.1-rc.2` 起自带一套**模型可见的定时器工具**（`ctx.schedule` 服务 + 这 4 个工具）。
 * 而宁静号的唤醒/巡航走的是**另一套**机制：`cognitive_trajectory send-later` → 落 CCC 的
 * `AGENT_SESSIONS/wake-registry.json` → 由**中心调度器 5min tick 统一投递**（D58）。
 * 两套并存会产生**三个具体问题**（不是"重复功能"这种审美问题）：
 *  ① **两处真相源**：宿主的 schedule 状态在宿主域、我们的在 CCC 文件里，**谁在跑说不清**；
 *  ② **CRO 判据失真**：CRO 程序读的是 `wake-registry.json`，宿主定时器触发的唤起**它看不见**
 *     ⇒ 巡检/记账全部遗漏（本轨已有同族教训：「CRO 只在 `wake===true` 时算」那条被推翻）；
 *  ③ **安静失败**：模型可能顺手用 `schedule_create` 排一个唤醒，**它不在任何人的账本里**。
 * ⇒ 故**在 CCC 内隐藏**（从模型清单移除），非 CCC 会话**不受影响**（那是宿主的正常能力）。
 *
 * ⚠️ **一处必须防的坑**（与 `hideAllFor` 同族）：宿主 `restrict` 对**未注册的名字**会让**整次调用失败**
 * （`dsh-tools` 契约逐字："Empty filters, unknown names … fail"）。
 * 这 4 个名字是否在册取决于**宿主是否装了该 tool 包**（不同宿主版本/裁剪可能没有）
 * ⇒ 所以**逐个名字单独发 restrict**，某个失败就跳过那个，**绝不整批发**
 * （整批发一旦撞到缺名的宿主 ⇒ 一个都不隐藏 + 只有一行 log ⇒ 缺陷静默）。
 */
const HOST_SCHEDULE_TOOL_NAMES = [
  'schedule_create',
  'schedule_list',
  'schedule_update',
  'schedule_delete',
] as const

/** `${sessionId}::${toolName}` → restrict disposer（逐工具，便于某个名字不成立时单独跳过） */
const hostScheduleRestrictions = new Map<string, () => void>()

/** 诊断面：本会话已屏蔽的宿主定时器工具（排查"工具为什么不见了"） */
export function getHostScheduleHiddenDiagnostics(): { hidden: string[] } {
  return { hidden: [...hostScheduleRestrictions.keys()] }
}

/**
 * 在 **CCC 内**屏蔽宿主自带的定时器工具（v1.59.5）。
 *
 * 判据 = **会话是否落在某个 CCC 内**（`root !== null`）——与 `syncCccToolVisibility` 互补：
 * 那个管"不在 CCC ⇒ 隐藏**我们自己的**全部工具"，本函数管"**在** CCC ⇒ 隐藏**宿主的**定时器工具"。
 *
 * 幂等；失败不阻断 step（最坏 = 那一个工具仍可见，但那只是"宿主的正常能力没被藏起来"，
 * 不会让会话坏掉）。逐个名字独立发 restrict ⇒ 任何一个名字不在册都不会连累其余三个。
 *
 * @param agent 目标会话
 * @param root  该会话的 CCC 根；`null` ⇒ 非 CCC ⇒ **不动**（宿主的定时器在别处是正常能力）
 */
export function syncHostScheduleToolHiding(agent: Agent, root: string | null): void {
  if (root === null) return
  const sessionId = (agent.session as { id?: string }).id ?? 'global'
  for (const tool of HOST_SCHEDULE_TOOL_NAMES) {
    const key = `${sessionId}::${tool}`
    if (hostScheduleRestrictions.has(key)) continue
    try {
      hostScheduleRestrictions.set(key, agent.ctx.tools.restrict({ deny: [tool] }))
    } catch {
      // 该名字不在册（宿主没装那个工具包 / 被裁剪）⇒ 跳过它，**不影响其余三个**
      // 刻意不逐条告警：这会随宿主版本常态发生，逐条 error 会在每个 CCC 会话上刷假警报。
    }
  }
}

/** 会话销毁清理（lifecycle 调用；按 `${sessionId}::` 前缀回收） */
export function forgetHostScheduleToolHiding(sessionId: string): void {
  const prefix = `${sessionId}::`
  for (const [key, dispose] of [...hostScheduleRestrictions]) {
    if (!key.startsWith(prefix)) continue
    try {
      dispose()
    } catch {
      /* disposer 已失效 */
    }
    hostScheduleRestrictions.delete(key)
  }
}

// ── 专属工具条件可见（v1.33，S142 §32.11）──

/**
 * ACC 注册但**默认对所有 CCC 隐藏**的专属工具清单。
 *
 * 语义（通用机制，不绑定任何具体 CCC）：只有在 CCC 的 `.opencode/serenity.json`
 * `exclusiveTools` 里**显式声明**过的名字才可见——ACC 侧不出现 CCC 的名字（D23）。
 * 与 im-bridge 的区别：im-bridge 是"配置了通道才可见"（能力由 CCC 配置决定），
 * 本族是"被点名才可见"（能力归属 ACC 负责人）。
 */
const EXCLUSIVE_TOOL_NAMES = ['acc-diag'] as const

/** `${sessionId}::${toolName}` → restrict disposer */
const exclusiveRestrictions = new Map<string, () => void>()

/** 专属工具隐藏诊断（排查"工具为什么不在清单里"） */
export function getExclusiveToolsDiagnostics(): { hidden: string[] } {
  return { hidden: [...exclusiveRestrictions.keys()] }
}

// ── 轨迹约束工具面：可见性同步（owner 2026-10-19 令「工具清单也要热加载」）──

/**
 * `sessionId` → { signature, dispose }（角色工具面 restrict 状态）
 *
 * `signature` = 本轮实际发出的 deny 清单（排序后 join）。用它做**幂等判据**：
 * 每次 pre-step 都重算白名单，只有**算出来的结果变了**才重新发 restrict
 * —— 配置不变就不重复发（restrict 会重建 schema，没必要每步都做）。
 */
const trajectoryConstraintRestrictions = new Map<string, { signature: string; deny: string[]; dispose: () => void }>()

/** 轨迹约束工具面诊断（排查"某工具为什么不在 轨迹约束的清单里"） */
export function getTrajectoryConstraintVisibilityDiagnostics(): { keys: string[]; denyByKey: Record<string, string[]> } {
  return {
    keys: [...trajectoryConstraintRestrictions.keys()],
    denyByKey: Object.fromEntries([...trajectoryConstraintRestrictions].map(([k, v]) => [k, v.deny])),
  }
}

/**
 * 同步 **轨迹约束会话的工具面**：把白名单之外的工具**从 schema 移除**（不是"看得到但被拒"）。
 *
 * ## 为什么必须有这条（owner 2026-10-19：「工具清单也要热加载」）
 *
 * 在它之前，轨迹约束白名单**只由运行时守卫拦截**（`decideGuard` 的 轨迹约束 分支）：
 * 工具全部出现在模型 schema 里，调用时才被打回。⇒ 两个真实后果：
 *  ① **模型看得见它不该有的工具** —— 它会去试，试了才撞墙（一轮白烧，且错误文案泛化，
 *     看不出"是不在清单里"还是"临时性拒绝"）；
 *  ② **配置变动在 schema 上永远不生效** —— 改 `trajectory-constraint.json` 的 `tools` 只影响"调用是否放行"。
 *
 * ## 判据与降级
 *
 * - deny 集合 = **`REGISTERED_TOOLS` − 白名单**（只对**我们自己注册的**工具算，
 *   不去动宿主的工具 —— 宿主的工具由各自的条件同步管）。
 * - ⚠️ **未注册的名字会让整次 restrict 失败**（宿主契约逐字 "unknown names … fail"），
 *   而 `diagram` 是按开关注册的 ⇒ 与 `hideAllFor` 同款**两档尝试**（先全覆盖，失败退常驻段）。
 * - 读不到约束面（不是 轨迹约束 / 配置删了）⇒ **撤销既有隐藏**（回到"无约束"）：
 *   ⛔ 不能只是 `return` —— 那会把上一步的隐藏**永久留在**一个已不再是 轨迹约束的会话上
 *   （这正是 owner 说的"删掉 `trajectory-constraint.json` 就该立刻恢复"）。
 * - 幂等：算出来的 deny 签名不变就跳过（不每步重建 schema）。
 *
 * @param agent 目标会话
 * @param root  CCC 根
 */
export function syncTrajectoryConstraintToolVisibility(agent: Agent, root: string): void {
  const sessionId = (agent.session as { id?: string }).id ?? 'global'
  const profile = trajectoryConstraintForSession(root, sessionId)
  const existing = trajectoryConstraintRestrictions.get(sessionId)

  // 不是 轨迹约束（含"刚刚删掉 trajectory-constraint.json"）⇒ **撤销**既有隐藏，回到无约束
  if (profile === null) {
    if (existing !== undefined) {
      try {
        existing.dispose()
      } catch {
        /* disposer 已失效 */
      }
      trajectoryConstraintRestrictions.delete(sessionId)
    }
    return
  }
  const allowed = profileToolWhitelist(profile)

  // 🔴 D181：`null` = 不收窄 ⇒ **撤销**既有隐藏，回到无约束（与"删掉文件"同效）。
  //    判据是**字段在不在**，不是数组空不空 —— 见 rules.ts 的 profileToolWhitelist。
  if (allowed === null) {
    if (existing !== undefined) {
      try {
        existing.dispose()
      } catch {
        /* disposer 已失效 */
      }
      trajectoryConstraintRestrictions.delete(sessionId)
    }
    return
  }

  const resident = REGISTERED_TOOLS.slice(0, REGISTERED_TOOLS.length - CONDITIONAL_TOOL_COUNT)
  const tiers: Array<readonly string[]> = [REGISTERED_TOOLS, resident]

  for (const names of tiers) {
    const deny = names.filter((n) => !allowed.has(n))
    const signature = [...deny].sort().join(',')
    if (existing !== undefined && existing.signature === signature) return // 已是目标态
    if (deny.length === 0) {
      // 白名单覆盖全部注册工具 ⇒ 解除既有隐藏
      if (existing !== undefined) {
        try {
          existing.dispose()
        } catch {
          /* disposer 已失效 */
        }
        trajectoryConstraintRestrictions.delete(sessionId)
      }
      return
    }
    try {
      // 先解除旧 restrict（否则多发射一次会叠加；宿主的 dispose 才是"撤销上一次"）
      if (existing !== undefined) {
        try {
          existing.dispose()
        } catch {
          /* 旧 disposer 失效 ⇒ 直接发新的 */
        }
        trajectoryConstraintRestrictions.delete(sessionId)
      }
      const dispose = agent.ctx.tools.restrict({ deny: [...deny] })
      trajectoryConstraintRestrictions.set(sessionId, { signature, deny, dispose })
      return
    } catch {
      // 该档里有不在册的名字（典型 = `diagram` 关着）⇒ 退下一档
      continue
    }
  }
}

/** 会话销毁清理（lifecycle 调用） */
export function forgetTrajectoryConstraintToolVisibility(sessionId: string): void {
  const existing = trajectoryConstraintRestrictions.get(sessionId)
  if (!existing) return
  try {
    existing.dispose()
  } catch {
    /* disposer 已失效 */
  }
  trajectoryConstraintRestrictions.delete(sessionId)
}

/**
 * 同步专属工具可见性（v1.33）。
 *
 * 判据 = CCC 配置 `exclusiveTools`（`readExclusiveTools`）：
 * - **未声明** → `agent.ctx.tools.restrict({ deny: [tool] })`：从 schema 移除（模型看不到）
 * - **声明** → 解除隐藏（CCC 配置热更新即时生效）
 *
 * 判据失败按"未声明"处理（fail-closed：专属工具默认隐藏），原因见 `readExclusiveTools` 注释。
 * 与 `syncImBridgeVisibility` 同点调用（pre-step 每步 + 会话就绪），失败不阻断一步——
 * 最坏情况是"看得到但被拒"，而不是让 step 出错。
 */
export function syncExclusiveToolsVisibility(agent: Agent, root: string): void {
  const sessionId = (agent.session as { id?: string }).id ?? 'global'
  let declared: string[] = []
  try {
    declared = readExclusiveTools(root)
  } catch (e) {
    console.error(`[serenity-hooks] 专属工具可见性判据失败 (session=${sessionId}):`, (e as Error).message)
  }
  for (const tool of EXCLUSIVE_TOOL_NAMES) {
    const key = `${sessionId}::${tool}`
    const existing = exclusiveRestrictions.get(key)
    const visible = declared.includes(tool)
    if (!visible && !existing) {
      try {
        exclusiveRestrictions.set(key, agent.ctx.tools.restrict({ deny: [tool] }))
      } catch (e) {
        console.error(`[serenity-hooks] 专属工具隐藏失败 (${key}):`, (e as Error).message)
        /* 隐藏失败不阻断：最坏是该 CCC 看得见这个工具（诊断工具本身无副作用） */
      }
    } else if (visible && existing) {
      try {
        existing()
      } catch (e) {
        console.error(`[serenity-hooks] 专属工具解除隐藏失败 (${key}):`, (e as Error).message)
      }
      exclusiveRestrictions.delete(key)
    }
  }
}

/** 会话销毁清理（lifecycle 调用；本函数按 `${sessionId}::` 前缀回收全部专属工具项） */
export function forgetExclusiveToolsVisibility(sessionId: string): void {
  const prefix = `${sessionId}::`
  for (const [key, dispose] of [...exclusiveRestrictions]) {
    if (!key.startsWith(prefix)) continue
    try {
      dispose()
    } catch {
      /* disposer 已失效 */
    }
    exclusiveRestrictions.delete(key)
  }
}

// ── 🔴 非 CCC 会话：**全工具面隐藏**（v1.56.6，owner 2026-10-13 报缺陷）──

/**
 * 非 CCC 会话的工具隐藏状态（sessionId → restrict disposer）。
 *
 * 🔴 **为什么需要它（缺陷根因）**：工具是 `apply()` 里 `ctx.tools.register(...)` 注册到**宿主级**的
 * ⇒ 它们出现在**每一个**会话的工具清单里，**与会话 cwd 无关**。其余各缝（身份注入 ／ guards ／
 * keeper ／ output-guard ／ bootstrap）都已有 `if (!root) return` 这道门，
 * **唯独"工具可见性"这一层没有** ⇒ 在非 CCC 目录开会话时，模型仍看得见这 14 个工具，
 * 于是会去调 —— 调了才抛 `No CCC found`。**那是运行时报错，不是事先不可见**。
 *
 * 判据（owner 原话：「宁静号所有功能在非宁静号目录不生效」）：
 * - **在 CCC 内** → 解除隐藏（本机制**一次 restrict 都不发**，既有行为零改变）
 * - **不在 CCC 内** → `restrict({ deny: [...REGISTERED_TOOLS] })` ⇒ 从模型工具清单移除
 *
 * ⚠️ **与 `syncExclusiveToolsVisibility` 的分工**：那个管"CCC 内哪个工具可见"（按 CCC 配置判）；
 * 本函数管"**这个会话配不配看到任何 ACC 工具**"（按"在不在 CCC 内"判）。二者独立、可叠加。
 *
 * ⚠️ **必须逐个名字显式列出**：宿主的 `restrict` 对**未注册的工具名**会让**整次调用失败**
 * （`dsh-tools` 契约逐字："Empty filters, unknown names … fail"）⇒ 不能写通配。
 * 但 `REGISTERED_TOOLS` 是"插件**具备**的工具面"，其中 **`diagram` 是按开关注册的**
 * （缺省关 ⇒ 缺省**并不在册**）⇒ 直接拿全表去 deny **可能整次失败**，那样就会
 * **静默退回"工具照样可见"**＝缺陷没修好。故此处走**两档尝试**（见 `hideAllFor`）。
 */
const nonCccRestrictions = new Map<string, () => void>()

/** 非 CCC 隐藏诊断（排查"工具为什么不见了"） */
export function getNonCccHiddenDiagnostics(): { hidden: string[] } {
  return { hidden: [...nonCccRestrictions.keys()] }
}

/**
 * 在非 CCC 会话上隐藏全部 ACC 工具（两档尝试）。
 *
 * 🔴 **为什么要两档（D119：不许照源码"意图"断言宿主行为）**：取消注册的工具名会让整次
 * `restrict` 失败，而 `diagram` 缺省不在册。若只发一次全表 deny，"deny 里有个不在册的名字"
 * 就会让**整次调用**失败 ⇒ 一个都不隐藏（且只有一行 console.error）。
 *
 * 档位（**先全覆盖、失败再退到"恒在册"那一段**）：
 *   ① 全表 `REGISTERED_TOOLS`（14：含条件工具）—— 首选，覆盖最全
 *   ② 常驻段（前 `length - CONDITIONAL_TOOL_COUNT` 个）—— 退路：只保证**恒注册**的那些被隐藏
 *
 * 返回**实际生效的注销器**；两档都失败 → `{ failed: [...] }`（原因一并带回，由调用方决定怎么响）。
 *
 * ⚠️ **档位失败不在这里逐条告警**：档 ① 在 `diagram` 缺省关时**按设计**就会失败（它不在册），
 * 那是**常态**、不是故障 ⇒ 逐条 error 会在每个非 CCC 会话上刷**假警报**（看着像坏了，其实档 ② 已成功）。
 * 真正的失败只由调用方在"两档全失败"时**响亮报一次**。
 */
function hideAllFor(agent: Agent): { dispose: () => void; names: readonly string[] } | { failed: string[] } {
  const resident = REGISTERED_TOOLS.slice(0, REGISTERED_TOOLS.length - CONDITIONAL_TOOL_COUNT)
  const tiers: Array<{ label: string; names: readonly string[] }> = [
    { label: '全表（含条件工具）', names: REGISTERED_TOOLS },
    { label: '常驻段（跳过条件工具）', names: resident },
  ]
  const failed: string[] = []
  for (const tier of tiers) {
    try {
      return { dispose: agent.ctx.tools.restrict({ deny: [...tier.names] }), names: tier.names }
    } catch (e) {
      failed.push(`${tier.label}: ${(e as Error).message}`)
    }
  }
  return { failed }
}

/**
 * 同步「本会话在不在 CCC 内」的工具可见性（v1.56.6）。
 *
 * @param agent 目标会话的 agent
 * @param root 该会话的 CCC 根；`null` ⇒ **不在任何 CCC 内** ⇒ 隐藏全部 ACC 工具
 *
 * 幂等：同一会话重复调用不会重复 restrict（已是目标态即直接返回）。
 * 失败不抛（最坏情况：工具可见，但**调用时**仍被各工具自己的根解析拒绝——既有兜底不变）。
 */
export function syncCccToolVisibility(agent: Agent, root: string | null): void {
  const sessionId = (agent.session as { id?: string }).id ?? 'global'
  const existing = nonCccRestrictions.get(sessionId)
  const shouldHide = root === null

  if (shouldHide && !existing) {
    const hidden = hideAllFor(agent)
    if ('failed' in hidden) {
      console.error(
        `[serenity-hooks] 非 CCC 工具隐藏**两档全失败**(session=${sessionId}) —— 工具仍可见（但有各工具自身的 !root 兜底）：${hidden.failed.join(' ／ ')}`,
      )
      return
    }
    nonCccRestrictions.set(sessionId, hidden.dispose)
    return
  }
  if (!shouldHide && existing) {
    // 会话从非 CCC 迁入 CCC（或根中途出现）⇒ 恢复可见
    try {
      existing()
    } catch (e) {
      console.error(`[serenity-hooks] 非 CCC 工具恢复失败 (session=${sessionId}):`, (e as Error).message)
    }
    nonCccRestrictions.delete(sessionId)
  }
}

/** 会话销毁清理（lifecycle 调用；防 per-会话 Map 无界增长） */
export function forgetNonCccToolVisibility(sessionId: string): void {
  const existing = nonCccRestrictions.get(sessionId)
  if (!existing) return
  try {
    existing()
  } catch {
    /* disposer 已失效 */
  }
  nonCccRestrictions.delete(sessionId)
}

/**
 * 从 exec 参数中提取常见路径字段（write/edit 工具）；宽松读取。
 * container_fs 复合工具：path（单路径）/ paths（数组）/ src / dst——取第一个命中（越界检查
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

/** 从 exec 参数提取 container_fs 子命令 action；无则 undefined */
function extractAction(exec: ToolExecution): string | undefined {
  const args = exec.arguments
  if (args === null || typeof args !== 'object') return undefined
  const a = args as Record<string, unknown>
  return typeof a.action === 'string' ? a.action : undefined
}

interface GuardRegistration {
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
    const root = cccRootForCwd(cwd)
    if (!root) return { kind: 'allow' } // 非 CCC，不干预

    const safeModeOn = isSafeModeOn(root)
    const blacklist = readBlacklist(root, configPaths)
    const pathArg = extractPathArg(exec)
    const action = extractAction(exec)
    const sessionId = (exec as { agent?: { session?: { id?: string } } } | undefined)?.agent?.session?.id
    // 轨迹约束面（**判据的唯一入口**在 profile.ts；此处只消费结果）
    const trajectoryConstraint = trajectoryConstraintForSession(root, sessionId)
    return decideGuard({ root, toolName: exec.name, safeModeOn, blacklist, pathArg, action, trajectoryConstraint })
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
