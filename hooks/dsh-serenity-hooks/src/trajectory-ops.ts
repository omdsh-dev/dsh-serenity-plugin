/**
 * trajectory-ops.ts — 轨迹工具纯操作层（零 DSH 依赖，可独立单测）
 *
 * 行为对齐 osp（opencode-serenity-plugin/src/session/lib.ts）——osp 是 ACC 工具 spec。
 *
 * v1.33 收敛（S142 §32）：本文件只服务 `container_trajectory` 的动作面
 * （现行 **8 个**：list / show / create / use / rebuild / **send-now** / **send-later** / **cro-guide**）。旧 `logbook` 面里
 * **close / archive / health / qa 四个动作已删**（用户裁决「功能上废弃，实际上没用」），
 * 其函数（closeSession / archiveSessions / healthCheck / qaCheck）**同批删除**——
 * 保留下来的只有：create（--desc / --issue 二选一、dry-run 预览）、
 * list（含 summarize 仪表盘）、show、use（激活 + 绑定）、以及供 list 用的 summarize。
 * 「完成」不再由 close 写入，而是从 SESSION.md 的 `[x]` 推导；归档走 `container_fs mv`。
 */

import {
  existsSync,
  statSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { localDate, localDateTimeMinutes } from './time.js'

/**
 * `container_trajectory` 工具的动作集合（v1.33，S142 §32 用户裁决后的收敛结果）。
 *
 * 为什么收敛到这 8 个（R↓；v1.33 收敛时为 **6 个** —— 其后追加 `send-now`（09-16）
 * 与 `cro-guide`（09-20），🔴 2026-09-25 更正计数，勿再写成"6 个"）：旧面是 `logbook`（11）+ `trajectory`（12）两个工具，用户裁决
 * 「都合并成 trajectory，废除 logbook 这个词」并逐条删并 ——
 * summary 并进 list｜health/qa 淘汰（判据＝旧模板，EAP 已取代；仅"空壳/长期无活动"并入 use）｜
 * close/archive 删（completed 由 SESSION.md 的 `[x]` 推导；归档走 container_fs mv）｜
 * hook-develop-guide 并进 container_admin msm guide｜autopilot 面归 container_admin 的 autopilot 域
 * （该域 2026-09-15 随 ACC 侧 autopilot 退场删除）｜
 * wake-add/list/rm 收敛为 wake-later（**2026-09-17 更名 `send-later`**）。
 * 2026-09-16（所有者裁决）：新增 **send-message**（**2026-09-17 更名 `send-now`**）—— 即时投递
 *   （与 wake-later 共用取用通路，差别只在时刻"现在 vs 未来"与回执"有 vs 无"）。
 *   设计稿 docs/trajectory-send-message-design.md。
 * 2026-09-17（所有者裁决 · 命名 A 案）：**两个投递动作更名** —— `wake-later` → **`send-later`**、
 *   `send-message` → **`send-now`**。判据（R↓）：两者是**同一条投递通路**（同取用机制 / 同载荷 /
 *   同落点语义），只差**时刻**；而「唤醒（冷载入）」是**两条路径共有**的属性，不配做区分
 *   ⇒ 族名取共享词干 **`send-`**、轴取 **`-now` / `-later`**（同构）。**硬切无别名**；
 *   机制层词汇（`wake-registry.json` / `w-*` id / `WakeEntry` / 调度器名）**一律不动**（分层命名）。
 * 2026-09-20（CRO 落地，owner 令「搞定了发一版」）：新增 **`cro-guide`** —— CRO
 *   （Continuous Re-Occurrence，`docs/cro-design.md`）的**编写指南**出口。
 *   判据（R↓，为何挂在本工具而不新增域）：CRO 程序**放在轨迹自己的目录里**
 *   （`<轨迹目录>/continuous-re-occurrence.ts`）⇒ 「怎么写它」是**逐轨迹**的知识，
 *   而**管轨迹的人正是用本工具的人**；挂这儿 = 设计 §9-5 的"**既有 guide 位置、不新增域**"。
 *   ⚠️ 本动作**纯读**（输出指南正文，不碰 fs、不碰注册表）。
 */
type TrajectoryAction = 'list' | 'show' | 'create' | 'use' | 'rebuild' | 'send-now' | 'send-later' | 'cro-guide'

export const TRAJECTORY_ACTIONS: readonly TrajectoryAction[] = [
  'list', 'show', 'create', 'use', 'rebuild', 'send-now', 'send-later', 'cro-guide',
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
const HEALTH_STALE_DAYS = 7
const DAY = 86_400_000

function today(): string {
  return localDate()
}

export function sessionsRoot(root: string): string {
  return join(root, 'AGENT_SESSIONS')
}

// ── 会话条目与状态（对齐 osp readAllSessions/parseSessionMd）──

interface SessionStatus {
  hasSessionMd: boolean
  /** 「完成」的判据 = SESSION.md 里出现 `[x]`（v1.33 起不再由 close 动作写入） */
  completed: boolean
}

interface SessionEntry {
  dirName: string
  path: string
  mtime: Date
  status: SessionStatus
}

/** 解析 SESSION.md 状态元数据（对齐 osp parseSessionMd） */
function parseSessionMd(filePath: string): SessionStatus {
  try {
    const content = readFileSync(filePath, 'utf-8')
    return { hasSessionMd: true, completed: /\[\s*x\s*\]/i.test(content) }
  } catch {
    return { hasSessionMd: false, completed: false }
  }
}

function readSessionEntry(dirPath: string): SessionEntry | null {
  try {
    const st = statSync(dirPath)
    if (!st.isDirectory()) return null
    const dirName = basename(dirPath)
    const mdPath = join(dirPath, SESSION_MD)
    const status = existsSync(mdPath) ? parseSessionMd(mdPath) : { hasSessionMd: false, completed: false }
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

interface CreateSessionOptions {
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
  const ts = localDateTimeMinutes(now)
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
function sanitizeDirName(s: string): string {
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
  const datePrefix = localDate(now)

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

// ── 会话命名（F3/v1.22.9 格式 + 需求② 概括）────────────────────────────────
// 🔴 2026-09-25（S142 工程化程序第 ④ 项·第 1 步）**从 `tools/trajectory.ts` 下沉至此**。
// 为何在 L1：`rebuild.ts`（L1）原**静态** import `tools/trajectory.ts`（L3）**只为取 `namingTitleFor`**
// ⇒ 既是 L1→L3 上行边，又与 `tools/trajectory.ts` 里 `await import('../rebuild.js')` 的合法下行边
// **成环**（证据＝模块图 §3-6）。两个纯函数（**零 DSH 依赖**）下沉到本模块后，两侧各自向下依赖，环解开。
// 🔵 为何 `sanitizeSessionSummary` 必须**同批**下沉：它是 `namingTitleFor` 的私有助手，若留在 L3
// 就会被 L1 反向 import ⇒ 只是把那条坏边挪个名字。**功能无影响的判据** = 输入输出与全部调用点不变 ＋ 全量测试绿。

/**
 * 概括清洗（标题用；需求② S142 用户拍板：编号日期后加 ≤20 字内容概括）。
 * 规则（服务端统一，不信任 LLM 输入）：
 *   - 去控制字符/换行/回车/制表（防标题注入/多行污染）
 *   - trim（去首尾空白）
 *   - 截断 ≤20 字符（按 Unicode 码点——中英混排统一；emoji 等代理对按码点保留）
 *   - 去 `/`（防标题被误读为路径分隔）
 * @returns 清洗后的概括（空输入 → 空串；调用方决定是否允许空）
 */
export function sanitizeSessionSummary(summary: string): string {
  const cleaned = summary
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\//g, '')
    .trim()
  return [...cleaned].slice(0, 20).join('')
}

/**
 * 从激活会话派生命名标题（v1.22.9 格式修正 + 需求② 概括）：
 * F3 原始需求是 **`S###-日期`**（如 `S143-2026-08-26`）——从 `sessionId` 派生，
 * 而非完整目录名（`2026-08-24--S142--...` 超长 + 中文，不符合用户拍板格式）。
 * 需求②（S142 用户拍板）：编号日期后加 ≤20 字内容概括 → `S###-YYYY-MM-DD-<概括>`
 * ——概括来自显式 summary 参数（服务端截断/清洗，可靠不靠猜）；编号日期仍固定派生。
 * 无 S### 编号（issue 会话等）→ 回退目录名。
 * @param active 激活会话信息（sessionId + dirName）
 * @param summary 内容概括（≤20 字，服务端清洗截断；空 → 不带概括的 `S###-日期`）
 * @returns `S143-2026-08-26-概括` / `S143-2026-08-26` / 原目录名
 */
export function namingTitleFor(active: ActiveSessionInfo, summary?: string): string {
  const sid = active.sessionId
  if (typeof sid === 'string' && /^S\d+$/.test(sid)) {
    const date = active.dirName.match(/^(\d{4}-\d{2}-\d{2})--/)?.[1] ?? ''
    const cleaned = summary ? sanitizeSessionSummary(summary) : ''
    const base = date ? `${sid}-${date}` : sid
    return cleaned ? `${base}-${cleaned}` : base
  }
  return active.dirName
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
 * 从 dsh 会话标题解析 SESSION 目录（编码无关 best-match，U3/U4）——
 * 标题不假设 S### 前缀（CCC 可自定义编码：apaas-xxx / P### / 完整目录名等）。
 * 匹配优先级（全部对 AGENT_SESSIONS 现有目录 best-match，不猜）：
 *   ① 标题即完整目录名（含日期前缀 `YYYY-MM-DD--`）→ 精确命中
 *   ② 标题含 `--<code>--` 段（如完整目录名被截断为 `<code>-日期-概括` 前段）→
 *      按 code 段匹配：取标题首 token（`-` 前），与各目录 `--<code>--`/`--<code>` 尾段比对
 *   ③ 唯一模糊子串匹配（多个则返回 null 防误猜）
 * @param title dsh 会话标题（如 `S142-2026-08-24-概括` / `apaas-26116-…` / 完整目录名）
 * @param sessionsDir AGENT_SESSIONS 绝对路径
 * @returns 命中目录的绝对路径（SESSION.md）；无/歧义返回 null
 */
export function resolveSessionByTitle(title: string, sessionsDir: string): string | null {
  const t = (title ?? '').trim()
  if (!t) return null
  const all = readAllSessions(sessionsDir)
  if (all.length === 0) return null

  // ① 完整目录名精确命中（标题可能直接就是目录名）
  if (isSessionDirName(t)) {
    const exact = all.find((s) => s.dirName === t)
    if (exact) return join(exact.path, SESSION_MD)
  }

  // ② code 段匹配：标题首 token（'-' 前）作为候选 code（S142 / apaas-26116 / P31…）
  const codeToken = t.split('-')[0]?.trim() ?? ''
  if (codeToken) {
    const byCode = all.filter((s) => {
      // desc 目录 `--<code>--` 段 或 issue 目录 `--<code>` 尾段
      const m = s.dirName.match(/--([^--]+)--/)
      const code = m ? m[1] : null
      const tailMatch = s.dirName.match(/--([^--]+)$/)
      const tailCode = tailMatch && !s.dirName.includes('--', s.dirName.lastIndexOf('--') + 3) ? tailMatch[1] : null
      return code === codeToken || tailCode === codeToken || s.dirName === codeToken || s.dirName.includes(`--${codeToken}`)
    })
    if (byCode.length === 1) return join(byCode[0]!.path, SESSION_MD)
    if (byCode.length > 1) return null // 歧义不猜
  }

  // ③ 唯一模糊子串（标题概括片段可能含目录描述）
  const fuzzy = all.filter((s) => s.dirName.toLowerCase().includes(t.toLowerCase()))
  if (fuzzy.length === 1) return join(fuzzy[0]!.path, SESSION_MD)
  return null
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

// ── summary ──

/** summary 仪表盘（供 `list` 动作拼接；v1.33 起独立 `summary` 动作已撤，并入 list） */
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
    // v1.33：不再指向已删的 health 动作——提示事实本身（长期无活动的轨迹清单在 list 里可见）
    lines.push('', '⚠ Warning: stale trajectories present (no activity > 7d) — see the list above for detail.')
  }
  return lines.join('\n')
}
