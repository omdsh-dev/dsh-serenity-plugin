/**
 * acp-face.test.ts — **面 E：官方 ACP 面**（2026-10-16，W2/W3 的判据）
 *
 * ## 为什么这件必须有（不是"凑覆盖率"）
 * 面 E 是**默认关**的可选面，而"默认关"的代码**没有任何日常路径会碰到它**
 * ⇒ 它坏掉的形态是**静默**的：开关拨开之后才发现起不来。
 * 本轮（2026-10-16）**实测就抓到一次这种静默**：`startAcpFace` 写好了却**没有任何调用点**
 * （W3 未接线）⇒ 拨开关永远起不来，而 `typecheck` 与既有全部测试**绿**。
 *
 * ## 本件覆盖什么
 * ① **端口表契约**：面 E 的 port/host/默认开关**取自 `FACE_PORTS`**（不在本模块硬写）
 * ② **HTTP 那半**：普通请求 → **426 Upgrade Required**（"这不是网页面"的可读信号）
 * ③ 🔴 **WS 升级那半（本件最值钱的一条）**：用**真 WS 客户端**握手 ⇒ 这才证明
 *    "面真的能收 ACP 连接"。⚠️ 只断言 `faceActive()` 为真是**弱证据**：
 *    端口开着但 `'upgrade'` 没接上也满足它。
 * ④ **接线（W3）**：`registerAcpFace` 按开关起停 —— 开则起 ／ 关则停 ／ **幂等**
 * ⑤ **失败语义**：接不上 `dsh-acp` 时**不把异常泄成连接重置**，且给可读日志
 *
 * ## 判据纪律
 * · **端口纪律**：全部 `port: 0`（内核分配）——**绝不占用 3200**
 *   （那是面 E 的生产端口；占它会让本机真面起不来）
 * · **模块级状态必须复位**：`__setSimpleSourceForTest(null)` ＋ `stopAllFaces()`（`afterEach`）
 * · **降级面与正控成对**：④ 里"关 ⇒ 停"必须配"开 ⇒ 起"，否则测不出"它永远是停的"
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { request } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { WebSocket } from 'ws'

import {
  startAcpFace,
  stopAcpFace,
  acpFaceActive,
  acpFacePort,
  acpFaceEnabled,
  acpFaceStatus,
  registerAcpFace,
  resolveAcpSelection,
  normalizeClientCwd,
  __setAcpRootsForTest,
} from '../src/acp-face.js'
import { stopAllFaces } from '../src/face-host.js'
import { FACE_PORTS } from '../src/ports.js'
import { __setSimpleSourceForTest, defaultSimpleSettings } from '../src/settings-section.js'
import { ensureAcpToken, readAcpToken } from '../src/acp-auth.js'

/**
 * 造一个"已启用 ACP 通道"的临时 CCC（真文件树，不是 mock）。
 *
 * 🔴 **为什么用真文件**（而不是替身）：认证闸的判据链读的是**真配置 ＋ 真 localstore**
 * （`loadSerenityConfig` ／ `getEntry`）—— 替身会把"配置读法"这一环整段绕过去，
 * 而那正是要验的东西（同族：`59` 号桩"自造夹具只能证明按我假设的形态能跑"）。
 */
function makeAcpCcc(accountId = 'agmente-phone', role = 'tester'): string {
  const root = mkdtempSync(join(tmpdir(), 'acp-ccc-'))
  mkdirSync(join(root, '.opencode'), { recursive: true })
  writeFileSync(join(root, '.serenity'), '')
  writeFileSync(
    join(root, '.opencode', 'serenity.json'),
    JSON.stringify({
      im: { channel: 'acp', acp: { enabled: true, accounts: [{ accountId, role }] } },
      skiff: { roles: { tester: { systemPrompt: '你是测试角色。' } } },
    }),
  )
  ensureAcpToken(root, accountId) // 生成 token（落该 CCC 的 localstore）
  return root
}

/** 读一次 HTTP 状态码（本面只回 426 短句） */
function httpStatus(port: number, path = '/'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = ''
      res.setEncoding('utf-8')
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** 把设置源切成"面 E 开、端口 0（内核分配）" */
function enableAcpFace(): void {
  __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), acpFaceEnabled: true, acpFacePort: 0 }))
}

/** 等一拍：`registerAcpFace` 的启动是异步的（它自己不 await） */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 80))

/** 读源码（静态钉用；`new URL` 相对本测试文件解析，与 `__dirname` 等价且是 ESM 正规写法） */
async function readSrc(name: string): Promise<string> {
  const fs = await import('node:fs')
  return fs.readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf-8')
}

/**
 * 剥掉注释后的源码 —— **静态钉必须在它上面判**（2026-10-16 实测踩到）。
 *
 * 🔴 **为什么必须有这个函数**：本文件有一条钉是"**不得**含 `registerUpgrade`"，
 *    而源文件的**文档注释里恰好逐字写着它**（在解释"为什么**不**走那条路"）。
 *    ⇒ 首跑当场**假红**：断言命中的是**那句解释**，不是任何可执行代码。
 *
 * 这与本轨迹既有的那条判据同族（2026-10-16 续 139 的「提示词回声」）：
 * **凡"文本里含某词"的断言，都要先排除"这句话自己把该词说了一遍"这条污染路径。**
 * ⚠️ 粗糙但够用：只处理行注释与块注释；本仓源码里没有会把它们嵌进字符串的写法。
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

beforeEach(() => {
  __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings() }))
})

afterEach(() => {
  stopAcpFace()
  stopAllFaces()
  __setSimpleSourceForTest(null)
})

describe('面 E（官方 ACP）：端口表契约', () => {
  it('端口/地址/默认开关**取自集中端口表**（单一真相源，不在本模块硬写）', () => {
    expect(FACE_PORTS.acp.port).toBe(3200)
    // owner Q3 裁决：先 `0.0.0.0` 监听（隧道不归 ACC 管）——而自持面可直接绑它
    expect(FACE_PORTS.acp.host).toBe('0.0.0.0')
    // 默认关：它带"协议无认证"的暴露面 ⇒ 不默认开是有意为之
    expect(FACE_PORTS.acp.defaultEnabled).toBe(false)
  })

  it('🔴 与已退役旧面 E（3100）**不是一回事**：端口分开，且 3100 不在表里', () => {
    expect(FACE_PORTS.acp.port).not.toBe(3100)
    expect(Object.values(FACE_PORTS).some((p) => p.port === 3100)).toBe(false)
  })

  it('未启动时：`acpFaceActive()` 假、`acpFacePort()` null（不撒谎）', () => {
    expect(acpFaceActive()).toBe(false)
    expect(acpFacePort()).toBeNull()
  })
})

describe('面 E：状态读数（安全前提不许含混）', () => {
  it('🔴 `status().authNote` **必须**带"协议无认证 ＋ 靠外部 Access 兜底"', () => {
    const s = acpFaceStatus()
    // 判据：把"无认证"说清楚 —— 否则读者会"看到 active 就以为它是安全的"
    expect(s.authNote).toContain('不做认证')
    expect(s.authNote).toContain('Access')
    expect(s.host).toBe(FACE_PORTS.acp.host)
  })

  it('启用意图读自设置面（缺省 false；改设置即反映）', () => {
    expect(acpFaceEnabled()).toBe(false)
    enableAcpFace()
    expect(acpFaceEnabled()).toBe(true)
  })
})

describe('面 E：真实 listener ＋ 真实 HTTP 往返（426 Upgrade Required）', () => {
  it('普通 GET → **426** ＋ 提示用 ACP 客户端（对照：面 D 是网页面会回 HTML）', async () => {
    enableAcpFace()
    const handle = await startAcpFace({} as never) // 端口 0 = 内核分配（绝不占 3200）
    const { status, body } = await httpStatus(handle.port)
    expect(status).toBe(426)
    expect(body).toContain('ACP')
    // 自持面的前提：面宿主必须把原始 `server` 交出来（自挂 'upgrade' 靠它）
    expect(handle.server).toBeTruthy()
    expect(acpFaceActive()).toBe(true)
    expect(acpFacePort()).toBe(handle.port)
  })

  it('停面幂等：停两次都安全；停后 `active` 转假', async () => {
    enableAcpFace()
    await startAcpFace({} as never)
    expect(stopAcpFace()).toBe(true)
    expect(acpFaceActive()).toBe(false)
    expect(stopAcpFace()).toBe(false) // 第二次：无在监听的面 ⇒ 假（＝幂等）
  })
})

describe('🔴 面 E：真实 WebSocket 升级（本件最强的证据）', () => {
  // 🔴 v1.59.0：面 E 现在有**认证闸**（owner 令「随即生成认证用的 token」）⇒
  //    握手测试必须先造一个"已启用 ACP 通道 ＋ 有 token ＋ 有角色"的 CCC。
  //    ⚠️ 这两例改写前是"裸连即 101" —— 那个契约**已作废**（裸连现在必须 401）。
  let ccc: string
  beforeEach(() => {
    ccc = makeAcpCcc()
    __setAcpRootsForTest([ccc])
  })
  afterEach(() => {
    __setAcpRootsForTest(null)
    try { rmSync(ccc, { recursive: true, force: true }) } catch { /* 已清 */ }
  })

  it("真 WS 客户端（带对 token）能完成 101 握手 ⇒ `'upgrade'` 确实接上了（不是\"端口开着\"而已）", async () => {
    enableAcpFace()
    const handle = await startAcpFace({} as never)
    const token = readAcpToken(ccc, 'agmente-phone')!

    const outcome = await new Promise<{ opened: boolean; err?: string }>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/acp`, {
        headers: { authorization: `Bearer ${token}` },
      })
      let settled = false
      const done = (v: { opened: boolean; err?: string }): void => {
        if (settled) return
        settled = true
        resolve(v)
      }
      ws.on('open', () => {
        // 关键读数：**握手成功**（服务端接受了 upgrade）；随后接线会因 ctx 是空对象而失败
        // ⇒ 这里只证明"升级路径通了"，不假装 ACP 会话跑通（那由 acp-selftest 验）
        done({ opened: true })
        ws.close()
      })
      ws.on('error', (e: Error) => done({ opened: false, err: e.message }))
      // 兜底：若握手根本没发生（例如 upgrade 未挂），会在超时里暴露
      setTimeout(() => done({ opened: false, err: 'timeout：未见 101 握手' }), 2000)
    })

    expect(outcome.err ?? '').toBe('')
    expect(outcome.opened).toBe(true)
  })

  it('🔴 空 ctx（无 `ctx.plugin`）⇒ 接线失败但**不泄成连接重置**，且记一条可读错误', async () => {
    enableAcpFace()
    const handle = await startAcpFace({} as never)
    const token = readAcpToken(ccc, 'agmente-phone')!

    const closed = await new Promise<{ code: number }>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/acp`, {
        headers: { authorization: `Bearer ${token}` },
      })
      ws.on('close', (code: number) => resolve({ code }))
      ws.on('error', () => { /* close 紧随其后 */ })
      setTimeout(() => resolve({ code: -1 }), 2000)
    })

    // 服务端在接线失败时用 1011 关闭（"内部错误"）——**不是**让 socket 静默悬着
    expect(closed.code).toBe(1011)
    // 诊断面留痕：`acpFaceStatus().errors` 记下了原因（人可读）
    const errs = acpFaceStatus().errors
    expect(errs.length).toBeGreaterThan(0)
    expect(errs[errs.length - 1]?.applied).toBe(false)
    expect(acpFaceStatus().connections).toBeGreaterThan(0)
  })
})

describe('🔴 面 E 认证闸（v1.59.0，owner 令「随即生成认证用的 token」）', () => {
  let ccc: string
  beforeEach(() => {
    ccc = makeAcpCcc()
    __setAcpRootsForTest([ccc])
  })
  afterEach(() => {
    __setAcpRootsForTest(null)
    try { rmSync(ccc, { recursive: true, force: true }) } catch { /* 已清 */ }
  })

  /** 连一次，返回握手结果（不抛） */
  async function tryConnect(port: number, url: string): Promise<{ opened: boolean; status?: number; err?: string }> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${url}`)
      let settled = false
      const done = (v: { opened: boolean; status?: number; err?: string }): void => {
        if (settled) return
        settled = true
        resolve(v)
      }
      ws.on('open', () => { done({ opened: true }); ws.close() })
      ws.on('unexpected-response', (_req, res) => done({ opened: false, status: res.statusCode }))
      ws.on('error', (e: Error) => done({ opened: false, err: e.message }))
      setTimeout(() => done({ opened: false, err: 'timeout' }), 2000)
    })
  }

  it('🔴 不带 token ⇒ **401**，且连接根本不升上来（本件的核心判据）', async () => {
    enableAcpFace()
    const handle = await startAcpFace({} as never)
    const r = await tryConnect(handle.port, '/acp')
    expect(r.opened).toBe(false)
    expect(r.status).toBe(401)
    // 拒掉的连接**单独计数**（否则"有人在敲门"会被读成"已服务"）
    expect(acpFaceStatus().rejected).toBeGreaterThan(0)
  })

  it('🔴 带**错** token ⇒ 401（不是"带了就放行"）', async () => {
    enableAcpFace()
    const handle = await startAcpFace({} as never)
    const r = await tryConnect(handle.port, '/acp?token=deadbeefdeadbeef')
    expect(r.opened).toBe(false)
    expect(r.status).toBe(401)
  })

  it('🔴 带**对** token（查询串形态）⇒ 101（正控：证明拒的是 token 而不是"一律拒"）', async () => {
    enableAcpFace()
    const handle = await startAcpFace({} as never)
    const token = readAcpToken(ccc, 'agmente-phone')!
    const r = await tryConnect(handle.port, `/acp?token=${token}`)
    expect(r.opened).toBe(true)
  })

  it('🔴 名单外的 CCC（未启用 ACP 通道）⇒ 401：token 对也不放行', async () => {
    enableAcpFace()
    const handle = await startAcpFace({} as never)
    const token = readAcpToken(ccc, 'agmente-phone')!
    __setAcpRootsForTest([]) // 模拟"该 CCC 未启用 ACP 通道"
    const r = await tryConnect(handle.port, `/acp?token=${token}`)
    expect(r.opened).toBe(false)
    expect(r.status).toBe(401)
  })
})

describe('🔴 面 E 接线（W3）：开关真能起停 —— 本轮实测的静默缺陷的回归钉', () => {
  it('关（缺省）⇒ **不起监听**；开 ⇒ 起（正控）', async () => {
    // 关：默认源即关
    registerAcpFace({ on: () => {} } as never)
    await settle()
    expect(acpFaceActive()).toBe(false)

    // 开（正控）
    enableAcpFace()
    registerAcpFace({ on: () => {} } as never)
    await settle()
    expect(acpFaceActive()).toBe(true)
  })

  it('开 → 关：再 sync 必须**真停掉**（否则"关开关"只是改了个数字）', async () => {
    enableAcpFace()
    registerAcpFace({ on: () => {} } as never)
    await settle()
    expect(acpFaceActive()).toBe(true)

    __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), acpFaceEnabled: false, acpFacePort: 0 }))
    registerAcpFace({ on: () => {} } as never)
    expect(acpFaceActive()).toBe(false)
  })

  it('幂等：连续 sync **只起一个** listener（不 EADDRINUSE、端口不变）', async () => {
    enableAcpFace()
    registerAcpFace({ on: () => {} } as never)
    await settle()
    const first = acpFacePort()

    registerAcpFace({ on: () => {} } as never) // 第二次：已在监听 ⇒ 直接返回
    await settle()
    expect(acpFacePort()).toBe(first)
  })

  it('🔴 事件通道缺失（ctx 无 `on`）⇒ **不抛**（apply 不可成为启动单点）', () => {
    expect(() => registerAcpFace({} as never)).not.toThrow()
  })

  it('🔴 监听的是**宿主的真事件** `settings/document-updated`（按 ns 过滤），不是死通道', async () => {
    const registered: string[] = []
    const ctx = {
      on: (name: string) => { registered.push(name) },
    }
    registerAcpFace(ctx as never)
    // 真事件在场（v1.51.1 实测：面板拨配置不重跑 apply ⇒ 必须靠事件）
    expect(registered).toContain('settings/document-updated')
    // 兜底两条也在
    expect(registered).toContain('agent/created')
    expect(registered).toContain('session/created')
  })
})

describe('🔴 面 E 的模型解析（2026-10-16 容器实测抓出的真缺陷的回归钉）', () => {
  /**
   * 缺陷回顾（本组的由来，别删）：我们曾**裸传** `provider: undefined, model: undefined`
   * ⇒ 上游 `dsh-acp` 的 `agentOptions()` 在字段 undefined 时**整个省掉**该键
   * ⇒ agent 真的没有模型 ⇒ 第一条 prompt 必失败（`{{model}} has no value`）。
   * ⚠️ 它 **typecheck ／ 2812 条单测 ／ deploy 预检全绿**，只有容器里的真模型那一跑能抓到。
   * ⇒ 本组钉住"缺省时**必须**从宿主默认模型服务取"，防它再退化回 undefined。
   */
  const OLD = { SERENITY_ACP_PROVIDER: process.env.SERENITY_ACP_PROVIDER, SERENITY_ACP_MODEL: process.env.SERENITY_ACP_MODEL }
  afterEach(() => {
    // 环境变量是**进程级**的 ⇒ 必须复位（否则跨用例泄漏，本仓既有纪律）
    if (OLD.SERENITY_ACP_PROVIDER === undefined) delete process.env.SERENITY_ACP_PROVIDER
    else process.env.SERENITY_ACP_PROVIDER = OLD.SERENITY_ACP_PROVIDER
    if (OLD.SERENITY_ACP_MODEL === undefined) delete process.env.SERENITY_ACP_MODEL
    else process.env.SERENITY_ACP_MODEL = OLD.SERENITY_ACP_MODEL
  })

  it('🔴 环境变量未设 ⇒ 从 `ctx.agentDefaultModel.currentSelection()` 取（**不许**给出 undefined）', () => {
    delete process.env.SERENITY_ACP_PROVIDER
    delete process.env.SERENITY_ACP_MODEL
    const sel = resolveAcpSelection({
      get: (n: string) => (n === 'agentDefaultModel'
        ? { currentSelection: () => ({ provider: 'host-default-p', model: 'host-default-m' }) }
        : undefined),
    } as never)
    // 这条断言就是那个缺陷的回归钉：旧实现下两个字段都是 undefined
    expect(sel).toEqual({ provider: 'host-default-p', model: 'host-default-m' })
  })

  it('显式环境变量优先于宿主默认（**显式 > 缺省**）', () => {
    process.env.SERENITY_ACP_PROVIDER = 'env-p'
    process.env.SERENITY_ACP_MODEL = 'env-m'
    const sel = resolveAcpSelection({
      get: () => ({ currentSelection: () => ({ provider: 'host-p', model: 'host-m' }) }),
    } as never)
    expect(sel).toEqual({ provider: 'env-p', model: 'env-m' })
  })

  it('宿主默认服务缺失 ⇒ 退回旧行为（两个 undefined），**不抛**', () => {
    delete process.env.SERENITY_ACP_PROVIDER
    delete process.env.SERENITY_ACP_MODEL
    const sel = resolveAcpSelection({ get: () => undefined } as never)
    expect(sel).toEqual({ provider: undefined, model: undefined })
  })

  it('🔴 宿主服务读取**抛错**时也不炸（cordis 对未声明 inject 的服务名会抛 —— 本仓 v1.31.4 实证）', () => {
    delete process.env.SERENITY_ACP_PROVIDER
    delete process.env.SERENITY_ACP_MODEL
    const sel = resolveAcpSelection({
      get: () => { throw new Error('cannot get property "agentDefaultModel" without inject') },
    } as never)
    expect(sel).toEqual({ provider: undefined, model: undefined })
  })

  it('只给一半环境变量（provider 有、model 无）⇒ 视为不完整，继续走宿主默认', () => {
    process.env.SERENITY_ACP_PROVIDER = 'env-p'
    delete process.env.SERENITY_ACP_MODEL
    const sel = resolveAcpSelection({
      get: () => ({ currentSelection: () => ({ provider: 'host-p', model: 'host-m' }) }),
    } as never)
    expect(sel).toEqual({ provider: 'host-p', model: 'host-m' })
  })

  it('🔴 静态钉：接线处**不许**再裸传 `readAcpProvider()`（防回退到缺陷形态）', async () => {
    const code = stripComments(await readSrc('acp-face.ts'))
    expect(code).not.toContain('provider: readAcpProvider()')
    expect(code).toContain('resolveAcpSelection(')
  })
})

describe('面 E：设计前提的静态钉（设计 §2 / §3）', () => {
  it('🔴 **不借**宿主 `webServer.registerUpgrade`（那条工程约束整个消失）', async () => {
    // ⚠️ 钉在**剥注释后**的源码上：文件头逐字解释过"为什么**不**走那条路"
    //    ⇒ 不剥会命中那句解释（首跑实测假红）
    const code = stripComments(await readSrc('acp-face.ts'))
    // 自持面的核心决策：面宿主是**我们自己的**，在自己 server 上挂 'upgrade'
    expect(code).not.toContain('registerUpgrade')
    expect(code).toContain("await import('@deepseek-ai/dsh-acp')")
    // 且它**不**手写 `dsh-acp`/**ws** 的形状（真契约来自上游；D111 三件齐之③）
    expect(code).toContain("import type { AcpConfig } from '@deepseek-ai/dsh-acp'")
    expect(code).toContain("import type { WebSocket, WebSocketServer } from 'ws'")
  })

  it('🔴 依赖不可用 ⇒ 错误文案提到两个包名（可诊断，不是裸 ERR_MODULE_NOT_FOUND）', async () => {
    const code = stripComments(await readSrc('acp-face.ts'))
    expect(code).toContain('面 E 依赖不可用')
    expect(code).toContain('@deepseek-ai/dsh-acp')
    expect(code).toContain("await import('ws')")
  })

  it('🔴 `inject` 名单**照抄上游**（少一个就在它内部抛错；跨版本注意点）', async () => {
    const code = stripComments(await readSrc('acp-face.ts'))
    expect(code).toContain("['agents', 'llm', 'sessionPersistence', 'sessions']")
  })

  it('🔴 自持 listener 的唯一拆卸入口在 `face-host`（不新建第二条拆卸路径）', async () => {
    const code = stripComments(await readSrc('acp-face.ts'))
    // `stopAcpFace` 必须真调 face-host 的 `stopFace` —— 本轮修掉的一处静默：
    // 原实现走一个**永假**的本地替身（`let faceStop = () => false`）且生产路径从不接线
    // ⇒ 拆卸时会话/端口都收不干净，而测试与 typecheck 全绿。
    expect(code).toContain('stopFace(FACE_ACP)')
    // 且**不再**有那个自造替身（它正是静默的来源）
    expect(code).not.toContain('faceStop')
  })
})

/**
 * 🔴 v1.59.2（owner 2026-10-17 令：「working directory 能改成让我填 ccc 目录名就可以吗？」）
 *
 * ## 这件在防什么
 * 宿主 `dsh-acp` **硬性**要求 `cwd` 是绝对路径（`validateWorkspaceParams` 里的
 * `if (!isAbsolute(params.cwd)) throw invalidParams(...)`）。而连接归属哪个 CCC
 * **已经由 token 决定了**（服务端权威）⇒ 让用户再手打一遍绝对路径是**同一信息说两遍**，
 * 且那第二遍正是最容易打错的一遍。
 *
 * ⚠️ **不改宿主**（D4 零改 DSH）：归一化只发生在**我们自己的缝**（WS 帧 → ACP Stream）。
 *
 * ## 为什么"归一化"不能顺手把越权也判了
 * 越权判据必须只有一处（`cwdInsideRoot`，它还管角色认领）。在这里再判一次 =
 * **两份会漂的实现**。⇒ 本件的反侧用例钉住"绝对但在根外 ⇒ **原样透传**，不在这里拒"。
 */
describe('🔴 v1.59.2 cwd 归一化：客户端可只填 CCC 目录名', () => {
  // ⚠️ **中性路径**：本仓是公开的（B 面 = GitHub public），隐私扫描会拦真实家目录
  const CCC = '/srv/ccc-root'

  it('🔴 非绝对（目录名 ／ 单字符 ／ 相对路径）⇒ 落到该 CCC 根', () => {
    expect(normalizeClientCwd('serenity', CCC)).toBe(CCC)
    expect(normalizeClientCwd('home-serenity', CCC)).toBe(CCC)
    expect(normalizeClientCwd('a', CCC)).toBe(CCC) // 用户实际就是这么填的
    expect(normalizeClientCwd('.', CCC)).toBe(CCC)
    expect(normalizeClientCwd('../other', CCC)).toBe(CCC) // 相对路径一律不猜
  })

  it('🔴 空 ／ 非字符串 ／ 空白 ⇒ 落到该 CCC 根（不是抛错、更不是保持 undefined）', () => {
    expect(normalizeClientCwd('', CCC)).toBe(CCC)
    expect(normalizeClientCwd('   ', CCC)).toBe(CCC)
    expect(normalizeClientCwd(undefined, CCC)).toBe(CCC)
    expect(normalizeClientCwd(null, CCC)).toBe(CCC)
    expect(normalizeClientCwd(42, CCC)).toBe(CCC)
  })

  it('正控：已经是绝对路径 ⇒ **原样**（不擅自改写用户明确给的值）', () => {
    expect(normalizeClientCwd(CCC, CCC)).toBe(CCC)
    expect(normalizeClientCwd(`${CCC}/AGENT_SESSIONS`, CCC)).toBe(`${CCC}/AGENT_SESSIONS`)
  })

  it('🔴 反侧：绝对但在 CCC 之外 ⇒ **原样透传**，不在这里拒', () => {
    // 为什么不在这里拒：越权判据只允许有一处（cwdInsideRoot）。
    // 若这里也拒一次，两处会漂 —— 改了一处另一处仍是旧的，而**没有任何门会报**。
    expect(normalizeClientCwd('/etc', CCC)).toBe('/etc')
    expect(normalizeClientCwd('/srv/other-ccc', CCC)).toBe('/srv/other-ccc')
  })

  it('两侧配平：归一化后的值**一定**满足宿主的 isAbsolute 前提', () => {
    const inputs = ['serenity', 'a', '.', '', '   ', undefined, null, '/etc', CCC]
    for (const raw of inputs) {
      const out = normalizeClientCwd(raw, CCC)
      expect(isAbsolute(out), `输入 ${String(raw)} 归一化后仍非绝对：${out}`).toBe(true)
    }
  })
})
