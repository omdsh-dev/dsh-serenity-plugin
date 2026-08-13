/**
 * init-wizard.ts — CCC 初始化向导
 *
 * 仿照 opencode-serenity-plugin 的 init 流程（D1 两阶段）：
 *   Phase 1: git init + .serenity + 骨架目录 + 安装 ACC 技能
 *   Phase 2: EAP 驱动访谈 —— 生成 PHASE2-PROMPT.md，指导下一个 Agent 会话完成认知对齐
 *
 * 独立实现（不复用 opencode-serenity-plugin 源码）。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { isValidCccName } from '../util/name.js';
import { installAll } from '../skills/install-skill.js';
import type { TemplateContext } from '../skills/template-loader.js';

export const PHASE2_PROMPT_FILENAME = 'PHASE2-PROMPT.md';

export interface InitOptions {
  path: string;
  name: string;
  description: string;
  templatesDir: string;
}

/**
 * buildPhase2Prompt — EAP 驱动访谈提示（Phase 2）
 *
 * 5 个 Topic：目的 / Git / 工作项 / 约束 / 边界。答案应沉淀到 SESSION.md 与入口技能。
 */
export function buildPhase2Prompt(name: string, description: string): string {
  return `# Phase 2 — ${name} 认知对齐访谈

> 由 dsh-serenity-plugin (ACC) init 生成。下一个进入本 CCC 的 Agent 会话应完成本次访谈，
> 答案沉淀到 AGENT_SESSIONS/ 的会话 SESSION.md，并视需要提炼为 .dsh/skills 下的领域技能。

## CCC 档案
- 名称: ${name}
- 描述: ${description}
- 已安装: ACC 技能束（acc-serenity 等）— 先加载 acc-serenity 入口技能

## 访谈 Topic（按序逐项对齐，EAP 标准：E↑ 显式 / R↓ 可重建 / S↑ 稳定）

### T1 项目目的
- 这个 CCC 要解决什么问题？一句话说清。
- 成功的可观察标准是什么？

### T2 Git 与协作
- 远程仓库地址？（如 git@github.com:ORG/REPO.git）
- 默认分支约定？谁参与维护？

### T3 工作项
- 当前（或首批）工作项清单是什么？每个工作项的验收标准？
- 建议用 AGENT_SESSIONS 会话追踪，或注册为 MSM（acc-msm admin register）。

### T4 约束
- 硬约束：哪些操作绝对禁止？（例：不写系统文件、不用裸 ssh）
- 软约束：命名规范、文档要求、提交纪律？

### T5 边界
- 范围内：本 CCC 管理哪些内容？
- 范围外：明确不做什么？（避免认知越界）

## 完成标准
- [ ] 5 个 Topic 均有结论
- [ ] 结论写入 AGENT_SESSIONS 会话 SESSION.md
- [ ] 需要长期固化的约定提炼为技能或 MSM
- [ ] 本文件标记为"已归档"（或删除）
`;
}

/**
 * runInit — Phase 1 骨架创建 + 技能安装 + Phase 2 提示生成
 */
export function runInit(opts: InitOptions): { root: string; phase2Path: string; installed: number } {
  if (!isValidCccName(opts.name)) {
    throw new Error(`无效 CCC 名: "${opts.name}"（只允许 kebab-case）`);
  }
  const root = resolve(opts.path);
  mkdirSync(join(root, 'AGENT_SESSIONS'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(join(root, '.dsh'), { recursive: true });
  writeFileSync(join(root, '.serenity'), opts.name, 'utf-8');
  writeFileSync(join(root, '.dsh', 'serenity.json'), JSON.stringify({}, null, 2) + '\n', 'utf-8');
  writeFileSync(
    join(root, 'README.md'),
    `# ${opts.name}\n\n> CCC（Concrete Cognitive Container）— 由 dsh-serenity-plugin (ACC) 创建\n\n${opts.description}\n\n## 下一步\n\n读取 \`.dsh/PHASE2-PROMPT.md\`，完成 Phase 2 认知对齐访谈。\n`,
    'utf-8',
  );

  const r = spawnSync('git', ['init', '-q'], { cwd: root, stdio: 'pipe' });
  if (r.status !== 0) {
    throw new Error('git init 失败');
  }

  const ctx: TemplateContext = { prefix: 'dsh', cccName: opts.name, date: new Date().toISOString().slice(0, 10) };
  const result = installAll(opts.templatesDir, { scope: 'ccc', cccRoot: root, userDshHome: homedir() }, ctx);

  const phase2Path = join(root, '.dsh', PHASE2_PROMPT_FILENAME);
  writeFileSync(phase2Path, buildPhase2Prompt(opts.name, opts.description), 'utf-8');

  return { root, phase2Path, installed: result.results.filter((x) => x.status === 'installed').length };
}
