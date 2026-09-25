/**
 * cro-log-branches.test.ts — 🔴 **⑤ 第 65 件**：`src/cro-log.ts` 的
 * **条目形状容错面（asEntry 的字段级拒绝与归一）＋ 解析层回退**
 * （2026-09-26 · 对应地图 §2.7 的续段）
 *
 * ## 为什么挑它（复扫读数，纪律 2）
 * `coverage/src/index.html`（01:0x 那一跑，第 64 件之后）实测：`src/**` 分支覆盖率
 * **最低且尚未做过**的文件 = `cro-log.ts`（**84.78% = 39/46**；语句 **100% = 230/230**；
 * 函数 7/7 已满）。
 * 🔴 **成对读（纪律 16）本次拦下一处**：`git-ops.ts` 的 83.33% 确实更低，但**已在第 53 件做过**；
 * 而 84.84% 那处是 `localstore-ops.ts`（line 508）—— **裸百分比单元格不带文件身份，必须成对读**。
 *
 * ## 🔴 开工第一步 = 按【被测符号】核对既有登记（纪律 ⑯）
 * grep `cro-log.js` 的 import 点与**全部导出名**（`appendCroWakeLog` ／ `pruneCroLogEntries`
 * ／ `loadCroWakeLog` ／ `summarizeCroPrompt` ／ `croWakeLogPath`）⇒ 命中
 * `cro-log.test.ts`（243 行，专测本模块）／ `wake-registry.test.ts` ／ `wake-scheduler-branches.test.ts`。
 * 逐条核对后确认 `cro-log.test.ts` 已覆盖：**落点与固定文件名**／**成败都记**／
 * **两日轮转（含边界与 30 天长跑有界性）**／**绝不抛（坏档 / 不可写路径）**／
 * **原子写不留 .tmp**／**分工边界（不夹带判定细节）**／**摘要按码点截断** ⇒ 本件**不重做**其中任何一条。
 *
 * ## 🔵 缺口形态：既有「坏条目」用例只打到**第一道守卫**
 * 既有那条用的是 `{ at: 123, ok: 'yes' }` 与 `null` —— 它们**在 `:635` 的 `at` 检查就被拦掉**
 * ⇒ `asEntry` 后三道的字段级拒绝与归一（`:636`／`:637`／`:643`／`:644`）**从未被执行**。
 * 🔴 **而它们恰恰是"容忍手改"这条承诺的唯一执行点**：本文件头逐字写着
 * 「**容忍手改：字段缺失/类型不符 → 丢弃该条，不阻断整档**」——
 * 手改档**完全可能**写出「`at` 合法但 `ok` 是字符串」这种形态（既有用例造不出来）。
 *
 * ## 🔴 本件为何要紧（objective 直指"长期存活"）
 * 这七处全是**降级臂**，而本模块的铁律是「**CRO 流水的问题绝不影响投递与既有链路**」
 * （设计 §5）：把它们写坏（`return null` 改成 throw、或让 `?? 0` 归一失效）
 * **既有全部测试仍绿**，而现网一旦有人手看过/改过该档，**整条投递链路会跟着倒**。
 *
 * ## 判据纪律（本件用到的高频条）
 * · **⑧ 不声称一个我没挣到的覆盖**：`:676`／`:749` 的 `?.message ?? err` **右侧**
 *   需 catch 抛**非 Error** 才可达 ⇒ 见「诚实边界」，**如实登记不涂绿**。
 * · **⑬ 降级面与正控方向成对测**：每条"丢弃"都配"合法条目必须通过"的对照。
 * · **判据钉盘上事实**：断言的是**读回来的内容**与**条数**，不是返回值自述。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { CRO_LOG_FILENAME, croWakeLogPath, loadCroWakeLog } from '../src/cro-log.js'

const DIR = '2026-09-13--S185--相机沉淀与语音输入'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cro-log-br-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 手工铺一份"手改档"现场（判据 = 本模块必须容忍它） */
function writeRaw(entries: unknown): void {
  const p = croWakeLogPath(root, DIR)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify({ version: 1, entries }), 'utf-8')
}

/** 一条形状**完全合法**的条目（所有"丢弃"判据的正控基准） */
const GOOD = { at: '2026-09-20T08:00:00+08:00', ok: true, detail: 'good', tick: 5, reason: '心跳' }

describe('cro-log 容错面：`asEntry` 的字段级拒绝与归一（**「容忍手改」的唯一执行点**）', () => {
  it('🟢 正控（夹具自证）：形状合法的条目必须**原样通过**（否则下面每条"丢弃"都不可判）', () => {
    writeRaw([GOOD])
    const { log, error } = loadCroWakeLog(root, DIR)
    expect(error).toBeNull()
    expect(log.entries).toHaveLength(1)
    expect(log.entries[0]).toEqual({
      at: GOOD.at,
      ok: true,
      detail: 'good',
      tick: 5,
      reason: '心跳',
      promptDigest: { length: 0, head: '' },
    })
  })

  it('🔴 `:636` **`at` 合法但 `ok` 不是 boolean** ⇒ 丢弃该条（不阻断整档）', () => {
    // 🔴 关键：这条 `at` 是**合法字符串** ⇒ 它会**穿过** `:635` 的 `at` 守卫，
    //    从而第一次真正执行 `:636` 的 `return null`（既有用例的坏条目全部在 `:635` 就被拦掉）
    writeRaw([GOOD, { ...GOOD, detail: 'ok-is-string', ok: 'yes' }])
    const { log, error } = loadCroWakeLog(root, DIR)
    expect(error, '形状不符 ⇒ 静默丢条，不是整档报错').toBeNull()
    expect(log.entries.map((e) => e.detail), '只有 `ok` 类型不符的那条被丢').toEqual(['good'])
  })

  it('🔴 `:637` **`at` 与 `ok` 都合法但 `detail` 不是 string** ⇒ 丢弃该条', () => {
    writeRaw([GOOD, { ...GOOD, detail: 12345 }])
    const { log } = loadCroWakeLog(root, DIR)
    expect(log.entries.map((e) => e.detail)).toEqual(['good'])
  })

  it('🔴 `:643`/`:644` **可选字段归一**：`tick` 非数 ⇒ 0；`reason` 非串 ⇒ null（**不得写 undefined**）', () => {
    // 判据（纪律 ⑱）：契约是「**无值时不得出现该键的坏形态**」—— 这里更严：
    // `tick`/`reason` 是**必填键、可空值**，缺省必须归一到 0 / null，**不能是 undefined**
    writeRaw([{ at: GOOD.at, ok: true, detail: 'missing-optionals' }])
    const { log } = loadCroWakeLog(root, DIR)
    const e = log.entries[0]!
    expect(e.tick, '缺 `tick` ⇒ 归一为 0').toBe(0)
    expect(e.reason, '缺 `reason` ⇒ 归一为 null（**不是 undefined**）').toBeNull()
    // 🔴 键必须**在场**（`'key' in obj` 而非 `toBeUndefined()` —— 纪律 ⑱ 的原始形态）
    expect('tick' in e).toBe(true)
    expect('reason' in e).toBe(true)
  })

  it('🔴 `:643`/`:644` 的**另一侧**：给了合法值就必须**原样保留**（归一不得吃掉真值）', () => {
    // 与上一条构成成对方向（纪律 ⑬）—— 只测"缺省归 0/null"无法区分
    // "归一正确"与"无论给什么都归 0/null"
    writeRaw([{ ...GOOD, tick: 0, reason: '' }])
    const { log } = loadCroWakeLog(root, DIR)
    expect(log.entries[0]!.tick, 'tick=0 是**合法值**，必须原样保留').toBe(0)
    expect(log.entries[0]!.reason, '空串是**合法字符串** ⇒ 保留空串，不得折成 null').toBe('')
  })

  it('🔴 `:638`/`:646`/`:647` promptDigest 三处归一：缺失 / 字段类型不符 ⇒ 归零摘要', () => {
    writeRaw([
      { at: GOOD.at, ok: true, detail: 'no-digest' },
      { at: GOOD.at, ok: true, detail: 'bad-digest', promptDigest: { length: 'x', head: 9 } },
    ])
    const { log } = loadCroWakeLog(root, DIR)
    expect(log.entries).toHaveLength(2)
    expect(log.entries[0]!.promptDigest).toEqual({ length: 0, head: '' })
    expect(log.entries[1]!.promptDigest, '类型不符 ⇒ 逐字段归零（不是整条丢弃）').toEqual({ length: 0, head: '' })
  })

  it('🔴 混合档：好条目**必须全部留下**，坏条目逐条丢弃（不是"一坏全丢"）', () => {
    // 🔴 这是"容忍手改"承诺的**完整语义**：坏条目丢自己，不牵连别人。
    // 既有用例只有 1 好 + 2 坏 ⇒ 无法区分"逐条丢弃"与"见坏即清空"
    writeRaw([
      { ...GOOD, detail: 'keep-1' },
      { at: 123, ok: true, detail: 'bad-at-type' },
      { ...GOOD, detail: 'keep-2' },
      null,
      { at: '', ok: true, detail: 'bad-at-empty' },
      { ...GOOD, detail: 'keep-3' },
      { at: GOOD.at, ok: true, detail: 0 },
      'not-an-object',
      { ...GOOD, detail: 'keep-4' },
    ])
    const { log, error } = loadCroWakeLog(root, DIR)
    expect(error).toBeNull()
    expect(log.entries.map((e) => e.detail)).toEqual(['keep-1', 'keep-2', 'keep-3', 'keep-4'])
  })
})

describe('cro-log 容错面：解析层回退（`:668`）', () => {
  it('🔴 `:668` **`entries` 不是数组** ⇒ 当空档（且不报错）；对照：是数组则正常读', () => {
    // 三种"不是数组"的形态各测一次：缺键 / 是对象 / 是字符串
    for (const bad of [undefined, { a: 1 }, 'nope']) {
      const body: Record<string, unknown> = { version: 1 }
      if (bad !== undefined) body.entries = bad
      const p = croWakeLogPath(root, DIR)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, JSON.stringify(body), 'utf-8')

      const { log, error } = loadCroWakeLog(root, DIR)
      expect(error, `entries=${JSON.stringify(bad) as string} ⇒ 不是解析失败，是"空档"`).toBeNull()
      expect(log.entries).toEqual([])
    }

    // 正控方向（纪律 ⑬）：给了合法数组就必须真的读出来
    writeRaw([GOOD])
    expect(loadCroWakeLog(root, DIR).log.entries).toHaveLength(1)
  })

  it('🔴 顶层是**非 null 的非对象**（裸数组 / 数字 / 字符串）⇒ 走 `:668` 回退到空档，不报错', () => {
    // 🔴 分诊（首跑红逼出，生产代码无错）：我原以为「`JSON.parse` 成功 ⇒ 都走 `:668`」—— **只对了一半**：
    //   `JSON.parse('null')` 的成功结果是 **`null`** ⇒ 随后 `parsed.entries` 触发
    //   `TypeError: Cannot read properties of null` ⇒ 落进 **catch**（不是 `:668`）。
    //   ⇒ 本用例只覆盖**真能走到 `:668`** 的那半：解析结果是**非 null 的非对象**（访问 `.entries` 不抛）。
    //   `null` 那一半归下一条「catch」用例（**两条判据语义不同，不得混**）。
    for (const body of ['[1,2,3]', '42', '"str"']) {
      const p = croWakeLogPath(root, DIR)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, body, 'utf-8')
      const { log, error } = loadCroWakeLog(root, DIR)
      expect(error, `顶层 ${body} ⇒ 不是解析失败，是"空档"`).toBeNull()
      expect(log.entries).toEqual([])
    }
  })

  it('🔴 顶层字面量 `null` ⇒ 落 catch（`:676`）：**不抛** ＋ 给出可读原因', () => {
    // 与上一条是**两条语义不同的判据**（纪律 ⑬ 的成对读）：
    //   · 非 null 非对象 ⇒ `:668` 回退 ⇒ `error` 为 **null**（不是错误）
    //   · `null`         ⇒ 解引用抛 ⇒ catch ⇒ `error` **非 null**（是错误）
    // 只测其中一条，就无法区分"回退生效"与"回退写成了 catch"。
    const p = croWakeLogPath(root, DIR)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, 'null', 'utf-8')
    const { log, error } = loadCroWakeLog(root, DIR)
    expect(error, '必须报出可读原因').toContain('CRO 流水解析失败')
    expect(log.entries).toEqual([])
  })

  it('🔴 读不动的路径（目录形态）⇒ 走 catch，**不抛**且带可读原因', () => {
    // 真故障形态：把该档的**路径**造成一个目录 ⇒ `readFileSync` 真抛 EISDIR
    // （这是 `:666` 的 try 真正被触发的形态；既有用例用的是"非法 JSON"，
    //  那条走的是 `JSON.parse` 抛 ⇒ 同一个 catch，但**触发点不同**）
    const p = croWakeLogPath(root, DIR)
    mkdirSync(p, { recursive: true })
    const { log, error } = loadCroWakeLog(root, DIR)
    expect(error, '必须给出可读原因').toContain('CRO 流水解析失败')
    expect(log.entries).toEqual([])
    expect(existsSync(p)).toBe(true) // 只读不写：档还在
  })
})

describe('cro-log 容错面：**只读**语义（`loadCroWakeLog` 绝不建文件）', () => {
  it('🔴 读一份**不存在**的档 ⇒ 空档且**不建文件**（正控：连父目录都不建）', () => {
    const p = croWakeLogPath(root, DIR)
    expect(existsSync(p)).toBe(false)
    expect(loadCroWakeLog(root, DIR)).toEqual({ log: { version: 1, entries: [] }, error: null })
    expect(existsSync(p), '读操作绝不得成为"建档"的副作用').toBe(false)
    expect(existsSync(join(root, 'AGENT_SESSIONS')), '连父目录都不该被读操作建出来').toBe(false)
  })

  it('🔴 反复读同一份坏档 ⇒ 结果稳定（不因读次数改变盘上内容）', () => {
    const p = croWakeLogPath(root, DIR)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, '{ 坏 JSON', 'utf-8')
    const before = readFileSync(p, 'utf-8')
    const a = loadCroWakeLog(root, DIR)
    const b = loadCroWakeLog(root, DIR)
    expect(a).toEqual(b)
    expect(readFileSync(p, 'utf-8'), '读绝不改盘上内容').toBe(before)
  })
})

describe('cro-log 常量契约（下游依赖面）', () => {
  it('🔴 固定文件名 = `cro-wake-log.json`（与程序自建 `cro-state.json` 并排、主语分明）', () => {
    expect(CRO_LOG_FILENAME).toBe('cro-wake-log.json')
    // 🔴 判据不是"名字好看"，而是**不得与程序那侧撞名**（撞名 ⇒ 两个主语写同一份 ⇒ 互相覆盖）
    expect(CRO_LOG_FILENAME).not.toBe('cro-state.json')
    expect(croWakeLogPath('/ccc', DIR)).toBe(join('/ccc', 'AGENT_SESSIONS', DIR, CRO_LOG_FILENAME))
  })
})
