/**
 * trajectory-skills-branches.test.ts — 🔴 **⑤ 第 67 件**：`src/trajectory-skills.ts` 的
 * **解析未定义形态 ＋ 缩进列表终止 ＋ 四处读取失败兜底 ＋ 观测回调护栏**
 * （2026-09-26 · 对应地图 §2.7 的续段）
 *
 * ## 为什么挑它（复扫读数，纪律 2）
 * `coverage/src/index.html`（01:2x 那一跑，第 66 件之后）**成对读**（纪律 16）实测：
 * `trajectory-skills.ts` = 语句 **96.63%（230/238）**／分支 **85.5%（59/69）**／函数 10/10
 * —— **`src/**` 中分支覆盖率最低且尚未做过**的文件。
 * 🔵 贴 objective：它是**轨迹技能注入面 = 与 DSH 的系统提示词衔接面**。
 * ⚠️ 成对读拦下的坑（纪律 16 第 7 次生效）：`gateway-dsh-auth.ts` 的 83.33% 是**函数列**（5/6），
 * 其**分支是 100%**；真正的低点是本文件（85.5%）⇒ 只读数值列会张冠李戴。
 *
 * ## 🔴 开工第一步 = 按【被测符号】核对既有登记（纪律 ⑯）
 * grep `trajectory-skills.js` 的 import 点 ⇒ 命中 `trajectory-skills.test.ts`（**515 行专测**）。
 * 逐块读过其覆盖面（**本件不重做其中任何一条**）：解析 ①②④⑤⑥ 五形态 ／ 注入装配 ／
 * 缺 skill 提示 ／ 长度截断 ／ 🔒 路径穿越 ／ section 注册门五态 ／ SEP 源码钉两枚 ＋
 * **SEP 语义孪生**（渲染输出级，含读数器自证）／ keeper 两条文案 ／ **CCC 级声明 v1.1 全套**
 * （readTrajectorySkills 三态 ／ mergeSkillNames ／ 并集装配 ／ 统一截断 ／ 注册门四态 ／ 动态注入）。
 * 🔵 ⇒ 既有覆盖面**很足**，本件只补它**结构上没碰过**的降级臂。
 *
 * ## 🔵 缺口形态（判据 = coverage 报告的 10 处 `cbranch-no`，逐条映射回源行）
 * | 源行 | 分支 | 可达性判定 |
 * |---|---|---|
 * | `:93` `fm[i] ?? ''` | undefined 侧 | ⛔ **不可达** —— `i < fm.length` 已界定 |
 * | `:96` `(m[1] ?? '')` | undefined 侧 | ⛔ **不可达** —— 正则组 `(.*)` 恒参与匹配 |
 * | `:102` `if (rest !== '') continue` | **continue 侧** | ✅ **可达** —— 裸标量 `skills: a` |
 * | `:105` `fm[j] ?? ''` | undefined 侧 | ⛔ **不可达** —— `j < fm.length` 已界定 |
 * | `:106` `if (!item) break` | **break 侧** | ✅ **可达** —— 列表后紧跟非 `- x` 行 |
 * | `:107` `item[1] ?? ''` | undefined 侧 | ⛔ **不可达** —— 同上，正则组恒参与 |
 * | `:132` catch（hasDeclaration） | 读失败 | ✅ **可达** —— 目录路径喂 `readFileSync` |
 * | `:201` catch（装配层） | 读失败 | ✅ **可达** |
 * | `:214` catch（观测回调） | 回调抛错 | ✅ **可达** |
 * | `:232` catch（skill 档读失败） | 读失败 | ✅ **可达** |
 * ⇒ 本件补 **6 处可达**；**4 处不可达如实登记、不涂绿**（纪律 ⑧）。
 *
 * ## 🔴 本件为何要紧（三条都是"写进注释却没人执行"的承诺）
 * ① **`:102` 是"不猜第三种形态"这条设计红线的唯一执行点**（函数头逐字："猜第三种等于自造契约"）——
 *    把 `continue` 删掉 ⇒ `skills: a` 会被当缩进列表继续往下扫，**把后面无关的 `- xxx` 行吸进声明**
 *    （注入一批用户根本没声明的 skill = 上下文被塞）而**既有测试全绿**（⑤ 只测了行内数组与未知键）。
 * ② **`:214` 是"统计失败绝不影响注入"的唯一执行点**（源码注释逐字，owner 令 2026-09-22）——
 *    统计是**旁路**，若它抛错能掀翻注入 ⇒ **一次统计缺陷 = 整条轨迹丢技能**。
 * ③ **`:132`/`:201`/`:232` 三处共守同一条承诺：「任何'拿不到全文'都必须响亮，绝不静默」**
 *    （规格 §3/§6-3/§6-6）——`:132` 写成 `return false` ⇒ **轨迹静默丢技能**（用户看不到任何信号）。
 *
 * ## 判据纪律（本件用到的高频条）
 * · **⑬ 降级面与正控方向成对测**：每条失败臂都配"同夹具的 happy path 必须走通"。
 * · **⑫ 错误码/文案钉"可分性"**：四条 notice **文案互不相同**，只断言"含 [缺失]"无法区分它们。
 * · **⑧ 不声称一个我没挣到的覆盖** ⇒ 4 处不可达在文件头登记，不写恒绿用例。
 * · **⑨ 观测回调的判据是"注入正文不受影响"，不是"回调收到名字"**（后者是既有覆盖面）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * fs 故障注入开关（hoisted）。
 * 🔴 为什么不用 `vi.spyOn(node:fs, …)`：node 内置模块导出是**不可重定义属性**
 * （第 57 件实测 `TypeError: Cannot redefine property: rmSync`）⇒ 本仓既有先例一律走
 * `vi.mock(importOriginal)` ＋ hoisted 开关。**缺省态为空集合 ⇒ 其余用例走真实 fs，零影响。**
 */
const h = vi.hoisted(() => ({
  /** 命中该子串的**读**操作抛错（模拟 EACCES/EISDIR 等真实读失败） */
  failRead: new Set<string>(),
  /** 命中该子串的**读**操作抛**非 Error**（字符串）——用于钉 `err instanceof Error ? … : String(err)` */
  throwString: new Set<string>(),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const shouldFail = (p: unknown): boolean =>
    typeof p === 'string' && [...h.failRead].some((frag) => p.includes(frag))
  const shouldThrowString = (p: unknown): boolean =>
    typeof p === 'string' && [...h.throwString].some((frag) => p.includes(frag))
  return {
    ...actual,
    readFileSync: (p: unknown, ...rest: unknown[]) => {
      if (shouldThrowString(p)) {
        // ⚠️ 抛**非 Error**（真实形态：中间层 `throw '字符串'`）；用 eslint 无关的裸 throw
        throw 'EACCES-simulated: non-Error throw'
      }
      if (shouldFail(p)) {
        // 真实故障形态：EISDIR 是"把目录当文件读"的原生错误，e2e 里最常见的读失败
        const e = new Error(`EISDIR: illegal operation on a directory, read '${String(p)}'`) as Error & { code: string }
        e.code = 'EISDIR'
        throw e
      }
      return (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)
    },
  }
})

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  parseDeclaredSkills,
  buildTrajectorySkillsSection,
  hasTrajectorySkillsDeclaration,
  TRAJECTORY_SKILLS_MAX_CHARS,
} from '../src/trajectory-skills.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'traj-skills-br-'))
  writeFileSync(join(dir, '.serenity'), 'test')
  h.failRead.clear()
  h.throwString.clear()
})

afterEach(() => {
  h.failRead.clear()
  h.throwString.clear()
  rmSync(dir, { recursive: true, force: true })
})

// ── 夹具 ──

function writeSkill(root: string, name: string, content: string): void {
  mkdirSync(join(root, '.opencode', 'skills', name), { recursive: true })
  writeFileSync(join(root, '.opencode', 'skills', name, 'SKILL.md'), content)
}

function writeSession(root: string, md: string): string {
  const d = join(root, 'AGENT_SESSIONS', '2026-09-26--S999--x')
  mkdirSync(d, { recursive: true })
  const p = join(d, 'SESSION.md')
  writeFileSync(p, md)
  return p
}

// ── A. 解析：未定义形态与列表终止（`:102` / `:106`）──

describe('trajectory-skills 退化面：解析的**未定义形态**与**缩进列表终止**', () => {
  it('🔴 `:102` 裸标量 `skills: a` ⇒ **视为无声明**（不得被当缩进列表继续往下吸）', () => {
    // 🔴 这是"不猜第三种形态"这条设计红线的**唯一执行点**（函数头逐字：规格 §2.1 只列了 ①②）。
    //    把 `continue` 删掉 ⇒ 本函数会继续往下扫，把**后面无关的** `- xxx` 行吸进声明。
    expect(parseDeclaredSkills('---\nskills: a\n---\n')).toEqual([])
    // 🔴 要害在这儿：**裸标量后面若恰好跟着看起来像列表的行，也不得吸进来**
    //    （真实形态：用户在 frontmatter 里写了别的缩进项，或 frontmatter 后是正文列表）
    expect(
      parseDeclaredSkills('---\nskills: home-rhetoric\n  - secret-a\n  - secret-b\n---\n'),
      '裸标量不得把后续裸 `- x` 行吸成声明（否则会注入用户根本没声明的 skill）',
    ).toEqual([])
  })

  it('🔵 正控：**合法的**两种形态在**同一夹具**下必须真的被解析出来（否则上面那条"空"不可判）', () => {
    expect(parseDeclaredSkills('---\nskills: [home-rhetoric]\n---\n'), '形式① 行内数组').toEqual(['home-rhetoric'])
    expect(parseDeclaredSkills('---\nskills:\n  - home-rhetoric\n---\n'), '形式② 缩进列表').toEqual(['home-rhetoric'])
  })

  it('🔴 `:106` 缩进列表遇到**非 `- x` 行** ⇒ `break`（止损，不得把后面的行当列表项）', () => {
    // 真实形态：frontmatter 里 skills 之后还有别的键 ⇒ 必须停在那个键上。
    // 把 `break` 改成 `continue` ⇒ 会继续扫到 frontmatter 末尾，
    // 把**同块里其它键的值**也当成 skill 名（例如 `name: x` 被吸成 skill "name: x"）。
    expect(parseDeclaredSkills('---\nskills:\n  - a\nname: S999\n  - b\n---\n')).toEqual(['a'])
    // 对照：`-` 行**连续**时要全部收（区分"该停"与"收不住"）
    expect(parseDeclaredSkills('---\nskills:\n  - a\n  - b\n  - c\n---\n')).toEqual(['a', 'b', 'c'])
  })

  it('🔴 `:102` 与 `:106` 的**组合形态**：空值 `skills:` 后紧跟另一个键 ⇒ 空声明（不是把那个键的名当 skill）', () => {
    expect(parseDeclaredSkills('---\nskills:\nname: x\n---\n')).toEqual([])
  })

  it('🔴 缩进列表**跑到 frontmatter 末尾** ⇒ 正常收完（不得越界/不得抛）', () => {
    // 🔵 这条专钉 `j < fm.length` 的**边界**：列表一直到最后一行时循环自然结束。
    //    ⚠️ 它与 `fm[j] ?? ''` 的 undefined 侧**不是**同一件事 —— 那个 `??` 在此不可达
    //    （循环条件已界定），本用例钉的是**行为边界**，不是那处分支。
    expect(parseDeclaredSkills('---\nskills:\n  - a\n  - b\n---\n')).toEqual(['a', 'b'])
  })
})

// ── B. `hasTrajectorySkillsDeclaration` 的读失败兜底（`:132`）──

describe('trajectory-skills 退化面：`:132` 读失败 ⇒ **响亮**（返回 true 交给装配层提示）', () => {
  it('🔴 SESSION.md 路径**存在但读不动**（真 EISDIR 形态）⇒ true，且**不抛**', () => {
    // 🔴 为何要紧：`hasTrajectorySkillsDeclaration` 是**注册门**。
    //    `:132` 若写成 `return false` ⇒ 该轨迹**静默丢技能**（用户看不到任何信号）——
    //    而源码注释逐字写明读失败要"交给装配层发响亮提示（不静默）"。
    // 真实故障形态：把**目录**当文件读（绑定记录指向目录、或归档时移走了文件只剩目录）
    const ghostDir = join(dir, 'AGENT_SESSIONS', 'ghost-as-dir', 'SESSION.md')
    mkdirSync(ghostDir, { recursive: true }) // 建一个**名为 SESSION.md 的目录**
    expect(() => hasTrajectorySkillsDeclaration(dir, ghostDir), '读失败不得抛').not.toThrow()
    expect(hasTrajectorySkillsDeclaration(dir, ghostDir), '读失败 ⇒ true（响亮，不静默丢）').toBe(true)
  })

  it('🔵 正控（同夹具两个方向）：文件在**且**有声明 ⇒ true；文件在**且**无声明 ⇒ false', () => {
    const withDecl = writeSession(dir, '---\nskills: [a]\n---\n')
    expect(hasTrajectorySkillsDeclaration(dir, withDecl)).toBe(true)
    const noDecl = writeSession(dir, '# SESSION\n无 frontmatter\n')
    expect(hasTrajectorySkillsDeclaration(dir, noDecl)).toBe(false)
    // 文件根本不在 ⇒ true（既有覆盖面，此处作正控的第三方向，证明判据不是在瞎返 true）
    expect(hasTrajectorySkillsDeclaration(dir, join(dir, 'nope', 'SESSION.md'))).toBe(true)
  })
})

// ── C. 装配层的读失败兜底（`:201` / `:232`）──

describe('trajectory-skills 退化面：装配层 `:201`（SESSION.md 读失败）与 `:232`（skill 档读失败）', () => {
  it('🔴 `:201` SESSION.md **存在但读不动** ⇒ notice 带 **EISDIR 原文**（可诊断），不抛', () => {
    const ghostDir = join(dir, 'AGENT_SESSIONS', 'ghost-as-dir', 'SESSION.md')
    mkdirSync(ghostDir, { recursive: true })
    const out = buildTrajectorySkillsSection(dir, ghostDir)
    expect(out, '读失败必须响亮').toContain('[缺失]')
    // ⑫ 可分性：与"文件不存在"那条 notice **文案不同** —— 前者写"读取失败：<原因>"
    expect(out, '读失败须带出底层原因（否则运维无从诊断）').toContain('读取失败')
    expect(out).toContain('EISDIR')
  })

  it('🔴 `:201` 与"文件不存在"是**两条可分**的 notice（只断言含 [缺失] 无法区分它们）', () => {
    const ghostDir = join(dir, 'AGENT_SESSIONS', 'ghost-as-dir', 'SESSION.md')
    mkdirSync(ghostDir, { recursive: true })
    const readFail = buildTrajectorySkillsSection(dir, ghostDir)
    const absent = buildTrajectorySkillsSection(dir, join(dir, 'nope', 'SESSION.md'))
    expect(readFail).toContain('读取失败')
    expect(absent).toContain('不存在')
    expect(absent).not.toContain('读取失败')
    expect(readFail).not.toContain('SESSION.md 不存在')
  })

  it('🔴 `:202` catch 里的 `err instanceof Error ? … : String(err)` ⇒ **非 Error 抛出物**也必须可读', () => {
    // 🔴 为什么单列一条：`readFileSync` **契约上**只抛 Error，但这段代码主动兜了"非 Error"——
    //    而**兜底本身也可能写坏**：若写成 `err.message`（去掉三元）⇒ 抛非 Error 时 notice 变
    //    "读取失败：undefined"（**诊断信息丢失**，运维看到的就是个 undefined）。
    //    真实形态：别的模块/中间层 `throw '字符串'`、或 Node 某些内部路径抛非 Error。
    const mdPath = writeSession(dir, '---\nskills: [a]\n---\n')
    h.throwString.add(join('AGENT_SESSIONS', '2026-09-26--S999--x')) // 真抛**字符串**（不是 Error）
    const out = buildTrajectorySkillsSection(dir, mdPath)
    expect(out, '非 Error 抛出物必须仍被渲染成可读文本').toContain('[缺失]')
    expect(out, '必须落到 String(err) 那一侧').toContain('读取失败：')
    expect(out, '不得出现 undefined（那是信息丢失）').not.toContain('读取失败：undefined')
    expect(out, '字符串抛出物的内容应在场').toContain('EACCES-simulated')
  })

  it('🔴 `:232` skill 档**存在但读不动** ⇒ 按该 skill 缺失处理（**其余 skill 仍须正常注入**）', () => {
    writeSkill(dir, 'good-one', 'GOOD 正文')
    writeSkill(dir, 'bad-one', 'BAD 正文')
    const mdPath = writeSession(dir, '---\nskills: [good-one, bad-one]\n---\n')
    h.failRead.add(join('skills', 'bad-one')) // 只让 bad-one 的 SKILL.md 读失败
    const out = buildTrajectorySkillsSection(dir, mdPath)
    // 🔴 判据一：坏的那个**响亮**（不是静默丢、也不是把空的拼进去）
    expect(out, '读不动的 skill 必须响亮').toContain('bad-one（未找到该 skill）')
    // 🔴 判据二（**更强**）：好兄弟**不受连累** —— 逐个 skill 失败不得中断整段装配
    //    （与第 45 件"清理与拆卸一律吞掉异常"同族：要断言**独立性**，不只断言"不抛"）
    expect(out, '其它 skill 仍须注入（独立性）').toContain('=== skill: good-one ===')
    expect(out).toContain('GOOD 正文')
    expect(out, '坏的那个不得把自己的正文拼进去').not.toContain('BAD 正文')
  })

  it('🔵 正控（同夹具）：不注入故障 ⇒ 两个 skill 都正常注入（证明上面那条的红是注入造成的）', () => {
    writeSkill(dir, 'good-one', 'GOOD 正文')
    writeSkill(dir, 'bad-one', 'BAD 正文')
    const mdPath = writeSession(dir, '---\nskills: [good-one, bad-one]\n---\n')
    const out = buildTrajectorySkillsSection(dir, mdPath)
    expect(out).toContain('GOOD 正文')
    expect(out).toContain('BAD 正文')
    expect(out).not.toContain('[缺失]')
  })
})

// ── D. 观测回调护栏（`:211`~`:217`）──

describe('trajectory-skills 退化面：`:214` 观测回调抛错 ⇒ **统计失败绝不影响注入**', () => {
  it('🔴 回调真抛 ⇒ 注入正文**逐字不变**（返回同一段文本），且不抛', () => {
    // 🔴 这是源码注释逐字承诺的唯一执行点（owner 令 2026-09-22）：
    //    "统计失败绝不影响注入正文（统计不是注入的一部分）"。
    //    回调是**旁路**：它抛错若能掀翻注入 ⇒ 一次统计缺陷 = 整条轨迹丢技能。
    writeSkill(dir, 'home-rhetoric', '# 修辞正文')
    const mdPath = writeSession(dir, '---\nskills: [home-rhetoric]\n---\n')

    // 🔵 基线：不传回调时的正文（下面要与它**逐字**比）
    const baseline = buildTrajectorySkillsSection(dir, mdPath)

    let calledWith: readonly string[] | null = null
    const out = buildTrajectorySkillsSection(dir, mdPath, TRAJECTORY_SKILLS_MAX_CHARS, [], (names) => {
      calledWith = names
      throw new Error('统计后端炸了') // 真抛（不是 mock 掉 try）
    })
    // 🔵 正控：回调**确实被调到了**（否则"不抛"可能是因为压根没走这条路径 = 假绿）
    expect(calledWith, '回调必须被真的调用（否则本用例测的是空）').toEqual(['home-rhetoric'])
    // 🔴 判据：注入正文逐字不变
    expect(out, '统计抛错不得改变注入正文一个字符').toBe(baseline)
    expect(out).toContain('# 修辞正文')
  })

  it('🔴 `names.length === 0` 时**不调**回调（空 section 不计数，`:206` 早退在其之前）', () => {
    // 源码注释逐字："放在 names.length === 0 之后 ⇒ 空 section 不计数天然成立"
    const mdPath = writeSession(dir, '# SESSION\n无 frontmatter\n')
    let calls = 0
    const out = buildTrajectorySkillsSection(dir, mdPath, TRAJECTORY_SKILLS_MAX_CHARS, [], () => {
      calls += 1
    })
    expect(out).toBe('')
    expect(calls, '空声明 ⇒ 回调一次都不该被调（宿主也会丢弃空块）').toBe(0)
  })

  it('🔴 回调收到的是**合并后去重**的名字（CCC 级在前），不是原始两串', () => {
    // 与既有 `mergeSkillNames` 覆盖面**互补**：那条钉合并函数本身，这条钉**回调看到的是合并结果**
    // （用量统计要按"本次请求真的带上了什么"计数 ⇒ 传原始两串会重复计）
    writeSkill(dir, 'base', 'BASE 正文')
    const mdPath = writeSession(dir, '---\nskills: [extra, base]\n---\n')
    let seen: readonly string[] = []
    buildTrajectorySkillsSection(dir, mdPath, TRAJECTORY_SKILLS_MAX_CHARS, ['base'], (names) => {
      seen = names
    })
    expect(seen, 'CCC 级在前、同名只留一次').toEqual(['base', 'extra'])
  })
})
