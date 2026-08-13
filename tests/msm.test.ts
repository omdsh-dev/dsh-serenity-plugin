import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  findSerenityRoot,
  parseRegistry,
  loadMsmEntries,
  findEntry,
  validatePathArgs,
  cmdList,
  execMsm,
  cmdRegister,
  cmdDeregister,
} from '../src/templates/acc-msm/scripts/msm.js';

let dir: string;

function makeScript(name: string, body: string): void {
  const scriptsDir = join(dir, '.opencode', 'skills', 'test-skill', 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(join(scriptsDir, name), body);
}

function makeRegistry(entries: unknown): void {
  const refs = join(dir, '.opencode', 'skills', 'test-skill', 'references');
  mkdirSync(refs, { recursive: true });
  writeFileSync(join(refs, 'mech-registry.json'), JSON.stringify(entries, null, 2));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'acc-msm-'));
  writeFileSync(join(dir, '.serenity'), 'test');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('acc-msm: 注册表解析', () => {
  it('v1 包装格式', () => {
    const entries = parseRegistry(JSON.stringify({ version: 1, entries: [{ name: 'a', path: 'x.ts' }] }));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe('a');
  });

  it('兼容数组格式', () => {
    const entries = parseRegistry(JSON.stringify([{ name: 'a', path: 'x.ts' }]));
    expect(entries[0]!.name).toBe('a');
  });

  it('loadMsmEntries 合并并去重', () => {
    makeRegistry({
      version: 1,
      entries: [
        { name: 'dup', path: '.opencode/skills/test-skill/scripts/dup.ts', skill: 'test-skill', category: 'mech' },
        { name: 'only-here', path: '.opencode/skills/test-skill/scripts/only.ts', skill: 'test-skill', category: 'mech' },
      ],
    });
    // 根级注册表同名 dup —— 先到先得
    writeFileSync(join(dir, 'mech-registry.json'), JSON.stringify({ version: 1, entries: [{ name: 'dup', path: 'x.ts' }] }));
    const entries = loadMsmEntries(dir);
    expect(entries).toHaveLength(2);
    expect(findEntry(dir, 'dup')!.path).toContain('test-skill');
  });
});

describe('acc-msm: path 守卫', () => {
  it('validatePathArgs 阻断逃逸', () => {
    const entry = { name: 'x', path: 'x.ts', flags: [{ name: 'out', type: 'path' }] };
    expect(() => validatePathArgs(dir, entry, ['--out', '../escape'])).toThrow(/Path escape blocked/);
    expect(() => validatePathArgs(dir, entry, ['--out=/tmp/x'])).toThrow(/Path escape blocked/);
    expect(() => validatePathArgs(dir, entry, ['--out', 'docs'])).not.toThrow();
  });
});

describe('acc-msm: exec', () => {
  it('list 输出注册 MSM', () => {
    makeRegistry({ version: 1, entries: [{ name: 'hello-msm', path: 'x.ts', skill: 'test-skill', category: 'mech', description: '测试' }] });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    cmdList(dir);
    expect(spy.mock.calls.join('\n')).toContain('hello-msm');
    spy.mockRestore();
  });

  it('exec 执行真实脚本（bun）', () => {
    makeScript('hello.ts', 'console.log("hi-from-msm");\n');
    makeRegistry({
      version: 1,
      entries: [{ name: 'hello', path: '.opencode/skills/test-skill/scripts/hello.ts', skill: 'test-skill', category: 'mech' }],
    });
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = execMsm(dir, 'hello', []);
    expect(code).toBe(0);
    expect(spy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('hi-from-msm');
    spy.mockRestore();
  });

  it('exec 未注册返回 1', () => {
    expect(execMsm(dir, 'nope', [])).toBe(1);
  });
});

describe('acc-msm: admin', () => {
  it('register 写注册表并去重拒绝', () => {
    makeScript('tool.ts', 'console.log("ok");\n');
    const code = cmdRegister(dir, ['tool', '--skill', 'test-skill', '--path', '.opencode/skills/test-skill/scripts/tool.ts', '--category', 'mech', '--description', '测试工具']);
    expect(code).toBe(0);
    expect(findEntry(dir, 'tool')).not.toBeNull();
    // 重复注册拒绝
    expect(cmdRegister(dir, ['tool', '--skill', 'test-skill', '--path', 'x.ts', '--category', 'mech', '--description', 'd'])).toBe(1);
  });

  it('deregister 移除条目', () => {
    makeScript('tool.ts', 'console.log("ok");\n');
    cmdRegister(dir, ['tool', '--skill', 'test-skill', '--path', '.opencode/skills/test-skill/scripts/tool.ts', '--category', 'mech', '--description', '测试工具']);
    expect(cmdDeregister(dir, ['tool'])).toBe(0);
    expect(findEntry(dir, 'tool')).toBeNull();
  });
});
