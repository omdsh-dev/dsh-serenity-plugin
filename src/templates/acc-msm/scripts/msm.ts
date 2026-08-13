#!/usr/bin/env bun
/**
 * msm.ts — MSM 框架（msm_list/exec/admin 语义，DSH 版）
 *
 * 自包含实现（零三方依赖）。读取 CCC 的 mech-registry.json（v1 或数组格式），
 * 执行/管理 MSM。cwd 钉在 CCC 根，path-arg 逃逸阻断，600s 超时。
 *
 * 用法：
 *   bun msm.ts list
 *   bun msm.ts exec <name> [args...] [--format=json]
 *   bun msm.ts admin register <name> --skill <s> --path <script> --category <c> --description <d>
 *   bun msm.ts admin deregister <name>
 *   bun msm.ts admin check
 *
 * 退出码：0 成功 / 1 user / 2 system / 3 operator（业务 MSM 非 0）
 */

import {
  existsSync,
  statSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve, dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const TIMEOUT_MS = 600_000;

// ── 路径工具 ──

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

// ── 注册表 ──

export interface MsmFlag {
  name: string;
  type?: string;
  description?: string;
  required?: boolean;
  default?: unknown;
}

export interface MsmEntry {
  name: string;
  path: string;
  skill?: string;
  category?: string;
  description?: string;
  usage?: string;
  flags?: MsmFlag[];
}

interface RegistryFile {
  version?: number;
  description?: string;
  entries: MsmEntry[];
}

export function parseRegistry(raw: string): MsmEntry[] {
  const data = JSON.parse(raw);
  if (Array.isArray(data)) return data as MsmEntry[];
  const entries = (data as RegistryFile).entries;
  if (!Array.isArray(entries)) throw new Error('invalid registry: missing entries[]');
  return entries as MsmEntry[];
}

export function findRegistries(root: string): string[] {
  const out: string[] = [];
  const skillsDir = join(root, '.opencode', 'skills');
  if (existsSync(skillsDir)) {
    for (const skill of readdirSync(skillsDir)) {
      const p = join(skillsDir, skill, 'references', 'mech-registry.json');
      if (existsSync(p)) out.push(p);
    }
  }
  const rootRegistry = join(root, 'mech-registry.json');
  if (existsSync(rootRegistry)) out.push(rootRegistry);
  return out;
}

export function loadMsmEntries(root: string): MsmEntry[] {
  const byName = new Map<string, MsmEntry>();
  for (const regPath of findRegistries(root)) {
    for (const entry of parseRegistry(readFileSync(regPath, 'utf-8'))) {
      if (!byName.has(entry.name)) byName.set(entry.name, entry);
    }
  }
  return [...byName.values()];
}

export function findEntry(root: string, name: string): MsmEntry | null {
  return loadMsmEntries(root).find((e) => e.name === name) ?? null;
}

// ── list ──

export function cmdList(root: string): number {
  const entries = loadMsmEntries(root);
  if (entries.length === 0) {
    console.log('(no MSM registered)');
    return 0;
  }
  for (const e of entries) {
    console.log(`${e.name}  [${e.category ?? '?'}]  ${e.skill ?? ''}  — ${e.description ?? ''}`);
  }
  return 0;
}

// ── exec ──

export function validatePathArgs(root: string, entry: MsmEntry, args: string[]): void {
  const pathFlags = (entry.flags ?? []).filter((f) => f.type === 'path');
  if (pathFlags.length === 0) return;
  for (const f of pathFlags) {
    const idx = args.indexOf(`--${f.name}`);
    if (idx >= 0 && args[idx + 1]) {
      const value = args[idx + 1]!;
      if (classifyPath(resolve(root, value), root) === 'outside') {
        throw new Error(`Path escape blocked: flag --${f.name} value "${value}"`);
      }
    }
    const eq = args.find((a) => a.startsWith(`--${f.name}=`));
    if (eq) {
      const value = eq.slice(f.name.length + 3);
      if (classifyPath(resolve(root, value), root) === 'outside') {
        throw new Error(`Path escape blocked: flag --${f.name} value "${value}"`);
      }
    }
  }
}

export function resolveScriptPath(root: string, entry: MsmEntry): string {
  const abs = resolve(root, entry.path);
  if (classifyPath(abs, root) === 'outside') {
    throw new Error(`MSM script escapes CCC root: "${entry.path}"`);
  }
  if (!existsSync(abs)) {
    throw new Error(`MSM script not found: "${entry.path}"`);
  }
  return abs;
}

export function execMsm(root: string, name: string, args: string[]): number {
  const entry = findEntry(root, name);
  if (!entry) {
    console.error(`MSM not registered: "${name}"（先 msm admin register 或检查 mech-registry.json）`);
    return 1;
  }
  const fmtJson = args.includes('--format=json');
  const businessArgs = args.filter((a) => a !== '--format=json');

  let script: string;
  try {
    validatePathArgs(root, entry, businessArgs);
    script = resolveScriptPath(root, entry);
  } catch (err: any) {
    console.error(`[msm] ${err.message ?? err}`);
    return 2;
  }

  // 运行时选择：bun（可直跑 TS）优先，npx tsx 回退
  const run = (): { status: number; stdout: string; stderr: string } => {
    const r = spawnSync('bun', [script, ...businessArgs], {
      cwd: root,
      encoding: 'utf-8',
      timeout: TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') {
      // bun 不存在 → 回退 npx tsx
      const r2 = spawnSync('npx', ['tsx', script, ...businessArgs], {
        cwd: root,
        encoding: 'utf-8',
        timeout: TIMEOUT_MS,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { status: r2.status ?? 2, stdout: r2.stdout ?? '', stderr: r2.stderr ?? '' };
    }
    return { status: r.status ?? 2, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };

  const r = run();
  if (fmtJson) {
    if (r.status === 0) {
      console.log(JSON.stringify({ ok: true, exit: 0, data: r.stdout.trim() }));
    } else {
      console.log(JSON.stringify({ ok: false, exit: r.status, error: r.stderr.trim() || r.stdout.trim() }));
      return 3;
    }
    return 0;
  }
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  return r.status === 0 ? 0 : 3;
}

// ── admin ──

export function registryPathFor(root: string, skill?: string): string {
  if (skill) {
    return join(root, '.opencode', 'skills', skill, 'references', 'mech-registry.json');
  }
  return join(root, 'mech-registry.json');
}

export function readOrInitRegistry(root: string, skill?: string): { path: string; entries: MsmEntry[] } {
  const path = registryPathFor(root, skill);
  if (!existsSync(path)) {
    return { path, entries: [] };
  }
  return { path, entries: parseRegistry(readFileSync(path, 'utf-8')) };
}

export function writeRegistry(path: string, entries: MsmEntry[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const data = { version: 1, description: 'MSM registry (managed by acc-msm / dsh-serenity-plugin)', entries };
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

export function gitCommit(root: string, message: string): void {
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', message], { cwd: root, stdio: 'pipe' });
}

export function cmdRegister(root: string, args: string[]): number {
  const name = args[0];
  if (!name) {
    console.error('register 需要 <name>');
    return 1;
  }
  const pick = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1]! : null;
  };
  const skill = pick('--skill');
  const path = pick('--path');
  const category = pick('--category');
  const description = pick('--description');
  if (!path || !category || !description) {
    console.error('register 需要 --skill <s> --path <script> --category <mech|semi-mech> --description <desc>');
    return 1;
  }
  const { path: regPath, entries } = readOrInitRegistry(root, skill ?? undefined);
  if (entries.some((e) => e.name === name)) {
    console.error(`MSM already registered: "${name}"`);
    return 1;
  }
  entries.push({
    name,
    path,
    skill: skill ?? undefined,
    category,
    description,
    usage: `msm_exec ${name} [args...]`,
    flags: [],
  });
  writeRegistry(regPath, entries);
  try {
    gitCommit(root, `msm: register ${name}`);
    console.log(`registered: ${name} -> ${regPath}`);
  } catch {
    console.log(`registered: ${name} -> ${regPath}（git commit 失败，请手动提交）`);
  }
  return 0;
}

export function cmdDeregister(root: string, args: string[]): number {
  const name = args[0];
  if (!name) {
    console.error('deregister 需要 <name>');
    return 1;
  }
  for (const regPath of findRegistries(root)) {
    const entries = parseRegistry(readFileSync(regPath, 'utf-8'));
    const idx = entries.findIndex((e) => e.name === name);
    if (idx >= 0) {
      entries.splice(idx, 1);
      writeRegistry(regPath, entries);
      try {
        gitCommit(root, `msm: deregister ${name}`);
      } catch {
        /* 非 git 环境忽略 */
      }
      console.log(`deregistered: ${name}`);
      return 0;
    }
  }
  console.error(`MSM not registered: "${name}"`);
  return 1;
}

export function cmdCheck(root: string): number {
  const entries = loadMsmEntries(root);
  let issues = 0;
  for (const e of entries) {
    const script = join(root, e.path);
    const scriptExists = existsSync(script);
    const testFile = script.replace(/\.ts$/, '.test.ts');
    const hasTest = existsSync(testFile);
    const hasMainGuard = scriptExists ? readFileSync(script, 'utf-8').includes('import.meta.url') : false;
    if (!scriptExists) {
      console.log(`[M3] ${e.name}: script missing (${e.path})`);
      issues++;
    }
    if (!hasTest) {
      console.log(`[M1] ${e.name}: no .test.ts`);
      issues++;
    }
    if (scriptExists && !hasMainGuard) {
      console.log(`[M2] ${e.name}: no main() guard (import.meta.url)`);
      issues++;
    }
  }
  if (issues === 0) console.log(`(DC-M1~M4 ok: ${entries.length} MSM)`);
  return issues === 0 ? 0 : 2;
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
    case 'list':
      return cmdList(root);
    case 'exec':
      return execMsm(root, argv[1] ?? '', argv.slice(2));
    case 'admin':
      switch (argv[1]) {
        case 'register':
          return cmdRegister(root, argv.slice(2));
        case 'deregister':
          return cmdDeregister(root, argv.slice(2));
        case 'check':
          return cmdCheck(root);
        default:
          console.error('usage: msm.ts admin <register|deregister|check>');
          return 1;
      }
    default:
      console.error('usage: msm.ts <list|exec|admin>');
      return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  process.exit(run(process.argv.slice(2)));
}
