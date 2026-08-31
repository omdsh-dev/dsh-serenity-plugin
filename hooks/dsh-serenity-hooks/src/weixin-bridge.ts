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
import { findSerenityRoot, readHandymanConfig } from './ccc.js'
import { readWeixinSettings, readWeixinCredential, weixinSessionIdFor, matchWeixinRoute, extractWeixinText, type WeixinAccountCredential } from './weixin-route.js'
import { getUpdates, sendTextMessage } from './weixin-api.js'
import { readSkiffRoles } from './skiff-role.js'
import { createSkiffAgent, getSkiffAgent, askSkiff } from './skiff-core.js'

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
 * 以固定 id 新建（角色不变，记忆从新开始——重启后自动重建，与 3100 问答页同语义）。
 */
export async function handleIncoming(
  ctx: Context,
  root: string,
  _accountId: string,
  cred: WeixinAccountCredential,
  msg: { from_user_id?: string; context_token?: string; item_list?: Array<{ type?: number; text_item?: { text?: string } }> },
): Promise<void> {
  const fromUserId = msg.from_user_id
  if (!fromUserId) return
  // P1 只处理文本（媒体消息 → 忽略；P3 扩展）
  const text = extractWeixinText(msg)
  if (!text) return

  const settings = readWeixinSettings(root)
  if (!settings.enabled) return
  const roleName = matchWeixinRoute(settings.routes ?? [], fromUserId)
  if (!roleName) return // 无路由 → 不回复（未配置该用户）

  try {
    const role = readSkiffRoles(root).get(roleName)
    if (!role) {
      console.log(`[serenity-hooks] weixin-bridge: 路由命中角色 "${roleName}" 但该 CCC 未定义（检查 skiff.roles）`)
      return
    }
    const sessionId = weixinSessionIdFor(fromUserId)
    const existing = getSkiffAgent(sessionId)
    const recreated = !existing
    const hc = readHandymanConfig(root)
    const ref = existing
      ? { agent: existing, sessionId }
      : await createSkiffAgent(ctx, root, roleName, role, hc?.defaultModel, sessionId)

    if (recreated) {
      // 首次/重启后新会话 → 通知用户"新对话开始"（对齐 3100 问答页行为）
      await sendTextMessage({
        baseUrl: cred.baseUrl,
        token: cred.token,
        toUserId: fromUserId,
        text: '（新的对话已开始）',
        contextToken: msg.context_token,
      }).catch(() => { /* 通知失败不影响主流程 */ })
    }

    const result = await askSkiff(ctx, ref.agent, text, undefined, { includeTrajectory: false })
    const answer = result.answer ?? ''
    if (answer === '') return

    // 回复回写（必须回带 context_token 关联对话；md→plain 由 sendTextMessage 内置）
    await sendTextMessage({
      baseUrl: cred.baseUrl,
      token: cred.token,
      toUserId: fromUserId,
      text: answer,
      contextToken: msg.context_token,
    })
  } catch (err) {
    // 桥错误静默（日志可见；不中断轮询循环）
    console.log(`[serenity-hooks] weixin-bridge error (ccc=${root}): ${err instanceof Error ? err.message : String(err)}`)
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
