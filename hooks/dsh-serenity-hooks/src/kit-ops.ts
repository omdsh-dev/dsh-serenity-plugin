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
import { findSerenityRoot, findGitRoot, loadSerenityConfig, pathInside, DEFAULT_SERENITY_CONFIG_PATHS } from './ccc.js'
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

/**
 * MSM 注册表完整性检查（需求⑤c S142 用户："要有ACC层检查方法检查注册表没坏，这东西太核心了"）。
 * 注册表坏 → loadMsmEntries JSON.parse 抛 → acc_msm/skiff-admin/output-guard/session 全崩 +
 * register 判重也 loadMsmEntries → **自锁无法自救**（R7）——health 必须**不因坏表抛错**，
 * 独立解析（不依赖 loadMsmEntries）逐项检查，坏 = ok:false + issues + 修复指引。
 *
 * 检查项（单级化后唯一聚合档 + root 级遗留）：
 *  - 文件存在（无注册表 = 空 ok——CCC 尚未注册 MSM 不视为坏）
 *  - JSON.parse 合法（剥 BOM；坏 JSON = 结构损坏）
 *  - 顶层 v1 wrapper（entries[]）或裸数组
 *  - 每 entry 字段类型（name/path/skill/category/description）
 *  - name 全局唯一（loadMsmEntries byName 去重语义——重复歧义）
 *  - path 根内 + 脚本存在（引用完整）
 *
 * 修复指引：register/deregister 每次变更精提交（只 add 注册表文件）→ 坏表可
 * `git checkout -- <registry>` 恢复（bash 可用时 / 用户手动 / cc_git 无 checkout 子命令——
 * 走 bash git restore，safe-mode 下建议用户介入）。工具只输出指引不代劳（用户拍板）。
 */
export interface RegistryHealthReport {
  /** 聚合档路径（相对 CCC 根）；无 cccName → null */
  path: string | null
  ok: boolean
  /** 该注册表文件是否存在（不存在 = 未注册任何 MSM，非坏） */
  present: boolean
  issues: string[]
}

export function checkRegistryHealth(root: string): RegistryHealthReport {
  const cccName = readCccName(root)
  if (!cccName) {
    // 无 cccName → 无法定位注册表：**既不算健康也不算坏**（无可检查对象）。
    // P3-④ review：旧实现 ok:true + issues 非空自相矛盾——统一为 issues 空 + ok:true
    // （path:null 本身已表达"无注册表可查"，不产生错误 issue）。
    return { path: null, ok: true, present: false, issues: [] }
  }
  const rel = `.opencode/skills/${cccName}/references/mech-registry.json`
  const abs = resolve(root, rel)
  if (!existsSync(abs)) {
    // 无注册表文件 = 空 CCC（未注册 MSM）——ok（不是坏）
    return { path: rel, ok: true, present: false, issues: [] }
  }
  const issues: string[] = []
  let raw = ''
  try {
    raw = readFileSync(abs, 'utf-8')
  } catch (err) {
    return { path: rel, ok: false, present: true, issues: [`registry unreadable: ${String((err as Error)?.message ?? err)}`] }
  }
  // 剥 BOM（Windows 编辑器 \uFEFF）
  let data: unknown
  try {
    data = JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch (err) {
    return {
      path: rel, ok: false, present: true,
      issues: [
        `registry JSON is broken: ${String((err as Error)?.message ?? err)}`,
        `Fix: restore from git — register/deregister auto-commits the registry (git checkout -- ${rel}; or git restore ${rel})`,
      ],
    }
  }
  const entries = Array.isArray(data) ? data : (data as { entries?: unknown })?.entries
  if (!Array.isArray(entries)) {
    return {
      path: rel, ok: false, present: true,
      issues: [
        'registry top-level is neither an array nor a v1 wrapper with entries[]',
        `Fix: restore from git (git checkout -- ${rel}; or git restore ${rel})`,
      ],
    }
  }
  const names = new Set<string>()
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as { name?: unknown; path?: unknown; skill?: unknown; category?: unknown }
    if (typeof e !== 'object' || e === null) {
      issues.push(`entry[${i}] is not an object`)
      continue
    }
    if (typeof e.name !== 'string' || e.name === '') issues.push(`entry[${i}]: name missing or not a string`)
    if (typeof e.path !== 'string' || e.path === '') issues.push(`entry[${i}] (${String(e.name ?? '?')}): path missing or not a string`)
    if (e.skill !== undefined && typeof e.skill !== 'string') issues.push(`entry[${i}] (${String(e.name ?? '?')}): skill not a string`)
    if (e.category !== undefined && typeof e.category !== 'string') issues.push(`entry[${i}] (${String(e.name ?? '?')}): category not a string`)
    if (typeof e.name === 'string' && e.name !== '') {
      if (names.has(e.name)) issues.push(`duplicate MSM name: "${e.name}" (entry[${i}]) — loadMsmEntries dedups by name, ambiguity`)
      names.add(e.name)
    }
    // path 引用完整（根内 + 脚本存在）——坏路径 = exec 会失败但注册表结构没坏；归为 issue
    if (typeof e.path === 'string' && e.path !== '') {
      const scriptAbs = resolve(root, e.path)
      // review P2-5：路径判断从 startsWith(root+'/') 改 pathInside（跨盘/平台安全——
      // Windows 全量误报 escape；pathInside 处理大小写 + 分隔符边界 + 跨盘）
      if (!pathInside(resolve(root), scriptAbs)) {
        issues.push(`entry[${i}] (${String(e.name ?? '?')}): path "${e.path}" escapes CCC root`)
      } else if (!existsSync(scriptAbs)) {
        issues.push(`entry[${i}] (${String(e.name ?? '?')}): script not found at "${e.path}"`)
      }
    }
  }
  return { path: rel, ok: issues.length === 0, present: true, issues }
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
      // 需求⑤c：MSM 注册表完整性检查段（用户：注册表太核心，要有 ACC 层检查方法检查没坏）
      if (root) {
        report.registry = checkRegistryHealth(root)
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
        throw new Error('wait requires a positive integer number of seconds (default 1)')
      }
      await new Promise((r) => setTimeout(r, seconds * 1000))
      return `waited ${seconds}s`
    }
    default:
      throw new Error(`Unknown action: ${args.action as string}`)
  }
}

export { loadSerenityConfig }
