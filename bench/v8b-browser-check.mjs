/**
 * v8b-browser-check.mjs — **渲染面**证据（V8b）：在容器内用 headless chromium 真渲染一次宿主页面。
 *
 * 为什么必须新增（判据阶梯的第四档）：
 *   V6b = 契约层（服务端有 configure/describe/update）
 *   V6c = 功能层（两条 settings 依赖的功能没被静默跳过）
 *   V8  = **交付层**（宿主真发给浏览器的 client bundle 里，我们那张设置页在场）——**作者自述"非真浏览器证据"**
 *   V8b = **渲染层**（真 JS 引擎跑一遍页面，DOM 里出现我方 UI 的标记）← 本文件
 * 🔴 为什么前三档回答不了 A19：那次十键漏标 `.volatile()` ⇒ 命名空间从不进 `describe`
 *    ⇒ **面板整块消失**，而日志里**一条报错都没有**（V6b 全绿）。只有真渲染才看得见"页没了"。
 *
 * 判据（每条都打印读数，便于失败时定位，不"只给一个红叉"）：
 *   P1 页面在真引擎里**启动**：dump 出的 DOM 长度 > 2000 且含应用挂载点（`id="root"`）
 *   P2 我方 UI **真的渲染出来了**：DOM 里出现我们的品牌/面板标记（`Serenity` ／ `sp-brand` ／ `ss-title`）
 *   P3 渲染过程**无 JS 致命错误**（chromium stderr 里无 `Uncaught`/`ReferenceError`/`TypeError` 命中）
 *   P4 落一张**截图**到 /logs（证据工件，不参与判断）
 *
 * 退出码：0 = P1&P2&P3 全过 ｜ 1 = 判据失败 ｜ 2 = 读数器不可用（chromium 不在 ⇒ 明确报，不静默绿）
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const LOG = '/logs'
const TOKEN_RE = /token=([A-Za-z0-9_-]+)/
const PASS = []
const FAIL = []

function say(ok, id, label, extra = '') {
  const row = `${ok ? 'PASS' : 'FAIL'} ${id}  ${label}${extra ? '  ' + extra : ''}`
  console.log(row)
  ;(ok ? PASS : FAIL).push(id)
}

/** 从宿主日志里取带 token 的 URL（无 token ⇒ 页面会拒绝，不能拿来判渲染） */
function pageUrl() {
  const logPath = `${LOG}/dsh-web.log`
  if (!existsSync(logPath)) return null
  const text = readFileSync(logPath, 'utf-8')
  const m = TOKEN_RE.exec(text)
  if (!m) return null
  return `http://127.0.0.1:3080/?token=${m[1]}`
}

function chromium(args, timeoutMs = 60_000) {
  try {
    const out = execFileSync('chromium', args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    })
    return { ok: true, out, err: '' }
  } catch (e) {
    return { ok: false, out: String(e?.stdout ?? ''), err: String(e?.stderr ?? e?.message ?? '') }
  }
}

/**
 * headless chromium 的公共旗标（容器内 root ⇒ 必须 --no-sandbox；/dev/shm 小 ⇒ 显式声明）
 * 🔴 **不要加 `--virtual-time-budget`** —— 2026-09-25 首跑实测：带上它 `--dump-dom` **永不返回**，
 *    被 60s 超时杀掉 ⇒ 探针只能报"chromium 起不来"（**读数器失败被误读成被测对象失败**）。
 *    去掉后同一命令立即 exit 0。⇒ 这里改用 chromium 自己的 `--timeout`（毫秒）兜底。
 */
const BASE = ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--timeout=20000']

const url = pageUrl()
if (url === null) {
  say(false, 'V8b', '渲染面（容器内真浏览器）', '前置不足：/logs/dsh-web.log 里没有 token（宿主未起？）')
  console.log(`V8b-RESULT PASS=${PASS.length} FAIL=${FAIL.length}`)
  process.exit(2)
}

// ── P1/P2：dump 渲染后的 DOM ──
// 🔴 2026-09-25 收紧（首版差点假绿）：**不能用 `html.includes('sp-brand')` 判"渲染出来了"** ——
//    我方 client CSS 是**注入成 `<style>` 的选择器文本**，类名在 CSS 里必然出现 ⇒ 那种匹配
//    连"组件一个都没渲染"时也会命中（**判据读的是 CSS 而不是 DOM 元素**）。
//    ⇒ 判据改为**元素属性形态**：DOM 里必须出现 `class="… ss-title …"` / `class="… sp-brand …"`
//       （即真有一个带该 class 的元素被渲染出来），并**分别打印两种命中的读数**好定位。
const ELEMENT_HIT = /class="[^"]*\b(?:ss-title|sp-brand|sp-serenity)\b[^"]*"/g
const CSS_TEXT_HIT = /\b(?:ss-title|sp-brand|sp-serenity)\b/g

/** 渲染一次并给出读数（DOM 长度／元素级命中／文本级命中） */
function renderOnce(target) {
  const dom = chromium([...BASE, '--dump-dom', target])
  const html = dom.out
  const elementHits = (html.match(ELEMENT_HIT) ?? []).filter((s) => s.trim().length > 0)
  const cssHits = (html.match(CSS_TEXT_HIT) ?? []).length
  const serenityText = html.includes('Serenity')
  return { ok: dom.ok, html, elementHits, cssHits, serenityText, err: dom.err, target }
}

const attempts = [url, `${url}#/settings`]
const results = attempts.map(renderOnce)
for (const r of results) {
  console.log(`      · ${r.target.includes('#') ? '设置路由' : '落地页'}: DOM=${r.html.length} 元素级命中=${r.elementHits.length} 类名文本命中(CSS)=${r.cssHits} 'Serenity'文本=${r.serenityText}`)
}
const best = results.find((r) => r.elementHits.length > 0) ?? results[0]
const html = best.html

if (html.includes('authentication required')) {
  // token 过期/缺失 ⇒ 这是**前置**问题，不是"面板没渲染"；明确区分（判据纪律：先分诊）
  console.log(`FAIL V8b  渲染面（容器内真浏览器）  前置不足：页面回「authentication required」（token 过期或未带上）`)
  console.log(`V8b-RESULT PASS=${PASS.length} FAIL=${FAIL.length + 1}`)
  process.exit(2)
}
const mounted = html.length > 2000 && html.includes('id="root"')
const elemHits = best.elementHits.length
say(mounted, 'V8b-P1', '页面在真引擎里启动（DOM 已挂载）', `DOM 长度=${html.length}`)

// ── P2：**浏览器真的把我方客户端模块取下来了吗**（网络层铁证）──
// 为什么用网络层而不是 DOM 元素级（2026-09-25 实测教训）：
//   ① 首版用 `html.includes('sp-brand')` 判"渲染了" ⇒ **假绿**：我方 client CSS 是**注入的 `<style>`**，
//      类名在 CSS 文本里必然出现（实测：元素级命中 **0**、CSS 文本命中 **3**）。
//   ② 收紧成"元素形态"后如实 FAIL，但**落地页没有会话**（截图实证 = "No sessions yet"）⇒
//      会话头胶囊本就不该渲染；设置页也不是路由可达（实测 `/settings`、`/?view=settings`、`/#/settings`
//      四种入口的元素级命中都是 **0**）⇒ **"元素真的渲染"必须靠 CDP 交互**（点开设置面板），
//      那是 **V8c**（已登记为后续增量）。
//   ⇒ 本档判"**模块真被浏览器请求并拿到**"：它严格强于 V8（V8 只看 profile 里有文件），
//      且**不依赖**页面当前展示哪一屏。
const netlog = `${LOG}/v8b-netlog.json`
chromium([...BASE, `--log-net-log=${netlog}`, '--dump-dom', url])
let netText = ''
try { netText = readFileSync(netlog, 'utf-8') } catch { /* 落不下来 ⇒ 下面如实报 */ }
const ourPkgHits = (netText.match(/dsh-serenity-hooks/g) ?? []).length
const clientJsHits = (netText.match(/client\.js/g) ?? []).length
say(ourPkgHits > 0, 'V8b-P2', '我方客户端模块**真被浏览器请求**（网络层铁证）',
  `netlog 命中 dsh-serenity-hooks ${ourPkgHits} 处 / client.js ${clientJsHits} 处；元素级渲染命中 ${elemHits}（0 = 本屏不该渲染，见 V8c）`)

// ── P3：渲染过程无致命 JS 错误 ──
const errText = results.map((r) => r.err).join('\n')
const fatalHits = (errText.match(/Uncaught|ReferenceError|TypeError/g) ?? []).length
say(fatalHits === 0, 'V8b-P3', '渲染过程无致命 JS 错误', `命中 ${fatalHits}`)

// ── P4：截图（证据工件；失败不影响判据）──
const shot = `${LOG}/v8b-panel.png`
const shotRes = chromium([...BASE, `--screenshot=${shot}`, '--window-size=1280,900', url], 90_000)
const shotOk = shotRes.ok && existsSync(shot)
console.log(`      · 截图${shotOk ? '已落' : '未落'}: ${shot}`)

// 失败时的现场摘要（不打印整页，避免噪声；§陷阱 §1 输出体量）
if (!mounted || ourPkgHits === 0) {
  const head = html.slice(0, 600).replace(/\s+/g, ' ')
  console.log(`      · DOM 摘要(前 600 字符): ${head}`)
  writeFileSync(`${LOG}/v8b-dom.html`, html)
  console.log(`      · 完整 DOM 已落: ${LOG}/v8b-dom.html`)
}

console.log(`V8b-RESULT PASS=${PASS.length} FAIL=${FAIL.length}`)
process.exit(FAIL.length === 0 ? 0 : 1)
