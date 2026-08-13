#!/usr/bin/env bun
/**
 * acc-kit.ts — ACC 通用能力工具包（health/time/wait）
 *
 * 自包含实现（DSH 侧独立，不复用 opencode-serenity-plugin 源码）。
 * 零三方依赖（仅 node 内置模块）。
 *
 * 用法：
 *   bun acc-kit.ts health
 *   bun acc-kit.ts time
 *   bun acc-kit.ts wait <seconds>
 *
 * 退出码：
 *   0 — 成功
 *   1 — user（缺参数 / 未知子命令 / 非数字秒数）
 *   2 — system（health 检查失败）
 */

import { existsSync, statSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

// ── 路径工具（自包含）──

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

export function findGitRoot(cwd: string): string | null {
  let current = resolve(cwd);
  while (true) {
    if (existsSync(resolve(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// ── health ──

export function cmdHealth(cwd: string): number {
  const serenityRoot = findSerenityRoot(cwd);
  const gitRoot = findGitRoot(cwd);

  let config: unknown = null;
  let configPath: string | null = null;
  if (serenityRoot) {
    for (const candidate of ['.dsh/serenity.json', '.opencode/serenity.json']) {
      const p = resolve(serenityRoot, candidate);
      if (existsSync(p)) {
        try {
          config = JSON.parse(readFileSync(p, 'utf-8'));
          configPath = p;
        } catch {
          config = { parseError: true };
          configPath = p;
        }
        break;
      }
    }
  }

  const result = {
    cwd: resolve(cwd),
    serenityRoot, // P1
    gitRoot,      // P2
    config,
    configPath,
    p1: serenityRoot !== null,
    p2: gitRoot !== null,
    p3: 'enforced-by-dsh-fs-sandbox', // P3：DSH fs 沙箱原生执行
  };
  console.log(JSON.stringify(result, null, 2));
  return result.p1 && result.p2 ? 0 : 2;
}

// ── time ──

export function cmdTime(): number {
  console.log(new Date().toISOString());
  return 0;
}

// ── wait ──

export function cmdWait(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) return 1;
  execFileSync('sleep', [String(seconds)], { stdio: 'inherit' });
  return 0;
}

// ── run ──

export function run(argv: string[]): number {
  const sub = argv[0];
  switch (sub) {
    case 'health':
      return cmdHealth(process.cwd());
    case 'time':
      return cmdTime();
    case 'wait': {
      const n = Number(argv[1]);
      if (!Number.isFinite(n) || n < 0) {
        console.error('usage: acc-kit.ts wait <seconds>');
        return 1;
      }
      return cmdWait(n);
    }
    default:
      console.error('usage: acc-kit.ts <health|time|wait>');
      return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  process.exit(run(process.argv.slice(2)));
}
