import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  findSerenityRoot,
  listSessions,
  nextSessionId,
  cmdCreate,
  cmdList,
  cmdShow,
  cmdArchive,
  cmdHealth,
} from '../src/templates/acc-session/scripts/session-tool.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'acc-session-'));
  writeFileSync(join(dir, '.serenity'), 'test');
  mkdirSync(join(dir, 'AGENT_SESSIONS'), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('acc-session: 会话生命周期', () => {
  it('空目录 list 为空', () => {
    expect(listSessions(dir)).toHaveLength(0);
  });

  it('create 自动分配 S001 并写 SESSION.md', () => {
    const code = cmdCreate(dir, ['--name', 'test-work', '--title', '测试工作']);
    expect(code).toBe(0);
    const sessions = listSessions(dir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).toBe('S001');
    expect(sessions[0]!.dir).toContain('S001');
    expect(sessions[0]!.dir).toContain('test-work');
    expect(sessions[0]!.hasSessionMd).toBe(true);
    const md = join(dir, 'AGENT_SESSIONS', sessions[0]!.dir, 'SESSION.md');
    expect(existsSync(md)).toBe(true);
  });

  it('nextSessionId 递增', () => {
    cmdCreate(dir, ['--name', 'a']);
    cmdCreate(dir, ['--name', 'b']);
    const sessions = listSessions(dir);
    expect(nextSessionId(sessions)).toBe('S003');
  });

  it('show 按 id 与关键词', () => {
    cmdCreate(dir, ['--name', 'alpha', '--title', '阿尔法']);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    cmdShow(dir, ['S001']);
    expect(spy.mock.calls.join('\n')).toContain('阿尔法');
    spy.mockRestore();

    const spy2 = vi.spyOn(console, 'log').mockImplementation(() => {});
    cmdShow(dir, ['阿尔法']);
    expect(spy2.mock.calls.join('\n')).toContain('S001');
    spy2.mockRestore();
  });

  it('archive 标记完成', () => {
    cmdCreate(dir, ['--name', 'x']);
    const sessions = listSessions(dir);
    expect(sessions[0]!.status).toBe('open');
    expect(cmdArchive(dir, ['S001'])).toBe(0);
    const after = listSessions(dir);
    expect(after[0]!.status).toBe('done');
  });

  it('health 报告 stale', () => {
    // 无会话 → healthy
    expect(cmdHealth(dir)).toBe(0);
    // 造一个 20 天前的会话
    cmdCreate(dir, ['--name', 'old']);
    const oldDir = join(dir, 'AGENT_SESSIONS', listSessions(dir)[0]!.dir);
    const past = new Date(Date.now() - 20 * 86400000);
    utimesSync(oldDir, past, past);
    const md = join(oldDir, 'SESSION.md');
    utimesSync(md, past, past);
    expect(cmdHealth(dir)).toBe(2);
  });
});
