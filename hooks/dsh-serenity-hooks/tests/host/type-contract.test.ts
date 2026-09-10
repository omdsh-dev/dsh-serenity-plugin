/**
 * type-contract.test.ts — 宿主类型契约模块的镜像门禁测试（P2-2）
 *
 * 说明（R↓）：`src/host/type-contract.ts`（node 半）与 `src/client/host-type-contract.ts`
 * （client 半）是**纯类型模块**（`Expect<Extends<宿主真相, dsp 假设>>` 编译期反证，零运行时语句，
 * tsc 产物只有 `export {}`）——它们没有"运行时可测行为"，真正的断言发生在
 * `dsh-develop typecheck` / `typecheck-host <ver>` 的编译期。
 *
 * 因此本测试不重复编译期语义，只锁两条**机制前提**（都满足镜像门禁的"被 import"形态）：
 *  ① 两文件必须位于 `src/` 下（= 在 typecheck 的 `include` 覆盖内）——若有人把它们挪到
 *     `tests/`（那里不参与 tsc），编译期守护会**静默失效**，而本测试会红；
 *  ② 模块可装载（type-only 模块在运行时是空导出，import 不抛错）。
 */
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// 类型契约模块（type-only；import 只为满足镜像门禁 + 证明可装载）
import '../../src/host/type-contract.js'

describe('host/client 类型契约（type-only，编译期反证）', () => {
  const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../src')

  it('两文件留在 src/（typecheck include 覆盖）——移出即失去编译期守护', () => {
    for (const rel of ['host/type-contract.ts', 'client/host-type-contract.ts']) {
      expect(existsSync(resolve(srcRoot, rel))).toBe(true)
    }
  })

  it('模块可装载（无运行时语句；真正的断言由 typecheck 执行）', () => {
    // 若本模块在生产被意外加入运行时依赖，typecheck 的构建面会先红；
    // 这里只证明 import 不抛错（空导出模块）。
    expect(true).toBe(true)
  })
})