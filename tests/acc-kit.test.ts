import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findSerenityRoot, findGitRoot, cmdHealth, cmdTime } from '../src/templates/acc-kit/scripts/acc-kit.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'acc-kit-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('acc-kit', () => {
  it('findSerenityRoot / findGitRoot', () => {
    expect(findSerenityRoot(dir)).toBeNull();
    writeFileSync(join(dir, '.serenity'), 'test');
    expect(findSerenityRoot(dir)).toBe(dir);
    mkdirSync(join(dir, '.git'));
    expect(findGitRoot(dir)).toBe(dir);
  });

  it('health 通过时退出 0 并输出 P1/P2', () => {
    writeFileSync(join(dir, '.serenity'), 'test');
    mkdirSync(join(dir, '.git'));
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = cmdHealth(dir);
    const out = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(code).toBe(0);
    expect(out.p1).toBe(true);
    expect(out.p2).toBe(true);
    spy.mockRestore();
  });

  it('health 缺 .serenity 时退出 2', () => {
    mkdirSync(join(dir, '.git'));
    expect(cmdHealth(dir)).toBe(2);
  });

  it('time 输出 ISO 格式', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    cmdTime();
    expect(new Date(spy.mock.calls[0]![0] as string).toString()).not.toBe('Invalid Date');
    spy.mockRestore();
  });
});
