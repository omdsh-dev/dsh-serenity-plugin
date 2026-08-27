/**
 * status.ts — 状态与安全模式操作（纯逻辑，零 DSH 依赖，可独立单测）
 *
 * WebUI 停靠栏的数据源：ACC 版本 / CCC 根 / safe-mode 状态 / 黑名单 / keeper 阈值 / handyman 模型。
 * setSafeMode 直接读写 .serenity-safe-on 标记（守卫实时读取，写即生效）。
 */

import { existsSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
import {
  findSerenityRoot,
  isSafeModeOn,
  readBlacklist,
  loadSerenityConfig,
  readHandymanConfig,
  SAFE_MODE_MARKER,
  DEFAULT_SERENITY_CONFIG_PATHS,
} from './ccc.js'
import { ACC_VERSION } from './constants.js'
import { getRestrictDiagnostics } from './seams/guards.js'

/**
 * 读取已安装 DSH CLI 版本；读不到返回 null。
 * 跨平台（Windows 审计问题 13）：Windows npm 全局装在 %APPDATA%\npm（非 ~/.npm-global）——
 * 依次尝试 npm_config_prefix / APPDATA\npm / ~/.npm-global。
 */
export function readDshVersion(): string | null {
  const candidates: string[] = []
  if (process.env.npm_config_prefix) {
    candidates.push(join(process.env.npm_config_prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh'))
  }
  if (process.env.APPDATA) {
    candidates.push(join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh'))
  }
  candidates.push(join(homedir(), '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh'))
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(join(p, 'package.json'), 'utf-8')) as { version?: unknown }
      if (typeof pkg.version === 'string') return pkg.version
    } catch {
      /* 下一个候选 */
    }
  }
  return null
}

export interface SerenityStatus {
  root: string | null
  accVersion: string
  dshVersion: string | null
  nodeVersion: string
  safeModeOn: boolean
  /** 黑名单条目（string 或 {pattern, message}，对齐 osp） */
  blacklist: { pattern: string; message?: string }[]
  threshold: number | null
  handymanModel: string | null
  restrict: {
    lastKey: string | null
    lastAttemptAt: string | null
    lastSuccess: boolean | null
    lastError: string | null
    activeKeys: string[]
  }
}

export function getStatus(cwd: string, configPaths: string[] = DEFAULT_SERENITY_CONFIG_PATHS): SerenityStatus {
  const root = findSerenityRoot(cwd)
  const restrict = getRestrictDiagnostics()
  const common = {
    accVersion: ACC_VERSION,
    dshVersion: readDshVersion(),
    nodeVersion: process.version,
  }
  if (!root) {
    return { root: null, ...common, safeModeOn: false, blacklist: [], threshold: null, handymanModel: null, restrict }
  }
  const cfg = loadSerenityConfig(root, configPaths)
  return {
    root,
    ...common,
    safeModeOn: isSafeModeOn(root),
    blacklist: readBlacklist(root, configPaths),
    threshold: cfg.sessionKeeper?.threshold ?? null,
    handymanModel: readHandymanConfig(root, configPaths)?.defaultModel ?? null,
    restrict,
  }
}

/** 切换安全模式（写/删标记文件）；返回实际生效状态 */
export function setSafeMode(root: string, on: boolean): { on: boolean } {
  const marker = resolve(root, SAFE_MODE_MARKER)
  if (on) {
    if (!existsSync(marker)) writeFileSync(marker, new Date().toISOString() + '\n', 'utf-8')
  } else {
    rmSync(marker, { force: true })
  }
  return { on: isSafeModeOn(root) }
}
