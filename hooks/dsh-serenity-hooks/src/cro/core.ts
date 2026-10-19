/**
 * cro/core.ts — CRO（Continuous Re-Occurrence · 持续再发生）机制层（S142 §7.8，2026-09-19）
 *
 * ## 这东西用来干什么（白话）
 *
 * 今天叫醒一条轨迹的方式是「几点几分叫我」。但**该不该醒，往往不是时间说了算**：
 * 比如 S185 应该「天亮 + 家里有人 + 非高峰」才醒；已经在干活就不该再叫；
 * 日志太大了，下次叫它时该让它先整理。
 *
 * CRO 让**一条轨迹自己带一段程序**，由 ACC 在每次检查时跑它，
 * **由这段程序决定「现在该不该叫我、叫我的时候说什么」**。
 *
 * ## 归属（所有者 2026-09-19 定：**机制属 ACC，CCC 是用户**）
 *
 * | 面 | 归谁 | 内容 |
 * |---|---|---|
 * | **机制** | 🔴 **ACC（本模块）** | 契约 / 调度 / 执行 / 状态暴露 / 容错 |
 * | **程序** | 🔴 **CCC（用户）** | 那段判定的 TS 代码，放**轨迹自己的目录**里 |
 *
 * ⇒ 与 `send-later` 同构：**工具在 ACC，用它在 CCC**。
 *
 * ## 命名（防混淆，写死）
 *
 * **`CRO` = 那段程序**（实体名），**不是** ACC 标准 §0.1 三环节（发生/存储/**再发生**）的第三环本身。
 * 命名来源 = §0.3「**Trajectory 在寻找 Agent**」——CRO 是「再发生」这一环的自动化。
 *
 * ## 位置与形态（设计 §2）
 *
 * `<CCC 根>/AGENT_SESSIONS/<轨迹目录>/continuous-re-occurrence.ts`
 * · **文件名全写**（所有者令）；· **程序只有一个**：**文件在 = 启用，不在 = 禁用**（无 enabled 字段、无注册表）。
 *
 * ## 🔴 运行契约 = B 案（**ACC 只 spawn，从不 import**）
 *
 * 所有者 2026-09-19：「**B 是设计，A 只是文档友好**」。
 * 若 ACC **import** 那段 TS，会出现两件事：
 *   ① ACC 依赖 CCC 的**源码路径**（npm 装机版在别处 ⇒ 两条路径都要活 = 两个真相源）；
 *   ② **用户程序语法错会让 ACC 启动失败** ⇒ **一个用户程序的错误放倒整个容器**。
 * ⇒ 进程边界把这两件事同时挡掉：**路径只需一个（文件系统），错误被隔离在子进程里**。
 *
 * ## 🔴 铁律：CRO 的任何失败，绝不影响既有机制（设计 §5）
 *
 * `send-later` / `send-now` / 唤醒表的投递**照常工作**。
 * 先例 = `im/hook.ts` 的**旁路容忍**（"超时 kill / 非 0 退出 / spawn 失败 → 仅日志返回，绝不抛"）。
 * ⇒ 本模块的**每一个**导出函数**都不抛错**（返回结构化失败）。
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { resolveInside } from '../kernel/ccc.js'
import { sessionsRoot } from '../trajectory/core.js'
import { isoLocal } from '../kernel/time.js'

/** 入口文件名（**全写**，所有者令 2026-09-19；不改缩写） */
export const CRO_FILENAME = 'continuous-re-occurrence.ts'

/**
 * 机器绑定文件名（**全写**，与 `CRO_FILENAME` 同风格）。
 *
 * 🔴 **它随 CCC git 走是设计意图，不是缺陷**：
 * 绑定声明必须跟着**轨迹**走，才能在第二台机器上被读到、并被判为"不是我的"。
 * （这正是机器绑定的整个目的 —— 见 `resolveCroHostBinding` 的头注。）
 */
export const CRO_HOST_FILENAME = 'cro-host-binding'

/** 硬超时（沿用 `biasProvider` 先例的 60s；设计 §5 情形 2） */
export const CRO_TIMEOUT_MS = 60_000

/** stdout 上限（防一个坏程序把日志撑爆；沿用 hook 截断思路） */
const CRO_STDOUT_MAX = 64 * 1024

/** 绑定文件体积上限（它只是个机器名 ⇒ 超过这个数一定是写错了，不读） */
const CRO_HOST_FILE_MAX = 1_024

/** SESSION.md 文件名（与 `trajectory/core.ts` 同值；此处本地常量避免反向依赖） */
const SESSION_MD = 'SESSION.md'

// ── 输入快照（设计 §3）──

/**
 * 轨迹状态快照 —— ACC 把它**能看到的全部**序列化后喂给程序（所有者令：「信息尽可能多」）。
 *
 * ⚠️ **边界（诚实标注）**：给满的是**「快照」**，不是「无限能力」——
 * ACC **看不见**的东西（程序自己上次判了什么）**物理上给不了**（那是另一个进程的内存）。
 * ⇒ 那类状态**归程序自己**（可在自己轨迹目录里写状态文件）。
 */
export interface CroSnapshot {
  /** 快照格式版本（程序据此判兼容；未来加字段时递增） */
  version: number
  /** 身份 */
  identity: {
    /** 🔴 硬锚：完整目录名（不解析编号格式，§0I U4） */
    dirName: string
    /** 展示码（如 `S185`）——**派生**，不作识别依据 */
    code: string
    /** CCC 根（绝对路径） */
    cccRoot: string
  }
  /** 时间（当地时区呈现，遵 D67） */
  time: {
    /** 当前时刻 — ISO（当地时区） */
    now: string
    /** 当前 epoch 毫秒 */
    nowMs: number
    /** 本地人读时刻 */
    nowLocal: string
  }
  /** 轨迹身体（SESSION.md 及其目录） */
  body: {
    sessionMdPath: string
    sessionMdBytes: number | null
    sessionMdMtime: string | null
    /** `references/` 目录清单（名 + 体积 + mtime）；不存在 ⇒ 空数组 */
    references: Array<{ name: string; bytes: number; mtime: string }>
  }
  /** 绑定与载体 */
  binding: {
    /** 绑定该轨迹的载体会话 id（按绑定时间倒序） */
    boundSessionIds: string[]
    /** 其中**当前 live** 的 */
    liveSessionIds: string[]
    /**
     * 🔴 其中**正在跑轮次**的（设计 §3.2 —— 本机制**唯一需要 ACC 新增的状态**）。
     * ⚠️ `live ≠ 在跑`：一条会话可以 live 而空闲。
     * 宿主没有现成的 turn 运行标志 ⇒ 由 `cro/turns.ts` 用 `agent/session-start` +
     * `agent/turn-stopping` 两个**既有契约事件**夹出来。
     */
    runningSessionIds: string[]
  }
  /** 调度面 */
  scheduling: {
    /** 本轨迹在办的唤醒条目（`wake-registry` 中 state=pending 且 target 命中本轨迹） */
    pendingWakes: Array<{ id: string; at: string; createdAt: string; createdBy: string }>
    /** 调度器状态（armed / 全局闸 / tick 次数 / 上次跳过原因） */
    scheduler: {
      armed: boolean
      enabled: boolean
      ticks: number
      lastSkipReason: string | null
    }
  }
}

/** 快照装配的输入（**纯数据** ⇒ `buildCroSnapshot` 可穷举测试，无需 fs） */
export interface CroSnapshotInput {
  dirName: string
  cccRoot: string
  nowMs: number
  sessionMdPath: string
  sessionMdBytes: number | null
  sessionMdMtimeMs: number | null
  references: Array<{ name: string; bytes: number; mtimeMs: number }>
  boundSessionIds: string[]
  liveSessionIds: string[]
  runningSessionIds: string[]
  pendingWakes: Array<{ id: string; at: string; createdAt: string; createdBy: string }>
  scheduler: { armed: boolean; enabled: boolean; ticks: number; lastSkipReason: string | null }
}

/**
 * 展示码派生（**只用于展示**，不作识别依据 —— §0I U4：锚永远是 `dirName`）。
 *
 * 判据（设计 §1）：**编号不是固定格式，不同 CCC 格式不同**（本容器 `S###`，别处可能是 issue 号
 * 或自定义前缀）⇒ 这里只做**尽力而为的展示性提取**，取不到就返回空串。
 * 🔴 **绝不**因为取不到就拒绝服务——`dirName` 才是硬锚。
 * @param dirName 轨迹目录名
 * @returns `S###` 形态的展示码；取不到 ⇒ `''`
 */
export function deriveCode(dirName: string): string {
  const m = /(?:^|--)S(\d{2,})(?:--|$)/.exec(dirName)
  return m ? `S${m[1]}` : ''
}

/** epoch ms → 当地 ISO（不可解析 ⇒ null） */
function isoOrNull(ms: number | null): string | null {
  return typeof ms === 'number' && Number.isFinite(ms) ? isoLocal(ms) : null
}

/**
 * 装配快照（**纯函数**：只做数据整形，不读 fs、不看 ctx）⇒ 可穷举测试。
 * @param input 已读好的原始数据
 * @returns 喂给 CRO 程序的快照
 */
export function buildCroSnapshot(input: CroSnapshotInput): CroSnapshot {
  return {
    version: 1,
    identity: { dirName: input.dirName, code: deriveCode(input.dirName), cccRoot: input.cccRoot },
    time: { now: isoLocal(input.nowMs), nowMs: input.nowMs, nowLocal: new Date(input.nowMs).toString() },
    body: {
      sessionMdPath: input.sessionMdPath,
      sessionMdBytes: input.sessionMdBytes,
      sessionMdMtime: isoOrNull(input.sessionMdMtimeMs),
      references: input.references.map((r) => ({ name: r.name, bytes: r.bytes, mtime: isoLocal(r.mtimeMs) })),
    },
    binding: {
      boundSessionIds: input.boundSessionIds,
      liveSessionIds: input.liveSessionIds,
      runningSessionIds: input.runningSessionIds,
    },
    scheduling: { pendingWakes: input.pendingWakes, scheduler: input.scheduler },
  }
}

// ── 输出（设计 §4）──

/** CRO 程序输出的决策 */
export interface CroDecision {
  /** 🔴 是否唤起 */
  wake: boolean
  /** 🔴 唤起时的提示词（`wake=true` 时必填、非空） */
  prompt: string | null
  /** 可选：判定理由（进日志，供事后重建 —— 设计 §4.2） */
  reason: string | null
}

/** 解析结果（**不抛错**） */
export type CroParseResult = { ok: true; decision: CroDecision } | { ok: false; error: string; detail?: string }

/**
 * 解析 CRO 程序 stdout（**纯函数** ⇒ 可穷举测试）。
 *
 * ## 边界（设计 §4.1）
 * · `wake` 缺省 / `false` ⇒ **不唤起**（**这是常态**）——`prompt` 可省；
 * · `wake: true` 但 `prompt` 空 / 非串 ⇒ 🔴 **非法** ⇒ 返回错误（调用方**跳过本轮**，不投递空消息）；
 * · 非 JSON / 非对象 ⇒ 错误。
 *
 * ## 🔴 为什么 `reason` 重要（CCE：重建 > 保存）
 * 改成程序判定后，**「当时为什么叫了」不再能从时间表重建**（原因在程序肚子里：
 * 可能有随机、可能看了外部数据）⇒ 要求程序自报理由，把「决策依据」重新变成**可重建的**。
 * ⇒ **强烈建议但不强制**（强制会让简单程序难写；设计 §9-6 待裁，本版取"建议"）。
 *
 * @param stdout 程序标准输出（可含前后空白；允许多行 JSON 文本）
 * @returns 决策 或 结构化错误
 */
export function parseCroOutput(stdout: string): CroParseResult {
  const text = stdout.trim()
  if (text === '') return { ok: false, error: 'cro-empty-output', detail: '程序没有输出（期望 stdout 一行 JSON）' }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return { ok: false, error: 'cro-bad-json', detail: `输出不是合法 JSON: ${String((err as Error)?.message ?? err)}` }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'cro-bad-json', detail: '输出必须是 JSON 对象' }
  }
  const obj = raw as Record<string, unknown>
  const wake = obj.wake === true
  const reason = typeof obj.reason === 'string' && obj.reason.trim() !== '' ? obj.reason.trim() : null
  if (!wake) return { ok: true, decision: { wake: false, prompt: null, reason } }
  // wake === true ⇒ prompt 必须是非空串（否则不投递空消息）
  if (typeof obj.prompt !== 'string' || obj.prompt.trim() === '') {
    return { ok: false, error: 'cro-missing-prompt', detail: 'wake=true 但 prompt 缺失或为空' }
  }
  return { ok: true, decision: { wake: true, prompt: obj.prompt.trim(), reason } }
}

// ── 执行（设计 §2.2/§5）──

/** 单次执行结果（**永不抛**） */
export interface CroRunResult {
  ok: boolean
  /** 程序 stdout（已截断）；失败时可能为部分输出 */
  stdout: string
  /** 失败原因（人读；成功 ⇒ null） */
  error: string | null
  /** 失败分类（稳定码，供日志/测试断言） */
  code?: string
}

/** runner 签名（**可注入** —— 测试捕获防真实 spawn flake；同 `im/hook.ts` 手法） */
export type CroRunner = (scriptAbs: string, stdinJson: string, timeoutMs: number) => Promise<CroRunResult>

/**
 * CRO 程序路径：`<CCC 根>/AGENT_SESSIONS/<dirName>/continuous-re-occurrence.ts`。
 *
 * ⚠️ 路径逃逸校验（`resolveInside`）：`dirName` 来自配置/工具入参，
 * 必须确保解析后仍在 CCC 根内（同 `im/hook.ts:160` 手法）。**抛错由调用方吞**。
 * @param root CCC 根
 * @param dirName 轨迹目录名
 * @returns 绝对路径
 */
export function croScriptPath(root: string, dirName: string): string {
  return resolveInside(root, join('AGENT_SESSIONS', dirName, CRO_FILENAME))
}

/** CRO 是否启用（**判据 = 文件在不在**；设计 §2.1：无 enabled 字段、无注册表） */
export function isCroEnabled(root: string, dirName: string): boolean {
  try {
    return existsSync(croScriptPath(root, dirName))
  } catch {
    return false // 路径逃逸 ⇒ 视为未启用（不抛）
  }
}

/**
 * 机器绑定判定结果（**永不抛**）。
 *
 * 三态而非布尔：**「没绑」与「绑给别人」必须分得开**（见下"为什么三态"）。
 */
export interface CroHostVerdict {
  /** 这台机器可以跑吗（唯一决定投递与否的字段） */
  allowed: boolean
  /** 绑定文件里写的机器名（未绑/读不到 ⇒ `null`） */
  bound: string | null
  /** 本机机器名 */
  self: string
  /**
   * 机器可读的判定原因（稳定码，供测试与日志断言）。
   * · `bound-to-self` —— 已绑且是本机 ⇒ 跑
   * · `not-bound` —— **没有绑定文件**（或文件是空的）⇒ **不跑**（fail-closed）
   * · `bound-to-other` —— 绑给了别的机器 ⇒ 不跑
   * · `read-error` —— 文件在但读不了 ⇒ 不跑（fail-closed）
   */
  code: 'bound-to-self' | 'not-bound' | 'bound-to-other' | 'read-error'
  /** 人读说明（进 tick 日志） */
  detail: string
}

/**
 * 解析机器绑定 —— 「**这条轨迹由哪台机器负责自唤醒**」（所有者令 2026-10-15）。
 *
 * ## 所有者裁定的语义（逐字，D135）
 *
 * 「**CRO 必须指定绑定机器，否则不运行，唤醒器 检查这个**」⇒ 三条同时成立：
 * ① **只许这一台**（白名单，不是"排除这一台"）；
 * ② **fail-closed** —— **没绑 = 不跑**（不是"没绑 = 随便跑"）；
 * ③ **检查者在唤醒器**（本函数由 `runCroPhase` 调用，不是程序自己判）。
 *
 * ## 绑定键 = 机器名（所有者 2026-10-15 裁「用 hostname 吧，比较合理」）
 *
 * ⚠️ **已接受的取舍**：本机机器名是 QEMU 机型派生的默认形
 * （`yh-Standard-PC-Q35-ICH9-2009`）⇒ 同法新建的同名用户 VM 会取到同一个名字。
 * 所有者 2026-10-15 明确「**不改名，家里就这几台机器没必要**」⇒ **风险由所有者接受**。
 *
 * ## 🔴 为什么必须是三态，「没绑」不能并进「绑给别人」
 *
 * 2026-10-15 已发生过**同族事故**：`send-now` 失败时报的是「无绑定会话记录」，
 * 而真因是"那条轨迹不可寻址"—— **文案相同、原因不同**，害得排查方向错了一次
 * （S142 §日志 续 129 / D134）。
 * ⇒ 绑定这一层**不许再造同样的坑**：「你没绑」与「你绑给了别人」是**两件不同的事**，
 *   日志必须分开写 —— 否则将来"为什么这条轨迹不跑了"会又一次指错方向。
 *
 * ## 文件形态（刻意的极简）
 *
 * · 位置 = `<轨迹目录>/cro-host-binding`（与 CRO 程序**同级**）
 * · 内容 = **一行机器名**（首尾空白裁掉；只取第一行有效内容）
 * · 不用 JSON —— 它只有一个值，JSON 只会多一种写错的方式
 * · 支持 `#` 注释行与空行（方便人写、方便留痕）
 *
 * 🔴 **它必须随 git 入库**（不是"运行态"）：绑定声明要**跟着轨迹走到第二台机器**，
 *   在那里被判成「绑给了别人」而**正确地不跑** —— 那就是本机制在工作。
 *   ⇒ ⛔ **不要把它加进 `.gitignore`**（那会让第二台机器读到"没绑"而同样不跑，
 *   表面上结果一样，但**判据从"明确绑给别人"退化成"什么都没说"**，失去可诊断性）。
 *
 * ## 为什么读文件而不是读快照字段
 *
 * 快照（`CroSnapshot`）是喂给**程序**的；而本判定发生在**程序被 spawn 之前**
 * —— 程序还没跑，没有快照可读。⇒ 只能读文件。（这也是"机制属 ACC"的体现：
 * ACC 在调用用户程序前先判定自己该不该调用。）
 *
 * @param root CCC 根
 * @param dirName 轨迹目录名
 * @param selfHost 本机机器名（**注入** ⇒ 可测；生产调用方传 `hostname()`）
 * @returns 判定结果（**永不抛** —— 旁路容忍铁律）
 */
export function resolveCroHostBinding(root: string, dirName: string, selfHost: string): CroHostVerdict {
  const self = String(selfHost ?? '').trim()
  let fileAbs: string
  try {
    fileAbs = resolveInside(root, join('AGENT_SESSIONS', dirName, CRO_HOST_FILENAME))
  } catch (err) {
    // 路径逃逸 ⇒ 视为"没绑"（不跑）。**不抛**：本函数跑在 tick 内。
    return {
      allowed: false,
      bound: null,
      self,
      code: 'read-error',
      detail: `绑定文件路径非法（已忽略）：${String((err as Error)?.message ?? err)}`,
    }
  }

  let raw: string
  try {
    if (!existsSync(fileAbs)) {
      return {
        allowed: false,
        bound: null,
        self,
        code: 'not-bound',
        detail: `未绑定机器（缺 ${CRO_HOST_FILENAME}）⇒ 按"必须指定"不运行`,
      }
    }
    const st = statSync(fileAbs)
    if (st.size > CRO_HOST_FILE_MAX) {
      return {
        allowed: false,
        bound: null,
        self,
        code: 'read-error',
        detail: `绑定文件过大（${st.size} B > ${CRO_HOST_FILE_MAX} B）⇒ 判为写错，不运行`,
      }
    }
    raw = readFileSync(fileAbs, 'utf-8')
  } catch (err) {
    return {
      allowed: false,
      bound: null,
      self,
      code: 'read-error',
      detail: `绑定文件读取失败 ⇒ 不运行：${String((err as Error)?.message ?? err)}`,
    }
  }

  const bound = parseCroHostBinding(raw)
  if (bound === null) {
    return {
      allowed: false,
      bound: null,
      self,
      code: 'not-bound',
      detail: `绑定文件为空（只有注释/空行）⇒ 按"必须指定"不运行`,
    }
  }
  if (bound === self) {
    return { allowed: true, bound, self, code: 'bound-to-self', detail: `已绑定本机（${bound}）` }
  }
  return {
    allowed: false,
    bound,
    self,
    code: 'bound-to-other',
    detail: `绑定给别的机器（绑定=${bound}，本机=${self}）⇒ 本机不运行`,
  }
}

/**
 * 解析绑定文件正文 ⇒ 机器名（取不到 ⇒ `null`）。
 *
 * 规则（刻意宽松：**只认一行，其余都当注释**）：
 * · 逐行扫；跳过空行与 `#` 开头的行；
 * · **第一条有效行** = 机器名（裁首尾空白）；
 * · 无有效行 ⇒ `null`。
 * @param raw 文件正文
 * @returns 机器名；无有效内容 ⇒ `null`
 */
export function parseCroHostBinding(raw: string): string | null {
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const t = line.trim()
    if (t === '' || t.startsWith('#')) continue
    return t
  }
  return null
}

/**
 * 列出**启用了 CRO 的轨迹目录名**（供调度器每 tick 扫描，设计 §6.1）。
 *
 * ## 判据与形态（R↓）
 * · 判据 = **文件在不在**（同 §2.1）——**没有注册表**，所以"谁启用了"只能靠**扫目录**：
 *   `AGENT_SESSIONS/` 下每个目录查一次 `<目录>/continuous-re-occurrence.ts`。
 * · **一次 readdir + 每个目录一次 existsSync**：N 条轨迹的代价是 O(N) 次 `stat`，
 *   每 5min 一次 —— 与既有 `listSessions` 同量级，可接受。
 * · 跳过 **`_` 前缀**（`_archived` / `_轨迹约束-logs` / `_weixin-logs` = 系统与日志目录）
 *   与 **`.` 前缀**（隐藏）——它们**不是轨迹**，且扫它们纯属浪费。
 * · 🔴 **本函数绝不抛错**（返回 `[]`）——它跑在调度器 tick 内，任何异常都可能影响既有链路
 *   （设计 §5 铁律）。目录读不到（不存在 / 权限）⇒ `[]` = "没有轨迹启用 CRO"，语义正确。
 *
 * ⚠️ **为什么不做缓存**：缓存会引入"文件删了但缓存还在"的失效模式（本容器栽过的"第二真相源"），
 * 而这里省下的只是一次 `readdir`——**不值当**。
 *
 * @param root CCC 根
 * @returns 启用了 CRO 的轨迹目录名（**排序后**，保证同 tick 顺序稳定、便于日志比对）
 */
export function listCroCognitiveTrajectories(root: string): string[] {
  const rootDir = sessionsRoot(root)
  let entries: Dirent[]
  try {
    entries = readdirSync(rootDir, { withFileTypes: true })
  } catch {
    return [] // 目录不存在/读不到 ⇒ 没有轨迹启用 CRO（不抛）
  }
  const out: string[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (e.name.startsWith('_') || e.name.startsWith('.')) continue // 系统/隐藏目录不是轨迹
    try {
      if (existsSync(join(rootDir, e.name, CRO_FILENAME))) out.push(e.name)
    } catch {
      /* 单条读不到 ⇒ 跳过该条，不影响其余（不抛） */
    }
  }
  return out.sort()
}

/**
 * 执行一次 CRO 程序（**永不抛** —— 旁路容忍铁律）。
 *
 * runner 顺序（照 `im/hook.ts:171-174` 的 bun 优先 / node 兜底）：
 * `bun` → `process.execPath`（同运行时）。
 * 判据：`ENOENT`（二进制不存在）⇒ 试下一个；**其余失败视为最终结果**
 * （程序自己报错就是报错，不该用另一个 runner 掩盖——与 hook 一致）。
 * @param scriptAbs 程序绝对路径
 * @param stdinJson 喂给程序的快照 JSON
 * @param timeoutMs 硬超时
 * @returns 执行结果（含输出的解析交由 `parseCroOutput`）
 */
export async function runCroProcess(
  scriptAbs: string,
  stdinJson: string,
  timeoutMs: number = CRO_TIMEOUT_MS,
): Promise<CroRunResult> {
  const runners: Array<[string, string[]]> = [
    ['bun', [scriptAbs]],
    [process.execPath, [scriptAbs]],
  ]
  for (const [cmd, args] of runners) {
    const res = await runCroOnce(cmd, args, stdinJson, timeoutMs)
    if (!res.ok && res.code === 'ENOENT') continue // 该 runner 不存在 ⇒ 试下一个
    return res
  }
  return { ok: false, stdout: '', error: 'CRO 执行失败（bun 与 node 均不可用）', code: 'cro-no-runner' }
}

/** 单次 spawn（Promise 化 + 超时 kill + 输出截断 + **绝不抛**） */
function runCroOnce(cmd: string, args: string[], stdinJson: string, timeoutMs: number): Promise<CroRunResult> {
  return new Promise((resolvePromise) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    let child: ReturnType<typeof spawn> | null = null
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } })
    } catch (err) {
      return resolvePromise({ ok: false, stdout: '', error: String(err), code: 'SPAWN_ERR' })
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child?.kill('SIGKILL')
      resolvePromise({
        ok: false,
        stdout,
        error: `CRO 执行超时（>${Math.round(timeoutMs / 1000)}s，已 kill）`,
        code: 'cro-timeout',
      })
    }, timeoutMs)

    child.stdin?.on('error', () => {
      /* stdin 关闭竞态忽略（程序可能不读 stdin 就退出） */
    })
    try {
      child.stdin?.write(stdinJson)
      child.stdin?.end()
    } catch {
      /* 忽略：程序提前退出 */
    }
    child.stdout?.on('data', (d: Buffer) => {
      stdout = (stdout + d.toString()).slice(0, CRO_STDOUT_MAX)
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(0, CRO_STDOUT_MAX)
    })
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ ok: false, stdout, error: String(err.message ?? err), code: err.code })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) {
        resolvePromise({ ok: true, stdout, error: null })
      } else {
        // 🔴 半成品 / 语法错 / 运行期抛错都落这里 ⇒ **报错即可**（所有者令：
        //    「文件是半成品报错就好了，这么简单的事情，不需要想」）
        const detail = stderr.trim().split('\n')[0] ?? ''
        resolvePromise({
          ok: false,
          stdout,
          error: `CRO 程序退出码 ${code}${detail ? `：${detail}` : ''}`,
          code: 'cro-exit-nonzero',
        })
      }
    })
  })
}

// ── 快照读取（fs 侧；与装配分离，便于测试）──

/** 读目录清单（不存在/读失败 ⇒ 空数组；**不回退抛错**） */
function readDirEntries(dir: string): Array<{ name: string; bytes: number; mtimeMs: number }> {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        const p = join(dir, e.name)
        try {
          const st = statSync(p)
          return { name: e.name, bytes: st.size, mtimeMs: st.mtimeMs }
        } catch {
          return null
        }
      })
      .filter((x): x is { name: string; bytes: number; mtimeMs: number } => x !== null)
  } catch {
    return []
  }
}

/** 读 SESSION.md 体积与 mtime（不存在/读失败 ⇒ null） */
function readMdStat(mdPath: string): { bytes: number | null; mtimeMs: number | null } {
  try {
    const st = statSync(mdPath)
    return { bytes: st.size, mtimeMs: st.mtimeMs }
  } catch {
    return { bytes: null, mtimeMs: null }
  }
}


/** 读取快照所需的 fs 侧数据（**纯读取，不抛**） */
export function readCroSnapshotInput(
  root: string,
  dirName: string,
  nowMs: number,
  extras: {
    liveSessionIds: string[]
    runningSessionIds: string[]
    boundSessionIds: string[]
    pendingWakes: CroSnapshot['scheduling']['pendingWakes']
    scheduler: CroSnapshot['scheduling']['scheduler']
  },
): CroSnapshotInput {
  const dir = join(sessionsRoot(root), dirName)
  const mdPath = join(dir, SESSION_MD)
  const md = readMdStat(mdPath)
  return {
    dirName,
    cccRoot: root,
    nowMs,
    sessionMdPath: mdPath,
    sessionMdBytes: md.bytes,
    sessionMdMtimeMs: md.mtimeMs,
    references: readDirEntries(join(dir, 'references')),
    boundSessionIds: extras.boundSessionIds,
    liveSessionIds: extras.liveSessionIds,
    runningSessionIds: extras.runningSessionIds,
    pendingWakes: extras.pendingWakes,
    scheduler: extras.scheduler,
  }
}

// ── 编排（设计 §5/§6）──

/** 一次 CRO 评估的结果（四态，调用方按 status 分派） */
export type CroOutcome =
  | { status: 'disabled'; detail: string }
  | { status: 'skipped'; detail: string; code?: string }
  | { status: 'no-wake'; decision: CroDecision; detail: string }
  | { status: 'wake'; decision: CroDecision; prompt: string; detail: string }

/** 评估依赖（可注入 ⇒ 单测无需真实 spawn/fs） */
export interface CroDeps {
  runner?: CroRunner
  timeoutMs?: number
}

/**
 * 评估一条轨迹的 CRO 程序：**文件在 ⇒ 跑它；不在 ⇒ 未启用**（设计 §2.1）。
 *
 * 🔴 **本函数永不抛错**（旁路容忍铁律）：任何失败都返回 `{status:'skipped'}`，
 * 调用方据此**跳过本轮**、**不影响既有投递链路**。
 *
 * @param root CCC 根
 * @param dirName 轨迹目录名
 * @param snapshotInput 已读好的快照输入
 * @param deps 可注入依赖（测试用）
 * @returns 四态结果
 */
export async function evaluateCro(
  root: string,
  dirName: string,
  snapshotInput: CroSnapshotInput,
  deps: CroDeps = {},
): Promise<CroOutcome> {
  let scriptAbs: string
  try {
    scriptAbs = croScriptPath(root, dirName)
  } catch (err) {
    // 路径逃逸 ⇒ 视为未启用（不抛；响亮日志）
    return { status: 'disabled', detail: `CRO 路径非法（须在 CCC 根内）：${String((err as Error)?.message ?? err)}` }
  }
  if (!existsSync(scriptAbs)) {
    return { status: 'disabled', detail: `未启用（无 ${CRO_FILENAME}）` }
  }
  const snapshot = buildCroSnapshot(snapshotInput)
  let stdinJson: string
  try {
    stdinJson = JSON.stringify(snapshot)
  } catch (err) {
    return { status: 'skipped', detail: `快照序列化失败：${String((err as Error)?.message ?? err)}`, code: 'cro-snapshot' }
  }
  const runner = deps.runner ?? runCroProcess
  const run = await runner(scriptAbs, stdinJson, deps.timeoutMs ?? CRO_TIMEOUT_MS)
  if (!run.ok) {
    return { status: 'skipped', detail: run.error ?? 'CRO 执行失败', ...(run.code ? { code: run.code } : {}) }
  }
  const parsed = parseCroOutput(run.stdout)
  if (!parsed.ok) {
    return { status: 'skipped', detail: parsed.detail ?? parsed.error, code: parsed.error }
  }
  const decision = parsed.decision
  if (!decision.wake) {
    return { status: 'no-wake', decision, detail: decision.reason ?? '程序判定：不唤起' }
  }
  return {
    status: 'wake',
    decision,
    prompt: decision.prompt as string,
    detail: decision.reason ?? '程序判定：唤起',
  }
}

/** 人读一行（日志用；`evaluateCro` 结果的稳定摘要） */
export function renderCroOutcome(dirName: string, outcome: CroOutcome): string {
  switch (outcome.status) {
    case 'disabled':
      return `${dirName}: CRO ${outcome.detail}`
    case 'skipped':
      return `${dirName}: CRO 跳过本轮（${outcome.detail}）`
    case 'no-wake':
      return `${dirName}: CRO 不唤起（${outcome.detail}）`
    case 'wake':
      return `${dirName}: CRO 唤起（${outcome.detail}）`
  }
}
