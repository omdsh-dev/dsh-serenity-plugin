/**
 * constants.test.ts —— 包根定位 ＋ `ACC_VERSION` 的回归钉（S142 2026-10-19）
 *
 * ## 为什么必须有这一件（R↓：它钉的是一个**真实缺陷**）
 *
 * `src/kernel/constants.ts` 早先用的是 `join(dirname(import.meta.url), '..')` 找包根 ——
 * 即"包根 = 我上一级"。2026-10-19 的目录域化把该文件从 `src/` 搬进 `src/kernel/`，
 * **多了一层** ⇒ 该写法指到 `src/`（没有 package.json）⇒ 落进 catch ⇒ `ACC_VERSION` 悄悄变
 * **`'0.0.0'`**。而当时**全量测试 173 文件 / 2842 例全绿** —— 因为**没有任何一条断言钉过它**。
 *
 * 失败形态值得记住：它不是崩溃，而是"读出来的版本号是 0.0.0"这种**看起来像正常值**的东西，
 * 只有把它与唯一真相源（`package.json` 的 `version`）对读才抓得到。
 *
 * ⇒ 判据（三条，互相独立）：
 *   ① `ACC_VERSION` === `package.json` 的 `version`（**内容对读，不是形状检查**）；
 *   ② `findPackageRoot()` 从**深层起点**也能上溯到位（防"写死层数"的做法回来）；
 *   ③ 上溯**有界**：从文件系统根这类无命中起点出发，必须返回 `null` 而**不是**一路爬。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ACC_VERSION, findPackageRoot } from '../src/kernel/constants.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOOKS_DIR = join(HERE, '..')
const PKG_PATH = join(HOOKS_DIR, 'package.json')

describe('包根定位（findPackageRoot）：按内容核对，不按层数猜', () => {
  it('🔴 回归钉：ACC_VERSION 必须等于 package.json 的 version（曾静默变 0.0.0）', () => {
    const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8')) as { name: string; version: string }
    // 正控：先证明我们读的是**本包**的 package.json（否则这条断言会拿别人的版本号自证）
    expect(pkg.name).toBe('@shgroup/dsh-serenity-hooks')
    expect(ACC_VERSION).toBe(pkg.version)
  })

  it('从「深层起点」上溯也能命中（防"写死层数"的做法回来）', () => {
    // src/kernel 比 src/ 深一层 —— 正是 2026-10-19 出事的那个深度
    expect(findPackageRoot(join(HOOKS_DIR, 'src', 'kernel'))).toBe(HOOKS_DIR)
    // 再深两层的构造点也必须命中同一处
    expect(findPackageRoot(join(HOOKS_DIR, 'src', 'surface', 'voyage'))).toBe(HOOKS_DIR)
  })

  it('上溯**有界**：从无命中的起点出发返回 null，不一路爬到文件系统根', () => {
    expect(findPackageRoot(dirname(HOOKS_DIR))).toBeNull()
  })
})
