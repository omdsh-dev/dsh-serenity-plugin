/**
 * v8c-cdp-panel-check.mjs — **元素级渲染**证据（V8c）：容器内起 chromium（带 CDP），**点开设置面板**，
 * 断言我方 section **作为 DOM 元素**出现。
 *
 * 为什么 V8b 不够（判据阶梯的最后一档）：
 *   V8  = 交付层（profile 里有我们的 bundle）
 *   V8b = **真浏览器层**（页面真渲染 ＋ 我方模块真被浏览器请求；已实测 netlog 命中 7 处）
 *   V8c = **元素级**（真的点开设置页，看我们的 section 元素／标题文本在不在）
 * 🔴 为什么非要有这一档：A19（十键漏标 `.volatile()` ⇒ 设置页整块消失）在**日志上零报错**，
 *    而 V8/V8b 都只证明"模块被送达" —— **送达到 ≠ 渲染出来**。V8c 把最后这一跳也机械化了。
 * 🔴 首版 V8b 的教训在此继承：**不许用"类名出现在 HTML 文本里"判渲染**（我方 CSS 注入成 <style>，
 *    类名必然命中）⇒ 本探针一律用**元素查询**（querySelector / innerText），不用字符串包含。
 *
 * ## 🔴 2026-09-25 17:3x 重写：把判据钉在**宿主真实 DOM 锚点**上（首版三次假红/假绿的原因）
 *
 * 首版（找"文本等于 Settings 的最内层元素"→ `el.click()` → 立刻查 `.ss-title`）有**两个错**，
 * 两个都已被源码取证纠正（宿主包 `dsh-client-ui-settings-general/lib/client.js`）：
 *  ① **`Settings` 只是触发器按钮里的 `<span>` 文字** —— 真正的可点元素是
 *     `<button type="button" aria-label="Settings" aria-haspopup="dialog" aria-expanded=…>`
 *     （`TriggerContent` 只渲染 icon + `<span class="…triggerLabel">Settings</span>`）。
 *     ⇒ 选**语义锚**（`aria-label` / `aria-haspopup`），并用 **CDP `Input.*` 真输入**点击
 *     （比 `el.click()` 更接近真人：有 mouseMoved/Pressed/Released，且 `isTrusted`）。
 *  ② **设置 UI 是 body-portaled 的模态框**（`div[data-shortcut-modal="settings"][role=dialog]`），
 *     且打开后**默认选中第一节（general）** —— 我方 section 只有在**点它自己的导航行**之后才渲染。
 *     ⇒ 首版"点开设置后立刻查 `.ss-title`"**结构上必然查不到**（不是缺陷，是判据写错了）。
 *     ⇒ 本版判据链 = 开面板 → **我方导航行（label「Serenity」）是元素** → 点它 → `.ss-title` 是元素。
 *
 * 判据链（四级，全部元素级；任一环失败即 FAIL，并打印诊断——绝不静默绿）：
 *   V8c-P1 页面经 CDP 可交互（`#root` 已挂载）
 *   V8c-P2 真输入点击触发器后**模态框真的打开**（`[data-shortcut-modal=settings][role=dialog]` 在场）
 *   V8c-P3 **我方 section 的导航行**作为元素出现（label 逐字「Serenity」）—— 这一步证明
 *          `configForms.whileServed` 真的成立、`settings.section` 真的注册了
 *   V8c-P4 点我方导航行后，我方页面**作为元素**渲染（`.ss-title` 是 HTMLElement 且文本含 Serenity）
 *
 * 退出码：0 = 全过 ｜ 1 = 判据失败 ｜ 2 = 读数器/CDP 不可用（明确报，绝不静默绿）
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs'

const LOG = '/logs'
/** 🔴 CDP 端口**每轮唯一**（pid 派生）。实测踩到（2026-09-25 17:5x）：端口写死时，本轮浏览器会连到
 *  **上一轮遗留的实例**上 —— 判据于是测的是"上一轮那台"（带着上一轮的页面状态），
 *  同一份代码一次绿一次红，与代码无关。范围 9300+（避开 CCC `home-browser` 的 9222..9299）。 */
const PORT = 9300 + (process.pid % 200)
/** 每轮唯一的 profile 目录（pid 派生）——见下方"清场 ③"：共用目录会让本轮浏览器连到旧实例上 */
const PROFILE = `/tmp/v8c-profile-${process.pid}`
/** 我方 section 的导航 label（与 `client/index.ts` 注册处 `label: () => 'Serenity'` 逐字一致） */
const OUR_LABEL = 'Serenity'

const PASS = []
const FAIL = []
function say(ok, id, label, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}  ${label}${extra ? '  ' + extra : ''}`)
  ;(ok ? PASS : FAIL).push(id)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 宿主页面入口（token 必须取到：无 token 页面会拒绝，判不了渲染） */
function pageTarget() {
  const p = `${LOG}/dsh-web.log`
  if (!existsSync(p)) return null
  const m = /token=([A-Za-z0-9_-]+)/.exec(readFileSync(p, 'utf-8'))
  return m ? { token: m[1], url: `http://127.0.0.1:3080/?token=${m[1]}` } : null
}

async function httpJson(pathname, timeoutMs = 3000) {
  const r = await fetch(`http://127.0.0.1:${PORT}${pathname}`, { signal: AbortSignal.timeout(timeoutMs) })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return await r.json()
}

/** 极简 CDP 客户端（零依赖：Node ≥21 内建 WebSocket；与 CCC `home-browser` 同设计） */
function attach(ws) {
  let nextId = 1
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    let msg
    try { msg = JSON.parse(String(ev.data)) } catch { return }
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result)
  })
  return (method, params, timeoutMs = 15_000) =>
    new Promise((res, rej) => {
      const id = nextId++
      const t = setTimeout(() => { pending.delete(id); rej(new Error(`CDP 超时: ${method}`)) }, timeoutMs)
      pending.set(id, { res: (v) => { clearTimeout(t); res(v) }, rej: (e) => { clearTimeout(t); rej(e) } })
      ws.send(JSON.stringify({ id, method, params }))
    })
}

/** 等 CDP 端点与页面 target 就绪。
 *
 *  🔴 身份靠**每轮唯一的 CDP 端口**保证（见 `PORT`），**不能**靠"URL 里带 token"：
 *     实测（2026-09-25 18:0x）宿主会把 token 从地址栏抹掉（写进自己的存储后 replaceState）
 *     ⇒ "URL 含 token"这条判据**恒假**，探针会一直报「CDP 端点未就绪」（像"chromium 起不来"）。
 *     ⇒ 判据只要求"有个 http 页面 target"，并把**它实际是谁**打进读数（错靶要看得见，不静默）。 */
async function connectPageWs() {
  let seen = []
  for (let i = 0; i < 40; i++) {
    try {
      const list = await httpJson('/json/list')
      seen = list.map((t) => `${t.type}:${String(t.url).slice(0, 70)}`)
      const page = list.find((t) => t.type === 'page' && String(t.url).startsWith('http'))
      if (page?.webSocketDebuggerUrl) return { wsUrl: page.webSocketDebuggerUrl, pageUrl: String(page.url) }
    } catch { /* 未就绪 */ }
    await sleep(500)
  }
  return { wsUrl: null, seen }
}

const target = pageTarget()
if (target === null) {
  say(false, 'V8c', '设置面板元素级渲染（容器内 CDP）', '前置不足：/logs/dsh-web.log 无 token（宿主未起？）')
  console.log(`V8c-RESULT PASS=${PASS.length} FAIL=${FAIL.length}`)
  process.exit(2)
}
const url = target.url

/** 杀掉**历史遗留**的 v8c 浏览器并**等到真的没了**（`-9` ＋ 轮询；只发一次信号是不够的）。
 *
 *  🔴 匹配式必须**带上旗标**（`--user-data-dir=/tmp/v8c-profile`），不能只写 `v8c-profile` ——
 *     实测（2026-09-25 17:5x）：`pkill -9 -f v8c-profile` **把调用它的那个 shell 自己杀了**
 *     （那行命令的 cmdline 里就含这个子串）⇒ 整条测试命令 exit 137，看起来像"探针崩了"。
 *     这是"`pkill` 自伤"那一族：**pkill 的模式会命中自己所在的进程树**。
 *  ⚠️ 同理：调试时也别在**同一条 shell 命令里**写这个子串（`ls -d /tmp/v8c-prof*` 也要用通配截断）。 */
const STALE_PATTERN = '--user-data-dir=/tmp/v8c-profile'
async function clearStaleBrowsers() {
  for (let i = 0; i < 10; i++) {
    let alive = true
    try { execFileSync('pgrep', ['-f', '--', STALE_PATTERN], { stdio: 'ignore' }) } catch { alive = false }
    if (!alive) return true
    try { execFileSync('pkill', ['-9', '-f', '--', STALE_PATTERN], { stdio: 'ignore' }) } catch { /* 已死 */ }
    await sleep(400)
  }
  return false
}

// 🔴 清场（三条全是实测踩出来的，且**每条都曾让判据红绿与代码无关**）：
//   ① 杀**上一轮遗留的** chromium —— `process.exit` 不执行 `finally`，早期版本每跑一轮留一个孤儿；
//   ② **必须等它真死**（`-9` ＋ 轮询）—— 只发一次信号就往下走，实测会让新实例"连到正在死的旧实例上"，
//      连续 3 轮报「CDP 端点/页面 target 未就绪」（看起来像"chromium 起不来"，其实是清场没收干净）；
//   ③ **profile 每轮唯一**（`-<pid>`）—— chromium 对同一 `user-data-dir` 是**单例**：新实例把请求
//      交给旧实例后自己退出 ⇒ "新的一轮"其实连在**旧实例**上（页面停在上一轮交互后的状态）。
//      唯一目录把这条**从判据里彻底移除**（不再靠"清得干净"来保证正确）。
const staleGone = await clearStaleBrowsers()
if (!staleGone) {
  say(false, 'V8c', '设置面板元素级渲染（容器内 CDP）', '清场失败：上一轮的 chromium 在 4s 内没被杀掉（读数器不可信，先手工收摊）')
  console.log(`V8c-RESULT PASS=${PASS.length} FAIL=${FAIL.length}`)
  process.exit(2)
}
try { rmSync(PROFILE, { recursive: true, force: true }) } catch { /* 自家目录残留：无碍 */ }
mkdirSync(PROFILE, { recursive: true })
const child = spawn('chromium', [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--no-first-run', '--no-default-browser-check',
  '--window-size=1440,900',
  url,
], { detached: true, stdio: 'ignore' })
child.unref()
// 🔴 收摊必须挂在 `exit` 上：`process.exit()` **不会**执行 `finally`（这条就是上面"孤儿"的成因）。
//    detached ⇒ 子进程是组长，杀**进程组**才能连 zygote/renderer 一起收掉。
const reap = () => {
  try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* noop */ } }
  try { rmSync(PROFILE, { recursive: true, force: true }) } catch { /* 清不掉也无碍（唯一目录，不会再被用到） */ }
}
process.on('exit', reap)

/** 触发器选择器（语义锚优先；最后一条是按文字兜底，仅为宿主改名时的可诊断退化） */
const TRIGGER_EXPR = `document.querySelector('button[aria-label="Settings"]')
  || document.querySelector('button[aria-label="设置"]')
  || document.querySelector('button[aria-haspopup="dialog"]')
  || [...document.querySelectorAll('button')].find((b) => /^(Settings|设置)$/.test((b.textContent || '').trim()))
  || null`
/** 模态框锚点（宿主源码 `SettingsPanel`：`data-shortcut-modal="settings"` + `role="dialog"`） */
const PANEL_EXPR = `document.querySelector('[data-shortcut-modal="settings"]')`
/** **挡路的**弹窗（除设置面板以外的任何 `role=dialog`）—— 实测：落地页上就有一个，
 *  它的 `mask` 铺满全屏并把真输入全部吃掉（这正是首版"点了没反应"的真因，与我们的插件无关） */
const BLOCKING_EXPR = `[...document.querySelectorAll('[role="dialog"]')].find((d) => !d.matches('[data-shortcut-modal="settings"]')) || null`
/** 我方导航行：面板内 label 逐字等于 OUR_LABEL 的按钮 */
const OUR_ROW_EXPR = `[...(${PANEL_EXPR}?.querySelectorAll('button') ?? [])].find((b) => (b.textContent || '').trim() === ${JSON.stringify(OUR_LABEL)}) || null`

let cdp = null
try {
  const conn = await connectPageWs()
  if (conn.wsUrl === null) {
    say(false, 'V8c', '设置面板元素级渲染（容器内 CDP）',
      `CDP 端点/页面 target 未就绪（chromium 起不来 或 端口占用）；实测 target 列表=${JSON.stringify(conn.seen)}`)
    console.log(`V8c-RESULT PASS=${PASS.length} FAIL=${FAIL.length}`)
    process.exit(2)
  }
  const wsUrl = conn.wsUrl
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('WebSocket 连接超时')), 8000)
    ws.addEventListener('open', () => { clearTimeout(t); res(undefined) })
    ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('WebSocket 连接失败')) })
  })
  cdp = attach(ws)
  const evalJs = async (expression) => (await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value
  /** 轮询直到条件为真（判据不依赖固定 sleep；"等多久"不该是判据的一部分） */
  const waitFor = async (expression, ms = 8000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (await evalJs(expression)) return true
      await sleep(250)
    }
    return false
  }
  /** **真输入**点击（CDP `Input.*`）：有 moved/pressed/released 三段，`isTrusted=true`。
   *  🔴 点击前先做**命中测试**（`elementFromPoint`）—— 实测踩到：落地页上有一个开机弹窗的
   *  `mask` 铺满全屏，真输入会被它吃掉，而"点了没反应"从返回码上完全看不出来。 */
  const realClick = async (expr) => {
    const box = await evalJs(`(() => { const e = ${expr}; if (!e) return null
      const r = e.getBoundingClientRect()
      const p = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      const hit = !p ? 'none' : ((e === p || e.contains(p)) ? 'self' : (p.tagName + ' class=' + ((p.getAttribute('class') || '')).slice(0, 50)))
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, tag: e.tagName, hit,
        label: (e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 40) } })()`)
    if (box === null) return { ok: false, via: 'not-found' }
    if (!(box.w > 0 && box.h > 0)) {
      // 0 尺寸 ⇒ 真输入打不中；退回 DOM click，并**如实标注**这个退化（不静默）
      const r = await evalJs(`(() => { const e = ${expr}; e.click(); return true })()`)
      return { ok: !!r, via: 'dom-click（元素 0 尺寸，真输入打不中）', ...box }
    }
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none' })
    await sleep(120)
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await sleep(60)
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    return { ok: true, via: 'CDP Input.*', ...box }
  }
  const pressEscape = async () => {
    const k = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...k })
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...k })
  }
  /** 关掉挡在路上的开机弹窗（**不是**我们的设置面板）。返回观察到的弹窗文案，供记录。 */
  const dismissBlocking = async () => {
    const seen = []
    for (let i = 0; i < 4; i++) {
      const info = await evalJs(`(() => { const d = ${BLOCKING_EXPR}; if (!d) return null
        return { text: (d.innerText || '').replace(/\\s+/g, ' ').slice(0, 100),
          buttons: [...d.querySelectorAll('button')].map((b) => ((b.textContent || '') + '|' + (b.getAttribute('aria-label') || '')).trim()).slice(0, 8) } })()`)
      if (info === null) return seen
      seen.push(info)
      // 先试它自己的"继续/知道了"按钮；没有再试 Escape（宿主 useModalLayer 支持 Esc 关闭）
      const clicked = await evalJs(`(() => { const d = ${BLOCKING_EXPR}; if (!d) return false
        const b = [...d.querySelectorAll('button')].find((x) => /continue|got it|close|dismiss|agree|accept|ok|继续|知道了|关闭|确定|同意/i.test(((x.textContent || '') + (x.getAttribute('aria-label') || '')).trim()))
        if (!b) return false
        b.click(); return true })()`)
      if (!clicked) await pressEscape()
      await sleep(800)
    }
    return seen
  }

  // ── V8c-P1 等应用挂载 ──
  let mounted = false
  for (let i = 0; i < 30; i++) {
    mounted = await evalJs('!!document.querySelector("#root") && document.body.innerText.length > 0')
    if (mounted) break
    await sleep(500)
  }
  say(!!mounted, 'V8c-P1', '页面经 CDP 可交互（#root 已挂载）', `target=${conn.pageUrl.slice(0, 70)}`)

  // ── 前置：关掉落地页上的开机弹窗（**不是判据**，是让后续真输入能落到目标上）──
  // 🔴 实测（2026-09-25 17:4x）：首版"找到按钮 -> 真输入点击 -> 模态框没开"的真因**不在我方插件**，
  //    而在页面自己带的那个开机提示弹窗：它的 `mask` 铺满全屏，
  //    实测 `elementFromPoint(触发器中心)` = `DIV class=_mask_17i0t_18` ⇒ 点击被 mask 吃掉。
  //    ⇒ 先把挡路的弹窗关掉（点它自己的按钮 / Escape），再点我们的触发器。
  const dismissed = await dismissBlocking()
  if (dismissed.length > 0) console.log(`NOTE 落地页阻挡弹窗已处理：${JSON.stringify(dismissed)}`)

  // ── V8c-P2 真输入点击触发器 ⇒ **模态框真的打开** ──
  // 🔴 判据 = 模态框元素在场（不是"我点过了"）：首版把"找到并点击"当成"打开了"，那是自证不是验收。
  const click = await realClick(TRIGGER_EXPR)
  const opened = click.ok ? await waitFor(`!!(${PANEL_EXPR}) && (${PANEL_EXPR}).getAttribute('role') === 'dialog'`) : false
  // 失败时自证"为什么没开"：`aria-expanded` 区分"处理器没跑" vs "状态变了但面板没渲染"；
  // `elementFromPoint` 抓"真输入到底打在了谁身上"（覆盖层 / 视口外）。
  const diag = opened || !click.ok ? null : await evalJs(`(() => { const b = ${TRIGGER_EXPR}; if (!b) return { noTrigger: true }
    const r = b.getBoundingClientRect()
    const pt = r.width > 0 ? document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) : null
    return { ariaExpanded: b.getAttribute('aria-expanded'), disabled: !!b.disabled,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      viewport: { w: window.innerWidth, h: window.innerHeight },
      atPoint: pt ? pt.tagName + ' class=' + ((pt.getAttribute('class') || '')).slice(0, 60) : null,
      dialogs: document.querySelectorAll('[role="dialog"]').length,
      shortcutModals: [...document.querySelectorAll('[data-shortcut-modal]')].map((e) => e.getAttribute('data-shortcut-modal')) } })()`)
  say(opened, 'V8c-P2', '真输入点击触发器 ⇒ 设置模态框打开（[data-shortcut-modal=settings][role=dialog]）',
    click.ok
      ? `触发器 <${click.tag}>「${click.label}」via ${click.via}${click.hit && click.hit !== 'self' ? `｜🔴 命中点实际是 ${click.hit}` : ''}；模态框=${opened}${diag ? '；实测=' + JSON.stringify(diag) : ''}`
      : '未找到触发器（aria-label="Settings" / aria-haspopup="dialog" / 文字匹配皆未命中）')

  // ── V8c-P3 我方 section 的**导航行**是元素（证明 settings.section 真注册了）──
  const rows = opened
    ? await evalJs(`[...(${PANEL_EXPR}).querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter((s) => s.length > 0 && s.length < 30).slice(0, 20)`)
    : []
  const rowFound = opened ? await waitFor(`!!(${OUR_ROW_EXPR})`, 6000) : false
  say(rowFound, 'V8c-P3', `我方 section 导航行作为元素出现（label 逐字「${OUR_LABEL}」）`,
    rowFound ? `面板导航行 = ${JSON.stringify(rows)}` : `未找到「${OUR_LABEL}」行；面板内按钮文案 = ${JSON.stringify(rows)}`)

  // ── V8c-P4 点我方导航行 ⇒ 我方页面**作为元素**渲染 ──
  // 🔴 元素级：`querySelector('.ss-title')` 必须是 HTMLElement（不是"类名出现在文本里"）
  let clickedRow = { ok: false, via: 'skipped（上一环未过）' }
  let oursRendered = false
  let detail = ''
  if (rowFound) {
    clickedRow = await realClick(OUR_ROW_EXPR)
    oursRendered = await waitFor(`(() => { const t = document.querySelector('.ss-title')
      return !!t && t instanceof HTMLElement && (t.textContent || '').includes(${JSON.stringify(OUR_LABEL)}) })()`, 6000)
    const probe = await evalJs(`(() => { const t = document.querySelector('.ss-title')
      return { ssTitle: !!t, ssText: (t?.textContent || '').trim().slice(0, 40),
        ourEls: document.querySelectorAll('[class^="ss-"], [class*=" ss-"]').length,
        panelTail: (${PANEL_EXPR}?.innerText || '').replace(/\\s+/g, ' ').slice(-220) } })()`)
    detail = `经 ${clickedRow.via} 点我方行；.ss-title 元素=${probe?.ssTitle} 文本=「${probe?.ssText ?? ''}」／我方 class 元素 ${probe?.ourEls ?? 0} 个／面板尾部=「${probe?.panelTail ?? ''}」`
  }
  say(oursRendered, 'V8c-P4', '我方 UI **作为元素**被渲染（querySelector 命中，非字符串包含）', detail)

  console.log(`V8c-RESULT PASS=${PASS.length} FAIL=${FAIL.length}`)
  process.exit(FAIL.length === 0 ? 0 : 1)
} catch (e) {
  say(false, 'V8c', '设置面板元素级渲染（容器内 CDP）', `读数器失败：${String(e?.message ?? e).slice(0, 200)}`)
  console.log(`V8c-RESULT PASS=${PASS.length} FAIL=${FAIL.length}`)
  process.exit(2)
} finally {
  reap()
}
