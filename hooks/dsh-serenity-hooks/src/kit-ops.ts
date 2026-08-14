/**
 * kit-ops.ts — acc_kit 纯操作层（零 DSH 依赖）
 *
 * health: CCC 三原则检查（P1 .serenity / P2 git / 配置）
 * time: ISO 8601 时间戳
 * wait: 等待 N 秒（纯 Node setTimeout——不依赖外部 sleep 可执行文件，
 *       Windows 无 GNU coreutils sleep，spawn 必 ENOENT，见 Windows 兼容审计问题 3）
 */

import { existsSync, statSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { findSerenityRoot, findGitRoot, loadSerenityConfig, DEFAULT_SERENITY_CONFIG_PATHS } from './ccc.js'
import { ACC_VERSION } from './constants.js'
import { readDshVersion } from './status.js'
import type { JsonValue } from './json.js'

export type KitAction = 'health' | 'time' | 'wait'

export const KIT_ACTIONS: readonly KitAction[] = ['health', 'time', 'wait']

export interface KitArgs {
  action: KitAction
  seconds?: number
}

export async function runKit(root: string, args: KitArgs): Promise<JsonValue> {
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
        // P2-9 版本自省：ACC 版本 + 已安装 DSH CLI 版本（升级提示依据）
        accVersion: ACC_VERSION,
        dshVersion: readDshVersion(),
      }
    }
    case 'time':
      return new Date().toISOString()
    case 'wait': {
      const n = args.seconds ?? 0
      if (!Number.isFinite(n) || n < 0) throw new Error('wait 需要非负秒数')
      await new Promise((r) => setTimeout(r, Math.round(n * 1000)))
      return { waited: n }
    }
    default:
      throw new Error(`未知 action: ${args.action as string}`)
  }
}

export { loadSerenityConfig }
