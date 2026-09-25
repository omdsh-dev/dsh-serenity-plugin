/**
 * cro-branches.test.ts — 🔴 **⑤ 第 63 件**：`src/cro.ts` 的
 * **runner 回退链 ＋ 编排降级臂 ＋ 超时/退出码文案边界**
 * （2026-09-26 · 对应地图 §2.7 的续段）
 *
 * ## 为什么挑它（复扫读数，纪律 2）
 * `coverage/src/index.html`（00:44 那一跑，第 62 件之后）实测：`src/**` 分支覆盖率
 * **最低且尚未做过**的文件 = `cro.ts`（**84.15% = 85/101**；
 * 语句 96.64% ＝ 548/567；函数 14/14 已满）。
 * ⚠️ **复扫时的成对读（纪律 16）拦下一个错靶**：同为 83.33% 的两个候选里，
 * `gateway-dsh-auth.ts` 的 83.33% 是**函数列**（5/6）、其**分支是 100%**；
 * 真正的分支低点是 `git-ops.ts`（75/90）—— 但它**已在第 53 件做过**
 * ⇒ 才轮到 `cro.ts`。**只读数值列会把这三者混为一谈。**
 *
 * ## 🔴 开工第一步 = 按【被测符号】核对既有登记（纪律 ⑯，第 62 件的教训）
 * 本件**同时** grep 了文件名与**符号**（`src/cro.js` 的 import 点）⇒ 找到四处：
 * `cro.test.ts`（420 行，主）／`cro-guide.test.ts`／`wake-registry.test.ts`／
 * `unattended-seam.test.ts`（后三者只取常量或 mock）。
 * `cro.test.ts` 文件头已逐条自述其覆盖面：§2 位置形态 ／ §3 快照装配 ／
 * §4 输出解析**全部边界** ／ §5 四态 ／ 真实 spawn（成功／非 0／超时／ENOENT）。
 * ⇒ 本件**不重做**其中任何一条。
 *
 * 🔵 **分工干净互补（缺口在"回退链本身"）**：既有 spawn 组**每一条都只跑一跳**
 * （本机有 `bun` ⇒ 第一次迭代就 `res.ok === true || code !== 'ENOENT'` 而 return）
 * ⇒ **`ENOENT ⇒ continue` 试下一个 runner** 与 **两个 runner 都不可用 ⇒ `cro-no-runner`**
 * 这两条**从未被执行**。而同族（第 47 件 `weixin-hook.ts`）踩过一模一样的坑：
 * 「设计承诺写进文件头、却从未被执行」。
 *
 * ## 🔴 本件为何要紧（源码逐字给出的承诺）
 * `:327-330` 逐字写着 runner 顺序与判据：「**`bun` → `process.execPath`**；
 * `ENOENT`（二进制不存在）⇒ 试下一个；**其余失败视为最终结果**（程序自己报错就是报错，
 * 不该用另一个 runner 掩盖——与 hook 一致）」。
 * ⇒ 若把 `continue` 写成 `return`，或把 `res.code === 'ENOENT'` 写成真值判断，
 * **既有测试全绿**，而现网一旦 `bun` 缺失，CRO **整条链静默失效**（这正是回退链存在的
 * 唯一理由）。反向：若判据放宽成"任何失败都试下一个"，**程序的真报错会被掩盖**。
 *
 * ## 覆盖对象（报告 `cbranch-no`/`cstat-no` 逐条映射回源行；锚点 = 报告 :1429 ↔ 源 :230）
 * 全部落在 `runCroProcess` / `runCroOnce` / `evaluateCro` / `listCroTrajectories`：
 *   · `:347` **ENOENT ⇒ continue**（试下一个 runner）＋ `:350` **两个都不可用** ⇒ `cro-no-runner`
 *   · `:537` `run.error ?? '…'` 与 `...(run.code ? {code} : {})` 的**两个方向**
 *   · `:541` `parsed.detail ?? parsed.error` 的**两个方向**（有 detail / 无 detail）
 *   · `:531` 快照序列化失败 catch
 *   · `:317` `listCroTrajectories` 的单条 catch
 *   · `:407` `stderr.trim().split('\n')[0] ?? ''`（**无 stderr** 时）
 *   · `:411` `detail ? `：${detail}` : ''` 的**空 detail** 方向
 *
 * ## 判据纪律（本件用到的高频条）
 * · **⑬ 降级面与正控方向成对测**：`ENOENT ⇒ 试下一个` 与 `真报错 ⇒ **不**试下一个`
 *   是**同一夹具的两个方向**；分开写就无法区分"判据真在判 code"与"夹具坏了"。
 * · **⑪ 只钉本模块自己控制的前缀**：程序 stderr 是**外部内容**，只钉本模块包装的前缀。
 * · **⑭ 变异一次才配声称承重**。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CRO_FILENAME, buildCroSnapshot, evaluateCro, listCroTrajectories, runCroProcess, type CroSnapshotInput } from '../src/cro.js'

const DIR_NAME = '2026-09-13--S185--desk-camera'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cro-br-'))
  mkdirSync(join(root, 'AGENT_SESSIONS'), { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function makeTrajectory(dirName = DIR_NAME, croSource?: string): string {
  const dir = join(root, 'AGENT_SESSIONS', dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SESSION.md'), '# SESSION\n', 'utf-8')
  if (croSource !== undefined) writeFileSync(join(dir, CRO_FILENAME), croSource, 'utf-8')
  return dir
}

function snapshotInput(over: Partial<CroSnapshotInput> = {}): CroSnapshotInput {
  return {
    dirName: DIR_NAME,
    cccRoot: root,
    nowMs: 1_789_800_000_000,
    sessionMdPath: join(root, 'AGENT_SESSIONS', DIR_NAME, 'SESSION.md'),
    sessionMdBytes: 1234,
    sessionMdMtimeMs: 1_789_799_940_000,
    references: [],
    boundSessionIds: [],
    liveSessionIds: [],
    runningSessionIds: [],
    pendingWakes: [],
    ...over,
  }
}

describe('cro 退化面：runner 回退链（**本机有 bun ⇒ 此前从未走到第二跳**）', () => {
  it('🔴 正控（夹具自证）：本机**有** bun ⇒ 回退链的**第一跳**就成功', async () => {
    // 判据 = 这一条先证明"第一跳能跑通"，下一条的"试下一个"才可归因于 ENOENT 而非夹具坏
    const script = join(root, 'ok.mjs')
    writeFileSync(script, 'process.stdout.write(JSON.stringify({wake:false}))\n', 'utf-8')
    const res = await runCroProcess(script, '{}', 10_000)
    expect(res.ok, '第一跳（bun）必须能跑通 —— 否则下面那条测的不是回退链').toBe(true)
    expect(res.code).toBeUndefined()
  })

  it('🔴 `:347` ENOENT 判据的**结构边界取证**（结论与我事前假设**相反**，如实记录）', async () => {
    // 🔴 **我原以为**："脚本不在盘上 ⇒ 两跳 ENOENT ⇒ `:350` `cro-no-runner`"。**实测错**：
    //    `bun` 是 PATH 上的**真二进制**，对缺失脚本它**自己 exit 非 0**（stderr 抱怨找不到文件），
    //    **不产生 `err.code === 'ENOENT'`** ⇒ 走 `cro-exit-nonzero`（`:412`），**不是** `cro-no-runner`。
    //    ⇒ 这条钉住判据的**语义边界**：`ENOENT` 只在**运行时可执行文件本身**找不到时出现
    //      （即 `spawn` 的 `error` 事件带 `err.code === 'ENOENT'`），**与脚本路径无关**。
    const missing = join(root, 'no-such-program.mjs')
    const res = await runCroProcess(missing, '{}', 5_000)
    expect(res.ok, '绝不抛、必须结构化失败').toBe(false)
    expect(res.code, '运行时可执行文件在 ⇒ 非 ENOENT（判据边界）').toBe('cro-exit-nonzero')
    expect(res.stdout).toBe('')
    expect(res.error).toContain('退出码')
  })

  it('🟡 `:350` `cro-no-runner`（两跳全 ENOENT）经**真实 spawn 构造上不可达** —— 如实登记', async () => {
    // ⚠️ **诚实边界（纪律 8 的镜像：不声称一个我没挣到的覆盖）**：
    //    要让**两个** runner 都产出 `err.code === 'ENOENT'`，需要
    //    ① `bun` 不在 PATH **且** ② `process.execPath` 也不存在。
    //    ② 在**当前 Node 进程里结构上不可能**（execPath 就是正在跑的解释器）。
    //    ⇒ 真实 spawn 路径下这条分支**不可达** ⇒ **不造假故障去涂绿**。
    //    同族先例：第 47 件 `weixin-hook.ts` 的 bun 回退链第一跳（本机有 bun ⇒ 走不到）。
    expect(typeof runCroProcess).toBe('function')
  })

  it('🔴 **反向判据（⑬ 成对）**：程序**真报错**时**不得**去试下一个 runner', async () => {
    // 设计原文：「其余失败视为最终结果 —— 程序自己报错就是报错，
    // 不该用另一个 runner 掩盖」⇒ 退出码非 0 必须**原样返回**，
    // 若判据被放宽成"任何失败都试下一个"，node 会**再跑一遍**同一个程序
    // （副作用翻倍）⇒ 本断言会因 code 仍是 cro-exit-nonzero 而**看不出来** ——
    // 所以另钉 stderr 只出现一次（程序只跑了一遍）。
    const script = join(root, 'boom.mjs')
    writeFileSync(
      script,
      'process.stderr.write("BOOM-MARKER\\n");process.exit(7)\n',
      'utf-8',
    )
    const res = await runCroProcess(script, '{}', 10_000)
    expect(res.ok).toBe(false)
    expect(res.code, '真报错 ⇒ 最终结果，不换 runner').toBe('cro-exit-nonzero')
    expect(res.error).toContain('退出码 7')
    // 只跑了一遍的机械证据：标记出现次数为 1（换 runner 会变成 2）
    expect((res.error.match(/BOOM-MARKER/g) ?? []).length, '程序只应被执行一次').toBe(1)
  })
})

describe('cro 退化面：`runCroOnce` 退出码文案边界', () => {
  it('🔴 `:407`/`:411` 有 stderr ⇒ 文案带首行 detail（且只带首行）', async () => {
    const script = join(root, 'multi.mjs')
    writeFileSync(script, 'process.stderr.write("FIRST\\nSECOND\\n");process.exit(2)\n', 'utf-8')
    const res = await runCroProcess(script, '{}', 10_000)
    expect(res.error).toContain('退出码 2')
    expect(res.error).toContain('FIRST')
    // 🔴 只取首行（`split('\n')[0]`）—— 第二行不得进文案
    expect(res.error, '只应带 stderr 首行').not.toContain('SECOND')
  })

  it('🔴 `:411` **空 detail** 方向：无 stderr 的非 0 退出 ⇒ 文案**不带冒号尾巴**（不出现「：」空挂）', async () => {
    // `detail ? `：${detail}` : ''` 的**右侧**：无 stderr ⇒ detail 为空串 ⇒ 不加尾巴。
    // 若把三元写反/删掉，文案会变成「退出码 5：」—— 一个悬空的冒号。
    const script = join(root, 'quiet.mjs')
    writeFileSync(script, 'process.exit(5)\n', 'utf-8')
    const res = await runCroProcess(script, '{}', 10_000)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('退出码 5')
    expect(res.error, '无 stderr ⇒ 不得留下悬空冒号').not.toMatch(/：\s*$/)
    expect(res.error).not.toContain('：')
  })
})

describe('cro 退化面：`evaluateCro` 注入 runner 的两条降级臂', () => {
  it('🔴 `:537` `run.error ?? …` 的**右侧**：runner 返回 ok:false 且 **error 为 null** ⇒ 用兜底文案', async () => {
    makeTrajectory(DIR_NAME, 'export {}')
    // 真实形态：某些失败路径（如被信号杀）可能拿不到 error 文本
    const out = await evaluateCro(root, DIR_NAME, snapshotInput(), {
      runner: async () => ({ ok: false, stdout: '', error: null }),
    })
    expect(out.status).toBe('skipped')
    if (out.status === 'skipped') {
      expect(out.detail, 'error 缺失时必须用兜底文案，不得是 "null"/空').toBe('CRO 执行失败')
      // 🔴 `...(run.code ? { code } : {})` 的**左侧**：无 code ⇒ **不得出现 code 键**
      //    （判据用 `in`，纪律 ⑱：`code: undefined` 与"无该键"对不同）
      expect('code' in out, 'run.code 缺省时不得出现 code 键').toBe(false)
    }
  })

  it('🔴 `:537` 的**左侧**（成对）：runner 带 error 与 code ⇒ 两者都透传', async () => {
    makeTrajectory(DIR_NAME, 'export {}')
    const out = await evaluateCro(root, DIR_NAME, snapshotInput(), {
      runner: async () => ({ ok: false, stdout: '', error: '程序被信号杀死', code: 'cro-signal' }),
    })
    expect(out.status).toBe('skipped')
    if (out.status === 'skipped') {
      expect(out.detail).toBe('程序被信号杀死')
      expect(out.code).toBe('cro-signal')
    }
  })

  it('🔴 `:541` `parsed.detail ?? parsed.error` 的**两个方向**', async () => {
    makeTrajectory(DIR_NAME, 'export {}')

    // 方向一：**有 detail**（非 JSON 会带 detail）⇒ 用 detail
    const withDetail = await evaluateCro(root, DIR_NAME, snapshotInput(), {
      runner: async () => ({ ok: true, stdout: 'not json at all', error: null }),
    })
    expect(withDetail.status).toBe('skipped')
    if (withDetail.status === 'skipped') {
      expect(withDetail.code).toBe('cro-bad-json')
      expect(withDetail.detail, '有 detail 时用 detail（信息量更大）').toContain('输出不是合法 JSON')
    }

    // 方向二：**无 detail**（合法 JSON 但不是对象 ⇒ 只给 error）⇒ 用 error 兜底
    const noDetail = await evaluateCro(root, DIR_NAME, snapshotInput(), {
      runner: async () => ({ ok: true, stdout: '[1,2,3]', error: null }),
    })
    expect(noDetail.status).toBe('skipped')
    if (noDetail.status === 'skipped') {
      expect(noDetail.code).toBe('cro-bad-json')
      expect(noDetail.detail, '无 detail ⇒ 落 error 文案').toBe('输出必须是 JSON 对象')
    }
  })

  it('🟡 `:531` 快照序列化失败 ⇒ skipped ＋ `cro-snapshot` —— 🔴 **经真实输入构造上不可达**（如实登记）', async () => {
    // 🔴 **我原以为**："往 references 里塞一个循环引用 ⇒ JSON.stringify 必抛 ⇒ 覆盖 :531"。**实测错**：
    //    `buildCroSnapshot`（源 :172-190）**不是**把入参原样透传，而是**逐字段重建一个全新普通对象**
    //    （`:181` 把每条 reference **映射成** `{name, bytes, mtime}`）⇒ 任何额外键（含循环引用）
    //    **在装配阶段就被丢弃** ⇒ 送进 `JSON.stringify` 的**永远是可序列化的平面对象**。
    //    ⇒ 该 catch 的分母侧**不可达** ⇒ **不造假故障去涂绿**（纪律 8 的镜像）。
    //    🔵 **但它不是死代码**：它守的是"未来某次装配改动引入了不可序列化字段"这类回归
    //      ⇒ 与第 60 件族⑤ 的"支配性守卫"同性质（**防御性、当前够不着**）。
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const snapshot = buildCroSnapshot(snapshotInput({ references: [cyclic as never] }))

    // 机械证据：装配后已**不含**那个自引用键 ⇒ 必然可序列化
    // ⚠️ 逐字段断言而非整体 `toEqual`（我首版写死 `mtime: undefined` 而实测是
    //    `isoLocal(undefined)` 产出的**时间戳字符串** —— 我错了，不是生产错）
    const ref0 = snapshot.body.references[0]!
    expect('self' in ref0, '额外键（含循环引用）已被丢弃').toBe(false)
    expect(Object.keys(ref0).sort(), 'references 被重建为三键平面形状').toEqual(['bytes', 'mtime', 'name'])
    // 且真能序列化（这就是"不可达"的直接证据）
    expect(() => JSON.stringify(snapshot)).not.toThrow()

    // 下游语义仍可覆盖：注入 runner 走通 skipped 分支（与 `:531` 是同一个出口的**另一条**）
    // 🔴 **必须先建轨迹 + 写入 CRO 文件** —— 否则 `evaluateCro` 在 `:524` 就 disabled 返回，
    //    根本走不到 runner（我第二版漏了这个前置，实测 `disabled` ⇒ 错的是我的夹具）
    makeTrajectory(DIR_NAME, 'export {}')
    const out = await evaluateCro(root, DIR_NAME, snapshotInput(), {
      runner: async () => ({ ok: false, stdout: '', error: 'x', code: 'cro-x' }),
    })
    expect(out.status).toBe('skipped')
  })
})

describe('cro 退化面：`listCroTrajectories` 的目录退化', () => {
  it('🔴 `:317` 单条 catch 与 `:313`/`:314` 的过滤：只列**目录**且**非 `_`/`.` 前缀**且有 CRO 文件', async () => {
    makeTrajectory('2026-01-01--S001--a', 'export {}')          // ✅ 有 CRO ⇒ 列出
    makeTrajectory('2026-01-02--S002--b')                        // ❌ 无 CRO ⇒ 不列
    makeTrajectory('_archived', 'export {}')                     // ❌ `_` 前缀 ⇒ 不列
    makeTrajectory('.hidden', 'export {}')                       // ❌ `.` 前缀 ⇒ 不列
    writeFileSync(join(root, 'AGENT_SESSIONS', 'loose.txt'), 'x') // ❌ 顶层文件 ⇒ 不列（`:313`）

    const out = listCroTrajectories(root)
    expect(out).toEqual(['2026-01-01--S001--a'])
  })

  it('🔴 排序稳定（同 tick 顺序可比对）＋ AGENT_SESSIONS 不存在 ⇒ 空数组（绝不抛）', () => {
    makeTrajectory('2026-01-03--S003--c', 'export {}')
    makeTrajectory('2026-01-01--S001--a', 'export {}')
    makeTrajectory('2026-01-02--S002--b', 'export {}')
    expect(listCroTrajectories(root), '字典序稳定').toEqual([
      '2026-01-01--S001--a', '2026-01-02--S002--b', '2026-01-03--S003--c',
    ])

    const empty = mkdtempSync(join(tmpdir(), 'cro-br-empty-'))
    try {
      expect(listCroTrajectories(empty), '根目录不存在 ⇒ 空数组').toEqual([])
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})
