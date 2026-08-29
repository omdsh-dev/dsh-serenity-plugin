/**
 * acp-http.ts — ACP HTTP JSON-RPC 端点（F4c，v1.26.0 实验性）
 *
 * node:http 服务（默认关，仅监听 127.0.0.1；启停 = 人工——设置面板「Serenity」
 * 页 ACP 区块开关，不随插件加载自动启动；仿 skiff 调试服务模式）。
 *
 * - POST / → JSON-RPC 2.0 单帧/批处理（body 为 JSON）→ JSON-RPC 响应数组
 *
 * 与 skiff 调试页（人工测试面）共享同一会话核心（acp-core → skiff-core）；
 * 企业微信桥（F4c-2）同进程直调 acp-core 处理器函数，不经本端点。
 * stdio 形态（独立进程部署）后续复用同一 acp-core（官方 NDJSON 帧格式）。
 *
 * 实验性质：未开启时零资源占用（无监听、无 agent 创建）。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Context } from 'cordis'
import { AcpServer, dispatchRpc } from './acp-core.js'

/** 运行中的 ACP HTTP 服务（单实例；进程级） */
let active: { server: ReturnType<typeof createServer>; port: number } | null = null

export function acpHttpActive(): boolean {
  return active !== null
}

export function acpHttpPort(): number | null {
  return active?.port ?? null
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

/**
 * 启动 ACP HTTP JSON-RPC 端点（单实例；重复启动幂等返回既有实例）。
 * @param ctx 插件上下文（AcpServer 内部经 skiff-core 创建 agent）
 * @param port 监听端口（仅 127.0.0.1）
 */
export async function startAcpHttpServer(ctx: Context, port: number): Promise<void> {
  if (active) return
  const server = createServer((req, res) => {
    void handle(ctx, req, res)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  active = { server, port }
  console.log(`[serenity-hooks] ✓ ACP HTTP JSON-RPC: http://127.0.0.1:${port}（session/new 支持 {ccc, role, sessionId?}）`)
}

export function stopAcpHttpServer(): void {
  if (!active) return
  try {
    active.server.close()
  } catch {
    /* 关闭失败忽略 */
  }
  active = null
}

async function handle(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = (req.url ?? '/').split('?')[0] ?? '/'
    if (req.method === 'POST' && url === '/') {
      let body: unknown
      try {
        body = JSON.parse(await readBody(req)) as unknown
      } catch {
        sendJson(res, 400, [{ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }])
        return
      }
      const server = new AcpServer(ctx)
      const responses = await dispatchRpc(server, body)
      sendJson(res, 200, responses)
      return
    }
    sendJson(res, 404, { error: 'not found' })
  } catch (err) {
    sendJson(res, 500, { error: (err as Error)?.message ?? String(err) })
  }
}
