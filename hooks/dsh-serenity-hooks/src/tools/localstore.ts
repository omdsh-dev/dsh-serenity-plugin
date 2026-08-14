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
    'ACC 标准本地凭据/配置存储：一个工具管理两个命名空间 credential（凭据）与 config（本地偏好）。' +
    '存储于 CCC 根根目录 localstore.json（JSON 格式，MSM 可直接读取）。' +
    'git 策略：.opencode/serenity.json localstore.gitTrack（allow 可提交 / deny 禁提交，缺省 deny；.dsh 回退）——deny 时写入自动确保 .gitignore 含该文件（物理保证），cc_git commit 会检查拒绝。' +
    '子命令：list（列 key，凭据不返回值）/ get <name>（读值）/ set <name> <value>（写）/ unset <name>（删）/ show <name>（元数据，凭据不打印值）/ doc（输出存储规范——路径/格式/key 规范/git 策略，agent 可按说明直接用 read/write 操作文件）。' +
    '默认 scope=credential；config 需传 --scope config（路径为 section.key，如 loop.defaultModel）。',
  parameters: {
    action: { type: 'string', enum: [...ACTIONS], required: true, description: '子命令：list/get/set/unset/show/doc' },
    name: { type: 'string', description: '条目名（credential 用大写蛇形；config 用 section.key）' },
    value: { type: 'string', description: 'set 的值' },
    scope: { type: 'string', enum: [...LOCALSTORE_SCOPES], description: '命名空间 credential|config（默认 credential）' },
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
