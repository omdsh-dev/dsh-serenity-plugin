/**
 * deepseek-vision-patch.ts — DeepSeek 模型的"支持图片"声明自动补齐（临时，S142 §26 §0x-9）
 *
 * ## 这东西用来干什么（D70：先用途、后机制）
 *
 * DSH 里"某个模型能不能收图"**不是自动识别的**，而是靠**声明**。
 * 声明链（`dsh-llm-pi-ai/lib/index.js:682`）：
 *
 *     input: declaredInput(entry.input) ?? base?.input ?? [...request.defaultInput]
 *
 * 少数模型在**内置目录**里声明了 `["text","image"]`（如 `deepseek-v4-flash-vision-exp`）；
 * 而**不在目录里**的模型走最后一段兜底，`DEFAULT_INPUT = ["text"]`（`:906`）
 * ⇒ **明明支持图片的模型被当成"只能收文字"**（图片被丢/报错）。
 *
 * 本模块：启动时检查模型配置，**凡 id 含 `deepseek` 的模型**，把 `input` 补上 `"image"`。
 * ⇒ 效果：DeepSeek 系模型**开箱能收图**，无需用户手配。
 *
 * ## 为什么叫"临时"（owner 2026-09-19 原话：「临时的我允许」「以后 dsh 做得更完善了我们这个功能再下掉」）
 *
 * 这是在**替上游补一个它还缺的声明**。⇒ 设计上必须**易于整体撤除**（见 §撤除）。
 *
 * ## 授权与边界（**不是后门**）
 *
 * owner 2026-09-19 14:5x 明确授权走**写入型**（§0x-9d 路线 c）：
 * 「临时的我允许，还是要 patch，帮我做个逻辑，如果发现任何 deepseek 模型，都直接 patch 支持多模态」。
 * ⇒ 与 `opencode-provider.ts` **同款通道、同款授权模式**（`ctx.settings.update` 写 `llm-pi-ai` 命名空间）。
 * 🔴 **只补缺失，绝不覆盖用户已有声明**（判据 J4）；**只碰 deepseek 模型**（判据 J1/J2）。
 *
 * ## 注入通道（唯一可用且是官方的）—— 与 `opencode-provider.ts` 同源
 *
 * `ctx.settings.update('llm-pi-ai', patch)`：
 *   ① 深合并（`mergeLayers` 逐层递归）② **先校验后落盘** ③ `writable` ⇒ 写入用户 settings 文档（0600）。
 *
 * ## 🔴 核心实现约束：深合并对**数组是整体替换**（本模块最易错处）
 *
 * 宿主原文（`dsh-settings/lib/index.js:203-216`，逐字）：
 *   "Layer `over` onto `under`: plain objects merge recursively,
 *    **every other value (arrays included) replaces the lower layer wholesale**."
 *
 * ⇒ 若只发 `{ providers: { r: { models: [ 一个元素 ] } } }`，宿主会把它当**整个 models 数组**
 * ⇒ **静默冲掉该 route 上其它所有模型**。
 * ⇒ 本模块**必须读出现有 `models` 全量 → 内存里改目标元素 → 把改过的整个数组回写**。
 * （该行为已由 `tests/host/deepseek-vision-probe.test.ts` 的 W-1 **实测**钉住，非仅源码推断。）
 *
 * ⚠️ 两条同族陷阱（已在实现中处理）：
 *   ① 回写元素必须 **spread 原对象**（否则丢 `name`/`contextWindow`/`compat` 等字段 = 静默改配置）；
 *   ② `modelOverrides` 与 `models` **互斥**（`dsh-llm-pi-ai/lib/index.js:643`）⇒
 *      某 route 未设 `models` 时**绝不新建** `models` 数组（会让该 route 当场校验失败）。
 *
 * ## 已知边界（诚实，不粉饰）
 *
 * 🔴 **本模块只作用于 `llm-pi-ai` 面**。`dsh-llm-deepseek` 有自己的 `DEFAULT_MODELS` +
 * `inputModalities` 字段（`dsh-llm-deepseek/lib/index.js:1841-1884`），**是另一条声明链**。
 * ⇒ 若某 deepseek 模型仍收不了图，第一步应判定它走哪条链，而不是断定本 patch 失效。
 *
 * ## 撤除（三层，从便宜到彻底）
 *
 *   ① **关开关**：CCC 配置 `visionPatch.enabled = false` ⇒ 停止再补（已写的值留着）
 *   ② **整体移除**：删本文件 + `index.ts` 一行装配 ⇒ 功能彻底消失
 *   ③ **清值**：手动编辑 `~/.dsh/settings.yaml` 删掉那些 `input`
 *
 * 🔴 **刻意不做"回滚已写入的值"**（R↓）：我们写的是**事实**（"该模型支持图片"），不是**偏好**；
 * 停掉插件后它依然是事实。做回滚需要一份"哪些是我们写的"的**写入台账**——
 * 那是第二真相源，属本仓已多次识别过的"只增不清"病族（§0z / §0A-5），**不值得为它引入**。
 */
import type { Context } from 'cordis'
import { hostSettings } from './host/access.js'
import { registerDisposer } from './host/effect.js'
import { LLM_PI_AI_NAMESPACE } from './opencode-provider.js'

/** 触发判据：模型 id 含此串即补（**大小写不敏感**；owner：「任何 deepseek 模型」） */
export const DEEPSEEK_ID_MARKER = 'deepseek'

/** 要补上的模态（判据 J3） */
export const VISION_MODALITY = 'image'

/** 文本模态（补 `image` 时保证 `text` 在列——兜底现状就是 `["text"]`，故保持这个基线） */
const TEXT_MODALITY = 'text'

/**
 * 该模型 id 是否属于"要 patch"的对象（判据 J1）。
 *
 * ⚠️ **大小写不敏感**：目录里存在 `deepseek-*` 与 `DeepSeek-*` 两种写法
 * （如 `dsh-llm-deepseek` 的 `name: "DeepSeek-V41-Flash"`）⇒ 只做小写比较。
 */
export function isDeepseekModelId(id: unknown): boolean {
  return typeof id === 'string' && id.toLowerCase().includes(DEEPSEEK_ID_MARKER)
}

/** 该 `input` 声明是否**已含** image（判据 J3/J4：已含即跳过 ⇒ 幂等） */
export function declaresImage(input: unknown): boolean {
  return Array.isArray(input) && input.includes(VISION_MODALITY)
}

/**
 * 计算目标 `input` 数组（**保序去重**；判据 J3）。
 *
 * 六种现状 → 结果（设计 §4.2 全表，测试逐条钉住）：
 * | 现状 | 结果 |
 * |---|---|
 * | 未设（undefined） | `["text","image"]` |
 * | `["text"]` | `["text","image"]` |
 * | `[]` | `["text","image"]` 🔴 `declaredInput([])` 返回 undefined（`:293`）⇒ 空数组语义上等于未声明 |
 * | `["image"]` | **不动**（已含 ⇒ 由调用方跳过） |
 * | `["text","image"]` | **不动**（幂等） |
 * | 非数组（脏数据） | `["text","image"]`（按"未设"处理，不猜用户意图） |
 *
 * @returns 新的 input 数组（已含 image 时原样返回副本）
 */
export function desiredInput(input: unknown): string[] {
  if (!Array.isArray(input)) return [TEXT_MODALITY, VISION_MODALITY]
  // 空数组 ⇒ 与"未设"同义（宿主 `declaredInput` 语义）
  if (input.length === 0) return [TEXT_MODALITY, VISION_MODALITY]
  const out = input.filter((m): m is string => typeof m === 'string')
  if (out.includes(VISION_MODALITY)) return out // 已含 ⇒ 不改（保序）
  // 补 image：保序追加，并确保 text 在列（若原声明连 text 都没有，仍以 text 为基线）
  if (!out.includes(TEXT_MODALITY)) out.unshift(TEXT_MODALITY)
  out.push(VISION_MODALITY)
  return out
}

interface DeepseekVisionPatchInput {
  /** `llm-pi-ai` 命名空间**解析后**的值（0.1.7 读面 `settings.describe()` 里按 `ns` 挑出的 `value`；undefined = 命名空间未注册） */
  resolved: unknown
  /** 开关（CCC 配置 `visionPatch.enabled`）；undefined ⇒ 按默认 true */
  enabled?: boolean
}

/** 一条动作记录（日志 + 测试断言共用；不返回"秘密"、只返回做了什么） */
export type DeepseekVisionAction =
  | { kind: 'patch-model'; route: string; model: string }
  | { kind: 'skip-model'; route: string; model: string; reason: 'already-image' }
  | { kind: 'idle'; reason: 'namespace-unregistered' | 'disabled' | 'no-deepseek-model' }

export interface DeepseekVisionPatchPlan {
  /** 传给 `settings.update` 的补丁；空对象 = 无事可做（**不写**，避免无谓触发 settings/updated） */
  patch: Record<string, unknown>
  actions: readonly DeepseekVisionAction[]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 计算 patch 计划（**纯函数**：不读文件、不碰 ctx —— 便于穷举测试）。
 *
 * 判据顺序（R↓）：
 *   ① 开关关闭 → idle `disabled`（**最先判**：关了就不该再看数据）
 *   ② 命名空间未注册（`resolved === undefined`）→ idle，调用方负责重试（llm-pi-ai 可能后装载）
 *   ③ 逐 route 遍历 `models` 数组：
 *        · 目标是 deepseek 且未声明 image ⇒ 该模型换新 input
 *        · 否则**原样保留**（非 deepseek 一律不动；已含 image 一律不动）
 *      ⇒ 仅当**整个数组确有变化**时才产出 patch（幂等 ⇒ 稳态下零写入）
 *   ④ 全无改动 → idle `no-deepseek-model`
 *
 * 🔴 **数组整写**：`patchProviders[route] = { models: 新数组 }` —— 新数组是**全量**
 * （未改动的元素**原样带上**）。这是本模块最关键的实现约束，理由见文件头。
 *
 * 🔴 **绝不新建 `models`**：某 route 没有 `models`（用 `modelOverrides` 或目录默认）时**直接跳过**
 * ——为它造一个 `models` 会让宿主拒掉整个 route（`:643` 二者互斥）。
 */
export function planDeepseekVisionPatch(input: DeepseekVisionPatchInput): DeepseekVisionPatchPlan {
  const actions: DeepseekVisionAction[] = []
  if (input.enabled === false) {
    return { patch: {}, actions: [{ kind: 'idle', reason: 'disabled' }] }
  }
  if (input.resolved === undefined) {
    return { patch: {}, actions: [{ kind: 'idle', reason: 'namespace-unregistered' }] }
  }
  const providers = isPlainObject(input.resolved) && isPlainObject(input.resolved.providers)
    ? input.resolved.providers
    : {}
  const patchProviders: Record<string, unknown> = {}

  for (const [route, rawProfile] of Object.entries(providers)) {
    const profile = isPlainObject(rawProfile) ? rawProfile : {}
    // 🔴 只处理**已有 `models` 数组**的 route：不新建（`models` 与 `modelOverrides` 互斥，`:643`）
    const models = profile.models
    if (!Array.isArray(models) || models.length === 0) continue

    let changed = false
    const nextModels = models.map((rawEntry) => {
      if (!isPlainObject(rawEntry)) return rawEntry // 脏数据原样保留（不猜）
      const id = rawEntry.id
      if (!isDeepseekModelId(id)) return rawEntry // 判据 J2：只碰 deepseek
      if (declaresImage(rawEntry.input)) {
        actions.push({ kind: 'skip-model', route, model: String(id), reason: 'already-image' })
        return rawEntry // 判据 J4：已声明支持图片 ⇒ 一字不改
      }
      changed = true
      actions.push({ kind: 'patch-model', route, model: String(id) })
      // 🔴 spread 原对象（保字段）+ 只换 input
      return { ...rawEntry, input: desiredInput(rawEntry.input) }
    })

    if (changed) patchProviders[route] = { models: nextModels }
  }

  if (Object.keys(patchProviders).length === 0) {
    // 已有 skip 动作时不再追加 idle —— 保持"每条分支恰好一条动作"的不变量
    if (actions.length === 0) actions.push({ kind: 'idle', reason: 'no-deepseek-model' })
    return { patch: {}, actions }
  }
  return { patch: { providers: patchProviders }, actions }
}

/** 最小 settings 面（结构化读取；零宿主 import 策略 —— 与 opencode-provider 同款） */
interface SettingsLike {
  /** 🔴 0.1.7 的读面（取代 `get`）：`SettingsForms.describe()` 按**条目 id** 给出表单，
   *  其 `value` = 该条目已解析的配置。⚠️ 它有**副作用**：修订号变化时会 emit
   *  `settings/document-updated` ⇒ 本函数被该事件再触发时，第二次 `describe` 的 raw 不变
   *  ⇒ 不会再 emit（**收敛，不成环**）。与 `opencode-provider.ts` 同款通道，两处须同步改。 */
  describe?: (options?: { redactSecrets?: boolean }) => readonly { ns?: string; value?: unknown }[] | undefined
  update?: (ns: string, patch: object) => Promise<void>
}

/** 动作 → 单行人读日志（无秘密） */
export function describeDeepseekVisionAction(action: DeepseekVisionAction): string {
  switch (action.kind) {
    case 'patch-model':
      return `${action.route}/${action.model} 补上 image 声明`
    case 'skip-model':
      return `${action.route}/${action.model} 已声明支持图片（跳过）`
    case 'idle':
      return `无需动作（${action.reason}）`
  }
}

/** 执行结果（调用方据此决定是否停止重试 / 日志） */
export interface DeepseekVisionApplyResult {
  /** 是否**真的写入了** */
  wrote: boolean
  /** 命名空间是否已注册（false ⇒ 调用方应重试） */
  registered: boolean
}

/**
 * 执行一次自动补齐。返回是否写入了（调用方据此决定是否停止重试）。
 *
 * 失败语义（F-08/F-07 纪律）：**任何失败都不抛给宿主**——
 * apply 抛错 = 整个 dsh 启动失败。一律 try/catch + 响亮告警，
 * 最坏情况退回"用户手配 input"。
 */
export async function applyDeepseekVisionPatchOnce(
  ctx: Context,
  enabled?: boolean,
): Promise<DeepseekVisionApplyResult> {
  const settings = hostSettings(ctx) as SettingsLike | undefined
  if (settings?.describe === undefined || settings.update === undefined) {
    console.warn('[serenity-hooks] DeepSeek 多模态补丁跳过：settings 服务不可用（未能读写 llm-pi-ai 命名空间）')
    return { wrote: false, registered: false }
  }
  let resolved: unknown
  try {
    const forms = settings.describe.call(settings) ?? []
    resolved = forms.find((f) => f.ns === LLM_PI_AI_NAMESPACE)?.value
  } catch (error) {
    console.warn(`[serenity-hooks] DeepSeek 多模态补丁跳过：读取 ${LLM_PI_AI_NAMESPACE} 失败: ${String((error as Error)?.message ?? error)}`)
    return { wrote: false, registered: false }
  }
  const plan = planDeepseekVisionPatch({ resolved, ...enabled === undefined ? {} : { enabled } })
  if (Object.keys(plan.patch).length === 0) {
    return { wrote: false, registered: resolved !== undefined }
  }
  try {
    await settings.update.call(settings, LLM_PI_AI_NAMESPACE, plan.patch)
  } catch (error) {
    // 写失败不重试：update 先校验后落盘，被拒通常意味着该 route 在当前宿主不可服务
    // （响亮告警 + 指引手配，比"悄悄重试 N 次"更有用）
    console.warn(
      `[serenity-hooks] ✗ DeepSeek 多模态补丁写入被拒: ${String((error as Error)?.message ?? error)}`
      + '（可手动写入 llm-pi-ai.providers.<route>.models[].input）',
    )
    return { wrote: false, registered: true }
  }
  const changed = plan.actions.filter((a) => a.kind === 'patch-model')
  if (changed.length > 0) {
    console.log(`[serenity-hooks] ✓ DeepSeek 多模态：为 ${changed.length} 个模型补上 image 声明`
      + `（${changed.map((a) => `${a.route}/${a.model}`).join(', ')}）`)
  }
  return { wrote: true, registered: true }
}

/**
 * 命名空间注册重试间隔（毫秒；累计 ~72s）。
 *
 * 为什么要重试：`llm-pi-ai` 只在**它自己的** `ctx.inject(['settings'])` 回调里注册命名空间，
 * 与本插件 apply **无先后保证**。首次读取拿到 undefined 是常态而非错误
 * （与 opencode-provider 同款问题、同款处置：v1.30.13 实证"只在 apply 时试一次 → 永不重试"）。
 */
const NAMESPACE_RETRY_DELAYS_MS = [1000, 3000, 8000, 20000, 40000] as const

/**
 * 装配 DeepSeek 多模态补丁。
 *
 * 触发面（三层，与 opencode-provider 同款）：
 *   ① apply 时立即试一次
 *   ② 命名空间尚未注册 → 退避重试（1s/3s/8s/20s/40s）
 *   ③ `settings/updated` → 再试（用户热改 settings.yaml 时自愈；自身写入触发的复评是幂等空转）
 *
 * 🔴 不设"一次性完成"闸门：③ 必须能持续生效（用户随时可能新增 deepseek 模型）。
 */
export function registerDeepseekVisionPatch(ctx: Context, enabled?: boolean): void {
  let settled = false
  let retryTimer: NodeJS.Timeout | null = null
  let retries = 0

  const clearRetry = (): void => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  const scheduleRetry = (): void => {
    if (retryTimer !== null || settled) return
    if (retries >= NAMESPACE_RETRY_DELAYS_MS.length) {
      console.warn(
        `[serenity-hooks] DeepSeek 多模态补丁放弃：重试 ${retries} 次仍等不到 ${LLM_PI_AI_NAMESPACE} 命名空间`
        + '（未使用 pi-ai 适配器时正常）',
      )
      settled = true
      return
    }
    const delay = NAMESPACE_RETRY_DELAYS_MS[retries] ?? 0
    retryTimer = setTimeout(() => {
      retryTimer = null
      retries += 1
      sync()
    }, delay)
    retryTimer.unref?.() // 不阻止进程退出
  }

  function sync(): void {
    void applyDeepseekVisionPatchOnce(ctx, enabled)
      .then((result) => {
        if (result.registered) {
          settled = true
          clearRetry()
        } else if (!settled) {
          scheduleRetry()
        }
      })
      .catch((error: unknown) => {
        // 双保险：applyDeepseekVisionPatchOnce 内部已 try/catch；这里只防未预期的同步抛错
        console.warn(`[serenity-hooks] DeepSeek 多模态补丁异常: ${String((error as Error)?.message ?? error)}`)
        settled = true
        clearRetry()
      })
  }

  // ③ settings 变化 → 复评（结构化订阅：通道缺失时不阻断；事件名在 HOST_EVENT_NAMES 白名单里编译期已钉）
  // ⚠️ v0.1.7：`settings/updated` → `settings/document-updated`（**两个位置参** `(ns, revision)`，只读 ns）
  try {
    const on = (ctx as unknown as { on?: (name: string, fn: (ns?: unknown, revision?: unknown) => void) => unknown }).on
    on?.call(ctx, 'settings/document-updated', (ns?: unknown) => {
      if (ns === LLM_PI_AI_NAMESPACE) sync()
    })
  } catch {
    /* 事件通道缺失不阻断（①② 仍覆盖首次配置） */
  }
  sync()
  // F-08 纪律：重试定时器随插件卸载/HMR 拆卸
  registerDisposer(ctx, 'deepseek vision patch retry timer', clearRetry)
}
