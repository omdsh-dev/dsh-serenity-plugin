/**
 * ccc-roots.ts — CCC 根解析的**唯一判断层**（L1 单根解析 + L2 全量枚举）
 *
 * 为什么存在（C2「CCC 发现面归一」，S142 2026-09-15 Q5 裁决）：
 * 「这个会话/路径属于哪个 CCC 根」（L1）与「本机有哪些 CCC」（L2）这两层判断此前被
 * 独立实现在 ~19 处，且互有分歧（同一进程内三个面可指向不同 CCC；"live CCC 列表"有三份
 * 不同答案；三层发现是**短路**而非合并 ⇒ 名单不全）。本模块把这两层**收成一个出口**：
 * 调用方只问本模块，不再各写各的上溯 + 兜底。
 *
 * 分层（唯一真相源边界，**不要**把下层搬进本模块）：
 *  - **L0 原语** `findSerenityRoot(cwd)`（`ccc.ts:16`）——**仍是唯一** L0 实现，本模块从它 import。
 *  - **L1 单根解析** —— 本模块：{@link agentCwdFor}（agent/exec → cwd）与
 *    {@link cccRootForCwd}/{@link cccRootForExec}（cwd → 根）。
 *  - **L2 全量枚举** —— 本模块：{@link listCccs}。
 *  - **L3 CCC 名解析** `readCccName`（`ccc.ts`）——不在本模块，也不与 `skills-discovery` 的
 *    第二份实现合并（那是另一条开放项）。
 *
 * 不新增持久状态（Q5 裁决：**不新增"本机 CCC 名单"**、不扫盘、不写路径假设）——
 * 枚举只读 **DSH 已有的三个来源**。
 *
 * ── 🔴 2026-09-25 I2 收敛（约束文档 §2.7 违反清单，L1 违反之一）────────────────
 * **本模块的 `ctx` 参数类型从 `Context` 改为 `unknown`** —— 消除本文件唯一的 `W2` 接触。
 *
 * **判据（与 `live-sessions.ts` 同款，但本文件要多过一道）：** 约束文档 §2.7 原记本处
 * `Context` 是"**实测真被用到**"（因它调 `hostService(ctx,…)`／`hostSessions(ctx)`）。
 * 🔴 **该判断把"透传"与"解引用"混为一谈了** —— 实测本文件 `ctx` 的**唯一**去向是
 * **原样透传**给两个 L0 取数口（签名均为 `ctx: unknown`），**零处** `ctx.xxx` 属性访问。
 * ⇒ `Context` 这个 import **未参与任何类型检查**，只贡献了一处 L1→宿主 的接触点。
 * 🔵 **证据（可重跑）**：grep 本文件 —— `ctx.` **0 命中**；`ctx` 命中全在
 * 参数位／调用位（`hostService(ctx, …)` ／ `hostSessions(ctx)`）。
 */

import { basename } from 'node:path'
import { hostService, hostSessions } from './host/access.js'
import { findSerenityRoot } from './ccc.js'

// ── L1：agent/exec → cwd → 根 ──

/**
 * 工具/缝里"取会话工作目录"的那段形状的最小模型。
 * 多数工具只带 `agent`（`exec.agent.session.header.cwd`）；少数缝把 agent 本身传进来。
 */
export interface ExecOrAgent {
  agent?: { session?: { header?: { cwd?: string } } }
  session?: { header?: { cwd?: string } }
}

/**
 * 取调用方的工作目录（**语义逐字保留**自原先散落 10 份的工具内副本）：
 * `exec.agent?.session?.header?.cwd ?? process.cwd()`。
 *
 * ⚠️ 无 `exec.agent` 时回落进程 cwd —— "用服务启动目录冒充会话目录"是**既有语义**，
 * 不是本模块的选择（改它会动到 9 个工具的根解析行为）。已知副作用与规避见
 * `tools/handyman.ts` 的「调用形态检查前移」补偿（`?? process.cwd()` 会把真因
 * "exec.agent 不存在"盖成 `No CCC found`）。
 */
export function agentCwdFor(execOrAgent: ExecOrAgent): string {
  return execOrAgent.agent?.session?.header?.cwd ?? execOrAgent.session?.header?.cwd ?? process.cwd()
}

/**
 * cwd → CCC 根（L0 原语的唯一调用形态；`ccc.ts` 之外不要再各写一遍）。
 * @param cwd 起始路径（目录或文件；文件会靠 `dirname` 上溯）
 * @returns CCC 根绝对路径；不在任何 CCC 内 → `null`
 */
export function cccRootForCwd(cwd: string): string | null {
  return findSerenityRoot(cwd)
}

/**
 * 工具/缝入口的根解析（L1 标准形态）：`agentCwdFor(...)` 再上溯。
 * @returns CCC 根；解析不到 → `null`（**不**回落假根——"回落进程 cwd 当根"是 `rebuild.ts`
 *   独有的另一条语义，见该处注释）
 */
export function cccRootForExec(execOrAgent: ExecOrAgent): string | null {
  return findSerenityRoot(agentCwdFor(execOrAgent))
}

/**
 * 工具根解析失败时抛出的**统一**错误文案。
 * 9 个工具原先各写一份字面量（内容完全相同）；抽成常量以保单一真相源，
 * **文案逐字不变**（外在行为不变）。
 */
export const NO_CCC_FROM_AGENT_CWD = 'No CCC found: no .serenity file from agent cwd'

// ── L2：全量枚举（本机有哪些 CCC）──

/** 候选 CCC 条目（调试页 CCC 切换器 / 微信桥 / ACP 问答页 / `/serenity/cccs` 共用数据形状） */
export interface CccEntry {
  /** CCC 根（绝对路径） */
  root: string
  /** 目录名（展示用） */
  name: string
  /**
   * 该 CCC 的 skiff 角色名列表。
   * ⚠️ **仅 `withRoles: true` 时非空**；缺省 `false` ⇒ 恒为 `[]` 且**不读任何
   * `serenity.json`**（唤醒调度器每 tick 都要枚举，不该为角色付 IO；见 listCccs 说明）。
   */
  roles: string[]
}

export interface ListCccsOptions {
  /**
   * 默认根：不在结果里时 **unshift 到首位**（既有语义，逐字保留）。
   * 传 `undefined`/`''` 表示没有默认根。
   */
  defaultRoot?: string
  /** 是否实时读取各 CCC 的 `skiff.roles`（缺省 false）。 */
  withRoles?: boolean
}

/** 起点路径集合会被逐条 `findSerenityRoot` 上溯并按根去重（保序） */
function makeCollector(): { push(cwd: string | undefined): void; roots: string[] } {
  const roots: string[] = []
  return {
    roots,
    push(cwd: string | undefined): void {
      if (typeof cwd !== 'string' || cwd === '') return
      const r = findSerenityRoot(cwd)
      if (r && !roots.includes(r)) roots.push(r)
    },
  }
}

/**
 * ① **dsh 工作区注册表**（`workspaceRegistry.list`，持久化——所有工作目录即使无 live 会话）。
 * S142 用户 2026-08-29：应直接拉 dsh 工作区，且只列具体 CCC。
 */
function workspaceRegistryPaths(ctx: unknown): string[] {
  const out: string[] = []
  try {
    const registry = hostService<{ list?: () => Array<{ path?: string }> }>(ctx, 'workspaceRegistry')
    for (const ws of registry?.list?.() ?? []) {
      if (typeof ws?.path === 'string') out.push(ws.path)
    }
  } catch {
    /* workspace 服务不可用忽略 */
  }
  return out
}

/**
 * ② **dsh 持久化会话**（`sessionPersistence.list`，必装配服务——覆盖所有历史会话工作目录）。
 *
 * v1.31.6 适配 0.1.5-rc.1：`list()` 返回形状变了（**静默突破**——形状由本处断言自写，
 * 宿主改名/改形在类型检查里看不见）：
 *   0.1.2      → `Promise<SessionHeader[]>`             → `h.cwd`
 *   0.1.5-rc.1 → `Promise<SessionPersistenceSnapshot[]>` → `h.header.cwd`
 */
async function sessionPersistencePaths(ctx: unknown): Promise<string[]> {
  const out: string[] = []
  try {
    const sp = hostService<{ list?: () => Promise<Array<{ header?: { cwd?: string } }>> }>(ctx, 'sessionPersistence')
    for (const h of (await sp?.list?.()) ?? []) {
      if (typeof h?.header?.cwd === 'string') out.push(h.header.cwd)
    }
  } catch {
    /* sessionPersistence 不可用忽略 */
  }
  return out
}

/** ③ **live 会话**（`sessions.list()` 的 cwd；`host/access.ts` 收口） */
function liveSessionPaths(ctx: unknown): string[] {
  const out: string[] = []
  try {
    for (const s of hostSessions(ctx)?.list?.() ?? []) {
      const cwd = s?.header?.cwd
      if (typeof cwd === 'string') out.push(cwd)
    }
  } catch {
    /* 遍历失败忽略 */
  }
  return out
}

/**
 * 列出本机已知的 CCC 根（**L2 的唯一权威列举器**）。
 *
 * 三层来源**各自都跑、结果取并集**（来源顺序 `workspaceRegistry → sessionPersistence → live`，
 * 按 root 去重**保留首次出现**）。`defaultRoot` 若不在结果里则 unshift 到首位。
 *
 * ⚠️ **为什么是并集而不是短路**（C2 修正的核心，现状稿 §2.B E1 + §2.D 第 4 条）：
 * 旧实现是 `if (roots.length === 0)` 三层门控 ⇒ 只要工作区注册表里有**任意一条**，
 * 就永远不看 `sessionPersistence`/live；注册表里有一个 CCC 而另一 CCC 只存在于历史会话时，
 * **整个列表都不含后者**（"名单不全"）。并集修正它，且**不改**任何消费方的输入契约。
 *
 * @param ctx 插件上下文
 * @param opts.defaultRoot 默认根（不在列表 → 置首）；opts.withRoles 是否读 `skiff.roles`
 * @returns 按上述顺序去重的 CCC 条目（无任何来源 → 空数组 + 可选默认根）
 */
export async function listCccs(ctx: unknown, opts: ListCccsOptions = {}): Promise<CccEntry[]> {
  const c = makeCollector()
  // 三层**依次**跑（保序），但**不做短路**：每层都执行，贡献自己的候选
  for (const path of workspaceRegistryPaths(ctx)) c.push(path)
  for (const path of await sessionPersistencePaths(ctx)) c.push(path)
  for (const path of liveSessionPaths(ctx)) c.push(path)

  const defaultRoot = opts.defaultRoot
  if (typeof defaultRoot === 'string' && defaultRoot !== '' && !c.roots.includes(defaultRoot)) {
    c.roots.unshift(defaultRoot)
  }

  // 角色**按需**读取：`withRoles` 缺省 false ⇒ 一个 serenity.json 都不读。
  // ⚠️ 动态 import：`skiff-role.ts` 不是静态依赖（本模块要能在没有 skiff 链的
  // 场景里被静态引用——如唤醒调度器；只有真要角色时才加载）。
  let rolesOf: ((root: string) => string[]) | null = null
  if (opts.withRoles === true) {
    const { readSkiffRoles } = await import('./skiff-role.js')
    rolesOf = (root: string) => [...readSkiffRoles(root).keys()]
  }

  return c.roots.map((root) => ({
    root,
    name: basename(root) || root,
    roles: rolesOf ? rolesOf(root) : [],
  }))
}
