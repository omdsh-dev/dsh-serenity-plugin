/**
 * autotrajectory.test.ts — 自主轨迹机制（v1.26.12 实验提案）测试
 *
 * 覆盖：北京时间/唤起窗口（用量峰谷省钱）/ 目录后缀标志 / 目标定位 / 唤起条件 /
 * 自生动机读取 / 随机方向 MSM 调用 / 唤起消息三段式。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, utimesSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('@deepseek-ai/dsh-llm', () => ({
  createUserMessage: (o: unknown) => o,
}))
vi.mock('../src/session-ops.js', () => ({
  sessionsRoot: (root: string) => join(root, 'AGENT_SESSIONS'),
  findSession: vi.fn(),
  findLatestActiveSessionMd: vi.fn(),
}))

import { findSession, findLatestActiveSessionMd } from '../src/session-ops.js'
import {
  DEFAULT_BIAS_PROVIDER,
  AUTO_DIR_SUFFIX,
  beijingHour,
  inAllowedWakeWindow,
  isAutoTrajectorySession,
  resolveTargetMd,
  shouldWake,
  readSelfGeneratedMotivation,
  fetchBiasContent,
  buildWakeMessage,
} from '../src/autotrajectory.js'

const mockFindSession = vi.mocked(findSession)
const mockFindLatest = vi.mocked(findLatestActiveSessionMd)

/** 北京时间某时刻的 UTC 时间戳 */
function beijingUtcMs(hour: number, minute = 0): number {
  return Date.UTC(2026, 7, 30, hour - 8, minute, 0)
}

describe('beijingHour / inAllowedWakeWindow（用量峰谷省钱）', () => {
  it('北京时间 = UTC+8（服务器时区无关）', () => {
    expect(beijingHour(beijingUtcMs(12))).toBe(12) // UTC 04:00 → 北京 12:00
    expect(beijingHour(beijingUtcMs(0))).toBe(0) // UTC 前日 16:00 → 北京 00:00
    expect(beijingHour(beijingUtcMs(23))).toBe(23)
  })

  it('缺省窗口避开北京 8~18：8/12 不唤起，18/0/23 唤起', () => {
    expect(inAllowedWakeWindow(beijingUtcMs(8))).toBe(false) // 8:00 边界（窗口内）
    expect(inAllowedWakeWindow(beijingUtcMs(12))).toBe(false)
    expect(inAllowedWakeWindow(beijingUtcMs(17))).toBe(false)
    expect(inAllowedWakeWindow(beijingUtcMs(18))).toBe(true) // 18:00 边界（窗口外）
    expect(inAllowedWakeWindow(beijingUtcMs(0))).toBe(true)
    expect(inAllowedWakeWindow(beijingUtcMs(23))).toBe(true)
  })

  it('跨零点避开配置 {22,6}：窗口 = 北京 6~22', () => {
    const avoid = { start: 22, end: 6 }
    expect(inAllowedWakeWindow(beijingUtcMs(0), avoid)).toBe(false)
    expect(inAllowedWakeWindow(beijingUtcMs(5), avoid)).toBe(false)
    expect(inAllowedWakeWindow(beijingUtcMs(6), avoid)).toBe(true)
    expect(inAllowedWakeWindow(beijingUtcMs(12), avoid)).toBe(true)
    expect(inAllowedWakeWindow(beijingUtcMs(21), avoid)).toBe(true)
    expect(inAllowedWakeWindow(beijingUtcMs(22), avoid)).toBe(false)
  })
})

describe('isAutoTrajectorySession（目录后缀标志）', () => {
  it('--auto 后缀 → 自主形态；无后缀 → 否', () => {
    expect(isAutoTrajectorySession(`/root/AGENT_SESSIONS/2026-08-30--S143--exp${AUTO_DIR_SUFFIX}/SESSION.md`)).toBe(true)
    expect(isAutoTrajectorySession('/root/AGENT_SESSIONS/2026-08-30--S143--normal/SESSION.md')).toBe(false)
    expect(isAutoTrajectorySession('/root/AGENT_SESSIONS/S143/SESSION.md')).toBe(false)
  })
})

describe('resolveTargetMd（目标定位）', () => {
  beforeEach(() => {
    mockFindSession.mockReset()
    mockFindLatest.mockReset()
  })

  it('cfg.session 优先（findSession 命中）', () => {
    const realDir = mkdtempSync(join(tmpdir(), 'at-find-'))
    const realMd = join(realDir, 'SESSION.md')
    writeFileSync(realMd, '# SESSION: exp\n')
    mockFindSession.mockReturnValue({ dirName: '2026-08-30--S143--exp--auto', path: realDir, mtime: new Date(), status: { hasSessionMd: true, completed: false, completedCount: 0, pendingCount: 0, unresolvedCount: 0 } })
    const md = resolveTargetMd('/root', { session: 'S143' })
    expect(mockFindSession).toHaveBeenCalledWith('/root/AGENT_SESSIONS', 'S143')
    expect(md).toBe(realMd)
    rmSync(realDir, { recursive: true, force: true })
  })

  it('cfg.session 未命中 → 回退最近活跃', () => {
    mockFindSession.mockReturnValue(null)
    mockFindLatest.mockReturnValue('/root/AGENT_SESSIONS/2026-08-30--S143--exp--auto/SESSION.md')
    expect(resolveTargetMd('/root', { session: 'S143' })).toBe('/root/AGENT_SESSIONS/2026-08-30--S143--exp--auto/SESSION.md')
  })

  it('无 session 配置 → 直接最近活跃', () => {
    mockFindLatest.mockReturnValue('/root/AGENT_SESSIONS/2026-08-30--S143--exp--auto/SESSION.md')
    expect(resolveTargetMd('/root', {})).toBe('/root/AGENT_SESSIONS/2026-08-30--S143--exp--auto/SESSION.md')
  })
})

describe('shouldWake（唤起条件全链）', () => {
  let tmp: string
  let md: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'at-test-'))
    const dir = join(tmp, 'AGENT_SESSIONS', '2026-08-30--S143--exp--auto')
    mkdirSync(dir, { recursive: true })
    md = join(dir, 'SESSION.md')
    writeFileSync(md, '# SESSION: exp\n')
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  function setMtimeHoursAgo(hoursAgo: number): void {
    const t = new Date(Date.now() - hoursAgo * 3600_000)
    utimesSync(md, t, t)
  }

  it('未启用 / 运行中 / 无标志 / 窗口外 / 间隔未到 → 均不唤起', () => {
    setMtimeHoursAgo(99)
    const now = beijingUtcMs(12) // 北京时间中午（窗口内）
    expect(shouldWake({}, md, now, false)).toBe(false) // 未启用
    expect(shouldWake({ enabled: true }, md, now, true)).toBe(false) // 运行中
    const plain = join(tmp, 'AGENT_SESSIONS', '2026-08-30--S143--normal', 'SESSION.md')
    expect(shouldWake({ enabled: true }, plain, now, false)).toBe(false) // 无标志
    expect(shouldWake({ enabled: true }, md, beijingUtcMs(12), false)).toBe(false) // 窗口内
    setMtimeHoursAgo(1)
    expect(shouldWake({ enabled: true }, md, Date.now(), false)).toBe(false) // 间隔未到
  })

  it('全条件满足（标志+间隔+窗口+空闲）→ 唤起', () => {
    setMtimeHoursAgo(99)
    const now = beijingUtcMs(20) // 北京时间 20:00（窗口外）
    expect(shouldWake({ enabled: true }, md, now, false)).toBe(true)
    // 自定义间隔：99h 前 > 12h
    expect(shouldWake({ enabled: true, intervalHours: 12 }, md, now, false)).toBe(true)
  })

  it('间隔边界：满 N 小时（>=）唤起；不足不唤起（固定窗口外基准，与运行时刻无关）', () => {
    const NOW = beijingUtcMs(20) // 北京 20:00（窗口外）
    const tUnder = new Date(NOW - 12 * 3600_000 + 60_000) // 差 1min 不足 12h
    utimesSync(md, tUnder, tUnder)
    expect(shouldWake({ enabled: true, intervalHours: 12 }, md, NOW, false)).toBe(false)
    const t12 = new Date(NOW - 12 * 3600_000) // 恰好满 12h
    utimesSync(md, t12, t12)
    expect(shouldWake({ enabled: true, intervalHours: 12 }, md, NOW, false)).toBe(true)
  })
})

describe('readSelfGeneratedMotivation（自生动机）', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'at-mot-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('提取「下一轮动机」段（到下一个二级标题）', () => {
    const md = join(tmp, 'SESSION.md')
    writeFileSync(md, [
      '# SESSION: exp',
      '',
      '## 下一轮动机',
      '探索 X 方向的反事实：如果步骤 3 用 B 方案会怎样。',
      '',
      '## 进度',
      '做了些事',
    ].join('\n'))
    expect(readSelfGeneratedMotivation(md)).toBe('探索 X 方向的反事实：如果步骤 3 用 B 方案会怎样。')
  })

  it('无标记 / 文件缺失 → null', () => {
    const md = join(tmp, 'SESSION.md')
    writeFileSync(md, '# SESSION: exp\n## 进度\n')
    expect(readSelfGeneratedMotivation(md)).toBeNull()
    expect(readSelfGeneratedMotivation(join(tmp, 'missing.md'))).toBeNull()
  })
})

describe('fetchBiasContent（偏见内容 = CCC 根目录偏见提供者脚本）', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'at-bias-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('脚本存在且 exit 0 → stdout 为偏见内容', async () => {
    writeFileSync(join(tmp, 'bias.js'), 'console.log("反事实：如果改用离线索引会怎样")')
    const res = await fetchBiasContent(tmp, 'bias.js')
    expect(res.error).toBeNull()
    expect(res.text).toBe('反事实：如果改用离线索引会怎样')
  })

  it('脚本缺失 → error 提示实现（不静默）', async () => {
    const res = await fetchBiasContent(tmp, DEFAULT_BIAS_PROVIDER)
    expect(res.text).toBeNull()
    expect(res.error).toContain('请在 CCC 根目录实现偏见内容提供者脚本')
    expect(res.error).toContain(DEFAULT_BIAS_PROVIDER)
  })

  it('路径逃逸（根外）→ error 拒绝', async () => {
    const res = await fetchBiasContent(tmp, '../outside.js')
    expect(res.text).toBeNull()
    expect(res.error).toContain('路径逃逸')
  })

  it('脚本 exit 非 0 → error 执行失败', async () => {
    writeFileSync(join(tmp, 'fail.js'), 'process.exit(3)')
    const res = await fetchBiasContent(tmp, 'fail.js')
    expect(res.text).toBeNull()
    expect(res.error).toContain('执行失败')
  })
})

describe('buildWakeMessage（唤起消息三段式）', () => {
  it('含自生动机 + 偏见内容', () => {
    const msg = buildWakeMessage({
      sessionName: '2026-08-30--S143--exp--auto',
      mdPath: '/x/SESSION.md',
      intervalHours: 12,
      motivation: '探索 B 方案',
      biasContent: '反事实：步骤 3 换做法',
    })
    expect(msg).toContain('[自主轨迹唤起] — 距上次轨迹活动已满 12 小时')
    expect(msg).toContain('身份锚定：继续 2026-08-30--S143--exp--auto 的 trajectory')
    expect(msg).toContain('· 自生动机：探索 B 方案')
    expect(msg).toContain('· 偏见内容：反事实：步骤 3 换做法')
    expect(msg).toContain('「自主探索日志」段')
    expect(msg).toContain('预写「下一轮动机」段')
  })

  it('都无 → 标注纯自主探索', () => {
    const msg = buildWakeMessage({ sessionName: 'S143', mdPath: '/x', intervalHours: 12, motivation: null, biasContent: null })
    expect(msg).toContain('（无——本轮纯自主探索）')
  })
})
