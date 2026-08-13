/**
 * env.ts — shell.env 环境变量注入（ACC 标准）
 *
 * 经 ctx.shellEnv（DSH shell-env 缝，公开版由 bash-env 改名）注册 DSH_* 事实：
 *   DSH_SERENITY_ROOT    — CCC 根目录（agent 会话 cwd 上溯 .serenity）
 *   DSH_SERENITY_CCC     — CCC 名称（根目录 basename）
 *   DSH_SERENITY_VERSION — ACC 版本
 *
 * 每次模型 shell 调用都会重建 DSH_* 命名空间并注入（按当前执行解析）。
 */

import type { Context } from 'cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { BashEnvContributor } from '@deepseek-ai/dsh-shell-env'
import type { DshEnvironmentKey } from '@deepseek-ai/dsh-shell'
import { basename } from 'node:path'
import { findSerenityRoot } from '../ccc.js'
import { ACC_VERSION } from '../constants.js'

export type SerenityEnvFacts = Partial<Record<DshEnvironmentKey, string>>

/** 纯解析：给定 cwd，返回可注入的 DSH_SERENITY_* 事实（非 CCC 返回空） */
export function resolveSerenityEnv(cwd: string): SerenityEnvFacts {
  const root = findSerenityRoot(cwd)
  if (!root) return {}
  return {
    DSH_SERENITY_ROOT: root,
    DSH_SERENITY_CCC: basename(root),
    DSH_SERENITY_VERSION: ACC_VERSION,
  }
}

export function registerEnv(ctx: Context): void {
  const contributor: BashEnvContributor = {
    name: 'dsh-serenity-hooks',
    variables: {
      DSH_SERENITY_ROOT: { description: 'CCC 根目录（宁静号认知容器）' },
      DSH_SERENITY_CCC: { description: 'CCC 名称（根目录 basename）' },
      DSH_SERENITY_VERSION: { description: 'ACC 插件版本' },
    },
    resolve(execution: ToolExecution) {
      const cwd = (execution.agent?.session as { header?: { cwd?: string } } | undefined)?.header?.cwd ?? process.cwd()
      return resolveSerenityEnv(cwd)
    },
  }
  ctx.shellEnv.register(contributor)
}
