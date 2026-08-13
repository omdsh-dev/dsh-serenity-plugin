/**
 * activation.ts — 激活层：CCC 三原则 (P1/P2/P3) 检测
 *
 * P1 有根 — 有且仅有一个 .serenity 标记的根目录
 * P2 git 管 — 根目录必须处于 git 管理下
 * P3 权限二分 — 根内完整权限，根外零权限（DSH 侧由 fs 沙箱原生执行）
 *
 * 独立实现（不复用 opencode-serenity-plugin 源码）。
 */

import { existsSync, statSync } from 'node:fs';
import { resolve, dirname, relative, normalize } from 'node:path';

/**
 * findSerenityRoot — 从 cwd 向上遍历寻找 .serenity 标记目录
 */
export function findSerenityRoot(cwd: string): string {
  let current = resolve(cwd);
  while (true) {
    const marker = resolve(current, '.serenity');
    if (existsSync(marker) && statSync(marker).isFile()) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`No CCC found: no .serenity file found when walking up from "${cwd}"`);
    }
    current = parent;
  }
}

/**
 * findGitRoot — 向上遍历寻找 .git 目录
 */
export function findGitRoot(cwd: string): string | null {
  let current = resolve(cwd);
  while (true) {
    if (existsSync(resolve(current, '.git'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * 路径分类：'inside' | 'outside' | 'same'
 */
export type PathClass = 'inside' | 'outside' | 'same';

export function classifyPath(path: string, root: string): PathClass {
  const rel = relative(resolve(root), resolve(path));
  if (rel === '') return 'same';
  if (rel.startsWith('..') || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    return 'outside';
  }
  return 'inside';
}

/**
 * 解析路径并确保在根内（路径逃逸阻断）
 */
export function resolveInside(root: string, p: string): string {
  const abs = resolve(root, p);
  if (classifyPath(abs, root) === 'outside') {
    throw new Error(`Path escape blocked: "${p}" resolves outside "${root}"`);
  }
  return normalize(abs);
}

/**
 * 激活状态
 */
export interface ActivationStatus {
  ok: boolean;
  cwdRoot: string | null;
  reasons: string[];
  inGitRepo: boolean;
}

/**
 * checkActivation — 检测当前 cwd 是否满足 ACC 激活条件 (P1 + P2)
 */
export function checkActivation(cwd: string): ActivationStatus {
  const reasons: string[] = [];
  let cwdRoot: string | null = null;
  let inGitRepo = false;

  try {
    cwdRoot = findSerenityRoot(cwd);
  } catch {
    reasons.push('RR1: no .serenity marker');
  }

  const gitRoot = findGitRoot(cwd);
  if (gitRoot) {
    inGitRepo = true;
  } else {
    reasons.push('RR6: not in a git repo');
  }

  return { ok: cwdRoot !== null && inGitRepo, cwdRoot, reasons, inGitRepo };
}
