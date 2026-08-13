/** 常量（纯模块，零 DSH 依赖） */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/** 插件 ID */
export const PLUGIN_ID = 'dsh-serenity-hooks'

/**
 * ACC 版本：自动从 package.json 读取（单一真相源，消除与 CHANGELOG 的漂移）。
 * 发布时只需改 package.json 的 version。
 */
export const ACC_VERSION: string = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf-8')) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()
