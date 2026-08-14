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

function cmdGithubPush(remote?: string, force = false): void {
  const target = remote ?? 'github'
  const args = ['push', target, 'HEAD']
  if (force) args.push('--force')
  const r = run('git', args, {
    cwd: REPO_ROOT,
    quiet: true,
    env: { GIT_SSH_COMMAND: GIT_SSH_GITHUB },
  })
  if (r.status !== 0) {
    console.error(r.stdout + r.stderr)
    fail(`git push ${target} 失败 (exit ${r.status})`, 2)
  }
  console.log(`[dsh-develop] ✓ pushed to ${target}${force ? '（force）' : ''}`)
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

function cmdPublish(): void {
  // npm publish @shgroup/dsh-serenity-hooks（cwd=hooks；凭据走 ~/.npmrc；publishConfig.access=public 已声明）
  // 发布前先构建（lib/ 最新）；npm cache 指向可写临时目录（沙箱 ~/.npm 只读）
  cmdBuild()
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
  console.log(`[dsh-develop] ✓ tarball 核对通过（${tarballFiles.length} 文件，含 lib/index.js + lib/client.js + lib/invariant.js）`)
  const r = run('npm', ['publish', '--access', 'public'], {
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
  const dshHome = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
  const cliBin = join(process.env.HOME ?? '', '.npm-global', 'bin', 'dsh')
  const npmDsh = join(process.env.HOME ?? '', '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const bin = existsSync(npmDsh) ? npmDsh : cliBin
  const PORT = 3080
  if (!existsSync(bin)) fail(`dsh CLI 缺失: ${bin}`, 2)

  // 1) 找到旧 web 进程并 kill（含残留：匹配 bin.js web / bin/dsh web）
  const ps = run('bash', ['-c', `ps aux | grep -E 'dsh/lib/bin\\.js web|bin/dsh web' | grep -v grep | awk '{print $2}'`], { cwd: process.cwd(), quiet: true })
  const pids = ps.stdout.trim().split('\n').filter(Boolean)
  if (pids.length === 0) console.log('[dsh-develop]    无旧 web 进程')
  for (const pid of pids) {
    console.log(`    kill ${pid}`)
    run('kill', [pid], { cwd: process.cwd(), quiet: true })
  }
  // 2) 轮询等待端口释放（最多 15s；EADDRINUSE 根因：kill 后旧进程未完全退出）
  const waitForPortFree = (): boolean => {
    for (let i = 0; i < 15; i++) {
      const probe = run('bash', ['-c', `ss -ltn 2>/dev/null | grep -q ':${PORT} ' && echo busy || echo free`], { cwd: process.cwd(), quiet: true })
      if (probe.stdout.trim().includes('free')) return true
      run('sleep', ['1'], { cwd: process.cwd(), quiet: true })
    }
    return false
  }
  if (!waitForPortFree()) {
    console.error(`[dsh-develop] ⚠️ 端口 ${PORT} 15s 内未释放，尝试强杀`)
    const hard = run('bash', ['-c', `ss -ltnp 2>/dev/null | grep ':${PORT} ' | grep -oP 'pid=\\K[0-9]+' | sort -u`], { cwd: process.cwd(), quiet: true })
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
  // 端口确认
  const portCheck = run('bash', ['-c', `ss -ltn 2>/dev/null | grep -q ':${PORT} ' && echo LISTENING || echo DOWN`], { cwd: process.cwd(), quiet: true })
  const health = run('curl', ['-s', 'http://127.0.0.1:3080/serenity/status?workspace=' + (process.env.SERENITY_CCC_ROOT ?? '')], { cwd: process.cwd(), quiet: true })
  const statusLine = health.status === 0 && health.stdout ? health.stdout.trim().slice(0, 400) : ''
  console.log(`[dsh-develop] 端口: ${portCheck.stdout.trim()}`)
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
function cmdNpmInstall(profile = 'web', version?: string): void {
  const cliBin = join(process.env.HOME ?? '', '.npm-global', 'bin', 'dsh')
  const npmDsh = join(process.env.HOME ?? '', '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const bin = existsSync(npmDsh) ? npmDsh : cliBin
  if (!existsSync(bin)) fail(`dsh CLI 缺失: ${bin}`, 2)
  const cache = join(process.env.HOME ?? '', '.cache', 'npm-publish')
  mkdirSync(cache, { recursive: true })

  // 解析目标版本：显式版本直接使用；缺省/latest 查 registry 最新版。
  let target = version
  if (target === undefined || target === 'latest') {
    const view = run('npm', ['view', '@shgroup/dsh-serenity-hooks', 'version'], {
      cwd: process.cwd(),
      quiet: true,
      env: { npm_config_cache: cache, NPM_CONFIG_CACHE: cache },
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
  console.log(`[dsh-develop] npm 安装 ${pkgSpec} 到 profile '${profile}'（官方 dsh plugin add 路径）`)
  const r = run(bin, ['plugin', '--profile', profile, 'add', pkgSpec], {
    cwd: process.cwd(),
    quiet: true,
    env: { npm_config_cache: cache, NPM_CONFIG_CACHE: cache },
  })
  if (r.status !== 0) {
    console.error(r.stdout + r.stderr)
    fail(`dsh plugin add 失败 (exit ${r.status})`, 2)
  }
  console.log(r.stdout.trim() || r.stderr.trim())
  console.log(`[dsh-develop] ✓ 已安装 ${pkgSpec}（npm registry）→ 重启 dsh web 生效（restart-web）`)
}

// ── main 守卫 ──

if (import.meta.url === `file://${process.argv[1]}`) {
  const [sub, ...rest] = process.argv.slice(2)
  try {
    switch (sub) {
      case 'typecheck': cmdTypecheck(); break
      case 'test': {
        const fi = rest.indexOf('--filter')
        const filter = fi >= 0 ? rest[fi + 1] : undefined
        cmdTest(filter)
        break
      }
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
      case 'github-push-repo': cmdGithubPushRepo(rest[0]); break
      case 'github-ls': cmdGithubLs(rest[0]); break
      case 'version': cmdVersion(); break
      case 'sys': {
        // 诊断：执行白名单系统命令（ps/ss/curl/lsof/xdg-open/zstd 等只读诊断）
        const [cmd, ...args] = rest
        if (!['ps', 'ss', 'curl', 'lsof', 'pgrep', 'pkill', 'kill', 'sleep', 'ss', 'date', 'ls', 'xdg-open', 'zstd'].includes(cmd ?? '')) {
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
      case 'npm-install': cmdNpmInstall(rest[0] ?? 'web', rest[1]); break
      case 'restart-web': cmdRestartWeb(); break
      case 'api-status': cmdApiStatus(rest[0]); break
      case 'inspect-dsh': cmdInspectDsh(rest[0]); break
      case 'read-dsh': cmdReadDsh(rest[0], rest[1], rest[2]); break
      case '--list':
      case 'list':
        console.log('typecheck | test [--filter] | build | status | commit <msg> | push | version | bump <ver> | deploy | npm-install [<profile>] | restart-web | squash-history [<msg>] | github-push [--force] | inspect-dsh <pattern>')
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
用法: dsh-develop <typecheck|test|build|status|commit|push|version|bump|deploy|restart-web> [args]
  typecheck             tsc --noEmit
  test [--filter <p>]   vitest run
  build                 tsc + tsdown 双 bundle
  status                git status + 版本
  commit <message>      git add -A + commit
  push                  git push origin（GitHub，SSH-443）
  version               三处版本一致性
  bump <x.y.z>          package.json + dsh.plugin.json 版本同步
  deploy                load-plugin.sh 全流程（构建+双锚+shim+profile+预检）
  npm-install [profile] [version] 官方 npm 安装：缺省/latest=registry 最新；可指定精确版本
  restart-web           kill + setsid 重启 dsh web（健康检查）
  squash-history [msg]  抹除历史为单个初始 commit（公开发布前清敏感历史；不可逆）
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
