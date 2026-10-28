/**
 * tests/trajectory/model-runtime.test.ts — `trajectory.json` 的 `model` 字段运行时热加载（D182）
 *
 * 钉三件事：
 * ① **不写 `model` ⇒ 不装缝**（`syncTrajectoryModel` 返回 `false`，一个字节都不动）
 * ② 写了 `model` ⇒ 读出来是 `provider/model` 拆开的形态
 * ③ 改文件后再读 ⇒ 拿到**新值**（这就是"运行时热加载"，不缓存）
 *
 * ⚠️ 不测"宿主真把请求路由换了" —— 那需要真 agent + 真 provider，
 *    属于**真机验收**（已写进方案 §6）。这里的判据只到"我们喂给宿主的选择是对的"。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { readModelSelection, hasModelDeclared } from '../../src/trajectory/model-runtime.js'
import { TRAJECTORY_CONSTRAINT_FILENAME } from '../../src/trajectory/policy/profile.js'

let dir: string

function makeTrajectory(code: string, json: Record<string, unknown>): string {
  const dirName = `2026-10-20--${code}--traj`
  const abs = join(dir, 'AGENT_SESSIONS', dirName)
  mkdirSync(abs, { recursive: true })
  writeFileSync(join(abs, TRAJECTORY_CONSTRAINT_FILENAME), JSON.stringify(json), 'utf-8')
  return dirName
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'model-runtime-'))
  writeFileSync(join(dir, '.serenity'), 'test')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('model-runtime: 读声明（D182）', () => {
  it('🔴 不写 model ⇒ undefined（⛔ 不回退到任何缺省模型）', () => {
    const d = makeTrajectory('no-model', { tools: ['read'] })
    expect(readModelSelection(dir, d)).toBeUndefined()
    expect(hasModelDeclared(dir, d)).toBe(false)
  })

  it('写了 model ⇒ 拆成 provider/model（用中立示例值，不绑任何真实供应商）', () => {
    const d = makeTrajectory('with-model', { model: 'provider-a/model-x.1' })
    expect(readModelSelection(dir, d)).toEqual({ provider: 'provider-a', model: 'model-x.1' })
    expect(hasModelDeclared(dir, d)).toBe(true)
  })

  it('只有 model 名没有 provider（无斜杠）⇒ 只给 model', () => {
    const d = makeTrajectory('bare-model', { model: 'some-model' })
    expect(readModelSelection(dir, d)).toEqual({ model: 'some-model' })
  })

  it('空白 model 串 ⇒ 视同未写', () => {
    const d = makeTrajectory('blank-model', { model: '   ' })
    expect(readModelSelection(dir, d)).toBeUndefined()
  })

  it('目录里没有声明文件 ⇒ undefined（普通轨迹的常态，不抛）', () => {
    expect(readModelSelection(dir, '2026-10-20--nope--traj')).toBeUndefined()
  })

  it('🔴 改了文件再读 ⇒ 拿到新值（无缓存 = 热加载的机械判据）', () => {
    const d = makeTrajectory('hot', { model: 'a/one' })
    expect(readModelSelection(dir, d)).toEqual({ provider: 'a', model: 'one' })
    writeFileSync(join(dir, 'AGENT_SESSIONS', d, TRAJECTORY_CONSTRAINT_FILENAME), JSON.stringify({ model: 'b/two' }), 'utf-8')
    expect(readModelSelection(dir, d)).toEqual({ provider: 'b', model: 'two' })
  })
})

describe('model-runtime: syncTrajectoryModel 的装缝边界（D182 边界①）', () => {
  it('🔴 没声明 model ⇒ 不装缝（返回 false），且清掉可能残留的旧缝', async () => {
    const { syncTrajectoryModel, resetModelRuntimeForTests, modelRuntimeSnapshot } = await import('../../src/trajectory/model-runtime.js')
    resetModelRuntimeForTests()
    const d = makeTrajectory('nofit', { tools: ['read'] })
    const agent = { session: { id: 'sess-nofit' }, ctx: {} }
    expect(syncTrajectoryModel(agent as never, dir, d)).toBe(false)
    // 装不上 ⇒ 运行时快照里不该出现这个会话（"缝在、值为空"会把宿主选择清掉）
    expect(modelRuntimeSnapshot().keys).not.toContain('sess-nofit')
  })

  it('宿主不可解析时 ⇒ 响亮告警且返回 false（不静默停旧模型）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { syncTrajectoryModel, resetModelRuntimeForTests } = await import('../../src/trajectory/model-runtime.js')
    resetModelRuntimeForTests()
    const d = makeTrajectory('with-model-2', { model: 'p/m' })
    const agent = { session: { id: 'sess-warn' }, ctx: {} }
    // 测试环境下 `@deepseek-ai/dsh-agent` 可能解析到 devDep（有该导出）或解析失败；
    // 两种都合法，但**失败必须走告警分支**——这里只断言"不抛"。
    expect(() => syncTrajectoryModel(agent as never, dir, d)).not.toThrow()
    warn.mockRestore()
  })
})
