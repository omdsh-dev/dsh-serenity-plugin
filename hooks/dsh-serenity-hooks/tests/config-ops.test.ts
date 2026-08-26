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
  ADVANCED_SECTION,
} from '../src/config-ops.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hooks-config-ops-'))
  writeFileSync(join(dir, '.serenity'), 'test')
})

afterEach(() => {
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

describe('读写（localstore serenityAdvanced 节）', () => {
  it('文件不存在 → 默认值', () => {
    const s = readAdvancedSettings(dir)
    expect(s.gateway.enabled).toBe(false)
    expect(s.gateway.host).toBe('0.0.0.0')
    expect(s.gateway.port).toBe(3081)
    expect(s.gateway.accounts).toEqual([])
    expect(s.rebuild.enabled).toBe(true)
    expect(s.rebuild.thresholdRatio).toBe(0.9)
    expect(s.naming.enabled).toBe(true)
  })

  it('写 → 读 往返一致；保留其他节', () => {
    const s = defaultAdvancedSettings()
    s.gateway.accounts = [{ id: 'a1', user: 'yh', passHash: hashPassword('pw') }]
    writeAdvancedSettings(dir, s)

    const raw = JSON.parse(readFileSync(join(dir, 'localstore.json'), 'utf-8'))
    expect(raw[ADVANCED_SECTION].gateway.accounts[0].user).toBe('yh')
    // 其他节不受影响（写前存在 credentials）
    expect(raw.credentials).toBeUndefined()

    const back = readAdvancedSettings(dir)
    expect(back.gateway.accounts).toHaveLength(1)
    expect(back.gateway.accounts[0]!.user).toBe('yh')
    expect(verifyPassword('pw', back.gateway.accounts[0]!.passHash)).toBe(true)
  })

  it('坏 JSON → 默认值（不抛错）', () => {
    writeFileSync(join(dir, 'localstore.json'), '{broken', 'utf-8')
    expect(readAdvancedSettings(dir).gateway.accounts).toEqual([])
  })

  it('部分写入（非对象/缺字段）→ merge 默认值', () => {
    writeFileSync(join(dir, 'localstore.json'), JSON.stringify({ serenityAdvanced: { gateway: { enabled: true } } }), 'utf-8')
    const s = readAdvancedSettings(dir)
    expect(s.gateway.enabled).toBe(true)
    expect(s.gateway.port).toBe(3081) // 缺省字段补默认
    expect(s.rebuild.enabled).toBe(true)
  })
})

describe('updateAdvancedSettings（部分更新）', () => {
  it('gateway 部分 patch 保留 accounts；accounts 未传不覆盖', () => {
    const s = defaultAdvancedSettings()
    s.gateway.accounts = [{ id: 'a1', user: 'yh', passHash: 'h1' }]
    writeAdvancedSettings(dir, s)

    const next = updateAdvancedSettings(dir, { gateway: { enabled: true } })
    expect(next.gateway.enabled).toBe(true)
    expect(next.gateway.accounts).toHaveLength(1) // 保留
  })

  it('rebuild/naming 独立 patch', () => {
    const next = updateAdvancedSettings(dir, { rebuild: { thresholdRatio: 0.85 } })
    expect(next.rebuild.thresholdRatio).toBe(0.85)
    expect(next.rebuild.enabled).toBe(true)
    expect(next.naming.enabled).toBe(true)
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
    expect(w.gateway.accounts[0]).toEqual({ id: 'a1', user: 'yh', hasPassword: true })
    expect(w.gateway.accounts[1]).toEqual({ id: 'a2', user: 'd', hasPassword: false })
    expect(JSON.stringify(w)).not.toContain('passHash')
    expect(JSON.stringify(w)).not.toContain('pw')
  })
})

describe('applyWirePatch（wire → 持久化）', () => {
  it('新账号必带 pass → hash 落库', () => {
    const next = applyWirePatch(dir, {
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
      applyWirePatch(dir, {
        gateway: { accounts: [{ id: 'a1', user: 'yh' }] },
      }),
    ).toThrow(/必须设置密码/)
  })

  it('既有账号 pass 空 → 保留原 hash', () => {
    const s = defaultAdvancedSettings()
    s.gateway.accounts = [{ id: 'a1', user: 'yh', passHash: hashPassword('orig') }]
    writeAdvancedSettings(dir, s)

    const next = applyWirePatch(dir, {
      gateway: { accounts: [{ id: 'a1', user: 'yh', pass: '' }] },
    })
    expect(verifyPassword('orig', next.gateway.accounts[0]!.passHash)).toBe(true)
  })

  it('既有账号带新 pass → 更新 hash（可改名）', () => {
    const s = defaultAdvancedSettings()
    s.gateway.accounts = [{ id: 'a1', user: 'yh', passHash: hashPassword('orig') }]
    writeAdvancedSettings(dir, s)

    const next = applyWirePatch(dir, {
      gateway: { accounts: [{ id: 'a1', user: 'yh-new', pass: 'newpw' }] },
    })
    expect(next.gateway.accounts[0]!.user).toBe('yh-new')
    expect(verifyPassword('newpw', next.gateway.accounts[0]!.passHash)).toBe(true)
    expect(verifyPassword('orig', next.gateway.accounts[0]!.passHash)).toBe(false)
  })

  it('删除账号（数组整体替换）', () => {
    const s = defaultAdvancedSettings()
    s.gateway.accounts = [{ id: 'a1', user: 'yh', passHash: 'h1' }]
    writeAdvancedSettings(dir, s)

    const next = applyWirePatch(dir, { gateway: { accounts: [] } })
    expect(next.gateway.accounts).toEqual([])
  })

  it('开关/阈值/端口 patch 生效（含边界校验）', () => {
    const next = applyWirePatch(dir, {
      gateway: { enabled: true, host: '127.0.0.1', port: 9999 },
      rebuild: { enabled: false, thresholdRatio: 0.5 },
      naming: { enabled: false },
    })
    expect(next.gateway.enabled).toBe(true)
    expect(next.gateway.host).toBe('127.0.0.1')
    expect(next.gateway.port).toBe(9999)
    expect(next.rebuild.enabled).toBe(false)
    expect(next.rebuild.thresholdRatio).toBe(0.5)
    expect(next.naming.enabled).toBe(false)
  })

  it('非法阈值被忽略（>1 或 ≤0）', () => {
    const next = applyWirePatch(dir, { rebuild: { thresholdRatio: 1.5 } })
    expect(next.rebuild.thresholdRatio).toBe(0.9)
  })

  it('写后 localstore 被 .gitignore 覆盖（deny 缺省物理保证）', () => {
    const s = defaultAdvancedSettings()
    s.gateway.accounts = [{ id: 'a1', user: 'yh', passHash: 'h' }]
    writeAdvancedSettings(dir, s)
    const gi = readFileSync(join(dir, '.gitignore'), 'utf-8')
    expect(gi).toContain('localstore.json')
  })
})
