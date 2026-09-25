import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getStatus, setSafeMode, readDshVersion } from '../src/status.js'

/**
 * 🔴 **实测发现（本件首跑即撞到，值得记）**：**在本进程内改 `process.env.HOME` 不会改变 `os.homedir()`** ——
 * 我原计划"用 `$HOME` 驱动第三条候选"，实测仍读到**本机真实安装**（返回真版本 `0.1.7-rc.2`）。
 * 机制**未定位**（Node 侧缓存 / 不经 env —— 两种解释都未被证伪）⇒ 要驱动 `readDshVersion` 的
 * **第三条候选**（`~/.npm-global`）与"三条全失败 ⇒ null"终态，**只能对 `homedir` 做替身**。
 * 替身**默认透传真实现**（`home === null` ⇒ 原样调用），仅在 ⑥／⑦ 两个用例里接管。
 */
const osStub = vi.hoisted(() => ({ home: null as string | null }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => osStub.home ?? actual.homedir() }
})

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'status-'))
  writeFileSync(join(dir, '.serenity'), 'test')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('status: getStatus', () => {
  it('CCC 内返回完整状态', () => {
    const s = getStatus(dir)
    expect(s.root).toBe(dir)
    expect(s.safeModeOn).toBe(false)
    expect(s.accVersion).toBeTruthy()
  })

  it('非 CCC 返回 root null', () => {
    const s = getStatus('/tmp')
    expect(s.root).toBeNull()
    expect(s.safeModeOn).toBe(false)
  })

  it('读取黑名单 / 阈值 / handyman 模型', () => {
    mkdirSync(join(dir, '.opencode'))
    writeFileSync(
      join(dir, '.opencode', 'serenity.json'),
      JSON.stringify({ handyman: { models: ['m3'] }, sessionKeeper: { threshold: 100 }, safeMode: { blacklist: ['.secrets/'] } }),
    )
    const s = getStatus(dir)
    expect(s.threshold).toBe(100)
    expect(s.handymanModel).toBe('m3')
    // 对齐 osp：黑名单条目为 {pattern} 对象
    expect(s.blacklist).toEqual([{ pattern: '.secrets/' }])
  })

  it('P2-7 扩展：nodeVersion 恒有；dshVersion 读得到返回字符串、读不到为 null', () => {
    const s = getStatus(dir)
    expect(s.nodeVersion).toMatch(/^v\d+\.\d+\.\d+/)
    // dshVersion 依赖本机 npm 全局安装；两者之一成立即可（CI/无安装场景为 null）
    expect(s.dshVersion === null || typeof s.dshVersion === 'string').toBe(true)
  })
})

describe('status: setSafeMode（WebUI 开关通道）', () => {
  it('开 → 创建标记；关 → 删除标记', () => {
    expect(getStatus(dir).safeModeOn).toBe(false)
    const on = setSafeMode(dir, true)
    expect(on.on).toBe(true)
    expect(existsSync(join(dir, '.serenity-safe-on'))).toBe(true)
    expect(getStatus(dir).safeModeOn).toBe(true)

    const off = setSafeMode(dir, false)
    expect(off.on).toBe(false)
    expect(existsSync(join(dir, '.serenity-safe-on'))).toBe(false)
  })

  it('幂等：重复开/关不报错', () => {
    setSafeMode(dir, true)
    expect(setSafeMode(dir, true).on).toBe(true)
    setSafeMode(dir, false)
    expect(setSafeMode(dir, false).on).toBe(false)
  })
})

/**
 * 🔵 本组补的缺口（判据 = 覆盖率报告 `cstat-no`/`cbranch-no` **逐行核对**）：
 * `readDshVersion` 的**候选链**此前只走过"第三条候选恰好命中"这一条路 —— 本机 `~/.npm-global`
 * 真有安装 ⇒ 循环在**最后一项**成功 ⇒ 前两条 env 候选、`catch`、以及 `return null` 终态**全未执行**。
 *
 * 🔴 **前两条候选不 mock**：`npm_config_prefix` / `APPDATA` 用**真临时安装根 ＋ 真 env 变量**驱动
 * （它们就是普通的 `process.env` 读取 ⇒ 真设真读，比替身强）。
 * **第三条候选与 null 终态需要一个替身** —— 因为 `os.homedir()` 在本进程内**不跟着 `$HOME` 变**
 * （见文件头部的实测发现）⇒ 用 `osStub.home` 接管；⑥ 是**读数器自证**（证明它真跟着替身走），
 * ⑦ 才断言终态 —— 没有 ⑥ 的话，⑦ 的 null 可能是"替身没生效"的假绿。
 * ⚠️ 本组替换掉上方 ④ 那条"两者之一成立即可"的**弱断言**（它对 `dshVersion` 实际上什么都没判）。
 */
describe('status: readDshVersion（DSH 安装位置探测：三条候选 ＋ 失败终态）', () => {
  const KEYS = ['npm_config_prefix', 'APPDATA'] as const
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    saved = {}
    for (const k of KEYS) saved[k] = process.env[k]
  })

  afterEach(() => {
    for (const k of KEYS) {
      const v = saved[k]
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    osStub.home = null // 替身复位（透传真实现）
  })

  /** 造一个「npm 全局安装根」下的 dsh 包目录；`content === null` ⇒ 目录存在但**无 package.json** */
  function install(root: string, sub: string[], content: string | null): void {
    const dshDir = join(root, ...sub, 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(dshDir, { recursive: true })
    if (content !== null) writeFileSync(join(dshDir, 'package.json'), content)
  }

  it('① npm_config_prefix 命中 ⇒ 取它，且**优先于** APPDATA（两候选都真存在时的正控）', () => {
    const a = mkdtempSync(join(tmpdir(), 'dsh-a-'))
    const b = mkdtempSync(join(tmpdir(), 'dsh-b-'))
    install(a, ['lib'], JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.1.1-prefix' }))
    install(b, ['npm'], JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.2.2-appdata' }))
    process.env.npm_config_prefix = a
    process.env.APPDATA = b
    expect(readDshVersion()).toBe('9.1.1-prefix')
  })

  it('② 无 npm_config_prefix ⇒ 回落 `APPDATA\\npm`（Windows 审计问题 13 的跨平台档）', () => {
    const b = mkdtempSync(join(tmpdir(), 'dsh-b-'))
    install(b, ['npm'], JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.2.2-appdata' }))
    delete process.env.npm_config_prefix
    process.env.APPDATA = b
    expect(readDshVersion()).toBe('9.2.2-appdata')
  })

  it('③ 候选**读不到 package.json**（ENOENT）⇒ 不中止，继续下一个候选', () => {
    const a = mkdtempSync(join(tmpdir(), 'dsh-a-'))
    const b = mkdtempSync(join(tmpdir(), 'dsh-b-'))
    install(a, ['lib'], null) // 目录在、文件不在 ⇒ readFileSync 抛 ⇒ catch
    install(b, ['npm'], JSON.stringify({ version: '9.3.3-second' }))
    process.env.npm_config_prefix = a
    process.env.APPDATA = b
    expect(readDshVersion()).toBe('9.3.3-second')
  })

  it('④ 候选 package.json **不是合法 JSON** ⇒ 同样走 catch 继续（坏文件不等于中断）', () => {
    const a = mkdtempSync(join(tmpdir(), 'dsh-a-'))
    const b = mkdtempSync(join(tmpdir(), 'dsh-b-'))
    install(a, ['lib'], '{ not json')
    install(b, ['npm'], JSON.stringify({ version: '9.4.4-json' }))
    process.env.npm_config_prefix = a
    process.env.APPDATA = b
    expect(readDshVersion()).toBe('9.4.4-json')
  })

  it('⑤ package.json **无 `version` 字符串** ⇒ 跳过该候选（不返回 undefined/数字）', () => {
    const a = mkdtempSync(join(tmpdir(), 'dsh-a-'))
    const b = mkdtempSync(join(tmpdir(), 'dsh-b-'))
    install(a, ['lib'], JSON.stringify({ name: 'x', version: 123 }))
    install(b, ['npm'], JSON.stringify({ version: '9.5.5-second' }))
    process.env.npm_config_prefix = a
    process.env.APPDATA = b
    expect(readDshVersion()).toBe('9.5.5-second')
  })

  it('⑥ 第三条候选（`~/.npm-global`）由 homedir 决定 —— 🔵 读数器自证：它真跟着替身走', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
    install(home, ['.npm-global', 'lib'], JSON.stringify({ version: '9.6.6-home' }))
    delete process.env.npm_config_prefix
    delete process.env.APPDATA
    osStub.home = home
    expect(readDshVersion()).toBe('9.6.6-home') // 若替身未生效 ⇒ 会拿到本机真版本 ⇒ ⑦ 随之变成假绿
  })

  it('🔴 三条候选**全部失败** ⇒ 返回 null（读不到 ≠ 抛错；⑥ 已先证第三条确实受控）', () => {
    const a = mkdtempSync(join(tmpdir(), 'dsh-a-'))
    const b = mkdtempSync(join(tmpdir(), 'dsh-b-'))
    const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
    install(a, ['lib'], '{ not json') // 坏 JSON
    install(b, ['npm'], '{}') // 合法 JSON 但无 version
    process.env.npm_config_prefix = a
    process.env.APPDATA = b
    osStub.home = home // 第三条候选 ⇒ <home>/.npm-global/... 不存在（⑥ 已证替身真生效）
    expect(readDshVersion()).toBeNull()
  })
})
