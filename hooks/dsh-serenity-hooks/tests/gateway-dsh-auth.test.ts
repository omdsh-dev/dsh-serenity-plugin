/**
 * gateway-dsh-auth.test.ts — 3081 网关对 DSH 主端口 BrowserAuth 的适配（v1.28.2）
 * 覆盖：pickDshCookie 提取 / exchangeDshCookie 官方通道换取 / createDshCookieProvider 缓存语义。
 */
import { describe, it, expect } from 'vitest'
import {
  pickDshCookie,
  mergeCookieHeader,
  exchangeDshCookie,
  createDshCookieProvider,
  type DshConnectionLike,
} from '../src/gateway-dsh-auth.js'

/** 构造一个伪 connection（模拟官方 HostConnectionHandle 的 token 交换） */
function fakeConnection(opts: { token?: string; cookie?: string | string[]; fail?: boolean } = {}): DshConnectionLike {
  const token = opts.token ?? 'launch-token-abc'
  return {
    authenticatedUrl: (baseUrl: string) => `${baseUrl}/?token=${token}`,
    authorizeIndex: (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      if (opts.fail) return false // 认证失败（无 set-cookie）
      // 模拟 token 匹配 → 写 set-cookie（303）
      if (url.searchParams.get('token') === token) {
        const cookie = opts.cookie ?? 'dsh-auth-test=v1.body.sig; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict'
        ;(res as { writeHead: (s: number, h: Record<string, unknown>) => void }).writeHead(303, {
          'set-cookie': cookie,
          location: '/',
        })
        return false
      }
      return false
    },
  }
}

describe('pickDshCookie：从 set-cookie 提取 dsh-auth-* cookie', () => {
  it('提取 dsh-auth- 前缀 cookie（含属性）', () => {
    const header = 'dsh-auth-abcd=v1.x.y; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict'
    expect(pickDshCookie(header)).toBe('dsh-auth-abcd=v1.x.y')
  })

  it('多 cookie（数组）→ 提取 dsh-auth 那个', () => {
    const headers = ['serenity_csrf=abc; Path=/', 'dsh-auth-xyz=v1.a.b; Max-Age=100']
    expect(pickDshCookie(headers)).toBe('dsh-auth-xyz=v1.a.b')
  })

  it('无 dsh-auth → undefined', () => {
    expect(pickDshCookie('serenity_csrf=abc; Path=/')).toBeUndefined()
    expect(pickDshCookie(undefined)).toBeUndefined()
    expect(pickDshCookie([])).toBeUndefined()
  })

  it('dsh-auth- 前缀但无 = → undefined（非 cookie）', () => {
    expect(pickDshCookie('dsh-auth-justname')).toBeUndefined()
  })
})

describe('exchangeDshCookie：经 connection 官方通道内存换取（token → cookie）', () => {
  it('token 匹配 → 返回 dsh cookie（authority 绑定，零落盘）', () => {
    const connection = fakeConnection()
    const cookie = exchangeDshCookie(connection, '127.0.0.1:3080')
    expect(cookie).toBe('dsh-auth-test=v1.body.sig')
  })

  it('authority 自定义 → 传给 authenticatedUrl + 请求 host（cookie 绑定外部 authority）', () => {
    const seen: { baseUrl?: string; host?: string } = {}
    const connection: DshConnectionLike = {
      authenticatedUrl: (baseUrl: string) => {
        seen.baseUrl = baseUrl
        return `${baseUrl}/?token=tok`
      },
      authorizeIndex: (req, res) => {
        seen.host = (req.headers as Record<string, string>).host
        ;(res as { writeHead: (s: number, h: Record<string, unknown>) => void }).writeHead(303, {
          'set-cookie': 'dsh-auth-c=v1.c.d',
        })
        return false
      },
    }
    const cookie = exchangeDshCookie(connection, '192.168.1.31:3081')
    expect(cookie).toBe('dsh-auth-c=v1.c.d')
    expect(seen.baseUrl).toBe('http://192.168.1.31:3081')
    expect(seen.host).toBe('192.168.1.31:3081')
  })

  it('token 不匹配/无 token → undefined', () => {
    const connection = fakeConnection({ token: 'real-token' })
    // authenticatedUrl 给错 token → authorizeIndex 不写 cookie
    const bad: DshConnectionLike = {
      authenticatedUrl: () => 'http://x/?token=wrong',
      authorizeIndex: () => false,
    }
    expect(exchangeDshCookie(bad, '127.0.0.1:3080')).toBeUndefined()
    expect(exchangeDshCookie(connection, '127.0.0.1:3080')).toBe('dsh-auth-test=v1.body.sig')
  })

  it('authorizeIndex 抛错 / 无 URL → undefined（不崩）', () => {
    const broken: DshConnectionLike = {
      authenticatedUrl: () => { throw new Error('boom') },
      authorizeIndex: () => false,
    }
    expect(exchangeDshCookie(broken, '127.0.0.1:3080')).toBeUndefined()
    const noToken: DshConnectionLike = {
      authenticatedUrl: () => 'http://x/none',
      authorizeIndex: () => false,
    }
    expect(exchangeDshCookie(noToken, '127.0.0.1:3080')).toBeUndefined()
  })
})

describe('mergeCookieHeader：dsh cookie 合并进现有 Cookie 头（保持外部会话）', () => {
  it('无现有 cookie → 只返回 dsh cookie', () => {
    expect(mergeCookieHeader(undefined, 'dsh-auth-a=v1')).toBe('dsh-auth-a=v1')
    expect(mergeCookieHeader('', 'dsh-auth-a=v1')).toBe('dsh-auth-a=v1')
  })

  it('有现有 cookie（string）→ 追加 dsh cookie', () => {
    expect(mergeCookieHeader('serenity_session=tok', 'dsh-auth-a=v1')).toBe('serenity_session=tok; dsh-auth-a=v1')
  })

  it('现有 cookie 为数组（node 头形态）→ join 后追加', () => {
    expect(mergeCookieHeader(['a=1', 'b=2'], 'dsh-auth-a=v1')).toBe('a=1; b=2; dsh-auth-a=v1')
  })
})

describe('createDshCookieProvider：内存缓存提供者（拍板：不落盘）', () => {
  it('首次调用换取 → 缓存 → 后续直接返回（不重复换取）', () => {
    let exchanges = 0
    const connection: DshConnectionLike = {
      authenticatedUrl: (b: string) => `${b}/?token=t`,
      authorizeIndex: (_req, res) => {
        exchanges++
        ;(res as { writeHead: (s: number, h: Record<string, unknown>) => void }).writeHead(303, {
          'set-cookie': 'dsh-auth-mem=v1.x',
        })
        return false
      },
    }
    const provider = createDshCookieProvider(connection, '127.0.0.1:3080')
    expect(provider()).toBe('dsh-auth-mem=v1.x')
    expect(provider()).toBe('dsh-auth-mem=v1.x')
    expect(provider()).toBe('dsh-auth-mem=v1.x')
    expect(exchanges).toBe(1) // 只换一次（缓存）
  })

  it('connection undefined → 恒 undefined（旧 dsh/非 web 装配兼容）', () => {
    const provider = createDshCookieProvider(undefined, '127.0.0.1:3080')
    expect(provider()).toBeUndefined()
    expect(provider()).toBeUndefined()
  })

  it('换取失败 → undefined 且不缓存（下次重试）', () => {
    let fail = true
    let attempts = 0
    const connection: DshConnectionLike = {
      authenticatedUrl: (b: string) => `${b}/?token=t`,
      authorizeIndex: (_req, res) => {
        attempts++
        if (fail) return false // 无 set-cookie
        ;(res as { writeHead: (s: number, h: Record<string, unknown>) => void }).writeHead(303, {
          'set-cookie': 'dsh-auth-retry=v1',
        })
        return false
      },
    }
    const provider = createDshCookieProvider(connection, '127.0.0.1:3080')
    expect(provider()).toBeUndefined()
    expect(attempts).toBe(1)
    fail = false // 服务恢复 → 下次调用重试成功并缓存
    expect(provider()).toBe('dsh-auth-retry=v1')
    expect(provider()).toBe('dsh-auth-retry=v1')
    expect(attempts).toBe(2) // 第二次成功换取后缓存，不再尝试
  })
})
