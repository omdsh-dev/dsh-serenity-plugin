/**
 * settings-section.ts — 简单配置注册（dsh 原生设置面板，v1.21 分层）
 *
 * 分层决策（S142）：**简单配置（开关/阈值）→ dsh 原生设置面板**；
 * **复杂配置（账号列表）→ 宁静号高级面板**（localstore + /serenity/config）。
 *
 * 本模块承载简单配置层：`installSettingsSection(ctx, settingsNamespace('serenity-hooks'), schema, entry)`
 * 注册 `serenity-hooks` namespace——三功能总开关 + F2 阈值。
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
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'

/** 插件 Config 的简单配置片段（index.ts Config 组合；settings entry base） */
export interface SimpleConfigFragment {
  gateway?: { enabled?: boolean }
  rebuild?: { enabled?: boolean; thresholdRatio?: number }
  naming?: { enabled?: boolean }
}

/** 简单配置命名空间（dsh 设置面板的 section id / settings.yaml section） */
export const SERENITY_SETTINGS_NS = 'serenity-hooks'

/**
 * 简单配置 schema（schemastery）：三功能总开关 + F2 阈值。
 * 与 DSH settings 的 schema 语义一致（z.object 布尔/数字）。
 */
export interface SerenitySimpleSettings {
  /** F1 双端口网关总开关 */
  gatewayEnabled: boolean
  /** F2 超限重建总开关 */
  rebuildEnabled: boolean
  /** F2 contextPressure 触发比例（0~1） */
  rebuildThreshold: number
  /** F3 会话命名总开关 */
  namingEnabled: boolean
}

/** schemastery schema（与 DSH 各插件 Config 同款） */
export const simpleSettingsSchema = z.object({
  gatewayEnabled: z.boolean().default(false),
  rebuildEnabled: z.boolean().default(true),
  rebuildThreshold: z.number().min(0.01).max(1).default(0.9),
  namingEnabled: z.boolean().default(true),
})

/** 从插件 Config 提取 entry 默认（settings base 层） */
export function entryDefaults(config: SimpleConfigFragment): SerenitySimpleSettings {
  return {
    gatewayEnabled: config.gateway?.enabled ?? false,
    rebuildEnabled: config.rebuild?.enabled ?? true,
    rebuildThreshold: config.rebuild?.thresholdRatio ?? 0.9,
    namingEnabled: config.naming?.enabled ?? true,
  }
}

/** 运行时源（installSettingsSection 注入：settings scope 或 entry fallback） */
let simpleSource: (() => SerenitySimpleSettings) | null = null

/** 进程级默认（无 settings 服务时的兜底） */
export function defaultSimpleSettings(): SerenitySimpleSettings {
  return {
    gatewayEnabled: false,
    rebuildEnabled: true,
    rebuildThreshold: 0.9,
    namingEnabled: true,
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
 * 注册简单配置到 DSH settings（零改 DSH；settings.yaml 持久化 + 原生面板渲染）。
 * 注：插件 Config（cordis.yml 组合层）作为 base；用户文档层叠加其上。
 * 运行时读取简单配置统一经 `readSimpleSettings()`。
 */
export function registerSettingsSection(ctx: Context, config: SimpleConfigFragment): void {
  installSettingsSection(
    ctx,
    settingsNamespace(SERENITY_SETTINGS_NS),
    simpleSettingsSchema,
    entryDefaults(config),
    {
      setSource: (get) => {
        simpleSource = get
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
    },
  )
}
