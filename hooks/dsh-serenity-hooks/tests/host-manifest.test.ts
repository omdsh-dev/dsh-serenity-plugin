/**
 * host-manifest.test.ts — **宿主消费面**的机械闸门（v1.31.9，S142 全量 review 域 C 收口）
 *
 * ## 为什么存在（R↓）
 *
 * 域 C（manifest / app-boot 读取端）长期标为"CCC 外不可取证"——本仓 1.31.9 把宿主**应用本体**
 * 抓进 CCC 后穷举出一份**宿主真正消费的字段清单**（下方每节标注宿主源码出处），
 * 本次把这份清单变成会红的测试：字段名/路径一漂移，测试当场红，而不是等用户装包时安静降级。
 *
 * ## 宿主真正消费的 manifest 字段（0.1.5-rc.1 实证，穷举 `\.dsh\?\.` 全 45 包扫描）
 *
 * | 字段 | 读取方（宿主文件） | 缺失后果 |
 * |------|------------------|---------|
 * | `dsh.profile.bundles` / `dsh.profile.patchReload` | `@deepseek-ai/dsh-app-boot/lib/index.js`（loadProfile/initProfile） | profile 未列出本包 = 本包根本不被装载 |
 * | **`dsh.bundle.patch`**（**bundle 包自己的 package.json**） | 同上（`JSON.parse(...).dsh?.bundle?.patch`）+ `@deepseek-ai/dsh/lib/plugin-*.js` `isBundle()` | **响亮失败**：`profile bundle "X" declares no dsh.bundle in its package.json`；`dsh plugin add` 路径则**降级为普通依赖**（warning："declares no dsh.bundle — installed as a plain dependency, not a profile layer"） |
 * | `dsh.moduleFallback.targets` | app-boot（dsh 托管的代理包） | **非插件作者面**（dsh 自己写） |
 * | `dsh.client`（+ `exports["./client"]`） | `@deepseek-ai/dsh-cordis-client-runner`（"the browser half ships through exports["./client"], discovered from the package.json dshClient declaration"） | 浏览器半不被发现 → 面板/输入区 dock 等 client 能力整体消失 |
 *
 * ## 明确**不**被宿主消费的声明（旧结论复核结论，勿再当契约）
 *
 * - **`dsh.plugin.json`**：0.1.5-rc.1 的 45 个宿主包内**连字符串都零命中** → **非宿主识别格式**，
 *   是本包**自维护元数据**（`contributes.tools` 供 `invariant.ts` 与测试自检；工具真正注册走 `ctx.tools.register`）
 * - **`engines.dsh`**：全树 `engines` 只在无关注释里出现 → **无宿主强制**；真正的版本门 = `peerDependencies`
 *   解析 + 本包自己的 `REQUIRED_HOST_RANGE`（`src/host/contract.ts`）
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 包根（不依赖 cwd——根/包两级 vitest 配置下都成立） */
const packageDir = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const read = (rel: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(packageDir, rel), 'utf8')) as Record<string, unknown>

describe('宿主消费面（manifest）：宿主真正读取的字段必须完好', () => {
  it('dsh.bundle.patch 已声明，且指向的 patch 文件真实存在（app-boot 的硬要求）', () => {
    const pkg = read('package.json') as { dsh?: { bundle?: { patch?: string } } }
    const patch = pkg.dsh?.bundle?.patch
    expect(patch).toBe('./cordis.patch.yml')
    // 宿主用 join(packageDir, declared) 解析 → 文件必须在场，否则 bundle 层启动即失败
    expect(existsSync(join(packageDir, patch!))).toBe(true)
  })

  it('patch 文件随包发布（files 必须含 cordis.patch.yml——否则装到用户机器上解析不到）', () => {
    const pkg = read('package.json') as { files?: string[] }
    // npm pack 只带 files 白名单内的文件；patch 不在白名单 = 发布物缺文件（本地测不出，装包才炸）
    expect(pkg.files).toContain('cordis.patch.yml')
    expect(pkg.files).toContain('dsh.plugin.json')
  })

  it('exports["./client"] 声明自洽且目标被 files[] 白名单覆盖（浏览器半的发现通道）', () => {
    const pkg = read('package.json') as { exports?: Record<string, unknown>; files?: string[] }
    const client = pkg.exports?.['./client']
    expect(typeof client).toBe('string')
    // 只断**声明自洽**，**不断"构建产物在场"**：CI 用 `pnpm install --ignore-scripts` 安装
    // （prepare 依赖本机硬编码 paths，runner 上跑不了构建）→ runner 上没有 lib/。
    // v1.31.10 实证：CI run #32（本仓 CI 自 v1.31.6 后**首次真正跑到 vitest**）就红在这一行
    // ——旧断言把"产物已构建"这一**环境依赖**混进了测试，于是"本地绿、CI 红"。
    // 产物完整性归发布链的 `dsh-develop pack-check`（构建之后跑），测试只负责
    // "export 目标与 files[] 白名单对得上"。
    expect(String(client)).toMatch(/^\.\/lib\/.+\.js$/)
    expect(pkg.files ?? []).toContain(String(client).replace(/^\.\//, ''))
  })

  it('dsh.client 声明在场（platform 决定浏览器半挂到哪个面）', () => {
    const pkg = read('package.json') as { dsh?: { client?: { platform?: string } } }
    expect(pkg.dsh?.client?.platform).toBe('web')
  })

  it('peerDependencies 作为**唯一**真实的宿主版本门仍然在场且非空（engines 不被宿主强制）', () => {
    const pkg = read('package.json') as { peerDependencies?: Record<string, string> }
    const peers = Object.keys(pkg.peerDependencies ?? {}).filter((n) => n.startsWith('@deepseek-ai/dsh-'))
    expect(peers.length).toBeGreaterThan(10)
    for (const value of Object.values(pkg.peerDependencies ?? {})) {
      // bare `cordis` 走 rc 线（^4.0.0-rc.N）：上游 cordis 从未发布 4.0.2（npm 404），
      // 宿主 profile 提供的 shim 是 4.0.0-rc.7 —— 见 compliance.test.ts F6b 与 SESSION §17
      expect(value).toMatch(/^\^0\.1\.5-rc\.1$|^\^3\.18\.2$|^\^4\.0\.2$|^\^4\.0\.0-rc\.\d+$/)
    }
  })
})
