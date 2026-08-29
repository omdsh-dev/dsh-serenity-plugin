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
import { verifyPublicAskKey, ensurePublicAskKey, readAdvancedSettings } from './config-ops.js'
import { readSkiffRoles } from './skiff-role.js'
import { discoverCccs, renderSkiffMarkdown, type SkiffCccEntry } from './skiff-debug.js'
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
  const body = JSON.stringify(payload)
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
      await handleAskParsed(ctx, ccc, body, res)
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
      await handleAskParsed(ctx, ccc, body, res)
      return
    }
    sendJson(res, 404, { error: 'not found' })
  } catch (err) {
    sendJson(res, 500, { error: (err as Error)?.message ?? String(err) })
  }
}

/**
 * 单容器问答核心（/c/<name>/ask 与 /ask 共用）：
 * body { key, role?, question, sessionId? } → key 校验（401）→ 角色缺省取 CCC 第一个
 * → 会话延续（v1.25.10 语义，静默新建）→ askSkiff(0 全量轨迹) → { answer, answer_html, sessionId, continued, trajectory }
 */
async function handleAskParsed(
  ctx: Context,
  ccc: SkiffCccEntry,
  body: Record<string, unknown>,
  res: ServerResponse,
): Promise<void> {
  const key = typeof body.key === 'string' ? body.key : undefined
  // key 认证（S142 用户：没有 key 不工作；timing-safe）
  if (!verifyPublicAskKey(key)) {
    sendJson(res, 401, { error: 'invalid or missing key' })
    return
  }
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
    answer_html: renderSkiffMarkdown(result.answer),
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

/** 页面基础样式（列表页 + 单容器页共用） */
const ASK_CSS = `
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 24px; background: #f6f7f9; color: #1f2328; }
  @media (prefers-color-scheme: dark) { body { background: #1a1b1e; color: #e6e6e6; } }
  main { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { opacity: .65; font-size: 13px; margin-bottom: 16px; }
  label { font-size: 13px; font-weight: 600; display: block; margin: 12px 0 4px; }
  input, select, textarea { width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 8px; border: 1px solid #d0d7de; background: #fff; color: inherit; font-size: 14px; }
  @media (prefers-color-scheme: dark) { input, select, textarea { background: #26282c; border-color: #3a3d42; } }
  textarea { min-height: 72px; resize: vertical; }
  button { margin-top: 12px; padding: 9px 18px; border-radius: 8px; border: 0; background: #0ba875; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: .55; cursor: wait; }
  .card { background: #fff; border: 1px solid #d0d7de; border-radius: 10px; padding: 14px 16px; margin-bottom: 10px; display: block; text-decoration: none; color: inherit; }
  @media (prefers-color-scheme: dark) { .card { background: #26282c; border-color: #3a3d42; } }
  .card:hover { border-color: #0ba875; }
  .card .cname { font-weight: 600; font-size: 15px; }
  .card .cmeta { opacity: .6; font-size: 12px; margin-top: 2px; }
  #answer { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 12px; margin-top: 16px; font-size: 14px; line-height: 1.6; min-height: 48px; word-break: break-word; }
  @media (prefers-color-scheme: dark) { #answer { background: #26282c; border-color: #3a3d42; } }
  #answer p { margin: 6px 0; }
  #answer h1, #answer h2, #answer h3 { margin: 12px 0 6px; font-size: 15px; }
  #answer code { background: rgba(127,127,127,.14); border-radius: 4px; padding: 1px 5px; font-size: 13px; font-family: ui-monospace, monospace; }
  #answer pre { background: rgba(127,127,127,.1); border-radius: 8px; padding: 10px 12px; overflow-x: auto; }
  #answer ul, #answer ol { margin: 6px 0; padding-left: 22px; }
  .err { color: #cf222e; white-space: pre-wrap; }
  .muted { opacity: .6; font-size: 13px; }
  details.think { margin: 8px 0; border: 1px solid rgba(210,153,34,.4); border-radius: 8px; background: rgba(210,153,34,.06); }
  details.think summary { cursor: pointer; padding: 6px 10px; font-size: 12px; color: #d29922; font-weight: 600; }
  .empty { text-align: center; opacity: .7; padding: 24px 0; }
  .back { display: inline-block; margin-bottom: 12px; font-size: 13px; color: #0ba875; text-decoration: none; }
  .ccname { font-weight: 600; color: #0ba875; }
`

/** 容器列表页（v1.26.2）：只列已开放容器，点击进入 /c/<name> */
function publicAskListPage(cccs: Array<{ root: string; name: string; roles: string[] }>): string {
  const cards = cccs.map((c) => `
    <a class="card" href="/c/${encodeURIComponent(c.name)}">
      <div class="cname">${c.name}</div>
      <div class="cmeta">${c.roles.length} 个问答角色 · 点击进入</div>
    </a>`).join('') || '<div class="empty">暂无可问答的认知容器（管理员尚未开放）</div>'
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Serenity Public Ask</title>
<style>${ASK_CSS}</style>
</head>
<body>
<main>
  <h1>Serenity Public Ask</h1>
  <div class="sub">选择认知容器开始提问（访问需 key，key 由管理员提供）</div>
  ${cards}
</main>
</body>
</html>`
}

/** 单容器问答页（v1.26.2）：URL 锁定容器，key + 角色；key 自动存 localStorage */
function publicAskContainerPage(ccc: { root: string; name: string; roles: string[] }): string {
  const data = JSON.stringify({ name: ccc.name, root: ccc.root, roles: ccc.roles }).replace(/</g, '\\u003c')
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Serenity Public Ask · ${ccc.name}</title>
<style>${ASK_CSS}</style>
</head>
<body>
<main>
  <a class="back" href="/">← 容器列表</a>
  <h1>Serenity Public Ask</h1>
  <div class="sub">认知容器：<span class="ccname">${ccc.name}</span></div>
  <label for="key">访问 Key</label>
  <input id="key" type="password" placeholder="请输入访问 key" autocomplete="off">
  <label for="role">问答角色</label>
  <select id="role"></select>
  <label for="q">问题</label>
  <textarea id="q" placeholder="向该认知容器提问…"></textarea>
  <button id="ask">提问</button>
  <div id="answer" class="muted">等待提问…</div>
</main>
<script id="ask-data" type="application/json">${data}</script>
<script>
const CCC = JSON.parse(document.getElementById('ask-data').textContent)
const KEY_STORE = 'serenity-public-ask-key'
const keyInput = document.getElementById('key')
const roleSel = document.getElementById('role')
const btn = document.getElementById('ask')
const answer = document.getElementById('answer')
let sessionId = ''
// 角色下拉（v1.26.2 用户：3100 应能选择角色）
roleSel.innerHTML = (CCC.roles || []).map((r) => '<option value="' + r + '">' + r + '</option>').join('') || '<option value="">(无角色)</option>'
// key 自动从 localStorage 恢复（v1.26.2：输入一次后浏览器记住，无需每次粘贴）
try { const saved = localStorage.getItem(KEY_STORE); if (saved) keyInput.value = saved } catch {}
btn.addEventListener('click', async () => {
  const q = document.getElementById('q').value.trim()
  const key = keyInput.value.trim()
  const role = roleSel.value || undefined
  if (!q) { answer.className = 'err'; answer.textContent = '请输入问题'; return }
  if (!key) { answer.className = 'err'; answer.textContent = '请输入访问 key（没有 key 无法使用）'; return }
  // 输入即记住（保存到 localStorage；下次自动填充）
  try { localStorage.setItem(KEY_STORE, key) } catch {}
  btn.disabled = true
  answer.className = 'muted'
  answer.textContent = '运行中…'
  try {
    const res = await fetch('/c/' + encodeURIComponent(CCC.name) + '/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, role, question: q, sessionId: sessionId || undefined }) })
    const data = await res.json()
    if (!res.ok) { sessionId = ''; throw new Error(data.error || ('HTTP ' + res.status)) }
    answer.className = ''
    answer.innerHTML = data.answer_html || data.answer || '（空回答）'
    sessionId = data.sessionId || ''
  } catch (err) {
    answer.className = 'err'
    answer.textContent = String(err.message || err)
  } finally {
    btn.disabled = false
  }
})
</script>
</body>
</html>`
}
