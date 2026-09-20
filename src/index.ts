/**
 * index.ts — dsh-serenity-plugin CLI 入口
 *
 * 子命令：
 *   install [--scope ccc|user] [--target <dir>] [--force] [--skills <csv|all>]
 *                                                          安装 ACC 技能到目标 .dsh/skills
 *   init <path> --name <ccc> --description <desc>          创建新 CCC（git init + .serenity + 骨架 + 技能）
 *   list [--target <dir>]                                  列出已安装技能
 *   status [--dir <dir>]                                   显示当前目录激活状态（P1/P2）
 */

import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { checkActivation } from './activation.js';
import { installAll, DEFAULT_TEMPLATE_SKILLS } from './skills/install-skill.js';
import { runInit } from './init/init-wizard.js';

// 模板目录：src/templates（开发时）/ dist/templates（构建后）
const here = fileURLToPath(new URL('.', import.meta.url));
const templatesDir = existsSync(join(here, 'templates'))
  ? join(here, 'templates')
  : join(here, '..', 'src', 'templates');

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 模板目录下实际存在的技能（判据 = 该目录里有 `SKILL.md`） */
export function listTemplateSkills(dir: string = templatesDir): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => existsSync(join(dir, name, 'SKILL.md')))
    .sort();
}

/**
 * resolveInstallSkills — 解析 `--skills` 选中的技能集合（纯函数，可单测）。
 *
 * 三种取值（`install-skill.ts` 的注释一直声称支持 `--skills`，本函数把它做实）：
 *   · **缺省 / 空** ⇒ `DEFAULT_TEMPLATE_SKILLS`（入口 + EAP + Neat；工具技能模板**已退役**为 fallback）
 *   · **`all`** ⇒ 模板目录下**实际存在**的全部技能 —— 用于**刷新既有 CCC 的存量技能**
 *     （先例：2026-09-20 补齐「轨迹自带 skill」指南时，CCC 里存着 9 份旧印，而默认集只覆盖 3 份）
 *   · **显式 CSV** ⇒ 逐个校验；**不存在的名字进 `missing` 响亮列出**（不静默丢）
 */
export function resolveInstallSkills(
  skillsArg: string | null | undefined,
  available: readonly string[] = listTemplateSkills(),
): { skills: string[]; missing: string[] } {
  const arg = (skillsArg ?? '').trim();
  if (arg === '') return { skills: [...DEFAULT_TEMPLATE_SKILLS], missing: [] };
  if (arg === 'all') return { skills: [...available], missing: [] };
  const wanted = arg
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    skills: wanted.filter((n) => available.includes(n)),
    missing: wanted.filter((n) => !available.includes(n)),
  };
}

function usage(): void {
  console.log(`dsh-serenity-plugin — 宁静号 ACC (DSH 运行时)

用法:
  dsh-serenity-plugin install [--scope ccc|user] [--target <dir>] [--force] [--skills <csv|all>]
      --scope  安装目标：ccc（CCC 级 .dsh/skills，默认）/ user（用户级 ~/.dsh/skills）
      --target 显式指定安装目录（覆盖 scope 推断）
      --skills 装哪些（缺省 = 入口 + EAP + Neat 三件；all = 模板里实际存在的全部，
               用于刷新既有 CCC 的存量技能；也可给逗号分隔的名字）
  dsh-serenity-plugin init <path> --name <ccc> --description <desc>
      创建新 CCC：git init + .serenity + 骨架 + 安装技能
  dsh-serenity-plugin list [--target <dir>]
  dsh-serenity-plugin status [--dir <dir>]
`);
}

export function cmdInstall(args: string[]): number {
  let scope: 'ccc' | 'user' = 'ccc';
  let target: string | null = null;
  let force = false;
  let skillsArg: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--scope') scope = args[++i] as 'ccc' | 'user';
    else if (a === '--target') target = args[++i] ?? null;
    else if (a === '--force') force = true;
    else if (a === '--skills') skillsArg = args[++i] ?? null;
  }
  const cccRoot = target ?? (scope === 'ccc' ? process.cwd() : homedir());
  const userDshHome = homedir();
  const ctx = { prefix: 'dsh', cccName: 'home-serenity', date: today() };
  const { skills, missing } = resolveInstallSkills(skillsArg);
  const result = installAll(templatesDir, { scope, cccRoot, userDshHome, force }, ctx, skills);
  console.log(`skills dir: ${result.skillsDir}`);
  for (const r of result.results) {
    console.log(`  [${r.status}] ${r.skill}${r.error ? ` — ${r.error}` : ''}`);
  }
  if (missing.length > 0) {
    console.log(`  [missing] 模板里没有这些技能（未安装）：${missing.join(', ')}`);
  }
  if (!force) {
    console.log('提示：目标已存在同名技能时会被跳过（幂等）；要覆盖请加 --force');
  }
  return 0;
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
    const result = runInit({ path: pathArg, name, description, templatesDir });
    console.log(`installed ${result.installed} skills into ${join(result.root, '.dsh', 'skills')}`);
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
    case 'install':
      return cmdInstall(argv.slice(1));
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
