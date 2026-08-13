#!/usr/bin/env bun
/**
 * cc-git.ts — CCC 内 git 操作（cc-git 语义，DSH 版）
 *
 * 自包含实现（零三方依赖）。git 命令 cwd 钉在 CCC 根。
 *
 * 用法：
 *   bun cc-git.ts status
 *   bun cc-git.ts commit -m <msg>
 *   bun cc-git.ts push
 *   bun cc-git.ts log [-n <count>]
 *
 * 退出码：
 *   0 — 成功
 *   1 — user（缺参数 / commit 无消息）
 *   2 — system（非 git 仓库 / git 失败 / push 被拒）
 */

import { existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

// ── 工具 ──

export function findSerenityRoot(cwd: string): string | null {
  let current = resolve(cwd);
  while (true) {
    const marker = resolve(current, '.serenity');
    if (existsSync(marker) && statSync(marker).isFile()) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function git(root: string, args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('git', args, { cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { status: 0, stdout, stderr: '' };
  } catch (err: any) {
    return {
      status: err.status ?? 2,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
    };
  }
}

// ── 子命令 ──

export function cmdStatus(root: string): number {
  const r = git(root, ['status', '--porcelain']);
  process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) {
    console.error('[cc-git] status 失败：可能不是 git 仓库');
    return 2;
  }
  if (r.stdout.trim() === '') console.log('(clean)');
  return 0;
}

export function cmdCommit(root: string, args: string[]): number {
  const mIdx = args.indexOf('-m');
  const msg = mIdx >= 0 ? args[mIdx + 1] : null;
  if (!msg) {
    console.error('commit 需要 -m <msg>');
    return 1;
  }
  const add = git(root, ['add', '-A']);
  if (add.status !== 0) {
    process.stderr.write(add.stderr);
    return 2;
  }
  const commit = git(root, ['commit', '-m', msg]);
  process.stdout.write(commit.stdout);
  if (commit.stderr) process.stderr.write(commit.stderr);
  if (commit.status !== 0) {
    if (commit.stderr.includes('nothing to commit')) {
      console.log('(nothing to commit)');
      return 0;
    }
    return 2;
  }
  return 0;
}

export function cmdPush(root: string): number {
  const r = git(root, ['push', 'origin', 'HEAD']);
  process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) {
    const isNonFF = /non-fast-forward|rejected|fetch first|被拒绝/i.test(r.stderr);
    if (isNonFF) {
      console.error(`
push rejected (non-fast-forward)
建议：
  1. git pull --rebase   # 先合并远程变更
  2. 重新 push
  3. 若确需覆盖远程：git push --force-with-lease（人工确认后）`);
    }
    return 2;
  }
  return 0;
}

export function cmdLog(root: string, args: string[]): number {
  let count = 10;
  const nIdx = args.indexOf('-n');
  if (nIdx >= 0) count = Number(args[nIdx + 1]) || 10;
  const r = git(root, ['log', '--oneline', '-n', String(count)]);
  process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r.status === 0 ? 0 : 2;
}

// ── run ──

export function run(argv: string[]): number {
  const root = findSerenityRoot(process.cwd());
  if (!root) {
    console.error('No CCC found: no .serenity file from cwd. 请在 CCC 根内运行。');
    return 2;
  }
  const sub = argv[0];
  switch (sub) {
    case 'status':
      return cmdStatus(root);
    case 'commit':
      return cmdCommit(root, argv.slice(1));
    case 'push':
      return cmdPush(root);
    case 'log':
      return cmdLog(root, argv.slice(1));
    default:
      console.error('usage: cc-git.ts <status|commit|push|log> [args...]');
      return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  process.exit(run(process.argv.slice(2)));
}
