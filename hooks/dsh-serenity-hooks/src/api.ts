/**
 * api.ts — HTTP 状态接口（WebUI 停靠栏数据源/开关通道 + 图片落盘）
 *
 * 路由：
 *   GET  /serenity/status            ?workspace=<路径>  → 状态（root/accVersion/safeModeOn/...）
 *   POST /serenity/status            { workspace, on }  → 切换安全模式（WebUI 专属头）
 *   GET  /serenity/handymen          → handyman 运行状态（v1.24.0：loop → handyman）
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
import { listActiveHandymen } from './handyman-ops.js'
import { readAdvancedSettings, toWire, applyWirePatch } from './config-ops.js'

const ROUTE_PATH = '/serenity/status' // 非 /api：/api 前缀由 connection 路由拥有
const HANDYMEN_PATH = '/serenity/handymen'
const UPLOAD_PATH = '/serenity/image-upload'
const CONFIG_PATH = '/serenity/config'

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

/**
 * 从请求参数解析 workspace：优先 sessionId → 会话 header.cwd；其次 workspace 参数；
 * 无参 → 遍历 live sessions 找第一个 CCC 会话的 cwd（远程访问时 sessionId 可能缺失，
 * 回退 process.cwd()=$HOME 会错误显示"未激活"——v1.22.2 修复）；最后进程 cwd。
 * 纯逻辑（可单测）：resolveWorkspaceCore(sessionCwd, workspaceParam, listCwds)。
 */
export function resolveWorkspaceCore(
  sessionCwd: string | undefined,
  workspaceParam: string | undefined,
  listCwds: () => string[],
  fallback: string,
): string {
  if (sessionCwd) return sessionCwd
  if (workspaceParam) return workspaceParam
  for (const cwd of listCwds()) {
    if (cwd && findSerenityRoot(cwd)) return cwd
  }
  return fallback
}

function resolveWorkspace(ctx: Context, params: { sessionId?: string; workspace?: string }): string {
  let sessionCwd: string | undefined
  if (params.sessionId) {
    const session = (ctx.sessions as { get?: (id: SessionId) => { header?: { cwd?: string } } | undefined } | undefined)?.get?.(params.sessionId as SessionId)
    sessionCwd = session?.header?.cwd
  }
  let listCwds: () => string[] = () => []
  try {
    const sessions = (ctx.sessions as unknown as {
      list?: () => Array<{ header?: { cwd?: string } }>
    } | undefined)
    if (typeof sessions?.list === 'function') {
      listCwds = () => sessions.list!().map((s) => s.header?.cwd ?? '').filter(Boolean)
    }
  } catch {
    /* 遍历失败 → 空列表 */
  }
  return resolveWorkspaceCore(sessionCwd, params.workspace, listCwds, process.cwd())
}

export function registerStatusApi(ctx: Context, opts: StatusApiRegistration = {}): void {
  const configPaths = opts.configPaths ?? DEFAULT_SERENITY_CONFIG_PATHS

  // /serenity/handymen：handyman 运行状态（WebUI 等待界面数据源；进度文件摘要，不依赖工具执行上下文）
  ctx.webServer.register({
    kind: 'exact',
    path: HANDYMEN_PATH,
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
          sendJson(res, 200, { handymen: [] })
          return
        }
        sendJson(res, 200, { handymen: listActiveHandymen(root) })
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

  // /serenity/config：plugin 全局配置读写（v1.21 面板数据源；v1.22 全局化——
  // 归属原则：账号密码/gateway 监听是 plugin 级能力，存 ~/.dsh/serenity-hooks.json，
  // 不依赖任何具体 CCC。client 专属头）
  // GET  → wire 形态（密码 hash 永不返回；accounts 只含 id/user/hasPassword）
  // PUT  → wire patch 应用（新账号必须带 pass；既有账号 pass 空=保留原 hash）
  ctx.webServer.register({
    kind: 'exact',
    path: CONFIG_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        if (req.headers['x-serenity-ui'] !== '1') {
          sendJson(res, 403, { error: '高级设定仅限 WebUI（client 专用）' })
          return
        }
        if (req.method === 'GET') {
          sendJson(res, 200, { config: toWire(readAdvancedSettings()) })
          return
        }
        if (req.method === 'PUT') {
          const raw = await readBody(req, 128 * 1024)
          const body = JSON.parse(raw) as { config?: Partial<ReturnType<typeof toWire>> }
          const saved = applyWirePatch(body.config ?? {})
          // 通知 gateway 重建（第二监听器配置/账号变化后立即生效）
          try {
            (ctx as unknown as { emit?: (name: string, payload?: unknown) => void }).emit?.('serenity/config-updated')
          } catch {
            /* 事件通知失败不影响保存结果 */
          }
          sendJson(res, 200, { config: toWire(saved) })
          return
        }
        sendJson(res, 405, { error: 'method not allowed' })
      } catch (err: any) {
        sendJson(res, 400, { error: err.message ?? String(err) })
      }
    },
  })
}
