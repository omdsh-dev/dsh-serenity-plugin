/**
 * api.ts — HTTP 状态接口（WebUI 停靠栏数据源/开关通道 + 图片落盘）
 *
 * 路由：
 *   GET  /serenity/status            ?workspace=<路径>  → 状态（root/accVersion/safeModeOn/...）
 *   POST /serenity/status            { workspace, on }  → 切换安全模式（WebUI 专属头）
 *   GET  /serenity/loops             → loop 运行状态
 *   POST /serenity/image-upload      { workspace?, mediaType, data(base64) } → 图片写 _tmp/images_from_user/（client 专属）
 *
 * 经 ctx.webServer（webserver 服务，公开版由 httpServer 改名）注册；客户端与服务器同源，调用无信任围栏问题。
 */

import type { Context } from 'cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
// 类型引用：拉入 webserver / session 包的 cordis 声明增强（ctx.webServer / ctx.sessions）；运行时擦除
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { getStatus, setSafeMode } from './status.js'
import { findSerenityRoot, DEFAULT_SERENITY_CONFIG_PATHS } from './ccc.js'
import { listActiveLoops } from './loop-ops.js'

const ROUTE_PATH = '/serenity/status' // 非 /api：/api 前缀由 connection 路由拥有
const LOOPS_PATH = '/serenity/loops'
const UPLOAD_PATH = '/serenity/image-upload'

/** 图片落盘目录（CCC 根相对；S142 图片自动识别基础设施——粘贴图片落盘供 agent 经 CCC vlm MSM 自主处理） */
export const IMAGE_UPLOAD_DIR = '_tmp/images_from_user'
export const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const EXT_BY_MEDIA: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
const MAX_IMAGE_BYTES = 10 * 1024 * 1024 // 单图 10MB 上限

/**
 * 图片落盘核心逻辑（可测）：校验 mediaType 白名单 + base64 解码 + 大小上限 →
 * 写 CCC 根 _tmp/images_from_user/<ts>-<rand>.<ext>，返回相对路径。
 * 校验失败抛 Error（handler 转 400）。
 */
export function saveImageToTmp(root: string, mediaType: string, data: string): string {
  if (!IMAGE_MEDIA_TYPES.has(mediaType)) {
    throw new Error(`unsupported media type: ${mediaType}`)
  }
  if (typeof data !== 'string' || data.length === 0) {
    throw new Error('missing image data')
  }
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(`image size out of range: ${bytes.length} bytes (max ${MAX_IMAGE_BYTES})`)
  }
  const dir = join(root, IMAGE_UPLOAD_DIR)
  mkdirSync(dir, { recursive: true })
  const ext = EXT_BY_MEDIA[mediaType] ?? 'img'
  const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}.${ext}`
  writeFileSync(join(dir, filename), bytes)
  return `${IMAGE_UPLOAD_DIR}/${filename}`
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf-8')
      if (data.length > maxBytes) {
        reject(new Error('body too large'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(payload)
}

export interface StatusApiRegistration {
  configPaths?: string[]
}

/** 从请求参数解析 workspace：优先 sessionId → 会话 header.cwd；其次 workspace 参数；最后进程 cwd */
function resolveWorkspace(ctx: Context, params: { sessionId?: string; workspace?: string }): string {
  if (params.sessionId) {
    const session = (ctx.sessions as { get?: (id: SessionId) => { header?: { cwd?: string } } | undefined } | undefined)?.get?.(params.sessionId as SessionId)
    if (session?.header?.cwd) return session.header.cwd
  }
  if (typeof params.workspace === 'string' && params.workspace) return params.workspace
  return process.cwd()
}

export function registerStatusApi(ctx: Context, opts: StatusApiRegistration = {}): void {
  const configPaths = opts.configPaths ?? DEFAULT_SERENITY_CONFIG_PATHS

  // /serenity/loops：loop 运行状态（WebUI 等待界面数据源；进度文件摘要，不依赖工具执行上下文）
  ctx.webServer.register({
    kind: 'exact',
    path: LOOPS_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const workspace = resolveWorkspace(ctx, { sessionId: url.searchParams.get('sessionId') ?? undefined, workspace: url.searchParams.get('workspace') ?? undefined })
        const root = findSerenityRoot(workspace)
        if (!root) {
          sendJson(res, 200, { loops: [] })
          return
        }
        sendJson(res, 200, { loops: listActiveLoops(root) })
      } catch (err: any) {
        sendJson(res, 400, { error: err.message ?? String(err) })
      }
    },
  })

  // /serenity/image-upload：图片落盘（S142 图片自动识别基础设施——WebUI 粘贴图片 →
  // 模型不支持图片时自动存 _tmp/images_from_user/，agent 经 CCC vlm MSM 自主处理）。
  // client 专属（x-serenity-ui 头）；类型白名单 + 10MB 上限 + CCC 根内写入。
  ctx.webServer.register({
    kind: 'exact',
    path: UPLOAD_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        if (req.headers['x-serenity-ui'] !== '1') {
          sendJson(res, 403, { error: '图片落盘仅限 WebUI（client 专用）' })
          return
        }
        const raw = await readBody(req, 20 * 1024 * 1024)
        const body = JSON.parse(raw) as { sessionId?: string; workspace?: string; mediaType?: string; data?: string }
        const workspace = resolveWorkspace(ctx, { sessionId: body.sessionId, workspace: body.workspace })
        const root = findSerenityRoot(workspace)
        if (!root) {
          sendJson(res, 404, { error: `no CCC found from workspace: ${workspace}` })
          return
        }
        const path = saveImageToTmp(root, body.mediaType ?? '', body.data ?? '')
        sendJson(res, 200, { path })
      } catch (err: any) {
        sendJson(res, 400, { error: err.message ?? String(err) })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        if (req.method === 'GET') {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const workspace = resolveWorkspace(ctx, { sessionId: url.searchParams.get('sessionId') ?? undefined, workspace: url.searchParams.get('workspace') ?? undefined })
          const status = getStatus(workspace, configPaths)
          // P2-7：附加 codeRuntime 装配态（WebUI 停靠栏可显示 PTC/Code Mode 是否可用）
          const runtime = ctx.get('codeRuntime') as { language?: string; isolation?: string } | undefined
          sendJson(res, 200, {
            ...status,
            ...runtime === undefined ? { codeRuntime: null } : { codeRuntime: { language: runtime.language, isolation: runtime.isolation } },
          })
          return
        }
        if (req.method === 'POST') {
          // safe-mode 是用户能力：POST 需 WebUI 专属头，agent 工具/curl 无法自行开关
          if (req.headers['x-serenity-ui'] !== '1') {
            sendJson(res, 403, { error: 'safe-mode 切换仅限 WebUI（agent 不可自行开关）' })
            return
          }
          const raw = await readBody(req, 64 * 1024)
          const body = JSON.parse(raw) as { sessionId?: string; workspace?: string; on?: boolean }
          const workspace = resolveWorkspace(ctx, { sessionId: body.sessionId, workspace: body.workspace })
          const root = findSerenityRoot(workspace)
          if (!root) {
            sendJson(res, 404, { error: `no CCC found from workspace: ${workspace}` })
            return
          }
          const on = body.on === true
          const result = setSafeMode(root, on)
          sendJson(res, 200, { ...getStatus(workspace, configPaths), ...result })
          return
        }
        sendJson(res, 405, { error: 'method not allowed' })
      } catch (err: any) {
        sendJson(res, 400, { error: err.message ?? String(err) })
      }
    },
  })
}
