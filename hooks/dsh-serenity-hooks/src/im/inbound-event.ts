/**
 * im/inbound-event.ts — **中立入站事件层**（B1，2026-10-19）
 *
 * ## 这一层解决的是什么
 *
 * `handleIncoming` 原先吃的 `msg` 是 **iLink 形状**（`from_user_id` / `context_token` /
 * `item_list` / `message_type`）。飞书的消息形状与它**没有一处相同**，所以接第二家 IM
 * 的真正工作量不在"建连接"，而在**把各家消息归一成同一个东西**。
 *
 * 本文件就是那个"同一个东西"，以及消费它的**通道中立主流程**。
 *
 * ## 切法（为什么这样切，而不是改 `handleIncoming` 的签名）
 *
 * 🔴 实测爆炸半径：全仓 **约 50 处**测试直接驱动 `handleIncoming` 的 iLink 形状。
 * 直接改签名 ⇒ 那 50 处同时要改 ⇒ 而 B1 的验收判据恰恰是「**微信行为逐字不变**」
 * （用例数守恒 ＋ 真机一条微信）。判据自己会失去可复算性。
 *
 * ⇒ 切法是**适配器**：
 *   - 本文件 `handleInboundEvent()` = 真正的主流程，**零 iLink 概念**；
 *   - `bridge.ts` 的 `handleIncoming()` 退化成**薄适配器**：iLink 消息 → 中立事件 + iLink 的 io；
 *   - 飞书实现自己造中立事件 + 飞书的 io，调到**同一个** `handleInboundEvent`。
 *
 * 收益：微信侧调用点与测试**逐字不动**；第二条、第三条 IM 只是**新增一个适配器**。
 *
 * ## 边界（R↓：这层刻意**不**管什么）
 *
 * - ⛔ **不管连接怎么建**（长轮询 vs WebSocket 回调）—— 那是各账号实现自己的事。
 * - ⛔ **不管凭据怎么取** —— `io` 与事件都由实现处构造好再交进来。
 * - ✅ 只负责：「一条已到达的消息，该投到哪条认知轨迹、怎么答、怎么记账」。
 */

import type { Context } from 'cordis'
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { readCheapWorkerConfig } from '../kernel/ccc.js'
import { appendHumanChannelAudit, planInboundRoute, type InboundRoutePlan } from './inbound.js'
import { readSimpleSettings } from '../surface/settings.js'
import { readWeixinSettings, weixinSessionIdForTrajectory, matchWeixinRoute, sanitizeFileName, weixinInboundDir } from './route.js'
import { sniffImageExt, markdownToPlainText } from './ilink.js'
import { readTrajectoryConstraintByCode, type TrajectoryConstraint } from '../trajectory/policy/profile.js'
import { stripThink } from '../surface/text.js'
import {
  createTrajectoryAgent, getTrajectoryAgent, askTrajectory, workspaceCognitiveTrajectoryLine,
  ensureWorkspacePromptSection, trajectoryWorkspaceMdPath,
} from '../trajectory/session.js'
import { noteManualOutputSession, forgetManualOutputSession, clearSentThisTurn, hasSentThisTurn, isWeixinOutputGuardActive } from './guard.js'
import { getActiveSessionInfo } from '../trajectory/core.js'
import { invokeWeixinHook, buildIncomingHookEvent, buildOutgoingHookEvent, type WeixinHookMediaRef } from './hook.js'

// ── 中立事件的形状 ──────────────────────────────────────────────────────────

/**
 * 一条**已到达**的入站消息（归一后）。
 *
 * 刻意只留**主流程真正用到的**字段 —— 每多留一个通道特定的字段，这一层就多一处
 * 需要为两家分别解释的东西（E↓）。
 */
export interface ImInboundEvent {
  /** 发送者在**该通道内**的稳定标识（微信 = from_user_id；飞书 = open_id） */
  userId: string
  /** 正文（含语音转写）。无文本 ⇒ `null` */
  text: string | null
  /** 媒体项（图片/文件）。顺序即到达顺序 */
  media: ImMediaItem[]
  /** 有语音但**没有转写文本**（触发降级告知；与 `text` 同时为空时才有意义） */
  hasVoice: boolean
  /**
   * 回复锚点。微信 = `context_token`（回复必须带上它）；飞书**没有这个概念**
   * ⇒ 可选。⛔ 不要在消费侧假设它一定在。
   */
  replyRef?: string
}

/**
 * 一个媒体项：**取字节的动作由通道自己提供**。
 *
 * 为什么把下载放进事件里，而不是让主流程拿着 `item` 去调 `downloadMedia`：
 * 后者是 iLink 的 CDN 协议，飞书是 `im.v1.messageResource.get` —— 两者除了
 * "返回一堆字节"之外没有任何共同点。⇒ 中立层只约定**取字节这个动作**。
 */
export interface ImMediaItem {
  kind: 'image' | 'file'
  /** 原始文件名（file 才有；**未净化**，净化在落盘侧做） */
  fileName?: string
  /** 取字节；失败/不可得 ⇒ `null`（主流程**降级告知**，不静默） */
  fetch(): Promise<{ data: Buffer; fileName?: string } | null>
}

/**
 * 账号的**动作面**（发消息 / 打字态）。
 *
 * 与 `ImInboundEvent` 成对：进来的是事件，出去的是动作。两者都不含通道协议细节。
 */
export interface ImAccountIo {
  /** 发纯文本（实现内部做各自的长度分片与格式转换） */
  sendText(input: { toUserId: string; text: string; replyRef?: string }): Promise<void>
  /** "正在输入"起始（可实现不了；飞书就没有这个能力） */
  typingStart?(input: { toUserId: string; replyRef?: string }): Promise<void>
  /** "正在输入"结束（异常路径也会调 ⇒ 实现须自行容忍未开始的情形） */
  typingStop?(input: { toUserId: string }): Promise<void>
}

/** 媒体大小上限（M6：20MB，对齐 vlm-describe；超限降级告知不落盘） */
const MEDIA_MAX_BYTES = 20 * 1024 * 1024

// ── 路由（原在 bridge.ts；通道无关，故随主流程一起搬进来）──────────────────

/**
 * 路由解析结果：目标根 ＋ **轨迹编码** ＋ **该轨迹的 轨迹约束面**。
 * `null` 从本函数出去 ⇒ **不投递**（未命中已留痕 ／ 目标不存在已响亮出声）。
 */
export interface ResolvedInboundTarget {
  root: string
  /** 目标认知轨迹编码（= 新模型里的"身份"；旧模型的角色名已退役） */
  trajectory: string
  /**
   * 该轨迹的 轨迹约束面。
   * ⚠️ **可能为 `null`**：轨迹存在但没有 `trajectory-constraint.json` ⇒ 它是一条**普通轨迹**，
   * IM 桥照样可以往里投，只是不施加 轨迹约束 约束。
   */
  profile: TrajectoryConstraint | null
}

/**
 * 订阅表里的 `ccc` **别名 → CCC 根**（P0-3）。
 *
 * 别名取值与面板下拉**同源** ⇒ 先按 `CccEntry.name`（= CCC 根目录名）匹配；
 * 再退一步接受**绝对路径**（手写配置时人会直接粘路径）。两条都试
 * ⇒ 两种写法都可用，且**不引入第二张名字表**。
 */
async function resolveCccRootByAlias(ctx: Context, alias: string): Promise<string | null> {
  try {
    const { listCccs } = await import('../kernel/ccc-roots.js')
    const entries = await listCccs(ctx)
    const byName = entries.find((e) => e.name === alias)
    if (byName) return byName.root
    const byRoot = entries.find((e) => e.root === alias)
    return byRoot ? byRoot.root : null
  } catch {
    // 枚举失败（服务不可用等）⇒ 与"没找到"同处理（响亮报错 + 留痕，由调用方做）
    return null
  }
}

/**
 * **入站路由的单一解析处**（P0-3）：机器级订阅表优先 → CCC 级回退；三档语义都在这里落地。
 *
 * 🔴 为什么抽成一个函数而不是写两遍：**两种模式（CCC 起桥 ／ 机器级起 poller）走的是同一套
 * 判据**，差别只有一格 —— **有没有 CCC 级回退**（`cccFallback`）。写两遍必然分叉。
 *
 * 三档（方案 §3.1，**刻意分档**）：
 *  - **未命中** ⇒ 不投递 ＋ **留痕**（静默档：这是"表里没有你"，不是错误）
 *  - **表残缺** ⇒ **响亮出声**（且**独立于是否命中**）
 *  - **目标不存在**（CCC ／ **轨迹**）⇒ **响亮报错**（不静默丢弃）
 */
export async function resolveInboundTarget(ctx: Context, input: {
  account: string
  user: string
  cccFallback: { root: string; trajectory: string } | null
}): Promise<ResolvedInboundTarget | null> {
  const route: InboundRoutePlan = planInboundRoute({
    subscriptions: readSimpleSettings().humanChannel.subscriptions,
    account: input.account,
    user: input.user,
    // 🔴 回退目标的 `ccc` 装的是**本 CCC 的绝对路径**（不是别名）—— 计划层两种写法都收
    fallback: input.cccFallback ? { ccc: input.cccFallback.root, role: input.cccFallback.trajectory } : null,
  })

  // 表残缺 ⇒ **响亮出声**（与"未命中"分档：笔误必须有人去改）
  for (const defect of route.defects) {
    console.error(
      `[serenity-hooks] ✗ human-channel: 订阅表第 ${defect.index + 1} 行**残缺**（缺 ${defect.missing.join(' / ')}）`
      + `｜已有字段 ${JSON.stringify(defect.present)}｜该行**不生效** —— 请补全或删掉（机器级 humanChannel.subscriptions）`,
    )
    appendHumanChannelAudit({ kind: 'subscription-defect', account: input.account, index: defect.index, missing: defect.missing, present: defect.present })
  }

  const target = route.target
  // ① 未命中 ⇒ **不投递 ＋ 留痕**（**静默档**：这不是错误，是"表里没有你"）
  if (!target) {
    const detail = route.skipReason === 'no-subscription'
      ? '机器级订阅表为空（且无 CCC 级回退）'
      : '订阅表里没有匹配 (账号, 用户) 的行'
    console.warn(`[serenity-hooks] ⚠ human-channel: 入站未命中订阅 ⇒ **不投递**（account=${input.account} user=${input.user}）：${detail}`)
    appendHumanChannelAudit({ kind: 'inbound-unrouted', account: input.account, user: input.user, reason: route.skipReason ?? 'no-match', detail })
    return null
  }

  // ② 目标**不存在** ⇒ **响亮报错**（W5'：**不静默丢弃**）
  // 🔴 回退来源的 `ccc` **就是已知的本 CCC 根** ⇒ 不做枚举查找（省一次 IO）
  const root = route.source === 'ccc-fallback' ? target.ccc : await resolveCccRootByAlias(ctx, target.ccc)
  if (root === null) {
    const detail = `订阅表指向的 CCC "${target.ccc}" 在本机 CCC 枚举里不存在`
    console.error(`[serenity-hooks] ✗ human-channel: ${detail}（account=${input.account} user=${input.user}）—— 该消息**未投递**，请改订阅表`)
    appendHumanChannelAudit({ kind: 'inbound-target-missing', account: input.account, user: input.user, ccc: target.ccc, role: target.role, detail })
    return null
  }
  // ③ 目标**轨迹**不存在 ⇒ 响亮报错。
  // ⚠️ 轨迹存在但没有 `trajectory-constraint.json` **不是错** —— 那只是一条普通轨迹。
  const { findDirNameByCode } = await import('../trajectory/policy/profile.js')
  const dirName = findDirNameByCode(root, target.role)
  if (dirName === null) {
    const detail = `目标 CCC "${target.ccc}" 内没有编码为 "${target.role}" 的认知轨迹`
    console.error(`[serenity-hooks] ✗ human-channel: ${detail}（account=${input.account} user=${input.user}）—— 该消息**未投递**，请改订阅表里的目标编码`)
    appendHumanChannelAudit({ kind: 'inbound-target-missing', account: input.account, user: input.user, ccc: target.ccc, role: target.role, detail })
    return null
  }
  const profile = readTrajectoryConstraintByCode(root, target.role)
  return { root, trajectory: target.role, profile }
}

// ── 中立主流程 ─────────────────────────────────────────────────────────────

/**
 * **一条入站消息的主流程**（通道中立）。
 *
 * 职责：路由 → 固定会话 id 创建/延续 → 提问 → 回复（或被闸门拦下后兜底）。
 * 语料（媒体）由事件自带 `fetch()`；出站走的 `io`。
 *
 * 🔴 **本函数没有任何 iLink 概念** —— 这是 B1 的判据。任何 `context_token` /
 * `item_list` / `message_type` 出现在这里，就说明抽缝没抽干净。
 *
 * @param preset 机器级模式：目标已解析好 ⇒ **不再自行路由**，且**不看本 CCC 的 `enabled`**
 */
export async function handleInboundEvent(
  ctx: Context,
  root: string,
  accountId: string,
  io: ImAccountIo,
  event: ImInboundEvent,
  preset?: { target?: ResolvedInboundTarget; channel?: string },
): Promise<void> {
  /**
   * 🔴 **渠道身份必须穿过本层**（2026-10-20，Q4 出站飞书）。
   *
   * 为什么缺省值是 `'weixin'` 而不是"必填"：本层有 7 处既有测试调用点**逐字不动**
   * （B1 的判据是"微信行为逐字不变"）。⇒ 缺省 = 当时唯一存在的渠道，
   * 而**新增渠道必须显式传**，这样"漏传"只会退化到旧行为，不会把两条渠道搅混。
   *
   * ⚠️ 为什么由**调用方**给而不是从 `accountId` 推：`accountId`（`feishu-1` / `wechat-1`）
   * 只是**命名习惯**，配置里没有任何字段强制它带渠道前缀 —— 从名字推渠道 =
   * 让一个会漂的约定承当判据（D167 同族：认族不认名）。
   */
  const channel = preset?.channel ?? 'weixin'
  const fromUserId = event.userId
  if (!fromUserId) return
  const text = event.text
  const mediaRefs = event.media

  const settings = readWeixinSettings(root)

  // ── 路由：**机器级订阅表优先** → CCC 级 `routes` 回退 ─────────────────────────
  let resolved: ResolvedInboundTarget | null
  // 🔴 判据是 **`preset.target` 在不在**，不是 `preset` 在不在（2026-10-20 Q4 实测踩到）：
  //    飞书 CCC 级路径要传 `{ channel:'feishu' }`（没有 target，让它自己按 routes 路由），
  //    而首版把判据写成 `if (preset)` ⇒ 那条路径会拿到 `resolved = undefined`
  //    ⇒ 被下一行的 `if (!resolved) return` **静默丢掉每一条消息**（零报错）。
  //    ⇒ "机器级模式"的定义是**目标已被解析好**，不是"调用方多传了一个对象"。
  if (preset?.target) {
    resolved = preset.target // 机器级模式：目标已解析（且**不看本 CCC 的 enabled**）
  } else {
    if (!settings.enabled) return
    const cccTarget = matchWeixinRoute(settings.routes ?? [], fromUserId)
    resolved = await resolveInboundTarget(ctx, {
      account: accountId,
      user: fromUserId,
      cccFallback: cccTarget ? { root, trajectory: cccTarget } : null,
    })
  }
  if (!resolved) return // 未命中／目标不存在 ⇒ 已留痕／已出声，两者都**不投递**
  const { trajectory, profile } = resolved
  root = resolved.root

  // 纯语音无转写（无文本无媒体）→ 降级提示（不静默；不创建会话）
  if (!text && mediaRefs.length === 0) {
    if (event.hasVoice) {
      await io.sendText({
        toUserId: fromUserId,
        text: '（抱歉，暂时无法解析这条语音消息，请尝试发送文字）',
        replyRef: event.replyRef,
      }).catch(() => { /* 提示失败不影响 */ })
    }
    return
  }

  try {
    // 🔴 会话 id **由轨迹编码派生**（身份挂在轨迹上，不挂在用户上）。
    const sessionId = weixinSessionIdForTrajectory(trajectory)
    const existing = getTrajectoryAgent(sessionId)
    const hc = readCheapWorkerConfig(root)
    // 无 `trajectory-constraint.json` 的普通轨迹：不施加任何 轨迹约束 约束，用编码造一个最小面立提示词段。
    const effective: TrajectoryConstraint = profile ?? {
      dirName: trajectory,
      code: trajectory,
      path: '',
      tools: [],
      msms: [],
      cognitiveTrajectory: { session: true, keeper: true, rebuild: true },
    }
    const ref = existing
      ? { agent: existing, sessionId, resumed: true }
      : await createTrajectoryAgent(ctx, root, effective, hc?.defaultModel, sessionId)

    if (!ref.resumed) {
      // 真正首次（无持久化历史）→ 通知用户"新对话开始"；resume 不发
      await io.sendText({
        toUserId: fromUserId,
        text: '（新的对话已开始）',
        replyRef: event.replyRef,
      }).catch(() => { /* 通知失败不影响主流程 */ })
    }

    // 正在输入：处理前开始（**含媒体下载**），处理完（含异常路径）结束
    await io.typingStart?.({ toUserId: fromUserId, replyRef: event.replyRef })
    try {
      // 媒体：取字节 → 落盘 → 存在性+路径注入（ACC 层最小闭环）
      const mediaNotes: string[] = []
      const degradedNotes: string[] = []
      const hookMedia: WeixinHookMediaRef[] = []
      for (const mediaRef of mediaRefs) {
        const label = mediaRef.kind === 'image' ? '一张图片' : `文件 ${mediaRef.fileName ?? '(未命名)'}`
        const result = await mediaRef.fetch()
        if (!result) {
          hookMedia.push({ kind: mediaRef.kind, relPath: null })
          degradedNotes.push(`（用户发送了${label}，但下载失败——可请用户重发）`)
          continue
        }
        if (result.data.length > MEDIA_MAX_BYTES) {
          hookMedia.push({ kind: mediaRef.kind, relPath: null })
          degradedNotes.push(`（用户发送了${label}，但超过 20MB 大小限制）`)
          continue
        }
        try {
          const inboundDir = weixinInboundDir(root, fromUserId)
          mkdirSync(inboundDir, { recursive: true })
          const fname = mediaRef.kind === 'image'
            ? `img_${Date.now()}_${randomBytes(4).toString('hex')}.${sniffImageExt(result.data)}`
            : (sanitizeFileName(result.fileName ?? mediaRef.fileName ?? '') || `file_${Date.now()}_${randomBytes(4).toString('hex')}`)
          const abs = join(inboundDir, fname)
          writeFileSync(abs, result.data)
          const rel = relative(root, abs)
          hookMedia.push({ kind: mediaRef.kind, relPath: rel })
          // 注引用**实际保存的文件名**（fname = 净化后）——agent 按 rel 路径找文件，名字须一致
          mediaNotes.push(`（用户发送了${mediaRef.kind === 'image' ? '一张图片' : `文件 ${fname}`}，已保存到 ${rel}）`)
        } catch {
          hookMedia.push({ kind: mediaRef.kind, relPath: null })
          degradedNotes.push('（媒体保存失败，请重试）')
        }
      }

      const parts: string[] = []
      // 工作台 = **该轨迹自己的 SESSION.md**（不再有"自动建一个"这回事）。
      const workspaceMd = trajectoryWorkspaceMdPath(root, sessionId) ?? getActiveSessionInfo(sessionId)?.mdPath ?? null
      if (workspaceMd) {
        const sectionOk = ensureWorkspacePromptSection(ref.agent, sessionId, root)
        if (!sectionOk) parts.push(workspaceCognitiveTrajectoryLine(workspaceMd))
      }
      const manualOutput = settings.autoReplyWithLastMessage === false
      if (text) parts.push(text)
      parts.push(...mediaNotes, ...degradedNotes)
      if (manualOutput) {
        // 本轮开始 → 清空"已发送"标记（闸门只置位；桥在 askTrajectory 后读它决定兜底）
        clearSentThisTurn(sessionId)
        noteManualOutputSession(sessionId, { root, accountId, userId: fromUserId, role: trajectory, channel })
        parts.push(manualOutputMarker(accountId, fromUserId, channel))
      } else {
        forgetManualOutputSession(sessionId)
      }
      const question = parts.join('\n')

      // hook：incoming 事件（用户 → bot）——媒体落盘后、askTrajectory 前 fire。旁路容忍（H3）。
      const hookRel = settings.hook
      if (hookRel) {
        void invokeWeixinHook(root, hookRel, buildIncomingHookEvent({
          cccRoot: root,
          accountId,
          userId: fromUserId,
          sessionId,
          role: trajectory,
          text,
          media: hookMedia,
        })).catch((err) => {
          console.log(`[serenity-hooks] im hook incoming error: ${err instanceof Error ? err.message : String(err)}`)
        })
      }

      const result = await askTrajectory(ctx, ref.agent, question)
      const answer = result.answer ?? ''
      // 手动输出模式——桥不转发最终文本（输出权归 agent）
      if (manualOutput) {
        const fallback = manualOutputFallbackNeeded({
          fallbackOnNoSend: settings.fallbackOnNoSend,
          guardActive: isWeixinOutputGuardActive(),
          sentThisTurn: hasSentThisTurn(sessionId),
          answer,
        })
        if (!fallback) return
        const reply = markdownToPlainText(stripThink(answer))
        await io.sendText({ toUserId: fromUserId, text: reply, replyRef: event.replyRef })
        console.warn(
          `[serenity-hooks] ⚠ im 输出兜底：agent 本轮未发送（闸门打回用尽）→ 桥转发最终文本（session=${sessionId}, trajectory=${trajectory}）`,
        )
        if (hookRel) {
          void invokeWeixinHook(root, hookRel, buildOutgoingHookEvent({
            cccRoot: root,
            accountId,
            userId: fromUserId,
            sessionId,
            role: trajectory,
            reply,
            source: 'reply-fallback',
          })).catch((err) => {
            console.log(`[serenity-hooks] im hook outgoing(reply-fallback) error: ${err instanceof Error ? err.message : String(err)}`)
          })
        }
        return
      }
      if (answer === '') return

      const reply = markdownToPlainText(stripThink(answer))
      await io.sendText({ toUserId: fromUserId, text: reply, replyRef: event.replyRef })

      // hook：outgoing 事件——发送成功后 fire（发送失败不记录——从未送达的回复无记录价值）
      if (hookRel) {
        void invokeWeixinHook(root, hookRel, buildOutgoingHookEvent({
          cccRoot: root,
          accountId,
          userId: fromUserId,
          sessionId,
          role: trajectory,
          reply,
        })).catch((err) => {
          console.log(`[serenity-hooks] im hook outgoing error: ${err instanceof Error ? err.message : String(err)}`)
        })
      }
    } finally {
      await io.typingStop?.({ toUserId: fromUserId })
    }
  } catch (err) {
    // 桥错误静默（日志可见；不中断轮询循环）——含堆栈（诊断 resume 失败路径）
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[serenity-hooks] im-bridge error (ccc=${root}): ${msg}`)
    const stack = err instanceof Error ? err.stack : undefined
    if (stack) console.log(`[serenity-hooks] im-bridge stack:\n${stack.slice(0, 1500)}`)
  }
}

// ── 与通道无关、但被主流程用到的那个标记 ───────────────────────────────────

/**
 * 手动输出模式的**机制标记**（v1.30.10 引入；v1.30.16 按「ACC 管机制、CCC 管措辞」重构）。
 *
 * 边界（R↓）：ACC 只提供**机制与数据**——"桥不转发最终文本"这个事实 + 三个已填好的参数值。
 * **纪律措辞归 CCC**：怎么写、必须怎么做、后果是什么，全部写在轨迹的 `PROMPT.md` 里。
 *
 * 🔴 **渠道不是常量**（2026-10-20 Q4）：此前这里硬写 `channel:"weixin"`，
 * 而一条**飞书**会话收到的却是"发往微信"的命令 ⇒ 模型照着做必然失败（目标 id 是 open_id）。
 * ⇒ 渠道由调用方传入；缺省 `'weixin'` 保留既有调用点与测试的读数。
 */
export function manualOutputMarker(accountId: string, userId: string, channel = 'weixin'): string {
  return [
    '[serenity:weixin-manual-output]',
    `im-bridge({channel:"${channel}", action:"send", account:"${accountId}", user:"${userId}", text:"<回复>"})`,
  ].join('\n')
}

/**
 * 手动输出模式的**兜底判定**（纯函数，v1.30.17——把决策矩阵从装配里抽出来，可独立测试）。
 *
 * 四个条件同时成立才兜底：
 * ① CCC 显式开启 `fallbackOnNoSend`（缺省 false = 严格静默）
 * ② 机械闸门**已装配**（未装配时无法判定"是否发送过" → 宁可静默也不冒重复发送风险）
 * ③ 本轮**没有**成功发送（agent 自己发过 → 输出权归 agent，桥不插话）
 * ④ 有最终文本可转发（空文本无意义）
 */
export function manualOutputFallbackNeeded(input: {
  fallbackOnNoSend?: boolean
  guardActive: boolean
  sentThisTurn: boolean
  answer: string
}): boolean {
  return input.fallbackOnNoSend === true && input.guardActive && !input.sentThisTurn && input.answer !== ''
}
