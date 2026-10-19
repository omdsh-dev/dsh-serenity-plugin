/**
 * role/skiff/config.ts — Skiff（F4，v1.25.0 实验性）角色层纯逻辑（零 DSH 依赖，可独立单测）
 *
 * 概念（S142 用户拍板）：Skiff = 完整宁静号 cognitive trajectory（在宁静号内全知全能）的
 * **任意子集**——CCC 通过角色配置定义：能力面（tools 非 MSM 工具白名单 + msms
 * MSM 白名单，双白名单独立，白名单外全隐藏）+ 轨迹纪律面（cognitive trajectory 子集）+
 * 系统提示词（CCC 完整定义，dsp 只给基础部分）。
 *
 * 实验性质：未配置任何角色 → Skiff 完全零影响（无监听、无 agent 创建、guard 无规则）。
 */

import { loadSerenityConfig, resolveInside, readUtf8, DEFAULT_SERENITY_CONFIG_PATHS, type SkiffRoleConfig } from '../../kernel/ccc.js'
import { existsSync, statSync } from 'node:fs'

export type { SkiffRoleConfig }

/** Skiff agent 会话 id 前缀（agents.create 生成；seams 旁路/白名单判定用） */
export const SKIFF_SESSION_PREFIX = 'skiff-'

/** 判定 sessionId 是否为 Skiff 会话（仿 cheap-worker- 前缀排除模式） */
export function isSkiffSessionId(sessionId: string | undefined): boolean {
  return typeof sessionId === 'string' && sessionId.startsWith(SKIFF_SESSION_PREFIX)
}

/**
 * 读取 CCC 的 Skiff 角色配置（.opencode/serenity.json skiff.roles）。
 * @returns 名 → 角色配置 的 Map；未配置（无 skiff 段/空 roles）返回空 Map（Skiff 未启用）
 */
export function readSkiffRoles(root: string, paths: string[] = DEFAULT_SERENITY_CONFIG_PATHS): Map<string, SkiffRoleConfig> {
  const out = new Map<string, SkiffRoleConfig>()
  try {
    const cfg = loadSerenityConfig(root, paths)
    const roles = cfg.skiff?.roles
    if (!roles || typeof roles !== 'object') return out
    for (const [name, role] of Object.entries(roles)) {
      if (!role || typeof role !== 'object') continue
      if (name.trim() === '') continue
      out.set(name.trim(), {
        model: typeof role.model === 'string' ? role.model : undefined,
        kind: role.kind === 'temporary' || role.kind === 'persistent' ? role.kind : undefined,
        msms: Array.isArray(role.msms) ? role.msms.filter((m): m is string => typeof m === 'string') : undefined,
        tools: Array.isArray(role.tools) ? role.tools.filter((t): t is string => typeof t === 'string') : undefined,
        cognitiveTrajectory: role.cognitiveTrajectory && typeof role.cognitiveTrajectory === 'object' ? {
          session: role.cognitiveTrajectory.session === true,
          keeper: role.cognitiveTrajectory.keeper === true,
          rebuild: role.cognitiveTrajectory.rebuild === true,
        } : undefined,
        systemPrompt: typeof role.systemPrompt === 'string' ? role.systemPrompt : undefined,
        systemPromptFile: typeof role.systemPromptFile === 'string' ? role.systemPromptFile : undefined,
      })
    }
  } catch (err) {
    /* 配置读取失败 → 空（Skiff 角色不启用 = 权限面 fail-closed）。
     * F-07：失败必须可见——空角色集会让所有 skiff 会话被拒，静默会让人查不到原因。
     * （loadSerenityConfig 内的 JSON 损坏已各自告警；此处兜住其余读取异常。） */
    console.warn(`[serenity-hooks] ✗ skiff 角色配置读取失败（按无角色继续）: ${String((err as Error)?.message ?? err)}`)
  }
  return out
}

/** 某角色的轨迹纪律子集（缺省全 false = 完全独立） */
interface SkiffCognitiveTrajectorySubset {
  session: boolean
  keeper: boolean
  rebuild: boolean
}

export function cognitiveTrajectorySubset(role: SkiffRoleConfig | undefined): SkiffCognitiveTrajectorySubset {
  return {
    session: role?.cognitiveTrajectory?.session === true,
    keeper: role?.cognitiveTrajectory?.keeper === true,
    rebuild: role?.cognitiveTrajectory?.rebuild === true,
  }
}

/** 角色可用工具面（白名单并集）：tools + msm（msms 非空时作为 MSM 通道自动可用） */
export function roleToolWhitelist(role: SkiffRoleConfig | undefined): Set<string> {
  const out = new Set<string>()
  for (const t of role?.tools ?? []) out.add(t)
  if ((role?.msms?.length ?? 0) > 0) out.add('msm')
  return out
}

/** 角色允许的 MSM 白名单（msm 工具 exec 校验 / 过滤用；独立于 tools 白名单） */
export function roleMsmWhitelist(role: SkiffRoleConfig | undefined): Set<string> {
  return new Set(role?.msms ?? [])
}

/**
 * 解析角色的系统提示词全文（v1.25.10，S142 用户：超长提示词 JSON 内嵌不可读）：
 * ① `systemPromptFile` 存在 → 读取文件内容（**推荐配置方法**；相对 CCC 根，
 *    路径逃逸拒绝（resolveInside）+ BOM 剥除（readUtf8）+ 存在性校验）
 * ② 否则 → 内嵌 `systemPrompt`（兼容旧配置）
 * ③ 都无 → 空字符串
 * 文件缺失/逃逸 → 抛错（调用方 catch 降级 + validate 报 issue）。
 * 懒读取：readSkiffRoles 不读文件（guards/seams 每次工具调用查询的热路径零 IO），
 * 仅在本函数（创建 agent / validate / list 时）读取。
 */
export function resolveRoleSystemPrompt(root: string, role: SkiffRoleConfig | undefined): string {
  if (!role) return ''
  const file = role.systemPromptFile?.trim()
  if (file) {
    const abs = resolveInside(root, file) // 逃逸 → throw
    if (!existsSync(abs)) {
      throw new Error(`skiff role "${role.systemPrompt ?? '(unnamed)'}": systemPromptFile "${file}" not found (resolved: ${abs})`)
    }
    return readUtf8(abs).trim()
  }
  return role.systemPrompt ?? ''
}

/** 角色系统提示词来源（validate/list 展示用） */
export function systemPromptSource(role: SkiffRoleConfig | undefined): 'file' | 'inline' | 'none' {
  if (role?.systemPromptFile?.trim()) return 'file'
  if (role?.systemPrompt?.trim()) return 'inline'
  return 'none'
}

/**
 * 角色类型（v1.30.15，S142 用户拍板）：
 * - 显式 `role.kind` 优先（`temporary` / `persistent`）
 * - 缺省 = 隐式推断：调用方给出**稳定 sessionId** → persistent；否则 temporary
 *   （存量配置零迁移；微信桥传固定会话 id → persistent，调试页随机 id → temporary）
 */
type SkiffKind = 'temporary' | 'persistent'

export function resolveSkiffKind(role: SkiffRoleConfig | undefined, hasStableId: boolean): SkiffKind {
  const k = role?.kind
  if (k === 'temporary' || k === 'persistent') return k
  return hasStableId ? 'persistent' : 'temporary'
}

/**
 * 角色提示词**读取器**（v1.30.15，方案 A：长期型热更新）。
 *
 * 为什么是函数而不是字符串（R↓）：旧实现 `createSkiffAgent` 在创建时把
 * `resolveRoleSystemPrompt(...)` 的结果**快照**进系统提示词段闭包 → CCC 改了
 * `<role>.md` 必须重启 dsh web 才生效（本轮实证：改完 18KB 提示词，live agent 仍用旧文本）。
 * 现形态返回一个读取函数，由系统提示词段的 `text()` **每轮调用**：
 *   - `systemPromptFile`：按 **mtime + size** 缓存重读（命中缓存零 IO；未变不解析）
 *     → 改文件即生效，**无需重启**；变更时打一行 info 日志（可观测，便于确认热更生效）
 *   - 内嵌 `systemPrompt`：静态（JSON 配置改动仍需重启/重载配置）
 *   - 读取失败：返回**上次成功内容**（绝不返回空——空提示词会让角色失去人格与纪律），
 *     并按标签去重告警一次
 * @param root CCC 根
 * @param role 角色配置
 */
export function createRolePromptReader(root: string, role: SkiffRoleConfig | undefined): () => string {
  const file = role?.systemPromptFile?.trim()
  if (!file) {
    const inline = role?.systemPrompt ?? ''
    return () => inline
  }
  let abs: string | null = null
  try {
    abs = resolveInside(root, file) // 逃逸 → 抛错（此处降级为空读取器 + 告警）
  } catch (err) {
    console.warn(`[serenity-hooks] ✗ skiff 角色提示词路径非法（${file}）: ${String((err as Error)?.message ?? err)}`)
  }
  if (abs === null) return () => ''
  const absPath: string = abs
  let cachedMtime = -1
  let cachedSize = -1
  let cachedText = ''
  let warned = false
  return () => {
    try {
      const st = statSync(absPath)
      if (st.mtimeMs === cachedMtime && st.size === cachedSize) return cachedText
      const text = readUtf8(absPath).trim()
      const isReload = cachedMtime !== -1
      cachedMtime = st.mtimeMs
      cachedSize = st.size
      cachedText = text
      warned = false
      if (isReload) {
        console.info(`[serenity-hooks] ↻ skiff 角色提示词已热重载（${file}，${text.length} 字符）`)
      }
      return text
    } catch (err) {
      if (!warned) {
        warned = true
        console.warn(
          `[serenity-hooks] ✗ skiff 角色提示词读取失败（${file}）——沿用上次成功内容: ${String((err as Error)?.message ?? err)}`,
        )
      }
      return cachedText
    }
  }
}

/**
 * Skiff 基础提示词（dsp 只给这部分；CCC 的 systemPrompt 段由调用方拼接）。
 *
 * ## 🔴 为什么**不再枚举**清单（owner 2026-10-19 令）
 *
 * 旧版在这里抄了两份清单（`MSMs: a, b, c` / `Tools: read, grep, …`）。那是**第二真相源**，
 * 而真相源本来就在模型自己手里：
 *   · **工具清单** = 这一轮实际注册给它的 tool schema —— 模型已经看得见，抄一遍只会漂
 *   · **MSM 清单** = `msm()` 无参调用返回的目录 —— 已按角色白名单过滤，且**每次实时读配置**
 *
 * ⚠️ **漂移不是理论风险，是已发生的缺陷**（2026-10-19）：角色配置早就长到 8 个工具，
 * 而这个函数是从**创建时冻结的 role 快照**求值的 ⇒ 提示词里一直写着旧的 4 个
 * ⇒ 模型照着提示词办事，**它自己以为没有的能力就不去调** ⇒ 症状是"工具用不了"，
 * 而守卫那边（每调用实时读配置）其实是放行的。两个真相源打架，输的总是提示词。
 *
 * ⇒ 现在只声明**边界与发现路径**，不抄内容：清单在哪，怎么取，越界会怎样。
 *
 * @param roleName 角色名（CCC 定义；用于身份声明）
 */
export function buildSkiffBasePrompt(roleName: string): string {
  return [
    '=== Serenity Skiff ===',
    `Role: ${roleName} (defined by this CCC)`,
    'Your capability boundary is enforced mechanically by this CCC — anything outside it is rejected at the call site, not by your judgment.',
    'Discover your surface, do not memorize it (both are generated from the live config on every turn):',
    '  · Your tools are exactly the tool schemas you see in this session — if a tool is not in your schema, it is not available.',
    '  · Your MSMs are listed by calling msm() with no arguments — that directory is already filtered to this role.',
    '  · Usage for any MSM: msm("<name>", [], inspect=true) or pass "--help" as the first argument.',
    'Do not infer unavailability from anything you remember or from an earlier list: this surface changes when the CCC configuration changes, and it takes effect without restarting.',
    '',
    '---',
    '',
  ].join('\n')
}
