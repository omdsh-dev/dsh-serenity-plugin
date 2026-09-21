import { describe, it, expect, vi } from 'vitest';
import * as cli from '../src/index.js';

/**
 * cli.test.ts — CLI 入口（`src/index.ts`）契约钉
 *
 * 为什么有这份文件（2026-09-21，B 案第 2 步④）：
 *   ① **`src/index.ts` 此前没有任何测试 import 它** ⇒ 在那里删错东西（例如 import 了
 *      已删模块）**不会变红**。本文件把它纳入测试面。
 *   ② 本次删掉的是**整条 install 面**（子命令 + `install-skill.ts` / `template-loader.ts`
 *      + 9 份模板 `SKILL.md`）。删机制同样要留一条"**它确实没了**"的负向钉——
 *      否则下一轮会被静默改回来（同族纪律：「改了机制就必须同批改掉描述它的那句话」的反面）。
 *
 * ⚠️ 范围：本文件钉 **CLI 进程面**（`bin/dsh-serenity-plugin.js` 走的那条）；
 * 插件运行时在 `hooks/dsh-serenity-hooks/`，由那边的测试覆盖。
 * ⚠️ 覆盖缺口（诚实标注）：本包的 `src/` **不在 `dsh-develop typecheck` 的范围内**
 * （那条只跑 `hooks/dsh-serenity-hooks/tsconfig.json` + 其 client），本文件经 vitest
 * 转译只能证明"**模块可加载、导出面正确**"，证明不了类型正确。
 */

/** 跑一次 CLI 并捕获它的 stdout/stderr（`main` 用 console.log/error 输出） */
function runCli(argv: string[]): { code: number; out: string; err: string } {
  const logs: string[] = [];
  const errs: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.map((x) => String(x)).join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    errs.push(a.map((x) => String(x)).join(' '));
  });
  try {
    const code = cli.main(argv);
    return { code, out: logs.join('\n'), err: errs.join('\n') };
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
}

describe('cli: install 面已退场（B 案第 2 步② 负向钉）', () => {
  it('`install` 子命令不再存在', () => {
    const r = runCli(['install']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('未知子命令: install');
  });

  it('usage 不再宣传 install（且仍列出留下的三个子命令）', () => {
    const r = runCli(['--help']);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('dsh-serenity-plugin install');
    expect(r.out).toContain('init <path>');
    expect(r.out).toContain('list [--target <dir>]');
    expect(r.out).toContain('status [--dir <dir>]');
  });

  it('导出面：安装器相关的导出已消失，其余四个仍在', () => {
    for (const gone of ['cmdInstall', 'listTemplateSkills', 'resolveInstallSkills']) {
      expect(gone in cli).toBe(false);
    }
    for (const kept of ['cmdInit', 'cmdList', 'cmdStatus', 'main']) {
      expect(kept in cli).toBe(true);
    }
  });

  it('`init` 缺路径参数时响亮失败（不是静默 0）', () => {
    const r = runCli(['init']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('init 需要路径参数');
  });
});
