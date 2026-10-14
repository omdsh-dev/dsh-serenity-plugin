/**
 * cheap-worker.ts — cheap-worker（杂工）真实 DSH 工具
 *
 * v1.24.0：loop（牛马）→ handyman（杂工）；2026-10-14：handyman → cheap-worker。
 * 🆕 2026-10-14（owner 令「删除后台运行能力」）：**background 模式整条退场** ——
 *    轮次循环 ／ stop-token 完成码 ／ 进度文件 ／ 重启计数 ／ maxRounds／maxParallel 全部删除。
 *    现存只有**前台委派**一种形态：宿主起子 agent、等它跑完、取回最终文本。
 *
 * 机制：走宿主**委派正门** `ctx.subagents.start('spawn', …)`（深度上限、子 agent 所有权、
 * `subagent/start|end` 事件、`dispose()` 收尾全部沿用宿主实现），模型经 `agentOptions` 注入。
 * 前置：`exec.agent` 必须存在（前台委派要有发起方）。
 *
 * 🔴 **模型不可由调用方指定**（owner 令）：**没有 `model` 参数**，一律读 CCC 配置
 *    `cheap-worker.models` / `cheap-worker.defaultModel`（单一真相源）。
 *
 * 递归防护：子 agent 的工具面 deny `cheap-worker` 本身（编排归主 agent，防无限嵌套）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Context } from 'cordis'
import { readCheapWorkerConfig, DEFAULT_SERENITY_CONFIG_PATHS } from '../ccc.js'
import { cccRootForExec, NO_CCC_FROM_AGENT_CWD } from '../ccc-roots.js'
import {
  CHEAP_WORKER_GUIDE,
  providerAvailabilityError,
  requireWhitelistedModel,
  splitModel,
} from '../cheap-worker-ops.js'
import type { JsonValue } from '../json.js'
import { hostLlm, hostSubagents } from '../host/access.js'

function renderText(value: unknown): ContentBlock[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

/**
 * 🔴 **前台并行上限 = 10**（owner 2026-09-29 具名令：「这个版本顺手帮我把 handyman 并行度从 5 调整成 10」；
 * 原值 5 出自 owner 2026-09-27 的具名令「最大 5；就当是支持自定模型的 subagent 用了，急需」）。
 *
 * 为什么是**硬编码**而不是又一个配置键：owner 两次都是**直接给数**（同 `REBUILD-TODO` 那次的裁决口径
 * —— 设定项能不加就不加，见 S142 的「可砍设定项」）。若将来还要调，仍按具名令改这个常量。
 *
 * 为什么是 10 而不是更高：**前台委派会占住主 agent 的这一轮**（调用方在等结果），
 * 并发越高越容易把宿主的并发面与用量推上去。
 */
const FOREGROUND_MAX_PARALLEL = 10

/** foreground 的 jobs 解析（label 可选 —— 前台 label 只是显示名，不命名任何文件） */
function parseForegroundJobs(raw: unknown): Array<{ task: string; label?: string }> | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const jobs: Array<{ task: string; label?: string }> = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null
    const rec = item as Record<string, unknown>
    if (typeof rec.task !== 'string' || rec.task.trim() === '') return null
    jobs.push({
      task: rec.task,
      ...(typeof rec.label === 'string' && rec.label !== '' ? { label: rec.label } : {}),
    })
  }
  return jobs
}

/** foreground 模式结果（一次调用一次结果；无循环、无进度文件） */
interface CheapWorkerForegroundResult {
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
 * providerPreflight — 在**创建任何 worker 之前**判定「本机有没有该 provider 的 adapter」。
 *
 * 返回**可执行**的错误文本；`null` = 可用，**或无法取证**（服务缺失 / 形状不符 / 读取抛错
 * ⇒ 一律**不阻断**，保持旧行为 —— 增强不得变成新的失败源）。
 *
 * 为什么必须放在"创建之前"：宿主对未知 provider 抛 `no adapter registered for provider "…"`
 * （`dsh-llm`，code `NO_ADAPTER`）。若照常创建：只拿回 `stopReason:"error"` ＋ **空
 * `diagnostic`**（实测）⇒ 调用方（LLM）无法自我修正配置。
 */
function providerPreflight(ctx: Context, model: string): string | null {
  const llm = hostLlm(ctx)
  if (typeof llm?.listProviders !== 'function') return null
  let registered: Array<{ id: string; name?: string }>
  try {
    const raw = llm.listProviders()
    if (!Array.isArray(raw)) return null   // 形状不符（旧宿主）⇒ 不判定
    registered = raw.filter((r): r is { id: string; name?: string } =>
      typeof r === 'object' && r !== null && typeof (r as { id?: unknown }).id === 'string')
  } catch {
    return null                            // 读取失败 = 服务不可用（等价缺失）⇒ 不判定
  }
  let declared: Array<{ provider: string; displayName?: string; settingsNs?: string }> = []
  try {
    const raw = llm.listConfigurableProviders?.()
    if (Array.isArray(raw)) {
      declared = raw.filter((d): d is { provider: string; displayName?: string; settingsNs?: string } =>
        typeof d === 'object' && d !== null && typeof (d as { provider?: unknown }).provider === 'string')
    }
  } catch {
    /* 声明面读不到只是少一段建议，不影响判定 */
  }
  return providerAvailabilityError([model], { registered, declared, configPath: '.opencode/serenity.json' })
}

/**
 * 单次前台串行委派。
 *
 *  - 走宿主**委派正门** `ctx.subagents.start('spawn', …)`——深度上限、子 agent 所有权、
 *    `subagent/start|end` 生命周期事件、`dispose()` 收尾全部沿用宿主实现（不重写 agent 创建）；
 *  - 模型经 `agentOptions` 注入（spawn 后端能力位 `agentOptions: true`），因此**不依赖**
 *    宿主未放开的 `subagent-model-selection` 设置；
 *  - 不循环、不写文件、不做完成码校验——"一次调用一次结果"。
 *
 * 前置条件：`opts.parent` 必须是发起 agent（由调用方 `execute` 在解析 CCC 之前校验；
 * 本函数不再重复检查——单一真相源）。
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
): Promise<CheapWorkerForegroundResult> {
  const { task, label, model, models, parent, signal } = opts
  requireWhitelistedModel(model, models)
  const subagents = hostSubagents(ctx)
  if (!subagents?.start) {
    throw new Error(
      'cheap-worker: host subagents service unavailable — neither ctx.subagents nor '
      + 'ctx.get("subagents") yielded a start() function. Check `dashboard health` (host-contract '
      + 'section, service "subagents").',
    )
  }
  // 🔴 provider 预检（v1.48）：本机没有该 provider 的 adapter ⇒ **不创建注定失败的子 agent**，
  // 而是把**可执行原因**放进 `diagnostic`（前台路径既有的"失败解释"位，工具描述也指向它）。
  const preflight = providerPreflight(ctx, model)
  if (preflight !== null) {
    return { mode: 'foreground', done: false, model, stopReason: 'error', output: '', diagnostic: preflight }
  }
  const { provider, model: modelName } = splitModel(model)
  const run = (await subagents.start('spawn', {
    ...(label === undefined ? {} : { label }),
    prompt: [{ type: 'text', text: task }],
    parent,
    signal: signal ?? new AbortController().signal,
    agentOptions: { ...(provider === undefined ? {} : { provider }), model: modelName },
    // 递归防护：子 agent 不再持有 cheap-worker（编排归主 agent）
    toolFilter: { deny: ['cheap-worker'] },
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

/** 创建 cheap-worker 工具（闭包捕获插件 ctx → 可访问 ctx.subagents） */
export function createCheapWorkerTool(ctx: Context): ToolDefinition {
  return defineTool({
    name: 'cheap-worker',
    description:
      'The cheap-worker (杂工): delegate work to a worker agent on the CCC-configured model, and return its ' +
      'final text. One serial child per task; `jobs` fans out in parallel.\n' +
      'Usage: cheap-worker(task, [label]) for a single delegation; ' +
      'cheap-worker(jobs=[{task,label?},...]) for parallel fan-out (cap 10, results keep your order).\n' +
      'The child does NOT share this conversation — the task must be self-contained.\n' +
      'No loop, no completion-code validation, no progress file, no unattended/background run.\n' +
      'Model: NOT selectable per call — it is read from .opencode/serenity.json "cheap-worker.models" ' +
      '(missing config = error); "cheap-worker.defaultModel" names the one used, falling back to models[0].\n' +
      'Provider check: the whitelist lives in the CCC (it travels with the repo) while provider adapters are ' +
      'registered per machine by the host — so before spawning, the provider of the resolved model is verified ' +
      'against the adapters present on THIS machine. If it is missing you get the available providers plus the ' +
      'exact fix in `diagnostic`, and no child is created.\n' +
      'Recursion: a worker\'s tool set excludes cheap-worker itself (orchestration belongs to the main agent).\n' +
      'Guide: cheap-worker(guide=true) prints the scale-up usage guide.',
    parameters: {
      task: { type: 'string', description: 'The task goal to complete (must be self-contained — the child does not share this conversation)' },
      label: { type: 'string', description: 'Optional child display name' },
      jobs: {
        type: 'array',
        description: 'Multi-job orchestration (workflow capability): [{task, label?}, ...] — runs jobs in parallel, cap 10 (fixed). Results keep the order you passed them in.',
        items: {
          type: 'object',
          properties: {
            task: { type: 'string' },
            label: { type: 'string' },
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
        return { guide: CHEAP_WORKER_GUIDE }
      }
      // 前台委派的「发起方」是**调用形态**前提，先于 CCC 解析检查。
      // 为什么顺序重要（R↓，CI 实证）：`cccRootForExec` 在无 `exec.agent` 时回落
      // `process.cwd()`，而该 cwd 未必落在任何 CCC 内（CI runner 的 cwd = 仓库根，
      // 祖先链无 `.serenity`）→ 原顺序先抛 `No CCC found`，把真正的错误原因盖掉，
      // 也让用例依赖"运行目录恰好在某个 CCC 里"。
      if (!exec.agent) {
        throw new Error('cheap-worker: requires a calling agent (exec.agent was undefined)')
      }

      const root = cccRootForExec(exec)
      if (!root) throw new Error(NO_CCC_FROM_AGENT_CWD)

      const hc = readCheapWorkerConfig(root, DEFAULT_SERENITY_CONFIG_PATHS)
      if (hc === null) {
        throw new Error(
          'cheap-worker requires a model whitelist: configure .opencode/serenity.json "cheap-worker.models" ' +
            '(e.g. {"cheap-worker": {"models": ["minimax-cn-coding-plan/MiniMax-M3"], "defaultModel": "minimax-cn-coding-plan/MiniMax-M3"}})',
        )
      }

      // ── 并行扇出（jobs）──
      if (args.jobs !== undefined) {
        const jobs = parseForegroundJobs(args.jobs)
        if (jobs === null) throw new Error('cheap-worker: jobs must be [{task, label?}, ...] (every job requires a non-empty task)')
        if (jobs.length > FOREGROUND_MAX_PARALLEL) {
          throw new Error(
            `cheap-worker: ${jobs.length} jobs exceed the parallel cap ${FOREGROUND_MAX_PARALLEL}`
              + ' (split into batches)',
          )
        }
        const results = await Promise.all(
          jobs.map((job) => runForegroundJob(ctx, {
            task: job.task,
            ...(job.label === undefined ? {} : { label: job.label }),
            model: hc.defaultModel,
            models: hc.models,
            parent: exec.agent,
            signal: (exec as { signal?: AbortSignal }).signal,
          })),
        )
        const done = results.every((r) => r.done)
        return {
          mode: 'foreground',
          done,
          jobs: results,
          usage: {
            how: `foreground parallel mode starts ${results.length} child agents at once through the host delegation service (ctx.subagents.start "spawn"), awaits all of them, and returns each child's final text. No loop, no completion-code validation, no progress file. Cap = ${FOREGROUND_MAX_PARALLEL}.`,
            model: 'NOT selectable per call — resolved from the CCC config cheap-worker.models (cheap-worker.defaultModel, else models[0])',
            next: done
              ? 'All children completed; use each job\'s output directly (results are in the same order as the jobs you passed)'
              : 'Some children did not complete — inspect each job\'s diagnostic/output (results keep the order you passed)',
          },
        } as unknown as JsonValue
      }

      // ── 单任务 ──
      if (typeof args.task !== 'string' || args.task.trim() === '') {
        throw new Error('cheap-worker: task is required (and must be self-contained — the child does not share this conversation)')
      }
      const res = await runForegroundJob(ctx, {
        task: args.task,
        ...(typeof args.label === 'string' && args.label !== '' ? { label: args.label } : {}),
        model: hc.defaultModel,
        models: hc.models,
        parent: exec.agent,
        signal: (exec as { signal?: AbortSignal }).signal,
      })
      return {
        ...res,
        usage: {
          how: 'foreground mode starts ONE serial child agent through the host delegation service (ctx.subagents.start "spawn") with the CCC-configured model; it awaits the run and returns the child\'s final text. No loop, no completion-code validation, no progress file.',
          model: 'NOT selectable per call — resolved from the CCC config cheap-worker.models (cheap-worker.defaultModel, else models[0])',
          next: res.done
            ? 'Child completed; use its output directly'
            : `Child did not complete (stopReason=${res.stopReason}); inspect diagnostic/output and decide whether to retry`,
        },
      } as unknown as JsonValue
    },
  })
}
