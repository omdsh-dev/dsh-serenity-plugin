/**
 * settings-section.ts — 简单配置注册（dsh 原生设置面板，v1.21 分层）
 *
 * 分层决策（S142）：**简单配置（开关/阈值）→ dsh 原生设置面板**；
 * **复杂配置（账号列表）→ 宁静号高级面板**（localstore + /serenity/config）。
 *
 * 本模块承载简单配置层：`SettingsProvider.installSection(ctx, 'serenity-hooks', schema, entry)`
 * 注册 `serenity-hooks` namespace——三功能总开关 + F2 阈值。
 * （v1.28.0 适配 0.1.2-rc.1：installSettingsSection/settingsNamespace 便捷函数消失 → 方法调用）
 *
 * 运行时降级守卫（版本鲁棒性）：旧 RC（staging 架构）api-proxy 有
 * `WEB_SETTINGS_NAMESPACES` 静态白名单，第三方 ns 会收到 settings-not-exposed
 * ——client 面板读不到。新 RC（官方 master）已删除白名单（全量 describe）。
 * 本模块不依赖白名单状态：register 总是执行（host 侧零成本）；
 * **client 侧**（SettingsSection 组件）以 describe 结果为据——ns 不在描述列表
 * 则显示降级提示（引导去宁静号面板），在则渲染 schema 表单。零配置自动适配。
 */

import type { Context } from 'cordis'
import z from '@deepseek-ai/schemastery'
// v1.28.0 适配 0.1.2-rc.1（B4）：installSettingsSection/settingsNamespace 便捷函数在 rc.1 消失 →
// 改 SettingsProvider.installSection。本机运行时仍 rc.2（类型无 installSection），
// 故经类型断言访问——升级 0.1.2-rc.1 后类型原生匹配（见 registerSettingsSection 实现注释）。
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'

/** 插件 Config 的简单配置片段（index.ts Config 组合；settings entry base） */
export interface SimpleConfigFragment {
  gateway?: { enabled?: boolean }
  rebuild?: { enabled?: boolean; thresholdK?: number }
  /** F4 Skiff（实验性）：调试服务启停（人工） */
  skiff?: { enabled?: boolean; debugPort?: number }
  /** F4c ACP（实验性）：HTTP JSON-RPC 端点启停（人工） */
  acp?: { enabled?: boolean; httpPort?: number }
  /** F4d 建议问答页（实验性）：按认知容器暴露问答页供他人验证（全局开关；与 ACP 共用端口） */
  publicAsk?: { enabled?: boolean }
}

/** 简单配置命名空间（dsh 设置面板的 section id / settings.yaml section） */
export const SERENITY_SETTINGS_NS = 'serenity-hooks'

/**
 * 简单配置 schema（schemastery）：三功能总开关 + F2 阈值 + F4 Skiff 启停。
 * 与 DSH settings 的 schema 语义一致（z.object 布尔/数字）。
 */
export interface SerenitySimpleSettings {
  /** F1 双端口网关总开关 */
  gatewayEnabled: boolean
  /** F2 超限重建总开关 */
  rebuildEnabled: boolean
  /** F2 触发阈值（需求① S142 用户拍板：百分比比例 → K 数值；projectedTokens ≥ thresholdK*1000 触发，纯绝对无窗口比例保护） */
  rebuildThresholdK: number
  /** F4 Skiff 调试服务总开关（实验性；默认关——不随插件加载自动启动，人工开启） */
  skiffEnabled: boolean
  /** F4 Skiff 调试端口（默认 3099，仅 127.0.0.1） */
  skiffDebugPort: number
  /** F4c ACP HTTP JSON-RPC 端点总开关（实验性；默认关——人工开启） */
  acpEnabled: boolean
  /** F4c ACP HTTP 端口（默认 3100，仅 127.0.0.1） */
  acpHttpPort: number
  /** F4d 建议问答页总开关（实验性；默认关——按认知容器暴露问答页，key 认证） */
  publicAskEnabled: boolean
  /** Autopilot Trajectory 全局总开关（v1.27.9，默认关——只在指定电脑开启；
   *  关了即使 CCC 配置 enabled=true 也不启动定时器；CCC 级 enabled 仍为必要条件） */
  autopilotEnabled: boolean
}

/** schemastery schema（与 DSH 各插件 Config 同款） */
export const simpleSettingsSchema = z.object({
  gatewayEnabled: z.boolean().default(false),
  rebuildEnabled: z.boolean().default(true),
  rebuildThresholdK: z.number().min(50).max(4000).default(400),
  skiffEnabled: z.boolean().default(false),
  skiffDebugPort: z.number().min(1024).max(65535).default(3099),
  acpEnabled: z.boolean().default(false),
  acpHttpPort: z.number().min(1024).max(65535).default(3100),
  publicAskEnabled: z.boolean().default(false),
  autopilotEnabled: z.boolean().default(false),
})

/** 从插件 Config 提取 entry 默认（settings base 层） */
export function entryDefaults(config: SimpleConfigFragment): SerenitySimpleSettings {
  return {
    gatewayEnabled: config.gateway?.enabled ?? false,
    rebuildEnabled: config.rebuild?.enabled ?? true,
    rebuildThresholdK: config.rebuild?.thresholdK ?? 400,
    skiffEnabled: config.skiff?.enabled ?? false,
    skiffDebugPort: config.skiff?.debugPort ?? 3099,
    acpEnabled: config.acp?.enabled ?? false,
    acpHttpPort: config.acp?.httpPort ?? 3100,
    publicAskEnabled: config.publicAsk?.enabled ?? false,
    autopilotEnabled: false,
  }
}

/** 运行时源（installSettingsSection 注入：settings scope 或 entry fallback） */
let simpleSource: (() => SerenitySimpleSettings) | null = null

/** 进程级默认（无 settings 服务时的兜底） */
export function defaultSimpleSettings(): SerenitySimpleSettings {
  return {
    gatewayEnabled: false,
    rebuildEnabled: true,
    rebuildThresholdK: 400,
    skiffEnabled: false,
    skiffDebugPort: 3099,
    acpEnabled: false,
    acpHttpPort: 3100,
    publicAskEnabled: false,
    autopilotEnabled: false,
  }
}

/**
 * 读取当前简单配置（settings 解析值；无 provider/未注册 → entry 默认）。
 * 各功能（gateway/rebuild/naming）启动与运行时判断开关都经此函数。
 */
export function readSimpleSettings(): SerenitySimpleSettings {
  return simpleSource ? simpleSource() : defaultSimpleSettings()
}

/**
 * 测试注入钩子（生产零调用）：替换/恢复运行时源，便于单测各功能门控
 * （registerSettingsSection 的 setSource 回调在 mock dsh-settings 时不会触发）。
 */
export function __setSimpleSourceForTest(source: (() => SerenitySimpleSettings) | null): void {
  simpleSource = source
}

/**
 * 注册简单配置到 DSH settings（零改 DSH；settings.yaml 持久化 + 原生面板渲染）。
 * 注：插件 Config（cordis.yml 组合层）作为 base；用户文档层叠加其上。
 * 运行时读取简单配置统一经 `readSimpleSettings()`。
 * v1.28.0 适配 0.1.2-rc.1（B4）：`installSettingsSection`/`settingsNamespace` 便捷函数在
 * rc.1 消失 → 改 `SettingsProvider.installSection(owner, ns, schema, entry, hooks)`
 * （owner = consumer 插件 ctx；ns 直接字符串）。
 */
export function registerSettingsSection(ctx: Context, config: SimpleConfigFragment): void {
  // v1.28.0 适配 0.1.2-rc.1（B4）：rc.1 SettingsProvider.installSection(owner, ns, schema, entry, hooks)
  // （owner = consumer 插件 ctx；ns 直接字符串——不再 settingsNamespace() 包装）。
  // ⚠️ this 绑定（第四次同病根治）：installSection 是 SettingsProvider **方法**（内部 this.register），
  // 必须先取实例再 .call() 调用——解构裸调用（const f = obj.m; f()）丢 this → Cannot read register（实崩）。
  interface InstallSectionHooks<T> {
    setSource: (get: () => T) => void
    onChange: () => void
    validate?: (value: T) => void
  }
  const hooks: InstallSectionHooks<unknown> = {
    setSource: (get) => {
      simpleSource = get as unknown as () => SerenitySimpleSettings
    },
    onChange: () => {
      // 简单配置变化（开关/阈值）→ 通知 gateway 重新 sync。
      // 走 'serenity/settings-changed'（非强制）：sync 内部 sig 判断，
      // 无实质 gateway 变化（如仅阈值拖动）不重建，避免无谓断 WS。
      // 账号/监听/白名单变化（/serenity/config PUT）才走 'serenity/config-updated' 强制重建。
      try {
        (ctx as unknown as { emit?: (name: string, payload?: unknown) => void }).emit?.('serenity/settings-changed')
      } catch {
        /* 事件通知失败不影响 settings 保存 */
      }
    },
  }
  const settingsAny = (ctx as unknown as { settings?: unknown }).settings as
    | {
        installSection: (owner: Context, ns: string, schema: unknown, entry: unknown, h: InstallSectionHooks<unknown>) => void
      }
    | undefined
  if (settingsAny) {
    // 方法调用保持 this（v1.28.0 实崩修复：解构 installSection 后裸调用丢 this → this.register undefined）
    settingsAny.installSection.call(
      settingsAny,
      ctx,
      SERENITY_SETTINGS_NS,
      simpleSettingsSchema,
      entryDefaults(config),
      hooks,
    )
    return
  }
  // 无 settings provider → 降级：entry 为源（readSimpleSettings 兜底 defaultSimpleSettings）
  hooks.setSource(() => ({}) as unknown)
  hooks.onChange()
}
