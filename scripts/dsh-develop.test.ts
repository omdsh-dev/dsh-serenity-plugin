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
