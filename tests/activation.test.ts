import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findSerenityRoot, findGitRoot, classifyPath, resolveInside, checkActivation } from '../src/activation.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-serenity-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('activation: P1 有根', () => {
  it('向上遍历找到 .serenity 根', () => {
    writeFileSync(join(dir, '.serenity'), 'test-ccc');
    const nested = join(dir, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    expect(findSerenityRoot(nested)).toBe(dir);
  });

  it('无 .serenity 时抛错', () => {
    expect(() => findSerenityRoot(dir)).toThrow(/No CCC found/);
  });
});

describe('activation: P2 git 管', () => {
  it('找到 .git 根', () => {
    mkdirSync(join(dir, '.git'));
    const nested = join(dir, 'a');
    mkdirSync(nested);
    expect(findGitRoot(nested)).toBe(dir);
  });

  it('无 .git 返回 null', () => {
    expect(findGitRoot(dir)).toBeNull();
  });
});

describe('activation: P3 路径二分', () => {
  it('根内/根外/同根分类', () => {
    expect(classifyPath(join(dir, 'docs', 'a.md'), dir)).toBe('inside');
    expect(classifyPath('/tmp/outside.md', dir)).toBe('outside');
    expect(classifyPath(dir, dir)).toBe('same');
  });

  it('resolveInside 阻断逃逸', () => {
    expect(() => resolveInside(dir, '../escape.md')).toThrow(/Path escape blocked/);
    expect(resolveInside(dir, 'docs/a.md')).toBe(join(dir, 'docs', 'a.md'));
  });
});

describe('activation: checkActivation', () => {
  it('完整 CCC 激活', () => {
    writeFileSync(join(dir, '.serenity'), 'test-ccc');
    mkdirSync(join(dir, '.git'));
    const s = checkActivation(dir);
    expect(s.ok).toBe(true);
    expect(s.cwdRoot).toBe(dir);
  });

  it('缺标记不激活', () => {
    mkdirSync(join(dir, '.git'));
    const s = checkActivation(dir);
    expect(s.ok).toBe(false);
    expect(s.reasons).toContain('RR1: no .serenity marker');
  });
});

// 🔴 2026-09-21（B 案第 2 步④）：原 `describe('installer')` 两条用例（`resolveSkillsDir` 的
// scope 路径解析 / `installAll` 的"只安装存在的模板"+"幂等 skip"）**随安装器一并删除**——
// 主语（`src/skills/install-skill.ts`）已经不存在。owner 令「连模板和安装命令一起删」。
// ⇒ 负向钉（"安装器面确实没了"）另置 `tests/cli.test.ts`，不在此处留空壳。
