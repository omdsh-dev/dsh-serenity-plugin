/**
 * trajectory-tool.test.ts — `cognitive_trajectory` 工具的 **execute 分派面** 行为测试（⑤ 第 5 件）
 *
 * 🔴 为什么有这个文件（挑靶依据 = coverage 的**未覆盖行**；`fstat-no` 逐条命中）：
 *   本仓 coverage 实测 `src/tools/cognitive-trajectory.ts` **57.66%**，未覆盖的**函数**恰好是
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

import { createCognitiveTrajectoryTool } from '../src/tools/cognitive-trajectory.js'
import { hasSessionLogById } from '../src/session-cleanup.js'
import { resetActiveSessionStore, COGNITIVE_TRAJECTORY_ACTIONS } from '../src/cognitive-trajectory-ops.js'
import { setBindingStore, BINDINGS_REL_PATH } from '../src/cognitive-trajectory-bound.js'
import { NO_CCC_FROM_AGENT_CWD } from '../src/ccc-roots.js'

const mockHasLog = vi.mocked(hasSessionLogById)

const A_DIR = '2026-09-25--S900--alpha'
const B_DIR = '2026-09-25--S901--beta'
const A_BODY = '# SESSION: alpha\n- ID: S900\n'

let ccc: string

/** 工具对象在测试里是 defineTool 的透传形态 */
const tool = createCognitiveTrajectoryTool({ get: () => undefined } as never) as unknown as {
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
  return createCognitiveTrajectoryTool(ctx as never) as unknown as typeof tool
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

describe('cognitive_trajectory：工具面', () => {
  it('工具名 = cognitive_trajectory；action 必填且枚举 = COGNITIVE_TRAJECTORY_ACTIONS（10 个，含 archive/uid）', () => {
    expect(tool.name).toBe('cognitive_trajectory')
    expect(tool.parameters.action?.required).toBe(true)
    expect(tool.parameters.action?.enum).toEqual([...COGNITIVE_TRAJECTORY_ACTIONS])
    // 🔴 2026-10-18：8 → 9（`archive`）→ **10**（`uid`：唯一标识符，独立于编码与命名）
    expect(COGNITIVE_TRAJECTORY_ACTIONS).toHaveLength(10)
    expect(COGNITIVE_TRAJECTORY_ACTIONS).toContain('archive')
    expect(COGNITIVE_TRAJECTORY_ACTIONS).toContain('uid')
    for (const k of ['name', 'uid', 'summary', 'target', 'at', 'message', 'note', 'force', 'dryRun']) {
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

describe('cognitive_trajectory：list / show', () => {
  it('list = 清单 + 全库统计（summary 已并入 list）', async () => {
    writeSession(A_DIR)
    const out = (await run({ action: 'list' })) as string
    expect(out).toContain(A_DIR)
    expect(out).toContain('AGENT_SESSIONS Summary')
    // 🔴 2026-10-18：计数字样改为「Active (not archived)」（四项生命周期计数已删）
    expect(out).toContain('Active (not archived): 1')
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

describe('cognitive_trajectory：create', () => {
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
    // 真建了目录 + 写了绑定。🆕 2026-10-16（owner 令）：**无绑定 ⇒ 自动激活**（故 action=activate，不再是 create）
    expect(existsSync(join(ccc, BINDINGS_REL_PATH))).toBe(true)
    expect(bindings().sessions['dsh-1']?.action).toBe('activate')
    expect(bindings().sessions['dsh-1']?.note).toContain('auto-activated on create (no prior binding)')
  })

  it('desc + summary ⇒ 真建目录，目录名含日期与 desc 片段', async () => {
    await run({ action: 'create', desc: 'hello world', summary: '概' })
    const dirs = readdirSync(join(ccc, 'AGENT_SESSIONS'))
    expect(dirs.some((d) => d.includes('hello'))).toBe(true)
  })

  // ── 🆕 2026-10-16（owner 令）：create 的分支语义由「有无绑定」决定 ──
  // 两条路径**互为对照**：同样的 create，只因"当前有没有绑定"而行为不同。
  it('🆕 路径①：**无绑定** ⇒ 直接激活（写 activate 绑定 + 正文告知已自动激活）', async () => {
    writeSession(A_DIR)
    const out = (await run({ action: 'create', desc: 'fresh', summary: '概' })) as string
    expect(out).toContain('已自动激活')
    expect(out).toContain('此前**无绑定**')
    const rec = bindings().sessions['dsh-1']
    expect(rec?.action).toBe('activate')
    expect(rec?.note).toContain('auto-activated on create (no prior binding)')
    // 绑定指向**新**轨迹（不是 A_DIR）
    expect(rec?.dirName).toContain('fresh')
  })

  it('🆕 路径②：**已有绑定** ⇒ 只建不夺（绑定仍指原轨迹）+ 提示用 send-now 激活', async () => {
    writeSession(A_DIR)
    await run({ action: 'use', name: 'S900', summary: '概' }) // 先建立绑定
    const before = bindings().sessions['dsh-1']?.dirName
    expect(before).toBe(A_DIR)

    const out = (await run({ action: 'create', desc: 'later-work', summary: '概' })) as string
    expect(out).toContain('未')
    expect(out).toContain('send-now')
    expect(out).toContain(before as string) // 正文点名当前绑定是谁
    // 🔴 核心断言：**绑定没被夺走**（这正是 U6 要保的行为，不能被本次改动破坏）
    expect(bindings().sessions['dsh-1']?.dirName).toBe(A_DIR)
  })
})

describe('cognitive_trajectory：use —— 守卫与绑定（agentScope / agentDshSession / currentBoundDirName）', () => {
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
    await expect(run({ action: 'use', name: 'S901', summary: '概' })).rejects.toThrow(/would orphan the current cognitive trajectory/)
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

describe('cognitive_trajectory：use —— 重命名门面（两态）', () => {
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

describe('cognitive_trajectory：use —— advisoryHint（只提示不阻断）', () => {
  it('🔴 SESSION.md 陈旧（>7 天）⇒ **不再有 advisory**（年龄已不是判据）', async () => {
    // owner 2026-10-18：轨迹永存 ⇒ 「旧轨迹该退休了」这个前提消失。
    // 旧实现在这里会返回 `… 已 N 天未更新 …` 的告警；现在必须**完全静默**。
    // ⚠️ 这是**删除的钉子**：老化告警若回来，这条用例立刻红。
    const md = writeSession(A_DIR)
    const old = new Date(Date.now() - 8 * 86_400_000)
    utimesSync(md, old, old)
    const out = (await run({ action: 'use', name: 'S900', summary: '概' })) as Record<string, unknown>
    expect(out.advisory, '年龄不再是判据 ⇒ 不得给任何老化提示').toBeUndefined()
    // 正控：确实**激活成功**了（否则"无 advisory"可能只是因为它根本没跑到）
    expect(out.dir, '激活必须真的成功，才能证明"静默"是判据生效而非路径没走到').toBe(A_DIR)
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

describe('cognitive_trajectory：send-later（renderWakeEntry）', () => {
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

describe('cognitive_trajectory：其余动作的守卫与纯读面', () => {
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

/**
 * 🔴 2026-10-18 新增：`archive` —— 轨迹没有生命周期后，它是**唯一**的"状态变化"。
 *
 * 这组用例是本次改动的**核心判据**，四条各自对应一条会真出事的失效形态：
 *  ① 归档后**仍出现在 list 里** ⇒ "归档"名不副实（`readAllSessions` 漏了 `_` 跳过）
 *  ② 归档**覆盖了**同名既有轨迹 ⇒ 不可逆的丢失（唯一副本被毁）
 *  ③ 归档**改动了内容** ⇒ 它不是"换位置"，而是"改写历史"
 *  ④ 归档后 `use` 仍能激活它 ⇒ 归档区没有真正退出域
 */
describe('cognitive_trajectory：archive（🔴 唯一的"状态变化"，单向）', () => {
  it('归档成功 ⇒ 目录移入 _archived/，且 list 里**不再出现**（判据①）', async () => {
    writeSession(A_DIR)
    const listBefore = (await run({ action: 'list' })) as string
    expect(listBefore, '正控：归档前必须在清单里').toContain(A_DIR)

    const out = (await run({ action: 'archive', name: 'S900' })) as Record<string, unknown>
    expect(out.ok).toBe(true)
    expect(out.dirName).toBe(A_DIR)

    // 物理位置：旧路径没了、新路径在
    expect(existsSync(join(ccc, 'AGENT_SESSIONS', A_DIR)), '原位置必须已不存在').toBe(false)
    expect(existsSync(join(ccc, 'AGENT_SESSIONS', '_archived', A_DIR)), '必须落在 _archived/').toBe(true)

    // 🔴 判据①：list 里不得再出现
    const listAfter = (await run({ action: 'list' })) as string
    expect(listAfter, '归档后不得再出现在活跃清单里').not.toContain(A_DIR)
    // 空仓走 summarize 的专属文案（不是计数行）—— 这本身就是"活跃数为 0"的证据
    expect(listAfter).toContain('AGENT_SESSIONS/ is empty.')
    expect(listAfter, '归档件不得被计入活跃').not.toContain('Active (not archived): 1')
  })

  it('归档**不得覆盖**同名既有轨迹（判据②：不可逆丢失的护栏）', async () => {
    writeSession(A_DIR)
    await run({ action: 'archive', name: 'S900' })

    // 再建一个同名的新轨迹，并塞不同内容 —— 然后试图再归档
    writeSession(A_DIR, '# SESSION: alpha（新的一条，内容不同）\n')
    await expect(run({ action: 'archive', name: 'S900' })).rejects.toThrow('already exists in _archived/')

    // 🔴 负控：**先归档的那一份必须原封不动**（没被新内容覆盖，也没被删）
    const kept = readFileSync(join(ccc, 'AGENT_SESSIONS', '_archived', A_DIR, 'SESSION.md'), 'utf-8')
    expect(kept, '既有归档件的内容必须还是最早那一份').toBe(A_BODY)
    // 并确认新那条仍在活跃区（报错不应产生任何副作用）
    expect(existsSync(join(ccc, 'AGENT_SESSIONS', A_DIR)), '归档失败 ⇒ 活跃区那条必须原地不动').toBe(true)
  })

  it('归档只换位置，**内容逐字节不变**（判据③：它不是改写历史）', async () => {
    const md = writeSession(A_DIR)
    const before = readFileSync(md, 'utf-8')
    await run({ action: 'archive', name: 'S900' })
    const after = readFileSync(join(ccc, 'AGENT_SESSIONS', '_archived', A_DIR, 'SESSION.md'), 'utf-8')
    expect(after, 'SESSION.md 必须逐字节一致').toBe(before)
  })

  it('归档后 `use` 不再找得到它（判据④：归档区已退出域）', async () => {
    writeSession(A_DIR)
    await run({ action: 'archive', name: 'S900' })
    await expect(run({ action: 'use', name: 'S900', summary: '概' })).rejects.toThrow('Session not found')
  })

  it('dryRun ⇒ 只报路径不落盘（真故障形态：误用预览时把轨迹挪走了）', async () => {
    writeSession(A_DIR)
    const out = (await run({ action: 'archive', name: 'S900', dryRun: true })) as Record<string, unknown>
    expect(String(out.message)).toContain('[dry-run]')
    // 🔴 原地必须还在、归档区必须还不存在 —— 预览零副作用
    expect(existsSync(join(ccc, 'AGENT_SESSIONS', A_DIR)), 'dryRun 不得移动任何东西').toBe(true)
    expect(existsSync(join(ccc, 'AGENT_SESSIONS', '_archived', A_DIR)), 'dryRun 不得创建归档件').toBe(false)
  })

  it('目标不存在 ⇒ 抛（响亮失败，不静默成功）', async () => {
    await expect(run({ action: 'archive', name: 'S999' })).rejects.toThrow('Trajectory not found')
  })

  it('缺 name ⇒ 抛参数错', async () => {
    await expect(run({ action: 'archive' })).rejects.toThrow('archive requires name')
  })

  it('🔴 `_archived` 本身不是轨迹：它不出现在 list，也不能被归档', async () => {
    writeSession(A_DIR)
    await run({ action: 'archive', name: 'S900' })
    const list = (await run({ action: 'list' })) as string
    // 归档区目录名不得被当成一条轨迹列出来（`_` 前缀跳过的正控）
    expect(list, '`_archived` 不得出现在清单里').not.toContain('_archived')
    // 它的子项也不该被列
    expect(list).not.toContain(A_DIR)
  })
})

/**
 * 🔴 2026-10-18 新增：`uid` —— 认知轨迹的**唯一标识符**。
 *
 * owner 原话：*"命名很可能由于变化而变化，所以我们需要让认知轨迹支持一种用于交流的唯一标识符，
 * 它不同于编码和命名，而是单独设定的（也可以不设定，不设定就还是用编码），
 * 所有可以用编码操作的能力，都同样支持唯一标识符，唯一标识符用文件形式声明在认知轨迹目录中"*。
 *
 * 核心判据 = **"所有能用编码操作的，都能用 UID 操作"**（本组第 2 条就是它的机械形式）。
 */
describe('cognitive_trajectory：uid（唯一标识符，独立于编码与命名）', () => {
  const B_BODY = '# SESSION: beta\n- ID: S901\n'

  it('设定 UID ⇒ 落成目录内的声明文件；未设定 ⇒ 读回 null（不是错误）', async () => {
    writeSession(A_DIR)
    // 未设定：读回 null
    const before = (await run({ action: 'uid', name: 'S900' })) as Record<string, unknown>
    expect(before.uid).toBeNull()
    // 设定
    const set = (await run({ action: 'uid', name: 'S900', uid: 'alpha-main' })) as Record<string, unknown>
    expect(set.uid).toBe('alpha-main')
    // 文件真的落在轨迹目录内（owner："用文件形式声明在认知轨迹目录中"）
    const f = join(ccc, 'AGENT_SESSIONS', A_DIR, 'TRAJECTORY-UID')
    expect(existsSync(f), 'UID 必须是轨迹目录内的一个文件').toBe(true)
    expect(readFileSync(f, 'utf-8').trim()).toBe('alpha-main')
  })

  it('🔴 核心判据：所有能用编码操作的动作，同样接受 UID', async () => {
    // 这条是 owner 需求里最硬的一句的机械形式。只测 show 不够 —— 要逐条点名。
    writeSession(A_DIR)
    writeSession(B_DIR, B_BODY)
    await run({ action: 'uid', name: 'S900', uid: 'alpha-main' })

    // show：用 UID 能读到同一条
    const viaUid = (await run({ action: 'show', name: 'alpha-main' })) as string
    const viaId = (await run({ action: 'show', name: 'S900' })) as string
    expect(viaUid, 'show 用 UID 与用编码必须等价').toBe(viaId)

    // use：用 UID 能激活
    const used = (await run({ action: 'use', name: 'alpha-main', summary: '概' })) as Record<string, unknown>
    expect(used.dir).toBe(A_DIR)

    // uid 读回：用 UID 自己也能定位
    const readBack = (await run({ action: 'uid', name: 'alpha-main' })) as Record<string, unknown>
    expect(readBack.uid).toBe('alpha-main')

    // archive：用 UID 能归档
    const arch = (await run({ action: 'archive', name: 'alpha-main' })) as Record<string, unknown>
    expect(arch.ok).toBe(true)
    expect(existsSync(join(ccc, 'AGENT_SESSIONS', '_archived', A_DIR))).toBe(true)
  })

  it('UID 形态非法 ⇒ 拒（它要被逐字打出来交流，不容忍需转义的字符）', async () => {
    writeSession(A_DIR)
    // ⚠️ `''` 不在本组：空串是**清除**语义（回到用编码），不是"非法形态"。
    //    第一版我把它混进来，得到"清除成功"而不是"拒绝" —— 那是测试写错，不是产品缺陷。
    for (const bad of ['has space', '有中文', 'a/b', '-leading', 'x'.repeat(65)]) {
      await expect(run({ action: 'uid', name: 'S900', uid: bad }), `"${bad}" 应被拒`).rejects.toThrow()
    }
  })

  it('🔴 唯一性：重复 UID 被拒，且**不污染**既有的那一条（负控）', async () => {
    writeSession(A_DIR)
    writeSession(B_DIR, B_BODY)
    await run({ action: 'uid', name: 'S900', uid: 'shared' })
    await expect(run({ action: 'uid', name: 'S901', uid: 'shared' })).rejects.toThrow('已被')
    // 负控：A 的 UID 文件必须原封不动、B 的不得生成
    expect(readFileSync(join(ccc, 'AGENT_SESSIONS', A_DIR, 'TRAJECTORY-UID'), 'utf-8').trim()).toBe('shared')
    expect(existsSync(join(ccc, 'AGENT_SESSIONS', B_DIR, 'TRAJECTORY-UID'))).toBe(false)
  })

  it('清除（uid=""）⇒ 删除声明文件，回到用编码', async () => {
    writeSession(A_DIR)
    await run({ action: 'uid', name: 'S900', uid: 'alpha-main' })
    await run({ action: 'uid', name: 'S900', uid: '' })
    expect(existsSync(join(ccc, 'AGENT_SESSIONS', A_DIR, 'TRAJECTORY-UID'))).toBe(false)
    // 清除后仍可用编码操作（"不设定就还是用编码"）
    expect((await run({ action: 'show', name: 'S900' })) as string).toContain('alpha')
  })

  it('🔴 UID 精确匹配是大小写敏感的（`Alpha` ≠ `alpha`）', async () => {
    writeSession(A_DIR)
    await run({ action: 'uid', name: 'S900', uid: 'Alpha' })
    // 正控：精确大小写命中
    expect((await run({ action: 'show', name: 'Alpha' })) as string).toContain('SESSION: alpha')
    // 负控：小写**不命中 UID**。
    // ⚠️ 但它仍会落到**模糊目录名匹配**（目录名含 `alpha`）⇒ 整体仍能解析到同一条 ——
    //    这是**既有行为**（模糊分支在 UID 之前就存在），不是本改动引入的近似匹配。
    //    所以要断言的是"UID 这条路没命中"，判据 = 去掉模糊分支时它会失败。
    //    可机械验证的形态：用**目录名里不出现的**大小写变体。
    await run({ action: 'uid', name: 'S900', uid: 'Zulu' })
    await expect(
      run({ action: 'show', name: 'zulu' }),
      '小写 zulu 不得命中 UID "Zulu"（也不含在目录名里 ⇒ 两条路都不该命中）',
    ).rejects.toThrow('Session not found')
  })

  it('list 会印出已设定的 UID（它是用于交流的标识，得让人看得见）', async () => {
    writeSession(A_DIR)
    expect((await run({ action: 'list' })) as string).not.toContain('[alpha-main]')
    await run({ action: 'uid', name: 'S900', uid: 'alpha-main' })
    expect((await run({ action: 'list' })) as string).toContain('[alpha-main]')
  })

  it('🔴 UID 不改变本体：目录名与 SESSION.md 逐字节不变（与 archive 同一条纪律）', async () => {
    const md = writeSession(A_DIR)
    const before = readFileSync(md, 'utf-8')
    await run({ action: 'uid', name: 'S900', uid: 'alpha-main' })
    expect(existsSync(join(ccc, 'AGENT_SESSIONS', A_DIR)), '目录名不得因设定 UID 而改').toBe(true)
    expect(readFileSync(md, 'utf-8'), 'SESSION.md 不得被改写').toBe(before)
  })
})
