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
 *    ⇒ 策略 = **直接发 → 被拒时从宿主的错误文案里解析出它点名的未知名字 → 只剔那几个、其余重发一次**。
 *    被剔掉的名字进 `dropped`（调用方决定要不要告警）。
 *    ⚠️ **不做 `tools.get` 预探活** —— 那个视图查不出 agent-plane 贡献的工具
 *    （`bash` / `schedule_*`），会把**在册的名字误判成未注册**（见下方发射段的实测记录）。
 *    🔴 **也不按"谁注册的"降级** —— `REGISTERED_TOOLS` 只含 ACC 自己的 14 个，
 *    用它当"在册面"会**整类丢掉宿主工具**（2026-10-24 真机缺陷，见发射段）。
 *    ⇒ 唯一合法的在册判据是**宿主自己的回答**：要么发一次成功，要么它说出哪些名字不认识。
 *
 * @returns `'unchanged'` ／ `'applied'` ／ `'failed'`（`failed` 时 `deny` 保持原样）
 */
export function applyVisibilityDecision(
  // 🔴 类型里**故意不声明 `get`**：它不再参与任何判断，声明出来就等于给人留一条
  //    "用别的视图查表冒充在册判据"的路（v1.87.0 真机事故的正是这条路）。
  //    真宿主的 agent 结构上多一个 `get` 也照样能传进来（多余属性不参与结构检查）。
  agent: { ctx: { tools: { restrict(f: { deny: string[] }): () => void } } },
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

  // ② 发射 —— 🔴 **不做预探活**（2026-10-22 真机当晚纠正，见下）
  //
  // 第一版用 `tools.get(name)` 逐个探活来剔除未注册名。**真机一上线就炸**：
  // 日志打出「跳过 12 个未注册名（bash, exit_plan_mode, …, schedule_*）」——那 12 个**全部在册**。
  //
  // **根因**：宿主 `get(name, scope?)` 省略 scope = **全局视图**，而 `bash` / `schedule_*` 这类
  // 是**宿主的 agent-plane 贡献**（宿主文档逐字：*"Once presets moved them onto the agent plane
  // they became an ANCESTOR contribution"*）⇒ 从全局视图查它们**恒为 undefined**。
  // 后果比原缺陷更严重：`bash` 被剔 ⇒ **safe mode 的 bash 隐藏直接失效**。
  //
  // ⇒ 判据：**"这个名字在不在册"只能问宿主自己**（发一次就知道），
  //    ⛔ 不能拿"另一个视图的查表结果"冒充（D146 同族：判据必须打在真故障的那一维）。
  //
  // 🔴🔴 2026-10-24 真机缺陷（owner 报「工具在过程中变来变去」）——**上一版的降级档是错的**：
  //    上一版写 `accOnly = names ∩ REGISTERED_TOOLS`，而 `REGISTERED_TOOLS` 只含 **ACC 自己注册的**
  //    那些；`safeMode.hiddenTools` / `hostSchedule` 里的名字（`bash` / `job_*` / `workflow` /
  //    `schedule_*` / `exit_plan_mode` …）**全是宿主工具**，必然落在外面。
  //    ⇒ 全量一旦被拒，退档会把**宿主工具整类丢掉**（实测：14 个 deny 里 13 个是宿主名字，
  //    退档只剩 1 个）⇒ owner 看到的就是「藏了的不消失」。
  //    更糟：退档时记的签名是**全量**签名、实际只发了 accOnly ⇒ 下一轮签名相同 ⇒ `unchanged`
  //    ⇒ **永久不再重试**（二次缺陷，静默）。
  //
  // ⇒ 现策略（两段，都**只依赖宿主自己的回答**，不猜）：
  //    ① 直接发全量。
  //    ② 失败时**从宿主错误消息里解析出它点名的未知名字**（宿主逐字：
  //       `tools.restrict() names unknown global tool(s) "a", "b"; known global tools: …`），
  //       只剔掉**那几个**，其余**原样重发一次**。⇒ 不再按"谁注册的"猜，而是用**故障本身**定位。
  //    ③ 解析不出名字（错误文案变了 / 不是 unknown-name 类失败）⇒ 如实 `failed`、**不记账**
  //       （下一轮重试，保持"不留错误目标态"）。
  //    ④ 记账的签名必须与**实际发出**的集合一致（`appliedSignature`），否则重试永远不会发生。
  //    ⚠️ 解析失败时不退回旧的两档降级 —— 那正是本缺陷的成因；宁可 failed 让人看见。
  const tools = agent.ctx.tools
  const dropped: string[] = []
  const names = decision.deny

  // ③ 全部都不需要藏 ⇒ 不发射（撤销即可，已经撤过了）
  if (names.length === 0) {
    // 🔴 签名必须记**原始判决**（不是 ''）：否则下一轮拿 '' 与真签名比 ⇒ 判成"变了"
    //    ⇒ 每步重算一次 —— 那正是本次要修的"闪动"（变异检验：记 '' ⇒ 幂等用例红）
    applied.set(sessionId, { signature, deny: [], dispose: () => {} })
    return { status: 'applied', dropped }
  }

  try {
    const dispose = tools.restrict({ deny: [...names] })
    applied.set(sessionId, { signature, deny: names, dispose })
    return { status: 'applied', dropped }
  } catch (firstError) {
    const message = errorText(firstError)
    // ② 用**宿主点名的未知名字**定位，而不是用"谁注册的"猜
    const unknown = parseUnknownToolNames(message)
    if (unknown.length === 0) {
      // ③ 解析不出 ⇒ 如实失败、不记账（下轮重试）
      return { status: 'failed', dropped, error: message }
    }
    const unknownSet = new Set(unknown)
    const remaining = names.filter((n) => !unknownSet.has(n))
    dropped.push(...names.filter((n) => unknownSet.has(n)))
    if (remaining.length === 0) {
      // 全都不在册 ⇒ 无可发之名；**不记账**，下轮重试（宿主可能装上了那些包）
      return { status: 'failed', dropped, error: message }
    }
    try {
      const dispose = tools.restrict({ deny: remaining })
      // ④ 记**实际发出**的集合签名（不是全量）⇒ 全量再被算出时仍会重试，不会永久 unchanged
      applied.set(sessionId, { signature: decisionSignature({ ...decision, deny: remaining }), deny: remaining, dispose })
      return { status: 'applied', dropped }
    } catch (secondError) {
      return { status: 'failed', dropped, error: errorText(secondError) }
    }
  }
}

/** 取异常的可读文案（非 Error 也能取到 message；都没有则 String()） */
function errorText(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'object' && e !== null && 'message' in e && typeof (e as { message: unknown }).message === 'string') {
    return (e as { message: string }).message
  }
  return String(e)
}

/**
 * 从宿主的 `tools.restrict()` 错误文案里解析出**被点名的未知工具名**。
 *
 * 宿主逐字形态（`dsh-tools/lib/types/index.js` 的 `restrict()`）：
 * ```
 * tools.restrict() names unknown global tool(s) "a", "b"; known global tools: x, y, z
 * ```
 * 单数时是 `tool`，复数时是 `tool(s)`——两种都匹配。
 *
 * 🔴 **只取分号之前那一段**：分号后是 `known global tools:` 清单，**不能**误当成未知名字。
 * 🔴 解析不出来就返回 `[]`（调用方据此走"如实失败、不记账"），**绝不猜**。
 */
export function parseUnknownToolNames(message: string): string[] {
  // 必须在分号处截断：否则 known 清单会被一起扫进来
  const head = message.split(';')[0] ?? ''
  if (!/names unknown global tool/.test(head)) return []
  const out: string[] = []
  // 双引号包裹的名字（宿主用 `"${n}"` 拼接）
  for (const m of head.matchAll(/"([^"]+)"/g)) {
    const name = m[1]
    if (name !== undefined && name !== '') out.push(name)
  }
  return [...new Set(out)]
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
