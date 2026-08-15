/**
 * msm.ts — acc_msm 真实 DSH 工具定义（defineTool）
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { findSerenityRoot } from '../ccc.js'
import { runMsmAsync, MSM_ACTIONS } from '../msm-ops.js'

function agentCwd(exec: { agent?: { session?: { header?: { cwd?: string } } } }): string {
  return exec.agent?.session?.header?.cwd ?? process.cwd()
}

function renderText(value: unknown): ContentBlock[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

export const msmTool = defineTool({
  name: 'acc_msm',
  description:
    'MSM（Mech & Semi-Mech）框架：list 列出注册 MSM（header+flags 展示）；exec 执行（600s 超时，path 逃逸+symlink 阻断，注入 SERENITY_ROOT/CCC/VERSION env，失败追加 --help TIP；参数首位 --list/--schema/--format=json 为协议）；register/deregister 管理注册表（path 根内+脚本存在+全局唯一校验，自动 git 精提交）；check 品质检查 DC-M1~M4；guide 开发手册；ccc-config CCC 配置参考（loop.defaultModel/sessionKeeper.threshold/localstore.gitTrack/hooks.autoRestoreSession）。复用 CCC 的 mech-registry.json。',
  parameters: {
    action: { type: 'string', enum: [...MSM_ACTIONS], required: true, description: '子命令：list/exec/register/deregister/check/guide/ccc-config' },
    name: { type: 'string', description: 'MSM 名（exec/register/deregister）' },
    args: { type: 'array', items: { type: 'string' }, description: 'exec 的业务参数（参数首位 --list/--schema <n>/--format=json 为协议 flag，其余无损透传）' },
    skill: { type: 'string', description: 'register 的所属 skill' },
    path: { type: 'string', description: 'register 的脚本相对路径（必须根内且存在）' },
    category: { type: 'string', description: 'register 的类别（mech/semi-mech）' },
    description: { type: 'string', description: 'register 的描述' },
    flags: { type: 'string', description: 'register 的 flags JSON 字符串（new-style 对象数组，type:"path" 启用逃逸校验）' },
    usage: { type: 'string', description: 'register 的自定义 usage（缺省自动生成）' },
  },
  output: {
    schema: { type: 'json' },
    render: (args, value) => renderText(value),
  },
  async execute(args, exec) {
    const root = findSerenityRoot(agentCwd(exec))
    if (!root) throw new Error('No CCC found: no .serenity file from agent cwd')
    // runMsmAsync：exec 用异步 execFile（不阻塞 web 事件循环，避免 MSM 自请求 3080 死锁）
    return runMsmAsync(root, args)
  },
})
