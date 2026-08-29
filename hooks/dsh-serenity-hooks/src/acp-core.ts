/**
 * acp-core.ts — ACP 会话管理层（F4c，v1.26.0 实验性）
 *
 * **传输无关**：方法处理器（initialize/session/new/prompt/cancel/list/close/request_permission）
 * 不依赖任何传输（stdio/HTTP/直调）——企业微信桥同进程直调处理器函数，
 * acp-http 端点（外部程序化面）与未来 stdio 独立进程复用同一处理器。
 *
 * Skiff 映射（S142 用户拍板：指定 认知容器+角色+会话（可选）进行对话）：
 *   - session/new { ccc, role, sessionId? } → createSkiffAgent / getSkiffAgent 复用
 *     （无 sessionId → 新建；有 → 进程内延续——与 v1.25.10 调试页同语义）
 *   - session/prompt → askSkiff(agent, question, 0)（全量轨迹）
 *   - session/cancel → agent.interrupt（DSH 能力）
 *   - session/close → unregisterSkiffSession（释放 agent + 注册表清理）
 *   - session/request_permission → 恒 allow（G9：白名单即授权）
 *
 * 实验性质：仅当 ACP 服务装配（settings acpEnabled）且 CCC 配置了角色时才创建 agent；
 * 未启用时本模块零副作用（无监听、无 agent）。
 */

import type { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { createSkiffAgent, askSkiff, getSkiffAgent, skiffSessionInfo, unregisterSkiffSession, skiffSessionSnapshot } from './skiff-core.js'
import { readSkiffRoles } from './skiff-role.js'
import { readHandymanConfig } from './ccc.js'

// ── JSON-RPC 2.0 类型（传输无关；acp-http 序列化用）──

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
}

/** JSON-RPC 错误码（对齐标准） */
export const RPC_ERROR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
} as const

// ── ACP 方法面（对齐 ACP v1 + 官方 dsh-acp 演进；skiff 扩展 session/new）──

export interface AcpSessionHandle {
  sessionId: string
  role: string
  ccc: string
  /** 会话是否可复用（进程内延续） */
  continued: boolean
}

/** ACP 会话记录（处理器内部） */
interface AcpSessionRecord {
  handle: AcpSessionHandle
  agent: Agent
}

/**
 * ACP 会话管理器：持有 skiff agent 会话（与 skiff-core 注册表同源——
 * 创建走 createSkiffAgent（自动注册），关闭走 unregisterSkiffSession）。
 * 传输无关：HTTP 端点/企业微信桥/未来 stdio 都调 handle(method, params)。
 */
export class AcpServer {
  private readonly ctx: Context

  constructor(ctx: Context) {
    this.ctx = ctx
  }

  /** 实现级方法调度（返回 result 或抛 JSON-RPC 语义错误） */
  async handle(method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return this.initialize()
      case 'authenticate':
        return {} // no-op（ACP v1 无认证；部署面安全见 acp-wecom-design §5）
      case 'session/new':
        return this.newSession(params)
      case 'session/list':
        return this.listSessions()
      case 'session/prompt':
        return this.prompt(params)
      case 'session/cancel':
        return this.cancel(params)
      case 'session/close':
        return this.closeSession(params)
      case 'session/request_permission':
        return { allow: true } // G9：白名单即授权，恒 allow
      default:
        throw new RpcMethodError(`method not found: ${method}`)
    }
  }

  // ── 方法实现 ──

  private initialize(): { protocolVersion: number; capabilities: Record<string, unknown>; serverInfo: Record<string, unknown> } {
    return {
      protocolVersion: 1,
      capabilities: {
        sessionId: true, // skiff 扩展：session/new 支持 sessionId（进程内延续）
        ccc: true, // skiff 扩展：指定认知容器
        role: true, // skiff 扩展：指定角色
      },
      serverInfo: { name: 'dsh-serenity-hooks-acp', version: '1.26.0' },
    }
  }

  /**
   * session/new：{ ccc, role, sessionId? } → 创建或延续 skiff 会话。
   * 无 sessionId → createSkiffAgent（新会话，continued:false）；
   * 有 → 进程内延续（getSkiffAgent 命中 + role/ccc 绑定校验；未命中 → 错误）。
   */
  private async newSession(params: Record<string, unknown> | undefined): Promise<AcpSessionHandle> {
    const ccc = typeof params?.ccc === 'string' && params.ccc !== '' ? params.ccc : undefined
    const roleName = typeof params?.role === 'string' ? params.role : undefined
    const sessionId = typeof params?.sessionId === 'string' && params.sessionId !== '' ? params.sessionId : undefined
    if (!ccc) throw new RpcInvalidParams('session/new requires ccc (CCC root path)')
    if (!roleName) throw new RpcInvalidParams('session/new requires role')
    const roles = readSkiffRoles(ccc)
    const role = roles.get(roleName)
    if (!role) throw new RpcInvalidParams(`unknown role: ${roleName} (ccc: ${ccc})`)

    // 会话延续（与调试页 /ask 同语义：进程内复用）
    if (sessionId) {
      const info = skiffSessionInfo(sessionId)
      const live = getSkiffAgent(sessionId)
      if (!info || !live) {
        throw new RpcInvalidParams('session is not recoverable (process restarted or session unknown) — start a new conversation')
      }
      if (info.role !== roleName || info.ccc !== ccc) {
        throw new RpcInvalidParams(`session "${sessionId}" belongs to role "${info.role}" in another CCC`)
      }
      return { sessionId, role: roleName, ccc, continued: true }
    }

    const hc = readHandymanConfig(ccc)
    const ref = await createSkiffAgent(this.ctx, ccc, roleName, role, hc?.defaultModel)
    return { sessionId: ref.sessionId, role: roleName, ccc, continued: false }
  }

  private listSessions(): { sessions: Array<{ sessionId: string; role: string; ccc: string }> } {
    const sessions: Array<{ sessionId: string; role: string; ccc: string }> = []
    for (const [id, b] of skiffSessionSnapshot()) {
      sessions.push({ sessionId: id, role: b.role, ccc: b.ccc })
    }
    return { sessions }
  }

  /**
   * session/prompt：{ sessionId, question } → 答案（**v1.26.10：不返回 trajectory**——
   * 3100 对外只提供问答，轨迹含工具结果等内部信息；3099 调试页另走 /ask 保留）
   */
  private async prompt(params: Record<string, unknown> | undefined): Promise<{ answer: string; sessionId: string }> {
    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : undefined
    const question = typeof params?.question === 'string' ? params.question : undefined
    if (!sessionId) throw new RpcInvalidParams('session/prompt requires sessionId')
    if (!question?.trim()) throw new RpcInvalidParams('session/prompt requires question')
    const agent = getSkiffAgent(sessionId)
    if (!agent) throw new RpcInvalidParams(`unknown session: ${sessionId} (not recoverable — process restarted?)`)
    const result = await askSkiff(this.ctx, agent, question, undefined, { includeTrajectory: false })
    return { answer: result.answer, sessionId: result.sessionId }
  }

  /** session/cancel：{ sessionId } → 中断当前 prompt（DSH interrupt） */
  private cancel(params: Record<string, unknown> | undefined): { cancelled: boolean } {
    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : undefined
    if (!sessionId) return { cancelled: false }
    const agent = getSkiffAgent(sessionId)
    if (!agent) return { cancelled: false } // 未知会话 no-op（对齐官方）
    try {
      ;(agent as unknown as { interrupt?: () => void }).interrupt?.()
    } catch {
      /* 中断失败忽略（agent 可能已空闲） */
    }
    return { cancelled: true }
  }

  /** session/close：{ sessionId } → 释放 agent + 注册表清理（进程内） */
  private closeSession(params: Record<string, unknown> | undefined): { closed: boolean } {
    const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : undefined
    if (!sessionId) return { closed: false }
    if (!getSkiffAgent(sessionId)) return { closed: false }
    unregisterSkiffSession(sessionId)
    return { closed: true }
  }
}

/** 方法不存在错误（JSON-RPC -32601） */
export class RpcMethodError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RpcMethodError'
  }
}

/** 参数错误（JSON-RPC -32602） */
export class RpcInvalidParams extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RpcInvalidParams'
  }
}

/**
 * JSON-RPC 2.0 批处理（单帧）：解析请求/通知 → 调 AcpServer.handle → 响应。
 * 传输无关：acp-http 端点 / 未来 stdio 共用。
 * @returns 响应帧数组（请求有响应；通知无；解析失败 → 单错误响应）
 */
export async function dispatchRpc(server: AcpServer, frame: unknown): Promise<JsonRpcResponse[]> {
  if (frame === null || typeof frame !== 'object') {
    return [rpcError(null, RPC_ERROR.INVALID_REQUEST, 'invalid request')]
  }
  const req = frame as JsonRpcRequest
  if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    return [rpcError(req.id ?? null, RPC_ERROR.INVALID_REQUEST, 'invalid request')]
  }
  // 通知（无 id）→ 不响应
  if (req.id === undefined) {
    try {
      await server.handle(req.method, req.params)
    } catch {
      /* 通知错误静默（无 id 可回） */
    }
    return []
  }
  try {
    const result = await server.handle(req.method, req.params)
    return [{ jsonrpc: '2.0', id: req.id, result }]
  } catch (error) {
    return [rpcError(req.id, rpcCodeOf(error), error instanceof Error ? error.message : String(error))]
  }
}

function rpcCodeOf(error: unknown): number {
  if (error instanceof RpcMethodError) return RPC_ERROR.METHOD_NOT_FOUND
  if (error instanceof RpcInvalidParams) return RPC_ERROR.INVALID_PARAMS
  return RPC_ERROR.INTERNAL
}

function rpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

/** 断言 SessionId 类型（ACP 会话 id 即 skiff sessionId） */
export type { SessionId }
