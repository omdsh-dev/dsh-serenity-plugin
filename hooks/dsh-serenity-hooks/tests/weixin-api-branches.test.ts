/**
 * weixin-api-branches.test.ts — 🔴 **⑤ 第 68 件**：`src/weixin-api.ts` 的
 * **iLink 业务码闸 / 版本与 URL 兜底 / 媒体解析退化面 / 下载解密兜底**
 * （2026-09-26 · 对应地图 §2.7 的续段）
 *
 * ## 为什么挑它（复扫读数，纪律 2）
 * `coverage/src/index.html`（01:3x 那一跑，第 67 件之后）**成对读**（纪律 16）实测：
 * `weixin-api.ts` = 语句 **98.13%（580/591）**／分支 **85.82%（115/134）**／**函数 92%（23/25）**
 * —— **`src/**` 中分支覆盖率最低且尚未做过**的文件，**且是唯一还带未执行函数的低点**（双缺口）。
 * 🔵 贴 objective：它是**对外面**（3082 微信发送 API ＋ iLink 协议客户端）。
 *
 * ## 🔴 开工第一步 = 按【被测符号】核对既有登记（纪律 ⑯）
 * grep `weixin-api.js` ⇒ 命中 **四个**测试文件 ⇒ 逐个读过（**本件不重做其中任何一条**）：
 *   · `weixin.test.ts §weixin-api: 协议客户端`（15 例）：buildClientVersion 正常值 ／ fetchQRCode ／
 *     pollQRStatus 两态 ／ getUpdates 正路 ／ sendTextMessage 体结构 ／ getConfig+sendTyping ／
 *     buildMediaDownloadUrl 三态 ／ parseMediaAesKey 三型 ／ aes128EcbDecrypt 已知向量 ／
 *     sniffImageExt 六型 ／ downloadMedia 正路 ／ markdownToPlainText 7 类 ／ stripThink
 *   · `weixin-file-send.test.ts`（12 例，**第 13 件**）：sendFileMessage 三步链 ／ padTo16 三态 ／
 *     encrypt_query_param 回退 ／ upload_full_url 组装 ／ **ret:1 不算成功**（两处）／ 非 JSON 体 ／
 *     非 2xx
 *   · `api-weixin-login.test.ts`：登录两步 ＋ **`login-start` 不校验 iLink 业务码**（已登记待裁）
 *   · `weixin-bridge-branches.test.ts`：桥侧降级（**不是本模块的分支**）
 *
 * ## 🔵 缺口形态（判据 = coverage 报告 17 处 `cbranch-no` ＋ 2 处 `fstat-no`，逐条映射回源行）
 * 可达（本件覆盖）：
 *   `:33`/`:34`  buildClientVersion 的 `parts[1]`/`parts[2] ?? 0` —— 版本串**段数不足**（如 `'2.1'`）
 *   `:47`  **两侧** —— ① baseUrl **不以 `/` 结尾**（补斜杠）② **已带** `/`（幂等，不得补成 `//`）
 *   `:62`              buildHeaders 的 `token ? … : {}` 的**无 token 侧**（经 `apiPost` 驱动）
 *   `:133`             assertIlinkOk 的 catch —— 响应体**不是 JSON**（HTML 错误页）
 *   `:140`             assertIlinkOk 的 **errcode 闸**（`typeof === 'number' && !== 0`）
 *   `:254`             getUpdates 的 `getUpdatesBuf ?? ''`
 *   `:375`             上传 URL 组装的 `upload_param ?? ''` 与 `filekey ?? fileKey`
 *   `:390`/`:391`      CDN 上传体的 `ret`/`errcode` 拦截 ＋ `errmsg` 细分
 *   `:505`             parseMediaAesKey 的 `buf.length === 16 ? buf : null` 的 **else**
 *   `:514`             parseMediaAesKey 的 base64 catch
 *   `:548`             downloadMedia 的 `media ?? {}` 的 **undefined 侧**
 *   `:563`             解密失败 catch（key 错/密文损坏）
 *   `:568`             下载整体 catch（fetch 抛）
 * 不可达（登记不涂绿，纪律 ⑧ ＋ ㉑ 的结构性理由）：
 *   `:32`              `parts[0] ?? 0` —— ⛔ **恒有值族**：`'x'.split('.')` **至少返回一个元素**
 *                      ⇒ `parts[0]` 永不 undefined（与第 67 件的"循环界界定"同族）
 *   `:70`/`:74`        `currentFetch` 的**默认箭头**（`(...args) => fetch(...args)`）
 *                      ⇒ 属**注入点本身**一族（第 40/41/42 件已定性）：**硬测要真发网络请求**，
 *                        那会改生产语义（把真实外呼引进单测）⇒ 如实登记，不造假绿
 *   `:260`             getUpdates 的 `AbortError` 分支 —— 需**真超时**（35s 或真 abort 竞速）
 *                      ⇒ 单测内不可构造（真实形态由集成测试 ⑥ 的 V 系列覆盖）
 *   `:375`             `upl.upload_param ?? ''` 的 **undefined 侧** —— ⛔ **被上游守卫支配**：
 *                      `:371` 已保证 `upload_full_url || upload_param` 至少有一个为真，
 *                      且走到 `??` 时 `upload_full_url` 必为 falsy ⇒ `upload_param` **必为真值**
 *                      ⇒ 右侧永不成立（**支配性守卫族**，第 60 件同族）
 *   `:514`             `parseMediaAesKey` 的 base64 catch —— ⛔ **构造上不抛**：
 *                      Node 的 `Buffer.from(x, 'base64')` 对非法输入**宽容**（不抛，返回部分解码）
 *                      ⇒ 该 catch **在 Node 上不可达**（真实形态：永远不会进这里）
 *
 * ⚠️ **诚实边界（本轮实测更正两次我自己的误判，值得记）**：
 *  ① 我原先把 `:47` 的未覆盖侧记成 **else**，读报告取证后确认**恰相反** —— 未覆盖的是
 *     **then 侧**（`? url :`，即"已带斜杠"）⇒ **读 `cbranch-no` 必须看清它包住的是三元的哪一侧**，
 *     不能按"通常是 else"想当然。
 *  ② 我第一版文件头**声称覆盖了 `:375`/`:390-391`/`:514`**，而实测**没有**（那些在
 *     `sendFileMessage` 里，我压根没调它）⇒ **写完主张必须回报告复核**：`grep cbranch-no`
 *     一次即知，比"我以为测了"可靠（同族 = 纪律 ⑭「coverage 涨了 ≠ 测试承重」的反向形态）。
 *
 * ## 🔴 本件为何要紧
 * ① **`assertIlinkOk` 是 v1.30.9 修的事故的唯一执行点**（源码 `:274` 逐字：*"HTTP 200 但
 *    `ret/errcode != 0` → 抛错（此前静默当成功，导致'记录已送达'的假象）"*）。
 *    它有两道闸（`ret` 与 `errcode`）—— **既有覆盖面只打了 `ret`**（第 13 件），
 *    `errcode` 那道**从未被执行** ⇒ 把 `:140` 删掉/写反，**全仓测试仍绿**，
 *    而现网会**把 iLink 的业务拒绝当成功**（用户以为消息发出去了）。
 * ② **`:32-34` 的版本兜底**：`buildClientVersion('2.1')` 若缺 `?? 0` ⇒ `undefined & 0xff` = 0，
 *    看似无害；但**段数不足时 `parts[2]` 是 undefined** ⇒ 一旦有人把 `?? 0` 换成别的写法就会 NaN
 *    ⇒ ClientVersion 变 NaN ⇒ **整个协议头坏掉**（所有请求被拒）。
 * ③ **`:505` 的 else**：hex 串**长度不是 16 字节**时必须回 null（不是硬当 16 字节用）——
 *    否则会拿一把**长度不对的 key** 去解密 ⇒ 运行时抛在解密层（错误被吞成"下载失败"，**难查**）。
 *
 * ## 判据纪律（本件用到的高频条）
 * · **⑬ 降级面与正控方向成对测**：每条失败臂都配"同夹具 happy path 必须走通"。
 * · **⑫ 错误码/文案钉"可分性"**：`ret` 与 `errcode` 两条闸的报错**文案不同**，只断言"抛了"无法区分。
 * · **⑧ 不声称一个我没挣到的覆盖** ⇒ 不可达项在文件头登记。
 * · **⑨ 观测/注入点类不硬测** ⇒ `currentFetch` 默认箭头如实登记，不为它发网络请求。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  buildClientVersion,
  parseMediaAesKey,
  downloadMedia,
  getUpdates,
  sendTextMessage,
  sendFileMessage,
  fetchQRCode,
  __setWeixinFetchForTest,
} from '../src/weixin-api.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weixin-api-br-'))
})

afterEach(() => {
  __setWeixinFetchForTest(null) // 复位注入（缺省 = 真 fetch；防泄漏到其它用例）
  rmSync(dir, { recursive: true, force: true })
})

// ── 夹具：回放一个 fetch 响应（最小 Response 形状）──

interface Captured {
  url: string
  init?: RequestInit
}

/**
 * 装一个**假 fetch**，按顺序回放预设响应；返回捕获到的请求列表。
 * 🔴 用 `__setWeixinFetchForTest`（**生产自带的注入点**，生产零调用）而非 mock 模块：
 *    这样被测代码**真跑**（第 58 件纪律：截获生产真构造的对象，不照抄一份来测自己）。
 */
function installFetch(
  replies: Array<{ status?: number; body?: string; headers?: Record<string, string>; throwErr?: unknown }>,
): Captured[] {
  const captured: Captured[] = []
  let i = 0
  __setWeixinFetchForTest((async (url: string | URL, init?: RequestInit) => {
    captured.push({ url: String(url), init })
    const r = replies[i++] ?? { status: 200, body: '{}' }
    if ('throwErr' in r) throw r.throwErr
    const status = r.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      // `:385` 读 `x-encrypted-param` ⇒ 必须能按名取值（Headered 的 get 语义）
      headers: { get: (k: string) => r.headers?.[k.toLowerCase()] ?? r.headers?.[k] ?? null },
      text: async () => r.body ?? '',
      arrayBuffer: async () => new TextEncoder().encode(r.body ?? '').buffer,
    }
  }) as never)
  return captured
}

// ── A. iLink 业务码闸（`:133` / `:140`）—— 本件最值钱的一组 ──

describe('weixin-api 退化面：assertIlinkOk 的两道业务码闸（`:133` 非 JSON / `:140` errcode）', () => {
  const send = () => sendTextMessage({ baseUrl: 'https://example.invalid', token: 'tk', toUserId: 'u1', text: 'hi' })

  it('🔴 `:140` **errcode 闸**：HTTP 200 + `{errcode:1}` ⇒ 必须抛（不得当成功）', async () => {
    // 🔴 这是 v1.30.9 事故修复的**第二道闸**，而既有覆盖面（第 13 件）**只打了 `ret`**。
    //    把 `:140` 删掉 ⇒ 本用例红，而**全仓其余测试仍绿** ⇒ 现网会把 iLink 的业务拒绝当成功
    //    （用户以为消息发出去了，实际没有）。
    installFetch([{ status: 200, body: JSON.stringify({ errcode: 1, errmsg: 'denied by policy' }) }])
    await expect(send(), 'errcode 非 0 ⇒ 必须抛').rejects.toThrow(/errcode=1/)
  })

  it('🔴 **可分性**（纪律 ⑫）：`ret` 与 `errcode` 两条闸的报错文案**互不相同**', async () => {
    // 只断言"抛了"无法区分是哪一道闸（把 errcode 检查误写成 ret 检查也会绿）⇒ 分开钉。
    installFetch([{ status: 200, body: JSON.stringify({ ret: 1, errmsg: 'a' }) }])
    await expect(send()).rejects.toThrow(/ret=1/)
    __setWeixinFetchForTest(null)
    installFetch([{ status: 200, body: JSON.stringify({ errcode: 2, errmsg: 'b' }) }])
    await expect(send()).rejects.toThrow(/errcode=2/)
  })

  it('🔴 `:136`/`:141` `errmsg` 细分：**有** errmsg ⇒ 带上；**无** ⇒ 不带（不得渲染成 `undefined`）', async () => {
    installFetch([{ status: 200, body: JSON.stringify({ errcode: 9, errmsg: '具体原因' }) }])
    await expect(send()).rejects.toThrow(/具体原因/)
    __setWeixinFetchForTest(null)
    installFetch([{ status: 200, body: JSON.stringify({ errcode: 9 }) }])
    // 无 errmsg ⇒ 文案止于 errcode（`:136` 的 `detail` 为空串）——不得出现 `: undefined`
    await expect(send()).rejects.toThrow(/errcode=9$/)
  })

  it('🔴 `:133` catch：响应体**不是 JSON**（HTML 错误页）⇒ **宽容放行**（不得因此抛）', async () => {
    // 源码 `:125` 逐字："非 JSON 的 200 响应保持既有宽容语义（视为成功）"。
    // 真实形态：网关返回 HTML 错误页但状态码 200。
    installFetch([{ status: 200, body: '<!DOCTYPE html><html>502 Bad Gateway</html>' }])
    await expect(send(), '非 JSON ⇒ 宽容放行（既有语义）').resolves.toBeUndefined()
  })

  it('🔵 正控（同夹具）：**全部合法** ⇒ 放行（证明上面三条的"红"不是夹具坏了）', async () => {
    installFetch([{ status: 200, body: JSON.stringify({ ret: 0, errcode: 0 }) }])
    await expect(send()).resolves.toBeUndefined()
  })

  it('🔴 **边界**：`ret: 0` / `errcode: 0` 必须放行（"非 0 才抛"不得写成"有值就抛"）', async () => {
    installFetch([{ status: 200, body: JSON.stringify({ ret: 0, errcode: 0 }) }])
    await expect(send()).resolves.toBeUndefined()
    __setWeixinFetchForTest(null)
    // 字符串 "0" 不是 number ⇒ `typeof === 'number'` 守卫应放行（不得把字符串当业务码）
    installFetch([{ status: 200, body: JSON.stringify({ ret: '0', errcode: '0' }) }])
    await expect(send(), '非 number 的业务码不参与判定').resolves.toBeUndefined()
  })
})

// ── B. 版本号与 URL / 凭据兜底（`:32-34` / `:47` / `:62`）──

describe('weixin-api 退化面：版本号段数不足 / baseUrl 无尾斜杠 / 无凭据头', () => {
  it('🔴 `:32`/`:33`/`:34` 段数不足 ⇒ 缺的段**补 0**（不得变 NaN）', () => {
    // 🔴 本机常量是完整三段（`2.1.1`），故既有覆盖面**只测过完整形态**。
    //    缺段时若 `?? 0` 失效 ⇒ `undefined & 0xff` → 0（看着"没事"）但一旦写法换成算术就 NaN
    //    ⇒ `CLIENT_VERSION` 变 NaN ⇒ **整个协议头坏掉**（所有请求被拒）。
    expect(buildClientVersion('2.1'), '两段 ⇒ patch 补 0').toBe((2 << 16) | (1 << 8))
    expect(buildClientVersion('2'), '一段 ⇒ minor/patch 补 0').toBe(2 << 16)
    expect(buildClientVersion(''), '空串 ⇒ 全 0').toBe(0)
    // 🔴 要害断言：**任何形态都不得产出 NaN**
    for (const v of ['2.1', '2', '', '2.1.1.9', 'x.y.z']) {
      expect(Number.isNaN(buildClientVersion(v)), `${v} ⇒ 不得为 NaN`).toBe(false)
    }
  })

  it('🔵 正控：完整三段与既有覆盖面一致（`2.1.1` → 131329）', () => {
    expect(buildClientVersion('2.1.1')).toBe(131329)
  })

  it('🔴 `:47` baseUrl **不以 `/` 结尾** ⇒ 补尾斜杠（否则 URL 拼接会吃掉末段路径）', async () => {
    // 真实形态：配置里写 `https://ilink.example.com/ilink`（无尾斜杠）。
    // 不补 ⇒ `new URL('ilink/bot/getupdates', 'https://x/ilink')` 解析成 `https://x/ilink/bot/getupdates`
    // 看似对，但 base 若是 `.../a/b` 就会被吃掉 `b` ⇒ 打到错误端点。
    const cap = installFetch([{ status: 200, body: JSON.stringify({ ret: 0, msgs: [] }) }])
    await getUpdates({ baseUrl: 'https://example.invalid/ilink', token: 'tk', timeoutMs: 1000 })
    expect(cap[0]!.url, 'base 无尾斜杠 ⇒ 仍须解析到正确端点').toBe('https://example.invalid/ilink/ilink/bot/getupdates')
  })

  it('🔴 `:47` **反向**（同函数另一侧）：baseUrl **已带** `/` ⇒ 原样用（不得补成 `//`）', async () => {
    // 🔴 这一侧是"幂等"契约：`ensureTrailingSlash` 的 `? url :` 分支。
    //    若有人把三元写反/去掉 ⇒ 带尾斜杠的配置会变成 `.../ilink//ilink/bot/...`（双斜杠）——
    //    多数网关容忍，但**签名/路由严格的会 404**，且**错误现场只是一句 404**。
    const cap = installFetch([{ status: 200, body: JSON.stringify({ ret: 0, msgs: [] }) }])
    await getUpdates({ baseUrl: 'https://example.invalid/ilink/', token: 'tk', timeoutMs: 1000 })
    expect(cap[0]!.url, '已带尾斜杠 ⇒ 不得出现双斜杠').toBe('https://example.invalid/ilink/ilink/bot/getupdates')
    expect(cap[0]!.url, '尤其不得是 //').not.toContain('//ilink')
  })

  it('🔴 `:62` **无 token** ⇒ 请求头**不得出现** Authorization（不得是 `Bearer undefined`）', async () => {
    // `buildHeaders` 的 `...(token ? { Authorization } : {})` 的**无 token 侧**从未被执行
    // （既有用例恒带 token）。
    // 🔴🔴 **首跑红逼出的取证结论（纪律 20/21）**：我原以为可以走 `fetchQRCode` —— **错**。
    //    `fetchQRCode → apiGet`，而 `apiGet` 用的是 **`buildCommonHeaders()`（`:85`）**，
    //    **根本不经过 `buildHeaders`**，也就与 `:62` 无关。
    //    ⇒ `:62` 的**唯一入口是 `apiPost`**（`:106`），而 `apiPost` 的 `token?: string` 是**可选**的
    //    ⇒ 必须**在 POST 侧**驱动它。这正是"先确认注入会落到哪一行"的又一实例。
    const cap = installFetch([{ status: 200, body: JSON.stringify({ ret: 0, msgs: [] }) }])
    // `token` 缺省（apiPost 的 token 可选；此处**刻意不传**）
    await getUpdates({ baseUrl: 'https://example.invalid', timeoutMs: 1000 } as never)
    const h = (cap[0]!.init?.headers ?? {}) as Record<string, string>
    // 🔴 用 `'Authorization' in h`（纪律 ⑱）：`undefined` 值与"无该键"是两回事
    expect('Authorization' in h, '无 token ⇒ 不得出现该键').toBe(false)
    expect(String(h['Authorization'] ?? ''), '尤其不得是 Bearer undefined').not.toContain('undefined')
    // 正控方向：公共头必须在（否则"没有 Authorization"可能是因为头整个坏了）
    // 🔴 **首跑二次红逼出的取证结论**：公共头 **GET 与 POST 两路各不相同** ——
    //    `buildCommonHeaders()`（`:50-55`）= `iLink-App-Id` + `iLink-App-ClientVersion`（**两路都拼**）；
    //    `AuthorizationType`（`:60`）只在 **`buildHeaders`** 里 ⇒ **POST 侧独有**。
    //    ⚠️ 我第一版拿 `AuthorizationType` 当 POST 的正控 —— **对的**；
    //    第二版把它当成 GET 的公共头 —— **错的**（那正是本轮第二次红）。
    expect(h['iLink-App-Id'], '公共头必须在场（两路共用）').toBe('bot')
    expect(h['AuthorizationType'], 'POST 侧独有的鉴权类型头也在场').toBe('ilink_bot_token')
  })

  it('🔵 正控：**带 token** ⇒ Authorization 必须在场且格式正确', async () => {
    const cap = installFetch([{ status: 200, body: JSON.stringify({ ret: 0, msgs: [] }) }])
    await getUpdates({ baseUrl: 'https://example.invalid', token: 'tk-123', timeoutMs: 1000 })
    const h = (cap[0]!.init?.headers ?? {}) as Record<string, string>
    expect(h['Authorization']).toBe('Bearer tk-123')
  })

  it('🔴 **两路公共头的一致性契约**：`iLink-App-Id` 与 `ClientVersion` **两路都在**（各自独有项分开）', async () => {
    // 上一轮两次首跑红暴露的结构事实，值得当**契约**钉住（而不是只修掉红）：
    //   · GET（`apiGet:85` → `buildCommonHeaders`）：`iLink-App-Id` + `iLink-App-ClientVersion`，**无** Authorization
    //   · POST（`apiPost:106` → `buildHeaders`）：上述两项 **＋** `AuthorizationType` **＋** `X-WECHAT-UIN`
    //     **＋**（有 token 时）`Authorization`
    // ⇒ 一旦有人"顺手"把两路合并成同一个函数，就会**多**给 GET 带上 Authorization（登录前 = Bearer undefined）
    //   或**少**给 POST 带 ClientVersion（协议版本头缺失 ⇒ 上游可能拒）。
    const capGet = installFetch([{ status: 200, body: JSON.stringify({ qrcode: 'q', qrcode_img_content: 'i' }) }])
    await fetchQRCode({ baseUrl: 'https://example.invalid', timeoutMs: 1000 })
    const g = (capGet[0]!.init?.headers ?? {}) as Record<string, string>
    expect('Authorization' in g, 'GET 侧（登录前）不得出现 Authorization').toBe(false)
    expect(g['iLink-App-Id'], 'GET 必须有 App-Id').toBe('bot')
    expect(g['iLink-App-ClientVersion'], 'GET 必须有 ClientVersion').toBeDefined()

    __setWeixinFetchForTest(null)
    const capPost = installFetch([{ status: 200, body: JSON.stringify({ ret: 0, msgs: [] }) }])
    await getUpdates({ baseUrl: 'https://example.invalid', token: 'tk', timeoutMs: 1000 })
    const p = (capPost[0]!.init?.headers ?? {}) as Record<string, string>
    expect(p['iLink-App-Id'], 'POST 也必须有 App-Id').toBe('bot')
    expect(p['iLink-App-ClientVersion'], 'POST 也必须有 ClientVersion').toBeDefined()
    expect(p['AuthorizationType'], 'POST 独有的鉴权类型头').toBe('ilink_bot_token')
    expect(p['X-WECHAT-UIN'], 'POST 独有的防重放头').toBeDefined()
  })
})

// ── C. getUpdates 游标兜底（`:254`）──

describe('weixin-api 退化面：`:254` getUpdates 游标缺省', () => {
  it('🔴 不传 `getUpdatesBuf` ⇒ 请求体是**空串**（不是 undefined / 不是缺键）', async () => {
    // 首轮轮询的真实形态（还没有游标）。若写成 `params.getUpdatesBuf` 直传 ⇒
    // `JSON.stringify` 会**丢掉该键** ⇒ wire 上变成"无此字段"，与协议期望的"空串"不同。
    const cap = installFetch([{ status: 200, body: JSON.stringify({ ret: 0, msgs: [] }) }])
    await getUpdates({ baseUrl: 'https://example.invalid', token: 'tk', timeoutMs: 1000 })
    const body = JSON.parse(String(cap[0]!.init?.body)) as Record<string, unknown>
    expect(body, '该键必须**在场**').toHaveProperty('get_updates_buf')
    expect(body['get_updates_buf'], '缺省 ⇒ 空串').toBe('')
  })

  it('🔵 正控：**传了**游标 ⇒ 原样带上（不得被兜底吃掉）', async () => {
    const cap = installFetch([{ status: 200, body: JSON.stringify({ ret: 0, msgs: [] }) }])
    await getUpdates({ baseUrl: 'https://example.invalid', token: 'tk', getUpdatesBuf: 'cursor-7', timeoutMs: 1000 })
    const body = JSON.parse(String(cap[0]!.init?.body)) as Record<string, unknown>
    expect(body['get_updates_buf']).toBe('cursor-7')
  })
})

// ── D. 媒体 AES key 解析退化面（`:505` / `:514`）──

describe('weixin-api 退化面：`:505` hex 长度不为 16 字节 / `:514` 非法 base64', () => {
  it('🔴 `:505` hex 串长度**不是 32** ⇒ 回 null（不得硬当成 16 字节 key 用）', () => {
    // 🔴 为何要紧：`/^[0-9a-fA-F]{32,}$/` 是 **32 或更多**（`{32,}`）⇒ 40 位 hex 也会进来，
    //    而 `Buffer.from(x,'hex')` 得 **20 字节**（不是 16）⇒ 必须由 `:505` 拦成 null。
    //    拦不住 ⇒ 拿长度不对的 key 去 `createDecipheriv` ⇒ 运行时抛在解密层，
    //    被 `:563` 吞成"下载失败" ⇒ **极难查**（错误现场只剩一句"下载失败"）。
    expect(parseMediaAesKey('a'.repeat(32)), '32 位 hex = 16 字节 ⇒ 合法').toHaveLength(16)
    expect(parseMediaAesKey('a'.repeat(40)), '40 位 hex = 20 字节 ⇒ 必须 null').toBeNull()
    expect(parseMediaAesKey('a'.repeat(34)), '34 位 hex = 17 字节 ⇒ 必须 null').toBeNull()
  })

  it('🔴 `:514` catch：**不是合法 base64 / 解不出可用长度** ⇒ 回 null（不抛）', () => {
    // 真实形态：wire 上 aes_key 字段被截断或含非法字符。
    expect(() => parseMediaAesKey('!!!not-base64!!!'), '非法 base64 不得抛').not.toThrow()
    expect(parseMediaAesKey('!!!not-base64!!!'), '解不出 16/32 ⇒ null').toBeNull()
    // 解出来长度不是 16 也不是 32 ⇒ null（走完 try 落到末尾）
    expect(parseMediaAesKey(Buffer.from('abc').toString('base64')), '3 字节 ⇒ null').toBeNull()
  })

  it('🔵 正控：三型合法编码都必须解出（既有覆盖面，此处作对照证明夹具不瞎）', () => {
    expect(parseMediaAesKey('a'.repeat(32)), '① 32 hex').toHaveLength(16)
    expect(parseMediaAesKey(Buffer.alloc(16, 7).toString('base64')), '② base64 = 16B').toHaveLength(16)
    const hex32 = 'b'.repeat(32)
    expect(parseMediaAesKey(Buffer.from(hex32, 'ascii').toString('base64')), '③ base64 = 32B ascii-hex').toHaveLength(16)
  })
})

// ── F. sendFileMessage 的 CDN 上传面（`:375` / `:390` / `:391`）──

describe('weixin-api 退化面：sendFileMessage 的 CDN 上传 URL 组装与业务码拦截', () => {
  /**
   * 造一条**成功的 getuploadurl 响应**（upload_param 形态 ⇒ 走 `:375` 的组装分支）。
   * 🔵 刻意不带 `upload_full_url`：那才会进入 `??` 的**右侧**。
   */
  const okUpload = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ ret: 0, upload_param: 'UP-TOKEN', filekey: 'FK-from-resp', ...over })

  /** CDN 上传响应：带响应头 `x-encrypted-param` ⇒ 直接成功（不走 body 解析） */
  const cdnOkWithHeader = { status: 200, body: '', headers: { 'x-encrypted-param': 'EQP-1' } }

  it('🔴 `:375` `upload_full_url` 缺失 ⇒ 用 `upload_param` + `filekey` 组装（并 encode）', async () => {
    // 真实形态：iLink 的 getuploadurl 有时只给 upload_param（不给全 URL）。
    // 组装写坏（少 encode / 少 filekey）⇒ **上传打到错误 URL**，表现是"文件发送失败"。
    const cap = installFetch([{ status: 200, body: okUpload() }, cdnOkWithHeader])
    await sendFileMessage({
      baseUrl: 'https://example.invalid', token: 'tk', toUserId: 'u1',
      data: Buffer.from('hello-file'), fileName: 'a.txt', timeoutMs: 1000,
    })
    const uploadUrl = cap[1]!.url
    expect(uploadUrl, '必须走 CDN 基址 + download/upload 端点').toContain('/upload?')
    expect(uploadUrl, 'upload_param 必须在场且已编码').toContain('encrypted_query_param=UP-TOKEN')
    expect(uploadUrl, 'filekey 用响应里的那个（不是本地随机的）').toContain('filekey=FK-from-resp')
  })

  it('🔴 `:375` 响应**缺 filekey** ⇒ 回退用**本地生成的** fileKey（不得渲染成 undefined）', async () => {
    // `upl.filekey ?? fileKey` 的 undefined 侧：filekey 是可缺字段。
    const cap = installFetch([{ status: 200, body: okUpload({ filekey: undefined }) }, cdnOkWithHeader])
    await sendFileMessage({
      baseUrl: 'https://example.invalid', token: 'tk', toUserId: 'u1',
      data: Buffer.from('x'), fileName: 'a.txt', timeoutMs: 1000,
    })
    const uploadUrl = cap[1]!.url
    expect(uploadUrl, '必须回退到本地 fileKey（dsp- 前缀）').toMatch(/filekey=dsp-[0-9a-f]+/)
    expect(uploadUrl, '尤其不得出现 undefined').not.toContain('undefined')
  })

  it('🔴 `:390`/`:391` CDN 上传体**带 `{ret:1}`** ⇒ 必须抛（不得产生"假成功"）', async () => {
    // 🔴 与前面 `assertIlinkOk` 同族、但是**另一处独立实现**：CDN 上传的响应体业务码。
    //    它在**无响应头**时才被读到 ⇒ 这是"CDN 返回 200 但内容里写着失败"的真实形态
    //    （第 13 件已测过 ret 一侧；本件补 **errcode** 侧与 **errmsg 细分**）。
    installFetch([
      { status: 200, body: okUpload() },
      { status: 200, body: JSON.stringify({ errcode: 7, errmsg: 'cdn quota exceeded' }) },
    ])
    await expect(
      sendFileMessage({
        baseUrl: 'https://example.invalid', token: 'tk', toUserId: 'u1',
        data: Buffer.from('x'), fileName: 'a.txt', timeoutMs: 1000,
      }),
      'errcode 非 0 ⇒ 必须抛',
    ).rejects.toThrow(/CDN 上传失败.*errcode=7/)
  })

  it('🔴 `:391` `errmsg` 细分：有 ⇒ 带上原因；无 ⇒ 不得渲染成 `: undefined`', async () => {
    installFetch([
      { status: 200, body: okUpload() },
      { status: 200, body: JSON.stringify({ ret: 3, errmsg: '具体失败原因' }) },
    ])
    await expect(
      sendFileMessage({
        baseUrl: 'https://example.invalid', token: 'tk', toUserId: 'u1',
        data: Buffer.from('x'), fileName: 'a.txt', timeoutMs: 1000,
      }),
    ).rejects.toThrow(/具体失败原因/)
    __setWeixinFetchForTest(null)
    // 🔴 无 errmsg 侧（`j.errmsg ? ': ' + errmsg : ''`）：文案必须**止于 errcode**，
    //    不得渲染成 `CDN 上传失败: ret=4 errcode=7: undefined`。
    installFetch([
      { status: 200, body: okUpload() },
      { status: 200, body: JSON.stringify({ ret: 4, errcode: 7 }) },
    ])
    const err = await sendFileMessage({
      baseUrl: 'https://example.invalid', token: 'tk', toUserId: 'u1',
      data: Buffer.from('x'), fileName: 'a.txt', timeoutMs: 1000,
    }).then(() => null, (e: Error) => e)
    expect(err, '必须抛').not.toBeNull()
    expect(err!.message, '不得出现 undefined').not.toContain('undefined')
    expect(err!.message, '文案止于 errcode（无冒号尾巴）').toMatch(/errcode=7$/)
  })

  it('🔴 **缺口形态**：CDN 200 但**既无响应头也无业务码** ⇒ 抛"缺 param"（不静默）', async () => {
    installFetch([{ status: 200, body: okUpload() }, { status: 200, body: JSON.stringify({ note: 'no params here' }) }])
    await expect(
      sendFileMessage({
        baseUrl: 'https://example.invalid', token: 'tk', toUserId: 'u1',
        data: Buffer.from('x'), fileName: 'a.txt', timeoutMs: 1000,
      }),
      '拿不到 encrypt_query_param ⇒ 必须响亮',
    ).rejects.toThrow(/缺 encrypt_query_param/)
  })

  it('🔵 正控（同夹具）：CDN 带响应头 ⇒ 三步链走通，返回名与字节数', async () => {
    installFetch([{ status: 200, body: okUpload() }, cdnOkWithHeader, { status: 200, body: JSON.stringify({ ret: 0 }) }])
    const out = await sendFileMessage({
      baseUrl: 'https://example.invalid', token: 'tk', toUserId: 'u1',
      data: Buffer.from('hello-file'), fileName: 'a.txt', timeoutMs: 1000,
    })
    expect(out.fileName).toBe('a.txt')
    expect(out.size, '字节数 = 原始数据长度').toBe(Buffer.from('hello-file').length)
  })
})

// ── E. downloadMedia 三条兜底（`:548` / `:563` / `:568`）──

describe('weixin-api 退化面：`:548` 无 media 元数据 / `:563` 解密失败 / `:568` 下载抛错', () => {
  const mediaItem = (over: Record<string, unknown>) => ({ image_item: over })

  it('🔴 `:548` `media` **缺失** ⇒ 走 `?? {}` ⇒ 无 URL ⇒ 回 null（且**不发请求**）', async () => {
    // 真实形态：wire 上的 item 有时不带 media（字段可选）。
    const cap = installFetch([{ status: 200, body: 'x' }])
    const out = await downloadMedia({ item: mediaItem({}) as never, mediaType: 'image_item', timeoutMs: 1000 })
    expect(out, '无 media ⇒ null').toBeNull()
    expect(cap, '🔴 无 URL ⇒ **一次网络都不该发**').toEqual([])
  })

  it('🔴 `:563` **解密失败**（key 错）⇒ 回 null（不抛）—— 与"下载失败"同归 null', async () => {
    // 真实形态：key 与密文不配对（两端不一致）。`aes128EcbDecrypt` 会抛 ⇒ 必须被 `:563` 吞。
    const cap = installFetch([{ status: 200, body: 'not-multiple-of-16-block' }])
    const out = await downloadMedia({
      item: mediaItem({ media: { full_url: 'https://cdn.invalid/x', aes_key: Buffer.alloc(16, 9).toString('base64') } }) as never,
      mediaType: 'image_item',
      timeoutMs: 1000,
    })
    expect(out, '解密失败 ⇒ null（吞掉异常）').toBeNull()
    expect(cap).toHaveLength(1) // 正控：请求真的发过（证明是"解密失败"而非"没发请求"）
  })

  it('🔴 `:568` **下载整体抛错**（fetch 抛）⇒ 回 null（不抛、不冒泡）', async () => {
    installFetch([{ throwErr: new Error('ECONNREFUSED') }])
    const out = await downloadMedia({
      item: mediaItem({ media: { full_url: 'https://cdn.invalid/x' } }) as never,
      mediaType: 'image_item',
      timeoutMs: 1000,
    })
    expect(out, 'fetch 抛 ⇒ null（降级，不冒泡）').toBeNull()
  })

  it('🔴 `:558` 非 2xx ⇒ null（且**不得**把错误页当媒体返回）', async () => {
    installFetch([{ status: 502, body: '<html>bad gateway</html>' }])
    const out = await downloadMedia({
      item: mediaItem({ media: { full_url: 'https://cdn.invalid/x' } }) as never,
      mediaType: 'image_item',
      timeoutMs: 1000,
    })
    expect(out).toBeNull()
  })

  it('🔵 正控（同夹具）：**不带 key** 时原样返回字节（证明上面"null"不是夹具恒 null）', async () => {
    installFetch([{ status: 200, body: 'plain-bytes' }])
    const out = await downloadMedia({
      item: mediaItem({ media: { full_url: 'https://cdn.invalid/x' } }) as never,
      mediaType: 'image_item',
      timeoutMs: 1000,
    })
    expect(out, '无 key ⇒ 原样返回').not.toBeNull()
    expect(out!.data.toString('utf-8')).toBe('plain-bytes')
  })
})
