/**
 * autopilot-trajectory.test.ts — Autopilot Trajectory（自动巡航轨迹，正式版 v1.27.4）测试
 *
 * 前身 autotrajectory.test.ts（v1.26.12 实验提案）——v1.27.4 正式化改名 + 多 CCC 独立 +
 * 可靠性（轮次预算/审计/偏见脚本沙箱）。
 *
 * 覆盖：北京时间/唤起窗口（用量峰谷省钱）/ 目录后缀标志 / 目标定位 / 唤起条件（含预算）/
 * 自生动机读取 / 偏见内容（含旧默认回退 + 沙箱）/ 唤起消息四段式 / 面板状态（含审计）/
 * 立即唤起 / 多 CCC 独立收集与时钟 / 进程内诊断 / 审计 ring。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, utimesSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('@deepseek-ai/dsh-llm', () => ({
  createUserMessage: (o: unknown) => o,
}))
vi.mock('@deepseek-ai/dsh-tools', () => ({
  defineTool: (o: unknown) => o,
}))
// schemastery 运行时不可解析（peerDep 全局提供）——settings-section import 链需要
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
// dsh-settings peerDep 同样不可解析——mock（settings-section import 链）
vi.mock('@deepseek-ai/dsh-settings', () => ({
  installSettingsSection: () => {},
  settingsNamespace: (v: string) => v,
}))
vi.mock('../src/session-ops.js', () => ({
  sessionsRoot: (root: string) => join(root, 'AGENT_SESSIONS'),
  findSession: vi.fn(),
  findLatestActiveSessionMd: vi.fn(),
}))

import { findSession, findLatestActiveSessionMd } from '../src/session-ops.js'
import { findExpScript } from '../src/tools/autopilot-trajectory.js'
import {
  DEFAULT_BIAS_PROVIDER,
  LEGACY_BIAS_PROVIDER,
  DEFAULT_MAX_DAILY_WAKES,
  AUDIT_HISTORY_MAX,
  AUTO_DIR_SUFFIX,
  beijingHour,
  dailyWakeCount,
  inAllowedWakeWindow,
  isAutopilotSession,
  resolveTargetMd,
  shouldWake,
  readSelfGeneratedMotivation,
  fetchBiasContent,
  buildWakeMessage,
  readAutopilotSettings,
  recordWake,
  wakeHistoryFor,
  resetWakeHistory,
  getAutopilotStatus,
  performAutopilotWake,
  listLiveSessions,
  collectAutopilotCccs,
  diagLive,
  registerAutopilot,
} from '../src/autopilot-trajectory.js'
import { __setSimpleSourceForTest, defaultSimpleSettings } from '../src/settings-section.js'

const mockFindSession = vi.mocked(findSession)
const mockFindLatest = vi.mocked(findLatestActiveSessionMd)

/** 北京时间某时刻的 UTC 时间戳 */
function beijingUtcMs(hour: number, minute = 0): number {
  return Date.UTC(2026, 7, 30, hour - 8, minute, 0)
}

describe('findExpScript（包内实验脚本定位——bundle lib/ 与源码 src/ 两种布局）', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ap-exp-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('从 lib/index.js 一层上溯（bundle 布局）→ 找到包根 experiments', () => {
    const pkg = join(tmp, 'pkg')
    mkdirSync(join(pkg, 'lib'), { recursive: true })
    const script = join(pkg, 'experiments', 'autopilot-trajectory', 'scripts', 'autopilot-trajectory.ts')
    mkdirSync(join(pkg, 'experiments', 'autopilot-trajectory', 'scripts'), { recursive: true })
    writeFileSync(script, '// exp\n')
    expect(findExpScript(join(pkg, 'lib'))).toBe(script)
  })

  it('从 src/tools 两层上溯（源码/测试布局）→ 找到包根 experiments', () => {
    const pkg = join(tmp, 'pkg2')
    mkdirSync(join(pkg, 'src', 'tools'), { recursive: true })
    const script = join(pkg, 'experiments', 'autopilot-trajectory', 'scripts', 'autopilot-trajectory.ts')
    mkdirSync(join(pkg, 'experiments', 'autopilot-trajectory', 'scripts'), { recursive: true })
    writeFileSync(script, '// exp\n')
    expect(findExpScript(join(pkg, 'src', 'tools'))).toBe(script)
  })

  it('找不到 → null', () => {
    expect(findExpScript(tmp)).toBeNull()
  })
})

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

describe('isAutopilotSession（目录后缀标志）', () => {
  it('--auto 后缀 → 自主形态；无后缀 → 否', () => {
    expect(isAutopilotSession(`/root/AGENT_SESSIONS/2026-08-30--S143--exp${AUTO_DIR_SUFFIX}/SESSION.md`)).toBe(true)
    expect(isAutopilotSession('/root/AGENT_SESSIONS/2026-08-30--S143--normal/SESSION.md')).toBe(false)
    expect(isAutopilotSession('/root/AGENT_SESSIONS/S143/SESSION.md')).toBe(false)
  })
})

describe('resolveTargetMd（目标定位——session 必填，不默认任何会话）', () => {
  beforeEach(() => {
    mockFindSession.mockReset()
    mockFindLatest.mockReset()
  })

  it('配置 session 命中 → 返回该 SESSION.md', () => {
    const realDir = mkdtempSync(join(tmpdir(), 'ap-find-'))
    const realMd = join(realDir, 'SESSION.md')
    writeFileSync(realMd, '# SESSION: exp\n')
    mockFindSession.mockReturnValue({ dirName: '2026-08-30--S143--exp--auto', path: realDir, mtime: new Date(), status: { hasSessionMd: true, completed: false, completedCount: 0, pendingCount: 0, unresolvedCount: 0 } })
    const md = resolveTargetMd('/root', { session: 'S143' })
    expect(mockFindSession).toHaveBeenCalledWith('/root/AGENT_SESSIONS', 'S143')
    expect(md).toBe(realMd)
    rmSync(realDir, { recursive: true, force: true })
  })

  it('未配置 session → null（绝不默认最近活跃——CCC 日常多轨迹并行）', () => {
    expect(resolveTargetMd('/root', {})).toBeNull()
    expect(resolveTargetMd('/root', { enabled: true })).toBeNull()
    expect(mockFindLatest).not.toHaveBeenCalled()
  })

  it('配置 session 未命中 → null（不唤起）', () => {
    mockFindSession.mockReturnValue(null)
    expect(resolveTargetMd('/root', { session: 'S999' })).toBeNull()
  })
})

describe('readAutopilotSettings（配置键：新键 autopilotTrajectory 优先，旧键回退）', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ap-cfg-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  function writeCfg(cfg: unknown): void {
    const dir = join(tmp, '.opencode')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'serenity.json'), JSON.stringify(cfg))
  }

  it('新键 autopilotTrajectory 优先（正式版）', () => {
    writeCfg({ autopilotTrajectory: { enabled: true, session: 'S143' }, autotrajectory: { enabled: false, session: 'S999' } })
    const s = readAutopilotSettings(tmp)
    expect(s?.enabled).toBe(true)
    expect(s?.session).toBe('S143')
  })

  it('无新键 → 旧键 autotrajectory 回退（存量 CCC 零迁移）', () => {
    writeCfg({ autotrajectory: { enabled: true, session: 'S999' } })
    const s = readAutopilotSettings(tmp)
    expect(s?.enabled).toBe(true)
    expect(s?.session).toBe('S999')
  })

  it('两键皆无 → null（未配置）', () => {
    writeCfg({ other: 1 })
    expect(readAutopilotSettings(tmp)).toBeNull()
  })
})

describe('dailyWakeCount / shouldWake 轮次预算（v1.27.4 可靠性——防失控 + 控成本）', () => {
  let tmp: string
  let md: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ap-budget-'))
    const dir = join(tmp, 'AGENT_SESSIONS', '2026-08-30--S143--exp--auto')
    mkdirSync(dir, { recursive: true })
    md = join(dir, 'SESSION.md')
    writeFileSync(md, '# SESSION: exp\n')
    resetWakeHistory()
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
    resetWakeHistory()
  })

  function setMtimeHoursAgo(hoursAgo: number): void {
    const t = new Date(Date.now() - hoursAgo * 3600_000)
    utimesSync(md, t, t)
  }

  it('dailyWakeCount：只计北京时间当日（跨日不计）', () => {
    const now = Date.now()
    const today = { time: now, ok: true, detail: 'x' }
    const yesterday = { time: now - 24 * 3600_000, ok: true, detail: 'x' }
    expect(dailyWakeCount([today, yesterday, today], now)).toBe(2)
  })

  it('shouldWake：history 达当日上限 → 不唤起（预算）', () => {
    setMtimeHoursAgo(99)
    const now = beijingUtcMs(20) // 窗口外
    const fullHistory = Array.from({ length: DEFAULT_MAX_DAILY_WAKES }, () => ({ time: now, ok: true, detail: 'x' }))
    expect(shouldWake({ enabled: true }, md, now, false, fullHistory)).toBe(false)
    expect(shouldWake({ enabled: true }, md, now, false, fullHistory.slice(0, -1))).toBe(true)
  })

  it('shouldWake：自定义 maxDailyWakes 生效', () => {
    setMtimeHoursAgo(99)
    const now = beijingUtcMs(20)
    const history = Array.from({ length: 3 }, () => ({ time: now, ok: true, detail: 'x' }))
    expect(shouldWake({ enabled: true, maxDailyWakes: 3 }, md, now, false, history)).toBe(false)
    expect(shouldWake({ enabled: true, maxDailyWakes: 4 }, md, now, false, history)).toBe(true)
  })
})

describe('shouldWake（唤起条件全链）', () => {
  let tmp: string
  let md: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ap-test-'))
    const dir = join(tmp, 'AGENT_SESSIONS', '2026-08-30--S143--exp--auto')
    mkdirSync(dir, { recursive: true })
    md = join(dir, 'SESSION.md')
    writeFileSync(md, '# SESSION: exp\n')
    resetWakeHistory()
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
    resetWakeHistory()
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

  it('v1.27.8 小数间隔：0.01h（≈36s）→ 满 36s 即唤起（支持高频实验）', () => {
    const NOW = beijingUtcMs(20) // 北京 20:00（窗口外）
    // 0.01h = 36s；37s 前活动 → 已满间隔 → 唤起
    const tOver = new Date(NOW - 37_000)
    utimesSync(md, tOver, tOver)
    expect(shouldWake({ enabled: true, intervalHours: 0.01 }, md, NOW, false)).toBe(true)
    // 30s 前活动 → 不足 36s → 不唤起
    const tUnder = new Date(NOW - 30_000)
    utimesSync(md, tUnder, tUnder)
    expect(shouldWake({ enabled: true, intervalHours: 0.01 }, md, NOW, false)).toBe(false)
    // 合法小数：0.5h = 30min
    const tHalf = new Date(NOW - 31 * 60_000)
    utimesSync(md, tHalf, tHalf)
    expect(shouldWake({ enabled: true, intervalHours: 0.5 }, md, NOW, false)).toBe(true)
  })
})

describe('readSelfGeneratedMotivation（自生动机）', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ap-mot-'))
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

describe('fetchBiasContent（偏见内容 = CCC 根目录偏见提供者脚本；沙箱：超时 + 输出上限）', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ap-bias-'))
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

  it('新默认缺失 → 回退旧默认 autotrajectory-bias.ts（pangu 等已配置 CCC 零迁移）', async () => {
    writeFileSync(join(tmp, LEGACY_BIAS_PROVIDER), 'console.log("旧默认偏见：反事实方向 A")')
    const res = await fetchBiasContent(tmp, DEFAULT_BIAS_PROVIDER)
    expect(res.error).toBeNull()
    expect(res.text).toBe('旧默认偏见：反事实方向 A')
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

  it('输出超 8KB → 截断（沙箱输出上限）', async () => {
    writeFileSync(join(tmp, 'big.js'), 'console.log("x".repeat(20000))')
    const res = await fetchBiasContent(tmp, 'big.js')
    expect(res.error).toBeNull()
    expect(res.text!.length).toBeLessThanOrEqual(8 * 1024)
  })
})

describe('buildWakeMessage（唤起消息四段式：轨迹焦点 / 身份锚定 / 先验偏见 / 任务）', () => {
  it('轨迹焦点（CCC 定义）最先注入——稳定锚定防漂移', () => {
    const msg = buildWakeMessage({
      sessionName: '2026-08-30--S143--exp--auto',
      mdPath: '/x/SESSION.md',
      intervalHours: 12,
      topPrompt: '持续深化某领域认知，产出可重建的结论',
      motivation: '探索 B 方案',
      biasContent: '反事实：步骤 3 换做法',
    })
    // 轨迹焦点必须出现在消息第一行（影响力最大）
    expect(msg.startsWith('[轨迹焦点] 持续深化某领域认知，产出可重建的结论')).toBe(true)
    expect(msg.indexOf('[轨迹焦点]')).toBeLessThan(msg.indexOf('[Autopilot Trajectory 唤起]'))
    expect(msg).toContain('[Autopilot Trajectory 唤起] — 距上次轨迹活动已满 12 小时')
    expect(msg).toContain('身份锚定：继续 2026-08-30--S143--exp--auto 的 trajectory')
    expect(msg).toContain('· 自生动机：探索 B 方案')
    expect(msg).toContain('· 偏见内容：反事实：步骤 3 换做法')
    expect(msg).toContain('「自主探索日志」段')
    expect(msg).toContain('预写「下一轮动机」段')
  })

  it('无轨迹焦点 → 消息不含该段（存量兼容：唤起仍可进行）', () => {
    const msg = buildWakeMessage({ sessionName: 'S143', mdPath: '/x', intervalHours: 12, topPrompt: null, motivation: null, biasContent: null })
    expect(msg.startsWith('[轨迹焦点]')).toBe(false)
    expect(msg).toContain('（无——本轮纯自主探索）')
  })

  it('v1.27.8 小数间隔唤起消息 → 显示分钟（0.01h → "约 1 分钟"）', () => {
    const msg = buildWakeMessage({ sessionName: 'S143', mdPath: '/x', intervalHours: 0.01, topPrompt: null, motivation: null, biasContent: 'x' })
    expect(msg).toContain('约 1 分钟')
    expect(msg).not.toContain('0.01 小时')
    // 整小时仍显示小时
    const msgH = buildWakeMessage({ sessionName: 'S143', mdPath: '/x', intervalHours: 2, topPrompt: null, motivation: null, biasContent: 'x' })
    expect(msgH).toContain('2 小时')
  })
})

describe('recordWake / wakeHistoryFor（审计——v1.27.4 每 CCC ring，可回看可分析）', () => {
  beforeEach(() => {
    resetWakeHistory()
  })
  afterEach(() => {
    resetWakeHistory()
  })

  it('记录 + 读取（root 隔离）', () => {
    recordWake('/root/a', { time: 1, ok: true, detail: 'ok-a' })
    recordWake('/root/b', { time: 2, ok: false, detail: 'fail-b' })
    expect(wakeHistoryFor('/root/a')).toEqual([{ time: 1, ok: true, detail: 'ok-a' }])
    expect(wakeHistoryFor('/root/b')).toEqual([{ time: 2, ok: false, detail: 'fail-b' }])
  })

  it('ring 上限 AUDIT_HISTORY_MAX/CCC：超限截断保留最新', () => {
    for (let i = 0; i < AUDIT_HISTORY_MAX + 5; i++) {
      recordWake('/root', { time: i, ok: true, detail: `w-${i}` })
    }
    const h = wakeHistoryFor('/root')
    expect(h).toHaveLength(AUDIT_HISTORY_MAX)
    expect(h[0]!.detail).toBe(`w-${5}`) // 最早的 5 条被截断
    expect(h[h.length - 1]!.detail).toBe(`w-${AUDIT_HISTORY_MAX + 4}`)
  })
})

describe('getAutopilotStatus（面板状态——GET /serenity/autopilot-trajectory 数据源）', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ap-status-'))
    mockFindSession.mockReset()
    resetWakeHistory()
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
    resetWakeHistory()
  })

  function writeCfg(cfg: unknown): void {
    const dir = join(tmp, '.opencode')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'serenity.json'), JSON.stringify({ autopilotTrajectory: cfg }))
  }

  it('未配置 → configured=false，target=null', () => {
    const s = getAutopilotStatus(tmp)
    expect(s.configured).toBe(false)
    expect(s.enabled).toBe(false)
    expect(s.target).toBeNull()
    expect(s.biasProvider).toBe(DEFAULT_BIAS_PROVIDER)
    expect(s.topPrompt).toBeNull()
    expect(s.maxDailyWakes).toBe(DEFAULT_MAX_DAILY_WAKES)
    expect(s.recentWakes).toEqual([])
    expect(s.beijingHour).toBeGreaterThanOrEqual(0)
    expect(s.beijingHour).toBeLessThan(24)
  })

  it('已配置未启用 → enabled=false，配置摘要展示', () => {
    writeCfg({ enabled: false, intervalHours: 6, biasProvider: 'bias.ts', topPrompt: 'EAP 质量', session: 'S143', maxDailyWakes: 4 })
    const s = getAutopilotStatus(tmp)
    expect(s.configured).toBe(true)
    expect(s.enabled).toBe(false)
    expect(s.intervalHours).toBe(6)
    expect(s.biasProvider).toBe('bias.ts')
    expect(s.topPrompt).toBe('EAP 质量')
    expect(s.session).toBe('S143')
    expect(s.maxDailyWakes).toBe(4)
    // 未启用：仍尝试解析目标（展示用）——未命中 → null
    expect(s.target).toBeNull()
  })

  it('已配置 topPrompt 空白 → 归一为 null（面板显示未配置）', () => {
    writeCfg({ enabled: true, topPrompt: '   ' })
    const s = getAutopilotStatus(tmp)
    expect(s.topPrompt).toBeNull()
  })

  it('启用 + 会话命中（--auto）→ target 完整：标志/空闲/可唤起', () => {
    const dir = join(tmp, 'AGENT_SESSIONS', `2026-08-30--S143--exp${AUTO_DIR_SUFFIX}`)
    mkdirSync(dir, { recursive: true })
    const md = join(dir, 'SESSION.md')
    writeFileSync(md, '# SESSION: exp\n')
    const t = new Date(Date.now() - 99 * 3600_000) // 99h 前（超阈值）
    utimesSync(md, t, t)
    const realDir = join(tmp, 'AGENT_SESSIONS', `2026-08-30--S143--exp${AUTO_DIR_SUFFIX}`)
    mockFindSession.mockReturnValue({ dirName: `2026-08-30--S143--exp${AUTO_DIR_SUFFIX}`, path: realDir, mtime: new Date(), status: { hasSessionMd: true, completed: false, completedCount: 0, pendingCount: 0, unresolvedCount: 0 } })
    writeCfg({ enabled: true, intervalHours: 12, session: 'S143' })
    const s = getAutopilotStatus(tmp)
    expect(s.enabled).toBe(true)
    expect(s.target).not.toBeNull()
    expect(s.target!.dirName.endsWith(AUTO_DIR_SUFFIX)).toBe(true)
    expect(s.target!.autoFlag).toBe(true)
    expect(s.target!.idleHours).toBeGreaterThan(98)
    // 可唤起判定：窗口允许 + 间隔到 → wakeable=true（用当前时刻；若恰在北京 8~18 点则 windowAllowed=false）
    if (s.windowAllowed) {
      expect(s.target!.wakeable).toBe(true)
    }
  })

  it('启用 + 会话未命中 → target=null（展示「未命中」）', () => {
    mockFindSession.mockReturnValue(null)
    writeCfg({ enabled: true, session: 'S999' })
    const s = getAutopilotStatus(tmp)
    expect(s.enabled).toBe(true)
    expect(s.target).toBeNull()
  })

  it('recentWakes：审计含最近记录（倒序，最多 10 条展示）', () => {
    recordWake(tmp, { time: 1000, ok: true, detail: 'wake-1' })
    recordWake(tmp, { time: 2000, ok: false, detail: 'wake-2' })
    const s = getAutopilotStatus(tmp)
    expect(s.recentWakes).toHaveLength(2)
    expect(s.recentWakes[0]!.detail).toBe('wake-2') // 倒序（最新在前）
    expect(s.recentWakes[1]!.detail).toBe('wake-1')
  })
})

describe('performAutopilotWake（时钟与「立即唤起」共用执行体）', () => {
  let tmp: string
  let steer: ReturnType<typeof vi.fn>

  function makeCtx(): unknown {
    // 真实 dsh 形态：sessions.list() 条目无 title 字段——标题在 events 的 session/title 事件里；
    // header.cwd 决定 CCC 归属（performAutopilotWake 的 tmp 即根，这里 cwd=tmp 命中归属校验）
    return {
      sessions: {
        list: () => [
          {
            id: 'sess-1',
            header: { cwd: tmp },
            events: [{ type: 'session/title', data: { title: 'S143-2026-08-30', messageSeqs: [], source: { kind: 'user' } } }],
          },
        ],
      },
      agents: { get: (id: string) => (id === 'sess-1' ? { steer } : undefined) },
    }
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ap-wake-'))
    mockFindSession.mockReset()
    steer = vi.fn()
    resetWakeHistory()
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
    resetWakeHistory()
  })

  function setupTarget(intervalHoursAgo: number): string {
    const dir = join(tmp, 'AGENT_SESSIONS', `2026-08-30--S143--exp${AUTO_DIR_SUFFIX}`)
    mkdirSync(dir, { recursive: true })
    const md = join(dir, 'SESSION.md')
    writeFileSync(md, '# SESSION: exp\n')
    const t = new Date(Date.now() - intervalHoursAgo * 3600_000)
    utimesSync(md, t, t)
    mockFindSession.mockReturnValue({ dirName: `2026-08-30--S143--exp${AUTO_DIR_SUFFIX}`, path: dir, mtime: t, status: { hasSessionMd: true, completed: false, completedCount: 0, pendingCount: 0, unresolvedCount: 0 } })
    return md
  }

  const cfg = { enabled: true, intervalHours: 12, session: 'S143', biasProvider: 'bias.js' }

  it('force=true（立即唤起）：跳过窗口/间隔/预算，偏见脚本就绪 → steer 注入 + ok', async () => {
    setupTarget(0) // 刚刚活动（间隔不满足——force 跳过）
    writeFileSync(join(tmp, 'bias.js'), 'console.log("反事实：换做法会怎样")')
    const res = await performAutopilotWake(makeCtx() as never, tmp, cfg, { force: true })
    expect(res.ok).toBe(true)
    expect(res.detail).toContain('已唤起')
    expect(steer).toHaveBeenCalledTimes(1)
    const msg = steer.mock.calls[0]![0] as { content: { text: string }[] }
    expect(msg.content[0]!.text).toContain('[Autopilot Trajectory 唤起]')
    expect(msg.content[0]!.text).toContain('反事实：换做法会怎样')
  })

  it('force=true（立即唤起）：当日预算已满也跳过（force 语义=调试，用户在场）', async () => {
    setupTarget(0)
    writeFileSync(join(tmp, 'bias.js'), 'console.log("x")')
    const fullHistory = Array.from({ length: DEFAULT_MAX_DAILY_WAKES }, () => ({ time: Date.now(), ok: true, detail: 'x' }))
    for (const rec of fullHistory) recordWake(tmp, rec)
    const res = await performAutopilotWake(makeCtx() as never, tmp, cfg, { force: true })
    expect(res.ok).toBe(true)
    expect(steer).toHaveBeenCalledTimes(1)
  })

  it('force=false（时钟）：间隔不足 → 拒绝，不注入', async () => {
    setupTarget(1) // 1h 前（不足 12h）
    writeFileSync(join(tmp, 'bias.js'), 'console.log("x")')
    // avoidWakeHours {0,0} 恒在窗口外：时间无关——默认北京 8-18 窗口会让本测试
    // 在窗口期先命中"避开窗口"而非"间隔不足"（08:08 实测 flake）
    const res = await performAutopilotWake(makeCtx() as never, tmp, { ...cfg, avoidWakeHours: { start: 0, end: 0 } }, { force: false })
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('不足')
    expect(steer).not.toHaveBeenCalled()
  })

  it('未启用 → 拒绝', async () => {
    const res = await performAutopilotWake(makeCtx() as never, tmp, { ...cfg, enabled: false }, { force: true })
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('未启用')
  })

  it('会话目录无 --auto 标志 → 拒绝（force 也校验）', async () => {
    const dir = join(tmp, 'AGENT_SESSIONS', '2026-08-30--S143--normal')
    mkdirSync(dir, { recursive: true })
    const md = join(dir, 'SESSION.md')
    writeFileSync(md, '# SESSION: exp\n')
    mockFindSession.mockReturnValue({ dirName: '2026-08-30--S143--normal', path: dir, mtime: new Date(), status: { hasSessionMd: true, completed: false, completedCount: 0, pendingCount: 0, unresolvedCount: 0 } })
    const res = await performAutopilotWake(makeCtx() as never, tmp, cfg, { force: true })
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('--auto')
    expect(steer).not.toHaveBeenCalled()
  })

  it('偏见脚本缺失 → 拒绝（force 也校验），提示实现', async () => {
    setupTarget(0)
    const res = await performAutopilotWake(makeCtx() as never, tmp, cfg, { force: true })
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('偏见内容缺失')
    expect(res.detail).toContain('bias.js')
    expect(steer).not.toHaveBeenCalled()
  })

  it('agent 不可得 → 拒绝', async () => {
    setupTarget(0)
    writeFileSync(join(tmp, 'bias.js'), 'console.log("x")')
    const ctx = { sessions: { list: () => [] }, agents: { get: () => undefined } }
    const res = await performAutopilotWake(ctx as never, tmp, cfg, { force: true })
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('agent 不可得')
    expect(steer).not.toHaveBeenCalled()
  })

  it('标题从 events 的 session/title 事件读取（latest-wins）', async () => {
    setupTarget(0)
    writeFileSync(join(tmp, 'bias.js'), 'console.log("x")')
    // 旧标题在前、新标题在后 → 取最后一条（latest-wins 语义）
    const ctx = {
      sessions: {
        list: () => [
          {
            id: 'sess-2',
            header: { cwd: tmp },
            events: [
              { type: 'session/title', data: { title: '旧标题' } },
              { type: 'session/title', data: { title: 'S143-2026-08-30' } },
            ],
          },
        ],
      },
      agents: { get: (id: string) => (id === 'sess-2' ? { steer } : undefined) },
    }
    const res = await performAutopilotWake(ctx as never, tmp, cfg, { force: true })
    expect(res.ok).toBe(true)
    expect(steer).toHaveBeenCalledTimes(1)
  })

  it('cwd 归属校验：其他 CCC 的会话（header.cwd 非目标根）不匹配', async () => {
    setupTarget(0)
    writeFileSync(join(tmp, 'bias.js'), 'console.log("x")')
    // 标题匹配但 cwd 归属其他 CCC → 拒绝（不误唤起别的 CCC 会话）
    const ctx = {
      sessions: {
        list: () => [
          {
            id: 'sess-other',
            header: { cwd: '/other/ccc' },
            events: [{ type: 'session/title', data: { title: 'S143-2026-08-30' } }],
          },
        ],
      },
      agents: { get: () => ({ steer }) },
    }
    const res = await performAutopilotWake(ctx as never, tmp, cfg, { force: true })
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('agent 不可得')
    expect(steer).not.toHaveBeenCalled()
  })

  it('agent 不可得时诊断信息：区分「无 live 会话」/「标题不匹配」/「agent 未加载」', async () => {
    setupTarget(0)
    writeFileSync(join(tmp, 'bias.js'), 'console.log("x")')
    // ① 目标 CCC 内无 live 会话 → 提示先打开
    const empty = { sessions: { list: () => [] }, agents: { get: () => undefined } }
    const r1 = await performAutopilotWake(empty as never, tmp, cfg, { force: true })
    expect(r1.detail).toContain('无 live 会话')
    // ② 目标 CCC 内有会话但标题不匹配 → 列出标题
    const mismatch = {
      sessions: {
        list: () => [
          { id: 'a', header: { cwd: tmp }, events: [{ type: 'session/title', data: { title: 'S999-其他' } }] },
        ],
      },
      agents: { get: () => ({ steer }) },
    }
    const r2 = await performAutopilotWake(mismatch as never, tmp, cfg, { force: true })
    expect(r2.detail).toContain('S999-其他')
    expect(r2.detail).toContain('均不匹配')
    // ③ 标题匹配但 agent 未加载 → 明确提示
    const noAgent = {
      sessions: {
        list: () => [
          { id: 'a', header: { cwd: tmp }, events: [{ type: 'session/title', data: { title: 'S143-2026-08-30' } }] },
        ],
      },
      agents: { get: () => undefined },
    }
    const r3 = await performAutopilotWake(noAgent as never, tmp, cfg, { force: true })
    expect(r3.detail).toContain('已打开但 agent 未加载')
  })
})

describe('listLiveSessions / collectAutopilotCccs / diagLive（进程内诊断——v1.26.14 面板检测不到实验 CCC 排查）', () => {
  let tmp: string
  let tmp2: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ap-diag-'))
    tmp2 = mkdtempSync(join(tmpdir(), 'ap-diag2-'))
    mockFindSession.mockReset()
    // findSerenityRoot 依赖 .serenity 标记（ccc.ts）
    writeFileSync(join(tmp, '.serenity'), '')
    writeFileSync(join(tmp2, '.serenity'), '')
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
    rmSync(tmp2, { recursive: true, force: true })
  })

  function sessionCtx(sessions: Array<{ id: string; cwd?: string; events?: unknown[] }>): unknown {
    return {
      sessions: {
        list: () => sessions.map((s) => ({ id: s.id, header: s.cwd ? { cwd: s.cwd } : {}, events: s.events ?? [] })),
      },
      agents: { get: () => undefined },
    }
  }

  function writeCfgAt(root: string, cfg: unknown): void {
    const dir = join(root, '.opencode')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'serenity.json'), JSON.stringify({ autopilotTrajectory: cfg }))
  }

  it('listLiveSessions：读 id/cwd/标题（events session/title latest-wins）/ccc 归属', () => {
    const ctx = sessionCtx([
      {
        id: 's-1',
        cwd: tmp,
        events: [
          { type: 'session/title', data: { title: '旧' } },
          { type: 'session/title', data: { title: 'S143-2026-08-30' } },
        ],
      },
      { id: 's-2', cwd: '/plain/dir' }, // 无 .serenity → cccRoot null
      { id: 's-3' }, // 无 cwd
    ])
    const list = listLiveSessions(ctx as never)
    expect(list).toHaveLength(3)
    expect(list[0]).toMatchObject({ id: 's-1', cwd: tmp, cccRoot: tmp, title: 'S143-2026-08-30' })
    expect(list[1]).toMatchObject({ id: 's-2', cccRoot: null, title: null })
    expect(list[2]).toMatchObject({ id: 's-3', cwd: null, title: null })
  })

  it('collectAutopilotCccs：仅返回 enabled 的 live CCC（v1.27.4 多 CCC 独立）', () => {
    // 两 CCC 都配置：tmp enabled=true，tmp2 enabled=false → 只收 tmp
    writeCfgAt(tmp, { enabled: true, session: 'S143' })
    writeCfgAt(tmp2, { enabled: false, session: 'S999' })
    const ctx = sessionCtx([
      { id: 'a', cwd: tmp2 }, // 顺序无关——按 enabled 过滤
      { id: 'b', cwd: tmp },
    ])
    const roots = collectAutopilotCccs(ctx as never)
    expect(roots).toEqual([tmp])
  })

  it('collectAutopilotCccs：多个 enabled CCC 全部收集（多 CCC 各自独立唤起）', () => {
    writeCfgAt(tmp, { enabled: true, session: 'S143' })
    writeCfgAt(tmp2, { enabled: true, session: 'S999' })
    const ctx = sessionCtx([
      { id: 'a', cwd: tmp },
      { id: 'b', cwd: tmp2 },
    ])
    const roots = collectAutopilotCccs(ctx as never)
    expect(roots).toContain(tmp)
    expect(roots).toContain(tmp2)
    expect(roots).toHaveLength(2)
  })

  it('collectAutopilotCccs includeDisabled：含 configured 未启用（面板/诊断全量）', () => {
    writeCfgAt(tmp, { enabled: true, session: 'S143' })
    writeCfgAt(tmp2, { enabled: false, session: 'S999' })
    const ctx = sessionCtx([
      { id: 'a', cwd: tmp },
      { id: 'b', cwd: tmp2 },
    ])
    const roots = collectAutopilotCccs(ctx as never, { includeDisabled: true })
    expect(roots).toHaveLength(2)
  })

  it('collectAutopilotCccs：无配置 → []', () => {
    const ctx = sessionCtx([{ id: 'a', cwd: tmp }])
    expect(collectAutopilotCccs(ctx as never)).toEqual([])
  })

  it('diagLive：报告完整（live 会话 + autopilot CCC + agent 定位 + 面板解析目标）', () => {
    writeCfgAt(tmp, { enabled: true, session: 'S143' })
    const ctx = sessionCtx([
      { id: 'a', cwd: tmp, events: [{ type: 'session/title', data: { title: 'S143-2026-08-30' } }] },
    ])
    const r = diagLive(ctx as never)
    expect(r.processCwd).toBe(process.cwd())
    expect(r.liveSessions).toHaveLength(1)
    expect(r.panelResolved).toBe(tmp)
    expect(r.autopilotCccs).toHaveLength(1)
    expect(r.autopilotCccs[0]!.enabled).toBe(true)
    expect(r.autopilotCccs[0]!.session).toBe('S143')
  })
})

describe('registerAutopilot（时钟定时器——v1.26.14 修复：启动时 live 会话为空导致定时器永不启动；v1.27.4 多 CCC 独立）', () => {
  let tmp: string
  let tmp2: string
  let listeners: Record<string, Array<(payload?: unknown) => void>>
  let timer: ReturnType<typeof setInterval> | null
  let liveSessions: unknown[]

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ap-reg-'))
    tmp2 = mkdtempSync(join(tmpdir(), 'ap-reg2-'))
    writeFileSync(join(tmp, '.serenity'), '')
    writeFileSync(join(tmp2, '.serenity'), '')
    mockFindSession.mockReset()
    listeners = {}
    timer = null
    liveSessions = []
    resetWakeHistory()
    // v1.27.9 全局开关：register 测试默认全局已开（验证 CCC 级逻辑）；全局关门控有专门用例
    __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), autopilotEnabled: true }))
    // mock setInterval/unref：记录定时器并阻止真实计时
    vi.spyOn(global, 'setInterval').mockImplementation(((fn: () => void, ms: number) => {
      timer = { fn, ms, unref: () => undefined } as unknown as ReturnType<typeof setInterval>
      return timer
    }) as typeof setInterval)
    vi.spyOn(global, 'clearInterval').mockImplementation(() => { timer = null })
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
    rmSync(tmp2, { recursive: true, force: true })
    resetWakeHistory()
    __setSimpleSourceForTest(null)
    vi.restoreAllMocks()
  })

  function makeCtx(): { ctx: unknown; emit: (name: string) => void; setSessions: (s: unknown[]) => void } {
    const ctx = {
      sessions: { list: () => liveSessions },
      agents: { get: () => undefined },
      on: (name: string, fn: (payload?: unknown) => void) => { (listeners[name] ??= []).push(fn) },
    }
    return {
      ctx,
      emit: (name) => { for (const fn of listeners[name] ?? []) fn() },
      setSessions: (s) => { liveSessions = s },
    }
  }

  function writeCfg(root: string, cfg: unknown): void {
    const dir = join(root, '.opencode')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'serenity.json'), JSON.stringify({ autopilotTrajectory: cfg }))
  }

  /** 在 root 下建 --auto 目标会话（mtime 超阈值；session 命中 mock） */
  function setupTarget(root: string, sessionId: string, hoursAgo = 99): void {
    const dir = join(root, 'AGENT_SESSIONS', `2026-08-30--${sessionId}--exp${AUTO_DIR_SUFFIX}`)
    mkdirSync(dir, { recursive: true })
    const md = join(dir, 'SESSION.md')
    writeFileSync(md, '# SESSION: exp\n')
    const t = new Date(Date.now() - hoursAgo * 3600_000)
    utimesSync(md, t, t)
  }

  it('v1.27.9 全局开关默认关（autopilotEnabled=false）→ 即使 CCC 启用也不启动定时器', () => {
    writeCfg(tmp, { enabled: true, session: 'S143' })
    const { ctx, setSessions } = makeCtx()
    setSessions([{ id: 'a', header: { cwd: tmp } }])
    __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), autopilotEnabled: false }))
    registerAutopilot(ctx as never)
    expect(timer).toBeNull() // 全局关 → 零资源占用
  })

  it('v1.27.9 全局开关开启 + CCC 启用 → 启动定时器（双重门控都满足）', () => {
    writeCfg(tmp, { enabled: true, session: 'S143' })
    const { ctx, setSessions } = makeCtx()
    setSessions([{ id: 'a', header: { cwd: tmp } }])
    __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), autopilotEnabled: true }))
    registerAutopilot(ctx as never)
    expect(timer).not.toBeNull()
  })

  it('启动时无 live 会话（或未配置）→ 不启动定时器（零资源占用）', () => {
    const { ctx } = makeCtx()
    registerAutopilot(ctx as never)
    expect(timer).toBeNull()
  })

  it('启动时已有启用 CCC live 会话 → 立即启动定时器（v1.26.14 主路径）', () => {
    writeCfg(tmp, { enabled: true, session: 'S143' })
    const { ctx, setSessions } = makeCtx()
    setSessions([{ id: 'a', header: { cwd: tmp } }])
    registerAutopilot(ctx as never)
    expect(timer).not.toBeNull()
  })

  it('启动时无会话 → 会话出现（session/created）后启动定时器（修复核心）', () => {
    writeCfg(tmp, { enabled: true, session: 'S143' })
    const { ctx, emit, setSessions } = makeCtx() // 启动时无 live 会话
    registerAutopilot(ctx as never)
    expect(timer).toBeNull() // 未启动
    // 用户打开启用 CCC 会话 → session/created 触发
    setSessions([{ id: 'a', header: { cwd: tmp } }])
    emit('session/created')
    expect(timer).not.toBeNull() // 定时器启动
  })

  it('配置关闭（enabled=false）→ 即使会话出现也不启动', () => {
    writeCfg(tmp, { enabled: false })
    const { ctx, emit, setSessions } = makeCtx()
    registerAutopilot(ctx as never)
    setSessions([{ id: 'a', header: { cwd: tmp } }])
    emit('session/created')
    expect(timer).toBeNull()
  })

  it('tick 多 CCC 独立唤起（v1.27.4）：两个启用 CCC 各自评估 + 各自审计（全局串行链）', async () => {
    // 两个 CCC 都配置启用 + 目标会话就绪（--auto + mtime 超阈值 + 窗口外基准）
    writeCfg(tmp, { enabled: true, session: 'S143', intervalHours: 12, avoidWakeHours: { start: 0, end: 0 } })
    writeCfg(tmp2, { enabled: true, session: 'S999', intervalHours: 12, avoidWakeHours: { start: 0, end: 0 } })
    setupTarget(tmp, 'S143')
    setupTarget(tmp2, 'S999')
    mockFindSession.mockImplementation((_root: string, sessionId: string) => {
      // 按会话 id 返回对应 CCC 的目标目录（root 前缀匹配）
      for (const root of [tmp, tmp2]) {
        const dir = join(root, 'AGENT_SESSIONS', `2026-08-30--${sessionId}--exp${AUTO_DIR_SUFFIX}`)
        if (existsSync(join(dir, 'SESSION.md'))) {
          return { dirName: `2026-08-30--${sessionId}--exp${AUTO_DIR_SUFFIX}`, path: dir, mtime: new Date(), status: { hasSessionMd: true, completed: false, completedCount: 0, pendingCount: 0, unresolvedCount: 0 } }
        }
      }
      return null
    })
    const { ctx, setSessions } = makeCtx()
    setSessions([
      { id: 'a', header: { cwd: tmp } },
      { id: 'b', header: { cwd: tmp2 } },
    ])
    registerAutopilot(ctx as never)
    expect(timer).not.toBeNull()
    // 触发 tick：两 CCC 均到点 → 各走一次唤起（agent 不可得 → 审计记录失败，不崩）
    const t = timer as unknown as { fn: () => void }
    t.fn()
    await new Promise((r) => setTimeout(r, 20)) // 等 wakeChain 串行完成
    const h1 = wakeHistoryFor(tmp)
    const h2 = wakeHistoryFor(tmp2)
    expect(h1).toHaveLength(1)
    expect(h2).toHaveLength(1)
    expect(h1[0]!.ok).toBe(false) // agent 不可得（makeCtx agents.get → undefined）
    expect(h2[0]!.ok).toBe(false)
  })
})
