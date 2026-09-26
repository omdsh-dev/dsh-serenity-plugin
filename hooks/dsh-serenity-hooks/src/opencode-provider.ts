/**
 * opencode-provider.ts — opencode zen / go 路由的自动配置（v1.31.7，S142 用户需求）
 *
 * ## 为什么存在（R↓）
 *
 * opencode 的 zen / go 面按**请求头**做会话亲和路由：缺 `x-opencode-session` 时
 * `/zen/go` 直接 400 `Request is missing x-opencode-session and cannot be routed efficiently`。
 * 而 DSH 用的 **pi-ai 库本身不发这些头**（`@earendil-works/pi-ai@0.85.1` 全库 `x-opencode` 零命中；
 * pi 的 CLI 是**应用层**自己在 `packages/coding-agent/src/core/sdk.ts` 加的）。
 * → 用户要在 DSH 里用 opencode，除了配路由还得手抄一串头。本模块把这步自动化。
 *
 * ## 两层（S142 用户 2026-09-10 拍板：两层默认都开）
 *
 * - **L1 补头**：路由已存在（路由名 ∈ opencode/opencode-go，或 baseURL 命中 opencode.ai）且缺头
 *   → 只补**缺失的键**。已存在的键（用户手写的）**一律不覆盖**——头名按 HTTP 语义**大小写不敏感**比较。
 * - **L2 建路由**：环境里有 `OPENCODE_API_KEY` 且没有任何 opencode 路由 → 建 `opencode-go` 并带全头。
 *   “有 key”就是用户意图的最强证据 → 不需要的人（没 key）零影响（不会平白多出一组模型）。
 *
 * ## L3 补模型（v1.48.0；S142 owner 具名令「做成自动吧」）
 *
 * pi-ai 目录**收录不全**（如 `deepseek-v4.1-flash` 已在官方端点表、目录里却没有）⇒
 * 面板不显示；手加也不带推理（目录外模型 `base` 为 undefined ⇒ `reasoning` 恒 false，
 * 见 {@link OPENCODE_EXTRA_MODELS} 的注释）⇒ **"能用但没 thinking"**。
 * 本层把 {@link OPENCODE_EXTRA_MODELS} 里的模型补进该路由的 `models` 列表。
 *
 * 🔴 **三条拒绝条件**（每条都对应一个会把配置弄坏的真实形态，宁可不动）：
 *   ① 路由**没有显式 `models` 列表** —— 补 `models` 会顶掉整个 pi-ai 目录（宿主是"整体替换"语义）
 *   ② 列表里含**已知异协议**模型 —— 设路由级 `api` 会覆盖它们的 `base.api`
 *   ③ 路由已显式设了**别的 `api`** —— 同上，且那是用户的显式选择
 * 判据与来源见 `planExtraModels` / `OPENCODE_GO_NON_COMPLETIONS`。
 *
 * ## 注入通道（唯一可用且是官方的）
 *
 * `ctx.settings.update('llm-pi-ai', patch)` —— `dsh-settings` 的官方写入面：
 *   ① 深合并（`mergeLayers` 逐层递归，数组整体替换）→ 不会冲掉用户别的路由
 *   ② **先校验后落盘**（pi-ai 注册时给的 `validate`）→ 坏补丁拒绝且不持久化
 *   ③ `dsh-settings-file` 的 `writable` 恒 true → 写入用户 settings 文档（0600，用户可读可删）
 *
 * 被否掉的备选：① 本插件 `cordis.patch.yml` 直接改 `llm-pi-ai` 的 config —— 宿主 patch 语义是
 * **整体替换 config（非深合并）**，会冲掉部署方在该条目上配的其它 provider；且无法按条件启用。
 * ② 让用户手抄 —— 本次要消灭的正是这一步。
 *
 * ## 只注入"会话族"，**不注入身份族**（诚实边界，用户选了付费 /zen/go）
 *
 * - 注入：`x-opencode-session` / `X-Session-ID`（同一个稳定的本机安装标识）、
 *   `x-opencode-client: dsh`、`x-opencode-project: global`
 *   （证据：Trae 的 Go 面代理注入的正是这一族，且该项目 README 明列 "dsh 亲测有效"）
 * - **不注入** `X-Title: opencode` / `HTTP-Referer: https://opencode.ai/` —— 那是**冒充 OpenCode 客户端**，
 *   只在免费档的**滥用判别**中起作用（hermes #106495 实证）。冒充他人客户端去绕限额不是本插件该做的事。
 * - **不注入** `User-Agent` —— 它是 `@deepseek-ai/dsh-llm` 的 attribution 保留名
 *   （`APP_IDENTITY` 无配置缝），宿主层面就不可覆盖。
 * - **不注入** `x-opencode-request` —— 它的语义是"会话内递增"（`msg_1`/`msg_2`…），
 *   本模块只能给**静态**值，写个假的递增 id 比不写更糟。
 *
 * ## 已知局限（必须显式，不粉饰）
 *
 * DSH 的 provider `headers` 在路由解析时**一次性求值**（无 per-request 模板缝；pi-ai 支持
 * `transformHeaders` 但 DSH 适配器未用）→ 会话标识只能是**静态**的。代价 = 跨会话共用同一亲和键：
 * 对提示词缓存是利好（同机器请求恒定落同一上游 provider），对"按会话分区"是语义偏差。
 * pi issue #4847 的报告者也点出该 workaround 的固有缺陷（"bound to the installation"）。
 */

import type { Context } from 'cordis'
import { hostSettings } from './host/access.js'
import { registerDisposer } from './host/effect.js'

/** `llm-pi-ai` 的 settings 命名空间（宿主 `dsh-llm-pi-ai` 的 `NS`） */
export const LLM_PI_AI_NAMESPACE = 'llm-pi-ai'

/**
 * 本机安装的会话标识（静态；见文件头"已知局限"）。
 *
 * 为什么用常量而不是随机/uuid：`headers` 只在路由解析时求值一次，随机值等于每次进程启动换一个
 * 亲和键（缓存永远不命中），反而劣化。常量让"同一安装 → 同一亲和键"成立。
 */
export const OPENCODE_SESSION_ID = 'dsh-serenity'

/** 视为 opencode 路由的路由名（pi-ai 目录里的两个 id） */
const OPENCODE_ROUTE_IDS: readonly string[] = ['opencode', 'opencode-go']

/** 自动配置时创建的路由名（pi-ai 目录的 Go 面；用户选的是付费 `/zen/go`） */
export const OPENCODE_ROUTE_TO_CREATE = 'opencode-go'

/** 触发 L2 建路由的环境变量名（与 pi-ai 目录 provider 的 `envApiKeyAuth` 声明一致） */
export const OPENCODE_API_KEY_ENV = 'OPENCODE_API_KEY'

/**
 * 注入的头（"会话族"）——每次调用返回新对象（调用方会放进 patch，共享可变对象是坑）。
 *
 * 注：同一个值同时给 `x-opencode-session`（pi 与第三方代理用的名字）与 `X-Session-ID`
 * （OpenCode 自家客户端用的名字）——两处证据各自出现，都发才不会漏。
 * 头名大小写不敏感是 HTTP 语义，但**名字不同就是两个头**，故都要。
 */
export function opencodeRouteHeaders(): Record<string, string> {
  return {
    'x-opencode-session': OPENCODE_SESSION_ID,
    'X-Session-ID': OPENCODE_SESSION_ID,
    'x-opencode-client': 'dsh',
    'x-opencode-project': 'global',
  }
}

/**
 * 一个「pi-ai 目录尚未收录、但我们已知怎么配」的 opencode-go 模型。
 *
 * 🔴 **为什么必须有 `reasoningEfforts`**：`dsh-llm-pi-ai` 的 `resolveModelReasoning` 是
 * `if (efforts === void 0) return { reasoning: base?.reasoning ?? false }` ——
 * **目录里没有的模型 `base` 为 undefined ⇒ 一律判成非推理模型**（"能用但没 thinking"的唯一成因）。
 * 已收录的兄弟模型（如 `deepseek-v4-flash`）从目录的 `base` 拿到 `reasoning`/`thinkingLevelMap`，
 * 故本表**只需收录目录没有的那些**。
 */
export interface OpencodeExtraModel {
  readonly name: string
  /** 该模型说的 wire 协议；见 {@link OPENCODE_GO_NON_COMPLETIONS} 的安全闸 */
  readonly api: string
  /**
   * 该模型的端点基址 —— 🔴 **目录外模型的必需品**（v1.48.1 补）。
   *
   * 宿主 `resolveRouteModels` 的兜底链是 `request.baseURL ?? base?.baseUrl ?? providerBaseUrl`；
   * 目录里没有它 ⇒ `base` 为 undefined，而 pi-ai 的 `opencodeGoProvider()` **也没有 provider 级
   * baseUrl** ⇒ 三级全空 ⇒ 宿主**严格写入直接把整条补丁拒掉**（v1.48.0 真机实测原文：
   * `model "deepseek-v4.1-flash" needs a baseURL; the installed catalog does not describe this route`）。
   * 故本字段是**唯一可控的那一环**：路由自身没写 `baseURL` 时，必须由我们补上。
   */
  readonly baseUrl: string
  readonly contextWindow: number
  readonly maxTokens: number
  readonly input: readonly string[]
  /** pi-ai 推理档 → wire 取值（除 `off` 外都必须非空；空值会被宿主 `invalid` 拒绝） */
  readonly reasoningEfforts: Readonly<Record<string, string>>
  /** 该模型族的 compat（推理 wire 格式在这里；值取自目录里同族兄弟模型） */
  readonly compat: Readonly<Record<string, unknown>>
}

/**
 * 目录补丁表（**唯一真相源 = pi-ai 的 `dist/providers/data/opencode-go.json`**）。
 *
 * 录取判据：① 官方文档 <https://opencode.ai/docs/zh-cn/go/> 的端点表列了它；
 * ② pi-ai 目录里**没有**它 ⇒ 面板不显示、手加也没 thinking。
 *
 * `deepseek-v4.1-flash` 的各字段**逐字取自目录里 `deepseek-v4-flash`**（同族兄弟，
 * 同 `chat/completions` 端点 + 同 `thinkingFormat: deepseek`）——不自行发明规格。
 */
export const OPENCODE_EXTRA_MODELS: Readonly<Record<string, OpencodeExtraModel>> = {
  'deepseek-v4.1-flash': {
    name: 'DeepSeek V4.1 Flash',
    api: 'openai-completions',
    // 逐字取自目录里 deepseek-v4-flash 的 baseUrl（同族兄弟、同端点）——不自行发明
    baseUrl: 'https://opencode.ai/zen/go/v1',
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    input: ['text'],
    reasoningEfforts: { low: 'low', high: 'high', max: 'max' },
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: 'max_tokens',
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: 'deepseek',
    },
  },
}

/**
 * opencode-go 上**已知不说 `openai-completions`** 的模型 id（安全闸）。
 *
 * 为什么需要它：给路由设 `api` 会**覆盖该路由每个条目的 `base.api`**
 * （`resolveRouteModels` 的 `request.api ?? base?.api ?? routeApi`）⇒
 * 若用户的 models 列表里混着异协议模型，设 `api` 会把它们**配坏**。
 * 故：列表里只要出现下表中的任一 id，本模块**放弃补模型**（响亮说明原因，不硬来）。
 *
 * 来源 = 官方文档端点表（`@ai-sdk/anthropic` 与 `@ai-sdk/openai`（Responses）两族）。
 */
const OPENCODE_GO_NON_COMPLETIONS: ReadonlySet<string> = new Set([
  // @ai-sdk/anthropic → /zen/go/v1/messages
  'minimax-m3',
  'minimax-m2.7',
  'minimax-m2.5',
  'qwen3.8-max',
  'qwen3.8-flash',
  'qwen3.7-max',
  'qwen3.7-plus',
  'qwen3.6-plus',
  // @ai-sdk/openai → /zen/go/v1/responses
  'grok-4.7',
  'grok-4.6',
  'gpt-6-luna',
  'gpt-5.6-luna',
  'muse-spark-1.3-contributor',
  'muse-spark-1.2-contributor',
])

interface OpencodeAutoConfigInput {
  /** `llm-pi-ai` 命名空间**解析后**的值（0.1.7 读面 `settings.describe()` 里按 `ns` 挑出的 `value`；undefined = 命名空间未注册） */
  resolved: unknown
  /** 进程环境（注入以便测试） */
  env: Readonly<Record<string, string | undefined>>
}

/** 一条动作记录（日志 + 测试断言共用；不返回"秘密"、只返回做了什么） */
type OpencodeAutoConfigAction =
  | { kind: 'fill-headers'; route: string; keys: readonly string[] }
  | { kind: 'create-route'; route: string }
  | { kind: 'skip-route'; route: string; reason: 'headers-complete' }
  | { kind: 'add-models'; route: string; ids: readonly string[]; api: string | null }
  | { kind: 'enrich-models'; route: string; ids: readonly string[] }
  | { kind: 'skip-models'; route: string; reason: 'catalog-served' | 'mixed-protocol' | 'api-conflict' | 'api-missing' }
  | { kind: 'idle'; reason: 'namespace-unregistered' | 'no-route' }

interface OpencodeAutoConfigPlan {
  /** 传给 `settings.update` 的补丁；空对象 = 无事可做（**不写**，避免无谓触发 settings/updated） */
  patch: Record<string, unknown>
  actions: readonly OpencodeAutoConfigAction[]
}

/** 路由的 models 列表里"补"了什么（**追加**目录外模型 ／ 给**已列出**的补规格） */
interface ExtraModelsPlan {
  /** 改写后的**完整** models 数组（未改动的条目**逐字保留**）；undefined = 不改这一项 */
  models?: readonly unknown[]
  /** 需要同时设的路由级 `api`（缺省不出现在补丁里） */
  api?: string
  /** 需要同时设的路由级 `baseURL`（缺省不出现在补丁里；路由自己写过就不动它） */
  baseUrl?: string
  /** 追加进去的模型 id */
  addedIds: readonly string[]
  /** 就地补齐了规格的模型 id（已列出但缺 `reasoningEfforts`） */
  enrichedIds: readonly string[]
  /** 为何没补（`addedIds`／`enrichedIds` 皆空时才有意义） */
  skip?: 'catalog-served' | 'mixed-protocol' | 'api-conflict' | 'api-missing'
}

/**
 * 把 {@link OPENCODE_EXTRA_MODELS} 落到一个**已有显式 `models` 列表**的路由上（**纯函数**）。
 *
 * 两种落法（v1.48.1 起）：
 *   · **追加**（模型不在表里）—— 目录里没有它，连条目都得我们造。
 *   · **补规格**（模型已在表里、但缺 `reasoningEfforts`）—— 🔴 **这是"手加过"的形态**：
 *     用户把模型抄进列表了，可没抄推理档 ⇒ 宿主 `resolveModelReasoning` 走 `base?.reasoning ?? false`
 *     ⇒ **能用但永远不出 thinking**。只补"缺失的模型"是补不到这一形态的。
 *
 * 拒绝条件（每条都对应一个会让配置变坏的真实形态；宁可不动也不硬来）：
 *   ① **没有显式 `models` 列表**（含空表）⇒ 该路由此刻服务的是 pi-ai 目录本体；
 *      一旦我们写出 `models`，**整个目录会被顶掉**（宿主的 `models` 是"整体替换"语义）。
 *   ② **列表里出现已知异协议模型** ⇒ 设路由级 `api` 会覆盖它们的 `base.api`，把它们配坏。
 *   ③ **路由已显式设了别的 `api`** ⇒ 同上，且那是用户的显式选择，不覆盖。
 *   ④ **要补规格却判不出协议**（路由没写 `api`，又不追加任何模型）⇒ 无法保证 compat 合法。
 */
function planExtraModels(profile: Record<string, unknown>): ExtraModelsPlan {
  const raw = profile.models
  if (!Array.isArray(raw) || raw.length === 0) {
    return { addedIds: [], enrichedIds: [], skip: 'catalog-served' }
  }

  const byId = new Map<string, Record<string, unknown>>()
  for (const entry of raw) {
    if (isPlainObject(entry) && typeof entry.id === 'string') byId.set(entry.id, entry)
  }
  // ②：已知异协议模型在场 ⇒ 任何路由级 api/baseURL 都别写
  for (const id of byId.keys()) {
    if (OPENCODE_GO_NON_COMPLETIONS.has(id)) return { addedIds: [], enrichedIds: [], skip: 'mixed-protocol' }
  }

  const missing = Object.entries(OPENCODE_EXTRA_MODELS).filter(([id]) => !byId.has(id))
  const existingApi = typeof profile.api === 'string' && profile.api !== '' ? profile.api : undefined

  // 路由级 api：待补模型的协议必须一致（路由级 api 只能有一个值）
  let pendingApi: string | undefined
  if (missing.length > 0) {
    const apis = new Set(missing.map(([, model]) => model.api))
    if (apis.size !== 1) return { addedIds: [], enrichedIds: [], skip: 'mixed-protocol' }
    pendingApi = [...apis][0] as string
  }
  if (existingApi !== undefined && pendingApi !== undefined && existingApi !== pendingApi) {
    return { addedIds: [], enrichedIds: [], skip: 'api-conflict' }
  }
  /** 写完之后该路由的**有效协议**（第三方条目也会按它解析） */
  const effectiveApi = existingApi ?? pendingApi

  // 已列出、但缺推理档的那些 ⇒ 就地补规格
  const toEnrich: Array<[string, OpencodeExtraModel, Record<string, unknown>]> = []
  for (const [id, model] of Object.entries(OPENCODE_EXTRA_MODELS)) {
    const entry = byId.get(id)
    if (entry === undefined) continue
    if (entry.reasoningEfforts !== undefined) continue // 用户写过就别碰（含显式 `false`）
    if (effectiveApi === undefined) return { addedIds: [], enrichedIds: [], skip: 'api-missing' }
    if (effectiveApi !== model.api) return { addedIds: [], enrichedIds: [], skip: 'api-conflict' }
    toEnrich.push([id, model, entry])
  }

  if (missing.length === 0 && toEnrich.length === 0) return { addedIds: [], enrichedIds: [] }

  // 路由自己写过 baseURL ⇒ 兜底链已成立，**不动它**（用户的端点就是用户的端点）；
  // 没写过 ⇒ 必须由我们给出，否则宿主严格写入会以 `needs a baseURL` 拒掉整条补丁（v1.48.0 事故）。
  let baseUrl: string | undefined
  if (!(typeof profile.baseURL === 'string' && profile.baseURL !== '')) {
    const want = new Set([...missing.map(([, m]) => m), ...toEnrich.map(([, m]) => m)].map((m) => m.baseUrl))
    if (want.size !== 1) return { addedIds: [], enrichedIds: [], skip: 'mixed-protocol' }
    baseUrl = [...want][0]
  }

  const enrichById = new Map(toEnrich.map(([id, model]) => [id, model]))
  const models: unknown[] = raw.map((entry) => {
    if (!isPlainObject(entry) || typeof entry.id !== 'string') return entry
    const model = enrichById.get(entry.id)
    if (model === undefined) return entry
    return {
      // 原条目**逐字保留**，只补上缺的那两项 —— 用户字段一个都不许丢、更不许改
      ...entry,
      reasoningEfforts: { ...model.reasoningEfforts },
      // compat 合并：我们的规格在前、**用户已写的键优先**（绝不覆盖用户的选择）
      compat: { ...model.compat, ...(isPlainObject(entry.compat) ? entry.compat : {}) },
    }
  })
  for (const [id, model] of missing) {
    models.push({
      id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      input: [...model.input],
      reasoningEfforts: { ...model.reasoningEfforts },
      compat: { ...model.compat },
    })
  }

  return {
    models,
    // 已显式设过同值 api 时不重复写（避免无谓的 settings/updated）
    ...(pendingApi !== undefined && existingApi === undefined ? { api: pendingApi } : {}),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    addedIds: missing.map(([id]) => id),
    enrichedIds: toEnrich.map(([id]) => id),
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 该路由是否指向 opencode（按路由名，或按 baseURL 主机名——用户可能把路由改名） */
export function isOpencodeRoute(route: string, profile: Record<string, unknown>): boolean {
  if (OPENCODE_ROUTE_IDS.includes(route)) return true
  const baseURL = profile.baseURL
  if (typeof baseURL !== 'string' || baseURL === '') return false
  try {
    const host = new URL(baseURL).hostname.toLowerCase()
    return host === 'opencode.ai' || host.endsWith('.opencode.ai')
  } catch {
    return false
  }
}

/** HTTP 头名按大小写不敏感查找（HTTP 字段名语义；用户写 `x-title` 与 `X-Title` 等价） */
function hasHeaderCaseInsensitive(headers: Record<string, unknown>, name: string): boolean {
  return headerValue(headers, name) !== undefined
}

/** 按大小写不敏感取头值（取不到 → undefined） */
function headerValue(headers: Record<string, unknown>, name: string): string | undefined {
  const want = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want && typeof v === 'string') return v
  }
  return undefined
}

/**
 * 会话标识的两个头名是**同一逻辑值**的两个别名（两处独立证据各用一个：
 * Go 面 400 点名 `x-opencode-session`，OpenCode 自家客户端用 `X-Session-ID`）。
 *
 * 因此判定顺序是"先定值、再补名"：用户任写其一 → 用**他的值**补齐另一个；
 * 两个都没写 → 用本插件常量。**绝不出现两个互相矛盾的 id**（那会让上游按哪个路由都说不清）。
 */
function sessionIdentityValue(headers: Record<string, unknown>): string {
  return headerValue(headers, 'x-opencode-session')
    ?? headerValue(headers, 'X-Session-ID')
    ?? OPENCODE_SESSION_ID
}

/**
 * 计算自动配置计划（**纯函数**：不读文件、不碰 ctx——便于穷举测试）。
 *
 * 判据顺序（R↓）：
 *   ① 命名空间未注册（`resolved === undefined`）→ idle，调用方负责重试（llm-pi-ai 可能后装载）
 *   ② 逐个已有 opencode 路由：只补缺失的键（用户的显式值一律不动）
 *   ③ 一个 opencode 路由都没有 + 环境有 `OPENCODE_API_KEY` → 建路由（带全头）
 *   ④ 其余 → idle `no-route`（含"没有 key 就不建路由"——不给不用 opencode 的人平白加模型）
 */
export function planOpencodeAutoConfig(input: OpencodeAutoConfigInput): OpencodeAutoConfigPlan {
  const actions: OpencodeAutoConfigAction[] = []
  if (input.resolved === undefined) {
    return { patch: {}, actions: [{ kind: 'idle', reason: 'namespace-unregistered' }] }
  }
  const providers = isPlainObject(input.resolved) && isPlainObject(input.resolved.providers)
    ? input.resolved.providers
    : {}
  const patchProviders: Record<string, unknown> = {}
  let sawOpencodeRoute = false

  for (const [route, rawProfile] of Object.entries(providers)) {
    const profile = isPlainObject(rawProfile) ? rawProfile : {}
    if (!isOpencodeRoute(route, profile)) continue
    sawOpencodeRoute = true
    const existing = isPlainObject(profile.headers) ? profile.headers : {}
    const sessionId = sessionIdentityValue(existing)
    const wanted: Record<string, string> = { ...opencodeRouteHeaders(), 'x-opencode-session': sessionId, 'X-Session-ID': sessionId }
    const missing: Record<string, string> = {}
    for (const [name, value] of Object.entries(wanted)) {
      if (!hasHeaderCaseInsensitive(existing, name)) missing[name] = value
    }
    const keys = Object.keys(missing)
    const extra = planExtraModels(profile)
    // `catalog-served`（没有 models 列表）是**常态**，不出声；只有"有列表却拒绝"才值得说明
    if (extra.skip !== undefined && extra.skip !== 'catalog-served') {
      actions.push({ kind: 'skip-models', route, reason: extra.skip })
    } else {
      if (extra.addedIds.length > 0) actions.push({ kind: 'add-models', route, ids: extra.addedIds, api: extra.api ?? null })
      if (extra.enrichedIds.length > 0) actions.push({ kind: 'enrich-models', route, ids: extra.enrichedIds })
    }
    const routePatch: Record<string, unknown> = {}
    if (keys.length > 0) routePatch.headers = missing
    if (extra.models !== undefined) routePatch.models = extra.models
    if (extra.api !== undefined) routePatch.api = extra.api
    if (extra.baseUrl !== undefined) routePatch.baseURL = extra.baseUrl
    if (keys.length === 0 && Object.keys(routePatch).length === 0) {
      actions.push({ kind: 'skip-route', route, reason: 'headers-complete' })
      continue
    }
    if (keys.length > 0) actions.push({ kind: 'fill-headers', route, keys })
    patchProviders[route] = routePatch
  }

  if (!sawOpencodeRoute) {
    const key = input.env[OPENCODE_API_KEY_ENV]
    if (typeof key !== 'string' || key === '') {
      actions.push({ kind: 'idle', reason: 'no-route' })
    } else {
      // 不写 apiKeyEnv：pi-ai 的目录 provider 自带 `envApiKeyAuth(['OPENCODE_API_KEY'])` 环境发现，
      // 显式再声明一次反而多一层（且我们无法验证宿主凭据缝是否按 env 解析）。
      patchProviders[OPENCODE_ROUTE_TO_CREATE] = { headers: opencodeRouteHeaders() }
      actions.push({ kind: 'create-route', route: OPENCODE_ROUTE_TO_CREATE })
    }
  }

  // 每个分支都已推入恰好一条动作（路由循环里的 fill/skip，或末段的 no-route/create-route），
  // 故不存在"动作列表为空"的收尾分支——曾有的 `nothing-to-do` 兜底是死代码（v1.31.7 删除）。
  return { patch: Object.keys(patchProviders).length > 0 ? { providers: patchProviders } : {}, actions }
}

/** 最小 settings 面（结构化读取；零宿主 import 策略——`dsh-settings` 不在 peerDeps 的必要面里） */
interface SettingsLike {
  /** 🔴 0.1.7 的读面（取代 `get`）：`SettingsForms.describe()` 按**条目 id** 给出表单，
   *  其 `value` = 该条目已解析的配置。⚠️ 它有**副作用**：修订号变化时会 emit
   *  `settings/document-updated` ⇒ 本函数被该事件再触发时，第二次 `describe` 的 raw 不变
   *  ⇒ 不会再 emit（**收敛，不成环**），但改这里时必须把这条交互记在案。 */
  describe?: (options?: { redactSecrets?: boolean }) => readonly { ns?: string; value?: unknown }[] | undefined
  update?: (ns: string, patch: object) => Promise<void>
}

/** 动作 → 单行人读日志（无秘密） */
export function describeOpencodeAction(action: OpencodeAutoConfigAction): string {
  switch (action.kind) {
    case 'fill-headers':
      return `补齐 ${action.route} 的路由头（${action.keys.length} 项：${action.keys.join(', ')}）`
    case 'create-route':
      return `创建 ${action.route} 路由（检测到 ${OPENCODE_API_KEY_ENV}）+ 路由头`
    case 'skip-route':
      return `${action.route} 路由头已齐备（跳过）`
    case 'add-models':
      return `为 ${action.route} 补目录未收录的模型：${action.ids.join(', ')}`
        + (action.api === null ? '' : `（并设路由 api=${action.api}）`)
    case 'enrich-models':
      return `为 ${action.route} 已列出的模型补推理档：${action.ids.join(', ')}`
        + '（此前「能用但没 thinking」）'
    case 'skip-models':
      return `${action.route} 未补模型（${
        action.reason === 'catalog-served'
          ? '该路由未声明 models 列表，补 models 会顶掉整个目录'
          : action.reason === 'mixed-protocol'
            ? '该路由含异协议模型，设路由 api 会把它们配坏'
            : action.reason === 'api-missing'
              ? '该模型已列出但缺推理档，而路由没写 api ⇒ 判不出该用哪套 compat'
              : '该路由的 api 与本表规格不一致'
      }）`
    case 'idle':
      return `无需动作（${action.reason}）`
  }
}

/**
 * 执行一次自动配置。返回是否**写入了**（调用方据此决定是否停止重试）。
 *
 * 失败语义（F-08/F-07 纪律）：**任何失败都不抛给宿主**——apply 抛错 = 整个 dsh 启动失败。
 * 一律 try/catch + 响亮告警（用户能看到"没生效 + 为什么"），最坏情况退回"用户手抄头"。
 */
export async function applyOpencodeAutoConfigOnce(ctx: Context, env?: Readonly<Record<string, string | undefined>>): Promise<{ wrote: boolean; registered: boolean }> {
  const settings = hostSettings(ctx) as SettingsLike | undefined
  if (settings?.describe === undefined || settings.update === undefined) {
    console.warn('[serenity-hooks] opencode 路由自动配置跳过：settings 服务不可用（未能读取/写入 llm-pi-ai 命名空间）')
    return { wrote: false, registered: false }
  }
  let resolved: unknown
  try {
    const forms = settings.describe.call(settings) ?? []
    resolved = forms.find((f) => f.ns === LLM_PI_AI_NAMESPACE)?.value
  } catch (error) {
    console.warn(`[serenity-hooks] opencode 路由自动配置跳过：读取 ${LLM_PI_AI_NAMESPACE} 失败: ${String((error as Error)?.message ?? error)}`)
    return { wrote: false, registered: false }
  }
  const plan = planOpencodeAutoConfig({ resolved, env: env ?? process.env })
  if (Object.keys(plan.patch).length === 0) {
    return { wrote: false, registered: resolved !== undefined }
  }
  try {
    await settings.update.call(settings, LLM_PI_AI_NAMESPACE, plan.patch)
  } catch (error) {
    // 写失败不重试：settings.update 会先校验后落盘，被拒通常意味着该路由在当前宿主不可服务
    // （响亮告警 + 指引手抄，比"悄悄重试 N 次"更有用）
    console.warn(
      `[serenity-hooks] ✗ opencode 路由自动配置写入被拒: ${String((error as Error)?.message ?? error)}`
      + `（可手动写入 llm-pi-ai.providers.<route>.headers；见本插件 README）`,
    )
    return { wrote: false, registered: true }
  }
  for (const action of plan.actions) {
    if (action.kind === 'idle' || action.kind === 'skip-route') continue
    // 未补模型是"说明"不是"成果" ⇒ 用不同标记，避免和 ✓ 混在一起看
    if (action.kind === 'skip-models') {
      console.log(`[serenity-hooks] · opencode 路由：${describeOpencodeAction(action)}`)
      continue
    }
    console.log(`[serenity-hooks] ✓ opencode 路由：${describeOpencodeAction(action)}`)
  }
  return { wrote: true, registered: true }
}

/**
 * 命名空间注册重试间隔（毫秒；累计 ~72s）。
 *
 * 为什么要重试：`llm-pi-ai` 只在**它自己的** `ctx.inject(['settings'])` 回调里注册命名空间，
 * 与本插件 apply **无先后保证**（两者都依赖 settings 服务）。首次读取拿到 undefined 是常态而非错误
 * （与 skiff 的 CCC root 重试同款问题、同款处置：v1.30.13 实证"只在 apply 时试一次 → 永不重试"）。
 */
const NAMESPACE_RETRY_DELAYS_MS = [1000, 3000, 8000, 20000, 40000] as const

/**
 * 装配 opencode 路由自动配置。
 *
 * 触发面（三层，与 skiff 同款；R↓：单点触发在同装载竞态下必然漏）：
 *   ① apply 时立即试一次
 *   ② 命名空间尚未注册 → 退避重试（1s/3s/8s/20s/40s）
 *   ③ `settings/updated` → 再试（用户热改 settings.yaml 加路由时自愈；自身写入触发的复评是幂等空转）
 *
 * 不设"一次性完成"闸门：③ 必须能在之后继续生效（用户随时可能新增 opencode 路由）。
 */
export function registerOpencodeAutoConfig(ctx: Context): void {
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
        `[serenity-hooks] opencode 路由自动配置放弃：重试 ${retries} 次仍等不到 ${LLM_PI_AI_NAMESPACE} 命名空间`
        + '（未使用 pi-ai 适配器时正常；若要手配见 README）',
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
    retryTimer.unref?.() // 不阻止进程退出（与 skiff 同款）
  }

  function sync(): void {
    void applyOpencodeAutoConfigOnce(ctx)
      .then((result) => {
        if (result.registered) {
          settled = true
          clearRetry()
        } else if (!settled) {
          scheduleRetry()
        }
      })
      .catch((error: unknown) => {
        // 双保险：applyOpencodeAutoConfigOnce 内部已 try/catch；这里只防未预期的同步抛错
        console.warn(`[serenity-hooks] opencode 路由自动配置异常: ${String((error as Error)?.message ?? error)}`)
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
  registerDisposer(ctx, 'opencode provider auto-config retry timer', clearRetry)
}
