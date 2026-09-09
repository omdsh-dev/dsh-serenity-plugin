/**
 * dsh-serenity-hooks — 宁静号 ACC harness（Native Cordis 插件，DSH 运行时）
 *
 * 形态（DSH 官方 native hook 约定）：name / inject / Config / apply，无 default export。
 *
 * 能力：
 *   1. 真实 DSH 工具注册：container_fs（文件系统 15 子命令，含 reveal）、logbook（会话全周期含 rebuild）
 *   2. 拦截缝机械约束：tools/pre-execute + ctx.tools.guard（安全模式/黑名单/路径守卫）
 *
 * 加载：~/.dsh/config.yaml 加 insert 行（免改 DSH 源码），插件包装入 DSH node_modules。
 *
 * 配置：进程级 Config（cordis.yml 提供）+ 运行时读取 CCC 的 .opencode/serenity.json（规范位置，.dsh 回退）。
 */

import type { Context } from 'cordis'
import z from '@deepseek-ai/schemastery'
import { ccFsTool } from './tools/cc-fs.js'
import { createKitTool } from './tools/kit.js'
import { gitTool } from './tools/git.js'
import { msmTool } from './tools/msm.js'
import { praxisTool } from './tools/praxis.js'
import { createHandymanTool } from './tools/handyman.js'
import { createSessionTool } from './tools/session.js'
import { localstoreTool } from './tools/localstore.js'
import { containerAdminTool } from './tools/container-admin.js'
import { createAutopilotTool } from './tools/autopilot-trajectory.js'
import { registerGuards } from './seams/guards.js'
import { registerBootstrap } from './seams/bootstrap.js'
import { registerKeeper } from './seams/keeper.js'
import { registerContext } from './seams/context.js'
import { registerEntrySkillSectionGlobal } from './seams/system-prompt.js'
import { registerCompactRetention } from './seams/compact.js'
import { registerStatusApi } from './api.js'
import { registerEnv } from './seams/env.js'
import { registerOpencodeSkills } from './seams/opencode-skills.js'
import { DEFAULT_SERENITY_CONFIG_PATHS, findSerenityRoot } from './ccc.js'
import { hostSessions, hostWebServer } from './host/access.js'
import { probeHostContract, summarizeHostContract } from './host/contract.js'
import { readDshVersion } from './status.js'
import { readSkiffRoles } from './skiff-role.js'
import { registerSettingsSection, readSimpleSettings } from './settings-section.js'
import { registerGateway } from './gateway.js'
import { registerRebuildTurnHook } from './rebuild.js'
import { registerOutputGuardHook } from './output-guard-seam.js'
import { migrateLegacyLocalstore, globalConfigPath } from './config-ops.js'
import { startSkiffDebugServer, stopSkiffDebugServer } from './skiff-debug.js'
import { startAcpHttpServer, stopAcpHttpServer } from './acp-http.js'
import { registerAutopilot } from './autopilot-trajectory.js'
import { registerWeixinBridge } from './weixin-bridge.js'
import { registerWeixinSendApi } from './weixin-send-api.js'
import { registerWeixinOutputGuard } from './weixin-output-guard.js'
import { registerLifecycle } from './seams/lifecycle.js'
import { registerWebFetchProvider } from './web-fetch-provider.js'
import { registerImChannel } from './im-bridge.js'
import { weixinChannel } from './im-weixin.js'
import { createImBridgeTool } from './tools/im-bridge.js'
import { registerDisposer } from './host/effect.js'

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
}

export const Config: z<Config> = z.object({
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
  skiff: z.object({ enabled: z.boolean().default(false), debugPort: z.number().min(1024).max(65535).default(3099) }),
  acp: z.object({ enabled: z.boolean().default(false), httpPort: z.number().min(1024).max(65535).default(3100) }),
  webFetch: z.object({ enabled: z.boolean().default(true) }),
})

export function apply(ctx: Context, config: Config): void {
  // review F-05（v1.30.7）：装载时核对宿主契约（服务/成员/宿主版本）——把"静默漂移"
  // 变成启动可见信号。探针自身永不抛错：宿主对插件 apply 抛错会导致整个 dsh 启动失败
  // （app-boot 的 "plugin(s) failed to load" 语义），探针不能成为新的单点。
  try {
    const report = probeHostContract(ctx, readDshVersion())
    if (report.issues.length > 0) console.warn(`[serenity-hooks] ${summarizeHostContract(report)}`)
  } catch {
    /* 探针失败不阻断插件装载 */
  }
  // v1.31.0（S142 用户洞察「微信桥是 ACC 提供的，发送能力也应是 ACC 的工具」）：
  // IM 通道注册必须发生在工具装配**之前**——`im-bridge` 的 description 读通道枚举
  // （imChannelIds）。可见性不在这里判定：未配置通道的 CCC 由 guards 逐 agent
  // `tools.restrict({deny:['im-bridge']})` 从清单中移除（未配置 = 模型看不到）。
  registerImChannel(weixinChannel)
  if (config.tools) {
    ctx.tools.register(ccFsTool) // container_fs
    ctx.tools.register(createSessionTool(ctx)) // logbook（含 rebuild）
    ctx.tools.register(createKitTool(ctx)) // dashboard
    ctx.tools.register(gitTool) // container_git
    ctx.tools.register(msmTool) // msm（单入口执行 + 发现）
    ctx.tools.register(praxisTool) // praxis（eap/neat/cce 三合一）
    ctx.tools.register(createHandymanTool(ctx))
    ctx.tools.register(localstoreTool)
    ctx.tools.register(containerAdminTool) // container_admin（role + msm 管理 + config）
    // Autopilot Trajectory 一站式管理（v1.26.12 实验 → v1.27.4 正式化；默认关；只提供工具与知识，不自动安装任何东西）
    // v1.26.14：闭包捕获 ctx → diag-live 进程内诊断（live 会话/标题/agent 定位）
    ctx.tools.register(createAutopilotTool(ctx))
    // v1.31.0：IM 消息发送（条件可见——本 CCC 未配置任何 IM 通道时由 guards 移除）
    ctx.tools.register(createImBridgeTool())
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
  }
  // v1.21 分层：简单配置（开关/阈值）注册到 dsh 原生设置面板（零改 DSH；
  // 旧 RC 白名单存在时 client 侧自动降级，账号复杂配置走宁静号面板不受影响）
  registerSettingsSection(ctx, config)
  // v1.21 F1：双端口网关（第二监听器 + 登录 + 反代；v1.22 起 plugin 全局——
  // enabled 读 DSH settings 开关，host/port/accounts 读全局文件，不依赖具体 CCC；
  // 旧 CCC localstore 配置在首个 agent/session-start 时一次性迁移）
  registerGateway(ctx)
  // v1.22.4 定稿：logbook rebuild（原 session_rebuild）排队 → agent/turn-stopping 时执行真正清空（复用旧会话原地重来）
  registerRebuildTurnHook(ctx)
  // v1.26.3 输出守卫：最终输出敏感词检测 + steer 打回重生成（凭据/机制/MSM 名不泄露给用户）
  registerOutputGuardHook(ctx)
  // v1.21 F3：use 激活宁静号会话时同步重命名当前 dsh 会话（在 createSessionTool 内实现，
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
  // Autopilot Trajectory（v1.26.12 实验 → v1.27.4 正式化）：CCC 定义（serenity.json
  // autopilotTrajectory，旧键 autotrajectory 兼容）→ 时钟遍历多 CCC 各自唤起 +
  // 先验偏见注入（前台运行）。enabled=false 未配置 → 零资源占用；不触碰任何现有机制。
  registerAutopilot(ctx)
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
}

/**
 * F4 Skiff 调试服务装配：启停 = 人工（设置面板 Skiff 区块开关，settings 持久化）。
 * settings-changed 事件触发同步（skiffEnabled 开 → 启动调试服务；关 → 停止）。
 * 角色配置（skiff.roles）从当前 CCC 根读取（进程 cwd 优先，live 会话兜底）。
 *
 * v1.30.13（S142 诊断 D1）：**CCC root 解析失败要重试**。旧实现只在 apply 时同步一次——
 * 此刻通常还没有 live 会话，进程 cwd（服务启动目录）也不在 CCC 内 → `resolveSkiffRoot`
 * 返回 null → 打印一行警告后**永不重试**（实证：重启日志
 * `✗ Skiff 调试服务未启动：无法定位 CCC root`，`ss -ltn` 无 3099；同批 ACP 因容忍
 * `root ?? undefined` 而正常启动）。现形态三层触发（用户"锚定要准确"同源要求）：
 *   ① 启动时同步一次 ② 定位失败 → 定时退避重试（1s/3s/8s/20s/40s，共 5 次）
 *   ③ 首个 live 会话就绪（`agent/session-start` / `session/created`）→ 立即再试一次。
 *
 * v1.30.14（重启日志实证后的收敛）：**并发启动守卫** + 首次未定位降级为信息级日志。
 *  - 实证（v1.30.13 重启日志）：重试定时器与"会话就绪"事件几乎同时触发 → 两次 sync 都
 *    看到 `started === false` → **两次 start**（第一次绑定成功、第二次 `EADDRINUSE` 刷错误日志）。
 *    → 加 `starting` 在飞标志（启动 Promise settle 前不再重复发起）。
 *  - 首次未定位**不是失败**（apply 时无 live 会话是常态）→ 用 `console.log` 说明"等待 live 会话"，
 *    只有**退避重试耗尽**才 `console.warn` 报错（失败语义只留给真正失败）。
 */
function registerSkiff(ctx: Context): void {
  let started = false
  let starting = false
  let retryTimer: NodeJS.Timeout | null = null
  let retries = 0
  let informedRoot = false

  const clearRetry = (): void => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  /** 退避重试定位 CCC root（幂等：已有待执行重试则不再排） */
  const scheduleRootRetry = (): void => {
    if (retryTimer !== null || started || starting) return
    if (retries >= SKIFF_ROOT_RETRY_DELAYS_MS.length) {
      console.warn(
        `[serenity-hooks] ✗ Skiff 调试服务未启动：重试 ${retries} 次仍无法定位 CCC root（进程 cwd 与 live 会话均无 .serenity）`,
      )
      return
    }
    const delay = SKIFF_ROOT_RETRY_DELAYS_MS[retries] ?? 0
    retryTimer = setTimeout(() => {
      retryTimer = null
      retries += 1
      sync()
    }, delay)
    // 不阻止进程退出（与 autopilot 时钟同款）
    retryTimer.unref?.()
  }

  function sync(): void {
    const s = readSimpleSettings()
    if (s.skiffEnabled && !started && !starting) {
      const root = resolveSkiffRoot(ctx)
      if (!root) {
        if (!informedRoot) {
          informedRoot = true
          // 信息级（非失败）：apply 阶段无 live 会话是常态，退避重试与就绪事件会接手
          console.log(
            '[serenity-hooks] Skiff 调试服务等待 CCC root（此刻无 live 会话；已排入退避重试，会话就绪即试）',
          )
        }
        scheduleRootRetry()
        return
      }
      clearRetry()
      const webPort = readWebPort(ctx)
      starting = true
      startSkiffDebugServer(ctx, root, s.skiffDebugPort, webPort)
        .then(() => {
          started = true
          if (retries > 0) console.info(`[serenity-hooks] ✓ Skiff 调试服务已启动（重试 ${retries} 次后定位到 CCC root: ${root}）`)
        })
        .catch((err) => {
          console.error(`[serenity-hooks] ✗ Skiff 调试服务启动失败: ${String((err as Error)?.message ?? err)}`)
        })
        .finally(() => {
          starting = false
        })
    } else if (!s.skiffEnabled && started) {
      stopSkiffDebugServer()
      started = false
    } else if (!s.skiffEnabled) {
      // 关闭状态：清掉待执行的重试（避免关开关后仍起服务）
      clearRetry()
      retries = 0
      informedRoot = false
    }
  }

  try {
    ctx.on('serenity/settings-changed', sync)
  } catch {
    /* 事件通道缺失不阻断（启动时 sync 仍执行） */
  }
  // ② / ③：live 会话就绪是"CCC root 现在可解析"的最强信号（重启后会话恢复、用户开始对话）
  for (const eventName of ['agent/session-start', 'session/created'] as const) {
    try {
      ctx.on(eventName, () => {
        if (!started) sync()
      })
    } catch {
      /* 事件通道缺失不阻断（退避重试仍兜底） */
    }
  }
  // 启动时同步一次（settings.yaml 持久化 skiffEnabled=true → 重启后自动恢复调试服务）
  sync()
  // F-08（v1.30.8 纪律）：重试定时器随插件卸载/HMR 拆卸（否则卸载后仍会尝试起服务）
  registerDisposer(ctx, 'skiff root retry timer', clearRetry)
}

/** Skiff 调试服务 CCC root 退避重试间隔（毫秒；累计 ~72s 后放弃并响亮告警） */
const SKIFF_ROOT_RETRY_DELAYS_MS = [1000, 3000, 8000, 20000, 40000] as const

/**
 * 解析 Skiff 调试服务绑定的 CCC 根（v1.25.2 用户指出：skiff 必须绑定 CCC）：
 * ① live 会话中**配置了 skiff.roles 的 CCC 优先**（用户认知中的绑定目标）
 * ② 回退进程 cwd 上溯 .serenity
 * ③ 再回退任一 live 会话的 CCC
 */
function resolveSkiffRoot(ctx: Context): string | null {
  const liveRoots: string[] = []
  try {
    const sessions = hostSessions(ctx)
    for (const s of sessions?.list?.() ?? []) {
      const cwd = s?.header?.cwd
      if (typeof cwd === 'string') {
        const r = findSerenityRoot(cwd)
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
  const fromCwd = findSerenityRoot(process.cwd())
  if (fromCwd) return fromCwd
  // ③ 任一 live CCC
  return liveRoots[0] ?? null
}

/** 主 WebUI 端口（WebUI 链接；webServer 未装配回退 3080） */
function readWebPort(ctx: Context): number {
  try {
    const ws = hostWebServer(ctx)
    return typeof ws?.port === 'number' ? ws.port : 3080
  } catch {
    return 3080
  }
}

/**
 * F4c ACP HTTP + F4d 建议问答页装配（v1.26.x 实验性）：启停 = 人工（设置面板
 * 「Serenity」页 ACP / 问答页开关，settings 持久化）。任一面开启即启动服务
 * （同一端口：POST / = JSON-RPC 需 acpEnabled；GET / + /ask = 问答页需 publicAskEnabled）。
 * 会话创建/延续走 acp-core → skiff-core；仅监听 127.0.0.1；未开启零资源占用。
 */
function registerAcp(ctx: Context): void {
  let started = false
  const sync = (): void => {
    const s = readSimpleSettings()
    const anyFace = s.acpEnabled || s.publicAskEnabled
    if (anyFace && !started) {
      const root = resolveSkiffRoot(ctx)
      startAcpHttpServer(ctx, s.acpHttpPort, root ?? undefined)
        .then(() => {
          started = true
        })
        .catch((err) => {
          console.error(`[serenity-hooks] ✗ ACP HTTP 服务启动失败: ${String((err as Error)?.message ?? err)}`)
        })
    } else if (!anyFace && started) {
      stopAcpHttpServer()
      started = false
    }
  }
  try {
    ctx.on('serenity/settings-changed', sync)
  } catch {
    /* 事件通道缺失不阻断（启动时 sync 仍执行） */
  }
  // 启动时同步一次（settings.yaml 持久化 acpEnabled/publicAskEnabled=true → 重启后自动恢复）
  sync()
}
