/**
 * localstore.ts — localstore 真实 DSH 工具定义（defineTool）
 *
 * ACC 标准本地凭据/配置存储（S133 设计，S134 重设计：CCC 根 localstore.json）。
 * 进程内注册，零 DSH 依赖逻辑在 localstore-ops.ts（可单测）。
 * doc 子命令输出存储规范，agent 可直接用 fs 工具（read/write）自己读写。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { findSerenityRoot } from '../ccc.js'
import { runLocalStore, LOCALSTORE_SCOPES } from '../localstore-ops.js'

const ACTIONS = ['list', 'get', 'set', 'unset', 'show', 'doc'] as const

function agentCwd(exec: { agent?: { session?: { header?: { cwd?: string } } } }): string {
  return exec.agent?.session?.header?.cwd ?? process.cwd()
}

function renderText(value: unknown): ContentBlock[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

export const localstoreTool = defineTool({
  name: 'localstore',
  description:
    'ACC standard local credential/config storage: one tool manages two namespaces — credential (credentials) and config (local preferences). ' +
    'Stored in localstore.json at the CCC root (JSON format, directly readable by MSMs). ' +
    'Git policy: .opencode/serenity.json localstore.gitTrack (allow commits / deny commits, default deny; .dsh fallback) — when deny, writes ensure .gitignore contains this file (physical guarantee), cc_git commit checks and refuses. ' +
    'Subcommands: list (list keys, credentials never return values) / get <name> (read value) / set <name> <value> (write) / unset <name> (delete) / show <name> (metadata, credentials never print values) / doc (output the storage spec — path/format/key conventions/git policy; agents may operate the file directly with read/write per the spec). ' +
    'Default scope=credential; config requires --scope config (path is section.key, e.g. loop.defaultModel).',
  parameters: {
    action: { type: 'string', enum: [...ACTIONS], required: true, description: 'Subcommand: list/get/set/unset/show/doc' },
    name: { type: 'string', description: 'Entry name (credentials: UPPER_SNAKE; config: section.key)' },
    value: { type: 'string', description: 'set value' },
    scope: { type: 'string', enum: [...LOCALSTORE_SCOPES], description: 'Namespace credential|config (default credential)' },
  },
  output: {
    schema: { type: 'json' },
    render: (args, value) => renderText(value),
  },
  async execute(args, exec) {
    const root = findSerenityRoot(agentCwd(exec))
    if (!root) throw new Error('No CCC found: no .serenity file from agent cwd')
    return runLocalStore(root, args)
  },
})
