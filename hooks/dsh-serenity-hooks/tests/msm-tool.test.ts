/**
 * msm-tool.test.ts — `msm` 工具（v1.30 单入口：list/exec 合一）行为测试
 *
 * 🔴 为什么有这个文件（⑤ 第 3 件；挑靶依据 = coverage 的**未覆盖行**）：
 *   本仓 coverage 实测 `src/tools/msm.ts` 41.42%，未覆盖面 = **整个 `execute` 处理器
 *   ＋ 四个私有助手**（`agentSessionId` / `renderText` / `buildMsmIndex` / `suggestMsm`）
 *   —— 即"这个工具从没被真正执行过"。（注意：**不是**"没被提到" —— `coverage-gate`
 *   用正则匹配 import 字符串，**提到即算覆盖**，故该门禁看不见这类缺口。）
 *
 * 覆盖面（按 L3 工具面测法：**真实 CCC 夹具 + 真注册表 + 真 skiff 门控**，只桩掉子进程执行）：
 *   ① 工具面：名字 / 三参数 / render（字符串原样、非字符串 JSON）
 *   ② 根解析失败：无 `.serenity` ⇒ 抛 `NO_CCC_FROM_AGENT_CWD`
 *   ③ 精简目录（无 name）：空注册表 / 分组计数与降序 / 无 skill 归 `uncategorized` / 空白串等同无 name
 *   ④ 命中执行：载荷（`action:'exec'`、`args` 缺省 `[]`、透传、`inspect` ⇒ `['--schema', name]`）＋ name trim
 *   ⑤ 未命中候选：name 子串 / description 子串 / 全无匹配（回落目录）/ **limit=5** / flags 展示
 *   ⑥ Skiff 门控（**真 `skiffMsmGate`**，非替身）：白名单 list / 白名单内放行 / 白名单外拒绝 /
 *      未注册会话拒绝 / 白名单内未注册名 ⇒ 候选带前缀
 *
 * ⚠️ 诚实边界（与 ⑤ 前两件同）：本文件**不给覆盖率百分比**（MSM 输出会被截断，溢写文件在
 *   CCC 根外不可读）——证据是"这些行只能由本文件的断言触达"。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('@deepseek-ai/dsh-tools', () => ({ defineTool: (o: unknown) => o }))
vi.mock('@deepseek-ai/dsh-llm', () => ({ createUserMessage: (o: unknown) => o }))

// 只桩「跑子进程」这一步；注册表读取（loadMsmEntries/findEntry）走**真实现**（真夹具文件）。
vi.mock('../src/msm-ops.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/msm-ops.js')>()
  return {
    ...actual,
    runMsmAsync: vi.fn(async (root: string, args: Record<string, unknown>) => ({ stub: 'runMsmAsync', root, args })),
  }
})

import { msmTool } from '../src/tools/msm.js'
import { runMsmAsync } from '../src/msm-ops.js'
import { NO_CCC_FROM_AGENT_CWD } from '../src/ccc-roots.js'
import { registerSkiffSession, unregisterSkiffSession } from '../src/skiff-core.js'
import { SKIFF_SESSION_PREFIX } from '../src/skiff-role.js'

const mockRunMsmAsync = vi.mocked(runMsmAsync)

/** 工具对象在测试里是 defineTool 的透传形态 */
const tool = msmTool as unknown as {
  name: string
  description: string
  parameters: Record<string, { type?: string; items?: unknown; enum?: unknown }>
  output: { render: (args: unknown, value: unknown) => Array<{ type: string; text: string }> }
  execute: (a: unknown, e: unknown) => Promise<unknown>
}

/** 执行入口：默认 cwd = 夹具根；sessionId 省略 ⇒ 非 skiff ⇒ 门控恒放行 */
function exec(args: unknown, cwd = dir, sessionId?: string): Promise<unknown> {
  const session: Record<string, unknown> = { header: { cwd } }
  if (sessionId !== undefined) session.id = sessionId
  return tool.execute(args, { agent: { session } })
}

const CCC_NAME = 'testccc'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'msm-tool-'))
  writeFileSync(join(dir, '.serenity'), `${CCC_NAME}\n`)
  mockRunMsmAsync.mockClear()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 写注册表（真文件——走 loadMsmEntries 的真读路径） */
function writeRegistry(entries: unknown[]): void {
  const p = join(dir, '.opencode', 'skills', CCC_NAME, 'references')
  mkdirSync(p, { recursive: true })
  writeFileSync(join(p, 'mech-registry.json'), JSON.stringify({ version: 1, entries }, null, 2))
}

/** 写 CCC 配置（skiff 角色面） */
function writeConfig(cfg: unknown): void {
  mkdirSync(join(dir, '.opencode'), { recursive: true })
  writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify(cfg))
}

const THREE = [
  { name: 'alpha', skill: 'home-a', category: 'mech', description: 'Alpha tool' },
  { name: 'beta', skill: 'home-a', category: 'mech', description: 'Beta tool', flags: [{ name: 'x', type: 'string' }] },
  { name: 'gamma', skill: 'home-b', category: 'semi-mech', description: 'Gamma tool' },
]

describe('msm 工具面：名字 / 参数 / render', () => {
  it('工具名 = msm，参数 = name/args/inspect（三参数，单入口形态）', () => {
    expect(tool.name).toBe('msm')
    expect(Object.keys(tool.parameters).sort()).toEqual(['args', 'inspect', 'name'])
    expect(tool.parameters.args?.type).toBe('array')
    expect(tool.parameters.args?.items).toEqual({ type: 'string' })
    expect(tool.parameters.inspect?.type).toBe('boolean')
    // 描述里必须留着两条最易误用的语义（inspect 不执行 / 未命中返候选）
    expect(tool.description).toContain('inspect=true shows usage/flags without running')
    expect(tool.description).toContain('name not found returns matching candidates')
  })

  it('render：字符串原样；非字符串 ⇒ JSON 缩进两格', () => {
    expect(tool.output.render({}, 'plain text')).toEqual([{ type: 'text', text: 'plain text' }])
    expect(tool.output.render({}, { a: 1 })).toEqual([{ type: 'text', text: '{\n  "a": 1\n}' }])
  })
})

describe('msm：CCC 根解析失败', () => {
  it('cwd 无 .serenity ⇒ 抛统一文案 NO_CCC_FROM_AGENT_CWD', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'msm-bare-'))
    try {
      await expect(exec({ name: 'alpha' }, bare)).rejects.toThrow(NO_CCC_FROM_AGENT_CWD)
      expect(mockRunMsmAsync).not.toHaveBeenCalled()
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })
})

describe('msm：无 name ⇒ 精简目录（buildMsmIndex）', () => {
  it('空注册表 ⇒ 提示去 container_admin 注册（不抛）', async () => {
    expect(await exec({})).toBe('(no MSM registered — call container_admin register to add one)')
    expect(mockRunMsmAsync).not.toHaveBeenCalled()
  })

  it('有注册表 ⇒ 总数 + 按 skill 分组计数（降序）+ 四条用法指引', async () => {
    writeRegistry(THREE)
    const text = (await exec({})) as string
    expect(text).toContain('3 MSMs registered (by skill):')
    expect(text).toContain('  home-a: 2 MSM')
    expect(text).toContain('  home-b: 1 MSM')
    // 降序：2 条的分组排在 1 条之前
    expect(text.indexOf('home-a: 2')).toBeLessThan(text.indexOf('home-b: 1'))
    for (const line of [
      'Execute: msm("<name>", ["<args>"])',
      'Inspect: msm("<name>", [], inspect=true)',
      'Partial name returns matching candidates.',
      'Full listing: use container_admin (register/deregister/check).',
    ]) {
      expect(text).toContain(line)
    }
  })

  it('缺 skill 字段的条目归 uncategorized', async () => {
    writeRegistry([{ name: 'orphan', description: 'no skill field' }])
    expect(await exec({})).toContain('  uncategorized: 1 MSM')
  })

  it('name = 空白串 ⇒ 等同无 name（走目录，不执行）', async () => {
    writeRegistry(THREE)
    expect(await exec({ name: '   ' })).toContain('3 MSMs registered (by skill):')
    expect(mockRunMsmAsync).not.toHaveBeenCalled()
  })
})

describe('msm：命中 ⇒ 执行载荷', () => {
  beforeEach(() => writeRegistry(THREE))

  it('缺省 ⇒ action:exec、name 原样、args 缺省 []', async () => {
    await exec({ name: 'alpha' })
    expect(mockRunMsmAsync).toHaveBeenCalledTimes(1)
    expect(mockRunMsmAsync.mock.calls[0]?.[0]).toBe(dir)
    expect(mockRunMsmAsync.mock.calls[0]?.[1]).toEqual({ action: 'exec', name: 'alpha', args: [] })
  })

  it('args 透传（原样数组）', async () => {
    await exec({ name: 'alpha', args: ['status', '--json'] })
    expect(mockRunMsmAsync.mock.calls[0]?.[1]).toEqual({ action: 'exec', name: 'alpha', args: ['status', '--json'] })
  })

  it('inspect=true ⇒ 走协议 --schema 路径（不跑真实执行）', async () => {
    await exec({ name: 'beta', inspect: true })
    expect(mockRunMsmAsync.mock.calls[0]?.[1]).toEqual({ action: 'exec', name: 'beta', args: ['--schema', 'beta'] })
  })

  it('inspect=false 与省略等价（只有 === true 才查 schema）', async () => {
    await exec({ name: 'beta', inspect: false })
    expect(mockRunMsmAsync.mock.calls[0]?.[1]).toEqual({ action: 'exec', name: 'beta', args: [] })
  })

  it('name 前后空格被 trim 后再查表与执行', async () => {
    await exec({ name: '  alpha  ' })
    expect(mockRunMsmAsync.mock.calls[0]?.[1]).toEqual({ action: 'exec', name: 'alpha', args: [] })
  })
})

describe('msm：未精确命中 ⇒ 模糊候选（suggestMsm）', () => {
  beforeEach(() => writeRegistry(THREE))

  it('name 子串命中 ⇒ 候选行含 name | skill | category | description', async () => {
    const text = (await exec({ name: 'alp' })) as string
    expect(text).toContain('No exact MSM "alp" — did you mean one of these?')
    expect(text).toContain('alpha | home-a | mech | Alpha tool')
    expect(mockRunMsmAsync).not.toHaveBeenCalled()
  })

  it('description 子串也算命中（不只比 name）', async () => {
    const text = (await exec({ name: 'gamma t' })) as string
    expect(text).toContain('gamma | home-b | semi-mech | Gamma tool')
  })

  it('候选行带 flags 展示；无 flags ⇒ 不带该段', async () => {
    const text = (await exec({ name: 'bet' })) as string
    expect(text).toContain('beta | home-a | mech | Beta tool [flags: --x <string>]')
    expect(text).not.toContain('alpha | home-a | mech | Alpha tool [flags:')
  })

  it('缺 skill/category 时字段回落 "-"', async () => {
    writeRegistry([{ name: 'orphan', description: 'no skill field' }])
    const text = (await exec({ name: 'orph' })) as string
    expect(text).toContain('orphan | - | - | no skill field')
  })

  it('全无匹配 ⇒ 回落完整目录（含注册总数）', async () => {
    const text = (await exec({ name: 'zzz-nothing' })) as string
    expect(text).toContain('No MSM matches "zzz-nothing". Registered: 3 MSMs registered (by skill):')
  })

  it('候选数上限 5（第 6 条起不显示）', async () => {
    writeRegistry(Array.from({ length: 7 }, (_, i) => ({ name: `dup-${i}`, skill: 'home-a', description: 'dup' })))
    const text = (await exec({ name: 'dup' })) as string
    const rows = text.split('\n').slice(1)
    expect(rows).toHaveLength(5)
    expect(rows[0]).toContain('dup-0')
    expect(text).not.toContain('dup-5')
  })
})

describe('msm：Skiff 门控（真 skiffMsmGate）', () => {
  const qaId = `${SKIFF_SESSION_PREFIX}qa-msm-1`

  beforeEach(() => {
    writeRegistry(THREE)
    writeConfig({ skiff: { roles: { qa: { msms: ['alpha'], tools: [] } } } })
    registerSkiffSession(qaId, 'qa', dir, { session: { id: qaId, events: [] } } as never)
  })

  afterEach(() => {
    unregisterSkiffSession(qaId)
  })

  it('无 name ⇒ 只列本角色白名单（不列全仓目录）', async () => {
    const text = (await exec({}, dir, qaId)) as string
    expect(text).toBe('MSMs allowed in this role:\nalpha')
    expect(text).not.toContain('MSMs registered (by skill)')
  })

  it('exec 白名单内 ⇒ 放行到执行载荷', async () => {
    await exec({ name: 'alpha' }, dir, qaId)
    expect(mockRunMsmAsync.mock.calls[0]?.[1]).toEqual({ action: 'exec', name: 'alpha', args: [] })
  })

  it('exec 白名单外 ⇒ 抛错，且错误里不回显被拒的名字（不泄露名单）', async () => {
    await expect(exec({ name: 'gamma' }, dir, qaId)).rejects.toThrow('MSM not allowed')
    let message = ''
    try {
      await exec({ name: 'gamma' }, dir, qaId)
    } catch (err) {
      message = String((err as Error).message)
    }
    expect(message).not.toContain('gamma')
    expect(mockRunMsmAsync).not.toHaveBeenCalled()
  })

  // 🔴 本组顺带钉住一条**实测发现**：`src/tools/msm.ts` 里两处 `gate.whitelist` 分支**不可达** ——
  //   `whitelist` 只在 `skiffMsmGate(..., 'list', ...)` 里被返回，而 msm.ts 只在 **name 为空**时传
  //   `'list'`，且那一路在 L110 就**提前返回**了。于是 L117（白名单过滤）与 L125（候选加「已过滤」前缀）
  //   两处的 `gate.whitelist` **恒为 undefined**；exec 路的拒绝已由门控自己完成（`{reject}`）。
  //   ⇒ 下面这条用例钉的是**可观测契约**：白名单内、但未注册的名字 ⇒ 走**无前缀**的候选分支。
  it('白名单内但未注册 ⇒ 走无前缀候选分支（证明「加已过滤前缀」那条分支永不执行）', async () => {
    writeConfig({ skiff: { roles: { qa: { msms: ['ghost-msm'], tools: [] } } } })
    const text = (await exec({ name: 'ghost-msm' }, dir, qaId)) as string
    expect(text).toContain('No MSM matches "ghost-msm". Registered:')
    expect(text).not.toContain('(whitelisted role — candidates filtered)')
    expect(mockRunMsmAsync).not.toHaveBeenCalled()
  })

  it('skiff 会话未注册（进程重启遗留）⇒ 拒绝', async () => {
    await expect(exec({ name: 'alpha' }, dir, `${SKIFF_SESSION_PREFIX}ghost-9`)).rejects.toThrow(
      'MSM not allowed in this skiff session',
    )
  })
})
