/**
 * im/accounts.ts — **账号实现派发表**（P2，2026-10-19）
 *
 * ## 为什么是"账号"这一层（owner 定向，逐字）
 *
 * > 「飞书继承可以很方便的加到当前的体系里，**和微信一样，只不过是 account 方实现不同**。
 * > **要整合到统一的配置中**。」
 *
 * 微信与飞书的差别**只在账号侧**：怎么连、怎么收、怎么发。而它们的**身份、路由、会话**
 * 从来就是通道无关的：
 * - 路由表 = `user → 轨迹编码`（不认渠道）
 * - 会话 id = `skiff-weixin-<轨迹编码>`（由轨迹决定，不认渠道）
 * - 一账号一 poller 的归属判据 = `(root, accountId, identity)`（不含渠道概念）
 *
 * ⇒ 抽象点是 `account.channel`，**不是**新造一个平行的"通道接口"。
 *   本文件的全部职责：**channel 字符串 → 那个实现**。
 *
 * ## 这不是新设计（源码里早就留了口）
 *
 * `bridge.ts` 的机器级装配处原本写着：
 * *「只有已实现的渠道能起 poller（**P2 才加第二个实现**）⇒ 未实现的出声但不静默跳过」*
 * 且账号行 `HumanChannelAccountSettings` **本来就有 `channel` 字段**。
 * ⇒ 本文件就是把那个"P2 预留位"填上。
 *
 * ## 为什么用「注册表 + 未命中响亮」而不是 switch
 *
 * switch 会把"支持哪些渠道"写死在装配逻辑里；注册表让**新增一个渠道实现 = 新增一个文件
 * + 一次 register**，装配处一行不改（R3 家族式扩展）。而未命中**必须出声**——
 * 静默跳过会表现成"某个账号莫名其妙不工作"，那是本轨反复踩过的一类最难查的故障。
 */

/** 一条账号的运行期凭据（各实现自解释；`weixin` 用 token/baseUrl/userId） */
export interface ImAccountCredential {
  token?: string
  baseUrl?: string
  userId?: string
  /** 飞书等：appId（凭据本体仍在 localstore） */
  appId?: string
}

/**
 * 账号实现的**最小面**（只放装配处真正需要的东西）。
 *
 * 🔴 刻意**不**把"收消息"放进来：接收循环的形状（长轮询 vs WebSocket 回调）
 * 两家根本不同，硬塞进一个签名只会让两边都别扭。装配处需要的是：
 * ① 这个账号该不该起（凭据齐不齐）② 起起来 ③ 停 ④ 健康快照。
 */
export interface ImAccountImpl {
  /** 实现名（= `account.channel` 的取值，如 `weixin`） */
  readonly channel: string
  /**
   * 凭据是否齐全到**可以起**（缺失 ⇒ 装配处跳过并出声，**不静默**）。
   * @param cred 已从 localstore 读好的凭据（实现自己判断哪个字段必需）
   */
  isReady(cred: ImAccountCredential): boolean
  /**
   * 凭据不全时**给人看的原因**（装配处的告警文案，可含 CC 特定措辞）。
   * 缺省 ⇒ 装配处用通用文案。存在的理由：微信的文案是「无 token（未绑定）」，
   * 那是有既有判据钉住的措辞（测试与排查手册都按它找），不该被本层统一措辞冲掉。
   */
  notReadyReason?(cred: ImAccountCredential): string
  /**
   * 起这条账号的接收循环（fire-and-forget：实现内部自行循环，不得阻塞装配）。
   * @returns 该账号的循环控制对象（装配处用它做停止与快照）
   */
  startLoop(input: ImAccountLoopInput): ImAccountLoop
}

/**
 * 起循环的输入。
 *
 * ⚠️ `root` 在**机器级模式**下是 `MACHINE_SCOPE` 哨兵（不是一个目录）——
 * 这与既有语义一致（投到哪个 CCC 由**每条消息**的订阅表决定，不由账号决定）。
 */
export interface ImAccountLoopInput {
  ctx: unknown
  root: string
  accountId: string
  cred: ImAccountCredential
  /** 真 = 机器级 poller（目标由订阅表逐条决定） */
  machine: boolean
}

/**
 * 循环控制（装配处持有；`weixinBridgeStatus` 读它出健康快照）。
 *
 * 🔴 `lastPollAt` / `lastError` 是**面板读数面**的既有字段，名字不能改
 * （`im-bridge status` 与设置面板都按这个形状读）。
 */
export interface ImAccountLoop {
  stopped: boolean
  lastPollAt: number
  lastError?: string
}

const impls = new Map<string, ImAccountImpl>()

/** 注册账号实现（`index.ts` 装配时调用；重复 channel 覆盖——测试与热重载友好） */
export function registerImAccountImpl(impl: ImAccountImpl): void {
  impls.set(impl.channel, impl)
}

/** 取实现（未注册 ⇒ `null`，由调用方**响亮出声**，不要静默跳过） */
export function getImAccountImpl(channel: string): ImAccountImpl | null {
  return impls.get(channel) ?? null
}

/** 已注册的实现名（诊断与错误文案用；顺序 = 注册顺序） */
export function imAccountChannels(): string[] {
  return [...impls.keys()]
}

/** 测试辅助：清空派发表（生产零调用） */
export function __resetImAccountImplsForTest(): void {
  impls.clear()
}

/**
 * 账号行的渠道归一（**单一处**）。
 *
 * 缺省 `weixin`：老配置平移到 `im` 段时不必补这个字段——owner 的"统一配置"
 * 要能直接吃旧数据（与 `route.ts` 的 `normalizeImSection` 保持同一口径）。
 */
export function normalizeAccountChannel(channel: string | undefined): string {
  const v = (channel ?? '').trim()
  return v === '' ? 'weixin' : v
}
