/**
 * surface/debug.ts — 调试问答页（面 D，F4a'，v1.25.x 实验性）
 *
 * node:http 调试端口（默认关，仅监听 127.0.0.1；启停 = 人工——设置面板「Serenity」
 * 页 Skiff 区块开关，不随插件加载自动启动）。
 *
 * - GET  /        → 问答 HTML 页（**CCC 选择器** + 轨迹下拉 + 输入框 + 答案区 + 轨迹区 + WebUI 链接）
 * - POST /ask     → {ccc?, role, question} → 走会话核心（`trajectory/policy`）→ {answer, sessionId}
 *
 * **多 CCC 手工切换（v1.25.4，S142 用户）**：dsh 管理多个 CCC 时，调试页顶部 CCC
 * 下拉列出全部候选（live 会话 cwd 上溯 .serenity 去重 + 默认绑定 root 兜底），
 * 切换后下拉联动（各 CCC 的 skiff 轨迹实时扫描），提问按所选 CCC 创建 agent。
 *
 * 与轨迹会话核心（createSkiffAgent + askSkiff）直接共用同一实现；
 * （原「与 ACP stdio 协议（F4c 后续）共用同一会话核心」一句已随面 E 退役删除，2026-10-15）
 * 轨迹 = session.events 结构化返回（与 dsh WebUI 同源数据），
 * 页面 JS 渲染成对话时间线；同时保留原生 WebUI 会话链接供完整交互。
 *
 * 实验性质：未开启时零资源占用（无监听、无 agent 创建）。
 *
 * ## S11 拆分（2026-10-19，轨迹中心重构）
 *
 * 本文件原先还含**通用文本清洗**（`stripThink` / `renderSkiffMarkdown` / `jscSafeJsonText`），
 * 而那几个导出被 `im/bridge.ts` 与 `guard/seam.ts` **两个与 skiff 无关的模块**使用
 * ⇒ 它们不属于"某条轨迹的调试面" ⇒ 已拆到 `surface/text.ts`。
 * 本文件只留**面 D 自己的东西**：listener 生命周期 ＋ 路由 ＋ HTML。
 */

import { type IncomingMessage, type ServerResponse } from 'node:http'
import type { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { readSkiffProfileByCode, SKIFF_PROFILE_FILENAME } from '../trajectory/policy/profile.js'
import { createSkiffAgent, askSkiff, getSkiffAgent, skiffSessionInfo, unregisterSkiffSession } from '../role/skiff/core.js'
import { readCheapWorkerConfig } from '../kernel/ccc.js'
// C2（CCC 发现面归一）：候选 CCC 枚举的**唯一真相源**是 kernel/ccc-roots.ts；
// 本模块的 `discoverCccs` 已删除（调用点改用 `listCccs`，见各 handle 分支）。
import { listCccs, type CccEntry } from '../kernel/ccc-roots.js'
// C4 块 A：listener 生命周期归面宿主（本面=面 D，端口语义见 kernel/ports.ts 的 FACE_PORTS.skiffDebug）
import { faceActive, facePort, startFace, stopFace, type FaceSpec } from './faces.js'
import { FACE_PORTS } from '../kernel/ports.js'
import { readSimpleSettings } from './settings.js'
import { escapeHtml, jscSafeJsonText, renderSkiffMarkdown } from './text.js'

/** 面名（C4 块 A） */
const FACE_SKIFF_DEBUG = 'skiff-debug'
/** 监听地址：**只绑 loopback**（本面无认证——仅靠 loopback 挡住外部） */
const SKIFF_DEBUG_HOST = FACE_PORTS.skiffDebug.host ?? '127.0.0.1'

export function skiffDebugActive(): boolean {
  return faceActive(FACE_SKIFF_DEBUG)
}

export function skiffDebugPort(): number | null {
  return facePort(FACE_SKIFF_DEBUG)
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
 * 候选 CCC 条目（调试页 CCC 切换器数据）。
 *
 * C2：定义已迁至 `kernel/ccc-roots.ts`（L2 枚举的唯一真相源）——此处只在**类型层**转出
 * （零运行时重导出，避免把 `ccc-roots` 拉进本模块的运行时静态链）。
 */
export type { CccEntry }

/** 问答页 HTML：CCC 切换器 + 角色下拉 + 输入 + 答案区 + 轨迹区（JS 渲染）+ WebUI 链接 */
export function skiffDebugPage(cccs: CccEntry[], defaultRoot: string, webPort: number): string {
  // v1.25.7 修复：内嵌 JSON **不能整体 escapeHtml**（&quot; 会让 JSON.parse 失败——用户实测
  // console 报错 position 2）。只转义 `<` → `\u003c`（JSON 合法转义，JSON.parse 还原；
  // 防 `</script>` 注入）。data-default 属性值仍走 escapeHtml（HTML 属性语境）。
  // v1.26.9：jscSafeJsonText 消除 JSC JSON.parse 快速路径正则对 \u2028/\u2029/\uFEFF 的误抛
  const data = jscSafeJsonText(JSON.stringify(cccs).replace(/</g, '\\u003c'))
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
  #cognitiveTrajectory { margin-top: 12px; font-size: 13px; }
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
  <div class="sub">宁静号轨迹的子集角色问答页（实验性）。可切换 CCC；同一会话可追问，点「新对话」另起一条；回答在服务端渲染，think 块折叠。</div>
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
  <div id="cognitiveTrajectory"></div>
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
const traj = document.getElementById('cognitiveTrajectory')
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
    renderCognitiveTrajectory(data.cognitiveTrajectory || [], data.sessionId || '')
  } catch (err) {
    answer.className = 'err'
    answer.textContent = String(err.message || err)
  } finally {
    btn.disabled = false
  }
})
function renderCognitiveTrajectory(entries, sessionId) {
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

/**
 * 本面的规格（C4 块 A/④：**只提供** name/port/host/enabled/handler）。
 * 路由/鉴权/HTML 全部仍归本模块的 {@link handle}（面宿主不介入面语义）。
 */
export function skiffDebugSpec(ctx: Context, root: string, port: number, webPort: number): FaceSpec {
  return {
    name: FACE_SKIFF_DEBUG,
    port,
    host: SKIFF_DEBUG_HOST,
    // 意图 = 设置面板「Skiff 调试」开关（装配层 index.ts 亦以此门控；此处是规格自述）
    enabled: () => readSimpleSettings().skiffEnabled,
    handler: (req, res) => handle(ctx, root, webPort, req, res),
  }
}

/**
 * 启动调试问答服务（单实例；重复启动幂等返回既有实例）。
 *
 * **CCC 绑定（v1.25.2 用户指出）**：服务绑定一个默认 CCC root（调用方 resolveSkiffRoot
 * 解析：live 会话中**含 skiff.roles 的 CCC 优先**）；v1.25.4 起页面可**手工切换**到
 * 其它候选 CCC（live 会话发现的全部 CCC）；角色配置**每次请求实时读取**（不缓存快照）。
 *
 * C4 块 A：listener 的创建/监听/错误/端口占用/关闭归 `face-host`（本函数只提供规格 + 记日志）。
 *
 * @param root 默认绑定的 CCC 根（首次加载选中；角色配置读取 + skiff agent cwd）
 * @param port 调试端口（仅 127.0.0.1）
 * @param webPort 主 WebUI 端口（WebUI 链接）
 */
export async function startSkiffDebugServer(ctx: Context, root: string, port: number, webPort: number): Promise<void> {
  if (skiffDebugActive()) return
  const handle = await startFace(skiffDebugSpec(ctx, root, port, webPort))
  console.log(`[serenity-hooks] ✓ Skiff 调试问答页: http://127.0.0.1:${handle.port}（默认 CCC: ${root}，WebUI: ${webPort}）`)
}

export function stopSkiffDebugServer(): void {
  stopFace(FACE_SKIFF_DEBUG)
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
      // 实时发现候选 CCC（ccc-roots.listCccs：工作区注册表 ∪ sessionPersistence ∪ live 会话）
      // + 实时角色（withRoles: true —— 调试页的角色下拉需要各 CCC 的 skiff.roles）
      const cccs = await listCccs(ctx, { defaultRoot, withRoles: true })
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
      // 🔴 2026-10-19：选择项从「角色名」改为**轨迹编码**（skiff = 带 skiff.json 的轨迹）
      const code = typeof body.role === 'string' ? body.role : ''
      const question = typeof body.question === 'string' ? body.question : ''
      const sessionId = typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : undefined
      const profile = code !== '' ? readSkiffProfileByCode(ccc, code) : null
      if (!profile) {
        sendJson(res, 400, {
          error: `unknown skiff trajectory: ${code} (no trajectory with code "${code}" has ${SKIFF_PROFILE_FILENAME} in ${ccc})`,
        })
        return
      }
      if (!question.trim()) {
        sendJson(res, 400, { error: 'empty question' })
        return
      }
      // 会话延续（v1.25.10，S142 用户：同一会话追问）：
      // ① 无 sessionId → 新建（continued:false）
      // ② 有 sessionId：
      //    a. 进程内命中（skiffAgents）→ 校验 (轨迹, ccc) 绑定一致 → 复用（continued:true）
      //    b. 未命中（重启后/不存在）→ 400「会话不可恢复，请新对话」（仅进程内延续）
      //    c. 绑定不匹配（轨迹/容器切换残留）→ 400 提示（前端清 sessionId 重建）
      let agent: Agent | undefined
      let continued = false
      if (sessionId) {
        const info = skiffSessionInfo(sessionId)
        const live = getSkiffAgent(sessionId)
        if (!info || !live) {
          sendJson(res, 400, { error: 'session is not recoverable (process restarted or session unknown) — start a new conversation' })
          return
        }
        if (info.trajectoryDirName !== profile.dirName || info.ccc !== ccc) {
          sendJson(res, 400, { error: `session "${sessionId}" belongs to trajectory "${info.trajectoryDirName}" in another CCC — start a new conversation` })
          return
        }
        agent = live
        continued = true
      }
      const hc = readCheapWorkerConfig(ccc)
      if (!agent) {
        const ref = await createSkiffAgent(ctx, ccc, profile, hc?.defaultModel)
        agent = ref.agent
      }
      const result = await askSkiff(ctx, agent, question)
      // v1.25.9：answer_html = marked 服务端渲染（页面直接 innerHTML；answer 保留原文兜底）
      sendJson(res, 200, {
        answer: result.answer,
        answer_html: renderSkiffMarkdown(result.answer),
        sessionId: result.sessionId,
        continued,
      })
      return
    }
    sendJson(res, 404, { error: 'not found' })
  } catch (err) {
    sendJson(res, 500, { error: (err as Error)?.message ?? String(err) })
  }
}
