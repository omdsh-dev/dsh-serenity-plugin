/**
 * session-ops.ts — session 工具纯操作层（零 DSH 依赖，可独立单测）
 *
 * 移植自 dsh-serenity-plugin v0.1 acc-session runner（本项目自有代码）。
 * 操作 CCC 根的 AGENT_SESSIONS/ 目录，返回规范 JSON 值。
 */

import { existsSync, statSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { join, resolve, relative, basename, dirname } from 'node:path'
import { pathInside } from './ccc.js'
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

/**
 * 活动会话标记：按 DSH 会话（agent.session.id）隔离，不再使用 CCC 级全局单文件。
 * 每个 dsh 会话一个标记文件（.dsh/active-sessions/<scope>），系统提示词 Session 块
 * 只注入当前 dsh 会话 use 的活跃会话 —— 多开 conversation / subagent / loop 牛马互不泄露。
 *
 * 旧版全局标记 `.dsh/active-session`（v1.16.1 及以前）：use 时删除（迁移清理），
 * 读取不再回退（隔离优先；升级后重新 use 一次即可）。
 */
export const ACTIVE_SESSIONS_DIR = join('.dsh', 'active-sessions')

/** 旧版全局标记路径（v1.16.1 及以前 use 写入；新版本仅清理不再读取） */
export const LEGACY_ACTIVE_SESSION_MARKER = join('.dsh', 'active-session')

/** 默认 scope（agent.session.id 缺失时） */
export const DEFAULT_SESSION_SCOPE = 'default'

/** scope 用作文件名：仅保留安全字符（agent.session.id 可能含 / 等；`.` 排除以杜绝 `..` 路径段穿越） */
export function sanitizeScope(scope: string): string {
  const s = scope.replace(/[^A-Za-z0-9_-]/g, '_')
  return s || DEFAULT_SESSION_SCOPE
}

/** scope 标记文件绝对路径 */
export function activeSessionMarker(root: string, scope: string): string {
  return resolve(root, ACTIVE_SESSIONS_DIR, sanitizeScope(scope))
}

/** 激活会话：写 <scope> 标记（内容 = 相对 CCC 根的 SESSION.md 路径）；顺带清理旧全局标记 */
export function useSession(root: string, key: string, scope = DEFAULT_SESSION_SCOPE): DirResult & { mdPath: string } {
  const target = findSession(root, key)
  if (!target) throw new Error(`未找到会话: ${key}`)
  const md = join(sessionsRoot(root), target.dir, 'SESSION.md')
  if (!existsSync(md)) throw new Error(`会话 ${target.dir} 缺少 SESSION.md`)
  const marker = activeSessionMarker(root, scope)
  mkdirSync(resolve(root, '.dsh', 'active-sessions'), { recursive: true })
  const relMd = relative(root, md)
  writeFileSync(marker, relMd, 'utf-8')
  // 迁移清理：旧全局标记不再读取，避免其他 dsh 会话回退到本会话 use 的会话
  const legacy = resolve(root, LEGACY_ACTIVE_SESSION_MARKER)
  if (existsSync(legacy)) rmSync(legacy, { force: true })
  return { dir: target.dir, mdPath: md }
}

/** 关闭活动会话：删除 <scope> 标记 + 旧全局标记 */
export function closeSession(root: string, scope = DEFAULT_SESSION_SCOPE): DirResult {
  const marker = activeSessionMarker(root, scope)
  if (existsSync(marker)) rmSync(marker, { force: true })
  const legacy = resolve(root, LEGACY_ACTIVE_SESSION_MARKER)
  if (existsSync(legacy)) rmSync(legacy, { force: true })
  return { dir: 'active-session cleared' }
}

/** 读取指定 scope 的活跃会话 SESSION.md 绝对路径；无标记/越界返回 null */
export function readActiveSessionMd(root: string, scope = DEFAULT_SESSION_SCOPE): string | null {
  const marker = activeSessionMarker(root, scope)
  if (!existsSync(marker)) return null
  const rel = readFileSync(marker, 'utf-8').trim()
  if (!rel) return null
  const abs = resolve(root, rel)
  if (!abs.startsWith(resolve(root))) return null
  return abs
}

// ── 重启自动恢复（S134 需求）：新 DSH 会话无自身标记时，回退最近激活的宁静号会话 ──

export interface ActiveMarker {
  /** 标记文件名 = sanitize 后的 scope */
  scope: string
  /** 标记内容 = 相对 CCC 根的 SESSION.md 路径 */
  mdRel: string
  /** 标记 mtime（ms）——"最近激活"排序依据 */
  mtime: number
}

/** 列出全部 scope 的活动标记（含 scope / mdRel / mtime）；目录不存在返回空 */
export function listActiveMarkers(root: string): ActiveMarker[] {
  const dir = resolve(root, ACTIVE_SESSIONS_DIR)
  if (!existsSync(dir)) return []
  const out: ActiveMarker[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (!statSync(full).isFile()) continue
    try {
      const rel = readFileSync(full, 'utf-8').trim()
      if (!rel) continue
      out.push({ scope: entry, mdRel: rel, mtime: statSync(full).mtimeMs })
    } catch {
      /* 坏标记跳过（不阻断其余） */
    }
  }
  return out
}

/**
 * 重启恢复：当前 scope 无标记时，把"最近激活"（mtime 最新）且根内有效的标记
 * 复制为当前 scope 标记（激活语义延续：use = 激活，重启自动恢复 = 重新激活）。
 * 返回恢复的会话信息；已有标记 / 无候选 / 全部越界 → null。
 * 调用方负责根会话判定（subagent / loop 牛马不恢复——见 context.ts shouldAutoRestore）。
 */
export function restoreActiveSession(root: string, scope = DEFAULT_SESSION_SCOPE): (DirResult & { mdPath: string; restored: boolean; from: string }) | null {
  const marker = activeSessionMarker(root, scope)
  if (existsSync(marker)) return null // 已有激活，不覆盖
  const scopeName = sanitizeScope(scope)
  const candidates = listActiveMarkers(root).filter((m) => m.scope !== scopeName)
  if (candidates.length === 0) return null
  const rootAbs = resolve(root)
  // 有效性过滤：mdRel 必须在根内（防标记内容越界注入；pathInside 平台感知 sep/大小写）
  const valid = candidates.filter((m) => pathInside(rootAbs, resolve(rootAbs, m.mdRel)))
  if (valid.length === 0) return null
  const best = valid.sort((a, b) => b.mtime - a.mtime)[0]!
  mkdirSync(resolve(rootAbs, ACTIVE_SESSIONS_DIR), { recursive: true })
  writeFileSync(marker, best.mdRel, 'utf-8')
  const mdPath = resolve(rootAbs, best.mdRel)
  const dirName = basename(dirname(mdPath))
  const idMatch = dirName.match(/S(\d{3,})/)
  return { dir: dirName, id: idMatch ? `S${idMatch[1]}` : null, mdPath, restored: true, from: best.scope }
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
