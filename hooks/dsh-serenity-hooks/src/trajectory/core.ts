/**
 * cognitive-trajectory-ops.ts — 轨迹工具纯操作层（零 DSH 依赖，可独立单测）
 *
 * 行为对齐 osp（opencode-serenity-plugin/src/session/lib.ts）——osp 是 ACC 工具 spec。
 *
 * v1.33 收敛（S142 §32）：本文件只服务 `cognitive_trajectory` 的动作面
 * （现行 **8 个**：list / show / create / use / rebuild / **send-now** / **send-later** / **cro-guide**）。旧 `logbook` 面里
 * **close / archive / health / qa 四个动作已删**（用户裁决「功能上废弃，实际上没用」），
 * 其函数（closeSession / archiveSessions / healthCheck / qaCheck）**同批删除**——
 * 保留下来的只有：create（--desc / --issue 二选一、dry-run 预览）、
 * list（含 summarize 仪表盘）、show、use（激活 + 绑定）、以及供 list 用的 summarize。
 *
 * ## 🔴 2026-10-18（owner 令）：**认知轨迹没有生命周期**
 *
 * owner 原话要点：*"我需要允许永存的认知轨迹……我希望该生命周期足够简单，即没有生命周期，
 * 但允许轨迹本身被操作为归档"*。据此**删除**了以下全部"生命周期"语义：
 *
 * | 被删的 | 为什么它属于生命周期 |
 * |---|---|
 * | `completed` 解析（SESSION.md 里的方括号小写 x） | "完成"是一个**终态**；没有生命周期就没有终态 |
 * | `summarize` 的 Active / Completed / Stale / Ghost 四项计数 | 四项全部在给轨迹分"阶段" |
 * | `advisoryHint` 的「N 天未更新」告警 | 老化告警的前提是"旧轨迹该退休了"——现在**旧不是问题** |
 * | `findLatestActiveSessionMd`（**全仓零消费者**，纯死代码） | 它的语义是"最新的**未完成**轨迹"，前提已不存在 |
 *
 * **保留**：SESSION.md 头部的状态行**照旧生成**（`- 状态: [ ] 进行中`），但**不再被任何代码解析**。
 * 理由（owner 裁决）：格式最小变动、老文件完全不用改。⇒ 它从"机器契约"降为**惰性文本**，
 * 且"进行中"对永存轨迹**恒为真**，因此不构成谎言。
 *
 * **新增唯一的操作**：`archiveSession()` —— 单向移入 `_archived/`。
 * 归档是**唯一的"变化"**，且它不属于轨迹自身：轨迹本体（目录 ＋ SESSION.md）**永不被改**，
 * 只是**换了个存放位置**、从清单里消失。恢复 = 手工 `container_fs mv` 移回（owner 裁决：不设 unarchive）。
 *
 * ⚠️ 由此产生一条**必须成立**的配套：`readAllSessions` **跳过 `_` 前缀目录**。
 * 否则归档后的轨迹会继续出现在清单里，"归档"就不是归档了（历史 bug：`_weixin-logs` /
 * `_skiff-logs` / `_corpus` 曾被当成轨迹列出来）。
 */

import {
  existsSync,
  statSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { localDate, localDateTimeMinutes } from '../time.js'

/**
 * `cognitive_trajectory` 工具的动作集合（v1.33，S142 §32 用户裁决后的收敛结果）。
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
 *   设计稿 docs/cognitive-trajectory-send-message-design.md。
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
type CognitiveTrajectoryAction = 'list' | 'show' | 'create' | 'use' | 'rebuild' | 'archive' | 'uid' | 'send-now' | 'send-later' | 'cro-guide'

export const COGNITIVE_TRAJECTORY_ACTIONS: readonly CognitiveTrajectoryAction[] = [
  'list', 'show', 'create', 'use', 'rebuild', 'archive', 'uid', 'send-now', 'send-later', 'cro-guide',
]

/**
 * 读取 Session 事件序列（v1.28.1 适配 0.1.2-rc.1 补齐）：rc.1 起官方 Session 类
 * 移除 `.events` 属性 → `snapshotEvents()` 方法（dsh-session/src/session.ts：
 * `snapshotEvents(fromSeq, toSeqExclusive)`）。插件早期代码多处裸读 `.events`
 * （经 `as unknown as { events? }` 断言绕过 typecheck），运行时静默 undefined——
 * 造成 fake-initial-turns 每轮重插 / SESSION 激活恢复失效 / rebuild 定位错乱。
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
const DAY = 86_400_000

/** 归档区目录名（`_` 前缀 ⇒ 不是轨迹，见 readAllSessions 的跳过判据） */
export const ARCHIVED_DIR = '_archived'

export function sessionsRoot(root: string): string {
  return join(root, 'AGENT_SESSIONS')
}

// ── 会话条目与状态（对齐 osp readAllSessions/parseSessionMd）──

/**
 * 轨迹的**存在形态**（🔴 **2026-10-18 起不再是"生命周期"**）。
 *
 * `hasSessionMd` 是唯一的判据，而且它**不是阶段**：它只说"这个目录里有没有正文"。
 * 旧字段 `completed` 已删除（见文件头「认知轨迹没有生命周期」）。
 */
interface SessionStatus {
  hasSessionMd: boolean
}

interface SessionEntry {
  dirName: string
  path: string
  mtime: Date
  status: SessionStatus
}

/**
 * 解析 SESSION.md 存在性。
 *
 * 🔴 **2026-10-18：不再解析"完成"**。旧实现 `completed: /\[\s*x\s*\]/i.test(content)` 已删——
 * 轨迹永存 ⇒ 没有终态，而这个字段的所有消费者（排序 / 标记 / 计数）也同批删掉了。
 * ⚠️ **副作用（有意接受）**：`[x]` 不再有机器含义 ⇒ 正文里出现它**不会再**把轨迹判成任何东西。
 * 那条"正文绝不能用方括号小写 x"的老纪律随之解除（但它仍是无害的好习惯）。
 */
function parseSessionMd(filePath: string): SessionStatus {
  try {
    readFileSync(filePath, 'utf-8')
    return { hasSessionMd: true }
  } catch {
    return { hasSessionMd: false }
  }
}

function readSessionEntry(dirPath: string): SessionEntry | null {
  try {
    const st = statSync(dirPath)
    if (!st.isDirectory()) return null
    const dirName = basename(dirPath)
    const mdPath = join(dirPath, SESSION_MD)
    const status = existsSync(mdPath) ? parseSessionMd(mdPath) : { hasSessionMd: false }
    return { dirName, path: dirPath, mtime: st.mtime, status }
  } catch {
    return null
  }
}

/**
 * 读取 AGENT_SESSIONS 中所有**活跃**轨迹，按 mtime 降序。
 *
 * 🔴 **跳过 `_` 前缀目录**（2026-10-18 新增，与归档配套）：
 * `_archived` 是归档区，`_skiff-logs` / `_weixin-logs` / `_corpus` 是**日志与数据区**——
 * 它们**都不是轨迹**。旧实现会把它们当轨迹列出来（历史 bug）。
 * 没有这条，归档后的轨迹仍会出现在清单里 ⇒ **"归档"名不副实**。
 *
 * ⚠️ 排序判据已变：旧实现是「未完成优先，再 mtime 降序」，现在**只有 mtime 降序**
 * （没有"未完成"这个概念了）。
 */
function readAllSessions(sessionsDir: string): SessionEntry[] {
  try {
    return readdirSync(sessionsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .filter((e) => !e.name.startsWith('_') && !e.name.startsWith('.'))
      .map((e) => readSessionEntry(join(sessionsDir, e.name)))
      .filter((s): s is SessionEntry => s !== null)
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
  } catch {
    return []
  }
}

/** 提取目录名中的会话 ID（S### 或 issue 名）；无匹配返回 '' */
function extractSessionId(dirName: string): string {
  const m = dirName.match(/--S(\d{3,})--/)
  return m ? `S${m[1]}` : ''
}

// ── 唯一标识符（UID）──

/**
 * UID 的声明文件名（**固定名、住在轨迹目录内**）。
 *
 * 🔴 owner 2026-10-18 需求原话：*"认知轨迹编号和命名问题，命名很可能由于变化而变化，
 * 所以我们需要让认知轨迹支持一种用于交流的唯一标识符，它不同于编码和命名，而是单独设定的
 * （也可以不设定，不设定就还是用编码），所有可以用编码操作的能力，都同样支持唯一标识符，
 * 唯一标识符用文件形式声明在认知轨迹目录中"*。
 *
 * ## 为什么是「一个文件」而不是 frontmatter 里一行
 * | 形 | 问题 |
 * |---|---|
 * | 写进 `SESSION.md` frontmatter | SESSION.md 是**轨迹的身体**（会被重写、被 rebuild 锚点反复读）⇒ 标识符住在会变的东西里 |
 * | 写进目录名 | 改名即变 —— 而这正是要解决的问题（owner：命名会变） |
 * | **独立小文件**（选定） | 与目录名、SESSION.md **都解耦**；改标识符不动正文、不动目录名；删文件即"回到用编码" |
 *
 * ## 语义边界（R↓）
 * - **可选**：文件不存在 ⇒ 用编码（`S###`），**不是错误**。
 * - **只用于"被指认"**：它是 `findSession` 的一个**解析分支**，不参与排序、不参与展示优先级、
 *   **不改变**目录名与 SESSION.md 一个字节（与 `archive` 同一条纪律：只换指认方式，不动本体）。
 * - **唯一性**：由 `setTrajectoryUid` 在写入时保证（重复即拒绝）。读取侧不做全表唯一性断言 ——
 *   外部手工造的重复应由写入侧拦，读取侧只能"第一个命中"，那是注入侧的职责不是解析侧的。
 */
export const UID_FILENAME = 'TRAJECTORY-UID'

/** UID 合法形态：**保守**（只允许交流安全的字符）—— 它会被用在命令行、消息文本、日志里 */
const UID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * 校验 UID 形态。
 *
 * 为什么保守（R↓）：UID 是**给人和 agent 在对话里互相指认用的**（owner：「用于交流」）⇒
 * 它必须能**逐字打出来**。含空格/引号/中文的 UID 会在 shell、JSON、markdown 里各自需要一套转义
 * ⇒ "用于交流"这个目的当场失败。⇒ 限定 `[A-Za-z0-9._-]`，首字符必须字母数字，上限 64。
 *
 * ⚠️ 大小写**敏感**：`S142` 与 `s142` 是两个不同 UID（判据：唯一标识符不是给人近似匹配用的；
 * 要模糊匹配请用目录名/编码那条既有分支）。
 */
export function isValidUid(uid: string): boolean {
  return UID_PATTERN.test(uid)
}

/**
 * 读一条轨迹的 UID（文件不存在 / 读失败 / 形态非法 ⇒ `null` = "没设定"）。
 *
 * 🔴 **形态非法的文件按"没设定"处理，而不是报错**：解析侧出现在**每一次** `findSession` 里
 * （show/use/archive/send-now/send-later 全走它），在那里抛错会让一个坏文件**炸掉整条轨迹的所有操作**
 * —— 惩罚远大于问题本身。坏 UID 由 `setTrajectoryUid` 在**写入侧**拦住（那里才该响亮失败）。
 */
export function readTrajectoryUid(sessionPath: string): string | null {
  try {
    const raw = readFileSync(join(sessionPath, UID_FILENAME), 'utf-8').trim()
    return isValidUid(raw) ? raw : null
  } catch {
    return null // 无该文件 = 未设定（常态，不是错误）
  }
}

/**
 * 设定 / 清除一条轨迹的 UID。
 *
 * @param sessionsDir AGENT_SESSIONS 绝对路径
 * @param key 定位用（目录名 / S### / 既有 UID / 唯一模糊串）
 * @param uid 新 UID；`null` ⇒ **删除声明文件**（回到"用编码"）
 * @throws UID 形态非法 ／ 已被**别的**轨迹占用 ／ 目标轨迹不存在
 */
export function setTrajectoryUid(sessionsDir: string, key: string, uid: string | null): { dirName: string; uid: string | null; path: string } {
  const target = findSession(sessionsDir, key)
  if (!target) throw new Error(`Trajectory not found: "${key}". Use "list" to see available trajectories.`)
  const file = join(target.path, UID_FILENAME)

  if (uid === null) {
    rmSync(file, { force: true })
    return { dirName: target.dirName, uid: null, path: file }
  }

  if (!isValidUid(uid)) {
    throw new Error(
      `Invalid trajectory UID: "${uid}". ` +
      `允许 [A-Za-z0-9._-]，首字符须字母或数字，长度 ≤64（它要被逐字打出来用于交流 ⇒ 不容忍需要转义的字符）`,
    )
  }
  // 🔴 唯一性 = 写入侧的责任：重复 UID 会让"用 UID 指认"变成歧义，而**歧义在读取侧无法消解**
  const clash = readAllSessions(sessionsDir).find(
    (s) => s.dirName !== target.dirName && readTrajectoryUid(s.path) === uid,
  )
  if (clash) {
    throw new Error(`UID "${uid}" 已被 ${clash.dirName} 占用（唯一标识符必须唯一；先解除它或换一个）`)
  }
  writeFileSync(file, uid + '\n', 'utf-8')
  return { dirName: target.dirName, uid, path: file }
}

/**
 * 根据 key 查找轨迹。
 *
 * 解析顺序（**越精确越靠前**，且**前三级都不做模糊**）：
 * ① 目录名精确 ／ ② **UID 精确** ／ ③ 编码 `S###`（允许 `S31`→`031`）／ ④ 唯一模糊子串（多个则报错）
 *
 * 🔴 **UID 排在编码之前**是因为 owner 定的语义：UID 是"单独设定"的**交流标识**
 * （"不设定就还是用编码"⇒ 设定之后，用 UID 指认就该与编码同等可靠）。
 * 它与目录名都属**精确匹配**、彼此不会混淆（UID 形态不含 `--`，目录名必含）⇒ 顺序对结果无实质影响，
 * 但把这个顺序写死，避免后来者以为"UID 是模糊匹配的一种"。
 */
export function findSession(sessionsDir: string, key: string): SessionEntry | null {
  const all = readAllSessions(sessionsDir)
  const byName = all.find((s) => s.dirName === key)
  if (byName) return byName
  // ② UID 精确命中（大小写敏感）
  const byUid = all.find((s) => readTrajectoryUid(s.path) === key)
  if (byUid) return byUid
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
    // 🔴 2026-10-18：只剩两态（active ● / 普通 ○）。旧的三态里 `✓` = "已完成"，随生命周期一起删。
    const status = isActive ? '●' : '○'
    // UID 设定过就同时印出来（owner：它是"用于交流的唯一标识符"）——
    // ⚠️ 未设定时**不印占位符**：没有 UID 是常态，印一个空括号只会制造噪声。
    const uid = readTrajectoryUid(s.path)
    const uidTag = uid === null ? '' : ` [${uid}]`
    return `${status} ${s.dirName} (${age}d ago)${uidTag}`
  })
  return `AGENT_SESSIONS/ (${sessions.length} active)\n` + lines.join('\n')
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

/**
 * 生成 SESSION.md 模板（固定格式，owner 2026-09-25 裁决；时间戳 YYYY-MM-DD HH:mm）。
 *
 * 🔴 **2026-10-18：状态行不再是机器契约**（owner 裁决：轨迹永存，没有生命周期）。
 * 它**照旧生成** `- 状态: [ ] 进行中`，但**没有任何代码解析它** —— 从"被解析的机器契约"
 * 降为**惰性文本**。保留的两个理由：
 *   ① 格式最小变动、老文件完全不用改；
 *   ② 对永存轨迹来说"进行中"**恒为真**，所以它不是谎言，只是冗余。
 * ⚠️ 仍然**不得**把任何一段固定 7 段的段名与顺序动掉（契约钉在 `tests/trajectory-ops.test.ts`）。
 */
function sessionMdTemplate(title: string, id: string, goal: string | undefined, now: Date): string {
  const ts = localDateTimeMinutes(now)
  return (
    `# SESSION: ${title}\n- ID: ${id}\n- 状态: [ ] 进行中\n\n` +
    `## 身份与边界\n${goal ?? '（待补充）'}\n\n` +
    `## 权威锚点\n- （指针：仓库 / 工具 / 单一真相源位置）\n\n` +
    `## 工作纪律\n- （只放本轨迹特有的；通用项外推到 skill）\n\n` +
    `## 决策\n| # | 决策 | 理由 / 否决项 |\n|---|------|------|\n| 1 | | |\n\n` +
    `## 日志\n- ${ts} — 创建（里程碑 ＋ 证据指针；执行细节归 commit message）\n\n` +
    `## 当前状态\n- 在办：\n- 断点：\n\n` +
    `## 待 owner 裁决\n- \n`
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
// 🔴 2026-09-25（S142 工程化程序第 ④ 项·第 1 步）**从 `tools/cognitive-trajectory.ts` 下沉至此**。
// 为何在 L1：`rebuild.ts`（L1）原**静态** import `tools/cognitive-trajectory.ts`（L3）**只为取 `namingTitleFor`**
// ⇒ 既是 L1→L3 上行边，又与 `tools/cognitive-trajectory.ts` 里 `await import('../rebuild.js')` 的合法下行边
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
    `  When a milestone lands or a decision is made: overwrite "当前状态" and append ONE`,
    `  milestone line to "日志" (one line + an evidence pointer — details go to the commit message).`,
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
  // 🔴 本正则必须与**两个发射点逐字同步**：`seams/system-prompt.ts` 的 Session 块
  //    与 `rebuild.ts` 的重建锚点规范行。改一侧不改另一侧 ⇒ 静默剥不掉尾注 ⇒
  //    解析出的路径带上注释文字 ⇒ 会话恢复断链，且 **typecheck 抓不到**（正则字面量无类型）。
  //    （2026-10-18 更名时由三个 worker 独立报出同一处，见 D156。）
  const suffix = p.search(/ \(the cognitive trajectory's persistent body/)
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

// ── summary ──

/**
 * summary 仪表盘（供 `list` 动作拼接；v1.33 起独立 `summary` 动作已撤，并入 list）。
 *
 * 🔴 **2026-10-18：四项生命周期计数已删**（Active / Completed / Stale / Ghost）。
 * 它们全都在给轨迹**分阶段**，而 owner 裁决「没有生命周期」⇒ 唯一有意义的总数是 `Total`。
 * ⚠️ **`Ghost` 也被删了**（"目录在但没 SESSION.md"）—— 它不是阶段而是**损坏**，但：
 *   · 真出现时 `use` 会在 `advisoryHint` 里**当场说清**（用到才发现，比长期挂一个计数更有效）；
 *   · 挂一个恒 0 的计数只会钝化注意力。
 * `Total` 现在 = **活跃轨迹数**（`_` 前缀的归档区与日志区已不在域内）。
 */
export function summarize(root: string): string {
  const sessions = readAllSessions(sessionsRoot(root))
  if (sessions.length === 0) return 'AGENT_SESSIONS/ is empty.'
  const now = Date.now()
  const recent = sessions.slice(0, 5)
  const lines: string[] = [
    `AGENT_SESSIONS Summary`,
    `────────────────────────`,
    `Active (not archived): ${sessions.length}`,
    ``,
    `Recent activity (top 5):`,
    ...recent.map((s) => {
      const age = Math.floor((now - s.mtime.getTime()) / DAY)
      return `  ○ ${s.dirName} (${age}d ago)`
    }),
  ]
  return lines.join('\n')
}

// ── archive（🔴 2026-10-18 新增：唯一的"状态变化"，单向）──

/**
 * 活跃轨迹的**结构化**清单（面板消费；owner 2026-10-18 需求二）。
 *
 * 🔴 为什么不在面板侧重新扫目录：**"哪些轨迹是活跃的"只有一个判据源** =
 * `readAllSessions`（它已经实现 `_` 前缀跳过 = 归档区不在域内）。面板若自己扫一遍
 * `AGENT_SESSIONS/`，就会长出**第二份会漂的实现** —— 归档之后面板仍会列出它，
 * 而这种不一致**没有任何机械信号**（两边各自都"跑成功了"）。
 *
 * 字段都取自**文件系统事实**，不做任何推断：
 * `dirName` / `sessionId`（S### ，无则 ''）/ `ageDays`（目录 mtime 距今天数）/ `hasSessionMd`。
 * ⚠️ **没有 `completed`** —— 轨迹没有生命周期（见文件头）。
 *
 * @param root CCC 根
 * @returns 按 mtime 降序的活跃轨迹（已排除 `_` 前缀目录）
 */
export interface TrajectorySummary {
  dirName: string
  sessionId: string
  /**
   * 唯一标识符（未设定 ⇒ `null`）。面板与 `list` 同源显示 ——
   * 它是"用于交流"的标识，人类在面板上看到它才能直接拿去用。
   */
  uid: string | null
  ageDays: number
  hasSessionMd: boolean
}

export function listActiveTrajectories(root: string): TrajectorySummary[] {
  const now = Date.now()
  return readAllSessions(sessionsRoot(root)).map((s) => ({
    dirName: s.dirName,
    sessionId: extractSessionId(s.dirName),
    uid: readTrajectoryUid(s.path),
    ageDays: Math.floor((now - s.mtime.getTime()) / DAY),
    hasSessionMd: s.status.hasSessionMd,
  }))
}

export interface ArchiveResult {
  message: string
  dirName: string
  from: string
  to: string
  dryRun: boolean
}

/**
 * 把一条轨迹**单向**归档到 `AGENT_SESSIONS/_archived/`（owner 2026-10-18 裁决）。
 *
 * ## 为什么这是"唯一"的状态变化
 * 轨迹没有生命周期 ⇒ 它**不完成、不关闭、不衰老**。它只会**换个存放位置**：
 * 从活跃区移到归档区。目录与 SESSION.md **逐字节不动**（纯 rename）——
 * 「归档」在此**不是删除，也不是收尾**，只是"不再列在活跃清单里"。
 *
 * ## 判据（R↓）
 * ① **单向**：owner 裁决不设 unarchive。恢复 = 手工 `container_fs mv` 移回。
 *    ⇒ 不提供反向动作，避免"两个方向各自实现一遍、语义各自漂移"。
 * ② **绝不覆盖**：目标已存在 ⇒ 报错，**不合并、不重命名、不删除**。归档是不可逆动作，
 *    静默覆盖会**毁掉**先前那条轨迹（它的 SESSION.md 是唯一副本）。
 * ③ **归档区不建在别处**：落点恒为 `<CCC>/AGENT_SESSIONS/_archived/`，
 *    与 `readAllSessions` 的 `_` 跳过判据**成对**（换一处就要同时改两处 ⇒ 不换）。
 * ④ `dryRun` 只报路径、不落盘。
 *
 * @param root CCC 根
 * @param key 目录名 / S### / 唯一模糊串（同 findSession）
 * @param dryRun 预览
 */
export function archiveSession(root: string, key: string, dryRun = false): ArchiveResult {
  const sessionsDir = sessionsRoot(root)
  const target = findSession(sessionsDir, key)
  if (!target) {
    throw new Error(`Trajectory not found: "${key}". Use "list" to see available trajectories.`)
  }
  const archiveRoot = join(sessionsDir, ARCHIVED_DIR)
  const dest = join(archiveRoot, target.dirName)
  // 判据②：目标已存在 ⇒ 响亮失败（绝不覆盖）
  if (existsSync(dest)) {
    throw new Error(
      `Cannot archive: "${target.dirName}" already exists in ${ARCHIVED_DIR}/. ` +
      `归档不会覆盖既有轨迹（那是不可逆的丢失）。请先人工处理 ${dest}`,
    )
  }
  if (dryRun) {
    return {
      message: `[dry-run] Would archive: ${target.dirName} → ${ARCHIVED_DIR}/`,
      dirName: target.dirName,
      from: target.path,
      to: dest,
      dryRun: true,
    }
  }
  mkdirSync(archiveRoot, { recursive: true })
  renameSync(target.path, dest)
  return {
    message: `Archived: ${target.dirName} → ${ARCHIVED_DIR}/`,
    dirName: target.dirName,
    from: target.path,
    to: dest,
    dryRun: false,
  }
}
