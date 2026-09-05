/**
 * handyman.ts — handyman（杂工）真实 DSH 工具（v1.24.0：loop 牛马 → handyman 杂工）
 *
 * 用户需求（S142 拍板）：
 *   - **同步**（用户明确：这个事一般不会异步——工具阻塞到完成）
 *   - **指定模型**（CCC 白名单内——handyman.models，未配置报错）
 *   - **自主循环到完成**（stop-token 唯一完成判据，对齐 osp loop）
 *   - **内部递归同样低能 subagent**（worker 工具面含 subagent，DSH 原生模型继承）
 *   - **workflow 能力**（jobs 编排：主 agent 一次并行多个杂工，maxParallel 默认 10）
 *   - **worker 不含 handyman 本身**（递归编排归主 agent，防无限嵌套）
 *   - **不兼容旧 loop 进度文件**（仅 handyman- 前缀）
 *
 * 机制：ctx.agents.create()（带 setup 钩子）创建专用 agent（进程内），
 * 每轮 followup → agent/status idle → 读 session.events 响应 → 写进度 → stop token 检查 →
 * 未完成继续下一轮；followup/waitIdle 抛错（非正常停止）→ dispose 并重新 create agent
 * （重启计数，≤100），同一轮重试。工厂模式：apply 时闭包捕获插件 ctx（工具 execute 无 ctx 参数）。
 *
 * preset 继承 + 工具收窄：setup 钩子里对子 agent 执行 agentPresets.composeFrom（对齐
 * subagent 先例）+ tools.restrict deny handyman（worker 内部看不到 handyman 工具）。
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
import { findSerenityRoot, loadSerenityConfig, readHandymanConfig, DEFAULT_SERENITY_CONFIG_PATHS } from '../ccc.js'
import { handymanPresetInheritance } from '../handyman-preset-inherit.js'
import {
  buildRoundPrompt,
  HANDYMAN_GUIDE,
  handymanProgressPaths,
  newStopToken,
  readProgress,
  requireWhitelistedModel,
  splitModel,
  writeFailedStatus,
  writeProgress,
} from '../handyman-ops.js'
import type { JsonValue } from '../json.js'

function agentCwd(exec: ToolRunContext): string {
  return (exec.agent?.session as { header?: { cwd?: string } } | undefined)?.header?.cwd ?? process.cwd()
}

function renderText(value: unknown): ContentBlock[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

/** 等待 agent 空闲（agent/status → idle）；无超时（handyman 可永续，agent 工作多久等多久） */
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
  // v1.28.0 适配 0.1.2-rc.1：Session.snapshotEvents() 方法（rc.1 移除 .events 属性）；
  // 兼容测试替身 events 形态
  const s = agent.session as { snapshotEvents?: () => readonly unknown[]; events?: readonly unknown[] }
  const events: readonly unknown[] = typeof s.snapshotEvents === 'function' ? s.snapshotEvents() : s.events ?? []
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e && (e as { type?: string }).type === 'assistant/message') {
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
export const HANDYMAN_MAX_RESTARTS = 100
/** 对话轮次上限（对齐 osp loop-runner 的 round>=100 强制 done 保险阀） */
export const HANDYMAN_MAX_ROUNDS = 100

export interface HandymanJob {
  task: string
  label: string
  model?: string
}

export interface HandymanJobResult {
  label: string
  done: boolean
  rounds: number
  finishReason: 'done' | 'max_rounds' | 'restart_exceeded'
  restarts: number
  model: string
  lastResponse: string
  progressFile: string
}

/** 运行时解析 jobs 参数（DSH schema 不支持 object items 的 required/校验 → 手工校验类型） */
function parseJobs(raw: unknown): HandymanJob[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const jobs: HandymanJob[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null
    const rec = item as Record<string, unknown>
    if (typeof rec.task !== 'string' || typeof rec.label !== 'string') return null
    jobs.push({ task: rec.task, label: rec.label, model: typeof rec.model === 'string' ? rec.model : undefined })
  }
  return jobs
}

/**
 * 驱动单个 handyman worker：创建 agent → while 循环（stop-token 完成判据）→ dispose。
 * 同步阻塞直到完成/保险阀。jobs 编排时多个 worker 并行（Promise.all）。
 */
async function runHandymanJob(
  ctx: Context,
  opts: {
    root: string
    job: HandymanJob
    defaultModel: string
    models: string[]
    maxRounds: number
    parentSession?: string
    parentCtx?: Context
    session?: string
  },
): Promise<HandymanJobResult> {
  const { root, job, defaultModel, models, maxRounds, parentSession, parentCtx, session } = opts
  const label = job.label
  const model = job.model ?? defaultModel
  requireWhitelistedModel(model, models)

  const { provider, model: modelName } = splitModel(model)
  const stopToken = newStopToken()
  let progress = readProgress(root, label)
  // 续跑：从进度文件的下一轮开始（对话轮号仅用于进度记录/续跑）
  const startRound = progress ? progress.round + 1 : 1

  const inherited = handymanPresetInheritance(parentCtx)
  if (!ctx.agents) throw new Error('handyman: ctx.agents unavailable')

  // definite-assignment 断言：spawnAgent 在 try 前必被 await 赋值；
  // 循环内异常重启路径也会先 dispose 旧 handle 再重新 spawn
  let handle!: AgentHandle
  let workerAgent!: Agent
  const spawnAgent = async (): Promise<void> => {
    const sessionId = `handyman-${label}-${randomUUID()}` as SessionId
    handle = await ctx.agents.create({
      sessionId,
      meta: {
        cwd: root,
        // origin + parentSession：worker 注册为父会话的子代理 →
        // WebUI 子代理活动卡实时可见；shouldAutoRestore 排除 subagent origin
        origin: 'subagent',
        ...parentSession === undefined ? {} : { parentSession: parentSession as SessionId },
        ...inherited.agentPreset === undefined ? {} : { agentPreset: inherited.agentPreset },
      },
      agentOptions: { provider, model: modelName },
      ...inherited.setup === undefined ? {} : { setup: inherited.setup },
    })
    workerAgent = handle.agent
  }
  await spawnAgent()

  let done = false
  let lastResponse = progress?.lastResponse ?? ''
  let finalRound = startRound - 1
  // 非正常停止（followup/waitIdle 抛错）时重启 agent 的次数；对话轮次上限 maxRounds
  let restarts = 0
  // 结束原因（对齐 osp finishReason 语义）：done / max_rounds / restart_exceeded
  let finishReason: 'done' | 'max_rounds' | 'restart_exceeded' = 'done'
  try {
    let round = startRound
    while (true) {
      // 轮次上限保险阀（对齐 osp）：round 超上限强制终止（done=false，可续跑）
      if (round > maxRounds) {
        finishReason = 'max_rounds'
        break
      }
      finalRound = round
      const prompt = buildRoundPrompt({ root, session, label, round, stopToken, progress, task: job.task })
      try {
        workerAgent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'plugin', plugin: 'dsh-serenity-hooks' } }))
        await waitIdle(ctx, workerAgent)
        lastResponse = lastAssistantText(workerAgent)
      } catch {
        // 非正常停止：重启 agent（≤ HANDYMAN_MAX_RESTARTS 次）后重试同一轮，不消耗对话轮号
        restarts++
        if (restarts > HANDYMAN_MAX_RESTARTS) {
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
          ? `Reached ${maxRounds} rounds without completion — resume with same label to continue.`
          : `Agent restarted ${HANDYMAN_MAX_RESTARTS} times without progress — resume with same label to continue.`,
      })
    }
  } finally {
    // owned handle：dispose 停止 worker、注销 agent、移除 session、展开 scope
    await handle.dispose().catch(() => { /* worker agent 清理失败不阻断工具返回 */ })
  }

  const { json } = handymanProgressPaths(root, label)
  return {
    label,
    done,
    rounds: finalRound,
    finishReason,
    restarts,
    model,
    lastResponse: lastResponse.slice(0, 2000),
    progressFile: json,
  }
}

/** 创建 handyman 工具（闭包捕获插件 ctx → 可访问 ctx.agents） */
export function createHandymanTool(ctx: Context): ToolDefinition {
  return defineTool({
    name: 'handyman',
    description:
      'The handyman (杂工): delegate a do-everything worker agent to a CCC-configured model and run it ' +
      'synchronously in rounds until the task is done.\n' +
      'Usage: handyman guide (print the scale-up usage guide — load eap to design a plan before using); ' +
      'single task: handyman(task, label, [model]); multi-job orchestration (workflow capability): handyman(jobs=[{task,label,model?},...]).\n' +
      'Model: only models whitelisted in .opencode/serenity.json "handyman.models" (missing config = error); ' +
      'default reads handyman.defaultModel; jobs run in parallel (handyman.maxParallel, default 10 — cheap models are cheap).\n' +
      'Behavior: each worker runs synchronously (this call blocks until done) with an internal hard while-loop; ' +
      'the only completion condition = the worker echoes this round\'s random completion code (stop token), ' +
      'preventing low-intelligence models from finishing early. Round cap (default 100, osp fail-safe; resumable), ' +
      'automatic restart on abnormal stop (≤100 restarts).\n' +
      'Recursion: a worker\'s tool set includes the subagent tool (DSH-native model inheritance — its subagents ' +
      'use the same model), but NOT handyman itself (orchestration belongs to the main agent).\n' +
      'Progress: AGENT_SESSIONS/handyman-<label>.md/.json; same label resumes from the last round (no redo). ' +
      'Legacy loop- progress files are NOT compatible (v1.24.0).\n' +
      'Example: handyman(task="扫描 SQC 并修复 DC 问题", label="sqc-scan"); handyman(jobs=[{task:"扫描 A",label:"scan-a"},{task:"扫描 B",label:"scan-b"}]); handyman guide',
    parameters: {
      task: { type: 'string', description: 'The task goal to complete (required for single-task mode; must be detailed and EAP-compliant)' },
      label: { type: 'string', description: 'Task label (1-50 chars; progress file named handyman-<label>.md/.json)' },
      session: { type: 'string', description: 'Work session S### (context hint, progress reference)' },
      model: { type: 'string', description: 'provider/model — must be in the CCC whitelist handyman.models; default reads handyman.defaultModel' },
      jobs: {
        type: 'array',
        description: 'Multi-job orchestration (workflow capability): [{task, label, model?}, ...] — runs jobs in parallel (cap handyman.maxParallel, default 10)',
        items: {
          type: 'object',
          properties: {
            task: { type: 'string' },
            label: { type: 'string' },
            model: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
      guide: { type: 'boolean', description: 'Print the scale-up usage guide (creates no agent; includes eap design requirements / whitelist rules / jobs parallel strategy / prompt conventions)' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderText(value),
    },
    async execute(args, exec): Promise<JsonValue> {
      // guide 子命令：输出规模化使用指引（不创建 agent，不需要 CCC/model）
      if (args.guide) {
        return { guide: HANDYMAN_GUIDE }
      }
      const root = findSerenityRoot(agentCwd(exec))
      if (!root) throw new Error('No CCC found: no .serenity file from agent cwd')

      const hc = readHandymanConfig(root, DEFAULT_SERENITY_CONFIG_PATHS)
      if (hc === null) {
        throw new Error(
          'handyman requires a model whitelist: configure .opencode/serenity.json "handyman.models" ' +
            '(e.g. {"handyman": {"models": ["minimax-cn-coding-plan/MiniMax-M3"], "defaultModel": "minimax-cn-coding-plan/MiniMax-M3"}})',
        )
      }

      const jobs: HandymanJob[] = args.jobs !== undefined
        ? (() => {
            const parsed = parseJobs(args.jobs)
            if (parsed === null) throw new Error('handyman: jobs must be [{task, label, model?}, ...] (every job requires task and label)')
            return parsed
          })()
        : (() => {
            if (typeof args.task !== 'string' || typeof args.label !== 'string') {
              throw new Error('handyman: task and label are required (single-job mode)')
            }
            return [{ task: args.task, label: args.label }]
          })()
      if (jobs.length === 0) throw new Error('handyman: no jobs provided')
      if (jobs.length > hc.maxParallel) {
        throw new Error(`handyman: ${jobs.length} jobs exceed maxParallel ${hc.maxParallel} (configure handyman.maxParallel to raise)`)
      }
      if (jobs.some((j) => !j.task || !j.label)) {
        throw new Error('handyman: every job requires task and label')
      }

      const parentCtx = exec.agent?.ctx
      const parentSession = (exec.agent?.session as { id?: string } | undefined)?.id

      // 同步阻塞：单任务直接跑；多任务并行（Promise.all）后汇总返回
      const results = await Promise.all(jobs.map((job) => runHandymanJob(ctx, {
        root,
        job,
        defaultModel: hc.defaultModel,
        models: hc.models,
        maxRounds: hc.maxRounds,
        parentSession,
        parentCtx,
        session: typeof args.session === 'string' ? args.session : undefined,
      })))

      return {
        done: results.every((r) => r.done),
        jobs: results.map((r) => ({ ...r })) as unknown as JsonValue,
        usage: {
          how: 'handyman drives each worker agent round by round via an internal hard while-loop; the worker terminates by echoing the random completion code; round cap (default 100, osp fail-safe), automatic restart on abnormal stop (≤100 times); model restricted to the CCC whitelist handyman.models',
          progress: 'Progress in AGENT_SESSIONS/handyman-<label>.md and .json; calling handyman again with the same label resumes from the next round (no redo)',
          constraints: 'handyman workers carry full Serenity constraints (ACC identity / entry-skill system prompt / guards / trajectory-steward); workers include the subagent tool (same-model inheritance) but NOT handyman itself',
          next: results.every((r) => r.done)
            ? 'All jobs completed; check the progress files to wrap up'
            : 'Some jobs incomplete (max_rounds / restart_exceeded fail-safe); resume with the same labels',
        },
      }
    },
  })
}
