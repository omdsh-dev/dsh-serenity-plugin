/** 常量（纯模块，零 DSH 依赖） */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/** 本包名 —— 上溯定位包根时的**身份核对**（同名目录家的邻居不会误命中） */
const PACKAGE_NAME = '@shgroup/dsh-serenity-hooks'

/** 上溯层数上限（源码态最深 `src/<域>/<子域>/` ／ 发布态 `lib/` ⇒ 8 层足够，且**保证有界**） */
const MAX_ROOT_ASCENT = 8

/**
 * 包根 = 含**本包** `package.json` 的目录。
 *
 * 🔴 为什么不写 `join(here, '..')`：本模块自身的位置**随目录重构变化**
 * （曾 `src/`，现 `src/kernel/`），而发布态是从打包入口 `lib/index.js` 反推 ——
 * 两种布局的深度不同，写死层数**必然在其中一个布局下静默错位**。
 * 实测代价：`src/` → `src/kernel/` 之后，`join(here,'..')` 指到 `src/`（无 package.json）
 * ⇒ `ACC_VERSION` 落进 catch 分支变 `0.0.0`，**没有任何门禁报警**。
 *
 * ⇒ 判据改成**内容**（找带本包名的 package.json）而不是**层数**。
 *
 * @param start 起点目录（缺省 = 本模块所在目录；测试可注入）
 */
export function findPackageRoot(start?: string): string | null {
  let dir = start ?? dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < MAX_ROOT_ASCENT; i += 1) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as { name?: string }
      if (pkg.name === PACKAGE_NAME) return dir
    } catch {
      // 该层没有可读的 package.json ⇒ 继续上溯（这是正常路径，不是错误）
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/**
 * ACC 版本：自动从 package.json 读取（单一真相源，消除与 CHANGELOG 的漂移）。
 * 发布时只需改 package.json 的 version。
 */
export const ACC_VERSION: string = (() => {
  try {
    const root = findPackageRoot()
    if (root === null) return '0.0.0'
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()
