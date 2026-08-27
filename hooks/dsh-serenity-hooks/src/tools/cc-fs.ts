/**
 * cc-fs.ts — cc_fs 真实 DSH 工具定义（defineTool）
 *
 * 进程内注册（取代 v0.1 的 bash spawn runner）：zod/schemastery 参数校验、
 * 规范 JSON 输出、纯 render 投影。逻辑在 fs-ops.ts（可单测）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { findSerenityRoot } from '../ccc.js'
import { runCcFs, CC_FS_ACTIONS } from '../fs-ops.js'

function agentCwd(exec: { agent?: { session?: { header?: { cwd?: string } } } }): string {
  return exec.agent?.session?.header?.cwd ?? process.cwd()
}

function renderText(value: unknown): ContentBlock[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

export const ccFsTool = defineTool({
  name: 'cc_fs',
  description:
    'CCC filesystem operations (cc-fs semantics, DSH-native). 15 subcommands: root/resolve/exists/list/tree/relative/mkdir/rm/mv/cp/touch/append/reveal/info/find. All paths confined to the CCC root; path escape is blocked automatically. reveal opens a path in the OS file manager (Linux xdg-open / macOS Finder / Windows Explorer). Complements read/write/edit (structural operations).',
  parameters: {
    action: {
      type: 'string',
      enum: [...CC_FS_ACTIONS],
      required: true,
      description: 'Subcommand',
    },
    path: { type: 'string', description: 'Primary path argument (single-path ops: resolve/exists/list/tree/relative/touch/append/info/rm)' },
    paths: { type: 'array', items: { type: 'string' }, description: 'Batch paths (mkdir/rm)' },
    src: { type: 'string', description: 'mv/cp source path' },
    dst: { type: 'string', description: 'mv/cp destination path' },
    content: { type: 'string', description: 'append content' },
    pattern: { type: 'string', description: 'find match (glob *? or case-insensitive substring)' },
    depth: { type: 'integer', description: 'tree max depth (1-10, default 3)' },
    dryRun: { type: 'boolean', description: 'rm/archive preview mode' },
    recursive: { type: 'boolean', description: 'rm directory / cp directory requires recursive' },
    filesOnly: { type: 'boolean', description: 'tree shows files only (mutually exclusive with dirsOnly)' },
    dirsOnly: { type: 'boolean', description: 'tree shows directories only (mutually exclusive with filesOnly)' },
    absolute: { type: 'boolean', description: 'find returns absolute paths' },
    maxDepth: { type: 'integer', description: 'find max recursion depth (default unlimited)' },
  },
  output: {
    schema: { type: 'json' },
    render: (args, value) => renderText(value),
  },
  async execute(args, exec) {
    const root = findSerenityRoot(agentCwd(exec))
    if (!root) throw new Error('No CCC found: no .serenity file from agent cwd')
    return runCcFs(root, args)
  },
})
