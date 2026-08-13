/**
 * install-skill.ts — 技能安装器
 *
 * 把模板技能安装到目标 .dsh/skills/ 目录（CCC 级）或 ~/.dsh/skills/（用户级）。
 * 幂等：已存在则跳过（除非 --force）。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { copyTemplateTree, type TemplateContext } from './template-loader.js';

export type InstallScope = 'ccc' | 'user';

export interface InstallOptions {
  scope: InstallScope;
  cccRoot: string;
  userDshHome: string;
  force?: boolean;
}

export function resolveSkillsDir(opts: InstallOptions): string {
  return opts.scope === 'ccc'
    ? join(opts.cccRoot, '.dsh', 'skills')
    : join(opts.userDshHome, '.dsh', 'skills');
}

export interface InstallResult {
  skill: string;
  status: 'installed' | 'skipped' | 'failed';
  files: string[];
  error?: string;
}

/**
 * installSkillTemplate — 安装单个技能模板
 */
export function installSkillTemplate(
  templatesDir: string,
  skillName: string,
  skillsDir: string,
  ctx: TemplateContext,
  force: boolean,
): InstallResult {
  const templateDir = join(templatesDir, skillName);
  if (!existsSync(templateDir)) {
    return { skill: skillName, status: 'failed', files: [], error: `template not found: ${templateDir}` };
  }
  const targetDir = join(skillsDir, skillName);
  if (existsSync(targetDir) && !force) {
    return { skill: skillName, status: 'skipped', files: [] };
  }
  const files = copyTemplateTree(templateDir, targetDir, ctx);
  return { skill: skillName, status: 'installed', files };
}

/**
 * 默认安装技能集（v1.x：知识层收敛）
 *
 * native 插件（hooks/dsh-serenity-hooks）已提供工具能力（cc_fs/session/acc_kit/cc_git/acc_msm）
 * 与机械约束（守卫/keeper/上下文注入），工具技能模板退役。
 * 默认只装知识技能：入口 + EAP + Neat。旧工具技能模板文件保留作 fallback（可经 --skills 覆盖）。
 */
export const DEFAULT_TEMPLATE_SKILLS = [
  'acc-serenity',
  'acc-eap',
  'acc-neat',
] as const;

export interface InstallAllResult {
  skillsDir: string;
  results: InstallResult[];
}

/**
 * installAll — 安装全部默认技能（只处理实际存在的模板）
 */
export function installAll(
  templatesDir: string,
  opts: InstallOptions,
  ctx: TemplateContext,
  skills: readonly string[] = DEFAULT_TEMPLATE_SKILLS,
): InstallAllResult {
  const skillsDir = resolveSkillsDir(opts);
  const results: InstallResult[] = [];
  for (const skill of skills) {
    if (!existsSync(join(templatesDir, skill))) continue;
    results.push(installSkillTemplate(templatesDir, skill, skillsDir, ctx, opts.force ?? false));
  }
  return { skillsDir, results };
}
