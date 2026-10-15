/**
 * eap.ts — EAP 内容源（**完整论文全文**，v1.30 三工具合并为 praxis 后只保留内容源）
 *
 * 🔴 本文件的形态由一条 owner 令决定（2026-10-15，S142 续 125）：
 *   原实现内嵌一份约 1.5 KB 的「简易说明」（三变量表 ＋ 自检清单），而 `praxis eap`
 *   的职责是**注入 EAP 论文全文**。owner 原话：「praxis · eap 放的不是 eap 完整论文全文
 *   而是简易说明，这是不行的，要求改成全文」。
 *
 * ⇒ 正文**不再内嵌**（58 KB 塞进 TS 模板字符串还要转义论文里 4 处 ```mermaid 围栏——
 *   本容器为此踩过四次），改为**随包的静态资产 ＋ 运行时读取**：
 *     资产 = `assets/eap-paper.md`（**逐字**来自上游论文，未经改写）
 *     读取 = `loadEapPaper()`（进程内缓存一次；同 `voyage-page.ts` 的既有先例）
 *
 * 🔴 **单一真相源**：正文只在 `assets/eap-paper.md` 一个地方。本文件负责**定位与读取**，
 *    `praxis.ts` 只负责**路由**。二者都不得内嵌任何论文片段——否则又是"第二份会漂的正文"。
 *
 * 上游：https://github.com/tellmewhattodo/theory-eap（MIT，许可证随包见
 * `assets/eap-paper-LICENSE.txt`；同 `assets/diagram/*.ttf` 的既有做法）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 资产相对包根的路径。
 * 🔒 它**必须**同时出现在两处，否则发布包会缺文件、`praxis eap` 在**运行态**才报错：
 *   ① `package.json` 的 `files` 白名单；
 *   ② `scripts/dsh-develop.ts` 的 `verifyTarball` / `deploy` 的 `required` 数组。
 * 同 v1.26.15 事故形态（`files` 白名单漏运行时必需文件）。
 */
export const EAP_PAPER_ASSET = 'assets/eap-paper.md'

/**
 * 包根 = **向上找到含 `package.json` 的那一级**。
 *
 * 🔴 为什么不写 `join(__dirname, '..')`：本模块在 `src/tools/` 里（发布态 `lib/tools/`），
 * 一次 `..` 只到 `src/`，于是会去找 `src/assets/eap-paper.md` —— **实测 ENOENT**，
 * 而症状（"论文不在"）与真因（路径层级算错）长得完全不同。
 * 按 `package.json` 上溯对**开发态（vitest 直跑 TS）与发布态（lib/）都成立**。
 * 与 `src/diagram/rasterize.ts` 的 `packageRootPath()` 同一形态（该处已由实测固化）。
 *
 * @returns 包根绝对路径；四层内找不到 `package.json` 时回落"上一级"（不抛——定位失败由调用方响亮报错）
 */
function packageRootPath(): string {
  const start = dirname(fileURLToPath(import.meta.url))
  let dir = start
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir
    dir = dirname(dir)
  }
  return join(start, '..')
}

/** 论文资产的绝对路径（导出以便测试与 pack-check 共用同一判据来源） */
export function eapPaperPath(): string {
  return join(packageRootPath(), EAP_PAPER_ASSET)
}

/** 缓存（58 KB；`praxis eap` 可能被反复调用——进程内只读一次） */
let cachedPaper: string | null = null

/**
 * 读取论文全文。**读不到即抛错** —— 绝不静默返回空串或退回一份"简易说明"：
 * 那种降级会把"资产缺失"伪装成"调用成功"，而本工具的全部价值就是那份正文。
 */
export function loadEapPaper(assetPath: string = eapPaperPath()): string {
  if (assetPath === eapPaperPath()) {
    if (cachedPaper === null) cachedPaper = readFileSync(assetPath, 'utf-8')
    return cachedPaper
  }
  return readFileSync(assetPath, 'utf-8')
}

/** 清缓存（测试用） */
export function resetEapCache(): void {
  cachedPaper = null
}
