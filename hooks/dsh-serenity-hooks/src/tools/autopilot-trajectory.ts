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

export const AUTOPILOT_ACTIONS = ['all', 'init', 'random', 'diag', 'doc', 'check', 'status', 'guide', 'diag-live'] as const

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

/** 创建 autopilot-trajectory 工具（闭包捕获 ctx → diag-live 进程内诊断；v1.26.14 + v1.27.4 改名） */
export function createAutopilotTool(ctx: Context): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'autopilot-trajectory',
    description:
      'Autopilot Trajectory（自动巡航轨迹，正式版 v1.27.4；前身 autotrajectory 实验）一站式管理。无参/action=all：全报告（背景摘要 + 就绪检查 + 状态 + 下一步）——CCC agent 看一次即完整理解并知道怎么开始；init：初始化辅助（写配置 + 生成偏见提供者脚本模板）；random：运行偏见提供者脚本输出当前偏见内容；diag：唤起条件链诊断（--ccc <path> 指定 CCC，无参递归扫描 /home/yh 两层；逐条件输出 + 阻断点 + 修复建议）；diag-live：**进程内诊断**（live 会话清单/标题/agent 定位/面板解析目标；排查"面板检测不到实验 CCC"）；doc：定义全文；check/status/guide：单项。**topPrompt（轨迹焦点）**：CCC 定义时自己填写本轨迹核心焦点（顶层提示词），每次唤起最先注入——稳定焦点锚定防漂移，与偏见内容（每轮随机探索）互补。多 CCC 独立（v1.27.4）：每个 live+enabled CCC 各自时钟唤起。机制是 CCC 的自选动作——dsp 只提供工具与知识，不自动安装任何东西。',
    parameters: {
      action: { type: 'string', enum: [...AUTOPILOT_ACTIONS], required: true, description: 'Subcommand' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderText(value),
    },
    async execute(args, exec) {
      // diag-live：进程内诊断（不 exec 脚本——脚本是独立进程看不到 ctx.sessions/agents）
      if (args.action === 'diag-live') {
        return { output: renderDiagLive(diagLive(ctx)) }
      }
      const root = findSerenityRoot(agentCwd(exec))
      const result: Record<string, string> = {}
      if (!EXP_SCRIPT) {
        result.error = 'autopilot-trajectory 脚本未随安装分发（npm 包缺 experiments/autopilot-trajectory/）——请检查包完整性'
        return result
      }
      const script = EXP_SCRIPT
      if (!existsSync(script)) {
        result.error = `autopilot-trajectory 脚本缺失（${script}）——包未随安装分发，请检查 npm 包完整性`
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
        result.error = 'autopilot-trajectory 需要 bun 运行时（bun not found in PATH）'
        return result
      }
      result.error = r.stderr?.trim() || r.stdout?.trim() || `exit ${r.status ?? '?'}`
      return result
    },
  })
}
