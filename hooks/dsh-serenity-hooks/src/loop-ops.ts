/**
 * loop-ops.ts — acc_loop 纯逻辑层（零 DSH 依赖，可独立单测）
 *
 * 对齐 opencode-serenity-plugin 老 loop 语义：进度文件（loop-<label>.md/.json）、
 * 续跑、轮次 prompt 结构、stop token。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

export interface LoopProgress {
  round: number
  done: boolean
  label: string
  model: string
  updated: string
  lastResponse: string
}

export function loopProgressPaths(root: string, label: string): { md: string; json: string } {
  const dir = join(root, 'AGENT_SESSIONS')
  return { md: join(dir, `loop-${label}.md`), json: join(dir, `loop-${label}.json`) }
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
    JSON.stringify({ ...p, updated: new Date().toISOString() }, null, 2) + '\n',
    'utf-8',
  )
  const lines = [`# loop: ${label}`, `- 模型: ${p.model}`, `- 轮次: ${p.round}`, `- 完成: ${p.done}`, '', `## 最近响应`, '', p.lastResponse, '']
  writeFileSync(md, lines.join('\n'), 'utf-8')
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

/** 轮次 prompt（对齐老 loop 结构：回顾进度 → 自由工作 → 汇报） */
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

本轮内你可以自由工作：读文件、改代码、执行命令，尽一切手段推进任务。
每轮结束时汇报：
1. 本轮做了什么（具体）
2. 下一步计划
3. 是否已完成（若完成，输出 ${stopToken}）

若已完成任务，只输出 ${stopToken}。`
}
