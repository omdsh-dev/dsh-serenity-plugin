/**
 * msm-scan-entry-criterion.test.ts — DC-M3 正向扫描的**入口判据**钉测试（S142，2026-09-17）
 *
 * 背景（跨轨迹信号 S151 轮 112 → S142 §0q）：
 *   M3 的正向基准是"扫描 skills/&#42;/scripts/ 下**未注册的脚本**"。2026-09 发现它隐含一个
 *   **错误假设**：**"scripts/ 下的 .ts 文件 = MSM 候选"**。实际上那里也有**库模块**
 *   （`dev-kit/` 5 个 + `home-desk/scripts/lib/` 3 个，共 8 个实测候选）。
 *
 *   两条**已被证伪**的判据（勿再采用）：
 *     ① ~~"有同名 `.test.ts` ⇒ 真入口"~~ —— 库**同样**有测试（`dev-kit.test.ts` 自述"共享库单测"）。
 *     ② ~~"含 `process.argv` ⇒ 入口"~~ —— 反例 `home-desk/scripts/lib/desk-dispatch.ts`：
 *        5 处 `process.argv`，但无 shebang / 无 `main()`，且被 desk-window/desk-vision import ⇒ **是库**。
 *
 * 采用判据（二值、机械可测）：**入口 ⟺ 有 shebang（`^#!`） ∨ 声明了 `function main(`**。
 *
 * 本测试把该判据**连反例一起固化**：任何人把判据改宽（例如把 `process.argv` 加回来）或
 * 把扫描改成递归，都会在这里立刻红。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { checkRegistryQuality } from '../src/msm-ops.js'

let root: string

/** 在 <root>/.opencode/skills/<skill>/scripts/ 下写一个文件 */
function writeScript(skill: string, rel: string, content: string): void {
  const dir = join(root, '.opencode', 'skills', skill, 'scripts', rel.split('/').slice(0, -1).join('/') || '.')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, rel.split('/').pop() as string), content, 'utf-8')
}

/** 取 M3 上报的 name 集合（正斜杠结尾无关，取 basename 便于断言） */
function m3Names(): string[] {
  return checkRegistryQuality(root)
    .issues.filter((i) => i.check === 'M3')
    .map((i) => i.name.split('/').pop() as string)
    .sort()
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsp-m3-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('DC-M3 正向扫描：入口判据（库不得被误报为"未注册 MSM"）', () => {
  it('入口（有 main()）⇒ 上报为未注册', () => {
    writeScript('s1', 'entry-main.ts', 'export function main(): void {}\n')
    expect(m3Names()).toEqual(['entry-main.ts'])
  })

  it('入口（有 shebang）⇒ 上报为未注册', () => {
    writeScript('s1', 'entry-shebang.ts', '#!/usr/bin/env node\nconsole.log(1)\n')
    expect(m3Names()).toEqual(['entry-shebang.ts'])
  })

  it('async function main() 同样算入口', () => {
    writeScript('s1', 'entry-async.ts', 'export async function main(): Promise<void> {}\n')
    expect(m3Names()).toEqual(['entry-async.ts'])
  })

  it('🔴 反例固化：**只有 process.argv、没有 main()/shebang ⇒ 不算入口**（desk-dispatch 型）', () => {
    writeScript(
      's1',
      'argv-only.ts',
      'export function dispatch(): string[] {\n  return process.argv.slice(2)\n}\n',
    )
    // argv 出现 5 次也不改变结论——判据看的是"有没有 CLI 入口"，不是"有没有读 argv"
    writeScript('s2', 'lib-module.ts', 'export const A = 1\nexport const B = 2\n')
    expect(m3Names()).toEqual([])
  })

  it('库模块（无 shebang / 无 main）⇒ 不上报，即使它有测试', () => {
    writeScript('s1', 'shared-lib.ts', 'export function helper(): number { return 1 }\n')
    writeScript('s1', 'shared-lib.test.ts', "import { helper } from './shared-lib'\nhelper()\n")
    expect(m3Names()).toEqual([])
  })

  it('测试文件（.test. / .spec.）不是 MSM 候选', () => {
    writeScript('s1', 'thing.test.ts', 'export function main(): void {}\n')
    writeScript('s1', 'thing.spec.ts', '#!x\n')
    expect(m3Names()).toEqual([])
  })

  it('🔴 目录**显式**排除：一个名为 `foo.ts/` 的目录不得被当成脚本', () => {
    mkdirSync(join(root, '.opencode', 'skills', 's1', 'scripts', 'foo.ts'), { recursive: true })
    expect(m3Names()).toEqual([])
  })

  it('🔴 嵌套文件不被扫（钉住"当前非递归"这一刻意语义）', () => {
    // 注意：这里写的是**真入口**（有 main）——它仍**不该**被报，
    // 因为当前语义是"只扫 scripts/ 一层"。若将来有人改成递归，本断例会红，
    // 而 scanSkillScripts 的注释正好写着"改递归前先读判据/护栏"。
    writeScript('s1', 'nested/inner-entry.ts', 'export function main(): void {}\n')
    writeScript('s1', 'lib/inner-lib.ts', 'export const X = 1\n')
    expect(m3Names()).toEqual([])
  })

  it('混合场景：只报真入口，库/测试/目录/嵌套全部安静', () => {
    writeScript('s1', 'a-entry.ts', 'export function main(): void {}\n')
    writeScript('s1', 'b-lib.ts', 'export const B = 1\n')
    writeScript('s1', 'c-entry.test.ts', 'export function main(): void {}\n')
    writeScript('s1', 'lib/d.ts', 'export function main(): void {}\n')
    mkdirSync(join(root, '.opencode', 'skills', 's1', 'scripts', 'e.ts'), { recursive: true })
    writeScript('s2', 'f-entry.ts', '#!/usr/bin/env bun\n')
    expect(m3Names()).toEqual(['a-entry.ts', 'f-entry.ts'])
  })
})
