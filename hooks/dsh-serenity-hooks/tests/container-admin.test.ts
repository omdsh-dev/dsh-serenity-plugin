/**
 * container-admin.test.ts — container_admin（v1.30 机务舱：容器管理面统一入口）
 *
 * 覆盖：domain 路由（role/msm/config）、role 子命令转发、msm 管理 action 转发、
 * skiff 会话 register/deregister 拒绝。
 *
 * v1.34.1 形态变化：工具由 `export const containerAdminTool` 改为工厂
 * `createContainerAdminTool(ctx)`。
 * 2026-09-15：**autopilot 域整段退场**（ACC 侧 autopilot 删除，所有者裁决 (a)）
 * ⇒ 本文件原「autopilot 域」一组用例（枚举含 autopilot、三动作派发、带 ctx 调用、
 * diag/doc/check/guide 拒绝）**整组删除**；`domain` 枚举改由本文件的 domain 路由组钉住。
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

import { createContainerAdminTool } from '../src/tools/container-admin.js'
import { runMsm } from '../src/msm-ops.js'

const mockRunMsm = vi.mocked(runMsm)

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

  it('🔒 domain enum 恰为 role/msm/config（autopilot 域已退场，不得复活）', () => {
    expect(containerAdminTool.parameters.domain.enum).toEqual(['role', 'msm', 'config'])
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
      /domain: role \| msm \| config/,
    )
  })

  it('🔒 已删除的 domain 不得复活：autopilot 一律拒绝（不派发任何实现）', async () => {
    await expect(exec({ domain: 'autopilot', action: 'status' })).rejects.toThrow(
      /domain: role \| msm \| config/,
    )
  })

  it('非 CCC（无 .serenity）→ 拒绝', async () => {
    await expect(
      containerAdminTool.execute({ domain: 'role', action: 'list' }, { agent: { session: { header: { cwd: '/tmp' } } } }),
    ).rejects.toThrow(/No CCC found/)
  })
})
