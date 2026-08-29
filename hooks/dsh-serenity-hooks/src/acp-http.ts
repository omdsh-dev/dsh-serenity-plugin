/**
 * acp-http.ts — ACP HTTP JSON-RPC + 建议问答页（F4c/F4d，v1.26.x 实验性）
 *
 * node:http 服务（默认关，仅监听 127.0.0.1；启停 = 人工——设置面板「Serenity」
 * 页 ACP 区块开关 / 问答页开关，不随插件加载自动启动；仿 skiff 调试服务模式）。
 *
 * - POST /          → JSON-RPC 2.0 单帧/批处理（acpEnabled 门控；ACP 程序化面）
 * - GET  /          → 容器列表页（publicAskEnabled 门控；v1.26.2：只列已开放容器）
 * - GET  /c/<name>  → 单容器问答页（v1.26.2：URL 体现容器名，用户只输 key）
 * - POST /c/<name>/ask → 该容器问答（key 校验 + allowed 白名单校验）
 * - POST /ask       → 兼容旧形态 { key, ccc, ... }（key 校验 + allowed 校验）
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
import {
  verifyPublicAskKey,
  ensurePublicAskKey,
  readAdvancedSettings,
  isPublicAskIpLocked,
  recordPublicAskFail,
  resetPublicAskIpFail,
} from './config-ops.js'
import { readSkiffRoles } from './skiff-role.js'
import { discoverCccs, renderSkiffMarkdown, jscSafeJsonText, type SkiffCccEntry } from './skiff-debug.js'
import { readSimpleSettings } from './settings-section.js'
import { createSkiffAgent, askSkiff, getSkiffAgent, skiffSessionInfo } from './skiff-core.js'
import { readHandymanConfig, findSerenityRoot } from './ccc.js'

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
  // v1.26.9：jscSafeJsonText 消除 Safari/JSC JSON.parse 快速路径正则对原始
  // \u2028/\u2029/\uFEFF 的误抛（WebKit bug 200190）——文本层等价转义，parse 后语义不变
  const body = jscSafeJsonText(JSON.stringify(payload))
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(html)
}

/**
 * 启动 ACP HTTP JSON-RPC + 建议问答页服务（单实例；重复启动幂等返回既有实例）。
 * @param ctx 插件上下文（AcpServer 内部经 skiff-core 创建 agent）
 * @param port 监听端口（仅 127.0.0.1）
 * @param defaultRoot 默认 CCC 根（问答页候选发现兜底；resolveSkiffRoot 传入）
 */
export async function startAcpHttpServer(ctx: Context, port: number, defaultRoot?: string): Promise<void> {
  if (active) return
  const server = createServer((req, res) => {
    void handle(ctx, defaultRoot ?? '', req, res)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  active = { server, port }
  const s = readSimpleSettings()
  const faces: string[] = []
  if (s.acpEnabled) faces.push('JSON-RPC')
  if (s.publicAskEnabled) faces.push('问答页(key 认证)')
  console.log(`[serenity-hooks] ✓ ACP HTTP: http://127.0.0.1:${port}（${faces.join(' + ') || '未开启任何面'}；session/new 支持 {ccc, role, sessionId?}）`)
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

async function handle(ctx: Context, defaultRoot: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = (req.url ?? '/').split('?')[0] ?? '/'
    const s = readSimpleSettings()
    // v1.26.5 请求来源 IP（公网 key 失败锁定）：X-Forwarded-For 优先（反代/tunnel），回退 socket 地址
    const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown'

    // ── ACP JSON-RPC（acpEnabled 门控）──
    if (req.method === 'POST' && url === '/') {
      if (!s.acpEnabled) {
        sendJson(res, 403, { error: 'ACP JSON-RPC disabled (enable in Serenity settings)' })
        return
      }
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

    // ── 建议问答页（F4d，publicAskEnabled 门控）──
    if (!s.publicAskEnabled) {
      // 关闭时：页面路由渲染未启用提示页；/ask 返回 403
      if (req.method === 'GET' && (url === '/' || url.startsWith('/c/'))) {
        sendHtml(res, publicAskDisabledHtml())
        return
      }
      if (req.method === 'POST' && (url === '/ask' || url.startsWith('/c/'))) {
        sendJson(res, 403, { error: 'public ask disabled (enable in Serenity settings)' })
        return
      }
      sendJson(res, 404, { error: 'not found' })
      return
    }

    // 容器白名单判定（v1.26.2）：allowed 空 = 全部开放；非空 = 容器名必须在白名单
    const containerAllowed = (name: string): boolean => {
      const allowed = readAdvancedSettings().publicAsk.allowed
      return allowed.length === 0 || allowed.includes(name)
    }

    // GET /c/<name> → 单容器问答页（URL 体现容器名，用户只输 key）
    const cMatch = /^\/c\/([^/]+)$/.exec(url)
    if (req.method === 'GET' && cMatch) {
      const name = decodeURIComponent(cMatch[1] ?? '')
      const cccs = await discoverCccs(ctx, defaultRoot || (findSerenityRoot(process.cwd()) ?? ''))
      const ccc = cccs.find((c) => c.name === name)
      if (!ccc) {
        sendHtml(res, publicAskContainerUnknownHtml(name))
        return
      }
      if (!containerAllowed(name)) {
        sendHtml(res, publicAskContainerClosedHtml(name))
        return
      }
      sendHtml(res, publicAskContainerPage(ccc))
      return
    }

    // GET / → 容器列表页（只列已开放容器，链接到 /c/<name>）
    if (req.method === 'GET' && url === '/') {
      const cccs = await discoverCccs(ctx, defaultRoot || (findSerenityRoot(process.cwd()) ?? ''))
      const open = cccs.filter((c) => containerAllowed(c.name))
      sendHtml(res, publicAskListPage(open))
      return
    }

    // POST /c/<name>/ask → 该容器问答（allowed + key 校验）
    const aMatch = /^\/c\/([^/]+)\/ask$/.exec(url)
    if (req.method === 'POST' && aMatch) {
      const name = decodeURIComponent(aMatch[1] ?? '')
      const cccs = await discoverCccs(ctx, defaultRoot || (findSerenityRoot(process.cwd()) ?? ''))
      const ccc = cccs.find((c) => c.name === name)
      if (!ccc || !containerAllowed(name)) {
        sendJson(res, 403, { error: `container "${name}" is not open for public ask` })
        return
      }
      let body: Record<string, unknown>
      try {
        const parsed = JSON.parse(await readBody(req)) as unknown
        if (parsed === null || typeof parsed !== 'object') throw new Error('not an object')
        body = parsed as Record<string, unknown>
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' })
        return
      }
      await handleAskParsed(ctx, ccc, body, res, ip)
      return
    }

    // POST /ask → 兼容旧形态（{ key, ccc, ... }；ccc 也做白名单校验）
    if (req.method === 'POST' && url === '/ask') {
      let body: Record<string, unknown>
      try {
        const parsed = JSON.parse(await readBody(req)) as unknown
        if (parsed === null || typeof parsed !== 'object') throw new Error('not an object')
        body = parsed as Record<string, unknown>
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' })
        return
      }
      const cccValue = typeof body.ccc === 'string' && body.ccc !== '' ? body.ccc : undefined
      const nameValue = typeof body.name === 'string' && body.name !== '' ? body.name : undefined
      let ccc: SkiffCccEntry | undefined
      if (nameValue) {
        const cccs = await discoverCccs(ctx, defaultRoot || (findSerenityRoot(process.cwd()) ?? ''))
        ccc = cccs.find((c) => c.name === nameValue)
      } else if (cccValue) {
        // 兼容旧 ccc=root 路径：按 root 匹配
        const cccs = await discoverCccs(ctx, defaultRoot || (findSerenityRoot(process.cwd()) ?? ''))
        ccc = cccs.find((c) => c.root === cccValue)
        // root 不在发现列表（如未挂工作区）→ 允许按 root 直接构造（白名单按目录名判定）
        if (!ccc && cccValue !== '') {
          const nm = cccValue.split('/').filter(Boolean).pop() ?? cccValue
          ccc = { root: cccValue, name: nm, roles: [...readSkiffRoles(cccValue).keys()] }
        }
      }
      if (!ccc || !containerAllowed(ccc.name)) {
        sendJson(res, 403, { error: 'container is not open for public ask' })
        return
      }
      await handleAskParsed(ctx, ccc, body, res, ip)
      return
    }
    sendJson(res, 404, { error: 'not found' })
  } catch (err) {
    sendJson(res, 500, { error: (err as Error)?.message ?? String(err) })
  }
}

/**
 * 单容器问答核心（/c/<name>/ask 与 /ask 共用）：
 * body { key, role?, question, sessionId? } → key 校验（401 + IP 失败锁定）→ 角色缺省取 CCC 第一个
 * → 会话延续（v1.25.10 语义，静默新建）→ askSkiff(0 全量轨迹) → { answer, answer_html, sessionId, continued, trajectory }
 * @param ip 请求来源 IP（v1.26.5 公网 key 失败锁定：X-Forwarded-For 优先——公网反代，回退 remoteAddress）
 */
async function handleAskParsed(
  ctx: Context,
  ccc: SkiffCccEntry,
  body: Record<string, unknown>,
  res: ServerResponse,
  ip: string,
): Promise<void> {
  const key = typeof body.key === 'string' ? body.key : undefined
  // v1.26.5 公网 key 失败锁定（先查锁定——锁定期间直接 429，不浪费校验）
  if (isPublicAskIpLocked(ip)) {
    sendJson(res, 429, { error: 'too many failed attempts — temporarily locked (retry later)' })
    return
  }
  // key 认证（S142 用户：没有 key 不工作；timing-safe）
  if (!verifyPublicAskKey(key)) {
    const remaining = recordPublicAskFail(ip)
    sendJson(res, remaining > 0 ? 429 : 401, {
      error: remaining > 0
        ? `too many failed attempts — locked for ${Math.ceil(remaining / 60000)} min`
        : 'invalid or missing key',
    })
    return
  }
  // 成功 → 重置该 IP 失败计数（v1.26.5：防止历史失败累计误锁）
  resetPublicAskIpFail(ip)
  const root = ccc.root
  const roleName = typeof body.role === 'string' && body.role !== '' ? body.role : undefined
  const question = typeof body.question === 'string' ? body.question : ''
  const sessionId = typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : undefined
  if (!question.trim()) {
    sendJson(res, 400, { error: 'empty question' })
    return
  }
  const roles = readSkiffRoles(root)
  // 角色缺省 → 该 CCC 第一个角色（简单问答页不要求用户懂角色）
  const explicit = roleName ? roles.get(roleName) : undefined
  const effectiveRole = (roleName && explicit ? roleName : roles.keys().next().value) as string | undefined
  const effectiveCfg = (roleName && explicit ? explicit : (effectiveRole ? roles.get(effectiveRole) : undefined)) ?? undefined
  if (!effectiveRole || !effectiveCfg) {
    sendJson(res, 400, { error: `no skiff role available in ccc: ${root}` })
    return
  }
  // 会话延续（复用 v1.25.10 语义）：sessionId 命中 + 绑定校验；缺省新建
  let agent: Awaited<ReturnType<typeof createSkiffAgent>>['agent'] | undefined
  let continued = false
  if (sessionId) {
    const info = skiffSessionInfo(sessionId)
    const live = getSkiffAgent(sessionId)
    if (info && live && info.role === effectiveRole && info.ccc === root) {
      agent = live
      continued = true
    }
    // 不匹配/不可恢复 → 静默新建（问答页对普通用户友好，不暴露 400 细节）
  }
  if (!agent) {
    const hc = readHandymanConfig(root)
    const ref = await createSkiffAgent(ctx, root, effectiveRole, effectiveCfg, hc?.defaultModel)
    agent = ref.agent
  }
  const result = await askSkiff(ctx, agent, question, 0)
  sendJson(res, 200, {
    answer: result.answer,
    // v1.26.4：public 口不渲染 <think>（思考过程对普通用户不展示；skiff 调试页保持折叠卡）
    answer_html: renderSkiffMarkdown(result.answer, true),
    sessionId: result.sessionId,
    continued,
    trajectory: result.trajectory,
  })
}

/** 问答页未启用提示页 */
function publicAskDisabledHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><title>Serenity Public Ask</title></head>
<body style="font-family:system-ui;padding:48px;text-align:center;color:#57606a">
<h2>Serenity Public Ask</h2>
<p>问答页未启用（请在 dsh 设置面板「Serenity」页开启「建议问答」）。</p>
</body></html>`
}

/** 容器不存在提示页（URL 容器名不在已发现 CCC 中） */
function publicAskContainerUnknownHtml(name: string): string {
  return `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><title>Serenity Public Ask</title></head>
<body style="font-family:system-ui;padding:48px;text-align:center;color:#57606a">
<h2>Serenity Public Ask</h2>
<p>认知容器「${name}」不存在。</p>
<p style="font-size:13px"><a href="/" style="color:#0ba875">返回容器列表</a></p>
</body></html>`
}

/** 容器未开放提示页（白名单外） */
function publicAskContainerClosedHtml(name: string): string {
  return `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><title>Serenity Public Ask</title></head>
<body style="font-family:system-ui;padding:48px;text-align:center;color:#57606a">
<h2>Serenity Public Ask</h2>
<p>认知容器「${name}」当前未开放问答（管理员在设置面板「开放容器」中配置）。</p>
<p style="font-size:13px"><a href="/" style="color:#0ba875">返回容器列表</a></p>
</body></html>`
}

/** 页面基础样式（列表页 + 单容器页共用；v1.26.4 聊天 UI） */
const ASK_CSS = `
  :root { color-scheme: light dark; --sp-green: #0ba875; --sp-green-dim: #059669; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; background: #f6f7f9; color: #1f2328; }
  @media (prefers-color-scheme: dark) { body { background: #16181c; color: #e6e6e6; } }
  main { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { opacity: .65; font-size: 13px; margin-bottom: 16px; }
  .card { background: #fff; border: 1px solid #d0d7de; border-radius: 10px; padding: 14px 16px; margin-bottom: 10px; display: block; text-decoration: none; color: inherit; }
  @media (prefers-color-scheme: dark) { .card { background: #26282c; border-color: #3a3d42; } }
  .card:hover { border-color: var(--sp-green); }
  .card .cname { font-weight: 600; font-size: 15px; }
  .card .cmeta { opacity: .6; font-size: 12px; margin-top: 2px; }
  .empty { text-align: center; opacity: .7; padding: 24px 0; }
  .ccname { font-weight: 600; color: var(--sp-green); }
  /* key 门（v1.26.6：选容器前必填） */
  .keyGate { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; background: rgba(127,127,127,.06); border: 1px solid rgba(127,127,127,.18); border-radius: 10px; padding: 10px 14px; }
  .keyGate label { font-size: 12px; opacity: .7; white-space: nowrap; }
  .keyGate input { flex: 1; border: 1px solid rgba(127,127,127,.25); border-radius: 8px; background: transparent; color: inherit; padding: 8px 12px; font-size: 14px; }
  .keyGate input:focus { outline: none; border-color: var(--sp-green); }

  /* ── 聊天布局（v1.26.4 体验升级：参考 ChatGPT/Claude 会话形态）── */
  .chat { display: flex; flex-direction: column; height: 100vh; max-width: 720px; margin: 0 auto; }
  .chatHead { display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-bottom: 1px solid rgba(127,127,127,.18); background: rgba(127,127,127,.04); position: sticky; top: 0; z-index: 5; }
  .chatHead .back { color: var(--sp-green); text-decoration: none; font-size: 13px; white-space: nowrap; }
  .chatHead .title { font-weight: 600; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chatHead .spacer { flex: 1; }
  .chatHead select { border: 1px solid rgba(127,127,127,.25); border-radius: 8px; background: transparent; color: inherit; padding: 4px 8px; font-size: 12px; }
  .chatHead .newBtn { border: 1px solid rgba(127,127,127,.25); border-radius: 8px; background: transparent; color: inherit; padding: 4px 10px; font-size: 12px; cursor: pointer; white-space: nowrap; }
  .chatHead .newBtn:hover { border-color: var(--sp-green); color: var(--sp-green); }
  /* 消息流 */
  .msgList { flex: 1; overflow-y: auto; padding: 18px 16px; display: flex; flex-direction: column; gap: 16px; }
  .msg { display: flex; flex-direction: column; max-width: 88%; }
  .msg.user { align-self: flex-end; align-items: flex-end; }
  .msg.assistant { align-self: flex-start; align-items: flex-start; }
  .msg .who { font-size: 11px; opacity: .55; margin-bottom: 4px; padding: 0 4px; }
  .msg .bubble { padding: 10px 14px; border-radius: 14px; font-size: 14px; line-height: 1.65; word-break: break-word; white-space: normal; }
  .msg.user .bubble { background: var(--sp-green); color: #fff; border-bottom-right-radius: 4px; }
  .msg.assistant .bubble { background: #fff; border: 1px solid #d0d7de; border-bottom-left-radius: 4px; }
  @media (prefers-color-scheme: dark) { .msg.assistant .bubble { background: #26282c; border-color: #3a3d42; } }
  .bubble p { margin: 6px 0; }
  .bubble p:first-child { margin-top: 0; }
  .bubble p:last-child { margin-bottom: 0; }
  .bubble h1, .bubble h2, .bubble h3, .bubble h4 { margin: 12px 0 6px; font-size: 15px; line-height: 1.4; }
  .bubble ul, .bubble ol { margin: 6px 0; padding-left: 22px; }
  .bubble code { background: rgba(127,127,127,.14); border-radius: 4px; padding: 1px 5px; font-size: 13px; font-family: ui-monospace, monospace; }
  .bubble pre { background: rgba(127,127,127,.1); border-radius: 8px; padding: 10px 12px; overflow-x: auto; margin: 8px 0; }
  .bubble pre code { background: none; padding: 0; }
  .bubble blockquote { margin: 6px 0; padding: 2px 12px; border-left: 3px solid rgba(127,127,127,.3); opacity: .85; }
  .bubble a { color: var(--sp-green); }
  .bubble table { border-collapse: collapse; margin: 8px 0; }
  .bubble th, .bubble td { border: 1px solid rgba(127,127,127,.25); padding: 4px 10px; font-size: 13px; }
  .bubble img { max-width: 100%; border-radius: 8px; }
  .bubble hr { border: 0; border-top: 1px solid rgba(127,127,127,.2); margin: 10px 0; }
  .typing { display: inline-flex; align-items: center; gap: 4px; padding: 4px 2px; }
  .typing i { width: 6px; height: 6px; border-radius: 50%; background: rgba(127,127,127,.5); animation: blink 1.2s infinite; }
  .typing i:nth-child(2) { animation-delay: .2s; }
  .typing i:nth-child(3) { animation-delay: .4s; }
  @keyframes blink { 0%, 80%, 100% { opacity: .3 } 40% { opacity: 1 } }
  .err { color: #cf222e; white-space: pre-wrap; font-size: 13px; }
  .msg .err { padding: 0 4px; }
  /* 输入区 */
  .chatInput { border-top: 1px solid rgba(127,127,127,.18); padding: 10px 16px calc(12px + env(safe-area-inset-bottom)); background: rgba(127,127,127,.04); }
  .inputRow { display: flex; align-items: flex-end; gap: 8px; }
  .inputRow textarea { flex: 1; border: 1px solid rgba(127,127,127,.25); border-radius: 12px; background: #fff; color: inherit; padding: 10px 12px; font-size: 14px; resize: none; min-height: 44px; max-height: 140px; line-height: 1.5; }
  @media (prefers-color-scheme: dark) { .inputRow textarea { background: #26282c; border-color: #3a3d42; } }
  .inputRow textarea:focus { outline: none; border-color: var(--sp-green); }
  .inputRow .sendBtn { border: 0; border-radius: 12px; background: var(--sp-green); color: #fff; padding: 10px 18px; font-size: 14px; font-weight: 600; cursor: pointer; white-space: nowrap; }
  .inputRow .sendBtn:disabled { opacity: .5; cursor: wait; }
  .inputRow .sendBtn:hover:not(:disabled) { background: var(--sp-green-dim); }
  .hint { text-align: center; font-size: 12px; opacity: .55; padding: 20px 0; }

  /* ── 移动端适配（v1.26.6：手机/平板——iOS 防放大 16px / 触控 ≥44px / 100dvh / safe-area）── */
  @media (max-width: 640px) {
    main { padding: 20px 16px calc(28px + env(safe-area-inset-bottom)); }
    .sub { font-size: 14px; margin-bottom: 14px; }
    .keyGate { flex-wrap: wrap; gap: 6px; }
    .keyGate input { flex: 1 1 100%; font-size: 16px; padding: 12px 14px; min-height: 48px; } /* 16px 防 iOS 聚焦放大 + 触控 ≥44px */
    .card { padding: 16px; border-radius: 12px; }
    .card .cname { font-size: 16px; }
    .card .cmeta { font-size: 13px; }
    .chat { height: 100vh; height: 100dvh; } /* dvh：iOS 地址栏收起/展开不跳动 */
    .chatHead { gap: 8px; padding: 8px 12px calc(8px + env(safe-area-inset-top)); }
    .chatHead .back { font-size: 14px; padding: 10px 4px; } /* 触控目标 ≥44px */
    .chatHead .title { font-size: 14px; }
    .chatHead select { font-size: 16px; padding: 8px 6px; min-height: 44px; } /* 16px 防放大 + 触控 */
    .chatHead .newBtn { font-size: 14px; padding: 10px 12px; min-height: 44px; }
    .msgList { padding: 14px 12px calc(20px + env(safe-area-inset-bottom)); gap: 14px; }
    .msg { max-width: 94%; }
    .msg .bubble { font-size: 15px; padding: 12px 14px; }
    .msg .who { font-size: 12px; }
    .chatInput { padding: 8px 12px calc(10px + env(safe-area-inset-bottom)); }
    .inputRow textarea { font-size: 16px; padding: 12px 14px; min-height: 48px; } /* 16px 防放大 + 触控 */
    .inputRow .sendBtn { font-size: 16px; padding: 12px 20px; min-height: 48px; }
  }
`


/** 容器列表页（v1.26.2 → v1.26.6）：key 在选容器前填写（v1.26.6 用户拍板：不填 key 不让选容器） */
function publicAskListPage(cccs: Array<{ root: string; name: string; roles: string[] }>): string {
  const cards = cccs.map((c) => `
    <a class="card" data-name="${c.name}" href="/c/${encodeURIComponent(c.name)}">
      <div class="cname">${c.name}</div>
      <div class="cmeta">${c.roles.length} 个问答角色 · 点击进入</div>
    </a>`).join('') || '<div class="empty">暂无可问答的认知容器（管理员尚未开放）</div>'
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Serenity Public Ask</title>
<style>${ASK_CSS}</style>
</head>
<body>
<main>
  <h1>Serenity Public Ask</h1>
  <div class="sub">先填写访问 key，再选择认知容器开始提问</div>
  <div class="keyGate">
    <label for="gateKey">访问 Key</label>
    <input id="gateKey" type="password" placeholder="请输入访问 key（仅本次浏览器记忆）" autocomplete="off" autocapitalize="none" enterkeyhint="done">
  </div>
  <div id="cards">${cards}</div>
</main>
<script>
const KEY_STORE = 'serenity-public-ask-key'
const gateKey = document.getElementById('gateKey')
const cardList = document.getElementById('cards')
// 容器卡片（key 未填时禁用——v1.26.6 用户拍板：key 在选容器前填写）
function applyGate() {
  const ok = gateKey.value.trim().length > 0
  for (const card of cardList.querySelectorAll('a.card')) {
    card.classList.toggle('locked', !ok)
    card.setAttribute('aria-disabled', ok ? 'false' : 'true')
    if (!ok) { card.removeAttribute('href'); card.style.pointerEvents = 'none'; card.style.opacity = '.4' }
    else { card.setAttribute('href', '/c/' + encodeURIComponent(card.dataset.name)); card.style.pointerEvents = ''; card.style.opacity = '' }
  }
}
gateKey.addEventListener('input', () => {
  // 即存 localStorage（v1.26.7 修复：v1.26.6 漏掉保存——填一次就记录，对话页读取）
  try { localStorage.setItem(KEY_STORE, gateKey.value.trim()) } catch {}
  applyGate()
})
// key 自动从 localStorage 恢复
let hasSavedKey = false
try { const saved = localStorage.getItem(KEY_STORE); if (saved) { gateKey.value = saved; hasSavedKey = true } } catch {}
if (hasSavedKey) gateKey.placeholder = '访问 Key（已记忆，可修改）'
applyGate()
gateKey.focus()
</script>
</body>
</html>`
}

/** 单容器问答页（v1.26.2→v1.26.6）：URL 锁定容器；聊天 UI——消息流 + 连续对话 + key 从列表页记忆（v1.26.6 用户拍板：对话页不再填 key） */
function publicAskContainerPage(ccc: { root: string; name: string; roles: string[] }): string {
  const data = jscSafeJsonText(JSON.stringify({ name: ccc.name, root: ccc.root, roles: ccc.roles }).replace(/</g, '\\u003c'))
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Serenity · ${ccc.name}</title>
<style>${ASK_CSS}</style>
</head>
<body>
<div class="chat">
  <div class="chatHead">
    <a class="back" href="/">← 容器</a>
    <span class="title">Serenity · <span class="ccname">${ccc.name}</span></span>
    <span class="spacer"></span>
    <select id="role" title="问答角色"></select>
    <button id="newChat" class="newBtn" title="清空当前对话（不存储，刷新即失）">新对话</button>
  </div>

  <div id="msgs" class="msgList"></div>

  <div class="chatInput">
    <div class="inputRow">
      <textarea id="q" placeholder="向 ${ccc.name} 提问…（Enter 发送，Shift+Enter 换行）" rows="1" enterkeyhint="send" autocapitalize="sentences"></textarea>
      <button id="ask" class="sendBtn">发送</button>
    </div>
  </div>
</div>
<script id="ask-data" type="application/json">${data}</script>
<script>
const CCC = JSON.parse(document.getElementById('ask-data').textContent)
const KEY_STORE = 'serenity-public-ask-key'
const roleSel = document.getElementById('role')
const btn = document.getElementById('ask')
const msgs = document.getElementById('msgs')
const qInput = document.getElementById('q')
let sessionId = ''
let busy = false

// 角色下拉
roleSel.innerHTML = (CCC.roles || []).map((r) => '<option value="' + r + '">' + r + '</option>').join('') || '<option value="">(无角色)</option>'
// key 从 localStorage 读取（列表页填写时记忆；对话页不填——v1.26.6 用户拍板）
function getStoredKey() {
  try { return (localStorage.getItem(KEY_STORE) || '').trim() } catch { return '' }
}

/** 追加一条消息气泡（role: user|assistant） */
function addMsg(role, htmlOrText, isHtml) {
  const m = document.createElement('div')
  m.className = 'msg ' + role
  const who = document.createElement('div')
  who.className = 'who'
  who.textContent = role === 'user' ? '你' : CCC.name
  const bubble = document.createElement('div')
  bubble.className = 'bubble'
  if (isHtml) bubble.innerHTML = htmlOrText
  else bubble.textContent = htmlOrText
  m.appendChild(who)
  m.appendChild(bubble)
  msgs.appendChild(m)
  msgs.scrollTop = msgs.scrollHeight
  return bubble
}

/** 打字指示器（等待回答时显示） */
function addTyping() {
  const m = document.createElement('div')
  m.className = 'msg assistant'
  const who = document.createElement('div')
  who.className = 'who'
  who.textContent = CCC.name
  const bubble = document.createElement('div')
  bubble.className = 'bubble'
  bubble.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>'
  m.appendChild(who)
  m.appendChild(bubble)
  msgs.appendChild(m)
  msgs.scrollTop = msgs.scrollHeight
  return bubble
}

async function ask() {
  const q = qInput.value.trim()
  const key = getStoredKey()
  const role = roleSel.value || undefined
  if (!q) return
  if (!key) { addMsg('assistant', '⚠️ 未找到访问 key，请先回到 <a href="/">容器列表页</a> 填写 key。', true); return }
  if (busy) return
  // 追加用户消息 + 打字指示
  addMsg('user', q, false)
  qInput.value = ''
  autoGrow()
  const typing = addTyping()
  busy = true
  btn.disabled = true
  try {
    const res = await fetch('/c/' + encodeURIComponent(CCC.name) + '/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, role, question: q, sessionId: sessionId || undefined }) })
    const data = await res.json()
    typing.remove() // 移除打字指示，替换为真实回答
    if (!res.ok) {
      sessionId = ''
      addMsg('assistant', '⚠️ ' + (data.error || ('HTTP ' + res.status)), true)
      return
    }
    addMsg('assistant', data.answer_html || data.answer || '（空回答）', true)
    sessionId = data.sessionId || ''
  } catch (err) {
    typing.remove()
    addMsg('assistant', '⚠️ ' + String(err.message || err), true)
  } finally {
    busy = false
    btn.disabled = false
    qInput.focus()
  }
}

function autoGrow() {
  qInput.style.height = 'auto'
  qInput.style.height = Math.min(qInput.scrollHeight, 140) + 'px'
}

btn.addEventListener('click', () => void ask())
qInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask() }
})
qInput.addEventListener('input', autoGrow)
// 新对话：重置 sessionId + 清空消息流（前端内存，不存储——刷新即失）
document.getElementById('newChat').addEventListener('click', () => {
  sessionId = ''
  msgs.innerHTML = ''
  qInput.focus()
})

// 初始欢迎消息（外层模板求值注入容器名；textContent 渲染防注入）
addMsg('assistant', '你好，我是「${ccc.name}」的认知助手。有什么可以帮你的？（本对话仅当前页面有效，刷新即失）', false)
qInput.focus()
</script>
</body>
</html>`
}
