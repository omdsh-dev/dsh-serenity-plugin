/**
 * unattended-seam.ts — 无人值守代理回复的**拦截缝**（S142 **D77**，owner 2026-09-23 令「我需要的是一个机制」）
 *
 * ## 停在哪、怎么接（设计 §4 的裁决：**A 的通道 ＋ B 的措辞**）
 *
 * 复用的是**已验证过的**通道——`agent/turn-stopping`（serial）里 `agent.steer()`：
 * 宿主语义 = "**listener 反对就打回**，机器重读 inbox：有新 steer ⇒ 再跑一步，没有 ⇒ 关轮"
 * （`host/contract.ts` 的 `HOST_EVENTS` 原文）。因此：
 * · **轮不结束**（语义正是"有人打回"）⇒ **零新机械**；
 * · 文本**写成代理用户的话**（B 的措辞）+ **首句自报身份**（owner 已裁）。
 *
 * 模板 = `output-guard-seam.ts`（同一缝位、同一 `createUserMessage + PLUGIN_SOURCE` 形态）。
 *
 * ## 🔴「这轮是不是真实用户发起的」怎么判（本机制**唯一**的新机械；2026-09-23 取证）
 *
 * 交接块把它列为"动手前必须先查清的一件事"，取证结论（读宿主类型面，非猜测）：
 *
 * | 事实 | 出处 |
 * |---|---|
 * | 每条进入 inbox 的消息都发 `agent/inbox/inserted { agent, message }`；**在轮内离开 inbox 时**发 `agent/inbox/claimed { agent, message, turn }` | `@deepseek-ai/dsh-agent` README（Inbox 段）＋ `runtime-types.d.ts` |
 * | `claimed.turn` = **拥有该消息的那一轮**；`turn-stopping.turn` = **即将关闭的那一轮** ⇒ 两者同编号可直接比对 | `runtime-types.d.ts` 同一文件两处 `turn` 声明 |
 * | 消息来源可辨：`MessageSourceMap` 里**真实用户** = `kind: 'user'`（`user` ／ `user-rpc` 两种形态**同 kind**）；**ACC 自己注入**的一律 `kind: 'plugin'` | `@deepseek-ai/dsh-llm` `types/message.d.ts` ＋ 本仓 `PLUGIN_SOURCE`（wake/send-now/send-later/keeper/output-guard 五处同值） |
 *
 * ⇒ **判据 = 「这一轮 claim 到的消息里，有没有 `source.kind === 'user'`」**。
 * 没有现成信号时本可退化为"记账法"（我们知道自己投过什么），**但不必**：宿主已给出一手信号。
 *
 * ## 🔴 为什么"用户发起的轮"要跳过（这是设计 §3-③ 的本意，别当成漏洞）
 *
 * 用户**刚说完话**⇒ 人就在跟前，代理插话既是冒充也是浪费。**"用户说完走开"那种情形**
 * 由**绳（长周期保险丝）／其它非用户发起的唤醒**覆盖：那条轮**不是**用户发起的 ⇒ 代理接手，
 * 一路推进到**合法收束**。⇒ 两个机制合起来才等于"用户走开后会话还能自己跑完"。
 *
 * ## 🔴 铁律（与 `unattended-ops.ts` 同族）
 *
 * **本模块的任何失败都不得影响 turn 收尾**：所有 handler 包 try/catch，异常只记一行 console。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import { cccRootForCwd } from './ccc-roots.js'
import { readLastBound } from './trajectory-bound.js'
import { sessionsRoot } from './trajectory-ops.js'
import { CRO_FILENAME } from './cro.js'
import { readSimpleSettings } from './settings-section.js'
import { registerDisposer } from './host/effect.js'
import { lastAssistantText } from './output-guard-seam.js'
import {
  UNATTENDED_MAX_ROUNDS,
  appendUnattendedLog,
  buildFalseNotifyRebuke,
  buildProxyMessage,
  claimsUserNotification,
  clearProxyRun,
  clearUnattendedState,
  clearUserTurn,
  decideUnattendedAction,
  getProxyRun,
  hasOutboundSendSince,
  isProxyExcludedSessionId,
  isUserTurn,
  newNonce,
  noteUserTurn,
  parseDoneNonces,
  setProxyRun,
  type UnattendedLogEntry,
} from './unattended-ops.js'

/** 本插件注入消息的**统一来源标记**（与 output-guard / wake / keeper 同值 ⇒ 一眼可辨"不是用户"） */
const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'dsh-serenity-hooks' }

/** 取载体 id（payload 的 `agent` 面；取不到 ⇒ 空串） */
function sessionIdOf(agent: unknown): string {
  const id = (agent as { session?: { id?: unknown } } | undefined)?.session?.id
  return typeof id === 'string' ? id : ''
}

/** 取会话对象（payload 的 `agent.session`） */
function sessionOf(agent: unknown): unknown {
  return (agent as { session?: unknown } | undefined)?.session
}

/** 取会话 cwd（`header.cwd`；取不到回落进程 cwd——与 `output-guard-seam.ts` 同款读法） */
function cwdOf(agent: unknown): string {
  return ((sessionOf(agent) as { header?: { cwd?: string } } | undefined)?.header?.cwd) ?? process.cwd()
}

/** 是否 **CCC 内主会话**（`delegationDepth` 缺省 0；子代理 / 无头运行不算） */
function isMainSession(agent: unknown): boolean {
  const depth = (sessionOf(agent) as { header?: { delegationDepth?: number } } | undefined)?.header?.delegationDepth
  return (depth ?? 0) === 0
}

/**
 * 该会话所属轨迹**是否带 CRO 程序**（窄口径的唯一排除项）。
 * 判据 = 轨迹目录下存在 `continuous-re-occurrence.ts`（与 `cro.ts` 同源：**文件在 = 启用**）。
 * 无绑定（未挂在任何轨迹上）⇒ false（没有程序在驱动它）。
 */
function hasCroProgram(session: unknown, root: string): boolean {
  const dirName = readLastBound(session)?.dirName
  if (!dirName) return false
  return existsSync(join(sessionsRoot(root), dirName, CRO_FILENAME))
}

/** 落一条流水（**永不抛**；无绑定 ⇒ 无落点，只回 false 由调用方记 console） */
function logEvent(
  session: unknown,
  root: string,
  entry: Omit<UnattendedLogEntry, 'at'>,
  nowMs: number,
): boolean {
  const dirName = readLastBound(session)?.dirName
  if (!dirName) return false
  const res = appendUnattendedLog(root, dirName, entry, nowMs)
  if (!res.ok) console.log(`[serenity-hooks] unattended: 流水未落盘 — ${res.error ?? '未知原因'}`)
  return res.ok
}

/**
 * 一轮收尾（`agent/turn-stopping`）的完整处置。
 *
 * 顺序：**取事实 → 纯函数判定 → 执行**（判定全在 `unattended-ops.ts`，本函数只做 I/O 与 steer）。
 * @returns 便于用例观察的判定结果文本（生产不使用返回值）
 */
function handleTurnStopping(agent: Agent, turn: number | null): string {
  // 🔴 便宜门先行（**只是短路**，不是第二套判据：判定语义仍然只在 `decideUnattendedAction` 里，
  //    这几条与它开头那几条逐字同义 ⇒ 结论必然相同）。
  // 为什么必须先短路（本函数挂在**每个会话每一轮**的 turn-stopping 上）：
  //    `hasCroProgram` / `logEvent` 都要读**绑定**（文件或宿主存储域 = I/O），而闸关着时
  //    每一次收尾都会做一次注定 skip 的判定 ⇒ 白付 I/O。
  const settings = readSimpleSettings()
  if (settings.unattendedEnabled !== true) return 'skip:mode-off'
  const sessionId = sessionIdOf(agent)
  if (sessionId === '') return 'skip:no-session-id'
  const root = cccRootForCwd(cwdOf(agent))
  if (root === null) return 'skip:not-in-ccc'

  const session = sessionOf(agent)
  const nowMs = Date.now()
  const run = getProxyRun(sessionId)
  const text = lastAssistantText(agent)
  const nonces = parseDoneNonces(text)

  // 同样只在这几道便宜门都过了之后才去查 CRO 程序（要读绑定 ⇒ I/O）
  const sessionIdExcluded = isProxyExcludedSessionId(sessionId)
  const userInitiated = turn === null ? true : isUserTurn(sessionId, turn)
  const cro = !sessionIdExcluded && !userInitiated && isMainSession(agent) ? hasCroProgram(session, root) : false

  const verdict = decideUnattendedAction({
    enabled: true,
    root,
    isMainSession: isMainSession(agent),
    sessionIdExcluded,
    // ⚠️ 取不到 turn（payload 异常）⇒ 视为"用户发起"（保守：宁可不动）
    userInitiated,
    hasCroProgram: cro,
    run,
    nowMs,
    doneNonce: nonces.length > 0 ? (nonces[nonces.length - 1] ?? null) : null,
    claimsNotify: claimsUserNotification(text),
    outboundSeen: run !== null && hasOutboundSendSince(root, run.startedAt, nowMs),
  })

  if (verdict.action === 'skip') return `skip:${verdict.reason}`

  if (verdict.action === 'accept' || verdict.action === 'cap') {
    clearProxyRun(sessionId)
    logEvent(session, root, {
      event: verdict.action,
      round: verdict.round,
      nonce: run?.nonce ?? null,
      reason: verdict.reason,
      sessionId,
    }, nowMs)
    console.log(`[serenity-hooks] unattended: ${verdict.action} (${verdict.reason}, round=${verdict.round}, session=${sessionId})`)
    return `${verdict.action}:${verdict.reason}`
  }

  // inject：新码每轮生成（旧码作废）；startedAt 跨轮保留（墙钟上限累计）
  const nonce = newNonce()
  const startedAt = run?.startedAt ?? nowMs
  setProxyRun(sessionId, { round: verdict.round, nonce, startedAt })
  const message = verdict.reason === 'false-notify'
    ? buildFalseNotifyRebuke({ round: verdict.round, maxRounds: UNATTENDED_MAX_ROUNDS, nonce })
    : buildProxyMessage({ round: verdict.round, maxRounds: UNATTENDED_MAX_ROUNDS, nonce })
  try {
    agent.steer(createUserMessage({ content: [{ type: 'text', text: message }], source: PLUGIN_SOURCE }))
  } catch (error) {
    // 打回失败 ⇒ 轮会照常关闭；清状态（**不留悬挂的代理段**），并如实记账
    clearProxyRun(sessionId)
    logEvent(session, root, {
      event: 'cap',
      round: verdict.round,
      nonce,
      reason: 'steer-failed',
      sessionId,
    }, nowMs)
    console.warn(`[serenity-hooks] unattended: steer 失败（本轮放弃） — ${String((error as Error)?.message ?? error)}`)
    return 'cap:steer-failed'
  }
  logEvent(session, root, {
    event: 'inject',
    round: verdict.round,
    nonce,
    reason: verdict.reason,
    sessionId,
  }, nowMs)
  console.log(`[serenity-hooks] unattended: inject round=${verdict.round}/${UNATTENDED_MAX_ROUNDS} (${verdict.reason}, session=${sessionId})`)
  return `inject:${verdict.reason}`
}

/**
 * 装配无人值守代理缝（`index.ts` apply 调用）。
 *
 * 订阅三个事件（**都已在 `host/contract.ts` 白名单里**，新增的 `agent/inbox/claimed` 同批登记）：
 * · `agent/inbox/claimed` —— 记「真实用户发起的轮次」；用户回来时**让位**（清代理段 + 记流水）;
 * · `agent/turn-stopping` —— 判定 + 注入（本机制主体）；
 * · `agent/disposed` / `session/disposed` —— 载体销毁清表（**本容器栽过 5 次"只增不清"**）。
 */
export function registerUnattendedSeam(ctx: Context): void {
  const on = (event: string, handler: (payload: unknown) => void): void => {
    try {
      // 宿主事件为字符串键，写错只会静默不订阅 ⇒ 名字取自 HOST_EVENTS 白名单（编译期已钉）
      ;(ctx as unknown as { on: (e: string, h: (p: unknown) => void) => void }).on(event, handler)
    } catch (err) {
      console.log(`[serenity-hooks] ✗ 无人值守代理未装配（${event} 不可用）: ${String((err as Error)?.message ?? err)}`)
    }
  }

  // ① 真实用户在场的一手信号 + 让位
  on('agent/inbox/claimed', (payload) => {
    try {
      const p = payload as { agent?: unknown; message?: unknown; turn?: unknown }
      const sessionId = sessionIdOf(p?.agent)
      if (sessionId === '') return
      const kind = (p.message as { source?: { kind?: unknown } } | undefined)?.source?.kind
      if (kind !== 'user') return // 插件注入（唤醒 / 打回 / keeper 提醒）不算用户在场
      const turn = typeof p.turn === 'number' ? p.turn : null
      noteUserTurn(sessionId, turn ?? -1)
      // 🔴 单一续驱者：用户一出现 ⇒ 立刻让位（停代理）
      const run = getProxyRun(sessionId)
      if (!run) return
      clearProxyRun(sessionId)
      const root = cccRootForCwd(cwdOf(p.agent))
      if (root) {
        logEvent(sessionOf(p.agent), root, {
          event: 'yield',
          round: run.round,
          nonce: run.nonce,
          reason: 'user-returned',
          sessionId,
        }, Date.now())
      }
      console.log(`[serenity-hooks] unattended: yield — 用户回来了 (session=${sessionId}, round=${run.round})`)
    } catch (err) {
      console.log(`[serenity-hooks] unattended: claimed 观察失败 — ${String((err as Error)?.message ?? err)}`)
    }
  })

  // ② 主体：轮收尾时判定 + 注入
  on('agent/turn-stopping', (payload) => {
    try {
      const p = payload as { agent?: Agent; turn?: number }
      if (!p?.agent) return
      handleTurnStopping(p.agent, typeof p.turn === 'number' ? p.turn : null)
    } catch (err) {
      // 🔴 绝不抛：turn 收尾不可被本机制影响
      console.log(`[serenity-hooks] unattended: turn-stopping 处置失败（已忽略） — ${String((err as Error)?.message ?? err)}`)
    }
  })

  // ③ 生命周期清理（防"按载体只增"）
  on('agent/disposed', (payload) => {
    const sessionId = sessionIdOf((payload as { agent?: unknown })?.agent)
    if (sessionId === '') return
    clearProxyRun(sessionId)
    clearUserTurn(sessionId)
  })
  on('session/disposed', (payload) => {
    const id = (payload as { id?: unknown })?.id
    if (typeof id !== 'string' || id === '') return
    clearProxyRun(id)
    clearUserTurn(id)
  })

  // ④ 插件卸载 / HMR ⇒ 清进程内状态（不碰磁盘）
  registerDisposer(ctx, 'unattended proxy', () => {
    clearUnattendedState()
  })
}

/** 类型再导出（调用方少一处 import） */
export type { Agent as UnattendedAgent }
