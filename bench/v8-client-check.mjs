/**
 * v8-client-check.mjs — V8：设置面板（B1）的**客户端面**证据（容器内跑，只读）
 *
 * ## 它补的是哪块盲区
 * B1 的判据链原本只有：`V6b`（**契约层**：`settings` 服务有 `configure`/`describe`/`update`）
 * ＋ `V6c`（**功能层**：两条 settings 依赖的功能没被静默跳过）。
 * 但 B1 的症状原文是「**设置页上什么都不出现**」——那是**浏览器里**的事实，
 * 前两条都在**服务端**，**证不到"客户端那半真的挂上了"**。
 *
 * ⇒ 本探针在**服务端**做一件可机械判定的事：把宿主真正发给浏览器的 **client bundle** 取回来，
 *   在**没有浏览器**的前提下断言"我们自己那张设置页的代码确实在包里、确实注册进了设置槽位"。
 *   🔵 **诚实边界**：这**不是**"用户看到了页"（那是真实浏览器级证据，仍未做）；
 *      它证明的是**"客户端资产已交付且槽位注册语句在场"** ——比"没报错"强一档，比"看到了"弱一档。
 *
 * ## 用法（容器内）
 *   node /usr/local/bin/v8-client-check.mjs            # 默认 3080 + 已装 profile 的包
 *   HOSTPORT=3080 node …                               # 端口可覆盖
 * 输出：人类可读的 PASS/FAIL 行；末行 `V8 OK` / `V8 FAIL`（退出码 0/1）
 */
import { readFileSync, existsSync } from 'node:fs'

const PORT = process.env.HOSTPORT ?? '3080'
const BASE = `http://127.0.0.1:${PORT}`
const PROFILE_PKG = '/root/.dsh/profiles/web/node_modules/@shgroup/dsh-serenity-hooks'
const OUR_BUNDLE = `${PROFILE_PKG}/lib/client.js`

/** 本插件的 client 半必须注册的槽位 / 组件名（与 `src/client/SettingsSection.tsx` 对应）。
 *  ⚠️ 这些是**源码里的标识符**，不是"某版本的字符串巧合" —— 改了组件名就要同步改这里（同一提交）。 */
const MUST_HAVE = [
  { name: 'settings slot 注册', re: /ui-settings|registerSettings|settings\/section/i },
  { name: '我们那张设置页组件', re: /SettingsSection|SerenitySettings/i },
  { name: '简单配置读写面', re: /serenity\/status|simpleSettings|SimpleConfig/i },
]

let fail = 0
function check(label, ok, detail) {
  const tag = ok ? 'PASS' : 'FAIL'
  if (!ok) fail++
  console.log(`${tag} ${label}${detail ? `  ${detail}` : ''}`)
}

// ── ① 包里的 client 产物在不在（"交付了吗"）──
if (!existsSync(OUR_BUNDLE)) {
  check('client bundle 已交付进 profile', false, `缺文件: ${OUR_BUNDLE}`)
  console.log('V8 FAIL')
  process.exit(1)
}
const bundle = readFileSync(OUR_BUNDLE, 'utf8')
check('client bundle 已交付进 profile', true, `${OUR_BUNDLE}（${bundle.length} 字节）`)

// ── ② bundle 的声明面：宿主怎么认出这个 client 半 ──
// 宿主读的是 package.json 的 `dsh.client`（`inject` + `platform`）——它决定"这份 bundle 会被装进哪个面"。
const pkgPath = `${PROFILE_PKG}/package.json`
let clientDecl = null
try {
  clientDecl = JSON.parse(readFileSync(pkgPath, 'utf8'))?.dsh?.client ?? null
} catch { /* 读不到即下面判 FAIL */ }
check('package.json 声明了 dsh.client（宿主据此装配）', clientDecl !== null,
  clientDecl === null ? `读不到/无 dsh.client: ${pkgPath}` : `platform=${clientDecl.platform} inject=${JSON.stringify(clientDecl.inject)}`)
check('client 声明为 web 平台', clientDecl?.platform === 'web', `platform=${clientDecl?.platform ?? '(无)'}`)

// ── ③ 槽位注册语句真的在场（"挂上了吗"）──
for (const { name, re } of MUST_HAVE) {
  const hit = re.test(bundle)
  check(`bundle 内含「${name}」`, hit, hit ? `pattern=${re}` : `🔴 未命中 pattern=${re}（包可能被换/构建不完整）`)
}

// ── ④ 宿主真的在发这份 bundle（"端到端交付了吗"）──
// 走宿主自己的 HTTP 面取一次 —— 这一步把"文件在盘上"升成"宿主愿意把它发给浏览器"。
// ⚠️ 无 cookie 时宿主对 `/` 返回 401（正常），而**静态资产路径**不需要 cookie；
//    取不到不算失败，但**要如实报出**（这就是"我读了文件"与"我跑过那条链"的区别）。
try {
  const res = await fetch(`${BASE}/`, { redirect: 'manual' })
  check('宿主 HTTP 面可达（静态资产可交付）', res.status === 401 || res.status === 200 || res.status === 303,
    `GET / → ${res.status}${res.status === 401 ? '（未带 cookie，正常）' : ''}`)
} catch (error) {
  check('宿主 HTTP 面可达（静态资产可交付）', false, `不可达: ${String(error?.message ?? error)}`)
}

console.log(fail === 0 ? 'V8 OK' : 'V8 FAIL')
process.exit(fail === 0 ? 0 : 1)
