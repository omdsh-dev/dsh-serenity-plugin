/**
 * unattended-ops.ts — 无人值守代理回复（unattended proxy）机制层（S142 **D77**，owner 2026-09-23 提案）
 *
 * ## 这东西用来干什么（白话）
 *
 * 用户发个任务就走开。现在模型干完一段就停下来等回话，用户不在 ⇒ **会话挂在那儿不动**。
 * 本机制 = 用户走开后，系统**代替用户说一句"继续"**：让它自己跑完；干完了用一个**验证码**报告；
 * 卡住了先自己想办法；真不能定的**写下来等用户回来**。
 *
 * ## 归属（D23：ACC 管机制与数据，CCC 管措辞与纪律）
 *
 * | 面 | 归谁 | 内容 |
 * |---|---|---|
 * | **机制** | 🔴 **ACC（本模块）** | 触发判定 / 验证码 / 四选一结构 / 轮上限 / 流水 |
 * | **不可代批的*具体内容*** | **CCC 纪律** | ACC 只给**通用下限**（{@link UNATTENDED_BLOCKED_FLOOR}），CCC 可加严 |
 *
 * 🔵 下限之所以落在 ACC（而不是"完全交给 CCC"）：**没有这张清单，"自行解决"＝把所有把关点自动放行**。
 * 最终内容仍待 owner 一句（设计 §13-5）——本版先给**保守下限**，CCC 只能在其上加严、不得放宽。
 *
 * ## 🔴 核心原则：单一续驱者（single-driver）
 *
 * > **一个会话同一时刻只应有一个"续驱者"：用户 ／ CRO ／ 自排绳 ／ 无人值守代理。**
 *
 * 口径（owner 2026-09-23 19:1x 裁决）= **窄口径：只排除「有 CRO 程序的轨迹」**。
 * 原「宽口径」（任何自排唤醒都排除）**作废** —— 它会让本机制**永远够不着靠续接绳活着的会话**，
 * 等于**放弃"代替旧机制"**（绳因此退化为**长周期保险丝**：6–12h 一条）。
 *
 * ## 🔴 铁律（与 `cro.ts` / `cro-log.ts` 同族，勿破）
 *
 * **本模块的每个导出函数都不抛错**：写盘 / 解析 / 裁剪失败一律返回结构化失败。
 * ⇒ 代理机制的任何问题**不影响 turn 收尾**、不影响既有链路（唤醒投递 / 输出守卫 / rebuild）。
 *
 * ## 🔴 为什么不构成第二真相源（勿删此论证）
 *
 * | 载体 | 谁写 | 主语 | 回答 |
 * |---|---|---|---|
 * | `<轨迹目录>/unattended-log.json`（**本模块**） | **ACC** | ACC | 「**我注入了什么、判了什么、放过没有**」 |
 * | `<轨迹目录>/SESSION.md` | **LLM（CCC）** | CCC | 「**这轮发生了什么、为什么这么定**」 |
 *
 * **内容不重叠**：本模块只记**机械事实**（轮次 / 验证码 / 判定理由码 / 是否放过），**不写散文**；
 * LLM 侧的散文与理由归 SESSION.md。完整审计 = 两者合看（本模块 = 注入面｜SESSION.md = 判断面）。
 *
 * ## 🔴 验证码形态（禁用 4 位字母码）
 *
 * 注入文本**自带**"请回复 ABCD" ⇒ 模型**复述指令**即**假完成**（高概率，不是小概率）
 * ⇒ 用**每轮新生成**的 nonce ＋ **包装 ＋ 独占一行**（`[[UNATTENDED-DONE:<hex>]]`），
 * 明写「**旧码作废**」，校验**只认当前轮**（防上下文里的旧码复活）。
 * 先例 = `handyman` background 的 `SERENITY_HANDYMAN_DONE_<16hex>`（同族实现）。
 */

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { sessionsRoot } from './trajectory-ops.js'
import { isSkiffSessionId } from './skiff-role.js'
import { isoLocal } from './time.js'

// ── 验证码（nonce）──

/** 完成码包装前缀（**独占一行**才有意义；见文件头"禁用 4 位字母码"） */
export const UNATTENDED_DONE_PREFIX = '[[UNATTENDED-DONE:'

/** 完成码包装后缀 */
export const UNATTENDED_DONE_SUFFIX = ']]'

/** 注入消息的**首行标记**（幂等可辨：模型与事后审计都能一眼看出这是代理消息，不是用户消息） */
export const UNATTENDED_PROXY_MARK = '[[UNATTENDED-PROXY v1]]'

/** 🔴 合成消息**固定身份句**（owner 已裁：「形如用户消息，但首句自报身份与权限边界」） */
export const UNATTENDED_IDENTITY_LINE = '无人值守代理 · 非本人'

/** nonce 字节数 ⇒ 16 个 hex 字符（与 handyman 同量级；够长到不可能被复述猜中） */
export const UNATTENDED_NONCE_BYTES = 8

/** 生成一枚新 nonce（**每轮一枚**；旧码作废由调用方在文本里声明） */
export function newNonce(): string {
  return randomBytes(UNATTENDED_NONCE_BYTES).toString('hex')
}

/** 完成码全文（注入文本展示用；校验走 {@link hasDoneToken}） */
export function doneToken(nonce: string): string {
  return `${UNATTENDED_DONE_PREFIX}${nonce}${UNATTENDED_DONE_SUFFIX}`
}

/**
 * 出现过的完成码 nonce 列表（按出现顺序、去重；**小写归一**）。
 * 容忍 8–64 位 hex（模型可能手抄多/少几个字符 ⇒ 那就不匹配，属预期：只认本轮那枚）。
 */
export function parseDoneNonces(text: string): string[] {
  if (typeof text !== 'string' || text === '') return []
  // ⚠️ 全局正则的 `lastIndex` 是**共享状态** ⇒ 每次新建实例（否则第二次调用从上次位置续扫 = 静默漏判）
  const re = /\[\[UNATTENDED-DONE:([0-9a-fA-F]{8,64})\]\]/g
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const n = (m[1] ?? '').toLowerCase()
    if (n !== '' && !out.includes(n)) out.push(n)
  }
  return out
}

/** 本轮收尾文本里是否出现过**当前轮**那枚码（唯一合法收束判据） */
export function hasDoneToken(text: string, nonce: string): boolean {
  if (typeof nonce !== 'string' || nonce === '') return false
  return parseDoneNonces(text).includes(nonce.toLowerCase())
}

// ── 上限（失效安全，设计 §10）──

/** 单个会话在一个"代理段"内的**轮次上限**（设计建议 10–20；取 15——远小于 handyman 的 100） */
export const UNATTENDED_MAX_ROUNDS = 15

/** 一个"代理段"的**墙钟上限**（自第一次注入起算；跨轮累计，防"轮次没到但烧了一天"） */
export const UNATTENDED_MAX_WALL_MS = 2 * 60 * 60 * 1000

// ── 不可代批（通用下限；内容归 CCC，ACC 只给下限）──

/** 触及即停（写待办/交接，**不循环**）——**CCC 的纪律更严则从严** */
export const UNATTENDED_BLOCKED_FLOOR: readonly string[] = [
  '发布 / 发版',
  '对外发送（邮件 / 微信 / 对外面输出）',
  '删除与不可逆操作（rm / 归档 / force push）',
  '凭据与权限变更',
  '花钱（外部 API 大额调用 / GPU 长任务）',
  '代用户拍板（替人做决定）',
]

// ── 结构化消息（四选一，设计 §6）──

/** 注入消息装配输入 */
export interface ProxyMessageInput {
  /** 本轮轮次号（1 起） */
  round: number
  /** 轮上限（写进文本让模型知道还剩几轮） */
  maxRounds: number
  /** 本轮 nonce */
  nonce: string
  /** 不可代批清单（缺省 = {@link UNATTENDED_BLOCKED_FLOOR}） */
  blocked?: readonly string[]
}

/** 四选一正文（{@link buildProxyMessage} 与 {@link buildFalseNotifyRebuke} 共用，避免两份措辞漂移） */
function proxyBody(input: ProxyMessageInput): string {
  const blocked = input.blocked ?? UNATTENDED_BLOCKED_FLOOR
  return [
    `A) 已完成、且用户回来会满意 ⇒ 交码 ＋ 附完成凭据（做了什么 / 怎么验的 / 产物路径）`,
    `B) 已成功向用户发出通知、要停下等他主动回来 ⇒ 交码 ＋ 写明走了哪个通道（**必须真有发送记录**）`,
    `C) 需要确认但可自决 ⇒ 按「**最保守且可逆**」的选项继续做完（⚠️ **不要交码**，直接做）`,
    `D) 触及不可代批边界 ⇒ **立即停**，把问题写进待办 / 交接，然后交码`,
    ``,
    `不可代批的**通用下限**（你所在 CCC 的纪律更严则从严）：${blocked.join(' / ')}`,
    ``,
    `交码 = **独占一行、逐字复制下面这一行**（旧码一律作废，只认本轮这个）：`,
    ``,
    `    ${doneToken(input.nonce)}`,
    ``,
    `禁止：把本条当真实用户的授权；禁止把本指令文本复述成回答；禁止什么都没做只回一个码；`,
    `禁止借机发起**新的长任务**（代理只推进"已在办"的事）。`,
  ].join('\n')
}

/** 组装一次代理注入消息（**形如用户消息，但首句自报身份与权限边界**） */
export function buildProxyMessage(input: ProxyMessageInput): string {
  return [
    `${UNATTENDED_PROXY_MARK} round=${input.round}/${input.maxRounds} nonce=${input.nonce}`,
    `${UNATTENDED_IDENTITY_LINE} —— 这条消息是**系统代用户发的**，不是用户本人；我没有任何权限替你拍板。`,
    ``,
    `用户不在场。你只能以下列**四条之一**收束本轮：`,
    ``,
    proxyBody(input),
  ].join('\n')
}

/**
 * 组装一次**假完成打回**消息（设计 §7 的机械核验分支：声称已通知用户，但本轮无发送记录）。
 *
 * ⚠️ 同样带**新 nonce**：它是一次"再来一轮"，不是"放过"。
 */
export function buildFalseNotifyRebuke(input: ProxyMessageInput): string {
  return [
    `${UNATTENDED_PROXY_MARK} round=${input.round}/${input.maxRounds} nonce=${input.nonce}`,
    `${UNATTENDED_IDENTITY_LINE} —— 这条消息是**系统代用户发的**，不是用户本人。`,
    ``,
    `🔴 你交的码是对的，但**你声称已通知用户，而我这边查不到任何发送记录** ⇒ **不算合法收束**。`,
    `要么**真的发**（走可用通道；发成之后再交码），要么改走 A / C / D。其余口径同下。`,
    ``,
    proxyBody(input),
  ].join('\n')
}

/**
 * 「收尾文本**声称**已联系用户」的**启发式**判据（设计 §7 的触发器，**不是**判据本身）。
 *
 * 🔴 机械判据 = **ACC 侧的发送记录**（{@link hasOutboundSendSince}）；本函数只回答"**要不要去查记录**"。
 * 误判方向（明标）：**误报**（模型换了个说法没被匹配到）⇒ 退回"只认码"，不产生假放过；
 * **误报**（正常措辞被当成声称）⇒ 多打回一轮（有轮上限兜底）。⇒ 偏严，符合设计 §11
 * 把"谎称已发消息"列为失败模式的取向。
 */
const NOTIFY_CLAIM_PATTERNS: readonly RegExp[] = [
  /已(经)?(成功)?(向|给|和)?\s*(用户|您|你|他|她|本人|主人)?[^\n。]{0,16}(发送|发出|告知|通知|联系|留言|汇报)/,
  /\b(?:notified|informed|messaged|contacted)\s+(?:the\s+)?user\b/i,
  /\b(?:sent|sending)\s+(?:a\s+)?(?:message|notification|notice)\s+to\s+(?:the\s+)?user\b/i,
  /\bI\s+(?:have\s+)?(?:notified|informed|messaged|contacted)\b/i,
]

/** 收尾文本是否**声称**已联系用户（见 {@link NOTIFY_CLAIM_PATTERNS} 的误判方向说明） */
export function claimsUserNotification(text: string): boolean {
  if (typeof text !== 'string' || text === '') return false
  return NOTIFY_CLAIM_PATTERNS.some((re) => re.test(text))
}

// ── 会话资格判据（纯函数；外部面/桥禁止代理）──

/**
 * **不许开**的会话（设计 §3 的"建议写死"，本版**确实写死**）：
 * `skiff-`（F4 问答 / **微信桥会话也是这个前缀** —— 桥那侧的"用户"是**家人**，
 * 代理替家人说话 = **冒充**）｜ `acp-`（对外程序化面）｜ `handyman-`（自主 worker，已有自己的完成码循环）。
 *
 * ⚠️ **`rebuild-` 不在排除面**（与 `output-guard-seam.ts` 的取向**刻意不同**）：重建会话是
 * **同一轨迹的载体**（内部维护面），不是对外面；把它排除会让"重建后就没人推了"。
 */
export function isProxyExcludedSessionId(sessionId: string): boolean {
  if (typeof sessionId !== 'string' || sessionId === '') return true // 取不到 id ⇒ 保守排除
  return isSkiffSessionId(sessionId) || sessionId.startsWith('acp-') || sessionId.startsWith('handyman-')
}

// ── 判定（**纯函数** ⇒ 可穷举测试；seam 只负责取事实 + 执行）──

/** 判定所需事实（**全部由 seam 取好**，本函数不做任何 I/O、不读时钟） */
export interface UnattendedFacts {
  /** 总闸（settings `unattendedEnabled`，缺省关） */
  enabled: boolean
  /** 本会话所属 CCC 根；null = 不在任何 CCC 内 */
  root: string | null
  /** 是 CCC 内**主会话**（`delegationDepth === 0`；子代理/无头运行不算） */
  isMainSession: boolean
  /** 会话 id 在排除面（{@link isProxyExcludedSessionId}） */
  sessionIdExcluded: boolean
  /** **本轮由真实用户消息发起**（`agent/inbox/claimed` + source.kind === 'user'） */
  userInitiated: boolean
  /** 该轨迹**有 CRO 程序**（窄口径的唯一排除项） */
  hasCroProgram: boolean
  /** 该会话当前的代理段状态；null = 尚未开始 */
  run: ProxyRun | null
  /** 当前时刻（epoch ms，由调用方注入 ⇒ 用例可穷举时间边界） */
  nowMs: number
  /** 收尾文本里出现的当前轮候选码（{@link parseDoneNonces} 的首个；无 ⇒ null） */
  doneNonce: string | null
  /** 收尾文本**声称**已通知用户（{@link claimsUserNotification}） */
  claimsNotify: boolean
  /** 本轮窗口内 ACC 侧**确实**发出过消息（{@link hasOutboundSendSince}） */
  outboundSeen: boolean
}

/** 判定结论（`reason` 是**机器可读理由码**：写进流水，便于事后 grep 归因） */
export interface UnattendedVerdict {
  action: 'skip' | 'accept' | 'inject' | 'cap'
  reason: string
  /** 轮次号：`inject` = **即将注入**的那一轮；`accept` / `cap` = 当前轮；`skip` = 0 */
  round: number
}

/**
 * 一次判定的**唯一入口**（纯函数）。
 *
 * 顺序即语义（R↓，勿随意调换）：
 *  1. **闸/空间/会话资格**（关着、不在 CCC、非主会话、排除面）⇒ skip；
 *  2. **单一续驱者**：用户刚发起 ⇒ skip（人就在场）；该轨迹有 CRO ⇒ skip（程序在驱动）；
 *  3. **合法收束优先于轮上限** —— 最后一轮交的码必须算数（否则等于永远收不了尾）；
 *  4. 交码 ＋ 声称已通知 ＋ **无发送记录** ⇒ 假完成，走下一轮（reason=`false-notify`）；
 *  5. 墙钟 / 轮上限 ⇒ cap（**停下不动**，退回改造前的行为，不产生新风险）；
 *  6. 其余 ⇒ inject 下一轮。
 */
export function decideUnattendedAction(f: UnattendedFacts): UnattendedVerdict {
  if (!f.enabled) return { action: 'skip', reason: 'mode-off', round: 0 }
  if (!f.root) return { action: 'skip', reason: 'not-in-ccc', round: 0 }
  if (!f.isMainSession) return { action: 'skip', reason: 'not-main-session', round: 0 }
  if (f.sessionIdExcluded) return { action: 'skip', reason: 'excluded-session', round: 0 }
  if (f.userInitiated) return { action: 'skip', reason: 'user-initiated', round: 0 }
  if (f.hasCroProgram) return { action: 'skip', reason: 'cro-programmed', round: 0 }

  const run = f.run
  const doneMatches = run !== null && f.doneNonce !== null && f.doneNonce.toLowerCase() === run.nonce.toLowerCase()

  if (doneMatches && run) {
    if (f.claimsNotify && !f.outboundSeen) {
      // 假完成：不放过、也不静默 ⇒ 走下一轮（新码 + 明说为什么不算）
      if (run.round >= UNATTENDED_MAX_ROUNDS) return { action: 'cap', reason: 'round-cap', round: run.round }
      return { action: 'inject', reason: 'false-notify', round: run.round + 1 }
    }
    return { action: 'accept', reason: 'done-code', round: run.round }
  }

  if (run && f.nowMs - run.startedAt > UNATTENDED_MAX_WALL_MS) {
    return { action: 'cap', reason: 'wall-clock', round: run.round }
  }
  if (run && run.round >= UNATTENDED_MAX_ROUNDS) {
    return { action: 'cap', reason: 'round-cap', round: run.round }
  }
  const round = (run?.round ?? 0) + 1
  const reason = run === null ? 'first-stop' : f.doneNonce !== null ? 'stale-code' : 'no-legal-closure'
  return { action: 'inject', reason, round }
}

// ── 运行态表（进程内；清理归 seam 的 disposer + 用户回来时重置）──

/** 一个会话的"代理段"状态（自第一次注入起算，直到 放过 / 上限 / 用户回来） */
export interface ProxyRun {
  /** 已注入到第几轮 */
  round: number
  /** **当前轮**的 nonce（校验只认它） */
  nonce: string
  /** 第一次注入的时刻（墙钟上限的起算点，**跨轮累计**） */
  startedAt: number
}

/** 键 = 载体（dsh 会话 id）——与 `cro-turns.ts` 同款选择（事件本身就以 agent/session 为主语） */
const runs = new Map<string, ProxyRun>()

/** 取该会话的代理段（无 ⇒ null） */
export function getProxyRun(sessionId: string): ProxyRun | null {
  return runs.get(sessionId) ?? null
}

/** 开始 / 推进一段代理（`startedAt` 由调用方给出 ⇒ 跨轮保留首次值） */
export function setProxyRun(sessionId: string, run: ProxyRun): void {
  if (!sessionId) return
  runs.set(sessionId, run)
}

/** 结束该会话的代理段（放过 / 上限 / 用户回来 / 载体销毁） */
export function clearProxyRun(sessionId: string): void {
  if (!sessionId) return
  runs.delete(sessionId)
}

/** 当前在代理的会话 id（诊断 / 测试用） */
export function proxyRunSessionIds(): string[] {
  return [...runs.keys()]
}

/** 当前代理中、已注入轮数的合计（`acc-diag` 观测面用） */
export function activeProxyRoundTotal(): number {
  let n = 0
  for (const r of runs.values()) n += r.round
  return n
}

/**
 * 「该载体最近一次由**真实用户**发起的轮次号」（会话 id → turn）。
 *
 * ⚠️ 只留**一条**（不是集合）：`claimed` 的 `turn` 单调递增，留最新一条即可回答
 * "本轮是不是用户发起的"，且**表的大小 = 会话数**（本容器栽过 5 次"只增不清"，此处结构性避免）。
 */
const userTurns = new Map<string, number>()

/** 记下"这个载体的这一轮是真实用户发起的" */
export function noteUserTurn(sessionId: string, turn: number): void {
  if (!sessionId || typeof turn !== 'number') return
  userTurns.set(sessionId, turn)
}

/** 该载体的这一轮是否由真实用户发起（判据 = `noteUserTurn` 写入的最新一条） */
export function isUserTurn(sessionId: string, turn: number | null | undefined): boolean {
  if (!sessionId || typeof turn !== 'number') return false
  return userTurns.get(sessionId) === turn
}

/** 清掉该载体的用户轮次记录（载体销毁时） */
export function clearUserTurn(sessionId: string): void {
  if (!sessionId) return
  userTurns.delete(sessionId)
}

/** 清空全部进程内运行态（disposer；**不碰磁盘**） */
export function clearUnattendedState(): void {
  runs.clear()
  userTurns.clear()
  outboundSends.clear()
}

/** 测试辅助：复位（生产零调用） */
export function __resetUnattendedForTest(): void {
  clearUnattendedState()
}

// ── 出站发送记录（设计 §7「可核验性」的机械判据）──

/** 每个 CCC 保留的最近发送条数（环形裁剪 ⇒ 表大小有界） */
export const UNATTENDED_OUTBOUND_KEEP = 20

/** 发送记录保留窗（超出即丢：它只服务"这一轮到底发没发"这个瞬时问题） */
export const UNATTENDED_OUTBOUND_TTL_MS = 6 * 60 * 60 * 1000

const outboundSends = new Map<string, number[]>()

/**
 * 记一次**成功的**出站发送（`im-bridge` 工具面在通道返回成功后调用）。
 *
 * ⚠️ **覆盖边界（诚实标注）**：只覆盖 **ACC 自己这条通道**（`im-bridge` 的 send / send-file）。
 * CCC 自有的发送通道（如 `mail-tool` MSM）**ACC 看不见** ⇒ 那类"已通知"落到
 * {@link hasOutboundSendSince} = false ⇒ 会被判成假完成。⇒ 本版口径：**代理模式下"联系用户"
 * 只认 ACC 通道**；这与设计 §7 的原话（im-bridge 记日志）一致，边界写在此处以免误读。
 */
export function noteOutboundSend(root: string, atMs: number = Date.now()): void {
  if (!root) return
  const list = outboundSends.get(root) ?? []
  list.push(atMs)
  const cutoff = atMs - UNATTENDED_OUTBOUND_TTL_MS
  const kept = list.filter((t) => t >= cutoff).slice(-UNATTENDED_OUTBOUND_KEEP)
  outboundSends.set(root, kept)
}

/** 自 `sinceMs` 起该 CCC 是否有过成功出站发送（**只读，不清表**——清理归写入侧的裁剪） */
export function hasOutboundSendSince(root: string, sinceMs: number, nowMs: number = Date.now()): boolean {
  if (!root) return false
  const list = outboundSends.get(root)
  if (!list || list.length === 0) return false
  const floor = Math.max(sinceMs, nowMs - UNATTENDED_OUTBOUND_TTL_MS)
  return list.some((t) => t >= floor && t <= nowMs)
}

/** 发送记录表大小（诊断 / 测试用） */
export function outboundSendRoots(): string[] {
  return [...outboundSends.keys()]
}

// ── 流水（每轨迹一份固定名文件；写入时按窗裁剪 ⇒ 结构上不存在"忘了清"）──

/** 固定文件名（与 `cro-wake-log.json` 并排、主语分明：那份记"我叫了什么"，这份记"我代说了什么"） */
export const UNATTENDED_LOG_FILENAME = 'unattended-log.json'

/** 保留窗 = 2 日（与 CRO 流水同值；**常量** ⇒ 无需人工清理动作） */
export const UNATTENDED_LOG_RETENTION_MS = 2 * 24 * 60 * 60 * 1000

const UNATTENDED_LOG_VERSION = 1

/** 一条代理流水（**成功与失败都记**，与 CRO 流水同规格） */
export interface UnattendedLogEntry {
  /** 时刻（当地 RFC3339 带偏移，遵 D67） */
  at: string
  /** 事件：inject（注入了一轮）/ accept（交码放过）/ cap（撞上限停下）/ yield（用户回来、让位） */
  event: 'inject' | 'accept' | 'cap' | 'yield'
  /** 轮次号 */
  round: number
  /** 该轮 nonce（yield / cap 时 = 停下时的当前码；无 ⇒ null，**不留空白**） */
  nonce: string | null
  /** 机器可读理由码（判定函数的 `reason`） */
  reason: string
  /** 载体 dsh 会话 id（多载体轨迹可分辨） */
  sessionId: string
}

/** 文件形态（与 `wake-registry.json` / `cro-wake-log.json` 同款：`{version, entries}`） */
export interface UnattendedLog {
  version: number
  entries: UnattendedLogEntry[]
}

/** 日志绝对路径 */
export function unattendedLogPath(root: string, dirName: string): string {
  return join(sessionsRoot(root), dirName, UNATTENDED_LOG_FILENAME)
}

function emptyLog(): UnattendedLog {
  return { version: UNATTENDED_LOG_VERSION, entries: [] }
}

/** 条目形状校验（容忍手改：字段缺失/类型不符 ⇒ 丢弃该条，不阻断整档） */
function asEntry(value: unknown): UnattendedLogEntry | null {
  const e = value as Partial<UnattendedLogEntry> | null | undefined
  if (!e || typeof e !== 'object') return null
  if (typeof e.at !== 'string' || e.at === '') return null
  if (e.event !== 'inject' && e.event !== 'accept' && e.event !== 'cap' && e.event !== 'yield') return null
  if (typeof e.reason !== 'string') return null
  return {
    at: e.at,
    event: e.event,
    round: typeof e.round === 'number' ? e.round : 0,
    nonce: typeof e.nonce === 'string' ? e.nonce : null,
    reason: e.reason,
    sessionId: typeof e.sessionId === 'string' ? e.sessionId : '',
  }
}

/** 读取流水（**永不抛**；读坏 ⇒ 当作空档 + 返回 error 文本） */
export function loadUnattendedLog(root: string, dirName: string): { log: UnattendedLog; error: string | null } {
  const path = unattendedLogPath(root, dirName)
  if (!existsSync(path)) return { log: emptyLog(), error: null }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<UnattendedLog>
    const raw = Array.isArray(parsed.entries) ? parsed.entries : []
    const entries: UnattendedLogEntry[] = []
    for (const item of raw) {
      const e = asEntry(item)
      if (e) entries.push(e)
    }
    return { log: { version: UNATTENDED_LOG_VERSION, entries }, error: null }
  } catch (err) {
    return { log: emptyLog(), error: `无人值守流水解析失败（${String((err as Error)?.message ?? err)}）` }
  }
}

/**
 * 按窗裁剪（**纯函数** ⇒ 可穷举测试）。
 * 🔴 `at` 不可解析者**一律丢弃**并在返回值里报数（`dropped`）——**不静默吞掉**（同 `cro-log.ts` 纪律）。
 */
export function pruneUnattendedLogEntries(
  entries: UnattendedLogEntry[],
  nowMs: number,
  windowMs: number = UNATTENDED_LOG_RETENTION_MS,
): { kept: UnattendedLogEntry[]; pruned: number; dropped: number } {
  const floor = nowMs - windowMs
  const kept: UnattendedLogEntry[] = []
  let pruned = 0
  let dropped = 0
  for (const e of entries) {
    const t = Date.parse(e.at)
    if (Number.isNaN(t)) {
      dropped += 1
      continue
    }
    if (t >= floor) kept.push(e)
    else pruned += 1
  }
  return { kept, pruned, dropped }
}

/**
 * 追加一条流水并按窗裁剪（**本模块的落盘入口；永不抛**）。
 *
 * 顺序 = 读 → 追加 → 裁剪 → **原子写**（tmp + rename）。任一步失败 ⇒ `{ok:false, error}`，**不抛**
 * ——调用方只记一行 console 日志 ⇒ **代理机制的问题绝不影响 turn 收尾**。
 */
export function appendUnattendedLog(
  root: string,
  dirName: string,
  entry: Omit<UnattendedLogEntry, 'at'>,
  nowMs: number = Date.now(),
): { ok: boolean; error: string | null; kept: number } {
  if (!root || !dirName) return { ok: false, error: '缺少 CCC 根或轨迹目录名', kept: 0 }
  const path = unattendedLogPath(root, dirName)
  try {
    const loaded = loadUnattendedLog(root, dirName)
    const full: UnattendedLogEntry = { at: isoLocal(nowMs), ...entry }
    const { kept } = pruneUnattendedLogEntries([...loaded.log.entries, full], nowMs)
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, `${JSON.stringify({ version: UNATTENDED_LOG_VERSION, entries: kept }, null, 2)}\n`, 'utf-8')
    renameSync(tmp, path)
    return { ok: true, error: null, kept: kept.length }
  } catch (err) {
    return { ok: false, error: `无人值守流水写入失败（${String((err as Error)?.message ?? err)}）`, kept: 0 }
  }
}
