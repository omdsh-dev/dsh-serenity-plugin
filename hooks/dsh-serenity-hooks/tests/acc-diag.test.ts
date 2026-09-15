/**
 * acc-diag.test.ts — 专属运行态诊断工具（v1.33，S142 §32.11）
 *
 * 覆盖三层：
 *  ① 判据：`readExclusiveTools`（声明 / 缺字段 / 损坏 JSON → fail-closed 空 / 非字符串过滤）
 *  ② 装配：`runAccDiag`（live 运行态 + 面板解析 + 唤醒注册表 + 脚本条件链；失败不吞）
 *  ③ 工具面：`createAccDiagTool`（名字 / 无参 / CCC 未解析时响亮 code / 报告四段齐）
 *
 * 可见性（`tools.restrict`）不在本文件覆盖——它属拦截缝，见 `guards.test.ts`
 * 的「专属工具条件可见」一组。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('@deepseek-ai/dsh-tools', () => ({ defineTool: (o: unknown) => o }))

// v1.34.1（⑥ C6a）：④ 段**不再 spawn 包内脚本**（改为进程内调 autopilot-chain）⇒ 本文件不再
// 需要脚本通道 mock。判据本身在 autopilot-chain.test.ts 覆盖；此处只验**装配与渲染**。

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
    expect(text).toContain('② 面板解析')
    expect(text).toContain('③ 唤醒注册表')
    expect(text).toContain('④ 唤起条件链')
    expect(text).toContain('w-1 [pending]')
    expect(text).toContain('补跑窗口 2h')
    // ④ 段 = **进程内**条件链（判据唯一实现 = autopilot-chain）——不再有子进程输出
    expect(text).toContain('自主轨迹唤起诊断')
  })

  it('🔴 ④ 段进程内：读得到只有进程内可见的判据（全局闸），并给出判决档', async () => {
    writeCccConfig({ trajectory: { autopilot: { enabled: true, intervalHours: 12 } } })
    const r = await runAccDiag(fakeCtx() as never, dir)
    // 本测试进程 settings 缺省 → 闸关（readSimpleSettings 兜底）⇒ 阻断，且**报告里能看见**
    expect(r.autopilotChain).toContain('周期自唤醒全局闸关闭')
    expect(r.autopilotChain).not.toContain('不可知（离线通道——只有插件进程能读 DSH 设置）')
    expect(r.autopilotVerdict).toBe('blocked')
    expect(renderAccDiag(r)).toContain('周期自唤醒全局闸关闭')
  })

  it('无 live 会话 / 无条目：空段显式说明"无"（不得让人误读为"沉默 = 一切正常"）', async () => {
    const r = await runAccDiag(fakeCtx([]) as never, dir)
    const text = renderAccDiag(r)
    expect(text).toContain('live 会话: 0 个')
    expect(text).toContain('autopilot CCC: 无')
    expect(text).toContain('（无条目）')
    // ② 段在测试进程里总能解析到"某个 CCC"（进程 cwd 就在本 CCC 内）⇒ 只断言段落在场
    expect(text).toContain('── ② 面板解析')
  })

  it('配置缺失 → ④ 段如实报"未配置"（不是空段、不是静默）', async () => {
    const r = await runAccDiag(fakeCtx() as never, dir)
    expect(r.autopilotChain).toContain('trajectory.autopilot 未配置')
    expect(r.autopilotVerdict).toBe('blocked')
  })

  it('live 会话列出 id / cwd / CCC 归属', async () => {
    const r = await runAccDiag(fakeCtx([{ id: 'session-a', cwd: dir }]) as never, dir)
    expect(r.live.liveSessions).toHaveLength(1)
    expect(renderAccDiag(r)).toContain('session-a')
  })

  it('① 段报告进程内两个时钟的武装状态（"为何没有 tick" 的第一手判据）', async () => {
    const r = await runAccDiag(fakeCtx() as never, dir)
    const text = renderAccDiag(r)
    expect(r.clocks.wake).toHaveProperty('armed')
    expect(r.clocks.wake).toHaveProperty('enabled')
    expect(r.clocks.autopilot).toHaveProperty('armed')
    expect(text).toContain('唤醒调度器（wake-registry tick）')
    expect(text).toContain('autopilot 时钟（周期自唤醒 tick）')
    expect(text).toContain('armed=')
    expect(text).toContain('上次 tick=')
  })
})

describe('acc-diag: 工具面', () => {
  it('名字为 acc-diag，参数为空（无动作参数——一次调用即全报告）', () => {
    const tool = createAccDiagTool(fakeCtx() as never) as unknown as { name: string; parameters: unknown }
    expect(tool.name).toBe('acc-diag')
    expect(Object.keys(tool.parameters as object)).toHaveLength(0)
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

  it('CCC 内调用 → ok + 报告含四段', async () => {
    const tool = createAccDiagTool(fakeCtx() as never) as unknown as {
      execute: (a: unknown, e: unknown) => Promise<{ ok: boolean; report: string }>
    }
    const res = await tool.execute({}, { agent: { session: { header: { cwd: dir } } } })
    expect(res.ok).toBe(true)
    expect(res.report).toContain('① live 运行态')
    expect(res.report).toContain('④ 唤起条件链')
  })
})
