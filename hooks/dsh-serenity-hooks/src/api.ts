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
import { extname, join } from 'node:path'
// 类型引用：拉入 webserver / session 包的 cordis 声明增强（ctx.webServer / ctx.sessions）；运行时擦除
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { hostService, hostSessions } from './host/access.js'
import { getStatus, setSafeMode } from './status.js'
import { DEFAULT_SERENITY_CONFIG_PATHS } from './ccc.js'
// C2（CCC 发现面归一）：L1 单根解析 / L2 枚举一律问 ccc-roots（本文件不再自写上溯包裹）
import { cccRootForCwd, listCccs } from './ccc-roots.js'
import { listActiveHandymen } from './handyman-ops.js'
import { readAdvancedSettings, toWire, applyWirePatch, ensurePublicAskKey, rotatePublicAskKey, projectKnownWorkspaces } from './config-ops.js'
// C4 块 B：端口取值只从集中端口表取（原处硬写 3100 回退）
import { ACP_HTTP_PORT } from './ports.js'
import { isoLocal, localFileStamp } from './time.js'

const ROUTE_PATH = '/serenity/status' // 非 /api：/api 前缀由 connection 路由拥有
const HANDYMEN_PATH = '/serenity/handymen'
const UPLOAD_PATH = '/serenity/image-upload'
const FILE_UPLOAD_PATH = '/serenity/file-upload'
const CONFIG_PATH = '/serenity/config'
const CCCS_PATH = '/serenity/cccs'
const PUBLIC_ASK_PATH = '/serenity/public-ask'
const WEIXIN_PATH = '/serenity/weixin'

/** 图片落盘目录（CCC 根相对；S142 图片自动识别基础设施——粘贴图片落盘供 agent 经 CCC vlm MSM 自主处理） */
export const IMAGE_UPLOAD_DIR = '_tmp/images_from_user'
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const EXT_BY_MEDIA: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
const MAX_IMAGE_BYTES = 10 * 1024 * 1024 // 单图 10MB 上限

/** 文件落盘目录（CCC 根相对；v1.24.1 粘贴任意文件自动落盘——agent 经 CCC 既有 MSM（pdf-extract/archive-extract 等）自主处理） */
export const FILE_UPLOAD_DIR = '_tmp/files_from_user'
/** 拒绝的可执行/危险扩展名（安全边界：不落盘可执行文件，防 agent 被诱导执行） */
const BLOCKED_FILE_EXTS = new Set([
  'exe', 'dll', 'msi', 'bat', 'cmd', 'ps1', 'com', 'scr', 'lnk', 'sh', 'vbs', 'bin', 'app', 'deb', 'rpm', 'jar',
])
const MAX_FILE_BYTES = 10 * 1024 * 1024 // 单文件 10MB 上限（用户拍板：与图片一致）

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
  const filename = `${localFileStamp()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
  writeFileSync(join(dir, filename), bytes)
  return `${IMAGE_UPLOAD_DIR}/${filename}`
}

/**
 * 文件名脱敏（路径逃逸 + 非法字符）：取 basename（去 / 与 \），剥离前导点/空，
 * 非法字符 → '-',限长。返回空则 'file'。
 */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const cleaned = base
    .replace(/[<>:"|?*\u0000-\u001f]/g, '-')
    .replace(/^\.+/, '')
    .trim()
  if (cleaned === '') return 'file'
  return cleaned.slice(0, 100)
}

/**
 * 任意文件落盘核心逻辑（可测）：文件名校验 + 可执行扩展名拒绝 + base64 解码 +
 * 大小上限（10MB）→ 写 CCC 根 _tmp/files_from_user/<ts>-<rand>-<safeName>，返回相对路径。
 * 校验失败抛 Error（handler 转 400）。
 */
export function saveFileToTmp(root: string, fileName: string, data: string): string {
  if (typeof fileName !== 'string' || fileName.length === 0) {
    throw new Error('missing file name')
  }
  const ext = extname(fileName).slice(1).toLowerCase()
  if (ext !== '' && BLOCKED_FILE_EXTS.has(ext)) {
    throw new Error(`blocked executable file type: .${ext}`)
  }
  if (typeof data !== 'string' || data.length === 0) {
    throw new Error('missing file data')
  }
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES) {
    throw new Error(`file size out of range: ${bytes.length} bytes (max ${MAX_FILE_BYTES})`)
  }
  const dir = join(root, FILE_UPLOAD_DIR)
  mkdirSync(dir, { recursive: true })
  const safeName = sanitizeFileName(fileName)
  const filename = `${localFileStamp()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`
  writeFileSync(join(dir, filename), bytes)
  return `${FILE_UPLOAD_DIR}/${filename}`
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

/**
 * WebUI 专属动作的来源判别（C4 块 C：此前 **9 处内联** `req.headers['x-serenity-ui'] !== '1'`）。
 *
 * ⚠️ 语义边界（勿误读为认证）：这是**客户端判别头**——任何本机能发 HTTP 的进程都可自带它
 * （无密钥、无签名、不校验来源，见现状取证 §② 面 A "认证与守卫"）。它区分的是
 * "WebUI 触发的动作"与"agent/curl 触发的动作"（如 safe-mode 不可由 agent 自行开关）。
 * 本 helper 只做**同一判据的归一**，不放宽也不收紧：判据、状态码、文案均由调用方给出。
 */
function senderIsWebUi(req: IncomingMessage): boolean {
  return req.headers['x-serenity-ui'] === '1'
}

/**
 * WebUI 闸门：非 WebUI 来源 → 回 403（文案由调用方给，**响应体逐字不变**）并返回 false。
 * 用法：`if (!requireWebUi(req, res, '<原文案>')) return`
 */
function requireWebUi(req: IncomingMessage, res: ServerResponse, message: string): boolean {
  if (senderIsWebUi(req)) return true
  sendJson(res, 403, { error: message })
  return false
}

interface StatusApiRegistration {
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
    if (cwd && cccRootForCwd(cwd)) return cwd
  }
  return fallback
}

function resolveWorkspace(ctx: Context, params: { sessionId?: string; workspace?: string }): string {
  let sessionCwd: string | undefined
  if (params.sessionId) {
    const session = hostSessions(ctx)?.get?.(params.sessionId as SessionId)
    sessionCwd = session?.header?.cwd
  }
  let listCwds: () => string[] = () => []
  try {
    const sessions = hostSessions(ctx)
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
        const root = cccRootForCwd(workspace)
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
        if (!requireWebUi(req, res, '图片落盘仅限 WebUI（client 专用）')) return
        const raw = await readBody(req, 20 * 1024 * 1024)
        const body = JSON.parse(raw) as { sessionId?: string; workspace?: string; mediaType?: string; data?: string }
        const workspace = resolveWorkspace(ctx, { sessionId: body.sessionId, workspace: body.workspace })
        const root = cccRootForCwd(workspace)
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

  // /serenity/file-upload：任意文件落盘（v1.24.1——粘贴非图片文件自动存
  // _tmp/files_from_user/，agent 经 CCC 既有 MSM（pdf-extract/archive-extract 等）自主处理）。
  // client 专属（x-serenity-ui 头）；可执行扩展名拒绝 + 10MB 上限 + CCC 根内写入。
  ctx.webServer.register({
    kind: 'exact',
    path: FILE_UPLOAD_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        if (!requireWebUi(req, res, '文件落盘仅限 WebUI（client 专用）')) return
        const raw = await readBody(req, 20 * 1024 * 1024)
        const body = JSON.parse(raw) as { sessionId?: string; workspace?: string; name?: string; data?: string }
        const workspace = resolveWorkspace(ctx, { sessionId: body.sessionId, workspace: body.workspace })
        const root = cccRootForCwd(workspace)
        if (!root) {
          sendJson(res, 404, { error: `no CCC found from workspace: ${workspace}` })
          return
        }
        const path = saveFileToTmp(root, body.name ?? '', body.data ?? '')
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
          if (!requireWebUi(req, res, 'safe-mode 切换仅限 WebUI（agent 不可自行开关）')) return
          const raw = await readBody(req, 64 * 1024)
          const body = JSON.parse(raw) as { sessionId?: string; workspace?: string; on?: boolean }
          const workspace = resolveWorkspace(ctx, { sessionId: body.sessionId, workspace: body.workspace })
          const root = cccRootForCwd(workspace)
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
        if (!requireWebUi(req, res, '高级设定仅限 WebUI（client 专用）')) return
        if (req.method === 'GET') {
          // v1.28.0 适配 0.1.2-rc.1 A2 方案 A′：响应附 knownWorkspaces（host workspaceRegistry
          // 投影 + 白名单过滤）——rc.1 workspace.list unary 删除，AccountsEditor 白名单下拉
          // 数据源改走 gateway 自有配置接口，零 WS 介入。
          const settings = readAdvancedSettings()
          let known: Array<{ path: string; title: string }> = []
          try {
            const registry = hostService<{ list?: () => Array<{ path?: string; title?: string }> }>(ctx, 'workspaceRegistry')
            known = projectKnownWorkspaces(registry?.list?.() ?? [], settings.gateway.workspaces)
          } catch {
            /* workspace 服务不可用 → 空列表（面板显示"暂无可选工作区"） */
          }
          sendJson(res, 200, { config: toWire(settings), knownWorkspaces: known })
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

  // /serenity/cccs：候选认知容器列表（v1.26.2 设置面板「开放容器」白名单选择的数据源；
  // 只读；与 skiff 调试页/微信桥/ACP 问答页**同一** listCccs——工作区注册表 ∪ 持久化会话 ∪ live）
  ctx.webServer.register({
    kind: 'exact',
    path: CCCS_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const workspace = resolveWorkspace(ctx, { sessionId: url.searchParams.get('sessionId') ?? undefined, workspace: url.searchParams.get('workspace') ?? undefined })
        const root = cccRootForCwd(workspace) ?? ''
        // C2：枚举归 ccc-roots（不再绕 skiff-debug.js 加载整条 skiff 链）；
        // CccEntry 带 name + roles ⇒ 面板选择器需要的字段齐备（与旧 discoverCccs 输出同形）。
        const cccs = await listCccs(ctx, { defaultRoot: root, withRoles: true })
        sendJson(res, 200, { cccs })
      } catch (err: any) {
        sendJson(res, 400, { error: err.message ?? String(err) })
      }
    },
  })

  // /serenity/public-ask：建议问答页配置信息（v1.26.2 用户：配置处需能获取 key 和地址）
  // GET → { enabled, port, key, allowed, urls }（x-serenity-ui 头限定 WebUI；key 仅管理员可见）
  // PUT { action: 'rotate' } → 轮换 key（v1.26.5 用户：不好说要换 key 呢——生成新 key 旧 key 立即失效）
  ctx.webServer.register({
    kind: 'exact',
    path: PUBLIC_ASK_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        if (!requireWebUi(req, res, '仅限 WebUI（key 属敏感凭据）')) return
        if (req.method === 'PUT') {
          const raw = await readBody(req, 16 * 1024)
          const body = JSON.parse(raw) as { action?: string }
          if (body.action !== 'rotate') {
            sendJson(res, 400, { error: 'unsupported action (expected "rotate")' })
            return
          }
          const newKey = rotatePublicAskKey()
          sendJson(res, 200, { key: newKey })
          return
        }
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        const settings = readAdvancedSettings()
        // 动态 import：readSimpleSettings 依赖 settings-section（schemastery peerDep）——
        // 保持 api.ts 静态链纯净（仅本端点触发时加载）
        const { readSimpleSettings } = await import('./settings-section.js')
        const simple = readSimpleSettings()
        const allowed = settings.publicAsk.allowed
        // 地址：单容器页 /c/<name>（开放容器）+ 列表页 /
        const port = simple.acpHttpPort ?? ACP_HTTP_PORT
        const base = `http://127.0.0.1:${port}`
        const containerUrls = allowed.map((name) => ({ name, url: `${base}/c/${encodeURIComponent(name)}` }))
        sendJson(res, 200, {
          enabled: simple.publicAskEnabled ?? false,
          port,
          key: ensurePublicAskKey(),
          allowed,
          urls: containerUrls,
          listUrl: `${base}/`,
        })
      } catch (err: any) {
        sendJson(res, 400, { error: err.message ?? String(err) })
      }
    },
  })

  // 原 `/serenity/trajectory` 端点（Autopilot Trajectory 状态 + 唤醒注册表 + 手动立即唤起）已随
  // ACC 侧 autopilot 退场整体删除（2026-09-15）：它的两个半边——`status`（autopilot 状态）与
  // POST `action:'wake'`（手动唤起）——的唯一消费方是设置面板的「Autopilot Trajectory」区块，
  // 该区块同批删除。`wakes`（唤醒注册表）半边同样失去面板消费方；注册表本身的真相源仍是
  // `AGENT_SESSIONS/wake-registry.json`，运行态可见性走 `acc-diag` ③ 段。

  // /serenity/weixin：微信桥 CCC 级配置（F4c-3，v1.27.0 实验性；S142 用户拍板——
  // 配置归 CCC + 显式 ccc 参数 + 面板扫码）。全部 x-serenity-ui 头限定（client 专属）。
  // GET ?ccc=<root> → { enabled, accounts[]（脱敏）, routes[], bridgeStatus[] }
  // POST { action: 'login-start', ccc } → { qrcode, qrcode_img_content, loginKey }
  // GET /serenity/weixin/login?key=<loginKey> → { status, accountId?, tokenSaved?, error? }
  // POST { action: 'remove-account', ccc, accountId } → 移除（serenity.json + localstore + 停桥）
  // POST { action: 'save-routes', ccc, routes } / { action: 'set-enabled', ccc, enabled }
  ctx.webServer.register({
    kind: 'exact',
    path: WEIXIN_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        if (!requireWebUi(req, res, '微信桥配置仅限 WebUI（client 专用）')) return
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')

        if (req.method === 'GET') {
          const rootParam = url.searchParams.get('ccc') ?? undefined
          const chk = requireCcc(rootParam)
          if (!chk.ok) {
            sendJson(res, 400, { error: chk.error })
            return
          }
          const { readWeixinSettings } = await import('./weixin-route.js')
          const { weixinBridgeStatus } = await import('./weixin-bridge.js')
          const settings = readWeixinSettings(chk.root)
          const bridge = weixinBridgeStatus().find((b) => b.ccc === chk.root)
          // accounts 脱敏：只回元信息 + 是否已绑定（token 永不落 wire）
          const { readWeixinCredential } = await import('./weixin-route.js')
          const accounts = (settings.accounts ?? []).map((a) => ({
            accountId: a.accountId,
            name: a.name ?? undefined,
            enabled: a.enabled !== false,
            bound: readWeixinCredential(chk.root, a.accountId) !== null,
          }))
          sendJson(res, 200, {
            enabled: settings.enabled === true,
            botType: settings.botType ?? undefined,
            accounts,
            routes: settings.routes ?? [],
            bridge: bridge?.accounts ?? [],
          })
          return
        }

        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }

        const raw = await readBody(req, 128 * 1024)
        const body = JSON.parse(raw) as {
          action?: string
          ccc?: string
          accountId?: string
          routes?: Array<{ user: string; role: string }>
          enabled?: boolean
        }
        const chk = requireCcc(body.ccc)
        if (!chk.ok) {
          sendJson(res, 400, { error: chk.error })
          return
        }
        const root = chk.root

        // login-start：出码（进程内调 iLink get_bot_qrcode；无需凭据）→ 存 loginKey 供轮询
        if (body.action === 'login-start') {
          const { fetchQRCode } = await import('./weixin-api.js')
          const { randomUUID } = await import('node:crypto')
          // 清理过期登录
          for (const [key, v] of weixinLogins) {
            if (Date.now() - v.startedAt > WEIXIN_LOGIN_TTL_MS) weixinLogins.delete(key)
          }
          const { readWeixinSettings } = await import('./weixin-route.js')
          const settings = readWeixinSettings(root)
          const qr = await fetchQRCode({ botType: settings.botType ?? undefined })
          const loginKey = randomUUID()
          weixinLogins.set(loginKey, { root, qrcode: qr.qrcode, startedAt: Date.now(), polling: false })
          sendJson(res, 200, { qrcode: qr.qrcode, qrcode_img_content: qr.qrcode_img_content, loginKey })
          return
        }

        // remove-account：移除账号（serenity.json 结构 + localstore 凭据 + 停桥重建）
        if (body.action === 'remove-account') {
          if (!body.accountId) {
            sendJson(res, 400, { error: 'missing accountId' })
            return
          }
          const { removeWeixinAccount } = await import('./weixin-route.js')
          const { syncCccBridge } = await import('./weixin-bridge.js')
          removeWeixinAccount(root, body.accountId)
          syncCccBridge(ctx, root)
          sendJson(res, 200, { removed: body.accountId })
          return
        }

        // save-routes：保存路由表（整体替换；校验 role 合法性——必须 ∈ 该 CCC skiff.roles）
        if (body.action === 'save-routes') {
          const routes = body.routes ?? []
          if (!Array.isArray(routes) || routes.some((r) => typeof r?.user !== 'string' || typeof r?.role !== 'string' || r.user === '' || r.role === '')) {
            sendJson(res, 400, { error: 'invalid routes (expected [{user, role}, ...])' })
            return
          }
          const { saveWeixinRoutes } = await import('./weixin-route.js')
          const { readSkiffRoles } = await import('./skiff-role.js')
          const roles = readSkiffRoles(root)
          for (const r of routes) {
            if (!roles.has(r.role)) {
              sendJson(res, 400, { error: `unknown role: ${r.role} (not in ${root} skiff.roles)` })
              return
            }
          }
          saveWeixinRoutes(root, routes)
          sendJson(res, 200, { saved: routes.length })
          return
        }

        // set-enabled：切换总开关（启用时无账号/无路由 → 400 提示先绑定）
        if (body.action === 'set-enabled') {
          const enabled = body.enabled === true
          const { readWeixinSettings, setWeixinEnabled } = await import('./weixin-route.js')
          const { syncCccBridge } = await import('./weixin-bridge.js')
          const settings = readWeixinSettings(root)
          if (enabled && (settings.accounts ?? []).length === 0) {
            sendJson(res, 400, { error: '启用前请先扫码绑定至少一个账号' })
            return
          }
          setWeixinEnabled(root, enabled)
          if (enabled) syncCccBridge(ctx, root)
          else {
            const { stopCccBridge } = await import('./weixin-bridge.js')
            stopCccBridge(root)
          }
          sendJson(res, 200, { enabled })
          return
        }

        sendJson(res, 400, { error: `unsupported action: ${body.action ?? ''}` })
      } catch (err: any) {
        sendJson(res, 400, { error: err.message ?? String(err) })
      }
    },
  })

  // GET /serenity/weixin/login?key=<loginKey>：扫码状态轮询（面板 1s 间隔）
  ctx.webServer.register({
    kind: 'exact',
    path: `${WEIXIN_PATH}/login`,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        if (!requireWebUi(req, res, '微信桥配置仅限 WebUI（client 专用）')) return
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const key = url.searchParams.get('key') ?? ''
        const login = weixinLogins.get(key)
        if (!login) {
          sendJson(res, 404, { error: 'login not found or expired' })
          return
        }
        if (Date.now() - login.startedAt > WEIXIN_LOGIN_TTL_MS) {
          weixinLogins.delete(key)
          sendJson(res, 200, { status: 'expired' })
          return
        }

        const { pollQRStatus } = await import('./weixin-api.js')
        const { readWeixinSettings } = await import('./weixin-route.js')
        const settings = readWeixinSettings(login.root)
        const status = await pollQRStatus({ baseUrl: undefined, qrcode: login.qrcode })

        switch (status.status) {
          case 'confirmed': {
            // confirmed → 写凭据（localstore）+ 账号元信息（serenity.json）→ 停桥重建
            if (!status.bot_token) {
              sendJson(res, 200, { status: 'error', error: 'confirmed but no bot_token' })
              return
            }
            const { upsertWeixinAccount, writeWeixinCredential, nextWeixinAccountId } = await import('./weixin-route.js')
            const { syncCccBridge } = await import('./weixin-bridge.js')
            // 多账号：每次扫码生成最小未占用 id（移除中间账号后复用，不冲突）
            const accountId = nextWeixinAccountId(settings)
            upsertWeixinAccount(login.root, { accountId, name: `微信 ${accountId}`, enabled: true })
            writeWeixinCredential(login.root, accountId, {
              token: status.bot_token,
              baseUrl: status.baseurl ?? '',
              userId: status.ilink_user_id,
            })
            syncCccBridge(ctx, login.root)
            weixinLogins.delete(key)
            sendJson(res, 200, { status: 'confirmed', accountId, tokenSaved: true })
            return
          }
          case 'expired':
            weixinLogins.delete(key)
            sendJson(res, 200, { status: 'expired' })
            return
          default:
            sendJson(res, 200, { status: status.status ?? 'wait' })
            return
        }
      } catch (err: any) {
        sendJson(res, 400, { error: err.message ?? String(err) })
      }
    },
  })

  // ── 旧会话清理（v1.29 需求③，S142 用户拍板：lastActive 基准 + 手动按钮 + 直接物理删）──
  // GET  → 预览（dryRun：列出将删会话，不删）
  // POST { action:'cleanup', olderThanDays } → 执行物理删（x-serenity-ui 头限定——WebUI 按钮）
  const SESSION_CLEANUP_PATH = '/serenity/session-cleanup'
  ctx.webServer.register({
    kind: 'exact',
    path: SESSION_CLEANUP_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const daysParam = Number(url.searchParams.get('olderThanDays') ?? '30')
        const days = Number.isFinite(daysParam) && daysParam >= 1 ? daysParam : 30
        // live 会话保护：删除前取当前 live id 集合（安全底线——绝不动正在跑的会话）
        // 🔴 2026-09-25 走收口层（F-06 残留收敛）：原先直接 `ctx.get('sessions')`，
        //    绕过了 `host/access` 的**唯一读取入口**（该层会吞掉 getter 抛错 ⇒ 失败模式一致为"缺失"）。
        //    行为无影响：`sessions` 是 injected 服务 ⇒ `hostSessions` 先属性读、再回落 `ctx.get`（超集）。
        const sessions = hostSessions(ctx)
        const liveIds = new Set<string>()
        if (sessions?.list) {
          for (const s of sessions.list()) {
            const id = s.id ?? s.header?.id
            if (id) liveIds.add(id)
          }
        }
        const { sessionsRootDir, collectEligibleSessions, performCleanup, cutoffDaysAgo } = await import('./session-cleanup.js')
        const root = sessionsRootDir()

        if (req.method === 'GET') {
          const { candidates } = performCleanup(root, cutoffDaysAgo(days), liveIds, { dryRun: true })
          sendJson(res, 200, {
            root,
            olderThanDays: days,
            dryRun: true,
            count: candidates.length,
            candidates: candidates.map((c) => ({
              id: c.id,
              project: c.project,
              lastActive: isoLocal(c.lastActiveMs),
            })),
          })
          return
        }

        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        if (!requireWebUi(req, res, '会话清理仅限 WebUI（client 专用）')) return
        const { result } = performCleanup(root, cutoffDaysAgo(days), liveIds)
        sendJson(res, 200, {
          root,
          olderThanDays: days,
          dryRun: false,
          deleted: result!.deleted,
          errors: result!.errors,
        })
      } catch (err: any) {
        sendJson(res, 400, { error: err.message ?? String(err) })
      }
    },
  })
}

// ── 微信桥（F4c-3，v1.27.0 实验性；CCC 级配置——显式 ccc 参数）──

/** 进行中的扫码登录（loginKey → 状态；进程内，5min 有效） */
const weixinLogins = new Map<string, {
  root: string
  qrcode: string
  startedAt: number
  polling: boolean
}>()

const WEIXIN_LOGIN_TTL_MS = 5 * 60_000

/** 校验微信桥面板操作的头/参数（x-serenity-ui + ccc 必填） */
function requireCcc(root: string | undefined): { ok: true; root: string } | { ok: false; error: string } {
  if (!root || root.trim() === '') return { ok: false, error: 'missing ccc param' }
  const serenityRoot = cccRootForCwd(root)
  if (!serenityRoot) return { ok: false, error: `no CCC found from: ${root}` }
  return { ok: true, root: serenityRoot }
}
