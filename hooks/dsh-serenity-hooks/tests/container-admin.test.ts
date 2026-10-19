/**
 * container-admin.test.ts — container_admin（v1.30 机务舱：容器管理面统一入口）
 *
 * 覆盖：domain 路由（config/msm）、config 的两层说明菜单（P3）、轨迹约束四动作（P4 并入 config）、
 * msm 管理 action 转发、轨迹约束会话 register/deregister 拒绝。
 *
 * ## 结构变化史（留着，因为每一条都对应一次"门禁全绿也抓不到"的教训）
 * - v1.34.1：工具由 `export const containerAdminTool` 改为工厂 `createContainerAdminTool(ctx)`
 * - 2026-09-15：**autopilot 域整段退场**（ACC 侧 autopilot 删除）⇒ 该域一组用例整组删除
 * - **2026-10-19：`role` 域并入 `config`**（owner 裁「1 并入」）⇒ 本文件三处靶同批改：
 *   ① enum 从 `['role','msm','config']` → `['config','msm']`；
 *   ② 拒绝文案从 `domain: role | msm | config` → `domain: config | msm`；
 *   ③ `role` 四动作改走 `config`，且**旧别名必须仍可用**（存量 CCC 文档/脚本 30 处引用它）。
 *
 * 🔴 **别名为什么必须有判据**（不是顺手加的兼容）：本仓实测有 30 处 `container_admin role ...`
 * 的活引用（SESSION/文档/CCC 手册）。硬切会让它们全部"未知域"，而**没有任何机械信号**
 * 会告诉我们"哪份文档已经说谎了"（D151 同族）。⇒ 别名 + 一条钉住它的用例。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('@deepseek-ai/dsh-tools', () => ({ defineTool: (o: unknown) => o }))
vi.mock('@deepseek-ai/dsh-llm', () => ({ createUserMessage: (o: unknown) => o }))

/**
 * 部分 mock：只替换 `runMsm`，其余导出走真模块。
 *
 * 🔴 **必须是 async 工厂 + `await importActual`**（2026-10-19 实测）：原先写
 * `const actual = vi.importActual(...)` 然后 `...actual` —— `importActual` 返回的是
 * **Promise**，展开 Promise 得到的是**空对象**（不报错）。此前只是因为测试只用到
 * `runMsm`（被显式覆盖）所以看不出来；一旦依赖别的导出（如 `CCC_CONFIG_REFERENCE`
 * 作菜单章节正文）就当场炸成 "No ... export is defined on the mock"。
 * ⇒ 判据：**部分 mock 里凡是 `...actual`，工厂就必须 async 且 `await` 过它**。
 */
vi.mock('../src/tools/msm/service.js', async () => {
  const actual = await vi.importActual<typeof import('../src/tools/msm/service.js')>('../src/tools/msm/service.js')
  return {
    ...actual,
    runMsm: vi.fn((root: string, args: { action: string }) => ({ action: args.action, root })),
  }
})

import { createContainerAdminTool } from '../src/tools/container-admin.js'
import { runMsm } from '../src/tools/msm/service.js'

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
  it('工具名 = container_admin；参数含 domain/action/chapter', () => {
    expect(containerAdminTool).toMatchObject({ name: 'container_admin' })
    const params = containerAdminTool.parameters
    expect(params.domain).toBeDefined()
    expect(params.action).toBeDefined()
    // P3 第二层菜单参数
    expect(params.chapter).toBeDefined()
  })

  it('🔒 domain enum 恰为 config/msm（`role` 已并入 config；autopilot 已退场，均不得复活）', () => {
    expect(containerAdminTool.parameters.domain.enum).toEqual(['config', 'msm'])
    // `role` 是别名，**不进 enum**（文案不教它），但必须仍能用（下一条用例钉住）
    expect(containerAdminTool.parameters.domain.enum).not.toContain('role')
  })

  it('🔴 旧 `role` 域仍可用（过渡别名 → config），且三动作全部可达', async () => {
    // 本仓 30 处存量引用 `container_admin role ...` ⇒ 硬切会让它们静默失效
    await expect(exec({ domain: 'role', action: 'list' })).resolves.toMatchObject({ roles: [] })
    await expect(exec({ domain: 'role', action: 'validate' })).resolves.toMatchObject({ ok: true })
    await expect(exec({ domain: 'role', action: 'guide' })).resolves.toMatchObject({ guide: expect.any(String) })
  })

  it('config list → 轨迹约束摘要（无轨迹 → 空数组）', async () => {
    const res = await containerAdminTool.execute({ domain: 'config', action: 'list' }, execWith())
    expect(res).toMatchObject({ roles: [] })
  })

  it('config validate → 无轨迹时 ok:true + 计数 0', async () => {
    const res = await containerAdminTool.execute({ domain: 'config', action: 'validate' }, execWith())
    expect(res).toMatchObject({ ok: true, constraintCount: 0 })
  })

  it('config guide → 返回轨迹约束教程（非空）', async () => {
    const res = await containerAdminTool.execute({ domain: 'config', action: 'guide' }, execWith())
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

  it('config view → 转发 ccc-config 到 runMsm（现值）', async () => {
    await containerAdminTool.execute({ domain: 'config', action: 'view' }, execWith())
    expect(mockRunMsm).toHaveBeenCalledWith(tmp, expect.objectContaining({ action: 'ccc-config' }))
  })

  it('config 无 action → 按 view 处理（向后兼容旧的 `{domain:"config"}` 调用）', async () => {
    await containerAdminTool.execute({ domain: 'config' }, execWith())
    expect(mockRunMsm).toHaveBeenCalledWith(tmp, expect.objectContaining({ action: 'ccc-config' }))
  })

  it('非法 domain → 拒绝（文案只列新名）', async () => {
    await expect(containerAdminTool.execute({ domain: 'nope' }, execWith())).rejects.toThrow(
      /domain: config \| msm/,
    )
  })

  it('🔒 已删除的 domain 不得复活：autopilot 一律拒绝（不派发任何实现）', async () => {
    await expect(exec({ domain: 'autopilot', action: 'status' })).rejects.toThrow(
      /domain: config \| msm/,
    )
  })

  it('非 CCC（无 .serenity）→ 拒绝', async () => {
    await expect(
      containerAdminTool.execute({ domain: 'config', action: 'list' }, { agent: { session: { header: { cwd: '/tmp' } } } }),
    ).rejects.toThrow(/No CCC found/)
  })
})

/**
 * P3：两层说明菜单（owner 原话「一个是使用说明目录，一个是使用说明详情（按章节获得）」）。
 *
 * 🔴 核心判据不是"能返回东西"，而是**目录与详情是两个不同大小的东西**：
 * 目录若把正文也带上，两层菜单就退化成一份长文（那就等于没做）。
 */
describe('config docs：两层说明菜单（P3）', () => {
  it('第一层：无 chapter ⇒ 目录，且列出全部章节 id', async () => {
    const res = (await exec({ domain: 'config', action: 'docs' })) as { docs: string; chapters: string[] }
    expect(res.chapters).toEqual(['config', 'trajectory-constraint'])
    expect(res.docs).toContain('CCC 配置说明 · 目录')
    // 目录里每一章都有一句话
    expect(res.docs).toContain('config')
    expect(res.docs).toContain('trajectory-constraint')
  })

  it('🔴 目录必须显著短于详情（否则"两层"名不副实）', async () => {
    const index = (await exec({ domain: 'config', action: 'docs' })) as { docs: string }
    const detail = (await exec({ domain: 'config', action: 'docs', chapter: 'config' })) as { docs: string }
    // 目录只索引不复制 ⇒ 体量必须小一个量级以上
    expect(index.docs.length).toBeLessThan(detail.docs.length / 5)
  })

  it('第二层：给 chapter ⇒ 该章全文（config 章 = CCC 配置参考全文）', async () => {
    const res = (await exec({ domain: 'config', action: 'docs', chapter: 'config' })) as { chapter: string; docs: string }
    expect(res.chapter).toBe('config')
    expect(res.docs).toContain('CCC Configuration Reference')
    // 关键段落必须在（证明是真全文，不是摘要）
    expect(res.docs).toContain('cheap-worker.models')
    expect(res.docs).toContain('exclusiveTools')
  })

  it('第二层：trajectory-constraint 章 = 轨迹约束教程全文', async () => {
    const res = (await exec({ domain: 'config', action: 'docs', chapter: 'trajectory-constraint' })) as { docs: string }
    expect(res.docs).toContain('Guide (2026-10-19 redesigned)')
  })

  it('章节名大小写不敏感（「我打错大小写」不该变成"没有这章"）', async () => {
    const res = (await exec({ domain: 'config', action: 'docs', chapter: 'CONFIG' })) as { chapter: string }
    expect(res.chapter).toBe('config')
  })

  it('🔴 未知章节 → 拒绝且**带候选清单**（"不知道这章"≠"这章是空的"）', async () => {
    await expect(exec({ domain: 'config', action: 'docs', chapter: 'nope' })).rejects.toThrow(
      /unknown chapter "nope"[\s\S]*Available: config \| trajectory-constraint/,
    )
  })

  it('🔴 白空格章节 ⇒ 按"没给"处理（返回目录，不是报错）', async () => {
    const res = (await exec({ domain: 'config', action: 'docs', chapter: '   ' })) as { chapters: string[] }
    expect(res.chapters).toEqual(['config', 'trajectory-constraint'])
  })
})
