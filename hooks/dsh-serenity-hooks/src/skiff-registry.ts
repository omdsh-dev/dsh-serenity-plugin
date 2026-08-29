/**
 * skiff-registry.ts — Skiff 会话注册表（sessionId → {role, ccc}；零 DSH 依赖，可被任何 seams 安全 import）
 *
 * F4b 会话映射：Skiff agent 创建时注册（skiff-core），guards/seams 按 sessionId 查角色。
 * 独立成模块的原因：guards.ts 等拦截缝需要查角色而不引入 skiff-core 的运行时依赖
 * （skiff-core 依赖 @deepseek-ai/dsh-llm，测试/装配级联成本高）——注册表本身纯内存 Map。
 *
 * 值结构 v1.25.10 扩展：role（guards/seams 依赖，向后兼容）+ ccc（会话追问时
 * 角色/容器绑定校验——同 sessionId 复用必须同 (role, ccc)，防串角色污染）。
 *
 * 生命周期：进程内存态；连接/页面关闭时 unregister；进程重启自然清空（skiff 会话不复存在）。
 */

/** 注册表值：会话绑定的角色 + CCC 根（追问延续校验用） */
export interface SkiffSessionBinding {
  role: string
  ccc: string
}

const skiffSessions = new Map<string, SkiffSessionBinding>()

/** 查 sessionId 的 Skiff 角色名（无 → null）——向后兼容（guards/seams 依赖） */
export function skiffRoleFor(sessionId: string): string | null {
  return skiffSessions.get(sessionId)?.role ?? null
}

/** 查 sessionId 的完整绑定（role + ccc；无 → null）——v1.25.10 会话追问校验 */
export function skiffSessionInfo(sessionId: string): SkiffSessionBinding | null {
  return skiffSessions.get(sessionId) ?? null
}

export function registerSkiffSession(sessionId: string, role: string, ccc: string): void {
  skiffSessions.set(sessionId, { role, ccc })
}

export function unregisterSkiffSession(sessionId: string): void {
  skiffSessions.delete(sessionId)
}

/** 测试/调试：注册表快照（sessionId → {role, ccc}） */
export function skiffSessionSnapshot(): ReadonlyMap<string, SkiffSessionBinding> {
  return new Map(skiffSessions)
}
