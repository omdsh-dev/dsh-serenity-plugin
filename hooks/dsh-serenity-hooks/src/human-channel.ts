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
 * 本模块做三件事（**都属机制**，与"哪个渠道"无关）：
 *  ① **归属判定**（P0-2：谁能起 poller、谁被谁占着）—— 见下 §归属判定
 *  ② **订阅表查询 ＋ 入站路由决策**（P0-3：`(账号, 用户) → (CCC, 角色)`）—— 见 §订阅表
 *  ③ **机器级留痕**（P0-3：未投递 ／ 目标不存在 ／ 表残缺）—— 见 §留痕。
 *     🔴 为什么这些必须机器级：它们**没有目标 CCC** ⇒ 落进任何 CCC 都是"编一个"目标。
 * **不碰**：轮询循环、凭据解析、会话投递 —— 那些是**渠道实现**，留在 `weixin-bridge.ts`。
 * ⇒ 本模块**零 DSH 依赖**（只有 `node:crypto` ／ `node:fs`），可独立单测。
 */

import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
// 只取**类型**（`import type` 编译期擦除 ⇒ 运行时零依赖、无环风险）：
// 订阅行的形状由读取面（settings-section）定义，本模块**不复制**一份（单真相源）。
import type { HumanChannelSubscriptionSettings } from './settings-section.js'

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

// ── 订阅表（机器级 `(账号, 用户) → (CCC, 角色)`；P0-3）────────────────────────────
// 设计全文 = 插件仓 `docs/human-channel-plan.md` §2.2（表形状）／§3.1（入站）／§11.4（P0-3）。
//
// 🔴 **本段是纯函数**（不读盘、不查 CCC 是否存在）—— 两档语义必须分开，别合并：
//   · **未命中** = "表里没有你" ⇒ **静默**（不投递 ＋ 留痕）—— 方案 §3.1
//   · **表残缺** = "表本身写错了" ⇒ **响亮出声** —— 方案 §3.1「命中但角色/CCC 不存在」同族
//   合并的后果：一处笔误会被读成"这个人没订阅"，于是**没人会去改那个笔误**。
//   目标**存在性**（CCC 在不在 ／ 角色定义没定义）要读盘 ⇒ 归运行时（`weixin-bridge.ts`）。

/** 订阅表里**完好**的一行（四个字段全部非空） */
export interface SubscriptionHit {
  account: string
  user: string
  ccc: string
  role: string
}

/**
 * 订阅表里的**残缺行**（缺字段）。
 * 🔴 它**不是**"未命中"（见上）；且**与是否命中无关** —— 表里只要有残缺行就要出声，
 * 否则"命中了一条完好的"会让人以为整张表是干净的。
 */
export interface SubscriptionDefect {
  /** 行序（0 基）—— 报错要指得出是**哪一行** */
  index: number
  /** 缺哪些字段（`account` ／ `user` ／ `ccc` ／ `role`） */
  missing: string[]
  /** 行里**已有**的字段（残缺行的可见部分：让人认得出是哪一行） */
  present: Record<string, string>
}

export interface SubscriptionLookup {
  /** 命中的行（未命中 ⇒ `null`） */
  hit: SubscriptionHit | null
  /** 表里残缺的行（**与是否命中无关**，一律要出声） */
  defects: SubscriptionDefect[]
  /** 表里**完好**的行数（供调用方区分"表是空的"与"表里没有你"） */
  usable: number
}

/** 订阅行的四个字段（顺序即报错里的字段顺序） */
const SUBSCRIPTION_FIELDS = ['account', 'user', 'ccc', 'role'] as const

/**
 * 订阅表查询（**纯函数**）。
 *
 * 匹配两段式（**刻意对齐**旧 `matchWeixinRoute` 的 exact → `*` 兜底）：
 *  ① `account` **精确** ∧ `user` **精确**
 *  ② `account` **精确** ∧ `user === '*'`（通配兜底）
 * 🔴 `account` **不设通配**：它是机器级账号的**显式身份**（表里写的就是账号 id）；
 *   给账号也开 `*` 会让"这条订阅到底覆盖哪个 bot"变得不可读。
 * 🔴 `user` 保留 `*`：这是**有意的**——存量 CCC 级 `routes` 用的就是 `{user:'*'}`，
 *   迁移（P0-4）要能**逐字平移**它，否则"迁移"会悄悄改变行为。
 *
 * @param subscriptions 机器级订阅表（`readSimpleSettings().humanChannel.subscriptions`）
 * @param account 收到的**账号 id**（poller 身份；不是 token）
 * @param user 发信人 id
 */
export function lookupSubscription(
  subscriptions: readonly HumanChannelSubscriptionSettings[],
  account: string,
  user: string,
): SubscriptionLookup {
  const defects: SubscriptionDefect[] = []
  const usable: SubscriptionHit[] = []
  subscriptions.forEach((row, index) => {
    // 显式取四字段（不按 key 索引 —— 保住类型检查；`row` 可能整体是 undefined）
    const raw: Record<string, unknown> = {
      account: row?.account,
      user: row?.user,
      ccc: row?.ccc,
      role: row?.role,
    }
    const present: Record<string, string> = {}
    const missing: string[] = []
    for (const field of SUBSCRIPTION_FIELDS) {
      const v = raw[field]
      // 空白串 = "没填"（面板空文本框会写 `''`）⇒ 与"缺这个键"同义
      if (typeof v === 'string' && v.trim() !== '') present[field] = v.trim()
      else missing.push(field)
    }
    if (missing.length > 0) {
      defects.push({ index, missing, present })
      return
    }
    usable.push({ account: present.account!, user: present.user!, ccc: present.ccc!, role: present.role! })
  })

  const hit = usable.find((r) => r.account === account && r.user === user)
    ?? usable.find((r) => r.account === account && r.user === '*')
    ?? null
  return { hit, defects, usable: usable.length }
}

/** 入站投递目标**从哪来**（判据用；也是"这条消息为什么被投到这里"的可重建依据） */
export type InboundRouteSource = 'machine' | 'ccc-fallback'

/** 未投递的原因（两档，措辞刻意不同 —— 见 `planInboundRoute`） */
export type InboundSkipReason = 'no-subscription' | 'no-match'

export interface InboundRoutePlan {
  /** 投递目标（`null` ⇒ **不投递**） */
  target: { ccc: string; role: string } | null
  /** 目标出处（`null` ⇔ `target === null`） */
  source: InboundRouteSource | null
  /** 未投递的原因（`target !== null` ⇒ `null`） */
  skipReason: InboundSkipReason | null
  /** 订阅表里残缺的行（**与是否命中无关**，一律要出声） */
  defects: SubscriptionDefect[]
}

/**
 * 入站路由决策（**纯函数**）。
 *
 * 顺序：**机器级订阅表优先** → 未命中时用 CCC 级回退。
 *
 * 🔴 **回退是过渡期的"不打断在用的微信"**（方案 §11.3 **Q5**）：机器级账号表为空时，
 * 桥仍按 CCC 起、路由也仍认 CCC 级 `routes`。机器级一旦配起来，回退传 `null`
 * ⇒ **未命中 = 不投递**（不是"投给默认角色"——那正是方案 §3.1 明令禁止的）。
 * @param input.subscriptions 机器级订阅表
 * @param input.account 收到的账号 id
 * @param input.user 发信人 id
 * @param input.fallback CCC 级回退目标（`{ccc, role}`）；无 ⇒ `null` ／ 省略
 */
export function planInboundRoute(input: {
  subscriptions: readonly HumanChannelSubscriptionSettings[]
  account: string
  user: string
  fallback?: { ccc: string; role: string } | null
}): InboundRoutePlan {
  const { hit, defects } = lookupSubscription(input.subscriptions, input.account, input.user)
  if (hit) {
    return { target: { ccc: hit.ccc, role: hit.role }, source: 'machine', skipReason: null, defects }
  }
  if (input.fallback) {
    return { target: { ccc: input.fallback.ccc, role: input.fallback.role }, source: 'ccc-fallback', skipReason: null, defects }
  }
  return {
    target: null,
    source: null,
    // "表里压根没有订阅" 与 "表里有行但都不匹配你" 是**两件事**（排查方向不同）
    skipReason: input.subscriptions.length === 0 ? 'no-subscription' : 'no-match',
    defects,
  }
}

// ── 机器级留痕（P0-3；Q4 的种子）────────────────────────────────────────────────

/**
 * 留痕落点：`$DSH_HOME/human-channel-audit.jsonl`（缺省 `~/.dsh/human-channel-audit.jsonl`）。
 *
 * 🔴 **为什么是机器级而不是某个 CCC 的 `_weixin-logs/`**：本文件记的事件（未投递 ／
 * 目标不存在 ／ 表残缺）**恰恰是"没有目标 CCC"的那些** —— 落进任何一个 CCC 都是**编一个**目标。
 * （投递成功的入站事件仍落**被路由到的那个 CCC** 的 `_weixin-logs/`，方案 §3.6 不变。）
 * env `SERENITY_HUMAN_CHANNEL_AUDIT` 覆盖（测试注入；与 `SERENITY_HOOKS_CONFIG` 同款推导）。
 */
export function humanChannelAuditPath(): string {
  const override = process.env.SERENITY_HUMAN_CHANNEL_AUDIT
  if (override && override !== '') return override
  const dshHome = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
  return join(dshHome, 'human-channel-audit.jsonl')
}

/**
 * 留痕事件。
 * 🔴 **刻意不记消息正文**：方案 §3.1 要的是"**谁**发的、**为什么**没投" —— 正文既不必要，
 * 又会把人说的话抄进一个机器级文件（本该只落在他自己 CCC 的日志里）。
 */
export type HumanChannelAuditEvent =
  | { kind: 'inbound-unrouted'; account: string; user: string; reason: InboundSkipReason; detail: string }
  | { kind: 'inbound-target-missing'; account: string; user: string; ccc: string; role: string; detail: string }
  | { kind: 'subscription-defect'; account: string; index: number; missing: string[]; present: Record<string, string> }

/**
 * 追加一条留痕。**永不抛** ——
 * 留痕失败绝不能反过来打断投递（它是**旁路**，与 `invokeWeixinHook` 的"旁路容忍"同款）。
 * 🔴 **不静默的是它记的那件事**，不是它自己：所以调用方仍要**另行 `console` 出声**。
 */
export function appendHumanChannelAudit(event: HumanChannelAuditEvent): void {
  try {
    const path = humanChannelAuditPath()
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`, 'utf-8')
  } catch {
    /* 留痕失败静默（见上） */
  }
}
