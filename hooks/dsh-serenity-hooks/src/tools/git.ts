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
    'CCC 内 git 操作（cc-git 语义，对齐 osp）。status/commit/push/log/pull/diff；push/pull 非快进时输出 [REJECTED] + 操作建议（绝不自动 force）。merge/rebase/冲突解决走 bash。',
  parameters: {
    action: { type: 'string', enum: [...GIT_ACTIONS], required: true, description: '子命令：status/commit/push/log/pull/diff' },
    message: { type: 'string', description: 'commit 消息（commit 必填）' },
    count: { type: 'integer', description: 'log 条数（默认 10，max 100）' },
    staged: { type: 'boolean', description: 'diff: 显示暂存区变更（--cached）' },
    ref: { type: 'string', description: 'diff: 对比 ref（如 HEAD~1 / main / origin/main）' },
    path: { type: 'string', description: 'diff: 限定路径（如 src/、package.json）' },
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
