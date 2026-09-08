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
