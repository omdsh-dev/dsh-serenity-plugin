/**
 * voyage-workspace-wiring.test.ts — 航行页词表注入的**接线判据**（S142，2026-10-18）
 *
 * ## 这条判据守的是什么
 * owner 报的现象：「为什么我在别的 CCC 点开显示的还是我们 home-serenity 的信息」。
 * 修法拆成两半，各自单测都能绿，但**缺了接线就整体失效**：
 *
 * | 半 | 位置 | 单测 |
 * |---|---|---|
 * | ① 服务端**能**按请求所属 CCC 注入 | `src/voyage-vocab.ts` ＋ `src/voyage-page.ts` | 各自有测 |
 * | ② 客户端 iframe **把 workspace 传上去** | `src/client/SafeModePanel.tsx` | ⬅ 原本没有 |
 *
 * 🔴 **为什么单测全绿仍会失效（本仓反复踩的形态）**：
 * 服务端的兜底第③步在**多 CCC 共存时故意不猜**（`api.ts` 的 `resolveWorkspaceCore`，
 * 与「跨轨迹不许猜」同一裁决）⇒ iframe 若只带 `?v=<版本号>`，服务端拿不到归属，
 * 只能退回进程 cwd ⇒ `cccRootForCwd` = null ⇒ **不注入** ⇒ 资产里写死的
 * home-serenity 词表原样发出去 ⇒ **缺陷逐字复现**，且**没有任何报错**。
 *
 * ⇒ 两半是**互为前提**的，必须有一条判据把「接线」本身钉住。
 * ⚠️ 为什么用源码形态断言：本仓 client 侧无 DOM 测试环境（无 jsdom / react-dom），
 * 与 `client-popover-clip-guard.test.ts` 是同一套既有办法。真实观感留给真机（D149）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage } from 'node:http'
import { registerVoyageApi } from '../src/voyage-page.js'

const clientDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client')
const tsx = readFileSync(join(clientDir, 'SafeModePanel.tsx'), 'utf-8')

// ─────────────────────────────────────────────────────────────
// ② 客户端：iframe 必须把本面板所属 CCC 传给服务端
// ─────────────────────────────────────────────────────────────

describe('航行页接线（②）：iframe 必须带上本面板所属 CCC', () => {
  /** 取 `<iframe …/>` 那一段源码（只在这一段里断言，避免命中面板别处的同名变量） */
  function iframeTag(): string {
    const m = /<iframe[\s\S]*?\/>/.exec(tsx)
    if (!m) throw new Error('iframe 不在（面板形态变了 ⇒ 这条判据必须先更新）')
    return m[0]
  }

  it('🔴 src 里带 `workspace=` 参数（缺它 ⇒ 服务端无从知道归属 ⇒ 退回写死词表）', () => {
    expect(iframeTag(), 'iframe 必须把 workspace 传上去，否则两条修法互相抵消').toMatch(/workspace=/)
  })

  it('🔴 取值来自 `status.root`（= 本面板正在显示的那个 CCC，与轨迹/技能同源）', () => {
    // 不是随便找个路径：它必须与面板展示的轨迹/技能来自**同一个**解析结果，
    // 否则会出现"面板显示 A 的轨迹、动画显示 B 的词表"这种更难查的错位。
    expect(iframeTag()).toMatch(/status\.root/)
  })

  it('根为空时不硬塞空参数（未激活态不发 `workspace=` 空值）', () => {
    // 空串会被服务端当成"有 workspace 参数"⇒ resolveWorkspace 返回 '' ⇒
    // cccRootForCwd('') = null ⇒ 不注入（行为上等价，但语义含糊）。
    // 判据：workspace 参数必须挂在条件表达式下，而不是无条件拼进去。
    expect(iframeTag(), 'workspace 参数必须条件拼接（status.root ? … : \'\'）').toMatch(
      /status\.root\s*\?[\s\S]*?&workspace=/,
    )
  })
})

// ─────────────────────────────────────────────────────────────
// ① 服务端：拿到 workspace ⇒ 按那个 CCC 注入（端到端，走真路由）
// ─────────────────────────────────────────────────────────────

/** 最小的 CCC 骨架：只要技能目录与注册表就够注入 */
function makeCcc(skills: string[], msms: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'voyage-wire-'))
  const sk = join(root, '.opencode', 'skills')
  for (const s of skills) {
    mkdirSync(join(sk, s), { recursive: true })
    writeFileSync(join(sk, s, 'SKILL.md'), `# ${s}\n`)
  }
  const ref = join(sk, 'home-serenity', 'references')
  mkdirSync(ref, { recursive: true })
  writeFileSync(join(ref, 'mech-registry.json'), JSON.stringify({ msms: msms.map((name) => ({ name })) }))
  return root
}

/** 判据专用资产：结构必须与真资产一致（`var VOCAB = {…};` 独占一行，带 `zh`） */
function writeAsset(dir: string): string {
  const p = join(dir, 'voyage.html')
  writeFileSync(
    p,
    [
      '<!DOCTYPE html>',
      '<html><body>',
      '<script>',
      'var VOCAB = {"skills":["STALE-OTHER-CCC"],"msms":["STALE"],"zh":["寰宇"],"onto":[],"counts":{"skill":1}};',
      '</script>',
      '</body></html>',
    ].join('\n'),
  )
  return p
}

function fakeReq(url: string): IncomingMessage {
  return { method: 'GET', url } as unknown as IncomingMessage
}
interface Cap {
  statusCode: number
  headers: Record<string, string>
  body: string
}
function fakeRes(): { res: unknown; cap: Cap } {
  const cap: Cap = { statusCode: 0, headers: {}, body: '' }
  const res = {
    set statusCode(v: number) {
      cap.statusCode = v
    },
    get statusCode() {
      return cap.statusCode
    },
    setHeader(k: string, v: string) {
      cap.headers[k.toLowerCase()] = v
      return this
    },
    end(chunk?: string) {
      cap.body = chunk ?? ''
    },
  }
  return { res, cap }
}
describe('航行页接线（①）：路由按 resolveRoot 给出的 CCC 注入词表', () => {
  let cccA: string
  let cccB: string
  let assetDir: string
  let assetPath: string

  beforeEach(() => {
    cccA = makeCcc(['skill-a1', 'skill-a2'], ['msm-a'])
    cccB = makeCcc(['skill-b1'], ['msm-b'])
    assetDir = mkdtempSync(join(tmpdir(), 'voyage-asset-'))
    assetPath = writeAsset(assetDir)
  })
  afterEach(() => {
    for (const p of [cccA, cccB, assetDir]) rmSync(p, { recursive: true, force: true })
  })

  /** 用给定的 root 解析器跑一次 GET，返回响应 */
  async function get(resolveRoot?: (req: IncomingMessage) => string | null): Promise<Cap> {
    const holders: Array<{ handler: (q: IncomingMessage, s: unknown) => unknown }> = []
    const c = { webServer: { register: (r: { handler: (q: IncomingMessage, s: unknown) => unknown }) => holders.push(r) } }
    registerVoyageApi(c as never, { assetPath, resolveRoot })
    const { res, cap } = fakeRes()
    await holders[0]!.handler(fakeReq('/serenity/voyage'), res)
    return cap
  }

  it('🔴 同一个 URL、不同 CCC ⇒ 返回**不同内容**（这正是缺陷本体）', async () => {
    const a = await get(() => cccA)
    const b = await get(() => cccB)
    expect(a.statusCode).toBe(200)
    expect(b.statusCode).toBe(200)
    expect(a.body).toContain('skill-a1')
    expect(b.body).toContain('skill-b1')
    // 关键：互相不得串味（这是 owner 报的那句话的可执行版本）
    expect(a.body).not.toContain('skill-b1')
    expect(b.body).not.toContain('skill-a1')
    expect(a.body).not.toBe(b.body)
  })

  it('注入后 `zh` 仍在（中文隐喻词属资产，不来自容器）', async () => {
    const a = await get(() => cccA)
    expect(a.body).toContain('"zh":["寰宇"]')
  })

  it('🔴 资产里写死的旧词表**不得**残留（负控：证明了"确实注入了"而不是恰巧包含）', async () => {
    const a = await get(() => cccA)
    expect(a.body, '注入没发生 ⇒ 别的 CCC 看到的仍是这个写死名单').not.toContain('STALE-OTHER-CCC')
  })

  it('无 resolveRoot（旧行为）⇒ 资产原样发出，且仍是长缓存', async () => {
    const cap = await get(undefined)
    expect(cap.body).toContain('STALE-OTHER-CCC')
    expect(cap.headers['cache-control']).toContain('max-age=')
  })

  it('🔴 注入时缓存降为 no-cache（同一 URL 不同 CCC 返回不同内容）', async () => {
    const cap = await get(() => cccA)
    expect(cap.headers['cache-control'], '长缓存会让"切了 CCC 还是旧词表"').toBe('no-cache')
  })

  it('resolveRoot 抛错 ⇒ 仍 200 发出原资产（装饰页不该打不开）', async () => {
    const cap = await get(() => {
      throw new Error('boom')
    })
    expect(cap.statusCode).toBe(200)
    expect(cap.body).toContain('STALE-OTHER-CCC')
  })
})
