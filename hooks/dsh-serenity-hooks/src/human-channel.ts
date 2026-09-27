/**
 * human-channel.ts — 人机信道的**机制层**（机器级；2026-09-26 owner 定案 ⇒ 方案 §2.6）
 *
 * ## 为什么单独一个模块（方案 §5-12）
 * 今天"机制"与"渠道实现"混在 `weixin-bridge.ts` 里。P0-2 要立的这条不变量是**机器级**的 ——
 * 它**跨 CCC**、且与"微信"无关（飞书桥／邮件桥同样要守）⇒ 抽到这里；`weixin-bridge` 只做接线。
 *
 * ## 本模块唯一的不变量
 * 🔴 **一账号一 poller**：同一个**账号**（= 同一个 bot 身份）在**同一时刻只有一个轮询者**。
 * 今天的形态是"**按 CCC 起桥**"（`for entry of listCccs ⇒ syncCccBridge`）⇒ 若两个 CCC 各自
 * 配了**同一个**微信账号（同一份凭据），就会**两处轮询同一条消息** ⇒ 重复投递 ＋ 重复落盘
 * （方案 §3.6 的"顺带解决"就是这一条）。
 *
 * ## 🔴 账号的"身份"是什么（本模块最容易写错的一处）
 * **不是 `accountId`** —— 它是**每 CCC 的本地标签**（今天两处都叫 `wechat-1` 完全可能是两个
 * 不同的微信号）。跨 CCC 能辨认同一个 bot 的**唯一**依据是**凭据内容**（token）。
 * ⇒ `accountIdentity()` 以 **token 的哈希**为身份；**没有 token** 时才退回
 * `ccc:<root>|<accountId>`（那时身份里带了 root ⇒ 跨 CCC 不可能撞车，也就不会误判成"同一账号"）。
 *
 * ## 边界
 * 本模块**只做归属判定**（谁能起、谁被谁占着），**不碰**：轮询循环、凭据解析、路由投递。
 * 那些留在 `weixin-bridge.ts`（渠道实现）—— 归属是机制，实现是渠道。
 */

import { createHash } from 'node:crypto'

/** 一个"想为该账号起 poller"的请求（来自某 CCC） */
export interface PollerRequest {
  /** 发起方 CCC 根（绝对路径） */
  root: string
  /** 该 CCC 本地账号键 */
  accountId: string
  /** 账号的**机器级身份**（由 `accountIdentity()` 算得） */
  identity: string
}

/** 账号当前的拥有者 */
export interface AccountOwner {
  root: string
  accountId: string
}

/** 已归属表（identity → 拥有者）；只读视图，供判定用 */
export type AccountOwners = ReadonlyMap<string, AccountOwner>

export interface PollerClaimPlan {
  /** 可以起 poller 的请求（去重后） */
  claims: PollerRequest[]
  /** 被跳过者 ＋ **谁占着**（供响亮登记：被跳过不能是静默的） */
  skipped: Array<{ request: PollerRequest; ownedBy: AccountOwner }>
}

/**
 * 算账号的**机器级身份**。
 *
 * - 有 token ⇒ `token:<sha256 前 16 位>`（**跨 CCC 可辨同一 bot**；不落原文，日志/状态面可安全展示）
 * - 无 token（未扫码绑定等）⇒ `ccc:<root>|<accountId>`（**退化为每 CCC 唯一** ⇒ 不会误判撞车）
 * @param root CCC 根
 * @param accountId 该 CCC 本地账号键
 * @param token 凭据 token（可缺省）
 */
export function accountIdentity(root: string, accountId: string, token: string | undefined): string {
  const t = (token ?? '').trim()
  if (t !== '') return `token:${createHash('sha256').update(t).digest('hex').slice(0, 16)}`
  return `ccc:${root}|${accountId}`
}

/**
 * 归属判定（**纯函数**：不改任何状态）。
 *
 * 规则三条（**同批**与**跨批**刻意用不同判据，别合并——合并会放过"同一 CCC 里两个本地键绑同一个 bot"）：
 *  ① **同批**内同身份重复 ⇒ **一律跳过**（后者）—— 与是哪个 CCC 无关。实例：某 CCC 的账号表里
 *     `wechat-1` 与 `wechat-2` 绑的是同一个 bot ⇒ 若豁免"自己"，它就会为同一个 bot 起**两个**循环。
 *  ② 身份已被**别的** CCC 占着 ⇒ 跳过（记 `ownedBy`）—— 这就是"一账号一 poller"的主判据。
 *  ③ 身份被**自己**占着 ⇒ **照常 claim**（热重建语义：`syncCccBridge` 会先释放自己的旧归属再重新
 *     claim；把"自己占着"也判成冲突会让**配置一变就再也起不来**）。
 * @param requests 本批请求（顺序即优先级：先到先得）
 * @param owners 当前归属表（`pollerOwners()`）
 */
export function planPollerClaims(requests: readonly PollerRequest[], owners: AccountOwners): PollerClaimPlan {
  const claims: PollerRequest[] = []
  const skipped: Array<{ request: PollerRequest; ownedBy: AccountOwner }> = []
  /** 本批占位（判据 ①：不带"自己"豁免） */
  const batch = new Map<string, AccountOwner>()
  for (const request of requests) {
    const inBatch = batch.get(request.identity)
    if (inBatch) {
      skipped.push({ request, ownedBy: inBatch })
      continue
    }
    const existing = owners.get(request.identity)
    if (existing && existing.root !== request.root) {
      skipped.push({ request, ownedBy: existing })
      continue
    }
    batch.set(request.identity, { root: request.root, accountId: request.accountId })
    claims.push(request)
  }
  return { claims, skipped }
}

// ── 归属表（进程级；与 `bridges` 同生命周期）──────────────────────────────────────

const owners = new Map<string, AccountOwner>()

/** 当前归属表（只读视图；供判定与状态面用） */
export function pollerOwners(): AccountOwners {
  return owners
}

/** 落实一批 claim（调用方在**真正起了 poller 之后**调它） */
export function commitPollerClaims(plan: PollerClaimPlan): void {
  for (const claim of plan.claims) owners.set(claim.identity, { root: claim.root, accountId: claim.accountId })
}

/**
 * 释放某 CCC 的**全部**归属（热重建/停止时先调它，再重新 claim）。
 *
 * 🔴 为什么"先全放再 claim"是安全的：`syncCccBridge` 内这一段是**同步**的（中间没有 await）
 * ⇒ 不存在"刚放开就被别人抢走"的窗口；且**别人**在这次调用里本来就抢不到（它的请求会被
 * 判成"被 <本 CCC> 占着"而跳过）⇒ 归属**粘在本 CCC**，不会在两个 CCC 之间来回漂。
 * @param root 要释放的 CCC 根
 * @returns 被释放的身份数（日志/判据用）
 */
export function releasePollersOf(root: string): number {
  let released = 0
  for (const [identity, owner] of [...owners]) {
    if (owner.root === root) {
      owners.delete(identity)
      released++
    }
  }
  return released
}

/** 清空归属表（插件 dispose） */
export function releaseAllPollers(): void {
  owners.clear()
}

/** 测试专用：复位进程级归属表（生产零调用） */
export function __resetPollersForTest(): void {
  owners.clear()
}
