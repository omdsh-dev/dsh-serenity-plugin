/**
 * im/feishu-account.ts — 飞书账号实现（P3，2026-10-19）
 *
 * ## 它凭什么这么短
 *
 * 这是本件最有价值的一点：**P3 只写了这一个文件**。路由 ／ 会话 ／ 提问 ／ 回复 ／ 记账 ／
 * 媒体落盘全都在中立层（`im/inbound-event.ts`，B1）—— 飞书只提供三样：
 *   ① 怎么建连接并收消息 ② 一条飞书消息长什么样 ③ 怎么把文本发回去。
 *
 * owner 那句「和微信一样，只不过是 account 方实现不同」在这里是**代码事实**。
 *
 * ## 三条官方约束（照抄会坏，必须各自处理）
 *
 * 1. 🔴 **回调须 3 秒内返回**（官方：超时触发重推）⇒ 回调里**只入队**，处理全异步。
 * 2. 🔴 **超时会重推** ⇒ 必须按 `message_id` **去重**，否则同一句话答两遍。
 * 3. 🔴 **建连成功 ≠ 能收消息** ⇒ 这两件事分开取证（`getConnectionStatus` 只证明前者）。
 *
 * ## 边界（R↓）
 *
 * - ⛔ 不做路由判断、不做会话管理 —— 那是中立层的。
 * - ⛔ 不解析富文本/图片/文件（本期）：只取 `message_type === 'text'` 的正文；
 *   其它类型当作"有消息但没文本"交给中立层（它会静默或降级，**不会静默丢连接**）。
 */
import type { ImAccountImpl, ImAccountCredential, ImAccountLoop, ImAccountLoopInput } from './accounts.js'
import { registerImAccountImpl } from './accounts.js'
import type { ImInboundEvent, ImAccountIo } from './inbound-event.js'
import { handleInboundEvent, resolveInboundTarget } from './inbound-event.js'
import { markdownToPlainText } from './ilink.js'

/** 去重集合上限（飞书重推窗口有限；限量防内存无界增长） */
const SEEN_LIMIT = 2000

/** 已处理过的 message_id（超时重推去重；按账号隔离） */
const seenByAccount = new Map<string, Set<string>>()

/**
 * 飞书 SDK 的最小面（**注入**，不是硬 import）。
 *
 * 🔴 为什么注入（两条理由，一条设计、一条实测）：
 *  ① **设计**：与微信同款（`installWeixinAccountImpl` 注入 `getUpdates` 等）。
 *     飞书 SDK 是重依赖（protobufjs 等）⇒ 不该成为模块求值时的硬依赖，只在真要起账号时加载。
 *  ② **实测**：`vi.mock` 拦不住它 —— 本模块用 `await import('@larksuiteoapi/node-sdk')`，
 *     而该包在 pnpm 下是**外置依赖**，vitest 的动态 import 不被 mock 拦截。实测证据：
 *     测试里跑出了真 SDK 自己的日志 `[error]: ['[ws]', 'invalid appId: cli_x']`
 *     ⇒ 若坚持 mock，测的就是"能不能骗过测试装置"，不是被测对象。
 *     ⇒ 注入后，测试直接给替身，**没有魔法**。
 */
export interface FeishuSdk {
  Client: new (p: { appId: string; appSecret: string }) => {
    im?: { v1?: { message?: { create?: (p: unknown) => Promise<unknown> } } }
  }
  EventDispatcher: new (p?: unknown) => {
    register: (h: Record<string, (d: never) => unknown>) => unknown
  }
  WSClient: new (p: { appId: string; appSecret: string }) => {
    start: (p: { eventDispatcher: unknown }) => Promise<void>
    close: (p?: { force?: boolean }) => void
  }
}

let sdkLoader: (() => Promise<FeishuSdk>) | null = null

/**
 * 接入 SDK 加载器（`bridge.ts` 在模块求值时注入真加载器；测试注入替身）。
 * 缺省 = 动态 import 真包 —— 这样生产路径不需要 `bridge.ts` 也能独立跑。
 */
export function installFeishuSdk(loader: () => Promise<FeishuSdk>): void {
  sdkLoader = loader
}

/**
 * 取 SDK（未注入 ⇒ 动态 import 真包）。
 *
 * 🔴 **导出**（2026-10-20 Q4）：出站通道 `feishu-channel.ts` 也要用它。
 * 让它走**同一个加载器**而不是自己再写一次 `import('@larksuiteoapi/node-sdk')` ——
 * 否则 `installFeishuSdk()` 注入的替身只对入站那半生效，出站那半在测试里会去加载真 SDK
 * （那正是本文件头注记着的实测坑：真 SDK 会打自己的日志证明你没拦住它）。
 * ⇒ **注入点必须唯一**，否则"能不能测"这件事会随调用方向而变。
 */
export async function loadFeishuSdk(): Promise<FeishuSdk> {
  if (sdkLoader) return sdkLoader()
  const mod = await import('@larksuiteoapi/node-sdk')
  return mod as unknown as FeishuSdk
}

/**
 * 账号 → 长连接客户端（`ImAccountLoop` 的形状是面板既有契约，**不加字段** ——
 * 加字段会逼面板与 `im-bridge status` 认识一个通道特有的东西）。
 * 用途：`stopped` 置位后能真正 `close()` 掉连接（只置标志位而不关连接 = 假停止）。
 */
const wsByAccount = new Map<string, { close: (p?: { force?: boolean }) => void }>()

/** 测试辅助：关掉并清空全部长连接（生产零调用） */
export function __closeAllFeishuConnectionsForTest(): void {
  for (const ws of wsByAccount.values()) {
    try { ws.close({ force: true }) } catch { /* 关闭失败不影响清理 */ }
  }
  wsByAccount.clear()
}

function seenSet(accountId: string): Set<string> {
  let s = seenByAccount.get(accountId)
  if (!s) { s = new Set(); seenByAccount.set(accountId, s) }
  return s
}

/** 测试辅助：清空去重表（生产零调用） */
export function __resetFeishuSeenForTest(): void {
  seenByAccount.clear()
}

/**
 * 飞书凭据就绪判据：**appId 与 appSecret 都非空**。
 * （微信只需 token；飞书是双要素，缺任一起不了长连接。）
 */
function feishuCredentialReady(cred: ImAccountCredential): boolean {
  const appId = typeof cred.appId === 'string' ? cred.appId.trim() : ''
  const secret = typeof cred.token === 'string' ? cred.token.trim() : ''
  return appId !== '' && secret !== ''
}

/**
 * 从飞书 `im.message.receive_v1` 事件里取出**中立入站事件**。
 *
 * 🔴 这是 P3 唯一的"形状翻译"处，与 `bridge.ts` 里 iLink 的那一处对称。
 * ⚠️ 用户标识用 **open_id**（不是 chat_id）：路由表是"人 → 轨迹"，
 *    而 chat_id 在群里会变、在单聊里也与人不是一一对应。
 * @returns 无可用发送者/消息体 ⇒ `null`（调用方丢弃并**出声**，不静默）
 */
export function feishuEventToInbound(data: Record<string, unknown>): ImInboundEvent | null {
  const sender = data.sender as { sender_id?: { open_id?: string } } | undefined
  const message = data.message as { message_id?: string; message_type?: string; content?: string } | undefined
  const userId = sender?.sender_id?.open_id
  if (!userId || !message?.message_id) return null

  // 只认文本；其它类型（图片/文件/富文本）本期不解析 ⇒ 当作"有消息、无文本"
  let text: string | null = null
  if (message.message_type === 'text' && typeof message.content === 'string') {
    try {
      const parsed = JSON.parse(message.content) as { text?: string }
      const t = typeof parsed.text === 'string' ? parsed.text.trim() : ''
      // 飞书群里 @机器人 会在正文里带 @_user_N 占位，去掉避免它进对话
      text = t.replace(/@_user_\d+/g, '').trim()
      if (text === '') text = null
    } catch {
      // content 是 JSON 字符串（官方形态）；解析失败 ⇒ 当作无文本，不抛
      text = null
    }
  }

  return {
    userId,
    text,
    // 附件本期不支持：空数组 ⇒ 若也无文本，中立层按"有消息但无内容"处理
    media: [],
    hasVoice: false,
    // 飞书没有 context_token 概念 ⇒ 不带回复锚点（出站用 open_id 直接发）
    replyRef: undefined,
  }
}

/**
 * 造出站动作面（飞书）。
 *
 * 🔴 `content` 必须是 **JSON 字符串**：`JSON.stringify({ text })` —— 这是官方形态，
 * 直接给裸文本会被服务端拒绝（且错误码不直观）。
 */
function feishuIo(client: unknown): ImAccountIo {
  const c = client as {
    im?: { v1?: { message?: { create?: (p: unknown) => Promise<unknown> } } }
  }
  return {
    sendText: async ({ toUserId, text }) => {
      const create = c.im?.v1?.message?.create
      if (typeof create !== 'function') {
        throw new Error('飞书 SDK 缺少 im.v1.message.create')
      }
      await create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: toUserId,
          msg_type: 'text',
          // 🔴 JSON 字符串，不是裸文本
          content: JSON.stringify({ text: markdownToPlainText(text) }),
        },
      })
    },
    // 飞书没有"正在输入"能力 ⇒ 这两个方法**刻意不提供**
    // （中立层的 typingStart/typingStop 是可选调用 ⇒ 不实现就是正确用法）
  }
}

/**
 * 单账号的飞书长连接循环。
 *
 * 与微信的**关键结构差别**：微信是 `while` 轮询，飞书是**事件回调**（长连接推）。
 * 所以这里的"循环"其实是"建连一次，然后等回调"；`stopped` 靠 `close()` 兑现。
 */
async function runFeishuAccountLoop(input: ImAccountLoopInput, loop: ImAccountLoop): Promise<void> {
  // `ImAccountCredential` 的两半：`appId` ＋ `token`（= appSecret，复用既有的 token 字段）
  const cred = input.cred as { appId?: string; token?: string }
  const appId = cred.appId ?? ''
  const appSecret = cred.token ?? ''
  if (!appId || !appSecret) {
    loop.lastError = '飞书凭据不全（缺 appId 或 appSecret）'
    return
  }

  // 通过注入的加载器取 SDK（生产 = 动态 import 真包；测试 = 替身，无魔法）
  const Lark = await loadFeishuSdk()
  const client = new Lark.Client({ appId, appSecret })
  const dispatcher = new Lark.EventDispatcher({})

  // 逐条串行处理的队列（**不进回调**：回调只 push，3 秒约束靠这个兑现）
  const queue: Array<{ data: Record<string, unknown> }> = []
  let draining = false

  const drain = async (): Promise<void> => {
    if (draining) return
    draining = true
    try {
      while (queue.length > 0 && !loop.stopped) {
        const item = queue.shift()!
        loop.lastPollAt = Date.now() // 面板读数面：有事件到达即算"活着"
        try {
          const event = feishuEventToInbound(item.data)
          if (!event) {
            loop.lastError = '收到飞书事件但取不出发送者/消息体'
            continue
          }
          const msgId = (item.data.message as { message_id?: string } | undefined)?.message_id ?? ''
          if (msgId !== '') {
            const seen = seenSet(input.accountId)
            if (seen.has(msgId)) continue // 🔴 超时重推 ⇒ 丢弃（否则答两遍）
            seen.add(msgId)
            if (seen.size > SEEN_LIMIT) {
              // 淘汰最旧一条（Set 保持插入序）
              const oldest = seen.values().next().value
              if (oldest !== undefined) seen.delete(oldest)
            }
          }
          const ctx = input.ctx as never
          const io = feishuIo(client)
          if (input.machine) {
            const target = await resolveInboundTarget(ctx, {
              account: input.accountId,
              user: event.userId,
              cccFallback: null,
            })
            if (!target) continue // 未命中／目标不存在 ⇒ 中立层已留痕／已出声
            // 🔴 渠道身份必须显式传（2026-10-20 Q4）：不传 ⇒ 中立层缺省按 weixin 处理
            // ⇒ 手动输出模式下注入给模型的会是"发往微信"的命令（目标 id 却是 open_id）。
            await handleInboundEvent(ctx, target.root, input.accountId, io, event, { target, channel: 'feishu' })
          } else {
            await handleInboundEvent(ctx, input.root, input.accountId, io, event, { channel: 'feishu' })
          }
        } catch (err) {
          loop.lastError = err instanceof Error ? err.message : String(err)
        }
      }
    } finally {
      draining = false
    }
  }

  dispatcher.register({
    'im.message.receive_v1': (data: Record<string, unknown>) => {
      // 🔴 回调里**只入队**（官方 3 秒约束）——任何 await 都可能超时导致重推
      queue.push({ data })
      void drain()
      return undefined
    },
  })

  const ws = new Lark.WSClient({ appId, appSecret })
  wsByAccount.set(input.accountId, ws)
  try {
    await ws.start({ eventDispatcher: dispatcher })
  } catch (err) {
    loop.lastError = `飞书长连接建立失败: ${err instanceof Error ? err.message : String(err)}`
  }
}

/** 飞书账号实现（登记名 = `feishu`；与配置里的 `channel` 取值一致） */
export const feishuAccountImpl: ImAccountImpl = {
  channel: 'feishu',
  isReady: feishuCredentialReady,
  notReadyReason: () => '**缺 appId 或 appSecret**（未绑定）',
  startLoop(input: ImAccountLoopInput): ImAccountLoop {
    const loop: ImAccountLoop = { stopped: false, lastPollAt: 0 }
    void runFeishuAccountLoop(input, loop)
    return loop
  },
}

/**
 * 注册飞书实现（`bridge.ts` 在**模块求值时**调用）。
 *
 * ⚠️ 与微信同款教训（续 220 实测 12 例红）：注册必须在**模块求值**时发生，
 * 不能等 `apply` —— 测试与面板会**直接**调 `syncCccBridge` / `syncHumanChannel`。
 */
export function installFeishuAccountImpl(): void {
  registerImAccountImpl(feishuAccountImpl)
}
