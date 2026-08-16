/**
 * guards.ts — 拦截缝：安全模式 + 路径守卫（P3 语义的机械层）
 *
 * 纯决策逻辑（decideGuard）与 DSH 注册（registerGuards）分离：
 * 前者零 DSH 依赖可单测，后者把决策接到 tools/pre-execute 瀑布 + ctx.tools.guard 终局。
 *
 * 对应 opencode-serenity-plugin 的 tool.execute.before 路径守卫 + bash 开关 + 黑名单。
 */

import { resolve, relative } from 'node:path'
import { writeFileSync, mkdirSync } from 'node:fs'
import type { Context } from 'cordis'
import type { ToolExecution, PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  findSerenityRoot,
  isSafeModeOn,
  matchBlacklist,
  readBlacklist,
  pathInside,
  type BlacklistRule,
} from '../ccc.js'

// ── 纯决策（可单测）──

export interface GuardInput {
  root: string
  toolName: string
  safeModeOn: boolean
  blacklist: BlacklistRule[]
  /** 工具参数中可能携带的路径（write/edit 等）；无则 undefined */
  pathArg?: string
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
  const { root, toolName, safeModeOn, blacklist, pathArg } = input

  // 1) 安全模式：bash 一律禁用（标准语义）
  // 提示不泄露 safe-mode 机制（safe-mode 对 agent 不可见）：模型视角 = bash 工具不存在
  if (safeModeOn && toolName === 'bash') {
    return { deny: `bash: 没有这个工具`, kind: 'deny' }
  }

  // 2) 携带路径参数：先查越界（读写都拦——安全），再查治理文件/黑名单（仅写类工具，对齐 osp）
  if (pathArg !== undefined) {
    const abs = resolve(root, pathArg)
    // pathInside 前缀+sep 边界+跨盘安全（Windows 兼容：跨盘 relative 返回绝对路径原文，
    // 旧 relative().startsWith('..') 漏判，见 Windows 审计问题 6）
    if (!pathInside(resolve(root), abs)) {
      return { deny: `path escape blocked: "${pathArg}" 越出 CCC 根`, kind: 'deny' }
    }
    // 读操作（read/glob/grep 等）不查黑名单/治理文件——对齐 osp（permission-guards 只在
    // write/edit 时查黑名单）；否则 REPOSITORIES/ 这类"只读参考源"黑名单会误伤读操作
    // （用户实测：读 REPOSITORIES/ 下 repo 被拦，见 v1.18.5）
    const isWriteTool = toolName === 'write' || toolName === 'edit' || toolName === 'str_replace_editor'
      || toolName === 'cc_fs' || toolName === 'bash' || toolName === 'append' || toolName === 'touch'
    if (isWriteTool) {
      // 归一化反斜杠（Windows）：黑名单前缀匹配与治理文件保护用正斜杠 rel
      // （relative 在 Windows 产出反斜杠，斜杠结尾规则 `.secrets/` 匹配不到 `.secrets\file`，
      //   嵌套治理路径 `.serenity\child` 也不匹配，见 Windows 审计问题 9）
      const rel = relative(root, abs).split('\\').join('/')
      // CCC 治理文件永远拒绝写入（safe-mode 是用户能力，agent 不能自行开关/篡改）
      if (rel === '.serenity-safe-on' || rel === '.serenity' || rel.startsWith('.serenity-safe-on/') || rel.startsWith('.serenity/')) {
        return { deny: `CCC 治理文件 "${rel}" 保留给用户，agent 不可写`, kind: 'deny' }
      }
      const hit = matchBlacklist(rel, blacklist)
      if (hit) {
        // 对象条目支持自定义提示（对齐 osp：{ pattern, message } → message ?? 默认）
        return { deny: hit.message ?? `blacklist blocked: "${pathArg}" 命中规则 "${hit.pattern}"`, kind: 'deny' }
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

/** 从 exec 参数中提取常见路径字段（write/edit 工具）；宽松读取 */
function extractPathArg(exec: ToolExecution): string | undefined {
  const args = exec.arguments
  if (args === null || typeof args !== 'object') return undefined
  const a = args as Record<string, unknown>
  for (const key of ['path', 'file_path', 'target', 'dst']) {
    const v = a[key]
    if (typeof v === 'string') return v
  }
  return undefined
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
    return decideGuard({ root, toolName: exec.name, safeModeOn, blacklist, pathArg })
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
