/**
 * container-status-degradation.test.ts — 🔴 **⑤ 第 61 件**：`src/container-status.ts` 的
 * **注册表结构判据（判据 A）的退化面**
 * （2026-09-26 · 对应地图 §2.7 的续段）
 *
 * ## 为什么挑它（复扫读数，纪律 2）
 * `coverage/src/index.html`（00:29 那一跑，第 60 件之后）实测：`src/**` 分支覆盖率
 * **最低且尚未做过**的文件 = `container-status.ts`（**83.05% = 49/59**；
 * 语句 98.48% ＝ 324/329；函数 6/6 已满）。
 *
 * ## 🔴 开工第一步 = 核对既有登记（第 59/60 件沉淀的纪律）
 * `container-status.test.ts`（326 行）的文件头**已逐条自述其覆盖面**：① 组装 ② **两条注册表判据
 * 相互独立** ③ 宿主契约每次现探 ④ 时钟读快照 ＋ 时间轴取数。⇒ 本件**不重做**其中任何一条。
 * 🔵 **两者的分工是干净互补的**：既有文件测的是**两条判据的「结论可分性」**（同一份表上 A 说 ok、
 * B 报 M1+M2），它的夹具**恒是「合法 JSON ＋ 形状正确的 entries」** ⇒
 * **判据 A 自己的全部退化路径从未被执行过**。
 *
 * ## 🔴 本件为何要紧（源码文件头逐字给出的事故形态）
 * `container-status.ts:135-136` 写着：**「health 必须不因坏表抛错（注册表坏 → `loadMsmEntries` 抛
 * → `container_admin`/`output-guard` 全崩且**自锁无法自救**），故本判据独立解析，不走
 * `loadMsmEntries`」**。
 * ⇒ 本件覆盖的**恰恰是那条设计红线的唯一执行点**。它要是写坏了（catch 改成 throw、
 * `issues.push` 变 `throw`、或非对象条目让 `e.name` 解引用崩），**既有全部测试仍全绿**，
 * 而现网一旦注册表被手改坏，容器会**自锁**。
 *
 * ## 覆盖对象（报告 `cbranch-no` 逐条映射回源行；判据 = `cline-any` 块与其后 `text` 块按序对应）
 * 全部落在 `checkRegistryHealth`（源 `:138-210`）内：
 *   · `:156` 文件**读不动**的 catch（真实形态：路径是目录 / 权限）
 *   · `:167` 坏 JSON 时 `err.message ?? err`（抛非 Error 才走右侧）
 *   · `:172` 顶层**不是数组** ⇒ 走 `data.entries` 分支
 *   · `:185` 条目**不是对象**（`null` / 字符串 / 数）
 *   · `:189-192` 四个字段类型校验（name / path / skill / category）
 *   · `:202` path **逃逸根**
 *   · `:204` path 存在但**脚本不在盘上**
 *   · `:203`/`:205` 的 `String(e.name ?? '?')` —— name 缺失时的占位（与 :190 同一形态）
 *
 * ## 判据纪律（本件用到的高频条）
 * · **⑬ 降级面必须与正控方向成对测**：每条退化都钉住「**它不抛、且给出可读 issue**」，
 *   并配一条**同夹具的好表**证明读数器不瞎（否则无法区分"守卫生效"与"夹具坏了"）。
 * · **🔴 文件头的核心契约要显式钉住**：`checkRegistryHealth` 对**任何**坏表输入
 *   **绝不抛**（本件用 `expect(() => …).not.toThrow()` 之外，更钉**返回值**——
 *   只断言"不抛"是弱测试（纪律 12）：无法区分"吞掉后给了可用报告"与"吞掉后返回了垃圾"）。
 * · 坏表**不得**被误判成"健康"：`ok:false` ＋ `present:true` 必须同时成立。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { checkRegistryHealth } from '../src/container-status.js'

let dir: string

/** 与既有文件同款：CCC 名取自 `.serenity` 首行 */
function write(rel: string, content: string): void {
  const abs = join(dir, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content)
}

const AGG_REL = '.opencode/skills/t/references/mech-registry.json'
const SCRIPTS_REL = '.opencode/skills/t/scripts'

/** 直接写**原始文本**（坏表场景不能用 JSON.stringify —— 它造不出坏 JSON／BOM） */
function writeRawRegistry(raw: string): void {
  write(AGG_REL, raw)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsp-cstatus-deg-'))
  writeFileSync(join(dir, '.serenity'), 't\n')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('container-status 退化面：判据 A 的**读不动 / 解析不了 / 形状不对**', () => {
  it('🔴 好表正控（夹具先证不瞎）：合法 JSON ⇒ present:true / ok:true / issues 空', () => {
    write(`${SCRIPTS_REL}/solo.ts`, 'function main() {}\nmain()\n')
    writeRawRegistry(JSON.stringify({
      version: 1,
      entries: [{ name: 'solo', path: `${SCRIPTS_REL}/solo.ts`, skill: 't', category: 'mech' }],
    }))

    const r = checkRegistryHealth(dir)
    expect(r.present, '表在盘上 ⇒ present 必须为 true').toBe(true)
    expect(r.ok, '合法且引用完整 ⇒ ok').toBe(true)
    expect(r.issues).toEqual([])
    expect(r.path).toBe(AGG_REL)
  })

  it('🔴 `:156` 文件**读不动**（路径是目录）⇒ 不抛、给出 `registry unreadable` ＋ ok:false', () => {
    // 真实故障形态：有人把注册表路径误建成**同名目录**（`readFileSync` 对目录抛 EISDIR）。
    // 🔴 为何不用 chmod：**root 身份下权限拦不住**（第 57 件的实测教训）⇒ 目录形态是本环境可构造的真故障。
    mkdirSync(join(dir, AGG_REL), { recursive: true })

    const r = checkRegistryHealth(dir)
    expect(r.present, '路径存在（是目录）⇒ present').toBe(true)
    expect(r.ok, '读不动 ⇒ 绝不判健康').toBe(false)
    expect(r.issues).toHaveLength(1)
    expect(r.issues[0]).toContain('registry unreadable')
  })

  it('🔴 `:163` 坏 JSON ⇒ 两条 issue（原因 ＋ **可执行的修复指令**），且**不是抛出**', () => {
    writeRawRegistry('{ this is not json')

    const r = checkRegistryHealth(dir)
    expect(r.present).toBe(true)
    expect(r.ok).toBe(false)
    expect(r.issues).toHaveLength(2)
    expect(r.issues[0]).toContain('registry JSON is broken')
    // 🔴 第二条是**修复动作**（不是复述故障）—— 它含可直接粘贴的 git 命令
    expect(r.issues[1]).toContain('restore from git')
    expect(r.issues[1]).toContain(AGG_REL)
  })

  it('🔴 `:162` BOM（Windows 编辑器 \uFEFF）⇒ **照样解析成功**（回归钉：剥 BOM 那一句必须留着）', () => {
    write(`${SCRIPTS_REL}/solo.ts`, 'function main() {}\nmain()\n')
    // 带 BOM 的合法 JSON —— 若 `:162` 的 `.replace(/^\uFEFF/, '')` 被删，
    // JSON.parse 会抛 ⇒ 这里会变成 "JSON is broken"（本用例随即变红）
    writeRawRegistry('\uFEFF' + JSON.stringify({
      version: 1,
      entries: [{ name: 'solo', path: `${SCRIPTS_REL}/solo.ts`, skill: 't', category: 'mech' }],
    }))

    const r = checkRegistryHealth(dir)
    expect(r.ok, 'BOM 必须被剥掉后正常解析（否则 Windows 用户存一次盘注册表就"坏"了）').toBe(true)
    expect(r.issues).toEqual([])
  })

  it('🔴 `:172`+`:173` 顶层形状不对（对象无 entries ／ 裸字符串 ／ null）⇒ 各自的 issue', () => {
    for (const [label, raw] of [
      ['无 entries 键的对象', JSON.stringify({ version: 1 })],
      ['裸字符串', JSON.stringify('nope')],
      ['null', 'null'],
    ] as Array<[string, string]>) {
      writeRawRegistry(raw)
      const r = checkRegistryHealth(dir)
      expect(r.present, label).toBe(true)
      expect(r.ok, label).toBe(false)
      expect(r.issues[0], label).toContain('neither an array nor a v1 wrapper')
      expect(r.issues[1], label).toContain('Fix: restore from git')
    }

    // 🔴 **对照（正控方向）**：**裸数组**顶层是**被接受的**（`Array.isArray(data) ? data : …` 左侧）
    //    —— 少了这条就无法区分"形状校验生效"与"它根本不接受数组"
    write(`${SCRIPTS_REL}/solo.ts`, 'function main() {}\nmain()\n')
    writeRawRegistry(JSON.stringify([
      { name: 'solo', path: `${SCRIPTS_REL}/solo.ts`, skill: 't', category: 'mech' },
    ]))
    const asArray = checkRegistryHealth(dir)
    expect(asArray.ok, '裸数组也是合法档（v0 形态，必须继续支持）').toBe(true)
    expect(asArray.issues).toEqual([])
  })
})

describe('container-status 退化面：判据 A 的**逐条 entry 校验**', () => {
  /** 把 entries 写进标准 v1 包装（本组只关心 entry 形状，不关心顶层形状） */
  function withEntries(entries: unknown[]): void {
    writeRawRegistry(JSON.stringify({ version: 1, entries }))
  }

  it('🔴 `:185` 条目**不是对象**（null ／ 字符串 ／ 数）⇒ 报 `is not an object` 并 **continue**（不崩）', () => {
    for (const [label, bad] of [['null', null], ['字符串', 'nope'], ['数', 42]] as Array<[string, unknown]>) {
      withEntries([bad])
      const r = checkRegistryHealth(dir)
      expect(r.ok, `${label}：非对象条目必须报错`).toBe(false)
      expect(r.issues, label).toEqual(['entry[0] is not an object'])
    }

    // 🔴 **关键回归钉（continue 的意义）**：非对象条目**后面**的条目仍须被校验到
    //    —— 若把 `continue` 写成 `break`/`return`，后面的条目会被**静默跳过**。
    // ⚠️ **首版这条钉不准（变异实测全绿）**：我当时让 entry[1] 是**合法**条目
    //    ⇒ `break` 跳过它也**不产生任何差异**（合法条目本就不贡献 issue）⇒ 无法区分。
    //    ⇒ 修法：让 entry[1] **本身有错**。此时 continue ⇒ 2 条 issue；break ⇒ 1 条。这才可判。
    withEntries([null, { name: 'solo', path: '' }])
    const r2 = checkRegistryHealth(dir)
    expect(r2.issues, '非对象条目之后的条目必须仍被校验（continue 而非 break）').toEqual([
      'entry[0] is not an object',
      'entry[1] (solo): path missing or not a string',
    ])
    // 方向对照：**只有**非对象那一条时 ⇒ 恰好 1 条（证明上面第 2 条来自 entry[1]，不是噪声）
    withEntries([null])
    expect(checkRegistryHealth(dir).issues).toEqual(['entry[0] is not an object'])
  })

  it('🔴 `:189`/`:190` name 与 path 的类型/空值校验（**四种形态**，含 `String(e.name ?? "?")` 占位）', () => {
    withEntries([
      { path: `${SCRIPTS_REL}/a.ts` },                       // name 完全缺失
      { name: 123, path: `${SCRIPTS_REL}/b.ts` },            // name 非字符串
      { name: '', path: `${SCRIPTS_REL}/c.ts` },             // name 空串
      { name: 'hasname' },                                    // path 完全缺失
    ])
    const r = checkRegistryHealth(dir)
    expect(r.ok).toBe(false)
    // 🔴 **判据按"哪一条 issue 在不在"钉，不按总数**（纪律：总数脆弱且此处会误导）——
    //    :189/:190 的字段校验与 :198 的"脚本存在性"是**各自独立的 if**（不是 else-if），
    //    故上面前三条的 path 虽合法、但其指向的脚本**并未落盘** ⇒ 每条纹理会**额外**产出一条
    //    `script not found`。写 `toHaveLength(4)` 会把"独立 if 语义"错当成"一个小计"。
    const byEntry = (i: number): string[] => r.issues.filter((s) => s.startsWith(`entry[${i}]`))
    for (const i of [0, 1, 2]) {
      expect(byEntry(i).some((s) => s.includes('name missing or not a string')), `entry[${i}] 应有 name 报错`).toBe(true)
    }
    // 🔴 `:190` 的占位形态：name 合法但 path 缺失 ⇒ 文案里带**真名字**
    expect(byEntry(3).some((s) => s.includes('entry[3] (hasname): path missing or not a string'))).toBe(true)
    // 交叉验证：entry[3] 只应报 path 一条（它没有 path ⇒ 不进 :198 那段 ⇒ 不报 script not found）
    expect(byEntry(3).some((s) => s.includes('script not found')), '没给 path 者不得报脚本缺失').toBe(false)
  })

  it('🔴 `:190` 的 `String(e.name ?? "?")` **占位分支**：name **不是字符串**时文案印 `?`（不是 undefined）', () => {
    // 关键：name 缺失 ⇒ `e.name` 为 undefined ⇒ 走 `?? '?'` 右侧。
    // 🔴 若把 `?? '?'` 删掉，文案会变成「(undefined)」—— 面板上就是那句丑陋的 undefined。
    withEntries([{ name: undefined, path: 42 }])
    const r = checkRegistryHealth(dir)
    expect(r.issues.some((i) => i.includes('(?)')), '占位必须是 ?，不得是 undefined').toBe(true)
    expect(r.issues.some((i) => i.includes('undefined')), '文案里不得出现 undefined').toBe(false)
  })

  it('🔴 `:191`/`:192` skill 与 category 类型校验：**缺省合法**、**给了但类型错才报**（两方向成对）', () => {
    // 方向一：**完全不给** skill/category ⇒ 合法（两者都是可选键）
    write(`${SCRIPTS_REL}/solo.ts`, 'function main() {}\nmain()\n')
    withEntries([{ name: 'solo', path: `${SCRIPTS_REL}/solo.ts` }])
    expect(checkRegistryHealth(dir).ok, '可选键缺省必须合法').toBe(true)

    // 方向二：给了但类型错 ⇒ 各报一条（判据是 `!== undefined && typeof !== 'string'`）
    //    ⚠️ 同样**按"哪条在不在"钉**：a.ts/b.ts 未落盘 ⇒ 各自**额外**有一条 script not found
    //    （:191/:192 与 :198 是独立 if）。此处**补齐脚本**以让本用例只测类型校验、隔离掉存在性噪声。
    write(`${SCRIPTS_REL}/a.ts`, 'function main() {}\nmain()\n')
    write(`${SCRIPTS_REL}/b.ts`, 'function main() {}\nmain()\n')
    withEntries([
      { name: 'a', path: `${SCRIPTS_REL}/a.ts`, skill: 42 },
      { name: 'b', path: `${SCRIPTS_REL}/b.ts`, category: {} },
    ])
    const r = checkRegistryHealth(dir)
    expect(r.ok).toBe(false)
    expect(r.issues).toHaveLength(2)
    expect(r.issues[0]).toContain('entry[0] (a): skill not a string')
    expect(r.issues[1]).toContain('entry[1] (b): category not a string')
  })

  it('🔴 `:194` 同名重复 ⇒ 报 `duplicate MSM name`（既有文件已钉结论，本件补**:193 的判据边界**）', () => {
    const src = 'function main() {}\nmain()\n'
    write(`${SCRIPTS_REL}/a.ts`, src)
    write(`${SCRIPTS_REL}/b.ts`, src)
    withEntries([
      { name: 'dup', path: `${SCRIPTS_REL}/a.ts`, skill: 't', category: 'mech' },
      { name: 'dup', path: `${SCRIPTS_REL}/b.ts`, skill: 't', category: 'mech' },
    ])
    const r = checkRegistryHealth(dir)
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.includes('duplicate MSM name: "dup"'))).toBe(true)

    // `:193` 的**守卫**：name 非法（缺省/空串）时**不得**进 names 集合去比重复
    // （否则两条都缺 name 的条目会被误报成 "duplicate" —— 它们连名字都没有）
    withEntries([{ path: `${SCRIPTS_REL}/a.ts` }, { path: `${SCRIPTS_REL}/b.ts` }])
    const r2 = checkRegistryHealth(dir)
    expect(r2.issues.some((i) => i.includes('duplicate')), 'name 非法者不得参与重复判定').toBe(false)
  })

  it('🔴 `:202` path **逃逸根** ⇒ `escapes CCC root`（且**不**再报"脚本不存在"——两判据有序）', () => {
    withEntries([{ name: 'evil', path: '../../outside.ts', skill: 't', category: 'mech' }])
    const r = checkRegistryHealth(dir)
    expect(r.ok).toBe(false)
    expect(r.issues).toHaveLength(1)
    expect(r.issues[0]).toContain('escapes CCC root')
    // 🔴 有序性：逃逸分支与缺失分支是 `if / else if` ⇒ **互不重复报**
    //    （若把 else-if 写成两个独立 if，这里会变 2 条 —— 本断言正是在钉那条 else）
    expect(r.issues.some((i) => i.includes('script not found'))).toBe(false)
  })

  it('🔴 `:204` path 在根内但**脚本不在盘上** ⇒ `script not found`（与逃逸形成对照）', () => {
    withEntries([{ name: 'ghost', path: `${SCRIPTS_REL}/ghost.ts`, skill: 't', category: 'mech' }])
    const r = checkRegistryHealth(dir)
    expect(r.ok).toBe(false)
    expect(r.issues).toHaveLength(1)
    expect(r.issues[0]).toContain('script not found at')
    expect(r.issues[0]).not.toContain('escapes')

    // 正控方向：把脚本补上 ⇒ **同一条目**转绿（证明上一读数是"文件真的不在"，不是判据坏了）
    write(`${SCRIPTS_REL}/ghost.ts`, 'function main() {}\nmain()\n')
    expect(checkRegistryHealth(dir).ok, '补上脚本后必须转 ok').toBe(true)
  })

  it('🔴 `:198` 的守卫：path 非法（缺省/空串）⇒ **不进** 根内/存在性那段（不误报 script not found）', () => {
    withEntries([{ name: 'nopath', skill: 't', category: 'mech' }])
    const r = checkRegistryHealth(dir)
    expect(r.issues.some((i) => i.includes('path missing'))).toBe(true)
    expect(r.issues.some((i) => i.includes('script not found')), 'path 都没给，不得再抱怨脚本找不到').toBe(false)
  })

  it('🔴 文件头的核心契约：**判据 A 对任何坏表都不抛**（逐形态穷举 ＋ 钉返回值）', () => {
    // 文件头逐字：「health 必须不因坏表抛错（… container_admin/output-guard 全崩且自锁无法自救）」
    // ⇒ 本用例把"不抛"与"给出可用报告"一起钉住（只钉"不抛"是弱测试 —— 纪律 12）
    const badInputs: Array<[string, string]> = [
      ['坏 JSON', '{oops'],
      ['空文件', ''],
      ['裸 null', 'null'],
      ['裸数', '1'],
      ['无 entries 的对象', '{}'],
      ['entries 非数组', JSON.stringify({ entries: 'nope' })],
      ['条目含非对象', JSON.stringify({ entries: [null, 1, 's'] })],
      ['条目全空', JSON.stringify({ entries: [{}, {}] })],
      ['深嵌套垃圾', JSON.stringify({ entries: [{ name: { a: 1 }, path: [], skill: null, category: 3 }] })],
    ]
    for (const [label, raw] of badInputs) {
      writeRawRegistry(raw)
      let r: ReturnType<typeof checkRegistryHealth> | undefined
      expect(() => { r = checkRegistryHealth(dir) }, `${label} 必须不抛`).not.toThrow()
      // 🔴 且必须给出**结构化**报告（不是 undefined/垃圾）—— 这才是"可用"的证据
      expect(r, label).toBeDefined()
      expect(typeof r!.ok, label).toBe('boolean')
      expect(typeof r!.present, label).toBe('boolean')
      expect(Array.isArray(r!.issues), label).toBe(true)
      // 坏表**不得**被误判成健康
      expect(r!.ok, `${label}：坏表不得判 ok`).toBe(false)
      expect(r!.present, `${label}：文件在盘上`).toBe(true)
    }
  })
})
