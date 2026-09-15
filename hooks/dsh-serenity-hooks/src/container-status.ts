/**
 * container-status.ts — 容器状态模型的**取数层唯一出口**（C5「观察面归一」，S142 2026-09-15）
 *
 * 为什么存在（R↓）：ACC 有多个观察面（`dashboard health` / `acc-diag` / WebUI 面板 /
 * 系统提示词注入），它们读的是同一批宿主事实。此前"这些事实怎么取"写在**每个消费方各自的
 * 函数体里**——同一份状态有几个读者就有几处取数代码。本模块把取数收成一个出口，消费方只留
 * **渲染**（薄渲染）。
 *
 * 本模块**只做取数 + 形状**（设计红线）：
 *  - **文案/格式归渲染点**。本模块给判据与事实（`rooted: true` / `configPath: '.opencode/serenity.json'`），
 *    **不给**人读句子（"✓ .serenity marker found"）。同一份事实在 `dashboard health` 与 `acc-diag`
 *    里的措辞不同，正是因为它属渲染。
 *  - **不合并两条 registry 判据**（见 {@link checkRegistryHealth} / {@link checkRegistryQuality} 的对照注释）。
 *  - **时钟读进程内模块级快照**（{@link containerClocks}）——**不重算**：调度器的武装态/计数只存在于
 *    其模块级运行时对象里，任何"重新推导"得到的都是与真实调度器不一致的假值。
 *
 * 依赖分层（为什么本模块"重"而 `kit-ops` / `status` 保持"轻"）：
 *  {@link containerClocks} 必须读 `wake-scheduler` / `autopilot-trajectory` 的进程内快照，而这两个
 *  模块带 **@deepseek-ai 值依赖**（`dsh-llm` 的 `createUserMessage`）。故本模块**只能**被本就重型或
 *  异步的消费方使用：`diag-ops`（静态 import）、`api.ts` / `kit-ops`（`await import(...)`，与
 *  `api.ts` 既有的"保持静态链纯净"约定一致）。**轻链模块不得静态 import 本模块**。
 *
 * 已有的单一真相源继续指向原处（**不复制**）：
 *  L0 根解析 `ccc.ts findSerenityRoot`｜L1/L2 根与枚举 `ccc-roots.ts`｜宿主契约 `host/contract.ts`
 *  ｜CCC 配置 `ccc.ts loadSerenityConfig`｜注册表 `msm-ops.ts`｜时钟 `wake-scheduler.ts` /
 *  `autopilot-trajectory.ts`｜唤醒注册表 `wake-registry.ts`。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  DEFAULT_SERENITY_CONFIG_PATHS,
  findGitRoot,
  loadSerenityConfig,
  pathInside,
  readCccName,
} from './ccc.js'
import { ACC_VERSION } from './constants.js'
import { readDshVersion } from './status.js'
import { hostContractReport, type HostContractReport } from './host/contract.js'
import { checkRegistryQuality, type RegistryQualityReport } from './msm-ops.js'
import { listWakes, type WakeEntry } from './wake-registry.js'
import { autopilotClockState, getAutopilotStatus } from './autopilot-trajectory.js'
import { wakeSchedulerState } from './wake-scheduler.js'
import type { JsonValue } from './json.js'

// ── 分组 1：身份 / 版本 ──

export interface ContainerIdentity {
  /** CCC 根（调用方给定；null = 不在任何 CCC 内） */
  root: string | null
  /** CCC 名（`.serenity` 首行；无根或读不到 → null） */
  ccc: string | null
  /** ACC 插件版本 */
  accVersion: string
  /** 已安装 DSH CLI 版本（读不到 → null） */
  dshVersion: string | null
  /** node 版本（`process.version`） */
  nodeVersion: string
}

/** 身份/版本段取数（版本自省是磁盘/常量事实，与 CCC 内容无关） */
export function containerIdentity(root: string | null): ContainerIdentity {
  return {
    root,
    ccc: root ? readCccName(root) : null,
    accVersion: ACC_VERSION,
    dshVersion: readDshVersion(),
    nodeVersion: process.version,
  }
}

// ── 分组 2：CCC 三原则（判据 + 证据；无文案） ──

export interface ContainerPrinciples {
  /** P1：`.serenity` 存在且非空 */
  rooted: boolean
  /** P2：位于某个 git 仓库内 */
  gitManaged: boolean
  /** P2 的证据（git 根绝对路径；null = 不是 git 仓库） */
  gitRoot: string | null
  /** P3：命中的 DSH/opencode 配置路径（相对 CCC 根）；null = 全部未命中 */
  configPath: string | null
  /** 三项全过（health 的 healthy/degraded 判据之一） */
  allPass: boolean
}

/**
 * 三原则取数。
 * ⚠️ 与 `ccc.ts` 的 P1/P2 原语是**同一实现**（`existsSync(.serenity)` / `findGitRoot`），
 * 本函数只把它们组装成"一次检查"的形状；判定语义未变（P1 要求文件非空、P2 要求 `.git` 存在）。
 */
export function containerPrinciples(root: string | null): ContainerPrinciples {
  const serenityPath = root ? resolve(root, '.serenity') : null
  const rooted = serenityPath !== null && existsSync(serenityPath) && statSync(serenityPath).size > 0
  const gitRoot = root ? findGitRoot(root) : null
  const gitManaged = gitRoot !== null
  let configPath: string | null = null
  if (root) {
    for (const candidate of DEFAULT_SERENITY_CONFIG_PATHS) {
      if (existsSync(resolve(root, candidate))) {
        configPath = candidate
        break
      }
    }
  }
  return { rooted, gitManaged, gitRoot, configPath, allPass: rooted && gitManaged && configPath !== null }
}

// ── 分组 3：注册表 —— **两条各自命名的判据，不许合并** ──

export interface RegistryStructureReport {
  /** 聚合档路径（相对 CCC 根）；无 cccName → null */
  path: string | null
  ok: boolean
  /** 该注册表文件是否存在（不存在 = 未注册任何 MSM，非坏） */
  present: boolean
  issues: string[]
}

/**
 * **判据 A —— 注册表「结构完整性」**（原 `kit-ops.ts checkRegistryHealth`，C5 迁入本模块）。
 *
 * 回答的问题：**这张表坏没坏**——文件能不能被安全解析（JSON 合法 / 顶层形状 / entry 字段类型 /
 * name 全局唯一 / path 在根内且脚本存在）。
 *
 * 🔴 **为什么不与 {@link checkRegistryQuality} 合并**（设计红线，取证见
 * `acc-c4c5-current-state.md` §⑥ 与 §⑤ 观察面 4/5）：两条判据的**主语不同**——
 *  - A 的主语是**文件**："解析它会不会炸"。它**绝不**因为某个 entry 的脚本缺测试文件而报 issue；
 *  - B 的主语是**条目契约**："这条 entry 符合 MSM 的质量规约吗"（DC-M1~M4）。
 *
 * 因此**同一份注册表上两条判据可以给出相反结论**（例：结构完全合法，但没有一条 entry 达标；
 * 或条目全达标，而表里有同名重复 entry）。合并成一个 `ok` 会把"表坏了（要 git restore）"与
 * "表没坏但条目欠火候（去写测试）"两种**修复动作完全不同**的故障压成同一个信号。
 *
 * health 必须**不因坏表抛错**（注册表坏 → `loadMsmEntries` 抛 → `container_admin`/`output-guard`
 * 全崩且自锁无法自救），故本判据独立解析，不走 `loadMsmEntries`。
 */
export function checkRegistryHealth(root: string): RegistryStructureReport {
  const cccName = readCccName(root)
  if (!cccName) {
    // 无 cccName → 无法定位注册表：**既不算健康也不算坏**（无可检查对象）。
    // P3-④ review：旧实现 ok:true + issues 非空自相矛盾——统一为 issues 空 + ok:true
    // （path:null 本身已表达"无注册表可查"，不产生错误 issue）。
    return { path: null, ok: true, present: false, issues: [] }
  }
  const rel = `.opencode/skills/${cccName}/references/mech-registry.json`
  const abs = resolve(root, rel)
  if (!existsSync(abs)) {
    // 无注册表文件 = 空 CCC（未注册 MSM）——ok（不是坏）
    return { path: rel, ok: true, present: false, issues: [] }
  }
  const issues: string[] = []
  let raw = ''
  try {
    raw = readFileSync(abs, 'utf-8')
  } catch (err) {
    return { path: rel, ok: false, present: true, issues: [`registry unreadable: ${String((err as Error)?.message ?? err)}`] }
  }
  // 剥 BOM（Windows 编辑器 \uFEFF）
  let data: unknown
  try {
    data = JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch (err) {
    return {
      path: rel, ok: false, present: true,
      issues: [
        `registry JSON is broken: ${String((err as Error)?.message ?? err)}`,
        `Fix: restore from git — register/deregister auto-commits the registry (git checkout -- ${rel}; or git restore ${rel})`,
      ],
    }
  }
  const entries = Array.isArray(data) ? data : (data as { entries?: unknown })?.entries
  if (!Array.isArray(entries)) {
    return {
      path: rel, ok: false, present: true,
      issues: [
        'registry top-level is neither an array nor a v1 wrapper with entries[]',
        `Fix: restore from git (git checkout -- ${rel}; or git restore ${rel})`,
      ],
    }
  }
  const names = new Set<string>()
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as { name?: unknown; path?: unknown; skill?: unknown; category?: unknown }
    if (typeof e !== 'object' || e === null) {
      issues.push(`entry[${i}] is not an object`)
      continue
    }
    if (typeof e.name !== 'string' || e.name === '') issues.push(`entry[${i}]: name missing or not a string`)
    if (typeof e.path !== 'string' || e.path === '') issues.push(`entry[${i}] (${String(e.name ?? '?')}): path missing or not a string`)
    if (e.skill !== undefined && typeof e.skill !== 'string') issues.push(`entry[${i}] (${String(e.name ?? '?')}): skill not a string`)
    if (e.category !== undefined && typeof e.category !== 'string') issues.push(`entry[${i}] (${String(e.name ?? '?')}): category not a string`)
    if (typeof e.name === 'string' && e.name !== '') {
      if (names.has(e.name)) issues.push(`duplicate MSM name: "${e.name}" (entry[${i}]) — loadMsmEntries dedups by name, ambiguity`)
      names.add(e.name)
    }
    // path 引用完整（根内 + 脚本存在）——坏路径 = exec 会失败但注册表结构没坏；归为 issue
    if (typeof e.path === 'string' && e.path !== '') {
      const scriptAbs = resolve(root, e.path)
      // review P2-5：路径判断从 startsWith(root+'/') 改 pathInside（跨盘/平台安全——
      // Windows 全量误报 escape；pathInside 处理大小写 + 分隔符边界 + 跨盘）
      if (!pathInside(resolve(root), scriptAbs)) {
        issues.push(`entry[${i}] (${String(e.name ?? '?')}): path "${e.path}" escapes CCC root`)
      } else if (!existsSync(scriptAbs)) {
        issues.push(`entry[${i}] (${String(e.name ?? '?')}): script not found at "${e.path}"`)
      }
    }
  }
  return { path: rel, ok: issues.length === 0, present: true, issues }
}

/**
 * **判据 B —— 注册表「质量契约」**（DC-M1~M4；实现在 `msm-ops.ts checkRegistryQuality`，
 * 执行面 `container_admin msm check` 亦走它）。
 *
 * 与判据 A 的关系见 {@link checkRegistryHealth} 的对照注释——**两条判据、两个名字、两份结论**。
 * 本模块只做具名转出（取数出口唯一），不复制其判据实现。
 */
export { checkRegistryQuality, type RegistryQualityReport }

// ── 分组 4：进程内时间轴（时钟 / 唤醒注册表 / autopilot 目标）──

/**
 * 进程内时钟快照类型。
 * ⚠️ 两个时钟的形状由**各自模块**定义（`WakeSchedulerRuntime` / `AutopilotClockRuntime`，
 * 两者都未导出且 `autopilot` 少一个 `lastTickLog` 字段）——故此处取**联合**：它们对外暴露的
 * 诊断字段（armed / enabled / ticks / lastTickAt / armedAt / lastSkipReason）语义同规格，
 * 但类型上不是同一个。**不为了合并类型去改那两个模块的导出面**。
 */
export type ClockSnapshot = ReturnType<typeof wakeSchedulerState> | ReturnType<typeof autopilotClockState>

export interface ContainerClocks {
  /** 唤醒调度器（一次性唤醒，5min tick）——**模块级快照**，不重算 */
  wake: ClockSnapshot
  /** autopilot 时钟（周期自唤醒 tick）——**模块级快照**，不重算 */
  autopilot: ClockSnapshot
}

/**
 * 两条时钟的进程内状态（"为什么这轮没被唤起"的第一手判据）。
 *
 * 🔴 **只读快照，不重算**（设计红线）：`armed`/`ticks`/`lastTickAt`/`lastSkipReason` 只存在于
 * 调度器自己的模块级运行时对象里（`wake-scheduler.ts schedulerRuntime` /
 * `autopilot-trajectory.ts` 同规格对象）。任何"从配置或文件重新推导"得到的值都会与真实
 * 调度器的状态不一致——那比没有可观测量更糟（会给出假的"一切正常"）。
 */
export function containerClocks(): ContainerClocks {
  return { wake: wakeSchedulerState(), autopilot: autopilotClockState() }
}

export interface ContainerWakes {
  /** 注册表文件读取问题（读不到时非空——不得静默） */
  error: string | null
  /** 全量条目（原样，按 `at` 升序；**投影由各渲染点决定**——面板要 `message`，诊断不要） */
  entries: WakeEntry[]
  /** 在办（`state === 'pending'`）条目数 */
  pending: number
}

/** 唤醒注册表取数（文件 IO：每个渲染点自己决定是否要看它） */
export function containerWakes(root: string): ContainerWakes {
  const { entries, error } = listWakes(root)
  return { error, entries, pending: entries.filter((e) => e.state === 'pending').length }
}

/**
 * autopilot 目标状态取数（读 CCC 配置 + 目标 SESSION.md 的 mtime 探测）。
 * 与 WebUI 面板 / `acc-diag` 一致——两边渲染的是**同一份** `getAutopilotStatus()` 结果。
 * 类型从该函数的返回类型派生（`AutopilotTrajectoryStatus` 未从 `autopilot-trajectory.ts` 导出，
 * 此处不为了转出而改动那个模块的导出面）。
 */
export type AutopilotStatusSnapshot = ReturnType<typeof getAutopilotStatus>

/** @returns CCC 根缺失（null）→ null */
export function containerAutopilot(root: string | null): AutopilotStatusSnapshot | null {
  return root ? getAutopilotStatus(root) : null
}

// ── 组装：核心段 ──

export interface ContainerStatus {
  identity: ContainerIdentity
  principles: ContainerPrinciples
  /**
   * 注册表**两条判据**（各自命名、不许合并——见 `checkRegistryHealth` / `checkRegistryQuality`）。
   */
  registry: {
    /** 判据 A 结构完整性（**总是**算：health 的核心，成本 = 一次 JSON 解析） */
    structure: RegistryStructureReport
    /**
     * 判据 B 质量契约 DC-M1~M4（**默认不算**：要枚举 `skills/` 下脚本并逐个读源码查 main() 守卫，
     * 是唯一有实打实成本的段）——`withRegistryQuality: true` 才取。
     */
    quality: RegistryQualityReport | null
  }
  /** CCC 配置（`ccc.ts loadSerenityConfig`；无根 → null） */
  config: JsonValue | null
  /** 宿主契约（进程内唯一来源，见 `host/contract.ts hostContractReport`） */
  hostContract: HostContractReport | null
}

export interface ContainerStatusOptions {
  /** CCC 根；null = 不在任何 CCC 内（仍返回降级形状，不抛错） */
  root?: string | null
  /** CCC 配置候选路径（缺省 `DEFAULT_SERENITY_CONFIG_PATHS`） */
  configPaths?: string[]
  /** 是否取判据 B（注册表质量契约）；缺省 false */
  withRegistryQuality?: boolean
  /**
   * 宿主契约**兜底**捕获用的上下文：快照已存在（apply 时已捕获）时此参数被忽略，
   * 进程内**不会**发生第二次探针。缺省 undefined = 只要快照（拿不到就是 null）。
   */
  hostCtx?: unknown
}

/**
 * 核心段组装（`dashboard health` 的取数：身份 + 三原则 + 注册表两判据 + 配置 + 宿主契约）。
 *
 * 时间轴三段（时钟/唤醒注册表/autopilot 目标）**不在本组装内**：它们是各自独立消费方的需要
 * （`acc-diag` / `/serenity/trajectory`），硬塞进来会让只想看三原则的调用方付无谓的 IO。
 * 需要时按名字调 {@link containerClocks} / {@link containerWakes} / {@link containerAutopilot}。
 */
export function containerStatus(opts: ContainerStatusOptions = {}): ContainerStatus {
  const root = opts.root ?? null
  const configPaths = opts.configPaths ?? DEFAULT_SERENITY_CONFIG_PATHS
  const identity = containerIdentity(root)
  return {
    identity,
    principles: containerPrinciples(root),
    registry: {
      structure: root ? checkRegistryHealth(root) : { path: null, ok: true, present: false, issues: [] },
      quality: opts.withRegistryQuality === true && root ? checkRegistryQuality(root) : null,
    },
    config: root ? (loadSerenityConfig(root, configPaths) as unknown as JsonValue) : null,
    hostContract: opts.hostCtx !== undefined
      ? hostContractReport(opts.hostCtx, identity.dshVersion)
      : hostContractReport(),
  }
}
