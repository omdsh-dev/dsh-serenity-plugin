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
    'CCC 内文件系统操作（cc-fs 语义，DSH 原生版）。15 子命令：root/resolve/exists/list/tree/relative/mkdir/rm/mv/cp/touch/append/reveal/info/find。全部路径限定在 CCC 根内，路径逃逸自动阻断。reveal 在 OS 文件管理器中打开路径（Linux xdg-open / macOS Finder / Windows Explorer）。与 read/write/edit 互补（结构性操作）。',
  parameters: {
    action: {
      type: 'string',
      enum: [...CC_FS_ACTIONS],
      required: true,
      description: '子命令',
    },
    path: { type: 'string', description: '主路径参数（resolve/exists/list/tree/relative/touch/append/info/rm 单路径）' },
    paths: { type: 'array', items: { type: 'string' }, description: '批量路径（mkdir/rm）' },
    src: { type: 'string', description: 'mv/cp 源路径' },
    dst: { type: 'string', description: 'mv/cp 目标路径' },
    content: { type: 'string', description: 'append 内容' },
    pattern: { type: 'string', description: 'find 匹配（glob *? 或大小写不敏感子串）' },
    depth: { type: 'integer', description: 'tree 最大深度（1-10，默认 3）' },
    dryRun: { type: 'boolean', description: 'rm/archive 预览模式' },
    recursive: { type: 'boolean', description: 'rm 删目录 / cp 复制目录需 recursive' },
    filesOnly: { type: 'boolean', description: 'tree 只显示文件（与 dirsOnly 互斥）' },
    dirsOnly: { type: 'boolean', description: 'tree 只显示目录（与 filesOnly 互斥）' },
    absolute: { type: 'boolean', description: 'find 返回绝对路径' },
    maxDepth: { type: 'integer', description: 'find 最大递归深度（缺省不限）' },
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
