/**
 * autopilot-chain.test.ts — **唤起条件链唯一实现**（`src/autopilot-chain.ts`）测试
 *
 * 覆盖（⑥ C6a 的三条硬要求）：
 *  · **判决语义回归钉**（§12.7 修复不得回退）：`✗` = 配置/环境问题 ｜ `⏸` = 等待中（非配置问题）
 *    ｜ `?` = 不可知；**只有三类皆空才印 ✅**（旧实现只统计 `✗` ⇒ 高峰时段假 ✅，实测复现过）
 *  · **离线通道永不印 ✅**（`NO_RUNTIME_FACTS`：全局闸/live/重入三项不可知 ⇒ 照实标 `?`，
 *    **不**当作满足）——这条是"独立进程看不到运行态"的结构性缺口的**显式化**
 *  · **进程内事实驱动**：全局闸关 / agent 未定位 / 重入进行中 各有一枚 ✗⏸ 分类钉
 *
 * 本文件**不 mock 任何东西**（chain 零 DSH 依赖）——它 import 得动的正是"离线通道 import 得动"
 * 的同一份实现（该性质本身由 `dsh-develop diag` 实跑覆盖）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NO_RUNTIME_FACTS,
  buildWakeChain,
  renderWakeChain,
  type WakeChainFacts,
} from '../src/autopilot-chain.js'

/** 北京时间某时刻对应的 UTC 时间戳（判据以显式 now 驱动 ⇒ 与真实时钟无关） */
function beijingUtcMs(hour: number, minute = 0): number {
  return Date.UTC(2026, 7, 30, hour - 8, minute, 0)
}

/** 偏见执行桩（chain 的注入点——避免测试 spawn；生产默认 = fetchBiasContent） */
const biasOk = async (): Promise<{ text: string | null; error: string | null }> => ({ text: 'BIAS-OUT', error: null })
const biasFail = async (): Promise<{ text: string | null; error: string | null }> => ({ text: null, error: '未实现偏见脚本' })

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ap-chain-'))
  writeFileSync(join(root, '.serenity'), 'test\n')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeConfig(autopilot: Record<string, unknown>, key = 'trajectory'): void {
  const p = join(root, '.opencode', 'serenity.json')
  mkdirSync(join(root, '.opencode'), { recursive: true })
  const body = key === 'trajectory' ? { trajectory: { autopilot } } : { [key]: autopilot }
  writeFileSync(p, JSON.stringify(body))
}

/** 目标会话目录（`--auto` = 自主形态；mtime 相对 baseMs 设置） */
function makeSession(dirName: string, baseMs: number, ageHours: number): void {
  const dir = join(root, 'AGENT_SESSIONS', dirName)
  mkdirSync(dir, { recursive: true })
  const md = join(dir, 'SESSION.md')
  writeFileSync(md, '# session\n')
  const t = (baseMs - ageHours * 3600_000) / 1000
  utimesSync(md, t, t)
}

/** 一切正常的基准：北京 2 点（窗口内）+ 24h 未活动 + 配置齐备 */
const OK_CFG = { enabled: true, intervalHours: 12, session: 'S151', biasProvider: 'bias.js' }
const IN_PROCESS_OK: WakeChainFacts = {
  globalGate: true,
  running: false,
  live: { sessionCount: 1, agentResolved: true, diagnosis: null },
}

describe('autopilot-chain：判决语义回归钉（§12.7 修复不得回退）', () => {
  it('三类皆空 → ✅（唯一允许印 ✅ 的情形）', async () => {
    writeConfig(OK_CFG)
    makeSession('2026-09-01--S151--x--auto', beijingUtcMs(2), 24)
    const r = await buildWakeChain(root, IN_PROCESS_OK, beijingUtcMs(2), biasOk)
    expect(r.verdict).toBe('ready')
    expect(r.blockers).toEqual([])
    expect(r.waiting).toEqual([])
    expect(r.unknowns).toEqual([])
    expect(r.judgement).toContain('✅ 唤起条件全部满足')
    expect(r.judgement).toContain('5min tick') // 文案取 TICK_MINUTES（旧脚本写死 10min）
  })

  it('🔴 只有 ⏸（等待中）时**不得**印 ✅ —— 旧实现在此印"全部满足"（用户可见假报告）', async () => {
    writeConfig(OK_CFG)
    makeSession('2026-09-01--S151--x--auto', beijingUtcMs(12), 24) // 北京 12 点 = 高峰避开中
    const r = await buildWakeChain(root, IN_PROCESS_OK, beijingUtcMs(12), biasOk)
    expect(r.verdict).toBe('waiting')
    expect(r.blockers).toEqual([])
    expect(r.waiting).toHaveLength(1)
    expect(r.judgement).toContain('⏸ 尚未满足 1 项')
    expect(r.judgement).toContain('**非**配置问题')
    expect(r.judgement).not.toContain('✅')
    expect(renderWakeChain(r)).not.toContain('✅ 唤起条件全部满足')
  })

  it('⏸ 的另一成因：间隔未到（同样不印 ✅）', async () => {
    writeConfig(OK_CFG)
    makeSession('2026-09-01--S151--x--auto', beijingUtcMs(2), 0.5) // 0.5h 前活动 < 12h 阈值
    const r = await buildWakeChain(root, IN_PROCESS_OK, beijingUtcMs(2), biasOk)
    expect(r.verdict).toBe('waiting')
    expect(r.waiting[0]).toContain('等待中')
    expect(r.judgement).not.toContain('✅')
  })

  it('`✗` = 配置/环境问题（需人改）——给出修复建议；`⏸` 与 `✗` 分开呈现', async () => {
    writeConfig({ ...OK_CFG, enabled: false, session: undefined })
    makeSession('2026-09-01--S151--x--auto', beijingUtcMs(12), 24) // 同时处于高峰 → ⏸ 与 ✗ 并存
    const r = await buildWakeChain(root, IN_PROCESS_OK, beijingUtcMs(12), biasOk)
    expect(r.verdict).toBe('blocked')
    expect(r.blockers.some((b) => b.includes('enabled = false'))).toBe(true)
    expect(r.blockers.some((b) => b.includes('session 未配置'))).toBe(true)
    expect(r.waiting).toHaveLength(1)
    expect(r.judgement).toContain('阻断点 2 项')
    expect(r.judgement).toContain('另 1 项等待中')
    // 建议行必须印出（旧脚本在 blocked 时才印 suggestions——语义保留）
    expect(renderWakeChain(r)).toContain('→ ')
  })

  it('建议行只在 blocked 时印出（waiting/ready 不刷建议）', async () => {
    writeConfig(OK_CFG)
    makeSession('2026-09-01--S151--x--auto', beijingUtcMs(12), 24)
    const r = await buildWakeChain(root, IN_PROCESS_OK, beijingUtcMs(12), biasOk)
    expect(renderWakeChain(r)).not.toContain('→ ')
  })
})

describe('autopilot-chain：进程内事实驱动（8 项分歧的判据在报告里显形）', () => {
  it('🔴 全局闸关 → `✗` 阻断（旧脚本看不到闸，此处会印 ✅）', async () => {
    writeConfig(OK_CFG)
    makeSession('2026-09-01--S151--x--auto', beijingUtcMs(2), 24)
    const r = await buildWakeChain(root, { ...IN_PROCESS_OK, globalGate: false }, beijingUtcMs(2), biasOk)
    expect(r.verdict).toBe('blocked')
    expect(r.blockers.some((b) => b.includes('周期自唤醒全局闸关闭'))).toBe(true)
    expect(renderWakeChain(r)).toContain('autopilotWakeEnabled')
  })

  it('🔴 目标 agent 未定位 → `✗`（含诊断文本）——旧脚本无此判据', async () => {
    writeConfig(OK_CFG)
    makeSession('2026-09-01--S151--x--auto', beijingUtcMs(2), 24)
    const r = await buildWakeChain(
      root,
      { globalGate: true, running: false, live: { sessionCount: 0, agentResolved: false, diagnosis: '目标 CCC 内无 live 会话' } },
      beijingUtcMs(2),
      biasOk,
    )
    expect(r.verdict).toBe('blocked')
    expect(r.blockers.some((b) => b.includes('agent 未定位'))).toBe(true)
    expect(renderWakeChain(r)).toContain('目标 CCC 内无 live 会话')
  })

  it('🔴 重入守卫：进行中 → `⏸`（等待中，非配置问题）——旧脚本无此判据', async () => {
    writeConfig(OK_CFG)
    makeSession('2026-09-01--S151--x--auto', beijingUtcMs(2), 24)
    const r = await buildWakeChain(root, { ...IN_PROCESS_OK, running: true }, beijingUtcMs(2), biasOk)
    expect(r.verdict).toBe('waiting')
    expect(r.waiting.some((w) => w.includes('已有一轮唤起在进行中'))).toBe(true)
    expect(r.judgement).not.toContain('✅')
  })

  it('agentResolved=null（目标未命中）→ 只报会话数，不误判为"未定位"', async () => {
    writeConfig({ ...OK_CFG, session: 'S999' })
    makeSession('2026-09-01--S151--x--auto', beijingUtcMs(2), 24)
    const r = await buildWakeChain(
      root,
      { globalGate: true, running: false, live: { sessionCount: 1, agentResolved: null, diagnosis: null } },
      beijingUtcMs(2),
      biasOk,
    )
    expect(r.blockers.some((b) => b.includes('session=S999 未命中'))).toBe(true)
    expect(renderWakeChain(r)).toContain('agent 可解析性不适用')
  })
})

describe('autopilot-chain：离线通道（NO_RUNTIME_FACTS）', () => {
  it('🔴 离线永不印 ✅：三项不可知照实标 `?`，判 `unknown` 并指向进程内判定', async () => {
    writeConfig(OK_CFG)
    makeSession('2026-09-01--S151--x--auto', beijingUtcMs(2), 24)
    const r = await buildWakeChain(root, NO_RUNTIME_FACTS, beijingUtcMs(2), biasOk)
    expect(r.verdict).toBe('unknown')
    expect(r.unknowns).toHaveLength(3) // 全局闸 / live 运行态 / 重入守卫
    expect(r.judgement).toContain('? 已知条件全部满足')
    expect(r.judgement).not.toContain('✅')
    expect(renderWakeChain(r)).not.toContain('✅ 唤起条件全部满足')
    expect(renderWakeChain(r)).toContain('不可知项：3 项')
  })

  it('离线仍如实报配置问题（不可知 ≠ 免检）', async () => {
    writeConfig({ ...OK_CFG, enabled: false })
    makeSession('2026-09-01--S151--x--auto', beijingUtcMs(2), 24)
    const r = await buildWakeChain(root, NO_RUNTIME_FACTS, beijingUtcMs(2), biasOk)
    expect(r.verdict).toBe('blocked')
    expect(r.blockers.some((b) => b.includes('enabled = false'))).toBe(true)
  })

  it('无配置 CCC：未配置 `✗` + 其余条件照常评估（不因缺段而中断报告）', async () => {
    const r = await buildWakeChain(root, NO_RUNTIME_FACTS, beijingUtcMs(2), biasOk)
    expect(r.verdict).toBe('blocked')
    expect(r.blockers.some((b) => b.includes('trajectory.autopilot 未配置'))).toBe(true)
  })
})

describe('autopilot-chain：其余逐条件（与 tick 判据同源）', () => {
  it('会话目录缺 --auto 标志 → `✗`', async () => {
    writeConfig(OK_CFG)
    makeSession('2026-09-01--S151--x', beijingUtcMs(2), 24)
    const r = await buildWakeChain(root, IN_PROCESS_OK, beijingUtcMs(2), biasOk)
    expect(r.blockers.some((b) => b.includes('无 --auto 标志'))).toBe(true)
  })

  it('偏见脚本不可运行 → `✗`（含修复建议）', async () => {
    writeConfig(OK_CFG)
    makeSession('2026-09-01--S151--x--auto', beijingUtcMs(2), 24)
    const r = await buildWakeChain(root, IN_PROCESS_OK, beijingUtcMs(2), biasFail)
    expect(r.verdict).toBe('blocked')
    expect(r.blockers.some((b) => b.includes('偏见脚本: 未实现偏见脚本'))).toBe(true)
    expect(renderWakeChain(r)).toContain('container_admin autopilot init 生成模板')
  })

  it('旧键配置（autopilotTrajectory）同样被读到——报告与 tick 读同一回退链', async () => {
    writeConfig(OK_CFG, 'autopilotTrajectory')
    makeSession('2026-09-01--S151--x--auto', beijingUtcMs(2), 24)
    const r = await buildWakeChain(root, IN_PROCESS_OK, beijingUtcMs(2), biasOk)
    expect(r.verdict).toBe('ready')
  })

  it('报告头部含 CCC 名与根路径（多 CCC 扫描时可区分）', async () => {
    writeConfig(OK_CFG)
    makeSession('2026-09-01--S151--x--auto', beijingUtcMs(2), 24)
    const r = await buildWakeChain(root, IN_PROCESS_OK, beijingUtcMs(2), biasOk)
    expect(r.lines[0]).toContain('自主轨迹唤起诊断')
    expect(r.lines[0]).toContain(root)
    expect(r.root).toBe(root)
  })
})
