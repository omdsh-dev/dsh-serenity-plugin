/**
 * session-ops.ts — session 工具纯操作层（零 DSH 依赖，可独立单测）
 *
 * 行为对齐 osp（opencode-serenity-plugin/src/session/lib.ts）——osp 是 ACC 工具 spec：
 *   - create：--desc / --issue 二选一（互斥、缺省报错）；issue 模式目录 YYYY-MM-DD--<issue>
 *     （无 S###，sessionId=issue）；desc 模式 YYYY-MM-DD--S###--<desc>；goal 写入目标段；dry-run 预览
 *   - close：需 name + confirm=true；标记 [x] 已完成+已关闭 + 进度记录"关闭"
 *   - archive：name 缺省 → 批量归档（completed + ≥7 天 → 移动 _archived/）；单会话需 completed + grace
 *   - list/show/health/qa/summary：文本输出格式与 osp 一致
 * 保留 dsp S134 活跃会话机制（内存 Map + events 恢复，不落盘）——osp 同为内存 active-state。
 */

import {
  existsSync,
  statSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from 'node:fs'
import { join, basename, dirname } from 'node:path'
import type { JsonValue } from './json.js'

export type SessionAction =
  | 'list'
  | 'show'
  | 'create'
  | 'use'
  | 'close'
  | 'health'
  | 'qa'
  | 'archive'
  | 'summary'
  | 'hook-develop-guide'

export const SESSION_ACTIONS: readonly SessionAction[] = [
  'list', 'show', 'create', 'use', 'close', 'health', 'qa', 'archive', 'summary', 'hook-develop-guide',
]

/**
 * 读取 Session 事件序列（v1.28.1 适配 0.1.2-rc.1 补齐）：rc.1 起官方 Session 类
 * 移除 `.events` 属性 → `snapshotEvents()` 方法（dsh-session/src/session.ts：
 * `snapshotEvents(fromSeq, toSeqExclusive)`）。插件早期代码多处裸读 `.events`
 * （经 `as unknown as { events? }` 断言绕过 typecheck），运行时静默 undefined——
 * 造成 first-anchor 每轮重插 / SESSION 激活恢复失效 / rebuild 定位错乱。
 * 统一收敛到本 helper：snapshotEvents() 优先（rc.1 真实形态），`.events` 兜底
 * （测试替身/旧运行时）。所有消费方一律经此读取，禁止再裸读 `.events`。
 * 泛型 T：调用方按需声明事件形状（如 `SessionEvent`），unknown 默认。
 */
export function sessionEvents<T = unknown>(session: unknown): readonly T[] {
  const s = session as { snapshotEvents?: () => readonly T[] | readonly unknown[]; events?: readonly T[] } | null | undefined
  if (!s) return []
  if (typeof s.snapshotEvents === 'function') {
    try {
      const snap = s.snapshotEvents()
      return (snap ?? []) as readonly T[]
    } catch {
      /* snapshot 失败退 events 兜底 */
    }
  }
  return (s.events ?? []) as readonly T[]
}

const SESSION_MD = 'SESSION.md'
const ARCHIVE_DIR_NAME = '_archived'
const HEALTH_STALE_DAYS = 7
const HEALTH_STALLED_PCT = 30
const HEALTH_STALLED_DAYS = 3
const HEALTH_GHOST_DAYS = 2
const DAY = 86_400_000

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export function sessionsRoot(root: string): string {
  return join(root, 'AGENT_SESSIONS')
}

// ── 会话条目与状态（对齐 osp readAllSessions/parseSessionMd）──

interface SessionStatus {
  hasSessionMd: boolean
  completed: boolean
  completedCount: number
  pendingCount: number
  unresolvedCount: number
}

export interface SessionEntry {
  dirName: string
  path: string
  mtime: Date
  status: SessionStatus
}

/** 解析 SESSION.md 状态元数据（对齐 osp parseSessionMd） */
function parseSessionMd(filePath: string): SessionStatus {
  try {
    const content = readFileSync(filePath, 'utf-8')
    const completed = /\[\s*x\s*\]/i.test(content)
    const completedCount = (content.match(/\[\s*x\s*\]/gi) ?? []).length
    const pendingCount = (content.match(/\[\s*[ \t]\s*\]/g) ?? []).length
    const unresolvedCount = (content.match(/(未解决|open|question|TODO)/gi) ?? []).length
    return { hasSessionMd: true, completed, completedCount, pendingCount, unresolvedCount }
  } catch {
    return { hasSessionMd: false, completed: false, completedCount: 0, pendingCount: 0, unresolvedCount: 0 }
  }
}

function readSessionEntry(dirPath: string): SessionEntry | null {
  try {
    const st = statSync(dirPath)
    if (!st.isDirectory()) return null
    const dirName = basename(dirPath)
    const mdPath = join(dirPath, SESSION_MD)
    const status = existsSync(mdPath)
      ? parseSessionMd(mdPath)
      : { hasSessionMd: false, completed: false, completedCount: 0, pendingCount: 0, unresolvedCount: 0 }
    return { dirName, path: dirPath, mtime: st.mtime, status }
  } catch {
    return null
  }
}

/** 读取 AGENT_SESSIONS 中所有会话，活跃（未完成）排前（对齐 osp readAllSessions） */
function readAllSessions(sessionsDir: string): SessionEntry[] {
  try {
    return readdirSync(sessionsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => readSessionEntry(join(sessionsDir, e.name)))
      .filter((s): s is SessionEntry => s !== null)
      .sort((a, b) => {
        if (!a.status.completed && b.status.completed) return -1
        if (a.status.completed && !b.status.completed) return 1
        return b.mtime.getTime() - a.mtime.getTime()
      })
  } catch {
    return []
  }
}

/** 提取目录名中的会话 ID（S### 或 issue 名）；无匹配返回 '' */
function extractSessionId(dirName: string): string {
  const m = dirName.match(/--S(\d{3,})--/)
  return m ? `S${m[1]}` : ''
}

/**
 * 根据 key 查找会话（对齐 osp findSession）：
 * 精确目录名 → S### ID（允许 S31→031）→ 唯一模糊子串匹配（多个则报错）
 */
export function findSession(sessionsDir: string, key: string): SessionEntry | null {
  const all = readAllSessions(sessionsDir)
  const byName = all.find((s) => s.dirName === key)
  if (byName) return byName
  const searchId = key.replace(/^S/, '').padStart(3, '0')
  const byId = all.find((s) => {
    const m = s.dirName.match(/--S(\d{3,})--/)
    return m && m[1] === searchId
  })
  if (byId) return byId
  const lower = key.toLowerCase()
  const fuzzy = all.filter((s) => s.dirName.toLowerCase().includes(lower))
  if (fuzzy.length === 1) return fuzzy[0] ?? null
  if (fuzzy.length > 1) {
    throw new Error(
      `Found ${fuzzy.length} sessions matching "${key}": ` +
      fuzzy.map((s) => s.dirName).join(', ') +
      '. Use a more specific query.',
    )
  }
  return null
}

// ── list ──

/** list 子命令（对齐 osp listSessions 文本格式 + active 标记） */
export function listSessions(root: string, activeId?: string): string {
  const sessions = readAllSessions(sessionsRoot(root))
  if (sessions.length === 0) return '(no sessions in AGENT_SESSIONS/)'
  const lines = sessions.map((s) => {
    const age = Math.floor((Date.now() - s.mtime.getTime()) / DAY)
    const sessionId = extractSessionId(s.dirName)
    const isActive = activeId !== undefined && sessionId !== '' && sessionId === activeId
    const status = isActive ? '●' : s.status.completed ? '✓' : '○'
    return `${status} ${s.dirName} (${age}d ago)`
  })
  return `AGENT_SESSIONS/ (${sessions.length} sessions)\n` + lines.join('\n')
}

// ── show ──

/** show 子命令（对齐 osp showSession：`# dirName\n\n` + SESSION.md 内容） */
export function showSession(root: string, key: string): string {
  const sessionsDir = sessionsRoot(root)
  const session = findSession(sessionsDir, key)
  if (!session) {
    throw new Error(`Session not found: "${key}". Use "list" to see available sessions.`)
  }
  const mdPath = join(session.path, SESSION_MD)
  if (!existsSync(mdPath)) {
    return `Session ${session.dirName} (no SESSION.md — directory exists but is empty)`
  }
  const content = readFileSync(mdPath, 'utf-8')
  return `# ${session.dirName}\n\n${content}`
}

// ── create ──

export interface CreateSessionOptions {
  root: string
  /** --desc 模式的描述（与 issue 互斥） */
  desc?: string
  /** --issue 模式的工单号（与 desc 互斥） */
  issue?: string
  goal?: string
  dryRun: boolean
}

export interface CreateSessionResult {
  message: string
  dirName: string
  sessionPath: string
  sessionId: string
}

/** 生成 SESSION.md 模板（对齐 osp：goal 写入目标段，时间戳 YYYY-MM-DD HH:mm） */
function sessionMdTemplate(title: string, id: string, goal: string | undefined, now: Date): string {
  const ts = now.toISOString().slice(0, 16).replace('T', ' ')
  return (
    `# SESSION: ${title}\n- ID: ${id}\n\n` +
    `## 目标\n${goal ?? '（待补充）'}\n\n` +
    `## 状态\n- [ ] 进行中\n\n` +
    `## 关键决策\n| # | 决策 | 理由 |\n|---|------|------|\n| 1 | | |\n\n` +
    `## 进度记录\n- ${ts} — 创建\n\n` +
    `## 产出物\n- \n\n` +
    `## 未解决的问题\n- \n`
  )
}

/** create 子命令（对齐 osp createSession：--desc/--issue 二选一 + dry-run + 长度限制） */
/** 目录名脱敏（Windows 审计问题 10）：非法字符 → '-', 去尾点/空格, 保留名（CON/NUL 等）加前缀 */
export function sanitizeDirName(s: string): string {
  const cleaned = s
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/[ .]+$/g, '')
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)) {
    return `_${cleaned}`
  }
  return cleaned
}

export function createSession(opts: CreateSessionOptions): CreateSessionResult {
  const { root, desc, issue, goal, dryRun } = opts
  const sessionsDir = sessionsRoot(root)
  const now = new Date()
  const datePrefix = now.toISOString().slice(0, 10)

  if (!desc && !issue) {
    throw new Error('create requires either --desc or --issue')
  }
  if (desc && issue) {
    throw new Error('--desc and --issue are mutually exclusive')
  }

  if (issue) {
    if (issue.length > 100) {
      throw new Error(`issue too long: ${issue.length} chars (max 100)`)
    }
    const dirName = `${datePrefix}--${sanitizeDirName(issue)}`
    const sessionPath = join(sessionsDir, dirName)
    if (!dryRun && existsSync(sessionPath)) {
      throw new Error(`Session directory already exists: "${dirName}"`)
    }
    if (dryRun) {
      return { message: `[dry-run] Would create: ${dirName}/`, dirName, sessionPath, sessionId: issue }
    }
    mkdirSync(sessionPath, { recursive: true })
    writeFileSync(join(sessionPath, SESSION_MD), sessionMdTemplate(issue, issue, goal, now), 'utf-8')
    return { message: `Created: ${dirName}/`, dirName, sessionPath, sessionId: issue }
  }

  // --desc 模式
  if (!desc || desc.length === 0) {
    throw new Error('description cannot be empty')
  }
  if (desc.length > 200) {
    throw new Error(`description too long: ${desc.length} chars (max 200)`)
  }
  const sessions = readAllSessions(sessionsDir)
  let maxId = 0
  for (const s of sessions) {
    const m = s.dirName.match(/--S(\d{3,})--/)
    if (m) {
      const num = parseInt(m[1]!, 10)
      if (num > maxId) maxId = num
    }
  }
  const nextId = String(maxId + 1).padStart(3, '0')
  const dirName = `${datePrefix}--S${nextId}--${sanitizeDirName(desc)}`
  const sessionPath = join(sessionsDir, dirName)
  if (!dryRun && existsSync(sessionPath)) {
    throw new Error(`Session directory already exists: "${dirName}"`)
  }
  if (dryRun) {
    return {
      message: `[dry-run] Would create: ${dirName}/\n  goal=${goal ?? '(none)'}`,
      dirName,
      sessionPath,
      sessionId: `S${nextId}`,
    }
  }
  mkdirSync(sessionPath, { recursive: true })
  writeFileSync(join(sessionPath, SESSION_MD), sessionMdTemplate(desc, `S${nextId}`, goal, now), 'utf-8')
  return { message: `Created: ${dirName}/ (S${nextId})`, dirName, sessionPath, sessionId: `S${nextId}` }
}

// ── S134 活跃会话（内存 Map + events 恢复；对齐 osp active-state 的内存模型）──

/**
 * 活动会话跟踪（S134 v1.16.14 内存化，对齐 osp active-state）：
 * **不落盘**——活跃会话状态在内存 Map（key = scope = dsh 会话 id），避免落盘标记
 * 文件累积与跨会话串台（落盘版 `.dsh/active-sessions/<scope>` 已被此方案取代）。
 * 进程重启恢复：从**当前会话历史（events）**解析 `[SESSION CONTEXT]` 标记（use 时注入），
 * 只扫自己会话——无全局扫描、无跨会话污染。
 */
export const DEFAULT_SESSION_SCOPE = 'default'

/** [SESSION CONTEXT] 恢复标记（use 时注入 events 历史；进程重启后从 events 解析） */
export const SESSION_CONTEXT_MARKER = '[SESSION CONTEXT] Activated:'

export interface ActiveSessionInfo {
  sessionId: string
  dirName: string
  mdPath: string
}

/** 内存活跃会话：scope（dsh 会话 id）→ 会话信息（不落盘；并行多会话各自 key 隔离） */
const activeStore = new Map<string, ActiveSessionInfo>()
/** 全局最近活跃（对齐 osp lastActive；供无 scope 上下文使用） */
let lastActive: ActiveSessionInfo | null = null

export function getActiveSessionInfo(scope: string): ActiveSessionInfo | null {
  return activeStore.get(scope) ?? null
}

export function getLastActiveSessionInfo(): ActiveSessionInfo | null {
  return lastActive
}

export function setActiveSessionInfo(scope: string, info: ActiveSessionInfo): void {
  activeStore.set(scope, info)
  lastActive = info
}

export function clearActiveSessionInfo(scope: string): void {
  activeStore.delete(scope)
  if (lastActive && ![...activeStore.values()].some((v) => v === lastActive)) lastActive = null
}

/** 重置内存活跃会话（测试用；进程重启即天然清空） */
export function resetActiveSessionStore(): void {
  activeStore.clear()
  lastActive = null
}

/** 当前 scope 的活跃会话 SESSION.md 绝对路径；无激活返回 null（读内存，不落盘） */
export function readActiveSessionMd(_root: string, scope = DEFAULT_SESSION_SCOPE): string | null {
  return getActiveSessionInfo(scope)?.mdPath ?? null
}

/**
 * use 子命令：激活会话（写内存 Map）+ 返回对齐 osp 的输出文本
 * （含 [SESSION CONTEXT] 标记 + todowrite 指令；标记随工具结果进 events 历史，
 *  进程重启后从当前会话 events 解析恢复）。
 */
export function useSession(root: string, key: string, scope = DEFAULT_SESSION_SCOPE): { dir: string; mdPath: string; context: string } {
  const sessionsDir = sessionsRoot(root)
  const session = findSession(sessionsDir, key)
  if (!session) {
    throw new Error(`Session not found: "${key}". Use "list" to see available sessions.`)
  }
  const mdPath = join(session.path, SESSION_MD)
  if (!existsSync(mdPath)) {
    throw new Error(`Session "${session.dirName}" has no SESSION.md — nothing to load.`)
  }
  const sessionId = extractSessionId(session.dirName) || basename(session.dirName)
  const dirName = session.dirName
  const shortName = dirName.replace(/^\d{4}-\d{2}-\d{2}--/, '')
  setActiveSessionInfo(scope, { sessionId, dirName, mdPath })
  const context = [
    `───────────────────────────────────────────────────────────────`,
    `${SESSION_CONTEXT_MARKER} ${dirName}`,
    `───────────────────────────────────────────────────────────────`,
    `Use "session show ${sessionId}" to view session details.`,
    `SESSION.md path: ${mdPath}`,
    ``,
    `→ All subsequent work should refer back to this session.`,
    `  Use "session show ${sessionId}" to check current progress.`,
    `  After advancing work, update the "进度记录" (progress) section in SESSION.md.`,
    ``,
    `→ BEFORE responding to the user, you MUST call todowrite immediately`,
    `  with the session todo list. The first item MUST be:`,
    `    content: "SESSION: ${sessionId} — ${shortName}"`,
    `    status: "completed", priority: "low"`,
    `  Follow with any tasks parsed from SESSION.md.`,
    `───────────────────────────────────────────────────────────────`,
  ].join('\n')
  return { dir: dirName, mdPath, context }
}

/**
 * close 子命令（对齐 osp closeSession）：需 name + confirm=true；
 * 标记 SESSION.md 为 [x] 已完成 + [x] 已关闭 + 进度记录"关闭"；清除该会话的活跃状态。
 */
export function closeSession(root: string, key: string, confirm: boolean, scope = DEFAULT_SESSION_SCOPE): string {
  if (!confirm) {
    return (
      `⚠ Close requires explicit confirmation.\n` +
      `  Re-run with --confirm to confirm closing this session.`
    )
  }
  const sessionsDir = sessionsRoot(root)
  const session = findSession(sessionsDir, key)
  if (!session) {
    throw new Error(`Session not found: "${key}". Use "list" to see available sessions.`)
  }
  if (session.status.completed) {
    return `Session "${session.dirName}" is already completed.`
  }
  const mdPath = join(session.path, SESSION_MD)
  if (!existsSync(mdPath)) {
    throw new Error(`Session "${session.dirName}" has no SESSION.md — nothing to close.`)
  }
  let content = readFileSync(mdPath, 'utf-8')
  // CRLF 归一化（Windows 审计问题 11）：Windows 编辑器/PowerShell 写的 \r\n 会
  // 使 `## 状态\n` 字面量正则不匹配 → 标记静默失效（假完成）
  content = content.replace(/\r\n/g, '\n')
  // 兼容有无空行的状态段（模板生成无空行；手工编辑可能带空行）
  content = content.replace(
    /## 状态\n\n?- \[ \] 进行中/,
    '## 状态\n- [x] 已完成\n- [x] 已关闭',
  )
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ')
  if (!content.includes('-- 关闭')) {
    content = content.replace(/(## 进度记录\n)/, `$1- ${now} — 关闭\n`)
  }
  writeFileSync(mdPath, content, 'utf-8')
  clearActiveSessionInfo(scope)
  return `Session "${session.dirName}" closed and marked as completed.`
}

/**
 * 从会话历史（events）解析会话身份（进程重启恢复；只扫**当前会话**自己的历史——无跨会话串台）。
 *
 * v1.24.11 稳固化（S142 用户需求：重建后新会话必须准确知道从哪个 SESSION 恢复）：
 * **路径规范行即可，不再要求 [SESSION CONTEXT] 标记**——`session use` 上下文与重建锚点
 * （buildRebuildAnchor 的 `- Persistent trajectory — SESSION.md path: <rel>` 行）同格式，
 * 因此**仅靠重建锚点的会话（从未显式 use）同样可恢复**。从**尾到头**扫描，最后一条
 * 合法路径胜出（时间序最新）；会话目录名/ID 从路径本身派生（单一真相源，不猜）。
 * 路径可为相对（重建锚点存 rel）——绝对化与存在性校验在调用方（知道 root）执行。
 */
export function parseSessionContextFromEvents(events: readonly unknown[]): ActiveSessionInfo | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const strs: string[] = []
    collectStrings(events[i], strs)
    for (const s of strs) {
      const md = extractSessionMdPathFromText(s)
      if (!md) continue
      // 兼容两种路径形态并归一为文件路径：`.../<session-dir>/SESSION.md`（真实契约）
      // 或 `.../<session-dir>`（旧写，目录形态）→ 补 /SESSION.md
      let dirName: string
      let filePath: string
      if (basename(md) === SESSION_MD) {
        dirName = basename(dirname(md))
        filePath = md
      } else if (isSessionDirName(basename(md))) {
        dirName = basename(md)
        filePath = join(md, SESSION_MD)
      } else {
        continue
      }
      if (!isSessionDirName(dirName)) continue
      const idMatch = dirName.match(/--S(\d{3,})--/)
      return {
        sessionId: idMatch ? `S${idMatch[1]}` : dirName,
        dirName,
        mdPath: filePath,
      }
    }
  }
  return null
}

/** 递归收集对象/数组/字符串中的全部字符串（保留原文，无 JSON 转义） */
function collectStrings(v: unknown, out: string[]): void {
  if (typeof v === 'string') {
    out.push(v)
    return
  }
  if (v && typeof v === 'object') {
    for (const val of Object.values(v as Record<string, unknown>)) collectStrings(val, out)
  }
}

// ── v1.24.11 稳固化：SESSION.md 路径规范行（use 上下文与重建锚点同格式）──

/** 规范行正则：`SESSION.md path: <路径>`（路径可含空格 → [^\r\n]+ 整行匹配） */
const SESSION_MD_PATH_RE = /SESSION\.md path:\s*([^\r\n]+)/

/** 从文本提取 SESSION.md 路径（use 上下文 / 重建锚点规范行通用；无匹配返回 null）。
 *  同行已知尾注（如系统提示词 Session 块的 persistent-body 注释）剥除——规范行只取路径本体。 */
export function extractSessionMdPathFromText(text: string): string | null {
  const m = text.match(SESSION_MD_PATH_RE)
  if (!m) return null
  let p = m[1]!.trim()
  const suffix = p.search(/ \(the trajectory's persistent body/)
  if (suffix > 0) p = p.slice(0, suffix).trim()
  return p
}

/** 会话目录名形态校验（createSession 恒带日期前缀 `YYYY-MM-DD--`） */
function isSessionDirName(dirName: string): boolean {
  return /^\d{4}-\d{2}-\d{2}--/.test(dirName) && dirName.length > 11
}

/**
 * 约定回退（v1.24.11）：AGENT_SESSIONS 下最新修改的**未完成**会话的 SESSION.md。
 * readAllSessions 已按「未完成优先 + mtime 降序」排序 → 首个未完成且含 SESSION.md 即最新活动。
 * 只作最后手段（内存/events/锚点全缺时），保证重建锚点至少指向一个真实存在的轨迹。
 */
export function findLatestActiveSessionMd(root: string): string | null {
  for (const s of readAllSessions(sessionsRoot(root))) {
    if (s.status.completed) continue
    const md = join(s.path, SESSION_MD)
    if (existsSync(md)) return md
  }
  return null
}

// ── health ──

/** health 子命令（对齐 osp healthCheck：stale/stalled/ghost/drift 四类检查，文本输出） */
export function healthCheck(root: string): string {
  const sessions = readAllSessions(sessionsRoot(root))
  if (sessions.length === 0) return 'No sessions found — nothing to check.'
  const now = Date.now()
  interface HealthIssue { dirName: string; issue: string; severity: string }
  const issues: HealthIssue[] = []
  for (const s of sessions) {
    const ageDays = (now - s.mtime.getTime()) / DAY
    const st = s.status
    if (ageDays > HEALTH_STALE_DAYS && !st.completed) {
      issues.push({ dirName: s.dirName, issue: `No activity for ${Math.floor(ageDays)}d`, severity: 'stale' })
    }
    const totalTasks = st.completedCount + st.pendingCount
    if (totalTasks > 0) {
      const pct = Math.round((st.completedCount / totalTasks) * 100)
      if (pct < HEALTH_STALLED_PCT && ageDays > HEALTH_STALLED_DAYS && !st.completed) {
        issues.push({ dirName: s.dirName, issue: `Only ${pct}% done after ${Math.floor(ageDays)}d`, severity: 'stalled' })
      }
    }
    if (!st.hasSessionMd && ageDays > HEALTH_GHOST_DAYS) {
      issues.push({ dirName: s.dirName, issue: 'No SESSION.md (ghost directory)', severity: 'ghost' })
    }
    if (st.unresolvedCount > 3 && !st.completed) {
      issues.push({ dirName: s.dirName, issue: `${st.unresolvedCount} unresolved items`, severity: 'drift' })
    }
  }
  if (issues.length === 0) return 'All sessions healthy — no issues found.'
  const lines = issues.map((i) => `[${i.severity.toUpperCase()}] ${i.dirName}: ${i.issue}`)
  return `${issues.length} issue(s) found:\n` + lines.join('\n')
}

// ── archive ──

/** archive 子命令（对齐 osp archiveSessions：移动 _archived/；name 缺省批量） */
export function archiveSessions(root: string, opts: { name?: string; dryRun: boolean }): string {
  const { name, dryRun } = opts
  const sessionsDir = sessionsRoot(root)
  const now = Date.now()
  const archiveDir = join(sessionsDir, ARCHIVE_DIR_NAME)

  if (name) {
    const session = findSession(sessionsDir, name)
    if (!session) {
      throw new Error(`Session not found: "${name}"`)
    }
    if (!session.status.completed) {
      return `Session "${session.dirName}" is not completed — skipping.`
    }
    const ageDays = (now - session.mtime.getTime()) / DAY
    if (ageDays < 7) {
      return `Session "${session.dirName}" completed ${Math.floor(ageDays)}d ago — needs ${7 - Math.floor(ageDays)} more days before archiving.`
    }
    if (dryRun) {
      return `[dry-run] Would archive: ${session.dirName} → ${ARCHIVE_DIR_NAME}/`
    }
    if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true })
    renameSync(session.path, join(archiveDir, session.dirName))
    return `Archived: ${session.dirName} → _archived/`
  }

  const sessions = readAllSessions(sessionsDir)
  const toArchive = sessions.filter((s) => {
    if (!s.status.completed) return false
    return (now - s.mtime.getTime()) / DAY >= 7
  })
  if (toArchive.length === 0) return 'No sessions eligible for archiving.'
  if (dryRun) {
    return `[dry-run] Would archive ${toArchive.length} session(s):\n` +
      toArchive.map((s) => `  ${s.dirName}`).join('\n')
  }
  if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true })
  let count = 0
  for (const s of toArchive) {
    renameSync(s.path, join(archiveDir, s.dirName))
    count++
  }
  return `Archived ${count} session(s) → _archived/`
}

// ── summary ──

/** summary 子命令（对齐 osp sessionSummary 文本仪表盘） */
export function summarize(root: string): string {
  const sessions = readAllSessions(sessionsRoot(root))
  if (sessions.length === 0) return 'AGENT_SESSIONS/ is empty.'
  const now = Date.now()
  const completed = sessions.filter((s) => s.status.completed).length
  const active = sessions.length - completed
  const stale = sessions.filter((s) => !s.status.completed && (now - s.mtime.getTime()) / DAY > HEALTH_STALE_DAYS).length
  const ghost = sessions.filter((s) => !s.status.hasSessionMd).length
  const recent = sessions.slice(0, 5)
  const lines: string[] = [
    `AGENT_SESSIONS Summary`,
    `────────────────────────`,
    `Total:    ${sessions.length}`,
    `Active:   ${active}`,
    `Completed: ${completed}`,
    `Stale:    ${stale}`,
    `Ghost:    ${ghost}`,
    ``,
    `Recent activity (top 5):`,
    ...recent.map((s) => {
      const age = Math.floor((now - s.mtime.getTime()) / DAY)
      return `  ${s.status.completed ? '✓' : '○'} ${s.dirName} (${age}d ago)`
    }),
  ]
  if (stale > 0) {
    lines.push('', '⚠ Warning: Stale sessions found — run "session health" for details.')
  }
  return lines.join('\n')
}

// ── qa（事实核对，对齐 osp qaSession 五类检查）──

interface QaIssue {
  severity: 'info' | 'warning' | 'error'
  category: string
  message: string
}

/** 事实核对：SESSION.md 声明 vs 实际情况（结构/一致性/新鲜度/决策质量/产出物） */
export function qaCheck(root: string, key: string): string {
  const sessionsDir = sessionsRoot(root)
  const session = findSession(sessionsDir, key)
  if (!session) {
    throw new Error(`Session not found: "${key}". Use "list" to see available sessions.`)
  }
  const mdPath = join(session.path, SESSION_MD)
  if (!existsSync(mdPath)) {
    return `[ERROR] Session "${session.dirName}" has no SESSION.md — nothing to verify.`
  }
  const content = readFileSync(mdPath, 'utf-8')
  const issues: QaIssue[] = []

  // 1. 结构性检查：必选章节
  const requiredSections = [
    { heading: '目标', label: '目标 (goal)' },
    { heading: '状态', label: '状态 (status)' },
    { heading: '关键决策', label: '关键决策 (key decisions)' },
    { heading: '进度记录', label: '进度记录 (progress)' },
    { heading: '产出物', label: '产出物 (outputs)' },
    { heading: '未解决的问题', label: '未解决的问题 (unresolved)' },
  ]
  for (const section of requiredSections) {
    const headingRegex = new RegExp(`^##\\s*${section.heading}[\\s\\S]*?(?=^##|(?![\\s\\S]))`, 'm')
    const match = content.match(headingRegex)
    if (!match) {
      issues.push({ severity: 'warning', category: 'structure', message: `Missing section: ${section.label}` })
      continue
    }
    const headingLineRegex = new RegExp(`^##\\s*${section.heading}\\s*$`, 'm')
    const body = match[0].replace(headingLineRegex, '').trim()
    if (!body || /^[-*]\s*$/.test(body)) {
      issues.push({ severity: 'warning', category: 'structure', message: `Section "${section.label}" is empty (only placeholder)` })
    }
  }

  // 2. 完成度矛盾检查
  const completedTasks = (content.match(/\[\s*x\s*\]/gi) ?? []).length
  const pendingTasks = (content.match(/\[\s*[ \t]\s*\]/gi) ?? []).length
  const statusSection = content.match(/^##\s*状态[\s\S]*?(?=^##|(?![^]))/mi)
  const statusBody = statusSection ? statusSection[0].replace(/^##\s*状态.*$/m, '').trim() : ''
  const hasCompletionMark = statusBody
    ? /#+\s*(?:完成|done|completed|closed)\b/i.test(statusBody) ||
      /(?:全部完成|已全部完成|所有.*任务.*完成|任务.*全部完成|已完成.*所有)/i.test(statusBody)
    : false
  const unresolvedSection = content.match(/^##\s*未解决的问题[\s\S]*?(?=^##|(?![^]))/mi)
  const unresolvedBody = unresolvedSection ? unresolvedSection[0].replace(/^##\s*未解决的问题.*$/m, '').trim() : ''
  const unresolvedCount = unresolvedBody ? (unresolvedBody.match(/(?:未解决|open|question|TODO)/gi) ?? []).length : 0

  if (hasCompletionMark && pendingTasks > 0) {
    issues.push({ severity: 'error', category: 'consistency', message: `Session marked as completed but has ${pendingTasks} pending task(s)` })
  }
  if (hasCompletionMark && unresolvedCount > 0) {
    issues.push({ severity: 'warning', category: 'consistency', message: `Session marked as completed but has ${unresolvedCount} unresolved item(s)` })
  }
  if (completedTasks > 0 && pendingTasks === 0 && !hasCompletionMark) {
    issues.push({ severity: 'info', category: 'consistency', message: `All ${completedTasks} task(s) completed but session not marked complete` })
  }

  // 3. 进度新鲜度检查
  const progressSection = content.match(/##\s*进度记录[\s\S]*?(?=^##|\z)/m)
  if (progressSection) {
    const dateMatches = progressSection[0].match(/\b(\d{4}-\d{2}-\d{2})\b/g)
    if (dateMatches && dateMatches.length > 0) {
      const lastDateStr = dateMatches[dateMatches.length - 1]!
      const lastDate = new Date(lastDateStr)
      const daysSince = Math.floor((Date.now() - lastDate.getTime()) / DAY)
      if (daysSince > HEALTH_STALE_DAYS && pendingTasks > 0) {
        issues.push({ severity: 'warning', category: 'stale', message: `No progress entry for ${daysSince} days (last: ${lastDateStr}), session still has ${pendingTasks} pending task(s)` })
      }
    }
  }

  // 4. 决策质量检查
  const decisionSection = content.match(/##\s*关键决策[\s\S]*?(?=^##|\z)/m)
  if (decisionSection) {
    const decisionLines = decisionSection[0].split('\n').filter((l) => /^\|\s*\d+\s*\|/.test(l))
    if (decisionLines.length > 0) {
      const emptyDecisions = decisionLines.filter((l) => {
        const cells = l.split('|').map((c) => c.trim())
        return cells.length >= 4 && (!cells[2] || !cells[3] || cells[2] === '-' || cells[3] === '-')
      })
      if (emptyDecisions.length > 0) {
        issues.push({ severity: 'info', category: 'quality', message: `${emptyDecisions.length} decision(s) have empty reason — consider filling gaps` })
      }
    } else if (!hasCompletionMark) {
      issues.push({ severity: 'info', category: 'quality', message: 'No decisions recorded yet — add key decisions as the session progresses' })
    }
  }

  // 5. 产出物文件存在性检查（路径相对 CCC 根）
  const outputSection = content.match(/##\s*产出物[\s\S]*?(?=^##|\z)/m)
  if (outputSection) {
    const outputLines = outputSection[0].split('\n').filter((l) => /^\s*[-*]\s/.test(l))
    const fileRefs: string[] = []
    for (const line of outputLines) {
      const refs = line.match(/`[^`]+`/g) ?? []
      fileRefs.push(...refs.map((r) => r.replace(/`/g, '')))
      const inlineRefs = line.match(/\b[\w./-]+\.[a-zA-Z]{1,5}\b/g) ?? []
      fileRefs.push(...inlineRefs.filter((r) => r.includes('/') || r.includes('.')))
    }
    if (fileRefs.length > 0) {
      const missing = fileRefs.filter((ref) => !existsSync(join(root, ref)))
      if (missing.length > 0 && completedTasks > 0) {
        issues.push({
          severity: 'warning',
          category: 'outputs',
          message: `${missing.length} referenced file(s) not found: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? `... (+${missing.length - 3} more)` : ''}`,
        })
      }
    }
  }

  // 报告生成（对齐 osp qaSession）
  const errorCount = issues.filter((i) => i.severity === 'error').length
  const warningCount = issues.filter((i) => i.severity === 'warning').length
  const infoCount = issues.filter((i) => i.severity === 'info').length
  const verified = errorCount === 0 && warningCount === 0
  const lines: string[] = [
    `QA Report: ${session.dirName}`,
    `────────────────${'─'.repeat(session.dirName.length)}`,
    `Summary: ${issues.length} issue(s) found (${errorCount} error, ${warningCount} warning, ${infoCount} info)`,
    `Status: ${verified ? '✓ Verified' : '⚠ Issues found'}`,
  ]
  if (issues.length > 0) {
    lines.push('')
    for (const issue of issues) {
      const tag = issue.severity === 'error' ? 'ERR' : issue.severity === 'warning' ? 'WRN' : 'INF'
      lines.push(`  [${tag}:${issue.category}] ${issue.message}`)
    }
  }
  lines.push('', 'Recommendations:')
  if (errorCount > 0) lines.push('  • Fix errors before closing the session (status vs content mismatch)')
  if (warningCount > 0) lines.push('  • Review warnings — they may indicate incomplete or outdated information')
  if (verified) lines.push('  • Session looks clean — no issues detected')
  return lines.join('\n')
}

// ── 其他 ──

// 兼容导出（部分调用方依赖旧签名）
export type SessionInfo = SessionEntry
export type { JsonValue }
