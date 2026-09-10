/**
 * host/access.ts — 宿主访问收口（S142 review F-06）
 *
 * 为什么存在：dsp 此前在 30+ 个文件里各自用 `(ctx as unknown as {…})` 断言读取宿主
 * 服务——契约表达分散、失败模式各异（多数静默 undefined）。本模块是**唯一**读取宿主
 * 的入口：所有 `ctx.get` / `ctx.<service>` 的形状断言集中在此，调用点只拿类型化结果。
 *
 * 约定：
 *  - 只读、无副作用；服务缺失一律返回 `undefined`（调用方决定降级策略），**不抛错**
 *    （宿主对插件 apply 抛错 = 整个 dsh 启动失败，访问层不能成为单点）。
 *  - 形状以 `AI_LAB/dsh-harness-public` @ 0.1.2-rc.1 为准；成员缺失由
 *    `host/contract.ts` 的探针在装载时与 `dashboard health` 中报告。
 *  - 迁移是渐进的：新代码必须走本模块；旧调用点逐轮收敛（F-06 轮次记录见 CHANGELOG）。
 */

/** 通用读取：`ctx.get(name)`（含异常吞掉——服务 getter 抛错视为不可用） */
export function hostService<T = unknown>(ctx: unknown, name: string): T | undefined {
  const c = ctx as { get?: (n: string) => unknown } | undefined
  if (typeof c?.get !== 'function') return undefined
  try {
    return c.get(name) as T | undefined
  } catch {
    return undefined
  }
}

/**
 * 直接属性读取（injected 服务：`ctx.<name>`），属性缺失**或读取抛错**时回落 `ctx.get`。
 *
 * v1.31.4 修复（R↓，实证 v1.31.3 真机首测）：cordis 的 Context 是 Proxy，
 * `ReflectService.handler.get`（`vendor/cordis/src/reflect.ts`）对**未经 `inject` 声明**
 * 的服务名会沿 fiber 链查找，找不到时**抛错**而非返回 undefined：
 *
 *   cannot get property "<name>" without inject
 *
 * 于是"先直接属性读、失败回落 ctx.get"的写法在**真实 cordis** 下永远走不到回落分支——
 * 异常直接逃逸（`hostService` 的 try/catch 被绕过）。v1.31.3 的 `hostSubagents`
 * 正是这样炸的：`subagents` 是 lazy 服务（不在插件 `inject` 列表内）。
 * 现有 fake ctx 单测（普通对象无 getter）复现不了 → 真 cordis 用例见
 * `tests/host/cordis-access.test.ts`。
 *
 * 为什么吞掉异常而不是让它冒泡：本模块的契约是"服务缺失一律返回 undefined，**不抛错**"
 * （宿主对插件 apply 抛错 = 整个 dsh 启动失败）。读取失败 = 服务不可用，等价于缺失。
 */
export function hostInjected<T = unknown>(ctx: unknown, name: string): T | undefined {
  const c = ctx as Record<string, unknown> | undefined
  try {
    const direct = c?.[name]
    if (direct !== undefined) return direct as T
  } catch {
    // cordis 代理对未声明 inject 的服务名抛错 → 回落 ctx.get（docstring：
    // "Read a service from the store without the inject requirement"）
  }
  return hostService<T>(ctx, name)
}

// ── 常用服务的类型化读取器（形状对照宿主 rc.1）──

export interface HostSessionLike {
  id?: string
  header?: { cwd?: string; id?: string }
  snapshotEvents?: () => unknown[]
}

export interface HostSessions {
  list?: () => HostSessionLike[]
  get?: (id: unknown) => HostSessionLike | undefined
  create?: (...args: unknown[]) => unknown
}

export interface HostAgents {
  create?: (...args: unknown[]) => unknown
  get?: (id: string) => unknown
  resume?: (...args: unknown[]) => unknown
}

export interface HostWebServer {
  register?: (registration: unknown) => unknown
  port?: number
}

export interface HostSettings {
  installSection?: (...args: unknown[]) => unknown
}

/** `ctx.web`（injected；v1.30.12：fetch provider 注册通道） */
export interface HostWeb {
  registerFetchProvider?: (provider: unknown) => unknown
  registerSearchProvider?: (provider: unknown) => unknown
}

/** `ctx.sessions`（injected） */
export function hostSessions(ctx: unknown): HostSessions | undefined {
  return hostInjected<HostSessions>(ctx, 'sessions')
}

/** `ctx.agents`（injected） */
export function hostAgents(ctx: unknown): HostAgents | undefined {
  return hostInjected<HostAgents>(ctx, 'agents')
}

/** `ctx.webServer`（injected） */
export function hostWebServer(ctx: unknown): HostWebServer | undefined {
  return hostInjected<HostWebServer>(ctx, 'webServer')
}

/** `ctx.settings`（injected；提供 settings 面板装配通道） */
export function hostSettings(ctx: unknown): HostSettings | undefined {
  return hostInjected<HostSettings>(ctx, 'settings')
}

/** `ctx.web`（injected；v1.30.12 web_fetch provider 注册通道） */
export function hostWeb(ctx: unknown): HostWeb | undefined {
  return hostInjected<HostWeb>(ctx, 'web')
}

/**
 * `ctx.subagents`（lazy；v1.31.3：handyman foreground 模式的委派正门）。
 *
 * 形状对照宿主 rc.1：`SubagentRuntime.start(name, request)` → `SubagentRun`
 * （`result` / `dispose` / `id`）。本模块只做形状收口；语义与错误处理归调用方。
 *
 * 注（v1.31.4）：本服务**不在** dsp 的 `inject` 列表内，因此走 `hostInjected` 的
 * 回落分支（`ctx.get`）——见 `hostInjected` 的 v1.31.4 说明与真实 cordis 用例。
 */
export interface HostSubagents {
  start?: (name: string, request: unknown) => Promise<unknown>
}

export function hostSubagents(ctx: unknown): HostSubagents | undefined {
  return hostInjected<HostSubagents>(ctx, 'subagents')
}

/** 会话 cwd 列表（live 会话；形状不符时返回空数组而非抛错） */
export function hostSessionCwds(ctx: unknown): string[] {
  try {
    const list = hostSessions(ctx)?.list?.()
    if (!Array.isArray(list)) return []
    return list.map((s) => s?.header?.cwd).filter((c): c is string => typeof c === 'string')
  } catch {
    return []
  }
}
