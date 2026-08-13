#!/usr/bin/env bun
/**
 * session-tool.ts — 工作会话全周期管理（session 语义，DSH 版）
 *
 * 自包含实现（零三方依赖）。操作 CCC 根的 AGENT_SESSIONS/ 目录。
 *
 * 用法：
 *   bun session-tool.ts list
 *   bun session-tool.ts show <S###|目录名|关键词>
 *   bun session-tool.ts create [--name <desc>] [--title <标题>]
 *   bun session-tool.ts health
 *   bun session-tool.ts qa <S###>
 *   bun session-tool.ts archive <S###>
 *   bun session-tool.ts summary
 *
 * 退出码：0 成功 / 1 user / 2 system
 */

import { existsSync, statSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
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

export interface SessionInfo {
  dir: string;
  id: string | null;
  hasSessionMd: boolean;
  mtime: string;
  status: string | null;
}

const SESSION_DIR_RE = /^(\d{4}-\d{2}-\d{2})--(S\d{3})--(.+)$/;

export function listSessions(root: string): SessionInfo[] {
  const sessRoot = join(root, 'AGENT_SESSIONS');
  if (!existsSync(sessRoot)) return [];
  const out: SessionInfo[] = [];
  for (const entry of readdirSync(sessRoot)) {
    const full = join(sessRoot, entry);
    if (!statSync(full).isDirectory()) continue;
    const md = join(full, 'SESSION.md');
    const m = SESSION_DIR_RE.exec(entry);
    let status: string | null = null;
    if (existsSync(md)) {
      const content = readFileSync(md, 'utf-8');
      status = /\[x\]|\[X\]/.test(content) ? 'done' : 'open';
    }
    out.push({
      dir: entry,
      id: m?.[2] ?? null,
      hasSessionMd: existsSync(md),
      mtime: statSync(full).mtime.toISOString(),
      status,
    });
  }
  out.sort((a, b) => (a.dir < b.dir ? 1 : -1));
  return out;
}

export function nextSessionId(sessions: SessionInfo[]): string {
  let max = 0;
  for (const s of sessions) {
    if (s.id) {
      const n = Number(s.id.slice(1));
      if (n > max) max = n;
    }
  }
  return `S${String(max + 1).padStart(3, '0')}`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── 子命令 ──

export function cmdList(root: string): number {
  const sessions = listSessions(root);
  if (sessions.length === 0) {
    console.log('(no sessions)');
    return 0;
  }
  for (const s of sessions) {
    console.log(`${s.id ?? '----'}  ${s.status ?? '?'}  ${s.mtime.slice(0, 10)}  ${s.dir}`);
  }
  return 0;
}

export function cmdShow(root: string, args: string[]): number {
  const key = args[0];
  if (!key) {
    console.error('show 需要 <S###|目录名|关键词>');
    return 1;
  }
  const sessions = listSessions(root);
  const target = sessions.find((s) => s.dir.includes(key) || (s.id ?? '') === key.toUpperCase());
  if (!target) {
    // 关键词回退：内容搜索
    const sessRoot = join(root, 'AGENT_SESSIONS');
    for (const s of sessions) {
      const md = join(sessRoot, s.dir, 'SESSION.md');
      if (existsSync(md) && readFileSync(md, 'utf-8').includes(key)) {
        console.log(`--- ${s.dir} ---`);
        console.log(readFileSync(md, 'utf-8'));
        return 0;
      }
    }
    console.error(`未找到会话: ${key}`);
    return 1;
  }
  const md = join(root, 'AGENT_SESSIONS', target.dir, 'SESSION.md');
  if (!existsSync(md)) {
    console.error(`会话 ${target.dir} 缺少 SESSION.md`);
    return 2;
  }
  console.log(`--- ${target.dir} ---`);
  console.log(readFileSync(md, 'utf-8'));
  return 0;
}

export function cmdCreate(root: string, args: string[]): number {
  let name = 'untitled';
  let title = 'untitled';
  const nIdx = args.indexOf('--name');
  if (nIdx >= 0 && args[nIdx + 1]) name = args[nIdx + 1]!;
  const tIdx = args.indexOf('--title');
  if (tIdx >= 0 && args[tIdx + 1]) title = args[tIdx + 1]!;
  const sessions = listSessions(root);
  const id = nextSessionId(sessions);
  const dirName = `${today()}--${id}--${name}`;
  const dir = join(root, 'AGENT_SESSIONS', dirName);
  mkdirSync(dir, { recursive: true });
  const md = `# SESSION: ${title}\n- ID: ${id}\n\n## 目标\n<一句话描述本次会话要完成的事情>\n\n## 状态\n- [ ] 进行中\n\n## 关键决策\n| # | 决策 | 理由 |\n|---|------|------|\n| 1 |  |  |\n\n## 进度记录\n- ${today()} — 会话创建\n\n## 产出物\n- \n\n## 未解决的问题\n- \n`;
  writeFileSync(join(dir, 'SESSION.md'), md, 'utf-8');
  console.log(`created: ${dirName}`);
  console.log(`session id: ${id}`);
  return 0;
}

export function cmdHealth(root: string): number {
  const sessions = listSessions(root);
  const now = Date.now();
  const DAY = 86400000;
  let problems = 0;
  for (const s of sessions) {
    const age = (now - new Date(s.mtime).getTime()) / DAY;
    if (!s.hasSessionMd) {
      console.log(`[warn] ${s.dir}: 缺少 SESSION.md`);
      problems++;
    } else if (age > 14) {
      console.log(`[stale] ${s.dir}: ${Math.round(age)} 天未更新`);
      problems++;
    }
  }
  if (problems === 0) console.log('(all healthy)');
  return problems === 0 ? 0 : 2;
}

export function cmdQa(root: string, args: string[]): number {
  const key = args[0];
  if (!key) {
    console.error('qa 需要 <S###>');
    return 1;
  }
  const sessions = listSessions(root);
  const target = sessions.find((s) => (s.id ?? '') === key.toUpperCase() || s.dir.includes(key));
  if (!target) {
    console.error(`未找到会话: ${key}`);
    return 1;
  }
  const md = join(root, 'AGENT_SESSIONS', target.dir, 'SESSION.md');
  if (!existsSync(md)) return 2;
  const content = readFileSync(md, 'utf-8');
  let issues = 0;
  for (const line of content.split('\n')) {
    const m = /^-\s*(`[^`]+`|[^\s|]+)\s*—/.exec(line.trim());
    if (!m) continue;
    const p = m[1]!.replace(/`/g, '');
    const abs = resolve(root, p);
    if (!existsSync(abs)) {
      console.log(`[missing] ${p}`);
      issues++;
    }
  }
  if (issues === 0) console.log('(claims ok)');
  return issues === 0 ? 0 : 2;
}

export function cmdArchive(root: string, args: string[]): number {
  const key = args[0];
  if (!key) {
    console.error('archive 需要 <S###>');
    return 1;
  }
  const sessions = listSessions(root);
  const target = sessions.find((s) => (s.id ?? '') === key.toUpperCase() || s.dir.includes(key));
  if (!target) {
    console.error(`未找到会话: ${key}`);
    return 1;
  }
  const md = join(root, 'AGENT_SESSIONS', target.dir, 'SESSION.md');
  if (!existsSync(md)) return 2;
  let content = readFileSync(md, 'utf-8');
  content = content
    .replace(/^-\s*\[ \]\s*进行中$/m, '- [x] 已完成')
    .replace(/^-\s*\[ \]\s*已关闭（未完成）$/m, '- [x] 已关闭（未完成）');
  if (!/\[x\]|\[X\]/.test(content)) content = content.replace(/^## 状态$/m, '## 状态\n- [x] 已完成');
  writeFileSync(md, content, 'utf-8');
  appendFileSync(md, `\n> 已归档: ${today()}\n`, 'utf-8');
  console.log(`archived: ${target.dir}`);
  return 0;
}

export function cmdSummary(root: string): number {
  const sessions = listSessions(root);
  const done = sessions.filter((s) => s.status === 'done').length;
  const open = sessions.filter((s) => s.status !== 'done').length;
  const stale = sessions.filter((s) => (Date.now() - new Date(s.mtime).getTime()) / 86400000 > 14).length;
  console.log(`sessions: ${sessions.length}  (open: ${open}, done: ${done})`);
  console.log(`stale(>14d): ${stale}`);
  const recent = sessions.slice(0, 5);
  if (recent.length) {
    console.log('recent:');
    for (const s of recent) console.log(`  ${s.mtime.slice(0, 10)}  ${s.dir}`);
  }
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
  switch (sub) {
    case 'list':
      return cmdList(root);
    case 'show':
      return cmdShow(root, argv.slice(1));
    case 'create':
      return cmdCreate(root, argv.slice(1));
    case 'health':
      return cmdHealth(root);
    case 'qa':
      return cmdQa(root, argv.slice(1));
    case 'archive':
      return cmdArchive(root, argv.slice(1));
    case 'summary':
      return cmdSummary(root);
    default:
      console.error('usage: session-tool.ts <list|show|create|health|qa|archive|summary> [args...]');
      return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  process.exit(run(process.argv.slice(2)));
}
