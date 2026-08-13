#!/usr/bin/env bun
/**
 * safe-mode.ts — 安全模式协议（safe-mode 语义，DSH 版）
 *
 * 自包含实现（零三方依赖）。控制 .serenity-safe-on 标记 + 黑名单检查。
 * 黑名单规则来自 CCC 的 .dsh/serenity.json（回退 .opencode/serenity.json）safeMode.blacklist。
 *
 * 用法：
 *   bun safe-mode.ts on
 *   bun safe-mode.ts off
 *   bun safe-mode.ts status
 *   bun safe-mode.ts check <relative-path>
 *
 * 退出码：0 成功 / 1 user / 2 system（check 命中黑名单）
 */

import { existsSync, statSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const MARKER = '.serenity-safe-on';

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

export function readBlacklist(root: string): string[] {
  for (const candidate of ['.dsh/serenity.json', '.opencode/serenity.json']) {
    const p = resolve(root, candidate);
    if (!existsSync(p)) continue;
    try {
      const cfg = JSON.parse(readFileSync(p, 'utf-8'));
      const rules = cfg?.safeMode?.blacklist;
      if (Array.isArray(rules)) return rules.map(String);
      return [];
    } catch {
      return [];
    }
  }
  return [];
}

export function isSafeModeOn(root: string): boolean {
  return existsSync(resolve(root, MARKER));
}

/** 检查相对路径是否命中黑名单；命中返回匹配规则，未命中返回 null */
export function matchBlacklist(relPath: string, rules: string[]): string | null {
  for (const rule of rules) {
    if (rule.startsWith('regex:')) {
      try {
        if (new RegExp(rule.slice(6)).test(relPath)) return rule;
      } catch {
        /* 非法正则跳过 */
      }
    } else if (relPath.startsWith(rule)) {
      return rule;
    }
  }
  return null;
}

// ── 子命令 ──

export function cmdOn(root: string): number {
  const marker = resolve(root, MARKER);
  if (existsSync(marker)) {
    console.log('safe mode already ON');
    return 0;
  }
  writeFileSync(marker, new Date().toISOString() + '\n', 'utf-8');
  console.log('safe mode ON（已创建 .serenity-safe-on）');
  return 0;
}

export function cmdOff(root: string): number {
  const marker = resolve(root, MARKER);
  if (!existsSync(marker)) {
    console.log('safe mode already OFF');
    return 0;
  }
  rmSync(marker, { force: true });
  console.log('safe mode OFF（已删除 .serenity-safe-on）');
  return 0;
}

export function cmdStatus(root: string): number {
  const rules = readBlacklist(root);
  const result = {
    on: isSafeModeOn(root),
    marker: resolve(root, MARKER),
    blacklist: rules,
  };
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

export function cmdCheck(root: string, args: string[]): number {
  const target = args[0];
  if (!target) {
    console.error('check 需要 <relative-path>');
    return 1;
  }
  if (!isSafeModeOn(root)) {
    console.log(JSON.stringify({ safeMode: false, blocked: false, reason: 'safe mode off' }));
    return 0;
  }
  const abs = resolve(root, target);
  const rel = relative(root, abs);
  if (rel.startsWith('..')) {
    console.log(JSON.stringify({ safeMode: true, blocked: true, reason: 'outside CCC root' }));
    return 2;
  }
  const hit = matchBlacklist(rel, readBlacklist(root));
  if (hit) {
    console.log(JSON.stringify({ safeMode: true, blocked: true, rule: hit, path: rel }));
    return 2;
  }
  console.log(JSON.stringify({ safeMode: true, blocked: false, path: rel }));
  return 0;
}

// ── run ──

export function run(argv: string[]): number {
  const root = findSerenityRoot(process.cwd());
  if (!root) {
    console.error('No CCC found: no .serenity file from cwd. 请在 CCC 根内运行。');
    return 2;
  }
  switch (argv[0]) {
    case 'on':
      return cmdOn(root);
    case 'off':
      return cmdOff(root);
    case 'status':
      return cmdStatus(root);
    case 'check':
      return cmdCheck(root, argv.slice(1));
    default:
      console.error('usage: safe-mode.ts <on|off|status|check>');
      return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  process.exit(run(process.argv.slice(2)));
}
