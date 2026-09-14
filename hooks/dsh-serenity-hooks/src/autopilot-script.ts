/**
 * autopilot-script.ts — 包内 autopilot 脚本通道（v1.33 提取；S142 §32「logbook × trajectory 合并」）
 *
 * 为什么单独成模块（R↓）：autopilot 的三个动作（`autopilot-status` / `autopilot-init` /
 * `generate-autopilot-bias`，原 `all` / `init` / `random`）**归 `container_admin`**，而
 * 脚本定位与执行逻辑此前长在 `tools/autopilot-trajectory.ts` 里。若不提取，要么在两处
 * 重复 spawn 逻辑（熵），要么让 container_admin 依赖一个即将删除的工具文件（错向依赖）。
 * ⇒ 提取为**单真相源**：脚本定位（`findExpScript` / `EXP_SCRIPT`）+ 执行（`runAutopilotScript`）。
 *
 * 脚本本体：`experiments/autopilot-trajectory/scripts/autopilot-trajectory.ts`（随 npm files 分发）。
 * 契约：argv[2] = 子命令（`all` | `init` | `random` | `diag` | `doc` | `check` | `status` | `guide`），
 * 环境变量 `SERENITY_ROOT` = CCC 根；stdout 即人读结果。
 * ⚠️ 脚本侧的 `diag`/`doc`/`check`/`status`/`guide` 已**不在 CCC 工具面**（S142 §32.9：
 * `diag` 归 ACC 负责人、其余并入 `autopilot-status`）——脚本保留这些子命令以便开发面直接调用。
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 定位包内脚本（npm files 分发 experiments/autopilot-trajectory/）。
 * 布局差异：tsdown bundle 后 import.meta.url 指向 lib/index.js（lib → 包根 1 层）；
 * vitest 源码直跑时指向 src/tools/x.ts（src/tools → 包根 2 层）——逐级上溯查找，
 * 两种布局都稳（找到 experiments/autopilot-trajectory/scripts/autopilot-trajectory.ts 即止）。
 * @param startDir 起始目录（通常为模块自身所在目录）
 * @returns 脚本绝对路径；未找到 null
 */
export function findExpScript(startDir: string): string | null {
  let cur = startDir
  while (true) {
    const cand = join(cur, 'experiments', 'autopilot-trajectory', 'scripts', 'autopilot-trajectory.ts')
    if (existsSync(cand)) return cand
    const parent = dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
}

/** 包内脚本（上溯查找；找不到 → 调用方报错提示包完整性） */
export const EXP_SCRIPT = findExpScript(dirname(fileURLToPath(import.meta.url)))

/** 脚本执行结果（人读；`error` 非空即失败，调用方不得静默） */
export interface AutopilotScriptResult {
  /** 成功时的 stdout（已 trim） */
  output?: string
  /** 失败原因（人读，含"包不完整/缺 bun/脚本退出码"三类） */
  error?: string
}

/**
 * 执行包内 autopilot 脚本（bun 优先；同步、10min 超时、注入 CCC 根）。
 * @param root CCC 根（注入 `SERENITY_ROOT`；null 则靠脚本自行上溯 .serenity）
 * @param action 脚本子命令（`all` | `init` | `random` | …）
 * @returns `{ output }` 或 `{ error }`（不抛错——调用方决定如何呈现）
 */
export function runAutopilotScript(root: string | null, action: string): AutopilotScriptResult {
  if (!EXP_SCRIPT || !existsSync(EXP_SCRIPT)) {
    return {
      error:
        `autopilot 脚本未随安装分发（缺少 experiments/autopilot-trajectory/scripts/autopilot-trajectory.ts` +
        `${EXP_SCRIPT ? `，期望路径 ${EXP_SCRIPT}` : ''}）——请检查 npm 包完整性`,
    }
  }
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (root) env.SERENITY_ROOT = root
  const r = spawnSync('bun', [EXP_SCRIPT, action], {
    encoding: 'utf-8',
    timeout: 600_000,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (r.status === 0) return { output: r.stdout?.trim() || '(empty)' }
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    return { error: 'autopilot 脚本需要 bun 运行时（bun not found in PATH）' }
  }
  return { error: r.stderr?.trim() || r.stdout?.trim() || `exit ${r.status ?? '?'}` }
}
