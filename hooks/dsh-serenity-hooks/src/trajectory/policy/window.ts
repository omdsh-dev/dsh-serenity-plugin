/**
 * trajectory/policy/window.ts — 会话 → 轨迹 的内存映射（零 DSH 依赖）
 *
 * ## 它现在只做一件事：**把「会话」映到「轨迹」**
 *
 * 旧形态存的是 `{role, ccc}`（角色名）。owner 2026-10-19 重做后 **角色名不再存在**——
 * 轨迹约束的身份是**轨迹编码**，约束面住在该轨迹的 `trajectory-constraint.json` 里（见 `./profile.ts`）。
 * ⇒ 本表退化为一张**会话 → 轨迹目录名**的内存映射，供**同步**热路径（guards / system-prompt）查询；
 * 权威来源仍是持久绑定（`trajectory/bound.ts` 的 `readLastBound`）。
 *
 * ## S12（2026-10-19，轨迹中心重构）：原名 `role/轨迹约束/registry.ts`
 *
 * 改名理由：它**不是**一张"注册表"（注册表的语义是权威名单），它是**权威来源之外的一个窗口**——
 * 覆盖「轨迹已定、绑定还没落盘」那一段（见下方「为什么还需要这张内存表」）。
 * `registry` 这个名字会让下一个人以为它是权威，而权威在 `bound.ts` ⇒ 改叫 `window`。
 *
 * ## 为什么还需要这张内存表（R↓，一个窗口期）
 *
 * 持久绑定是**异步落盘**的（宿主存储域写入）。会话刚建立、`trajectory-constraint.json` 已生效、绑定的记录
 * 还没落盘的那一段，`readLastBound` 返回 null ⇒ 若只认持久绑定，**第一轮会被判成"不是 轨迹约束"**
 * ⇒ 工具面不收窄（模型看见并会去试它不该有的工具）。
 * ⇒ 两个来源并取（见 `profile.ts` 的 `trajectoryConstraintForSession`），**都不中才判"不是"**。
 *
 * ## 生命周期
 * 进程内存态：连接/会话关闭时解绑（`lifecycle.ts`），进程重启自然清空
 * （此时持久绑定已落盘 ⇒ 由它接管，**不会因为内存空而失去约束**）。
 */

/** 注册表值：该 dsh 会话承载哪条轨迹（`trajectoryDirName` 为空串 = 已登记但还没定轨迹） */
interface TrajectorySessionBinding {
  /** 轨迹目录名（`YYYY-MM-DD--<code>[--<desc>]`）——**轨迹身份的唯一载体** */
  trajectoryDirName: string
  /** CCC 根（多 CCC 时防止串味：同 sessionId 复用必须同 (轨迹, CCC)） */
  ccc: string
}

/** sessionId → 绑定的轨迹（**进程内**；跨重启的权威来源是 `trajectory/bound.ts` 的持久绑定） */
const trajectorySessions = new Map<string, TrajectorySessionBinding>()

/** 登记/更新一个会话 → 轨迹的映射 */
export function registerTrajectorySession(sessionId: string, trajectoryDirName: string, ccc: string): void {
  trajectorySessions.set(sessionId, { trajectoryDirName, ccc })
}

/** 解绑（会话销毁 / 轨迹失效 ⇒ 换身份） */
export function unregisterTrajectorySession(sessionId: string): void {
  trajectorySessions.delete(sessionId)
}

/** 查会话承载的轨迹目录名（无 → null）；`guards`/`system-prompt` 的同步热路径用 */
export function trajectoryDirNameForSession(sessionId: string): string | null {
  const b = trajectorySessions.get(sessionId)
  return b === undefined || b.trajectoryDirName === '' ? null : b.trajectoryDirName
}

/** 查会话的完整绑定（轨迹 + CCC；无 → null）——追问延续时校验 (轨迹, CCC) 未串味 */
export function trajectorySessionInfo(sessionId: string): TrajectorySessionBinding | null {
  return trajectorySessions.get(sessionId) ?? null
}

/** 测试/诊断：注册表快照 */
export function trajectorySessionSnapshot(): ReadonlyMap<string, TrajectorySessionBinding> {
  return new Map(trajectorySessions)
}

/** 测试：清空（进程级状态，用例间必须复位） */
export function resetTrajectorySessions(): void {
  trajectorySessions.clear()
}
