/**
 * trajectory/prompt.ts —— **轨迹提示词**（Trajectory Prompt）的单测。
 *
 * 概念：一条轨迹"是谁、按什么章程工作"的可编辑声明，落在 `<轨迹目录>/PROMPT.md`。
 * owner 2026-10-19 定向：「建立轨迹提示词概念来代替人格」。
 *
 * 本文件钉住四件事（都是这条机制最容易静默坏掉的格子）：
 *  ① **存在即生效、删掉即失效**（无缓存的错误态）；
 *  ② **改文件即热重载**（mtime 变化后读到新内容）；
 *  ③ **兼容期优先级**：`PROMPT.md` 优先于旧 `systemPromptFile`，且两者都给时**不叠加**；
 *  ④ **失败语义**：读不到 ⇒ 空串（不是错误），读坏了 ⇒ 沿用上次成功内容。
 *
 * ⚠️ 隐私纪律（D145）：夹具里不写任何真实角色名／路径／人名。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  TRAJECTORY_PROMPT_FILENAME,
  trajectoryPromptPath,
  resolveTrajectoryPrompt,
  createTrajectoryPromptReader,
  trajectoryPromptBlock,
  hasTrajectoryPrompt,
} from '../src/trajectory/prompt.js'

let root = ''
const DIR = '2026-01-01--probe--示例'

function writePrompt(text: string): void {
  const dir = join(root, 'AGENT_SESSIONS', DIR)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, TRAJECTORY_PROMPT_FILENAME), text)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'traj-prompt-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('路径与存在性（判据就是文件存在）', () => {
  it('路径固定在轨迹目录下（与 SESSION.md 同处，故 archive 时跟着走）', () => {
    expect(trajectoryPromptPath(root, DIR)).toBe(join(root, 'AGENT_SESSIONS', DIR, TRAJECTORY_PROMPT_FILENAME))
  })

  it('hasTrajectoryPrompt：没有 ⇒ false；写了 ⇒ true（无文件是常态，不是异常）', () => {
    expect(hasTrajectoryPrompt(root, DIR)).toBe(false)
    writePrompt('我是谁')
    expect(hasTrajectoryPrompt(root, DIR)).toBe(true)
  })
})

describe('resolveTrajectoryPrompt —— 一次性解析与优先级', () => {
  it('无 PROMPT.md、无旧字段 ⇒ 空串 / source=none（不是错误）', () => {
    const r = resolveTrajectoryPrompt(root, DIR)
    expect(r.text).toBe('')
    expect(r.source).toBe('none')
    expect(r.path).toBeNull()
  })

  it('PROMPT.md 存在 ⇒ 以它为准，source=trajectory-file', () => {
    writePrompt('  这是章程正文  ')
    const r = resolveTrajectoryPrompt(root, DIR)
    expect(r.text).toBe('这是章程正文') // trim
    expect(r.source).toBe('trajectory-file')
    expect(r.path).toBe(trajectoryPromptPath(root, DIR))
  })

  it('🔴 两者都给 ⇒ PROMPT.md 胜（旧字段不得叠加，否则同一份章程注入两遍）', () => {
    writePrompt('新章程')
    const r = resolveTrajectoryPrompt(root, DIR, {
      dirName: DIR, code: 'probe', path: '/dev/null',
      tools: [], msms: [], cognitiveTrajectory: { session: true, keeper: true, rebuild: true },
      systemPrompt: '旧内嵌章程',
    })
    expect(r.text).toBe('新章程')
    expect(r.source).toBe('trajectory-file')
  })

  it('只有旧内嵌 systemPrompt ⇒ 兼容期仍认（source=轨迹约束-legacy）', () => {
    const r = resolveTrajectoryPrompt(root, DIR, {
      dirName: DIR, code: 'probe', path: '/dev/null',
      tools: [], msms: [], cognitiveTrajectory: { session: true, keeper: true, rebuild: true },
      systemPrompt: '旧内嵌章程',
    })
    expect(r.text).toBe('旧内嵌章程')
    expect(r.source).toBe('轨迹约束-legacy')
  })
})

describe('createTrajectoryPromptReader —— 热路径（每轮调用）', () => {
  it('① 存在即生效；删掉即失效（回归钉：无缓存的错误态）', () => {
    writePrompt('第一版章程')
    const read = createTrajectoryPromptReader(root, DIR)
    expect(read()).toBe('第一版章程')
    rmSync(join(root, 'AGENT_SESSIONS', DIR, TRAJECTORY_PROMPT_FILENAME))
    // 🔴 删掉必须**立刻**回到空串 —— 这是"删掉 PROMPT.md 即恢复默认"的机制
    expect(read()).toBe('')
  })

  it('② 改文件即热重载（mtime 变化后读到新内容，不是首版快照）', () => {
    writePrompt('第一版')
    const read = createTrajectoryPromptReader(root, DIR)
    expect(read()).toBe('第一版')
    const p = join(root, 'AGENT_SESSIONS', DIR, TRAJECTORY_PROMPT_FILENAME)
    writeFileSync(p, '第二版')
    // 明确推 mtime（同秒内写入时 mtime 可能不变，那是测试环境问题不是被测对象问题）
    const future = new Date(Date.now() + 5000)
    utimesSync(p, future, future)
    expect(read()).toBe('第二版')
  })

  it('③ 缓存命中不重复告警/重载（同一次内容读两次结果一致）', () => {
    writePrompt('稳定内容')
    const read = createTrajectoryPromptReader(root, DIR)
    expect(read()).toBe('稳定内容')
    expect(read()).toBe('稳定内容')
  })

  it('④ 没有文件时返回空串且**不抛错**（普通轨迹常态）', () => {
    const read = createTrajectoryPromptReader(root, '2026-01-01--no-prompt--无章程')
    expect(read()).toBe('')
  })
})

describe('trajectoryPromptBlock —— 装配块（空内容 ⇒ 空串，宿主丢弃空块）', () => {
  it('空 ⇒ 空串（不产生噪声标题）', () => {
    expect(trajectoryPromptBlock('')).toBe('')
    expect(trajectoryPromptBlock('   \n  ')).toBe('')
  })

  it('非空 ⇒ 带固定标记头的块（可 grep、可让模型知道这是**自己的章程**）', () => {
    const block = trajectoryPromptBlock('我是这条轨迹。\n按这个章程工作。')
    expect(block).toContain('=== Serenity Trajectory Prompt ===')
    expect(block).toContain('我是这条轨迹。')
  })
})

describe('读取失败语义（不静默，但也不砖）', () => {
  it('文件变成目录（读失败）⇒ 沿用上次成功内容，并告警一次', () => {
    writePrompt('上次成功的章程')
    const read = createTrajectoryPromptReader(root, DIR)
    expect(read()).toBe('上次成功的章程')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // 把文件换成同名目录 ⇒ statSync 成功但 readUtf8 失败
    const p = join(root, 'AGENT_SESSIONS', DIR, TRAJECTORY_PROMPT_FILENAME)
    rmSync(p)
    mkdirSync(p)
    expect(read()).toBe('上次成功的章程') // ⛔ 绝不返回空：空提示词会让轨迹失去章程
    warn.mockRestore()
  })
})
