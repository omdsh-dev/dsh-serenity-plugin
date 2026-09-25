/**
 * api-branch-defaults.test.ts — 🔴 **⑤ 第 60 件**：`src/api.ts` 的**兜底与降级分支**
 * （2026-09-26 · 对应地图 §2.7 的续段）
 *
 * ## 为什么挑它（复扫读数，纪律 2）
 * `coverage/src/index.html`（00:15 那一跑，第 59 件之后）实测：全仓 `src/**` 分支覆盖率
 * **最低且尚未做过**的文件 = `api.ts`（**82.96% = 190/229**；语句 99.73%；函数 23/23 已满）。
 * 🔵 它同时是**对外面**（9 条 `/serenity/*` HTTP 路由）⇒ 贴 objective。
 *
 * ## 🔴 开工第一步 = 核对既有登记（第 59 件沉淀的纪律）
 * `api-status-api.test.ts`（1114 行，⑤ 第 8/9/10/11/17/18/31 件）的文件头**已逐条登记**：
 * ① 它测的是「**正路 + 五条破坏性/守卫边界**」（403 守卫、真删会话的 live 保护、可执行扩展名拒绝…）；
 * ② 且**显式登记了一条"刻意不覆盖"**：`readBody` 超限体（`req.destroy()` ⇒ 客户端只见 ECONNRESET，
 *    断言"400"会把假期望固化）；
 * ③ `resolveWorkspace` 的 `catch`（:199-201）**实测构造上不可达**（三层访问器全吞异常）⇒ 已登记地图 §3-8。
 *
 * ⇒ 本件**不重做**上述任何一条；对象 = 既有用例**结构上碰不到**的那一档：**取值兜底**。
 *
 * ## 分组（先从 `cbranch-no` 清单**按形态归类**，再逐条实测可达性 —— 不是盲补 37 处）
 * 复扫后 `api.ts` 剩 **37 处** `cbranch-no`。逐条映射回源行（判据：报告里
 * `<span class="cline-any cline-*">` 块与其后 `class="text"` 块按序一一对应 —— 已用
 * `:1623`/`:1750`/`:2244` 三处实测校准）后归为五族：
 *
 * | 族 | 形态 | 处数 | 可达性（本件实测结论） |
 * |---|---|---|---|
 * | ① | `err.message ?? String(err)` | **11** | 🟡 可达（抛非 Error 才走右侧）—— 本件**只挑 1 个端点钉住该族** |
 * | ② | `new URL(req.url ?? '/', …)` | **7** | ✅ **实测可达** —— 真 `IncomingMessage` 的 `url` **是可写属性**（探针实测 `urlWritable=true`） |
 * | ③ | 设置/配置缺键兜底（`?? []` ／ `?? ACP_HTTP_PORT` ／ `?? false`） | **9** | ✅ 可达（写一份**缺键**配置） |
 * | ④ | 入参/取值兜底（`?? ''` ／ `? : 30` ／ `=== undefined ? …` ／ `?? 'wait'`） | **7** | 🟡 其中 3 处可达（**已在本件覆盖**）、2 处不可达（另一条替身在跑）、1 处取到后会打到真网络、1 处属既有登记 |
 * | ⑤ | `EXT_BY_MEDIA[… ] ?? 'img'` ／ `name.split(…).pop() ?? ''` | **2** | 🔴 **两处都构造上不可达**（各有一个**支配性前置守卫**）⇒ **如实登记，不涂绿** |
 *
 * ## 🔴 本件最值钱的产出 = 两条「构造上不可达」的结构取证（族 ⑤）
 * - `api.ts:72` `EXT_BY_MEDIA[mediaType] ?? 'img'`：**不可达**。:60 的
 *   `if (!IMAGE_MEDIA_TYPES.has(mediaType)) throw` 是它的**支配性守卫**，而
 *   `IMAGE_MEDIA_TYPES`（4 个）与 `EXT_BY_MEDIA` 的键**逐一相同** ⇒ 走到 :72 时查表**必命中**。
 *   ⚠️ 顺带更正既有读法：既有 `api-upload.test.ts` 断言 `.jpg$/.webp$/.gif$`，这**不证明**回退可测 ——
 *   它证明的是**表命中**；想走到 `'img'` 得把表或白名单改坏（= 改生产语义）⇒ **不测**。
 * - `api.ts:83` `name.split(/[\\/]/).pop() ?? ''`：**不可达**。`''.split(x).pop()` 恒为 `''`（不是
 *   `undefined`）⇒ `.pop() === undefined` **永不成立**（本件 B3 用真函数正向钉住这条 ES 语义）。
 *   既有 `api-file-upload.test.ts` 断言 `sanitizeFileName('   ') === 'file'` 走的是**后置**的
 *   `cleaned === '' → 'file'`，与这条 `??` **无关**。
 *
 * ## 判据纪律（本件用到的高频条）
 * - **⑬ 降级面必须与正控方向成对测**：每条兜底都断言"**另一侧仍在**"（守卫生效 ≠ 端点坏了）。
 * - **⑪ 只钉本模块自己控制的前缀**：外部工具散文随 locale 变 ⇒ 不钉宿主/git 的文案。
 * - **⑭ 变异一次才配声称"承重"**：本件收尾对**四组**各做一次变异验证（见 commit message）。
 * - **端口纪律**：全部 `port: 0`（**绝不占用 3082/3080/3081/3099/3100 等活服务端口**）。
 * - **夹具不造第四套**：直接复用 `api-status-api.test.ts` 的 `bootApi` **形态**（同形状复制其 boot
 *   harness 的契约面），不新造一套分叉的夹具。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sanitizeFileName, saveImageToTmp, registerStatusApi } from '../src/api.js'
import { __setSimpleSourceForTest, defaultSimpleSettings } from '../src/settings-section.js'

type Handler = (req: IncomingMessage, res: ServerResponse) => unknown

interface Booted {
  port: number
  routes: string[]
  close: () => Promise<void>
}

/**
 * 起一台真 listener：把 `registerStatusApi` 注册的处理器按**精确路径**派发出去。
 * 🔴 `beforeHandlers` 在**派发之后、交进处理器之前**对 `req` 做变换 —— 这是族 ②（`req.url ?? '/'`）的注入点。
 * ⚠️ 派发路径取**变换前**的真 `req.url`：否则派发层自己会 404，处理器根本跑不到（本件首跑实测踩过）。
 */
async function bootApi(opts: {
  /** 派发前对 req 做一次变换（族 ② 的注入点：把 `url` 打成 `undefined`） */
  beforeHandlers?: (req: IncomingMessage) => void
  /** 派发用的路径（默认取变换**前**的 `req.url`）—— 族 ② 必须显式给，见 createServer 内的注释 */
  routePathOverride?: string
  /** 注入宿主服务（按名字；未列的返回 undefined）—— 用于 `ctx.get('codeRuntime')` 的两态 */
  services?: Record<string, unknown>
} = {}): Promise<Booted> {
  const handlers = new Map<string, Handler>()
  const routes: string[] = []
  const ctx = {
    webServer: {
      register: (r: { path: string; handler: Handler }) => {
        handlers.set(r.path, r.handler)
        routes.push(r.path)
      },
    },
    get: (name: string) => opts.services?.[name],
  }
  registerStatusApi(ctx as never)

  const server = createServer((req, res) => {
    // 🔴 派发层的路径解析**必须独立于被测代码**：这里若也用 `req.url ?? '/'`，
    //    被打成 undefined 的请求会被派发层判成 `/` ⇒ 直接 404 ⇒ **被测处理器根本不会跑**，
    //    于是"端点仍应答"这条断言测的其实是**派发层**（假覆盖 —— 本件首跑实测命中）。
    //    ⇒ 先把**真 url** 记下来，再让 `beforeHandlers` 变换交到处理器手里的那个 req。
    const realUrl = req.url
    opts.beforeHandlers?.(req)
    const path = opts.routePathOverride ?? new URL(realUrl ?? '/', 'http://127.0.0.1').pathname
    const handler = handlers.get(path)
    if (handler === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('no such route')
      return
    }
    void Promise.resolve(handler(req, res)).catch(() => {
      try { res.writeHead(500); res.end() } catch { /* 已结束 */ }
    })
  })
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve(typeof addr === 'object' && addr !== null ? addr.port : 0)
    })
  })
  return {
    port,
    routes,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => { server.close(() => resolve()); setTimeout(resolve, 1000) })
    },
  }
}

interface RawRes { status: number; body: string }

function raw(opts: { port: number; method: string; path: string; headers?: Record<string, string>; body?: string }): Promise<RawRes> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: opts.port, method: opts.method, path: opts.path, headers: opts.headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }))
      },
    )
    req.on('error', reject)
    req.end(opts.body)
  })
}

const UI_HEADERS = { 'content-type': 'application/json', 'x-serenity-ui': '1' }

let ccc: string
let cfgDir: string
let prevCfgEnv: string | undefined
let prevDshHome: string | undefined
let dshHome: string

beforeEach(() => {
  ccc = mkdtempSync(join(tmpdir(), 'hooks-api60-ccc-'))
  writeFileSync(join(ccc, '.serenity'), 'test')
  prevCfgEnv = process.env.SERENITY_HOOKS_CONFIG
  cfgDir = mkdtempSync(join(tmpdir(), 'hooks-api60-cfg-'))
  process.env.SERENITY_HOOKS_CONFIG = join(cfgDir, 'serenity-hooks.json')
  __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings() }))
  prevDshHome = process.env.DSH_HOME
  dshHome = mkdtempSync(join(tmpdir(), 'hooks-api60-dsh-'))
  process.env.DSH_HOME = dshHome
})

afterEach(() => {
  __setSimpleSourceForTest(null)
  if (prevCfgEnv === undefined) delete process.env.SERENITY_HOOKS_CONFIG
  else process.env.SERENITY_HOOKS_CONFIG = prevCfgEnv
  if (prevDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = prevDshHome
  rmSync(ccc, { recursive: true, force: true })
  rmSync(cfgDir, { recursive: true, force: true })
  rmSync(dshHome, { recursive: true, force: true })
})

/**
 * 族 ②：`new URL(req.url ?? '/', 'http://127.0.0.1')` —— **7 处**（:218 :296 :387 :467 :608 :671 :1769/1847/1938/2018/2159/2222）。
 * 🔴 可达性**已实测**：真 `IncomingMessage` 的 `url` 是**可写属性**（探针读数 `urlWritable=true`；
 * 对照 `headers` 是只读 getter ⇒ 不可写）⇒ 可以把它打成 `undefined`，让 `?? '/'` 的右侧真跑起来。
 *
 * 语义：`url` 缺失 ⇒ 回落 `'/'` ⇒ `searchParams` 全空 ⇒ **走默认值**（而不是崩）。
 * 这七处是**同一条链的七个入口**，任一处少了 `?? '/'` 都会让该端点对畸形请求抛异常。
 */
describe('src/api.ts 族 ②：`req.url` 缺失 ⇒ 回落 `/`（不是崩）', () => {
  const jsonBody = (r: RawRes): any => JSON.parse(r.body)

  it('🔴 7 条路由在 `req.url === undefined` 下**仍各自应答**（不是 500），且默认值真生效', async () => {
    const api = await bootApi({ beforeHandlers: (req) => { req.url = undefined as never } })
    try {
      // 接线自证（正控）：同一夹具下路由确实都注册了 —— 防止"全都 404 也算 7 条通过"
      for (const p of ['/serenity/config', '/serenity/cccs', '/serenity/public-ask', '/serenity/weixin', '/serenity/session-cleanup', '/serenity/status']) {
        expect(api.routes, `未注册：${p}`).toContain(p)
      }

      // ── ① /serenity/handymen：url 缺失 ⇒ workspace 参数读不到 ⇒ 回落 process.cwd() ──
      // 🔴 **本仓的 cwd 就在真 CCC 里** ⇒ `listActiveHandymen(root)` 会去读**真的**
      //    `AGENT_SESSIONS/handyman-*.json` —— 拿它判"空表"是**环境依赖的假断言**
      //    （首跑实测：读出一堆真实进度文件）。⇒ 判据只钉**降级语义**（不崩、仍是那个端点）。
      const handymen = await raw({ port: api.port, method: 'GET', path: '/serenity/handymen' })
      expect(handymen.status, 'url 缺失不得让 handymen 崩').toBe(200)
      expect(Array.isArray(jsonBody(handymen).handymen), '仍必须是 handymen 端点的形状').toBe(true)

      // 🔴 **承重判据（本族的关键）**：`req.url` 缺失时 `?? '/'` 必须**真被求值**。
      //    只看"没崩"是**弱测试** —— 变异实测：把 `?? '/'` 删成 `req.url as string`
      //    （⇒ `new URL(undefined, base)` 仍不抛、仍解析成 base 根）**照样全绿**。
      //    ⇒ 必须钉一条**只有右侧生效才会成立**的读数：`session-cleanup` 的
      //    `olderThanDays` 在 url 缺失时**只能是默认 30**；若 query 被"读到"（也就是
      //    `?? '/'` 没生效、url 其实是别的值），这条就会读出别的数或 NaN。
      //    下面第 ⑦ 段就是这条判据；这里先钉 `'/'` 的**语义后果**：路径解析成根 ⇒ 无 query。

      // ── ② /serenity/status：同理回落 process.cwd() ⇒ 200（root 取值不作断言：它取决于本仓被检出到哪） ──
      const status = await raw({ port: api.port, method: 'GET', path: '/serenity/status' })
      expect(status.status).toBe(200)
      expect(jsonBody(status)).toHaveProperty('root')

      // ── ③ /serenity/config：GET 仍 200，且 knownWorkspaces 仍在（宿主服务缺席 ⇒ []) ──
      const config = await raw({ port: api.port, method: 'GET', path: '/serenity/config', headers: UI_HEADERS })
      expect(config.status).toBe(200)
      expect(jsonBody(config).knownWorkspaces).toEqual([])
      expect(jsonBody(config).config).toBeTypeOf('object')

      // ── ④ /serenity/cccs：200 ＋ cccs 数组 ──
      const cccs = await raw({ port: api.port, method: 'GET', path: '/serenity/cccs', headers: UI_HEADERS })
      expect(cccs.status).toBe(200)
      expect(Array.isArray(jsonBody(cccs).cccs)).toBe(true)

      // ── ⑤ /serenity/public-ask：url 缺失 ⇒ 取不到任何 query；仍 200（key 走 ensurePublicAskKey） ──
      const publicAsk = await raw({ port: api.port, method: 'GET', path: '/serenity/public-ask', headers: UI_HEADERS })
      expect(publicAsk.status).toBe(200)
      expect(jsonBody(publicAsk).key).not.toBe('')

      // ── ⑥ /serenity/weixin：url 缺失 ⇒ ccc 参数空 ⇒ **400 missing ccc param**（判据边界的正控方向） ──
      const weixin = await raw({ port: api.port, method: 'GET', path: '/serenity/weixin', headers: UI_HEADERS })
      expect(weixin.status).toBe(400)
      expect(jsonBody(weixin)).toEqual({ error: 'missing ccc param' })

      // ── ⑦ /serenity/session-cleanup：url 缺失 ⇒ **olderThanDays 走默认 30**（而不是 NaN） ──
      const cleanup = await raw({ port: api.port, method: 'GET', path: '/serenity/session-cleanup', headers: UI_HEADERS })
      expect(cleanup.status).toBe(200)
      expect(jsonBody(cleanup).dryRun).toBe(true)
      expect(jsonBody(cleanup).olderThanDays, 'url 缺失必须落到默认 30，不得是 NaN').toBe(30)

      // 🔴🔴 **本族的承重边界（变异实测逼出来的，必须如实登记）**：带上**真 query**、再把 `req.url` 打掉。
      //    期望 400 `missing ccc param`（回落 `/` ⇒ query 不可见）。
      //    ⚠️ **本条不是承重断言** —— 变异实测（把该处 `?? '/'` 改成 `req.url as string`）**照样绿**：
      //    探针实测 `new URL(undefined, base)` **不抛**，解析成 `http://127.0.0.1/undefined`、
      //    `search` **为空** ⇒ 两种写法在"query 可不可见"上**行为等价**。
      //    ⇒ 这一族（`req.url ?? '/'`）的右侧**无法用 HTTP 黑盒区分**（除非打到 base 解析差异）。
      //    真正的价值在**另一侧**：它是**防崩守卫**（`req.url` 为 undefined 时不抛 TypeError）。
      //    本断言钉住的是**可观察契约**（参数不可见、回 400），**不声称它证明了 `??` 承重**。
      const weixinWithQuery = await raw({
        port: api.port, method: 'GET',
        path: `/serenity/weixin?ccc=${encodeURIComponent(ccc)}`, headers: UI_HEADERS,
      })
      expect(
        weixinWithQuery.status,
        '🔴 url 缺失 ⇒ 即便**请求行里带着 ccc**，回落后参数也必须**不可见** ⇒ 400',
      ).toBe(400)
      expect(jsonBody(weixinWithQuery)).toEqual({ error: 'missing ccc param' })
    } finally {
      await api.close()
    }

    // 判别性对照：**url 真在场**（不打掉）＋ workspace 指向空的临时 CCC ⇒ 真「空表」
    // ⚠️ 这条**不能**复用上面的 `beforeHandlers`（url 被打掉 ⇒ query 读不到 ⇒ workspace 无效 ⇒
    //    端点会回落到 `process.cwd()`，而那正是**真 CCC**、里面有真的 handyman 进度文件）。
    const scoped = await bootApi()
    try {
      const res = await raw({
        port: scoped.port, method: 'GET',
        path: `/serenity/handymen?workspace=${encodeURIComponent(ccc)}`, headers: UI_HEADERS,
      })
      expect(res.status).toBe(200)
      expect(jsonBody(res).handymen, '空 CCC 无进度文件 ⇒ 空表（与上一条的真 CCC 读数成对照）').toEqual([])
    } finally {
      await scoped.close()
    }
  })

  it('🔴 判别性对照（正控方向）：同一夹具**不**打 url ⇒ 查询参数真被用上', async () => {
    const api = await bootApi()
    try {
      // 同一端点、同一请求形态，只是 url 没被打掉 ⇒ 参数生效 ⇒ 证明上一条的"默认值"来自 url 缺失
      const ok = await raw({
        port: api.port, method: 'GET', path: `/serenity/weixin?ccc=${encodeURIComponent(ccc)}`, headers: UI_HEADERS,
      })
      expect(ok.status).toBe(200)
      expect(jsonBody(ok).enabled).toBe(false)

      const cleanup = await raw({ port: api.port, method: 'GET', path: '/serenity/session-cleanup?olderThanDays=7', headers: UI_HEADERS })
      expect(jsonBody(cleanup).olderThanDays, '对照组：参数在 ⇒ 参数生效').toBe(7)
    } finally {
      await api.close()
    }
  })
})

/**
 * 族 ③：**设置/配置缺键兜底**（9 处）。
 * 既有用例把配置**写成完整形态**（`writeCccConfig({ weixin: {...} })`、`SERENITY_HOOKS_CONFIG` 有值），
 * 因此这些 `?? []` ／ `?? false` ／ `?? ACP_HTTP_PORT` 的**右侧从来没有被求值过**。
 * 🔴 它们的共同语义是「**配置缺这一段时，端点回一个可用的默认，而不是 500**」—— 面板新装即此形态。
 */
describe('src/api.ts 族 ③：配置/设置缺键 ⇒ 兜底默认（不是 500）', () => {
  const jsonBody = (r: RawRes): any => JSON.parse(r.body)

  it('🔴 `weixin` 段**整体缺失** ⇒ GET 200 ＋ accounts/routes/bridge 三段全 `[]`（:482/:492/:493）', async () => {
    // 刻意**不写** `.opencode/serenity.json`（连文件都没有）—— 比"写了空对象"更彻底
    const api = await bootApi()
    try {
      const res = await raw({ port: api.port, method: 'GET', path: `/serenity/weixin?ccc=${encodeURIComponent(ccc)}`, headers: UI_HEADERS })
      expect(res.status).toBe(200)
      const body = jsonBody(res) as Record<string, unknown>
      // 🔴 **变异实测（本件）**：把 `settings.accounts ?? []` 改成 `settings.accounts!` **照样绿**
      //    —— 因为它的生产者 `readWeixinSettings` **恒返回数组**
      //    （`weixin-route.ts:70` 的 `Array.isArray(…) ? … : []` ＋ `:78` 的 catch 兜底）
      //    ⇒ 该 `?? []` 是**经真实生产者不可达的防御守卫**（与族 ⑤ 同性质，差别只在
      //      "守卫在**别的模块**"）。⇒ **如实登记，不声称它承重**（纪律 8 的镜像）。
      //      它仍有价值：把 `readWeixinSettings` 换成别的实现时，这里不会崩。
      expect(body.accounts).toEqual([])
      // ② settings.routes 缺 ⇒ `?? []`（同 ① 的性质）
      expect(body.routes).toEqual([])
      // ③ bridge 缺席（无轮询在跑）⇒ `bridge?.accounts ?? []`
      //    🔴 **这一处的右侧是【真可达】的**（与 ①② 不同）：`weixinBridgeStatus()` 返回数组，
      //    但 `find()` 未命中时给 `undefined` ⇒ `bridge?.accounts` 为 `undefined` ⇒ 走 `?? []`。
      //    本夹具无任何桥在跑 ⇒ 这正是**该分支的真实触发形态**。
      expect(body.bridge).toEqual([])
      // 正控方向：另两个取自 `=== true` / `?? undefined` 的字段形状仍在（证明还是那个端点）
      expect(body.enabled).toBe(false)
      // 🔴 判据纪律 ⑱（用 `in`，不用 `toBeUndefined`）：契约是「**无值时不得出现该键**」。
      //    `botType ?? undefined` ⇒ 缺配置时值是 undefined ⇒ `JSON.stringify` **丢弃**该键 ⇒
      //    到了 wire 上**键根本不存在**。用 `toBeUndefined()` 会把"键在但值是 undefined"与
      //    "无该键"一起判绿 —— 而下游（面板）按"键在不在"判能力，两者语义不同。
      expect('botType' in body, '缺配置时 botType 键必须**不出现**（而不是出现且为 null/undefined）').toBe(false)
      expect(body).not.toHaveProperty('botType')
    } finally {
      await api.close()
    }
  })

  it('🔴 public-ask：设置源**缺两个键** ⇒ `acpHttpPort` / `publicAskEnabled` 走兜底（:431/:435）', async () => {
    // 🔴 关键：部分缺键（其余键仍在）—— 这样 `readSimpleSettings()` 走的仍是注入源，
    //    而这两个键被刻意抽掉 ⇒ 只有 `?? ACP_HTTP_PORT` / `?? false` 的右侧能让端点回出可读值。
    const full = defaultSimpleSettings()
    const partial = { ...full } as Record<string, unknown>
    delete partial.acpHttpPort
    delete partial.publicAskEnabled
    __setSimpleSourceForTest(() => partial as never)

    const api = await bootApi()
    try {
      const res = await raw({ port: api.port, method: 'GET', path: '/serenity/public-ask', headers: UI_HEADERS })
      expect(res.status, '缺键不得让 public-ask 崩成 400').toBe(200)
      const body = jsonBody(res) as { port: number; enabled: boolean; urls: unknown[]; key: string }
      // ① `?? ACP_HTTP_PORT`：兜底值必须是那个集中端口常量，且**不得是 undefined**（否则 base URL 变成 "undefined"）
      expect(typeof body.port).toBe('number')
      expect(body.port).toBeGreaterThan(0)
      // ② `?? false`：缺键 ⇒ 严格静默（**不是** undefined、**不是** true）
      expect(body.enabled, '缺键的默认必须是 false 而不是 undefined/true').toBe(false)
      // 污染检查：URL 里不得出现字面量 undefined（那是"兜底没生效"的典型病灶）
      expect(JSON.stringify(body)).not.toContain('undefined')
    } finally {
      await api.close()
    }
  })

  it('🔴 判别性对照：设置源**键齐全** ⇒ 两侧都不走兜底（证明上一条的读数来自缺键）', async () => {
    __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), acpHttpPort: 3921, publicAskEnabled: true }))
    const api = await bootApi()
    try {
      const res = await raw({ port: api.port, method: 'GET', path: '/serenity/public-ask', headers: UI_HEADERS })
      expect(res.status).toBe(200)
      const body = jsonBody(res) as { port: number; enabled: boolean; listUrl: string }
      expect(body.port, '键在 ⇒ 用配置值而**不是**兜底常量').toBe(3921)
      expect(body.enabled, '键在 ⇒ 用配置值而**不是**兜底 false').toBe(true)
      expect(body.listUrl).toContain('3921')
    } finally {
      await api.close()
    }
  })

  it('🔴 `set-enabled`：配置里**没有 `accounts` 键**时 enable ⇒ 400（`:576` 的 `?? []` 兜底把"无账号"判对）', async () => {
    // 只写 `skiff.roles`，**刻意不写 `weixin`** ⇒ `settings.accounts` 缺席 ⇒ `(accounts ?? []).length === 0` 为真
    mkdirSync(join(ccc, '.opencode'), { recursive: true })
    writeFileSync(join(ccc, '.opencode', 'serenity.json'), JSON.stringify({ skiff: { roles: { qa: { prompt: 'x' } } } }, null, 2))

    const api = await bootApi()
    try {
      const res = await raw({
        port: api.port, method: 'POST', path: '/serenity/weixin', headers: UI_HEADERS,
        body: JSON.stringify({ ccc, action: 'set-enabled', enabled: true }),
      })
      expect(res.status, 'accounts 缺键 ⇒ 必须判成"无账号"而非放行').toBe(400)
      expect(jsonBody(res)).toEqual({ error: '启用前请先扫码绑定至少一个账号' })
      // 🔴 负控：被拒时**盘上什么都没写**（不是"回了个 400 就算数"）
      const cfg = JSON.parse(readFileSync(join(ccc, '.opencode', 'serenity.json'), 'utf-8')) as { weixin?: unknown }
      expect(cfg.weixin, '被拒的 enable 不得顺手建出 weixin 段').toBeUndefined()
    } finally {
      await api.close()
    }
  })
})

/**
 * 族 ④：**入参/取值兜底**（7 处）。三处可构造，本件覆盖；其余四处**逐条定性**（见文件头表格）。
 */
describe('src/api.ts 族 ④：入参/取值兜底', () => {
  const jsonBody = (r: RawRes): any => JSON.parse(r.body)

  it('🔴 `unsupported action`：**`action` 键整体缺失** ⇒ 文案尾部是空串（`:590` 的 `?? ""` 已生效）', async () => {
    const api = await bootApi()
    try {
      // 对照一：action 缺失（走 `body.action ?? ''` 的**右侧**）
      const noAction = await raw({
        port: api.port, method: 'POST', path: '/serenity/weixin', headers: UI_HEADERS,
        body: JSON.stringify({ ccc }),
      })
      expect(noAction.status).toBe(400)
      expect(jsonBody(noAction).error, '缺 action ⇒ 文案以「unsupported action: 」+ 空 收尾').toBe('unsupported action: ')

      // 对照二（正控方向）：action 在场且未知 ⇒ 同一个出口把名字印出来
      const named = await raw({
        port: api.port, method: 'POST', path: '/serenity/weixin', headers: UI_HEADERS,
        body: JSON.stringify({ ccc, action: 'nope' }),
      })
      expect(named.status).toBe(400)
      expect(jsonBody(named).error).toBe('unsupported action: nope')

      // 对照三（判别性）：`cciaction`?? 不——用"键在但值为 null"钉住**空串 ≠ nullish 之外**的边界：
      //   `null ?? ''` 也走右侧 ⇒ 出口与"缺键"相同。这条把「三态」一次说清：缺键 / null / 有值。
      const nulled = await raw({
        port: api.port, method: 'POST', path: '/serenity/weixin', headers: UI_HEADERS,
        body: JSON.stringify({ ccc, action: null }),
      })
      expect(nulled.status).toBe(400)
      expect(jsonBody(nulled).error).toBe('unsupported action: ')
    } finally {
      await api.close()
    }
  })

  it('🔴 `olderThanDays` 退化取值族：非数 / NaN / 0 / 负数 ⇒ **一律落回 30**（`:673` 的 `>= 1 ? … : 30`）', async () => {
    const api = await bootApi()
    try {
      for (const bad of ['abc', 'NaN', '0', '-5', '']) {
        const res = await raw({
          port: api.port, method: 'GET',
          path: `/serenity/session-cleanup?olderThanDays=${encodeURIComponent(bad)}`,
          headers: UI_HEADERS,
        })
        expect(res.status, `${bad} 不应让清理端点崩`).toBe(200)
        expect(jsonBody(res).olderThanDays, `olderThanDays=${JSON.stringify(bad)} 应落回 30`).toBe(30)
        expect(jsonBody(res).dryRun, 'GET 恒为预览（安全底线）').toBe(true)
      }
      // 正控方向：合法值（含小数 1.5、刚好等于阈值 1）**不被**改写
      for (const good of [1, 7, 1.5, 365]) {
        const res = await raw({
          port: api.port, method: 'GET', path: `/serenity/session-cleanup?olderThanDays=${good}`, headers: UI_HEADERS,
        })
        expect(jsonBody(res).olderThanDays, `合法值 ${good} 不得被改成 30`).toBe(good)
      }
    } finally {
      await api.close()
    }
  })

  it('🔴 `codeRuntime` 探测服务**在场/缺席**两态：`=== undefined ? … : …` 的两个方向（`:303`）', async () => {
    // 方向一：服务缺席（本夹具 `ctx.get` 恒 undefined）⇒ `{ codeRuntime: null }`
    const absent = await bootApi()
    try {
      const res = await raw({ port: absent.port, method: 'GET', path: `/serenity/status?workspace=${encodeURIComponent(ccc)}`, headers: UI_HEADERS })
      expect(res.status).toBe(200)
      expect(jsonBody(res).codeRuntime, '服务缺席 ⇒ null（降级，不是报错）').toBeNull()
    } finally {
      await absent.close()
    }

    // 方向二（正控方向）：服务在场 ⇒ 装配成对象 ⇒ 证明上一条的 null 来自"缺席"而非"根本没读"
    // 🔴 **走同一个 `bootApi`**（只多给一个服务）—— 不另造一套夹具（夹具重复 = 第二真相源）。
    const present = await bootApi({ services: { codeRuntime: { language: 'typescript', isolation: 'worktree' } } })
    try {
      const res = await raw({ port: present.port, method: 'GET', path: `/serenity/status?workspace=${encodeURIComponent(ccc)}`, headers: UI_HEADERS })
      expect(res.status).toBe(200)
      expect(jsonBody(res).codeRuntime, '服务在场 ⇒ 装配成对象').toEqual({ language: 'typescript', isolation: 'worktree' })
    } finally {
      await present.close()
    }
  })
})

/**
 * 族 ⑤：**两条构造上不可达的兜底**（如实登记，不涂绿 —— 纪律 8 / 纪律 3）。
 * 本组**不制造假故障**去凑覆盖率；它做的是**正向钉住"那条兜底为什么够不着"**，
 * 这样后人若改动了前置守卫，这里会**红**并提醒重估。
 */
describe('src/api.ts 族 ⑤：两条兜底的「构造上不可达」结构取证（登记，不涂绿）', () => {
  it('🔴 `EXT_BY_MEDIA[m] ?? "img"`（:72）不可达：白名单**就是**查表的键集 ⇒ 走到它时必命中', () => {
    // 判据：所有**能通过** :60 白名单的 mediaType，都必须能在查表里命中（即**永远不落** `'img'`）。
    // 这里用公开导出的 `saveImageToTmp` 做**正向**取证：4 个合法类型全部产出**真扩展名**。
    // ⚠️ 这不是"回退可达"，恰恰相反 —— 4/4 命中正是"回退够不着"的证据。
    const dir = mkdtempSync(join(tmpdir(), 'hooks-api60-img-'))
    try {
      const cases: Array<[string, string]> = [
        ['image/png', '.png'], ['image/jpeg', '.jpg'], ['image/webp', '.webp'], ['image/gif', '.gif'],
      ]
      for (const [mediaType, ext] of cases) {
        const rel = saveImageToTmpForProbe(dir, mediaType)
        expect(rel.endsWith(ext), `${mediaType} 必须命中查表（.img 只在前置守卫被绕过时才可能出现）`).toBe(true)
        expect(rel, '回退值 .img 在合法输入下不可达').not.toMatch(/\.img$/)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('🔴 `name.split(…).pop() ?? ""`（:83）不可达：`pop()` 对任何字符串都**不返回 undefined**', () => {
    // 判据 = **ES 语义**：`''.split(x).pop()` 恒为 `''`（数组恒非空 ⇒ pop 不空手）。
    // 因此 `.pop() ?? ''` 的右侧**只有 pop 返回 undefined 才走**，而它**永不**返回 undefined。
    // 这条正向钉住该语义（真函数、真输入；不是断言"回退不生效"）。
    expect([''.split(/[\\/]/).pop(), 'a'.split(/[\\/]/).pop(), '///'.split(/[\\/]/).pop()])
      .toEqual(['', 'a', ''])
    // 旁证：`sanitizeFileName` 对"空 basename"的兜底走的是**后置**那句 `cleaned === '' → 'file'`，
    // 与 :83 的 `??` 无关 —— 这里有既有用例覆盖（api-file-upload.test.ts 的 `'   '`），本件不重复。
    expect(sanitizeFileName('   ')).toBe('file')
    expect(sanitizeFileName('')).toBe('file')
    // 且：路径分隔符形态**永远**产出非空 basename 或 'file'（`??` 那侧够不着）
    for (const n of ['../etc/passwd.pdf', 'C:\\Users\\x\\a.txt', '/', '\\', '..']) {
      expect(typeof sanitizeFileName(n), `sanitizeFileName(${JSON.stringify(n)})`).toBe('string')
    }
  })
})

/** 探针包装：不与生产签名耦合（本组只关心"合法类型是否命中查表"这一条读数） */
function saveImageToTmpForProbe(root: string, mediaType: string): string {
  return saveImageToTmp(root, mediaType, Buffer.from('fake-image').toString('base64'))
}
