/**
 * loop.ts — acc_loop 真实 DSH 工具（老 loop 等效：廉价模型牛马循环）
 *
 * 语义对齐 opencode-serenity-plugin 老 loop：
 *   label（必）任务标签 → 进度文件 loop-<label>.md/.json
 *   session（选）工作会话 S###（上下文提示）
 *   model（选）provider/model（如 minimax-cn-coding-plan/MiniMax-M3）；缺省读 loop.defaultModel
 *   maxRounds（默认 100）轮次上限；每轮等待 agent **无超时**（loop 可永续，agent 工作多久等多久）
 *
 * 机制：ctx.agents.create()（带 setup 钩子）创建专用 agent（进程内），
 * 每轮 followup → agent/status idle → 读 session.events 响应 → 写进度 → stop token 检查 → 续跑。
 * 工厂模式：apply 时闭包捕获插件 ctx（工具 execute 无 ctx 参数）。
 *
 * preset 继承：setup 钩子里对子 agent 执行 agentPresets.composeFrom（对齐 subagent 先例），
 * 使 loop agent 继承发起方会话的 agent preset 工具（read/write/edit 等 preset 层工具）。
 * agentPresets 是可选服务——无 preset 装配的环境（无 roster 部署）退化为空工具层（历史行为）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Context } from 'cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-loop'
// 类型引用：拉入 agentPresets 的 cordis 声明增强（ctx.get('agentPresets') 类型解析；运行时擦除）
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { findSerenityRoot, loadSerenityConfig, DEFAULT_SERENITY_CONFIG_PATHS } from '../ccc.js'
import { loopPresetInheritance } from '../loop-preset-inherit.js'
import { buildRoundPrompt, loopProgressPaths, newStopToken, readProgress, splitModel, writeProgress } from '../loop-ops.js'

function agentCwd(exec: ToolRunContext): string {
  return (exec.agent?.session as { header?: { cwd?: string } } | undefined)?.header?.cwd ?? process.cwd()
}

function renderText(value: unknown): ContentBlock[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

/** 等待 agent 空闲（agent/status → idle）；无超时（loop 可永续，agent 工作多久等多久） */
function waitIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      dispose()
      resolve()
    }
    const dispose = ctx.on('agent/status', (payload: { agent: Agent; status: string }) => {
      if (payload.agent === agent && payload.status === 'idle') finish()
    })
  })
}

/** 读取会话最后一个 assistant/message 文本 */
function lastAssistantText(agent: Agent): string {
  const events = agent.session.events
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e && e.type === 'assistant/message') {
      const data = (e as { data?: { message?: { content?: { type?: string; text?: string }[] }; content?: { type?: string; text?: string }[] } }).data
      // 真实结构：data.message.content（v 升级后）；兼容旧 data.content
      const blocks = data?.message?.content ?? data?.content ?? []
      const text = blocks
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text)
        .join('\n')
      if (text) return text
    }
  }
  return ''
}

/** 创建 loop 工具（闭包捕获插件 ctx → 可访问 ctx.agentLoop） */

/** 创建 loop 工具（闭包捕获插件 ctx → 可访问 ctx.agentLoop） */
export function createLoopTool(ctx: Context): ToolDefinition {
  return defineTool({
    name: 'loop',
    description:
      '牛马循环（老 loop 等效）：用指定模型创建专用 agent 反复执行任务直到完成。\n' +
      '用法：loop 接受 task（要完成的目标）或依赖 session 上下文；模型缺省读 .dsh/serenity.json 的 loop.defaultModel（当前 minimax-cn-coding-plan/MiniMax-M3，廉价牛马）。\n' +
      '行为：内部硬性 while 循环驱动 agent 逐轮推进任务，每轮等待无超时（agent 工作多久等多久）。唯一完成条件 = agent 精确回显本轮随机完成码（stop token），防止低智能模型提前结束。调用者不关心轮数——任务交给 loop，完成即返回。\n' +
      '进度：写入 AGENT_SESSIONS/loop-<label>.md/.json；同 label 再次调用从上次轮次续跑（不重做）。\n' +
      '约束：loop agent 受完整 Serenity 约束（ACC 身份/入口技能系统提示词/守卫/session-keeper）。\n' +
      '示例：loop 执行「扫描 SQC 并修复 DC 问题」，label: sqc-scan',
    parameters: {
      task: { type: 'string', description: '要完成的任务目标（必填语义：告诉 loop agent 做什么；缺省则从 session 上下文推断）' },
      label: { type: 'string', required: true, description: '任务标签（进度文件命名 loop-<label>.md/.json）' },
      session: { type: 'string', description: '工作会话 S###（上下文提示，进度记录参考）' },
      model: { type: 'string', description: 'provider/model（如 minimax-cn-coding-plan/MiniMax-M3）；缺省读 loop.defaultModel' },
      maxRounds: { type: 'integer', description: '保险阀（防死循环，默认 100；调用者通常无需设置——loop 跑到完成或达此上限）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderText(value),
    },
    async execute(args, exec) {
      const root = findSerenityRoot(agentCwd(exec))
      if (!root) throw new Error('No CCC found: no .serenity file from agent cwd')
      const cfg = loadSerenityConfig(root, DEFAULT_SERENITY_CONFIG_PATHS)
      const model = args.model ?? cfg.loop?.defaultModel
      if (!model) throw new Error('loop 需要 model：传参或配置 .dsh/serenity.json loop.defaultModel')
      const maxRounds = args.maxRounds ?? 100
      const label = args.label
      if (!ctx.agentLoop) throw new Error('loop: ctx.agentLoop 不可用')

      const { provider, model: modelName } = splitModel(model)
      const stopToken = newStopToken()
      let progress = readProgress(root, label)
      // 续跑：从进度文件的下一轮开始（maxRounds 是保险阀，不截断续跑——调用者不关心轮数）
      const startRound = progress ? progress.round + 1 : 1

      // 创建 loop agent：经 ctx.agents.create（对齐 subagent 先例）——setup 钩子
      // 在 agent 未发布前把子 scope 绑定到父 agent 的 preset standing mount
      // （agentPresets.composeFrom），使 loop agent 继承父会话的 preset 工具层
      // （read/write/edit 等）。无 agentPresets 服务/父未 join preset 时跳过，
      // 退化为历史行为（全局工具层）。
      // sessionId 带唯一后缀：同 label 多次调用不冲突（session 是每次新建的临时
      // 执行载体，label 只用于进度文件/续跑）。
      const parentCtx = exec.agent?.ctx
      const inherited = loopPresetInheritance(parentCtx)
      if (!ctx.agents) throw new Error('loop: ctx.agents 不可用')
      const sessionId = `loop-${label}-${randomUUID()}` as SessionId
      const handle: AgentHandle = await ctx.agents.create({
        sessionId,
        meta: {
          cwd: root,
          ...inherited.agentPreset === undefined ? {} : { agentPreset: inherited.agentPreset },
        },
        agentOptions: { provider, model: modelName },
        ...inherited.setup === undefined ? {} : { setup: inherited.setup },
      })
      const loopAgent = handle.agent

      let done = false
      let lastResponse = progress?.lastResponse ?? ''
      let finalRound = startRound - 1
      try {
        for (let round = startRound; round <= maxRounds; round++) {
          finalRound = round
          const prompt = buildRoundPrompt({ root, session: args.session, label, round, maxRounds, stopToken, progress, task: args.task })
          loopAgent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'plugin', plugin: 'dsh-serenity-hooks' } }))
          await waitIdle(ctx, loopAgent)
          lastResponse = lastAssistantText(loopAgent)
          progress = { round, done: false, label, model, updated: new Date().toISOString(), lastResponse }
          writeProgress(root, label, progress)
          if (lastResponse.includes(stopToken)) {
            done = true
            break
          }
        }
        writeProgress(root, label, { round: finalRound, done, label, model, updated: new Date().toISOString(), lastResponse })
      } finally {
        // owned handle：dispose 停止 loop、注销 agent、移除 session、展开 scope
        await handle.dispose().catch(() => { /* loop agent 清理失败不阻断工具返回 */ })
      }

      const { json } = loopProgressPaths(root, label)
      return {
        done,
        rounds: finalRound,
        model,
        label,
        progressFile: json,
        lastResponse: lastResponse.slice(0, 2000),
        usage: {
          how: 'loop 内部硬性 while 驱动 agent 逐轮推进，agent 精确回显随机完成码即终止',
          progress: `进度在 AGENT_SESSIONS/loop-${label}.md 与 .json；同 label 再调 loop 会从下一轮续跑（不重做）`,
          constraints: 'loop agent 受完整 Serenity 约束（ACC 身份/入口技能系统提示词/守卫）',
          next: done ? '任务已完成；可查看进度文件收尾' : `任务未完成（已达保险阀 ${maxRounds} 轮）；可同 label 续跑`,
        },
      }
    },
  })
}
