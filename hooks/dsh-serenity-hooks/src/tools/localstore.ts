/**
 * localstore.ts — localstore 真实 DSH 工具定义（defineTool）
 *
 * ACC 标准本地凭据/配置存储（S133 设计）。进程内注册，零 DSH 依赖逻辑在
 * localstore-ops.ts（可单测）。doc 子命令输出存储规范，agent 可直接用 fs
 * 工具（read/write）自己读写。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { runLocalStore, LOCALSTORE_SCOPES } from '../localstore-ops.js'

const ACTIONS = ['list', 'get', 'set', 'unset', 'show', 'doc'] as const

function renderText(value: unknown): ContentBlock[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

export const localstoreTool = defineTool({
  name: 'localstore',
  description:
    'ACC 标准本地凭据/配置存储：一个工具管理两个命名空间 credential（凭据，0600）与 config（本地偏好，0644）。' +
    '存储于用户主目录 ~/.serenity/（平台感知，不在任何 git 仓库内）。' +
    '子命令：list（列 key，凭据不返回值）/ get <name>（读值）/ set <name> <value>（写）/ unset <name>（删）/ show <name>（元数据，凭据不打印值）/ doc（输出存储规范——路径/格式/key 规范/权限，agent 可按说明直接用 read/write 操作文件）。' +
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
  async execute(args) {
    return runLocalStore(args)
  },
})
