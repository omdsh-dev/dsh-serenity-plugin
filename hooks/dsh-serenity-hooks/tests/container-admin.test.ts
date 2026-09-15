/**
 * container-admin.test.ts — container_admin（v1.30 机务舱：容器管理面统一入口）
 *
 * 覆盖：domain 路由（role/msm/config/**autopilot**）、role 子命令转发、msm 管理 action 转发、
 * skiff 会话 register/deregister 拒绝、**autopilot 域的动作派发**（v1.33 新名；
 * v1.34.1 ⑥ C6a：由"spawn 包内脚本"改为**进程内直调**）。
 *
 * v1.34.1 形态变化：工具由 `export const containerAdminTool` 改为工厂
 * `createContainerAdminTool(ctx)`（autopilot 域需要 ctx 才能读 live 运行态事实）。
 * autopilot 三动作的**实现**另有直接测试（`autopilot-ops.test.ts`），本文件只验**派发**。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('@deepseek-ai/dsh-tools', () => ({ defineTool: (o: unknown) => o }))
vi.mock('@deepseek-ai/dsh-llm', () => ({ createUserMessage: (o: unknown) => o }))

vi.mock('../src/msm-ops.js', () => {
  const actual = vi.importActual<typeof import('../src/msm-ops.js')>('../src/msm-ops.js')
  return {
    ...actual,
    runMsm: vi.fn((root: string, args: { action: string }) => ({ action: args.action, root })),
  }
})

// autopilot 域：改直调**进程内**实现 → mock 掉 ops 层（其自身行为见 autopilot-ops.test.ts）
vi.mock('../src/autopilot-ops.js', () => ({
  autopilotInit: vi.fn(() => ({ action: 'init', output: 'init-ok' })),
  autopilotStatus: vi.fn(async () => ({ action: 'status', output: 'status-ok' })),
  autopilotGenerateBias: vi.fn(async () => ({ action: 'generate-bias', output: 'bias-ok' })),
}))

import { createContainerAdminTool } from '../src/tools/container-admin.js'
import { runMsm } from '../src/msm-ops.js'
import { autopilotInit, autopilotStatus, autopilotGenerateBias } from '../src/autopilot-ops.js'

const mockRunMsm = vi.mocked(runMsm)
const mockInit = vi.mocked(autopilotInit)
const mockStatus = vi.mocked(autopilotStatus)
const mockBias = vi.mocked(autopilotGenerateBias)

/** 工具对象在测试里是 defineTool 的透传形态（工厂返回） */
const containerAdminTool = createContainerAdminTool({ get: () => undefined } as never) as {
  name: string
  parameters: Record<string, { enum?: string[]; [k: string]: unknown }>
  execute: (a: unknown, e: unknown) => Promise<unknown>
}

/** 统一调用入口 */
function exec(args: unknown, cwd = tmp): Promise<unknown> {
  return containerAdminTool.execute(args, { agent: { session: { header: { cwd } } } })
}

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ca-'))
  mockRunMsm.mockReset()
  mockInit.mockClear()
  mockStatus.mockClear()
  mockBias.mockClear()
  // CCC 标记
  writeFileSync(join(tmp, '.serenity'), 'container-admin-test\n')
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function execWith(cwd = tmp): unknown {
  return { agent: { session: { header: { cwd } } } }
}

describe('container_admin：domain 路由（v1.30 机务舱）', () => {
  it('工具名 = container_admin；参数含 domain/action', () => {
    expect(containerAdminTool).toMatchObject({ name: 'container_admin' })
    const params = containerAdminTool.parameters
    expect(params.domain).toBeDefined()
    expect(params.action).toBeDefined()
  })

  it('role list → skiff 角色摘要（无角色 → 空数组）', async () => {
    const res = await containerAdminTool.execute({ domain: 'role', action: 'list' }, execWith())
    expect(res).toMatchObject({ roles: [] })
  })

  it('role validate → 无角色时 ok:true + 提示未定义', async () => {
    const res = await containerAdminTool.execute({ domain: 'role', action: 'validate' }, execWith())
    expect(res).toMatchObject({ ok: true })
  })

  it('role guide → 返回教程（非空）', async () => {
    const res = await containerAdminTool.execute({ domain: 'role', action: 'guide' }, execWith())
    expect(res).toMatchObject({ guide: expect.any(String) })
  })

  it('msm register → 转发 runMsm 且带业务参数', async () => {
    mockRunMsm.mockImplementation(((root: string, args: { action: string }) => ({ action: args.action, root, ok: true })) as never)
    const res = await containerAdminTool.execute(
      { domain: 'msm', action: 'register', name: 'my-tool', path: 'scripts/my-tool.ts', category: 'mech', description: 'test tool' },
      execWith(),
    )
    expect(mockRunMsm).toHaveBeenCalledWith(tmp, expect.objectContaining({ action: 'register', name: 'my-tool' }))
    expect(res).toBeTruthy()
  })

  it('msm catalog → 转发 runMsm action=catalog', async () => {
    await containerAdminTool.execute({ domain: 'msm', action: 'catalog' }, execWith())
    expect(mockRunMsm).toHaveBeenCalledWith(tmp, expect.objectContaining({ action: 'catalog' }))
  })

  it('msm 域不接受 exec（执行走 msm 工具）', async () => {
    await expect(
      containerAdminTool.execute({ domain: 'msm', action: 'exec', name: 'x' }, execWith()),
    ).rejects.toThrow(/execution goes through the msm tool/)
  })

  it('config → 转发 ccc-config 到 runMsm', async () => {
    await containerAdminTool.execute({ domain: 'config' }, execWith())
    expect(mockRunMsm).toHaveBeenCalledWith(tmp, expect.objectContaining({ action: 'ccc-config' }))
  })

  it('非法 domain → 拒绝', async () => {
    await expect(containerAdminTool.execute({ domain: 'nope' }, execWith())).rejects.toThrow(
      /domain: role \| msm \| config \| autopilot/,
    )
  })

  it('非 CCC（无 .serenity）→ 拒绝', async () => {
    await expect(
      containerAdminTool.execute({ domain: 'role', action: 'list' }, { agent: { session: { header: { cwd: '/tmp' } } } }),
    ).rejects.toThrow(/No CCC found/)
  })
})

/**
 * v1.33（S142 §32）：autopilot 面从独立工具归入机务舱。
 * v1.34.1（⑥ C6a）：三动作**进程内直调**（原"新名 ↔ 脚本历史子命令"映射已随独立脚本退场消失）。
 */
describe('container_admin：autopilot 域（v1.33 归机务舱；D59 周期自唤醒）', () => {
  it('domain enum 含 autopilot', () => {
    expect(containerAdminTool.parameters.domain.enum).toEqual(['role', 'msm', 'config', 'autopilot'])
  })

  it('三个动作各派发到**进程内**实现（status/init/generate-bias）', async () => {
    expect(await exec({ domain: 'autopilot', action: 'status' })).toMatchObject({ action: 'status', output: 'status-ok' })
    expect(mockStatus).toHaveBeenCalledWith(tmp, expect.anything())
    expect(await exec({ domain: 'autopilot', action: 'init' })).toMatchObject({ action: 'init', output: 'init-ok' })
    expect(mockInit).toHaveBeenCalledWith(tmp)
    expect(await exec({ domain: 'autopilot', action: 'generate-bias' })).toMatchObject({ action: 'generate-bias', output: 'bias-ok' })
    expect(mockBias).toHaveBeenCalledWith(tmp)
  })

  it('🔴 status **带 ctx** 调用（进程内事实：全局闸/live/agent 可解析性靠它）', async () => {
    await exec({ domain: 'autopilot', action: 'status' })
    const ctxArg = mockStatus.mock.calls[0]?.[1]
    expect(ctxArg).toBeTruthy() // 工厂闭包里的 ctx 被透传（不是 undefined——否则运行态全成"不可知"）
  })

  it('🔒 已删除的动作不得复活：diag / diag-live / doc / check / guide 一律拒绝且不触碰任何实现', async () => {
    for (const action of ['diag', 'diag-live', 'doc', 'check', 'guide', 'status-live']) {
      mockInit.mockClear()
      mockStatus.mockClear()
      mockBias.mockClear()
      await expect(exec({ domain: 'autopilot', action })).rejects.toThrow(
        /autopilot requires action: status \| init \| generate-bias/,
      )
      expect(mockInit).not.toHaveBeenCalled()
      expect(mockStatus).not.toHaveBeenCalled()
      expect(mockBias).not.toHaveBeenCalled()
    }
  })

  it('动作失败 → 原样透传 error（响亮失败，不静默）', async () => {
    mockBias.mockResolvedValueOnce({ action: 'generate-bias', output: '', error: '偏见内容提供者脚本无法运行' })
    const res = await exec({ domain: 'autopilot', action: 'generate-bias' })
    expect(res).toMatchObject({ action: 'generate-bias', error: '偏见内容提供者脚本无法运行' })
  })
})
