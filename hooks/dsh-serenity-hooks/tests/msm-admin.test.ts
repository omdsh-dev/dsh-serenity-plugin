/**
 * msm-admin.test.ts — MSM 管理面与安全边界（⑤ 第 19 件）
 *
 * 靶 = `src/msm-ops.ts`（"船上的机器"：注册表 ＋ 管理动作 ＋ exec 装配 ＋ 安全边界）。
 * 挑靶依据 = 分支覆盖率最低的可用文件（语句 83.83% / **分支 59.54%**，897 语句）。
 *
 * 🔴 **与既有测试的分工（别重复）**：
 *   · `ops.test.ts`            — exec 执行 ／ 未注册 ／ register **成功** ＋ check M1
 *   · `acc-extras.test.ts`     — guide ／ catalog ／ `--schema` ／ `--format=json` ／ **词法** path 逃逸
 *   · `msm-tool.test.ts`       — 工具面（**mock 掉 `runMsmAsync`**）
 *   · `container-admin.test.ts`— 管理工具面（**mock 掉 `runMsm`**）
 *   ⇒ 本文件补的正是"**真 `runMsm` / `runMsmAsync`**"这一侧：
 *     register 五态校验 ／ deregister ／ list ／ ccc-config ／ 未知 action ／ `--list` 协议 ／
 *     **真 symlink 逃逸**（≠ 词法逃逸）／ M4 判定 ／ 扫描边 ／ `runMsmAsync` 免 spawn 段。
 *
 * 🔴 **诚实边界（不许写成恒绿 —— 与 `ops.test.ts` 的 `HAS_BUN` 同一先例与理由）**：
 *   · `bunExecutablePath()` 的候选循环（`BUN_EXE_CANDIDATES`）在**非 win32 平台不可达**
 *     （首行 `platform !== 'win32'` 即返回 `'bun'`）⇒ 本机（Linux）无法诚实覆盖，**非缺口**。
 *   · 「bun 缺失回落 npx」与 `isBunMissing()` 的 **true 分支** 依赖"本机没有 bun"
 *     ⇒ 只能在真无 bun 的机器上覆盖 ⇒ 本文件按 `HAS_BUN` 分流，缺席时**如实 skip**。
 *   · `protocolResult` 末尾的 `return undefined`（`{list|schema}` 之外没有第三种协议）
 *     ⇒ **构造上不可达**（登记为 ② 死代码候选，不为其硬凑用例）。
 *   · `assertPathInsideRoot` 内层 `catch` 的"realpath 失败放行"分支：`realpathSync` 只因
 *     路径不可搜索而抛，而那种情形 `existsSync` 已为假 ⇒ 进不了该分支 ⇒ **同样不可达**。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync, chmodSync, readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runMsm, runMsmAsync, checkRegistryQuality } from '../src/msm-ops.js'

const SCRIPTS_REL = '.opencode/skills/t/scripts'
const REGISTRY_REL = '.opencode/skills/t/references/mech-registry.json'

/** 真入口脚本：命中 `hasCliEntry` 判据（shebang ∨ `function main(` 二者其一即可） */
const ENTRY_SRC = 'function main() {}\nmain()\n'
/** 副作用脚本：若被 spawn 就会在 cwd(=root) 落标记 ⇒ 用"标记不在"证明**未 spawn** */
const SPAWN_MARKER_SRC = "import { writeFileSync } from 'node:fs'\nwriteFileSync('spawned.marker', 'x')\n"

/**
 * TS 运行时探测：`exec` 直跑 `.ts` 需要 bun（无 bun 时回落 `npx tsx`，而临时 CCC 里没有本地
 * tsx ⇒ 要联网），故**执行类断言只在 bun 在场时进行**（先例与长说明见 `tests/ops.test.ts`）。
 */
const HAS_BUN = ((): boolean => {
  try {
    execFileSync('bun', ['--version'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
})()

/** root 下 `chmod 000` 对 root 用户无效 ⇒ 权限类用例在 root 上如实跳过 */
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0

let dir: string
let outside: string | null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hooks-msm-admin-'))
  outside = null
  // 注册表单级化：cccName = t ⇒ 聚合档 .opencode/skills/t/references/mech-registry.json
  writeFileSync(join(dir, '.serenity'), 't')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  if (outside) {
    rmSync(outside, { recursive: true, force: true })
    outside = null
  }
})

// ── 夹具助手 ──────────────────────────────────────────────────────────────────

function scriptsDir(): string {
  return join(dir, SCRIPTS_REL)
}

function writeScript(name: string, src = ENTRY_SRC): string {
  mkdirSync(scriptsDir(), { recursive: true })
  const abs = join(scriptsDir(), name)
  writeFileSync(abs, src)
  return abs
}

function registryAbs(): string {
  return join(dir, REGISTRY_REL)
}

/** 直接落一份注册表（wrapped=false ⇒ 裸数组形态，用于"格式保持"用例） */
function writeRegistry(entries: unknown[], wrapped = true): void {
  mkdirSync(join(dir, '.opencode', 'skills', 't', 'references'), { recursive: true })
  writeFileSync(registryAbs(), (wrapped ? JSON.stringify({ version: 1, entries }, null, 2) : JSON.stringify(entries, null, 2)) + '\n')
}

function rawRegistry(): string {
  return readFileSync(registryAbs(), 'utf-8')
}

/** 读盘并归一化（v1 wrapper ／ 裸数组两种形态都给 entries 数组） */
function registryEntries(): { name: string; [k: string]: unknown }[] {
  const data = JSON.parse(rawRegistry()) as unknown
  return Array.isArray(data) ? (data as { name: string }[]) : (data as { entries: { name: string }[] }).entries
}

/** register 一步到位（默认 path 指向同名脚本、字段齐全） */
function registerEntry(name: string, extra: Record<string, unknown> = {}): unknown {
  return runMsm(dir, {
    action: 'register',
    name,
    path: `${SCRIPTS_REL}/${name}.ts`,
    skill: 't',
    category: 'mech',
    description: 'd',
    ...extra,
  } as never)
}

/** 真 git 仓（为覆盖 register/deregister 的**精提交**成功路径 —— 非 git 环境只会走 catch） */
function gitInit(): void {
  execFileSync('git', ['init', '-q', '-b', 'master'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir })
  // 仓库本地关掉签名：本用例要验的是**提交真的发生**，不该被机器级 gpgsign 配置否决
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir })
}

function gitLog(): string {
  return execFileSync('git', ['log', '--oneline'], { cwd: dir, encoding: 'utf-8' })
}

// ── register：五态校验 ＋ 落盘 ＋ 格式保持 ＋ 精提交 ────────────────────────────

describe('msm-ops · register 校验与落盘', () => {
  it('缺 name ／ 缺 path|category|description ⇒ 前置抛错', () => {
    expect(() => runMsm(dir, { action: 'register', path: `${SCRIPTS_REL}/a.ts`, category: 'mech', description: 'd' } as never)).toThrow(
      /register requires name/,
    )
    expect(() => runMsm(dir, { action: 'register', name: 'a' } as never)).toThrow(/register requires path\/category\/description/)
  })

  it('path 逃逸 ⇒ 拒绝，且**不动盘**（注册表未被创建）', () => {
    writeScript('a.ts')
    expect(() => registerEntry('a', { path: '../evil.ts' })).toThrow(/escapes CCC root/)
    expect(existsSync(registryAbs())).toBe(false)
  })

  it('脚本不存在 ⇒ 拒绝（根内但缺文件）', () => {
    expect(() => registerEntry('ghost')).toThrow(/MSM script not found/)
    expect(existsSync(registryAbs())).toBe(false)
  })

  it('重名 ⇒ 拒绝（与既有条目对账，不覆盖、不追加）', () => {
    writeScript('tool.ts')
    registerEntry('tool')
    expect(registryEntries()).toHaveLength(1)
    expect(() => registerEntry('tool')).toThrow(/MSM already registered/)
    expect(registryEntries()).toHaveLength(1)
  })

  it('flags 非 JSON 数组 ⇒ 拒绝（坏 JSON 与非数组两态）', () => {
    writeScript('a.ts')
    expect(() => registerEntry('a', { flags: 'not-json' })).toThrow(/register flags parse failed/)
    expect(() => registerEntry('a', { flags: '{"name":"x"}' })).toThrow(/flags must be a JSON array/)
    expect(() => registerEntry('a', { flags: '[1,2]' })).not.toThrow() // 数组即合法（元素形状不校验，对齐 osp）
  })

  it('首建 ⇒ v1 wrapper ＋ 缺省 usage ＋ flags 落盘', () => {
    writeScript('a.ts')
    const r = registerEntry('a', { flags: '[{"name":"hook","type":"string","description":"h"}]' }) as { registered: string; registry: string }
    expect(r.registered).toBe('a')
    expect(r.registry).toBe(REGISTRY_REL)
    const data = JSON.parse(rawRegistry()) as { version: number; entries: { name: string; usage: string; flags: { name: string }[] }[] }
    expect(data.version).toBe(1) // P3-③：文件不存在时一律 v1 wrapper（不再分裂成裸数组）
    expect(data.entries[0]!.usage).toBe('msm a [args...]')
    expect(data.entries[0]!.flags.map((f) => f.name)).toEqual(['hook'])
  })

  it('自定义 usage ⇒ 落盘采用（不被缺省覆盖）；未传 flags ⇒ 空数组', () => {
    writeScript('a.ts')
    registerEntry('a', { usage: 'msm a run <id>' })
    const data = JSON.parse(rawRegistry()) as { entries: { usage: string; flags: unknown[] }[] }
    expect(data.entries[0]!.usage).toBe('msm a run <id>')
    expect(data.entries[0]!.flags).toEqual([])
  })

  it('既有**裸数组**注册表 ⇒ 保持裸数组格式（不自作升级为 wrapper）', () => {
    writeScript('new.ts')
    writeRegistry([{ name: 'old', path: `${SCRIPTS_REL}/new.ts`, skill: 't', category: 'mech' }], false)
    registerEntry('new')
    expect(Array.isArray(JSON.parse(rawRegistry()))).toBe(true)
    expect(registryEntries().map((e) => e.name)).toEqual(['old', 'new'])
  })

  it('git 仓内 ⇒ **精提交**：只 add 注册表 ＋ commit 信息含 register（真 git 往返）', () => {
    gitInit()
    writeScript('tool.ts')
    registerEntry('tool')
    expect(gitLog()).toContain('chore(msm): register tool')
    // 精提交判据 = 该提交**只**动了注册表（脚本文件不在提交里 ⇒ 没走 add -A）
    const files = execFileSync('git', ['show', '--name-only', '--pretty=format:'], { cwd: dir, encoding: 'utf-8' })
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    expect(files).toEqual([REGISTRY_REL])
  })
})

// ── deregister ────────────────────────────────────────────────────────────────

describe('msm-ops · deregister', () => {
  it('成功 ⇒ 条目真从盘上消失（v1 wrapper 形态保持）', () => {
    writeScript('a.ts')
    writeScript('b.ts')
    registerEntry('a')
    registerEntry('b')
    expect(runMsm(dir, { action: 'deregister', name: 'a' })).toEqual({ deregistered: 'a' })
    expect(registryEntries().map((e) => e.name)).toEqual(['b'])
    expect((JSON.parse(rawRegistry()) as { version: number }).version).toBe(1)
  })

  it('未注册 ⇒ 抛错（响亮，不是静默 no-op）且盘上不动', () => {
    writeScript('a.ts')
    registerEntry('a')
    expect(() => runMsm(dir, { action: 'deregister', name: 'nope' })).toThrow(/MSM not registered/)
    expect(registryEntries().map((e) => e.name)).toEqual(['a'])
  })

  it('无 .serenity ⇒ 找不到注册表 ⇒ 仍抛 not registered（不崩）', () => {
    writeScript('a.ts')
    registerEntry('a')
    rmSync(join(dir, '.serenity'))
    expect(() => runMsm(dir, { action: 'deregister', name: 'a' })).toThrow(/MSM not registered/)
  })

  it('裸数组注册表 ⇒ 删一条后仍是裸数组', () => {
    writeScript('a.ts')
    writeRegistry(
      [
        { name: 'a', path: `${SCRIPTS_REL}/a.ts`, skill: 't', category: 'mech' },
        { name: 'b', path: `${SCRIPTS_REL}/a.ts`, skill: 't', category: 'mech' },
      ],
      false,
    )
    runMsm(dir, { action: 'deregister', name: 'a' })
    expect(Array.isArray(JSON.parse(rawRegistry()))).toBe(true)
    expect(registryEntries().map((e) => e.name)).toEqual(['b'])
  })

  it('git 仓内 ⇒ 精提交：commit 信息含 deregister（真 git 往返）', () => {
    gitInit()
    writeScript('a.ts')
    registerEntry('a')
    runMsm(dir, { action: 'deregister', name: 'a' })
    expect(gitLog()).toContain('chore(msm): deregister a')
  })
})

// ── list ／ ccc-config ／ 未知 action ──────────────────────────────────────────

describe('msm-ops · list / ccc-config / 未知 action', () => {
  it('list：空注册表 ⇒ (no MSM registered) ＋ 头部含 CCC 名与根', () => {
    const out = runMsm(dir, { action: 'list' }) as string
    expect(out).toContain('CCC:t')
    expect(out).toContain(dir)
    expect(out).toContain('(no MSM registered)')
  })

  it('list：有条目 ⇒ 行格式；flags 有/无两态 ＋ 缺省字段回落', () => {
    writeScript('a.ts')
    writeRegistry([
      { name: 'a', path: `${SCRIPTS_REL}/a.ts`, skill: 't', category: 'mech', description: 'A', flags: [{ name: 'out', type: 'path' }, { name: 'q' }] },
      { name: 'b', path: `${SCRIPTS_REL}/a.ts` }, // skill/category/description/flags 全缺省
    ])
    const out = runMsm(dir, { action: 'list' }) as string
    // flags 行：`--name <type>`，type 缺省回落 string
    expect(out).toContain('a | t | mech | A [flags: --out <path>, --q <string>]')
    // 缺省字段回落 '-'
    expect(out).toContain('b | - | - | ')
    // 无 flags 的条目**不追加** [flags: …]
    const lineB = out.split('\n').find((l) => l.startsWith('b |'))
    expect(lineB).toBeDefined()
    expect(lineB).not.toContain('[flags:')
  })

  it('ccc-config ⇒ 返回非空配置参考（对齐 osp）', () => {
    const out = runMsm(dir, { action: 'ccc-config' }) as string
    expect(out).toContain('CCC Configuration Reference')
    expect(out).toContain('handyman.models')
  })

  it('未知 action ⇒ 抛 Unknown action（响亮而非静默默认）', () => {
    expect(() => runMsm(dir, { action: 'bogus' as never })).toThrow(/Unknown action: bogus/)
  })
})

// ── exec 协议面：--list（不 spawn 脚本） ────────────────────────────────────────

describe('msm-ops · exec 协议面 --list', () => {
  it('--list ⇒ 注册表条目数组 {name, category}；脚本**未被 spawn**', () => {
    writeScript('a.ts', SPAWN_MARKER_SRC)
    writeRegistry([
      { name: 'a', path: `${SCRIPTS_REL}/a.ts`, skill: 't', category: 'mech' },
      { name: 'b', path: `${SCRIPTS_REL}/a.ts` }, // 无 category ⇒ null
    ])
    const r = runMsm(dir, { action: 'exec', name: 'a', args: ['--list'] }) as { name: string; category: string | null }[]
    expect(r).toEqual([
      { name: 'a', category: 'mech' },
      { name: 'b', category: null },
    ])
    // 判据是"结果态"：标记文件不在 ⇒ 协议分流真的**没走到 spawn**
    expect(existsSync(join(dir, 'spawned.marker'))).toBe(false)
  })
})

// ── 安全边界：真 symlink 逃逸（≠ 词法逃逸） ────────────────────────────────────

describe('msm-ops · 安全边界：真 symlink 逃逸', () => {
  /** 注册一个带 `type:"path"` flag 的条目（flag 名 = out） */
  function setupPathFlagEntry(): void {
    writeScript('x.ts', SPAWN_MARKER_SRC)
    writeRegistry([{ name: 'x', path: `${SCRIPTS_REL}/x.ts`, skill: 't', category: 'mech', flags: [{ name: 'out', type: 'path' }] }])
  }

  it('词法根内、symlink 指向根外 ⇒ 拒绝（`--flag=value` 形态）', () => {
    setupPathFlagEntry()
    outside = mkdtempSync(join(tmpdir(), 'hooks-msm-outside-'))
    symlinkSync(outside, join(dir, 'link'), 'dir')
    expect(() => runMsm(dir, { action: 'exec', name: 'x', args: ['--out=link'] })).toThrow(/resolves via symlink outside the root/)
    expect(existsSync(join(dir, 'spawned.marker'))).toBe(false)
  })

  it('同一条 symlink 以空格形态传入 ⇒ 同样拒绝（位置参数分支）', () => {
    setupPathFlagEntry()
    outside = mkdtempSync(join(tmpdir(), 'hooks-msm-outside-'))
    symlinkSync(outside, join(dir, 'link'), 'dir')
    expect(() => runMsm(dir, { action: 'exec', name: 'x', args: ['--out', 'link'] })).toThrow(/resolves via symlink outside the root/)
    expect(existsSync(join(dir, 'spawned.marker'))).toBe(false)
  })

  it.skipIf(!HAS_BUN)('正控：指向根**内**的 symlink 放行（判据在甄别，不是"见 symlink 就拒"）', () => {
    setupPathFlagEntry()
    mkdirSync(join(dir, 'inside-dir'), { recursive: true })
    symlinkSync(join(dir, 'inside-dir'), join(dir, 'link-in'), 'dir')
    let err: unknown
    try {
      runMsm(dir, { action: 'exec', name: 'x', args: ['--out', 'link-in'] })
    } catch (e) {
      err = e
    }
    expect(String(err ?? '')).not.toContain('symlink')
    // 放行到底 ⇒ 脚本真被执行（正控的"确实走通了"一侧）
    expect(existsSync(join(dir, 'spawned.marker'))).toBe(true)
  })
})

// ── check：M4 判定 ＋ 扫描边 ＋ hasCliEntry 读失败 ─────────────────────────────

describe('msm-ops · checkRegistryQuality 的 M4 与扫描边', () => {
  it('无 .opencode/skills ⇒ 扫描直接返回（checked 0、无 issue）', () => {
    expect(checkRegistryQuality(dir)).toEqual({ checked: 0, issues: [] })
  })

  it('M4：flag 名含 path/file/dir 但未标 type:"path" ⇒ issue；已标 ／ 名字无关 ／ 无 name ⇒ 无', () => {
    writeScript('a.ts')
    writeRegistry([
      {
        name: 'a',
        path: `${SCRIPTS_REL}/a.ts`,
        skill: 't',
        category: 'mech',
        flags: [
          { name: 'outfile', type: 'string' }, // ⇒ M4（type 不是 path）
          { name: 'indir' }, // 无 type ⇒ M4
          { name: 'outfile2', type: 'path' }, // 已标 ⇒ 无
          { name: 'verbose' }, // 名字不含 path/file/dir ⇒ 无
          { type: 'path' }, // 无 name ⇒ `'name' in f` 为假 ⇒ 跳过
        ],
      },
    ])
    const report = checkRegistryQuality(dir)
    expect(report.checked).toBe(1)
    const m4 = report.issues.filter((i) => i.check === 'M4')
    expect(m4.map((i) => i.name)).toEqual(['a', 'a'])
    expect(m4[0]!.detail).toContain('--outfile')
    expect(m4[1]!.detail).toContain('--indir')
  })

  it('扫描边：悬空 symlink ／ 目录 ／ 测试文件 ／ 非脚本扩展名 ／ 库模块 ⇒ 均不上报 M3（真入口上报＝正控）', () => {
    mkdirSync(join(dir, '.opencode', 'skills', 'noscripts'), { recursive: true }) // 无 scripts/ 的 skill ⇒ continue
    writeScript('real.ts', ENTRY_SRC) // 真入口 ⇒ 上报（正控）
    symlinkSync(join(scriptsDir(), 'gone.ts'), join(scriptsDir(), 'broken.ts')) // 悬空符号链接 ⇒ statSync 抛 ⇒ continue
    mkdirSync(join(scriptsDir(), 'adir.ts'), { recursive: true }) // 名为 *.ts 的**目录** ⇒ isFile 假 ⇒ continue
    writeScript('foo.test.ts') // 测试文件 ⇒ continue
    writeScript('notes.md') // 扩展名不符 ⇒ continue
    writeScript('lib.ts', 'export const x = 1\n') // 库：无 shebang ∧ 无 main() ⇒ continue

    const m3 = checkRegistryQuality(dir).issues.filter((i) => i.check === 'M3').map((i) => i.name)
    expect(m3).toEqual([`${SCRIPTS_REL}/real.ts`])
  })

  it.skipIf(IS_ROOT)('hasCliEntry：脚本**读不出来** ⇒ 按入口上报（不静默漏候选）；同文件可读时不报（正控）', () => {
    const abs = writeScript('locked.ts', 'const x = 1\n') // 无 shebang ∧ 无 main()
    chmodSync(abs, 0o000)
    // 读不出 ⇒ 上报（宁可多报也不静默放过）
    expect(
      checkRegistryQuality(dir)
        .issues.filter((i) => i.check === 'M3')
        .map((i) => i.name),
    ).toEqual([`${SCRIPTS_REL}/locked.ts`])
    // 正控：内容一字未改、**只**恢复权限 ⇒ 判据翻回"不是入口" ⇒ 证明差异只在"读得出来吗"
    chmodSync(abs, 0o644)
    expect(checkRegistryQuality(dir).issues.filter((i) => i.check === 'M3')).toEqual([])
  })
})

// ── runMsmAsync 免 spawn 段 ＋ （bun 在场时）真跑 ──────────────────────────────

describe('msm-ops · runMsmAsync', () => {
  it('非 exec 动作 ⇒ 委托同步实现（不 spawn）', async () => {
    expect(await runMsmAsync(dir, { action: 'list' })).toContain('(no MSM registered)')
    expect(await runMsmAsync(dir, { action: 'ccc-config' })).toContain('CCC Configuration Reference')
  })

  it('exec --list 协议 ⇒ 返回条目数组（脚本未被 spawn）', async () => {
    writeScript('a.ts', SPAWN_MARKER_SRC)
    writeRegistry([{ name: 'a', path: `${SCRIPTS_REL}/a.ts`, skill: 't', category: 'mech' }])
    const r = (await runMsmAsync(dir, { action: 'exec', name: 'a', args: ['--list'] })) as { name: string; category: string | null }[]
    expect(r).toEqual([{ name: 'a', category: 'mech' }])
    expect(existsSync(join(dir, 'spawned.marker'))).toBe(false)
  })

  it.skipIf(!HAS_BUN)('exec 真跑（bun）：成功 ⇒ exit 0 ＋ stdout 透传 ＋ 无 TIP', async () => {
    writeScript('ok.ts', 'console.log("MSM-OK")\n')
    writeRegistry([{ name: 'ok', path: `${SCRIPTS_REL}/ok.ts`, skill: 't', category: 'mech' }])
    const r = (await runMsmAsync(dir, { action: 'exec', name: 'ok', args: [] })) as { exit: number; stdout: string; stderr: string }
    expect(r.exit).toBe(0)
    expect(r.stdout).toContain('MSM-OK')
    expect(r.stderr).not.toContain('[TIP]')
  })

  it.skipIf(!HAS_BUN)('exec 真跑（bun）：非零退出 ⇒ 码透传 ＋ 追加 TIP；带 --help 则不加 TIP', async () => {
    writeScript('bad.ts', 'process.exit(3)\n')
    writeRegistry([{ name: 'bad', path: `${SCRIPTS_REL}/bad.ts`, skill: 't', category: 'mech' }])
    const failed = (await runMsmAsync(dir, { action: 'exec', name: 'bad', args: [] })) as { exit: number; stderr: string }
    expect(failed.exit).toBe(3)
    expect(failed.stderr).toContain('[TIP]')
    // hasHelp 分支：业务参数含 --help ⇒ 不再追加提示（对齐 osp）
    const withHelp = (await runMsmAsync(dir, { action: 'exec', name: 'bad', args: ['--help'] })) as { exit: number; stderr: string }
    expect(withHelp.exit).toBe(3)
    expect(withHelp.stderr).not.toContain('[TIP]')
  })
})
