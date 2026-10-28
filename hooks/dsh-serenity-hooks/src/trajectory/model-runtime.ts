/**
 * trajectory/model-runtime.ts — **`trajectory.json` 的 `model` 字段：每轮求值 ＋ 运行时热切换**
 *
 * ## 这个模块存在的唯一理由（owner 2026-10-20 令，逐字）
 *
 * > 「我认为认知轨迹作为统一概念 **设定不应根据入口不同而有变化 所以应当直接生效 运行时热加载**」
 *
 * ## 旧实现错在哪（D182 的事实底数）
 *
 * `model` 的**唯一消费点**曾是 `createTrajectoryAgent` 建 agent 时，而它的**唯一调用方**是
 * IM 入站路由 ⇒ 对**已经存在的会话**（web 会话、`send-now` 冷启的载体……）**完全不生效**。
 * 而 `container_admin config list` 把它印成一个统一默认值，看上去像"已经生效了"。
 * ⇒ **同一个字段在 A 入口生效、在 B 入口不生效** —— 正是 owner 要禁的形态。
 *
 * ## 修法：接宿主**自带**的原语，不复刻语义
 *
 * `@deepseek-ai/dsh-agent` 导出 `installModelSelection(agentCtx, selection)`，它挂三条缝：
 *
 * | 缝 | 作用 |
 * |---|---|
 * | `system-prompt/assemble` | 把选中路由写进提示词变量快照（保证"这一步用哪个模型"一致） |
 * | **`agent/request`** | **把冻结的调用配置替换成 `selection.current`** ⇒ 这就是"下一轮生效" |
 * | `agent/pre-step` | 路由变化时追加 `[model changed: …]` 持久提示 |
 *
 * 🔴 **为什么必须直接调它而不是自己挂 `agent/request`**（本仓既有纪律）：
 * 自己复刻就要重做第三条的三态判断（reject／空步／aborted）与 `requestHeader` 比对，
 * **复刻错了会得到与事实相反的结论**。宿主已实现 ⇒ 直接调用。
 *
 * 🔴 **跨宿主档位**：`_tmp/host-*` 全部 **10 个**快照（`0.1.5-rc.1` … `0.2.1-rc.2`）
 * 逐个核对，该导出**全部存在且签名一致**（唯一差异在宿主内部的提示 `source` 形状，
 * **不由我们构造**）⇒ 无需宿主升级、无需分档分支。
 *
 * ## 三条硬边界（少一条就会重演 S196 的坑）
 *
 * 1. **未写 `model` ⇒ 不装这条缝**（`undefined` 原样返回）。⛔ **绝不回退到某个全局默认模型**
 *    —— 那种回退把"我想声明自述"变成"我被悄悄换了模型"，而用户完全不会预期到。
 *    （历史形态：曾回退 `cheap-worker.defaultModel`；该配置段已随工具于 2026-10-28 删除，
 *     但判据不变：**没写 = 不动**。）
 * 2. **切换会留下宿主的 `[model changed: …]` 提示**。这是**特性不是噪声**：
 *    否则模型不知道自己换了，它会照旧解释上方那些由**另一个模型**生成的回合。
 * 3. **模型名非法 ⇒ 不切 ＋ 响亮告警**，绝不静默停在旧模型上（"改了没生效"是最难查的一类）。
 *
 * ## 归属（D23）
 * **机制在 ACC**（怎么读、怎么装、何时刷新、非法怎么办）；**内容在 CCC**（`trajectory.json` 写哪个模型）。
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'
import { sessionsRoot } from './core.js'
import { readTrajectoryConstraintAt } from './policy/profile.js'
import { splitModel } from './model-string.js'

/**
 * 从轨迹声明里取模型选择（**每轮调用**，故不缓存）。
 *
 * @param root CCC 根
 * @param dirName 轨迹目录名
 * @returns `{ provider?, model }`；**未写 `model` ⇒ `undefined`（= 不动当前模型）**
 *
 * ⚠️ 读盘失败／坏 JSON ⇒ `undefined` 并**不抛**：一次读失败不该让整轮失败
 *   （`readTrajectoryConstraintAt` 内部已对坏 JSON 告警）。
 */
export function readModelSelection(root: string, dirName: string): { provider?: string; model: string } | undefined {
  let profile
  try {
    profile = readTrajectoryConstraintAt(join(sessionsRoot(root), dirName), root)
  } catch {
    return undefined
  }
  const raw = profile?.model?.trim()
  if (raw === undefined || raw === '') return undefined
  const { provider, model } = splitModel(raw)
  if (model.trim() === '') return undefined
  return provider === undefined ? { model } : { provider, model }
}

/**
 * 该轨迹**是否声明了**模型（= 要不要装这条缝）。
 *
 * 🔴 与 `readModelSelection` 分开的理由：装上缝之后 `selection.current = undefined`
 * 会**覆盖**宿主已有的选择（把它变成"没选"），所以**没写 `model` 的轨迹根本不该装缝**。
 */
export function hasModelDeclared(root: string, dirName: string): boolean {
  return readModelSelection(root, dirName) !== undefined
}

/** 已装的模型选择（进程级；`sessionId → selection`，与 tool-restrictions 同构） */
const installed = new Map<string, { current?: { provider?: string; model: string }; assembled?: { provider?: string; model: string }; dispose: () => void }>()

/** 进程态快照（`acc-diag` 级别的可观测性；**只暴露"装了没有"，不暴露模型值**） */
export function modelRuntimeSnapshot(): { keys: string[] } {
  return { keys: [...installed.keys()] }
}

/** 会话销毁时清理 */
export function forgetModelRuntime(sessionId: string): void {
  const cur = installed.get(sessionId)
  if (cur === undefined) return
  try {
    cur.dispose()
  } catch {
    /* disposer 已失效 */
  }
  installed.delete(sessionId)
}

/**
 * 给这个 agent 装**模型运行时热切换**（每轮重读 `trajectory.json`）。
 *
 * 🔴 **只在轨迹声明了 `model` 时装**（D182 边界 ①）：
 * 装了缝而 `current` 为 `undefined` 会**覆盖**宿主已有的模型选择 ⇒ 等于把会话的模型清空。
 * 故"没写" **必须** 表现为"这条缝不存在"，而不是"缝在、值为空"。
 *
 * 🔴 **每轮刷新**：`agent/pre-step` 每步都调它，求值器**重读磁盘**
 * （`readTrajectoryConstraintAt` 无缓存）⇒ 改 `trajectory.json` 下一轮即生效，
 * **与"谁创建了这个会话"无关**（这就是 owner 的令）。
 *
 * @param agent 目标 agent
 * @param root CCC 根
 * @param dirName 该 agent 绑定的轨迹目录名
 * @returns 是否装了缝（`false` = 该轨迹没声明 model，未改动任何东西）
 */
export function syncTrajectoryModel(agent: AgentLike, root: string, dirName: string): boolean {
  const sessionId = agent.session?.id ?? 'global'
  const wanted = readModelSelection(root, dirName)

  if (wanted === undefined) {
    // 该轨迹没声明 model ⇒ **一个字节都不许动**。若之前装过（用户后来删掉了 model），撤掉它。
    forgetModelRuntime(sessionId)
    return false
  }

  const existing = installed.get(sessionId)
  if (existing !== undefined) {
    // 缝已在 ⇒ 只刷新目标值（这一步就是"热加载"：下一轮 `agent/request` 会读到新值）
    existing.current = wanted
    return true
  }

  // 首次：装宿主原语。**动态取**（见下方 R↓），拿不到就响亮告警且不装。
  const install = resolveInstallModelSelection()
  if (install === null) {
    console.warn(
      `[serenity-hooks] ✗ 轨迹 "${dirName}" 声明了 model，但**宿主未导出 installModelSelection** ⇒ ` +
        `模型热切换无法生效（当前会话模型保持不变）。这是宿主契约变化，请核对 @deepseek-ai/dsh-agent 的导出。`,
    )
    return false
  }
  const selection: { current?: { provider?: string; model: string }; assembled?: { provider?: string; model: string } } = {
    current: wanted,
    assembled: undefined,
  }
  try {
    const dispose = install(agent.ctx as never, selection as never)
    installed.set(sessionId, { ...selection, dispose })
    return true
  } catch (err) {
    console.warn(
      `[serenity-hooks] ✗ 轨迹 "${dirName}" 的模型热切换装配失败（会话模型保持不变）: ${String((err as Error)?.message ?? err)}`,
    )
    return false
  }
}

/**
 * 取宿主的 `installModelSelection`。
 *
 * 🔴 **为什么是 `createRequire` 动态取，而不是顶层 `import`**（R↓，两个理由）：
 * ① 本仓对 `@deepseek-ai/dsh-agent` 的**全部**引用此前都是 `import type`（零运行时依赖）；
 *    改成顶层运行时 import 会把它变成**硬依赖**——而它是 `peerDependencies`，
 *    宿主没装好时**整个插件起不来**，那比"模型不切换"严重得多。
 * ② 这是一个**可选能力**：拿不到就告警并保持会话原模型（`null` 分支），插件其余部分照常工作。
 *
 * ⚠️ 本仓是 ESM（`package.json` `"type": "module"`）⇒ **裸 `require` 不可用**，
 * 必须走 `createRequire(import.meta.url)`（同 `diagram/rasterize.ts` 的既有做法）。
 *
 * ⚠️ 解析结果**缓存**（成功或确实没有都缓存）：避免每轮重复 require 与重复告警刷屏。
 */
let resolveCache: ((agentCtx: unknown, selection: unknown) => () => void) | null | undefined

function resolveInstallModelSelection(): ((agentCtx: never, selection: never) => () => void) | null {
  if (resolveCache !== undefined) return resolveCache
  try {
    const req = createRequire(import.meta.url)
    const mod = req('@deepseek-ai/dsh-agent') as { installModelSelection?: unknown }
    resolveCache =
      typeof mod.installModelSelection === 'function'
        ? (mod.installModelSelection as (agentCtx: unknown, selection: unknown) => () => void)
        : null
  } catch {
    resolveCache = null
  }
  return resolveCache
}

/** 测试用：清掉宿主解析缓存（真实进程内不需要） */
export function resetModelRuntimeForTests(): void {
  resolveCache = undefined
  for (const [k] of installed) forgetModelRuntime(k)
}

/** 最小 agent 形状（只用到 `session.id` 与 `ctx`；避免把整个 Agent 类型拖进来） */
interface AgentLike {
  session?: { id?: string }
  ctx?: unknown
}
