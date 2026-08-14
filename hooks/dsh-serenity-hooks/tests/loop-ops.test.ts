import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildRoundPrompt, loopProgressPaths, newStopToken, readProgress, splitModel, writeProgress } from '../src/loop-ops.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'loop-ops-'))
  writeFileSync(join(dir, '.serenity'), 'test')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('loop-ops: 进度读写（续跑）', () => {
  it('writeProgress 写 md + json；readProgress 读回', () => {
    writeProgress(dir, 'scan', { round: 3, done: false, label: 'scan', model: 'minimax-cn-coding-plan/MiniMax-M3', updated: 't', lastResponse: '做了 X' })
    const { md, json } = loopProgressPaths(dir, 'scan')
    expect(existsSync(md)).toBe(true)
    expect(existsSync(json)).toBe(true)
    const p = readProgress(dir, 'scan')
    expect(p!.round).toBe(3)
    expect(p!.lastResponse).toContain('X')
    expect(readFileSync(json, 'utf-8')).toContain('MiniMax-M3')
  })

  it('无进度返回 null', () => {
    expect(readProgress(dir, 'nope')).toBeNull()
  })
})

describe('loop-ops: 模型解析与 stop token', () => {
  it('splitModel：provider/model 与 model-only', () => {
    expect(splitModel('minimax-cn-coding-plan/MiniMax-M3')).toEqual({ provider: 'minimax-cn-coding-plan', model: 'MiniMax-M3' })
    expect(splitModel('deepseek-v4-flash')).toEqual({ provider: undefined, model: 'deepseek-v4-flash' })
  })

  it('stop token 唯一且长', () => {
    const a = newStopToken()
    const b = newStopToken()
    expect(a).not.toBe(b)
    expect(a.startsWith('SERENITY_LOOP_DONE_')).toBe(true)
  })
})

describe('loop-ops: 轮次 prompt', () => {
  it('第一轮 vs 续跑轮（不重做）', () => {
    const base = { root: dir, session: 'S101', label: 'scan', round: 2, stopToken: 'TOK' }
    const first = buildRoundPrompt({ ...base, progress: null })
    expect(first).toContain('round 2')
    expect(first).toContain('这是第一轮')
    const resume = buildRoundPrompt({ ...base, progress: { round: 1, done: false, label: 'scan', model: 'm', updated: 't', lastResponse: '已扫描 10 个' } })
    expect(resume).toContain('绝不重做已完成工作')
    expect(resume).toContain('TOK')
  })
})
