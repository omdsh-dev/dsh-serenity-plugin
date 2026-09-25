/**
 * opencode-skills-branches.test.ts — `seams/opencode-skills.ts` 的**缺省字段面**（⑤ 第 50 件，2026-09-25）
 *
 * ── 挑靶依据（机械，不是叙述）───────────────────────────────────────────────
 * 按 ⑤ 换挡后的入口「**按分支覆盖率排序**」复扫 `coverage/src/**` ⇒
 * `seams/opencode-skills.ts` = 分支 **77.77%（14/18）**，是 `src/**` 中**最低的未被做过**的文件
 * （43~49 已做完：`diag-ops` ／ `compact` ／ `lifecycle` ／ `seams/context` ／ `weixin-hook` ／
 *  `wake-scheduler` ／ `tools/handyman`）。🔵 **它的形态很特殊**：**语句已 100%（65/65）、函数 3/3** ——
 * 也就是说**每一行都跑过**，但**四条分支的另一侧从没走过**。这种"语句满分、分支缺口"正是
 * ⑤ 换挡（从"补零执行函数"转向"语义深度／分支覆盖"）要抓的对象。
 *
 * ⚠️ **读表纪律（累积纪律 16）**：本件挑靶时**按"文件名单元格 ＋ 数值单元格"成对读**核对，
 * 未再重蹈第 49 件"只读 `data-value` 列而张冠李戴"的覆辙。
 *
 * ── 🔴 为何这 4 处从未被走过（本件的核心发现）────────────────────────────────
 * 未覆盖的 4 处**全部是「可选字段缺失时的默认值」**，而既有 `opencode-skills.test.ts`
 * （159 行）的两个夹具 skill **都是"字段填满"的**：
 *   · `home-git`  → `name` ＋ `description` ＋ `whenToUse`（**三样俱全**）
 *   · `home-media`→ `name` ＋ `description`（无 `whenToUse`，但既有用例**只读 `home-git` 的该字段**）
 * 且**每个 `list()` 调用都显式传了 `cwd`**。⇒ 🔴 **结论**：
 * **"字段齐全"之外的所有退化形态从来没有被执行过**。
 *
 * 为什么这件事重要（不是覆盖率数字）：`.opencode/skills/<name>/SKILL.md` 的 frontmatter 是
 * **CCC 手写的**，`description` 与 `whenToUse` **都是可选键**（opencode 标准）——
 * 手写 skill 常只写 `name`。⇒ 这四条分支正是**真实产物的常态**，而不是边缘情形。
 * 把 `|| '(opencode skill)'` 误删、或把 `whenToUse` 三元写反（无值时也塞个空串），
 * **既有测试全绿**，而 DSH 侧要么拿到 `undefined` 当描述、要么拿到一条**空 whenToUse**。
 *
 * 逐处清单（源码行 = 本件写作时的锚；**行号只作"某版本的实测读数"**）：
 *   D1 `:24` `options.cwd ?? process.cwd()` —— **`??` 的右侧**（调用方不给 cwd）
 *   D2 `:34` `list` 的 `skill.meta.description || '(opencode skill)'` —— **`||` 的右侧**
 *   D3 `:35` `...(skill.meta.whenToUse ? { whenToUse } : {})` —— **假侧**（**不得出现该键**）
 *   D4 `:53` `get` 的 `skill.meta.description || candidate.description` —— **`||` 的右侧**
 *   （另：`:54` `get` 的 `whenToUse` 三元假侧 —— 与 D3 同款，一并钉住以互证）
 *
 * ── 本件测的是什么（不是"覆盖率数字"）──────────────────────────────────────
 *   ① **缺省值必须是"有意义的兜底"，不是"空"**：无 description ⇒ 候选仍须有描述文本
 *      （DSH 侧据此展示），而不是 `undefined`。
 *   ② 🔴 **"无值时不得出现该键"是契约**（D3/D4）：`whenToUse` 的假侧是 `{}` 而**不是**
 *      `{ whenToUse: undefined }` —— 后者会让 `'whenToUse' in candidate` 为真，
 *      下游若按"键在不在"判能力就会**误判**。
 *      ⇒ 断言用 **`'whenToUse' in obj`** 而非 `toBeUndefined()`（后者两者都过 —— 弱断言）。
 *   ③ **`get` 的描述兜底来源不同**（D4 用 `candidate.description`，与 `list` 的常量兜底
 *      **不是同一个来源**）⇒ 必须**分别**钉，否则改错了来源也不会红。
 *   ④ **cwd 缺省不得让 provider 崩**（D1）：`options.cwd` 缺席时回落 `process.cwd()`，
 *      而它**大概率不在任何 CCC 内** ⇒ 正确行为是**空候选 + complete:true**（不是抛错）。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────────
 *  · **夹具先有正控**（累积纪律 10）：先证"字段齐全 ⇒ 描述/`whenToUse` 都到位"，
 *    再证退化形态 —— 否则无法区分"兜底生效"与"夹具压根没建对"。
 *  · **真故障形态**：真写 `SKILL.md` 文件（不 mock `loadOpencodeSkill`），
 *    让被测模块走**真实的 frontmatter 解析**路径。
 *  · `it()` 标题内不用直引号（用「」）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { registerOpencodeSkills, OPENCODE_PROVIDER, OPENCODE_RANK } from '../src/seams/opencode-skills.js'

type Candidate = {
  name: string
  description: string
  whenToUse?: string
  provider: string
  rank: number
  resourceBase: { kind: string; path: string }
  locator: string
  path: string
}
type ListRes = { candidates: Candidate[]; complete: boolean }
type Provider = {
  list: (o: { cwd?: string }) => Promise<ListRes>
  get: (c: { locator?: string; description?: string; invocation?: unknown; source?: string; resourceBase?: unknown }) => Promise<Record<string, unknown> | undefined>
}

let dir = ''

/** 建一个 skill 目录（**真文件**，让 frontmatter 走真实解析） */
function mkSkill(name: string, frontmatter: string, body = 'body'): void {
  const d = join(dir, '.opencode', 'skills', name)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}`)
}

/** 取到 provider（真注册一次，再取回工厂产出的实例） */
function provider(): Provider {
  let captured: (() => Provider) | null = null
  const ctx = {
    skills: { registerProvider: (fn: () => Provider) => { captured = fn } },
  }
  registerOpencodeSkills(ctx as never)
  if (!captured) throw new Error('registerProvider 未被调用（夹具坏了）')
  return (captured as () => Provider)()
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oc-skills-br-'))
  writeFileSync(join(dir, '.serenity'), 'test-ccc\n')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('opencode-skills 分支面: 可选字段缺省（list）', () => {
  it('正控：字段齐全 ⇒ description 与 whenToUse 都到位（证明夹具不瞎）', async () => {
    mkSkill('full', 'name: full\ndescription: 全字段\nwhenToUse: 该用时')
    const res = await provider().list({ cwd: dir })
    const c = res.candidates.find((x) => x.name === 'full')
    // 🔴 正控先行：若这条红了，下面的"兜底"断言就无法区分
    //    "兜底生效"与"夹具压根没把 skill 建对"。
    expect(c?.description).toBe('全字段')
    expect(c?.whenToUse).toBe('该用时')
  })

  it('🔴 D2：无 description ⇒ 兜底「(opencode skill)」（不是 undefined、不是空串）', async () => {
    mkSkill('nodesc', 'name: nodesc') // 只写 name —— 手写 skill 的常态
    const res = await provider().list({ cwd: dir })
    const c = res.candidates.find((x) => x.name === 'nodesc')
    // 🔴 断言"有意义的兜底"：DSH 侧要用它做展示 ⇒ undefined / 空串都算坏
    expect(c).toBeDefined()
    expect(c?.description).toBe('(opencode skill)')
  })

  it('🔴 D3：无 whenToUse ⇒ **键不存在**（不是 whenToUse: undefined）', async () => {
    mkSkill('nowhen', 'name: nowhen\ndescription: 无 whenToUse')
    const res = await provider().list({ cwd: dir })
    const c = res.candidates.find((x) => x.name === 'nowhen')
    expect(c).toBeDefined()
    // 🔴 契约：三元假侧是 `{}`，不是 `{ whenToUse: undefined }`。
    //    断言 **`in`** 而非 `toBeUndefined()` —— 后者对两种写法都绿（弱断言，
    //    纪律 13/17 同族：无法区分"契约成立"与"字段虽在但值为空"）。
    expect('whenToUse' in (c as object)).toBe(false)
    // 交叉佐证：序列化后也不该冒出该键（若写成 undefined，JSON.stringify 会丢它，
    // 但 `in` 已经抓住；这里再钉一层"载荷形状"）
    expect(JSON.parse(JSON.stringify(c))).not.toHaveProperty('whenToUse')
  })

  it('🔴 D3 反侧：有 whenToUse（含空白字符串也算"有"）⇒ 键在', async () => {
    mkSkill('blankwhen', 'name: blankwhen\ndescription: d\nwhenToUse: " "')
    const res = await provider().list({ cwd: dir })
    const c = res.candidates.find((x) => x.name === 'blankwhen')
    // 🔴 这条钉的是"判据是 truthy 而非 trim" —— 若有人改成 `trim()` 判空，
    //    这条会红，从而把一处**语义变更**暴露出来（现行实现是 `? :` 的 truthy 判）。
    expect(c).toBeDefined()
    expect('whenToUse' in (c as object)).toBe(true)
  })

  it('🔴 D1：`cwd` **缺席** ⇒ 回落 process.cwd() 且**不抛**（大概率不在 CCC 内 ⇒ 空候选）', async () => {
    mkSkill('s1', 'name: s1\ndescription: d')
    const res = await provider().list({}) // 不传 cwd
    // 🔴 语义：**cwd 缺席不得让 provider 崩**。回落 process.cwd()（= 本仓/测试运行目录，
    //    祖先链上未必有 .serenity）⇒ 正确行为 = 空候选 + complete:true。
    //    ⚠️ 只断言"不抛"是弱测试（纪律 12/17 同族）⇒ 同时钉形状：complete 仍为 true。
    expect(res.complete).toBe(true)
    expect(Array.isArray(res.candidates)).toBe(true)
  })

  it('🔴 D1 反侧：`cwd` 在 CCC 内 ⇒ 正常返回候选（正控，证明上面不是"永远空"）', async () => {
    mkSkill('s2', 'name: s2\ndescription: d')
    const res = await provider().list({ cwd: dir })
    // 🔴 与上一条**成对**：证明 D1 的空候选是"cwd 落错地方"的结论，
    //    而不是"夹具根本产不出候选"。
    expect(res.candidates.map((c) => c.name)).toContain('s2')
  })
})

describe('opencode-skills 分支面: 可选字段缺省（get）', () => {
  it('正控：get 字段齐全 ⇒ description 来自 skill 自身', async () => {
    mkSkill('g-full', 'name: g-full\ndescription: 自身描述\nwhenToUse: 该用时')
    const p = provider()
    const c = (await p.list({ cwd: dir })).candidates.find((x) => x.name === 'g-full')!
    const def = await p.get(c)
    expect(def?.description).toBe('自身描述')
    expect(def?.whenToUse).toBe('该用时')
  })

  it('🔴 D4：get 时 skill **无 description** ⇒ 兜底用 **candidate.description**（不是那个常量）', async () => {
    // 🔴 关键：`get` 的兜底来源与 `list` **不同** —— list 用常量 '(opencode skill)'，
    //    get 用 **candidate 上已有的 description**。两者必须分别钉，
    //    否则"把 get 的兜底改成常量"这种改动不会红。
    mkSkill('g-nodesc', 'name: g-nodesc') // 无 description
    const p = provider()
    const listed = (await p.list({ cwd: dir })).candidates.find((x) => x.name === 'g-nodesc')!
    // candidate 上的描述此时已是 list 的常量兜底
    expect(listed.description).toBe('(opencode skill)')
    // 手工把 candidate 的 description 换成一个**可辨识的值** ⇒ 才能证明 get 用的是它
    const def = await p.get({ ...listed, description: '来自候选的描述（可辨识）' })
    expect(def?.description).toBe('来自候选的描述（可辨识）')
    // 🔴 负控：**不得**是 list 的那个常量（否则说明 get 走错了兜底来源）
    expect(def?.description).not.toBe('(opencode skill)')
  })

  it('🔴 D4 反侧：get 时 skill **有** description ⇒ 用 skill 自身的（候选的被忽略）', async () => {
    mkSkill('g-hasdesc', 'name: g-hasdesc\ndescription: skill 自己的')
    const p = provider()
    const listed = (await p.list({ cwd: dir })).candidates.find((x) => x.name === 'g-hasdesc')!
    const def = await p.get({ ...listed, description: '候选的（不该被采用）' })
    expect(def?.description).toBe('skill 自己的')
  })

  it('🔴 D4 同款：get 的 whenToUse 无值 ⇒ **键不存在**', async () => {
    mkSkill('g-nowhen', 'name: g-nowhen\ndescription: d')
    const p = provider()
    const listed = (await p.list({ cwd: dir })).candidates.find((x) => x.name === 'g-nowhen')!
    const def = await p.get(listed)
    expect(def).toBeDefined()
    // 与 D3 同款契约：假侧是 `{}`，键不得出现
    expect('whenToUse' in (def as object)).toBe(false)
  })

  it('契约保持：provider 名与 rank 在两条路径上一致（低 250，本地 .dsh/skills 优先）', async () => {
    mkSkill('g-rank', 'name: g-rank\ndescription: d')
    const p = provider()
    const c = (await p.list({ cwd: dir })).candidates.find((x) => x.name === 'g-rank')!
    const def = await p.get(c)
    // 🔴 这两处是**写死的常量**（OPENCODE_PROVIDER / OPENCODE_RANK）；一并钉住
    //    防止哪天被改成"从 candidate 透传"而 list 侧却仍写常量 —— 出现两侧漂移。
    expect(c.provider).toBe(OPENCODE_PROVIDER)
    expect(c.rank).toBe(OPENCODE_RANK)
    expect(def?.provider).toBe(OPENCODE_PROVIDER)
  })
})
