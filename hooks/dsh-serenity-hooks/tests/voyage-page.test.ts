import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync } from 'node:fs'
import {
  VOYAGE_PATH,
  VOYAGE_ASSET,
  voyageAssetPath,
  loadVoyageHtml,
  resetVoyageCache,
  registerVoyageApi,
} from '../src/voyage-page.js'

/**
 * voyage-page 镜像测试（2026-09-15 S142）。
 *
 * 两类判据：
 *  ① **资产面**——文件在位、可读、且**内容是我们的**（把"外来内容"这条判据钉进 CI：
 *     上一轮我正是靠人工 grep 漏掉了**全大写写法的外来铭牌字样**，判据必须自动化且**大小写不敏感**）；
 *  ② **路由面**——注册形态 + 三种响应（200 正文/405 方法/500 资产缺失）。
 */

/** 最小 req / res 假体（只实现 handler 用到的面） */
function fakeReq(method: string): IncomingMessage {
  return { method } as unknown as IncomingMessage
}
interface Captured {
  statusCode: number
  headers: Record<string, string>
  body: string
}
function fakeRes(): { res: unknown; cap: Captured } {
  const cap: Captured = { statusCode: 0, headers: {}, body: '' }
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

/** 捕获注册面（只实现 ctx.webServer.register） */
function fakeCtx(): { ctx: unknown; registered: Array<{ kind: string; path: string; handler: (q: IncomingMessage, s: unknown) => unknown }> } {
  const registered: Array<{ kind: string; path: string; handler: (q: IncomingMessage, s: unknown) => unknown }> = []
  const ctx = { webServer: { register: (r: (typeof registered)[number]) => registered.push(r) } }
  return { ctx, registered }
}

describe('voyage-page：资产面（ACC 层静态资产）', () => {
  beforeEach(() => resetVoyageCache())

  it('资产路径解析到包根下的 assets/ 且文件真实存在', () => {
    const p = voyageAssetPath()
    expect(p.endsWith(VOYAGE_ASSET)).toBe(true)
    expect(existsSync(p)).toBe(true)
  })

  it('可读且是自包含单文件（含内联 three 与画布）', () => {
    const html = loadVoyageHtml()
    expect(html.length).toBeGreaterThan(100_000)
    expect(html).toContain('window.THREE = Object.assign')
    expect(html).toContain('<canvas id="gl"')
    expect(html).toContain('var WORDS = [')
  })

  /**
   * 🔴 v4（S216 交接）：加两条"效果层真的在产物里"的判据。
   *
   * 为什么必须加（R↓）：那套渲染的失败模式**几乎全是"页面不报错、断言全绿、效果完全没有"** ——
   * 交接方实测三例：`emissiveIntensity` 默认 1.0 导致阴影全没了／RenderTarget 默认
   * UnsignedByte 导致 bloom 提不出高光／构图灯写死世界坐标导致换侧即平光。
   * ⇒ 至少把「后期管线在不在」与「投影开没开」变成**机械可核**，
   *   否则我们连"这两层被误删了"都不会知道。
   *
   * ⚠️ 边界：这两条只证明**代码在**，**证明不了画面对** ——
   *   光/阴影/贴图是否真的生效**必须真机看**（交接单第七节）。
   */
  it('v4：后期管线与投影在产物里（效果层被整段删掉时这里会红）', () => {
    const html = loadVoyageHtml()
    expect(html).toContain('var PostFX = (function')
    expect(html).toContain('shadowMap.enabled')
  })

  it('🔒 内容判据：渲染内容里不得出现「另一个容器」的痕迹（大小写不敏感）', () => {
    const html = loadVoyageHtml()
    // 注释里允许出现（那是留档说明），判据只针对**渲染内容**：逐行排除纯注释行
    const rendered = html
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
      .join('\n')
    for (const foreign of ['other-serenity', "'other-", 'other-container', 'choerodon', 'archery', 'snowflake-id', 'AX-SESSION-FIRST']) {
      expect(rendered.toLowerCase()).not.toContain(foreign.toLowerCase())
    }
  })

  it('🔒 内容判据：我们的容器名与卡片模式开关都在', () => {
    const html = loadVoyageHtml()
    expect(html).toContain('HOME-SERENITY')
    expect(html).toContain('宁静号')
    expect(html).toContain('body.card')
    // 卡片模式判定（app.js 里的正则）必须在产物里
    expect(html).toContain('[?&]card')
  })

  it('读一次即缓存（同引用返回，不重复读盘）', () => {
    const a = loadVoyageHtml()
    const b = loadVoyageHtml()
    expect(a).toBe(b)
  })

  it('显式传入不存在的路径 → 抛错（不静默返回空）', () => {
    expect(() => loadVoyageHtml('/nonexistent/voyage.html')).toThrow()
  })
})

describe('voyage-page：路由面', () => {
  beforeEach(() => resetVoyageCache())

  it('注册在 /serenity/voyage（exact）', () => {
    const { ctx, registered } = fakeCtx()
    registerVoyageApi(ctx as never)
    expect(registered).toHaveLength(1)
    expect(registered[0]!.kind).toBe('exact')
    expect(registered[0]!.path).toBe(VOYAGE_PATH)
    expect(VOYAGE_PATH).toBe('/serenity/voyage')
  })

  it('GET → 200 + text/html + content-length 与实际字节一致', async () => {
    const { ctx, registered } = fakeCtx()
    registerVoyageApi(ctx as never)
    const { res, cap } = fakeRes()
    await registered[0]!.handler(fakeReq('GET'), res)
    expect(cap.statusCode).toBe(200)
    expect(cap.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(cap.headers['cache-control']).toContain('max-age=')
    expect(Number(cap.headers['content-length'])).toBe(Buffer.byteLength(cap.body, 'utf-8'))
    expect(cap.body).toContain('<!DOCTYPE html>')
  })

  it('非 GET → 405（不读盘、不发 HTML）', async () => {
    const { ctx, registered } = fakeCtx()
    registerVoyageApi(ctx as never)
    const { res, cap } = fakeRes()
    await registered[0]!.handler(fakeReq('POST'), res)
    expect(cap.statusCode).toBe(405)
    expect(cap.headers['content-type']).toContain('application/json')
    expect(cap.body).toContain('method not allowed')
  })

  it('资产缺失 → 500 且错误可见（绝不静默发空页）', async () => {
    const { ctx, registered } = fakeCtx()
    registerVoyageApi(ctx as never, { assetPath: '/definitely/missing/voyage.html' })
    const { res, cap } = fakeRes()
    await registered[0]!.handler(fakeReq('GET'), res)
    expect(cap.statusCode).toBe(500)
    expect(cap.body).toContain('voyage asset unavailable')
  })
})
