/**
 * dsh-develop.test.ts — DC-M1 配对测试
 *
 * 验证核心纯逻辑：版本读取（currentVersion）、版本一致性判断、bump 版本号校验。
 * 子命令执行链路（typecheck/test/build）由 acc_msm exec 冒烟覆盖（本项目惯例）。
 */

import { test, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(SCRIPTS_DIR, '..')

function runDshDevelop(...args: string[]): { status: number; stdout: string } {
  try {
    const stdout = execFileSync('bun', [join(SCRIPTS_DIR, 'dsh-develop.ts'), ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      env: { ...process.env, DSH_HOME: process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh') },
      timeout: 120_000,
    })
    return { status: 0, stdout }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? 2, stdout: (err.stdout ?? '') + (err.stderr ?? '') }
  }
}

let hasBun = true
beforeAll(() => {
  try {
    execFileSync('bun', ['--version'], { stdio: 'pipe' })
  } catch {
    hasBun = false
  }
})

test('version 输出三处版本且一致', () => {
  if (!hasBun) return
  const r = runDshDevelop('version')
  expect(r.status).toBe(0)
  expect(r.stdout).toContain('package.json')
  expect(r.stdout).toContain('dsh.plugin.json')
  expect(r.stdout).toContain('CHANGELOG.md')
  expect(r.stdout).toContain('✓ 版本一致')
})

test('bump 拒绝非法版本号', () => {
  if (!hasBun) return
  const r = runDshDevelop('bump', 'not-a-version')
  expect(r.status).not.toBe(0)
  expect(r.stdout).toContain('bump 需要版本号')
})

test('list 输出子命令清单', () => {
  if (!hasBun) return
  const r = runDshDevelop('list')
  expect(r.status).toBe(0)
  for (const cmd of ['typecheck', 'test', 'build', 'status', 'commit', 'push', 'version', 'bump', 'deploy']) {
    expect(r.stdout).toContain(cmd)
  }
})

test('未知子命令报错（退出码 1）', () => {
  if (!hasBun) return
  const r = runDshDevelop('no-such-cmd')
  expect(r.status).toBe(1)
  expect(r.stdout).toContain('未知子命令')
})

/**
 * 🔴 退役命令的行为 pin（S142 2026-09-24）：`diag` 的对象（autopilot 唤起条件链）随 v1.35.0
 * 整段退场后已不存在 ⇒ 它**只印路牌且恒 exit 2**。**exit 2 是验收的一部分**：
 * 退出 0 会让调用方以为"诊断跑通了"（静默的假成功，比报错更坏）。
 */
test('diag 已退役：印路牌且恒 exit 2（不许变 0）', () => {
  if (!hasBun) return
  const r = runDshDevelop('diag')
  expect(r.status).toBe(2)
  expect(r.stdout).toContain('已退役')
  expect(r.stdout).toContain('acc-diag')          // 替代品写进了路牌
  expect(r.stdout).not.toContain('Cannot find module') // 不再是"看着像环境缺模块"的症状
})

/**
 * 🔴 `deploy` 的复制集合必须是**发布物清单本身**（S142 2026-09-24 取证后的修法）。
 * 判据 = 白名单驱动：发布物有的**必须有**，发布物没有的**一个都不许有**。
 * 反例清单取自那次**实测**的缺陷读数（当时副本多出 11 类、并反向缺 dsh.plugin.json）。
 */
test('deploy --list-copy-set：复制集合 = 发布物白名单（无黑名单漏项）', () => {
  if (!hasBun) return
  const r = runDshDevelop('deploy', '--list-copy-set')
  expect(r.status).toBe(0)
  // 必须有的（双 bundle + 声明面 + 清单本体）
  for (const f of ['lib/index.js', 'lib/client.js', 'lib/invariant.js',
    'assets/serenity-voyage.html', 'cordis.patch.yml', 'dsh.plugin.json', 'package.json']) {
    expect(r.stdout).toContain(f)
  }
  // 🔴 一个都不许有的（本缺陷的形态：黑名单只能枚举"想不到的"，所以它总会漏）
  for (const f of ['coverage/', 'experiments/', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
    'tsdown.config.ts', 'vitest.config.ts', 'tsconfig.prepare.json', 'tsconfig.host-']) {
    expect(r.stdout).not.toContain(f)
  }
})
