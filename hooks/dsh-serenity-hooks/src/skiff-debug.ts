/**
 * skiff-debug.ts — Skiff 调试问答页（F4a'，v1.25.0 实验性）
 *
 * node:http 调试端口（默认关，仅监听 127.0.0.1；启停 = 人工——设置面板「Serenity」
 * 页 Skiff 区块开关，不随插件加载自动启动）。
 *
 * - GET  /        → 问答 HTML 页（角色下拉 + 输入框 + 答案区 + 轨迹区 + WebUI 链接）
 * - POST /ask     → {role, question} → 走会话核心（skiff-core）→ {answer, sessionId, trajectory}
 *
 * 与 ACP stdio 协议（F4c 后续）共用同一会话核心（createSkiffAgent + askSkiff），
 * 协议层后加不返工。轨迹 = session.events 结构化返回（与 dsh WebUI 同源数据），
 * 页面 JS 渲染成对话时间线；同时保留原生 WebUI 会话链接供完整交互。
 *
 * 实验性质：未开启时零资源占用（无监听、无 agent 创建）。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Context } from 'cordis'
import { readSkiffRoles } from './skiff-role.js'
import { createSkiffAgent, askSkiff, type SkiffTrajectoryEntry } from './skiff-core.js'
import { readHandymanConfig } from './ccc.js'

/** 运行中的调试服务（单实例；进程级） */
let active: { server: ReturnType<typeof createServer>; port: number } | null = null

export function skiffDebugActive(): boolean {
  return active !== null
}

export function skiffDebugPort(): number | null {
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

/** 问答页 HTML：角色下拉 + 输入 + 答案区 + 轨迹区（JS 渲染）+ 绑定的 CCC + WebUI 链接 */
export function skiffDebugPage(roles: Map<string, { model?: string }>, cccRoot: string, webPort: number): string {
  const roleOptions = [...roles.entries()]
    .map(([name, r]) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}${r.model ? ` (${escapeHtml(r.model)})` : ''}</option>`)
    .join('\n')
  const webUrl = `http://127.0.0.1:${webPort}`
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Skiff Debug — CCC cognitive subset roles</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 24px; background: #f6f7f9; color: #1f2328; }
  @media (prefers-color-scheme: dark) { body { background: #1a1b1e; color: #e6e6e6; } }
  main { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { opacity: .65; font-size: 13px; margin-bottom: 16px; }
  .ccc { display: inline-block; padding: 3px 10px; border-radius: 999px; background: rgba(11,168,117,.12); color: #0ba875; font-size: 12px; font-weight: 600; margin-bottom: 12px; word-break: break-all; }
  @media (prefers-color-scheme: dark) { .ccc { color: #3ddc9a; } }
  label { font-size: 13px; font-weight: 600; display: block; margin: 12px 0 4px; }
  select, textarea { width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 8px; border: 1px solid #d0d7de; background: #fff; color: inherit; font-size: 14px; }
  @media (prefers-color-scheme: dark) { select, textarea { background: #26282c; border-color: #3a3d42; } }
  textarea { min-height: 72px; resize: vertical; }
  button { margin-top: 12px; padding: 9px 18px; border-radius: 8px; border: 0; background: #0ba875; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: .55; cursor: wait; }
  #answer { white-space: pre-wrap; background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 12px; margin-top: 16px; font-size: 14px; line-height: 1.55; min-height: 48px; }
  @media (prefers-color-scheme: dark) { #answer { background: #26282c; border-color: #3a3d42; } }
  #trajectory { margin-top: 12px; font-size: 13px; }
  .t-entry { border-left: 2px solid #d0d7de; padding: 6px 10px; margin: 6px 0; border-radius: 0 6px 6px 0; background: rgba(127,127,127,.06); white-space: pre-wrap; word-break: break-word; }
  .t-user { border-left-color: #0ba875; }
  .t-tool { border-left-color: #d29922; opacity: .85; font-family: ui-monospace, monospace; font-size: 12px; }
  .t-role { font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; opacity: .6; margin-bottom: 2px; }
  .muted { opacity: .6; font-size: 13px; }
  a { color: #0ba875; }
  .err { color: #cf222e; white-space: pre-wrap; }
</style>
</head>
<body>
<main>
  <h1>Skiff Debug</h1>
  <div class="sub">宁静号 trajectory 子集角色问答页（v1.25.2 实验性）— 走 DSH agent-loop 会话核心，轨迹与 WebUI 同源</div>
  <div class="ccc">CCC: ${escapeHtml(cccRoot)}</div>
  <label for="role">角色</label>
  <select id="role">${roleOptions || '<option value="">(未配置角色)</option>'}</select>
  <label for="q">问题</label>
  <textarea id="q" placeholder="向该角色提问…"></textarea>
  <button id="ask">提问</button>
  <div id="answer" class="muted">等待提问…</div>
  <div id="trajectory"></div>
  <p class="muted"><a href="${webUrl}" target="_blank" rel="noopener">在 dsh WebUI 查看完整会话</a>（会话列表搜索 sessionId；WebUI 有完整交互）</p>
</main>
<script>
const btn = document.getElementById('ask')
const answer = document.getElementById('answer')
const traj = document.getElementById('trajectory')
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
btn.addEventListener('click', async () => {
  const role = document.getElementById('role').value
  const q = document.getElementById('q').value.trim()
  if (!role || !q) { answer.className = 'err'; answer.textContent = '请选择角色并输入问题'; return }
  btn.disabled = true
  answer.className = 'muted'
  answer.textContent = '运行中…'
  traj.innerHTML = ''
  try {
    const res = await fetch('/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, question: q }) })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status))
    answer.className = ''
    answer.textContent = data.answer || '（空回答）'
    renderTrajectory(data.trajectory || [], data.sessionId || '')
  } catch (err) {
    answer.className = 'err'
    answer.textContent = String(err.message || err)
  } finally {
    btn.disabled = false
  }
})
function renderTrajectory(entries, sessionId) {
  if (entries.length === 0) { traj.innerHTML = '<div class="muted">（本轮无轨迹）</div>'; return }
  traj.innerHTML = '<div class="sub">本轮轨迹 · ' + esc(sessionId) + '</div>' + entries.map((e) => {
    const cls = e.role === 'user' ? 't-user' : (e.role === 'tool' ? 't-tool' : '')
    const role = e.role === 'tool' ? 'tool' + (e.tool ? ' · ' + esc(e.tool) : '') : e.role
    return '<div class="t-entry ' + cls + '"><div class="t-role">' + role + '</div>' + esc(e.text) + '</div>'
  }).join('')
}
</script>
</body>
</html>`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
}

/**
 * 启动调试问答服务（单实例；重复启动幂等返回既有实例）。
 *
 * **CCC 绑定（v1.25.2 用户指出）**：服务绑定一个 CCC root（调用方 resolveSkiffRoot
 * 解析：live 会话中**含 skiff.roles 的 CCC 优先**）；角色配置**每次请求实时读取**
 * （不缓存快照）——改 .opencode/serenity.json 后刷新页面即生效，无需重启服务。
 * 页面顶部显示绑定的 CCC root，绑定可核对。
 *
 * @param root 绑定的 CCC 根（角色配置读取 + skiff agent cwd）
 * @param port 调试端口（仅 127.0.0.1）
 * @param webPort 主 WebUI 端口（WebUI 链接）
 */
export async function startSkiffDebugServer(ctx: Context, root: string, port: number, webPort: number): Promise<void> {
  if (active) return
  const server = createServer((req, res) => {
    void handle(ctx, root, webPort, req, res)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  active = { server, port }
  console.log(`[serenity-hooks] ✓ Skiff 调试问答页: http://127.0.0.1:${port}（CCC: ${root}，WebUI: ${webPort}）`)
}

export function stopSkiffDebugServer(): void {
  if (!active) return
  try {
    active.server.close()
  } catch {
    /* 关闭失败忽略 */
  }
  active = null
}

async function handle(
  ctx: Context,
  root: string,
  webPort: number,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const url = (req.url ?? '/').split('?')[0] ?? '/'
    if (req.method === 'GET' && url === '/') {
      // 实时读取角色（v1.25.2：不缓存快照——改配置刷新页面即生效）
      const roles = readSkiffRoles(root)
      sendHtml(res, skiffDebugPage(roles, root, webPort))
      return
    }
    if (req.method === 'POST' && url === '/ask') {
      let body: { role?: unknown; question?: unknown }
      try {
        const parsed = JSON.parse(await readBody(req)) as unknown
        if (parsed === null || typeof parsed !== 'object') throw new Error('not an object')
        body = parsed as { role?: unknown; question?: unknown }
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' })
        return
      }
      const roleName = typeof body.role === 'string' ? body.role : ''
      const question = typeof body.question === 'string' ? body.question : ''
      const roles = readSkiffRoles(root)
      const role = roles.get(roleName)
      if (!roleName || !role) {
        sendJson(res, 400, { error: `unknown role: ${roleName}` })
        return
      }
      if (!question.trim()) {
        sendJson(res, 400, { error: 'empty question' })
        return
      }
      const hc = readHandymanConfig(root)
      const ref = await createSkiffAgent(ctx, root, roleName, role, hc?.defaultModel)
      const result = await askSkiff(ctx, ref.agent, question)
      sendJson(res, 200, { answer: result.answer, sessionId: result.sessionId, trajectory: result.trajectory })
      return
    }
    sendJson(res, 404, { error: 'not found' })
  } catch (err) {
    sendJson(res, 500, { error: (err as Error)?.message ?? String(err) })
  }
}

/** 导出类型引用（测试断言轨迹结构） */
export type { SkiffTrajectoryEntry }
