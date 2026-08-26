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
import { createLoopTool } from './tools/loop.js'
import { createSessionTool } from './tools/session.js'
import { localstoreTool } from './tools/localstore.js'
import { registerGuards } from './seams/guards.js'
import { registerBootstrap } from './seams/bootstrap.js'
import { registerKeeper } from './seams/keeper.js'
import { registerContext } from './seams/context.js'
import { registerEntrySkillSectionGlobal } from './seams/system-prompt.js'
import { registerCompactRetention } from './seams/compact.js'
import { registerStatusApi } from './api.js'
import { registerEnv } from './seams/env.js'
import { registerOpencodeSkills } from './seams/opencode-skills.js'
import { DEFAULT_SERENITY_CONFIG_PATHS } from './ccc.js'
import { registerSettingsSection } from './settings-section.js'

export const name = 'dsh-serenity-hooks'

/** 主动调用的服务；其余（agent 事件）随 harness 装配必然存在 */
export const inject = ['tools', 'webServer', 'sessions', 'shellEnv', 'skills', 'agentLoop', 'agents', 'systemPrompt']

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
    ctx.tools.register(createLoopTool(ctx))
    ctx.tools.register(localstoreTool)
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
}
