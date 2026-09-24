/**
 * dsh-serenity-hooks — 宁静号 ACC harness（Native Cordis 插件，DSH 运行时）
 *
 * 形态（DSH 官方 native hook 约定）：name / inject / Config / apply，无 default export。
 *
 * 能力：
 *   1. 真实 DSH 工具注册：container_fs（文件系统 15 子命令，含 reveal）、container_trajectory（轨迹生命周期 + 一次性安排，含 rebuild）
 *   2. 拦截缝机械约束：tools/pre-execute + ctx.tools.guard（安全模式/黑名单/路径守卫）
 *
 * 加载：~/.dsh/config.yaml 加 insert 行（免改 DSH 源码），插件包装入 DSH node_modules。
 *
 * 配置：进程级 Config（cordis.yml 提供）+ 运行时读取 CCC 的 .opencode/serenity.json（规范位置，.dsh 回退）。
 */

import type { Context, Volatile } from 'cordis'
import z from '@deepseek-ai/schemastery'
import { ccFsTool } from './tools/cc-fs.js'
import { createKitTool } from './tools/kit.js'
import { gitTool } from './tools/git.js'
import { msmTool } from './tools/msm.js'
import { praxisTool } from './tools/praxis.js'
import { createHandymanTool } from './tools/handyman.js'
import { createTrajectoryTool } from './tools/trajectory.js'
import { localstoreTool } from './tools/localstore.js'
import { createContainerAdminTool } from './tools/container-admin.js'
import { registerGuards } from './seams/guards.js'
import { registerBootstrap } from './seams/bootstrap.js'
import { registerKeeper } from './seams/keeper.js'
import { registerContext } from './seams/context.js'
import { registerEntrySkillSectionGlobal } from './seams/system-prompt.js'
import { registerCompactRetention } from './seams/compact.js'
import { registerStatusApi } from './api.js'
import { registerVoyageApi } from './voyage-page.js'
import { registerEnv } from './seams/env.js'
import { registerOpencodeSkills } from './seams/opencode-skills.js'
import { DEFAULT_SERENITY_CONFIG_PATHS } from './ccc.js'
import { cccRootForCwd, listCccs } from './ccc-roots.js'
// C4 块 B：端口只从集中端口表取（默认值不再散写）
import { ACP_HTTP_PORT, MAIN_WEB_PORT, SKIFF_DEBUG_PORT } from './ports.js'
import { hostSessions, hostWebServer } from './host/access.js'
import { hostContractReport, summarizeHostContract } from './host/contract.js'
import { readDshVersion } from './status.js'
import { readSkiffRoles } from './skiff-role.js'
import { registerSettingsSection, readSimpleSettings } from './settings-section.js'
import { registerGateway } from './gateway.js'
import { registerRebuildTurnHook } from './rebuild.js'
import { registerOutputGuardHook } from './output-guard-seam.js'
import { registerUnattendedSeam } from './unattended-seam.js'
import { migrateLegacyLocalstore, globalConfigPath } from './config-ops.js'
import { startSkiffDebugServer, stopSkiffDebugServer } from './skiff-debug.js'
import { startAcpHttpServer, stopAcpHttpServer, acpHttpActive } from './acp-http.js'
import { registerWakeScheduler } from './wake-scheduler.js'
import { registerCroTurnTracking } from './cro-turns.js'
import { registerWeixinBridge } from './weixin-bridge.js'
import { registerWeixinSendApi } from './weixin-send-api.js'
import { registerWeixinOutputGuard } from './weixin-output-guard.js'
import { registerLifecycle } from './seams/lifecycle.js'
import { registerWebFetchProvider } from './web-fetch-provider.js'
import { registerOpencodeAutoConfig } from './opencode-provider.js'
import { registerDeepseekVisionPatch } from './deepseek-vision-patch.js'
import { registerImChannel } from './im-bridge.js'
import { weixinChannel } from './im-weixin.js'
import { createImBridgeTool } from './tools/im-bridge.js'
import { createAccDiagTool } from './tools/acc-diag.js'
// §0L（S142 2026-09-19）：绑定载体迁到宿主存储域——装载期开域 + 注入句柄 + 一次性迁移
import { openBindingDomain, bindingStore } from './host/storage-domain.js'
import { setBindingStore } from './trajectory-bound.js'
// （C4 块 A 顺带清理：`registerDisposer` 的 import 自 C2 删掉 skiff root 重试定时器后已无使用点）

export const name = 'dsh-serenity-hooks'

/** 主动调用的服务；其余（agent 事件）随 harness 装配必然存在
 *  （v1.28.0 适配 0.1.2-rc.1：+ 'settings'——B4 settings 服务由 provider 插件加载后才有） */
export const inject = ['tools', 'webServer', 'sessions', 'shellEnv', 'skills', 'agentLoop', 'agents', 'systemPrompt', 'sessionProjections', 'settings', 'web']

/** 插件配置（cordis.yml 提供；进程级） */
export interface Config {
  /** CCC 配置相对路径（运行时从根读取）；缺省 .opencode/serenity.json（规范）+ .dsh/serenity.json（回退） */
  serenityConfigPaths?: string[]
  /** 注册真实工具 */
  tools?: boolean
  /** 注册拦截缝守卫 */
  guards?: boolean
  /** 注册 session-keeper DCP 提醒 */
  keeper?: boolean
  /** keeper 缺省阈值 */
  keeperThreshold?: number
  /** 注册 ACC 上下文注入（session-start + prompt-submit） */
  context?: boolean
  /** 注册压缩保留（compaction/end 后重注入 ACC 身份） */
  compactRetention?: boolean
  /** 注册 HTTP 状态接口（WebUI 停靠栏） */
  api?: boolean
  /** 身份注入时并入 CCC 入口 skill 内容（0 = 不注入） */
  entrySkillMaxChars?: number
  /** 注册 shell.env（DSH_SERENITY_* 环境事实） */
  env?: boolean
  /** 兼容 opencode skill 标准（provider：.opencode/skills 扫描注册） */
  opencodeSkills?: boolean
  /** F1 双端口网关（简单配置；entry 默认值，运行时经 DSH settings） */
  gateway?: { enabled?: boolean }
  /** F2 超限重建（entry 默认值，运行时经 DSH settings） */
  rebuild?: { enabled?: boolean; thresholdK?: number }
  /** F4 Skiff（实验性）：调试服务启停（entry 默认值，运行时经 DSH settings） */
  skiff?: { enabled?: boolean; debugPort?: number }
  /** F4c ACP（实验性）：HTTP JSON-RPC 端点启停（entry 默认值，运行时经 DSH settings） */
  acp?: { enabled?: boolean; httpPort?: number }
  /** v1.30.12 web_fetch provider 接管（fake-ip / TUN 网络：宿主内置 provider 判「非公网」恒拒） */
  webFetch?: { enabled?: boolean }
  /**
   * v1.31.7 opencode 路由自动配置（plugin 全局；S142 用户"省得用户配"）：
   * 补 `llm-pi-ai.providers.<opencode 路由>.headers` 的路由头；环境有 OPENCODE_API_KEY 时建路由。
   * 缺省开（`!== false` 判定）；关闭后一切回到"用户手抄"。
   */
  opencodeProvider?: { autoConfigure?: boolean }
  /**
   * v1.40.x DeepSeek 多模态临时补丁（plugin 全局；S142 owner 2026-09-19 令）：
   * 给 id 含 `deepseek` 的模型补 `input: [...,"image"]`——因为 DSH 里"模型能否收图"靠**声明**，
   * 而**不在内置目录里**的模型走 `DEFAULT_INPUT = ["text"]` 兜底 ⇒ 明明支持图片却被当成只能收文字。
   * 缺省开（`!== false` 判定）。🔴 **临时功能**：owner「以后 dsh 做得更完善了我们这个功能再下掉」
   * ⇒ 关闭 = 停止再补；**不回滚已写入的值**（写的是"该模型支持图片"这个**事实**，不是偏好）。
   */
  visionPatch?: { enabled?: boolean }
  // ── 设置面板层（扁平键）────────────────────────────────────────────────
  // 🔴 这些键是**旧 `settings.yaml` 的段名/字段名，故意原样保留**（v1.47 A 案）：
  //    0.1.7 起设置页由「profile 条目 Config」投影而来，而本插件条目 id 逐字 = `serenity-hooks`
  //    （= 旧 settings.yaml 的段名）⇒ 宿主的 `importLegacyDocument()` 会把旧值导入同一命名空间，
  //    声明了这些键 ⇒ **旧值零迁移自动生效**（schemastery 非 strict 会保留未声明键，但读取需要声明）。
  //    ⚠️ **一律不带 `.default()`**：带上就永远非 undefined，部署层（`gateway.enabled` 等）
  //    会被无声压死。读取优先级见 `settings-section.ts`：面板层 > 部署层 > 内建缺省。
  /** F1 双端口网关总开关（面板层；部署层同义键 = `gateway.enabled`） */
  gatewayEnabled?: Volatile<boolean | undefined>
  /** F2 超限重建总开关（面板层；部署层同义键 = `rebuild.enabled`） */
  rebuildEnabled?: Volatile<boolean | undefined>
  /** F2 触发阈值（K token；面板层；部署层同义键 = `rebuild.thresholdK`） */
  rebuildThresholdK?: Volatile<number | undefined>
  /** F4 Skiff 调试服务总开关（面板层；部署层同义键 = `skiff.enabled`） */
  skiffEnabled?: Volatile<boolean | undefined>
  /** F4 Skiff 调试端口（面板层；部署层同义键 = `skiff.debugPort`） */
  skiffDebugPort?: Volatile<number | undefined>
  /** F4c ACP HTTP 端点总开关（面板层；部署层同义键 = `acp.enabled`） */
  acpEnabled?: Volatile<boolean | undefined>
  /** F4c ACP HTTP 端口（面板层；部署层同义键 = `acp.httpPort`） */
  acpHttpPort?: Volatile<number | undefined>
  /** F4d 建议问答页总开关（面板层；无部署层同义键） */
  publicAskEnabled?: Volatile<boolean | undefined>
  /** CRO（轨迹自编程唤起）总闸（面板层；无部署层同义键；缺省开） */
  croEnabled?: Volatile<boolean | undefined>
  /** 无人值守代理回复总闸（面板层；无部署层同义键；缺省关） */
  unattendedEnabled?: Volatile<boolean | undefined>
}

// 🔴 **刻意不写 `z<Config>` 标注**（v1.47.2 起）：volatile 键的**输入形状**（裸 `boolean`）与
// **解析后形状**（`Volatile<boolean | undefined>`）**必然不同**，而 `z<Config>` 只用**一个**
// 类型参数同时充当两侧 ⇒ 一加 `.volatile()` 就是 TS2322（实测：`required().default` 两侧互不兼容）。
// 与宿主自己的做法一致：`dsh-agent-default-model` 也是「`Config` 声明解析后形状（带 `Volatile`）
// ＋ `static Config: z<ObjectS<…>, ObjectT<…>, 'plain'>` 走推导」，**不手写 `z<Config>`**。
// ⇒ **schema ↔ 解析后接口的对账改由机械 pin 承担** = `tests/config-volatile.test.ts`。
export const Config = z.object({
  serenityConfigPaths: z.array(z.string()).default([...DEFAULT_SERENITY_CONFIG_PATHS]),
  tools: z.boolean().default(true),
  guards: z.boolean().default(true),
  keeper: z.boolean().default(true),
  keeperThreshold: z.number().default(150),
  context: z.boolean().default(true),
  compactRetention: z.boolean().default(true),
  api: z.boolean().default(true),
  entrySkillMaxChars: z.number().default(30000),
  env: z.boolean().default(true),
  opencodeSkills: z.boolean().default(true),
  // v1.21 简单配置 entry 默认（schemastery：字段不 required 即可选）
  gateway: z.object({ enabled: z.boolean().default(false) }),
  rebuild: z.object({ enabled: z.boolean().default(true), thresholdK: z.number().min(50).max(4000).default(400) }),
  skiff: z.object({ enabled: z.boolean().default(false), debugPort: z.number().min(1024).max(65535).default(SKIFF_DEBUG_PORT) }),
  acp: z.object({ enabled: z.boolean().default(false), httpPort: z.number().min(1024).max(65535).default(ACP_HTTP_PORT) }),
  webFetch: z.object({ enabled: z.boolean().default(true) }),
  opencodeProvider: z.object({ autoConfigure: z.boolean().default(true) }),
  visionPatch: z.object({ enabled: z.boolean().default(true) }),
  // ── 设置面板层（v1.47 A 案；**v1.47.2 起补 `.volatile()`**）：旧 `settings.yaml` 的扁平键，**刻意无默认值** ──
  // 无默认 ⇒ "用户没设过"在**语义上**是 `undefined` ⇒ 部署层（嵌套段）才有机会生效。
  // 🔴 **必须标 `.volatile()`**（0.1.7 设置面硬约定）：宿主 `settings.describe()` 只收录
  //    `volatileForm(schema) !== undefined` 的条目，而 `volatileForm` **只认 `meta.volatile`**
  //    ⇒ 一个 volatile 字段都没有 ⇒ **本插件命名空间整个不进 describe** ⇒ 设置面板那一节消失
  //    （实证 = 0.1.7-rc.1 真机 `namespaces` 16 条里没有 `serenity-hooks`）。
  // ⚠️ **读取面必须配合**：运行期 volatile 字段是 `Volatile<T>` **恒真包装**（缺省时 `.get()`
  //    返回 `undefined`），**不是** `undefined` ⇒ 一律经 `settings-section.ts` 的 `unwrapVolatile()`。
  // 约束（min/max）与旧 settings schema 逐字一致，保证面板输入仍被宿主校验。
  gatewayEnabled: z.boolean().volatile(),
  rebuildEnabled: z.boolean().volatile(),
  rebuildThresholdK: z.number().min(50).max(4000).volatile(),
  skiffEnabled: z.boolean().volatile(),
  skiffDebugPort: z.number().min(1024).max(65535).volatile(),
  acpEnabled: z.boolean().volatile(),
  acpHttpPort: z.number().min(1024).max(65535).volatile(),
  publicAskEnabled: z.boolean().volatile(),
  croEnabled: z.boolean().volatile(),
  unattendedEnabled: z.boolean().volatile(),
})

export function apply(ctx: Context, config: Config): void {
  // review F-05（v1.30.7）：装载时核对宿主契约（服务/成员/宿主版本）——把"静默漂移"
  // 变成启动可见信号。探针自身永不抛错：宿主对插件 apply 抛错会导致整个 dsh 启动失败
  // （app-boot 的 "plugin(s) failed to load" 语义），探针不能成为新的单点。
  try {
    // C5（2026-09-15）：宿主契约走统一取数口 `hostContractReport`——**每次现探，不缓存答案**。
    // v1.34.2 纠正：装载瞬间 `lazy` 服务尚未实例化，把这次观测缓存下来会让 `dashboard health`
    // 长期渲染假阴性（实测：快照报 workspaceRegistry 缺失，而 /serenity/cccs 同时正常返回 4 个工作区）。
    const report = hostContractReport(ctx, readDshVersion())
    if (report !== null && report.issues.length > 0) console.warn(`[serenity-hooks] ${summarizeHostContract(report)}`)
  } catch {
    /* 探针失败不阻断插件装载 */
  }
  // v1.31.0（S142 用户洞察「微信桥是 ACC 提供的，发送能力也应是 ACC 的工具」）：
  // IM 通道注册必须发生在工具装配**之前**——`im-bridge` 的 description 读通道枚举
  // （imChannelIds）。可见性不在这里判定：未配置通道的 CCC 由 guards 逐 agent
  // `tools.restrict({deny:['im-bridge']})` 从清单中移除（未配置 = 模型看不到）。
  registerImChannel(weixinChannel)
  // §0L（S142 2026-09-19，owner「同意，开工吧，注意向前兼容」）：把「会话 ↔ 轨迹」绑定的
  // 载体从 CCC 内 `.bindings.json` 迁到**宿主自己的存储域**（`~/.dsh/storages/`）。
  // 形态 = **域优先 + 文件兜底 + 双写**（向前兼容：域不可用/未迁移时行为与升级前逐字一致）。
  // 全程 **fire-and-forget + 永不抛错**：装载期开域失败不得成为启动单点（同契约探针口径）。
  //
  // ⚠️ **迁移不在这里做**（实测修正，R↓）：dsh 服务进程的 cwd 是 `/home/yh`，**不是 CCC 根**
  // （`acc-diag` 实测：`进程 cwd: /home/yh ｜ 进程 CCC: （无）`）⇒ 装载期按 cwd 迁移会读到
  // 一个不存在的文件、静默迁移 0 条（首版发布的实测症状）。迁移改由
  // `bindingsPathFor` 惰性触发（`ensureBindingsMigrated`）——那里才稳定拿得到 CCC 根。
  void (async () => {
    try {
      const domain = await openBindingDomain(ctx)
      setBindingStore(bindingStore(domain))
      if (!domain) {
        console.log('[serenity-hooks] §0L 存储域不可用 → 绑定继续走 CCC 内 .bindings.json（向前兼容回落）')
      }
    } catch {
      /* 开域失败静默：旧文件路径仍然完整可用 */
      setBindingStore(null)
    }
  })()
  if (config.tools) {
    ctx.tools.register(ccFsTool) // container_fs
    // v1.33（S142 §32）：`logbook` 更名并收敛为 `trajectory`（原 autopilot 工具的动作 v1.33 归
    // container_admin 的 autopilot 域——该域 2026-09-15 随之退场；投递动作并入本工具）
    ctx.tools.register(createTrajectoryTool(ctx)) // container_trajectory（含 rebuild + send-now / send-later）
    ctx.tools.register(createKitTool(ctx)) // dashboard
    ctx.tools.register(gitTool) // container_git
    ctx.tools.register(msmTool) // msm（单入口执行 + 发现）
    ctx.tools.register(praxisTool) // praxis（eap/neat/cce 三合一）
    ctx.tools.register(createHandymanTool(ctx))
    ctx.tools.register(localstoreTool)
    // container_admin（role + msm 管理 + config——v1.33 起机务舱；v1.34.1 起为工厂形态：
    // 原为 autopilot 域传进程内运行态事实，该域已于 2026-09-15 退场，ctx 现无消费者）
    ctx.tools.register(createContainerAdminTool(ctx))
    // v1.31.0：IM 消息发送（条件可见——本 CCC 未配置任何 IM 通道时由 guards 移除）
    ctx.tools.register(createImBridgeTool())
    // v1.33：运行态诊断（**专属工具**——默认对所有 CCC 隐藏，只有在自己配置的
    // `exclusiveTools` 里声明的 CCC 可见；由 guards 逐 agent restrict）
    ctx.tools.register(createAccDiagTool(ctx))
  }
  if (config.guards) {
    registerGuards(ctx, { configPaths: config.serenityConfigPaths })
  }
  if (config.keeper) {
    registerKeeper(ctx, { configPaths: config.serenityConfigPaths, defaultThreshold: config.keeperThreshold })
  }
  if (config.context) {
    registerContext(ctx, { configPaths: config.serenityConfigPaths, entrySkillMaxChars: config.entrySkillMaxChars })
  }
  // 全局注册入口 skill 系统提示词 section（任何会话自动获得 xx-serenity 全文）
  registerEntrySkillSectionGlobal(ctx)
  if (config.compactRetention) {
    registerCompactRetention(ctx, { configPaths: config.serenityConfigPaths, entrySkillMaxChars: config.entrySkillMaxChars })
  }
  if (config.api) {
    registerStatusApi(ctx, { configPaths: config.serenityConfigPaths })
    // S142 §12.44：宁静号航行动画（ACC 层静态资产）——
    // /serenity/voyage 发 assets/serenity-voyage.html（无参=全屏版 / ?card=1=卡片模式），
    // 供会话头部状态胶囊展开卡片（SafeModePanel 的 sp-pop）当背景层用。
    registerVoyageApi(ctx)
  }
  // v1.21 分层：简单配置（开关/阈值）注册到 dsh 原生设置面板（零改 DSH；
  // 旧 RC 白名单存在时 client 侧自动降级，账号复杂配置走宁静号面板不受影响）
  registerSettingsSection(ctx, config)
  // v1.21 F1：双端口网关（第二监听器 + 登录 + 反代；v1.22 起 plugin 全局——
  // enabled 读 DSH settings 开关，host/port/accounts 读全局文件，不依赖具体 CCC；
  // 旧 CCC localstore 配置在首个 agent/session-start 时一次性迁移）
  registerGateway(ctx)
  // v1.22.4 定稿：container_trajectory rebuild（原 session_rebuild）排队 → agent/turn-stopping 时执行真正清空（复用旧会话原地重来）
  registerRebuildTurnHook(ctx)
  // v1.26.3 输出守卫：最终输出敏感词检测 + steer 打回重生成（凭据/机制/MSM 名不泄露给用户）
  registerOutputGuardHook(ctx)
  // 🔵 2026-09-23（S142 D77，owner 令「我需要的是一个机制」）：**无人值守代理回复**——
  // CCC 主会话**被 LLM 主动停止**且无人应答时，注入一次「**代理用户**」的结构化回复（四选一），
  // 以**每轮新生成的验证码（nonce）**作「合法收束」判据：**未回码 ⇒ 继续（≤轮上限），回码 ⇒ 放过**。
  // 总闸 = settings `unattendedEnabled`（**缺省关**；开关落点 = Serenity 全局面板「无人值守」组）。
  // 口径 = **窄**（单一续驱者：只排除**有 CRO 程序**的轨迹；自排绳不再排除，退化为长周期保险丝）；
  // 外部面/桥/worker 会话**写死不许开**（替家人说话 = 冒充）。机制层见 `unattended-ops.ts`。
  registerUnattendedSeam(ctx)
  // v1.21 F3：use 激活宁静号会话时同步重命名当前 dsh 会话（在 createTrajectoryTool 内实现，
  // naming.enabled 简单配置门控；sessionTitle 可选服务守卫）
  if (config.env) {
    registerEnv(ctx)
  }
  if (config.opencodeSkills) {
    registerOpencodeSkills(ctx)
  }
  // Anchored Standard 两阶段工具目录（S137，移植 xiaobright/dsh-anchored-standard）：
  // 协议固有（S142 用户原则：任何 CCC 抽象层都是宁静号/ACC）——默认开启不可关、
  // 零配置面，锚定消息与机制参数全部代码固化（旧 serenity.json bootstrap 段 v1.19.5 起忽略）
  registerBootstrap(ctx)
  // F4 Skiff（v1.25.0 实验性）：调试问答页装配——人工开关（settings skiffEnabled）→
  // 启动/停止 node:http 调试服务；角色定义归 CCC（skiff.roles）；未开启零资源占用
  registerSkiff(ctx)
  // F4c ACP（v1.26.0 实验性）：HTTP JSON-RPC 端点装配——人工开关（settings acpEnabled）→
  // 启动/停止；session/new 支持 {ccc, role, sessionId?}（复用 skiff 核心 + 会话延续）
  registerAcp(ctx)
  // Autopilot Trajectory（ACC 周期自唤醒，v1.26.12 实验 → v1.27.4 正式化）已于 2026-09-15
  // 整段退场（所有者裁决 (a)）——ACC 不再提供周期自唤醒：机制/时钟/`container_admin autopilot`
  // 域/面板区块全部删除。CCC 侧的自主巡航改走 `msm autopilot-round`（S151 自管理链，
  // 真相源 = S151 SESSION.md §1/§1b/§1c）。此处**不得**再注册任何周期时钟。
  // CRO（Continuous Re-Occurrence，S142 §7.8 / `docs/cro-design.md`；owner 2026-09-19
  // 令「在 dsp 做一版实现」）：让一条轨迹**自带一段程序**，由调度器每 tick 跑它、由其判定
  // 该不该唤起。归属 = **机制属 ACC / 程序属 CCC**；运行契约 = **只 spawn，从不 import**
  // （设计 §2.3 B 案：进程边界同时挡掉"ACC 依赖 CCC 源码路径"与"用户程序语法错放倒 ACC"）。
  // 🔴 本行**必须在 `registerWakeScheduler` 之前**：后者会立刻跑第一次 tick，而 CRO 快照的
  // `binding.runningSessionIds` 唯一数据源就是这张表（晚装 = 首拍读到空表 = 谎报"没在跑"）。
  // 评估与投递面在 tick 内（`wake-scheduler.ts` 的 `runCroPhase`），本行只装"是否正在跑轮次"。
  registerCroTurnTracking(ctx)
  // trajectory 唤醒注册表（D58，v1.32.0）：中心调度器——5min tick 投递「未来时刻 + 一条
  // message」的一次性唤醒（可自唤醒、可跨 trajectory）。冷会话经 ctx.sessionController
  // 载入后投递。🔴 **本钟无闸**（2026-09-21 所有者令砍掉 `wakeSchedulerEnabled`）⇒ **恒武装**、
  // 永不因闸跳过；tick 内**另一层**总闸是 CRO 阶段的 `croEnabled`（只停 CRO，**不影响**本注册表
  // 投递）。这是 ACC 唯一的轨迹调度机制。
  registerWakeScheduler(ctx)
  // F4c-3 微信桥（v1.27.0 实验性）：CCC 级配置（serenity.json weixin + localstore 凭据）→
  // 多账号 iLink 轮询 + 消息路由到 skiff role。enabled=false 未配置 → 零资源占用。
  registerWeixinBridge(ctx)
  // v1.30.9（S142 用户需求"微信桥支持被调用发消息给指定用户"）：主动发送入口——
  // 只绑 127.0.0.1 的独立监听器（默认 3082；plugin 全局配置 weixinApi），供**非 agent 调用者**
  // （外部脚本/集成）使用。v1.31.0 起 agent 侧统一走 im-bridge 工具（进程内直调 + 记录），
  // 旧 CCC MSM weixin-send 已退役；此 HTTP 入口保留（发送与记录都经桥，outgoing hook source=proactive）。
  registerWeixinSendApi(ctx)
  // v1.30.16（S142 用户"约束不够，LLM 不听"）：手动输出模式机械闸门——turn-stopping 检查
  // 本轮是否真的成功调用过输出工具（im-bridge，v1.30.x 为 weixin-send），未发送则 steer 打回
  // （≤2 次）。**措辞归 CCC 角色提示词**（本闸门只给机制事实 + 已填参数标记），与"ACC 管机制 /
  // CCC 管内容"边界一致。
  registerWeixinOutputGuard(ctx)
  // review F-08（v1.30.8）：生命周期——agent/session 销毁清理 per-会话状态 +
  // 插件卸载/HMR 停掉自起资源（skiff 调试页/ACP/微信桥；否则端口占用与重复轮询）
  registerLifecycle(ctx)
  // v1.30.12（S142 用户拍板 L3）：web_fetch provider 接管——fake-ip 网络下宿主内置
  // provider（web-fetch-http）把 198.18.0.0/15 判为「非公网」恒拒；本插件用同一
  // HttpFetchProvider 实现 + 放宽后的地址判据注册同 id（宿主内置由本包 bundle patch
  // `disabled: true` 关闭，避免 WEB_DUPLICATE_PROVIDER）。
  if (config.webFetch?.enabled !== false) {
    void registerWebFetchProvider(ctx)
  }
  // v1.31.7（S142 用户"dsp 装好就自动配上，省得用户配"）：opencode zen/go 路由头自动配置——
  // DSH 用的 pi-ai **库**本身不发 opencode 路由头（pi CLI 是应用层自己加的），
  // 缺 `x-opencode-session` 时 /zen/go 直接 400。本步经官方 settings 面补齐头；
  // 环境有 OPENCODE_API_KEY 时自动建 opencode-go 路由。缺省开，缺省值以下才跳过。
  if (config.opencodeProvider?.autoConfigure !== false) {
    registerOpencodeAutoConfig(ctx)
  }
  // v1.40.x（S142 §26 §0x-9，owner 2026-09-19 令「临时的我允许」）：DeepSeek 多模态补丁——
  // 给 id 含 `deepseek` 的模型补 `input` 的 `image`，因为"模型能否收图"在 DSH 里靠**声明**
  // （`declaredInput(entry.input) ?? base?.input ?? [...defaultInput]`），而**不在内置目录**的模型
  // 走 `DEFAULT_INPUT = ["text"]` 兜底 ⇒ 支持图片的模型被当成只能收文字。
  // 与上一条同款通道（`settings.update` 写 `llm-pi-ai`）、同款"永不抛错"纪律。
  // 🔴 临时功能，缺省开；`visionPatch.enabled=false` 停止再补（不回滚已写入的值）。
  if (config.visionPatch?.enabled !== false) {
    registerDeepseekVisionPatch(ctx, true)
  }
}

/**
 * F4 Skiff 调试服务装配：启停 = 人工（设置面板 Skiff 区块开关，settings 持久化）。
 * settings-changed 事件触发同步（skiffEnabled 开 → 启动调试服务；关 → 停止）。
 * 角色配置（skiff.roles）从当前 CCC 根读取（含 skiff.roles 的 CCC 优先，进程 cwd 次之）。
 *
 * v1.30.13（S142 诊断 D1）：**CCC root 解析失败不再"永不重试"**。旧实现只在 apply 时
 * 同步一次——此刻通常还没有 live 会话，进程 cwd（服务启动目录）也不在 CCC 内 →
 * `resolveSkiffRoot` 返回 null → 打印一行警告后**永不重试**（实证：重启日志
 * `✗ Skiff 调试服务未启动：无法定位 CCC root`，`ss -ltn` 无 3099；同批 ACP 因容忍
 * `root ?? undefined` 而正常启动）。
 *
 * v1.30.14（重启日志实证后的收敛）：**并发启动守卫** + 首次未定位降级为信息级日志。
 *  - 实证（v1.30.13 重启日志）：定时触发与"会话就绪"事件几乎同时到达 → 两次 sync 都
 *    看到 `started === false` → **两次 start**（第一次绑定成功、第二次 `EADDRINUSE` 刷错误日志）。
 *    → 加 `starting` 在飞标志（启动 Promise settle 前不再重复发起）。
 *  - 首次未定位**不是失败**（apply 时无 live 会话是常态）→ 用 `console.log` 说明"等待 live 会话"。
 *
 * v1.35（C2，S142 2026-09-15 Q5）：**退避重试定时器退场**。原形态是 ① 启动同步
 * ② 退避重试（1s/3s/8s/20s/40s） ③ 会话就绪事件再触发。C2 把 CCC 发现面归一后，
 * ② 的病灶（"apply 时刻解析不到根"）改由 **`resolveSkiffRoot` 第 ④ 档（ccc-roots 的
 * **并集**枚举：工作区注册表 ∪ 持久化会话 ∪ live 会话）** 从源头消掉——持久来源不依赖
 * 任何 live 会话，故 apply 时刻就能解析到，不再需要"等一会儿再试"。
 *
 * 🔒 **必须保留**（它们不是"重试"，删了会引入新缺陷）：
 *  - **反应式再触发**（`agent/created` / `session/created` → sync）：宿主重启后
 *    "恢复"旧会话不触发 `session/created`，但**开始对话**会触发 `agent/created`
 *    （v0.1.7 前名 `agent/session-start`）——这是唯一能把"进程起来时还解析不到、稍后才有会话"
 *    这条路径接上的通道。
 *  - **`starting` 在飞标志**：防同拍双次 start → `EADDRINUSE`。
 *    （C4 块 A 备注：面宿主亦按面名合并在飞启动，是第二道保险；**本标志仍保留**——
 *    它管的是"解析 root 这段装配流程"的在飞语义，且调试服务的启动替身在测试里被 mock，
 *     面宿主的 active 表在那种场景下为空，不能当作 `started` 的替代。）
 *  - **`informedRoot` 信息级日志**（只报一次，不刷屏）、`serenity/settings-changed` 监听、
 *    启动时那次 `sync()`。
 */
function registerSkiff(ctx: Context): void {
  let started = false
  let starting = false
  let informedRoot = false
  /** 已解析到的根（成功后缓存，避免每次 sync 重复解析） */
  let resolvedRoot: string | null = null

  const sync = async (): Promise<void> => {
    const s = readSimpleSettings()
    if (s.skiffEnabled) {
      if (started || starting) return
      // ⚠️ 在飞标志**必须在任何 await 之前**置起（同步段内）——否则同一 tick 内的
      // 第二个触发（事件 + 启动）会穿过守卫 → 双次 start → EADDRINUSE（原同步实现
      // 天然没有这个窗口，改 async 后必须显式保住）。
      starting = true
      try {
        const root = resolvedRoot ?? (await resolveSkiffRoot(ctx))
        if (!root) {
          if (!informedRoot) {
            informedRoot = true
            // 信息级（非失败）：apply 阶段无 live 会话是常态；会话就绪事件会接手再试
            console.log(
              '[serenity-hooks] Skiff 调试服务等待 CCC root（此刻无已知 CCC；会话就绪即试）',
            )
          }
          return
        }
        resolvedRoot = root
        const webPort = readWebPort(ctx)
        await startSkiffDebugServer(ctx, root, s.skiffDebugPort, webPort)
        started = true
      } catch (err) {
        console.error(`[serenity-hooks] ✗ Skiff 调试服务启动失败: ${String((err as Error)?.message ?? err)}`)
      } finally {
        starting = false
      }
      return
    }
    // 关闭状态：清掉在飞态（避免关开关后仍起服务）
    if (started) {
      stopSkiffDebugServer()
      started = false
    }
    resolvedRoot = null
    informedRoot = false
  }

  try {
    ctx.on('serenity/settings-changed', () => {
      void sync()
    })
  } catch {
    /* 事件通道缺失不阻断（启动时 sync 仍执行） */
  }
  // 反应式再触发：live 会话就绪是"CCC root 现在可解析"的强信号（重启后会话恢复、用户开始对话）
  // ⚠️ v0.1.7：`agent/session-start` → `agent/created`（serial ⇒ 处理函数只做同步判断，不 await）
  for (const eventName of ['agent/created', 'session/created'] as const) {
    try {
      ctx.on(eventName, () => {
        if (!started) void sync()
      })
    } catch {
      /* 事件通道缺失不阻断（settings-changed 与启动 sync 仍兜底） */
    }
  }
  // 启动时同步一次（settings.yaml 持久化 skiffEnabled=true → 重启后自动恢复调试服务）
  void sync()
}

/**
 * 解析 Skiff 调试服务绑定的 CCC 根（v1.25.2 用户指出：skiff 必须绑定 CCC）：
 * ① live 会话中**配置了 skiff.roles 的 CCC 优先**（用户认知中的绑定目标）
 * ② 回退进程 cwd 上溯 .serenity
 * ③ 再回退任一 live 会话的 CCC
 * ④ **（v1.35 / C2 新增）ccc-roots 枚举出的 CCC——仅在唯一候选时采用**
 *
 * 第 ④ 档为什么存在：①②③ 全部依赖 live 会话或进程 cwd；宿主重启、浏览器尚未重连时
 * 三者可能同时落空，而 `ccc-roots.listCccs` 的**持久来源**（工作区注册表 / 持久化会话）
 * 不依赖 live 会话 ⇒ 这正是"apply 时刻就能解析到根"的那条路，也是退避重试定时器
 * 得以退场的原因。
 *
 * ④ 的收敛条件（**不猜**）：只在候选**唯一**时采用；多个候选 → 返回 `null`
 * （留着让 ①②③ 的语义与人类的显式选择决定，不代替人拍板）。
 *
 * ⚠️ ①②③ 的**逐条优先级不变**；④ 只追加在末尾。
 */
async function resolveSkiffRoot(ctx: Context): Promise<string | null> {
  const liveRoots: string[] = []
  try {
    const sessions = hostSessions(ctx)
    for (const s of sessions?.list?.() ?? []) {
      const cwd = s?.header?.cwd
      if (typeof cwd === 'string') {
        const r = cccRootForCwd(cwd)
        if (r && !liveRoots.includes(r)) liveRoots.push(r)
      }
    }
  } catch {
    /* 遍历失败忽略 */
  }
  // ① 含 skiff.roles 的 live CCC 优先（绑定用户配置了角色的 CCC）
  for (const r of liveRoots) {
    if (readSkiffRoles(r).size > 0) return r
  }
  // ② 进程 cwd（服务器启动目录通常即 CCC）
  const fromCwd = cccRootForCwd(process.cwd())
  if (fromCwd) return fromCwd
  // ③ 任一 live CCC
  if (liveRoots[0]) return liveRoots[0]
  // ④ 持久来源兜底（仅唯一候选；多个候选保持 null —— 不猜）
  try {
    const entries = await listCccs(ctx)
    if (entries.length === 1) return entries[0]!.root
  } catch {
    /* 枚举失败忽略（等价于本档不存在） */
  }
  return null
}

/** 主 WebUI 端口（WebUI 链接；webServer 未装配回退集中端口表的 main 面端口） */
function readWebPort(ctx: Context): number {
  try {
    const ws = hostWebServer(ctx)
    return typeof ws?.port === 'number' ? ws.port : MAIN_WEB_PORT
  } catch {
    return MAIN_WEB_PORT
  }
}

/**
 * F4c ACP HTTP + F4d 建议问答页装配（v1.26.x 实验性）：启停 = 人工（设置面板
 * 「Serenity」页 ACP / 问答页开关，settings 持久化）。任一面开启即启动服务
 * （同一端口：POST / = JSON-RPC 需 acpEnabled；GET / + /ask = 问答页需 publicAskEnabled）。
 * 会话创建/延续走 acp-core → skiff-core；仅监听 127.0.0.1；未开启零资源占用。
 */
function registerAcp(ctx: Context): void {
  // async：`resolveSkiffRoot` 因第 ④ 档（ccc-roots 枚举）改为异步（C2）
  const sync = async (): Promise<void> => {
    const s = readSimpleSettings()
    const anyFace = s.acpEnabled || s.publicAskEnabled
    if (anyFace && !acpHttpActive()) {
      // ACP 面容忍 root 缺席（`root ?? undefined`，绑不上也只是不问 CCC）——与 Skiff 面不同。
      // C4 块 A：**不再自持 `started` 标志**——"面是否在监听"的真值源是 face-host 的
      // active 表（`acpHttpActive()`）；并发触发由面宿主的在飞合并兜住（同一面只 bind 一次）。
      const root = await resolveSkiffRoot(ctx)
      return startAcpHttpServer(ctx, s.acpHttpPort, root ?? undefined)
        .catch((err) => {
          console.error(`[serenity-hooks] ✗ ACP HTTP 服务启动失败: ${String((err as Error)?.message ?? err)}`)
        })
    } else if (!anyFace && acpHttpActive()) {
      stopAcpHttpServer()
    }
  }
  try {
    ctx.on('serenity/settings-changed', () => {
      void sync()
    })
  } catch {
    /* 事件通道缺失不阻断（启动时 sync 仍执行） */
  }
  // 启动时同步一次（settings.yaml 持久化 acpEnabled/publicAskEnabled=true → 重启后自动恢复）
  void sync()
}
