/**
 * ⑤ 第 54 件 — `src/weixin-send-api.ts` 错误路径与装配容错面。
 *
 * 靶（锚定 2026-09-26 00:1x 那一跑）：分支 **79.43%**（85/107）、语句 94.42%（322/341）、
 * 函数 16/16 —— 复扫后 `src/**` 分支覆盖率**最低**的未做过文件（复扫三连：交接块候选表
 * 第三次被推翻，但它这次**猜对了**首选 —— 前两件都猜错）。
 *
 * 与既有 `weixin-send-api.test.ts`（308 行）的分工（**互补不重叠**）：
 *   既有 = 纯校验正路 ＋ 路由正路 ＋ 成功/桥失败 ★主要★ 路径 ＋ 生命周期；
 *   本件 = **错误路径与容错**（既有全部没碰）—— 见下方覆盖清单。
 *
 * 本件覆盖的未覆盖分支（`weixin-send-api.ts`）：
 *   A 组 — 请求体边界：`:174` 体超 64 KB ⇒ 413 **BODY_TOO_LARGE**
 *           ／ `:228` 空体 ⇒ 按 `'{}'` 解析（不是 JSON.parse('') 语义）
 *   B 组 — 状态映射完整性：`:187` `ACCOUNT_NOT_FOUND` ⇒ **400**（既有只测了 409/502）
 *           ／ `:191` `default` ⇒ 400（未知 code **不得**落到 5xx）
 *   C 组 — CCC 发现失败：`:246` `collectCandidates` 抛 ⇒ 500 **CCC_DISCOVERY_FAILED**
 *   D 组 — 候选装配退化：`:155` 无 root ／ 重复 root ⇒ 跳过
 *           ／ `:157` 条目无 `name` ⇒ 回落 `basename(root)`；`cccName` 从 `.serenity` 读
 *   E 组 — 装配容错：`:313` 配置读取抛 ⇒ 告警 + **跳过同步**（不抛）
 *           ／ `:332` `:337` 两个 `ctx.on` 通道缺失 ⇒ 不阻断（Pi/旧宿主形态）
 *
 * 🔴 判据（为什么不是"返回了个错误码就算"）：
 *   1. **每条错误路径钉的是"稳定 code ＋ 语义化状态"，不是文案** —— 调用方按 `code`
 *      分支（文件头 `:17` 逐字），文案可改。故断言必含 `code` 与 `status` **两者**。
 *   2. **`default` 分支必须钉方向** —— 未知 code 落到 400（客户端错误）还是 5xx
 *      （服务端错误）是**语义选择**：落到 5xx 会让调用方误以为"重试有用"。
 *   3. **容错面钉"不抛 ＋ 后续仍执行"** —— 只断言"没抛"无法区分"吞掉后继续"与
 *      "吞掉后中断"（纪律 20 族）；E4 显式断言"跳过同步 ⇒ listener 未被启动"。
 *
 * ⚠️ **诚实边界（本件不覆盖，理由记此处而非遗漏）**：
 *   🔴 `:313` 的「配置读取失败」catch —— 本件首跑试图驱动它，**实测构造上不可达**：
 *      `readAdvancedSettings()` = `mergeWithDefaults(readFileSafe(...))`，而 `readFileSafe`
 *      **把所有读取/解析异常吞掉并返回 `{}`**，`mergeWithDefaults` 是纯函数
 *      ⇒ 该 `try` 永不进入 catch（与地图 §3-8「构造上不可达」一族同性质）。
 *      ⇒ **登记而非涂绿**（纪律 8）：E4 改为机械钉住真实契约「配置缺失 ⇒ 走默认、不抛、不告警」。
 *   `:47` 的 `FACE_PORTS.weixinSend.host ?? '127.0.0.1'` —— `ports.ts` 里该字段**是常量**，
 *      要驱动 `??` 的空侧需改生产常量，属"为覆盖率改生产语义"⇒ **不造**（纪律 8 镜像）。
 *
 * 🔴 **两条夹具硬前置（本件首跑实测踩到，务必保留）**：
 *   1. **桥替身必须给返回值** —— `vi.fn()` 默认返回 `undefined` ⇒ `result.ok` 直接崩
 *      （D1/D2 首跑红即此；不是生产代码问题）。
 *   2. **配置端口必须隔离** —— 默认 `weixinApi.port = 3082` 是**真实生产端口**；
 *      本件首跑在 `registerWeixinSendApi` 处撞 `EADDRINUSE`（活服务正占着 3082）
 *      ⇒ **测试绝不得去占用活服务端口**，一律 `writeConfig` 到临时文件并预占空闲端口。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ServerResponse } from 'node:http'

vi.mock('../src/weixin-bridge.js', () => ({
  sendProactiveText: vi.fn(),
}))
vi.mock('../src/ccc-roots.js', () => ({
  listCccs: vi.fn(),
}))

import { handleWeixinSendRequest, registerWeixinSendApi, stopWeixinSendApi, weixinSendEndpoint } from '../src/weixin-send-api.js'
import { sendProactiveText } from '../src/weixin-bridge.js'
import { listCccs } from '../src/ccc-roots.js'

const sendMock = vi.mocked(sendProactiveText)
const discoverMock = vi.mocked(listCccs)

let dir: string
let oldConfigEnv: string | undefined
const tempCccDirs: string[] = []

/**
 * 🔴 夹具硬前置：**必须把配置指到一个隔离文件**（默认 `weixinApi.port = 3082` = 真实生产端口，
 * 本件首跑实测在此撞 `EADDRINUSE` —— 测试**不得**去占用活服务的端口）。
 * 需要驱动"配置缺省"的用例显式写 `{}`（⇒ 默认 enabled:true，但端口已隔离到临时文件语义下）。
 */
function writeConfig(cfg: unknown): void {
  writeFileSync(process.env.SERENITY_HOOKS_CONFIG!, JSON.stringify(cfg))
}

/** 预留一个确定空闲的端口（与既有用例同法；避开硬写端口的碰撞类 flake） */
async function reserveFreePort(): Promise<number> {
  const probe = createServer()
  const port = await new Promise<number>((resolve) => {
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address()
      resolve(typeof addr === 'object' && addr !== null ? addr.port : 0)
    })
  })
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

/** 极简响应替身：记录 status + body（与既有用例同构） */
function fakeRes() {
  const out: { status: number; body: unknown } = { status: 0, body: undefined }
  const res = {
    writeHead: (status: number) => {
      out.status = status
    },
    end: (body: string) => {
      out.body = JSON.parse(body)
    },
  }
  return { res: res as unknown as ServerResponse, out }
}

/** 极简请求替身：method/url/来源地址/body 分块 */
function fakeReq(opts: { method?: string; url?: string; remoteAddress?: string; body?: string }) {
  const chunks = opts.body === undefined ? [] : [Buffer.from(opts.body)]
  return {
    method: opts.method ?? 'POST',
    url: opts.url ?? '/send',
    socket: { remoteAddress: opts.remoteAddress ?? '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c
    },
  }
}

/** 造一个真 CCC 目录（含 .serenity 标记；首行即 CCC 名） */
function makeCcc(name: string, cccName?: string): string {
  const d = mkdtempSync(join(tmpdir(), 'weixin-send-ccc-'))
  tempCccDirs.push(d)
  writeFileSync(join(d, '.serenity'), cccName ?? name)
  return d
}

const ctxStub = {} as never

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weixin-send-api-br-'))
  oldConfigEnv = process.env.SERENITY_HOOKS_CONFIG
  process.env.SERENITY_HOOKS_CONFIG = join(dir, 'serenity-hooks.json')
  writeFileSync(join(dir, '.serenity'), 'test')
  sendMock.mockReset()
  discoverMock.mockReset()
})

afterEach(() => {
  stopWeixinSendApi()
  if (oldConfigEnv === undefined) delete process.env.SERENITY_HOOKS_CONFIG
  else process.env.SERENITY_HOOKS_CONFIG = oldConfigEnv
  rmSync(dir, { recursive: true, force: true })
  for (const d of tempCccDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

// ── A 组：请求体边界 ──────────────────────────────────────────────────────────────

describe('weixin-send-api 分支：A 组 —— 请求体边界', () => {
  it('🔴 A1 体超 64 KB ⇒ 413 BODY_TOO_LARGE（读取时**边读边判**，不是读完再判）', async () => {
    const { res, out } = fakeRes()
    // 真故障形态：真造一个 > 64KB 的体（不分块 ⇒ 首次累加即越限）
    const big = 'x'.repeat(64 * 1024 + 1)

    await handleWeixinSendRequest(ctxStub, fakeReq({ body: big }) as never, res)

    // 🔴 钉 code ＋ status 两者（调用方按 code 判定）
    expect(out.status).toBe(413)
    expect((out.body as { code: string }).code).toBe('BODY_TOO_LARGE')
    // 且**没有**走到桥（越限必须在发送前被拦住）
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('🔴 A2 空体 ⇒ 按空对象解析（空串回退那侧）⇒ 报缺 ccc 而非 BAD_JSON', async () => {
    const { res, out } = fakeRes()

    // body 未给 ⇒ asyncIterator 无产出 ⇒ raw === ''
    await handleWeixinSendRequest(ctxStub, fakeReq({}) as never, res)

    // 🔴 关键区分：空体**不是** JSON 解析错误（若误写成 JSON.parse('') 会得 BAD_JSON）
    expect(out.status).toBe(400)
    expect((out.body as { code: string }).code).toBe('BAD_REQUEST')
    expect((out.body as { error: string }).error).toContain('ccc')
  })

  it('🔴 A2b 真非法 JSON ⇒ BAD_JSON（与 A2 的对照，证明两条分支确实分开）', async () => {
    const { res, out } = fakeRes()

    await handleWeixinSendRequest(ctxStub, fakeReq({ body: '{not json' }) as never, res)

    expect(out.status).toBe(400)
    expect((out.body as { code: string }).code).toBe('BAD_JSON')
  })
})

// ── B 组：状态映射完整性（既有只测了 409 与 502） ──────────────────────────────────

describe('weixin-send-api 分支：B 组 —— 桥失败 code 的语义化状态映射', () => {
  /** 造一个能解析到 CCC 的环境，让流程走到 `sendProactiveText` */
  async function withResolvableCcc(): Promise<void> {
    const ccc = makeCcc('home-serenity')
    discoverMock.mockResolvedValue([{ root: ccc, name: 'home-serenity' }] as never)
  }

  it('🔴 B1 ACCOUNT_NOT_FOUND ⇒ **400**（客户端给错了账号 ⇒ 重试无用）', async () => {
    await withResolvableCcc()
    sendMock.mockResolvedValue({ ok: false, code: 'ACCOUNT_NOT_FOUND', error: '账号不存在或未启用: nope' })
    const { res, out } = fakeRes()

    await handleWeixinSendRequest(
      ctxStub,
      fakeReq({ body: JSON.stringify({ ccc: 'home-serenity', user: 'u@im.wechat', text: 'hi' }) }) as never,
      res,
    )

    expect(out.status).toBe(400)
    expect((out.body as { code: string }).code).toBe('ACCOUNT_NOT_FOUND')
  })

  it('🔴 B2 未知 code（default 侧）⇒ **400 而非 5xx** —— 不得让调用方误以为"重试有用"', async () => {
    await withResolvableCcc()
    // 造一个桥侧返回的、映射表里没有的 code（未来新增 code 忘改映射即此形态）
    sendMock.mockResolvedValue({ ok: false, code: 'SOME_FUTURE_CODE' as never, error: 'x' })
    const { res, out } = fakeRes()

    await handleWeixinSendRequest(
      ctxStub,
      fakeReq({ body: JSON.stringify({ ccc: 'home-serenity', user: 'u@im.wechat', text: 'hi' }) }) as never,
      res,
    )

    // 🔴 方向断言：default 归**客户端错误**（400）—— 这是语义选择，不是随手写的兜底
    expect(out.status).toBe(400)
    expect((out.body as { code: string }).code).toBe('SOME_FUTURE_CODE')
  })

  it('🔵 B2b 对照：SEND_FAILED ⇒ 502（与 B2 的 400 形成可分性证据）', async () => {
    await withResolvableCcc()
    sendMock.mockResolvedValue({ ok: false, code: 'SEND_FAILED', error: '上游拒绝' })
    const { res, out } = fakeRes()

    await handleWeixinSendRequest(
      ctxStub,
      fakeReq({ body: JSON.stringify({ ccc: 'home-serenity', user: 'u@im.wechat', text: 'hi' }) }) as never,
      res,
    )

    expect(out.status).toBe(502)
  })
})

// ── C 组：CCC 发现失败 ────────────────────────────────────────────────────────────

describe('weixin-send-api 分支：C 组 —— CCC 发现失败（`:246` 容器）', () => {
  it('🔴 C1 collectCandidates 抛 ⇒ 500 CCC_DISCOVERY_FAILED（**不是** 404「未知 CCC」）', async () => {
    // 真故障形态：枚举链路本身炸了（与"枚举成功但没有这个 CCC"是两回事）
    discoverMock.mockRejectedValue(new Error('ccc-roots exploded'))
    const { res, out } = fakeRes()

    await handleWeixinSendRequest(
      ctxStub,
      fakeReq({ body: JSON.stringify({ ccc: 'home-serenity', user: 'u@im.wechat', text: 'hi' }) }) as never,
      res,
    )

    // 🔴 关键区分：枚举失败 = **服务端**问题（500，重试可能有用）
    //    而"CCC 不存在" = 客户端问题（404）。两者不得混为一谈。
    expect(out.status).toBe(500)
    expect((out.body as { code: string }).code).toBe('CCC_DISCOVERY_FAILED')
    expect((out.body as { error: string }).error).toContain('ccc-roots exploded')
  })
})

// ── D 组：候选装配退化 ────────────────────────────────────────────────────────────

describe('weixin-send-api 分支：D 组 —— 候选装配退化（`:155` `:157`）', () => {
  it('🔴 D1 条目无 root ⇒ 跳过；重复 root ⇒ 去重（`:155`）', async () => {
    const real = makeCcc('home-serenity')
    discoverMock.mockResolvedValue([
      { root: real, name: 'home-serenity' },
      { root: real, name: 'home-serenity' }, // 重复 ⇒ seen 拦截
      { root: '', name: 'bogus' }, // 无 root ⇒ 跳过
    ] as never)
    // 🔴 桥替身必须给返回值（首跑红即此：vi.fn() 默认返回 undefined ⇒ `result.ok` 崩）
    sendMock.mockResolvedValue({ ok: true, accountId: 'a', userId: 'u', sessionId: 's', role: 'r' })
    const { res, out } = fakeRes()

    await handleWeixinSendRequest(
      ctxStub,
      fakeReq({ body: JSON.stringify({ ccc: 'home-serenity', user: 'u@im.wechat', text: 'hi' }) }) as never,
      res,
    )

    // 去重后只剩一个候选 ⇒ 名称解析唯一命中 ⇒ 正常走到桥
    expect(out.status).toBe(200)
    expect(sendMock).toHaveBeenCalledTimes(1)
  })

  it('🔴 D2 条目无 `name` ⇒ dirName 回落 `basename(root)`（`:157`）', async () => {
    const real = makeCcc('home-serenity', 'serenity-alias')
    // name 缺省 ⇒ dirName 取 basename（临时目录名），cccName 取 .serenity 首行
    discoverMock.mockResolvedValue([{ root: real }] as never)
    sendMock.mockResolvedValue({ ok: true, accountId: 'a', userId: 'u', sessionId: 's', role: 'r' })
    const { res } = fakeRes()

    await handleWeixinSendRequest(
      ctxStub,
      fakeReq({
        // 用 **.serenity 首行名**（serenity-alias）解析 —— 只有 cccName 真的被读到才可能命中
        body: JSON.stringify({ ccc: 'serenity-alias', user: 'u@im.wechat', text: 'hi' }),
      }) as never,
      res,
    )

    // 🔴 断言"cccName 真从 .serenity 读出来"：否则 byName 匹配不到 alias ⇒ 404
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock.mock.calls[0]![0]).toMatchObject({ root: real })
  })
})

// ── E 组：装配容错 ────────────────────────────────────────────────────────────────

describe('weixin-send-api 分支：E 组 —— 装配容错（配置抛 / 事件通道缺失）', () => {
  it('🔴 E1 `ctx.on` 两个通道都抛 ⇒ 不阻断，且 **sync 仍执行**（`:332` `:337`）', async () => {
    // 旧宿主 / 测试替身形态：没有事件通道
    const ctx = {
      on: () => {
        throw new Error('no such event channel')
      },
    }
    const port = await reserveFreePort()
    // 🔴 端口必须隔离（默认 3082 = 真实生产端口，本件首跑实测撞 EADDRINUSE）
    writeConfig({ weixinApi: { enabled: true, port } })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // 🔴 方向断言：不是只"不抛"，而是**吞掉后仍继续**（纪律 20 族的强测试）
    expect(() => registerWeixinSendApi(ctx as never)).not.toThrow()

    // 证据：sync 走到了 startFace 的成功分支 ⇒ endpoint 真被设上（异步，等一拍）
    await vi.waitFor(() => {
      expect(weixinSendEndpoint()).not.toBeNull()
    })

    warn.mockRestore()
  })

  it('🔴 E2 配置 enabled:false ⇒ 同步停（endpoint 保持 null）—— E1 的**方向对照**', async () => {
    const port = await reserveFreePort()
    writeConfig({ weixinApi: { enabled: false, port } })

    registerWeixinSendApi({ on: () => () => {} } as never)

    // 🔴 与 E1 构成可分性：同一夹具下"关"必须**真的不启**
    expect(weixinSendEndpoint()).toBeNull()
  })

  it('🔴 E3 配置 port:0 ⇒ 视为关闭（`enabled() = cfg.enabled && cfg.port > 0` 的端口侧）', async () => {
    writeConfig({ weixinApi: { enabled: true, port: 0 } })

    registerWeixinSendApi({ on: () => () => {} } as never)

    // 🔴 "端口 0 = 关闭"是既有语义（规格里逐字）——不是"随机端口"
    expect(weixinSendEndpoint()).toBeNull()
  })

  it('🔴 E4 配置缺失 ⇒ 走默认值、**不抛、不告警**（`:313` 的 catch 构造上不可达——如实登记）', async () => {
    // 🔴 诚实登记（纪律 8 镜像）：`:313` 的「配置读取失败」catch **当前不可达** ——
    //    `readAdvancedSettings()` = `mergeWithDefaults(readFileSafe(...))`，而 `readFileSafe`
    //    **把所有读取/解析异常都吞掉并返回 `{}`**（config-ops.ts 的 catch），`mergeWithDefaults`
    //    是纯函数 ⇒ 该 `try` **永不进入 catch**（与地图 §3-8「构造上不可达」一族同性质）。
    //    ⇒ 不造"假故障"去涂绿。
    //
    // 🔴 **本用例刻意不调 `registerWeixinSendApi`**：配置缺失 ⇒ 默认 `enabled:true, port:3082`
    //    （真实生产端口）⇒ 那会去**绑定活服务端口**（本件首跑实测撞 EADDRINUSE）。
    //    改为直接观察**判据函数**的缺省语义（零监听、零端口）。
    rmSync(process.env.SERENITY_HOOKS_CONFIG!, { force: true }) // 文件不存在 ⇒ 走默认
    const { readAdvancedSettings } = await import('../src/config-ops.js')

    // 🔴 真实契约：配置缺失**不得抛**（这条才是那道 catch 想守的东西）
    const cfg = readAdvancedSettings()
    expect(cfg.weixinApi.enabled).toBe(true) // 默认启用（本面"零公网暴露故默认开"）
    expect(cfg.weixinApi.port).toBe(3082) // 默认端口（= 生产端口，故上句不得触发绑定）

    // 且缺省路径**不该**产生"配置读取失败"告警（因为根本没失败）
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const again = readAdvancedSettings()
    expect(again.weixinApi.port).toBe(3082)
    expect(warn.mock.calls.some((c) => String(c[0]).includes('配置读取失败'))).toBe(false)
    warn.mockRestore()
  })
})
