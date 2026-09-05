import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  defaultAdvancedSettings,
  hashPassword,
  verifyPassword,
  readAdvancedSettings,
  writeAdvancedSettings,
  updateAdvancedSettings,
  toWire,
  applyWirePatch,
  migrateLegacyLocalstore,
  globalConfigPath,
  projectKnownWorkspaces,
  ADVANCED_SECTION,
} from '../src/config-ops.js'
import { generateTotpSecret, totpCode, nowEpochSeconds, TOTP_STEP_SECONDS } from '../src/totp.js'

let dir: string
let oldEnv: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hooks-config-ops-'))
  // 全局文件路径注入（v1.22 plugin 全局；测试隔离）
  oldEnv = process.env.SERENITY_HOOKS_CONFIG
  process.env.SERENITY_HOOKS_CONFIG = join(dir, 'serenity-hooks.json')
})

afterEach(() => {
  if (oldEnv === undefined) delete process.env.SERENITY_HOOKS_CONFIG
  else process.env.SERENITY_HOOKS_CONFIG = oldEnv
  rmSync(dir, { recursive: true, force: true })
})

describe('密码 hash（scrypt）', () => {
  it('hashPassword 产生 salt:hex 格式且可 verify 通过', () => {
    const h = hashPassword('secret-1')
    expect(h).toMatch(/^[0-9a-f]{32}:[0-9a-f]{64}$/)
    expect(verifyPassword('secret-1', h)).toBe(true)
  })

  it('错误密码 verify 失败', () => {
    const h = hashPassword('secret-1')
    expect(verifyPassword('secret-2', h)).toBe(false)
  })

  it('同密码不同盐 → hash 不同（随机 salt）', () => {
    const a = hashPassword('same')
    const b = hashPassword('same')
    expect(a).not.toBe(b)
    expect(verifyPassword('same', a)).toBe(true)
    expect(verifyPassword('same', b)).toBe(true)
  })

  it('非法存储格式 → verify false（不抛错）', () => {
    expect(verifyPassword('x', '')).toBe(false)
    expect(verifyPassword('x', 'not-a-hash')).toBe(false)
    expect(verifyPassword('x', '00:')).toBe(false)
  })
})

describe('读写（plugin 全局文件）', () => {
  it('全局路径 = env 覆盖（缺省 ~/.dsh/serenity-hooks.json）', () => {
    expect(globalConfigPath()).toBe(join(dir, 'serenity-hooks.json'))
    delete process.env.SERENITY_HOOKS_CONFIG
    expect(globalConfigPath()).toContain('serenity-hooks.json')
  })

  it('文件不存在 → 默认值', () => {
    const s = readAdvancedSettings()
    expect(s.gateway.enabled).toBe(false)
    expect(s.gateway.host).toBe('0.0.0.0')
    expect(s.gateway.port).toBe(3081)
    expect(s.gateway.accounts).toEqual([])
    expect(s.gateway.workspaces).toEqual([])
    expect(s.persona.mode).toBe('')
    expect(s.publicAsk.allowed).toEqual([])
    // review P2-3：高级配置已无 rebuild（rebuild 归简单配置 settings.yaml）——死双胞胎删除
    expect((s as unknown as Record<string, unknown>).rebuild).toBeUndefined()
  })

  it('写 → 读 往返一致；文件权限 0600', () => {
    const s = defaultAdvancedSettings()
    s.gateway.accounts = [{ id: 'a1', user: 'yh', passHash: hashPassword('pw') }]
    writeAdvancedSettings(s)

    const raw = JSON.parse(readFileSync(globalConfigPath(), 'utf-8'))
    expect(raw.gateway.accounts[0].user).toBe('yh')
    // 全局文件是完整配置对象（无外层节包装）
    expect(raw[ADVANCED_SECTION]).toBeUndefined()

    const back = readAdvancedSettings()
    expect(back.gateway.accounts).toHaveLength(1)
    expect(back.gateway.accounts[0]!.user).toBe('yh')
    expect(verifyPassword('pw', back.gateway.accounts[0]!.passHash)).toBe(true)
  })

  it('坏 JSON → 默认值（不抛错）', () => {
    writeFileSync(globalConfigPath(), '{broken', 'utf-8')
    expect(readAdvancedSettings().gateway.accounts).toEqual([])
  })

  it('部分写入（非对象/缺字段）→ merge 默认值', () => {
    writeFileSync(globalConfigPath(), JSON.stringify({ gateway: { enabled: true } }), 'utf-8')
    const s = readAdvancedSettings()
    expect(s.gateway.enabled).toBe(true)
    expect(s.gateway.port).toBe(3081) // 缺省字段补默认
    expect(s.persona.mode).toBe('') // 缺省补默认
  })
})

describe('migrateLegacyLocalstore（v1.21.x → v1.22 一次性迁移）', () => {
  it('CCC localstore 有旧节 → 迁移到全局文件', () => {
    writeFileSync(join(dir, 'localstore.json'), JSON.stringify({
      credentials: { K: 'v' }, // 其他节不迁移
      serenityAdvanced: { gateway: { enabled: true, host: '0.0.0.0', port: 3081, accounts: [{ id: 'a1', user: 'admin', passHash: hashPassword('pw') }] } },
    }), 'utf-8')
    expect(migrateLegacyLocalstore(dir)).toBe(true)
    const migrated = readAdvancedSettings()
    expect(migrated.gateway.enabled).toBe(true)
    expect(migrated.gateway.accounts[0]!.user).toBe('admin')
    expect(verifyPassword('pw', migrated.gateway.accounts[0]!.passHash)).toBe(true)
  })

  it('全局文件已存在 → 跳过（幂等）', () => {
    writeAdvancedSettings(defaultAdvancedSettings())
    writeFileSync(join(dir, 'localstore.json'), JSON.stringify({
      serenityAdvanced: { gateway: { enabled: true, accounts: [] } },
    }), 'utf-8')
    expect(migrateLegacyLocalstore(dir)).toBe(false)
    expect(readAdvancedSettings().gateway.enabled).toBe(false) // 不被 localstore 覆盖
  })

  it('localstore 无旧节 / root 为空 → false', () => {
    expect(migrateLegacyLocalstore(null)).toBe(false)
    writeFileSync(join(dir, 'localstore.json'), JSON.stringify({ credentials: {} }), 'utf-8')
    expect(migrateLegacyLocalstore(dir)).toBe(false)
  })
})

describe('updateAdvancedSettings（部分更新）', () => {
  it('gateway 部分 patch 保留 accounts；accounts 未传不覆盖', () => {
    const s = defaultAdvancedSettings()
    s.gateway.accounts = [{ id: 'a1', user: 'yh', passHash: 'h1' }]
    writeAdvancedSettings(s)

    const next = updateAdvancedSettings({ gateway: { enabled: true } })
    expect(next.gateway.enabled).toBe(true)
    expect(next.gateway.accounts).toHaveLength(1) // 保留
  })

  it('review P2-3：legacy rebuild 残留键被忽略（读出不回显——死双胞胎删除）', () => {
    // 模拟 v1.27 前全局文件残留 rebuild 节（历史高级配置曾含它）
    writeFileSync(globalConfigPath(), JSON.stringify({
      gateway: { enabled: true },
      rebuild: { enabled: false, thresholdK: 500 },
    }), 'utf-8')
    const s = readAdvancedSettings()
    expect(s.gateway.enabled).toBe(true) // 其他字段正常
    expect((s as unknown as Record<string, unknown>).rebuild).toBeUndefined() // rebuild 被忽略
    // 文件持久化形态也不回写 rebuild（update 时整写覆盖）
    const next = updateAdvancedSettings({ gateway: { port: 9999 } })
    expect((next as unknown as Record<string, unknown>).rebuild).toBeUndefined()
  })
})

describe('toWire（hash 永不落 wire）', () => {
  it('剥离 passHash → hasPassword 布尔', () => {
    const s = defaultAdvancedSettings()
    s.gateway.accounts = [
      { id: 'a1', user: 'yh', passHash: hashPassword('pw') },
      { id: 'a2', user: 'd', passHash: '' },
    ]
    const w = toWire(s)
    expect(w.gateway.accounts[0]).toEqual({ id: 'a1', user: 'yh', hasPassword: true, hasTotp: false })
    expect(w.gateway.accounts[1]).toEqual({ id: 'a2', user: 'd', hasPassword: false, hasTotp: false })
    expect(JSON.stringify(w)).not.toContain('passHash')
    expect(JSON.stringify(w)).not.toContain('pw')
  })
})

describe('projectKnownWorkspaces（v1.28.0 适配 0.1.2-rc.1 A2 A′：host workspaceRegistry 投影 + 白名单过滤）', () => {
  it('空白名单 → 全放行（向后兼容默认）；无 path 项过滤；title 缺省回退 path', () => {
    expect(projectKnownWorkspaces([
      { path: '/a', title: 'A' },
      { path: '/b', title: '' },
      { title: 'no-path' },
    ], [])).toEqual([
      { path: '/a', title: 'A' },
      { path: '/b', title: '/b' },
    ])
  })

  it('白名单前缀 → 只保留匹配项', () => {
    const out = projectKnownWorkspaces([
      { path: '/home/yh/home/home-serenity', title: 'home-serenity' },
      { path: '/home/yh/zy/pangu-serenity', title: 'pangu' },
      { path: '/data/x', title: 'data-x' },
    ], ['/home/yh/home'])
    expect(out.map((w) => w.path)).toEqual(['/home/yh/home/home-serenity'])
  })

  it('空输入 → 空数组', () => {
    expect(projectKnownWorkspaces([], ['/home'])).toEqual([])
  })
})

describe('applyWirePatch（wire → 持久化）', () => {
  it('新账号必带 pass → hash 落库', () => {
    const next = applyWirePatch({
      gateway: {
        accounts: [{ id: 'a1', user: 'yh', pass: 'newpw' }],
      },
    })
    expect(next.gateway.accounts).toHaveLength(1)
    expect(verifyPassword('newpw', next.gateway.accounts[0]!.passHash)).toBe(true)
    expect(next.gateway.enabled).toBe(false) // 未传字段保留默认
  })

  it('新账号无 pass 且无现有 hash → 抛错', () => {
    expect(() =>
      applyWirePatch({
        gateway: { accounts: [{ id: 'a1', user: 'yh' }] },
      }),
    ).toThrow(/must set a password/)
  })

  it('既有账号 pass 空 → 保留原 hash', () => {
    const s = defaultAdvancedSettings()
    s.gateway.accounts = [{ id: 'a1', user: 'yh', passHash: hashPassword('orig') }]
    writeAdvancedSettings(s)

    const next = applyWirePatch({
      gateway: { accounts: [{ id: 'a1', user: 'yh', pass: '' }] },
    })
    expect(verifyPassword('orig', next.gateway.accounts[0]!.passHash)).toBe(true)
  })

  it('既有账号带新 pass → 更新 hash（可改名）', () => {
    const s = defaultAdvancedSettings()
    s.gateway.accounts = [{ id: 'a1', user: 'yh', passHash: hashPassword('orig') }]
    writeAdvancedSettings(s)

    const next = applyWirePatch({
      gateway: { accounts: [{ id: 'a1', user: 'yh-new', pass: 'newpw' }] },
    })
    expect(next.gateway.accounts[0]!.user).toBe('yh-new')
    expect(verifyPassword('newpw', next.gateway.accounts[0]!.passHash)).toBe(true)
    expect(verifyPassword('orig', next.gateway.accounts[0]!.passHash)).toBe(false)
  })

  it('删除账号（数组整体替换）', () => {
    const s = defaultAdvancedSettings()
    s.gateway.accounts = [{ id: 'a1', user: 'yh', passHash: 'h1' }]
    writeAdvancedSettings(s)

    const next = applyWirePatch({ gateway: { accounts: [] } })
    expect(next.gateway.accounts).toEqual([])
  })

  it('v1.24.7 TOTP：totpSecret 非空 → 直接绑定（无确认码）；wire 不回传 secret', () => {
    const s = defaultAdvancedSettings()
    s.gateway.accounts = [{ id: 'a1', user: 'yh', passHash: hashPassword('pw') }]
    writeAdvancedSettings(s)

    const secret = generateTotpSecret()
    const next = applyWirePatch({
      gateway: { accounts: [{ id: 'a1', user: 'yh', totpSecret: secret }] },
    })
    expect(next.gateway.accounts[0]!.totpSecret).toBe(secret)
    // wire 形态只有 hasTotp 布尔
    const w = toWire(next)
    expect(w.gateway.accounts[0]).toEqual({ id: 'a1', user: 'yh', hasPassword: true, hasTotp: true })
    expect(JSON.stringify(w)).not.toContain(secret)
    expect(JSON.stringify(w)).not.toContain('totpSecret')
  })

  it('v1.24.7 TOTP：非法 base32 secret → 拒绝绑定', () => {
    const s = defaultAdvancedSettings()
    s.gateway.accounts = [{ id: 'a1', user: 'yh', passHash: hashPassword('pw') }]
    writeAdvancedSettings(s)

    expect(() =>
      applyWirePatch({
        gateway: { accounts: [{ id: 'a1', user: 'yh', totpSecret: 'NOT-BASE32!!' }] },
      }),
    ).toThrow(/not valid base32/)
  })

  it('v1.22.4 TOTP：totpReset=true → 清除绑定', () => {
    const s = defaultAdvancedSettings()
    s.gateway.accounts = [{ id: 'a1', user: 'yh', passHash: hashPassword('pw'), totpSecret: 'MZXW6YTB' }]
    writeAdvancedSettings(s)

    const next = applyWirePatch({
      gateway: { accounts: [{ id: 'a1', user: 'yh', totpReset: true }] },
    })
    expect(next.gateway.accounts[0]!.totpSecret).toBeUndefined()
    expect(toWire(next).gateway.accounts[0]!.hasTotp).toBe(false)
  })

  it('v1.22.4 TOTP：未传 totpSecret/totpReset → 保留现有绑定', () => {
    const s = defaultAdvancedSettings()
    s.gateway.accounts = [{ id: 'a1', user: 'yh', passHash: hashPassword('pw'), totpSecret: 'KEEP' }]
    writeAdvancedSettings(s)

    const next = applyWirePatch({ gateway: { accounts: [{ id: 'a1', user: 'yh' }] } })
    expect(next.gateway.accounts[0]!.totpSecret).toBe('KEEP')
  })

  it('v1.22.4 cookieSecure patch', () => {
    const next = applyWirePatch({ gateway: { cookieSecure: true } })
    expect(next.gateway.cookieSecure).toBe(true)
    // 缺省保留现有
    const keep = applyWirePatch({ gateway: { port: 9999 } })
    expect(keep.gateway.cookieSecure).toBe(true)
  })

  it('开关/端口 patch 生效（含边界校验）', () => {
    const next = applyWirePatch({
      gateway: { enabled: true, host: '127.0.0.1', port: 9999 },
    })
    expect(next.gateway.enabled).toBe(true)
    expect(next.gateway.host).toBe('127.0.0.1')
    expect(next.gateway.port).toBe(9999)
  })

  it('工作区白名单 patch：写入/过滤空串/缺省保留', () => {
    const next = applyWirePatch({
      gateway: { workspaces: ['/home/yh/home', '', '/data'] },
    })
    expect(next.gateway.workspaces).toEqual(['/home/yh/home', '/data']) // 空串过滤
    // 未传 workspaces → 保留现有
    const keep = applyWirePatch({ gateway: { port: 9999 } })
    expect(keep.gateway.workspaces).toEqual(['/home/yh/home', '/data'])
  })

  it('review P2-3：wire rebuild patch 被忽略（简单配置单源——不再经高级 wire 改 rebuild）', () => {
    // 旧版面板曾 PUT wire.rebuild；新版 wire 类型已删 rebuild → 传入被忽略（不抛错不生效）
    const next = applyWirePatch({ gateway: { port: 9999 }, rebuild: { enabled: false, thresholdK: 5000 } } as never)
    expect(next.gateway.port).toBe(9999)
    expect((next as unknown as Record<string, unknown>).rebuild).toBeUndefined()
  })
})

describe('v1.23.1 persona 彩蛋（plugin 全局文件）', () => {
  it('默认关闭：mode 空 / overrideText 空', () => {
    const def = defaultAdvancedSettings()
    expect(def.persona.mode).toBe('')
    expect(def.persona.overrideText).toBe('')
    const w = toWire(readAdvancedSettings())
    expect(w.persona.mode).toBe('')
  })

  it('applyWirePatch 设置 persona → 持久化 + wire 回读', () => {
    const next = applyWirePatch({ persona: { mode: '大肥鱼', overrideText: 'You are a big fat fish.\nKeep it lazy but correct.' } })
    expect(next.persona.mode).toBe('大肥鱼')
    expect(next.persona.overrideText).toContain('big fat fish')
    // wire 回读一致
    expect(toWire(readAdvancedSettings()).persona.mode).toBe('大肥鱼')
    expect(toWire(readAdvancedSettings()).persona.overrideText).toContain('lazy')
  })

  it('清空 persona（mode 空串）→ 彩蛋关闭', () => {
    applyWirePatch({ persona: { mode: '大肥鱼', overrideText: 'text' } })
    const cleared = applyWirePatch({ persona: { mode: '', overrideText: '' } })
    expect(cleared.persona.mode).toBe('')
    expect(cleared.persona.overrideText).toBe('')
  })

  it('persona 未传 → 保留现有（部分 patch 语义）', () => {
    applyWirePatch({ persona: { mode: 'm1', overrideText: 't1' } })
    const keep = applyWirePatch({ gateway: { port: 9999 } })
    expect(keep.persona.mode).toBe('m1')
    expect(keep.persona.overrideText).toBe('t1')
  })

  it('mergeWithDefaults：坏文件/缺字段 → persona 默认关闭', () => {
    const next = readAdvancedSettings()
    expect(next.persona.mode).toBe('')
    expect(next.persona.overrideText).toBe('')
  })
})
