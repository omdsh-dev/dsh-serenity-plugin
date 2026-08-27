import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
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
  revokeToken,
  cookieValue,
  RANDOM_UUID_POLYFILL,
  injectPolyfillHtml,
  filterWorkspaceList,
  workspaceAllowed,
  workspaceDenyResponse,
  buildProxyHeaders,
  resetFailState,
  recordLoginFailure,
  accountLockRemaining,
  isAccountLocked,
  FAIL_LOCK_THRESHOLD,
  FAIL_LOCK_BASE_MS,
  newCsrfToken,
  isCsrfValid,
  csrfFromRequest,
  safeEqual,
  originAllowed,
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

describe('F1: token（颁发/校验/登出，v1.22.4 会话化）', () => {
  it('颁发后有效（返回会话含 user）', () => {
    const t = issueToken('yh')
    const s = validateToken(t)
    expect(s).toBeDefined()
    expect(s?.user).toBe('yh')
  })

  it('未颁发/空/乱值 → undefined', () => {
    expect(validateToken(undefined)).toBeUndefined()
    expect(validateToken('')).toBeUndefined()
    expect(validateToken('not-issued')).toBeUndefined()
  })

  it('revokeToken：吊销后无效', () => {
    const t = issueToken('yh')
    expect(validateToken(t)).toBeDefined()
    expect(revokeToken(t)).toBe(true)
    expect(validateToken(t)).toBeUndefined()
    expect(revokeToken(t)).toBe(false)
  })

  it('滑动过期：超过 TTL 后失效（fake time）', () => {
    const realNow = Date.now
    try {
      let now = 1_000_000
      Date.now = () => now
      const t = issueToken('yh')
      expect(validateToken(t)).toBeDefined()
      // 跳到 25h 后（无中间校验 → lastActiveAt 未被续期）
      now += 25 * 60 * 60 * 1000
      expect(validateToken(t)).toBeUndefined()
    } finally {
      Date.now = realNow
    }
  })

  it('滑动续期：TTL 内活动刷新过期点（fake time）', () => {
    const realNow = Date.now
    try {
      let now = 1_000_000
      Date.now = () => now
      const t = issueToken('yh')
      // 连续活动（每次间隔 <24h）→ 永不自然过期
      for (let i = 0; i < 3; i++) {
        now += 23 * 60 * 60 * 1000
        expect(validateToken(t)).toBeDefined()
      }
      // 最后一次活动后 25h 无活动 → 过期
      now += 25 * 60 * 60 * 1000
      expect(validateToken(t)).toBeUndefined()
    } finally {
      Date.now = realNow
    }
  })
})

describe('v1.22.4: 失败锁定（账号维度，不按 IP）', () => {
  it('连续失败达到阈值 → 锁定；剩余毫秒 > 0', () => {
    resetFailState('attacker')
    for (let i = 0; i < FAIL_LOCK_THRESHOLD; i++) {
      recordLoginFailure('attacker')
    }
    const remaining = accountLockRemaining('attacker')
    expect(remaining).toBeGreaterThan(0)
    expect(isAccountLocked('attacker')).toBe(true)
  })

  it('锁定到期自动解锁（fake time）', () => {
    const realNow = Date.now
    try {
      let now = 1_000_000
      Date.now = () => now
      resetFailState('u2')
      for (let i = 0; i < FAIL_LOCK_THRESHOLD; i++) recordLoginFailure('u2')
      expect(isAccountLocked('u2')).toBe(true)
      now += FAIL_LOCK_BASE_MS + 1000
      expect(isAccountLocked('u2')).toBe(false)
    } finally {
      Date.now = realNow
    }
  })

  it('成功登录（resetFailState）→ 解锁', () => {
    resetFailState('u3')
    for (let i = 0; i < FAIL_LOCK_THRESHOLD; i++) recordLoginFailure('u3')
    expect(isAccountLocked('u3')).toBe(true)
    resetFailState('u3')
    expect(isAccountLocked('u3')).toBe(false)
  })

  it('锁定指数退避：第二次锁定更长', () => {
    const realNow = Date.now
    try {
      let now = 1_000_000
      Date.now = () => now
      resetFailState('u4')
      for (let i = 0; i < FAIL_LOCK_THRESHOLD; i++) recordLoginFailure('u4')
      const first = accountLockRemaining('u4')
      now += FAIL_LOCK_BASE_MS + 1000 // 解锁
      isAccountLocked('u4') // 触发到期解锁
      for (let i = 0; i < FAIL_LOCK_THRESHOLD; i++) recordLoginFailure('u4')
      const second = accountLockRemaining('u4')
      expect(second).toBeGreaterThan(first)
    } finally {
      Date.now = realNow
    }
  })
})

describe('v1.22.4: CSRF（双提交 + Origin）', () => {
  it('newCsrfToken：随机且不同', () => {
    expect(newCsrfToken()).not.toBe(newCsrfToken())
    expect(newCsrfToken().length).toBe(64)
  })

  it('v1.24.9 isCsrfValid：生成即有效；未知 token 无效；多标签各自 token 都有效（集合语义）', () => {
    const a = newCsrfToken()
    const b = newCsrfToken()
    expect(isCsrfValid(a)).toBe(true)
    expect(isCsrfValid(b)).toBe(true)
    expect(isCsrfValid('deadbeef'.repeat(8))).toBe(false)
    expect(isCsrfValid('')).toBe(false)
  })

  it('safeEqual：常量时间比较', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
  })

  it('originAllowed：同源 / 主端口 loopback 允许；跨源拒绝', () => {
    expect(originAllowed('http://192.168.1.31:3081', '192.168.1.31:3081', 3080)).toBe(true)
    expect(originAllowed('http://127.0.0.1:3080', '192.168.1.31:3081', 3080)).toBe(true)
    expect(originAllowed('http://localhost:3080', '192.168.1.31:3081', 3080)).toBe(true)
    expect(originAllowed('http://evil.example.com', '192.168.1.31:3081', 3080)).toBe(false)
    expect(originAllowed('not-a-url', '192.168.1.31:3081', 3080)).toBe(false)
    // 无 Origin（curl/非浏览器）→ 放行（CSRF cookie 兜底）
    expect(originAllowed(undefined, '192.168.1.31:3081', 3080)).toBe(true)
  })

  it('csrfFromRequest：头优先，表单兜底', () => {
    const body = new URLSearchParams('csrf=formtoken&user=x')
    const req = { headers: {} } as never
    expect(csrfFromRequest(req, body)).toBe('formtoken')
    const req2 = { headers: { 'x-csrf-token': 'headertoken' } } as never
    expect(csrfFromRequest(req2, body)).toBe('headertoken')
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

  it('v1.22.4：CSRF 隐藏字段 + TOTP 输入框（传 csrf 时）', () => {
    const html = loginPageHtml('', 'csrf-abc')
    expect(html).toContain('name="csrf" value="csrf-abc"')
    expect(html).toContain('name="code"')
    expect(html).toContain('inputmode="numeric"')
    expect(html).toContain('maxlength="6"')
  })

  it('v1.22.4：不传 csrf 时无隐藏字段（兼容）', () => {
    expect(loginPageHtml('')).not.toContain('name="csrf"')
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

describe('v1.22.3: 外部连接中断崩溃修复（S142 实测：Unhandled ECONNRESET → 进程崩溃）', () => {
  // 回归防护：gateway 反代链路的客户端侧 req/res/socket 必须挂 'error' 监听。
  // Node 对无监听器的 'error' 事件直接 throw（node:events:497）→ 整个 dsh web 进程崩溃。
  // 验证方式：源文件必须包含这些监听注册（防止未来重构删除）。
  it('proxy 链路：客户端 req/res 挂 error 监听 + 透传 upstream 挂 error', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'gateway.ts'), 'utf-8')
    const proxyBody = src.split("const proxy = ")[1] ?? ''
    // req error → 销毁 target
    expect(proxyBody).toMatch(/req\.on\('error'/)
    // res error → 销毁 target
    expect(proxyBody).toMatch(/res\.on\('error'/)
    // 透传路径 upstream error → 销毁 res（HTML/workspace.list 分支原本就有）
    expect(src).toMatch(/upstream\.on\('error'/)
  })

  it('WS upgrade 链路：客户端 socket 与上游 usocket 都挂 error 监听', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'gateway.ts'), 'utf-8')
    const upgradeBody = src.split("server.on('upgrade'")[1] ?? ''
    // 客户端 socket error → 销毁上游
    expect(upgradeBody).toMatch(/socket\.on\('error'/)
    // 上游 usock error → 销毁客户端 socket
    expect(upgradeBody).toMatch(/usock\.on\('error'/)
  })

  it('登录 POST 分支 req/res 挂 error 监听', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'gateway.ts'), 'utf-8')
    const loginBody = src.split("'/serenity/login'")[1] ?? ''
    expect(loginBody).toMatch(/req\.on\('error'/)
    expect(loginBody).toMatch(/res\.on\('error'/)
  })

  it('server 级 clientError 兜底监听存在', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'gateway.ts'), 'utf-8')
    expect(src).toMatch(/server\.on\('clientError'/)
  })
})
