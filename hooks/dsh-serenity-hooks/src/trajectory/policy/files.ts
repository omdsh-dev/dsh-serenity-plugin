/**
 * trajectory/policy/files.ts — **轨迹级文件的文件名族**（owner 2026-10-19 裁 Q2：短名 `trajectory.json`）
 *
 * ## 这一层解决什么（白话）
 *
 * 一条轨迹目录里，ACC 自己产的文件原先有**四个名字各异的文件**：
 * `trajectory-constraint.json`（约束面）／`TRAJECTORY-UID`（只读遗留的旧标识）／
 * `cro-host-binding`（一行机器名）／`cro-wake-log.json`（CRO 流水）。
 * 后两个里，**「声明」性质的那两个现在并进一个 JSON**（流水不并 —— 见 `cro/log.ts` 的理由）。
 *
 * ⇒ 收拢后的形态：
 *
 * ```text
 * <轨迹目录>/
 *   SESSION.md                 ← 轨迹的身体（不动）
 *   PROMPT.md                  ← 章程（不动）
 *   continuous-re-occurrence.ts← CRO 程序（不动）
 *   trajectory.json            ← 🆕 声明面：约束 ＋ 旧标识(code) ＋ cro.host
 *   cro-wake-log.log           ← CRO 流水（高频追加，**刻意不并入**）
 * ```
 *
 * ## 🔴 为什么不硬切（本容器已两次栽在"上游改名、下游写死旧名"）
 *
 * 读取侧认**族**：`trajectory.json`（新）→ `trajectory-constraint.json`（v1.74 名）→
 * `skiff.json`（v1.71 名）。**任一存在即成立**。上游再改名只往族里加一项，不再单点写死。
 *
 * 🔴 **`cro-host-binding` 必须两代并读，这一条是有行为后果的**
 * （理由逐字保留在 `cro/core.ts` 的 `resolveCroHostBinding` 头注）：
 * 绑定声明要**跟着轨迹走到第二台机器**，在那里被判成「绑给了别人」而**正确地不跑**。
 * 若硬切改名，第二台机器读到的是**「没绑」** —— **表面结果相同，但判据退化**
 * （失去"明确绑给别人"的可诊断性）⇒ 只能两代并读。
 *
 * ## 归属（D23）
 * 本模块只管**机制**（文件叫什么、按什么顺序找、怎么读）；**内容归 CCC**
 * （JSON 里填什么：模型 / 白名单 / 提示词路径 / 机器名）。
 *
 * ## 边界与铁律
 * 本模块**零本地依赖**（只用 `node:fs` / `node:path`）⇒ 谁 import 它都不会成环。
 * 每个读取函数**永不抛**：文件不存在 / 坏 JSON ⇒ `null`，由调用方各自决定降级方式。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 收拢后的**新**文件名（owner 裁 Q2「短名」）。
 *
 * 🔴 **为什么要改名**：它装的不止"约束"了（还有 `code` 与 `cro.host`）
 * ⇒ 留着旧名会让**名字本身就是错名**（D151 同族：界面/文档里的名字会随内容演进而撒谎）。
 */
export const TRAJECTORY_FILENAME = 'trajectory.json'

/**
 * **判据族**：任一存在 ⇒ 这条轨迹有声明面（= 旧模型说的"它是一个轨迹约束"）。
 *
 * ⚠️ **顺序即优先级**（第一个找到的胜过后面的）：新名优先，两个旧名按代际倒序。
 * ⚠️ **准入面宽于约束面是有意的**：约束文件缺失的轨迹仍需要能被当作轨迹处理。
 */
export const TRAJECTORY_FILENAME_FAMILY = [
  TRAJECTORY_FILENAME, // 新（写只写它）
  'trajectory-constraint.json', // v1.74
  'skiff.json', // v1.71（更早）
] as const

/** 旧名的单独导出（调用方要单独判断"这是不是旧档"时用；顺序同上、不含新名） */
export const TRAJECTORY_LEGACY_FILENAMES = TRAJECTORY_FILENAME_FAMILY.slice(1)

/**
 * 在一条轨迹目录里找**声明文件**（族内第一个存在的）。
 *
 * @param trajectoryDir 轨迹目录绝对路径
 * @returns 命中的文件绝对路径；族内一个都不存在 ⇒ `null`（= 普通轨迹，**常态不是错误**）
 */
export function findTrajectoryFile(trajectoryDir: string): string | null {
  for (const name of TRAJECTORY_FILENAME_FAMILY) {
    const p = join(trajectoryDir, name)
    try {
      if (existsSync(p)) return p
    } catch {
      /* 单条查不到 ⇒ 试下一个（不抛） */
    }
  }
  return null
}

/**
 * 读一条轨迹目录里的声明文件，解析成对象（**永不抛**）。
 *
 * @returns `{ file, data }`：`file` 是命中的文件名（族内哪个），`data` 是解析后的对象；
 *          **族内无文件 ⇒ `null`**；**坏 JSON / 顶层非对象 ⇒ `{ file, data: null, error }`**
 *          —— 这三种情形调用方的降级方式各不相同（普通轨迹 / 告警后按普通轨迹），故分开给。
 */
export function readTrajectoryFile(
  trajectoryDir: string,
): { file: string; data: Record<string, unknown> | null; error: string | null } | null {
  const file = findTrajectoryFile(trajectoryDir)
  if (file === null) return null
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf-8'))
  } catch (err) {
    return { file, data: null, error: `JSON 解析失败（${String((err as Error)?.message ?? err)}）` }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { file, data: null, error: '顶层不是对象' }
  }
  return { file, data: raw as Record<string, unknown>, error: null }
}
