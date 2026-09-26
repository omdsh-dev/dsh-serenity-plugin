/**
 * 2026-09-26（owner 追加令 D92 ／ tiangong-serenity 报障）：`container_git` 的「提交—推送耦合」
 * ＋ **push 假成功** 的回归测试。
 *
 * 背景（两条独立缺陷，本文件逐条钉住）：
 *   A. `commit` 与 `push` 分离 ⇒ 提交常常只在本地（实测窗口 6h11m）。
 *   B. 🔴 **push 会把"超时被杀"报成成功** —— 根因（**实测**，非推断）：
 *      `spawnSync` 超时**不设 `err.killed`**（真值 `code=ETIMEDOUT` / `signal=SIGTERM` /
 *      `status=null` / stderr 长度 0），而 `execFileSync` **成功时丢弃 stderr**；
 *      于是"被杀"与"真成功"都交出 `{stdout:'', stderr:''}` ⇒ 旧判据 `if (!stderr) → 成功` 判错。
 *
 * 🔴 判据纪律（本文件的写法）：
 *   1. **成功/失败一律不看回执文本本身** —— 看**远程 ref**（`git rev-parse` 的对象 id）或
 *      `status --porcelain` 的**工作树事实**。文本只作辅助断言。
 *   2. **每条断言配正控** —— "paths 生效"必须配"不传 paths 时确实会吸走"（否则判据可能是瞎的）。
 *   3. **超时路径用真超时驱动**（不 mock `git()`）：靠 `DSH_GIT_NET_TIMEOUT_MS` 把网络超时压到
 *      300ms ＋ PATH 前置一个"push 会挂住"的假 git ⇒ **真**走 spawnSync 超时分支。
 *
 * ⚠️ **诚实边界（本组不覆盖的分支，逐族登记；不是遗漏）** —— 改写后 `git-ops.ts` 分支覆盖
 *  **77.77%（119/153）**，未覆盖者归四族：
 *   ① **跨平台防御的短路侧**：超时判据 `killed === true || code==='ETIMEDOUT' || (signal!=null && status==null)`
 *      在本机形态下**第一项恒假、第二项恒真**（实测）⇒ 后两项**永不作为决定项被求值**。
 *      保留它们是**跨平台保险**（别的 Node/平台可能只给 `signal`）——**不为它们造夹具**。
 *   ② **`?? ''` / `|| '(无输出)'` 的兜底右侧**：**支配性守卫** —— 实测 `spawnSync` 失败时
 *      `stdout`/`stderr` **恒为 string**（探针 B 实测），失败时 `stderr` 恒非空。
 *   ③ **`status` 首两列 `.trim() || '??'`**：同上，`--porcelain` 的首两列**恒非空**。
 *   ④ **防御性 catch**（status 的 ahead/behind 取值、pull 的 merge 文案三元）：未构造出触发形态。
 *   🔵 **口径**：本组只对**新增的实质行为**负责（超时不成、无正面证据不成、paths 隔离、
 *      自动推送、ahead 可见）——这五条**全部有断言**；上列四族**不硬造用例**（造了就是涂绿）。
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runGit } from '../src/git-ops.js'

function g(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
}

function initRepo(cwd: string, branch: string): void {
  g(cwd, 'init', '-q', '-b', branch)
  g(cwd, 'config', 'user.email', 't@t')
  g(cwd, 'config', 'user.name', 't')
}

const headOf = (cwd: string): string => g(cwd, 'rev-parse', 'HEAD').trim()
const committedPaths = (cwd: string): string[] =>
  g(cwd, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').filter(Boolean)

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

/** 造「bare 远程 ＋ 一个已 push -u 的工作树」 */
function makeRemoteWorld(): { dir: string; remote: string; a: string } {
  const dir = tmp('hooks-git-coupling-')
  const remote = join(dir, 'remote.git')
  g(dir, 'init', '-q', '--bare', remote)
  const a = join(dir, 'a')
  mkdirSync(a)
  initRepo(a, 'main')
  writeFileSync(join(a, 'a.txt'), 'a1')
  g(a, 'add', '-A')
  g(a, 'commit', '-m', 'init')
  g(a, 'remote', 'add', 'origin', remote)
  g(a, 'push', '-q', '-u', 'origin', 'main')
  return { dir, remote, a }
}
const remoteHead = (remote: string): string => g(remote, 'rev-parse', 'main').trim()

// ─────────────────────────────────────────────────────────────────────────────
describe('P1 — commit 支持显式 paths（修"绕过链"：工具可信才有人用）', () => {
  it('传 paths ⇒ 只提交这些路径；**他轨迹的在途文件仍留在工作树**', () => {
    const d = tmp('hooks-git-p1-')
    initRepo(d, 'main')
    writeFileSync(join(d, 'mine.md'), 'm')
    writeFileSync(join(d, 'other-trajectory.md'), 'o') // 模拟"别的轨迹的在途文件"

    const r = runGit(d, { action: 'commit', message: 'only mine', paths: ['mine.md'], noPush: true }) as string

    expect(r).not.toContain('整仓')
    expect(committedPaths(d)).toEqual(['mine.md'])
    // 🔴 核心：他轨迹的文件**没有被吸走**
    expect(g(d, 'status', '--porcelain')).toContain('other-trajectory.md')
  })

  it('🔴 正控：不传 paths ⇒ 整仓 `add -A`（他轨迹文件**确实会被吸走**）＋ 回执显式告知', () => {
    const d = tmp('hooks-git-p1ctl-')
    initRepo(d, 'main')
    writeFileSync(join(d, 'mine.md'), 'm')
    writeFileSync(join(d, 'other-trajectory.md'), 'o')

    const r = runGit(d, { action: 'commit', message: 'all', noPush: true }) as string

    expect(r).toContain('整仓') // 回执必须**显式告知**，不再让 agent 靠记忆判断
    // 正控成立 = 不给 paths 时确实两个都被吸走（证明上一条断言真在判 paths）
    expect(committedPaths(d).sort()).toEqual(['mine.md', 'other-trajectory.md'])
    expect(g(d, 'status', '--porcelain')).not.toContain('other-trajectory.md')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('P2 — commit 默认随后 push（提交与持久化不再分家）', () => {
  it('默认：commit 后**远程 ref 真的前进**，且回执带可核验事实（SHA 变迁）', () => {
    const w = makeRemoteWorld()
    writeFileSync(join(w.a, 'a.txt'), 'a2')

    const r = runGit(w.a, { action: 'commit', message: 'x', paths: ['a.txt'] }) as string

    expect(r).toMatch(/✅ 已推送 origin\/main/)
    expect(r).toMatch(/[0-9a-f]{7}\.\.[0-9a-f]{7}/) // before..after 的 SHA 变迁
    // 🔴 语义断言：不看文本，看**远程对象 id**
    expect(remoteHead(w.remote)).toBe(headOf(w.a))
  })

  it('noPush ⇒ 只本地提交；回执**明说未推送**，且远程**不动**', () => {
    const w = makeRemoteWorld()
    const before = remoteHead(w.remote)
    writeFileSync(join(w.a, 'a.txt'), 'a3')

    const r = runGit(w.a, { action: 'commit', message: 'x', paths: ['a.txt'], noPush: true }) as string

    expect(r).toContain('尚未推送')
    expect(r).not.toMatch(/✅ 已推送/)
    expect(remoteHead(w.remote)).toBe(before) // 远程不动
    expect(headOf(w.a)).not.toBe(before) // 但本地确实提交了
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('P3 — status 报「本地领先未推送」笔数（残余可见面）', () => {
  it('本地领先 1 笔 ⇒ status.ahead = 1，且 summary 里明写"未推送"', () => {
    const w = makeRemoteWorld()
    writeFileSync(join(w.a, 'a.txt'), 'a4')
    runGit(w.a, { action: 'commit', message: 'x', paths: ['a.txt'], noPush: true })

    const st = runGit(w.a, { action: 'status' }) as Record<string, unknown>

    expect(st.ahead).toBe(1)
    expect(st.behind).toBe(0)
    expect(String(st.summary)).toContain('未推送')
  })

  it('推送后 ahead 归零（正控：ahead 不是恒 1 的摆设）', () => {
    const w = makeRemoteWorld()
    writeFileSync(join(w.a, 'a.txt'), 'a5')
    runGit(w.a, { action: 'commit', message: 'x', paths: ['a.txt'] }) // 默认会推

    const st = runGit(w.a, { action: 'status' }) as Record<string, unknown>

    expect(st.ahead).toBe(0)
    expect(String(st.summary)).not.toContain('未推送')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('🔴 B 回归（tiangong-serenity 报障）— push 超时被杀 ⇒ **绝不报成功**', () => {
  it('真超时（PATH 假 git 让 push 挂住）⇒ [TIMEOUT] ＋ 未确认 ＋ 核验指令，**且不含成功字样**', () => {
    const shimDir = tmp('fake-git-')
    const shim = join(shimDir, 'git')
    // 只让 push 挂住；remote/rev-parse 回最小可用输出，其余直接成功
    writeFileSync(
      shim,
      '#!/bin/sh\ncase "$1" in\n  remote) echo origin ;;\n  rev-parse) echo main ;;\n  push) sleep 30 ;;\n  *) exit 0 ;;\nesac\n',
    )
    chmodSync(shim, 0o755)

    const oldPath = process.env.PATH
    const oldNet = process.env.DSH_GIT_NET_TIMEOUT_MS
    const cwd = tmp('hooks-git-timeout-')
    try {
      process.env.PATH = `${shimDir}:${oldPath ?? ''}`
      process.env.DSH_GIT_NET_TIMEOUT_MS = '300' // 把网络超时压到 300ms（否则要真等 180s）

      let msg = ''
      try {
        msg = runGit(cwd, { action: 'push' }) as string
      } catch (e: unknown) {
        msg = String((e as Error).message) // push 是硬失败 ⇒ 抛错，取 message
      }

      // 🔴 核心断言：**不得报成功**（这正是报障里的"3/3 次回成功而远程未变"）
      expect(msg).not.toContain('✅ 已推送')
      expect(msg).not.toContain('Pushed to origin')
      expect(msg).toContain('[TIMEOUT]')
      expect(msg).toContain('未确认')
      expect(msg).toContain('git ls-remote') // 必须给**可核验**的下一步
    } finally {
      process.env.PATH = oldPath
      if (oldNet === undefined) delete process.env.DSH_GIT_NET_TIMEOUT_MS
      else process.env.DSH_GIT_NET_TIMEOUT_MS = oldNet
    }
  })

  it('回归对照：**退出码 0 但没有 porcelain ref 行** ⇒ [UNVERIFIED]，不视为成功', () => {
    // 与上一条同族：**没有正面证据就不得声称成功**。
    // 这里让假 git 对 push **成功退出但不输出任何 ref 行** —— 旧实现在这种情况下会回
    // `Pushed to origin/<branch>`（fallback），新实现必须拒绝声称成功。
    const shimDir = tmp('fake-git2-')
    const shim = join(shimDir, 'git')
    writeFileSync(
      shim,
      '#!/bin/sh\ncase "$1" in\n  remote) echo origin ;;\n  rev-parse) echo main ;;\n  *) exit 0 ;;\nesac\n',
    )
    chmodSync(shim, 0o755)

    const oldPath = process.env.PATH
    const cwd = tmp('hooks-git-unverified-')
    try {
      process.env.PATH = `${shimDir}:${oldPath ?? ''}`

      let msg = ''
      try {
        msg = runGit(cwd, { action: 'push' }) as string
      } catch (e: unknown) {
        msg = String((e as Error).message)
      }

      expect(msg).not.toContain('✅ 已推送')
      expect(msg).not.toContain('Pushed to origin')
      expect(msg).toContain('[UNVERIFIED]')
      expect(msg).toContain('git ls-remote')
    } finally {
      process.env.PATH = oldPath
    }
  })

  it('同族守卫：**本地动作**超时（status）⇒ 抛错，不静默当成"干净工作树"', () => {
    // 与 push 的假成功同族：任何"被杀"都不得被当成正常结果。
    // 旧实现里 `if (r.stderr) throw` 对超时同样失明（stderr 为空）⇒ status 会返回 clean:true。
    const shimDir = tmp('fake-git3-')
    const shim = join(shimDir, 'git')
    writeFileSync(shim, '#!/bin/sh\ncase "$1" in\n  -c) sleep 30 ;;\n  remote) echo origin ;;\n  rev-parse) echo main ;;\n  *) exit 0 ;;\nesac\n')
    chmodSync(shim, 0o755)

    const oldPath = process.env.PATH
    const oldLocal = process.env.DSH_GIT_TIMEOUT_MS
    const cwd = tmp('hooks-git-statustimeout-')
    try {
      process.env.PATH = `${shimDir}:${oldPath ?? ''}`
      process.env.DSH_GIT_TIMEOUT_MS = '300'
      expect(() => runGit(cwd, { action: 'status' })).toThrow(/status timed out/)
    } finally {
      process.env.PATH = oldPath
      if (oldLocal === undefined) delete process.env.DSH_GIT_TIMEOUT_MS
      else process.env.DSH_GIT_TIMEOUT_MS = oldLocal
    }
  })
})
