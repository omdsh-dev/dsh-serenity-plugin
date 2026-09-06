/**
 * container-admin.test.ts — container_admin（v1.30 机务舱：容器管理面统一入口）
 *
 * 覆盖：domain 路由（role/msm/config）、role 子命令转发、msm 管理 action 转发、
 * skiff 会话 register/deregister 拒绝。
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

import { containerAdminTool } from '../src/tools/container-admin.js'
import { runMsm } from '../src/msm-ops.js'

const mockRunMsm = vi.mocked(runMsm)

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
    ).rejects.toThrow(/domain: role \| msm \| config/)
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
