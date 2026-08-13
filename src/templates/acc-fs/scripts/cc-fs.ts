#!/usr/bin/env bun
/**
 * cc-fs.ts — 文件系统操作（cc-fs 语义，DSH 版）
 *
 * 自包含实现（零三方依赖）。全部路径限定在 CCC 根内，路径逃逸自动阻断。
 *
 * 用法：
 *   bun cc-fs.ts <root|resolve|exists|list|tree|relative|mkdir|rm|mv|cp|touch|append|info|find> [args...]
 *
 * 退出码：
 *   0 — 成功
 *   1 — user（缺参数 / 未知子命令）
 *   2 — system（无 CCC / 路径逃逸 / IO 失败）
 */

import {
  existsSync,
  statSync,
  mkdirSync,
  rmSync,
  renameSync,
  cpSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { resolve, dirname, relative, join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

// ── 路径守卫（自包含）──

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

export function classifyPath(p: string, root: string): 'inside' | 'outside' | 'same' {
  const rel = relative(resolve(root), resolve(p));
  if (rel === '') return 'same';
  if (rel.startsWith('..')) return 'outside';
  return 'inside';
}

export function resolveInside(root: string, p: string): string {
  const abs = resolve(root, p);
  if (classifyPath(abs, root) === 'outside') {
    throw new Error(`Path escape blocked: "${p}" resolves outside "${root}"`);
  }
  return abs;
}

export function assertNoSymlinkEscape(abs: string, root: string): void {
  if (!existsSync(abs)) return;
  const real = realpathSync(abs);
  if (classifyPath(real, root) === 'outside') {
    throw new Error(`Symlink escape blocked: "${abs}" -> "${real}"`);
  }
}

// ── 子命令 ──

export function cmdRoot(root: string): number {
  console.log(root);
  return 0;
}

export function cmdResolve(root: string, args: string[]): number {
  if (!args[0]) throw new Error('resolve 需要路径参数');
  const abs = resolveInside(root, args[0]);
  console.log(JSON.stringify({ absolute: abs }));
  return 0;
}

export function cmdExists(root: string, args: string[]): number {
  if (!args[0]) throw new Error('exists 需要路径参数');
  const abs = resolveInside(root, args[0]);
  console.log(JSON.stringify({ exists: existsSync(abs) }));
  return 0;
}

export function cmdList(root: string, args: string[]): number {
  const dir = args[0] ? resolveInside(root, args[0]) : root;
  if (!existsSync(dir)) throw new Error(`no such dir: ${dir}`);
  const entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({
    name: e.name,
    type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other',
  }));
  console.log(JSON.stringify(entries, null, 2));
  return 0;
}

export function cmdTree(root: string, args: string[]): number {
  const dir = args[0] ? resolveInside(root, args[0]) : root;
  const depthFlag = args.findIndex((a) => a === '--depth');
  const maxDepth = depthFlag >= 0 ? Number(args[depthFlag + 1]) : Infinity;
  if (!existsSync(dir)) throw new Error(`no such dir: ${dir}`);
  const out: { path: string; type: string }[] = [];
  const walk = (cur: string, depth: number) => {
    if (depth > maxDepth) return;
    for (const e of readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, e.name);
      const rel = relative(root, full) || '.';
      out.push({ path: rel, type: e.isDirectory() ? 'dir' : 'file' });
      if (e.isDirectory()) walk(full, depth + 1);
    }
  };
  walk(dir, 0);
  console.log(JSON.stringify(out, null, 2));
  return 0;
}

export function cmdRelative(root: string, args: string[]): number {
  if (!args[0]) throw new Error('relative 需要路径参数');
  const abs = resolve(root, args[0]);
  if (classifyPath(abs, root) === 'outside') throw new Error(`Path escape blocked: "${args[0]}"`);
  console.log(JSON.stringify({ relative: relative(root, abs) }));
  return 0;
}

export function cmdMkdir(root: string, args: string[]): number {
  if (args.length === 0) throw new Error('mkdir 需要目录参数');
  for (const a of args) {
    const abs = resolveInside(root, a);
    mkdirSync(abs, { recursive: true });
    console.log(`mkdir: ${relative(root, abs) || '.'}`);
  }
  return 0;
}

export function cmdRm(root: string, args: string[]): number {
  const dryRun = args.includes('--dry-run');
  const paths = args.filter((a) => a !== '--dry-run');
  if (paths.length === 0) throw new Error('rm 需要路径参数');
  for (const a of paths) {
    const abs = resolveInside(root, a);
    if (abs === root) throw new Error('拒绝删除 CCC 根本身');
    if (!existsSync(abs)) {
      console.log(`rm: skip (missing) ${a}`);
      continue;
    }
    if (dryRun) {
      console.log(`rm: [dry-run] ${a}`);
      continue;
    }
    rmSync(abs, { recursive: true, force: true });
    console.log(`rm: ${a}`);
  }
  return 0;
}

export function cmdMv(root: string, args: string[]): number {
  if (args.length < 2) throw new Error('mv 需要 <src> <dst>');
  const src = resolveInside(root, args[0]!);
  const dst = resolveInside(root, args[1]!);
  renameSync(src, dst);
  console.log(`mv: ${args[0]} -> ${args[1]}`);
  return 0;
}

export function cmdCp(root: string, args: string[]): number {
  if (args.length < 2) throw new Error('cp 需要 <src> <dst>');
  const src = resolveInside(root, args[0]!);
  const dst = resolveInside(root, args[1]!);
  cpSync(src, dst, { recursive: true });
  console.log(`cp: ${args[0]} -> ${args[1]}`);
  return 0;
}

export function cmdTouch(root: string, args: string[]): number {
  if (!args[0]) throw new Error('touch 需要文件参数');
  const abs = resolveInside(root, args[0]);
  if (!existsSync(abs)) writeFileSync(abs, '', 'utf-8');
  console.log(`touch: ${args[0]}`);
  return 0;
}

export function cmdAppend(root: string, args: string[]): number {
  if (args.length < 2) throw new Error('append 需要 <file> <content>');
  const abs = resolveInside(root, args[0]!);
  appendFileSync(abs, args[1]!, 'utf-8');
  console.log(`append: ${args[0]}`);
  return 0;
}

export function cmdInfo(root: string, args: string[]): number {
  if (!args[0]) throw new Error('info 需要路径参数');
  const abs = resolveInside(root, args[0]);
  if (!existsSync(abs)) {
    console.log(JSON.stringify({ exists: false, path: relative(root, abs) }));
    return 0;
  }
  const st = statSync(abs);
  console.log(
    JSON.stringify(
      {
        exists: true,
        path: relative(root, abs),
        type: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other',
        size: st.size,
        mtime: st.mtime.toISOString(),
      },
      null,
      2,
    ),
  );
  return 0;
}

export function cmdFind(root: string, args: string[]): number {
  if (!args[0]) throw new Error('find 需要 pattern');
  const pattern = args[0];
  const isRegex = pattern.startsWith('regex:');
  const re = isRegex ? new RegExp(pattern.slice(6)) : null;
  const out: string[] = [];
  const walk = (cur: string) => {
    for (const e of readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, e.name);
      const hit = isRegex ? re!.test(e.name) : e.name.includes(pattern);
      if (hit) out.push(relative(root, full));
      if (e.isDirectory()) walk(full);
    }
  };
  walk(root);
  console.log(JSON.stringify(out, null, 2));
  return 0;
}

// ── run ──

export function run(argv: string[]): number {
  const root = findSerenityRoot(process.cwd());
  if (!root) {
    console.error('No CCC found: no .serenity file from cwd. 请在 CCC 根内运行。');
    return 2;
  }
  const sub = argv[0];
  const args = argv.slice(1);
  try {
    switch (sub) {
      case 'root':
        return cmdRoot(root);
      case 'resolve':
        return cmdResolve(root, args);
      case 'exists':
        return cmdExists(root, args);
      case 'list':
        return cmdList(root, args);
      case 'tree':
        return cmdTree(root, args);
      case 'relative':
        return cmdRelative(root, args);
      case 'mkdir':
        return cmdMkdir(root, args);
      case 'rm':
        return cmdRm(root, args);
      case 'mv':
        return cmdMv(root, args);
      case 'cp':
        return cmdCp(root, args);
      case 'touch':
        return cmdTouch(root, args);
      case 'append':
        return cmdAppend(root, args);
      case 'info':
        return cmdInfo(root, args);
      case 'find':
        return cmdFind(root, args);
      default:
        console.error('usage: cc-fs.ts <root|resolve|exists|list|tree|relative|mkdir|rm|mv|cp|touch|append|info|find> [args...]');
        return 1;
    }
  } catch (err: any) {
    console.error(`[cc-fs] ${err.message ?? err}`);
    return 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  process.exit(run(process.argv.slice(2)));
}
