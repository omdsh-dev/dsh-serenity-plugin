/**
 * live-sessions.ts — 进程内 live 会话取数 + 精简诊断
 *
 * ── 为什么单独成模块（R↓，2026-09-15 S142「ACC 侧 autopilot 退场」S1 搬迁）──
 * 这两个函数原先住在 `autopilot-trajectory.ts`，但它们的**主语不是 autopilot**：
 * `listLiveSessions` 服务 `acc-diag` ① 段的"**哪个会话属于哪个 CCC**"（会话维度，
 * 不是 CCC 维度），而"**独立进程看不到运行时**"正是 `acc-diag` 存在的理由。
 * autopilot 退场后它们必须活下去 ⇒ 独立成模块，不再挂着已死机制的名字。
 *
 * ── 迁移边界（不搬什么，以及为什么）──────────────────────────────────────
 * 原 `diagLive` 还含两段，**均不搬**（其主语是 autopilot，随机制退场）：
 *   · `autopilotCccs`（逐 CCC 目标命中 / agent 定位诊断）—— 依赖 `readAutopilotSettings` /
 *     `getAutopilotStatus` / `resolveTargetAgent`
 *   · `panelResolved`（无参面板请求落到哪个 CCC）—— 面板区块随机制退场
 * 留下的 = **进程 cwd/CCC + live 会话清单**（`acc-diag` ① 段仍需要）。
 *
 * 判据纪律：本模块**不得**反向依赖 autopilot 判据层（那会让退场半途而废）。
 *
 * ── 🔴 2026-09-25 I2 收敛（约束文档 §2.7 违反清单，L1 违反之一）────────────────
 * **本模块的 `ctx` 参数类型从 `Context` 改为 `unknown`** —— 消除本文件唯一的 `W2` 接触
 * （直接 import 宿主 `cordis` 的类型）。
 *
 * **为什么这是"真解耦"而不是"把类型藏起来"（判据）：** `ctx` 在本模块**从不被解引用** ——
 * 它只被**原样透传**给 `hostSessions(ctx)`，而后者（`host/access.ts`，**L0**）的参数
 * 本就声明为 `ctx: unknown` ⇒ `Context` 这个 import **在语义上是多余的**，
 * 它没有参与任何类型检查，只贡献了一处 L1→宿主 的接触点。
 * 🔵 **证据**：grep 本文件 `ctx` 全部 5 处命中 —— 3 处在参数/调用位、2 处在注释，
 * **零处**属性访问（`ctx.xxx`）。
 */

import { cccRootForCwd } from './ccc-roots.js'
import { hostSessions } from './host/access.js'
import { sessionEvents } from './trajectory-ops.js'

/** live 会话条目（诊断用；标题从 events 读） */
export interface LiveSessionEntry {
  id: string
  cwd: string | null
  cccRoot: string | null
  title: string | null
}

/**
 * 从 dsh 会话 log 读取标题（latest-wins `session/title` 事件）——
 * **标题不在 `sessions.list()` 条目上**（wire/对象均无 title 字段；F3 命名经
 * `sessionTitle.rename` 写进 session log），必须从 events 提取（rebuild 同款读取模式）。
 */
export function readSessionTitle(session: unknown): string | null {
  try {
    const events = sessionEvents<{ type?: string; data?: { title?: unknown } }>(session)
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (e?.type === 'session/title' && typeof e.data?.title === 'string' && e.data.title.trim() !== '') {
        return e.data.title.trim()
      }
    }
  } catch {
    /* events 访问失败忽略 */
  }
  return null
}

/**
 * 逐条 live 会话（`cccRoot` = 该会话 cwd 的 CCC 归属，无 → null）。
 *
 * CCC 枚举（"本机有哪些 CCC"）**不在这里**，归 `ccc-roots.listCccs`（并集语义）；
 * 本函数保留的是它**独有**的那部分：会话维度 + cwd 归属 + 标题 + id。
 *
 * @param ctx 插件上下文（**只透传**给 L0 取数口，本模块不解引用 ⇒ 类型为 `unknown`）
 * @returns 逐条 live 会话
 */
export function listLiveSessions(ctx: unknown): LiveSessionEntry[] {
  const out: LiveSessionEntry[] = []
  try {
    const sessions = hostSessions(ctx)
    for (const s of sessions?.list?.() ?? []) {
      const cwd = s?.header?.cwd ?? null
      out.push({
        id: s?.id ?? '',
        cwd,
        cccRoot: cwd ? cccRootForCwd(cwd) : null,
        title: readSessionTitle(s),
      })
    }
  } catch {
    /* 遍历失败忽略 */
  }
  return out
}

/**
 * 进程内诊断（`acc-diag` ① 段数据源）——输出当前实例的进程归属 + live 会话清单。
 *
 * 为什么必须在插件进程内算：脚本看不到 live 会话 / cwd 归属（这正是本数据的**唯一来源**，
 * 没有第二个取数出口）。`autopilotCccs` / `panelResolved` 两段随 autopilot 机制退场，见文件头。
 */
export interface DiagLiveReport {
  processCwd: string
  processCcc: string | null
  liveSessions: LiveSessionEntry[]
}

export function diagLive(ctx: unknown): DiagLiveReport {
  const processCwd = process.cwd()
  return {
    processCwd,
    processCcc: cccRootForCwd(processCwd),
    liveSessions: listLiveSessions(ctx),
  }
}
