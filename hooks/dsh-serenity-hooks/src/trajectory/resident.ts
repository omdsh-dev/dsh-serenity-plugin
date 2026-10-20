/**
 * trajectory/resident.ts — **常驻名单**（D173 的兑现口，`cognitive_trajectory resident` 的实现）
 *
 * ## 这条能力的判据（owner 2026-10-20 原话，逐字）
 *
 * > 「常驻的意思就是**自己声明为自己欢迎别人来麻烦自己**，和永不休眠没啥关系，
 * >   **trajectory never ends 悖论的一种实现**」
 *
 * ⇒ **常驻不是资源状态**。它不是"永不休眠"、不是"常驻内存"、不是"不许销毁我的会话"。
 *   一条轨迹**永远存在**（没有生命周期），常驻与否都不改变这一点。
 *
 * ⇒ **它管的是「被找到」，不是「不被销毁」。**
 *   两件事混为一谈，就会去动调度器的载体生命周期 —— 那正是本轨反复踩的"名字撒谎"。
 *
 * ## 因此本模块的三条硬边界
 *
 * 1. **纯读**：不写任何文件、不碰注册表、不碰 `wake/scheduler.ts`。
 * 2. **不进系统提示词**（owner 裁决 Q2：说明类信息按需取，不占每轮 token）。
 * 3. **只报写了 `serves` 的轨迹** —— 只写半个（有 `resident` 没 `serves`）等于
 *    "把自己挂上去却不说能干什么"，按手册的判据那比不写更坏，所以**不列出来**，
 *    但要**单独数出**来，让写的人知道自己的写法没生效。
 *
 * ## 归属（D23）
 * 机制在 ACC（怎么找、按什么顺序、列什么字段）；内容在 CCC（`serves` 那句话写什么）。
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { sessionsRoot } from './core.js'
import { readTrajectoryConstraintAt } from './policy/profile.js'

/** 名单里的一行 */
export interface ResidentEntry {
  /** 轨迹编码（身份） */
  code: string
  /** 轨迹目录名 */
  dirName: string
  /** 它自己说的"我擅长什么、能帮上什么忙" */
  serves: string
  /** 该轨迹是否另外声明了模型（方便找人时一并知道） */
  model?: string
}

/** 名单结果 */
export interface ResidentRoster {
  /** 可被找到的轨迹（写了 `resident.serves`） */
  entries: ResidentEntry[]
  /** ⚠️ 写了 `resident` 但 **没写 `serves`** 的编码（写半个 = 别人会来问错人） */
  incomplete: string[]
}

/**
 * 列出全部**可被找到**的轨迹（按编码排序，确定性）。
 *
 * ⚠️ 读盘失败 / 坏 JSON 一律**跳过该条**（不抛）：一份坏的声明不该让整张名单拿不到。
 *
 * @param root CCC 根
 */
export function collectResident(root: string): ResidentRoster {
  const entries: ResidentEntry[] = []
  const incomplete: string[] = []
  let names: string[] = []
  try {
    names = readdirSync(sessionsRoot(root), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
      .map((e) => e.name)
  } catch {
    return { entries, incomplete } // 没有 AGENT_SESSIONS/ = 没有轨迹（常态）
  }
  for (const dirName of names) {
    let profile
    try {
      profile = readTrajectoryConstraintAt(join(sessionsRoot(root), dirName), root)
    } catch {
      continue
    }
    if (!profile || profile.resident === undefined) continue
    const serves = profile.resident.serves
    if (serves === undefined || serves === '') {
      // 有字段、没内容 —— 单独数出来（写的人需要知道"你这样别人看不出你能干什么"）
      incomplete.push(profile.code)
      continue
    }
    entries.push({
      code: profile.code,
      dirName: profile.dirName,
      serves,
      ...(profile.model !== undefined ? { model: profile.model } : {}),
    })
  }
  entries.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
  incomplete.sort()
  return { entries, incomplete }
}

/**
 * 渲染成给模型读的文本（`cognitive_trajectory resident` 的返回值）。
 *
 * 🔴 **空名单也是有效结果**，且必须说清"这意味着什么" —— 否则读者会以为工具坏了。
 */
export function listResident(root: string): string {
  const { entries, incomplete } = collectResident(root)
  const lines: string[] = ['═══ 常驻轨迹（自己声明「欢迎别人来麻烦我」）═══', '']
  if (entries.length === 0) {
    lines.push('  （本 CCC 暂无轨迹声明常驻）')
    lines.push('  ⇒ 这不是错误：常驻是**自愿的自我声明**，没写就是"不参与被找"。')
  } else {
    for (const e of entries) {
      const model = e.model !== undefined ? `  [model: ${e.model}]` : ''
      lines.push(`  · ${e.code}${model}`)
      lines.push(`      ${e.serves}`)
    }
  }
  if (incomplete.length > 0) {
    lines.push('')
    lines.push(`  ⚠️ 写了 resident 但**没写 serves**（不会被列出）：${incomplete.join('、')}`)
    lines.push('     只写半个 = 把自己挂上去却不说能干什么 —— 别人会来问，然后发现问错了人。')
  }
  lines.push('')
  lines.push('── 怎么让自己出现在这里 ──')
  lines.push('  在你这条轨迹目录的 trajectory.json 里写：')
  lines.push('    { "resident": { "serves": "一句话说清我擅长什么、能帮上什么忙" } }')
  lines.push('  ⚠️ 只写这一个字段**不影响任何默认行为**（D183）；其余 key 全部可选。')
  return lines.join('\n')
}
