import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getStatus, setSafeMode, readDshVersion, dshVersionFromEntry } from '../src/status.js'

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
describe('status: readDshVersion 的**静态候选链**（入口档不适用时：三条候选 ＋ 失败终态）', () => {
  const KEYS = ['npm_config_prefix', 'APPDATA'] as const
  let saved: Record<string, string | undefined>
  let savedArgv1: string | undefined

  beforeEach(() => {
    saved = {}
    for (const k of KEYS) saved[k] = process.env[k]
    // 🔴 让**入口档**（`dshVersionFromEntry`）在本组**确定性地不适用**：本机真实 `argv[1]` 是 vitest 的入口，
    //    它的祖先里没有 `@deepseek-ai/dsh` 包 ⇒ 本来就该返回 null。但那是**隐式环境假设**
    //    （"vitest 恰好不在某个 dsh 包内"），一旦将来有环境把测试进程挂在 dsh 包内，本组会**静默改义**。
    //    ⇒ 显式钉住：入口指向一个**不存在**的路径（realpath 抛 ⇒ 本档不适用）。入口档本身由下一组逐条覆盖。
    savedArgv1 = process.argv[1]
    process.argv[1] = join(dir, 'not-a-dsh-entry.js')
  })

  afterEach(() => {
    for (const k of KEYS) {
      const v = saved[k]
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    if (savedArgv1 === undefined) delete process.argv[1]
    else process.argv[1] = savedArgv1
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

/**
 * 🔴 **布局无关档**（2026-09-28；修的是 docker bench 实测出的一处**静默失效**）。
 *
 * 缺陷形态：静态候选链**猜**三个安装位置 ⇒ 宿主装在别处（容器镜像 = `/usr/local/lib/node_modules/…`）
 * 时**全不中** ⇒ `null` ⇒ `checkHostVersion(null)` 只给 `required:false` 的 issue ⇒ `ok` 仍 true
 * ⇒ **版本门完全静默**（bench 逐字 `host contract degraded (1 optional): host version unknown`）。
 * 修法：从 `process.argv[1]`（= 启动本进程的那个脚本）**反推**宿主包根 —— "我们正跑在哪个宿主里"
 * 本来就有直接证据，不必猜。
 *
 * 本组把 `dshVersionFromEntry` **按注入参数**逐条打：不碰全局 `process.argv`（除 ⑦ 的组合用例），
 * 也不碰 `os.homedir` 替身 ⇒ 与上面那组的夹具互不干扰。所有临时目录都建在**外层 `dir` 之下**（它的
 * `afterEach` 负责清理）。
 */
describe('status: dshVersionFromEntry（布局无关档：从运行入口反推宿主包根）', () => {
  /** 造宿主包：`<root>/node_modules/@deepseek-ai/dsh/package.json`（`name` 可改，用于假阳性档） */
  function hostPkg(root: string, version: string, name = '@deepseek-ai/dsh'): string {
    const pkgDir = join(root, 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name, version }))
    return pkgDir
  }
  /** 在宿主包内造一个入口脚本，返回其路径；`sub` = 包内相对目录链（如 `['lib']`） */
  function entryIn(pkgDir: string, sub: string[]): string {
    const at = join(pkgDir, ...sub)
    mkdirSync(at, { recursive: true })
    const file = join(at, 'bin.js')
    writeFileSync(file, '// entry')
    return file
  }

  it('① 🔴 容器布局命中：入口 = `<root>/node_modules/@deepseek-ai/dsh/lib/bin.js`', () => {
    const pkgDir = hostPkg(dir, '7.1.1-container')
    expect(dshVersionFromEntry(entryIn(pkgDir, ['lib']))).toBe('7.1.1-container')
  })

  it('② 入口是**符号链接**（全局安装的常态）⇒ 仍命中 —— 正控：证 realpath 真生效', () => {
    const pkgDir = hostPkg(dir, '7.2.2-via-symlink')
    const real = entryIn(pkgDir, ['lib'])
    const linkDir = join(dir, 'bin')
    mkdirSync(linkDir, { recursive: true })
    const link = join(linkDir, 'dsh')
    symlinkSync(real, link)
    // 若没有 realpath，`argv[1]` 停在 `<…>/bin/dsh` ⇒ 上溯不到包根 ⇒ 本断言红
    expect(dshVersionFromEntry(link)).toBe('7.2.2-via-symlink')
  })

  it('③ 🔴 入口**不是** dsh（vitest/npx 那类）⇒ null：绝不误报别人的 package.json', () => {
    const other = join(dir, 'not-dsh')
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, 'package.json'), JSON.stringify({ name: 'vitest', version: '1.6.1' }))
    const file = join(other, 'cli.js')
    writeFileSync(file, '// entry')
    expect(dshVersionFromEntry(file)).toBeNull()
  })

  it('④ 入口在包内**多层**（`lib/a/b/c/`）⇒ 仍命中（不是只认 `lib/` 一层）', () => {
    const pkgDir = hostPkg(dir, '7.4.4-deep-inside')
    expect(dshVersionFromEntry(entryIn(pkgDir, ['lib', 'a', 'b', 'c']))).toBe('7.4.4-deep-inside')
  })

  it('🔴 上溯**有界**：宿主包落在 7 层之外 ⇒ null（证明它不会一路爬到文件系统根）', () => {
    const pkgDir = hostPkg(dir, '7.5.5-out-of-reach')
    // 从 `lib/a/b/c/d/e/f` 到包根需 7 次上溯 > MAX_ENTRY_ASCENT(6) ⇒ 够不到
    expect(dshVersionFromEntry(entryIn(pkgDir, ['lib', 'a', 'b', 'c', 'd', 'e', 'f']))).toBeNull()
  })

  it('🔴 目录形态像 dsh 但 **name 对不上** ⇒ 不取它的 version（本档唯一的假阳性来源）', () => {
    const pkgDir = hostPkg(dir, '7.6.6-impostor', '@deepseek-ai/dsh-lookalike')
    expect(dshVersionFromEntry(entryIn(pkgDir, ['lib']))).toBeNull()
  })

  it('🔴 入口不存在 ⇒ null 且不抛（`node -e` 一类 ⇒ 交给静态候选链）', () => {
    expect(dshVersionFromEntry(join(dir, 'nope', 'bin.js'))).toBeNull()
    expect(dshVersionFromEntry(undefined)).toBeNull()
    expect(dshVersionFromEntry('')).toBeNull()
  })

  it('入口是**目录** ⇒ 从该目录起上溯（防御档：`argv[1]` 正常是脚本路径，但不做此假设）', () => {
    const pkgDir = hostPkg(dir, '7.8.8-dir-entry')
    mkdirSync(join(pkgDir, 'lib'), { recursive: true })
    expect(dshVersionFromEntry(join(pkgDir, 'lib'))).toBe('7.8.8-dir-entry')
  })

  it('⑦ 组合：入口档**优先于**静态候选链（两者都能命中时取入口的那个）', () => {
    const entryPkg = hostPkg(dir, '7.7.7-entry')
    const entry = entryIn(entryPkg, ['lib'])
    const envRoot = join(dir, 'env-root')
    const envPkg = join(envRoot, 'lib', 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(envPkg, { recursive: true })
    writeFileSync(join(envPkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.9.9-env' }))

    const savedArgv1 = process.argv[1]
    const savedPrefix = process.env.npm_config_prefix
    process.argv[1] = entry
    process.env.npm_config_prefix = envRoot
    try {
      expect(readDshVersion()).toBe('7.7.7-entry') // 两个都能命中 ⇒ 直接证据赢
    } finally {
      if (savedArgv1 === undefined) delete process.argv[1]
      else process.argv[1] = savedArgv1
      if (savedPrefix === undefined) delete process.env.npm_config_prefix
      else process.env.npm_config_prefix = savedPrefix
    }
  })
})
