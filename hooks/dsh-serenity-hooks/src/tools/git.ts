/**
 * git.ts — container_git 真实 DSH 工具定义（defineTool）（v1.30：cc_git → container_git）
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { cccRootForExec, NO_CCC_FROM_AGENT_CWD } from '../ccc-roots.js'
import { runGit, GIT_ACTIONS } from '../git-ops.js'

function renderText(value: unknown): ContentBlock[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

export const gitTool = defineTool({
  name: 'container_git',
  description:
    'CCC git operations (cc-git semantics, aligned with osp). status/commit/push/log/pull/diff. commit 默认**随后自动 push**（noPush 可关）；commit 传 paths ⇒ 只提交这些路径（不传=整仓 add -A，回执会显式告知）。push 成功判据 = --porcelain 的 ref 行（**超时/未确认一律不报成功**，回执给 `git ls-remote` 核验指令）；非快进 push/pull 输出 [REJECTED] + 建议（never auto-force）。merge/rebase/conflict resolution go through bash.',
  parameters: {
    action: { type: 'string', enum: [...GIT_ACTIONS], required: true, description: 'Subcommand: status/commit/push/log/pull/diff' },
    message: { type: 'string', description: 'Commit message (required for commit)' },
    paths: {
      type: 'array',
      items: { type: 'string' },
      description:
        'commit: 只提交这些路径（如 ["docs/a.md","src/b.ts"]）。不传 = 整仓 `git add -A`（会吸走其它轨迹的在途文件，回执会显式提示）',
    },
    noPush: { type: 'boolean', description: 'commit: 只提交到本地，不随后推送（默认提交后自动推送）' },
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
    const root = cccRootForExec(exec)
    if (!root) throw new Error(NO_CCC_FROM_AGENT_CWD)
    return runGit(root, args)
  },
})
