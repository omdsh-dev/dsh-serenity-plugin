/**
 * role/worker/core.ts — cheap-worker（杂工）纯逻辑层（零 DSH 依赖，可独立单测）
 *
 * 🆕 2026-10-14（owner 令「删除后台运行能力」）：**进度文件 / stop token / 轮次循环**整族已退场 ——
 * 它们**只**服务于 background 模式。本模块现存 = 前台委派真正需要的三件：
 * 模型串解析 ／ 白名单校验 ／ provider 可用性判读（＋ 使用指引文本）。
 */

/** 解析 model 字符串（provider/model）→ {provider, model}；无 / 视为 model-only */
export function splitModel(model: string): { provider: string | undefined; model: string } {
  const idx = model.indexOf('/')
  if (idx < 0) return { provider: undefined, model }
  return { provider: model.slice(0, idx), model: model.slice(idx + 1) }
}

/** 校验模型在白名单内；不在 → 抛错（用户拍板：只能使用 CCC 配置的模型） */
export function requireWhitelistedModel(model: string, models: string[]): void {
  if (!models.includes(model)) {
    throw new Error(
      `cheap-worker: model "${model}" is not in the CCC whitelist. ` +
        `Configure .opencode/serenity.json "cheap-worker.models" with one of: ${models.join(', ')}`,
    )
  }
}

/**
 * providerAvailabilityError — 判定「**本机有没有该 provider 的 adapter**」，并产出**可执行**的错误文本。
 * 返回 `null` = 全部可用（调用方照常继续）。
 *
 * 🔴 为什么需要它（S142 2026-09-25，owner 在 **Mac** 上实测）：`cheap-worker` 的模型白名单写在
 *   **CCC**（`.opencode/serenity.json`，**随 git 走**），而 provider adapter 由**每台机器的宿主**
 *   注册（profile 配置 / settings 命名空间）⇒ 同一份白名单在一台机器可用、在另一台必失败。
 *   实测症状：宿主抛 `no adapter registered for provider "<p>"`（`dsh-llm`，code `NO_ADAPTER`），
 *   而**前台路径的 `diagnostic` 是空的** ⇒ 调用方（LLM）拿到 `stopReason:"error"` 却**不知道为什么**，
 *   也就无法修正自己的配置 —— 本条把「沉默的失败」变成「可执行的错误」。
 *
 * 数据来源（宿主 `LlmRuntime`）：`listProviders()` = **有 adapter 的路由**；
 * `listConfigurableProviders()` = **已声明但未必激活**的路由（含激活用的 settings 命名空间）。
 *
 * 判据边界：`model` 串里**没有 `/`** 时取不到 provider（沿用 agent 默认路由）⇒ **不判定**（跳过）。
 */
export function providerAvailabilityError(
  models: readonly string[],
  facts: {
    registered: readonly { id: string; name?: string }[]
    declared?: readonly { provider: string; displayName?: string; settingsNs?: string }[]
    configPath?: string
  },
): string | null {
  const registered = new Set(facts.registered.map((r) => r.id))
  const requested = models
    .map((m) => ({ raw: m, provider: splitModel(m).provider }))
    .filter((e): e is { raw: string; provider: string } => typeof e.provider === 'string' && e.provider !== '')
  const missing = [...new Set(requested.filter((e) => !registered.has(e.provider)).map((e) => e.provider))]
  if (missing.length === 0) return null

  const list = (items: string[], cap = 12): string =>
    items.length === 0
      ? '  (none)'
      : items.slice(0, cap).map((s) => `  - ${s}`).join('\n')
        + (items.length > cap ? `\n  … and ${items.length - cap} more` : '')

  const available = facts.registered.map((r) => (r.name ? `${r.id} (${r.name})` : r.id)).sort()
  const declared = (facts.declared ?? []).filter((d) => missing.includes(d.provider))
  const configPath = facts.configPath ?? '<ccc>/.opencode/serenity.json'
  const missingList = missing.map((p) => `"${p}"`).join(', ')

  return [
    `cheap-worker: provider ${missingList} has no adapter registered on this machine.`,
    '',
    '  Requested model(s) :',
    ...requested.map((e) => `    ${e.raw}`),
    `  Configured in      : ${configPath} → "cheap-worker.models" / "cheap-worker.defaultModel"`,
    '',
    '  Why this happens   : the whitelist lives in the CCC (it travels with the repository), while',
    '                       provider adapters are registered per machine by the host. An entry that',
    '                       works on one machine can fail on another.',
    '',
    '  Available on this machine (registered adapters):',
    list(available),
    '',
    '  Declared but NOT active here (activate via settings, then retry):',
    list(declared.map((d) => `${d.provider}${d.displayName ? ` (${d.displayName})` : ''}${d.settingsNs ? ` — settings namespace "${d.settingsNs}"` : ''}`)),
    '',
    '  Fix (pick one, then retry):',
    `    1. Point the whitelist at a provider that IS registered here — edit ${configPath}`,
    '       ("cheap-worker.models", and "cheap-worker.defaultModel" if that is what you relied on).',
    `    2. Register/activate provider ${missingList} on this machine (host profile config,`,
    '       or the settings namespace listed above).',
    '',
    '  Do not retry unchanged — the same call fails identically.',
  ].join('\n')
}

/**
 * cheap-worker 规模化使用指引（guide 子命令输出）。
 *
 * 🆕 2026-10-14：**双模式段已整段退场**（owner 令「删除后台运行能力」）。本指引只描述现行机制：
 * 前台委派（单任务）／前台并行扇出（jobs）／白名单与 provider 预检。
 */
export const CHEAP_WORKER_GUIDE = `# cheap-worker — Scale-Up Usage Guide (guide)

## What it is
One delegation primitive: **foreground spawn**. The host starts child agent(s) through its delegation
service, awaits them, and returns their final text. There is no loop, no completion code, no progress
file, and no unattended/background run.

| | single | parallel (jobs) |
|---|---|---|
| Call | cheap-worker(task, [label]) | cheap-worker(jobs=[{task, label?}, ...]) |
| Behaviour | one child runs the task once | all children start at once, results keep your order |
| Cap | — | **10 (fixed, hardcoded)** |
| Model | CCC config (single source) | same |

## ⚠️ Before using: load eap and design the plan
Before calling cheap-worker, load eap (acc-eap skill) and design the "scale-up cheap-worker plan" based on the EAP framework.

### 1. Task decomposition (E↑ Explicit)
- Split large tasks into explicit subtasks: each subtask defines goal / input / boundaries (what to do, what not to do) / acceptance criteria
- Make dependencies explicit: dependent tasks run serially, independent ones can run in parallel via \`jobs\`

### 2. Prompt design (cheap-worker's task parameter)
- task must be detailed, fixed, and EAP-compliant: clear goal, drawn boundaries, decidable acceptance criteria
- the child does NOT share your conversation — restate everything it needs in task
- Anti-example "handle this file" — ambiguous; good example "read <path>, extract all rows of the「关键决策」table,
  output a JSON array (fields id/conclusion/evidence), do not modify the original file"
- Reading/curating or text-writing work (extracting from files, summarizing, writing docs, generating text, etc.):
  the cheap-worker-internal agent is also required to load eap and organize output per the EAP standard

### 3. Model (CCC-configured, not selectable per call)
- The model is read from .opencode/serenity.json "cheap-worker.models" — **the caller cannot pass one**
  (there is no "model" parameter). "cheap-worker.defaultModel" names which entry is used; it falls back to models[0].
- The CCC is expected to point this whitelist at LOW-COST models: cheap-worker is the bulk-execution channel
- A child's own recursive subagents inherit the child's model automatically (DSH native)

### 3b. 🔴 Provider availability (per-machine — the whitelist is NOT enough)
- The whitelist lives in the **CCC** ("serenity.json", it **travels with the repository**), but provider
  **adapters are registered per machine by the host** (profile config / settings namespace). An entry that
  works on one machine can fail on another with: "no adapter registered for provider <p>".
- Before spawning, cheap-worker verifies the provider of the resolved model against the adapters registered
  **on this machine**; if it is missing it reports the requested model, where it is configured, **the
  providers that ARE available here**, any declared-but-dormant route (with its settings namespace), and the
  exact fix — delivered in the result's "diagnostic" field (never an opaque failure, never a created child).
- ⇒ If you see "has no adapter registered on this machine": edit ".opencode/serenity.json" "cheap-worker.models"
  (and "cheap-worker.defaultModel") to a provider listed as available, or activate/register the provider on this
  machine. **Do not retry the same call unchanged** — it fails identically.

### 4. Parallel strategy
- Independent subtasks: cheap-worker(jobs=[{task,label?},...]) ⇒ fan-out, **cap 10**, results come back
  **in the order you passed them** (label is only a display name).
- For programmable pipeline/phase orchestration at scale, use the platform's workflow tool instead.

## Completion criteria
- The child's run settles; done=true only when stopReason="completed" — otherwise read "diagnostic"
  (and "output" for whatever partial text was produced).
`
