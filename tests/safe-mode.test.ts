import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  findSerenityRoot,
  readBlacklist,
  isSafeModeOn,
  matchBlacklist,
  cmdOn,
  cmdOff,
  cmdStatus,
  cmdCheck,
} from '../src/templates/acc-safe-mode/scripts/safe-mode.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'acc-safe-'));
  writeFileSync(join(dir, '.serenity'), 'test');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('acc-safe-mode: 状态控制', () => {
  it('on/off 控制标记文件', () => {
    expect(isSafeModeOn(dir)).toBe(false);
    expect(cmdOn(dir)).toBe(0);
    expect(isSafeModeOn(dir)).toBe(true);
    expect(existsSync(join(dir, '.serenity-safe-on'))).toBe(true);
    expect(cmdOff(dir)).toBe(0);
    expect(isSafeModeOn(dir)).toBe(false);
  });

  it('幂等：重复 on/off 不报错', () => {
    cmdOn(dir);
    expect(cmdOn(dir)).toBe(0);
    cmdOff(dir);
    expect(cmdOff(dir)).toBe(0);
  });
});

describe('acc-safe-mode: 黑名单', () => {
  it('读取 .dsh/serenity.json 黑名单', () => {
    mkdirSync(join(dir, '.dsh'));
    writeFileSync(
      join(dir, '.dsh', 'serenity.json'),
      JSON.stringify({ safeMode: { blacklist: ['.secrets/', 'regex:\\.env$'] } }),
    );
    const rules = readBlacklist(dir);
    expect(rules).toEqual(['.secrets/', 'regex:\\.env$']);
  });

  it('matchBlacklist 前缀 + 正则', () => {
    const rules = ['.secrets/', 'regex:\\.env$'];
    expect(matchBlacklist('.secrets/cred.json', rules)).toBe('.secrets/');
    expect(matchBlacklist('config/.env', rules)).toBe('regex:\\.env$');
    expect(matchBlacklist('docs/a.md', rules)).toBeNull();
  });

  it('status 输出 JSON', () => {
    cmdOn(dir);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    cmdStatus(dir);
    const out = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(out.on).toBe(true);
    expect(Array.isArray(out.blacklist)).toBe(true);
    spy.mockRestore();
  });
});

describe('acc-safe-mode: check 守卫', () => {
  it('关闭时 check 放行', () => {
    expect(cmdCheck(dir, ['docs/a.md'])).toBe(0);
  });

  it('开启时命中黑名单返回 2', () => {
    cmdOn(dir);
    mkdirSync(join(dir, '.dsh'));
    writeFileSync(join(dir, '.dsh', 'serenity.json'), JSON.stringify({ safeMode: { blacklist: ['.secrets/'] } }));
    expect(cmdCheck(dir, ['.secrets/x'])).toBe(2);
    expect(cmdCheck(dir, ['docs/a.md'])).toBe(0);
  });

  it('根外路径直接拒绝', () => {
    cmdOn(dir);
    expect(cmdCheck(dir, ['../outside'])).toBe(2);
  });
});
