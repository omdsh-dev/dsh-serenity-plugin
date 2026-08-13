import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInit, buildPhase2Prompt, PHASE2_PROMPT_FILENAME } from '../src/init/init-wizard.js';

let dir: string;
let templatesDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'init-wizard-'));
  templatesDir = mkdtempSync(join(tmpdir(), 'tpl-'));
  mkdirSync(join(templatesDir, 'acc-serenity'), { recursive: true });
  writeFileSync(join(templatesDir, 'acc-serenity', 'SKILL.md'), 'placeholder');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(templatesDir, { recursive: true, force: true });
});

describe('init-wizard', () => {
  it('runInit 创建骨架 + 技能 + Phase 2 提示', () => {
    const result = runInit({ path: dir, name: 'my-ccc', description: '测试 CCC', templatesDir });
    expect(result.root).toBe(dir);
    expect(existsSync(join(dir, '.serenity'))).toBe(true);
    expect(existsSync(join(dir, 'AGENT_SESSIONS'))).toBe(true);
    expect(existsSync(join(dir, '.dsh', 'serenity.json'))).toBe(true);
    expect(existsSync(result.phase2Path)).toBe(true);
    expect(join(dir, '.dsh', PHASE2_PROMPT_FILENAME)).toBe(result.phase2Path);
  });

  it('非法 CCC 名抛错', () => {
    expect(() => runInit({ path: dir, name: 'Bad Name', description: 'x', templatesDir })).toThrow(/无效 CCC 名/);
  });

  it('buildPhase2Prompt 包含 5 个 Topic', () => {
    const prompt = buildPhase2Prompt('my-ccc', 'desc');
    expect(prompt).toContain('T1 项目目的');
    expect(prompt).toContain('T2 Git 与协作');
    expect(prompt).toContain('T3 工作项');
    expect(prompt).toContain('T4 约束');
    expect(prompt).toContain('T5 边界');
    expect(prompt).toContain('my-ccc');
  });
});
