import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// gateway.ts 依赖 settings-section（peerDep schemastery/dsh-settings）——mock 保证 vitest 解析
vi.mock('@deepseek-ai/schemastery', () => {
  const chain: unknown = new Proxy(function () {}, {
    get: (_t, prop) => {
      if (prop === Symbol.toPrimitive) return () => ''
      if (prop === 'valueOf') return () => 0
      if (prop === 'toString') return () => ''
      return chain
    },
    apply: () => chain,
  })
  return {
    default: {
      object: (spec: unknown) => spec,
      array: () => chain,
      string: () => chain,
      boolean: () => chain,
      number: () => chain,
    },
  }
})
vi.mock('@deepseek-ai/dsh-settings', () => ({
  installSettingsSection: () => {},
  settingsNamespace: (v: string) => v,
}))

import { hashPassword } from '../src/config-ops.js'
import {
  loginPageHtml,
  verifyGatewayLogin,
  issueToken,
  validateToken,
  cookieValue,
  RANDOM_UUID_POLYFILL,
  injectPolyfillHtml,
  filterWorkspaceList,
  workspaceAllowed,
  workspaceDenyResponse,
  buildProxyHeaders,
} from '../src/gateway.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hooks-gateway-'))
  writeFileSync(join(dir, '.serenity'), 'test')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('F1: verifyGatewayLogin（账号验证）', () => {
  const accounts = [
    { user: 'yh', passHash: hashPassword('secret-1') },
    { user: 'danica', passHash: hashPassword('pw2') },
  ]

  it('正确账号密码 → true', () => {
    expect(verifyGatewayLogin(accounts, 'yh', 'secret-1')).toBe(true)
    expect(verifyGatewayLogin(accounts, 'danica', 'pw2')).toBe(true)
  })

  it('错误密码 → false', () => {
    expect(verifyGatewayLogin(accounts, 'yh', 'wrong')).toBe(false)
  })

  it('未知账号 → false', () => {
    expect(verifyGatewayLogin(accounts, 'nobody', 'x')).toBe(false)
  })

  it('空账号列表 → 全 false', () => {
    expect(verifyGatewayLogin([], 'yh', 'secret-1')).toBe(false)
  })
})

describe('F1: token（颁发/校验）', () => {
  it('颁发后有效', () => {
    const t = issueToken()
    expect(validateToken(t)).toBe(true)
  })

  it('未颁发/空/乱值 → 无效', () => {
    expect(validateToken(undefined)).toBe(false)
    expect(validateToken('')).toBe(false)
    expect(validateToken('not-issued')).toBe(false)
  })
})

describe('F1: cookieValue（Cookie 头解析）', () => {
  it('提取指定 cookie', () => {
    const header = 'serenity_session=abc123; other=x'
    expect(cookieValue(header, 'serenity_session')).toBe('abc123')
    expect(cookieValue(header, 'other')).toBe('x')
  })

  it('无 header/无匹配 → undefined', () => {
    expect(cookieValue(undefined, 'serenity_session')).toBeUndefined()
    expect(cookieValue('a=b', 'missing')).toBeUndefined()
  })
})

describe('F1: loginPageHtml（登录页）', () => {
  it('含表单 + 错误提示注入', () => {
    const html = loginPageHtml('用户名或密码错误')
    expect(html).toContain('<form')
    expect(html).toContain('action="/serenity/login"')
    expect(html).toContain('用户名或密码错误')
    expect(html).toContain('autocomplete="username"')
  })

  it('无错误时提示区为空', () => {
    const html = loginPageHtml('')
    expect(html).toContain('class="error"></div>')
  })

  it('v1.22.1 移动端适配：viewport + 安全区 + 触控尺寸 + iOS 字号', () => {
    const html = loginPageHtml('')
    // viewport meta（移动浏览器不按 980px 缩放）
    expect(html).toContain('name="viewport"')
    expect(html).toContain('width=device-width')
    expect(html).toContain('viewport-fit=cover')
    // 安全区（刘海屏/手势条）
    expect(html).toContain('env(safe-area-inset-')
    // 触控目标 ≥ 44px / min-height 50px
    expect(html).toContain('min-height:50px')
    // 输入字号 16px（iOS 聚焦不自动放大）
    expect(html).toContain('font-size:16px')
    // 明暗自适应
    expect(html).toContain('prefers-color-scheme')
    expect(html).toContain('color-scheme')
    // 移动输入优化
    expect(html).toContain('autocapitalize="none"')
    expect(html).toContain('enterkeyhint="go"')
    // 响应式卡片宽度
    expect(html).toContain('min(340px,calc(100vw - 48px))')
  })
})

describe('v1.22: crypto.randomUUID polyfill（非安全上下文修复）', () => {
  it('polyfill 含 getRandomValues 实现（DSH 官方同算法）', () => {
    expect(RANDOM_UUID_POLYFILL).toContain('crypto.randomUUID')
    expect(RANDOM_UUID_POLYFILL).toContain('crypto.getRandomValues')
    expect(RANDOM_UUID_POLYFILL).toContain('padStart')
    expect(RANDOM_UUID_POLYFILL).toContain('</script>')
  })

  it('注入 HTML：</head> 前插入 + 幂等', () => {
    const html = '<!doctype html><head><title>t</title></head><body>x</body></html>'
    const out = injectPolyfillHtml(html)
    expect(out).toContain('data-sp-randomuuid-polyfill')
    expect(out.indexOf('data-sp-randomuuid-polyfill')).toBeLessThan(out.indexOf('</head>'))
    expect(injectPolyfillHtml(out)).toBe(out) // 幂等
  })

  it('无 </head> → 前置注入', () => {
    const out = injectPolyfillHtml('<html><body>x</body></html>')
    expect(out.startsWith('<script')).toBe(true)
  })
})

describe('v1.22: workspace 白名单过滤', () => {
  const listBody = JSON.stringify({
    type: 'server-response',
    rpcId: 'r1',
    result: {
      ok: true,
      value: {
        items: [
          { workspaceId: 'w1', path: '/home/yh/home/home-serenity', title: 'serenity' },
          { workspaceId: 'w2', path: '/home/yh/other', title: 'other' },
          { workspaceId: 'w3', path: '/data/x', title: 'x' },
        ],
        archivedSessionIds: [],
      },
    },
  })

  it('白名单为空 → 原样透传', () => {
    expect(filterWorkspaceList(listBody, [])).toBe(listBody)
  })

  it('前缀匹配过滤 items（保留匹配路径）', () => {
    const out = JSON.parse(filterWorkspaceList(listBody, ['/home/yh/home'])) as {
      result: { value: { items: Array<{ path: string }> } }
    }
    expect(out.result.value.items.map((i) => i.path)).toEqual(['/home/yh/home/home-serenity'])
  })

  it('多前缀并集', () => {
    const out = JSON.parse(filterWorkspaceList(listBody, ['/home/yh/home', '/data'])) as {
      result: { value: { items: Array<{ path: string }> } }
    }
    expect(out.result.value.items.map((i) => i.path)).toEqual(['/home/yh/home/home-serenity', '/data/x'])
  })

  it('非 ok / 非 JSON → 原样透传', () => {
    const errBody = JSON.stringify({ type: 'server-response', rpcId: 'r', result: { ok: false, error: { code: 'x', message: 'm' } } })
    expect(filterWorkspaceList(errBody, ['/home'])).toBe(errBody)
    expect(filterWorkspaceList('not-json{', ['/home'])).toBe('not-json{')
  })
})

describe('v1.22: workspace.create 白名单校验', () => {
  it('白名单空 → 全部允许', () => {
    expect(workspaceAllowed([], '/any/path')).toBe(true)
    expect(workspaceAllowed([], undefined)).toBe(true)
  })

  it('前缀匹配 → 允许；不匹配 → 拒绝', () => {
    expect(workspaceAllowed(['/home/yh/home'], '/home/yh/home/home-serenity')).toBe(true)
    expect(workspaceAllowed(['/home/yh/home'], '/home/yh/other')).toBe(false)
    expect(workspaceAllowed(['/home/yh/home'], undefined)).toBe(false)
  })

  it('拒绝响应为合法 RPC error（code=forbidden）', () => {
    const out = JSON.parse(workspaceDenyResponse('r9')) as {
      type: string; rpcId: string; result: { ok: boolean; error: { code: string } }
    }
    expect(out.type).toBe('server-response')
    expect(out.rpcId).toBe('r9')
    expect(out.result.ok).toBe(false)
    expect(out.result.error.code).toBe('forbidden')
  })
})

describe('v1.22.1: 信任栅栏修复（Origin 与 Host 同源）', () => {
  it('反代头：Host + Origin 都改写为 loopback 主端口', () => {
    const headers = buildProxyHeaders(
      { host: '192.168.1.31:3081', origin: 'http://192.168.1.31:3081', cookie: 'a=b' },
      3080,
    )
    expect(headers.host).toBe('127.0.0.1:3080')
    expect(headers.origin).toBe('http://127.0.0.1:3080')
    expect(headers.cookie).toBe('a=b') // 其余头保留
  })

  it('bodyOverride → content-length 更新', () => {
    const headers = buildProxyHeaders({ host: 'x:3081' }, 3080, '{"rpcId":"r1"}')
    expect(headers['content-length']).toBe(Buffer.byteLength('{"rpcId":"r1"}'))
  })

  it('信任栅栏等价性：Origin.host === Host（DSH isTrustedApiRequest 判定条件）', () => {
    const headers = buildProxyHeaders({ host: '192.168.1.31:3081', origin: 'http://192.168.1.31:3081' }, 3080)
    const originHost = new URL(String(headers.origin)).host
    const hostValue = String(headers.host)
    expect(originHost).toBe(hostValue) // 修复前 origin=192.168.1.31:3081 ≠ 127.0.0.1:3080 → 403
  })
})
