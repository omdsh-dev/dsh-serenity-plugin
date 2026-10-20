/**
 * trajectory/alive.ts — **"这个 dsh 会话还活着吗"的唯一判据**（owner 2026-10-20 裁决）
 *
 * ## owner 的原话（本模块的全部设计依据）
 *
 * > 「死应该包含归档判断；只有 ① 或者 ②且不在归档集 才算活」
 * > 「use 只要被调用了，可以无条件覆盖绑定到当前会话（这说明当前会话肯定活着啊）」
 *
 * ## 为什么必须收成一个判据（在此之前有三个互不一致的判据）
 *
 * | # | 判据 | 旧实现位置 | 单独使用时的漏洞 |
 * |---|---|---|---|
 * | ① | 进程内 loaded agent | `hostAgents(ctx).get(id)` | 冷会话全判死 |
 * | ② | 磁盘上有会话日志 | `hasSessionLogById()` | **归档后日志逐字节不动** ⇒ 归档会话判活 |
 * | ③ | 宿主归档集 | `workspaceRegistry.archivedSessionIds` | 旧 dsp **零引用**（整个仓库 0 处） |
 *
 * 宿主的归档语义是**只往集合里加一个 id、不动日志**（`dsh-workspace` 的
 * `archiveSession` 注释：「Archiving never touches workspace accounting」）。
 * ⇒ 只问 ② 的实现在归档上**必然判错**，而那个错误没有任何机械信号。
 *
 * ## 判据（owner 给定，逐字实现）
 *
 * ```text
 * 活 ⟺ ①                       （进程内 loaded ⇒ 一定在）
 *    ∨ (② ∧ 不在归档集)          （日志在、且没人把它归档掉）
 * ```
 *
 * 🔴 **一处对原话的收紧（必须说出来，不许默默改）**：owner 的 ① 未附加"不在归档集"，
 * 而本模块把**归档判定排在最前** —— 即 `归档 ∧ live ⇒ 判死`。理由：归档是**人对这条会话
 * 的处置声明**（宿主会把它从所有分组面隐藏），若仍被当成载体，唤醒调度器会去驱动一条
 * **使用者以为已经收起来**的会话。⚠️ 与字面规则的差异仅此一格；`use` 不受影响
 * （见下方 §use 逃生门），因此真需要复活一条已归档会话时**仍然有受支持的路**。
 *
 * ## 🔴 `use` 的逃生门（owner 第二条，写在调用点）
 *
 * **`use` 不查存活**：它被调用这件事本身证明**当前会话活着**（本模块的被测对象是
 * "别人写的那个 id"，而 `use` 手里拿的是**自己**）。⇒ `use` 走无条件覆盖
 * （`claimBinding` 的 `takeover`），因此**判据再严也不会把一条轨迹锁死**。
 * 这条逃生门是判据可以取严的前提，两者必须一起存在。
 *
 * ## 依赖纪律
 *
 * 纯判据 `isSessionAlive` 零依赖、可单测；宿主面只在 `hostAliveProbe` 里，
 * 且**不抛错**（服务缺失 ⇒ 该维度作废，而不是让 ACC 工具整块失败）。
 */

import { hostAgents, hostService } from '../host/access.js'
import { hasSessionLogById, sessionsRootDir } from './cleanup.js'

/**
 * 判活所需的三个事实（**纯数据**，由调用方去宿主/磁盘取）。
 *
 * 分开的理由与 `bind-file.ts` 的 `isBindUsable` 同款：把"判断"与"取数"拆开，
 * 判据可单测、不依赖 cordis。
 */
export interface SessionAliveFacts {
  /** ① 进程内 loaded（`hostAgents.get` 命中即算） */
  readonly liveIds: ReadonlySet<string>
  /** ③ 宿主归档集（`workspaceRegistry.archivedSessionIds`） */
  readonly archivedIds: ReadonlySet<string>
  /** ② 磁盘上还有这条会话的日志（`hasSessionLogById`） */
  readonly hasLog: (sessionId: string) => boolean
}

/**
 * **唯一的存活判据**（owner 2026-10-20）。
 *
 * @param sessionId dsh 会话 id（`session-<uuid>`，或 `skiff-*` 这类无前缀的）
 * @param facts 三个事实
 * @returns 活 ⇒ true
 *
 * 🔴 求值顺序是**判据的一部分**（不是优化）：归档先于 live，
 * 因为"归档"是对会话的**处置声明**，而 live 只说明字节还在内存里。
 */
export function isSessionAlive(sessionId: string, facts: SessionAliveFacts): boolean {
  if (sessionId === '') return false
  // ③ 归档优先：被归档 = 人已经把它收起来了 ⇒ 一律判死（含"仍然 loaded"那一格）
  if (facts.archivedIds.has(sessionId)) return false
  // ① 进程内 loaded
  if (facts.liveIds.has(sessionId)) return true
  // ② 日志在磁盘上（且未被归档，见上）
  return facts.hasLog(sessionId)
}

/** 宿主侧的归档集读取（不可用 ⇒ 空集 = 该维度作废，**不是**把所有会话判死） */
function archivedIdsOf(ctx: unknown): Set<string> {
  try {
    const reg = hostService<{ archivedSessionIds?: readonly string[] }>(ctx, 'workspaceRegistry')
    const ids = reg?.archivedSessionIds
    return new Set(Array.isArray(ids) ? ids : [])
  } catch {
    return new Set()
  }
}

/**
 * **宿主面的判活探针**（`(sessionId) => boolean`）——所有需要"这条会话还活着吗"的
 * 生产代码都应当用这一个，不要自己拼 `agents.get` ＋ `hasSessionLogById`。
 *
 * 语义 = {@link isSessionAlive}，其中：
 *  · `liveIds` 因为宿主只给 `get(id)` 而**按 id 逐次问**（不是集合）；
 *  · `archivedIds` 在**首次调用时**取一次快照并在闭包内复用（每 tick 一个探针，
 *    归档集在一个 tick 内不变）—— 避免为每条轨迹重复读存储域。
 *
 * ⚠️ **快照的代价**：同一探针内若有人中途归档了某会话，本探针直到下次新建才看见。
 *    调度器是每 tick 新建一个探针（见 `wake/scheduler.ts`），故实际窗口 ≤1 tick。
 *
 * @param ctx 插件上下文（取 `agents` 与 `workspaceRegistry`）
 * @returns 探针；**永不抛**
 */
export function hostAliveProbe(ctx: unknown): (sessionId: string) => boolean {
  let archived: Set<string> | undefined
  const archivedOnce = (): Set<string> => (archived ??= archivedIdsOf(ctx))
  return (sessionId: string): boolean => {
    if (typeof sessionId !== 'string' || sessionId === '') return false
    if (archivedOnce().has(sessionId)) return false
    try {
      if (hostAgents(ctx)?.get?.(sessionId)) return true
    } catch {
      /* 取不到 ⇒ 交给日志判据 */
    }
    try {
      return hasSessionLogById(sessionsRootDir(), sessionId)
    } catch {
      // 磁盘读失败 ⇒ **保守判活**（与 `hasSessionLogById` 的 fail-closed 同向：
      // 宁可留着一条绑定等人来看，也不要因为一次 IO 抖动把归属判成"无主"）
      return true
    }
  }
}

/**
 * 判据只有**两个**出口，别再开第三个：
 *  · {@link isSessionAlive} —— 纯判据（给定事实），单测的靶子；
 *  · {@link hostAliveProbe} —— 生产入口（自己去宿主与磁盘取事实）。
 *
 * ⚠️ 曾有一个 `aliveFactsFor`（把探针摊平成 `SessionAliveFacts`），**全仓零调用点**，
 * 已删除 —— 留一个"看起来有用、实际无人调用"的导出，会让下一个人以为存在第二条判活路径
 * （本仓同族教训：`cheapWorkerPresetInheritance` 全仓零调用点 ⇒ 接线断了却看不出来）。
 */
