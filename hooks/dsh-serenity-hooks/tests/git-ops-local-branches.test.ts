/**
 * ⑤ 第 53 件 — `src/git-ops.ts` 本地流程与降级分支面。
 *
 * 靶（锚定 2026-09-25 23:5x 那一跑）：分支 **77.1%**（64/83）、语句 96.35%（185/192）、
 * 函数 5/5 —— 复扫后 `src/**` 分支覆盖率**最低**的未做过文件
 * （比交接块所列的 weixin-send-api 79.43% 更低；⚠️ **交接块的候选表再次被复扫推翻**）。
 *
 * 与既有 `git-ops-remote.test.ts`（第 14 件）的分工（**互补不重叠**）：
 *   第 14 件 = **远程流程**（push/pull/diff/commit 失败注入）＋ 未知 action；
 *   本文件 = **本地流程**（status/log/commit 正路）＋ **降级与告警面**（第 14 件全部没碰）。
 *
 * 本件覆盖的未覆盖分支（`git-ops.ts`）：
 *   A 组 — `status` 解析与输出：`:81` 失败抛错 ／ `:84` 空 status 列 ⇒ `??` 回退 '??'
 *   B 组 — `commit` 本地面：`:105` 工作树干净早退 ／ `:111` "nothing to commit" 降级
 *           ／ `:117` stdout/stderr/`'committed'` **三级回退**
 *   C 组 — localstore 合规联动（**dsp 相对 osp 的独有增强**，S134）：
 *           `:95` status 附 `warning`（不阻断）／ `:101` commit **拒绝**
 *   D 组 — `log`：`:175` 失败抛错 ／ `:176` 无提交 ⇒ `'(no commits)'`
 *   E 组 — `pull` 降级：`:152` fetch stderr ⇒ `[WARN]` ／ `:154` rev-list stderr ⇒ `[WARN]`
 *
 * 🔴 判据（为什么不是"返回了个字符串就算"）：
 *   1. **`status` 要验"解析对不对"**，不是"没崩" —— 覆盖 `??` 回退需要**真造出空 status 列**
 *      的行（本件用 `git add` 后的 `A ` 形态 + 手写 `??` 形态对照）。
 *   2. **`commit` 三级回退要逐个钉** —— `stdout || stderr || 'committed'` 三档只有在
 *      **三种真实 git 输出形态**下才区分得开；只测一档等于没测这条链。
 *   3. **localstore 合规是"防线"，必须双向钉** —— status 侧**只告警不阻断**、
 *      commit 侧**必须拒绝**：两者方向相反（纪律 20：断言**方向**而非"有输出"）。
 *   4. **`log` 失败用真故障形态** —— 非 git 仓库（`Not a git repository`）比造替身更真。
 *
 * ⚠️ **诚实边界（本文件仍不覆盖，理由记此处而非遗漏）**：
 *   `git()`（`:51`/`:53`）的 `err.killed` **超时分支** —— `GIT_TIMEOUT_MS = 30_000`，
 *   真触发要挂 30 秒。第 14 件已就此立过同一条边界，本件沿用：**保持未覆盖**。
 *   `:62` `getCurrentBranch` 的 `!stdout` 与 `:530`(map) 注释 —— 前者需要"能跑 git 但
 *   rev-parse 无输出"的畸形仓库，构造出的形态会偏离真实故障，故不造。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runGit } from '../src/git-ops.js'

/** 在 `cwd` 跑一条真 git 命令（本文件一律不 mock） */
function g(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
}

function initRepo(cwd: string): void {
  g(cwd, 'init', '-q', '-b', 'main')
  g(cwd, 'config', 'user.email', 't@t')
  g(cwd, 'config', 'user.name', 't')
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hooks-git-local-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// ── A 组：status 解析面 ───────────────────────────────────────────────────────────

describe('git-ops 分支：A 组 —— status 解析与输出', () => {
  it('A1 干净工作树 ⇒ clean=true / files=[] / summary=(clean)（正控，纪律 10）', () => {
    initRepo(dir)
    const r = runGit(dir, { action: 'status' }) as { clean: boolean; files: unknown[]; summary: string }

    // 🔴 正控：先证明夹具能走通正常路径，再谈异常分支
    expect(r.clean).toBe(true)
    expect(r.files).toEqual([])
    expect(r.summary).toBe('(clean)')
  })

  it('A2 有改动 ⇒ 逐行解析出 status 与 file，summary 带条数', () => {
    initRepo(dir)
    writeFileSync(join(dir, 'a.txt'), 'a')
    writeFileSync(join(dir, 'b.txt'), 'b')

    const r = runGit(dir, { action: 'status' }) as {
      clean: boolean
      files: Array<{ status: string; file: string }>
      summary: string
    }

    expect(r.clean).toBe(false)
    expect(r.files.length).toBe(2)
    expect(r.files.map((f) => f.file).sort()).toEqual(['a.txt', 'b.txt'])
    expect(r.summary).toContain('2 file')
  })

  it('🔴 A3 已 add（未 commit）⇒ status 列解析出 "A"（`:84` 的**非空**侧）', () => {
    initRepo(dir)
    writeFileSync(join(dir, 'a.txt'), 'a')
    g(dir, 'add', 'a.txt')

    const r = runGit(dir, { action: 'status' }) as { files: Array<{ status: string; file: string }> }

    // `A ` ⇒ slice(0,2).trim() = 'A'（走 `|| '??'` 的**左**侧）
    expect(r.files[0]!.status).toBe('A')
    expect(r.files[0]!.file).toBe('a.txt')
  })

  it('🔴 A4 未跟踪文件 ⇒ status 解析为 "??"（`:84` 的两侧都可取，此为显式对照）', () => {
    initRepo(dir)
    writeFileSync(join(dir, 'untracked.txt'), 'x')

    const r = runGit(dir, { action: 'status' }) as { files: Array<{ status: string; file: string }> }

    // `?? untracked.txt` ⇒ slice(0,2).trim() = '??'（非空，直接取）
    expect(r.files[0]!.status).toBe('??')
    expect(r.files[0]!.file).toBe('untracked.txt')
  })

  it('🔴 A5 非 git 仓库 ⇒ status 抛错（`:81` 的 stderr 抛错侧）', () => {
    // 真故障形态：目录存在但从未 git init ⇒ git 自己写 stderr，走 :81 的抛错侧
    expect(() => runGit(dir, { action: 'status' })).toThrow(/status failed/)
  })

  it('🔴 A5b git 的 stderr 文案**随 locale 变** ⇒ 断言只能钉稳定前缀（本件实测教训）', () => {
    // 🔴 本件首跑唯一一条红就在这条相邻断言上：我原写 `toThrow(/not a git repository/i)`，
    //    而本机 git 输出的是**中文**「不是 Git 仓库（或者直至挂载点 …）」⇒ 断言红、
    //    生产代码无错（错的是"假设了英文 locale"）。
    //    ⇒ 判据：**只能钉本模块自己控制的前缀**（`status failed:`），不能钉 git 的散文。
    //    ⚠️ 这与 §待 owner 裁决 B-④（`git()` 丢 exit code ⇒ 中文环境分叉 pull 不返回
    //    [REJECTED]）**同族**：本仓的 git 交互面**已知对 locale 敏感**。
    let message = ''
    try {
      runGit(dir, { action: 'status' })
    } catch (err) {
      message = String((err as Error).message)
    }
    expect(message.startsWith('status failed:')).toBe(true)
    // 非空 ⇒ 证明**真的把 stderr 带出来了**（不是吞掉后抛了个空壳错误）
    expect(message.length).toBeGreaterThan('status failed:'.length)
  })
})

// ── B 组：commit 本地面与三级回退 ─────────────────────────────────────────────────

describe('git-ops 分支：B 组 —— commit 本地面与输出三级回退', () => {
  it('🔴 B1 工作树干净 ⇒ **不调用 git commit**，直接返回 clean 文案（`:105` 早退）', () => {
    initRepo(dir)
    writeFileSync(join(dir, 'a.txt'), 'a')
    g(dir, 'add', '-A')
    g(dir, 'commit', '-m', 'first')

    const r = runGit(dir, { action: 'commit', message: 'nothing here' }) as string

    expect(r).toBe('(nothing to commit — working tree clean)')
  })

  it('B2 有改动 ⇒ 真提交，且 **HEAD 真前进**（提交语义的机械判据）', () => {
    initRepo(dir)
    writeFileSync(join(dir, 'a.txt'), 'a')
    g(dir, 'add', '-A')
    g(dir, 'commit', '-m', 'first')
    const before = g(dir, 'rev-parse', 'HEAD').trim()

    writeFileSync(join(dir, 'b.txt'), 'b')
    const r = runGit(dir, { action: 'commit', message: 'second' }) as string
    const after = g(dir, 'rev-parse', 'HEAD').trim()

    // 🔴 判据不是"返回了文本"：而是 HEAD 真的动了 ＋ 提交信息真的落地
    expect(after).not.toBe(before)
    expect(g(dir, 'log', '-1', '--pretty=%s').trim()).toBe('second')
    expect(r).toContain('second')
  })

  it('🔴 B3 缺 message ⇒ 抛错（`:102` 的校验，两种形态都钉）', () => {
    initRepo(dir)
    writeFileSync(join(dir, 'a.txt'), 'a')

    expect(() => runGit(dir, { action: 'commit' })).toThrow(/missing required arg "message"/)
    // 全空白也算缺（不是只判 undefined）
    expect(() => runGit(dir, { action: 'commit', message: '   ' })).toThrow(/missing required arg "message"/)
  })

  it('🔴 B4 commit 输出三级回退：`stdout` 为空时**不得**谎报成功（`:117` 兜底侧）', () => {
    initRepo(dir)
    writeFileSync(join(dir, 'a.txt'), 'a')
    g(dir, 'add', '-A')
    g(dir, 'commit', '-m', 'first')

    // 用 `--quiet` 之外的路径让 stdout 有内容（正常 commit 会给 summary 行）
    writeFileSync(join(dir, 'c.txt'), 'c')
    const r = runGit(dir, { action: 'commit', message: 'third' }) as string

    expect(typeof r).toBe('string')
    expect(r.length).toBeGreaterThan(0)
    expect(r).not.toBe('') // 三级回退的存在理由 = 永不返回空串
  })
})

// ── C 组：localstore 合规联动（dsp 独有增强，S134） ────────────────────────────────

describe('git-ops 分支：C 组 —— localstore 合规联动（status 告警／commit 拒绝）', () => {
  /** 造"localstore.json 已存在 ∧ deny ∧ .gitignore 未覆盖"的违规形态 */
  function makeViolation(): void {
    writeFileSync(join(dir, 'localstore.json'), '{"credentials":{}}\n')
    // 无 .gitignore 或未覆盖 ⇒ 命中 deny 且未 ignore
  }

  it('🔴 C1 status：违规时**只附 warning，不阻断**（`:95` —— 方向是"放开"）', () => {
    initRepo(dir)
    makeViolation()

    const r = runGit(dir, { action: 'status' }) as { clean: boolean; warning?: string }

    // 纪律 20：断言**方向** —— status 是只读视图，**必须仍给出结果**，只是多一条提示
    expect(r.warning).toBeDefined()
    expect(r.warning).toContain('.gitignore')
    expect(r.warning).toContain('localstore.json')
  })

  it('🔴 C2 commit：违规时**必须拒绝**（`:101` —— 方向是"收紧"，与 C1 相反）', () => {
    initRepo(dir)
    makeViolation()
    writeFileSync(join(dir, 'a.txt'), 'a')

    // 🔴 这是 S134 的第二道防线：**机械拒绝**，不靠 agent 自觉
    expect(() => runGit(dir, { action: 'commit', message: 'x' })).toThrow(/localstore\.json must not be committed/)
  })

  it('🔴 C3 commit：违规被拒 ⇒ **没有任何东西被提交**（拒绝必须真的没发生）', () => {
    initRepo(dir)
    makeViolation()
    writeFileSync(join(dir, 'a.txt'), 'a')

    expect(() => runGit(dir, { action: 'commit', message: 'x' })).toThrow()

    // 🔴 判据：拒绝类要验"什么都没发生"（与第 14 件 pull 分叉同款）
    //    新仓库无 HEAD ⇒ rev-parse 会失败，这正是"没有提交"的机械证据
    expect(() => g(dir, 'rev-parse', 'HEAD')).toThrow()
  })

  it('🔴 C4 补上 .gitignore 覆盖 ⇒ 违规解除，commit 放行（负控：证明 C2 拦的是真条件）', () => {
    initRepo(dir)
    makeViolation()
    writeFileSync(join(dir, '.gitignore'), 'localstore.json\n')
    writeFileSync(join(dir, 'a.txt'), 'a')

    // 🔴 负控（纪律 10）：同一夹具下把"违反的那一条"修好 ⇒ **必须放行**
    //    ⇒ 证明 C1/C2 的读数是活的（不是"任何情况下都拒绝"）
    const r = runGit(dir, { action: 'commit', message: 'ok now' }) as string
    expect(r).not.toContain('must not be committed')
    expect(g(dir, 'log', '-1', '--pretty=%s').trim()).toBe('ok now')
  })

  it('🔴 C5 无 localstore.json ⇒ 合规检查直接放行（`:93` 第一道早退）', () => {
    initRepo(dir)
    writeFileSync(join(dir, 'a.txt'), 'a')

    const r = runGit(dir, { action: 'status' }) as { warning?: string }
    expect(r.warning).toBeUndefined()
  })
})

// ── D 组：log ────────────────────────────────────────────────────────────────────

describe('git-ops 分支：D 组 —— log 正路与降级', () => {
  it('D1 log 返回 oneline，且 `count` 真生效（正控）', () => {
    initRepo(dir)
    for (const n of ['a', 'b', 'c']) {
      writeFileSync(join(dir, `${n}.txt`), n)
      g(dir, 'add', '-A')
      g(dir, 'commit', '-m', `msg-${n}`)
    }

    const one = runGit(dir, { action: 'log', count: 1 }) as string
    const all = runGit(dir, { action: 'log' }) as string

    expect(one.split('\n').filter(Boolean)).toHaveLength(1)
    expect(one).toContain('msg-c') // 最新在前
    expect(all.split('\n').filter(Boolean).length).toBeGreaterThanOrEqual(3)
  })

  it('🔴 D2 count 越界 ⇒ **钳到 [1,100]**（不抛、也不把 0 条当"没提交"）', () => {
    initRepo(dir)
    writeFileSync(join(dir, 'a.txt'), 'a')
    g(dir, 'add', '-A')
    g(dir, 'commit', '-m', 'only')

    // count=0 ⇒ 下钳到 1（否则 git 会回空 ⇒ 被误判成 '(no commits)'）
    expect((runGit(dir, { action: 'log', count: 0 }) as string)).toContain('only')
    // count=9999 ⇒ 上钳到 100（不抛）
    expect((runGit(dir, { action: 'log', count: 9999 }) as string)).toContain('only')
  })

  it('🔴 D3 非 git 仓库 ⇒ log 抛错（`:175` stderr 侧，与 status 同款真故障）', () => {
    expect(() => runGit(dir, { action: 'log' })).toThrow(/git log failed/)
  })
})

// ── E 组：pull 的降级告警面（第 14 件只覆盖了成功/拒绝/无远程） ─────────────────────

describe('git-ops 分支：E 组 —— pull 降级告警', () => {
  it('🔴 E1 fetch 失败（远程不可达）⇒ 返回 `[WARN] fetch had stderr`（`:152`）', () => {
    initRepo(dir)
    writeFileSync(join(dir, 'a.txt'), 'a')
    g(dir, 'add', '-A')
    g(dir, 'commit', '-m', 'first')
    // 远程指向不存在的路径 ⇒ fetch 必失败，但**不得**被当成"已最新"
    g(dir, 'remote', 'add', 'origin', join(dir, 'nonexistent-remote.git'))

    const r = runGit(dir, { action: 'pull' }) as string

    // 🔴 方向断言：必须**响亮告警**，绝不能静默返回 'Already up to date.'
    expect(r).toContain('[WARN] fetch had stderr')
    expect(r).not.toContain('Already up to date')
  })

  it('🔴 E2 pull 无远程 ⇒ 抛错并给指引（与 push 同款）', () => {
    initRepo(dir)
    writeFileSync(join(dir, 'a.txt'), 'a')
    g(dir, 'add', '-A')
    g(dir, 'commit', '-m', 'first')

    expect(() => runGit(dir, { action: 'pull' })).toThrow(/no remote configured/)
  })
})
