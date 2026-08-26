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
    const r = resolveWorkspaceCore(undefined, undefined, () => [nonCccDir, cccDir], '/home/yh')
    expect(r).toBe(cccDir)
  })

  it('遍历无 CCC 会话 → 回退 fallback（进程 cwd）', () => {
    const r = resolveWorkspaceCore(undefined, undefined, () => [nonCccDir], '/home/yh')
    expect(r).toBe('/home/yh')
  })

  it('空会话列表 → 回退 fallback', () => {
    const r = resolveWorkspaceCore(undefined, undefined, () => [], '/home/yh')
    expect(r).toBe('/home/yh')
  })

  it('sessionCwd 存在但非 CCC → 仍用它（显式会话优先，不遍历）', () => {
    const r = resolveWorkspaceCore(nonCccDir, undefined, () => [cccDir], '/home/yh')
    expect(r).toBe(nonCccDir)
  })
})
