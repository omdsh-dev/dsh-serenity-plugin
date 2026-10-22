/**
 * seams/tool-visibility.ts — **工具可见性的单点收敛**（2026-10-22，owner 裁「方案 C」）
 *
 * ## 为什么要有这个模块（问题定义）
 *
 * 在它之前，工具可见性由**六条各自独立的 sync 函数**维护，每条自己持有一个
 * per-会话的 `restrict` disposer：
 *
 * | 机制 | 决定什么被隐藏 |
 * |---|---|
 * | `syncSafeModeRestriction` | 安全模式的基础表（`bash` 等）∪ CCC 声明的 `hiddenTools` |
 * | `syncCccToolVisibility` | 不在任何 CCC 内 ⇒ 隐藏**全部** ACC 工具 |
 * | `syncImBridgeVisibility` | 无 IM 账号 ⇒ 隐藏 `im-bridge` |
 * | `syncExclusiveToolsVisibility` | CCC 未声明 ⇒ 隐藏 `acc-diag` |
 * | `syncHostScheduleToolHiding` | 在 CCC 内 ⇒ 隐藏宿主 `schedule_*` |
 * | `syncTrajectoryConstraintToolVisibility` | 白名单之外 ⇒ 隐藏 |
 *
 * 它们**各自独立地**在 `pre-step`（每步）与 `seed`（冷载入）里被调用，于是同一个会话
 * 在一次交互里可能被发出**多次** `tools.restrict`。宿主每次收到 restrict 都会触发
 * `tools/change`，模型侧于是看到工具清单**先进后出**（微信/飞书实测：7 个工具"新增"后
 * 紧接着"移除"）。
 *
 * ## 为什么合并是"语义等价"，不是"简化"
 *
 * 宿主契约逐字（`dsh-tools` 的 `ToolRuntime.restrict`）：
 * > Restrictions **intersect**; scoped registrations remain visible.
 *
 * 即 N 次 `restrict({deny: D₁}) … ({deny: Dₙ})` 的净效果 = `deny: D₁ ∪ … ∪ Dₙ`。
 * ⇒ 把六个集合**先求并集、只发一次**，与发六次**结果相同**，但只触发一次 `tools/change`。
 * ⚠️ 前提：**全部只用 `deny`、不用 `allow`**（`allow` 的并集≠交集）。
 * 本仓 18 处 restrict 实测**全部只发 `deny`**；本模块把这条前提**写成断言式契约**
 * （见 {@link TOOL_VISIBILITY_DENY_ONLY}），将来谁引入 `allow` 会在这里被挡住。
 *
 * ## 设计：计算与发射分离（正确性优先）
 *
 * - **计算**（{@link collectVisibilityDecision}）= **纯函数**：读配置、算集合，**不碰宿主**。
 *   纯 ⇒ 可单测、可复算、可解释（"这个工具为什么被藏"只查这一处）。
 * - **发射**（{@link applyVisibilityDecision}）= 唯一的写点：签名不变则**一个字节都不发**。
 *
 * 🔴 **正确性不依赖"能发出去"**：每个来源各自记录**失败原因**，失败只影响它自己那一格，
 * 不会因为一次合并发射失败就把六格全丢掉（这是合并最容易犯的错，也是 owner 说
 * "写起来难度比较高"的地方）。发射层对此的处理见 {@link applyVisibilityDecision}。
 */
import type { Context } from 'cordis'

/** 一次 restrict 的 deny 集合来源（每个来源**独立成败**，互不连累） */
export interface VisibilitySource {
  /** 稳定标识（诊断与去重用；例：`safeMode` / `im-bridge` / `hostSchedule`） */
  readonly id: string
  /** 本来源要隐藏的工具名（已去重前的数组；由收集器统一去重） */
  readonly deny: readonly string[]
  /**
   * 本来源的判据是否成立。
   * - `false` ⇒ 本来源**不贡献** deny（等价于它"没意见"），**不是**错误。
   * - 读取配置抛错等情况由来源自己决定返回 `false` 还是抛（收集器会捕获并降级）。
   */
  readonly ok: boolean
  /** `ok=false` 且确实出了错（不是"判据不成立"）时的一句话，用于诊断 */
  readonly error?: string
}

/** 一次可见性判决（纯数据，可 JSON 化，便于诊断与测试断言） */
export interface VisibilityDecision {
  /** 合并后的 deny（已去重、已排序 —— 排序让签名稳定、可比较） */
  readonly deny: string[]
  /** 参与判决的来源（含失败的），用于诊断"谁把工具藏了" */
  readonly sources: readonly VisibilitySource[]
  /** 是否有任一来源报错（决定要不要打日志；**不影响** deny 的计算） */
  readonly hasError: boolean
}

/**
 * 🔴 本模块的**准入契约**：可见性判决只允许用 `deny`。
 *
 * 宿主 `restrict` 同时支持 `allow` 与 `deny`，而**两者不可混用合并**：
 * `allow: A₁` 与 `allow: A₂` 的交集是 `A₁ ∩ A₂`，**不是并集**。
 * ⇒ 若将来某个来源想"只保留某几个工具"，它**不能**塞进本模块，
 * 必须自己单独发一条 restrict（那条会与本次的 deny 正常求交）。
 * 该常量是这条契约的**机器可读声明**（测试据此钉住）。
 */
export const TOOL_VISIBILITY_DENY_ONLY = true

/** 收集器：把各来源的 deny 合并成一个判决（**纯函数、无副作用**） */
export function collectVisibilityDecision(sources: readonly VisibilitySource[]): VisibilityDecision {
  const deny = new Set<string>()
  let hasError = false
  for (const s of sources) {
    if (s.error !== undefined) hasError = true
    if (!s.ok) continue // 判据不成立 ⇒ 不贡献（不等于"放行"，只是它没意见）
    for (const name of s.deny) {
      if (typeof name === 'string' && name !== '') deny.add(name)
    }
  }
  return {
    deny: [...deny].sort(),
    sources,
    hasError,
  }
}

/** 判决签名（幂等判据：签名相同 ⇒ 目标态已达到 ⇒ **一次 restrict 都不发**） */
export function decisionSignature(decision: VisibilityDecision): string {
  return decision.deny.join(',')
}

/** 每个会话当前的发射状态 */
interface AppliedState {
  signature: string
  deny: string[]
  dispose: () => void
}

/** `${sessionId}` → 已发射状态（**全模块唯一的一份**） */
const applied = new Map<string, AppliedState>()

/** 诊断：当前每个会话的可见性状态（排查"某工具为何不可见"） */
export function getToolVisibilityDiagnostics(): {
  keys: string[]
  denyByKey: Record<string, string[]>
} {
  return {
    keys: [...applied.keys()],
    denyByKey: Object.fromEntries([...applied].map(([k, v]) => [k, v.deny])),
  }
}

/**
 * 发射一次判决（**唯一的写点**）。
 *
 * 三条纪律：
 * ① **幂等**：签名与当前已发射的一致 ⇒ 直接返回 `'unchanged'`，**不碰宿主**
 *    （这正是消除"工具清单闪动"的那一步）。
 * ② **先撤后发**：宿主的 disposer 才是"撤销上一次"，先撤再发才不会叠加旧集合。
 *    （旧集合是新集合的子集时叠不叠都看不出来，但**不是子集时**会残留 —— 必须撤。）
 * ③ 🔴 **未注册的名字不许炸掉整次发射**：宿主契约"unknown names … fail"。
 *    合并后集合里只要有一个不在册的名字，整次 restrict 就失败 ⇒ 六个机制**全都不生效**。
 *    ⇒ 发射前**先逐个探活**（`tools.get(name)`），把不在册的名字剔掉并**如实记账**
 *    （剔除的名字进 `dropped`，由调用方决定要不要告警）。
 *    ⚠️ 这比旧行为**更保守**：旧行为是"某条 restrict 失败 ⇒ 那一格静默不生效"，
 *    新行为是"剔掉那个名字、其余照常生效" —— **等价或更好**，且总有日志。
 *
 * @returns `'unchanged'` ／ `'applied'` ／ `'failed'`（`failed` 时 `deny` 保持原样）
 */
export function applyVisibilityDecision(
  agent: { ctx: { tools: { restrict(f: { deny: string[] }): () => void; get?(n: string): unknown } } },
  sessionId: string,
  decision: VisibilityDecision,
): { status: 'unchanged' | 'applied' | 'failed'; dropped: string[]; error?: string } {
  const signature = decisionSignature(decision)
  const existing = applied.get(sessionId)

  if (existing !== undefined && existing.signature === signature) {
    return { status: 'unchanged', dropped: [] }
  }

  // ① 先撤旧的（否则新集合会与旧集合求交 —— 少藏一个就是一个缺陷）
  if (existing !== undefined) {
    try {
      existing.dispose()
    } catch {
      /* 旧 disposer 已失效（会话销毁等）⇒ 直接发新的 */
    }
    applied.delete(sessionId)
  }

  // ② 探活：剔掉不在册的名字（宿主 unknown names ⇒ 整次失败）
  const tools = agent.ctx.tools
  const dropped: string[] = []
  let names = decision.deny
  if (typeof tools.get === 'function') {
    names = []
    for (const n of decision.deny) {
      let present = false
      try {
        present = tools.get(n) !== undefined
      } catch {
        present = false
      }
      if (present) names.push(n)
      else dropped.push(n)
    }
  }

  // ③ 全部都不需要藏 ⇒ 不发射（撤销即可，已经撤过了）
  if (names.length === 0) {
    // 🔴 签名必须记**原始判决**（不是 ''）：否则下一轮拿 '' 与真签名比 ⇒ 判成"变了"
    //    ⇒ 每步重算一次 —— 那正是本次要修的"闪动"（变异检验：记 '' ⇒ 幂等用例红）
    applied.set(sessionId, { signature, deny: [], dispose: () => {} })
    return { status: 'applied', dropped }
  }

  try {
    const dispose = tools.restrict({ deny: [...names] })
    // ⚠️ 签名记**原始判决**（不是剔名后的），否则下一轮会把"被剔掉的名字"当成变化而反复重算
    applied.set(sessionId, { signature, deny: names, dispose })
    return { status: 'applied', dropped }
  } catch (e) {
    // 发射失败：**不记账**，让下一轮重试（最坏是每步重试一次，但不会留下错误的目标态）
    return { status: 'failed', dropped, error: (e as Error).message }
  }
}

/** 会话销毁清理（防 per-会话 Map 无界增长；lifecycle 调用） */
export function forgetToolVisibility(sessionId: string): void {
  const existing = applied.get(sessionId)
  if (existing === undefined) return
  try {
    existing.dispose()
  } catch {
    /* disposer 已失效 */
  }
  applied.delete(sessionId)
}
