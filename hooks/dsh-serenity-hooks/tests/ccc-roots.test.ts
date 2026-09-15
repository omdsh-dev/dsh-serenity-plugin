/**
 * ccc-roots.test.ts — C2「CCC 发现面归一」的契约测试
 *
 * 本文件锁死 `src/ccc-roots.ts`（L1 单根解析 + L2 全量枚举的唯一判断层）的三条契约：
 *  1. **并集语义**（不是短路）：三层来源各贡献候选，结果按来源顺序去重；`defaultRoot` 置首。
 *  2. **`withRoles` 缺省 false ⇒ 不读任何 CCC 的 `serenity.json`**（唤醒调度器每 tick
 *     枚举，不该为角色付 IO）。
 *  3. `agentCwdFor` / `cccRootForExec` 的**逐字语义**（含 `process.cwd()` 回落）。
 *
 * 反例锚（回归钉）：第 1 条的用例在旧短路实现下只会得到 1 条——这正是 C2 要修的缺陷
 * （现状稿 §2.B E1 + §2.D 第 4 条："只要 workspaceRegistry 有任意一条就永远不看后两层"）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'

import { listCccs, agentCwdFor, cccRootForCwd, cccRootForExec, NO_CCC_FROM_AGENT_CWD } from '../src/ccc-roots.js'
import { readSkiffRoles } from '../src/skiff-role.js'

/** 建一个临时 CCC（含 `.serenity`）；返回真实路径 */
function makeCcc(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  writeFileSync(join(dir, '.serenity'), 'test')
  return dir
}

const made: string[] = []

/** 造一个只暴露指定宿主服务的 fake ctx（形状对齐 host/access.ts 的读取器） */
function fakeCtx(opts: {
  workspaces?: Array<{ path?: string }>
  persistence?: Array<{ header?: { cwd?: string } }>
  live?: Array<{ header?: { cwd?: string } }>
}) {
  return {
    get: (name: string) => {
      if (name === 'workspaceRegistry') return { list: () => opts.workspaces ?? [] }
      if (name === 'sessionPersistence') return { list: async () => opts.persistence ?? [] }
      return undefined
    },
    sessions: { list: () => opts.live ?? [] },
  }
}

beforeEach(() => {
  made.length = 0
})

afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('listCccs：并集语义（C2 核心修正）', () => {
  it('🔴 三层各有一条**互不重复**的记录 ⇒ 结果 3 条（旧短路实现只给 1 条）', async () => {
    const wsCcc = makeCcc('ccc-roots-ws-')
    const spCcc = makeCcc('ccc-roots-sp-')
    const liveCcc = makeCcc('ccc-roots-live-')
    made.push(wsCcc, spCcc, liveCcc)

    const ctx = fakeCtx({
      workspaces: [{ path: join(wsCcc, 'sub') }],
      persistence: [{ header: { cwd: join(spCcc, 'sub') } }],
      live: [{ header: { cwd: join(liveCcc, 'sub') } }],
    })
    const cccs = await listCccs(ctx as never)

    // 回归钉：短路实现（workspaceRegistry 非空就不再走后两层）在此只会得到 1 条
    expect(cccs).toHaveLength(3)
    expect(cccs.map((c) => c.root)).toEqual([wsCcc, spCcc, liveCcc])
    expect(cccs.map((c) => c.name)).toEqual([basename(wsCcc), basename(spCcc), basename(liveCcc)])
  })

  it('顺序 = 来源顺序（workspaceRegistry → sessionPersistence → live），跨层按 root 去重**保留首次出现**', async () => {
    const a = makeCcc('ccc-roots-a-')
    const b = makeCcc('ccc-roots-b-')
    const c = makeCcc('ccc-roots-c-')
    made.push(a, b, c)

    const ctx = fakeCtx({
      // ① 层给 a、b；② 层给 b（重复）、c；③ 层给 a（重复）、c（重复）
      workspaces: [{ path: a }, { path: b }],
      persistence: [{ header: { cwd: b } }, { header: { cwd: c } }],
      live: [{ header: { cwd: a } }, { header: { cwd: c } }],
    })
    const cccs = await listCccs(ctx as never)
    expect(cccs.map((x) => x.root)).toEqual([a, b, c])
  })

  it('同层内多会话同根 → 去重；非 CCC 路径 → 跳过；空串/无 cwd → 跳过', async () => {
    const a = makeCcc('ccc-roots-a-')
    made.push(a)
    const plain = mkdtempSync(join(tmpdir(), 'ccc-roots-plain-'))
    made.push(plain)

    const ctx = fakeCtx({
      workspaces: [{ path: plain }, { path: undefined }, {}],
      persistence: [{ header: { cwd: a } }, { header: { cwd: join(a, 'sub') } }, { header: {} }, {}],
      live: [{ header: { cwd: '' } }, { header: {} }],
    })
    const cccs = await listCccs(ctx as never)
    expect(cccs.map((x) => x.root)).toEqual([a])
  })

  it('defaultRoot 不在结果里 ⇒ **置首**；已在结果里 ⇒ 位置不变', async () => {
    const a = makeCcc('ccc-roots-a-')
    const b = makeCcc('ccc-roots-b-')
    const d = makeCcc('ccc-roots-default-')
    made.push(a, b, d)

    const ctx = fakeCtx({ workspaces: [{ path: a }, { path: b }] })
    const withNewDefault = await listCccs(ctx as never, { defaultRoot: d })
    expect(withNewDefault.map((x) => x.root)).toEqual([d, a, b])

    const withExistingDefault = await listCccs(ctx as never, { defaultRoot: b })
    expect(withExistingDefault.map((x) => x.root)).toEqual([a, b])
  })

  it('无任何来源 + 无 defaultRoot ⇒ 空数组（不抛错）', async () => {
    expect(await listCccs(fakeCtx({}) as never)).toEqual([])
  })

  it('宿主服务缺失/抛错 ⇒ 该层贡献为空，不影响其它层（不抛错）', async () => {
    const a = makeCcc('ccc-roots-a-')
    made.push(a)
    const exploding = {
      get: () => {
        throw new Error('service unavailable')
      },
      sessions: { list: () => [{ header: { cwd: a } }] },
    }
    const cccs = await listCccs(exploding as never)
    expect(cccs.map((x) => x.root)).toEqual([a])
  })

  it('0.1.2 旧形状（sessionPersistence 顶层 cwd）不被采用——只认 header.cwd', async () => {
    const a = makeCcc('ccc-roots-a-')
    made.push(a)
    const ctx = {
      get: (name: string) =>
        name === 'sessionPersistence' ? { list: async () => [{ cwd: a }] } : undefined,
      sessions: { list: () => [] },
    }
    expect(await listCccs(ctx as never)).toEqual([])
  })
})

describe('listCccs：withRoles 缺省不读 serenity.json', () => {
  it('🔴 withRoles 缺省 false ⇒ `readSkiffRoles` **零调用**（不给唤醒调度器的每 tick 加 IO）', async () => {
    const a = makeCcc('ccc-roots-a-')
    made.push(a)
    // 装上角色配置（若真去读，roles 会非空 → 反向也锁住）
    mkdirSync(join(a, '.opencode'), { recursive: true })
    writeFileSync(join(a, '.opencode', 'serenity.json'), JSON.stringify({ skiff: { roles: { qa: { msms: ['x'] } } } }))

    const spy = vi.spyOn(await import('../src/skiff-role.js'), 'readSkiffRoles')
    const cccs = await listCccs(fakeCtx({ workspaces: [{ path: a }] }) as never)

    // 用桩断言「fs 未被以那些路径调用」的等价形式：角色解析器一次都没被调用
    expect(spy).not.toHaveBeenCalled()
    expect(cccs[0]!.roles).toEqual([])
  })

  it('withRoles: true ⇒ 逐 CCC 读取角色（调试页/ACP 的既有行为）', async () => {
    const a = makeCcc('ccc-roots-a-')
    const b = makeCcc('ccc-roots-b-')
    made.push(a, b)
    mkdirSync(join(a, '.opencode'), { recursive: true })
    writeFileSync(join(a, '.opencode', 'serenity.json'), JSON.stringify({ skiff: { roles: { qa: { msms: ['x'] } } } }))

    const cccs = await listCccs(fakeCtx({ workspaces: [{ path: a }, { path: b }] }) as never, { withRoles: true })
    expect(cccs[0]!.roles).toEqual(['qa'])
    expect(cccs[1]!.roles).toEqual([])
  })
})

describe('agentCwdFor / cccRootForExec / cccRootForCwd（L1 单根解析）', () => {
  it('agentCwdFor：取 exec.agent.session.header.cwd', () => {
    expect(agentCwdFor({ agent: { session: { header: { cwd: '/x/y' } } } })).toBe('/x/y')
  })

  it('🔴 agentCwdFor：exec.agent 缺失 ⇒ 回落 process.cwd()（语义逐字保留）', () => {
    const spy = vi.spyOn(process, 'cwd').mockReturnValue('/fallback/dir')
    expect(agentCwdFor({})).toBe('/fallback/dir')
    expect(agentCwdFor({ agent: {} })).toBe('/fallback/dir')
    expect(agentCwdFor({ agent: { session: {} } })).toBe('/fallback/dir')
    expect(agentCwdFor({ agent: { session: { header: {} } } })).toBe('/fallback/dir')
    spy.mockRestore()
  })

  it('agentCwdFor：直接传 agent（少数缝的形态）也认 session.header.cwd', () => {
    expect(agentCwdFor({ session: { header: { cwd: '/agent/dir' } } })).toBe('/agent/dir')
  })

  it('cccRootForCwd：CCC 内任意深度/文件路径 → 根；CCC 外 → null', () => {
    const root = makeCcc('ccc-roots-r-')
    made.push(root)
    expect(cccRootForCwd(root)).toBe(root)
    expect(cccRootForCwd(join(root, 'a', 'b', 'c'))).toBe(root)
    // 文件路径靠 dirname 上溯（trajectory 反查 SESSION.md 的既有用法）
    expect(cccRootForCwd(join(root, 'AGENT_SESSIONS', 'x', 'SESSION.md'))).toBe(root)
    // 系统临时目录根部（无 .serenity）→ null
    expect(cccRootForCwd(tmpdir())).toBeNull()
  })

  it('cccRootForExec：cwd 命中 CCC → 根；cwd **不在任何 CCC 内 → null**（不回落假根）', () => {
    const root = makeCcc('ccc-roots-e-')
    made.push(root)
    expect(cccRootForExec({ agent: { session: { header: { cwd: join(root, 'sub') } } } })).toBe(root)
    expect(cccRootForExec({ agent: { session: { header: { cwd: tmpdir() } } } })).toBeNull()
  })

  it('cccRootForExec：无 agent ⇒ 用 process.cwd() 上溯（故结果取决于进程 cwd，可能非 null）', () => {
    const spy = vi.spyOn(process, 'cwd').mockReturnValue(tmpdir())
    expect(cccRootForExec({})).toBeNull()
    spy.mockRestore()
  })

  it('统一错误文案常量（9 个工具的对外行为不变）', () => {
    expect(NO_CCC_FROM_AGENT_CWD).toBe('No CCC found: no .serenity file from agent cwd')
  })
})
