/**
 * loop.ts — acc_loop 真实 DSH 工具（老 loop 等效：廉价模型牛马循环）
 *
 * 语义对齐 opencode-serenity-plugin 老 loop：
 *   label（必）任务标签 → 进度文件 loop-<label>.md/.json
 *   session（选）工作会话 S###（上下文提示）
 *   model（选）provider/model（如 minimax-cn-coding-plan/MiniMax-M3）；缺省读 loop.defaultModel
 *   （S134 修正：轮次不需要调用者指定——内部 while 驱动 agent 逐轮推进，
 *    对话轮次**无上限**（不完成不返回）；agent 非正常停止时自动重启，
 *    重启次数上限 LOOP_MAX_RESTARTS=100（防死循环保险阀））
 *
 * 机制：ctx.agents.create()（带 setup 钩子）创建专用 agent（进程内），
 * 每轮 followup → agent/status idle → 读 session.events 响应 → 写进度 → stop token 检查 →
 * 未完成继续下一轮；followup/waitIdle 抛错（非正常停止）→ dispose 并重新 create agent
 * （重启计数，≤100），同一轮重试。工厂模式：apply 时闭包捕获插件 ctx（工具 execute 无 ctx 参数）。
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
import { buildRoundPrompt, LOOP_GUIDE, loopProgressPaths, newStopToken, readProgress, splitModel, writeFailedStatus, writeProgress } from '../loop-ops.js'
import type { JsonValue } from '../json.js'

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

/** 非正常停止时重启 agent 的次数上限（防死循环保险阀）：对话轮次有上限，重启有上限 */
export const LOOP_MAX_RESTARTS = 100
/** 对话轮次上限（对齐 osp loop-runner 的 round>=100 强制 done 保险阀） */
export const LOOP_MAX_ROUNDS = 100

/** 创建 loop 工具（闭包捕获插件 ctx → 可访问 ctx.agentLoop） */

/** 创建 loop 工具（闭包捕获插件 ctx → 可访问 ctx.agentLoop） */
export function createLoopTool(ctx: Context): ToolDefinition {
  return defineTool({
    name: 'loop',
    description:
      'The workhorse loop (equivalent to the legacy loop): create a dedicated agent with the specified model and run it repeatedly until the task is done.\n' +
      'Usage: loop guide (print the scale-up usage guide — load eap to design a scale-up plan before using); loop accepts task (the goal to complete) or relies on session context; default model reads loop.defaultModel from .opencode/serenity.json (currently minimax-cn-coding-plan/MiniMax-M3, the cheap workhorse).\n' +
      'Behavior: an internal hard while-loop drives the agent round by round, each round waits with no timeout (the agent works as long as it needs). The only completion condition = the agent echoes this round\'s random completion code (stop token), preventing low-intelligence models from finishing early. Rounds need no caller input — dialogue round cap 100 (osp fail-safe; forced stop beyond the cap, resumable), automatic restart on abnormal stop (≤100 restarts, anti-infinite-loop fail-safe).\n' +
      'Progress: written to AGENT_SESSIONS/loop-<label>.md/.json; calling again with the same label resumes from the last round (no redo).\n' +
      'Constraints: loop agents carry full Serenity constraints (ACC identity / entry-skill system prompt / guards / trajectory-steward).\n' +
      'Example: loop 执行「扫描 SQC 并修复 DC 问题」 (run SQC scan and fix DC issues), label: sqc-scan; loop guide',
    parameters: {
      task: { type: 'string', required: true, description: 'The task goal to complete (required: tell the loop agent what to do)' },
      label: { type: 'string', required: true, description: 'Task label (1-50 chars; progress file named loop-<label>.md/.json)' },
      session: { type: 'string', description: 'Work session S### (context hint, progress reference)' },
      model: { type: 'string', description: 'provider/model (e.g. minimax-cn-coding-plan/MiniMax-M3); default reads loop.defaultModel' },
      guide: { type: 'boolean', description: 'Print the scale-up usage guide (creates no agent; read before using loop — includes eap scale-up design requirements / parallelism strategy / prompt conventions)' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderText(value),
    },
    async execute(args, exec): Promise<JsonValue> {
      // guide 子命令：输出规模化使用指引（不创建 agent，不需要 CCC/model）
      if (args.guide) {
        return { guide: LOOP_GUIDE }
      }
      const root = findSerenityRoot(agentCwd(exec))
      if (!root) throw new Error('No CCC found: no .serenity file from agent cwd')
      const cfg = loadSerenityConfig(root, DEFAULT_SERENITY_CONFIG_PATHS)
      const model = args.model ?? cfg.loop?.defaultModel
      if (!model) throw new Error('loop requires a model: pass --model or configure .opencode/serenity.json loop.defaultModel')
      const label = args.label
      if (!ctx.agentLoop) throw new Error('loop: ctx.agentLoop unavailable')

      const { provider, model: modelName } = splitModel(model)
      const stopToken = newStopToken()
      let progress = readProgress(root, label)
      // 续跑：从进度文件的下一轮开始（对话轮号仅用于进度记录/续跑）
      const startRound = progress ? progress.round + 1 : 1

      // 创建 loop agent：经 ctx.agents.create（对齐 subagent 先例）——setup 钩子
      // 在 agent 未发布前把子 scope 绑定到父 agent 的 preset standing mount
      // （agentPresets.composeFrom），使 loop agent 继承父会话的 preset 工具层
      // （read/write/edit 等）。无 agentPresets 服务/父未 join preset 时跳过，
      // 退化为历史行为（全局工具层）。
      // sessionId 带唯一后缀：同 label 多次调用不冲突（session 是每次新建的临时
      // 执行载体，label 只用于进度文件/续跑）；重启时重新生成（旧 session 已损坏）。
      const parentCtx = exec.agent?.ctx
      const inherited = loopPresetInheritance(parentCtx)
      if (!ctx.agents) throw new Error('loop: ctx.agents unavailable')

      // 父会话 id（loop agent 的 parentSession 标记——WebUI 子代理活动卡可见性的关键：
      // client runtime 按 origin='subagent' + parentSessionId 识别子代理（S134 调研结论））
      const parentSession = (exec.agent?.session as { id?: string } | undefined)?.id

      // definite-assignment 断言：spawnAgent 在 try 前必被 await 赋值；
      // 循环内异常重启路径也会先 dispose 旧 handle 再重新 spawn
      let handle!: AgentHandle
      let loopAgent!: Agent
      const spawnAgent = async (): Promise<void> => {
        const sessionId = `loop-${label}-${randomUUID()}` as SessionId
        handle = await ctx.agents.create({
          sessionId,
          meta: {
            cwd: root,
            // origin + parentSession：loop agent 注册为父会话的子代理 →
            // WebUI 子代理活动卡实时可见（对齐 workflow 子 agent 机制）；
            // 副作用正确：shouldAutoRestore 排除 subagent origin（loop 不恢复主会话激活）
            origin: 'subagent',
            ...parentSession === undefined ? {} : { parentSession: parentSession as SessionId },
            ...inherited.agentPreset === undefined ? {} : { agentPreset: inherited.agentPreset },
          },
          agentOptions: { provider, model: modelName },
          ...inherited.setup === undefined ? {} : { setup: inherited.setup },
        })
        loopAgent = handle.agent
      }
      await spawnAgent()

      let done = false
      let lastResponse = progress?.lastResponse ?? ''
      let finalRound = startRound - 1
      // 非正常停止（followup/waitIdle 抛错）时重启 agent 的次数；对话轮次上限 LOOP_MAX_ROUNDS
      let restarts = 0
      // 结束原因（对齐 osp finishReason 语义）：done / max_rounds / restart_exceeded
      let finishReason: 'done' | 'max_rounds' | 'restart_exceeded' = 'done'
      try {
        let round = startRound
        while (true) {
          // 轮次上限保险阀（对齐 osp）：round 超上限强制终止（done=false，可续跑）
          if (round > LOOP_MAX_ROUNDS) {
            finishReason = 'max_rounds'
            break
          }
          finalRound = round
          const prompt = buildRoundPrompt({ root, session: args.session, label, round, stopToken, progress, task: args.task })
          try {
            loopAgent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'plugin', plugin: 'dsh-serenity-hooks' } }))
            await waitIdle(ctx, loopAgent)
            lastResponse = lastAssistantText(loopAgent)
          } catch {
            // 非正常停止：重启 agent（≤ LOOP_MAX_RESTARTS 次）后重试同一轮，不消耗对话轮号
            restarts++
            if (restarts > LOOP_MAX_RESTARTS) {
              finishReason = 'restart_exceeded'
              break
            }
            await handle.dispose().catch(() => {})
            await spawnAgent()
            continue
          }
          progress = { round, done: false, label, model, updated: new Date().toISOString(), lastResponse }
          writeProgress(root, label, progress)
          // 唯一正常结束条件（当且仅当）：agent 精确回显本轮随机验证码。
          // agent 自报"完成"但未回显验证码 → 不算完成，继续下一轮；
          // 任何异常路径（下方 catch）都不置 done——验证码是唯一正常结束判据。
          if (lastResponse.includes(stopToken)) {
            done = true
            finishReason = 'done'
            break
          }
          round++
        }
        writeProgress(root, label, { round: finalRound, done, label, model, updated: new Date().toISOString(), lastResponse, status: done ? 'done' : 'running' })
        // 失败状态落盘（对齐 osp writeFailedStatus）：保险阀终止 → done:true/status:failed/errorCode
        if (finishReason !== 'done') {
          writeFailedStatus(root, label, {
            errorCode: finishReason,
            errorMessage: finishReason === 'max_rounds'
              ? `Reached ${LOOP_MAX_ROUNDS} rounds without completion — resume with same label to continue.`
              : `Agent restarted ${LOOP_MAX_RESTARTS} times without progress — resume with same label to continue.`,
          })
        }
      } finally {
        // owned handle：dispose 停止 loop、注销 agent、移除 session、展开 scope
        await handle.dispose().catch(() => { /* loop agent 清理失败不阻断工具返回 */ })
      }

      const { json } = loopProgressPaths(root, label)
      return {
        done,
        rounds: finalRound,
        finishReason,
        restarts,
        model,
        label,
        progressFile: json,
        lastResponse: lastResponse.slice(0, 2000),
        usage: {
          how: `loop drives the agent round by round via an internal hard while-loop; the agent terminates by echoing the random completion code; dialogue round cap ${LOOP_MAX_ROUNDS} (osp fail-safe), automatic restart on abnormal stop (≤${LOOP_MAX_RESTARTS} times)`,
          progress: `Progress in AGENT_SESSIONS/loop-${label}.md and .json; calling loop again with the same label resumes from the next round (no redo)`,
          constraints: 'loop agents carry full Serenity constraints (ACC identity / entry-skill system prompt / guards / trajectory-steward)',
          next: done ? 'Task completed; check the progress file to wrap up' : `Task incomplete (${finishReason}, hit ${LOOP_MAX_ROUNDS} rounds or ${LOOP_MAX_RESTARTS} restart fail-safe); resume with the same label`,
        },
      }
    },
  })
}
