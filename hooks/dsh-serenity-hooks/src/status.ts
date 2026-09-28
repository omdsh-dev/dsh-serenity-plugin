/**
 * status.ts — 状态与安全模式操作（纯逻辑，零 DSH 依赖，可独立单测）
 *
 * WebUI 停靠栏的数据源：ACC 版本 / CCC 根 / safe-mode 状态 / 黑名单 / keeper 阈值 / handyman 模型。
 * setSafeMode 直接读写 .serenity-safe-on 标记（守卫实时读取，写即生效）。
 */

import { existsSync, writeFileSync, rmSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { homedir } from 'node:os'
import {
  isSafeModeOn,
  readBlacklist,
  loadSerenityConfig,
  readHandymanConfig,
  SAFE_MODE_MARKER,
  DEFAULT_SERENITY_CONFIG_PATHS,
} from './ccc.js'
import { cccRootForCwd } from './ccc-roots.js'
import { ACC_VERSION } from './constants.js'
import { getRestrictDiagnostics } from './seams/guards.js'
import { isoLocal } from './time.js'

/** 宿主包名 —— 从运行入口反推包根时的**身份核对**用（见 {@link dshVersionFromEntry}） */
const HOST_PACKAGE_NAME = '@deepseek-ai/dsh'

/** 上溯层数上限：入口脚本在包内的深度是 `lib/`（1 层）或 `lib/x/y/`（≤3 层）⇒ 6 层足够，且**保证有界** */
const MAX_ENTRY_ASCENT = 6

/**
 * 🔴 **布局无关档**：从**正在跑的那个入口脚本**反推宿主包根，读它的 `version`。
 *
 * 为什么必须补这一档（R↓：一处**静默失效**的实际缺陷；2026-09-28 docker bench 实测）：
 * 下面那条静态候选链（{@link readDshVersion} 的 ②）是**猜安装位置**——`npm_config_prefix` /
 * `APPDATA\npm` / `~/.npm-global`。一旦宿主装在**别处**（典型 = 容器镜像里的
 * `/usr/local/lib/node_modules/@deepseek-ai/dsh`），**三个候选全不中** ⇒ 返回 `null`
 * ⇒ `checkHostVersion(null)` 只给一条 **`required: false`** 的 issue ⇒ 报告 `ok` 仍为 `true`
 * ⇒ **版本门完全静默**（bench 逐字：`host contract degraded (1 optional): host version unknown`）。
 * ⚠️ 这类坏法**比"偶尔报警"更危险**：一条**永远为假**的判据看起来像"没报警 = 没问题"。
 *
 * 而"我们正跑在哪个宿主里"**本来就有直接证据**：`process.argv[1]`（= 启动本进程的那个脚本）。
 * 三条判据要点（每条都对应一个实测过的坑）：
 *  ① **先 `realpath`** —— 全局安装的 `dsh` 是**符号链接**（`/usr/local/bin/dsh` → `…/@deepseek-ai/dsh/lib/bin.js`），
 *     而 Node 的 `argv[1]` **保留调用路径、不解析符号链接** ⇒ 不 realpath 就永远上溯不到包根。
 *  ② **核对包名**（`name === '@deepseek-ai/dsh'`）—— 否则在 vitest / npx 等入口下会误取**别人的**
 *     `package.json`（这是本档**唯一**的假阳性来源）。
 *  ③ **上溯有界**（{@link MAX_ENTRY_ASCENT}）—— 不设界的话，一个不在任何 dsh 包内的入口会一路爬到文件系统根。
 *
 * @param entry `process.argv[1]`（单测直接注入，无需替身）
 */
export function dshVersionFromEntry(entry: string | undefined): string | null {
  if (typeof entry !== 'string' || entry === '') return null
  let dir: string
  try {
    const real = realpathSync(entry)
    dir = statSync(real).isDirectory() ? real : dirname(real)
  } catch {
    return null // 入口不存在（`node -e` 等）⇒ 本档不适用，交给静态候选链
  }
  for (let i = 0; i < MAX_ENTRY_ASCENT; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as { name?: unknown; version?: unknown }
      if (pkg.name === HOST_PACKAGE_NAME && typeof pkg.version === 'string') return pkg.version
    } catch {
      /* 这一层没有 package.json / 不是合法 JSON ⇒ 继续上溯 */
    }
    const parent = dirname(dir)
    if (parent === dir) break // 已到文件系统根
    dir = parent
  }
  return null
}

/**
 * 读取已安装 DSH CLI 版本；读不到返回 null。
 *
 * **两档，顺序有理由**：
 *  ① 🔴 **布局无关档**（{@link dshVersionFromEntry}）= **正在跑的就是它** —— 直接证据优先于"猜安装位置"。
 *  ② **静态候选链**（跨平台历史档，保留）：`npm_config_prefix` ／ `APPDATA\npm` ／ `~/.npm-global`
 *     （Windows npm 全局装在 `%APPDATA%\npm`，见审计问题 13）。
 *     ⚠️ 保留它是因为**本进程不一定是 dsh CLI**（单测、嵌入式、将来别的宿主进程）——
 *     那时"本机装了哪个版本"仍需一个答案，只是证据等级更低。
 */
export function readDshVersion(): string | null {
  const fromEntry = dshVersionFromEntry(process.argv[1])
  if (fromEntry !== null) return fromEntry
  const candidates: string[] = []
  if (process.env.npm_config_prefix) {
    candidates.push(join(process.env.npm_config_prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh'))
  }
  if (process.env.APPDATA) {
    candidates.push(join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh'))
  }
  candidates.push(join(homedir(), '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh'))
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(join(p, 'package.json'), 'utf-8')) as { version?: unknown }
      if (typeof pkg.version === 'string') return pkg.version
    } catch {
      /* 下一个候选 */
    }
  }
  return null
}

interface SerenityStatus {
  root: string | null
  accVersion: string
  dshVersion: string | null
  nodeVersion: string
  safeModeOn: boolean
  /** 黑名单条目（string 或 {pattern, message}，对齐 osp） */
  blacklist: { pattern: string; message?: string }[]
  threshold: number | null
  handymanModel: string | null
  restrict: {
    lastKey: string | null
    lastAttemptAt: string | null
    lastSuccess: boolean | null
    lastError: string | null
    activeKeys: string[]
  }
}

export function getStatus(cwd: string, configPaths: string[] = DEFAULT_SERENITY_CONFIG_PATHS): SerenityStatus {
  const root = cccRootForCwd(cwd)
  const restrict = getRestrictDiagnostics()
  const common = {
    accVersion: ACC_VERSION,
    dshVersion: readDshVersion(),
    nodeVersion: process.version,
  }
  if (!root) {
    return { root: null, ...common, safeModeOn: false, blacklist: [], threshold: null, handymanModel: null, restrict }
  }
  const cfg = loadSerenityConfig(root, configPaths)
  return {
    root,
    ...common,
    safeModeOn: isSafeModeOn(root),
    blacklist: readBlacklist(root, configPaths),
    threshold: cfg.sessionKeeper?.threshold ?? null,
    handymanModel: readHandymanConfig(root, configPaths)?.defaultModel ?? null,
    restrict,
  }
}

/** 切换安全模式（写/删标记文件）；返回实际生效状态 */
export function setSafeMode(root: string, on: boolean): { on: boolean } {
  const marker = resolve(root, SAFE_MODE_MARKER)
  if (on) {
    if (!existsSync(marker)) writeFileSync(marker, isoLocal() + '\n', 'utf-8')
  } else {
    rmSync(marker, { force: true })
  }
  return { on: isSafeModeOn(root) }
}
