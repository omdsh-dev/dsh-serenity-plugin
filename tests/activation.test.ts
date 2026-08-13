import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findSerenityRoot, findGitRoot, classifyPath, resolveInside, checkActivation } from '../src/activation.js';
import { installAll, resolveSkillsDir } from '../src/skills/install-skill.js';

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

describe('installer', () => {
  it('scope 路径解析：ccc → <root>/.dsh/skills，user → ~/.dsh/skills', () => {
    const opts = { scope: 'ccc' as const, cccRoot: dir, userDshHome: '/home/test-user' };
    expect(resolveSkillsDir(opts)).toBe(join(dir, '.dsh', 'skills'));
    expect(resolveSkillsDir({ ...opts, scope: 'user' })).toBe('/home/test-user/.dsh/skills');
  });

  it('安装器只安装存在的模板', () => {
    const templatesDir = join(dir, 'templates');
    mkdirSync(join(templatesDir, 'acc-serenity'), { recursive: true });
    writeFileSync(join(templatesDir, 'acc-serenity', 'SKILL.md'), 'name: {{ccc_name}}');
    const result = installAll(
      templatesDir,
      { scope: 'ccc', cccRoot: dir, userDshHome: dir },
      { prefix: 'dsh', cccName: 'home-serenity', date: '2026-08-06' },
    );
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.skill).toBe('acc-serenity');
    expect(result.results[0]!.status).toBe('installed');
    // 幂等：重复安装 skip
    const again = installAll(
      templatesDir,
      { scope: 'ccc', cccRoot: dir, userDshHome: dir },
      { prefix: 'dsh', cccName: 'home-serenity', date: '2026-08-06' },
    );
    expect(again.results[0]!.status).toBe('skipped');
  });
});
