/**
 * loop-ops.ts — acc_loop 纯逻辑层（零 DSH 依赖，可独立单测）
 *
 * 对齐 opencode-serenity-plugin 老 loop 语义：进度文件（loop-<label>.md/.json）、
 * 续跑、轮次 prompt 结构、stop token。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

export interface LoopProgress {
  round: number
  done: boolean
  label: string
  model: string
  updated: string
  lastResponse: string
  /** 对齐 osp writeFailedStatus：failed 时 done=true + status=failed + errorCode */
  status?: 'running' | 'done' | 'failed'
  errorCode?: string
  errorMessage?: string
}

/** label 脱敏（Windows 审计问题 17）：非法字符 → '-'，去尾点/空格，限长 */
export function sanitizeLabel(label: string): string {
  return label
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/[ .]+$/g, '')
    .slice(0, 50)
}

export function loopProgressPaths(root: string, label: string): { md: string; json: string } {
  const dir = join(root, 'AGENT_SESSIONS')
  const safe = sanitizeLabel(label)
  return { md: join(dir, `loop-${safe}.md`), json: join(dir, `loop-${safe}.json`) }
}

/** 读取进度（续跑）；无文件返回 round 0 */
export function readProgress(root: string, label: string): LoopProgress | null {
  const { json } = loopProgressPaths(root, label)
  if (!existsSync(json)) return null
  try {
    return JSON.parse(readFileSync(json, 'utf-8')) as LoopProgress
  } catch {
    return null
  }
}

export function writeProgress(root: string, label: string, p: LoopProgress): void {
  const { md, json } = loopProgressPaths(root, label)
  mkdirSync(join(root, 'AGENT_SESSIONS'), { recursive: true })
  writeFileSync(
    json,
    JSON.stringify({ ...p, status: p.status ?? 'running', updated: new Date().toISOString() }, null, 2) + '\n',
    'utf-8',
  )
  const lines = [`# loop: ${label}`, `- 模型: ${p.model}`, `- 轮次: ${p.round}`, `- 完成: ${p.done}`, '', `## 最近响应`, '', p.lastResponse, '']
  writeFileSync(md, lines.join('\n'), 'utf-8')
}

/** 失败状态落盘（对齐 osp writeFailedStatus：done=true / status=failed / errorCode） */
export function writeFailedStatus(root: string, label: string, info: { errorCode: string; errorMessage?: string }): void {
  const { json } = loopProgressPaths(root, label)
  mkdirSync(join(root, 'AGENT_SESSIONS'), { recursive: true })
  const prev = readProgress(root, label)
  writeFileSync(
    json,
    JSON.stringify(
      {
        round: prev?.round ?? 0,
        done: true,
        label,
        model: prev?.model ?? '',
        status: 'failed',
        errorCode: info.errorCode,
        errorMessage: info.errorMessage,
        updated: new Date().toISOString(),
        lastResponse: prev?.lastResponse ?? '',
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  )
}

export function newStopToken(): string {
  return `SERENITY_LOOP_DONE_${randomBytes(8).toString('hex')}`
}

/** 解析 model 字符串（provider/model）→ {provider, model}；无 / 视为 model-only */
export function splitModel(model: string): { provider: string | undefined; model: string } {
  const idx = model.indexOf('/')
  if (idx < 0) return { provider: undefined, model }
  return { provider: model.slice(0, idx), model: model.slice(idx + 1) }
}

/** 轮次 prompt（对齐老 loop 结构：回顾进度 → 自由工作 → 汇报；S134 EAP 化：固定详尽） */
export function buildRoundPrompt(opts: {
  root: string
  session?: string
  label: string
  round: number
  stopToken: string
  progress?: LoopProgress | null
  task?: string
}): string {
  const { root, session, label, round, stopToken, progress, task } = opts
  const resumeNote =
    progress && progress.round > 0
      ? `上一轮（round ${progress.round}）已完成：${progress.lastResponse.slice(0, 300)}\n永远从上次停止处继续，绝不重做已完成工作。`
      : '这是第一轮。'
  const sessionNote = session ? `工作会话：${session}（AGENT_SESSIONS/${session}/SESSION.md 记录进度）` : ''
  const taskNote = task ? `任务：${task}` : `任务：以 label「${label}」对应的工作为准（若存在工作会话，先读 SESSION.md 明确目标）`
  return `# ${label} — 牛马循环 round ${round}

CCC 根：${root}
${sessionNote}
${taskNote}
${resumeNote}

## 工作规范（每轮固定，必须遵守）
1. 本轮内自由工作：读文件、改代码、执行命令，尽一切手段推进任务。
2. 若本任务属于**阅读整理或文字编写类工作**（读文件提炼、总结、撰写文档、生成文本等），
   请先加载 eap（acc-eap skill）并按 EAP 标准组织输出：
   - E↑ 显式：实体/变量明确定义，关系指明方向与基数，边界划定，不用歧义词
   - R↓ 可重建：关键结论记录来源与推理，可被后续 agent 重建
   - S↑ 稳定：输出结构可重复生成，不依赖隐含上下文
3. 汇报必须具体可核验，不写空话。

## 每轮汇报（固定格式，逐条回答）
1. 本轮做了什么（具体）
2. 下一步计划
3. 是否已完成（若完成，只输出 ${stopToken}）

若已完成任务，只输出 ${stopToken}。`
}

/**
 * loop 规模化使用指引（guide 子命令输出；S134）：
 * 使用 loop 前必须先加载 eap 设计方案；并行策略；提示词规范（详尽固定 EAP）；
 * 阅读/文字编写类 loop 内部也加载 eap。
 */
export const LOOP_GUIDE = `# loop — 规模化使用指引（guide）

## ⚠️ 使用前：必须先加载 eap 设计方案
调用 loop 前，请先加载 eap（acc-eap skill），基于 EAP 框架设计「规模化 loop 方案」。

### 1. 任务拆解（E↑ 显式）
- 大任务拆成明确子任务：每个子任务定义 目标 / 输入 / 边界（做什么、不做什么）/ 验收标准
- 依赖显式化：有依赖的串行，无依赖的可并行

### 2. 提示词设计（loop 的 task 参数）
- task 必须详尽、固定、符合 EAP：目标明确、边界划定、验收标准可判定
- 反例「处理这个文件」——歧义；正例「读取 <路径>，提取「关键决策」表格全部行，
  输出 JSON 数组（字段 id/结论/证据），不改动原文件」
- 阅读整理 / 文字编写类工作（读文件提炼、总结、撰写文档、生成文本等）：
  loop 内部 agent 也会被要求加载 eap，按 EAP 标准组织输出

### 3. 并行策略（规模化）
- 无依赖的子任务可并行：每个子任务一个独立 loop（独立 label + task）
- 并行执行方式：
  a. 后台 subagent：每个 subagent 内调 loop（各自 label），subagent 并行运行
  b. workflow：parallel 阶段驱动多个 loop 子 agent
- 并发安全已保证：sessionId 唯一（loop-<label>-<uuid>）、进度文件按 label 隔离
  （AGENT_SESSIONS/loop-<label>.json）——同 label 续跑、不同 label 互不干扰
- 汇总：并行 loop 各自产出进度后，主 agent 汇总合并（或再派一个汇总 loop）

## 完成判定
- 唯一完成条件 = loop 内部 agent 精确回显本轮随机验证码（stop token）；对话轮次上限 100（对齐 osp 保险阀，超限强制结束可续跑）
- agent 非正常停止时自动重启（≤100 次防死循环）

## 等待界面
- WebUI 会话头部 Serenity 详情卡显示运行中 loop 的进度（label / 轮次 / 最近响应），并行任务各自一行，约 3s 刷新
`

/** loop 运行状态（进度文件摘要；WebUI 等待界面数据源） */
export interface LoopRunInfo {
  label: string
  round: number
  done: boolean
  model: string
  updated: string
  lastResponse: string
}

/** 列出 AGENT_SESSIONS/loop-*.json 的全部进度（按 updated 倒序；坏文件跳过） */
export function listActiveLoops(root: string): LoopRunInfo[] {
  const dir = join(root, 'AGENT_SESSIONS')
  if (!existsSync(dir)) return []
  const out: LoopRunInfo[] = []
  for (const entry of readdirSync(dir)) {
    if (!entry.startsWith('loop-') || !entry.endsWith('.json')) continue
    try {
      const data = JSON.parse(readFileSync(join(dir, entry), 'utf-8')) as LoopRunInfo
      if (typeof data.label !== 'string' || typeof data.round !== 'number') continue
      out.push({
        label: data.label,
        round: data.round,
        done: data.done === true,
        model: typeof data.model === 'string' ? data.model : '',
        updated: typeof data.updated === 'string' ? data.updated : '',
        lastResponse: typeof data.lastResponse === 'string' ? data.lastResponse : '',
      })
    } catch {
      /* 坏进度文件跳过 */
    }
  }
  out.sort((a, b) => (a.updated < b.updated ? 1 : -1))
  return out
}
