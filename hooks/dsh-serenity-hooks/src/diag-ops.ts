/**
 * diag-ops.ts — `acc-diag` 报告装配（v1.33，S142 §32.11）
 *
 * 为什么单独成模块（R↓）：工具面（`tools/acc-diag.ts`）只做"取 CCC 根 + 渲染"，
 * 装配逻辑放这里 ⇒ 纯函数可单测、不依赖 DSH 工具注册。
 *
 * 为什么**无动作参数**：诊断是低频动作（§32.9 收敛取向），一次调用即出全报告，
 * 不需要子命令面；动作越多，模型选择成本越高。
 *
 * 四段内容（数据来源各自单一真相源，本模块只聚合不复制语义）：
 *   ① live 运行态 —— 插件进程内 `diagLive(ctx)`（live 会话清单 + 各 autopilot CCC 的
 *      目标命中 / agent 定位诊断）——**脚本侧看不到运行时**，这正是本工具存在的理由
 *   ② 面板解析 —— `diagLive.panelResolved`（无参面板请求会落到哪个 CCC）
 *   ③ 唤醒注册表 —— `wake-registry.json` 全量条目（state / at / target / lastResult）+ 补跑窗口
 *   ④ 唤起条件链 —— 包内脚本 `diag`（`runAutopilotScript(root,'diag')`）：逐条件值 + 阻断点 + 修复建议
 */

import { listWakes, WAKE_CATCH_UP_MS } from './wake-registry.js'
import { diagLive, type DiagLiveReport } from './autopilot-trajectory.js'
import { runAutopilotScript } from './autopilot-script.js'
import type { Context } from 'cordis'

export interface AccDiagReport {
  /** 调用方会话所属 CCC 根（脚本诊断的目标） */
  ccc: string
  live: DiagLiveReport
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
  /** 唤起条件链（脚本输出原文；失败时给出错误文本，不吞） */
  autopilotChain: string
}

/**
 * 装配报告（一次调用即全报告）。
 * @param ctx 插件上下文（进程内读 sessions/agents）
 * @param root 调用方 CCC 根（脚本诊断目标）
 * @returns 结构化报告（渲染由 {@link renderAccDiag} 负责）
 */
export function runAccDiag(ctx: Context, root: string): AccDiagReport {
  const live = diagLive(ctx)
  const { entries, error } = listWakes(root)
  const script = runAutopilotScript(root, 'diag')
  return {
    ccc: root,
    live,
    wakes: {
      error,
      entries: entries.map((e) => ({
        id: e.id,
        target: e.target,
        at: e.at,
        state: e.state,
        createdBy: e.createdBy,
        attempts: e.attempts ?? 0,
        lastResult: e.lastResult ?? null,
      })),
      pending: entries.filter((e) => e.state === 'pending').length,
    },
    autopilotChain: script.error ? `（脚本诊断失败：${script.error}）` : (script.output ?? '(empty)'),
  }
}

/** 人读渲染（四段；空段也要显式说明"无"，避免"沉默 = 一切正常"的误读） */
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
  if (r.live.autopilotCccs.length === 0) {
    lines.push('autopilot CCC: 无（没有 live 会话配置了 trajectory.autopilot）')
  } else {
    lines.push(`autopilot CCC: ${r.live.autopilotCccs.length} 个`)
    for (const c of r.live.autopilotCccs) {
      lines.push(
        `  · ${c.root} enabled=${c.enabled} session=${c.session ?? '(未配置)'} 目标=${c.target?.dirName ?? '(未命中)'}` +
          ` wakeable=${c.target?.wakeable ?? false} agent=${c.agentResolved ? '已定位' : '未定位'}`,
      )
      if (c.agentDiagnosis) lines.push(`      诊断: ${c.agentDiagnosis}`)
    }
  }
  lines.push('')

  // ② 面板解析
  lines.push(`── ② 面板解析（无参 /serenity/trajectory 落到哪个 CCC）──`)
  lines.push(r.live.panelResolved ?? '（解析不到——本进程无 live+enabled 的 autopilot CCC）')
  lines.push('')

  // ③ 唤醒注册表
  lines.push(`── ③ 唤醒注册表（${r.ccc}/AGENT_SESSIONS/wake-registry.json）──`)
  if (r.wakes.error) lines.push(`⚠ 注册表读取问题: ${r.wakes.error}`)
  lines.push(`条目: ${r.wakes.entries.length} 条（在办 ${r.wakes.pending}）｜补跑窗口 ${WAKE_CATCH_UP_MS / 3600_000}h`)
  if (r.wakes.entries.length === 0) lines.push('（无条目）')
  for (const w of r.wakes.entries) {
    lines.push(`  · ${w.id} [${w.state}] at=${w.at} → ${w.target} by=${w.createdBy} attempts=${w.attempts}`)
    if (w.lastResult) lines.push(`      lastResult: ${w.lastResult}`)
  }
  lines.push('')

  // ④ 唤起条件链
  lines.push(`── ④ 唤起条件链（"为什么这轮没被唤起"）──`)
  lines.push(r.autopilotChain)
  return lines.join('\n')
}
