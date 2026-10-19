import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  readSkiffProfileAt,
  readSkiffProfileByCode,
  listSkiffProfiles,
  findDirNameByCode,
  skiffProfileForSession,
  SKIFF_PROFILE_FILENAME,
} from '../src/trajectory/policy/profile.js'
import { registerSkiffSession, unregisterSkiffSession, resetSkiffSessions } from '../src/trajectory/policy/window.js'

/**
 * skiff 的唯一判据（owner 2026-10-19 重做令）：**目录下有 `skiff.json` 的认知轨迹**。
 *
 * 本文件的判据重心（每条都对应一个真实的失败形态）：
 *  ① **J1 文件存在性**：无该文件 ⇒ null（不是 skiff），且**不产生任何告警**（常态）；
 *  ② **缺省值语义**：`cognitiveTrajectory.*` 缺省为 **true**（工作台就是它自己的身体）；
 *  ③ **坏 JSON ⇒ 按普通轨迹处理 ＋ 响亮告警**（权限面不能带着半份读不懂的配置运行）；
 *  ④ **J2 会话判据两来源并取**：持久绑定窗口期由注册表兜（只取一个就有真 bug）。
 */

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hooks-skiffprofile-'))
  writeFileSync(join(root, '.serenity'), 'test')
  mkdirSync(join(root, 'AGENT_SESSIONS'), { recursive: true })
  resetSkiffSessions()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 造一条轨迹目录，可选写入约束面 */
function mkTraj(code: string, profile?: Record<string, unknown> | null): { dir: string; dirName: string } {
  const dirName = `2026-10-19--${code}--示例`
  const dir = join(root, 'AGENT_SESSIONS', dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SESSION.md'), `# SESSION: ${code}\n`, 'utf-8')
  if (profile !== null && profile !== undefined) {
    writeFileSync(join(dir, SKIFF_PROFILE_FILENAME), JSON.stringify(profile), 'utf-8')
  }
  return { dir, dirName }
}

describe('skiff-profile: J1 —— 判据是「目录里有 skiff.json」', () => {
  it('无该文件 ⇒ null（不是 skiff，常态且**不告警**）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { dir } = mkTraj('plain')
    expect(readSkiffProfileAt(dir, root)).toBeNull()
    expect(warn, '没有 skiff.json 是常态 —— 不该产生任何告警').not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('有该文件 ⇒ 拿到约束面，且带出轨迹编码（身份 = 编码，不是角色名）', () => {
    const { dir, dirName } = mkTraj('my-role', { model: 'p/m', tools: ['read'], msms: ['x'] })
    const p = readSkiffProfileAt(dir, root)
    expect(p).not.toBeNull()
    expect(p!.code).toBe('my-role')
    expect(p!.dirName).toBe(dirName)
    expect(p!.model).toBe('p/m')
    expect(p!.tools).toEqual(['read'])
    expect(p!.msms).toEqual(['x'])
    expect(p!.path.endsWith(SKIFF_PROFILE_FILENAME)).toBe(true)
  })

  it('🔴 删掉该文件 ⇒ 立刻不再判定为 skiff（这是 owner 要的"自动"语义）', () => {
    const { dir } = mkTraj('toggle', { tools: ['read'] })
    expect(readSkiffProfileAt(dir, root)).not.toBeNull()
    rmSync(join(dir, SKIFF_PROFILE_FILENAME))
    expect(readSkiffProfileAt(dir, root)).toBeNull()
  })

  it('非本工具建的目录名（无日期前缀）⇒ 不解析（编码拿不到就不该当 skiff）', () => {
    const dir = join(root, 'AGENT_SESSIONS', 'random-dir')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, SKIFF_PROFILE_FILENAME), '{}', 'utf-8')
    expect(readSkiffProfileAt(dir, root)).toBeNull()
  })
})

describe('skiff-profile: 缺省值与容错', () => {
  it('🔴 cognitiveTrajectory 缺省全 true（工作台就是它自己的 SESSION.md）', () => {
    const { dir } = mkTraj('defaults', {})
    const p = readSkiffProfileAt(dir, root)!
    expect(p.cognitiveTrajectory).toEqual({ session: true, keeper: true, rebuild: true })
  })

  it('显式 false 被尊重（逐项独立）', () => {
    const { dir } = mkTraj('partial', { cognitiveTrajectory: { keeper: false } })
    const p = readSkiffProfileAt(dir, root)!
    expect(p.cognitiveTrajectory).toEqual({ session: true, keeper: false, rebuild: true })
  })

  it('数组里的非字符串项被丢弃（不整份作废）', () => {
    const { dir } = mkTraj('dirty', { tools: ['read', 42, '', null, 'grep'], msms: ['ok', {}] })
    const p = readSkiffProfileAt(dir, root)!
    expect(p.tools).toEqual(['read', 'grep'])
    expect(p.msms).toEqual(['ok'])
  })

  it('model 空白 ⇒ undefined（回退 cheap-worker 缺省）', () => {
    const { dir } = mkTraj('nomodel', { model: '   ' })
    expect(readSkiffProfileAt(dir, root)!.model).toBeUndefined()
  })

  it('🔴 坏 JSON ⇒ null ＋ 响亮告警（不带着半份权限面运行）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { dir } = mkTraj('broken')
    writeFileSync(join(dir, SKIFF_PROFILE_FILENAME), '{ not json', 'utf-8')
    expect(readSkiffProfileAt(dir, root)).toBeNull()
    expect(warn.mock.calls.some((c) => String(c[0]).includes('解析失败'))).toBe(true)
    warn.mockRestore()
  })

  it('顶层是数组 ⇒ 同样按非 skiff 处理（告警）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { dir } = mkTraj('arrayish')
    writeFileSync(join(dir, SKIFF_PROFILE_FILENAME), '[]', 'utf-8')
    expect(readSkiffProfileAt(dir, root)).toBeNull()
    expect(warn.mock.calls.some((c) => String(c[0]).includes('顶层不是对象'))).toBe(true)
    warn.mockRestore()
  })

  it('🔴 systemPromptFile 越界 ⇒ 只丢那一项，其余约束仍生效', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { dir } = mkTraj('escape', { systemPromptFile: '../../etc/passwd', tools: ['read'] })
    const p = readSkiffProfileAt(dir, root)!
    expect(p.systemPromptFile).toBeUndefined()
    expect(p.tools, '其余约束不得因一个越界路径而失效').toEqual(['read'])
    expect(warn.mock.calls.some((c) => String(c[0]).includes('越界'))).toBe(true)
    warn.mockRestore()
  })
})

describe('skiff-profile: 按编码 / 全量枚举', () => {
  it('findDirNameByCode 只做精确匹配（不做模糊 —— 路由要确定性）', () => {
    const { dirName } = mkTraj('exact')
    expect(findDirNameByCode(root, 'exact')).toBe(dirName)
    expect(findDirNameByCode(root, 'exa'), '前缀不算命中').toBeNull()
    expect(findDirNameByCode(root, 'EXACT'), '大小写敏感').toBeNull()
  })

  it('readSkiffProfileByCode：命中 skiff / 普通轨迹返回 null', () => {
    mkTraj('withprofile', { tools: ['read'] })
    mkTraj('noprofile')
    expect(readSkiffProfileByCode(root, 'withprofile')?.tools).toEqual(['read'])
    expect(readSkiffProfileByCode(root, 'noprofile')).toBeNull()
    expect(readSkiffProfileByCode(root, 'ghost')).toBeNull()
  })

  it('listSkiffProfiles：只列有 skiff.json 的活跃轨迹（跳过 _ 前缀与无约束面者）', () => {
    mkTraj('a-profile', { tools: ['read'] })
    mkTraj('b-plain')
    // 归档区里的不算
    const arch = join(root, 'AGENT_SESSIONS', '_archived', '2026-01-01--old--x')
    mkdirSync(arch, { recursive: true })
    writeFileSync(join(arch, SKIFF_PROFILE_FILENAME), '{}', 'utf-8')
    expect(listSkiffProfiles(root).map((p) => p.code)).toEqual(['a-profile'])
  })

  it('无 AGENT_SESSIONS 目录 ⇒ 空数组（不抛）', () => {
    const bare = mkdtempSync(join(tmpdir(), 'hooks-bare-'))
    expect(listSkiffProfiles(bare)).toEqual([])
    expect(findDirNameByCode(bare, 'x')).toBeNull()
    rmSync(bare, { recursive: true, force: true })
  })
})

describe('skiff-profile: J2 —— 会话级判据（两来源并取）', () => {
  it('🔴 注册表已登记但持久绑定还没落盘（窗口期）⇒ 仍判为 skiff', () => {
    const { dirName } = mkTraj('window', { tools: ['read'] })
    registerSkiffSession('sess-window', dirName, root)
    // 不给 boundDirName（模拟"绑定还没落盘"）
    expect(skiffProfileForSession(root, 'sess-window')?.code).toBe('window')
  })

  it('调用方已解析出绑定 ⇒ 直接用（不查注册表）', () => {
    const { dirName } = mkTraj('bound', { tools: ['read'] })
    expect(skiffProfileForSession(root, 'sess-unregistered', dirName)?.code).toBe('bound')
  })

  it('都拿不到 ⇒ null（普通轨迹，零约束）', () => {
    mkTraj('nobody')
    expect(skiffProfileForSession(root, 'sess-none')).toBeNull()
    expect(skiffProfileForSession(root, undefined)).toBeNull()
    expect(skiffProfileForSession(root, '')).toBeNull()
  })

  it('登记过但轨迹已被删/归档 ⇒ null（载体没了就不再是 skiff，不静默沿用）', () => {
    const { dirName } = mkTraj('gone', { tools: ['read'] })
    registerSkiffSession('sess-gone', dirName, root)
    rmSync(join(root, 'AGENT_SESSIONS', dirName), { recursive: true, force: true })
    expect(skiffProfileForSession(root, 'sess-gone')).toBeNull()
  })

  it('解绑后 ⇒ null（不会挂着旧身份）', () => {
    const { dirName } = mkTraj('unbind', { tools: ['read'] })
    registerSkiffSession('sess-unbind', dirName, root)
    expect(skiffProfileForSession(root, 'sess-unbind')).not.toBeNull()
    unregisterSkiffSession('sess-unbind')
    expect(skiffProfileForSession(root, 'sess-unbind')).toBeNull()
  })

  it('轨迹存在但没有 skiff.json ⇒ null（登记过也不是 skiff）', () => {
    const { dirName } = mkTraj('plain-registered')
    registerSkiffSession('sess-plain', dirName, root)
    expect(skiffProfileForSession(root, 'sess-plain')).toBeNull()
  })
})
