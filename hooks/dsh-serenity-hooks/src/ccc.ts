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
import { resolve, dirname } from 'node:path';

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

/**
 * 前缀判定：abs 是否位于 rootAbs 之内。
 * caseInsensitive（Windows 盘符/路径大小写不敏感）由调用方按平台传入；
 * 边界必须是路径分隔符（`\` 或 `/` 任一）——不依赖平台 sep，跨平台语义一致：
 *   - 跨盘符绝对路径（root 在 D:\、target 在 C:\）前缀不匹配 → outside
 *   - 兄弟目录前缀陷阱（home vs home2）边界非分隔符 → outside
 * （旧实现用 path.relative().startsWith('..')——跨盘时 relative 返回绝对路径原文，
 *   不以 `..` 开头 → 漏判放行，见 Windows 兼容审计问题 1。）
 */
export function pathInside(rootAbs: string, abs: string, caseInsensitive = process.platform === 'win32'): boolean {
  const r = caseInsensitive ? rootAbs.toLowerCase() : rootAbs;
  const a = caseInsensitive ? abs.toLowerCase() : abs;
  if (a === r) return true;
  if (!a.startsWith(r)) return false;
  const next = a[r.length];
  return next === '\\' || next === '/';
}

export function classifyPath(p: string, root: string): PathClass {
  const rootAbs = resolve(root);
  const abs = resolve(p);
  const ci = process.platform === 'win32';
  if (ci ? abs.toLowerCase() === rootAbs.toLowerCase() : abs === rootAbs) return 'same';
  return pathInside(rootAbs, abs, ci) ? 'inside' : 'outside';
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
    /** 重启自动恢复最近激活的宁静号会话（session-start 时，根会话且无自身标记 → 回退最近 use 的标记） */
    autoRestoreSession?: boolean;
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
