import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInit, buildPhase2Prompt, PHASE2_PROMPT_FILENAME } from '../src/init/init-wizard.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'init-wizard-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('init-wizard', () => {
  it('runInit 创建骨架 + Phase 2 提示', () => {
    const result = runInit({ path: dir, name: 'my-ccc', description: '测试 CCC' });
    expect(result.root).toBe(dir);
    expect(existsSync(join(dir, '.serenity'))).toBe(true);
    expect(existsSync(join(dir, 'AGENT_SESSIONS'))).toBe(true);
    expect(existsSync(join(dir, '.dsh', 'serenity.json'))).toBe(true);
    expect(existsSync(result.phase2Path)).toBe(true);
    expect(join(dir, '.dsh', PHASE2_PROMPT_FILENAME)).toBe(result.phase2Path);
  });

  // 🔴 2026-09-21（B 案第 2 步④）负向钉：`init` **不再**往新 CCC 装技能副本。
  // 原实现（`installAll(templatesDir, …)` + `templatesDir` 参数）已随安装器删除；
  // 这条钉的是"删干净了"——若哪天真被改回装载，`.dsh/skills` 会重新出现，这里立刻变红。
  it('runInit 不再创建 .dsh/skills（安装器已退场）', () => {
    const result = runInit({ path: dir, name: 'my-ccc', description: '测试 CCC' });
    expect(existsSync(join(result.root, '.dsh', 'skills'))).toBe(false);
  });

  it('非法 CCC 名抛错', () => {
    expect(() => runInit({ path: dir, name: 'Bad Name', description: 'x' })).toThrow(/无效 CCC 名/);
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

  // 🔴 同批：提示词里那句"已安装 ACC 技能束"如今是**假陈述**（机制已退场）⇒ 改成明说"不装技能"。
  it('Phase 2 提示不再声称已装 ACC 技能束', () => {
    const prompt = buildPhase2Prompt('my-ccc', 'desc');
    expect(prompt).not.toContain('已安装: ACC 技能束');
    expect(prompt).toContain('本向导不安装任何技能');
  });
});
