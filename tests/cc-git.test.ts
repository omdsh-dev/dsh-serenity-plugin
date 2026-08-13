import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { findSerenityRoot, cmdStatus, cmdCommit, cmdLog, cmdPush } from '../src/templates/acc-git/scripts/cc-git.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'acc-git-'));
  writeFileSync(join(dir, '.serenity'), 'test');
  execFileSync('git', ['init', '-q', '-b', 'master'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  writeFileSync(join(dir, 'a.txt'), 'hello');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('acc-git', () => {
  it('findSerenityRoot', () => {
    expect(findSerenityRoot(dir)).toBe(dir);
  });

  it('commit 后 status 干净', () => {
    const code = cmdCommit(dir, ['-m', 'init']);
    expect(code).toBe(0);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    cmdStatus(dir);
    expect(spy).toHaveBeenCalledWith('(clean)');
    spy.mockRestore();
  });

  it('commit 无消息返回 1', () => {
    expect(cmdCommit(dir, [])).toBe(1);
  });

  it('log 输出提交记录（stdout）', () => {
    cmdCommit(dir, ['-m', 'init']);
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    cmdLog(dir, ['-n', '5']);
    const out = spy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('init');
    spy.mockRestore();
  });

  it('push 无远程返回 2', () => {
    const code = cmdPush(dir);
    expect(code).toBe(2);
  });
});
