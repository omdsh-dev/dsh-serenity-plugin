import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerTrajectorySession } from '../../src/trajectory/policy/window.js'
import { TRAJECTORY_CONSTRAINT_FILENAME, trajectoryConstraintForSession, type TrajectoryConstraint } from '../../src/trajectory/policy/profile.js'

/**
 * 轨迹约束 测试夹具（**2026-10-19 重做后**的单一造数据入口）。
 *
 * ## 为什么必须有这个文件（R↓）
 *
 * 重做把 轨迹约束的**配置载体**从 `serenity.json` 的 `轨迹约束.roles.<name>` 改成了
 * **轨迹目录下的 `trajectory-constraint.json`**。旧测试到处写 `writeConfig({ 轨迹约束: { roles: {...} } })`
 * —— 那个形状现在**读到也是空**（该段已退役）⇒ 183 个用例会以"白名单不生效"的形式集体变红，
 * 而每处红的表面原因看起来都不一样。
 *
 * ⇒ 把"造一条 轨迹约束轨迹 + 登记会话"收成两个函数，测试只描述**意图**（哪个会话、什么约束），
 * 不重复描述载体。
 */

/** 造一条轨迹目录（可选带 trajectory-constraint.json），返回目录名与绝对路径 */
export function makeTrajectory(
  root: string,
  code: string,
  profile?: Record<string, unknown> | null,
  desc = 'traj',
): { dirName: string; dir: string } {
  const dirName = `2026-10-19--${code}--${desc}`
  const dir = join(root, 'AGENT_SESSIONS', dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SESSION.md'), `# SESSION: ${code}\n`, 'utf-8')
  if (profile !== null && profile !== undefined) {
    writeFileSync(join(dir, TRAJECTORY_CONSTRAINT_FILENAME), JSON.stringify(profile), 'utf-8')
  }
  return { dirName, dir }
}

/**
 * 造一条 轨迹约束轨迹**并登记**某个会话承载它（= 测试里"这个会话是 轨迹约束"的完整前置）。
 *
 * @returns 该轨迹的目录名（`trajectorySessionInfo(sessionId).trajectoryDirName` 应等于它）
 */
export function make轨迹约束Session(
  root: string,
  sessionId: string,
  code: string,
  profile?: Record<string, unknown> | null,
  desc = 'traj',
): string {
  const { dirName } = makeTrajectory(root, code, profile ?? {}, desc)
  registerTrajectorySession(sessionId, dirName, root)
  return dirName
}

/** 常用约束面形状（工具/ MSM 白名单 + 纪律） */
export function 轨迹约束Json(opts: {
  tools?: string[]
  msms?: string[]
  model?: string
  systemPrompt?: string
  systemPromptFile?: string
  cognitiveTrajectory?: { session?: boolean; keeper?: boolean; rebuild?: boolean }
}): Record<string, unknown> {
  return {
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
    ...(opts.msms !== undefined ? { msms: opts.msms } : {}),
    ...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
    ...(opts.systemPromptFile !== undefined ? { systemPromptFile: opts.systemPromptFile } : {}),
    ...(opts.cognitiveTrajectory !== undefined ? { cognitiveTrajectory: opts.cognitiveTrajectory } : {}),
  }
}

/** 直接读一个会话的约束面（测试断言用；等价于生产代码的查询路径） */
export function profileFor(root: string, sessionId: string): TrajectoryConstraint | null {
  return trajectoryConstraintForSession(root, sessionId)
}
