/**
 * autopilot-trajectory.ts — Autopilot Trajectory 一站式管理工具（v1.26.12 实验
 * autotrajectory-exp → v1.27.4 正式化改名）
 *
 * 定位：dsp **只提供工具与知识**，不向 CCC 自动安装任何东西（机制是 CCC 的自选动作）——
 * agent 调本工具（doc/全报告）即懂机制，init/random/check 辅助，
 * 实际执行（写配置/写偏见脚本/标记会话）由 CCC 自己决定、自己用现有工具完成。
 *
 * 实现：薄封装——exec 包内静态脚本（npm files 含 experiments/），脚本是单一真相源。
 * 环境注入 SERENITY_ROOT（当前 CCC 根）供脚本定位；bun 优先（可直跑 TS）。
 * diag-live：**进程内诊断**（v1.26.14 用户"排查访问不到"）——闭包捕获 ctx，
 * 直接读 live 会话/标题/agent（脚本 diag 看不到运行时），输出实例级诊断报告。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from 'cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { findSerenityRoot } from '../ccc.js'
import { diagLive, type DiagLiveReport } from '../autopilot-trajectory.js'
import { resolveSessionTrajectoryLabel } from '../session-bound.js'
import { addWake, listWakes, removeWake, WAKE_CATCH_UP_MS, type WakeEntry } from '../wake-registry.js'

/**
 * 定位包内脚本（npm files 分发 experiments/autopilot-trajectory/）。
 * 布局差异：tsdown bundle 后 import.meta.url 指向 lib/index.js（lib → 包根 1 层）；
 * vitest 源码直跑时指向 src/tools/x.ts（src/tools → 包根 2 层）——逐级上溯查找，
 * 两种布局都稳（找到 experiments/autopilot-trajectory/scripts/autopilot-trajectory.ts 即止）。
 */
export function findExpScript(startDir: string): string | null {
  let cur = startDir
  while (true) {
    const cand = join(cur, 'experiments', 'autopilot-trajectory', 'scripts', 'autopilot-trajectory.ts')
    if (existsSync(cand)) return cand
    const parent = dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
}

/** 包内脚本（上溯查找；找不到 → execute 报错提示包完整性） */
const EXP_SCRIPT = findExpScript(dirname(fileURLToPath(import.meta.url)))

export const AUTOPILOT_ACTIONS = [
  'all', 'init', 'random', 'diag', 'doc', 'check', 'status', 'guide', 'diag-live',
  'wake-add', 'wake-list', 'wake-rm',
] as const

/** 进程内处理的动作（不 exec 包内脚本）：diag-live 诊断 + 唤醒注册表三动作 */
const NATIVE_ACTIONS = new Set<string>(['diag-live', 'wake-add', 'wake-list', 'wake-rm'])

/** 渲染唤醒条目（工具输出/面板共用形态；按 at 升序） */
function renderWakeList(entries: WakeEntry[], error: string | null): string {
  const lines: string[] = [`═══ trajectory 唤醒注册表（${entries.length} 条）═══`]
  if (error) lines.push(`⚠ ${error}`)
  if (entries.length === 0) lines.push('  （无条目——用 wake-add 登记：唤醒 = 未来时刻 + 一条 message）')
  for (const e of entries) {
    lines.push(`  · ${e.id}  [${e.state}]  at=${e.at}  target=${e.target}  by=${e.createdBy || '?'}`)
    lines.push(`      message: ${e.message.length > 120 ? `${e.message.slice(0, 120)}…` : e.message}`)
    if (e.lastResult) lines.push(`      last: ${e.lastResult}（attempts=${e.attempts}）`)
  }
  lines.push('', `补跑窗口 ${WAKE_CATCH_UP_MS / 3_600_000}h：停机期间到期且迟到未超窗 → 补投；超窗 → missed 留痕。`)
  return lines.join('\n')
}

function agentCwd(exec: { agent?: { session?: { header?: { cwd?: string } } } }): string {
  return exec.agent?.session?.header?.cwd ?? process.cwd()
}

function renderText(value: unknown): ContentBlock[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

/** 渲染 diag-live 报告为可读文本（EAP：结构清晰、命中点显式） */
function renderDiagLive(r: DiagLiveReport): string {
  const lines: string[] = [
    '═══ Autopilot Trajectory 进程内诊断（diag-live，v1.26.14）═══',
    `进程 cwd: ${r.processCwd}（CCC: ${r.processCcc ?? '无 .serenity'}）`,
    `面板解析（无参 GET 目标）: ${r.panelResolved ?? '无配置 Autopilot 的 live CCC'}`,
    '',
    `── live 会话（${r.liveSessions.length}）──`,
  ]
  if (r.liveSessions.length === 0) {
    lines.push('  （无 live 会话——WebUI 未打开任何会话；定时器绑定依赖 live 会话 cwd）')
  }
  for (const s of r.liveSessions) {
    lines.push(`  · ${s.id}${s.title ? ` [${s.title}]` : ' [无标题]'}${s.cwd ? ` cwd=${s.cwd}` : ' cwd=无'}${s.cccRoot ? ` → CCC ${s.cccRoot}` : ''}`)
  }
  lines.push('', `── 配置了 Autopilot Trajectory 的 CCC（${r.autopilotCccs.length}）──`)
  if (r.autopilotCccs.length === 0) {
    lines.push('  （无——live 会话中无任何 CCC 配置 autopilotTrajectory）')
  }
  for (const c of r.autopilotCccs) {
    lines.push(`  · ${c.root}（enabled=${c.enabled}）`)
    lines.push(`    session=${c.session ?? '未配置'} | 目标=${c.target ? `${c.target.dirName}（--auto ${c.target.autoFlag ? '✓' : '✗'}，空闲 ${c.target.idleHours.toFixed(1)}h）` : '未命中'}`)
    lines.push(`    agent 定位: ${c.agentResolved ? '✓ 可注入' : `✗ 不可得——${c.agentDiagnosis ?? '未知'}`}`)
  }
  return lines.join('\n')
}

/** 创建 trajectory 工具（原 autopilot-trajectory；D58 更名 + 唤醒注册表三动作） */
export function createAutopilotTool(ctx: Context): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'trajectory',
    description:
      'trajectory 一站式管理（D58：trajectory 是一等概念，**autopilot 是其子集**——周期自唤醒的特例）。无参/action=all：全报告（背景摘要 + 就绪检查 + 状态 + 下一步）——CCC agent 看一次即完整理解并知道怎么开始；init：初始化辅助（写配置 + 生成偏见提供者脚本模板）；random：运行偏见提供者脚本输出当前偏见内容；diag：唤起条件链诊断（--ccc <path> 指定 CCC，无参递归扫描 /home/yh 两层；逐条件输出 + 阻断点 + 修复建议）；diag-live：**进程内诊断**（live 会话清单/标题/agent 定位/面板解析目标）；doc：定义全文；check/status/guide：单项。**唤醒注册表（wake-add/wake-list/wake-rm）**：唤醒 = **未来时刻 + 一条 message**——可对**自己**预定未来唤醒，也可唤醒**别人**（任一 trajectory）；落点 CCC 内 `AGENT_SESSIONS/wake-registry.json`；到点由中心调度器投递（冷会话自动载入），**fire-and-forget：无回执、无阻塞、不等待**。wake-add 参数：target（S### 或目录名）/ at（RFC3339 或 `+30m`/`+2h`）/ message；wake-rm 参数：id。**topPrompt（轨迹焦点）**：CCC 定义时自己填写本轨迹核心焦点（顶层提示词），每次唤起最先注入——稳定焦点锚定防漂移。多 CCC 独立：每个 live CCC 各自评估。机制是 CCC 的自选动作——dsp 只提供工具与知识，不自动安装任何东西。',
    parameters: {
      action: { type: 'string', enum: [...AUTOPILOT_ACTIONS], required: true, description: 'Subcommand' },
      target: { type: 'string', description: 'wake-add：目标 trajectory（S### 或 AGENT_SESSIONS 目录名）' },
      at: { type: 'string', description: 'wake-add：未来时刻（RFC3339 含时区，或 +30m / +2h 相对写法）' },
      message: { type: 'string', description: 'wake-add：唤醒 message（投递给目标 trajectory 的正文）' },
      id: { type: 'string', description: 'wake-rm：条目 id（wake-list 可见）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderText(value),
    },
    async execute(args, exec) {
      const root = findSerenityRoot(agentCwd(exec))
      // diag-live：进程内诊断（不 exec 脚本——脚本是独立进程看不到 ctx.sessions/agents）
      if (args.action === 'diag-live') {
        return { output: renderDiagLive(diagLive(ctx)) }
      }
      // 唤醒注册表三动作：进程内直改注册表文件（不 exec 脚本——注册表是 CCC 级文件）
      if (NATIVE_ACTIONS.has(args.action ?? '')) {
        if (!root) return { output: '⚠ 未定位到 CCC 根（.serenity）——唤醒注册表按 CCC 存放，请在 CCC 内调用' }
        if (args.action === 'wake-list') {
          const { entries, error } = listWakes(root)
          return { output: renderWakeList(entries, error) }
        }
        if (args.action === 'wake-add') {
          // 发起者 = **调用方自身**所属 trajectory（见 resolveSessionTrajectoryLabel 的缺陷说明：
          // 旧实现取全局 lastActive 指针 ⇒ 多会话并发时张冠李戴，S142 §30.12.1 实测 by=S060）
          const scope = (exec.agent?.session as { header?: { id?: string } } | undefined)?.header?.id ?? ''
          const res = addWake(root, {
            target: args.target ?? '',
            at: args.at ?? '',
            message: args.message ?? '',
            createdBy: resolveSessionTrajectoryLabel(exec.agent?.session, scope),
            nowMs: Date.now(),
          })
          if (!res.ok) return { output: `✗ 登记失败：${res.error}` }
          return { output: `✓ 已登记唤醒\n${renderWakeList([res.entry], null)}` }
        }
        const removed = removeWake(root, args.id ?? '')
        return { output: removed.ok ? `✓ 已移除唤醒条目 ${args.id}` : `✗ 移除失败：${removed.error}` }
      }
      const result: Record<string, string> = {}
      if (!EXP_SCRIPT) {
        result.error = 'trajectory 脚本未随安装分发（npm 包缺 experiments/autopilot-trajectory/）——请检查包完整性'
        return result
      }
      const script = EXP_SCRIPT
      if (!existsSync(script)) {
        result.error = `trajectory 脚本缺失（${script}）——包未随安装分发，请检查 npm 包完整性`
        return result
      }
      const env: NodeJS.ProcessEnv = { ...process.env }
      if (root) env.SERENITY_ROOT = root
      const r = spawnSync('bun', [script, args.action ?? 'all'], {
        encoding: 'utf-8',
        timeout: 600_000,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      if (r.status === 0) {
        result.output = r.stdout?.trim() || '(empty)'
        return result
      }
      if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
        result.error = 'trajectory 需要 bun 运行时（bun not found in PATH）'
        return result
      }
      result.error = r.stderr?.trim() || r.stdout?.trim() || `exit ${r.status ?? '?'}`
      return result
    },
  })
}
