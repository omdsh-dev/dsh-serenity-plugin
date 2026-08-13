import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  findSerenityRoot,
  classifyPath,
  resolveInside,
  cmdRoot,
  cmdList,
  cmdTree,
  cmdMkdir,
  cmdTouch,
  cmdAppend,
  cmdInfo,
  cmdFind,
  cmdRm,
} from '../src/templates/acc-fs/scripts/cc-fs.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'acc-fs-'));
  writeFileSync(join(dir, '.serenity'), 'test');
  mkdirSync(join(dir, 'docs', 'nested'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'nested', 'a.md'), 'hello');
  writeFileSync(join(dir, 'README.md'), 'readme');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('acc-fs: 路径守卫', () => {
  it('findSerenityRoot 上溯', () => {
    expect(findSerenityRoot(join(dir, 'docs', 'nested'))).toBe(dir);
  });

  it('classifyPath 三分', () => {
    expect(classifyPath(join(dir, 'a.md'), dir)).toBe('inside');
    expect(classifyPath('/tmp/x.md', dir)).toBe('outside');
    expect(classifyPath(dir, dir)).toBe('same');
  });

  it('resolveInside 阻断逃逸', () => {
    expect(() => resolveInside(dir, '../escape')).toThrow(/Path escape blocked/);
  });
});

describe('acc-fs: 子命令', () => {
  it('root 打印根路径', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    cmdRoot(dir);
    expect(spy).toHaveBeenCalledWith(dir);
    spy.mockRestore();
  });

  it('list 输出 JSON 条目', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    cmdList(dir, []);
    const arg = JSON.parse(spy.mock.calls[0]![0] as string);
    const names = arg.map((e: { name: string }) => e.name);
    expect(names).toContain('docs');
    expect(names).toContain('README.md');
    spy.mockRestore();
  });

  it('tree 递归包含嵌套文件', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    cmdTree(dir, []);
    const arg = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(arg.some((e: { path: string }) => e.path === 'docs/nested/a.md')).toBe(true);
    spy.mockRestore();
  });

  it('mkdir/touch/append/info/find 全链路', () => {
    cmdMkdir(dir, ['tmp/x']);
    cmdTouch(dir, ['tmp/x/t.txt']);
    cmdAppend(dir, ['tmp/x/t.txt', 'line1']);
    expect(existsSync(join(dir, 'tmp/x/t.txt'))).toBe(true);

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    cmdInfo(dir, ['tmp/x/t.txt']);
    const info = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(info.type).toBe('file');
    expect(info.size).toBe(5);

    cmdFind(dir, ['t.txt']);
    const found = JSON.parse(spy.mock.calls[1]![0] as string);
    expect(found).toContain('tmp/x/t.txt');
    spy.mockRestore();
  });

  it('rm dry-run 不删除、根保护拒绝', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    cmdRm(dir, ['README.md', '--dry-run']);
    expect(existsSync(join(dir, 'README.md'))).toBe(true);
    expect(() => cmdRm(dir, ['.'])).toThrow(/拒绝删除 CCC 根本身/);
    spy.mockRestore();
  });

  it('find 支持 regex: 前缀', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    cmdFind(dir, ['regex:^README']);
    const found = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(found).toContain('README.md');
    spy.mockRestore();
  });
});
