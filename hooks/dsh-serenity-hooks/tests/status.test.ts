import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getStatus, setSafeMode } from '../src/status.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'status-'))
  writeFileSync(join(dir, '.serenity'), 'test')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('status: getStatus', () => {
  it('CCC 内返回完整状态', () => {
    const s = getStatus(dir)
    expect(s.root).toBe(dir)
    expect(s.safeModeOn).toBe(false)
    expect(s.accVersion).toBeTruthy()
  })

  it('非 CCC 返回 root null', () => {
    const s = getStatus('/tmp')
    expect(s.root).toBeNull()
    expect(s.safeModeOn).toBe(false)
  })

  it('读取黑名单 / 阈值 / loop 模型', () => {
    mkdirSync(join(dir, '.dsh'))
    writeFileSync(
      join(dir, '.dsh', 'serenity.json'),
      JSON.stringify({ loop: { defaultModel: 'm3' }, sessionKeeper: { threshold: 100 }, safeMode: { blacklist: ['.secrets/'] } }),
    )
    const s = getStatus(dir)
    expect(s.threshold).toBe(100)
    expect(s.loopModel).toBe('m3')
    expect(s.blacklist).toEqual(['.secrets/'])
  })
})

describe('status: setSafeMode（WebUI 开关通道）', () => {
  it('开 → 创建标记；关 → 删除标记', () => {
    expect(getStatus(dir).safeModeOn).toBe(false)
    const on = setSafeMode(dir, true)
    expect(on.on).toBe(true)
    expect(existsSync(join(dir, '.serenity-safe-on'))).toBe(true)
    expect(getStatus(dir).safeModeOn).toBe(true)

    const off = setSafeMode(dir, false)
    expect(off.on).toBe(false)
    expect(existsSync(join(dir, '.serenity-safe-on'))).toBe(false)
  })

  it('幂等：重复开/关不报错', () => {
    setSafeMode(dir, true)
    expect(setSafeMode(dir, true).on).toBe(true)
    setSafeMode(dir, false)
    expect(setSafeMode(dir, false).on).toBe(false)
  })
})
