/**
 * skiff-debug.ts — Skiff 调试问答页（F4a'，v1.25.x 实验性）
 *
 * node:http 调试端口（默认关，仅监听 127.0.0.1；启停 = 人工——设置面板「Serenity」
 * 页 Skiff 区块开关，不随插件加载自动启动）。
 *
 * - GET  /        → 问答 HTML 页（**CCC 选择器** + 角色下拉 + 输入框 + 答案区 + 轨迹区 + WebUI 链接）
 * - POST /ask     → {ccc?, role, question} → 走会话核心（skiff-core）→ {answer, sessionId, trajectory}
 *
 * **多 CCC 手工切换（v1.25.4，S142 用户）**：dsh 管理多个 CCC 时，调试页顶部 CCC
 * 下拉列出全部候选（live 会话 cwd 上溯 .serenity 去重 + 默认绑定 root 兜底），
 * 切换后角色下拉联动（各 CCC 的 skiff.roles 实时读取），提问按所选 CCC 创建 agent。
 *
 * 与 ACP stdio 协议（F4c 后续）共用同一会话核心（createSkiffAgent + askSkiff），
 * 协议层后加不返工。轨迹 = session.events 结构化返回（与 dsh WebUI 同源数据），
 * 页面 JS 渲染成对话时间线；同时保留原生 WebUI 会话链接供完整交互。
 *
 * 实验性质：未开启时零资源占用（无监听、无 agent 创建）。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { basename } from 'node:path'
import type { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { marked } from 'marked'
import { readSkiffRoles } from './skiff-role.js'
import { createSkiffAgent, askSkiff, getSkiffAgent, skiffSessionInfo, unregisterSkiffSession, type SkiffTrajectoryEntry } from './skiff-core.js'
import { readHandymanConfig, findSerenityRoot } from './ccc.js'

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

/** 候选 CCC 条目（调试页 CCC 切换器数据） */
export interface SkiffCccEntry {
  /** CCC 根（绝对路径） */
  root: string
  /** 目录名（展示用） */
  name: string
  /** 该 CCC 的 skiff 角色名列表（实时读取） */
  roles: string[]
}

/**
 * 发现候选 CCC 列表（多 CCC 手工切换，v1.25.6）：
 * ① **dsh 工作区注册表**（workspaceRegistry.list，持久化——所有工作目录即使无 live 会话；
 *    S142 用户 2026-08-29：应直接拉 dsh 工作区，且只列具体 CCC）
 * ② **sessionPersistence 兜底**（持久化会话 headers——必装配服务，覆盖所有历史会话工作目录；
 *    用户实测 workspaceRegistry 拉取仍空时兜底）
 * ③ live 会话兜底
 * ④ 默认绑定 root 兜底（不在列表时放首位）
 */
export async function discoverCccs(ctx: Context, defaultRoot: string): Promise<SkiffCccEntry[]> {
  const roots: string[] = []
  const pushRoot = (cwd: string | undefined): void => {
    if (typeof cwd !== 'string' || cwd === '') return
    const r = findSerenityRoot(cwd)
    if (r && !roots.includes(r)) roots.push(r)
  }
  // ① workspaceRegistry（DSH 持久化工作区注册表；list() 同步返回 Workspace[]，含 path）
  try {
    const registry = (ctx as unknown as { get?: (name: string) => unknown }).get?.('workspaceRegistry') as
      | { list?: () => Array<{ path?: string }> }
      | undefined
    for (const ws of registry?.list?.() ?? []) pushRoot(ws?.path)
  } catch {
    /* workspace 服务不可用忽略 */
  }
  // ② sessionPersistence（持久化会话 headers——覆盖所有历史会话的工作目录）
  if (roots.length === 0) {
    try {
      const sp = (ctx as unknown as { get?: (name: string) => unknown }).get?.('sessionPersistence') as
        | { list?: () => Promise<Array<{ cwd?: string }>> }
        | undefined
      for (const h of (await sp?.list?.()) ?? []) pushRoot(h?.cwd)
    } catch {
      /* sessionPersistence 不可用忽略 */
    }
  }
  // ③ live 会话兜底
  if (roots.length === 0) {
    try {
      const sessions = (ctx as unknown as { sessions?: { list?: () => Array<{ header?: { cwd?: string } }> } }).sessions
      for (const s of sessions?.list?.() ?? []) pushRoot(s?.header?.cwd)
    } catch {
      /* 遍历失败忽略 */
    }
  }
  if (!roots.includes(defaultRoot)) roots.unshift(defaultRoot)
  return roots.map((root) => ({
    root,
    name: basename(root) || root,
    roles: [...readSkiffRoles(root).keys()],
  }))
}

/** 问答页 HTML：CCC 切换器 + 角色下拉 + 输入 + 答案区 + 轨迹区（JS 渲染）+ WebUI 链接 */
export function skiffDebugPage(cccs: SkiffCccEntry[], defaultRoot: string, webPort: number): string {
  // v1.25.7 修复：内嵌 JSON **不能整体 escapeHtml**（&quot; 会让 JSON.parse 失败——用户实测
  // console 报错 position 2）。只转义 `<` → `\u003c`（JSON 合法转义，JSON.parse 还原；
  // 防 `</script>` 注入）。data-default 属性值仍走 escapeHtml（HTML 属性语境）。
  const data = JSON.stringify(cccs).replace(/</g, '\\u003c')
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
  .sessionbar { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
  .session-badge { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px; padding: 3px 10px; border-radius: 999px; background: rgba(127,127,127,.12); word-break: break-all; }
  .session-badge.continued { background: rgba(11,168,117,.12); color: #0ba875; }
  @media (prefers-color-scheme: dark) { .session-badge.continued { color: #3ddc9a; } }
  button.ghost { background: transparent; color: #57606a; border: 1px solid #d0d7de; padding: 4px 12px; font-size: 12px; border-radius: 8px; cursor: pointer; margin-top: 0; }
  @media (prefers-color-scheme: dark) { button.ghost { color: #8b949e; border-color: #3a3d42; } }
  button.ghost:hover { background: rgba(127,127,127,.1); }
  label { font-size: 13px; font-weight: 600; display: block; margin: 12px 0 4px; }
  select, textarea { width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 8px; border: 1px solid #d0d7de; background: #fff; color: inherit; font-size: 14px; }
  @media (prefers-color-scheme: dark) { select, textarea { background: #26282c; border-color: #3a3d42; } }
  textarea { min-height: 72px; resize: vertical; }
  button { margin-top: 12px; padding: 9px 18px; border-radius: 8px; border: 0; background: #0ba875; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: .55; cursor: wait; }
  #answer { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 12px; margin-top: 16px; font-size: 14px; line-height: 1.6; min-height: 48px; word-break: break-word; }
  @media (prefers-color-scheme: dark) { #answer { background: #26282c; border-color: #3a3d42; } }
  /* Markdown 渲染（v1.25.8）：代码/标题/列表/引用/think 折叠 */
  #answer p { margin: 6px 0; }
  #answer h1, #answer h2, #answer h3 { margin: 12px 0 6px; font-size: 15px; line-height: 1.4; }
  #answer h1 { font-size: 17px; }
  #answer code { background: rgba(127,127,127,.14); border-radius: 4px; padding: 1px 5px; font-size: 13px; font-family: ui-monospace, SFMono-Regular, monospace; }
  #answer pre { background: rgba(127,127,127,.1); border-radius: 8px; padding: 10px 12px; overflow-x: auto; margin: 8px 0; }
  #answer pre code { background: none; padding: 0; font-size: 13px; line-height: 1.5; }
  #answer ul, #answer ol { margin: 6px 0; padding-left: 22px; }
  #answer li { margin: 2px 0; }
  #answer blockquote { margin: 6px 0; padding: 2px 12px; border-left: 3px solid rgba(127,127,127,.35); opacity: .88; }
  #answer a { color: #0ba875; text-decoration: underline; }
  details.think { margin: 8px 0; border: 1px solid rgba(210,153,34,.4); border-radius: 8px; background: rgba(210,153,34,.06); }
  details.think summary { cursor: pointer; padding: 6px 10px; font-size: 12px; color: #d29922; font-weight: 600; user-select: none; list-style-position: inside; }
  details.think summary:hover { opacity: .8; }
  details.think .think-body { padding: 2px 12px 10px; font-size: 13px; opacity: .78; white-space: normal; }
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
  <div class="sub">宁静号 trajectory 子集角色问答页（v1.25.10 实验性）— 多 CCC 可切换，同会话可追问（新对话按钮开新会话），回答 marked 服务端渲染 + think 折叠</div>
  <div class="ccc" id="cccBadge"></div>
  <div class="sessionbar">
    <span id="sessionBadge" class="session-badge muted">（新会话）</span>
    <button id="newChat" type="button" class="ghost">新对话</button>
  </div>
  <label for="ccc">认知容器</label>
  <select id="ccc"></select>
  <label for="role">角色</label>
  <select id="role"></select>
  <label for="q">问题</label>
  <textarea id="q" placeholder="向该角色提问…（追问直接继续输入）"></textarea>
  <button id="ask">提问</button>
  <div id="answer" class="muted">等待提问…</div>
  <div id="trajectory"></div>
  <p class="muted"><a href="${webUrl}" target="_blank" rel="noopener">在 dsh WebUI 查看完整会话</a>（会话列表搜索 sessionId；WebUI 有完整交互）</p>
</main>
<script id="skiff-data" type="application/json" data-default="${escapeHtml(defaultRoot)}">${data}</script>
<script>
const CCCS = JSON.parse(document.getElementById('skiff-data').textContent)
const defaultRoot = document.getElementById('skiff-data').dataset.default
const cccSel = document.getElementById('ccc')
const roleSel = document.getElementById('role')
const badge = document.getElementById('cccBadge')
const sessionBadge = document.getElementById('sessionBadge')
const newChatBtn = document.getElementById('newChat')
const btn = document.getElementById('ask')
const answer = document.getElementById('answer')
const traj = document.getElementById('trajectory')
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
let sessionId = ''
function shortId(id) { return id.length > 24 ? id.slice(0, 18) + '…' + id.slice(-6) : id }
function renderSessionBadge() {
  sessionBadge.textContent = sessionId ? '会话 ' + shortId(sessionId) + '（追问续接）' : '（新会话）'
  sessionBadge.className = 'session-badge' + (sessionId ? ' continued' : '')
}
function newConversation() {
  sessionId = ''
  renderSessionBadge()
  answer.className = 'muted'
  answer.textContent = '已开启新对话'
  traj.innerHTML = ''
  document.getElementById('q').value = ''
}
function currentCcc() {
  return CCCS.find((c) => c.root === cccSel.value) || (CCCS[0] || { root: '', name: '', roles: [] })
}
function fillCccs() {
  cccSel.innerHTML = CCCS.map((c) => {
    const n = c.roles.length
    return '<option value="' + esc(c.root) + '">' + esc(c.name) + (n ? ' (' + n + ' 角色)' : ' (无角色)') + '</option>'
  }).join('') || '<option value="">(未发现 CCC)</option>'
  if (defaultRoot) cccSel.value = CCCS.some((c) => c.root === defaultRoot) ? defaultRoot : (CCCS[0] && CCCS[0].root)
  fillRoles()
}
function fillRoles() {
  const c = currentCcc()
  badge.textContent = 'CCC: ' + c.root
  roleSel.innerHTML = (c.roles && c.roles.length)
    ? c.roles.map((r) => '<option value="' + esc(r) + '">' + esc(r) + '</option>').join('')
    : '<option value="">(未配置角色)</option>'
}
cccSel.addEventListener('change', () => { fillRoles(); newConversation() })
roleSel.addEventListener('change', () => newConversation())
newChatBtn.addEventListener('click', newConversation)
fillCccs()
renderSessionBadge()
btn.addEventListener('click', async () => {
  const c = currentCcc()
  const role = roleSel.value
  const q = document.getElementById('q').value.trim()
  if (!c.root || !role || !q) { answer.className = 'err'; answer.textContent = '请选择认知容器与角色并输入问题'; return }
  btn.disabled = true
  answer.className = 'muted'
  answer.textContent = '运行中…'
  traj.innerHTML = ''
  try {
    const res = await fetch('/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ccc: c.root, role, question: q, sessionId: sessionId || undefined }) })
    const data = await res.json()
    if (!res.ok) {
      // 会话不可恢复/绑定不匹配 → 前端清空 sessionId 重建（用户拍板：切换即新对话）
      sessionId = ''
      renderSessionBadge()
      throw new Error(data.error || ('HTTP ' + res.status))
    }
    answer.className = ''
    answer.innerHTML = data.answer_html || esc(data.answer || '') || '（空回答）'
    sessionId = data.sessionId || sessionId
    renderSessionBadge()
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
 * Markdown 渲染（v1.25.9，正经库 marked 服务端渲染——替代手写正则渲染器，S142 用户要求）：
 * ① 提取 `<think>…</think>` 块（占位符 \u0000T<idx>\u0000）
 * ② 正文与 think 内容**先 escapeHtml 再 marked.parse**（GFM + breaks）——markdown 语法不受
 *    转义影响，原始 HTML 注入被消除（安全）；代码块内 `<` 显示为实体（可接受）
 * ③ think 占位符还原为 `<details class="think">` 折叠卡（🧠 思考过程，默认收起）
 */
export function renderSkiffMarkdown(raw: string): string {
  const thinks: string[] = []
  const body = raw.replace(/<think>([\s\S]*?)<\/think>/gi, (_m, inner: string) => {
    const idx = thinks.length
    thinks.push(String(inner ?? '').trim())
    return `\u0000T${idx}\u0000`
  })
  const parsed = marked.parse(escapeHtml(body), { breaks: true, gfm: true })
  const html = typeof parsed === 'string' ? parsed : ''
  return html.replace(/\u0000T(\d+)\u0000/g, (_m, idx: string) => {
    const inner = thinks[Number(idx)] ?? ''
    const innerHtml = inner === '' ? '' : marked.parse(escapeHtml(inner), { breaks: true, gfm: true })
    return `<details class="think"><summary>🧠 思考过程</summary><div class="think-body">${typeof innerHtml === 'string' ? innerHtml : ''}</div></details>`
  })
}

/**
 * 启动调试问答服务（单实例；重复启动幂等返回既有实例）。
 *
 * **CCC 绑定（v1.25.2 用户指出）**：服务绑定一个默认 CCC root（调用方 resolveSkiffRoot
 * 解析：live 会话中**含 skiff.roles 的 CCC 优先**）；v1.25.4 起页面可**手工切换**到
 * 其它候选 CCC（live 会话发现的全部 CCC）；角色配置**每次请求实时读取**（不缓存快照）。
 *
 * @param root 默认绑定的 CCC 根（首次加载选中；角色配置读取 + skiff agent cwd）
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
  console.log(`[serenity-hooks] ✓ Skiff 调试问答页: http://127.0.0.1:${port}（默认 CCC: ${root}，WebUI: ${webPort}）`)
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
  defaultRoot: string,
  webPort: number,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const url = (req.url ?? '/').split('?')[0] ?? '/'
    if (req.method === 'GET' && url === '/') {
      // 实时发现候选 CCC（v1.25.4+：工作区注册表 → sessionPersistence → live 会话）+ 实时角色
      const cccs = await discoverCccs(ctx, defaultRoot)
      sendHtml(res, skiffDebugPage(cccs, defaultRoot, webPort))
      return
    }
    if (req.method === 'POST' && url === '/ask') {
      let body: { ccc?: unknown; role?: unknown; question?: unknown; sessionId?: unknown }
      try {
        const parsed = JSON.parse(await readBody(req)) as unknown
        if (parsed === null || typeof parsed !== 'object') throw new Error('not an object')
        body = parsed as { ccc?: unknown; role?: unknown; question?: unknown; sessionId?: unknown }
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' })
        return
      }
      // 手工切换的 CCC（v1.25.4）；缺省回退默认绑定 root
      const ccc = typeof body.ccc === 'string' && body.ccc !== '' ? body.ccc : defaultRoot
      const roleName = typeof body.role === 'string' ? body.role : ''
      const question = typeof body.question === 'string' ? body.question : ''
      const sessionId = typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : undefined
      const roles = readSkiffRoles(ccc)
      const role = roles.get(roleName)
      if (!roleName || !role) {
        sendJson(res, 400, { error: `unknown role: ${roleName} (ccc: ${ccc})` })
        return
      }
      if (!question.trim()) {
        sendJson(res, 400, { error: 'empty question' })
        return
      }
      // 会话延续（v1.25.10，S142 用户：同一 qa 会话追问）：
      // ① 无 sessionId → 新建（continued:false）
      // ② 有 sessionId：
      //    a. 进程内命中（skiffAgents）→ 校验 (role, ccc) 绑定一致 → 复用（continued:true）
      //    b. 未命中（重启后/不存在）→ 400「会话不可恢复，请新对话」（首版仅进程内延续）
      //    c. 绑定不匹配（角色/容器切换残留）→ 400 提示（前端清 sessionId 重建）
      let agent: Agent | undefined
      let continued = false
      if (sessionId) {
        const info = skiffSessionInfo(sessionId)
        const live = getSkiffAgent(sessionId)
        if (!info || !live) {
          sendJson(res, 400, { error: 'session is not recoverable (process restarted or session unknown) — start a new conversation' })
          return
        }
        if (info.role !== roleName || info.ccc !== ccc) {
          sendJson(res, 400, { error: `session "${sessionId}" belongs to role "${info.role}" in another CCC — start a new conversation` })
          return
        }
        agent = live
        continued = true
      }
      const hc = readHandymanConfig(ccc)
      if (!agent) {
        const ref = await createSkiffAgent(ctx, ccc, roleName, role, hc?.defaultModel)
        agent = ref.agent
      }
      const result = await askSkiff(ctx, agent, question, 0)
      // v1.25.9：answer_html = marked 服务端渲染（页面直接 innerHTML；answer 保留原文兜底）
      // v1.25.10：continued 标记 + 全量轨迹（eventsStart=0 默认，页面重绘完整时间线）
      sendJson(res, 200, {
        answer: result.answer,
        answer_html: renderSkiffMarkdown(result.answer),
        sessionId: result.sessionId,
        continued,
        trajectory: result.trajectory,
      })
      return
    }
    sendJson(res, 404, { error: 'not found' })
  } catch (err) {
    sendJson(res, 500, { error: (err as Error)?.message ?? String(err) })
  }
}

/** 导出类型引用（测试断言轨迹结构） */
export type { SkiffTrajectoryEntry }
