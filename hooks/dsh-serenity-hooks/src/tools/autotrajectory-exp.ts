/**
 * autotrajectory-exp.ts — 自主轨迹实验一站式管理工具（v1.26.12 实验提案，默认关）
 *
 * 定位：dsp **只提供工具与知识**，不向 CCC 自动安装任何东西（实验可能失败，不污染 CCC）——
 * 实验是 CCC 的自选动作：agent 调本工具（doc/全报告）即懂实验，init/random/check 辅助，
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
import { diagLive, type DiagLiveReport } from '../autotrajectory.js'

/**
 * 定位包内实验脚本（npm files 分发 experiments/autotrajectory/）。
 * 布局差异：tsdown bundle 后 import.meta.url 指向 lib/index.js（lib → 包根 1 层）；
 * vitest 源码直跑时指向 src/tools/x.ts（src/tools → 包根 2 层）——逐级上溯查找，
 * 两种布局都稳（找到 experiments/autotrajectory/scripts/autotrajectory-exp.ts 即止）。
 */
export function findExpScript(startDir: string): string | null {
  let cur = startDir
  while (true) {
    const cand = join(cur, 'experiments', 'autotrajectory', 'scripts', 'autotrajectory-exp.ts')
    if (existsSync(cand)) return cand
    const parent = dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
}

/** 包内实验脚本（上溯查找；找不到 → execute 报错提示包完整性） */
const EXP_SCRIPT = findExpScript(dirname(fileURLToPath(import.meta.url)))

export const AUTO_TRAJECTORY_EXP_ACTIONS = ['all', 'init', 'random', 'diag', 'doc', 'check', 'status', 'guide', 'diag-live'] as const

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
    '═══ 自主轨迹进程内诊断（diag-live，v1.26.14）═══',
    `进程 cwd: ${r.processCwd}（CCC: ${r.processCcc ?? '无 .serenity'}）`,
    `面板解析（无参 GET 目标）: ${r.panelResolved ?? '无配置 autotrajectory 的 live CCC'}`,
    '',
    `── live 会话（${r.liveSessions.length}）──`,
  ]
  if (r.liveSessions.length === 0) {
    lines.push('  （无 live 会话——WebUI 未打开任何会话；定时器绑定依赖 live 会话 cwd）')
  }
  for (const s of r.liveSessions) {
    lines.push(`  · ${s.id}${s.title ? ` [${s.title}]` : ' [无标题]'}${s.cwd ? ` cwd=${s.cwd}` : ' cwd=无'}${s.cccRoot ? ` → CCC ${s.cccRoot}` : ''}`)
  }
  lines.push('', `── 配置了 autotrajectory 的 CCC（${r.autotrajectoryCccs.length}）──`)
  if (r.autotrajectoryCccs.length === 0) {
    lines.push('  （无——live 会话中无任何 CCC 配置 autotrajectory）')
  }
  for (const c of r.autotrajectoryCccs) {
    lines.push(`  · ${c.root}（enabled=${c.enabled}）`)
    lines.push(`    session=${c.session ?? '未配置'} | 目标=${c.target ? `${c.target.dirName}（--auto ${c.target.autoFlag ? '✓' : '✗'}，空闲 ${c.target.idleHours.toFixed(1)}h）` : '未命中'}`)
    lines.push(`    agent 定位: ${c.agentResolved ? '✓ 可注入' : `✗ 不可得——${c.agentDiagnosis ?? '未知'}`}`)
  }
  return lines.join('\n')
}

/** 创建 autotrajectory-exp 工具（闭包捕获 ctx → diag-live 进程内诊断；v1.26.14） */
export function createAutoTrajectoryExpTool(ctx: Context): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'autotrajectory-exp',
    description:
      '自主轨迹实验（Self-Sustaining Trajectory）一站式管理——实验提案 v1.26.14，默认关。无参/action=all：全报告（背景摘要 + 就绪检查 + 状态 + 下一步）——CCC agent 看一次即完整理解实验并知道怎么开始；init：初始化辅助（写配置 + 生成偏见提供者脚本模板）；random：运行偏见提供者脚本输出当前偏见内容；diag：唤起条件链诊断（--ccc <path> 指定 CCC，无参递归扫描 /home/yh 两层——覆盖任意实验 CCC 位置；逐条件输出 + 阻断点 + 修复建议）；diag-live：**进程内诊断**（v1.26.14——live 会话清单/标题/agent 定位/面板解析目标；排查"面板检测不到实验 CCC"）；doc：实验定义全文；check/status/guide：单项。**topPrompt（v1.26.17，轨迹焦点）**：CCC 定义 autotrajectory 时自己填写本轨迹核心焦点（顶层提示词），每次唤起最先注入——稳定焦点锚定防漂移（实验观察：无焦点多轮唤起轨迹腐化），与偏见内容（每轮随机探索）互补。实验是 CCC 的自选动作——dsp 只提供工具与知识，不自动安装任何东西。',
    parameters: {
      action: { type: 'string', enum: [...AUTO_TRAJECTORY_EXP_ACTIONS], required: true, description: 'Subcommand' },
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
        result.error = 'autotrajectory-exp 实验脚本未随安装分发（npm 包缺 experiments/autotrajectory/）——请检查包完整性'
        return result
      }
      const script = EXP_SCRIPT
      if (!existsSync(script)) {
        result.error = `autotrajectory-exp 脚本缺失（${script}）——实验包未随安装分发，请检查 npm 包完整性`
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
        result.error = 'autotrajectory-exp 需要 bun 运行时（bun not found in PATH）'
        return result
      }
      result.error = r.stderr?.trim() || r.stdout?.trim() || `exit ${r.status ?? '?'}`
      return result
    },
  })
}
