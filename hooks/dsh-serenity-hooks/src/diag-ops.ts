/**
 * diag-ops.ts — `acc-diag` 报告装配（v1.33，S142 §32.11；2026-09-15 段数收缩）
 *
 * 为什么单独成模块（R↓）：工具面（`tools/acc-diag.ts`）只做"取 CCC 根 + 渲染"，
 * 装配逻辑放这里 ⇒ 纯函数可单测、不依赖 DSH 工具注册。
 *
 * 为什么**无动作参数**：诊断是低频动作（§32.9 收敛取向），一次调用即出全报告，
 * 不需要子命令面；动作越多，模型选择成本越高。
 *
 * 三段内容（数据来源各自单一真相源，本模块只聚合不复制语义）：
 *   ①  live 运行态 —— 插件进程内 `diagLive(ctx)`（进程 cwd/CCC + live 会话清单）
 *       ——**独立进程看不到运行时**，这正是本工具存在的理由
 *   ①b 唤醒时钟 —— `containerClocks().wake`（唤醒调度器进程内快照：武装态/计数/上次跳过原因）
 *   ③  唤醒注册表 —— `wake-registry.json` 的**在办条目**（state / at / target / lastResult）+ 补跑窗口
 *       （🔴 2026-09-19 §0Q 甲案：终态条目**结案即清除** ⇒ 本段只列在办项，不再是"历史全量"；
 *        历史由 SESSION.md / 工具输出承担——该承诺原本就写在 `wake-registry.ts` 注释里，本次做实）
 *
 * ── 2026-09-15：段数由四降为三（S142「ACC 侧 autopilot 退场」§1 二阶裁定）─────────────
 * ACC 侧 autopilot 整段退场后，报告里两段的**主语消失**，故删除（不是"暂时关掉"）：
 *   · 原 ② 面板解析 —— `diagLive.panelResolved` 的来源是"哪个 CCC 配了 autopilot"，
 *     面板区块同批删除 ⇒ 主语不存在。
 *   · 原 ④ 唤起条件链 —— 整段都是 ACC autopilot 的唤起条件（`buildWakeChain` +
 *     `autopilotRuntimeFacts`），实现模块已删 ⇒ 不留第二份条件链、也不留半死的手写版。
 *   · 原 ① 段的 autopilot CCC 渲染（逐 CCC 目标命中 / agent 定位）同批删除。
 *
 * 🔴 **已知缺口（登记，不静默丢弃）**：④「为什么这轮没唤起」的诊断在 **CCC 自管理链**上归零。
 * 新链的失败形态是"S151 漏了自排下一轮"或"调度器闸关/未 tick"，而删掉 ④ 后这两种病因都不可见。
 * 按所有者裁决本次**不补**（一句话可补，代价 = 一条新条件链：调度器 armed / 闸 / tick 在跑 /
 * 条目到期 / 补跑窗口 / 目标可解析 / CCC 闸）。**不得**以"顺手保留 ④"的方式把它偷偷带回。
 *
 * C5「观察面归一」（2026-09-15）：① 走 `diagLive`（那是**live 运行态**的独有取数，没有第二个
 * 来源）；①b 时钟与 ③ 注册表经 `container-status.ts` 取（唯一取数出口）——**投影仍在本文件**
 * （诊断段不含 `message`，面板含；这是渲染差异，不是取数差异）。
 */

import { WAKE_CATCH_UP_MS } from './wake-registry.js'
import { diagLive, type DiagLiveReport } from './live-sessions.js'
import { containerClocks, containerWakes, type ClockSnapshot } from './container-status.js'
import type { Context } from 'cordis'
import { isoLocal } from './time.js'
import { readSimpleSettings } from './settings-section.js'

/** 进程内时钟状态（唤醒调度器；判据单一真相源 = `wake-scheduler.ts`） */
type ClockState = ClockSnapshot

/** 人读渲染一行时钟状态（"为何没有 tick" 的第一手判据） */
function renderClock(label: string, s: ClockState): string {
  const ts = (ms: number | null): string => (ms === null ? '（从未）' : isoLocal(ms))
  const parts = [
    `armed=${s.armed}`,
    // 🔴 2026-09-21 替换：原 `全局闸=${s.enabled}` —— 调度器的闸已砍掉（恒开，该字段失去信息量），
    //    改报**CRO 闸**（本容器唯一还存在的"会拦住某阶段"的开关）。它回答的是
    //    "这轮为什么没有自编程唤起"——与 armed / lastSkipReason 同属"为何没动"的第一手判据。
    `CRO 闸=${readSimpleSettings().croEnabled !== false}`,
    `tick 次数=${s.ticks}`,
    `上次 tick=${ts(s.lastTickAt)}`,
  ]
  if (s.armedAt !== null) parts.push(`武装于=${ts(s.armedAt)}`)
  if (s.lastSkipReason) parts.push(`上次跳过: ${s.lastSkipReason}`)
  return `${label}: ${parts.join(' ｜ ')}`
}

interface AccDiagReport {
  /** 调用方会话所属 CCC 根（过程内诊断的目标） */
  ccc: string
  live: DiagLiveReport
  /**
   * 唤醒调度器的进程内武装状态（2026-09-14 F 段缺陷**新暴露面**）。
   * 为什么必须有（R↓）：此前"条目为何滞留在 pending"无法从报告回答。有了它，
   * "时钟根本没在跑"这一类故障一眼可判——这是 ACC 现存的**唯一**轨迹调度时钟。
   */
  clocks: {
    wake: ClockState
  }
  wakes: {
    /** 注册表文件路径问题（读不到时非空——不得静默） */
    error: string | null
    entries: Array<{
      id: string
      target: string
      at: string
      state: string
      createdBy: string
      attempts: number
      lastResult: string | null
    }>
    pending: number
  }
}

/**
 * 装配报告（一次调用即全报告）。
 * @param ctx 插件上下文（进程内读 sessions/agents）
 * @param root 调用方 CCC 根（唤醒注册表取数目标）
 * @returns 结构化报告（渲染由 {@link renderAccDiag} 负责）
 */
export async function runAccDiag(ctx: Context, root: string): Promise<AccDiagReport> {
  const live = diagLive(ctx)
  // C5：时钟与唤醒注册表经 container-status 取数（与本文件其余段落同一取数出口）
  const clocks = containerClocks()
  const wakes = containerWakes(root)
  return {
    ccc: root,
    live,
    clocks: {
      wake: clocks.wake,
    },
    wakes: {
      error: wakes.error,
      entries: wakes.entries.map((e) => ({
        id: e.id,
        target: e.target,
        at: e.at,
        state: e.state,
        createdBy: e.createdBy,
        attempts: e.attempts ?? 0,
        lastResult: e.lastResult ?? null,
      })),
      pending: wakes.pending,
    },
  }
}

/** 人读渲染（三段；空段也要显式说明"无"，避免"沉默 = 一切正常"的误读） */
export function renderAccDiag(r: AccDiagReport): string {
  const lines: string[] = []
  lines.push(`═══ ACC 运行态诊断（acc-diag）═══`)
  lines.push(`调用方 CCC: ${r.ccc}`)
  lines.push('')

  // ① live 运行态
  lines.push(`── ① live 运行态（插件进程内）──`)
  lines.push(`进程 cwd: ${r.live.processCwd}`)
  lines.push(`进程 CCC: ${r.live.processCcc ?? '（无——进程 cwd 不在任何 CCC 内）'}`)
  lines.push(`live 会话: ${r.live.liveSessions.length} 个`)
  for (const s of r.live.liveSessions) {
    lines.push(`  · ${s.id}${s.title ? `「${s.title}」` : ''} — ccc=${s.cccRoot ?? '(非 CCC)'} cwd=${s.cwd ?? '(无)'}`)
  }
  lines.push('')

  // ①b 进程内时钟（**先看这一行**：时钟没武装时，注册表条目再就绪也不会被投递）
  lines.push(renderClock('唤醒调度器（wake-registry tick）', r.clocks.wake))
  lines.push('')

  // ③ 唤醒注册表
  // 🔴 2026-09-19（§0Q 甲案）：注册表**只保在办项**——终态（delivered/missed/cancelled）
  //   在结案那一刻即被移除（owner 裁「唤醒后就清理」）。故本段**不再显示历史**，
  //   只显示"还在等的"；历史归属 SESSION.md / 工具输出。
  //   标题显式写明，避免读成"记录丢了"（静默改语义比改行为更坏）。
  lines.push(`── ③ 唤醒注册表（在办项；已结案条目即时清除，历史见 SESSION.md）──`)
  lines.push(`  （${r.ccc}/AGENT_SESSIONS/wake-registry.json）`)
  if (r.wakes.error) lines.push(`⚠ 注册表读取问题: ${r.wakes.error}`)
  lines.push(`条目: ${r.wakes.entries.length} 条（在办 ${r.wakes.pending}）｜补跑窗口 ${WAKE_CATCH_UP_MS / 3600_000}h`)
  if (r.wakes.entries.length === 0) lines.push('（无在办条目）')
  for (const w of r.wakes.entries) {
    lines.push(`  · ${w.id} [${w.state}] at=${w.at} → ${w.target} by=${w.createdBy} attempts=${w.attempts}`)
    if (w.lastResult) lines.push(`      lastResult: ${w.lastResult}`)
  }
  return lines.join('\n')
}
