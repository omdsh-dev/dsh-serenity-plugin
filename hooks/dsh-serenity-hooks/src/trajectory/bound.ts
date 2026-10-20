/**
 * trajectory/bound.ts — 「会话 ↔ 认知轨迹」绑定（**2026-10-20 重做：归属 = 轨迹自己的交代**）
 *
 * ## 判决 D172（owner 2026-10-20 原话，这是整个文件的设计依据）
 *
 * > 「**认知轨迹自己交代永远是最好的交代**」
 * > 「绑定表是没有意义的，绑定关系必须**运行时按照规则探测**，绑定表本质就搞成**第二真相源**了」
 * > 「依赖文件系统…每个认知轨迹目录内放一个 `current.dsh_session_bind`，**以这个为绑定真相源**」
 * > 「文件里写的 sessionId **可能已经不存在了**，这个情况下就**视同没绑定**，就正确了」
 *
 * ## 旧形态为什么错（不是"性能不够"，是"真相源放错地方"）
 *
 * 旧实现用 **`.bindings.json` ＋ 宿主存储域** 两张旁路索引记录"谁承载谁"。
 * 它们是**旁路**：描述的对象（轨迹目录）与自己分离 ⇒ 一旦不一致就要写代码对账，
 * 而**对账失败没有任何机械信号**（本轨反复踩的形状：症状与真因在读数上完全不像）。
 *
 * 新形态：归属写在**轨迹目录自己里面**（`current.dsh_session_bind`）。
 * 判据不再是"表里有没有一条记录"，而是"**这一刻谁真的在承载它**"。
 *
 * ## 🔴 三条不变量（前两条由**形态**保证，第三条由**探针**保证）
 *
 * | # | 不变量 | 保证方式 |
 * |---|---|---|
 * | 1 | 一条轨迹**至多一个**当前载体 | 它是**一个文件**，写入即整体原子覆盖 |
 * | 2 | 一个载体**至多一条**轨迹 | 写入前扫全部轨迹的交代，该 id 已在别处 ⇒ **拒绝** |
 * | 3 | **会话不存在 ⇒ 视同没绑定** | `isBindUsable(decl, alive)`（探针由调用方给） |
 *
 * ⚠️ 旧的 `supersededAt`（"只留一条"靠标记退掉）**整条退役**：标记可以忘，覆盖不会忘。
 * 存量里带 `supersededAt` 的记录在迁移时**直接跳过**（它们本就不是"当前"）。
 *
 * ## 零依赖与不抛
 * 读函数**永不抛**；写函数返回布尔 / 结构化结果，由调用方决定如何呈现。
 */

import {
  type BindDeclaration,
  claimBinding,
  findTrajectoryHolding,
  isBindUsable,
  listBindDeclarations,
  readBindDeclaration,
  writeBindDeclaration,
  BIND_FILENAME,
} from './bind-file.js'
import { cccRootForCwd } from '../kernel/ccc-roots.js'
import { getActiveSessionInfo, getLastActiveSessionInfo, parseTrajectoryCode, sessionEvents, sessionsRoot } from './core.js'
import { join } from 'node:path'

/** 绑定记录形状（对外保持旧名，避免 10 个调用点全部改名） */
export interface SessionBoundRecord extends BindDeclaration {
  /** 轨迹目录名（**锚**；不是 `S###` —— 编码只是展示） */
  dirName: string
  /** `SESSION.md` 绝对路径（展示 / 定位用；**不作锚**） */
  mdPath: string
  /** 展示码（`S###` 或自定义），**仅展示** */
  sessionId2?: string
}

/** ⚠️ 兼容层：旧代码里 `rec.sessionId` 曾指"展示码"，现在指 dsh 会话 id。见 `readLastBound` 的返回。 */
export type SessionBoundAction = 'activate' | 'switch' | 'create' | 'rebuild' | 'reconcile' | 'release'

/**
 * 从 dsh 会话对象取 `header.id` / `header.cwd`。
 * @returns 取不到 ⇒ `null`
 */
function sessionHeader(session: unknown): { id?: string; cwd?: string } | null {
  const header = (session as { header?: unknown } | null | undefined)?.header
  if (!header || typeof header !== 'object') return null
  return header as { id?: string; cwd?: string }
}

/** 由会话对象定位 CCC 根（上溯 `.serenity`）；定位不到 ⇒ `null` */
function rootOf(session: unknown): string | null {
  const cwd = sessionHeader(session)?.cwd
  if (typeof cwd !== 'string') return null
  return cccRootForCwd(cwd)
}

/** 目录名 → 轨迹标签（固定位置编码；非本工具建的目录回退整名——编码无关 U4） */
function cognitiveTrajectoryLabel(dirName: string): string {
  return parseTrajectoryCode(dirName) ?? dirName
}

/**
 * 把一条「轨迹自我交代」投影成对外的 `SessionBoundRecord`。
 *
 * 🔴 **`sessionId` 的语义在这里对齐**：旧记录里 `sessionId` 是**展示码**（`S###`），
 * 新绑定文件里是**dsh 会话 id**（它是硬锚）。历史调用方有两类读法，故两个字段都给：
 *  · `sessionId` → **dsh 会话 id**（新语义，硬锚）
 *  · `sessionId2` → 展示码（由轨迹目录名派生；旧语义）
 * 这样"我要这个会话的 id"与"我要显示成 S###"各自有确定字段，不再靠猜。
 */
function toRecord(dirName: string, decl: BindDeclaration, root: string): SessionBoundRecord {
  return {
    dirName,
    mdPath: join(root, 'AGENT_SESSIONS', dirName, 'SESSION.md'),
    sessionId: decl.sessionId,
    sessionId2: cognitiveTrajectoryLabel(dirName),
    at: decl.at,
    action: decl.action,
    ...(decl.note !== undefined ? { note: decl.note } : {}),
    ...(decl.createdAsUser === true ? { createdAsUser: true } : {}),
  }
}

// ── 向后兼容的常量（旧代码里用于拼 `.bindings.json` 路径；新形态不再使用）──────────
/** @deprecated D172：绑定已迁到轨迹目录内；保留导出只为不打断外部 import */
export const BINDINGS_REL_PATH = 'AGENT_SESSIONS/.bindings.json'

/** @deprecated D172：存储域已退役；保留为空实现，装载期调用点无需改动 */
export function setBindingStore(_store: unknown): void {
  /* 存储域退役（D172）：绑定真相源 = 轨迹目录里的 current.dsh_session_bind */
}

/** @deprecated D172：迁移已由一次性脚本完成；保留恒零返回 */
export function migrateBindingsToDomain(_root: string): { migrated: number; skipped: number; failed: number } {
  return { migrated: 0, skipped: 0, failed: 0 }
}

/** @deprecated D172：`.bindings.json` 已退役；保留返回 null */
export function bindingsPathFor(_session: unknown): string | null {
  return null
}

/**
 * 读**这个会话**当前承载哪条轨迹（正向：会话 → 轨迹）。
 *
 * 判据（D172）：扫全部轨迹的自我交代，找 `sessionId === 本会话 id` 且**仍然 usable** 的那条。
 *
 * 🔴 为什么这里是"扫"而不是"查表"：**归属是算出来的，不是记下来的**。
 * 本 CCC 的轨迹数是**数十**量级，每次读盘只读每个目录里的一个小文件；比维护一份会漂的索引便宜。
 *
 * ⚠️ **不验"会话是否还活着"**：本函数回答的是"这个**活着的**会话属于谁"——
 * 调用方手里就拿着那个会话对象，它显然存在。`alive` 探针只在**反向**（轨迹 → 会话）才需要。
 *
 * @returns 记录（含 `dirName` / `mdPath` / dsh `sessionId`）；无 ⇒ `null`
 */
export function readLastBound(session: unknown): SessionBoundRecord | null {
  const id = sessionHeader(session)?.id
  const root = rootOf(session)
  if (typeof id !== 'string' || id === '' || root === null) {
    return readLegacyBoundFromEvents(session)
  }
  for (const { dirName, decl } of listBindDeclarations(sessionsRoot(root))) {
    if (decl.sessionId === id) return toRecord(dirName, decl, root)
  }
  // 兜底：本插件 v1.30.5 及更早把绑定写进会话日志（只读兼容，永不写）
  return readLegacyBoundFromEvents(session)
}

/** 旧形态事件类型（v1.29.1~v1.30.5 写入会话日志；只读兼容，**永不写**） */
const SESSION_BOUND_EVENT = 'serenity/bound' as const

/** 从会话日志扫最后一条 `serenity/bound`（兼容存量；坏记录跳过） */
function readLegacyBoundFromEvents(session: unknown): SessionBoundRecord | null {
  const events = sessionEvents<unknown>(session)
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i] as { type?: unknown; data?: unknown } | null | undefined
    if (!ev || ev.type !== SESSION_BOUND_EVENT) continue
    const d = ev.data as Partial<SessionBoundRecord> | null | undefined
    if (!d || typeof d.dirName !== 'string' || typeof d.mdPath !== 'string') continue
    return {
      dirName: d.dirName,
      mdPath: d.mdPath,
      sessionId: typeof d.sessionId === 'string' ? d.sessionId : '',
      at: typeof d.at === 'number' ? d.at : 0,
      action: typeof d.action === 'string' ? d.action : 'activate',
    }
  }
  return null
}

/** 判定会话是否已有归属（reconcile 用：无归属才允许用标题升级） */
export function hasAnyBound(session: unknown): boolean {
  return readLastBound(session) !== null
}

/**
 * **调用方自身**所属轨迹的标签（审计字段 `createdBy` 的唯一正解）。
 *
 * 三级来源（逐级回退，理由见旧实现注释与 S142 §30.12.1 实测）：
 *  1. `readLastBound(session)` —— 持久归属（重启存活）
 *  2. `getActiveSessionInfo(scope)` —— 本会话的内存激活（按 scope 隔离）
 *  3. `getLastActiveSessionInfo()` —— 全局最近激活指针（最后兜底）
 */
export function resolveSessionCognitiveTrajectoryLabel(session: unknown, scope: string): string {
  const bound = session ? readLastBound(session) : null
  if (bound?.dirName) return cognitiveTrajectoryLabel(bound.dirName)
  const scoped = scope !== '' ? getActiveSessionInfo(scope) : null
  if (scoped) return scoped.sessionId
  return getLastActiveSessionInfo()?.sessionId ?? ''
}

/**
 * 反向查：**此刻**承载某条轨迹的 dsh 会话 id（按 `at` 倒序，最新在前）。
 *
 * D172 起判据 = **轨迹自己的交代 ＋ "那个会话还在"**：
 *  · 文件不存在 ⇒ 没绑定
 *  · 文件在但 `alive` 说不存在 ⇒ **视同没绑定**（owner 原话），**不算候选**
 *
 * ⚠️ **`alive` 缺省时怎么判**：调用方没给探针 ⇒ 只能信文件（`usable`）。
 * 那是"读不到宿主事实"的降级，**不是**"会话一定在"。需要严格判的一方请显式传探针
 * （唤醒选人是这种：见 `wake/scheduler.ts`）。
 *
 * 🔴 **2026-10-20（owner 裁决）：生产调用点必须传探针，两个调用点都已接上。**
 * 缺省分支**保留**只为两件事：① 既有单测的向后兼容；② 诊断面"只读文件"的显式用法。
 * ⛔ 不要新增不传探针的生产调用点 —— 那等于把"归档会话算活"的漏洞再开一次
 * （本仓同族已踩：`carrierState` ＋ CRO 快照两处都漏传过）。
 * 生产一律用 `trajectory/alive.ts` 的 `hostAliveProbe(ctx)`（判据 ＝ owner 定的
 * 「① 进程内 loaded ∨ ② 日志在且未被归档」）。
 *
 * @param root CCC 根
 * @param dirName 轨迹目录名
 * @param alive 探针：该 dsh 会话 id 此刻是否真实存在
 * @returns 会话 id 列表（本形态**至多一条**——一个文件只装一个 id）；无 ⇒ `[]`
 */
export function listBoundSessionIds(
  root: string,
  dirName: string,
  alive?: (sessionId: string) => boolean,
): string[] {
  const decl = readBindDeclaration(join(sessionsRoot(root), dirName))
  if (decl === null) return []
  const usable = alive
    ? isBindUsable(decl, alive).state === 'usable'
    : isBindUsable(decl, () => true).state === 'usable'
  return usable ? [decl.sessionId] : []
}

/**
 * @deprecated D172：`supersededAt` 机制整条退役。
 *
 * 旧形态里"同轨迹只留一条"靠在别的记录上**盖戳**；新形态里它是**一个文件**，
 * 写入即覆盖 ⇒ **没有"其它条"可以盖戳**。保留本函数只为不打断既有调用点，
 * 恒返回空数组（"没有需要退休的"）。
 */
export function supersedeOtherBindings(_root: string, _dirName: string, _keepIds: ReadonlySet<string>): string[] {
  return []
}

/**
 * @deprecated D172：**悬空清理不再需要**。
 *
 * owner 原话：「文件里写的 sessionId 可能已经不存在了，这个情况下就**视同没绑定**，就正确了」。
 * ⇒ 过期文件**自动失效**，不需要任何人去删它；保留它反而记录了"上一次由谁承载"。
 * 保留本函数只为不打断既有调用点，恒返回空数组。
 */
export function pruneMissingBindings(_root: string, _isMissing: (sessionId: string) => boolean): string[] {
  return []
}

/**
 * 把一条轨迹的当前载体写成 `sessionId`（**唯一写入口**，内部走 `claimBinding` 的两条不变量）。
 *
 * 旧签名 `appendBound(session, action, rec)` 保持不变：`session` 提供 `header.id` / `header.cwd`，
 * `rec.dirName` 指明写哪条轨迹的交代。
 *
 * @returns 写入成功 ⇒ true（**每条轨迹只有一个文件，没有"追加"语义，只有"覆盖"**）
 */
export function appendBound(
  session: unknown,
  action: SessionBoundAction,
  rec: {
    dirName: string
    mdPath: string
    sessionId?: string
    note?: string
    createdAsUser?: boolean
    /** 允许顶掉该轨迹现有的另一个载体（rebuild / 崩溃后重建载体时**必须显式**声明） */
    takeover?: boolean
    /**
     * 探针：该轨迹**现有载体**是否还活着（决定"算不算占用"）。
     *
     * 🔴 2026-10-20（owner 裁决）：**死载体不构成占用**。
     * 不传 ⇒ 同一条轨迹现有的任何声明都算占用（旧语义，保守拒绝）。
     * 生产调用点应当传 {@link hostAliveProbe}（`trajectory/alive.ts`）。
     */
    alive?: (sessionId: string) => boolean
  },
): boolean {
  const id = sessionHeader(session)?.id
  const root = rootOf(session)
  // 🔴 **这条守卫不许静默**（2026-10-20，D186：守卫可以拒绝，但不许不出声）。
  //    它曾经是 `return false` 一句话，没有任何日志，而调用点又把返回值丢掉了。
  //
  //    ⚠️ **归因更正（同日晚些时候）**：S196 那次「回执成功、标题已改、绑定文件逐字节未变」
  //    **不是这一条守卫造成的** —— 那条会话的 header 齐全、日志也在。真因是
  //    `claimBinding` 的第 ② 条把**已归档的死载体**当成了占用者（见 `trajectory/alive.ts`
  //    与 `bind-file.ts` 的 `alive` 参数）。当时我读错了实现，把这条静默守卫当成了现场。
  //    ⇒ 保留这条告警**仍然正确**（它确实哑过，也确实该出声），但**别再把它当 S196 的解释**：
  //      两条失败路径的**读数不同** —— 这条是"取不到 header"，S196 是"header 齐全但槽位被占"。
  if (typeof id !== 'string' || id === '' || root === null) {
    console.warn(
      '[serenity-hooks] ✗ 绑定未写入（SESSION_HEADER_UNRESOLVED）：'
      + `会话对象取不到可用的 header（id=${typeof id === 'string' && id !== '' ? id : '(空/非字符串)'}，`
      + `root=${root ?? 'null（header.cwd 缺失或上溯不到 .serenity）'}）`
      + ` ⇒ 轨迹「${rec.dirName}」的 current.dsh_session_bind **未被改写**。`
      + ' 排查：该会话的 header.cwd 是否指向某个含 .serenity 的目录；'
      + ' 无 cwd 的会话（如某些程序性创建的载体）**不会**写绑定。',
    )
    return false
  }
  const result = claimBinding(
    sessionsRoot(root),
    rec.dirName,
    {
      sessionId: id,
      at: Date.now(),
      action,
      ...(rec.note !== undefined ? { note: rec.note } : {}),
      ...(rec.createdAsUser === true ? { createdAsUser: true } : {}),
    },
    { takeover: rec.takeover === true, ...(rec.alive !== undefined ? { alive: rec.alive } : {}) },
  )
  if (!result.ok) {
    // 🔴 不静默：绑定被拒意味着"这条轨迹现在归属不明"，必须让人看见
    console.warn(`[serenity-hooks] ✗ 绑定未写入（${result.code}）：${result.detail}`)
    return false
  }
  return true
}

// ── 供调用方做"这一步能不能建新载体"的判断（owner 第 2 条）─────────────────────────

/**
 * 这条轨迹**是否曾经有过载体**（判"要不要允许自建"）。
 *
 * 🔴 这是 owner 第 2 条的判据来源：**"绑定表空"≠"从未有过会话"**。
 * 旧实现拿"未退的绑定条目为空"当"没绑定"，于是一条轨迹的载体被退掉之后就
 * 又长出一个新的（实测：S196 在同一分钟出现第二个载体）。
 *
 * 新判据 = **轨迹目录里有没有交代文件**（哪怕它指向的会话已不存在 ⇒ 有过，就不再自动建）。
 *
 * @returns `'never'`（从未有过 ⇒ 允许自建）／`'occupied'`（有过 ⇒ 禁止自建）／`'live'`（此刻有效）
 */
export function carrierState(
  root: string,
  dirName: string,
  alive: (sessionId: string) => boolean,
): { state: 'live'; sessionId: string } | { state: 'occupied'; sessionId: string } | { state: 'never' } {
  const decl = readBindDeclaration(join(sessionsRoot(root), dirName))
  if (decl === null) return { state: 'never' }
  const v = isBindUsable(decl, alive)
  return v.state === 'usable'
    ? { state: 'live', sessionId: decl.sessionId }
    : { state: 'occupied', sessionId: decl.sessionId }
}

/** 某会话 id 现在安家在哪个轨迹（唯一性查询的对外门面） */
export function findTrajectoryOfSession(root: string, sessionId: string): string | null {
  return findTrajectoryHolding(sessionsRoot(root), sessionId)
}

/** 可写声明（迁移脚本 / 测试直用） */
export { writeBindDeclaration }
export { BIND_FILENAME }
export type { BindDeclaration }
