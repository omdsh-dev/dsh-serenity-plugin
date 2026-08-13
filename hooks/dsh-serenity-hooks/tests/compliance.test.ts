import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * compliance.test.ts — DSH plugin 开发标准合规门禁（docs/plugin-development-standard.md）
 *
 * 机械验证 B/E/F 关键项：
 *   B1  package.json 声明 dsh.bundle.patch
 *   B2  插件自带 cordis.patch.yml 存在且含 insert 行
 *   B3  patch 行 name 用包名
 *   E4  prepare script 存在
 *   F1  files 含 lib/ + cordis.patch.yml
 *   F2  peerDependencies 含 cordis + @deepseek-ai/dsh-tools
 *   F4  tsdown.prepare.config.ts 存在
 */
const __filename = fileURLToPath(import.meta.url)
// tests/ 位于 hooks/dsh-serenity-hooks/tests/，上一级即插件根
const HOOKS_DIR = resolve(dirname(__filename), '..')

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>
}

describe('DSH plugin 合规门禁（v1.15）', () => {
  const pkgPath = join(HOOKS_DIR, 'package.json')
  const pkg = readJson(pkgPath)

  it('B1: package.json 声明 dsh.bundle.patch', () => {
    const dsh = pkg.dsh as { bundle?: { patch?: string } } | undefined
    expect(dsh?.bundle?.patch).toBe('./cordis.patch.yml')
  })

  it('B2: 插件自带 cordis.patch.yml 存在且含 insert 行', () => {
    const patchPath = join(HOOKS_DIR, 'cordis.patch.yml')
    expect(existsSync(patchPath)).toBe(true)
    const content = readFileSync(patchPath, 'utf-8')
    expect(content).toContain('- insert:')
    expect(content).toContain('id: serenity-hooks')
  })

  it('B3: patch 行 name 用包名', () => {
    const content = readFileSync(join(HOOKS_DIR, 'cordis.patch.yml'), 'utf-8')
    expect(content).toContain(`name: '${pkg.name}'`)
  })

  it('E4: prepare script 存在且指向 prepare 配置', () => {
    const scripts = pkg.scripts as Record<string, string>
    expect(scripts.prepare).toContain('tsdown.prepare.config.ts')
    expect(existsSync(join(HOOKS_DIR, 'tsdown.prepare.config.ts'))).toBe(true)
    expect(existsSync(join(HOOKS_DIR, 'tsconfig.prepare.json'))).toBe(true)
  })

  it('F1: files 含 lib/ 与 cordis.patch.yml', () => {
    const files = pkg.files as string[]
    expect(files.some((f) => f.startsWith('lib'))).toBe(true)
    expect(files).toContain('cordis.patch.yml')
  })

  it('F2: peerDependencies 含 cordis 与 @deepseek-ai/dsh-tools', () => {
    const peers = pkg.peerDependencies as Record<string, string>
    expect(peers.cordis).toBeTruthy()
    expect(peers['@deepseek-ai/dsh-tools']).toBeTruthy()
  })

  it('F3: scripts 含 build/test/typecheck/prepare', () => {
    const scripts = pkg.scripts as Record<string, string>
    for (const s of ['build', 'test', 'typecheck', 'prepare']) {
      expect(scripts[s]).toBeTruthy()
    }
  })

  it('E4 端到端: prepare 消费端构建可独立产出 lib/index.js（staging tsdown；缺 staging 自跳过）', () => {
    const staging = resolve(process.env.HOME ?? '', '.dsh', 'source', 'current')
    const tsdownBin = join(staging, 'node_modules', '.bin', 'tsdown')
    if (!existsSync(tsdownBin)) return // 无 staging checkout（如 CI）→ 自跳过，对齐 G1
    const libDir = join(HOOKS_DIR, 'lib')
    rmSync(libDir, { recursive: true, force: true })
    execFileSync(tsdownBin, ['-c', 'tsdown.prepare.config.ts'], { cwd: HOOKS_DIR, encoding: 'utf-8' })
    expect(existsSync(join(libDir, 'index.js'))).toBe(true)
    expect(existsSync(join(libDir, 'invariant.js'))).toBe(true)
  })
})
