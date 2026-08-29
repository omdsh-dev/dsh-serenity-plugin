/**
 * skiff-registry.ts — Skiff 会话注册表（sessionId → role；零 DSH 依赖，可被任何 seams 安全 import）
 *
 * F4b 会话映射：Skiff agent 创建时注册（skiff-core），guards/seams 按 sessionId 查角色。
 * 独立成模块的原因：guards.ts 等拦截缝需要查角色而不引入 skiff-core 的运行时依赖
 * （skiff-core 依赖 @deepseek-ai/dsh-llm，测试/装配级联成本高）——注册表本身纯内存 Map。
 *
 * 生命周期：进程内存态；连接/页面关闭时 unregister；进程重启自然清空（skiff 会话不复存在）。
 */

const skiffSessions = new Map<string, string>()

/** 查 sessionId 的 Skiff 角色名（无 → null） */
export function skiffRoleFor(sessionId: string): string | null {
  return skiffSessions.get(sessionId) ?? null
}

export function registerSkiffSession(sessionId: string, role: string): void {
  skiffSessions.set(sessionId, role)
}

export function unregisterSkiffSession(sessionId: string): void {
  skiffSessions.delete(sessionId)
}

/** 测试/调试：注册表快照（sessionId → role） */
export function skiffSessionSnapshot(): ReadonlyMap<string, string> {
  return new Map(skiffSessions)
}
