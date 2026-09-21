/**
 * index.ts — dsh-serenity-plugin CLI 入口
 *
 * 子命令：
 *   init <path> --name <ccc> --description <desc>          创建新 CCC（git init + .serenity + 骨架 + Phase 2 提示）
 *   list [--target <dir>]                                  列出目标 .dsh/skills 下的目录（只读诊断）
 *   status [--dir <dir>]                                   显示当前目录激活状态（P1/P2）
 *
 * 🔴 2026-09-21（B 案第 2 步②；owner 令「**连模板和安装命令一起删**」）：`install` 子命令
 * 已**整体删除** —— 连同 `src/skills/install-skill.ts` / `template-loader.ts`，以及
 * `src/templates/` 下每个技能的 `SKILL.md`（共 9 份，见提交 `b6a964b`）。
 *
 * 为什么删（证据链，勿凭记忆改回）：
 *   1. owner 问「系统提示词怎么膨胀了好多倍」。查明**不是同一份被注入两次**，而是入口块
 *      = `home-serenity`(43,089 B) + `acc-serenity`(10,355 B) ≈ **53 KB/请求**；第二份的来路是
 *      `.dsh/entry-skill` 指针（自 2026-08-07 起就点名 `acc-serenity`），而它**直到 2026-09-17
 *      那次 `install --skills` 才第一次存在** ⇒ 自那天起每请求静默 +10 KB。
 *   2. 本安装器是那条路径**唯一的生产者** ⇒ 生产者退场，B 案第 1 步（删 `findEntrySkills` 的
 *      来源 3「扫 `.dsh/skills/*-serenity`」）才算完整闭环。
 *   3. 判据（owner 2026-09-21 选 **B 案**）：这套"ACC 往 CCC 装一份技能副本"的机制**整条退场**
 *      —— CCC 的技能由 CCC 自己维护（`.opencode/skills/`）。
 *
 * ⚠️ **保留**：模板目录里的 6 个 `scripts/*.ts`（`msm` / `cc-git` / `acc-kit` /
 * `session-tool` / `safe-mode` / `cc-fs`）—— 它们不是"指南"，被仓内 **6 个测试文件** import；
 * 删它们会连带删测试，**超出 owner 说的"模板"范围**。目录名沿用，但**不再有安装语义**。
 *
 * ⚠️（写本文件时踩到的坑，留给后来者）：**块注释里不能出现 `*` + `/` 连写**——
 * 描述路径通配（`src/templates/<skill>/SKILL.md`）时若照抄 shell 通配符，注释会被提前终止，
 * esbuild 报 `Expected ";" but found "..."`。同族先例：往 TS 模板字符串里插文本要先确认反引号。
 */

import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkActivation } from './activation.js';
import { runInit } from './init/init-wizard.js';

function usage(): void {
  console.log(`dsh-serenity-plugin — 宁静号 ACC (DSH 运行时)

用法:
  dsh-serenity-plugin init <path> --name <ccc> --description <desc>
      创建新 CCC：git init + .serenity + 骨架 + Phase 2 提示
  dsh-serenity-plugin list [--target <dir>]
      列出目标 .dsh/skills 下的目录（只读诊断；不再有 install，故这里通常为空）
  dsh-serenity-plugin status [--dir <dir>]
      显示当前目录激活状态（P1 有根 / P2 git 管）

⚠️ install 子命令已于 2026-09-21 删除（owner 令「连模板和安装命令一起删」）：
ACC 不再往 CCC 装技能副本；技能由 CCC 自己维护（.opencode/skills/）。
`);
}

export function cmdList(args: string[]): number {
  let target: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--target') target = args[++i] ?? null;
  }
  const dir = target ?? join(process.cwd(), '.dsh', 'skills');
  if (!existsSync(dir)) {
    console.log(`no skills dir: ${dir}`);
    return 0;
  }
  console.log(`skills in ${dir}:`);
  for (const entry of readdirSync(dir)) console.log(`  ${entry}`);
  return 0;
}

export function cmdStatus(args: string[]): number {
  let dir = process.cwd();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir') dir = args[++i] ?? dir;
  }
  const status = checkActivation(dir);
  console.log(`cwd: ${resolve(dir)}`);
  console.log(`activated: ${status.ok}`);
  if (status.cwdRoot) console.log(`cwdRoot: ${status.cwdRoot}`);
  console.log(`inGitRepo: ${status.inGitRepo}`);
  for (const r of status.reasons) console.log(`  reason: ${r}`);
  return status.ok ? 0 : 1;
}

export function cmdInit(args: string[]): number {
  const pathArg = args.find((a) => !a.startsWith('--'));
  let name = 'my-ccc';
  let description = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name') name = args[++i] ?? name;
    if (args[i] === '--description') description = args[++i] ?? description;
  }
  if (!pathArg) {
    console.error('init 需要路径参数');
    return 1;
  }
  try {
    const result = runInit({ path: pathArg, name, description });
    console.log(`Phase 2 提示已生成: ${result.phase2Path}`);
    console.log(`CCC "${name}" initialized at ${result.root}`);
    return 0;
  } catch (err: any) {
    console.error(`init 失败: ${err.message ?? err}`);
    return 1;
  }
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const cmd = argv[0];
  switch (cmd) {
    case 'init':
      return cmdInit(argv.slice(1));
    case 'list':
      return cmdList(argv.slice(1));
    case 'status':
      return cmdStatus(argv.slice(1));
    case '-h':
    case '--help':
    case undefined:
      usage();
      return 0;
    default:
      console.error(`未知子命令: ${cmd}`);
      usage();
      return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
