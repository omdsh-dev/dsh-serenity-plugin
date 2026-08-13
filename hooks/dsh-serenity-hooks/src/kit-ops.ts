/**
 * kit-ops.ts — acc_kit 纯操作层（零 DSH 依赖）
 *
 * health: CCC 三原则检查（P1 .serenity / P2 git / 配置）
 * time: ISO 8601 时间戳
 * wait: 同步等待 N 秒
 */

import { existsSync, statSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { findSerenityRoot, findGitRoot, loadSerenityConfig, DEFAULT_SERENITY_CONFIG_PATHS } from './ccc.js'
import type { JsonValue } from './json.js'

export type KitAction = 'health' | 'time' | 'wait'

export const KIT_ACTIONS: readonly KitAction[] = ['health', 'time', 'wait']

export interface KitArgs {
  action: KitAction
  seconds?: number
}

export function runKit(root: string, args: KitArgs): JsonValue {
  switch (args.action) {
    case 'health': {
      const gitRoot = findGitRoot(root)
      let config: JsonValue = null
      let configPath: string | null = null
      for (const candidate of DEFAULT_SERENITY_CONFIG_PATHS) {
        const p = resolve(root, candidate)
        if (!existsSync(p)) continue
        try {
          config = JSON.parse(readFileSync(p, 'utf-8')) as JsonValue
          configPath = p
        } catch {
          config = { parseError: true }
          configPath = p
        }
        break
      }
      return {
        cwd: root,
        serenityRoot: findSerenityRoot(root),
        gitRoot,
        config,
        configPath,
        p1: findSerenityRoot(root) !== null,
        p2: gitRoot !== null,
        p3: 'enforced-by-dsh-fs-sandbox',
      }
    }
    case 'time':
      return new Date().toISOString()
    case 'wait': {
      const n = args.seconds ?? 0
      if (!Number.isFinite(n) || n < 0) throw new Error('wait 需要非负秒数')
      execFileSync('sleep', [String(n)], { stdio: 'ignore' })
      return { waited: n }
    }
    default:
      throw new Error(`未知 action: ${args.action as string}`)
  }
}

export { loadSerenityConfig }
