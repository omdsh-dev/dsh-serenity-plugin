/**
 * ⑤ 第 14 件（语义深度：**远程流程 ＋ 失败注入**，2026-09-25）：`git-ops.ts` 当时 **79.68%**，
 * 且**没有任何 `fstat-no`** —— 缺口全在"已执行函数体内的分支"里。逐块读 `cstat-no` 后，未执行的
 * 恰好是**用户真正会走到的那些**：
 *   - `push`：**成功路径**从未执行过（既有测试只覆盖"被拒绝"）＋ 无远程 ＋ push 失败；
 *   - `pull`：**除"无远程报错"以外整段**（快进成功 ／ 已最新 ／ **分叉被拒**）；
 *   - `commit`：`git add` 失败 ／ `git commit` 失败两条**失败注入**分支；
 *   - `diff`：`--cached` ／ `<ref>` ／ `-- <path>` 三个旗标与**非空输出**；
 *   - `default`：未知 action。
 *
 * 🔴 判据（为什么不是"返回了个字符串就算"）：
 *   1. **远程流程要验"远端真的动了"** —— 断言 `git rev-parse` 的**对象 id 相等**，而不是只看返回文本；
 *      "Pushed to …" 这类文本在 v1.18.8 之前正是**误报**过（non-fast-forward 也回它）。
 *   2. **拒绝类要验"什么都没发生"** —— `pull` 分叉时的 `[REJECTED]` 必须配"本地 HEAD 未动 ＋
 *      远程独有文件没出现在工作树"（`--ff-only` 的机械保证就是**绝不自动合并**）。
 *   3. **失败路径用真触发，不用 mock** —— `git add` 失败 = **残留 `.git/index.lock`**（生产真实形态）；
 *      `git commit` 失败 = **`pre-commit` 钩子 exit 1**。两者都不需要替身，也不需要联网。
 *
 * 🔵 **2026-09-26 更新 —— 此前的"诚实边界"已闭合**：`git()` 的**超时**分支当时记为不可覆盖
 * （"要真触发就得让用例挂 30 秒以上"）。该理由**在旧设计下成立**；新设计给了超时覆盖缝
 * （`DSH_GIT_TIMEOUT_MS` / `DSH_GIT_NET_TIMEOUT_MS`，见 `src/git-ops.ts`）⇒ 现可在 **300ms** 内
 * 真触发。回归测试见 `tests/git-commit-push-coupling.test.ts` 的「B 回归」组。
 * ⚠️ 同批**更正旧判据**：超时**不设 `err.killed`**（实测 `code=ETIMEDOUT` / `signal=SIGTERM` /
 * `status=null` / stderr 长度 0）—— 旧守卫 `err.killed ? … : err.stderr` 因此是**死代码**，
 * 这正是"push 超时被报成成功"的一半成因（另一半：`execFileSync` 成功时丢弃 stderr）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runGit } from '../src/git-ops.js'

/** 在 `cwd` 跑一条真 git 命令（本文件一律不 mock；`stdio: 'pipe'` 防噪音进测试输出） */
function g(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
}

function initRepo(cwd: string, branch: string): void {
  g(cwd, 'init', '-q', '-b', branch)
  g(cwd, 'config', 'user.email', 't@t')
  g(cwd, 'config', 'user.name', 't')
}

function commitFile(cwd: string, name: string, content: string, msg: string): void {
  writeFileSync(join(cwd, name), content)
  g(cwd, 'add', '-A')
  g(cwd, 'commit', '-m', msg)
}

const headOf = (cwd: string): string => g(cwd, 'rev-parse', 'HEAD').trim()

interface World {
  dir: string
  remote: string
  /** 领先侧工作树（已 push -u origin main） */
  a: string
  /** 落后侧工作树（clone 自同一 bare 远程） */
  b: string
}

/** 造一个"bare 远程 ＋ 两个工作树"的真世界（全在临时目录内，零网络）。 */
function makeWorld(): World {
  const dir = mkdtempSync(join(tmpdir(), 'hooks-git-remote-'))
  const remote = join(dir, 'remote.git')
  g(dir, 'init', '-q', '--bare', remote)

  const a = join(dir, 'workA')
  mkdirSync(a)
  initRepo(a, 'main')
  commitFile(a, 'f.txt', 'a', 'a')
  g(a, 'remote', 'add', 'origin', remote)
  g(a, 'push', '-u', 'origin', 'main')

  const b = join(dir, 'workB')
  g(dir, 'clone', '-q', remote, b)
  g(b, 'config', 'user.email', 't@t')
  g(b, 'config', 'user.name', 't')
  // bare HEAD 未指向 main ⇒ clone 后是 detached，需显式检出分支
  g(b, 'checkout', '-b', 'main', 'origin/main')

  return { dir, remote, a, b }
}

const remoteHead = (w: World): string => g(w.remote, 'rev-parse', 'main').trim()

let world: World

beforeEach(() => {
  world = makeWorld()
})

afterEach(() => {
  rmSync(world.dir, { recursive: true, force: true })
})

describe('⑤ 第 14 件：container_git 远程流程（真 git ＋ 真 bare 远程）', () => {
  it('push 成功（本地领先）：返回成功语义，且**远程对象 id 真的前进到本地 HEAD**', () => {
    const localAhead = headOf(world.a)
    commitFile(world.a, 'f.txt', 'a2', 'a2')
    const newHead = headOf(world.a)
    expect(newHead).not.toBe(localAhead)

    const r = runGit(world.a, { action: 'push' }) as string
    expect(r).not.toContain('[REJECTED]')
    // 🔵 2026-09-26 改：成功判据换成 `--porcelain`（stdout）⇒ 回执带**可核验事实**（SHA 变迁）
    expect(r).toMatch(/✅ 已推送 origin\/main/)
    expect(r).toMatch(/[0-9a-f]{7}\.\.[0-9a-f]{7}/) // before..after 的 SHA 变迁
    // 🔴 语义断言：不看文本看**远程**（文本曾经在 non-fast-forward 时也报成功）
    expect(remoteHead(world)).toBe(newHead)
  })

  it('🔴 探测并钉住：本地已与远程同步时 push ⇒ 不被当成失败，且**与"真推送"可区分**', () => {
    // 此时 A 刚 push -u 过，本地与远程同点 ⇒ 这条 `git push` 是**合法的空操作**
    const before = remoteHead(world)
    const r = runGit(world.a, { action: 'push' }) as string
    expect(r).not.toContain('[REJECTED]')
    // 🔵 **2026-09-26 已修（此前的 wart）**：旧版这里返回 fallback `Pushed to origin/main` ——
    //    与"真的推了"**同一句话**（根因：`git()` 成功时丢弃 stderr，而 `git push` 的输出走 stderr）。
    //    本版改走 `--porcelain`（走 stdout）⇒ 「已最新」与「真推送」现在是**两句不同的话**。
    expect(r).toMatch(/已是最新/)
    expect(r).not.toMatch(/✅ 已推送/) // 空操作**不得**被说成"推了"
    expect(remoteHead(world)).toBe(before) // 空操作 ⇒ 远程不动
  })

  it('push 无远程 ⇒ 抛错并给出 `git remote add origin` 指引', () => {
    const bare = join(world.dir, 'no-remote')
    mkdirSync(bare)
    initRepo(bare, 'main')
    commitFile(bare, 'x.txt', 'x', 'x')
    expect(() => runGit(bare, { action: 'push' })).toThrow(/未配置 remote/)
    expect(() => runGit(bare, { action: 'push' })).toThrow(/git remote add origin/)
  })

  it('pull：落后 ⇒ 快进合并；**本地 HEAD == 远程 HEAD 且拿到远程的新文件内容**', () => {
    commitFile(world.a, 'f.txt', 'a2', 'a2')
    g(world.a, 'push', 'origin', 'main')
    const want = remoteHead(world)
    expect(headOf(world.b)).not.toBe(want)

    const r = runGit(world.b, { action: 'pull' }) as string
    expect(r).not.toContain('[REJECTED]')
    expect(r).not.toContain('[WARN]')
    expect(headOf(world.b)).toBe(want)
    expect(execFileSync('cat', [join(world.b, 'f.txt')], { encoding: 'utf8' })).toBe('a2')
  })

  it('pull：已是最新 ⇒ `Already up to date.`（且不产生副作用）', () => {
    const before = headOf(world.b)
    const r = runGit(world.b, { action: 'pull' }) as string
    expect(r).toBe('Already up to date.')
    expect(headOf(world.b)).toBe(before)
  })

  it('🔴 pull：分叉 ⇒ **绝不自动合并**（本地 HEAD 未动、远程独有文件没落地）—— 不变量与文案无关', () => {
    // A：提交并推远程（远程领先）
    commitFile(world.a, 'from-a.txt', 'a-side', 'a-side')
    g(world.a, 'push', 'origin', 'main')
    // B：本地也提交（分叉）
    commitFile(world.b, 'from-b.txt', 'b-side', 'b-side')
    const bBefore = headOf(world.b)

    // ⚠️ 当前实现下这条会 **throw**（根因见下一条用例的 `it.fails` 探针：判据靠解析 git 的**英文文案**）
    //    ⇒ 本用例只钉**与文案无关的安全不变量**：无论走 [REJECTED] 还是 throw，都**不许**发生合并。
    let threw: unknown
    let text = ''
    try {
      text = runGit(world.b, { action: 'pull' }) as string
    } catch (err) {
      threw = err
    }
    if (threw !== undefined) {
      expect(String((threw as Error).message)).toContain('container_git pull failed')
    } else {
      expect(text).toContain('[REJECTED]')
    }
    // 🔴 `--ff-only` 的机械保证：HEAD 不动 ＋ 远程独有的文件**不在**工作树里
    expect(headOf(world.b)).toBe(bBefore)
    expect(() => execFileSync('cat', [join(world.b, 'from-a.txt')], { stdio: 'pipe' })).toThrow()
    // B 自己的改动仍在（没被覆盖）
    expect(execFileSync('cat', [join(world.b, 'from-b.txt')], { encoding: 'utf8' })).toBe('b-side')
  })

  it.fails('🔴 待裁（已登记）：分叉 pull **应当**返回 `[REJECTED]` ＋ 操作建议，而不是 throw —— 当前判据只认英文文案', () => {
    commitFile(world.a, 'from-a.txt', 'a-side', 'a-side')
    g(world.a, 'push', 'origin', 'main')
    commitFile(world.b, 'from-b.txt', 'b-side', 'b-side')

    // 期望语义（osp 对齐）：非快进 ⇒ 可读的 [REJECTED] ＋ 5 步建议，**不是**原始 fatal 文本
    const r = runGit(world.b, { action: 'pull' }) as string
    expect(r).toContain('[REJECTED]')
    expect(r).toContain('non-fast-forward')
  })

  it('🔴 commit：`pre-commit` 钩子失败 ⇒ 抛 `git commit failed`（真触发，不用 mock）', () => {
    writeFileSync(join(world.b, 'newfile.txt'), 'x')
    const hook = join(world.b, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, '#!/bin/sh\necho "hook says no" >&2\nexit 1\n')
    chmodSync(hook, 0o755)

    expect(() => runGit(world.b, { action: 'commit', message: 'x' })).toThrow(/git commit failed/)
    // 钩子失败 ⇒ 没有产生提交（HEAD 未动）—— 这才是"失败"的实质
    expect(headOf(world.b)).toBe(headOf(world.b))
    expect(g(world.b, 'log', '--oneline').trim().split('\n')).toHaveLength(1)
  })

  it('🔴 commit：`git add` 失败（残留 `.git/index.lock`）⇒ 抛 `git add failed`（生产真实形态）', () => {
    // 先制造工作树差异（否则 hasChanges=false 会提前返回 "(nothing to commit …)"）
    writeFileSync(join(world.b, 'f.txt'), 'dirty')
    expect((runGit(world.b, { action: 'status' }) as { clean: boolean }).clean).toBe(false)
    // 残留锁文件 = 上一次 git 进程异常退出后的现场
    writeFileSync(join(world.b, '.git', 'index.lock'), '')

    expect(() => runGit(world.b, { action: 'commit', message: 'x' })).toThrow(/git add failed/)
  })

  it('diff：工作树差异 / `--cached` / `<ref>` / `-- <path>` 四态都走通且给真内容', () => {
    writeFileSync(join(world.b, 'f.txt'), 'changed-line')

    const unstaged = runGit(world.b, { action: 'diff' }) as string
    expect(unstaged).toContain('changed-line')
    expect(unstaged).toContain('a/f.txt')

    // 暂存后：工作树 diff 变空，`--cached` 才看得见
    g(world.b, 'add', '-A')
    expect(runGit(world.b, { action: 'diff' }) as string).toBe('(no diff)')
    const staged = runGit(world.b, { action: 'diff', staged: true }) as string
    expect(staged).toContain('changed-line')

    // 提交后再看：HEAD（ref）与限定路径两态
    g(world.b, 'commit', '-m', 'b-change')
    const vsHead = runGit(world.b, { action: 'diff', ref: 'HEAD' }) as string
    expect(vsHead).toBe('(no diff)') // 已提交 ⇒ 与 HEAD 无差异
    writeFileSync(join(world.b, 'f.txt'), 'again')
    const byPath = runGit(world.b, { action: 'diff', path: 'f.txt' }) as string
    expect(byPath).toContain('again')
  })

  it('🔴 push：远程配了但不可达（URL 指向不存在的路径）⇒ 抛 `[FAILED]`（fetch 失败不误判成功）', () => {
    // 真触发：把 origin 指向一个不存在的路径 ⇒ `git fetch` 与 `git push` 都失败。
    // 期望：fetch 的失败**不阻断**（它本就被忽略）⇒ 落到 push 自己的失败判据上，
    //       且**绝不**返回 "已推送"（这正是 v1.18.8 那类误报的同族风险）。
    g(world.b, 'remote', 'set-url', 'origin', join(world.dir, 'no-such-remote.git'))
    const call = () => runGit(world.b, { action: 'push' })
    expect(call).toThrow(/\[FAILED\]/)
    expect(call).toThrow(/未推送/)
    expect(call).toThrow(/git ls-remote origin main/) // 回执必须给**核验指令**
  })

  it('未知 action ⇒ 抛 `Unknown action`（默认分支不是静默）', () => {
    expect(() => runGit(world.b, { action: 'bogus' as never })).toThrow(/Unknown action: bogus/)
  })
})
