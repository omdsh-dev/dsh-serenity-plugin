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

/** 宿主委派返回句柄的最小形状（不直接依赖宿主类型）。新旧形态**同形**，故一个接口够用：
 *  旧 `SubagentRun` = `{id, result, dispose}`；新 `SubagentActivation` = `{childId, result, dispose}`。 */
interface SubagentRunLike {
  /** 旧形态的 id */
  id?: string
  /** 新形态（0.2.1-rc.1 起）的稳定身份 —— 与 `id` **不同名、同义** */
  childId?: string
  result?: Promise<{ output?: unknown; diagnostic?: unknown; stopReason?: unknown }>
  dispose?: () => Promise<void>
}

/**
 * 选出一个可用的"启动子 agent"函数（**先新后旧**）。
 *
 * 🔴 **为什么需要这一层**（v1.59.3 适配，2026-10-17）：
 *   宿主 `0.2.1-rc.1` **移除了** `SubagentRuntime.start(name, request)`，改由
 *   `startActivation(spec)` 承担；而 `0.1.7-rc.*` / `0.2.0-rc.*` **只有** `start`。
 *   本仓仍声明支持双档（`VERIFIED_HOST_BANDS`）⇒ **不能只留一边**。
 *
 * 形状差异（逐字取自两端 `.d.ts`）：
 *   · 旧：`start('spawn', {label?, prompt, parent, signal, agentOptions, toolFilter})`
 *   · 新：`startActivation({provider:'spawn', label, request:{prompt, parent, agentOptions}, signal, delivery})`
 *     —— 注意 `label` 在新 spec 里是**必填**（`readonly label: string`），故这里补默认值。
 *
 * @returns 一个统一签名的启动器；两者都不存在 ⇒ `undefined`（由调用方报**可诊断**的错）
 */
function resolveSubagentStarter(
  subagents: { start?: unknown; startActivation?: unknown },
): ((request: { label: string; prompt: unknown[]; parent: unknown; signal: AbortSignal; agentOptions: Record<string, unknown>; cwd?: string }) => Promise<unknown>) | undefined {
  if (typeof subagents.startActivation === 'function') {
    // 🔴🔴 2026-10-17（S142 · **升级 0.2.1-rc.2 后真机炸出的缺陷**）：
    //   这里**不能**把方法取出来再裸调（`const fn = subagents.startActivation; fn(spec)`）——
    //   宿主实现是 `async startActivation(spec) { const provider = this.expectProvider(spec.provider); … }`
    //   ⇒ **裸调会丢 `this`** ⇒ 运行时报 `Cannot read properties of undefined (reading 'expectProvider')`。
    //   为什么此前没暴露：旧接口 `start()` 是**闭包实现**、不依赖 `this`；而 v1.59.3 的 Docker 实测
    //   只验证了"新宿主上成员存在且能选路"，**没有真调一次** ⇒ 这正是本轨那条
    //   「'调用没报错' ≠ '内容到了'」的反面：**"选路正确" ≠ "调用能成"**。
    //   ⇒ 修法：**保留接收者**，用 `.call(subagents, spec)`。
    const fn = subagents.startActivation as (this: unknown, spec: unknown) => Promise<unknown>
    return (req) => fn.call(subagents, {
      provider: 'spawn',
      // 新 spec 的 `label` 必填；我们对外仍允许不传 ⇒ 退化成任务首行（人在子会话列表里能认出）
      label: req.label,
      request: {
        prompt: req.prompt,
        parent: req.parent,
        agentOptions: req.agentOptions,
        ...(req.cwd === undefined ? {} : { cwd: req.cwd }),
      },
      signal: req.signal,
      // 🔴 `caller` = 只把结果返回给调用方、**不通知模型** —— 正是 cheap-worker 的语义
      //    （spec 注释逐字：Parent delivery notifies the model; caller delivery only returns the result）
      delivery: 'caller',
    })
  }
  if (typeof subagents.start === 'function') {
    const fn = subagents.start as (name: string, request: unknown) => Promise<unknown>
    return (req) => fn('spawn', {
      label: req.label,
      prompt: req.prompt,
      parent: req.parent,
      signal: req.signal,
      agentOptions: req.agentOptions,
      // 🔴 **旧档仍传 `toolFilter`**：它的 `SubagentStartRequest` 有这个字段
      //    ⇒ 递归防护在旧档上**照旧成立**（不要因为新档做不到就把旧档的能力一起丢掉）。
      toolFilter: { deny: ['cheap-worker'] },
      ...(req.cwd === undefined ? {} : { cwd: req.cwd }),
    })
  }
  return undefined
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
 * 任务首行 → 子会话 label（截断）。
 *
 * 🔴 为什么必须有一个：新宿主 `SubagentActivationSpec.label` 是**必填**（`readonly label: string`），
 *   而我们对外把 `label` 当可选参数 ⇒ 缺省时必须自己造一个，否则 spec 不合法。
 *   取任务首行而不是空串：子会话在列表里要能被人认出来（空串等于没有标识）。
 */
function firstLineLabel(task: string): string {
  const line = task.split(/\r?\n/)[0]?.trim() ?? ''
  const clipped = line.length > 60 ? `${line.slice(0, 60)}…` : line
  return clipped === '' ? 'task' : clipped
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
  // 🔴 A3（v1.59.3）：守卫必须判**两个成员**。宿主 0.2.1-rc.1 移除了 `start`，只留 `startActivation`
  //    ⇒ 只判 `start` 会让守卫**恒真**，并把"成员改名了"误报成"服务不可用"（排障被引向错方向）。
  const starter = subagents === undefined ? undefined : resolveSubagentStarter(subagents)
  if (starter === undefined) {
    throw new Error(
      'cheap-worker: host subagents service unavailable — neither ctx.subagents.startActivation (0.2.1-rc.1+) '
      + 'nor ctx.subagents.start (0.1.7-rc.* / 0.2.0-rc.*) yielded a starter function. Check `dashboard health` '
      + '(host-contract section, service "subagents").',
    )
  }
  // 🔴 provider 预检（v1.48）：本机没有该 provider 的 adapter ⇒ **不创建注定失败的子 agent**，
  // 而是把**可执行原因**放进 `diagnostic`（前台路径既有的"失败解释"位，工具描述也指向它）。
  const preflight = providerPreflight(ctx, model)
  if (preflight !== null) {
    return { mode: 'foreground', done: false, model, stopReason: 'error', output: '', diagnostic: preflight }
  }
  const { provider, model: modelName } = splitModel(model)
  const run = (await starter({
    // 新 spec 的 `label` 必填 ⇒ 不传时用任务首行（截断），保证子会话可辨识
    label: label ?? firstLineLabel(task),
    prompt: [{ type: 'text', text: task }],
    parent,
    signal: signal ?? new AbortController().signal,
    agentOptions: { ...(provider === undefined ? {} : { provider }), model: modelName },
    // 🔴 A7（v1.59.3，**已知退化，如实记录**）：递归防护 `toolFilter: { deny: ['cheap-worker'] }`
    //    **在 0.2.1-rc.1 上不再可经此路传入** —— 实测取证（`dsh-subagent/lib/index.js`）：
    //      · `startLocal()` 的 `composition: { agentPreset: request.agentPreset }`（新建路径**只有** agentPreset）
    //      · `composition.toolFilter` 只在 **cold-resume** 分支由**持久化描述符**带入（:2180）
    //      · `SubagentStartRequest`（types.d.ts:127-174）已**无** `toolFilter` 字段
    //    ⇒ 调用方无法在"新建"时收窄子 agent 的工具面；官方替代 = **Agent Preset**
    //    （`tool-subagent` 的报错文案逐字：configure persona and tool plugins in an Agent Preset
    //      and select it with agentPreset (spawn only)）。
    //    ⚠️ **本轮不硬做 preset**：我们的插件在**插件层**，而 preset 的 `plugins` 是 **profile 层
    //    Cordis 树声明**（`PresetDefinition.plugins: EntryOptions[]`）⇒ 那是另一件事，须 owner 裁决。
    //    ⇒ **现状 = 新宿主上子 agent 会重新持有 cheap-worker**（可再委派），**不报错、无日志**。
    //      已报 S215；底线是**不假装它还在**。
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
      // 新旧形态身份字段名不同：旧 `id` ／ 新 `childId`（同义）⇒ 两边都认
      ...(typeof (run.childId ?? run.id) === 'string' ? { childId: run.childId ?? run.id } : {}),
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
