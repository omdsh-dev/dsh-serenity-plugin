/**
 * trajectory-tool.test.ts — `container_trajectory` 工具的 **execute 分派面** 行为测试（⑤ 第 5 件）
 *
 * 🔴 为什么有这个文件（挑靶依据 = coverage 的**未覆盖行**；`fstat-no` 逐条命中）：
 *   本仓 coverage 实测 `src/tools/trajectory.ts` **57.66%**，未覆盖的**函数**恰好是
 *   `agentScope` / `agentDshSession` / `currentBoundDirName` / `renderText`（＋ `output.render`）/
 *   `renderWakeEntry` / `advisoryHint` —— 它们**只经由本工具的 `execute` 进入**，
 *   而既有的 `trajectory-ops.test.ts`（测纯函数）与 `session-title.test.ts`（测重命名门面）
 *   **都不调用 `execute`** ⇒ 这六处是"**被提到、但从没被执行**"（§3-9 #5 的形态）。
 *
 * 测法（L3 工具面；**真实现 + 真夹具**，只在两处不可控面上打桩，理由逐条写在下）：
 *   · 真：`findSession` / `useSession` / `createSession` / `listSessions` / `showSession` /
 *     `addWake` ／ `appendBound`（绑定落 `.bindings.json`）／ 真 `skiff`-free 的 fake ctx/exec
 *   · 桩 ① `../src/session-cleanup.js` 的 `hasSessionLogById`：**宿主会话日志面在测试里不可能是真的**
 *     （夹具的 dsh 会话 id 在宿主机上没有日志）⇒ 打成可控开关：默认 `true`（= 有日志 ⇒ 不剪枝），
 *     一条用例置 `false` 以覆盖**悬空绑定剪枝**分支。⚠️ 不桩它的话，`(c)` 分支会**恒剪掉刚写的绑定**
 *     ⇒ 断言会变成"测宿主机上有没有那个 session"，即**环境耦合的假绿**。
 *   · 桩 ② `setBindingStore(null)`：把绑定存储钉回 CCC 内 `.bindings.json`（既有先例
 *     `tests/trajectory-bound.test.ts` 同款）⇒ 全程密闭、不碰 `~/.dsh/storages/`。
 *
 * 覆盖面（按动作）：工具面/render ／ 根解析失败 ／ list ／ show ／ create（summary 必填·dry-run 豁免·
 *   issue 豁免·真建目录＋写 create 绑定）／ use（summary 必填·未找到·**happy 写 activate 绑定**·
 *   **G1 切换守卫（拒 / --force 放行 + action=switch）**·**重命名成功与不可用两态**·**advisory 陈旧分支**·
 *   **空壳目录的实际失败点（钉住 advisory ① 分支不可达）**·无 agent session）／ send-later（守卫·回执渲染·
 *   长消息截断）／ send-now（守卫）／ rebuild（两条守卫）／ cro-guide ／ 未知动作。
 *
 * ⚠️ 诚实边界（同 ⑤ 前几件）：**不写覆盖率百分比**（MSM 输出会被截断）；证据 = 这些函数只由本文件的断言触达。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('@deepseek-ai/dsh-tools', () => ({ defineTool: (o: unknown) => o }))
vi.mock('@deepseek-ai/dsh-llm', () => ({ createUserMessage: (o: unknown) => o }))

// 桩 ①（理由见文件头）：宿主会话日志面在测试里不可为真 ⇒ 打成可控开关
vi.mock('../src/session-cleanup.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/session-cleanup.js')>()
  return { ...actual, hasSessionLogById: vi.fn(() => true) }
})

import { createTrajectoryTool } from '../src/tools/trajectory.js'
import { hasSessionLogById } from '../src/session-cleanup.js'
import { resetActiveSessionStore, TRAJECTORY_ACTIONS } from '../src/trajectory-ops.js'
import { setBindingStore, BINDINGS_REL_PATH } from '../src/trajectory-bound.js'
import { NO_CCC_FROM_AGENT_CWD } from '../src/ccc-roots.js'

const mockHasLog = vi.mocked(hasSessionLogById)

const A_DIR = '2026-09-25--S900--alpha'
const B_DIR = '2026-09-25--S901--beta'
const A_BODY = '# SESSION: alpha\n- ID: S900\n'

let ccc: string

/** 工具对象在测试里是 defineTool 的透传形态 */
const tool = createTrajectoryTool({ get: () => undefined } as never) as unknown as {
  name: string
  parameters: Record<string, { type?: string; enum?: string[]; required?: boolean }>
  output: { render: (args: unknown, value: unknown) => Array<{ type: string; text: string }> }
  execute: (a: unknown, e: unknown) => Promise<unknown>
}

/** 建一条轨迹目录（dirName 形如 `2026-09-25--S900--alpha`）；`withMd=false` ⇒ 空壳 */
function writeSession(dirName: string, body = A_BODY, withMd = true): string {
  const dir = join(ccc, 'AGENT_SESSIONS', dirName)
  mkdirSync(dir, { recursive: true })
  const md = join(dir, 'SESSION.md')
  if (withMd) writeFileSync(md, body)
  return md
}

/** dsh 会话替身：`append` 存在是 `agentDshSession` 的判据；`header` 供绑定定位 */
function fakeExec(opts: { id?: string; append?: boolean; cwd?: string } = {}): never {
  const session: Record<string, unknown> = { header: { id: opts.id ?? 'dsh-1', cwd: opts.cwd ?? ccc } }
  if (opts.append !== false) session.append = () => {}
  return { agent: { session } } as never
}

/** fake ctx：`sessionTitle` 服务可给可不给（覆盖重命名门面的成功/降级两态） */
function fakeCtx(opts: { titles?: { rename: (s: unknown, t: string) => unknown } } = {}): never {
  return { get: (n: string) => (n === 'sessionTitle' ? opts.titles : undefined) } as never
}

function run(args: unknown, exec = fakeExec()): Promise<unknown> {
  return tool.execute(args, exec)
}

/** 用指定 ctx 重新构造工具（仅「重命名两态」组用） */
function toolWith(ctx: unknown) {
  return createTrajectoryTool(ctx as never) as unknown as typeof tool
}

function bindings(): { version: number; sessions: Record<string, { dirName: string; action: string; note?: string }> } {
  return JSON.parse(readFileSync(join(ccc, BINDINGS_REL_PATH), 'utf-8'))
}

function wakeRegistry(): { entries?: Array<{ id: string; target: string; state: string }> } {
  return JSON.parse(readFileSync(join(ccc, 'AGENT_SESSIONS', 'wake-registry.json'), 'utf-8'))
}

beforeEach(() => {
  ccc = mkdtempSync(join(tmpdir(), 'traj-tool-'))
  writeFileSync(join(ccc, '.serenity'), 'trajtest\n')
  mkdirSync(join(ccc, 'AGENT_SESSIONS'), { recursive: true })
  resetActiveSessionStore()
  setBindingStore(null) // 桩 ②：绑定钉回 CCC 内文件
  mockHasLog.mockReturnValue(true)
})

afterEach(() => {
  rmSync(ccc, { recursive: true, force: true })
  setBindingStore(null)
  resetActiveSessionStore()
})

describe('container_trajectory：工具面', () => {
  it('工具名 = container_trajectory；action 必填且枚举 = TRAJECTORY_ACTIONS（8 个）', () => {
    expect(tool.name).toBe('container_trajectory')
    expect(tool.parameters.action?.required).toBe(true)
    expect(tool.parameters.action?.enum).toEqual([...TRAJECTORY_ACTIONS])
    expect(TRAJECTORY_ACTIONS).toHaveLength(8)
    for (const k of ['name', 'summary', 'target', 'at', 'message', 'note', 'force', 'dryRun']) {
      expect(tool.parameters[k], `缺参数 ${k}`).toBeDefined()
    }
  })

  it('render：字符串原样；非字符串 ⇒ JSON 缩进（覆盖 renderText）', () => {
    expect(tool.output.render({}, 'text')).toEqual([{ type: 'text', text: 'text' }])
    expect(tool.output.render({}, { ok: true })).toEqual([{ type: 'text', text: '{\n  "ok": true\n}' }])
  })

  it('cwd 不在任何 CCC 内 ⇒ 抛 NO_CCC_FROM_AGENT_CWD（不误报"session not found"）', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'traj-bare-'))
    try {
      await expect(run({ action: 'list' }, fakeExec({ cwd: bare }))).rejects.toThrow(NO_CCC_FROM_AGENT_CWD)
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })
})

describe('container_trajectory：list / show', () => {
  it('list = 清单 + 全库统计（summary 已并入 list）', async () => {
    writeSession(A_DIR)
    const out = (await run({ action: 'list' })) as string
    expect(out).toContain(A_DIR)
    expect(out).toContain('AGENT_SESSIONS Summary')
    expect(out).toContain('Total:    1')
  })

  it('空库：list 报无会话且统计为空库文案（不抛）', async () => {
    const out = (await run({ action: 'list' })) as string
    expect(out).toContain('(no sessions in AGENT_SESSIONS/)')
    expect(out).toContain('AGENT_SESSIONS/ is empty.')
  })

  it('show 缺 name ⇒ 抛；有 name ⇒ 回 SESSION.md 正文', async () => {
    writeSession(A_DIR)
    await expect(run({ action: 'show' })).rejects.toThrow('show requires name')
    expect((await run({ action: 'show', name: 'S900' })) as string).toContain('# SESSION: alpha')
  })
})

describe('container_trajectory：create', () => {
  it('非 dry-run 且非 issue：缺 summary ⇒ 抛（且不建目录）', async () => {
    await expect(run({ action: 'create', desc: 'x' })).rejects.toThrow('create requires --summary')
    expect(readdirSync(join(ccc, 'AGENT_SESSIONS'))).toHaveLength(0)
  })

  it('dry-run 豁免 summary（未真实创建 ⇒ 不写绑定）', async () => {
    const out = (await run({ action: 'create', desc: 'preview', dryRun: true })) as string
    expect(out.length).toBeGreaterThan(0)
    expect(existsSync(join(ccc, BINDINGS_REL_PATH))).toBe(false)
  })

  it('issue 会话豁免 summary（编号固定派生、无概括语义）', async () => {
    await run({ action: 'create', issue: 'apaas-1' })
    // 真建了目录 + 写了 create 审计绑定（绑定不改当前载体）
    expect(existsSync(join(ccc, BINDINGS_REL_PATH))).toBe(true)
    expect(bindings().sessions['dsh-1']?.action).toBe('create')
    expect(bindings().sessions['dsh-1']?.note).toContain('binding unchanged until explicit use')
  })

  it('desc + summary ⇒ 真建目录，目录名含日期与 desc 片段', async () => {
    await run({ action: 'create', desc: 'hello world', summary: '概' })
    const dirs = readdirSync(join(ccc, 'AGENT_SESSIONS'))
    expect(dirs.some((d) => d.includes('hello'))).toBe(true)
  })
})

describe('container_trajectory：use —— 守卫与绑定（agentScope / agentDshSession / currentBoundDirName）', () => {
  it('缺 summary ⇒ 抛（不动绑定）', async () => {
    writeSession(A_DIR)
    await expect(run({ action: 'use', name: 'S900' })).rejects.toThrow('use requires --summary')
  })

  it('目标不存在 ⇒ 抛（文案指向 list）', async () => {
    await expect(run({ action: 'use', name: 'S999', summary: '概' })).rejects.toThrow('Session not found: "S999"')
  })

  it('happy：激活 + 写 activate 绑定（dirName/mdPath/sessionId）+ 回 dir/mdPath/context', async () => {
    const md = writeSession(A_DIR)
    const out = (await run({ action: 'use', name: 'S900', summary: '概' })) as Record<string, string>
    expect(out.dir).toBe(A_DIR)
    expect(out.mdPath).toBe(md)
    expect(out.context).toContain('SESSION.md path:')
    const rec = bindings().sessions['dsh-1']
    expect(rec?.dirName).toBe(A_DIR)
    expect(rec?.action).toBe('activate')
  })

  it('🔴 G1 切换守卫：已绑定 A ⇒ 用 B 被拒（文案说明会 orphan 当前轨迹）', async () => {
    writeSession(A_DIR)
    writeSession(B_DIR)
    await run({ action: 'use', name: 'S900', summary: '概' })
    await expect(run({ action: 'use', name: 'S901', summary: '概' })).rejects.toThrow(/would orphan the current trajectory/)
    // 被拒后绑定不变（仍是 A）
    expect(bindings().sessions['dsh-1']?.dirName).toBe(A_DIR)
  })

  it('🔴 G1 放行：--force ⇒ 真切换，绑定 action=switch + note=forced switch', async () => {
    writeSession(A_DIR)
    writeSession(B_DIR)
    await run({ action: 'use', name: 'S900', summary: '概' })
    await run({ action: 'use', name: 'S901', summary: '概', force: true })
    const rec = bindings().sessions['dsh-1']
    expect(rec?.dirName).toBe(B_DIR)
    expect(rec?.action).toBe('switch')
    expect(rec?.note).toBe('forced switch')
  })

  it('重复 use 同一条（非切换）仍记 activate（守卫只挡"换目标"）', async () => {
    writeSession(A_DIR)
    await run({ action: 'use', name: 'S900', summary: '概' })
    await run({ action: 'use', name: 'S900', summary: '概' })
    expect(bindings().sessions['dsh-1']?.action).toBe('activate')
  })

  it('agent 无 session ⇒ 仍激活成功，但不写绑定（不抛）', async () => {
    writeSession(A_DIR)
    // ⚠️ `cwd` 必须在场：缺它 ⇒ `agentCwdFor` 回落 `process.cwd()` ⇒ 会解析到**跑测试的那个真 CCC 根**
    //   （本轮实测踩到：报 "Session not found: S900"，因为它在真 AGENT_SESSIONS 里找夹具会话）
    const exec = { agent: { session: { header: { id: 'x', cwd: ccc } } } } // 无 append ⇒ agentDshSession → null
    const out = (await run({ action: 'use', name: 'S900', summary: '概' }, exec as never)) as Record<string, string>
    expect(out.dir).toBe(A_DIR)
    expect(existsSync(join(ccc, BINDINGS_REL_PATH))).toBe(false)
  })

  it('🔴 悬空绑定剪枝：宿主侧无该会话日志 ⇒ prunedBindings 出现在结果里', async () => {
    writeSession(A_DIR)
    mockHasLog.mockReturnValue(false)
    const out = (await run({ action: 'use', name: 'S900', summary: '概' })) as Record<string, unknown>
    expect(Array.isArray(out.prunedBindings)).toBe(true)
    expect((out.prunedBindings as string[]).length).toBeGreaterThan(0)
  })

  it('宿主机读不到会话日志根（hasSessionLogById=true）⇒ 不剪枝（fail-closed 保留）', async () => {
    writeSession(A_DIR)
    const out = (await run({ action: 'use', name: 'S900', summary: '概' })) as Record<string, unknown>
    expect(out.prunedBindings).toBeUndefined()
  })
})

describe('container_trajectory：use —— 重命名门面（两态）', () => {
  it('有 sessionTitle 服务 ⇒ rename 收到命名标题（S###-日期-概括）', async () => {
    writeSession(A_DIR)
    const rename = vi.fn()
    const t = toolWith(fakeCtx({ titles: { rename } }))
    await t.execute({ action: 'use', name: 'S900', summary: '概' }, fakeExec())
    expect(rename).toHaveBeenCalledTimes(1)
    const title = rename.mock.calls[0]?.[1] as string
    expect(title).toContain('S900')
    expect(title).toContain('概')
    expect(title.startsWith('S900-')).toBe(true)
  })

  it('无 sessionTitle 服务 ⇒ 不抛（主流程完成），仅告警', async () => {
    writeSession(A_DIR)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = (await run({ action: 'use', name: 'S900', summary: '概' })) as Record<string, string>
    expect(out.dir).toBe(A_DIR)
    expect(warn.mock.calls.some((c) => String(c[0]).includes('重命名未执行'))).toBe(true)
    warn.mockRestore()
  })
})

describe('container_trajectory：use —— advisoryHint（只提示不阻断）', () => {
  it('SESSION.md 陈旧（>7 天）⇒ 结果带 advisory 与天数', async () => {
    const md = writeSession(A_DIR)
    const old = new Date(Date.now() - 8 * 86_400_000)
    utimesSync(md, old, old)
    const out = (await run({ action: 'use', name: 'S900', summary: '概' })) as Record<string, string>
    expect(out.advisory).toContain('天未更新')
    expect(out.advisory).toContain(A_DIR)
  })

  it('SESSION.md 新鲜 ⇒ 无 advisory 键（通过就静默）', async () => {
    writeSession(A_DIR)
    const out = (await run({ action: 'use', name: 'S900', summary: '概' })) as Record<string, unknown>
    expect(out.advisory).toBeUndefined()
  })

  it('🔴 空壳目录（无 SESSION.md）⇒ 失败发生在 useSession，**不是** advisory —— 钉住 advisory 空壳分支不可达', async () => {
    // 判据：`advisoryHint` 只有本工具一个调用点，且它排在 `useSession` **之后**；
    // 而 `useSession` 对同一 mdPath 已经做过 existsSync 校验（同 root、同 key ⇒ 同一个 entry）
    // ⇒ 走到 advisoryHint 时文件**必然存在** ⇒ 空壳分支除"竞态"外不可达。
    writeSession(A_DIR, A_BODY, false)
    const err = await run({ action: 'use', name: 'S900', summary: '概' }).catch((e: Error) => e)
    expect(String((err as Error).message)).toContain('has no SESSION.md')
    expect(String((err as Error).message)).not.toContain('空壳')
  })
})

describe('container_trajectory：send-later（renderWakeEntry）', () => {
  const at = (): string => new Date(Date.now() + 3_600_000).toISOString()

  it('缺 target/at/message 任一 ⇒ 抛（三个都点名）', async () => {
    await expect(run({ action: 'send-later', at: at(), message: 'm' })).rejects.toThrow(/requires target/)
    await expect(run({ action: 'send-later', target: 'S900', message: 'm' })).rejects.toThrow(/requires target/)
    await expect(run({ action: 'send-later', target: 'S900', at: at() })).rejects.toThrow(/requires target/)
  })

  it('happy：落注册表 + 回执含 id/state/at/target/by + 补跑窗与不可回收声明', async () => {
    const out = (await run({ action: 'send-later', target: 'S900', at: at(), message: 'ping' })) as {
      ok: boolean
      output: string
    }
    expect(out.ok).toBe(true)
    expect(out.output).toContain('✓ 已登记唤醒')
    expect(out.output).toContain('[pending]')
    expect(out.output).toContain('target=S900')
    expect(out.output).toContain('补跑窗口 2h')
    expect(out.output).toContain('不可回收')
    const reg = wakeRegistry()
    expect(reg.entries?.[0]?.target).toBe('S900')
    expect(reg.entries?.[0]?.id.startsWith('w-')).toBe(true)
  })

  it('长消息（>120 字）在回执里截断到 120 + 省略号；短消息原样', async () => {
    const long = 'x'.repeat(200)
    const out = (await run({ action: 'send-later', target: 'S900', at: at(), message: long })) as { output: string }
    expect(out.output).toContain(`${'x'.repeat(120)}…`)
    expect(out.output).not.toContain('x'.repeat(121))
    const out2 = (await run({ action: 'send-later', target: 'S901', at: at(), message: 'short' })) as { output: string }
    expect(out2.output).toContain('message: short')
  })
})

describe('container_trajectory：其余动作的守卫与纯读面', () => {
  it('send-now 缺 target / message ⇒ 抛（与 send-later 同款文案风格）', async () => {
    await expect(run({ action: 'send-now', message: 'm' })).rejects.toThrow('send-now requires target')
    await expect(run({ action: 'send-now', target: 'S900' })).rejects.toThrow('send-now requires target')
  })

  it('rebuild 缺 summary ⇒ 先抛（不进入 queueRebuild）', async () => {
    await expect(run({ action: 'rebuild' }, fakeExec({ id: 'sess' }))).rejects.toThrow('rebuild requires --summary')
  })

  it('rebuild 有 summary 但拿不到 dsh 会话 id ⇒ 抛（第二道守卫）', async () => {
    const noId = { agent: { session: { header: { cwd: ccc }, append: () => {} } } }
    await expect(run({ action: 'rebuild', summary: '概' }, noId as never)).rejects.toThrow(
      'Unable to determine the current dsh session id',
    )
  })

  it('cro-guide ⇒ 纯读返回 CRO 指南正文（不抛、不写盘）', async () => {
    const out = (await run({ action: 'cro-guide' })) as string
    expect(out).toContain('CRO')
    expect(typeof out).toBe('string')
    expect(existsSync(join(ccc, BINDINGS_REL_PATH))).toBe(false)
  })

  it('未知动作 ⇒ 抛 Unknown action（响亮而非静默）', async () => {
    await expect(run({ action: 'nope' })).rejects.toThrow('Unknown action: nope')
  })
})
