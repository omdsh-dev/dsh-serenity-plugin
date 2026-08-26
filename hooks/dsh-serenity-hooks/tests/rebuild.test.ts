import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('@deepseek-ai/dsh-tools', () => ({
  defineTool: (opts: unknown) => opts,
}))
vi.mock('@deepseek-ai/dsh-llm', () => ({
  createUserMessage: (o: unknown) => o,
}))
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
  return { default: { object: (s: unknown) => s, array: () => chain, string: () => chain, boolean: () => chain, number: () => chain } }
})
vi.mock('@deepseek-ai/dsh-settings', () => ({
  installSettingsSection: () => {},
  settingsNamespace: (v: string) => v,
}))

import { archiveSessionNow, buildRebuildAnchor, ARCHIVE_DIR } from '../src/rebuild.js'
import { rebuildReminderText, readContextPressure } from '../src/seams/keeper.js'
import { createSession } from '../src/session-ops.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hooks-rebuild-'))
  writeFileSync(join(dir, '.serenity'), 'test')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('F2: archiveSessionNow（立即归档，跳过 grace）', () => {
  it('创建会话 → 立即归档（SESSION.md 标记 completed + 移 _archived/）', () => {
    const s = createSession({ root: dir, desc: 'old-work', dryRun: false })
    const dest = archiveSessionNow(dir, s.dirName)
    expect(dest).not.toBeNull()
    expect(dest).toContain(ARCHIVE_DIR)
    // 原目录已移动
    expect(existsSync(s.sessionPath)).toBe(false)
    expect(existsSync(join(dir, 'AGENT_SESSIONS', ARCHIVE_DIR, s.dirName, 'SESSION.md'))).toBe(true)
    // SESSION.md 标记 completed + 关闭记录
    const md = readFileSync(join(dir, 'AGENT_SESSIONS', ARCHIVE_DIR, s.dirName, 'SESSION.md'), 'utf-8')
    expect(md).toContain('[x] 已完成')
    expect(md).toContain('关闭')
  })

  it('按 S### 编号归档', () => {
    const s = createSession({ root: dir, desc: 'old-work', dryRun: false })
    const dest = archiveSessionNow(dir, s.sessionId)
    expect(dest).toContain(ARCHIVE_DIR)
  })

  it('不存在 → null（不抛错）', () => {
    expect(archiveSessionNow(dir, 'S999')).toBeNull()
  })
})

describe('F2: buildRebuildAnchor（锚点消息）', () => {
  it('含 SESSION.md 路径 + 归档位置 + 重建指令', () => {
    const anchor = buildRebuildAnchor(dir, '2026-08-26--S001--old-work', '继续 x 任务')
    expect(anchor).toContain('[SESSION-REBUILD]')
    expect(anchor).toContain('AGENT_SESSIONS/_archived/2026-08-26--S001--old-work')
    expect(anchor).toContain('SESSION.md')
    expect(anchor).toContain('继续 x 任务')
    expect(anchor).toContain('读取旧会话的 SESSION.md')
  })

  it('无 note 时不含背景行', () => {
    const anchor = buildRebuildAnchor(dir, 'd', undefined)
    expect(anchor).not.toContain('重建背景')
  })
})

describe('F2: rebuildReminderText（轨迹跟踪器提示，v1.22.1 命名）', () => {
  it('含占用比例 + 持久轨迹/临时副本语义 + session_rebuild 引导', () => {
    const t = rebuildReminderText(0.93)
    expect(t).toContain('[TRAJECTORY]')
    expect(t).toContain('93%')
    expect(t).toContain('SESSION.md 是持久轨迹')
    expect(t).toContain('临时可重建')
    expect(t).toContain('session_rebuild')
  })
})

describe('F2: readContextPressure（投影读取）', () => {
  it('sessionProjections 未装配 → null', () => {
    const ctx = { get: () => undefined } as never
    expect(readContextPressure(ctx, { id: 's' })).toBeNull()
  })

  it('装配且有 contextPressure → 读取值', () => {
    const ctx = {
      get: (name: string) => name === 'sessionProjections'
        ? { snapshot: () => ({ values: { contextPressure: { projectedTokens: 900, contextWindow: 1000 } } }) }
        : undefined,
    } as never
    const r = readContextPressure(ctx, { id: 's' })
    expect(r).toEqual({ projectedTokens: 900, contextWindow: 1000 })
  })

  it('无 contextWindow → 返回 { projectedTokens, contextWindow: undefined }（调用方判窗口）', () => {
    const ctx = {
      get: (name: string) => name === 'sessionProjections'
        ? { snapshot: () => ({ values: { contextPressure: { projectedTokens: 900 } } }) }
        : undefined,
    } as never
    const r = readContextPressure(ctx, { id: 's' })
    expect(r).toEqual({ projectedTokens: 900, contextWindow: undefined })
  })
})
