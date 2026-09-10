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
 * 未完成继续下一轮；followup/等待空闲抛错（非正常停止）→ dispose 并重新 create agent
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
import { waitAgentIdle } from '../agent-idle.js'
import { hostSubagents } from '../host/access.js'

function agentCwd(exec: ToolRunContext): string {
  return (exec.agent?.session as { header?: { cwd?: string } } | undefined)?.header?.cwd ?? process.cwd()
}

function renderText(value: unknown): ContentBlock[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
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
function parseJobs(raw: unknown): HandymanJob[] | null {  if (!Array.isArray(raw) || raw.length === 0) return null
  const jobs: HandymanJob[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null
    const rec = item as Record<string, unknown>
    if (typeof rec.task !== 'string' || typeof rec.label !== 'string') return null
    jobs.push({ task: rec.task, label: rec.label, model: typeof rec.model === 'string' ? rec.model : undefined })
  }
  return jobs
}

// ── v1.31.3 foreground 模式：一次前台串行委派（用户裁决：handyman 双模式）──

/** foreground 模式结果（一次调用一次结果；无循环、无进度文件） */
export interface HandymanForegroundResult {
  mode: 'foreground'
  done: boolean
  model: string
  stopReason: string
  output: string
  childId?: string
  diagnostic?: string
}

/** 宿主 `ctx.subagents.start()` 返回句柄的最小形状（不直接依赖宿主类型） */
interface SubagentRunLike {
  id?: string
  result?: Promise<{ output?: unknown; diagnostic?: unknown; stopReason?: unknown }>
  dispose?: () => Promise<void>
}

/** 拼接 SubagentResult.output（ContentBlock[]）中的文本块 */
function subagentOutputText(output: unknown): string {
  if (!Array.isArray(output)) return ''
  return output
    .filter((b): b is { type?: string; text?: string } => typeof b === 'object' && b !== null)
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
}

/**
 * foreground 模式：单次前台串行委派（用户裁决"本次所需的简单实现"）。
 *
 * 与 background 的差别（R↓）：
 *  - 走宿主**委派正门** `ctx.subagents.start('spawn', …)`——深度上限、子 agent 所有权、
 *    `subagent/start|end` 生命周期事件、`dispose()` 收尾全部沿用宿主实现（不重写 agent 创建）；
 *  - 模型经 `agentOptions` 注入（spawn 后端能力位 `agentOptions: true`），因此**不依赖**
 *    宿主未放开的 `subagent-model-selection` 设置；
 *  - 不循环、不写进度文件、不做完成码校验——"一次调用一次结果"。
 */
async function runForegroundJob(
  ctx: Context,
  opts: {
    task: string
    label?: string
    model: string
    models: string[]
    parent: unknown
    signal?: AbortSignal
  },
): Promise<HandymanForegroundResult> {
  const { task, label, model, models, parent, signal } = opts
  requireWhitelistedModel(model, models)
  const subagents = hostSubagents(ctx)
  if (!subagents?.start) {
    throw new Error(
      'handyman foreground: host subagents service unavailable — neither ctx.subagents nor '
      + 'ctx.get("subagents") yielded a start() function. Check `dashboard health` (host-contract '
      + 'section, service "subagents"); mode="background" does not need this service and still works.',
    )
  }
  if (!parent) throw new Error('handyman foreground: requires a calling agent (exec.agent was undefined)')
  const { provider, model: modelName } = splitModel(model)
  const run = (await subagents.start('spawn', {
    ...(label === undefined ? {} : { label }),
    prompt: [{ type: 'text', text: task }],
    parent,
    signal: signal ?? new AbortController().signal,
    agentOptions: { ...(provider === undefined ? {} : { provider }), model: modelName },
    // 递归防护：子 agent 不再持有 handyman（对齐 background 的 tools.restrict deny）
    toolFilter: { deny: ['handyman'] },
  })) as SubagentRunLike
  try {
    const result = run.result === undefined ? {} : await run.result
    const stopReason = typeof result.stopReason === 'string' ? result.stopReason : 'error'
    return {
      mode: 'foreground',
      done: stopReason === 'completed',
      model,
      stopReason,
      output: subagentOutputText(result.output),
      ...(typeof run.id === 'string' ? { childId: run.id } : {}),
      ...(typeof result.diagnostic === 'string' && result.diagnostic !== ''
        ? { diagnostic: result.diagnostic }
        : {}),
    }
  } finally {
    // dispose 幂等：无论结果如何都释放子 agent（与原生 subagent 前台路径同构）
    if (run.dispose) await run.dispose().catch(() => {})
  }
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
        await waitAgentIdle(ctx, workerAgent)
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
      'The handyman (杂工): delegate work to a worker agent on a CCC-configured model. Two modes (v1.31.3).\n' +
      'Mode "foreground" (DEFAULT): one serial child agent runs the task once and returns its final text — ' +
      'no loop, no completion-code validation, no progress file; use it for one-shot serial delegation ' +
      '(e.g. per-case testers that just gather evidence). Usage: handyman(task, [label], [model]).\n' +
      'Mode "background": the loop-validated worker — internal hard while-loop whose ONLY completion condition ' +
      'is the worker echoing this round\'s random completion code (stop token, prevents low-intelligence models ' +
      'from finishing early), round cap (default 100, resumable), automatic restart on abnormal stop (≤100), ' +
      'progress file AGENT_SESSIONS/handyman-<label>.md/.json (same label resumes), and parallel jobs ' +
      '(handyman.maxParallel, default 10). Usage: handyman(mode="background", task, label, [model]) or ' +
      'handyman(mode="background", jobs=[{task,label,model?},...]).\n' +
      'Choosing: need exactly one result back now → foreground; need anti-early-finish guarantees, resumability ' +
      'or parallel jobs → background.\n' +
      'Model: only models whitelisted in .opencode/serenity.json "handyman.models" (missing config = error); ' +
      'default reads handyman.defaultModel. Both modes share the same whitelist and default.\n' +
      'Recursion: a worker\'s tool set excludes handyman itself (orchestration belongs to the main agent).\n' +
      'Guide: handyman(guide=true) prints the scale-up usage guide.',
    parameters: {
      mode: { type: 'string', description: 'Delegation mode: "foreground" (default — one serial child, returns its final text) or "background" (loop-validated worker with completion-code check, round cap, auto-restart, progress file, parallel jobs)' },
      task: { type: 'string', description: 'The task goal to complete (required in both modes; foreground needs a self-contained prompt — the child does not share this conversation)' },
      label: { type: 'string', description: 'Task label (background: 1-50 chars, names the progress file; foreground: optional child display name)' },
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

      // ── 模式分派（v1.31.3，用户裁决）：缺省 foreground；background = 既有循环校验实现 ──
      const mode = args.mode === 'background' ? 'background' : 'foreground'
      if (args.mode !== undefined && args.mode !== 'background' && args.mode !== 'foreground') {
        throw new Error('handyman: mode must be "foreground" (default) or "background"')
      }
      if (mode === 'foreground') {
        if (typeof args.task !== 'string' || args.task.trim() === '') {
          throw new Error('handyman foreground: task is required (and must be self-contained — the child does not share this conversation)')
        }
        if (args.jobs !== undefined) {
          throw new Error('handyman foreground: jobs is background-only — call foreground once per task, or use mode="background" for parallel jobs')
        }
        const model = typeof args.model === 'string' && args.model !== '' ? args.model : hc.defaultModel
        const res = await runForegroundJob(ctx, {
          task: args.task,
          ...(typeof args.label === 'string' && args.label !== '' ? { label: args.label } : {}),
          model,
          models: hc.models,
          parent: exec.agent,
          signal: (exec as { signal?: AbortSignal }).signal,
        })
        return {
          ...res,
          usage: {
            how: 'foreground mode starts ONE serial child agent through the host delegation service (ctx.subagents.start "spawn") with the CCC-configured model; it awaits the run and returns the child\'s final text. No loop, no completion-code validation, no progress file.',
            model: 'restricted to the CCC whitelist handyman.models; default reads handyman.defaultModel',
            next: res.done
              ? 'Child completed; use its output directly'
              : `Child did not complete (stopReason=${res.stopReason}); inspect diagnostic/output and decide whether to retry, switch model, or use mode="background"`,
          },
        } as unknown as JsonValue
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
