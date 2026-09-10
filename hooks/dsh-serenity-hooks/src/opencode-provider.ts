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
export const OPENCODE_ROUTE_IDS: readonly string[] = ['opencode', 'opencode-go']

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

export interface OpencodeAutoConfigInput {
  /** `llm-pi-ai` 命名空间**解析后**的值（`settings.get` 结果；undefined = 命名空间未注册） */
  resolved: unknown
  /** 进程环境（注入以便测试） */
  env: Readonly<Record<string, string | undefined>>
}

/** 一条动作记录（日志 + 测试断言共用；不返回"秘密"、只返回做了什么） */
export type OpencodeAutoConfigAction =
  | { kind: 'fill-headers'; route: string; keys: readonly string[] }
  | { kind: 'create-route'; route: string }
  | { kind: 'skip-route'; route: string; reason: 'headers-complete' }
  | { kind: 'idle'; reason: 'namespace-unregistered' | 'no-route' }

export interface OpencodeAutoConfigPlan {
  /** 传给 `settings.update` 的补丁；空对象 = 无事可做（**不写**，避免无谓触发 settings/updated） */
  patch: Record<string, unknown>
  actions: readonly OpencodeAutoConfigAction[]
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
    if (keys.length === 0) {
      actions.push({ kind: 'skip-route', route, reason: 'headers-complete' })
      continue
    }
    patchProviders[route] = { headers: missing }
    actions.push({ kind: 'fill-headers', route, keys })
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
  get?: (ns: string) => unknown
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
  if (settings?.get === undefined || settings.update === undefined) {
    console.warn('[serenity-hooks] opencode 路由自动配置跳过：settings 服务不可用（未能读取/写入 llm-pi-ai 命名空间）')
    return { wrote: false, registered: false }
  }
  let resolved: unknown
  try {
    resolved = settings.get.call(settings, LLM_PI_AI_NAMESPACE)
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
    retryTimer.unref?.() // 不阻止进程退出（与 skiff/autopilot 同款）
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

  // ③ settings 变化 → 复评（事件名非宿主类型化 Events 成员，故结构化订阅并容错）
  try {
    const on = (ctx as unknown as { on?: (name: string, fn: (ns?: unknown) => void) => unknown }).on
    on?.call(ctx, 'settings/updated', (ns?: unknown) => {
      if (ns === LLM_PI_AI_NAMESPACE) sync()
    })
  } catch {
    /* 事件通道缺失不阻断（①② 仍覆盖首次配置） */
  }
  sync()
  // F-08 纪律：重试定时器随插件卸载/HMR 拆卸
  registerDisposer(ctx, 'opencode provider auto-config retry timer', clearRetry)
}
