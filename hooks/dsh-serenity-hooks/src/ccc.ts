/**
 * ccc.ts — CCC 纯逻辑层（零 DSH 依赖，可独立单测）
 *
 * 职责：CCC 根检测（P1）、git 检测（P2）、.dsh/serenity.json 配置读取、
 * 路径守卫（P3 语义）、安全模式黑名单匹配。
 *
 * 由 tools/ 与 seams/ 复用；逻辑移植自 dsh-serenity-plugin v0.1-v0.2
 * runner（本项目自有代码，非 opencode-serenity-plugin 源码）。
 */

import { existsSync, statSync, readFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';

// ── P1 有根 ──

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

// ── P2 git 管 ──

export function findGitRoot(cwd: string): string | null {
  let current = resolve(cwd);
  while (true) {
    if (existsSync(resolve(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// ── P3 路径二分 ──

export type PathClass = 'inside' | 'outside' | 'same';

export function classifyPath(p: string, root: string): PathClass {
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

// ── 配置（.dsh/serenity.json / .opencode/serenity.json）──

export interface SerenityConfig {
  loop?: { defaultModel?: string };
  sessionKeeper?: { threshold?: number };
  safeMode?: { blacklist?: string[] };
  hooks?: {
    enabled?: boolean;
    injectAccContext?: boolean;
    enforceSafeMode?: boolean;
    sessionKeeper?: boolean;
    turnFlush?: boolean;
  };
}

export const DEFAULT_SERENITY_CONFIG_PATHS = ['.dsh/serenity.json', '.opencode/serenity.json'];

export function loadSerenityConfig(root: string, paths: string[] = DEFAULT_SERENITY_CONFIG_PATHS): SerenityConfig {
  for (const candidate of paths) {
    const p = resolve(root, candidate);
    if (!existsSync(p)) continue;
    try {
      return JSON.parse(readFileSync(p, 'utf-8')) as SerenityConfig;
    } catch {
      return {};
    }
  }
  return {};
}

// ── 安全模式 ──

export const SAFE_MODE_MARKER = '.serenity-safe-on';

export function isSafeModeOn(root: string): boolean {
  return existsSync(resolve(root, SAFE_MODE_MARKER));
}

export function readBlacklist(root: string, paths: string[] = DEFAULT_SERENITY_CONFIG_PATHS): string[] {
  const cfg = loadSerenityConfig(root, paths);
  const rules = cfg.safeMode?.blacklist;
  return Array.isArray(rules) ? rules.map(String) : [];
}

/** 匹配黑名单规则；命中返回规则，未命中返回 null。前缀匹配 / regex: 前缀 */
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

/** 写类工具名（safe-mode 下禁止） */
export const WRITE_TOOLS = new Set(['bash', 'write', 'edit', 'str_replace_editor', 'cc_fs']);

export function isWriteTool(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName);
}
