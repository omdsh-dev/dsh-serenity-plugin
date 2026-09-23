/**
 * settings-section.ts — 简单配置读取（dsh 原生设置面板；v1.21 分层，**v1.47 A 案移植到 0.1.7 表单模型**）
 *
 * 分层决策（S142）：**简单配置（开关/阈值）→ dsh 原生设置面板**；
 * **复杂配置（账号列表）→ 宁静号高级面板**（localstore + /serenity/config）。
 *
 * ## 🔴 v0.1.7 起（A 案）：**"安装 section"这件事整段退场**
 *
 * 宿主把 `SettingsProvider.installSection` 换成 `SettingsForms`：设置页不再由插件
 * "注册一个 namespace + schema + entry + hooks"，而是**由插件自己的 cordis `Config`
 * schema 投影成表单**（`packages/settings/settings` 的 `describe()` 遍历 profile 条目）。
 * ⇒ 命名空间**就是 profile 条目 id** —— 本插件 = `serenity-hooks`
 * （见 `cordis.patch.yml` 的 `- insert: - id: serenity-hooks`）。
 *
 * ## 为什么旧扁平键**原样保留**（这是本文件最容易被后人改错的地方）
 *
 * 旧模型把简单配置存成 `~/.dsh/settings.yaml` 的 `serenity-hooks:` 段，字段名是**扁平**的
 * （`gatewayEnabled` / `skiffEnabled` / …）。新模型的命名空间**逐字相同**
 * （`serenity-hooks`），而宿主的 `SettingsForms.importLegacyDocument()` 会把该段
 * **按同名条目导入**；schemastery 的 object 解析在非 strict 模式下 `merge(result, data)`
 * ⇒ **未声明的键会被保留而非报错**。⇒ 只要这些扁平键**仍在本插件 Config 里声明**，
 * **旧值就自动随宿主导入搬过来，零迁移代码**（这正是宿主的迁移惯例：`LEGACY_SECTION_ENTRIES`
 * 只重映射**段名**，从不改写字段名）。
 *
 * ## 两层拼写（**有意保留，不是重复真相源**）
 *
 * | 层 | 拼写 | 谁写 | 语义 |
 * |---|---|---|---|
 * | **面板层**（用户层） | 扁平键 `gatewayEnabled` | 设置面板 / 宿主 legacy 导入 | 用户在界面上改的那个 |
 * | **部署层** | 嵌套段 `gateway.enabled` | `cordis.yml` / bundle patch | 部署时的缺省 |
 *
 * 读取优先级 = **面板层 > 部署层 > 内建缺省**（`simpleSettingsFromConfig`）。
 * 🔴 面板层的键**故意不带 schemastery 默认值** —— 有默认值就永远非 `undefined`，
 * 部署层会被无声压死（"未设置"必须可观测）。
 */

import type { Context } from 'cordis'
import { hostSettings } from './host/access.js'
// C4 块 B：端口默认值只从集中端口表取（不再散写）
import { ACP_HTTP_PORT, SKIFF_DEBUG_PORT } from './ports.js'

/** 插件 Config 的简单配置片段（index.ts 的 Config 子集；面板层 + 部署层两种拼写） */
interface SimpleConfigFragment {
  // ── 部署层（cordis.yml / bundle patch）──
  gateway?: { enabled?: boolean }
  rebuild?: { enabled?: boolean; thresholdK?: number }
  /** F4 Skiff（实验性）：调试服务启停（人工） */
  skiff?: { enabled?: boolean; debugPort?: number }
  /** F4c ACP（实验性）：HTTP JSON-RPC 端点启停（人工） */
  acp?: { enabled?: boolean; httpPort?: number }
  // ── 面板层（扁平键；无默认值 ⇒ "未设置"可观测）──
  gatewayEnabled?: boolean
  rebuildEnabled?: boolean
  rebuildThresholdK?: number
  skiffEnabled?: boolean
  skiffDebugPort?: number
  acpEnabled?: boolean
  acpHttpPort?: number
  publicAskEnabled?: boolean
  croEnabled?: boolean
  unattendedEnabled?: boolean
}

/**
 * 设置面板命名空间 = **profile 条目 id**（v0.1.7 起；与旧 `settings.yaml` 段名逐字相同）。
 */
export const SERENITY_SETTINGS_NS = 'serenity-hooks'

/** 简单配置的扁平形态（运行时读取的统一形状；各功能门控只看它） */
interface SerenitySimpleSettings {
  /** F1 双端口网关总开关 */
  gatewayEnabled: boolean
  /** F2 超限重建总开关 */
  rebuildEnabled: boolean
  /** F2 触发阈值（需求① S142 用户拍板：百分比比例 → K 数值；projectedTokens ≥ thresholdK*1000 触发） */
  rebuildThresholdK: number
  /** F4 Skiff 调试服务总开关（实验性；默认关——不随插件加载自动启动，人工开启） */
  skiffEnabled: boolean
  /** F4 Skiff 调试端口（默认 3099，仅 127.0.0.1） */
  skiffDebugPort: number
  /** F4c ACP HTTP JSON-RPC 端点总开关（实验性；默认关） */
  acpEnabled: boolean
  /** F4c ACP HTTP 端口（默认 3100，仅 127.0.0.1） */
  acpHttpPort: number
  /** F4d 建议问答页总开关（实验性；默认关——按认知容器暴露问答页，key 认证） */
  publicAskEnabled: boolean
  /** **CRO（轨迹自编程唤起）总开关**（2026-09-21 所有者令新增；**缺省开**）。
   *
   *  CRO = 轨迹目录下放一个 `continuous-re-occurrence.ts`，由 ACC 的 5min tick spawn，
   *  由**程序**决定"要不要唤、何时唤、唤起的提示词是什么"。
   *  缺省开的理由：① 已在生产稳定运行（S151 / S185）；② 默认存在感为零（没有程序文件的轨迹
   *  本来就不参与）；③ 缺省关会让"已上线的程序突然不跑"。
   *  **只关 CRO 阶段**：`send-later` / `send-now` / 唤醒表投递**照常**。
   *  ⚠️ 与它**同时废止**的键：`wakeSchedulerEnabled`（唤醒调度器现恒开、无闸；旧键静默忽略）。 */
  croEnabled: boolean
  /** **无人值守代理回复（unattended proxy）总开关**（2026-09-23 所有者令新增；**缺省关**）。
   *
   *  开启后：CCC 会话**被 LLM 主动停止**且无人应答时，ACC 注入一次**代理用户的结构化回复**，
   *  以**验证码（nonce）**作「合法收束」判据 —— **未回码 ⇒ 继续，回码 ⇒ 放过**。
   *  **缺省关**：它把**人**从回路里拿掉（失败模式是静默的）。
   *  **排除面**：仅有 CRO 程序的轨迹不适用（所有者 2026-09-23 裁决：口径由"宽"改"窄"
   *  —— 原"任何自排唤醒都排除"会让本机制永远够不着靠续接绳活着的维护会话；改窄后
   *  **自排绳不再排除**，绳退化为**长周期保险丝**）。设计全文见 S142 的 **D77**。 */
  unattendedEnabled: boolean
}

/** 进程级默认（无 Config 可读时的兜底；与 Config 各字段的缺省一致） */
export function defaultSimpleSettings(): SerenitySimpleSettings {
  return {
    gatewayEnabled: false,
    rebuildEnabled: true,
    rebuildThresholdK: 400,
    skiffEnabled: false,
    skiffDebugPort: SKIFF_DEBUG_PORT,
    acpEnabled: false,
    acpHttpPort: ACP_HTTP_PORT,
    publicAskEnabled: false,
    croEnabled: true,
    unattendedEnabled: false,
  }
}

/**
 * Config（宿主 Loader 校验后的解析值）→ 扁平简单配置。**本文件唯一的读取语义**。
 *
 * 优先级：**面板层（扁平键）> 部署层（嵌套段）> 内建缺省**。
 * @param config - 插件 Config（`fiber.config` 或 apply 收到的 config）
 * @returns 扁平开关集合
 */
export function simpleSettingsFromConfig(config: SimpleConfigFragment): SerenitySimpleSettings {
  const d = defaultSimpleSettings()
  return {
    gatewayEnabled: config.gatewayEnabled ?? config.gateway?.enabled ?? d.gatewayEnabled,
    rebuildEnabled: config.rebuildEnabled ?? config.rebuild?.enabled ?? d.rebuildEnabled,
    rebuildThresholdK: config.rebuildThresholdK ?? config.rebuild?.thresholdK ?? d.rebuildThresholdK,
    skiffEnabled: config.skiffEnabled ?? config.skiff?.enabled ?? d.skiffEnabled,
    skiffDebugPort: config.skiffDebugPort ?? config.skiff?.debugPort ?? d.skiffDebugPort,
    acpEnabled: config.acpEnabled ?? config.acp?.enabled ?? d.acpEnabled,
    acpHttpPort: config.acpHttpPort ?? config.acp?.httpPort ?? d.acpHttpPort,
    publicAskEnabled: config.publicAskEnabled ?? d.publicAskEnabled,
    croEnabled: config.croEnabled ?? d.croEnabled,
    unattendedEnabled: config.unattendedEnabled ?? d.unattendedEnabled,
  }
}

/** 运行时源（`registerSettingsSection` 装配：读本插件 fiber 的**当前** Config） */
let simpleSource: (() => SerenitySimpleSettings) | null = null

/**
 * 读取当前简单配置（各功能 gateway/rebuild/skiff/… 的启动与运行时判断都经此）。
 *
 * 源 = 本插件 fiber 的 `config`（宿主在配置变更时走 `fiber.update()` ⇒ `config` 始终最新，
 * **不必**依赖 apply 重跑，也不必缓存）。
 * @returns 扁平开关集合
 */
export function readSimpleSettings(): SerenitySimpleSettings {
  return simpleSource ? simpleSource() : defaultSimpleSettings()
}

/**
 * 测试注入钩子（生产零调用）：替换/恢复运行时源，便于单测各功能门控。
 */
export function __setSimpleSourceForTest(source: (() => SerenitySimpleSettings) | null): void {
  simpleSource = source
}

/**
 * 装配简单配置读取面（v1.21 分层；**v0.1.7 起不再注册任何 section**）。
 *
 * 两件事：
 *  1. 把"本插件自己的 Config"接成简单配置源 —— 读 `ctx.fiber.config`（宿主 `fiber.update()`
 *     保证最新），拿不到 fiber 时退回 apply 收到的 `config`。
 *  2. 关掉宿主按 Config schema **自动生成**的通用页（`settings.configure({ auto: false })`）——
 *     门面是我们的自定义页 `client/SettingsSection.tsx`（同一个命名空间，同一份数据）。
 *
 * ⚠️ 两个失败都不阻断插件装载（面板是附属能力，绝不能成为启动单点）。
 * @param ctx - 插件上下文
 * @param config - apply 收到的 Config（fiber.config 不可用时的兜底）
 */
export function registerSettingsSection(ctx: Context, config: SimpleConfigFragment): void {
  const fiber = (ctx as unknown as { fiber?: { config?: unknown } }).fiber
  const readConfig = (): SimpleConfigFragment => (fiber?.config ?? config) as SimpleConfigFragment
  simpleSource = () => simpleSettingsFromConfig(readConfig())

  const settings = hostSettings(ctx) as { configure?: (presentation: { auto?: boolean }, owner?: unknown) => unknown } | undefined
  try {
    // 自动生成页 = 把整张 Config schema（含 serenityConfigPaths / 部署层各段）摊给用户看，
    // 与我们那张按功能分组、带中文说明的自定义页重复 ⇒ 只留自定义页。
    settings?.configure?.({ auto: false }, fiber)
  } catch {
    /* 面板策略设置失败不影响插件运行（最坏情况：多出一张通用页） */
  }
}
