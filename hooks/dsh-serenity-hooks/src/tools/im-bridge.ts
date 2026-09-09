/**
 * im-bridge.ts（工具面）— IM 消息发送工具（v1.31.0）
 *
 * 用户洞察（S142）：微信桥是 ACC 提供的 → **发送能力也应是 ACC 的工具**；
 * 「当用户配置了微信桥则可用，不配置则不可见」。
 *
 * 本文件只做工具面三件事：① 从 agent 会话解析**本会话 CCC**（R4：不接受目标 CCC）
 * ② 把参数交给 `im-bridge.ts`（能力层）分发 ③ 渲染结果/错误。
 *
 * 可见性不在这里判定：`seams/context.ts` 在会话就绪时按 CCC 配置
 * `agent.ctx.tools.restrict({ deny: ['im-bridge'] })` 把本工具从**未配置通道**的
 * agent 工具清单中移除（未配置 = 模型看不到，而非"看得到但被拒"）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { findSerenityRoot } from '../ccc.js'
import { runImBridge, imChannelIds } from '../im-bridge.js'

const ACTIONS = ['send', 'send-file', 'users', 'status'] as const

function agentCwd(exec: { agent?: { session?: { header?: { cwd?: string } } } }): string {
  return exec.agent?.session?.header?.cwd ?? process.cwd()
}

function renderText(value: unknown): ContentBlock[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

/**
 * IM 发送工具（`im-bridge`）。通道维度为将来其他 IM 预留（R3）——
 * 新增通道只注册实现，不改工具名与参数形状。
 */
export function createImBridgeTool() {
  return defineTool({
    name: 'im-bridge',
    description:
      'Send messages to family members through an IM channel configured for THIS container (currently: weixin / 微信). '
      + 'Every successful send is recorded in the container log automatically; this tool only acts on the current container (no target container parameter). '
      + 'It is hidden entirely when this container has no IM channel configured. '
      + `Channels: ${imChannelIds().join(', ') || '(none registered)'}. `
      + 'Actions: send (text) / send-file (a file inside this container) / users (list configured recipients) / status (channel health). '
      + 'user accepts a configured alias (e.g. yh, danica) or a raw channel user id. '
      + 'Failures return a stable code plus a remediation hint.',
    parameters: {
      channel: { type: 'string', description: `IM channel id (e.g. "weixin"); available: ${imChannelIds().join(', ') || '(none)'}` , required: true },
      action: { type: 'string', enum: [...ACTIONS], required: true, description: 'send / send-file / users / status' },
      user: { type: 'string', description: 'Recipient: configured alias (yh, danica) or raw channel user id (send / send-file)' },
      text: { type: 'string', description: 'Message text, plain text only (send)' },
      file: { type: 'string', description: 'File path inside this container, relative to the container root (send-file)' },
      caption: { type: 'string', description: 'Optional caption sent as a separate message (send-file)' },
      account: { type: 'string', description: 'Channel account id (default: the first enabled, bound account)' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderText(value),
    },
    async execute(args, exec) {
      const root = findSerenityRoot(agentCwd(exec))
      if (!root) {
        return {
          ok: false,
          code: 'CCC_UNRESOLVED',
          error: 'this session is not inside a Serenity container (no .serenity marker found from the session cwd)',
        }
      }
      return runImBridge(root, args)
    },
  })
}
