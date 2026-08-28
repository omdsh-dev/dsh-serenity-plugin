/**
 * handyman-ops.ts — handyman（杂工）纯逻辑层（零 DSH 依赖，可独立单测）
 *
 * v1.24.0：loop（牛马）→ handyman（杂工）重命名。语义对齐 osp loop：
 * 进度文件（handyman-<label>.md/.json）、续跑、轮次 prompt 结构、stop token。
 * 不兼容旧 loop- 进度文件（用户拍板：仅新 handyman- 前缀）。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

export interface HandymanProgress {
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

/** label 脱敏（Windows 审计问题 17）：非法字符 → '-'，去尾点/空格，限长（按码点截断，修复代理对切散 U+FFFD） */
export function sanitizeLabel(label: string): string {
  return [...label
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/[ .]+$/g, '')]
    .slice(0, 50)
    .join('')
}

export function handymanProgressPaths(root: string, label: string): { md: string; json: string } {
  const dir = join(root, 'AGENT_SESSIONS')
  const safe = sanitizeLabel(label)
  return { md: join(dir, `handyman-${safe}.md`), json: join(dir, `handyman-${safe}.json`) }
}

/** 读取进度（续跑）；无文件返回 round 0 */
export function readProgress(root: string, label: string): HandymanProgress | null {
  const { json } = handymanProgressPaths(root, label)
  if (!existsSync(json)) return null
  try {
    return JSON.parse(readFileSync(json, 'utf-8')) as HandymanProgress
  } catch {
    return null
  }
}

export function writeProgress(root: string, label: string, p: HandymanProgress): void {
  const { md, json } = handymanProgressPaths(root, label)
  mkdirSync(join(root, 'AGENT_SESSIONS'), { recursive: true })
  writeFileSync(
    json,
    JSON.stringify({ ...p, status: p.status ?? 'running', updated: new Date().toISOString() }, null, 2) + '\n',
    'utf-8',
  )
  const lines = [`# handyman: ${label}`, `- Model: ${p.model}`, `- Round: ${p.round}`, `- Done: ${p.done}`, '', `## Latest response`, '', p.lastResponse, '']
  writeFileSync(md, lines.join('\n'), 'utf-8')
}

/** 失败状态落盘（对齐 osp writeFailedStatus：done=true / status=failed / errorCode） */
export function writeFailedStatus(root: string, label: string, info: { errorCode: string; errorMessage?: string }): void {
  const { json } = handymanProgressPaths(root, label)
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
  return `SERENITY_HANDYMAN_DONE_${randomBytes(8).toString('hex')}`
}

/** 解析 model 字符串（provider/model）→ {provider, model}；无 / 视为 model-only */
export function splitModel(model: string): { provider: string | undefined; model: string } {
  const idx = model.indexOf('/')
  if (idx < 0) return { provider: undefined, model }
  return { provider: model.slice(0, idx), model: model.slice(idx + 1) }
}

/** 校验模型在白名单内；不在 → 抛错（用户拍板：只能使用 CCC 配置的模型） */
export function requireWhitelistedModel(model: string, models: string[]): void {
  if (!models.includes(model)) {
    throw new Error(
      `handyman: model "${model}" is not in the CCC whitelist. ` +
        `Configure .opencode/serenity.json "handyman.models" with one of: ${models.join(', ')}`,
    )
  }
}

/** 轮次 prompt（对齐老 loop 结构：回顾进度 → 自由工作 → 汇报；S134 EAP 化：固定详尽） */
export function buildRoundPrompt(opts: {
  root: string
  session?: string
  label: string
  round: number
  stopToken: string
  progress?: HandymanProgress | null
  task?: string
}): string {
  const { root, session, label, round, stopToken, progress, task } = opts
  const resumeNote =
    progress && progress.round > 0
      ? `Previous round (round ${progress.round}) completed: ${progress.lastResponse.slice(0, 300)}\nAlways continue from where you left off; never redo completed work.`
      : 'This is the first round.'
  const sessionNote = session ? `Work session: ${session} (progress recorded in AGENT_SESSIONS/${session}/SESSION.md)` : ''
  const taskNote = task ? `Task: ${task}` : `Task: follow the work corresponding to label "${label}" (if a work session exists, read SESSION.md first to clarify the goal)`
  return `# ${label} — handyman round ${round}

CCC root: ${root}
${sessionNote}
${taskNote}
${resumeNote}

## Work rules (fixed every round, must follow)
1. Work freely within this round: read files, modify code, execute commands — use every means to advance the task.
2. If this task is **reading/curating or text-writing work** (extracting from files, summarizing, writing docs, generating text, etc.),
   first load eap (acc-eap skill) and organize output per the EAP standard:
   - E↑ Explicit: entities/variables clearly defined, relationships with direction and cardinality, boundaries drawn, no ambiguous words
   - R↓ Reconstructable: key conclusions record sources and reasoning, rebuildable by later agents
   - S↑ Stable: output structure regenerates repeatably, no reliance on implicit context
3. Reports must be concrete and verifiable — no filler.

## Per-round report (fixed format, answer each item)
1. What was done this round (concrete)
2. Next-step plan
3. Whether the task is complete (if complete, output only ${stopToken})

If the task is complete, output only ${stopToken}.`
}

/**
 * handyman 规模化使用指引（guide 子命令输出；S134 继承 + v1.24.0 更新）：
 * 使用 handyman 前必须先加载 eap 设计方案；并行策略（jobs 编排）；提示词规范（详尽固定 EAP）；
 * 阅读/文字编写类 handyman 内部也加载 eap。
 */
export const HANDYMAN_GUIDE = `# handyman — Scale-Up Usage Guide (guide)

## ⚠️ Before using: load eap and design the plan
Before calling handyman, load eap (acc-eap skill) and design the "scale-up handyman plan" based on the EAP framework.

### 1. Task decomposition (E↑ Explicit)
- Split large tasks into explicit subtasks: each subtask defines goal / input / boundaries (what to do, what not to do) / acceptance criteria
- Make dependencies explicit: dependent tasks run serially, independent ones can run in parallel

### 2. Prompt design (handyman's task parameter)
- task must be detailed, fixed, and EAP-compliant: clear goal, drawn boundaries, decidable acceptance criteria
- Anti-example "handle this file" — ambiguous; good example "read <path>, extract all rows of the「关键决策」table,
  output a JSON array (fields id/conclusion/evidence), do not modify the original file"
- Reading/curating or text-writing work (extracting from files, summarizing, writing docs, generating text, etc.):
  the handyman-internal agent is also required to load eap and organize output per the EAP standard

### 3. Model whitelist (CCC-configured, mandatory)
- handyman only uses models listed in .opencode/serenity.json "handyman.models" — never arbitrary models
- Recursive subagents inside a handyman inherit the handyman's model automatically (DSH native)
- Keep the subagent tool instance free of a fixed agentOptions, or model inheritance breaks

### 4. Parallel strategy (jobs orchestration, workflow capability)
- Independent subtasks can run in parallel via handyman(jobs=[...]): each job gets its own label + task + stop token + progress file
- Concurrency safety guaranteed: unique sessionId (handyman-<label>-<uuid>), progress files isolated per label
  (AGENT_SESSIONS/handyman-<label>.json) — same label resumes, different labels never interfere
- Parallel cap: handyman.maxParallel (default 10 — cheap models are cheap)
- Aggregation: after each parallel job produces progress, the main agent merges (or spawns one aggregation handyman)
- For programmable pipeline/phase orchestration at scale, use the platform's workflow tool instead

## Completion criteria (osp loop standard)
- The only completion condition = the handyman-internal agent echoes this round's random verification code (stop token); dialogue round cap (default 100, osp fail-safe, forced stop beyond the cap, resumable)
- Automatic restart on abnormal agent stop (≤100 restarts, anti-infinite-loop)

## Waiting UI
- The WebUI session-header Serenity detail card shows running handymen's progress (label / round / last response), one line per parallel job, ~3s refresh
`

/** handyman 运行状态（进度文件摘要；WebUI 等待界面数据源） */
export interface HandymanRunInfo {
  label: string
  round: number
  done: boolean
  model: string
  updated: string
  lastResponse: string
}

/** 列出 AGENT_SESSIONS/handyman-*.json 的全部进度（按 updated 倒序；坏文件跳过） */
export function listActiveHandymen(root: string): HandymanRunInfo[] {
  const dir = join(root, 'AGENT_SESSIONS')
  if (!existsSync(dir)) return []
  const out: HandymanRunInfo[] = []
  for (const entry of readdirSync(dir)) {
    if (!entry.startsWith('handyman-') || !entry.endsWith('.json')) continue
    try {
      const data = JSON.parse(readFileSync(join(dir, entry), 'utf-8')) as HandymanRunInfo
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
