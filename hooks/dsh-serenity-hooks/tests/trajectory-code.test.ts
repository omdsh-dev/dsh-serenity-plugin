import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createSession,
  findSession,
  parseTrajectoryCode,
  isValidTrajectoryCode,
  readTrajectoryUid,
  UID_FILENAME,
  listSessions,
  resetActiveSessionStore,
} from '../src/trajectory/core.js'

/**
 * 轨迹编码（code）= 唯一标识（owner 2026-10-19 skiff 重做令，B 案）。
 *
 * 判据重心三条（每条都有对应的失败形态）：
 *  ① **固定位置解析**：目录名 `YYYY-MM-DD--<code>[--<desc>]` 的第二段恒为编码；
 *  ② **可指定 + 唯一性在写入侧**：`create --id` 指定后即生效；重复必须**响亮拒绝**
 *     （读取侧无法消解歧义 —— 那里只能"第一个命中"）；
 *  ③ **UID 写入退役、读取保留**：存量文件仍能被指认，但不再产生新标识。
 *
 * 🔴 负控思路（本文件刻意保留的两个）：
 *  · "重复编码被拒"若实现改成静默覆盖 ⇒ 该用例红；
 *  · "遗留 UID 仍可解析"若有人顺手删掉 `findSession` 的 UID 分支 ⇒ 该用例红。
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hooks-code-'))
  writeFileSync(join(dir, '.serenity'), 'test')
  mkdirSync(join(dir, 'AGENT_SESSIONS'), { recursive: true })
  resetActiveSessionStore()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function mk(opts: Parameters<typeof createSession>[0]): ReturnType<typeof createSession> {
  return createSession({ root: dir, dryRun: false, ...opts })
}

describe('trajectory-code: parseTrajectoryCode（固定位置）', () => {
  it('剥掉日期前缀后的第一段即编码（带描述、不带描述都对）', () => {
    expect(parseTrajectoryCode('2026-08-24--S142--dsh-serenity-plugin 长期维护')).toBe('S142')
    expect(parseTrajectoryCode('2026-10-14--apaas-26116')).toBe('apaas-26116')
    // issue 形态：只有一个分隔符 ⇒ 整个尾段就是编码（可含 `-`，但不含 `--`）
    expect(parseTrajectoryCode('2026-10-14--my.dotted_code--x')).toBe('my.dotted_code')
  })

  it('🔴 无日期前缀 ⇒ null（不是本工具建的目录，不该被当轨迹解析出编码）', () => {
    expect(parseTrajectoryCode('_archived')).toBeNull()
    expect(parseTrajectoryCode('random-dir')).toBeNull()
    expect(parseTrajectoryCode('2026-08-24--')).toBeNull()
  })
})

describe('trajectory-code: isValidTrajectoryCode（形态闸门）', () => {
  it('接受交流安全的编码', () => {
    expect(isValidTrajectoryCode('S142')).toBe(true)
    expect(isValidTrajectoryCode('my-role')).toBe(true)
    expect(isValidTrajectoryCode('apaas-26116')).toBe(true)
    expect(isValidTrajectoryCode('a.b_c-1')).toBe(true)
  })

  it('🔴 拒绝中文（owner 明令「不得包含中文」）', () => {
    expect(isValidTrajectoryCode('角色')).toBe(false)
    expect(isValidTrajectoryCode('zc角色')).toBe(false)
  })

  it('🔴 拒绝含 `--`（它是目录名分隔符，含它就破坏"固定位置"这个前提）', () => {
    expect(isValidTrajectoryCode('a--b')).toBe(false)
    expect(isValidTrajectoryCode('--x')).toBe(false)
  })

  it('拒绝首字符非字母数字 / 空 / 超长', () => {
    expect(isValidTrajectoryCode('')).toBe(false)
    expect(isValidTrajectoryCode('-abc')).toBe(false)
    expect(isValidTrajectoryCode('a b')).toBe(false)
    expect(isValidTrajectoryCode('a'.repeat(65))).toBe(false)
    expect(isValidTrajectoryCode('a'.repeat(64))).toBe(true)
  })
})

describe('trajectory-code: create --id（可指定 + 写入侧唯一性）', () => {
  it('指定的编码进入目录名固定位置，并成为 sessionId', () => {
    const r = mk({ desc: '示例', id: 'my-code' })
    expect(r.dirName.endsWith('--my-code--示例')).toBe(true)
    expect(r.sessionId).toBe('my-code')
    expect(parseTrajectoryCode(r.dirName)).toBe('my-code')
  })

  it('🔴 重复编码 ⇒ 响亮拒绝（不静默覆盖，也不造第二条）', () => {
    mk({ desc: '第一条', id: 'dup' })
    expect(() => mk({ desc: '第二条', id: 'dup' })).toThrow(/already in use/)
    // 且**没有**造出第二条目录
    expect(findSession(join(dir, 'AGENT_SESSIONS'), 'dup')?.dirName.endsWith('--dup--第一条')).toBe(true)
  })

  it('🔴 非法编码 ⇒ 拒绝且不落盘', () => {
    expect(() => mk({ desc: 'x', id: '角色' })).toThrow(/Invalid trajectory code/)
    expect(() => mk({ desc: 'x', id: 'a--b' })).toThrow(/Invalid trajectory code/)
    expect(listSessions(dir)).toContain('(no sessions')
  })

  it('不给 --id ⇒ 沿用自增 S###（零回归）', () => {
    const a = mk({ desc: 'a' })
    const b = mk({ desc: 'b' })
    expect(a.sessionId).toBe('S001')
    expect(b.sessionId).toBe('S002')
  })

  it('🔴 自定义编码不参与 S### 编号（不会把编号顶到不存在的值）', () => {
    mk({ desc: 'a', id: 'alpha' })
    expect(mk({ desc: 'b' }).sessionId).toBe('S001')
  })

  it('dry-run 也报编码，且不落盘', () => {
    const r = createSession({ root: dir, desc: 'x', id: 'preview', dryRun: true })
    expect(r.sessionId).toBe('preview')
    expect(r.message).toContain('code=preview')
    expect(listSessions(dir)).toContain('(no sessions')
  })
})

describe('trajectory-code: findSession（编码优先于遗留 UID）', () => {
  it('按编码精确命中', () => {
    const r = mk({ desc: 'x', id: 'findme' })
    expect(findSession(join(dir, 'AGENT_SESSIONS'), 'findme')?.dirName).toBe(r.dirName)
  })

  it('S31 → S031 补零兼容保留', () => {
    const r = mk({ desc: 'padded' }) // S001
    expect(findSession(join(dir, 'AGENT_SESSIONS'), 'S1')?.dirName).toBe(r.dirName)
  })

  it('🔴 遗留 UID 仍可指认（写入退役 ≠ 读取退役）', () => {
    const r = mk({ desc: 'old', id: 'legacy' })
    writeFileSync(join(r.sessionPath, UID_FILENAME), 'serenity-acc-maintainer\n', 'utf-8')
    expect(readTrajectoryUid(r.sessionPath)).toBe('serenity-acc-maintainer')
    expect(findSession(join(dir, 'AGENT_SESSIONS'), 'serenity-acc-maintainer')?.dirName).toBe(r.dirName)
  })

  it('编码与遗留 UID 同名时编码胜出（2026-10-19 起的顺序）', () => {
    const byCode = mk({ desc: 'code-side', id: 'shared' })
    const byUid = mk({ desc: 'uid-side', id: 'other' })
    writeFileSync(join(byUid.sessionPath, UID_FILENAME), 'shared\n', 'utf-8')
    expect(findSession(join(dir, 'AGENT_SESSIONS'), 'shared')?.dirName).toBe(byCode.dirName)
  })
})
