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

/** 直接属性读取（injected 服务：`ctx.<name>`），属性缺失时回落 `ctx.get` */
export function hostInjected<T = unknown>(ctx: unknown, name: string): T | undefined {
  const c = ctx as Record<string, unknown> | undefined
  const direct = c?.[name]
  if (direct !== undefined) return direct as T
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
