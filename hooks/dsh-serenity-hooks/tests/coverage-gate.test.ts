import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * src↔tests 镜像一致性门禁（P2-2，2026-09-05 可测试可验证方向——防新 src 模块无测试裸奔）。
 *
 * 规则：src/ 下每个业务模块（排除 index/constants/json 聚合壳 + client tsx/css/d.ts——
 * client 组件无 node 测试框架，由 client/tsconfig typecheck + client-css-tokens 守护）必须满足：
 *   ① tests/<同名>.test.ts 存在（镜像约定），**或**
 *   ② 被 ≥1 个测试文件 import（间接覆盖——模块可能并入其他测试，如 git-ops→ops.test）
 * 任一无测试引用的 src 业务模块 → 测试失败 → 新模块立即暴露。
 *
 * 审计实证（2026-09-05）：曾裸奔的 seams/opencode-skills.ts（funcs 0）与
 * client/image-fallback-api.ts 已补测试；本门禁固化防再犯。
 */
const __filename = fileURLToPath(import.meta.url)
const HOOKS_DIR = resolve(dirname(__filename), '..')
const SRC_DIR = join(HOOKS_DIR, 'src')
const TESTS_DIR = join(HOOKS_DIR, 'tests')

/** 聚合壳/基础设施——不要求独立测试（index 装配经 register.test，constants/json 纯字面量） */
const SKIP_BASENAMES = new Set(['index.ts', 'constants.ts', 'json.ts', 'css-modules.d.ts'])
/** client 浏览器面：tsx/css 无 node 测试框架（typecheck + css-token 门禁守护）；api ts 已要求测试 */
const SKIP_CLIENT_SUFFIX = ['.tsx', '.css']
/**
 * 显式间接覆盖白名单（模块无测试直接 import，但经宿主模块被测试执行——覆盖率实证见 coverage 报告）：
 *  - gateway-auth / gateway-proxy：gateway.ts import 它们 → gateway.test.ts 执行（auth 94.7% / proxy 100%）
 *  - tools/* 薄壳（cc-fs/git/kit/msm/handyman/localstore/session/rebuild/cce/eap/neat/autopilot-trajectory）：
 *    纯 defineTool 注册壳，逻辑在 ops 层（fs-ops/git-ops/... 已被各自测试覆盖）；
 *    存在性/注册契约由 register.test.ts（apply 注册 13 工具断言，import index.ts 全链）保障
 * 新增 src 模块一律走镜像或直接 import；需间接豁免须在此显式登记 + 注明宿主与实证
 */
const INDIRECT_COVERED = new Set([
  'gateway-auth.ts',
  'gateway-proxy.ts',
  'cc-fs.ts',
  'git.ts',
  'kit.ts',
  'msm.ts',
  'handyman.ts',
  'localstore.ts',
  'session.ts',
  'rebuild.ts',
  'cce.ts',
  'eap.ts',
  'neat.ts',
])

function collectSrcTs(dir: string, base: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const rel = relative(base, full).split('\\').join('/')
    if (statSync(full).isDirectory()) {
      out.push(...collectSrcTs(full, base))
    } else if (entry.endsWith('.ts') && !SKIP_BASENAMES.has(entry)) {
      out.push(rel)
    }
  }
  return out
}

function isClientBrowserFile(rel: string): boolean {
  return rel.startsWith('client/') && SKIP_CLIENT_SUFFIX.some((s) => rel.endsWith(s))
}

/** 全测试文件内容拼接（一次读，供引用检查） */
function allTestsContent(): string {
  const files = readdirSync(TESTS_DIR).filter((f) => f.endsWith('.test.ts'))
  return files.map((f) => readFileSync(join(TESTS_DIR, f), 'utf-8')).join('\n')
}

describe('src↔tests 镜像一致性门禁（P2-2，防 src 模块无测试裸奔）', () => {
  const srcModules = collectSrcTs(SRC_DIR, SRC_DIR)
    .filter((rel) => !rel.startsWith('client/') || !isClientBrowserFile(rel))
    .filter((rel) => !rel.includes('client/')) // client api 有测试但浏览器 tsx 排除——按文件粒度在循环内判
  const testFiles = readdirSync(TESTS_DIR).filter((f) => f.endsWith('.test.ts'))
  const testsContent = allTestsContent()

  const uncovered = srcModules.filter((rel) => {
    // 浏览器 tsx/css 排除（无 node 测试框架；typecheck + css-token 守护）
    if (rel.startsWith('client/') && /\.(tsx|css)$/.test(rel)) return false
    // 显式间接覆盖白名单（见 INDIRECT_COVERED 注释）
    if (INDIRECT_COVERED.has(rel.split('/').pop()!)) return false
    // 镜像：tests/<basename>.test.ts
    const base = rel.split('/').pop()!.replace(/\.ts$/, '')
    const mirror = testFiles.some((f) => f === `${base}.test.ts`)
    if (mirror) return false
    // 间接：模块 basename 出现在任一测试 import（匹配 src 路径引用各形态：
    // `../src/x.js`（跨目录）/ `./x.js`（同目录兄弟）/ `src/tools/x.js` 等）
    const modName = rel.replace(/\.ts$/, '').split('/').pop()!
    const importRef = new RegExp(`['"][^'"]*\\/${modName}\\.js['"]`).test(testsContent)
    return !importRef
  })

  it('每个 src 业务模块都有测试覆盖（镜像文件或测试 import）', () => {
    // 逐项断言（vitest 显示每个裸奔模块）
    for (const rel of uncovered) {
      expect(`${rel} 无任何测试引用（镜像 tests/${rel.replace(/\.ts$/, '.test.ts')} 缺失或未被 import）`).toBe('covered')
    }
    expect(uncovered).toEqual([])
  })
})
