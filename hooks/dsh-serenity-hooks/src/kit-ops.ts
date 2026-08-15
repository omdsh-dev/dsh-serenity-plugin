/**
 * kit-ops.ts — acc_kit 纯操作层（零 DSH 依赖）
 *
 * 行为对齐 osp（opencode-serenity-plugin/src/acc-kit.ts）——osp 是 ACC 工具 spec：
 *   - health：{ccc, root, version, status: healthy|degraded, principles: {P1_rooted, P2_git_managed, P3_binary_permissions}}
 *   - time：{now_iso, now_local, epoch_ms}
 *   - wait：缺省 1s（正整数秒），返回 'waited Ns' 文本
 * 平台适配：P3 在 osp 检查 opencode.json，DSH 无 opencode.json → 检查 DSH/opencode 配置路径
 * （.opencode/serenity.json / .dsh/serenity.json 等，见 DEFAULT_SERENITY_CONFIG_PATHS）。
 * CCC 缺失时返回 degraded 报告而非抛错（对齐 osp 未激活语义）。
 * 保留 dsp 增强：accVersion/dshVersion 版本自省字段。
 * wait 用纯 Node setTimeout——不依赖外部 sleep 可执行文件（Windows 无 GNU coreutils sleep）。
 */

import { existsSync, statSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

/** CCC 名：从 .serenity 首行解析（对齐 osp readSerenityCccName） */
function readCccName(root: string | null): string | null {
  if (!root) return null
  try {
    const content = readFileSync(resolve(root, '.serenity'), 'utf-8').trim()
    return content.split('\n')[0]?.trim() || null
  } catch {
    return null
  }
}

export async function runKit(root: string | null, args: KitArgs): Promise<JsonValue> {
  switch (args.action) {
    case 'health': {
      const cccName = readCccName(root)
      // P1: .serenity 存在且非空
      const serenityPath = root ? resolve(root, '.serenity') : null
      const p1Pass = serenityPath !== null && existsSync(serenityPath) && statSync(serenityPath).size > 0
      // P2: git 管理
      const gitRoot = root ? findGitRoot(root) : null
      const p2Pass = gitRoot !== null
      // P3: 配置存在（DSH 无 opencode.json，检查配置路径；对齐 osp 的 P3_binary_permissions 语义）
      let p3Pass = false
      let p3Detail = 'config not found at CCC root'
      if (root) {
        for (const candidate of DEFAULT_SERENITY_CONFIG_PATHS) {
          if (existsSync(resolve(root, candidate))) {
            p3Pass = true
            p3Detail = `${candidate} found`
            break
          }
        }
      }
      const allPass = p1Pass && p2Pass && p3Pass
      const report: Record<string, unknown> = {
        ccc: cccName,
        root,
        version: ACC_VERSION,
        status: allPass ? 'healthy' : 'degraded',
        principles: {
          P1_rooted: {
            pass: p1Pass,
            detail: p1Pass ? '.serenity marker found' : '.serenity marker missing',
          },
          P2_git_managed: {
            pass: p2Pass,
            detail: p2Pass ? 'git repository verified' : 'not in a git repository',
          },
          P3_binary_permissions: {
            pass: p3Pass,
            detail: p3Detail,
          },
        },
      }
      // dsp 增强：版本自省（升级提示依据）
      if (root) {
        report.config = loadSerenityConfig(root)
      }
      report.accVersion = ACC_VERSION
      report.dshVersion = readDshVersion()
      return report as JsonValue
    }
    case 'time': {
      const now = new Date()
      return {
        now_iso: now.toISOString(),
        now_local: now.toString(),
        epoch_ms: now.getTime(),
      }
    }
    case 'wait': {
      const seconds = args.seconds ?? 1
      if (!Number.isInteger(seconds) || seconds <= 0) {
        throw new Error('wait 需要正整数秒数（缺省 1）')
      }
      await new Promise((r) => setTimeout(r, seconds * 1000))
      return `waited ${seconds}s`
    }
    default:
      throw new Error(`未知 action: ${args.action as string}`)
  }
}

export { loadSerenityConfig }
