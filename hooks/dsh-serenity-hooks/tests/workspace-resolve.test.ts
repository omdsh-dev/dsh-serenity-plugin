import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveWorkspaceCore } from '../src/api.js'

let dir: string
let cccDir: string
let nonCccDir: string

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'ws-resolve-'))
  dir = base
  cccDir = join(base, 'ccc')
  nonCccDir = join(base, 'plain')
  mkdirSync(cccDir, { recursive: true })
  writeFileSync(join(cccDir, '.serenity'), 'test')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('resolveWorkspaceCore（远程状态显示修复 v1.22.2）', () => {
  it('sessionCwd 优先', () => {
    const r = resolveWorkspaceCore(cccDir, '/other', () => [], '/fallback')
    expect(r).toBe(cccDir)
  })

  it('workspace 参数次之', () => {
    const r = resolveWorkspaceCore(undefined, nonCccDir, () => [], '/fallback')
    expect(r).toBe(nonCccDir)
  })

  it('无 sessionId/workspace → 遍历 live sessions 找 CCC 会话（远程访问修复）', () => {
    // 会话列表含非 CCC + CCC——应选中 CCC（不再回退 $HOME 显示未激活）
    const r = resolveWorkspaceCore(undefined, undefined, () => [nonCccDir, cccDir], '/home/user')
    expect(r).toBe(cccDir)
  })

  it('遍历无 CCC 会话 → 回退 fallback（进程 cwd）', () => {
    const r = resolveWorkspaceCore(undefined, undefined, () => [nonCccDir], '/home/user')
    expect(r).toBe('/home/user')
  })

  it('空会话列表 → 回退 fallback', () => {
    const r = resolveWorkspaceCore(undefined, undefined, () => [], '/home/user')
    expect(r).toBe('/home/user')
  })

  it('sessionCwd 存在但非 CCC → 仍用它（显式会话优先，不遍历）', () => {
    const r = resolveWorkspaceCore(nonCccDir, undefined, () => [cccDir], '/home/user')
    expect(r).toBe(nonCccDir)
  })
})

/**
 * 🔴🔴 2026-10-18（owner 报的真缺陷）：「为什么我在别的 CCC 点开显示的还是我们 home-serenity 的信息」
 *
 * 根因：旧实现的第 ③ 步是「遍历 live sessions 找**第一个** CCC 会话的 cwd」——
 * 那是**跨工作区猜测**。只要 sessionId 缺失或那条会话查不到（ACP/skiff 会话、
 * 尚未 materialize 的会话、远程访问），它就静默返回**另一个 CCC** 的路径 ⇒
 * 面板把别人的轨迹/技能/safe-mode 当成本工作区的显示出来。
 *
 * 🔴 为什么这比"显示未激活"危险得多：用户会**据此做判断**
 * （以为自己的 safe-mode 开着、以为那些轨迹是自己的）。
 * ⇒ 与本仓对"跨轨迹猜测"的既有裁决一致：**多候选不许猜，响亮失败优于静默接错**
 *   （先例 = `rebuild.ts` 移除 `findLatestActiveSessionMd` 那条约定回退）。
 */
describe('resolveWorkspaceCore：多 CCC 共存时**不跨区猜测**（2026-10-18 缺陷）', () => {
  it('🔴 负控：两个不同 CCC 的 live 会话 ⇒ 回退 fallback（**不挑其中任何一个**）', () => {
    const cccA = join(dir, 'ccc-a')
    const cccB = join(dir, 'ccc-b')
    mkdirSync(cccA, { recursive: true })
    mkdirSync(cccB, { recursive: true })
    writeFileSync(join(cccA, '.serenity'), 'a')
    writeFileSync(join(cccB, '.serenity'), 'b')

    const r = resolveWorkspaceCore(undefined, undefined, () => [cccA, cccB], '/fallback')
    expect(r, '多候选必须回退，绝不挑一个顶替（那正是"看到别人信息"的成因）').toBe('/fallback')
    expect(r).not.toBe(cccA)
    expect(r).not.toBe(cccB)
  })

  it('🔴 负控：同一 CCC 的多个会话（路径不同）⇒ 仍算**一个**根，可以采用', () => {
    // 判据按 **CCC 根**去重，而不是按 cwd 字符串去重 ——
    // 否则"同一个 CCC 开了三条会话"会被误判成"三个候选"，退化成恒不兜底。
    const sub1 = join(cccDir, 'packages', 'a')
    const sub2 = join(cccDir, 'packages', 'b')
    mkdirSync(sub1, { recursive: true })
    mkdirSync(sub2, { recursive: true })
    const r = resolveWorkspaceCore(undefined, undefined, () => [sub1, sub2], '/fallback')
    expect(r, '同根多会话 ⇒ 唯一 CCC ⇒ 可以兜底').toBe(cccDir)
  })

  it('单 CCC 仍照旧兜底（v1.22.2 要救的场景不得退化）', () => {
    const r = resolveWorkspaceCore(undefined, undefined, () => [nonCccDir, cccDir], '/home/user')
    expect(r).toBe(cccDir)
  })
})
