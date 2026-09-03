/**
 * weixin-bridge.ts — 微信桥装配（F4c-3，v1.27.0 实验性）
 *
 * **CCC 级**：dsh 一个进程含多个 CCC，每个 CCC 独立对接微信桥（S142 用户拍板）——
 * 扫描 live CCC → 每 CCC 读 weixin 配置（enabled + accounts + routes）→
 * 启动该 CCC 该账号的 iLink 轮询循环。消息 → weixin-route 路由 → AcpServer 直调
 * （session/new + session/prompt，同进程不经网络——acp-core 传输无关设计）。
 *
 * 实验性质：未配置/未启用 → 完全不启动（零资源占用）。配置变化（面板写入）
 * → 热重建受影响 CCC 的桥（对齐 gateway 热重建模式）。
 *
 * 外部面纯净（D9/D11 延续）：微信桥会话 = 外部面——session/prompt 走
 * includeTrajectory:false（对外不返回轨迹）；skiff 角色白名单即授权（G9）。
 */

import type { Context } from 'cordis'
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { findSerenityRoot, readHandymanConfig } from './ccc.js'
import { readWeixinSettings, readWeixinCredential, weixinSessionIdFor, matchWeixinRoute, extractWeixinText, hasVoiceItem, extractWeixinMedia, sanitizeFileName, weixinInboundDir, type WeixinAccountCredential } from './weixin-route.js'
import { getUpdates, sendTextMessage, getConfig, sendTyping, TypingStatus, downloadMedia, sniffImageExt, markdownToPlainText, type WeixinMessage } from './weixin-api.js'
import { readSkiffRoles } from './skiff-role.js'
import { stripThink } from './skiff-debug.js'
import { createSkiffAgent, getSkiffAgent, askSkiff } from './skiff-core.js'
import { invokeWeixinHook, buildIncomingHookEvent, buildOutgoingHookEvent, type WeixinHookMediaRef } from './weixin-hook.js'

/** 运行中的桥（CCC 根 → 账号 id → 循环控制） */
interface AccountLoop {
  /** 停止信号（dispose 时置 true；循环每轮检查） */
  stopped: boolean
  /** 最近轮询开始时间（状态面板用） */
  lastPollAt: number
  /** 最近错误（状态面板用） */
  lastError?: string
}

interface CccBridge {
  root: string
  /** 账号 id → 循环 */
  loops: Map<string, AccountLoop>
}

const bridges = new Map<string, CccBridge>()

/** 轮询间隔（getupdates 失败后重试延迟；成功 = 立即续轮询） */
const POLL_RETRY_MS = 3_000

/** 媒体大小上限（M6：20MB，对齐 vlm-describe；超限降级告知不落盘） */
const MEDIA_MAX_BYTES = 20 * 1024 * 1024

/** typing_ticket 缓存（每 (accountId, fromUserId)；getconfig 一次后续复用——对齐参考实现 typingTicketCache） */
const typingTicketByUser = new Map<string, string>()

function typingCacheKey(accountId: string, fromUserId: string): string {
  return `${accountId}|${fromUserId}`
}

/** 处理开始：getconfig（无缓存时）→ sendtyping status=1（微信侧显示"正在输入..."）。
 *  任何失败静默（typing 不影响主流程——对齐参考实现 typingCallbacks try/catch 吞错）。 */
async function sendTypingStart(cred: WeixinAccountCredential, accountId: string, fromUserId: string, contextToken?: string): Promise<void> {
  try {
    const key = typingCacheKey(accountId, fromUserId)
    let ticket = typingTicketByUser.get(key)
    if (!ticket) {
      const configResp = await getConfig({
        baseUrl: cred.baseUrl,
        token: cred.token,
        ilinkUserId: fromUserId,
        contextToken: contextToken ?? '',
      })
      ticket = configResp.typing_ticket
      if (ticket) typingTicketByUser.set(key, ticket)
    }
    if (!ticket) return
    await sendTyping({ baseUrl: cred.baseUrl, token: cred.token, ilinkUserId: fromUserId, typingTicket: ticket, status: TypingStatus.TYPING })
  } catch (err) {
    console.log(`[serenity-hooks] weixin-bridge typing start skipped: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 处理结束（含异常路径 finally）：sendtyping status=0；缓存保留（ticket 可复用）。 */
async function sendTypingStop(cred: WeixinAccountCredential, accountId: string, fromUserId: string): Promise<void> {
  try {
    const ticket = typingTicketByUser.get(typingCacheKey(accountId, fromUserId))
    if (!ticket) return
    await sendTyping({ baseUrl: cred.baseUrl, token: cred.token, ilinkUserId: fromUserId, typingTicket: ticket, status: TypingStatus.CANCEL })
  } catch (err) {
    console.log(`[serenity-hooks] weixin-bridge typing stop skipped: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 测试辅助：清空 typing_ticket 缓存（生产零调用） */
export function resetWeixinTypingCache(): void {
  typingTicketByUser.clear()
}

/** 单账号轮询循环：getupdates 长轮询 → 逐消息分发 → 回复回写 */
async function runAccountLoop(
  ctx: Context,
  root: string,
  accountId: string,
  cred: WeixinAccountCredential,
  loop: AccountLoop,
): Promise<void> {
  let buf = ''
  while (!loop.stopped) {
    loop.lastPollAt = Date.now()
    try {
      const resp = await getUpdates({
        baseUrl: cred.baseUrl,
        token: cred.token,
        getUpdatesBuf: buf,
        timeoutMs: 35_000,
      })
      buf = resp.get_updates_buf ?? buf
      for (const msg of resp.msgs ?? []) {
        if (loop.stopped) break
        // 只处理用户消息（message_type=1）——忽略 bot 自己/系统消息
        if (msg.message_type !== 1) continue
        await handleIncoming(ctx, root, accountId, cred, msg)
      }
      // 成功 → 立即续轮询（不 sleep；长轮询本身 hold 35s）
    } catch (err) {
      loop.lastError = err instanceof Error ? err.message : String(err)
      // 失败 → 指数退避重试（对齐 orbit/ws 模式）
      await new Promise((r) => setTimeout(r, POLL_RETRY_MS))
    }
  }
}

/**
 * 处理单条微信消息：路由 → skiff 会话（固定 id 创建/延续）→ 提问 → 回复回写。
 *
 * 会话语义：`weixinSessionIdFor(fromUserId)` 固定可重建——同用户长期同一会话；
 * 进程内已有（getSkiffAgent 命中）→ 延续；无（首次/进程重启）→ createSkiffAgent
 * 固定 id resume-or-create（v1.27.2）：磁盘已有持久化 log → resume（历史延续，
 * 重启后记忆保留——真正的"同用户长期延续"）；无 log（首次）→ create。
 * "新的对话已开始"通知仅真正首次（create）时发送；resume/进程内延续不发。
 *
 * 完善（v1.27.3）：
 * - **语音支持**：`voice_item.text` = 微信服务端自带语音转写 → 与文本同路径进对话
 *   （无需下载/ASR）；语音无转写 → 降级提示"暂时无法解析"
 * - **正在输入**：处理前 sendtyping 1（微信显示"正在输入..."），处理后（含异常）0
 * - **媒体接收（图片/文件）**：桥侧 CDN 下载 + AES 解密 → 落盘 CCC 根
 *   `_tmp/weixin-inbound/<userhash>/` → question 注入「存在性 + 路径」（ACC 层只保证
 *   可达性——"让会话知道文件的存在并可以拿到"；识别/解析归角色 LLM 决策，不编排）。
 *   降级不静默：下载失败 / 超 20MB → 注入说明进对话；typing 窗口覆盖下载（M7）。
 */
export async function handleIncoming(
  ctx: Context,
  root: string,
  accountId: string,
  cred: WeixinAccountCredential,
  msg: Pick<WeixinMessage, 'from_user_id' | 'context_token' | 'item_list'>,
): Promise<void> {
  const fromUserId = msg.from_user_id
  if (!fromUserId) return
  const text = extractWeixinText(msg)
  const mediaRefs = extractWeixinMedia(msg)

  const settings = readWeixinSettings(root)
  if (!settings.enabled) return
  const roleName = matchWeixinRoute(settings.routes ?? [], fromUserId)
  if (!roleName) return // 无路由 → 不回复（未配置该用户）

  // 纯语音无转写（无文本无媒体）→ 降级提示（不静默；不创建会话）
  if (!text && mediaRefs.length === 0) {
    if (hasVoiceItem(msg)) {
      await sendTextMessage({
        baseUrl: cred.baseUrl,
        token: cred.token,
        toUserId: fromUserId,
        text: '（抱歉，暂时无法解析这条语音消息，请尝试发送文字）',
        contextToken: msg.context_token,
      }).catch(() => { /* 提示失败不影响 */ })
    }
    return
  }

  try {
    const role = readSkiffRoles(root).get(roleName)
    if (!role) {
      console.log(`[serenity-hooks] weixin-bridge: 路由命中角色 "${roleName}" 但该 CCC 未定义（检查 skiff.roles）`)
      return
    }
    const sessionId = weixinSessionIdFor(fromUserId)
    const existing = getSkiffAgent(sessionId)
    const hc = readHandymanConfig(root)
    const ref = existing
      ? { agent: existing, sessionId, resumed: true }
      : await createSkiffAgent(ctx, root, roleName, role, hc?.defaultModel, sessionId)

    if (!ref.resumed) {
      // 真正首次（无持久化历史）→ 通知用户"新对话开始"（对齐 3100 问答页行为）；
      // resume（历史延续）不发——用户记得之前的对话
      await sendTextMessage({
        baseUrl: cred.baseUrl,
        token: cred.token,
        toUserId: fromUserId,
        text: '（新的对话已开始）',
        contextToken: msg.context_token,
      }).catch(() => { /* 通知失败不影响主流程 */ })
    }

    // 正在输入：处理前开始（**含媒体下载**——M7 用户等待时显示状态），处理完（含异常路径）结束
    await sendTypingStart(cred, accountId, fromUserId, msg.context_token)
    try {
      // 媒体：下载 → 落盘 → 存在性+路径注入（ACC 层最小闭环；M1/M2/M3/M4/M6）
      const mediaNotes: string[] = []
      const degradedNotes: string[] = []
      // hook 事件媒体列表（v1.27.13：成功带 relPath，失败 null——CCC 记录侧可完整审计）
      const hookMedia: WeixinHookMediaRef[] = []
      for (const mediaRef of mediaRefs) {
        const mediaType = mediaRef.kind === 'image' ? 'image_item' : 'file_item'
        const label = mediaRef.kind === 'image' ? '一张图片' : `文件 ${mediaRef.fileName ?? '(未命名)'}`
        const result = await downloadMedia({ item: mediaRef.item, mediaType })
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
            : (sanitizeFileName(result.fileName ?? '') || `file_${Date.now()}_${randomBytes(4).toString('hex')}`)
          const abs = join(inboundDir, fname)
          writeFileSync(abs, result.data)
          const rel = relative(root, abs)
          hookMedia.push({ kind: mediaRef.kind, relPath: rel })
          // 注引用**实际保存的文件名**（fname = 净化后）——agent 按 rel 路径找文件，名字须一致
          mediaNotes.push(`（用户发送了${mediaRef.kind === 'image' ? '一张图片' : `文件 ${fname}`}，已保存到 ${rel}）`)
        } catch {
          hookMedia.push({ kind: mediaRef.kind, relPath: null })
          degradedNotes.push(`（媒体保存失败，请重试）`)
        }
      }

      // question = 原文 + 媒体存在性注入 + 降级说明（不做内容转述/工具引导——M3）
      const parts: string[] = []
      if (text) parts.push(text)
      parts.push(...mediaNotes, ...degradedNotes)
      const question = parts.join('\n')

      // hook：incoming 事件（用户 → bot）——媒体落盘后、askSkiff 前 fire。
      // 旁路容忍（H3）：异步 fire-and-forget，失败仅日志——不阻塞对话处理。
      const hookRel = settings.hook
      if (hookRel) {
        void invokeWeixinHook(root, hookRel, buildIncomingHookEvent({
          cccRoot: root,
          accountId,
          userId: fromUserId,
          sessionId,
          role: roleName,
          text,
          media: hookMedia,
        })).catch((err) => {
          console.log(`[serenity-hooks] weixin hook incoming error: ${err instanceof Error ? err.message : String(err)}`)
        })
      }

      const result = await askSkiff(ctx, ref.agent, question, undefined, { includeTrajectory: false })
      const answer = result.answer ?? ''
      if (answer === '') return

      // 回复文本：stripThink 剥离 <think> 块（微信桥用户反馈：用户不应看到思考过程）→
      // md→plain 转微信可见纯文本（sendTextMessage 内置同款转换——hook 记录与用户实际收到一致）
      const reply = markdownToPlainText(stripThink(answer))
      await sendTextMessage({
        baseUrl: cred.baseUrl,
        token: cred.token,
        toUserId: fromUserId,
        text: reply,
        contextToken: msg.context_token,
      })

      // hook：outgoing 事件（bot → 用户）——发送成功后 fire（发送失败不记录——从未送达的回复无记录价值）
      if (hookRel) {
        void invokeWeixinHook(root, hookRel, buildOutgoingHookEvent({
          cccRoot: root,
          accountId,
          userId: fromUserId,
          sessionId,
          role: roleName,
          reply,
        })).catch((err) => {
          console.log(`[serenity-hooks] weixin hook outgoing error: ${err instanceof Error ? err.message : String(err)}`)
        })
      }
    } finally {
      await sendTypingStop(cred, accountId, fromUserId)
    }
  } catch (err) {
    // 桥错误静默（日志可见；不中断轮询循环）——含堆栈（v1.27.2 诊断 resume 失败路径）
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[serenity-hooks] weixin-bridge error (ccc=${root}): ${msg}`)
    const stack = err instanceof Error ? err.stack : undefined
    if (stack) console.log(`[serenity-hooks] weixin-bridge stack:\n${stack.slice(0, 1500)}`)
  }
}

/**
 * 启动/重建某 CCC 的桥：读配置 → 对每个 enabled + 有凭据的账号启动轮询循环。
 * 已存在（配置变化热重建）→ 先停旧循环再启动新的。
 */
export function syncCccBridge(ctx: Context, root: string): void {
  const existing = bridges.get(root)
  if (existing) {
    for (const loop of existing.loops.values()) loop.stopped = true
    bridges.delete(root)
  }

  const settings = readWeixinSettings(root)
  if (!settings.enabled) return

  const bridge: CccBridge = { root, loops: new Map() }
  for (const account of settings.accounts ?? []) {
    if (account.enabled === false) continue
    const cred = readWeixinCredential(root, account.accountId)
    if (!cred) continue // 无凭据（未扫码绑定）→ 跳过
    const loop: AccountLoop = { stopped: false, lastPollAt: 0 }
    bridge.loops.set(account.accountId, loop)
    void runAccountLoop(ctx, root, account.accountId, cred, loop)
  }
  if (bridge.loops.size > 0) {
    bridges.set(root, bridge)
    console.log(`[serenity-hooks] ✓ weixin-bridge: ccc=${root} accounts=${[...bridge.loops.keys()].join(',')}`)
  }
}

/** 停止某 CCC 的桥（移除账号/禁用时） */
export function stopCccBridge(root: string): void {
  const bridge = bridges.get(root)
  if (!bridge) return
  for (const loop of bridge.loops.values()) loop.stopped = true
  bridges.delete(root)
}

/** 停止全部桥（插件 dispose） */
export function stopAllBridges(): void {
  for (const bridge of bridges.values()) {
    for (const loop of bridge.loops.values()) loop.stopped = true
  }
  bridges.clear()
}

/** 桥状态快照（面板数据源）：每 CCC → 每账号 → 轮询健康 */
export function weixinBridgeStatus(): Array<{
  ccc: string
  accounts: Array<{ accountId: string; lastPollAt: number; lastError?: string }>
}> {
  const out: Array<{ ccc: string; accounts: Array<{ accountId: string; lastPollAt: number; lastError?: string }> }> = []
  for (const [root, bridge] of bridges) {
    out.push({
      ccc: root,
      accounts: [...bridge.loops.entries()].map(([accountId, loop]) => ({
        accountId,
        lastPollAt: loop.lastPollAt,
        ...(loop.lastError ? { lastError: loop.lastError } : {}),
      })),
    })
  }
  return out
}

/**
 * 装配（index.ts 调用）：扫描 live CCC 启动桥 + 监听会话变化。
 * 事件驱动（对齐 autotrajectory v1.26.15）：live 会话出现 → 同步该 CCC 桥。
 */
export function registerWeixinBridge(ctx: Context): void {
  const syncFromLive = (): void => {
    try {
      const sessions = (ctx.sessions as unknown as { list?: () => Array<{ header?: { cwd?: string } }> } | undefined)
      const cwds = (sessions?.list?.() ?? []).map((s) => s.header?.cwd ?? '').filter(Boolean)
      const roots = [...new Set(cwds.map((c) => findSerenityRoot(c))).values()].filter((r): r is string => r !== null)
      // 未配置的 CCC 不启动（syncCccBridge 内部判断 enabled）
      for (const root of roots) syncCccBridge(ctx, root)
    } catch {
      /* 扫描失败忽略 */
    }
  }

  syncFromLive()

  // 会话创建/关闭 → 重扫（新 CCC 出现即启动其桥；配置变化也可经此路径热重建）
  try {
    ctx.on('session/created', () => syncFromLive())
  } catch {
    /* 事件监听失败不阻断（桥仍可按需启动） */
  }
}
