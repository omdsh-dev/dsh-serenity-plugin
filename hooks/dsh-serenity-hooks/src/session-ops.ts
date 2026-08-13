/**
 * session-ops.ts — session 工具纯操作层（零 DSH 依赖，可独立单测）
 *
 * 移植自 dsh-serenity-plugin v0.1 acc-session runner（本项目自有代码）。
 * 操作 CCC 根的 AGENT_SESSIONS/ 目录，返回规范 JSON 值。
 */

import { existsSync, statSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import type { JsonValue } from './json.js'

export type SessionAction = 'list' | 'show' | 'create' | 'use' | 'close' | 'health' | 'qa' | 'archive' | 'summary'

export const SESSION_ACTIONS: readonly SessionAction[] = ['list', 'show', 'create', 'use', 'close', 'health', 'qa', 'archive', 'summary']

export type SessionInfo = {
  dir: string
  id: string | null
  hasSessionMd: boolean
  mtime: string
  status: string | null
} & { [key: string]: JsonValue }

const SESSION_DIR_RE = /^(\d{4}-\d{2}-\d{2})--(S\d{3})--(.+)$/
const DAY = 86_400_000

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function sessionsRoot(root: string): string {
  return join(root, 'AGENT_SESSIONS')
}

export function listSessions(root: string): SessionInfo[] {
  const sessRoot = sessionsRoot(root)
  if (!existsSync(sessRoot)) return []
  const out: SessionInfo[] = []
  for (const entry of readdirSync(sessRoot)) {
    const full = join(sessRoot, entry)
    if (!statSync(full).isDirectory()) continue
    const md = join(full, 'SESSION.md')
    const m = SESSION_DIR_RE.exec(entry)
    let status: string | null = null
    if (existsSync(md)) {
      status = /\[x\]|\[X\]/.test(readFileSync(md, 'utf-8')) ? 'done' : 'open'
    }
    out.push({
      dir: entry,
      id: m?.[2] ?? null,
      hasSessionMd: existsSync(md),
      mtime: statSync(full).mtime.toISOString(),
      status,
    })
  }
  out.sort((a, b) => (a.dir < b.dir ? 1 : -1))
  return out
}

export function nextSessionId(sessions: SessionInfo[]): string {
  let max = 0
  for (const s of sessions) {
    if (s.id) {
      const n = Number(s.id.slice(1))
      if (n > max) max = n
    }
  }
  return `S${String(max + 1).padStart(3, '0')}`
}

export function findSession(root: string, key: string): SessionInfo | null {
  return (
    listSessions(root).find((s) => s.dir.includes(key) || (s.id ?? '') === key.toUpperCase()) ?? null
  )
}

export interface CreateSessionResult extends Record<string, JsonValue> {
  dir: string
  id: string
  sessionMd: string
}

export function createSession(root: string, name: string, title: string): CreateSessionResult {
  const sessions = listSessions(root)
  const id = nextSessionId(sessions)
  const dirName = `${today()}--${id}--${name}`
  const dir = join(sessionsRoot(root), dirName)
  mkdirSync(dir, { recursive: true })
  const md = join(dir, 'SESSION.md')
  writeFileSync(
    md,
    `# SESSION: ${title}\n- ID: ${id}\n\n## 目标\n<一句话描述本次会话要完成的事情>\n\n## 状态\n- [ ] 进行中\n\n## 关键决策\n| # | 决策 | 理由 |\n|---|------|------|\n| 1 |  |  |\n\n## 进度记录\n- ${today()} — 会话创建\n\n## 产出物\n- \n\n## 未解决的问题\n- \n`,
    'utf-8',
  )
  return { dir: dirName, id, sessionMd: md }
}

export function showSession(root: string, key: string): DirResult & { content: string } {
  const target = findSession(root, key)
  if (!target) {
    // 关键词回退：内容搜索
    for (const s of listSessions(root)) {
      const md = join(sessionsRoot(root), s.dir, 'SESSION.md')
      if (existsSync(md) && readFileSync(md, 'utf-8').includes(key)) {
        return { dir: s.dir, content: readFileSync(md, 'utf-8') }
      }
    }
    throw new Error(`未找到会话: ${key}`)
  }
  const md = join(sessionsRoot(root), target.dir, 'SESSION.md')
  if (!existsSync(md)) throw new Error(`会话 ${target.dir} 缺少 SESSION.md`)
  return { dir: target.dir, content: readFileSync(md, 'utf-8') }
}

export type DirResult = { dir: string } & Record<string, JsonValue>

/** 活动会话标记文件（sessionBlock 系统提示词注入读取） */
export const ACTIVE_SESSION_MARKER = join('.dsh', 'active-session')

/** 激活会话：写 .dsh/active-session 标记（内容 = 相对 CCC 根的 SESSION.md 路径） */
export function useSession(root: string, key: string): DirResult & { mdPath: string } {
  const target = findSession(root, key)
  if (!target) throw new Error(`未找到会话: ${key}`)
  const md = join(sessionsRoot(root), target.dir, 'SESSION.md')
  if (!existsSync(md)) throw new Error(`会话 ${target.dir} 缺少 SESSION.md`)
  const marker = resolve(root, ACTIVE_SESSION_MARKER)
  mkdirSync(resolve(root, '.dsh'), { recursive: true })
  const relMd = relative(root, md)
  writeFileSync(marker, relMd, 'utf-8')
  return { dir: target.dir, mdPath: md }
}

/** 关闭活动会话：删除 .dsh/active-session 标记 */
export function closeSession(root: string): DirResult {
  const marker = resolve(root, ACTIVE_SESSION_MARKER)
  if (existsSync(marker)) rmSync(marker, { force: true })
  return { dir: 'active-session cleared' }
}

export function archiveSession(root: string, key: string): DirResult {
  const target = findSession(root, key)
  if (!target) throw new Error(`未找到会话: ${key}`)
  const md = join(sessionsRoot(root), target.dir, 'SESSION.md')
  if (!existsSync(md)) throw new Error(`会话 ${target.dir} 缺少 SESSION.md`)
  let content = readFileSync(md, 'utf-8')
  content = content
    .replace(/^-\s*\[ \]\s*进行中$/m, '- [x] 已完成')
    .replace(/^-\s*\[ \]\s*已关闭（未完成）$/m, '- [x] 已关闭（未完成）')
  if (!/\[x\]|\[X\]/.test(content)) content = content.replace(/^## 状态$/m, '## 状态\n- [x] 已完成')
  writeFileSync(md, content, 'utf-8')
  appendFileSync(md, `\n> 已归档: ${today()}\n`, 'utf-8')
  return { dir: target.dir }
}

export interface HealthProblem extends Record<string, JsonValue> {
  dir: string
  kind: 'missing-md' | 'stale'
  detail: string
}

export function healthCheck(root: string): HealthProblem[] {
  const problems: HealthProblem[] = []
  const now = Date.now()
  for (const s of listSessions(root)) {
    const age = (now - new Date(s.mtime).getTime()) / DAY
    if (!s.hasSessionMd) {
      problems.push({ dir: s.dir, kind: 'missing-md', detail: '缺少 SESSION.md' })
    } else if (age > 14) {
      problems.push({ dir: s.dir, kind: 'stale', detail: `${Math.round(age)} 天未更新` })
    }
  }
  return problems
}

export interface SessionSummary extends Record<string, JsonValue> {
  total: number
  open: number
  done: number
  stale: number
  recent: SessionInfo[]
}

export function summarize(root: string): SessionSummary {
  const sessions = listSessions(root)
  const done = sessions.filter((s) => s.status === 'done').length
  const stale = sessions.filter((s) => (Date.now() - new Date(s.mtime).getTime()) / DAY > 14).length
  return {
    total: sessions.length,
    open: sessions.length - done,
    done,
    stale,
    recent: sessions.slice(0, 5),
  }
}

export interface QaIssue extends Record<string, JsonValue> {
  path: string
  kind: 'missing'
}

/** 事实核对：SESSION.md 中记录的产出物路径（- `path` — 说明 行）是否真实存在 */
export function qaCheck(root: string, key: string): { dir: string; issues: QaIssue[] } {
  const { dir, content } = showSession(root, key)
  const issues: QaIssue[] = []
  for (const line of content.split('\n')) {
    const m = /^-\s*(`[^`]+`|[^\s|]+)\s*—/.exec(line.trim())
    if (!m) continue
    const p = m[1]!.replace(/`/g, '')
    if (!existsSync(resolve(root, p))) {
      issues.push({ path: p, kind: 'missing' })
    }
  }
  return { dir, issues }
}

/** 追加会话心跳（turn-stopping 机械落盘用） */
export function appendHeartbeat(sessionMd: string): boolean {
  try {
    appendFileSync(sessionMd, `- ${new Date().toISOString()} — [auto] turn heartbeat (dsh-serenity-hooks)\n`, 'utf-8')
    return true
  } catch {
    return false
  }
}
