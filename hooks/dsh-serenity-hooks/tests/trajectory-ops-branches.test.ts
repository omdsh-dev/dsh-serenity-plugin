/**
 * trajectory-ops-branches.test.ts — 🔴 **⑤ 第 64 件**：`src/trajectory-ops.ts` 的
 * **createSession 入参校验面 ＋ show/list/summary 的退化臂**
 * （2026-09-26 · 对应地图 §2.7 的续段）
 *
 * ## 为什么挑它（复扫读数，纪律 2）
 * `coverage/src/index.html`（00:51 那一跑，第 63 件之后）实测：`src/**` 分支覆盖率
 * **最低且尚未做过**的文件 = `trajectory-ops.ts`（**84.65% = 160/189**；
 * 语句 94.85% ＝ 608/641；函数 28/28 已满）。
 * ⚠️ 复扫的成对读（纪律 16）再次拦下两个错靶：同为 83.33% 的两处，一处是
 * `gateway-dsh-auth.ts` 的**函数列**（其分支 100%），另一处 `git-ops.ts` 已在第 53 件做过。
 *
 * ## 🔴 开工第一步 = 按【被测符号】核对既有登记（纪律 ⑯）
 * 本件 grep `src/trajectory-ops.js` 的 import 点 ⇒ **命中 17 个文件**
 * （只有一个是按本模块命名的 `trajectory-ops.test.ts`；其余按**主题**散落：
 * `session-title` ／ `rebuild` ／ `keeper` ／ `skiff-core` ／ `trajectory-bound` ／
 * `seams/context-*` ／ `seams/lifecycle*` ／ `osp-alignment` ／ `cro-guide` ／
 * `trajectory-tool` ／ `rebuild-executor` ／ `skiff-core-branches`）。
 * ⇒ 🔵 **这正是纪律 ⑯ 存在的理由**：只看文件名会严重低估既有覆盖面。
 * 逐条核对后确认：**活跃会话内存模型**（set/get/clear/reset、scope 隔离）、
 * **events 恢复链**、**`resolveSessionByTitle` 三级优先序**、**create 正路与互斥**
 * 都已被覆盖 ⇒ 本件**不重做**其中任何一条。
 *
 * 🔵 **缺口形态**：既有用例走的是**「合法入参 + 正常目录」**，而下面两类从未被执行：
 *   · **`createSession` 的五条拒绝臂**（空 desc ／ desc 超 200 ／ issue 超 100 ／
 *     目录已存在 ×2 ／ dryRun 两条返回）
 *   · **`showSession` 的两条退化**（会话不存在 ⇒ 抛 ／ 目录在但无 SESSION.md ⇒ 提示串）
 *   · **`findSession` 的歧义臂**（多个模糊命中 ⇒ **报错而非猜**）
 *   · **`listSessions`/`summarize` 的 active 标记与 stale 告警**
 *
 * ## 🔴 本件为何要紧（objective 直指"长期存活"）
 * `createSession` 是**每条轨迹的出生点**；它的五条守卫是"用户输入错误要**响亮报错**、
 * 而不是**静默建出一个坏目录**"的唯一执行点。其中 `:317`/`:287` 的
 * 「目录已存在 ⇒ 抛」尤其要紧：**少了它，重跑一次 create 会把已有轨迹的 SESSION.md 覆盖掉**。
 *
 * ## 判据纪律（本件用到的高频条）
 * · **⑬ 降级面与正控方向成对测**：每条拒绝都配"合法入参必须放行"的对照。
 * · **⑧ 不声称一个我没挣到的覆盖**：`summarize` 的 `stale > 0` 臂只能靠
 *   **改 mtime** 构造（不 mock 时钟）—— 见 D 组说明。
 * · **终态判据钉盘上事实**，不钉返回值自述（纪律：响应说什么 ≠ 真做了什么）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, statSync, symlinkSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  createSession,
  findSession,
  listSessions,
  resetActiveSessionStore,
  sessionsRoot,
  showSession,
  summarize,
} from '../src/trajectory-ops.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'traj-ops-br-'))
  writeFileSync(join(dir, '.serenity'), 'test')
  mkdirSync(join(dir, 'AGENT_SESSIONS'), { recursive: true })
  resetActiveSessionStore()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function mk(desc: string, extra: Parameters<typeof createSession>[0] = {}): ReturnType<typeof createSession> {
  return createSession({ root: dir, desc, dryRun: false, ...extra })
}

/** 造一个"目录在但无 SESSION.md"的空壳轨迹 */
function mkEmptyDir(dirName: string): string {
  const p = join(sessionsRoot(dir), dirName)
  mkdirSync(p, { recursive: true })
  return p
}

describe('trajectory-ops 退化面：`createSession` 的五条拒绝臂（**绝不静默建坏目录**）', () => {
  it('🟢 正控（夹具自证）：合法 desc ⇒ 真建出目录 ＋ SESSION.md 落盘', () => {
    const r = mk('合法描述')
    expect(existsSync(r.sessionPath), '目录必须真被建出来').toBe(true)
    expect(existsSync(join(r.sessionPath, 'SESSION.md')), 'SESSION.md 必须落盘').toBe(true)
    expect(r.sessionId).toMatch(/^S\d{3}$/)
  })

  it('🔴 `:299` 空 desc ⇒ **上游 `:274` 先拦**（`:299` 是构造上不可达的冗余守卫 —— 如实登记，不涂绿）', () => {
    // 🔴 分诊结论（读源码判定，**未改生产**）：
    //   `:274`  `if (!desc && !issue) throw ...`
    //   `:299`  `if (!desc || desc.length === 0) throw 'description cannot be empty'`
    // `:299` 在 `:296` 的 `if (issue) {...}` **之后**、即「issue 为 falsy」才走到；
    // 而 issue 为 falsy 时，`:274` 放行的充要条件是 `!(!desc && !issue)` ⇒ **desc 必为真值**。
    // ⇒ `:299` 的两个析取项**都不可达**：`!desc`（与 `:274` 直接矛盾）／
    //    `desc.length === 0`（空串恰是 falsy，已被 `:274` 拦掉；`desc` 类型是 `string`，
    //    不存在"falsy 但 length>0"的值）。
    // ⇒ 这是**上游支配性守卫造成的死条件**，不是"我没测到"（纪律 ③：先问它为什么没跑）。
    //    **修法属删生产代码（`src/`）⇒ 须发版令（D14）** ⇒ 本件只登记、不删、不硬凑。
    //
    // 本用例把该结论**机械钉住**（它比"删掉不测"更有价值：后人若把 `:274` 改动/删掉，
    // 这条会红，从而暴露 `:299` 从"不可达"变成"可达但可能写错"）：
    expect(() => mk('')).toThrow(/requires either --desc or --issue/)
    expect(() => mk(''), '`:299` 的文案不得出现 —— 上游守卫必须先拦').not.toThrow(/description cannot be empty/)
    // 负控：盘上**没多出任何目录**（拒绝不得留副作用）
    expect(listSessions(dir)).toContain('(no sessions')
  })

  it('🔴 `:302` desc **超 200 字符** ⇒ 抛 `description too long`（且报出真实长度）', () => {
    const long = 'x'.repeat(201)
    expect(() => mk(long)).toThrow(/description too long: 201 chars \(max 200\)/)
    // 边界正控：**恰好 200** 必须放行（判据是 `> 200`，不是 `>= 200`）
    const r = mk('y'.repeat(200))
    expect(existsSync(r.sessionPath), '恰好 200 字符必须放行').toBe(true)
  })

  it('🔴 `:282` issue **超 100 字符** ⇒ 抛 `issue too long`；`--desc`/`--issue` **互斥**与**二选一**', () => {
    expect(() => createSession({ root: dir, issue: 'a'.repeat(101), dryRun: false })).toThrow(/issue too long: 101 chars \(max 100\)/)
    // 边界正控：恰好 100 放行
    const ok = createSession({ root: dir, issue: 'b'.repeat(100), dryRun: false })
    expect(existsSync(ok.sessionPath)).toBe(true)

    // `:274` 两个都没给 ⇒ 抛
    expect(() => createSession({ root: dir, dryRun: false })).toThrow(/requires either --desc or --issue/)
    // `:277` 两个都给 ⇒ 抛（互斥）
    expect(() => createSession({ root: dir, desc: 'd', issue: 'i', dryRun: false })).toThrow(/mutually exclusive/)
  })

  it('🔴 `:317` **目录已存在**（desc 模式）⇒ 抛，且**已有 SESSION.md 不被覆盖**（数据保全）', () => {
    // 🔴🔴 夹具构造（首跑红 × 4 逼出，生产代码无错）—— 这里有个**循环依赖陷阱**：
    //   ① 不能靠"跑两次"：`readAllSessions` 的 maxId 扫描会让第二次拿到**新 S###**。
    //   ② 🔴 **也不能靠"预建那个目录"**：预建的目录**本身会被扫描计入 maxId**
    //      ⇒ nextId 跟着抬高 ⇒ 目标路径**永远逃跑**（连"问 dryRun 拿路径"也没用：
    //      dryRun 返回时路径不存在，一建出来 maxId 就变了 ⇒ 与 ① 是同一个陷阱）。
    //   ⇒ 唯一出路：造一个 **`existsSync` 为真、但 `readAllSessions` 看不见**的对象。
    //      判据（读源码）：扫描过滤条件是 `e.isDirectory()`（`:136`），而 `existsSync`
    //      只要求"能 stat 到"。**指向目录的符号链接**恰好满足两者 ⇒ 用它当诱饵：
    //      · `readdirSync({withFileTypes})` 对 symlink 报 `isDirectory() === false` ⇒ 不计入 maxId
    //      · `existsSync(<symlink>)` 跟随链接 ⇒ 为真 ⇒ 命中 `:317`
    const first = mk('同名描述')
    const md = join(first.sessionPath, 'SESSION.md')
    const before = readFileSync(md, 'utf-8')

    // 先问生产代码"下一次会建在哪"（dryRun 不落盘 ⇒ 零副作用）
    const dry = createSession({ root: dir, desc: '同名描述', dryRun: true })
    // 造诱饵：另建一个真实目录，再用**指向它**的同名 symlink 占住目标路径
    const decoyReal = join(dir, '_decoy-real')
    mkdirSync(decoyReal, { recursive: true })
    writeFileSync(join(decoyReal, 'SESSION.md'), before, 'utf-8')
    symlinkSync(decoyReal, dry.sessionPath) // ⇒ 目标路径"已存在"，但不进 maxId 扫描

    // 正控（纪律 10）：先证明夹具真的命中了那个分支条件，而不是碰巧抛了别的错
    expect(existsSync(dry.sessionPath), '正控：诱饵必须让 existsSync 为真').toBe(true)

    expect(() => mk('同名描述'), '重复创建必须被拦截').toThrow(/Session directory already exists/)

    // 🔴 **本件最要紧的判据**：拒绝**不得**留下副作用 —— 诱饵里的 SESSION.md 逐字不变
    expect(readFileSync(join(decoyReal, 'SESSION.md'), 'utf-8'),
      '被拒的 create 绝不得覆盖既有 SESSION.md').toBe(before)
    // 且**首条**的 SESSION.md 也不得被动过
    expect(readFileSync(md, 'utf-8')).toBe(before)
  })

  it('🔴 `:287` **目录已存在**（issue 模式）：同 issue 重复创建 ⇒ 抛（与 desc 模式是**两条独立**守卫）', () => {
    const first = createSession({ root: dir, issue: 'TEST-1', dryRun: false })
    expect(existsSync(first.sessionPath)).toBe(true)
    expect(() => createSession({ root: dir, issue: 'TEST-1', dryRun: false })).toThrow(/already exists/)
  })

  it('🔴 `:290`/`:320` **dryRun 两条返回**：不建目录、但给出**将要建的路径**与不同文案', () => {
    // issue 模式（`:290`）
    const dryIssue = createSession({ root: dir, issue: 'DRY-1', dryRun: true })
    expect(dryIssue.message).toContain('[dry-run]')
    expect(dryIssue.sessionId).toBe('DRY-1')
    expect(existsSync(dryIssue.sessionPath), 'dryRun 绝不得建目录').toBe(false)

    // desc 模式（`:320`）
    const dryDesc = createSession({ root: dir, desc: '预演', goal: '目标', dryRun: true })
    expect(dryDesc.message).toContain('[dry-run]')
    // 🔴 desc 模式多一行 `goal=`（与 issue 模式文案**不同** —— 两条分支各自的形态）
    expect(dryDesc.message).toContain('goal=目标')
    expect(existsSync(dryDesc.sessionPath), 'dryRun 绝不得建目录').toBe(false)

    // desc 模式的 dryRun 仍分配 id（S001，因为盘上无会话）
    expect(dryDesc.sessionId).toBe('S001')

    // 🔴 **dryRun 后真跑**：同一描述必须能建出来（证明 dryRun 确实没占位）
    const real = mk('预演')
    expect(existsSync(real.sessionPath), 'dryRun 后再真跑必须成功').toBe(true)
  })

  it('🔴 `:302` goal 缺省 ⇒ dryRun 文案写 `(none)`（不出现 undefined）', () => {
    const d = createSession({ root: dir, desc: '无目标', dryRun: true })
    expect(d.message).toContain('goal=(none)')
    expect(d.message, '文案里不得出现字面量 undefined').not.toContain('undefined')
  })
})

describe('trajectory-ops 退化面：`showSession` / `findSession` 的报错与歧义', () => {
  it('🔴 `:204` 会话不存在 ⇒ **抛**（不是回空串）', () => {
    expect(() => showSession(dir, 'no-such-session')).toThrow(/Session not found/)
  })

  it('🔴 `:208` 目录在但**无 SESSION.md** ⇒ 回提示串（**不抛**）', () => {
    mkEmptyDir('2026-01-01--S900--empty-shell')
    const out = showSession(dir, 'S900')
    expect(out).toContain('no SESSION.md')
    expect(out).toContain('2026-01-01--S900--empty-shell')
  })

  it('🟢 正控：正常会话 ⇒ 回 `# dirName` ＋ SESSION.md 原文', () => {
    const r = mk('可读会话')
    const out = showSession(dir, r.sessionId)
    expect(out.startsWith(`# ${r.dirName}\n\n`)).toBe(true)
    expect(out).toContain('可读会话')
  })

  it('🔴 `:172` **歧义模糊匹配**（多个命中）⇒ **报错而非猜**（这是"不猜"设计红线的执行点）', () => {
    mk('alpha one')
    mk('alpha two') // 两条都含 "alpha"
    expect(() => findSession(sessionsRoot(dir), 'alpha'), '多命中必须报错').toThrow(/Found 2 sessions matching/)
  })

  it('🔴 `findSession` 三级优先序：**精确目录名 > S### ID > 唯一模糊**', () => {
    const a = mk('精确优先')
    // ① 精确目录名
    expect(findSession(sessionsRoot(dir), a.dirName)?.dirName).toBe(a.dirName)
    // ② S### ID（且容许 `S1`→`001` 补零形态）
    expect(findSession(sessionsRoot(dir), a.sessionId)?.dirName).toBe(a.dirName)
    expect(findSession(sessionsRoot(dir), 'S1')?.dirName).toBe(a.dirName)
    // ③ 唯一模糊子串
    expect(findSession(sessionsRoot(dir), '精确优')?.dirName).toBe(a.dirName)
    // ④ 完全没有 ⇒ null（不抛）
    expect(findSession(sessionsRoot(dir), 'zzz-nope')).toBeNull()
  })
})

describe('trajectory-ops 退化面：`listSessions` 的 active 标记与 `summarize` 的 stale 告警', () => {
  it('🔴 `:191`/`:192` active 三态标记：`●`（active）／`✓`（completed）／`○`（普通）', () => {
    const a = mk('甲')
    const b = mk('乙')
    // 把乙标成完成（`[x]` 是机器契约本体 —— 与 sessionMdTemplate 逐字对齐）
    const mdB = join(b.sessionPath, 'SESSION.md')
    writeFileSync(mdB, readFileSync(mdB, 'utf-8').replace('- 状态: [ ] 进行中', '- 状态: [x] 已完成'), 'utf-8')

    // 甲作为 activeId ⇒ 甲显 ●；乙已完成 ⇒ ✓
    const out = listSessions(dir, a.sessionId)
    const lineA = out.split('\n').find((l) => l.includes(a.dirName))!
    const lineB = out.split('\n').find((l) => l.includes(b.dirName))!
    expect(lineA.startsWith('●'), 'activeId 命中 ⇒ ●').toBe(true)
    expect(lineB.startsWith('✓'), '完成 ⇒ ✓').toBe(true)

    // 🔴 `:191` 的**守卫**：`activeId` 未给 ⇒ 即便有完成项也不得把普通项错标成 ●
    const noActive = listSessions(dir)
    const lineA2 = noActive.split('\n').find((l) => l.includes(a.dirName))!
    expect(lineA2.startsWith('○'), '未指定 activeId ⇒ 一律 ○（不是 ●）').toBe(true)
  })

  it('🔴 `summarize`：空仓 → 专属文案；有会话 → 六行计数 ＋ 最近 5 条', () => {
    expect(summarize(dir)).toBe('AGENT_SESSIONS/ is empty.')

    mk('报告甲')
    mk('报告乙')
    const out = summarize(dir)
    expect(out).toContain('AGENT_SESSIONS Summary')
    expect(out).toContain('Total:    2')
    expect(out).toContain('Active:   2')
    expect(out).toContain('Completed: 0')
    expect(out).toContain('Recent activity (top 5):')
    // 未超期 ⇒ **不得**出现 stale 告警（`:636` 的 `stale > 0` 右侧）
    expect(out, '无 stale 时不得打印告警').not.toContain('⚠ Warning')
  })

  it('🔴 `:636` `stale > 0` 告警臂：把 mtime 推到 **8 天前**（真 fs 操作，不 mock 时钟）', () => {
    // 🔴 真故障形态：`HEALTH_STALE_DAYS = 7` ⇒ 把 mtime 改到 8 天前
    //    （用 `utimesSync` 改**真实体**；不 mock 时钟、不改生产常量 —— 纪律 ⑧）
    // 🔴 **两条夹具事实（首跑红逼出，生产代码无错）**：
    //   ① **`utimesSync` 接受 `Date`（或**秒**），我原先传 `(Date.now()-8d)/1000` 却
    //      把它当成"毫秒数"直接给了 —— 实参被当作**秒**解释 ⇒ 落成一个**远未来**的时间
    //      ⇒ 摘要打印 `(-1d ago)`（负龄）。仓库既有先例（`trajectory-tool.test.ts:293`
    //      ／ `session-cleanup.test.ts`）**一律传 `Date`** ⇒ 本件对齐先例，改用 `Date`。
    //   ② 🔴 **决定 stale 的是【目录】的 mtime，不是 SESSION.md 的** ——
    //      `readSessionEntry` 取 `statSync(dirPath)`（`src/trajectory-ops.ts:121-126`）
    //      ⇒ 只改 SESSION.md 的 mtime **不会**影响 stale 计数（**两个都要改**）。
    const r = mk('陈旧轨迹')
    const md = join(r.sessionPath, 'SESSION.md')
    const old = new Date(Date.now() - 8 * 86_400_000)
    utimesSync(md, old, old)
    utimesSync(r.sessionPath, old, old)

    // 🟢 先证明读数器不瞎（纪律 10：夹具正控）—— 8 天前必须真的落了盘
    expect(Math.floor((Date.now() - statSync(r.sessionPath).mtimeMs) / 86_400_000),
      '正控：目录 mtime 必须真的是 8 天前（否则下面的断言无法区分"守卫生效"与"夹具坏了"）').toBe(8)

    const out = summarize(dir)
    expect(out).toContain('Stale:    1')
    expect(out, '有 stale ⇒ 必须打印告警').toContain('⚠ Warning: stale trajectories present')
    // 正控方向：另一条**新鲜**的不得被算进 stale
    mk('新鲜轨迹')
    const out2 = summarize(dir)
    expect(out2).toContain('Stale:    1')
    expect(out2).toContain('Total:    2')
  })

  it('🔴 `summarize` 的 Ghost 计数：目录在但无 SESSION.md 计一（`:619`）', () => {
    mk('正常')
    mkEmptyDir('2026-01-01--S901--ghost-shell')
    const out = summarize(dir)
    expect(out).toContain('Total:    2')
    expect(out, '幽灵轨迹（无 SESSION.md）必须被计入').toContain('Ghost:    1')
  })
})
