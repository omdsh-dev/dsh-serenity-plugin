/**
 * probe-dlg.mjs — 一次性诊断（非判据）：V8c-P2 到底被什么挡住
 *
 * 目的：`atPoint: DIV class=_mask_o6lrb_18` 且 `dialogs: 1` —— 探针的清障跑了却没清掉。
 * 问：那**一个** `[role=dialog]` 是什么？它有没有可点的按钮？文字是什么？
 *     以及 mask 的层级/父节点是谁（判断它是"弹窗的兄弟"还是"独立的全屏层"）。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 🔴 依赖解析锚在**被装进 profile 的那个插件自己**上（不是本机布局、也不是探针自己的目录）——
//    首版直接 `import('ws')` ⇒ 本文件在 /usr/local/bin，而那里没有 node_modules ⇒ MODULE_NOT_FOUND。
//    这正是我本轮刚写进 §判据纪律的那条（"读数器的依赖解析要锚在被测对象同一条链"），
//    写诊断件时**又踩了一次**（同族第 4 次）⇒ 固化成范式。
const req = (await import('node:module')).createRequire(
  '/root/.dsh/profiles/web/node_modules/@shgroup/dsh-serenity-hooks/lib/index.js',
)
const { WebSocket } = req('ws')

const PORT = 3080
const profile = mkdtempSync(join(tmpdir(), 'dlg-probe-'))
const cdpPort = 9411 + (process.pid % 200)

// 🔴 必须带 launch token —— 否则访问到的是**登录页**（无任何 dialog），
//    于是探针会得出"没有弹窗"这个**与事实相反**的结论（首版就是这么错的）。
//    与 v8c 探针同法：从宿主日志里取 token。
let token = ''
try {
  const { readFileSync } = await import('node:fs')
  const log = readFileSync('/logs/dsh-web.log', 'utf-8')
  const m = log.match(/token=([A-Za-z0-9_-]+)/)
  if (m) token = m[1]
} catch { /* 取不到就不带 */ }
const url = token ? `http://127.0.0.1:${PORT}/?token=${token}` : `http://127.0.0.1:${PORT}/`
console.log(`URL_HAS_TOKEN=${token ? 'yes' : 'NO'}`)

const chrome = spawn('chromium', [
  '--headless=new', '--no-sandbox', '--disable-gpu',
  `--remote-debugging-port=${cdpPort}`,
  `--user-data-dir=${profile}`,
  url,
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getWsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${cdpPort}/json/list`)
      const list = await r.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page.webSocketDebuggerUrl
    } catch { /* 还没起来 */ }
    await sleep(300)
  }
  return null
}

const wsUrl = await getWsUrl()
if (!wsUrl) { console.log('NO_CDP'); chrome.kill('SIGKILL'); process.exit(2) }

const ws = new WebSocket(wsUrl)
let id = 0
const pend = new Map()
ws.on('message', (d) => {
  const m = JSON.parse(d.toString())
  if (m.id !== undefined && pend.has(m.id)) {
    const p = pend.get(m.id); pend.delete(m.id)
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result)
  }
})
const cdp = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; pend.set(i, { res, rej })
  ws.send(JSON.stringify({ id: i, method, params }))
  setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('timeout ' + method)) } }, 15000)
})
const evalJs = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  return r.result ? r.result.value : undefined
}

await new Promise((r) => ws.on('open', r))
await cdp('Runtime.enable')
await sleep(3500) // 等应用挂载 + 可能的弹窗

const dump = await evalJs(`(() => {
  const dialogs = [...document.querySelectorAll('[role="dialog"]')].map((d) => ({
    tag: d.tagName,
    cls: String(d.className).slice(0, 80),
    shortcut: d.getAttribute('data-shortcut-modal'),
    text: (d.innerText || '').replace(/\\s+/g, ' ').slice(0, 160),
    buttons: [...d.querySelectorAll('button')].map((b) => ((b.textContent || '') + '|' + (b.getAttribute('aria-label') || '')).trim()).slice(0, 8),
    visible: d.offsetParent !== null,
  }))
  const masks = [...document.querySelectorAll('[class*="mask"]')].map((m) => {
    const r = m.getBoundingClientRect()
    const cs = getComputedStyle(m)
    return {
      cls: String(m.className).slice(0, 80),
      w: Math.round(r.width), h: Math.round(r.height),
      z: cs.zIndex, pos: cs.position, display: cs.display,
      parentTag: m.parentElement ? m.parentElement.tagName : null,
      parentCls: m.parentElement ? String(m.parentElement.className).slice(0, 60) : null,
    }
  })
  const at = document.elementFromPoint(135, 726) // 「Settings」按钮中心附近
  return {
    dialogs, masks,
    atPoint: at ? (at.tagName + ' class=' + String(at.className).slice(0, 60)) : null,
    maskCount: masks.length,
  }
})()`)

console.log(JSON.stringify(dump, null, 2))

try { ws.close() } catch {}
chrome.kill('SIGKILL')
await sleep(300)
try { rmSync(profile, { recursive: true, force: true }) } catch {}
process.exit(0)
