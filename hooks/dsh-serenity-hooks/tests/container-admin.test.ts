/**
 * container-admin.test.ts — container_admin（v1.30 机务舱：容器管理面统一入口）
 *
 * 覆盖：domain 路由（role/msm/config/**autopilot**）、role 子命令转发、msm 管理 action 转发、
 * skiff 会话 register/deregister 拒绝、**autopilot 域的新名↔脚本历史名映射**（v1.33，S142 §32）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
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

// autopilot 脚本通道：mock 掉进程 spawn（真跑会拉起 bun 与真实脚本）
vi.mock('../src/autopilot-script.js', () => ({
  findExpScript: () => null,
  EXP_SCRIPT: null,
  runAutopilotScript: vi.fn(() => ({ output: 'script-ok' })),
}))

import { containerAdminTool } from '../src/tools/container-admin.js'
import { runMsm } from '../src/msm-ops.js'
import { runAutopilotScript } from '../src/autopilot-script.js'

const mockRunMsm = vi.mocked(runMsm)
const mockRunAutopilotScript = vi.mocked(runAutopilotScript)

/** 统一调用入口（工具对象在测试里是 defineTool 的透传形态） */
function exec(args: unknown, cwd = tmp): Promise<unknown> {
  return (containerAdminTool as { execute: (a: unknown, e: unknown) => Promise<unknown> }).execute(
    args,
    { agent: { session: { header: { cwd } } } },
  )
}

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ca-'))
  mockRunMsm.mockReset()
  mockRunAutopilotScript.mockReset()
  mockRunAutopilotScript.mockReturnValue({ output: 'script-ok' })
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
    const params = (containerAdminTool as { parameters: Record<string, unknown> }).parameters
    expect(params.domain).toBeDefined()
    expect(params.action).toBeDefined()
  })

  it('role list → skiff 角色摘要（无角色 → 空数组）', async () => {
    const res = await (containerAdminTool as { execute: (a: unknown, e: unknown) => Promise<unknown> }).execute(
      { domain: 'role', action: 'list' },
      execWith(),
    )
    expect(res).toMatchObject({ roles: [] })
  })

  it('role validate → 无角色时 ok:true + 提示未定义', async () => {
    const res = await (containerAdminTool as { execute: (a: unknown, e: unknown) => Promise<unknown> }).execute(
      { domain: 'role', action: 'validate' },
      execWith(),
    )
    expect(res).toMatchObject({ ok: true })
  })

  it('role guide → 返回教程（非空）', async () => {
    const res = await (containerAdminTool as { execute: (a: unknown, e: unknown) => Promise<unknown> }).execute(
      { domain: 'role', action: 'guide' },
      execWith(),
    )
    expect(res).toMatchObject({ guide: expect.any(String) })
  })

  it('msm register → 转发 runMsm 且带业务参数', async () => {
    mockRunMsm.mockImplementation(((root: string, args: { action: string }) => ({ action: args.action, root, ok: true })) as never)
    const res = await (containerAdminTool as { execute: (a: unknown, e: unknown) => Promise<unknown> }).execute(
      { domain: 'msm', action: 'register', name: 'my-tool', path: 'scripts/my-tool.ts', category: 'mech', description: 'test tool' },
      execWith(),
    )
    expect(mockRunMsm).toHaveBeenCalledWith(tmp, expect.objectContaining({ action: 'register', name: 'my-tool' }))
    expect(res).toBeTruthy()
  })

  it('msm catalog → 转发 runMsm action=catalog', async () => {
    await (containerAdminTool as { execute: (a: unknown, e: unknown) => Promise<unknown> }).execute(
      { domain: 'msm', action: 'catalog' },
      execWith(),
    )
    expect(mockRunMsm).toHaveBeenCalledWith(tmp, expect.objectContaining({ action: 'catalog' }))
  })

  it('msm 域不接受 exec（执行走 msm 工具）', async () => {
    await expect(
      (containerAdminTool as { execute: (a: unknown, e: unknown) => Promise<unknown> }).execute(
        { domain: 'msm', action: 'exec', name: 'x' },
        execWith(),
      ),
    ).rejects.toThrow(/execution goes through the msm tool/)
  })

  it('config → 转发 ccc-config 到 runMsm', async () => {
    await (containerAdminTool as { execute: (a: unknown, e: unknown) => Promise<unknown> }).execute(
      { domain: 'config' },
      execWith(),
    )
    expect(mockRunMsm).toHaveBeenCalledWith(tmp, expect.objectContaining({ action: 'ccc-config' }))
  })

  it('非法 domain → 拒绝', async () => {
    await expect(
      (containerAdminTool as { execute: (a: unknown, e: unknown) => Promise<unknown> }).execute(
        { domain: 'nope' },
        execWith(),
      ),
    ).rejects.toThrow(/domain: role \| msm \| config \| autopilot/)
  })

  it('非 CCC（无 .serenity）→ 拒绝', async () => {
    await expect(
      (containerAdminTool as { execute: (a: unknown, e: unknown) => Promise<unknown> }).execute(
        { domain: 'role', action: 'list' },
        { agent: { session: { header: { cwd: '/tmp' } } } },
      ),
    ).rejects.toThrow(/No CCC found/)
  })
})

/**
 * v1.33（S142 §32）：autopilot 面从独立工具归入机务舱。
 * 动作**新名 ↔ 脚本历史名**的映射是本组用例的核心（改名不得静默改语义）。
 */
describe('container_admin：autopilot 域（v1.33 归机务舱；D59 周期自唤醒）', () => {
  it('domain enum 含 autopilot', () => {
    const params = (containerAdminTool as { parameters: Record<string, { enum?: string[] }> }).parameters
    expect(params.domain.enum).toEqual(['role', 'msm', 'config', 'autopilot'])
  })

  it('status→all / init→init / generate-bias→random（新名映射到脚本历史子命令）', async () => {
    const cases: Array<[string, string]> = [
      ['status', 'all'],
      ['init', 'init'],
      ['generate-bias', 'random'],
    ]
    for (const [action, scriptAction] of cases) {
      mockRunAutopilotScript.mockClear()
      const res = await exec({ domain: 'autopilot', action })
      expect(mockRunAutopilotScript).toHaveBeenCalledWith(tmp, scriptAction)
      expect(res).toMatchObject({ action, output: 'script-ok' })
    }
  })

  it('🔒 已删除的动作不得复活：diag / diag-live / doc / check / guide 一律拒绝且不触碰脚本', async () => {
    for (const action of ['diag', 'diag-live', 'doc', 'check', 'guide', 'status-live']) {
      mockRunAutopilotScript.mockClear()
      await expect(exec({ domain: 'autopilot', action })).rejects.toThrow(
        /autopilot requires action: status \| init \| generate-bias/,
      )
      expect(mockRunAutopilotScript).not.toHaveBeenCalled()
    }
  })

  it('脚本报错 → 原样透传 error（响亮失败，不静默）', async () => {
    mockRunAutopilotScript.mockReturnValue({ error: 'autopilot 脚本需要 bun 运行时' })
    const res = await exec({ domain: 'autopilot', action: 'status' })
    expect(res).toMatchObject({ action: 'status', error: 'autopilot 脚本需要 bun 运行时' })
  })
})
