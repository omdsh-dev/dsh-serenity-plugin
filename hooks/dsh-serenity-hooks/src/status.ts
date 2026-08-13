/**
 * status.ts — 状态与安全模式操作（纯逻辑，零 DSH 依赖，可独立单测）
 *
 * WebUI 停靠栏的数据源：ACC 版本 / CCC 根 / safe-mode 状态 / 黑名单 / keeper 阈值 / loop 模型。
 * setSafeMode 直接读写 .serenity-safe-on 标记（守卫实时读取，写即生效）。
 */

import { existsSync, writeFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  findSerenityRoot,
  isSafeModeOn,
  readBlacklist,
  loadSerenityConfig,
  SAFE_MODE_MARKER,
  DEFAULT_SERENITY_CONFIG_PATHS,
} from './ccc.js'
import { ACC_VERSION } from './constants.js'
import { getRestrictDiagnostics } from './seams/guards.js'

export interface SerenityStatus {
  root: string | null
  accVersion: string
  safeModeOn: boolean
  blacklist: string[]
  threshold: number | null
  loopModel: string | null
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
  if (!root) {
    return { root: null, accVersion: ACC_VERSION, safeModeOn: false, blacklist: [], threshold: null, loopModel: null, restrict }
  }
  const cfg = loadSerenityConfig(root, configPaths)
  return {
    root,
    accVersion: ACC_VERSION,
    safeModeOn: isSafeModeOn(root),
    blacklist: readBlacklist(root, configPaths),
    threshold: cfg.sessionKeeper?.threshold ?? null,
    loopModel: cfg.loop?.defaultModel ?? null,
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
