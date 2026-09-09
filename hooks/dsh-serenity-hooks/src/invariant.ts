/**
 * invariant.ts — 包级不变量伴生（dsh-my-rsi creating-a-plugin 规范）
 *
 * 检查：dsh.plugin.json 的 contributes.tools 与代码实际注册的工具一致。
 * 挂载时 plugin-local 会校验清单；本不变量让仓库内 `verify-package-invariants`
 * 类门禁也可直接调用。
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

export interface PluginManifest {
  id: string
  version?: string
  main?: string
  description?: string
  engines?: { dsh?: string }
  contributes?: { tools?: string[]; skills?: string[] }
}

/** 读取插件清单；缺失/非法返回 null */
export function readPluginManifest(manifestPath: string): PluginManifest | null {
  if (!existsSync(manifestPath)) return null
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf-8')) as PluginManifest
  } catch {
    return null
  }
}

/**
 * 校验清单声明的工具与代码注册的工具一致。
 * 返回不一致项列表（空 = 通过）。
 */
export function verifyToolConsistency(manifestPath: string, registeredTools: readonly string[]): string[] {
  const manifest = readPluginManifest(manifestPath)
  if (!manifest) return [`manifest not found or invalid: ${manifestPath}`]
  const declared = manifest.contributes?.tools ?? []
  const missing = declared.filter((t) => !registeredTools.includes(t))
  const undeclared = registeredTools.filter((t) => !declared.includes(t))
  const issues: string[] = []
  if (missing.length) issues.push(`manifest declares tools not registered: ${missing.join(', ')}`)
  if (undeclared.length) issues.push(`registered tools not declared in manifest: ${undeclared.join(', ')}`)
  return issues
}

/**
 * 包级不变量：本插件注册的工具集合（与 dsh.plugin.json contributes.tools 一致）。
 *
 * v1.31.1 修正：v1.31.0 新增 `im-bridge`（条件可见）时**漏改此处与清单**——两侧同错 →
 * `verifyToolConsistency` 零问题（**陈旧的双侧一致 = 静默通过**），而代码实际注册 11 个。
 * 教训：工具面变更必须同时改三处（tools/*.ts 注册 / 本常量 / dsh.plugin.json）。
 */
export const REGISTERED_TOOLS = [
  'container_fs', 'logbook', 'dashboard', 'container_git', 'msm', 'praxis', 'handyman',
  'localstore', 'container_admin', 'autopilot-trajectory', 'im-bridge',
] as const
