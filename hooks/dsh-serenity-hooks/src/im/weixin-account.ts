/**
 * im/weixin-account.ts — 微信账号实现（P2：把既有微信轮询包成 `ImAccountImpl`）
 *
 * 🔴 **纯移动，零逻辑改动**。`runAccountLoop` 的函数体逐字来自 `bridge.ts`；
 * 唯一新增的是把它**登记成"一种账号实现"**，这样装配处不必再写死 `channel === 'weixin'`。
 *
 * 为什么值得单独成一个文件（而不是留在 bridge.ts 里）：
 * 装配处从此只认 `ImAccountImpl` 接口；微信与飞书是**并列的两个实现**，
 * 而不是"微信是主角、别的往里塞"。这正是 owner「只不过是 account 方实现不同」的结构表达。
 */
import type { WeixinAccountCredential } from './route.js'
import { registerImAccountImpl, type ImAccountImpl, type ImAccountCredential, type ImAccountLoop, type ImAccountLoopInput } from './accounts.js'

/** 轮询间隔（getupdates 失败后重试；成功 = 立即续，长轮询本身 hold 35s） */
const POLL_RETRY_MS = 3_000

/**
 * 微信的凭据就绪判据：**有 token** 才算绑定（baseUrl 留空 = 走官方默认）。
 * 与既有装配处逐字同义（原 `if (token === '') { …跳过… }`）。
 */
function weixinCredentialReady(cred: ImAccountCredential): boolean {
  return typeof cred.token === 'string' && cred.token.trim() !== ''
}

/**
 * 把实现所需的最小注入面收进来。
 *
 * ⚠️ 这些是**微信侧的运行依赖**（`getUpdates` / `handleIncoming` / `handleMachineIncoming`）。
 * 用注入而不是 import，是为了让 `bridge.ts` 不因本文件而反向依赖 —— 否则两个文件互相
 * import 会成环（本轨已有先例：`rebuild ⇄ tools/trajectory` 那个人工发现的环）。
 */
export interface WeixinLoopDeps {
  getUpdates: (input: { baseUrl: string; token: string; getUpdatesBuf: string; timeoutMs: number }) => Promise<{
    get_updates_buf?: string
    msgs?: Array<Record<string, unknown>>
  }>
  handleIncoming: (ctx: unknown, root: string, accountId: string, cred: WeixinAccountCredential, msg: never) => Promise<void>
  handleMachineIncoming: (ctx: unknown, accountId: string, cred: WeixinAccountCredential, msg: never) => Promise<void>
}

let deps: WeixinLoopDeps | null = null

/** 装配时注入依赖（`bridge.ts` 在模块初始化末尾调用一次；见 `installWeixinAccountImpl`） */
export function setWeixinLoopDeps(d: WeixinLoopDeps): void {
  deps = d
}

/** 单账号轮询循环（**函数体逐字照搬自 bridge.ts 的 `runAccountLoop`，仅改类型与依赖来源**） */
async function runWeixinAccountLoop(input: ImAccountLoopInput, loop: ImAccountLoop): Promise<void> {
  if (!deps) {
    loop.lastError = 'weixin 实现未注入依赖（装配顺序错误）'
    return
  }
  const d = deps
  const ctx = input.ctx as never
  const cred = input.cred as WeixinAccountCredential
  let buf = ''
  while (!loop.stopped) {
    loop.lastPollAt = Date.now()
    try {
      const resp = await d.getUpdates({
        baseUrl: cred.baseUrl,
        token: cred.token,
        getUpdatesBuf: buf,
        timeoutMs: 35_000,
      })
      buf = resp.get_updates_buf ?? buf
      for (const msg of resp.msgs ?? []) {
        if (loop.stopped) break
        // 只处理用户消息（message_type=1）——忽略 bot 自己/系统消息
        if ((msg as { message_type?: number }).message_type !== 1) continue
        if (input.machine) await d.handleMachineIncoming(ctx, input.accountId, cred, msg as never)
        else await d.handleIncoming(ctx, input.root, input.accountId, cred, msg as never)
      }
      // 成功 → 立即续轮询（不 sleep；长轮询本身 hold 35s）
    } catch (err) {
      loop.lastError = err instanceof Error ? err.message : String(err)
      // 失败 → 指数退避重试（对齐 orbit/ws 模式）
      await new Promise((r) => setTimeout(r, POLL_RETRY_MS))
    }
  }
}

/** 微信账号实现（登记的 channel 名 = `weixin`；与配置里的取值一致） */
export const weixinAccountImpl: ImAccountImpl = {
  channel: 'weixin',
  isReady: weixinCredentialReady,
  // 既有判据钉住的文案（`human-channel-machine-poller.test.ts` 按「无 token」找它）⇒ 逐字保留
  notReadyReason: () => '**无 token**（未绑定）',
  startLoop(input: ImAccountLoopInput): ImAccountLoop {
    const loop: ImAccountLoop = { stopped: false, lastPollAt: 0 }
    void runWeixinAccountLoop(input, loop)
    return loop
  },
}

/**
 * 注册微信实现**并注入依赖**（`bridge.ts` 调用；幂等——重复注册覆盖同名 channel）。
 *
 * ⚠️ 必须在首次 `syncHumanChannel` / `syncCccBridge` **之前**发生。
 * `bridge.ts` 在**模块求值时**调用它一次（不是等到 `registerWeixinBridge`）——
 * 因为测试与面板会**直接**调 `syncCccBridge`，那时装配入口还没跑过；
 * 若依赖装配入口注册，那些路径会全部走进"未实现"分支（本轮实测：12 例红，根因就是它）。
 */
export function installWeixinAccountImpl(d: WeixinLoopDeps): void {
  setWeixinLoopDeps(d)
  registerImAccountImpl(weixinAccountImpl)
}
