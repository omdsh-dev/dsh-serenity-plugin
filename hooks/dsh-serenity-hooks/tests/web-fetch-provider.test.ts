/**
 * web-fetch-provider.test.ts — v1.30.12 web_fetch provider 接管（S142）
 *
 * 覆盖：
 *  ① 地址判据（allow fake-ip / public unicast；拒 loopback / link-local / RFC1918 / CGNAT /
 *     元数据 / 组播 / ULA / 仅本地 IPv6）
 *  ② resolver 语义：任一地址不合法 → 整体拒绝（防 DNS 重绑定，与宿主同口径）
 *  ③ 注册形态：ctx.web.registerFetchProvider 被调用且 provider id = http（接管宿主内置 id）
 *  ④ 降级：web 服务缺失 → 只告警不抛错（宿主 apply 抛错 = 整机启动失败）
 */

import { describe, expect, it, vi } from 'vitest'

// 🔴 域名分支的替身（⑤ 第 41 件）：`src/web-fetch-provider.ts` 从 `node:dns/promises` import `lookup`。
// 必须在 import 被测模块之前声明（vi.mock 提升），否则拿到的是真解析器 ⇒ 用例依赖外网。
// ⚠️ 这是**模块级** mock：本文件既有用例全走 IP 字面量（不触发 `lookup`），故不受影响。
const lookupMock = vi.hoisted(() => vi.fn())
vi.mock('node:dns/promises', () => ({ lookup: lookupMock }))

// 宿主 peer 包在测试环境不可解析（与现有测试 mock @deepseek-ai/dsh-tools 同因）——
// 这里替身只需满足本模块用到的三个导出形状。
vi.mock('@deepseek-ai/dsh-web-fetch-http', () => ({
  DEFAULT_USER_AGENT: 'test-agent',
  LOCAL_FETCH_PROVIDER_ID: 'http',
  HttpFetchProvider: class {
    id = 'http'
    constructor(
      public limits: unknown,
      public resolveAddresses: unknown,
    ) {}
    available(): boolean {
      return true
    }
  },
}))

import {
  isAllowedFetchAddress,
  isFakeIpV4,
  isPublicV4,
  isPublicV6,
  resolveAllowedAddresses,
} from '../src/web-fetch-provider.js'

describe('v1.30.12 web fetch 地址判据', () => {
  it('放行公网单播（IPv4/IPv6）', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '104.16.0.1', '2606:4700::1111']) {
      expect(isAllowedFetchAddress(ip), ip).toBe(true)
    }
  })

  it('放行 Clash fake-ip 段 198.18.0.0/15（本机实证段）', () => {
    for (const ip of ['198.18.0.1', '198.18.1.85', '198.19.255.254']) {
      expect(isFakeIpV4(ip), ip).toBe(true)
      expect(isAllowedFetchAddress(ip), ip).toBe(true)
    }
    // 段外不得误判
    expect(isFakeIpV4('198.20.0.1')).toBe(false)
    expect(isFakeIpV4('198.17.0.1')).toBe(false)
  })

  it('拒绝私网 / 回环 / 链路本地 / 元数据 / CGNAT / 组播 / 保留段', () => {
    const blocked = [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.1.4',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '192.0.0.170',
      '198.51.100.1',
      '203.0.113.1',
      '224.0.0.1',
      '255.255.255.255',
    ]
    for (const ip of blocked) {
      expect(isAllowedFetchAddress(ip), ip).toBe(false)
    }
  })

  it('IPv6：只放行全局单播 2000::/3；mapped 按内嵌 IPv4 判定', () => {
    expect(isPublicV6('2606:4700::1111')).toBe(true)
    expect(isPublicV6('::1')).toBe(false)
    expect(isPublicV6('fe80::1')).toBe(false)
    expect(isPublicV6('fc00::1')).toBe(false)
    expect(isPublicV6('ff02::1')).toBe(false)
    expect(isPublicV6('::ffff:1.1.1.1')).toBe(true)
    expect(isPublicV6('::ffff:192.168.1.4')).toBe(false)
    expect(isPublicV6('::ffff:198.18.1.85')).toBe(false) // mapped 只看内嵌 IPv4，不做 fake-ip 放行
  })

  it('非 IP 字面量一律拒绝', () => {
    expect(isAllowedFetchAddress('example.com')).toBe(false)
    expect(isAllowedFetchAddress('999.1.1.1')).toBe(false)
    expect(isPublicV4('1.2.3')).toBe(false)
  })

  it('resolver：公网 + fake-ip 通过（含 IPv6 字面量方括号）', async () => {
    await expect(resolveAllowedAddresses('1.1.1.1', new AbortController().signal)).resolves.toEqual([
      { address: '1.1.1.1', family: 4 },
    ])
    await expect(resolveAllowedAddresses('[2606:4700::1111]', new AbortController().signal)).resolves.toEqual([
      { address: '2606:4700::1111', family: 6 },
    ])
    await expect(resolveAllowedAddresses('198.18.1.85', new AbortController().signal)).resolves.toEqual([
      { address: '198.18.1.85', family: 4 },
    ])
  })

  it('resolver：任一地址不合法 → 整体拒绝（WEB_BLOCKED_URL）', async () => {
    await expect(resolveAllowedAddresses('192.168.1.4', new AbortController().signal)).rejects.toMatchObject({
      code: 'WEB_BLOCKED_URL',
    })
    await expect(resolveAllowedAddresses('127.0.0.1', new AbortController().signal)).rejects.toThrow(/non-public/)
  })
})

/**
 * 🔴 域名解析分支（`lookupAll`）—— ⑤ 第 41 件，S142 2026-09-25。
 *
 * **为何此前零执行**：本文件所有既有 resolver 用例都传 **IP 字面量**
 * （`1.1.1.1` / `[2606:4700::1111]` / `198.18.1.85` / `192.168.1.4` / `127.0.0.1`）
 * ⇒ `resolveAllowedAddresses` 里 `isIP(bare) !== 0` ⇒ **直接走 else，从不进 `lookupAll`**。
 * 这是本仓唯一**同时带 `fstat-no` 与 `cstat-no`** 的残余（其余残余只带 `fstat-no`）。
 *
 * **可达性（先取证再动手）**：`lookupAll` 由 `resolveAllowedAddresses` 在
 * 「非 IP 字面量」时无条件调用 —— 而这**正是生产里最常见的形态**（`web_fetch` 传的是域名，
 * 不是 IP）。⇒ 不是死代码、不是防御性 `??`，是**主路径**；此前只是没被测试走到。
 * **残余的性质** = 真 DNS 路径（挑靶四条里最值钱一档）。
 */
describe('v1.30.12 resolver 域名分支（lookupAll：本模块唯一带 cstat-no 的残余）', () => {
  it('域名 ⇒ 走 lookup；解析结果原样映射为 {address, family}', async () => {
    lookupMock.mockResolvedValueOnce([
      { address: '104.16.0.1', family: 4 },
      { address: '2606:4700::1111', family: 6 },
    ])
    await expect(resolveAllowedAddresses('example.com', new AbortController().signal)).resolves.toEqual([
      { address: '104.16.0.1', family: 4 },
      { address: '2606:4700::1111', family: 6 },
    ])
    // 取证「真调了谁」：非字面量的 hostname 才进 lookup，且不带方括号
    expect(lookupMock).toHaveBeenCalledWith('example.com', { all: true, order: 'verbatim' })
  })

  it('域名解析到私网 ⇒ 仍被拒（放宽的只是 fake-ip，不是全部私网）', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '192.168.1.4', family: 4 }])
    await expect(resolveAllowedAddresses('evil.example.com', new AbortController().signal)).rejects.toMatchObject({
      code: 'WEB_BLOCKED_URL',
    })
  })

  it('域名解析到 DNS 重绑定混合集（公网 + 私网）⇒ 整体拒绝，不放行任何一条', async () => {
    lookupMock.mockResolvedValueOnce([
      { address: '104.16.0.1', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ])
    await expect(resolveAllowedAddresses('rebind.example.com', new AbortController().signal)).rejects.toMatchObject({
      code: 'WEB_BLOCKED_URL',
    })
  })

  it('域名解析到 fake-ip 段 ⇒ 放行（本模块存在的理由）', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '198.18.1.85', family: 4 }])
    await expect(resolveAllowedAddresses('cdn.jsdelivr.net', new AbortController().signal)).resolves.toEqual([
      { address: '198.18.1.85', family: 4 },
    ])
  })

  it('解析结果为空 ⇒ 报 resolved to no addresses（不静默放行）', async () => {
    lookupMock.mockResolvedValueOnce([])
    await expect(resolveAllowedAddresses('nowhere.example.com', new AbortController().signal)).rejects.toThrow(
      /resolved to no addresses/,
    )
  })

  it('调用前已 abort ⇒ 立即 WEB_ABORTED，且不发起 DNS 查询', async () => {
    lookupMock.mockClear()
    const ctl = new AbortController()
    ctl.abort()
    await expect(resolveAllowedAddresses('example.com', ctl.signal)).rejects.toMatchObject({ code: 'WEB_ABORTED' })
    // 判据 = 「没查」而不是「查了不要」：前置 abort 必须短路，省一次 OS 查询
    expect(lookupMock).not.toHaveBeenCalled()
  })

  it('解析期间 abort ⇒ 竞速由 abort 分支胜出（WEB_ABORTED），未被 lookup 拖住', async () => {
    let release: ((v: Array<{ address: string; family: number }>) => void) | undefined
    lookupMock.mockImplementationOnce(
      () => new Promise<Array<{ address: string; family: number }>>((resolve) => { release = resolve }),
    )
    const ctl = new AbortController()
    const pending = resolveAllowedAddresses('slow.example.com', ctl.signal)
    ctl.abort()
    await expect(pending).rejects.toMatchObject({ code: 'WEB_ABORTED' })
    // 收尾：让未决的 lookup 落定，避免挂着的 promise 泄漏到下一条用例
    release?.([{ address: '104.16.0.1', family: 4 }])
  })

  it('abort 后 lookup 才失败 ⇒ 不产生 unhandled rejection（finally 里的吞异常）', async () => {
    let rejectLookup: ((e: Error) => void) | undefined
    lookupMock.mockImplementationOnce(
      () => new Promise<Array<{ address: string; family: number }>>((_res, rej) => { rejectLookup = rej }),
    )
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown): void => { unhandled.push(e) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const ctl = new AbortController()
      const pending = resolveAllowedAddresses('boom.example.com', ctl.signal)
      ctl.abort()
      await expect(pending).rejects.toMatchObject({ code: 'WEB_ABORTED' })
      // 🔴 本用例的靶 = `finally` 里那句 `lookupPromise.catch(() => undefined)`：
      //    abort 胜出后 lookup 才 reject，若无该句则成为 unhandled rejection（真实故障形态注入）。
      rejectLookup?.(new Error('ENOTFOUND boom.example.com'))
      await new Promise((r) => setTimeout(r, 20))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

describe('v1.30.12 provider 注册', () => {
  it('注册进 ctx.web，且沿用宿主内置 id=http（无需改宿主 web 配置）', async () => {
    const { registerWebFetchProvider } = await import('../src/web-fetch-provider.js')
    const registered: Array<{ id?: string; available?: () => boolean }> = []
    const ctx = {
      get: (name: string) =>
        name === 'web'
          ? { registerFetchProvider: (p: { id?: string }) => registered.push(p) }
          : undefined,
    }
    await registerWebFetchProvider(ctx as never)
    expect(registered).toHaveLength(1)
    expect(registered[0]?.id).toBe('http')
    expect(registered[0]?.available?.()).toBe(true)
  })

  it('web 服务缺失 → 只告警，不抛错', async () => {
    const { registerWebFetchProvider } = await import('../src/web-fetch-provider.js')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await expect(registerWebFetchProvider({ get: () => undefined } as never)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
