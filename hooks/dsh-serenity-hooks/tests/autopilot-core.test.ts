/**
 * autopilot-core.test.ts — autopilot **纯判据层**（v1.34.1 ⑥ C6a 提取）测试
 *
 * 覆盖：
 *  · 常量同源：`TICK_MINUTES` 由 `TICK_MS` 派生（旧脚本文案写死 10min——§12.7 的文案缺陷不再可能）
 *  · `judgeWake` = **判据唯一真相源**（间隔 + 窗口），且间隔下限与 tick **同源**（0.01）
 *    ——**回归钉**：旧脚本取 1 ⇒ `intervalHours < 1` 时报告假阴性（8 项分歧之一）
 *  · `shouldWake` 只做**组合**（enabled/--auto/running + judgeWake），不重复实现时间窗口计算
 *  · 配置读取回退链（`trajectory.autopilot` → `autopilotTrajectory` → `autotrajectory`）与路径回退
 *  · 目标会话定位（session 必填 / S### 补零 / --auto 标志）/ 自生动机提取
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AUTO_DIR_SUFFIX,
  DEFAULT_AVOID_HOURS,
  DEFAULT_BIAS_PROVIDER,
  MIN_INTERVAL_HOURS,
  TICK_MINUTES,
  TICK_MS,
  beijingHour,
  inAllowedWakeWindow,
  isAutopilotSession,
  judgeWake,
  readAutopilotSettings,
  readSelfGeneratedMotivation,
  resolveTargetMd,
  shouldWake,
} from '../src/autopilot-core.js'

/** 北京时间某时刻对应的 UTC 时间戳（判据全部以显式 nowMs 驱动 ⇒ 测试与真实时钟无关） */
function beijingUtcMs(hour: number, minute = 0): number {
  return Date.UTC(2026, 7, 30, hour - 8, minute, 0)
}

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ap-core-'))
  writeFileSync(join(root, '.serenity'), 'test\n')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeConfig(cfg: unknown, rel = '.opencode/serenity.json'): void {
  const p = join(root, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, JSON.stringify(cfg))
}

/**
 * 造一个目标会话目录（dirName 自带 --auto 时为自主形态）。
 * ⚠️ 年龄必须相对**被测判据所用的 now**（`baseMs`）设置——用真实 Date.now() 会让注入的
 * 过去时刻算出负的 idleHours（我方首跑即踩：'expected -394.01 to be greater than 0.5'）。
 */
function makeSession(dirName: string, opts: { ageHours?: number; baseMs?: number } = {}): string {
  const dir = join(root, 'AGENT_SESSIONS', dirName)
  mkdirSync(dir, { recursive: true })
  const md = join(dir, 'SESSION.md')
  writeFileSync(md, '# session\n')
  if (opts.ageHours !== undefined) {
    const base = opts.baseMs ?? Date.now()
    const t = (base - opts.ageHours * 3600_000) / 1000
    utimesSync(md, t, t)
  }
  return md
}

describe('autopilot-core：常量同源（文案不再可能与 tick 脱节）', () => {
  it('TICK_MINUTES 由 TICK_MS 派生 = 5（旧脚本写死 10min 的缺陷不再可能）', () => {
    expect(TICK_MS).toBe(5 * 60 * 1000)
    expect(TICK_MINUTES).toBe(TICK_MS / 60_000)
    expect(TICK_MINUTES).toBe(5)
  })

  it('缺省避开窗口 = 北京 8~18（用量峰谷省钱）', () => {
    expect(DEFAULT_AVOID_HOURS).toEqual({ start: 8, end: 18 })
  })
})

describe('autopilot-core：judgeWake 判据唯一真相源', () => {
  it('目标会话不存在（mdPath=null）→ idleHours=null、intervalOk=false（不假装到点）', () => {
    const j = judgeWake({ intervalHours: 12 }, null, beijingUtcMs(2))
    expect(j.idleHours).toBeNull()
    expect(j.intervalOk).toBe(false)
    expect(j.wakeable).toBe(false)
  })

  it('间隔与窗口**分开**给出（判决分类需要分别呈现 ⏸ 的两种成因）', () => {
    const md = makeSession('2026-09-01--S151--x--auto', { ageHours: 0.5, baseMs: beijingUtcMs(2) })
    // 北京 2 点（窗口内）+ 0.5h 前活动：间隔 12h 未到 → intervalOk=false, windowOk=true
    const j = judgeWake({ intervalHours: 12 }, md, beijingUtcMs(2))
    expect(j.intervalOk).toBe(false)
    expect(j.windowOk).toBe(true)
    expect(j.wakeable).toBe(false)
  })

  it('🔴 回归钉：间隔下限 = MIN_INTERVAL_HOURS(0.01)，与 tick 同源', () => {
    expect(MIN_INTERVAL_HOURS).toBe(0.01)
    const j = judgeWake({ intervalHours: 0 }, null, beijingUtcMs(2))
    expect(j.interval).toBe(0.01)
  })

  it('🔴 回归钉：intervalHours < 1 不再假阴性（旧脚本 max(1,·) 会报"未到"而插件已唤起）', () => {
    // 0.5h 配置 + 0.75h 前活动：插件侧（下限 0.01）→ 到点；旧脚本（下限 1）→ 报"未到"
    const md = makeSession('2026-09-01--S151--x--auto', { ageHours: 0.75, baseMs: beijingUtcMs(2) })
    const j = judgeWake({ intervalHours: 0.5 }, md, beijingUtcMs(2))
    expect(j.interval).toBe(0.5)
    expect(j.idleHours).toBeGreaterThan(0.5)
    expect(j.intervalOk).toBe(true)
  })

  it('文件不可 stat（会话目录被删）→ intervalOk=false 而非抛错', () => {
    const md = join(root, 'AGENT_SESSIONS', '2026-09-01--S151--x--auto', 'SESSION.md')
    const j = judgeWake({ intervalHours: 0.01 }, md, beijingUtcMs(2))
    expect(j.idleHours).toBeNull()
    expect(j.intervalOk).toBe(false)
  })

  it('窗口：高峰内 windowOk=false；跨零点避开也支持', () => {
    expect(judgeWake({}, null, beijingUtcMs(12)).windowOk).toBe(false)
    expect(judgeWake({}, null, beijingUtcMs(3)).windowOk).toBe(true)
    // 跨零点：避开 22~6 → 北京 2 点在避开内
    expect(judgeWake({ avoidWakeHours: { start: 22, end: 6 } }, null, beijingUtcMs(2)).windowOk).toBe(false)
    expect(judgeWake({ avoidWakeHours: { start: 22, end: 6 } }, null, beijingUtcMs(12)).windowOk).toBe(true)
  })
})

describe('autopilot-core：shouldWake 只做组合（判据来自 judgeWake）', () => {
  it('enabled=false → 不唤起', () => {
    const md = makeSession('2026-09-01--S151--x--auto', { ageHours: 24, baseMs: beijingUtcMs(2) })
    expect(shouldWake({ enabled: false, intervalHours: 12 }, md, beijingUtcMs(2), false)).toBe(false)
  })

  it('running=true（重入守卫）→ 不唤起', () => {
    const md = makeSession('2026-09-01--S151--x--auto', { ageHours: 24, baseMs: beijingUtcMs(2) })
    expect(shouldWake({ enabled: true, intervalHours: 12 }, md, beijingUtcMs(2), true)).toBe(false)
  })

  it('目录无 --auto 标志 → 不唤起（同 CCC 其他轨迹不受影响）', () => {
    const md = makeSession('2026-09-01--S151--x', { ageHours: 24, baseMs: beijingUtcMs(2) })
    expect(shouldWake({ enabled: true, intervalHours: 12 }, md, beijingUtcMs(2), false)).toBe(false)
  })

  it('高峰窗口内 → 不唤起；窗口外 + 到点 → 唤起', () => {
    const md = makeSession('2026-09-01--S151--x--auto', { ageHours: 24, baseMs: beijingUtcMs(2) })
    expect(shouldWake({ enabled: true, intervalHours: 12 }, md, beijingUtcMs(12), false)).toBe(false)
    expect(shouldWake({ enabled: true, intervalHours: 12 }, md, beijingUtcMs(2), false)).toBe(true)
  })

  it('mdPath=null（session 未配置/未命中）→ 不唤起', () => {
    expect(shouldWake({ enabled: true, intervalHours: 12 }, null, beijingUtcMs(2), false)).toBe(false)
  })
})

describe('autopilot-core：配置读取（回退链与路径回退）', () => {
  it('trajectory.autopilot（新键 D58）优先', () => {
    writeConfig({ trajectory: { autopilot: { enabled: true, intervalHours: 3 } }, autopilotTrajectory: { enabled: false } })
    expect(readAutopilotSettings(root)).toMatchObject({ enabled: true, intervalHours: 3 })
  })

  it('无新键 → 回退旧键 autopilotTrajectory → 再回退 autotrajectory', () => {
    writeConfig({ autopilotTrajectory: { enabled: true, intervalHours: 7 } })
    expect(readAutopilotSettings(root)).toMatchObject({ intervalHours: 7 })
    writeConfig({ autotrajectory: { enabled: true, intervalHours: 9 } })
    expect(readAutopilotSettings(root)).toMatchObject({ intervalHours: 9 })
  })

  it('无配置 → null（不是空对象——"未配置"必须可与"配了空"区分）', () => {
    expect(readAutopilotSettings(root)).toBeNull()
  })

  it('.opencode 缺失 → 回退 .dsh/serenity.json（与写侧 CONFIG_PATHS 同序）', () => {
    writeConfig({ trajectory: { autopilot: { enabled: true } } }, '.dsh/serenity.json')
    expect(readAutopilotSettings(root)).toMatchObject({ enabled: true })
  })
})

describe('autopilot-core：目标会话定位与形态判断', () => {
  it('session 未配置 → null（绝不默认唤起）', () => {
    makeSession('2026-09-01--S151--x--auto')
    expect(resolveTargetMd(root, { enabled: true })).toBeNull()
  })

  it('S31 → 补零匹配 S031（与 findSession 同规则）', () => {
    const md = makeSession('2026-09-01--S031--x--auto')
    expect(resolveTargetMd(root, { session: 'S31' })).toBe(md)
  })

  it('目录名 --auto 后缀 = 自主形态（缺标志则不唤醒该轨迹）', () => {
    expect(isAutopilotSession('/x/AGENT_SESSIONS/2026-09-01--S151--x--auto/SESSION.md')).toBe(true)
    expect(isAutopilotSession('/x/AGENT_SESSIONS/2026-09-01--S151--x/SESSION.md')).toBe(false)
    expect(AUTO_DIR_SUFFIX).toBe('--auto')
  })
})

describe('autopilot-core：时间与自生动机', () => {
  it('beijingHour 不依赖服务器时区', () => {
    expect(beijingHour(Date.UTC(2026, 7, 30, 0, 0, 0))).toBe(8)
    expect(beijingHour(Date.UTC(2026, 7, 30, 16, 0, 0))).toBe(0)
  })

  it('inAllowedWakeWindow 缺省避开 8~18', () => {
    expect(inAllowedWakeWindow(beijingUtcMs(7))).toBe(true)
    expect(inAllowedWakeWindow(beijingUtcMs(8))).toBe(false)
    expect(inAllowedWakeWindow(beijingUtcMs(18))).toBe(true)
  })

  it('自生动机：取「下一轮动机」到下一个二级标题之间；无 → null', () => {
    const md = join(root, 'motivation.md')
    writeFileSync(md, '# t\n\n下一轮动机\n\n继续推进 A 项\n\n## 别的段\n忽略我\n')
    expect(readSelfGeneratedMotivation(md)).toBe('继续推进 A 项')
    writeFileSync(md, '# t\n无该段\n')
    expect(readSelfGeneratedMotivation(md)).toBeNull()
    expect(readSelfGeneratedMotivation(join(root, '不存在.md'))).toBeNull()
  })

  it('偏见提供者缺省名（旧默认名回退在 fetchBiasContent 内，见引擎测试）', () => {
    expect(DEFAULT_BIAS_PROVIDER).toBe('autopilot-bias.ts')
  })
})
