/**
 * git.ts — cc_git 真实 DSH 工具定义（defineTool）
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { findSerenityRoot } from '../ccc.js'
import { runGit, GIT_ACTIONS } from '../git-ops.js'

function agentCwd(exec: { agent?: { session?: { header?: { cwd?: string } } } }): string {
  return exec.agent?.session?.header?.cwd ?? process.cwd()
}

function renderText(value: unknown): ContentBlock[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

export const gitTool = defineTool({
  name: 'cc_git',
  description:
    'CCC git operations (cc-git semantics, aligned with osp). status/commit/push/log/pull/diff; non-fast-forward push/pull outputs [REJECTED] + suggested actions (never auto-force). merge/rebase/conflict resolution go through bash.',
  parameters: {
    action: { type: 'string', enum: [...GIT_ACTIONS], required: true, description: 'Subcommand: status/commit/push/log/pull/diff' },
    message: { type: 'string', description: 'Commit message (required for commit)' },
    // 注意：公测 rc.6 value schema DSL 不支持 minimum/maximum 数字边界键（defineTool 阶段会拒绝）。
    // 边界校验（1-100）在 git-ops.ts 运行时 clamp 执行。
    count: { type: 'integer', description: 'Log count (default 10, max 100; runtime clamp 1-100)' },
    staged: { type: 'boolean', description: 'diff: show staged changes (--cached)' },
    ref: { type: 'string', description: 'diff: compare ref (e.g. HEAD~1 / main / origin/main)' },
    path: { type: 'string', description: 'diff: restrict to path (e.g. src/, package.json)' },
  },
  output: {
    schema: { type: 'json' },
    render: (args, value) => renderText(value),
  },
  async execute(args, exec) {
    const root = findSerenityRoot(agentCwd(exec))
    if (!root) throw new Error('No CCC found: no .serenity file from agent cwd')
    return runGit(root, args)
  },
})
