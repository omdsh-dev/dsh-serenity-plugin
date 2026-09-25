/**
 * env.test.ts — `seams/env.ts` 的 `registerEnv` 行为测试（⑤ 第 4 件）
 *
 * 🔴 为什么有这个文件（挑靶依据 = coverage 的**未覆盖行**）：
 *   本仓 coverage 实测 `src/seams/env.ts` **70.21%**，未覆盖面 = **整个 `registerEnv`**
 *   （`cstat-no` 逐行命中：贡献者对象体 ＋ `ctx.shellEnv.register(contributor)`）——
 *   即"这条缝**从没被装配过**"。
 *   ⚠️ 注意与**纯函数** `resolveSerenityEnv` 的区别：后者**早就有测试**（`acc-extras.test.ts`），
 *   故本条不是"重复测同一个东西"——本文件测的是**注册动作 ＋ 贡献者契约 ＋ resolve 接线**
 *   （`contributor.resolve` 里的 cwd 取值与回落），那三样此前**零执行**。
 *
 * 覆盖面：① 注册一次且形态正确（缝名 ＋ 三条 DSH_SERENITY_* 事实 ＋ 各带 description）
 *   ② `resolve` 走 CCC 根 ⇒ 三事实正确 ③ 子目录 cwd ⇒ 仍上溯到根
 *   ④ 非 CCC ⇒ **空对象**（不抛、不注入假事实）⑤ 无 agent / 无 cwd ⇒ **回落 `process.cwd()`**（用 spy 控住，
 *   不依赖"本机仓库恰好位于某个 CCC 内"这一环境事实）⑥ 空 cwd 字符串（两态）
 *   ⑦ 🔴 **「CCC 名」两套定义并存的机械钉**（见文件末组 —— 本件顺带发现，已登记进模块图）
 *
 * ⚠️ 诚实边界（与 ⑤ 前几件同）：**不写覆盖率百分比**（MSM 输出会被截断），证据 = 这些行
 *   只能由本文件的断言触达。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'

import { registerEnv } from '../../src/seams/env.js'
import { readCccName } from '../../src/ccc.js'
import { ACC_VERSION } from '../../src/constants.js'

const CCC_NAME = 'envccc'
let dir: string
let bare: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'seam-env-'))
  writeFileSync(join(dir, '.serenity'), `${CCC_NAME}\n`)
  bare = mkdtempSync(join(tmpdir(), 'seam-env-bare-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(bare, { recursive: true, force: true })
  vi.restoreAllMocks()
})

interface Contributor {
  name: string
  variables: Record<string, { description?: string }>
  resolve: (execution: unknown) => Record<string, string>
}

/** fake ctx：只提供本缝用到的 `shellEnv.register`，并把它收到的贡献者交出来 */
function fakeCtx(): { ctx: never; registered: Contributor[] } {
  const registered: Contributor[] = []
  const ctx = { shellEnv: { register: (c: Contributor) => registered.push(c) } }
  return { ctx: ctx as never, registered }
}

/** 装配一次并返回贡献者（多数用例的公共前置） */
function setup(): Contributor {
  const { ctx, registered } = fakeCtx()
  registerEnv(ctx)
  const contributor = registered[0]
  if (!contributor) throw new Error('registerEnv 未注册贡献者')
  return contributor
}

describe('registerEnv：装配（此前零执行）', () => {
  it('恰好注册一个贡献者，缝名 = dsh-serenity-hooks', () => {
    const { ctx, registered } = fakeCtx()
    expect(registerEnv(ctx)).toBeUndefined()
    expect(registered).toHaveLength(1)
    expect(registered[0]?.name).toBe('dsh-serenity-hooks')
  })

  it('声明三条 DSH_SERENITY_* 事实，且各带说明（宿主可发现）', () => {
    const { variables } = setup()
    expect(Object.keys(variables).sort()).toEqual(['DSH_SERENITY_CCC', 'DSH_SERENITY_ROOT', 'DSH_SERENITY_VERSION'])
    for (const key of Object.keys(variables)) {
      expect(variables[key]?.description, `${key} 缺 description`).toBeTruthy()
    }
    expect(variables.DSH_SERENITY_ROOT?.description).toContain('CCC root')
  })
})

describe('contributor.resolve：cwd → DSH_SERENITY_* 事实', () => {
  it('CCC 根内的 cwd ⇒ 根 / 版本正确；CCC 名 = **根目录 basename**（⚠️ 非 `.serenity` 首行，见末组）', () => {
    const facts = setup().resolve({ agent: { session: { header: { cwd: dir } } } })
    expect(facts).toEqual({
      DSH_SERENITY_ROOT: dir,
      DSH_SERENITY_CCC: basename(dir), // = 夹具目录名（随机），**不是** `.serenity` 首行的 'envccc'
      DSH_SERENITY_VERSION: ACC_VERSION,
    })
  })

  it('子目录 cwd ⇒ 上溯到 CCC 根（不是"只有恰好等于根才算"）', () => {
    const deep = join(dir, 'a', 'b', 'c')
    mkdirSync(deep, { recursive: true })
    expect(setup().resolve({ agent: { session: { header: { cwd: deep } } } }).DSH_SERENITY_ROOT).toBe(dir)
  })

  it('非 CCC 的 cwd ⇒ 空对象（不注入假事实、不抛）', () => {
    expect(setup().resolve({ agent: { session: { header: { cwd: bare } } } })).toEqual({})
  })

  it('无 agent ⇒ 回落 process.cwd()（用 spy 控住，不依赖本机仓库位置）', () => {
    const spy = vi.spyOn(process, 'cwd').mockReturnValue(dir)
    expect(setup().resolve({}).DSH_SERENITY_ROOT).toBe(dir)
    expect(spy).toHaveBeenCalled()
  })

  it('回落时 process.cwd() 不在 CCC 内 ⇒ 仍空对象', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(bare)
    expect(setup().resolve({ agent: { session: { header: {} } } })).toEqual({})
  })

  it('cwd 为空字符串 ⇒ 结果 = 以 process.cwd() 为起点解析（不抛、不注入假事实）', () => {
    // ⚠️ **本用例不能区分两种机制**：`agentCwdFor` 的 `?? process.cwd()` **不挡空串**（只挡 null/undefined），
    //   而 `findSerenityRoot('')` 内部 `resolve('')` **恰好也等于 `process.cwd()`** ⇒ 二者对空串**观测等价**。
    //   ⇒ 故这里钉的是**结果**（以 cwd 为起点解析），**不是机制** —— 不假装能判它走的是哪条路。
    vi.spyOn(process, 'cwd').mockReturnValue(dir)
    expect(setup().resolve({ agent: { session: { header: { cwd: '' } } } }).DSH_SERENITY_ROOT).toBe(dir)
  })

  it('cwd 为空字符串 + process.cwd() 不在 CCC 内 ⇒ 空对象', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(bare)
    expect(setup().resolve({ agent: { session: { header: { cwd: '' } } } })).toEqual({})
  })
})

/**
 * 🔴 本组钉住一条**本次实测发现的「同名两义」**（不是本缝的 bug，也不是"我读源码觉得"）：
 *   「CCC 名称」在**同一份代码里有两套定义**，被不同面采用 ——
 *     · **目录名**（`basename(root)`）：本缝的 `DSH_SERENITY_CCC` ／ 系统提示词身份块的 `CCC:` 行 ／ `listCccs().name`；
 *     · **`.serenity` 首行**（`readCccName`）：**MSM 注册表路径**（`.opencode/skills/<cccName>/references/…`）／
 *       `container-status` 报告 ／ `fs-ops` ／ `guards`；`weixin-send-api` **两者都输出**并分别命名为 `dirName` 与 `cccName`。
 *   ⇛ 夹具刻意让两者**不同**（目录名随机 ≠ 首行 `envccc`）⇒ 下面两条断言**可区分**两套定义
 *     （若哪天统一了，本组会红 —— 那正是我们要的信号）。⚠️ 在本 CCC 内二者**恰好相同**
 *     （目录 `home-serenity` ＝ `.serenity` 首行），故该分歧**当前是休眠的**。
 */
describe('🔴 「CCC 名」两套定义并存（本组即该分歧的机械钉）', () => {
  it('本缝注入的名字 = 目录名（≠ .serenity 首行）', () => {
    expect(setup().resolve({ agent: { session: { header: { cwd: dir } } } }).DSH_SERENITY_CCC).toBe(basename(dir))
    expect(basename(dir)).not.toBe(CCC_NAME)
  })

  it('同一 root 上 readCccName（= MSM 注册表路径所用的那套）= .serenity 首行', () => {
    expect(readCccName(dir)).toBe(CCC_NAME)
    expect(readCccName(dir)).not.toBe(basename(dir))
  })
})
