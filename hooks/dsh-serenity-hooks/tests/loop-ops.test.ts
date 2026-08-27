import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildRoundPrompt, loopProgressPaths, LOOP_GUIDE, listActiveLoops, newStopToken, readProgress, sanitizeLabel, splitModel, writeProgress } from '../src/loop-ops.js'

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
    expect(first).toContain('first round')
    const resume = buildRoundPrompt({ ...base, progress: { round: 1, done: false, label: 'scan', model: 'm', updated: 't', lastResponse: '已扫描 10 个' } })
    expect(resume).toContain('never redo completed work')
    expect(resume).toContain('TOK')
  })

  it('prompt EAP 化：固定详尽结构 + 阅读/文字编写类加载 eap 指令（v1.23.0 英化）', () => {
    const p = buildRoundPrompt({ root: dir, label: 'docs', round: 1, stopToken: 'TOK', task: '阅读整理文档' })
    expect(p).toContain('## Work rules (fixed every round, must follow)')
    expect(p).toContain('reading/curating or text-writing work')
    expect(p).toContain('load eap (acc-eap skill)')
    expect(p).toContain('E↑ Explicit')
    expect(p).toContain('R↓ Reconstructable')
    expect(p).toContain('S↑ Stable')
    expect(p).toContain('## Per-round report (fixed format, answer each item)')
    expect(p).toContain('output only TOK')
  })
})

describe('loop-ops: guide 指引 + 运行状态列表（WebUI 等待界面数据源）', () => {
  it('LOOP_GUIDE 含 eap 要求 / 并行策略 / 提示词规范 / 阅读类加载 eap（v1.23.0 英化）', () => {
    expect(LOOP_GUIDE).toContain('load eap and design the plan')
    expect(LOOP_GUIDE).toContain('Task decomposition (E↑ Explicit)')
    expect(LOOP_GUIDE).toContain('Parallel strategy (scale-up)')
    expect(LOOP_GUIDE).toContain('Background subagents')
    expect(LOOP_GUIDE).toContain('workflow')
    expect(LOOP_GUIDE).toContain('Concurrency safety guaranteed')
    expect(LOOP_GUIDE).toContain('loop-internal agent is also required to load eap')
    expect(LOOP_GUIDE).toContain('The only completion condition = the loop-internal agent echoes')
  })

  it('listActiveLoops 列出进度文件（按 updated 倒序；坏文件跳过）', () => {
    expect(listActiveLoops(dir)).toEqual([])
    mkdirSync(join(dir, 'AGENT_SESSIONS'), { recursive: true })
    // 直接写控制 updated 的进度文件（writeProgress 用实时时间戳，排序不可控）
    writeFileSync(
      join(dir, 'AGENT_SESSIONS', 'loop-a.json'),
      JSON.stringify({ round: 2, done: true, label: 'a', model: 'm2', updated: '2026-08-14T10:00:02.000Z', lastResponse: '做 A' }),
      'utf-8',
    )
    writeFileSync(
      join(dir, 'AGENT_SESSIONS', 'loop-b.json'),
      JSON.stringify({ round: 1, done: false, label: 'b', model: 'm1', updated: '2026-08-14T10:00:01.000Z', lastResponse: '做 B' }),
      'utf-8',
    )
    writeFileSync(join(dir, 'AGENT_SESSIONS', 'loop-broken.json'), '{ bad', 'utf-8')
    const loops = listActiveLoops(dir)
    expect(loops).toHaveLength(2)
    expect(loops[0]!.label).toBe('a') // updated 更新在前
    expect(loops[1]!.label).toBe('b')
    expect(loops[0]!.done).toBe(true)
    expect(loops[1]!.done).toBe(false)
  })

  it('sanitizeLabel 脱敏 Windows 非法字符（审计问题 17）', () => {
    expect(sanitizeLabel('sqc: scan/v2')).toBe('sqc- scan-v2')
    expect(sanitizeLabel('ok label')).toBe('ok label')
    expect(sanitizeLabel('a?b*c:d')).toBe('a-b-c-d')
    expect(sanitizeLabel('a.b.')).toBe('a.b')
    expect(sanitizeLabel('x'.repeat(80))).toHaveLength(50)
    // loopProgressPaths 用清洗后的 label
    const p = loopProgressPaths(dir, 'a:b/c')
    expect(p.json).toContain('loop-a-b-c.json')
  })
})
