/**
 * dsh-serenity-hooks — 宁静号 ACC harness（Native Cordis 插件，DSH 运行时）
 *
 * 形态（DSH 官方 native hook 约定）：name / inject / Config / apply，无 default export。
 *
 * 能力：
 *   1. 真实 DSH 工具注册：cc_fs（文件系统 15 子命令，含 reveal）、session（会话全周期 7 子命令）
 *   2. 拦截缝机械约束：tools/pre-execute + ctx.tools.guard（安全模式/黑名单/路径守卫）
 *
 * 加载：~/.dsh/config.yaml 加 insert 行（免改 DSH 源码），插件包装入 DSH node_modules。
 *
 * 配置：进程级 Config（cordis.yml 提供）+ 运行时读取 CCC 的 .opencode/serenity.json（规范位置，.dsh 回退）。
 */

import type { Context } from 'cordis'
import z from '@deepseek-ai/schemastery'
import { ccFsTool } from './tools/cc-fs.js'
import { kitTool } from './tools/kit.js'
import { gitTool } from './tools/git.js'
import { msmTool } from './tools/msm.js'
import { eapTool } from './tools/eap.js'
import { neatTool } from './tools/neat.js'
import { cceTool } from './tools/cce.js'
import { createHandymanTool } from './tools/handyman.js'
import { createSessionTool } from './tools/session.js'
import { createRebuildTool } from './tools/rebuild.js'
import { localstoreTool } from './tools/localstore.js'
import { skiffAdminTool } from './tools/skiff-admin.js'
import { createAutoTrajectoryExpTool } from './tools/autotrajectory-exp.js'
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
import { readSkiffRoles } from './skiff-role.js'
import { registerSettingsSection, readSimpleSettings } from './settings-section.js'
import { registerGateway } from './gateway.js'
import { registerRebuildTurnHook } from './rebuild.js'
import { registerOutputGuardHook } from './output-guard-seam.js'
import { migrateLegacyLocalstore, globalConfigPath } from './config-ops.js'
import { startSkiffDebugServer, stopSkiffDebugServer } from './skiff-debug.js'
import { startAcpHttpServer, stopAcpHttpServer } from './acp-http.js'
import { registerAutoTrajectory } from './autotrajectory.js'

export const name = 'dsh-serenity-hooks'

/** 主动调用的服务；其余（agent 事件）随 harness 装配必然存在 */
export const inject = ['tools', 'webServer', 'sessions', 'shellEnv', 'skills', 'agentLoop', 'agents', 'systemPrompt', 'sessionProjections']

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
  rebuild?: { enabled?: boolean; thresholdRatio?: number }
  /** F3 会话命名（entry 默认值，运行时经 DSH settings） */
  naming?: { enabled?: boolean }
  /** F4 Skiff（实验性）：调试服务启停（entry 默认值，运行时经 DSH settings） */
  skiff?: { enabled?: boolean; debugPort?: number }
  /** F4c ACP（实验性）：HTTP JSON-RPC 端点启停（entry 默认值，运行时经 DSH settings） */
  acp?: { enabled?: boolean; httpPort?: number }
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
  rebuild: z.object({ enabled: z.boolean().default(true), thresholdRatio: z.number().min(0.01).max(1).default(0.9) }),
  naming: z.object({ enabled: z.boolean().default(true) }),
  skiff: z.object({ enabled: z.boolean().default(false), debugPort: z.number().min(1024).max(65535).default(3099) }),
  acp: z.object({ enabled: z.boolean().default(false), httpPort: z.number().min(1024).max(65535).default(3100) }),
})

export function apply(ctx: Context, config: Config): void {
  if (config.tools) {
    ctx.tools.register(ccFsTool)
    ctx.tools.register(createSessionTool(ctx))
    ctx.tools.register(kitTool)
    ctx.tools.register(gitTool)
    ctx.tools.register(msmTool)
    ctx.tools.register(eapTool)
    ctx.tools.register(neatTool)
    ctx.tools.register(cceTool)
    ctx.tools.register(createHandymanTool(ctx))
    ctx.tools.register(createRebuildTool(ctx))
    ctx.tools.register(localstoreTool)
    ctx.tools.register(skiffAdminTool)
    // 自主轨迹实验一站式管理（v1.26.12 实验提案，默认关；只提供工具与知识，不自动安装任何东西）
    // v1.26.14：闭包捕获 ctx → diag-live 进程内诊断（live 会话/标题/agent 定位）
    ctx.tools.register(createAutoTrajectoryExpTool(ctx))
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
  // v1.22.4 定稿：session_rebuild 排队 → agent/turn-stopping 时执行真正清空（复用旧会话原地重来）
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
  // 自主轨迹（v1.26.12 实验提案）：CCC 定义（serenity.json autotrajectory）→ 时钟唤起 +
  // 先验偏见注入（前台运行）。enabled=false 未配置 → 零资源占用；不触碰任何现有机制。
  registerAutoTrajectory(ctx)
}

/**
 * F4 Skiff 调试服务装配：启停 = 人工（设置面板 Skiff 区块开关，settings 持久化）。
 * settings-changed 事件触发同步（skiffEnabled 开 → 启动调试服务；关 → 停止）。
 * 角色配置（skiff.roles）从当前 CCC 根读取（进程 cwd 优先，live 会话兜底）。
 */
function registerSkiff(ctx: Context): void {
  let started = false
  const sync = (): void => {
    const s = readSimpleSettings()
    if (s.skiffEnabled && !started) {
      const root = resolveSkiffRoot(ctx)
      if (!root) {
        console.warn('[serenity-hooks] ✗ Skiff 调试服务未启动：无法定位 CCC root（进程 cwd 与 live 会话均无 .serenity）')
        return
      }
      const webPort = readWebPort(ctx)
      startSkiffDebugServer(ctx, root, s.skiffDebugPort, webPort)
        .then(() => {
          started = true
        })
        .catch((err) => {
          console.error(`[serenity-hooks] ✗ Skiff 调试服务启动失败: ${String((err as Error)?.message ?? err)}`)
        })
    } else if (!s.skiffEnabled && started) {
      stopSkiffDebugServer()
      started = false
    }
  }
  try {
    ctx.on('serenity/settings-changed', sync)
  } catch {
    /* 事件通道缺失不阻断（启动时 sync 仍执行） */
  }
  // 启动时同步一次（settings.yaml 持久化 skiffEnabled=true → 重启后自动恢复调试服务）
  sync()
}

/**
 * 解析 Skiff 调试服务绑定的 CCC 根（v1.25.2 用户指出：skiff 必须绑定 CCC）：
 * ① live 会话中**配置了 skiff.roles 的 CCC 优先**（用户认知中的绑定目标）
 * ② 回退进程 cwd 上溯 .serenity
 * ③ 再回退任一 live 会话的 CCC
 */
function resolveSkiffRoot(ctx: Context): string | null {
  const liveRoots: string[] = []
  try {
    const sessions = (ctx as unknown as { sessions?: { list?: () => Array<{ header?: { cwd?: string } }> } }).sessions
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
    const ws = (ctx as unknown as { webServer?: { port?: number } }).webServer
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
