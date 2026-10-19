/**
 * trajectory/prompt.ts — **轨迹提示词**（Trajectory Prompt）：一条轨迹"是谁、按什么章程工作"
 *
 * ## 概念（owner 2026-10-19 定向，逐字）
 *
 * > 「参考会话的系统提示词，我们建立**轨迹提示词**概念来代替人格。架构上会好很多」
 *
 * **轨迹提示词** = 一条认知轨迹的**可编辑章程声明**，由 ACC 按固定顺序装配进系统提示词。
 * 三个关键词各是一条判据：
 * - **可编辑**：住在 CCC（盘上），改它**不发版**（D23 归属判据的直接推论）
 * - **声明**：它声明**身份／章程／方法论**，**不声明能力**（能力面归 `skiff.json` 白名单与工具 schema）
 * - **固定顺序**：装配顺序由 ACC 定死（见 `seams/system-prompt.ts` 的 ⑧ 位）
 *
 * ## 为什么取代「人格」
 *
 * 「人格」把身份绑在"像不像一个人"上 ⇒ 因为叫人格，它被设计成**可以整体替换**
 * （`persona` 置换 EAP 块，即 review F-05/R-14 那个悬置冲突）。而身份与章程**不该被替换，
 * 只该被特化**。⇒ 本模块把"替换"改成"叠加"：容器层与质量层永远保留，轨迹提示词只往上加。
 *
 * ## 落点（为什么在轨迹目录里）
 *
 * `AGENT_SESSIONS/<轨迹目录>/PROMPT.md`
 *
 * - **跟着轨迹走**：`archive` 时整个目录搬走，章程不会掉队（旧形态 `.opencode/skiff/<name>.md`
 *   与轨迹**分居两处** —— 多条轨迹共用一份文件正是那个后果）。
 * - **每条轨迹都能有**：不只是 skiff。普通轨迹同样需要"我是谁、按什么章程"。
 * - 与 `SESSION.md`（身体：延续/日志）、`skiff.json`（约束面：能力）三件并列，
 *   各管一件事，不合并（合并会让"改能力"与"改身份"互相牵连）。
 *
 * ## 兼容（不静默坏）
 *
 * `PROMPT.md` 不存在时**不报错**（普通轨迹常态）。skiff 的旧字段 `systemPromptFile`
 * 在兼容期仍被读取——优先级见 {@link resolveTrajectoryPrompt}。
 */

import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readUtf8 } from '../kernel/ccc.js'
import type { SkiffProfile } from './policy/profile.js'
import { sessionsRoot } from './core.js'

/** 轨迹提示词的固定文件名（**判据就是它存在**——不是目录名前缀，也不是配置里的一行） */
export const TRAJECTORY_PROMPT_FILENAME = 'PROMPT.md'

/** 一次解析的结果（`source` 说明正文**从哪来**，便于诊断与「为什么我改的不生效」） */
export interface TrajectoryPromptResolution {
  /** 提示词正文（已 trim）；无来源 ⇒ 空串 */
  text: string
  /** 来源：轨迹目录的 PROMPT.md ／ skiff 旧字段 ／ 无 */
  source: 'trajectory-file' | 'skiff-legacy' | 'none'
  /** 实际读取的绝对路径（`none` ⇒ null） */
  path: string | null
}

const EMPTY: TrajectoryPromptResolution = { text: '', source: 'none', path: null }

/** 轨迹目录的 PROMPT.md 绝对路径（不论存在与否——调用方自己判存在性） */
export function trajectoryPromptPath(root: string, dirName: string): string {
  return join(sessionsRoot(root), dirName, TRAJECTORY_PROMPT_FILENAME)
}

/**
 * 该轨迹**有没有**轨迹提示词（单一判据）。
 *
 * 用途：兼容期的"让位"判定 —— 若已有 `PROMPT.md`，skiff 旧字段 `systemPromptFile`
 * 必须**让位**，否则同一份章程会在两处各注入一遍（第 ⑧ 段 ＋ `serenity-skiff` 段）。
 * 🔴 判据只有这一处：别在 skiff 那边自己拼路径再判（两处会漂）。
 */
export function hasTrajectoryPrompt(root: string, dirName: string): boolean {
  try {
    return existsSync(trajectoryPromptPath(root, dirName))
  } catch {
    return false
  }
}

/**
 * 解析一条轨迹的**轨迹提示词**（一次性读；`create` / 诊断 / 预览用）。
 *
 * 🔴 热路径**不要**用它（那会每次工具调用都读盘）——热路径用 {@link createTrajectoryPromptReader}。
 *
 * 优先级（**确定性，只有这一条**）：
 *   ① `<轨迹目录>/PROMPT.md` —— 新形态，**所有轨迹**都能有
 *   ② skiff 的 `systemPromptFile` —— **兼容期**旧形态（存量 CCC 不必同批迁移）
 *   ③ 无 ⇒ 空串（**不是错误**：没有章程的轨迹是常态）
 *
 * ⚠️ 读失败（权限/坏文件）⇒ 空串而不是抛错：提示词读不到不该阻断会话创建；
 * 但**会告警**（见 reader 版本），不静默。
 */
export function resolveTrajectoryPrompt(
  root: string,
  dirName: string,
  legacyProfile?: SkiffProfile | null,
): TrajectoryPromptResolution {
  const own = trajectoryPromptPath(root, dirName)
  try {
    if (existsSync(own)) {
      return { text: readUtf8(own).trim(), source: 'trajectory-file', path: own }
    }
  } catch {
    /* 落到兼容分支（下面会告警的是 reader 版本；这里保持"解析不抛错"） */
  }
  // ② 兼容期：skiff 的旧字段（它自己已做过路径逃逸拒绝）
  const legacyFile = legacyProfile?.systemPromptFile?.trim()
  if (legacyFile) {
    return { text: '', source: 'skiff-legacy', path: legacyFile }
  }
  const inline = legacyProfile?.systemPrompt?.trim()
  if (inline) {
    return { text: inline, source: 'skiff-legacy', path: null }
  }
  return EMPTY
}

/**
 * 轨迹提示词的**读取器**（长期热更新；改文件即生效，无需重启）。
 *
 * ## 为什么返回函数而不是字符串（R↓，实证代价）
 *
 * 旧实现把提示词**快照**进系统提示词段的闭包 ⇒ CCC 改了文件必须重启 dsh web 才生效
 * （实测：改完 18KB 提示词，live agent 仍用旧文本）。现形态由系统提示词段的 `text()`
 * **每轮调用**本读取器：按 **mtime + size** 缓存重读（命中缓存零 IO）。
 *
 * ## 三条失败语义（各治一个失败模式）
 *
 * - **文件不存在** ⇒ 返回空串（**不是错误**：普通轨迹没有章程是常态，且删掉即失效
 *   必须是立即可见的——这就是"删掉 PROMPT.md 即恢复默认"的机制）
 * - **读取失败** ⇒ 返回**上次成功内容**（⛔ 绝不返回空：空提示词会让轨迹失去章程），
 *   并按去重标签告警一次
 * - **首次就读不到** ⇒ 空串 ＋ 告警一次（区分"本来没有"与"有但读不了"）
 *
 * @param root CCC 根
 * @param dirName 轨迹目录名（**不是编码**：目录名才是落盘位置）
 */
export function createTrajectoryPromptReader(root: string, dirName: string): () => string {
  const absPath = trajectoryPromptPath(root, dirName)
  let cachedMtime = -1
  let cachedSize = -1
  let cachedText = ''
  let warned = false
  return () => {
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(absPath)
    } catch (err) {
      // 🔴 文件**不存在** ⇒ 立刻清空缓存并返回空串。
      //    这不是"读取失败"，而是"这条轨迹现在没有章程了" ——
      //    `rm PROMPT.md` 必须当场恢复默认，否则删除动作看起来没生效（本文件单测抓到的真缺陷）。
      //    其它错误（权限等）同样走这里：拿不到 stat 就无法证明内容还有效 ⇒ 不能继续供应旧章程。
      const code = (err as { code?: string })?.code
      cachedMtime = -1
      cachedSize = -1
      cachedText = ''
      if (code !== 'ENOENT' && !warned) {
        warned = true
        console.warn(
          `[serenity-hooks] ✗ 轨迹提示词不可读（${absPath}）——按"没有章程"处理: ${String((err as Error)?.message ?? err)}`,
        )
      }
      return ''
    }
    try {
      if (st.mtimeMs === cachedMtime && st.size === cachedSize) return cachedText
      const text = readUtf8(absPath).trim()
      const isReload = cachedMtime !== -1
      cachedMtime = st.mtimeMs
      cachedSize = st.size
      cachedText = text
      warned = false
      if (isReload) {
        console.info(`[serenity-hooks] ↻ 轨迹提示词已热重载（${TRAJECTORY_PROMPT_FILENAME}，${text.length} 字符）`)
      }
      return text
    } catch (err) {
      if (!warned) {
        warned = true
        console.warn(
          `[serenity-hooks] ✗ 轨迹提示词读取失败（${absPath}）——沿用上次成功内容: ${String((err as Error)?.message ?? err)}`,
        )
      }
      return cachedText
    }
  }
}

/**
 * 装配用的**提示词段**（幂等：无内容 ⇒ 空串，宿主会丢弃空 section/空块）。
 *
 * 标记头 `=== Serenity Trajectory Prompt ===`：
 * ① 让模型知道"下面是**这条轨迹自己的章程**"，不是容器规则；
 * ② 让诊断可以按块名 grep。
 *
 * 🔴 这段**追加**在容器层与质量层之后，**永不替换它们**——那正是本概念相对「人格」的核心修正。
 */
export function trajectoryPromptBlock(text: string): string {
  const body = text.trim()
  if (body === '') return ''
  return ['', '=== Serenity Trajectory Prompt ===', body, ''].join('\n')
}
