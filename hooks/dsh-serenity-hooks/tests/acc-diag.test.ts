/**
 * acc-diag.test.ts — 专属运行态诊断工具（v1.33，S142 §32.11）
 *
 * 覆盖三层：
 *  ① 判据：`readExclusiveTools`（声明 / 缺字段 / 损坏 JSON → fail-closed 空 / 非字符串过滤）
 *  ② 装配：`runAccDiag`（live 运行态 + 唤醒时钟 + 唤醒注册表；失败不吞）
 *  ③ 工具面：`createAccDiagTool`（名字 / 无参 / CCC 未解析时响亮 code / 报告三段齐）
 *
 * 可见性（`tools.restrict`）不在本文件覆盖——它属拦截缝，见 `guards.test.ts`
 * 的「专属工具条件可见」一组。
 *
 * 2026-09-15（ACC 侧 autopilot 退场，S142 §1 二阶裁定）：报告由四段降为三段
 * （① live 运行态 / ①b 唤醒时钟 / ③ 唤醒注册表）。原 ② 面板解析与 ④ 唤起条件链的主语
 * 随机制消失 ⇒ 本文件对应用例（④ 进程内判据、④ 未配置如实报告）**整组删除**，
 * 不保留、不改为 skip。④ 的诊断缺口已登记在 `src/diag-ops.ts` 文件头与基线 doc §1。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('@deepseek-ai/dsh-tools', () => ({ defineTool: (o: unknown) => o }))

import { readExclusiveTools } from '../src/ccc.js'
import { runAccDiag, renderAccDiag } from '../src/diag-ops.js'
import { createAccDiagTool } from '../src/tools/acc-diag.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'acc-diag-'))
  writeFileSync(join(dir, '.serenity'), 'test')
  mkdirSync(join(dir, 'AGENT_SESSIONS'), { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeCccConfig(value: unknown): void {
  mkdirSync(join(dir, '.opencode'), { recursive: true })
  writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify(value))
}

/** 最小 fake ctx：live 会话清单 + 无 agent（诊断必须容得下"定位不到"） */
function fakeCtx(liveSessions: Array<{ id: string; cwd: string | null }> = []): unknown {
  return {
    get: () => undefined,
    sessions: {
      list: () => liveSessions.map((s) => ({ id: s.id, header: { cwd: s.cwd }, events: [] })),
    },
  }
}

describe('acc-diag: readExclusiveTools（判据 fail-closed）', () => {
  it('声明了 ["acc-diag"] → 原样返回', () => {
    writeCccConfig({ exclusiveTools: ['acc-diag'] })
    expect(readExclusiveTools(dir)).toEqual(['acc-diag'])
  })

  it('字段缺失 → 空数组（不声明 = 隐藏）', () => {
    writeCccConfig({ hooks: {} })
    expect(readExclusiveTools(dir)).toEqual([])
  })

  it('无配置文件 → 空数组', () => {
    expect(readExclusiveTools(dir)).toEqual([])
  })

  it('损坏 JSON → 空数组（fail-closed；配置损坏另有响亮告警）', () => {
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'serenity.json'), '{ broken')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(readExclusiveTools(dir)).toEqual([])
    warn.mockRestore()
  })

  it('非字符串 / 空白项被丢弃', () => {
    writeCccConfig({ exclusiveTools: ['acc-diag', 42, null, '   ', 'other'] })
    expect(readExclusiveTools(dir)).toEqual(['acc-diag', 'other'])
  })
})

describe('acc-diag: runAccDiag 装配 + 渲染', () => {
  it('注册表条目被聚合（state / at / target / lastResult / createdBy / attempts）', async () => {
    writeFileSync(
      join(dir, 'AGENT_SESSIONS', 'wake-registry.json'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: 'w-1',
            target: 'S142',
            at: '2026-09-14T10:00:00Z',
            message: 'm',
            state: 'pending',
            createdBy: 'S142',
            createdAt: '2026-09-14T09:00:00Z',
            attempts: 0,
          },
          {
            id: 'w-2',
            target: 'S151',
            at: '2026-09-14T09:00:00Z',
            message: 'm',
            state: 'delivered',
            createdBy: 'S112',
            createdAt: '2026-09-14T08:00:00Z',
            attempts: 1,
            lastResult: '已投递 S151（live(bound session-x)）',
          },
        ],
      }),
    )
    const r = await runAccDiag(fakeCtx() as never, dir)
    expect(r.ccc).toBe(dir)
    expect(r.wakes.error).toBeNull()
    expect(r.wakes.entries).toHaveLength(2)
    expect(r.wakes.pending).toBe(1)
    expect(r.wakes.entries.find((e) => e.id === 'w-2')!.lastResult).toContain('live(bound')

    const text = renderAccDiag(r)
    expect(text).toContain('ACC 运行态诊断')
    expect(text).toContain('① live 运行态')
    expect(text).toContain('③ 唤醒注册表')
    expect(text).toContain('w-1 [pending]')
    expect(text).toContain('补跑窗口 2h')
    // 🔒 已退场的两段不得复活：② 面板解析 / ④ 唤起条件链（主语随 ACC autopilot 消失）
    expect(text).not.toContain('② 面板解析')
    expect(text).not.toContain('④ 唤起条件链')
    expect(text).not.toContain('自主轨迹唤起诊断')
  })

  it('无 live 会话 / 无条目：空段显式说明"无"（不得让人误读为"沉默 = 一切正常"）', async () => {
    const r = await runAccDiag(fakeCtx([]) as never, dir)
    const text = renderAccDiag(r)
    expect(text).toContain('live 会话: 0 个')
    expect(text).toContain('（无条目）')
    expect(text).toContain('── ③ 唤醒注册表')
  })

  it('live 会话列出 id / cwd / CCC 归属', async () => {
    const r = await runAccDiag(fakeCtx([{ id: 'session-a', cwd: dir }]) as never, dir)
    expect(r.live.liveSessions).toHaveLength(1)
    expect(renderAccDiag(r)).toContain('session-a')
  })

  it('①b 段报告唤醒时钟的武装状态（"为何没有 tick" 的第一手判据）', async () => {
    const r = await runAccDiag(fakeCtx() as never, dir)
    const text = renderAccDiag(r)
    expect(r.clocks.wake).toHaveProperty('armed')
    expect(r.clocks.wake).toHaveProperty('enabled')
    expect(text).toContain('唤醒调度器（wake-registry tick）')
    expect(text).toContain('armed=')
    expect(text).toContain('上次 tick=')
    // 🔒 autopilot 时钟已随机制退场（回归钉：报告里不得再有第二座钟）
    expect(Object.keys(r.clocks)).toEqual(['wake'])
    expect(text).not.toContain('autopilot 时钟')
  })
})

describe('acc-diag: 工具面', () => {
  it('名字为 acc-diag，参数为空（无动作参数——一次调用即全报告）', () => {
    const tool = createAccDiagTool(fakeCtx() as never) as unknown as { name: string; parameters: unknown }
    expect(tool.name).toBe('acc-diag')
    expect(Object.keys(tool.parameters as object)).toHaveLength(0)
  })

  it('description 只承诺现存三段（②/④ 不得复现）', () => {
    const tool = createAccDiagTool(fakeCtx() as never) as unknown as { description: string }
    expect(tool.description).toContain('(1) live runtime')
    expect(tool.description).toContain('(1b) wake clock')
    expect(tool.description).toContain('(3) wake registry')
    expect(tool.description).not.toContain('(2) panel resolution')
    expect(tool.description).not.toContain('(4) wake condition chain')
    expect(tool.description).not.toContain('autopilot')
  })

  it('CCC 未解析（cwd 不在任何 CCC 内）→ 响亮 code，不抛错', async () => {
    const other = mkdtempSync(join(tmpdir(), 'not-ccc-'))
    const tool = createAccDiagTool(fakeCtx() as never) as unknown as {
      execute: (a: unknown, e: unknown) => Promise<{ ok: boolean; code: string; report: string }>
    }
    const res = await tool.execute({}, { agent: { session: { header: { cwd: other } } } })
    expect(res.ok).toBe(false)
    expect(res.code).toBe('CCC_UNRESOLVED')
    expect(res.report).toBe('')
    rmSync(other, { recursive: true, force: true })
  })

  it('CCC 内调用 → ok + 报告含三段', async () => {
    const tool = createAccDiagTool(fakeCtx() as never) as unknown as {
      execute: (a: unknown, e: unknown) => Promise<{ ok: boolean; report: string }>
    }
    const res = await tool.execute({}, { agent: { session: { header: { cwd: dir } } } })
    expect(res.ok).toBe(true)
    expect(res.report).toContain('① live 运行态')
    expect(res.report).toContain('唤醒调度器（wake-registry tick）')
    expect(res.report).toContain('③ 唤醒注册表')
  })
})
