/**
 * trajectory/policy/files.ts 的单测 —— **文件名族**（owner 2026-10-19 裁 Q2：短名 `trajectory.json`）
 *
 * ## 这个模块守的是什么
 *
 * 一条轨迹目录里，"ACC 自有声明"原来散在三个文件（约束面 / 旧标识 / 机器绑定），
 * 现在收拢进一个 `trajectory.json`。**收拢的风险全在读侧**：只要有一条读取路径还写死旧名，
 * 就会出现"某些轨迹读得到、某些读不到"——而症状（"我的约束没生效"）与真因（"文件名对不上"）
 * 在读数上完全不像。本轨已两次栽在这上面（`skiff.json` → `trajectory-constraint.json` 那次）。
 *
 * ⇒ 本文件的判据核心只有一条：**认族，不认当前叫什么**。
 *
 * ## 判据纪律
 * · 每个"找不到"都配一个"找到"的正控（否则分不清"逻辑对"与"恒返回 null"）；
 * · 断言看的是**返回的到底是族里哪个文件**，不只是"非 null"；
 * · 坏输入（坏 JSON / 顶层非对象）必须**与"没有文件"分开**：调用方对两者的降级不同。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  findTrajectoryFile,
  readTrajectoryFile,
  TRAJECTORY_FILENAME,
  TRAJECTORY_FILENAME_FAMILY,
  TRAJECTORY_LEGACY_FILENAMES,
} from '../src/trajectory/policy/files.js'

let dir = ''
let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'traj-files-'))
  dir = join(root, 'AGENT_SESSIONS', '2026-10-19--qa--traj')
  mkdirSync(dir, { recursive: true })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 在轨迹目录里铺一个文件 */
function put(name: string, content: string): void {
  writeFileSync(join(dir, name), content, 'utf-8')
}

describe('文件名族（认族，不认"当前叫什么"）', () => {
  it('族里有三代名字，新名排第一（= 写入目标）', () => {
    expect(TRAJECTORY_FILENAME).toBe('trajectory.json')
    expect(TRAJECTORY_FILENAME_FAMILY[0]).toBe(TRAJECTORY_FILENAME)
    expect(TRAJECTORY_FILENAME_FAMILY).toContain('trajectory-constraint.json')
    expect(TRAJECTORY_FILENAME_FAMILY).toContain('skiff.json')
  })

  it('旧名清单 = 族去掉新名（两者不重叠、不遗漏）', () => {
    expect(TRAJECTORY_LEGACY_FILENAMES).toEqual([...TRAJECTORY_FILENAME_FAMILY].slice(1))
    expect(TRAJECTORY_LEGACY_FILENAMES).not.toContain(TRAJECTORY_FILENAME)
  })
})

describe('findTrajectoryFile：返回族里**第一个**存在的（顺序即优先级）', () => {
  it('🟢 正控：只有新名 ⇒ 返回新名', () => {
    put(TRAJECTORY_FILENAME, '{}')
    expect(findTrajectoryFile(dir)).toBe(join(dir, TRAJECTORY_FILENAME))
  })

  it('只有旧名（v1.74 代）⇒ 仍能命中（**不硬切**：存量轨迹必须还能读）', () => {
    put('trajectory-constraint.json', '{}')
    expect(findTrajectoryFile(dir)).toBe(join(dir, 'trajectory-constraint.json'))
  })

  it('只有更旧的 `skiff.json` ⇒ 仍能命中（两代前的名字也在族里）', () => {
    put('skiff.json', '{}')
    expect(findTrajectoryFile(dir)).toBe(join(dir, 'skiff.json'))
  })

  it('🔴 新老都在 ⇒ **新名优先**（否则写入新名之后，旧文件会永久遮蔽它）', () => {
    put(TRAJECTORY_FILENAME, '{}')
    put('trajectory-constraint.json', '{}')
    expect(findTrajectoryFile(dir)).toBe(join(dir, TRAJECTORY_FILENAME))
  })

  it('🔴 新名不在、两个旧名都在 ⇒ 取 v1.74 那个（族内顺序，不是文件系统顺序）', () => {
    put('skiff.json', '{}')
    put('trajectory-constraint.json', '{}')
    expect(findTrajectoryFile(dir)).toBe(join(dir, 'trajectory-constraint.json'))
  })

  it('🔴 一个都没有 ⇒ `null`（普通轨迹，**常态不是错误**）', () => {
    expect(findTrajectoryFile(dir)).toBeNull()
  })

  it('目录本身不存在 ⇒ `null`，不抛', () => {
    expect(findTrajectoryFile(join(root, 'no-such-dir'))).toBeNull()
  })
})

describe('readTrajectoryFile：三种结局**必须分开**（调用方降级方式不同）', () => {
  it('🟢 有合法文件 ⇒ `{file, data, error:null}`，且 file 指出**是族里哪个**', () => {
    put(TRAJECTORY_FILENAME, JSON.stringify({ model: 'm/M3', tools: ['read'] }))
    const r = readTrajectoryFile(dir)!
    expect(r.file).toBe(join(dir, TRAJECTORY_FILENAME))
    expect(r.error).toBeNull()
    expect(r.data).toEqual({ model: 'm/M3', tools: ['read'] })
  })

  it('旧名也能读出内容（正控：族内任一都走同一解析）', () => {
    put('trajectory-constraint.json', JSON.stringify({ tools: ['grep'] }))
    const r = readTrajectoryFile(dir)!
    expect(r.file).toBe(join(dir, 'trajectory-constraint.json'))
    expect(r.data).toEqual({ tools: ['grep'] })
  })

  it('🔴 无文件 ⇒ **`null`**（不是 `{data:null}` —— 两者对调用方是不同的事）', () => {
    expect(readTrajectoryFile(dir)).toBeNull()
  })

  it('🔴 坏 JSON ⇒ `{file, data:null, error}`：**文件在**，只是读不懂', () => {
    put(TRAJECTORY_FILENAME, '{ 这不是 JSON')
    const r = readTrajectoryFile(dir)!
    expect(r.file).toBe(join(dir, TRAJECTORY_FILENAME))
    expect(r.data).toBeNull()
    expect(r.error).toContain('JSON 解析失败')
  })

  it('🔴 顶层不是对象（裸数组 / 数字 / 字符串 / null）⇒ 同样归为"读不懂"，与无文件分开', () => {
    for (const body of ['[1,2,3]', '42', '"str"', 'null']) {
      put(TRAJECTORY_FILENAME, body)
      const r = readTrajectoryFile(dir)!
      expect(r.data, `顶层 ${body} 不得被当成合法声明`).toBeNull()
      expect(r.error, `顶层 ${body} 必须报"不是对象"`).toContain('顶层不是对象')
    }
  })

  it('🔴 空对象 `{}` 是**合法**声明（不是错误）：文件在、内容就是一个空约束面', () => {
    put(TRAJECTORY_FILENAME, '{}')
    const r = readTrajectoryFile(dir)!
    expect(r.error).toBeNull()
    expect(r.data).toEqual({})
  })
})
