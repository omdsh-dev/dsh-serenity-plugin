#!/usr/bin/env bun
/**
 * dsh-develop.ts — dsh-serenity-plugin 开发操作 MSM（Mech，纯确定性）
 *
 * safe-mode 下 bash 被禁，但构建/测试/git/部署仍需执行。
 * 本 MSM 是注册的机械工具（acc_msm exec 走 bun 直跑），封装常用开发操作的白名单通道。
 *
 * 子命令:
 *   dsh-develop typecheck             tsc --noEmit（hooks 目录）
 *   dsh-develop test [--filter <p>]   vitest run（hooks 目录）
 *   dsh-develop build                 tsc + tsdown 双 bundle（产物 lib/）
 *   dsh-develop status                插件仓库 git status + 版本
 *   dsh-develop commit <message>      git add -A + commit（插件仓库）
 *   dsh-develop push                  git push origin（GitHub 公开仓库，SSH-over-443）
 *   dsh-develop deploy                load-plugin.sh 全流程（构建+双锚+shim+profile+预检）
 *   dsh-develop version               package.json / dsh.plugin.json / CHANGELOG 版本
 *   dsh-develop bump <version>        同步 package.json + dsh.plugin.json 版本
 *
 * 退出码: 0 成功 / 1 用户错误 / 2 系统错误
 *
 * 边界（安全语义）: 本 MSM 只执行固定的开发操作集，不接受任意命令执行。
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, rmSync, mkdirSync, cpSync, symlinkSync, statSync, readlinkSync } from 'node:fs'
import { resolve, dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync, execFileSync } from 'node:child_process'

const __filename = fileURLToPath(import.meta.url)
const SCRIPTS_DIR = dirname(__filename)
const REPO_ROOT = resolve(SCRIPTS_DIR, '..')
const HOOKS_DIR = join(REPO_ROOT, 'hooks', 'dsh-serenity-hooks')

const HOME_DIR = process.env.HOME ?? ''

const GIT_SSH = process.env.GIT_SSH_COMMAND
  ?? `ssh -F /dev/null -i ${process.env.SERENITY_GITLAB_KEY ?? join(HOME_DIR, '.ssh', 'id_ed25519_gitlab')} -o IdentitiesOnly=yes`
// GitHub 走 SSH-over-443（ssh.github.com:443）：家庭网络常封 22 端口
const GIT_SSH_GITHUB = process.env.GIT_SSH_COMMAND_GITHUB
  ?? `ssh -F /dev/null -i ${process.env.SERENITY_GITHUB_KEY ?? join(HOME_DIR, '.ssh', 'id_rsa_github')} -o IdentitiesOnly=yes -o HostName=ssh.github.com -o Port=443 -o StrictHostKeyChecking=accept-new`

// ── 工具 ──

function run(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; quiet?: boolean } = {}): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: opts.quiet ? 'pipe' : 'inherit',
    timeout: 600_000,
  })
  return { status: r.status ?? 2, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>
}

/**
 * JSONC 解析（tsconfig.json 是 JSONC——带 `//` 行注释）。
 * 只剥行注释，且**跳过字符串内部**（本仓库 tsconfig 的路径含 `//`? 不含，但注释剥离必须对字符串安全）。
 */
function parseJsonc(text: string): Record<string, unknown> {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; out += ch; continue }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
      continue
    }
    out += ch
  }
  // 容忍结尾多余逗号（JSONC 常见）
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as Record<string, unknown>
}

function currentVersion(): { pkg: string; plugin: string; changelog: string | null } {
  const pkg = readJson(join(HOOKS_DIR, 'package.json'))
  const plugin = readJson(join(HOOKS_DIR, 'dsh.plugin.json'))
  const changelogPath = join(REPO_ROOT, 'CHANGELOG.md')
  let changelog: string | null = null
  if (existsSync(changelogPath)) {
    const m = readFileSync(changelogPath, 'utf-8').match(/^## v([\d.]+)/m)
    changelog = m ? m[1] : null
  }
  return { pkg: String(pkg.version ?? ''), plugin: String(plugin.version ?? ''), changelog }
}

function fail(msg: string, code = 1): never {
  console.error(`[dsh-develop] ${msg}`)
  process.exit(code)
}

// ── 子命令 ──

function cmdTypecheck(): void {
  if (!existsSync(join(HOOKS_DIR, 'tsconfig.json'))) fail(`hooks 目录缺失: ${HOOKS_DIR}`, 2)
  const tscBin = join(REPO_ROOT, 'node_modules', '.bin', 'tsc')
  const r = run(tscBin, ['-p', 'tsconfig.json', '--noEmit'], { cwd: HOOKS_DIR, quiet: true })
  if (r.status !== 0) {
    console.error(r.stdout + r.stderr)
    fail(`typecheck 失败 (exit ${r.status})`, 2)
  }
  // client half（独立 tsconfig，包含浏览器 bundle 源码）
  const clientR = run(tscBin, ['-p', 'client/tsconfig.json'], { cwd: HOOKS_DIR, quiet: true })
  if (clientR.status !== 0) {
    console.error(clientR.stdout + clientR.stderr)
    fail(`client typecheck 失败 (exit ${clientR.status})`, 2)
  }
  console.log(`[dsh-develop] ✓ typecheck 通过（node + client）`)
}

function cmdTest(filter?: string): void {
  if (!existsSync(join(HOOKS_DIR, 'tests'))) {
    fail(`hooks 测试目录缺失`, 2)
  }
  const args = ['run']
  if (filter) args.push(filter)
  // cwd = 仓库根（vitest.config.ts include 覆盖 tests/ + scripts/）
  const r = run(join(REPO_ROOT, 'node_modules', '.bin', 'vitest'), args, { cwd: REPO_ROOT, quiet: true })
  if (r.status !== 0) {
    console.error(r.stdout + r.stderr)
    fail(`vitest 失败 (exit ${r.status})`, 2)
  }
  // 汇总行
  const m = r.stdout.match(/Test Files\s+(\d+) passed[\s\S]*?Tests\s+(\d+) passed/)
  console.log(m ? `[dsh-develop] ✓ 测试通过 (${m[1]} files / ${m[2]} tests)` : '[dsh-develop] ✓ 测试通过')
}

/** coverage：vitest --coverage（v1.28.0 可测试可验证——coverage 阈值门禁见 hooks vitest.config.ts）。
 *  从 HOOKS_DIR 运行：coverage-v8 装在 hooks 自身 node_modules（根 node_modules 无），
 *  且 hooks/vitest.config.ts 定义 coverage 范围 = hooks src。 */
function cmdCoverage(): void {
  if (!existsSync(join(HOOKS_DIR, 'tests'))) {
    fail(`hooks 测试目录缺失`, 2)
  }
  const r = run(join(HOOKS_DIR, 'node_modules', '.bin', 'vitest'), ['run', '--coverage'], { cwd: HOOKS_DIR })
  if (r.status !== 0) {
    console.error(r.stdout + r.stderr)
    fail(`vitest --coverage 失败 (exit ${r.status})——覆盖率低于阈值或测试失败，见 hooks/vitest.config.ts thresholds`, 2)
  }
  // 汇总行（vitest coverage 文本报告在 stdout 尾部）
  const m = r.stdout.match(/Test Files\s+(\d+) passed[\s\S]*?Tests\s+(\d+) passed/)
  console.log(m ? `[dsh-develop] ✓ 测试通过 (${m[1]} files / ${m[2]} tests) + coverage 报告（hooks/dsh-serenity-hooks/coverage/）` : '[dsh-develop] ✓ 测试通过 + coverage 报告')
}

function cmdBuild(): void {
  cmdTypecheck()
  const staging = process.env.DSH_HOME ? join(process.env.DSH_HOME, 'source', 'current') : resolve(process.env.HOME ?? '', '.dsh', 'source', 'current')
  const stagingRoot = readlinkSafe(staging)
  if (!existsSync(join(HOOKS_DIR, 'tsdown.config.ts'))) fail('tsdown.config.ts 缺失', 2)
  // tsdown: 优先 staging 的 harness tsdown 0.22.2（本仓 0.7.5 与 rolldown 不兼容）
  const tsdownBin = join(stagingRoot, 'node_modules', '.bin', 'tsdown')
  const bin = existsSync(tsdownBin) ? tsdownBin : join(REPO_ROOT, 'node_modules', '.bin', 'tsdown')
  const r = run(bin, ['-c', 'tsdown.config.ts'], { cwd: HOOKS_DIR, quiet: true })
  if (r.status !== 0) {
    console.error(r.stdout + r.stderr)
    fail(`tsdown 失败 (exit ${r.status})`, 2)
  }
  const clientSize = existsSync(join(HOOKS_DIR, 'lib', 'client.js'))
    ? `${statSync(join(HOOKS_DIR, 'lib', 'client.js')).size} B`
    : 'N/A'
  console.log(`[dsh-develop] ✓ 构建完成（lib/index.js + lib/client.js ${clientSize}）`)
}

function readlinkSafe(p: string): string {
  try {
    return execFileSync('readlink', ['-f', p], { encoding: 'utf-8' }).trim() || p
  } catch {
    return p
  }
}

function cmdStatus(): void {
  const v = currentVersion()
  console.log(`[dsh-develop] 版本: package.json=${v.pkg} | dsh.plugin.json=${v.plugin} | CHANGELOG=${v.changelog ?? '(无)'}`)
  const r = run('git', ['status', '--short'], { cwd: REPO_ROOT, quiet: true })
  if (r.status !== 0) {
    console.log('[dsh-develop] 仓库非 git 或 status 失败')
    return
  }
  const lines = r.stdout.trim().split('\n').filter(Boolean)
  console.log(lines.length ? `[dsh-develop] git status (${lines.length} 变更):` : '[dsh-develop] git status: clean')
  for (const l of lines.slice(0, 40)) console.log('  ' + l)
  if (lines.length > 40) console.log(`  … 还有 ${lines.length - 40} 条`)
}

function cmdCommit(message?: string): void {
  if (!message) fail('commit 需要消息: dsh-develop commit <message>')
  const add = run('git', ['add', '-A'], { cwd: REPO_ROOT, quiet: true })
  if (add.status !== 0) fail(`git add 失败: ${add.stderr}`, 2)
  const c = run('git', ['commit', '-m', message], { cwd: REPO_ROOT, quiet: true })
  if (c.status !== 0) {
    console.log('[dsh-develop] 无可提交内容或提交失败')
    console.log(c.stderr.trim())
    process.exit(c.status)
  }
  console.log(`[dsh-develop] ✓ committed: ${message}`)
}

function cmdPush(): void {
  // origin 已指向 GitHub 公开仓库（与 github 远程同 URL；v1.16.0 起 GitHub 为主远程）。
  // 推送走 GIT_SSH_GITHUB（id_rsa_github + SSH-over-443）。
  const r = run('git', ['push', 'origin', 'HEAD'], {
    cwd: REPO_ROOT,
    quiet: true,
    env: { GIT_SSH_COMMAND: GIT_SSH_GITHUB },
  })
  if (r.status !== 0) {
    console.error(r.stdout + r.stderr)
    fail(`git push 失败 (exit ${r.status})`, 2)
  }
  console.log(`[dsh-develop] ✓ pushed to origin (GitHub)`)
}

/** omdsh-dev 组织镜像 remote（v1.24.9：dsp 同步到 omdsh-dev 组织增加曝光） */
const OMD_SH_REMOTE = 'omdsh'
const OMD_SH_URL = 'git@github.com:omdsh-dev/dsh-serenity-plugin.git'

/** 确保 remote 存在且 URL 正确（缺则 add，变了则 set-url） */
function ensureRemote(target: string, url: string, cwd = REPO_ROOT): void {
  const existing = run('git', ['remote', 'get-url', target], { cwd, quiet: true })
  if (existing.status !== 0) {
    const add = run('git', ['remote', 'add', target, url], { cwd, quiet: true })
    if (add.status !== 0) fail(`remote add ${target} 失败: ${add.stderr}`, 2)
    console.log(`[dsh-develop] remote ${target} -> ${url}`)
  } else if (existing.stdout.trim() !== url) {
    const set = run('git', ['remote', 'set-url', target, url], { cwd, quiet: true })
    if (set.status !== 0) fail(`remote set-url ${target} 失败: ${set.stderr}`, 2)
    console.log(`[dsh-develop] remote ${target} 更新为 ${url}`)
  }
}

function cmdGithubPush(remote?: string, force = false): void {
  // v1.24.9：默认双推——主仓 github（必达）+ omdsh-dev 组织镜像（失败仅 warn 不阻断发布）；
  // 显式 remote 参数时只推指定 remote（如 github-push github / github-push omdsh）
  const targets = remote ? [remote] : ['github', OMD_SH_REMOTE]
  for (const target of targets) {
    if (target === OMD_SH_REMOTE) ensureRemote(OMD_SH_REMOTE, OMD_SH_URL)
    const args = ['push', target, 'HEAD']
    if (force) args.push('--force')
    const r = run('git', args, {
      cwd: REPO_ROOT,
      quiet: true,
      env: { GIT_SSH_COMMAND: GIT_SSH_GITHUB },
    })
    if (r.status !== 0) {
      if (target === OMD_SH_REMOTE) {
        // 组织镜像失败不阻断主发布（网络/权限问题可后续补推）；保留日志便于排查
        console.warn(`[dsh-develop] ⚠️ omdsh 组织镜像推送失败（不影响主仓，可后续 github-push omdsh 补推）: ${(r.stderr || r.stdout).slice(0, 300)}`)
        continue
      }
      console.error(r.stdout + r.stderr)
      fail(`git push ${target} 失败 (exit ${r.status})`, 2)
    }
    console.log(`[dsh-develop] ✓ pushed to ${target}${force ? '（force）' : ''}`)
  }
}

function cmdSquashHistory(message?: string): void {
  // 抹除历史：orphan 分支重建为单个初始 commit（保留工作树；历史不可逆——公开发布前清敏感历史用）
  const msg = message ?? 'Initial commit'
  const st = run('git', ['status', '--porcelain'], { cwd: REPO_ROOT, quiet: true })
  if (st.stdout.trim()) {
    fail(`工作树有未提交变更，先 commit 或 stash：\n${st.stdout.slice(0, 600)}`, 1)
  }  const orphan = run('git', ['checkout', '--orphan', 'squash-tmp'], { cwd: REPO_ROOT, quiet: true })
  if (orphan.status !== 0) fail(`checkout --orphan 失败: ${orphan.stderr}`, 2)
  const add = run('git', ['add', '-A'], { cwd: REPO_ROOT, quiet: true })
  if (add.status !== 0) fail(`git add 失败: ${add.stderr}`, 2)
  const commit = run('git', ['commit', '-m', msg], { cwd: REPO_ROOT, quiet: true })
  if (commit.status !== 0) fail(`commit 失败: ${commit.stderr}`, 2)
  run('git', ['branch', '-D', 'master'], { cwd: REPO_ROOT, quiet: true })
  const rename = run('git', ['branch', '-m', 'master'], { cwd: REPO_ROOT, quiet: true })
  if (rename.status !== 0) fail(`分支改名失败: ${rename.stderr}`, 2)
  console.log(`[dsh-develop] ✓ 历史已抹除（单初始 commit: ${msg}）`)
  console.log(`[dsh-develop]   推送公开仓库需 force（如: dsh-develop github-push --force）`)
}

/**
 * syncPackageReadme — 包内 README 与仓库 README 机械同步（单一真相源）
 *
 * 背景（v1.30.11）：npm 页面展示的是 **包内** README（hooks/dsh-serenity-hooks/README.md，
 * 经 package.json files 白名单进 tarball），**不是仓库根 README**。此前包内 README 是独立
 * 手写的短版；v1.30.11 重写根 README 后它停在 v1.30.0（"8 块"等过时事实）——于是
 * "发布后 npm README 会更新"的预期落空（实证：jsdelivr 取 @1.30.10 包内 README 仍是旧短版）。
 * 修复 = 发布前把根 README 复制为包内 README，并把**仓库相对链接改写成绝对 GitHub URL**
 * （tarball 内没有 docs/、CHANGELOG.md、LICENSE，相对链接在 npm 页会 404）。
 */
const REPO_BLOB_URL = 'https://github.com/tellmewhattodo/dsh-serenity-plugin/blob/master'

function syncPackageReadme(): void {
  const src = join(REPO_ROOT, 'README.md')
  const dst = join(HOOKS_DIR, 'README.md')
  if (!existsSync(src)) fail(`包内 README 同步失败：源文件不存在 ${src}`, 2)
  const out = readFileSync(src, 'utf-8')
    .replace(/\]\((?!https?:\/\/|mailto:|#)([^)]+)\)/g, (_m, rel: string) => `](${REPO_BLOB_URL}/${rel})`)
  const before = existsSync(dst) ? readFileSync(dst, 'utf-8') : ''
  if (before === out) {
    console.log('[dsh-develop] ✓ 包内 README 与仓库 README 一致（无变更）')
    return
  }
  writeFileSync(dst, out, 'utf-8')
  console.log(`[dsh-develop] ✓ 包内 README 已同步（README.md → hooks/dsh-serenity-hooks/README.md，${out.length} 字节）`)
}

function cmdPublish(): void {
  // npm publish @shgroup/dsh-serenity-hooks（cwd=hooks；凭据走 ~/.npmrc；publishConfig.access=public 已声明）
  // 发布前先构建（lib/ 最新）；npm cache 指向可写临时目录（沙箱 ~/.npm 只读）
  // v1.17.4：显式 --registry https://registry.npmjs.org/ —— ~/.npmrc 默认 registry 可能指向
  // 内网 nexus（tiangong-npm-group，只读镜像 → npm publish 400 Bad Request）。@shgroup token
  // 按 registry URL 匹配，官方 registry 发布不受影响。
  // v1.30.7（S142 review F-14）：发布前强制跑测试——此前 publish 只做 typecheck+build+pack-check，
  // 测试是"人记得跑"的步骤，绿着发布可能带着红测试。
  cmdTest()
  cmdBuild()
  syncPackageReadme()
  verifyTarball()
  const cache = join(process.env.HOME ?? '', '.cache', 'npm-publish')
  const r = run('npm', ['publish', '--access', 'public', '--registry', 'https://registry.npmjs.org/'], {
    cwd: HOOKS_DIR,
    quiet: true,
    env: { npm_config_cache: cache, NPM_CONFIG_CACHE: cache },
  })
  if (r.status !== 0) {
    console.error(r.stdout + r.stderr)
    fail(`npm publish 失败 (exit ${r.status})`, 2)
  }
  console.log(`[dsh-develop] ✓ published @shgroup/dsh-serenity-hooks@${currentVersion().pkg}（npm registry）`)
}

/**
 * verifyTarball — npm pack --dry-run 机械核对 tarball 完整性（发布前强制；pack-check 可独立调用）
 * 核对范围：lib/ 全部 JS 产物（含 tsdown chunk）+ 双 bundle 必需文件。
 * 历史教训：files 白名单漏 chunk（lib/ccc-*.js）→ npm 包 index.js import 失败（加载即崩，v1.26.15 事故）。
 */
function verifyTarball(): void {
  const cache = join(process.env.HOME ?? '', '.cache', 'npm-publish')
  mkdirSync(cache, { recursive: true })
  // 发布前核对 tarball 内容：npm publish 会自动运行 prepare（只构建 Node 半的 prepare
  // 曾清掉 lib/client.js → 发布包缺 client.js，DSH web 激活抛 MissingClientBundleError）。
  // 用 npm pack --dry-run --json 机械断言 Node 半 + client 半都在包内。
  const dry = run('npm', ['pack', '--dry-run', '--json'], {
    cwd: HOOKS_DIR,
    quiet: true,
    env: { npm_config_cache: cache, NPM_CONFIG_CACHE: cache },
  })
  if (dry.status !== 0) {
    console.error(dry.stdout + dry.stderr)
    fail(`npm pack --dry-run 失败 (exit ${dry.status})`, 2)
  }
  let tarballFiles: string[] = []
  try {
    const parsed = JSON.parse(dry.stdout) as Array<{ files: Array<{ path: string }> }>
    tarballFiles = (parsed[0]?.files ?? []).map((f) => f.path)
  } catch {
    fail(`npm pack --dry-run 输出解析失败（非预期 JSON）：\n${dry.stdout.slice(0, 400)}`, 2)
  }
  const required = ['lib/index.js', 'lib/client.js', 'lib/invariant.js']
  const missing = required.filter((f) => !tarballFiles.includes(f))
  if (missing.length > 0) {
    fail(`tarball 缺必需文件（${missing.join(', ')}）——检查 tsdown.prepare.config.ts 是否构建完整双 bundle，中止发布`, 2)
  }
  // v1.26.16：动态核对 lib/ 全部 JS 产物（含 tsdown chunk 如 lib/ccc-*.js）——
  // files 白名单漏 chunk 曾致 npm 包 index.js import "./ccc-xxx.js" 失败（加载即崩）。
  const libJs = readdirSync(join(HOOKS_DIR, 'lib')).filter((f) => f.endsWith('.js'))
  const missingLibJs = libJs.filter((f) => !tarballFiles.includes(`lib/${f}`))
  if (missingLibJs.length > 0) {
    fail(`tarball 缺 lib/ 产物（${missingLibJs.join(', ')}）——package.json files 白名单未覆盖 tsdown 全部输出，中止发布`, 2)
  }
  console.log(`[dsh-develop] ✓ tarball 核对通过（${tarballFiles.length} 文件，含 lib/index.js + lib/client.js + lib/invariant.js）`)
  // lib/ 产物清单（验证 chunk 与 .d.ts 齐全——v1.26.15 事故后常驻可见性）
  const libEntries = tarballFiles.filter((f) => f.startsWith('lib/'))
  const dtsCount = tarballFiles.filter((f) => f.endsWith('.d.ts')).length
  console.log(`[dsh-develop]   lib/ 共 ${libEntries.length} 项（js ${libEntries.filter((f) => f.endsWith('.js')).length} / d.ts ${libEntries.filter((f) => f.endsWith('.d.ts')).length}）`)
  for (const f of libEntries) console.log(`    ${f}`)
  console.log(`[dsh-develop]   包内 .d.ts 类型文件总计 ${dtsCount} 个`)
}

function cmdGithubPushRepo(dir?: string): void {
  // 任意仓库发布到 GitHub 公开仓库（tellmewhattodo/<仓库名>）：缺 github remote 自动添加；SSH-443
  if (!dir) fail('github-push-repo 需要仓库目录（相对 CCC 根，如 AI_LAB/serenity-acc-specs）')
  const abs = resolve(process.cwd(), dir)
  if (!existsSync(join(abs, '.git'))) fail(`不是 git 仓库: ${abs}`, 2)
  const target = 'github'
  const repoName = basename(abs)
  const url = `git@github.com:tellmewhattodo/${repoName}.git`
  const existing = run('git', ['remote', 'get-url', target], { cwd: abs, quiet: true })
  if (existing.status !== 0) {
    const add = run('git', ['remote', 'add', target, url], { cwd: abs, quiet: true })
    if (add.status !== 0) fail(`remote add 失败: ${add.stderr}`, 2)
    console.log(`[dsh-develop] remote ${target} -> ${url}`)
  } else if (existing.stdout.trim() !== url) {
    const set = run('git', ['remote', 'set-url', target, url], { cwd: abs, quiet: true })
    if (set.status !== 0) fail(`remote set-url 失败: ${set.stderr}`, 2)
    console.log(`[dsh-develop] remote ${target} 更新为 ${url}`)
  }
  const r = run('git', ['push', target, 'HEAD'], {
    cwd: abs,
    quiet: true,
    env: { GIT_SSH_COMMAND: GIT_SSH_GITHUB },
  })
  if (r.status !== 0) {
    console.error(r.stdout + r.stderr)
    fail(`git push ${target} 失败 (exit ${r.status})`, 2)
  }
  console.log(`[dsh-develop] ✓ pushed ${repoName} -> github (${url})`)
}

function cmdGithubLs(remote?: string): void {
  // 验证 GitHub remote 连通性 + 仓库存在（git ls-remote）；remote 缺失则自动添加
  const target = remote ?? 'github'
  const url = 'git@github.com:tellmewhattodo/dsh-serenity-plugin.git'
  const existing = run('git', ['remote', 'get-url', target], { cwd: REPO_ROOT, quiet: true })
  if (existing.status !== 0) {
    const add = run('git', ['remote', 'add', target, url], { cwd: REPO_ROOT, quiet: true })
    if (add.status !== 0) fail(`git remote add ${target} 失败: ${add.stderr}`, 2)
    console.log(`[dsh-develop] remote ${target} -> ${url}`)
  } else if (existing.stdout.trim() !== url) {
    const set = run('git', ['remote', 'set-url', target, url], { cwd: REPO_ROOT, quiet: true })
    if (set.status !== 0) fail(`git remote set-url ${target} 失败: ${set.stderr}`, 2)
    console.log(`[dsh-develop] remote ${target} 更新为 ${url}`)
  }
  const r = run('git', ['ls-remote', '--heads', target], {
    cwd: REPO_ROOT,
    quiet: true,
    env: { GIT_SSH_COMMAND: GIT_SSH_GITHUB },
  })
  if (r.status !== 0) {
    console.error(r.stdout + r.stderr)
    fail(`ls-remote ${target} 失败（SSH key 无权访问或仓库不存在）`, 2)
  }
  console.log(`[dsh-develop] ✓ ${target} 可达，heads:\n${r.stdout.trim() || '(空，新仓库)'}`)
}

function cmdInspectDsh(pattern?: string): void {
  // 诊断工具：在 staging DSH 源码中检索 src/（排除 lib/types 噪音；独立进程不受工具守卫约束）
  if (!pattern) fail('inspect-dsh 需要 pattern')
  const dshHome = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
  const staging = readlinkSafe(join(dshHome, 'source', 'current'))
  // 只搜 packages/*/src 与 apps/*/src，排除 lib（.d.ts 噪音）
  const grep = run('bash', ['-c',
    `find '${join(staging, 'packages')}' '${join(staging, 'apps')}' -type f -name '*.ts' -not -path '*/lib/*' -not -path '*/tests/*' 2>/dev/null | xargs grep -l -E '${pattern}' 2>/dev/null | head -8 | while read f; do echo "== $f"; grep -n -E '${pattern}' "$f" | head -5; done`],
  { cwd: staging, quiet: true })
  if (grep.status !== 0 || !grep.stdout.trim()) {
    console.log(`[dsh-develop] 无匹配: ${pattern}`)
    return
  }
  console.log(`[dsh-develop] 匹配 ${pattern}:`)
  console.log(grep.stdout.slice(0, 4000))
}

/**
 * host-fetch — 抓取指定版本的**宿主包**并解包到仓库内 `_tmp/host-<version>/`（**不动本机安装**）。
 *
 * 为什么存在（R↓，0.1.5-rc.1 适配轮）：宿主升级适配需要三样东西，全都要求**新版源码在场**：
 *   ① 我们 peer 依赖的包的 `.d.ts`（类型面/契约核对——`host/contract.ts` 的服务与成员表要逐条对账）；
 *   ② 宿主插件源码（如 `dsh-llm-pi-ai` 的 provider 请求构造，用于判断"特殊 header 能否在插件层注入"）；
 *   ③ 新旧两版对比（移除/改名的 API）。
 * 本机 `~/.npm-global/.../@deepseek-ai/dsh` 是**旧版安装**（用户要求先不升级），所以在这里把新版抓到
 * 仓库内 `_tmp/`（gitignore）——解包后 `read`/`grep`/`glob` 可直接读，无需安装、无需改 tsconfig。
 *
 * 用法: dsh-develop host-fetch <version> [pkg...]
 *   包集合 = hooks/package.json 的 peerDependencies（`@deepseek-ai/dsh-*`）+ client 半 ui 包 + 任务专用包
 *   已是幂等：已解包的包跳过；单个包失败仅告警（不阻断其余）
 */
const HOST_FETCH_CLIENT_PACKAGES = [
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-locale',
]

/** 适配轮常需、但不在 peer 列表里的宿主包（核对用） */
const HOST_FETCH_EXTRA_PACKAGES = [
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-llm-deepseek',
  '@deepseek-ai/dsh-persona',
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-subagent-spawn-in-process',
  '@deepseek-ai/dsh-tool-subagent',
  '@deepseek-ai/dsh-session-persistence-jsonl',
  '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-agent-presets',
]

function cmdHostFetch(version?: string, extra: string[] = []): void {
  if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
    fail('host-fetch 需要版本号: dsh-develop host-fetch <x.y.z[-rc.n]> [pkg...]')
  }
  const pkg = readJson(join(HOOKS_DIR, 'package.json'))
  const peers = Object.keys((pkg.peerDependencies ?? {}) as Record<string, string>)
    .filter((n) => n.startsWith('@deepseek-ai/dsh-'))
  const names = [...new Set([...peers, ...HOST_FETCH_CLIENT_PACKAGES, ...HOST_FETCH_EXTRA_PACKAGES, ...extra])]
  const outRoot = join(REPO_ROOT, '_tmp', `host-${version}`)
  mkdirSync(outRoot, { recursive: true })
  const cache = join(process.env.HOME ?? '', '.cache', 'npm-publish')
  mkdirSync(cache, { recursive: true })
  console.log(`[dsh-develop] host-fetch ${version} → ${outRoot}（${names.length} 个包）`)

  const failed: string[] = []
  let done = 0
  let skipped = 0
  for (const spec of names) {
    // 支持 `pkg@version` 逐包钉版本（cordis / schemastery 这类非 dsh-* 的 peer 不跟宿主版本号走）
    const at = spec.lastIndexOf('@')
    const name = at > 0 ? spec.slice(0, at) : spec
    const pkgVersion = at > 0 ? spec.slice(at + 1) : version
    const dest = join(outRoot, name)
    if (existsSync(join(dest, 'package.json'))) { skipped += 1; continue }
    const packed = run('npm', ['pack', `${name}@${pkgVersion}`, '--pack-destination', outRoot,
      '--registry', 'https://registry.npmjs.org/'], {
      cwd: outRoot, quiet: true, env: { npm_config_cache: cache, NPM_CONFIG_CACHE: cache },
    })
    if (packed.status !== 0) {
      failed.push(spec)
      continue
    }
    // npm pack 输出末行为 tarball 文件名
    const tgz = packed.stdout.trim().split('\n').pop() ?? ''
    const tgzPath = join(outRoot, tgz)
    if (!tgz || !existsSync(tgzPath)) { failed.push(name); continue }
    mkdirSync(dest, { recursive: true })
    const x = run('tar', ['-xzf', tgzPath, '-C', dest, '--strip-components=1'], { cwd: outRoot, quiet: true })
    rmSync(tgzPath, { force: true })
    if (x.status !== 0) { failed.push(name); continue }
    done += 1
  }
  console.log(`[dsh-develop] ✓ 解包 ${done} / 跳过（已存在）${skipped} / 失败 ${failed.length}`)
  if (failed.length) console.log(`[dsh-develop]   失败包: ${failed.join(', ')}`)
  console.log('[dsh-develop]   下一步：直接 read/grep/glob 读源码与 .d.ts（typecheck 基线仍指向本机安装，未改动）')
}

/**
 * 把基准 tsconfig 里的宿主路径值改写到本次解包的宿主根下。
 *
 * 两类基准来源（R↓：dsp 的 client 半历史上混用了两种宿主类型来源）：
 *  ① 本机安装：`…/node_modules/@deepseek-ai/dsh-tools[/子路径]`
 *  ② 本机源码树：`.dsh/source/current/packages/client/ui-slots[/子路径]`
 *     → 包名按官方约定还原为 `@deepseek-ai/dsh-client-ui-slots`
 * 其余值（如 `node_modules/@types/react`）与宿主无关，**原样保留**——误映射会把 react 类型打断。
 */
function mapHostPathToTmp(value: string, hostPrefix: string): string {
  // 基准值形如 `…/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools`
  // ——有**两个** `node_modules`，必须取最后一个（`indexOf` 会切出 `@deepseek-ai/dsh/node_modules/...`）。
  const nm = value.lastIndexOf('/node_modules/@deepseek-ai/')
  if (nm >= 0) return `${hostPrefix}/${value.slice(nm + '/node_modules/'.length)}`
  const src = value.indexOf('.dsh/source/current/packages/')
  if (src >= 0) {
    const parts = value.slice(src + '.dsh/source/current/packages/'.length).split('/')
    const pkg = `@deepseek-ai/dsh-${parts[0]}-${parts[1]}`
    return `${hostPrefix}/${[pkg, ...parts.slice(2)].join('/')}`
  }
  return value
}

/** 生成派生 tsconfig 并跑 tsc；返回 { label, status, output, hostFiles } */
function runHostTypecheckHalf(
  tscBin: string,
  version: string,
  baseFile: string,
  outFile: string,
  hostPrefix: string,
  label: string,
  fileMarker: string,
): { status: number; output: string; hostFiles: number } {
  const baseDir = dirname(baseFile)
  const base = parseJsonc(readFileSync(baseFile, 'utf-8'))
  const basePaths = (base.compilerOptions as { paths?: Record<string, string[]> }).paths ?? {}
  const paths: Record<string, string[]> = {}
  const remapped = new Set<string>()
  for (const [key, targets] of Object.entries(basePaths)) {
    paths[key] = targets.map((t) => {
      const mapped = mapHostPathToTmp(t, hostPrefix)
      if (mapped !== t) remapped.add(key)
      return mapped
    })
  }
  const derived = { ...base, compilerOptions: { ...(base.compilerOptions as Record<string, unknown>), paths } }
  writeFileSync(outFile, JSON.stringify(derived, null, 2) + '\n')
  // 基线自证（R↓）：paths 若指向不存在的目录，tsc 会**静默回落** node_modules（=旧宿主/未安装），
  // 于是"无类型错误"变成假阳性。存在性检查 + --listFiles 命中数把假阳性变成可读事实。
  // 只校验**被改写的**条目——`react` 这类与宿主无关的值原样保留，从 client 目录看本就不该存在。
  const missing = Object.entries(paths)
    .filter(([key]) => remapped.has(key))
    .filter(([, targets]) => !targets.some((t) => existsSync(resolve(baseDir, t))))
    .map(([key]) => key)
  if (missing.length) {
    fail(`${label}: 派生 paths 指向缺失目录（${missing.length} 条）: ${missing.join(', ')}\n`
      + `  说明 _tmp/host-${version}/ 解包不全 → 补跑: dsh-develop host-fetch ${version} <pkg...>`, 2)
  }
  console.log(`[dsh-develop] ${label}: 派生 ${basename(outFile)}，paths ${Object.keys(paths).length} 条全部命中`)
  const args = ['-p', basename(outFile), '--noEmit']
  const r = run(tscBin, args, { cwd: baseDir, quiet: true })
  const listed = run(tscBin, [...args, '--listFiles'], { cwd: baseDir, quiet: true })
  const hostFiles = listed.stdout.split('\n').filter((l) => l.includes(fileMarker)).length
  if (hostFiles === 0) fail(`${label}: 解包宿主文件命中 0 —— 派生 paths 未生效，结论不可用`, 2)
  console.log(`[dsh-develop]   ${label}: 实测载入解包宿主 ${hostFiles} 个文件`)
  return { status: r.status, output: (r.stdout + r.stderr).trim(), hostFiles }
}

/**
 * typecheck-host — 用**仓库内解包的宿主**（host-fetch 产物）对类型面做对账。
 *
 * 为什么存在（R↓，0.1.5-rc.1 适配轮）：正式 tsconfig 的 `paths` 硬编码指向**本机 DSH 安装**
 * （用户要求回家后再升级 → 仍是旧版）。于是"新版宿主下哪里会红"在本地无法回答，只能人肉读 .d.ts。
 * 本命令生成**一次性派生 tsconfig**（`tsconfig.host-<version>.local.json`，与基准同目录、gitignore）：
 *   - 编译选项逐字继承基准（JSONC 解析后仅覆写 `paths`；两份不漂移）
 *   - `paths` 指向 `_tmp/host-<version>/@deepseek-ai/*`（host-fetch 解包产物）
 *   - 产物不进仓、不动本机安装、不改正式 tsconfig
 *
 * 用法: dsh-develop typecheck-host <version>
 * 退出码: 0 两份全过 / 2 有类型错误（原文打印，即适配清单）
 */
function cmdTypecheckHost(version?: string): void {
  if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
    fail('typecheck-host 需要宿主版本号: dsh-develop typecheck-host <x.y.z[-rc.n]>（先跑 host-fetch）')
  }
  const hostRoot = join(REPO_ROOT, '_tmp', `host-${version}`)
  if (!existsSync(hostRoot)) {
    fail(`未找到 ${hostRoot} —— 先跑: dsh-develop host-fetch ${version}`, 1)
  }
  const tscBin = join(REPO_ROOT, 'node_modules', '.bin', 'tsc')
  const marker = `host-${version}/@deepseek-ai/`
  const halves = [
    {
      label: 'node',
      base: join(HOOKS_DIR, 'tsconfig.json'),
      out: join(HOOKS_DIR, `tsconfig.host-${version}.local.json`),
      prefix: `../../_tmp/host-${version}`,
    },
    {
      label: 'client',
      base: join(HOOKS_DIR, 'client', 'tsconfig.json'),
      out: join(HOOKS_DIR, 'client', `tsconfig.host-${version}.local.json`),
      prefix: `../../../_tmp/host-${version}`,
    },
  ]
  console.log(`[dsh-develop] typecheck-host ${version}（解包宿主 → _tmp/host-${version}/）`)
  const failures: string[] = []
  for (const half of halves) {
    if (!existsSync(half.base)) { failures.push(`${half.label}: 基准 tsconfig 缺失`); continue }
    const r = runHostTypecheckHalf(tscBin, version, half.base, half.out, half.prefix, half.label, marker)
    if (r.status !== 0) {
      console.log(r.output)
      failures.push(`${half.label}: tsc exit ${r.status}`)
    } else {
      console.log(`[dsh-develop] ✓ ${half.label} 半：新宿主 ${version} 下无类型错误`)
    }
  }
  if (failures.length) fail(`typecheck-host 失败（${failures.join(' / ')}）——以上条目即适配清单`, 2)
  console.log(`[dsh-develop] ✓ typecheck-host 通过（宿主 ${version}，node + client）`)
}

function cmdReadDsh(relPath?: string, start?: string, end?: string): void {
  // 诊断工具：读取 staging DSH 源码或任意文件片段（sed 式行范围；独立进程不受工具守卫约束）
  if (!relPath) fail('read-dsh 需要相对路径（如 packages/core/tools/src/index.ts）或绝对路径')
  const dshHome = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
  const staging = readlinkSafe(join(dshHome, 'source', 'current'))
  const file = relPath.startsWith('/') ? relPath : join(staging, relPath)
  if (!existsSync(file)) fail(`路径不存在: ${relPath}`, 2)
  if (statSync(file).isDirectory()) {
    const out = readdirSync(file).map((n) => {
      const p = join(file, n)
      return (statSync(p).isDirectory() ? 'd ' : 'f ') + n
    })
    console.log(out.join('\n'))
    return
  }
  const s = start ? String(parseInt(start, 10) || 1) : '1'
  const e = end ? String(parseInt(end, 10) || 1) : undefined
  const sedArgs = e ? ['-n', `${s},${e}p`, file] : ['-n', `${s},$p`, file]
  const r = run('sed', sedArgs, { cwd: staging, quiet: true })
  if (r.status !== 0) fail(`读取失败: ${r.stderr}`, 2)
  console.log(r.stdout)
}

function cmdDumpConfig(pattern?: string): void {
  // v1.30.12：机械验证 profile 合成结果——宿主 `dsh --dump-config` 与 boot 走**同一个**
  // applyEntryPatches（app-boot 注释明示"a dump can never drift from what boots"），
  // 因此可用它核对 bundle patch（如禁用 web-fetch-http）是否真的生效。
  const dshBin = process.env.SERENITY_DSH_BIN ?? join(HOME_DIR, '.npm-global', 'bin', 'dsh')
  const bin = existsSync(dshBin) ? dshBin : 'dsh'
  const profile = process.env.SERENITY_DSH_PROFILE ?? 'web'
  const r = run(bin, ['--profile', profile, '--dump-config'], { cwd: REPO_ROOT, quiet: true })
  if (r.status !== 0) {
    console.error(r.stdout + r.stderr)
    fail(`dsh --dump-config 失败 (exit ${r.status})`, 2)
  }
  if (!pattern) {
    console.log(r.stdout)
    return
  }
  const re = new RegExp(pattern, 'i')
  const all = r.stdout.split('\n')
  const keep = new Set<number>()
  all.forEach((line, i) => {
    if (re.test(line)) {
      keep.add(i - 1)
      keep.add(i)
      keep.add(i + 1)
    }
  })
  if (keep.size === 0) {
    console.log(`[dsh-develop] --dump-config 无匹配: ${pattern}`)
    return
  }
  console.log(all.filter((_, i) => keep.has(i)).join('\n'))
}

function cmdApiStatus(path?: string): void {
  // 查询本地 dsh web HTTP 接口（同步阻塞版；避免异步回调在 bun 进程退出前未执行）
  const urlPath = path ?? '/serenity/status?workspace=' + (process.env.SERENITY_CCC_ROOT ?? '')
  const code = `const http = require('node:http');
const req = http.request({ host: '127.0.0.1', port: 3080, path: ${JSON.stringify(urlPath)}, method: 'GET', headers: { 'cache-control': 'no-store' } }, (res) => {
  let data = '';
  res.on('data', c => data += c.toString('utf-8'));
  res.on('end', () => {
    console.log('HTTP ' + res.statusCode);
    console.log(data.slice(0, 1200));
  });
});
req.setTimeout(10000, () => req.destroy(new Error('timeout')));
req.on('error', e => { console.error('request failed: ' + e.message); process.exit(2); });
req.end();`
  const r = run('node', ['-e', code], { cwd: process.cwd(), quiet: true })
  if (r.status !== 0 && !r.stdout) { console.error(r.stderr); process.exit(r.status) }
  console.log(r.stdout)
}

function cmdRestartWeb(): void {
  // 重启 dsh web：kill 旧进程 → 等待端口释放 → rc.6 CLI 启动新进程（setsid 脱离，nohup 后台）
  // 公开版适配：运行时 = 已安装 CLI（~/.npm-global/bin/dsh），非 staging 源码（旧架构）
  // v1.22.1 稳定性修复：kill 后同时等待 3080 + 3081 释放（gateway 第二端口常被旧进程占用，
  // 只等 3080 → 新进程 gateway listen EADDRINUSE → 崩溃，表现为"restart 不成功，需手动启动"）
  const dshHome = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
  const cliBin = join(process.env.HOME ?? '', '.npm-global', 'bin', 'dsh')
  const npmDsh = join(process.env.HOME ?? '', '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const bin = existsSync(npmDsh) ? npmDsh : cliBin
  const PORT = 3080
  const GATEWAY_PORT = 3081
  if (!existsSync(bin)) fail(`dsh CLI 缺失: ${bin}`, 2)

  // 1) 找到旧 web 进程并 kill（含残留：匹配 bin.js web / bin/dsh web）
  const ps = run('bash', ['-c', `ps aux | grep -E 'dsh/lib/bin\\.js web|bin/dsh web' | grep -v grep | awk '{print $2}'`], { cwd: process.cwd(), quiet: true })
  const pids = ps.stdout.trim().split('\n').filter(Boolean)
  if (pids.length === 0) console.log('[dsh-develop]    无旧 web 进程')
  for (const pid of pids) {
    console.log(`    kill ${pid}`)
    run('kill', [pid], { cwd: process.cwd(), quiet: true })
  }
  // 2) 轮询等待端口释放（最多 15s；EADDRINUSE 根因：kill 后旧进程未完全退出 / gateway 端口未释放）
  const waitForPortsFree = (): boolean => {
    for (let i = 0; i < 15; i++) {
      const probe = run('bash', ['-c', `ss -ltn 2>/dev/null | grep -qE ':(${PORT}|${GATEWAY_PORT}) ' && echo busy || echo free`], { cwd: process.cwd(), quiet: true })
      if (probe.stdout.trim().includes('free')) return true
      run('sleep', ['1'], { cwd: process.cwd(), quiet: true })
    }
    return false
  }
  if (!waitForPortsFree()) {
    console.error(`[dsh-develop] ⚠️ 端口 ${PORT}/${GATEWAY_PORT} 15s 内未释放，尝试强杀`)
    const hard = run('bash', ['-c', `ss -ltnp 2>/dev/null | grep -E ':(${PORT}|${GATEWAY_PORT}) ' | grep -oP 'pid=\\K[0-9]+' | sort -u`], { cwd: process.cwd(), quiet: true })
    for (const pid of hard.stdout.trim().split('\n').filter(Boolean)) {
      run('kill', ['-9', pid], { cwd: process.cwd(), quiet: true })
    }
    run('sleep', ['2'], { cwd: process.cwd(), quiet: true })
  }

  // 3) setsid + nohup 启动新进程（rc.6 CLI web profile）
  const log = `/tmp/dsh-web-restart-v${currentVersion().pkg}.log`
  const cmd = `cd ${process.env.HOME ?? ''} && setsid nohup node ${bin} web > ${log} 2>&1 < /dev/null & disown`
  const r = run('bash', ['-c', cmd], { cwd: process.cwd(), quiet: true })
  if (r.status !== 0) fail(`web 启动失败: ${r.stderr}`, 2)
  console.log(`[dsh-develop] ✓ web 已重启（bin: ${bin}，日志: ${log}）`)
  console.log(`[dsh-develop]   等待 18s 后健康检查（curl /serenity/status，端口 ${PORT}）...`)
  run('sleep', ['18'], { cwd: process.cwd(), quiet: true })
  // 端口确认（主端口 + gateway 第二端口）
  const portCheck = run('bash', ['-c', `ss -ltn 2>/dev/null | grep -q ':${PORT} ' && echo LISTENING || echo DOWN`], { cwd: process.cwd(), quiet: true })
  const gwCheck = run('bash', ['-c', `ss -ltn 2>/dev/null | grep -q ':${GATEWAY_PORT} ' && echo LISTENING || echo DOWN`], { cwd: process.cwd(), quiet: true })
  const health = run('curl', ['-s', 'http://127.0.0.1:3080/serenity/status?workspace=' + (process.env.SERENITY_CCC_ROOT ?? '')], { cwd: process.cwd(), quiet: true })
  const statusLine = health.status === 0 && health.stdout ? health.stdout.trim().slice(0, 400) : ''
  console.log(`[dsh-develop] 端口: 主=${portCheck.stdout.trim()} 网关=${gwCheck.stdout.trim()}`)
  console.log(statusLine ? `[dsh-develop] ✓ 状态: ${statusLine}` : '[dsh-develop] ⚠️ 健康检查未返回（检查日志）')
  if (statusLine) {
    try {
      const st = JSON.parse(statusLine) as { safeModeOn?: boolean; restrict?: { lastSuccess?: boolean | null; lastError?: string | null; activeKeys?: string[] } }
      console.log(`[dsh-develop] safeModeOn=${st.safeModeOn} restrict.lastSuccess=${st.restrict?.lastSuccess} activeKeys=${JSON.stringify(st.restrict?.activeKeys ?? [])}${st.restrict?.lastError ? ` lastError=${st.restrict.lastError}` : ''}`)
    } catch { /* 解析失败忽略 */ }
  }
}

function cmdVersion(): void {
  const v = currentVersion()
  console.log(`package.json      ${v.pkg}`)
  console.log(`dsh.plugin.json   ${v.plugin}`)
  console.log(`CHANGELOG.md      ${v.changelog ?? '(无条目)'}`)
  const drift = new Set([v.pkg, v.plugin, v.changelog])
  if (drift.size > 1) console.log('⚠️ 版本漂移！三处不一致（ACC_VERSION 从 package.json 派生）')
  else console.log('✓ 版本一致')
}

function cmdBump(version?: string): void {
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) fail('bump 需要版本号: dsh-develop bump <x.y.z>')
  for (const f of ['package.json', 'dsh.plugin.json']) {
    const p = join(HOOKS_DIR, f)
    const j = readJson(p)
    j.version = version
    writeFileSync(p, JSON.stringify(j, null, 2) + '\n', 'utf-8')
  }
  console.log(`[dsh-develop] ✓ version → ${version}（package.json + dsh.plugin.json；CHANGELOG 需手动补条目）`)
}

/**
 * 检测 profile 是否已通过 bundle 层挂载插件（npm-install / `dsh plugin add` 写入
 * package.json `dsh.profile.bundles`）。存在 → deploy 不得再写 cordis.patch.yml insert
 * （双挂载 → duplicate loader entry id: serenity-hooks）。
 */
function profileBundleMounted(dshHome: string, profile: string): boolean {
  const candidates = [
    join(dshHome, 'profiles', profile, 'package.json'),
    join(dshHome, 'profiles', 'package.json'),
  ]
  for (const p of candidates) {
    if (!existsSync(p)) continue
    try {
      const j = JSON.parse(readFileSync(p, 'utf-8')) as {
        dsh?: { profile?: { bundles?: unknown }; bundle?: { patch?: string } }
      }
      const dsh = j.dsh
      if (!dsh || typeof dsh !== 'object') continue
      const bundles = dsh.profile?.bundles
      if (Array.isArray(bundles) && bundles.includes('@shgroup/dsh-serenity-hooks')) return true
      if (typeof dsh.bundle?.patch === 'string' && dsh.bundle.patch.includes('dsh-serenity-hooks')) return true
    } catch {
      /* 解析失败忽略 */
    }
  }
  return false
}

/**
 * 从 cordis.patch.yml 文本中幂等移除含目标 id 的顶层 `- insert:` 块。
 * 返回清理后的文本；未找到该块返回 null（调用方无需写回）。
 */
function stripInsertBlock(content: string, id: string): string | null {
  const lines = content.split('\n')
  const out: string[] = []
  let removed = false
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (/^-\s*insert:/.test(line)) {
      // 扫描该 insert 块（到下一个 0 缩进非注释行）是否含目标 id
      let j = i + 1
      let hasId = false
      while (j < lines.length) {
        const l = lines[j]!
        if (l.trim() !== '' && !/^\s/.test(l) && !l.startsWith('#')) break
        if (l.includes(`id: ${id}`)) {
          hasId = true
          break
        }
        j++
      }
      if (hasId) {
        removed = true
        i = j // 跳过整个块（j 指向下一块首行或 EOF）
        continue
      }
    }
    out.push(line)
    i++
  }
  if (!removed) return null
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

function cmdDeploy(): void {
  // 复刻 scripts/load-plugin.sh 全流程（纯 Node 实现，不依赖 bash）
  // 公开版适配（v1.16+）：运行时 = rc.6 CLI + profile（~/.dsh/profiles/node_modules），
  // staging 双锚保留为源码调试目标（旧架构，非运行时）。
  const dshHome = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
  const staging = readlinkSafe(join(dshHome, 'source', 'current'))
  const appNm = join(staging, 'apps', 'cli', 'node_modules')
  const rootNm = join(staging, 'node_modules')
  // v1.16.9 修复（S134）：CLI（`dsh web`）实际从 **profiles/web/node_modules**（pnpm profile 结构）
  // 解析 bundle 插件——deploy 原只复制 profiles/node_modules（错误目标，从未被加载，
  // 导致 deploy 后 web 仍是旧版）。两处都复制：web 为实际加载路径，profiles/node_modules 历史兼容。
  const profilePkg = join(dshHome, 'profiles', 'node_modules', '@shgroup', 'dsh-serenity-hooks')
  const webProfilePkg = join(dshHome, 'profiles', 'web', 'node_modules', '@shgroup', 'dsh-serenity-hooks')
  const profileTargets = [profilePkg, webProfilePkg]
  const targets = [rootNm, appNm]

  console.log('==> 1/4 构建插件')
  cmdBuild()

  console.log('==> 2/4 复制插件（staging 双锚 + profile 双目标：profiles/node_modules + profiles/web/node_modules）')
  for (const nm of targets) {
    const dst = join(nm, '@shgroup', 'dsh-serenity-hooks')
    rmSync(dst, { recursive: true, force: true })
    mkdirSync(join(nm, '@shgroup'), { recursive: true })
    cpSync(HOOKS_DIR, dst, {
      recursive: true,
      filter: (src) => {
        const base = src.split('/').pop() ?? ''
        return !['tests', 'src', '.pnpm-store', 'client', 'node_modules'].includes(base) && !src.endsWith('tsconfig.json') && !src.endsWith('dsh.plugin.json')
      },
    })
    console.log(`    copied -> ${dst}`)
  }
  // profile 真实目录（公开版运行时目标）：替换任何历史符号链接（旧 staging 时代残留）
  for (const dst of profileTargets) {
    try {
      if (lstatSync(dst).isSymbolicLink()) rmSync(dst, { force: true })
    } catch { /* 不存在或非链接 */ }
    rmSync(dst, { recursive: true, force: true })
    mkdirSync(dirname(dst), { recursive: true })
    cpSync(HOOKS_DIR, dst, {
      recursive: true,
      filter: (src) => {
        const base = src.split('/').pop() ?? ''
        return !['tests', 'src', '.pnpm-store', 'client', 'node_modules'].includes(base) && !src.endsWith('tsconfig.json') && !src.endsWith('dsh.plugin.json')
      },
    })
    console.log(`    copied -> ${dst}（真实目录，非链接）`)
  }

  console.log('==> 3/4 依赖 shim（仅 staging 锚需要；profile 目标走 rc.6 profile node_modules）')
  const shims: Record<string, string> = {
    cordis: join(staging, 'vendor', 'cordis'),
    schemastery: join(staging, 'vendor', 'schemastery'),
    '@deepseek-ai/dsh-tools': join(staging, 'packages', 'core', 'tools'),
    '@deepseek-ai/dsh-agent': join(staging, 'packages', 'core', 'agent'),
    '@deepseek-ai/dsh-session': join(staging, 'packages', 'core', 'session'),
    '@deepseek-ai/dsh-llm': join(staging, 'packages', 'llm', 'llm'),
    '@deepseek-ai/dsh-host-webserver': join(staging, 'packages', 'host', 'webserver'),
  }
  for (const nm of targets) {
    const dst = join(nm, '@shgroup', 'dsh-serenity-hooks')
    mkdirSync(join(dst, 'node_modules', '@deepseek-ai'), { recursive: true })
    for (const [spec, target] of Object.entries(shims)) {
      if (existsSync(target)) {
        try { symlinkSync(target, join(dst, 'node_modules', spec)) } catch { /* 已存在 */ }
      } else {
        console.log(`    !! shim 目标缺失: ${spec} -> ${target}`)
      }
    }
  }

  console.log('==> 4/4 profile 挂载 + 预检')
  const profileDir = join(dshHome, 'profiles', 'web')
  const patchFile = join(profileDir, 'cordis.patch.yml')
  // v1.16.6（S134 双挂载修复）：bundle 层（package.json `dsh.profile.bundles`，npm-install
  // 写入）与 cordis.patch.yml insert **二选一**——同挂载同一 loader entry 会报
  // `duplicate loader entry id: serenity-hooks`（web 起不来）：
  //   bundle 层已挂载 → 跳过 insert 写入，并幂等移除历史写入的 insert（bundle 是公开版主路径）
  //   无 bundle 层（纯 deploy 本地开发）→ 写入 insert（唯一挂载方式）
  if (profileBundleMounted(dshHome, 'web')) {
    if (existsSync(patchFile)) {
      const cleaned = stripInsertBlock(readFileSync(patchFile, 'utf-8'), 'serenity-hooks')
      if (cleaned !== null) {
        writeFileSync(patchFile, cleaned, 'utf-8')
        console.log('    bundle 层已挂载（dsh.profile.bundles）→ 移除 cordis.patch.yml 冗余 insert（防 duplicate loader entry）')
      } else {
        console.log('    bundle 层已挂载（dsh.profile.bundles）→ 跳过 insert（cordis.patch.yml 无冗余）')
      }
    } else {
      console.log('    bundle 层已挂载（dsh.profile.bundles）→ 无需 cordis.patch.yml')
    }
  } else {
    const bundlePatch = join(HOOKS_DIR, 'cordis.patch.yml')
    if (!existsSync(bundlePatch)) fail(`插件自带 cordis.patch.yml 缺失: ${bundlePatch}`, 2)
    const insertBlock = readFileSync(bundlePatch, 'utf-8')
    if (existsSync(patchFile) && readFileSync(patchFile, 'utf-8').includes('id: serenity-hooks')) {
      console.log('    cordis.patch.yml 已包含，跳过（幂等）')
    } else {
      mkdirSync(profileDir, { recursive: true })
      const content = existsSync(patchFile) ? readFileSync(patchFile, 'utf-8') + '\n' + insertBlock + '\n' : insertBlock + '\n'
      writeFileSync(patchFile, content, 'utf-8')
      console.log(`    ${patchFile} 已写入（无 bundle 层，insert 为唯一挂载）`)
    }
  }

  // 预检：公开版从 profile/web/node_modules（CLI 实际加载路径）导入
  const preflight = run('node', ['--input-type=module', '-e',
    `const m = await import('file://${webProfilePkg}/lib/index.js'); console.log('[preflight]', m.name, '|', JSON.stringify(m.inject))`],
  { cwd: profileDir, quiet: true })
  if (preflight.status === 0 && preflight.stdout.includes('dsh-serenity-hooks')) {
    console.log(preflight.stdout.trim())
  } else {
    console.error(`    preflight 尝试失败: ${(preflight.stderr || preflight.stdout).trim().slice(0, 400)}`)
    fail('预检失败（profile 目录无法加载插件）', 2)
  }

  console.log('\n==> 完成。重启 dsh web 使插件生效。')
}

/**
 * npm-install — 官方 npm 安装路径：`dsh plugin --profile web add @shgroup/dsh-serenity-hooks`。
 * 从 npm registry 拉取包（含 lib/client.js）并自动对账 profile bundles 层，取代旧的
 * deploy（复制本地目录）。安装后需 restart-web 生效。
 *
 * 版本解析：缺省或 `latest` → 查 registry 最新版本并显式 add @<latest>（绕过
 * package.json specifier 惰性——pnpm 对未变化 specifier 报 "Already up to date"，
 * 升级后 lock 会钉旧版）；显式版本（如 1.16.3）→ 按给定版本安装。
 * @param profile - profile 名（默认 web）。
 * @param version - 精确版本或 `latest`；缺省 = latest。
 */
/**
 * npm-install [profile] [version] [registry]
 *
 * `registry`（第三参，可选——v1.31.9 新增）：**只对本次安装的子进程**用
 * `npm_config_registry` 指向该源，**不改任何 .npmrc**。
 *
 * 为什么需要它（R↓，2026-09-10 实证）：profile 的 pnpm 走**部署方的内网 Nexus 镜像**
 * （来自用户级 `~/.npmrc` 的 `registry=`，此处不写具体主机名），
 * 其 **packument 带 ~24h TTL 缓存**——我们发布新版本比 TTL 快时，Nexus 仍报**上一版**为 latest →
 * `ERR_PNPM_NO_MATCHING_VERSION`（v1.31.8 / v1.31.9 连续两次撞墙）。
 * profile 目录**没有** `.npmrc`（源来自用户级文件，在 CCC 边界外，agent 无权写）。
 *
 * ⚠️ **实测边界（勿重复试）**：`npm_config_registry` 只对 **npm** 生效，对 `dsh plugin add` 内部的
 * **pnpm 不生效**——2026-09-10 实测：同一 env 下 `npm view` 正确返回 1.31.9，而 `dsh plugin add`
 * 仍从 Nexus 拉取并失败（pnpm 的源解析被更高优先级来源压过，疑似 DSH 以显式参数传入）。
 * 故本参数**只能**修正版本发现（`latest` 分支），**不能**救活 `dsh plugin add`。
 * 本地装新版的可行出路（按成本排序）：
 *   ① **`dsh-develop deploy`**（本地构建直写 profile，**不碰 npm**）← 2026-09-10 两次实际走通的路
 *   ② 用户级操作：在 `~/.dsh/profiles/<p>/` 建 `.npmrc` 写 `registry=https://registry.npmjs.org/`（CCC 边界外）
 *   ③ 刷 Nexus 缓存（需管理权限）/ 等 ~24h TTL 过期
 */
function cmdNpmInstall(profile = 'web', version?: string, registry?: string): void {
  const cliBin = join(process.env.HOME ?? '', '.npm-global', 'bin', 'dsh')
  const npmDsh = join(process.env.HOME ?? '', '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const bin = existsSync(npmDsh) ? npmDsh : cliBin
  if (!existsSync(bin)) fail(`dsh CLI 缺失: ${bin}`, 2)
  if (registry !== undefined && !/^https?:\/\//.test(registry)) fail(`registry 必须是 http(s) URL: ${registry}`, 2)
  const cache = join(process.env.HOME ?? '', '.cache', 'npm-publish')
  mkdirSync(cache, { recursive: true })
  const registryEnv = registry ? { npm_config_registry: registry } : {}

  // 解析目标版本：显式版本直接使用；缺省/latest 查 registry 最新版。
  let target = version
  if (target === undefined || target === 'latest') {
    const view = run('npm', ['view', '@shgroup/dsh-serenity-hooks', 'version'], {
      cwd: process.cwd(),
      quiet: true,
      env: { npm_config_cache: cache, NPM_CONFIG_CACHE: cache, ...registryEnv },
    })
    if (view.status !== 0) {
      console.error(view.stdout + view.stderr)
      fail(`npm view 最新版本失败 (exit ${view.status})`, 2)
    }
    target = view.stdout.trim().split('\n').pop() ?? ''
    if (target === '') fail('npm view 返回空版本', 2)
    console.log(`[dsh-develop] registry 最新版本: ${target}`)
  }
  const pkgSpec = `@shgroup/dsh-serenity-hooks@${target}`
  console.log(
    `[dsh-develop] npm 安装 ${pkgSpec} 到 profile '${profile}'（官方 dsh plugin add 路径）` +
      (registry ? `｜源覆盖: ${registry}` : ''),
  )
  const r = run(bin, ['plugin', '--profile', profile, 'add', pkgSpec], {
    cwd: process.cwd(),
    quiet: true,
    env: { npm_config_cache: cache, NPM_CONFIG_CACHE: cache, ...registryEnv },
  })
  if (r.status !== 0) {
    console.error(r.stdout + r.stderr)
    fail(`dsh plugin add 失败 (exit ${r.status})`, 2)
  }
  console.log(r.stdout.trim() || r.stderr.trim())
  console.log(`[dsh-develop] ✓ 已安装 ${pkgSpec}（npm registry）→ 重启 dsh web 生效（restart-web）`)
}

/**
 * npm-install-dev — 安装 hooks 开发依赖（v1.24.6：二维码绑定引入 qrcode-generator）。
 * 在 HOOKS_DIR 执行 `pnpm install --save-dev <pkgs>`（hooks 是 pnpm 项目——
 * pnpm-lock.yaml + .pnpm-store，npm 与 pnpm node_modules 布局冲突会崩）；
 * client bundle noExternal 全 true，第三方库内联进 lib/client.js（零运行时新依赖）；
 * devDependencies 记录可复现。
 */
function cmdNpmInstallDev(pkgs: string[]): void {
  if (pkgs.length === 0) fail('npm-install-dev 需要包名: dsh-develop npm-install-dev <pkg>[@version]...')
  console.log(`[dsh-develop] pnpm install --save-dev ${pkgs.join(' ')}（hooks）`)
  // store-dir 必须与既有 node_modules 链接一致（hooks/.pnpm-store/v11）——
  // pnpm 默认全局 store（~/.local/bin/store）与本地 store 冲突会 ERR_PNPM_UNEXPECTED_STORE
  const storeDir = join(HOOKS_DIR, '.pnpm-store')
  const r = run('pnpm', ['install', '--store-dir', storeDir, '--save-dev', ...pkgs], {
    cwd: HOOKS_DIR,
    quiet: true,
  })
  if (r.status !== 0) {
    console.error(r.stdout + r.stderr)
    fail(`pnpm install --save-dev 失败 (exit ${r.status})`, 2)
  }
  console.log(r.stdout.trim() || r.stderr.trim())
  console.log(`[dsh-develop] ✓ 已安装 devDeps: ${pkgs.join(', ')}（hooks/package.json）`)
}

// ── main 守卫 ──

if (import.meta.url === `file://${process.argv[1]}`) {
  const [sub, ...rest] = process.argv.slice(2)
  try {
    switch (sub) {
      case 'typecheck': cmdTypecheck(); break
      case 'typecheck-host': cmdTypecheckHost(rest[0]); break
      case 'test': {
        const fi = rest.indexOf('--filter')
        const filter = fi >= 0 ? rest[fi + 1] : undefined
        cmdTest(filter)
        break
      }
      case 'coverage': cmdCoverage(); break
      case 'build': cmdBuild(); break
      case 'status': cmdStatus(); break
      case 'commit': cmdCommit(rest[0]); break
      case 'push': cmdPush(); break
      case 'github-push': {
        const force = rest.includes('--force')
        cmdGithubPush(rest.find((a) => !a.startsWith('--')), force)
        break
      }
      case 'squash-history': cmdSquashHistory(rest[0]); break
      case 'publish': cmdPublish(); break
      case 'pack-check': verifyTarball(); break
      case 'readme-sync': syncPackageReadme(); break
      case 'github-push-repo': cmdGithubPushRepo(rest[0]); break
      case 'github-ls': cmdGithubLs(rest[0]); break
      case 'version': cmdVersion(); break
      case 'sys': {
        // 诊断：执行白名单系统命令（ps/ss/curl/lsof/xdg-open/zstd/git 等只读诊断）
        const [cmd, ...args] = rest
        if (!['ps', 'ss', 'curl', 'lsof', 'pgrep', 'pkill', 'kill', 'sleep', 'ss', 'date', 'ls', 'xdg-open', 'zstd', 'git'].includes(cmd ?? '')) {
          fail(`sys 仅允许白名单命令: ${cmd}`)
        }
        // curl 强制 --max-time（防无超时请求维持死锁；postmortem 2026-08-08）
        const curlArgs = cmd === 'curl' && !args.some((a) => a === '--max-time' || a === '-m')
          ? [...args, '--max-time', '5']
          : args
        const r = run(cmd, curlArgs, { cwd: process.cwd(), quiet: true })
        if (r.status !== 0 && cmd !== 'pkill') { console.error(r.stderr); process.exit(r.status) }
        console.log(r.stdout)
        break
      }
      case 'bump': cmdBump(rest[0]); break
      case 'deploy': cmdDeploy(); break
      case 'npm-install': cmdNpmInstall(rest[0] ?? 'web', rest[1], rest[2]); break
      case 'npm-install-dev': cmdNpmInstallDev(rest); break
      case 'restart-web': cmdRestartWeb(); break
      case 'api-status': cmdApiStatus(rest[0]); break
      case 'inspect-dsh': cmdInspectDsh(rest[0]); break
      case 'read-dsh': cmdReadDsh(rest[0], rest[1], rest[2]); break
      case 'host-fetch': cmdHostFetch(rest[0], rest.slice(1)); break
      case 'dump-config': cmdDumpConfig(rest[0]); break
      case '--list':
      case 'list':
        console.log('typecheck | typecheck-host <ver> | test [--filter] | coverage | build | status | commit <msg> | push | version | bump <ver> | deploy | npm-install [<profile>] [<version>] [<registry>] | restart-web | squash-history [<msg>] | github-push [--force] | pack-check | readme-sync | publish | inspect-dsh <pattern> | host-fetch <ver> [pkg[@ver]]')
        break
      case '--schema': {
        const target = rest[0] ?? 'dsh-develop'
        console.log(JSON.stringify({
          name: 'dsh-develop',
          path: 'AI_LAB/dsh-serenity-plugin/scripts/dsh-develop.ts',
          flags: [
            { name: 'filter', type: 'string', description: 'vitest 过滤（test）' },
            { name: 'message', type: 'string', description: 'commit 消息' },
            { name: 'version', type: 'string', description: 'bump 版本号 x.y.z' },
          ],
        }, null, 2))
        break
      }
      case '--help':
      case '-h':
      case undefined:
        console.log(`dsh-develop — dsh-serenity-plugin 开发操作 MSM（safe-mode 白名单通道）
用法: dsh-develop <typecheck|test|coverage|build|status|commit|push|version|bump|deploy|npm-install|restart-web|pack-check|readme-sync|publish|github-push|squash-history> [args]
  typecheck             tsc --noEmit
  test [--filter <p>]   vitest run
  coverage              vitest run --coverage（阈值门禁见 vitest.config.ts）
  build                 tsc + tsdown 双 bundle
  status                git status + 版本
  commit <message>      git add -A + commit
  push                  git push origin（GitHub，SSH-443）
  version               三处版本一致性
  bump <x.y.z>          package.json + dsh.plugin.json 版本同步
  deploy                load-plugin.sh 全流程（构建+双锚+shim+profile+预检）
  npm-install [profile] [version] 官方 npm 安装：缺省/latest=registry 最新；可指定精确版本
  npm-install-dev <pkg...> hooks 开发依赖安装（npm install --save-dev；client bundle 内联）
  restart-web           kill + setsid 重启 dsh web（健康检查）
  squash-history [msg]  抹除历史为单个初始 commit（公开发布前清敏感历史；不可逆）
  pack-check            npm pack --dry-run 核对 tarball 完整性（chunk/双 bundle/类型）
  readme-sync           包内 README ← 仓库 README（机械同步，相对链接转绝对 URL）
  dump-config [pattern] dsh --dump-config（合成后的 profile 条目树；pattern 过滤）
  publish               npm publish @shgroup/dsh-serenity-hooks（凭据走 ~/.npmrc）
  github-push [--force] push 到 GitHub 公开仓库（tellmewhattodo）`)
        break
      default:
        fail(`未知子命令: ${sub}`)
    }
  } catch (e) {
    fail((e as Error).message, 2)
  }
}
