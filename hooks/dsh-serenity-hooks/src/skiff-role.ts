/**
 * skiff-role.ts — Skiff（F4，v1.25.0 实验性）角色层纯逻辑（零 DSH 依赖，可独立单测）
 *
 * 概念（S142 用户拍板）：Skiff = 完整宁静号 trajectory（在宁静号内全知全能）的
 * **任意子集**——CCC 通过角色配置定义：能力面（tools 非 MSM 工具白名单 + msms
 * MSM 白名单，双白名单独立，白名单外全隐藏）+ 轨迹纪律面（trajectory 子集）+
 * 系统提示词（CCC 完整定义，dsp 只给基础部分）。
 *
 * 实验性质：未配置任何角色 → Skiff 完全零影响（无监听、无 agent 创建、guard 无规则）。
 */

import { loadSerenityConfig, DEFAULT_SERENITY_CONFIG_PATHS, type SkiffRoleConfig } from './ccc.js'

export type { SkiffRoleConfig }

/** Skiff agent 会话 id 前缀（agents.create 生成；seams 旁路/白名单判定用） */
export const SKIFF_SESSION_PREFIX = 'skiff-'

/** 判定 sessionId 是否为 Skiff 会话（仿 handyman- 前缀排除模式） */
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
        msms: Array.isArray(role.msms) ? role.msms.filter((m): m is string => typeof m === 'string') : undefined,
        tools: Array.isArray(role.tools) ? role.tools.filter((t): t is string => typeof t === 'string') : undefined,
        trajectory: role.trajectory && typeof role.trajectory === 'object' ? {
          session: role.trajectory.session === true,
          keeper: role.trajectory.keeper === true,
          rebuild: role.trajectory.rebuild === true,
        } : undefined,
        systemPrompt: typeof role.systemPrompt === 'string' ? role.systemPrompt : undefined,
      })
    }
  } catch {
    /* 配置读取失败 → 空（Skiff 不启用，零影响） */
  }
  return out
}

/** 某角色的轨迹纪律子集（缺省全 false = 完全独立） */
export interface SkiffTrajectorySubset {
  session: boolean
  keeper: boolean
  rebuild: boolean
}

export function trajectorySubset(role: SkiffRoleConfig | undefined): SkiffTrajectorySubset {
  return {
    session: role?.trajectory?.session === true,
    keeper: role?.trajectory?.keeper === true,
    rebuild: role?.trajectory?.rebuild === true,
  }
}

/** 角色可用工具面（白名单并集）：tools + acc_msm（msms 非空时作为 MSM 通道自动可用） */
export function roleToolWhitelist(role: SkiffRoleConfig | undefined): Set<string> {
  const out = new Set<string>()
  for (const t of role?.tools ?? []) out.add(t)
  if ((role?.msms?.length ?? 0) > 0) out.add('acc_msm')
  return out
}

/** 角色允许的 MSM 白名单（acc_msm exec 校验 / msm_list 过滤用；独立于 tools 白名单） */
export function roleMsmWhitelist(role: SkiffRoleConfig | undefined): Set<string> {
  return new Set(role?.msms ?? [])
}

/**
 * Skiff 基础提示词（dsp 只给这部分；CCC 的 systemPrompt 段由调用方拼接）：
 * 身份 + 可用 MSM/工具清单 + 调用协议 + 边界声明。动态生成（清单来自角色白名单）。
 */
export function buildSkiffBasePrompt(roleName: string, role: SkiffRoleConfig | undefined): string {
  const msms = role?.msms ?? []
  const tools = role?.tools ?? []
  const lines = [
    '=== Serenity Skiff ===',
    `Role: ${roleName} (defined by this CCC)`,
    'You interact with this CCC ONLY through the exposed surface below:',
  ]
  if (msms.length > 0) {
    lines.push(`  MSMs: ${msms.join(', ')} (call acc_msm exec <name> [args...]; pass --help as the first arg for usage)`)
  } else {
    lines.push('  MSMs: (none)')
  }
  lines.push(`  Tools: ${tools.length > 0 ? tools.join(', ') : '(none)'}`)
  lines.push('No other tools are available. Your capability boundary is this surface.')
  lines.push('')
  lines.push('---')
  lines.push('')
  return lines.join('\n')
}
