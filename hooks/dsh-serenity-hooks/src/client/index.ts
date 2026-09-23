/**
 * dsh-serenity-hooks — client half 入口（浏览器 bundle）
 *
 * 注册 UI 面：
 *  - conversation.session.header.actions — 头部状态徽章（绿点 + safe-mode 开关），
 *    点击徽章展开详情卡（CCC/handyman/守卫 + 大开关）。
 *  - conversation.input.dock — 图片自动落盘兜底（S142）：当前模型不支持图片时，
 *    发送失败（MODEL_DOES_NOT_SUPPORT_IMAGES）自动补救——图片上传 _tmp/images_from_user/、
 *    以「用户提供了图片在 {path}」文本重发，agent 经 CCC 自己的 vlm MSM 自主处理。
 *  - conversation.input.dock — 任意文件粘贴自动落盘（v1.24.1）：非图片文件粘贴 →
 *    _tmp/files_from_user/ + draft 追加路径提示（随发送进消息），agent 经 CCC MSM 处理。
 *  - settings.section — dsh 原生设置面板的 serenity-hooks 简单配置页（v1.21 分层：
 *    开关/阈值走 DSH settings；账号列表走宁静号高级面板）。
 * Export 纪律：只暴露 cordis apply 面。
 */

import type {} from '@deepseek-ai/dsh-client-ui-conversation'
import type {} from '@deepseek-ai/dsh-client-ui-settings'
// v1.31.6 适配 0.1.5-rc.1：session 作用域类型面被抽成独立包。
//  - `SessionStandardProps.sessionId`（session-scope slot props 的标准套件）：ui-conversation → ui-session
//  - `Context.sessions`（client 面 ISessions）：ui-session 自己 import 了 api-session-controller/client
// 故本行**一个空类型 import 同时修好两条**（缺它则 props.sessionId / ctx.sessions 在 client 半编译不过）。
// 纯类型导入 → transform 期擦除，不触 client bundle purity 插件，PLATFORM_MODULES 无需改动。
import type {} from '@deepseek-ai/dsh-client-ui-session'
// v1.28.0 适配 0.1.2-rc.1（A1 补充）：官方 feature 插件经 ui-renderer/client 类型 import
// 获得 Context.slots 等 client 面声明合并（原 dsh-client-runtime 包提供；rc.1 已删）。
import type {} from '@deepseek-ai/dsh-client-ui-renderer'
// v1.28.0 适配 0.1.2-rc.1（A1）：dsh-client-runtime 包已删 →
// ClientContext 用官方同款 `Context as ClientContext` from '@deepseek-ai/cordis'。
// 🔴 v1.47 适配 0.1.7-rc.1：`SettingsScope`/`SettingsScopeSpec` 与 `settingsScope` 服务**已从
//    `dsh-client-ui-settings` 移除**（实测：该包 client 面只导出 ConfigForms / ConfigForm /
//    SettingsSchemaService / SettingsDescribe*）⇒ 设置页数据改走 `ctx.configForms`
//    （按 profile 条目 Config 投影的表单），注册面改走 `configForms.whileServed`。
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { SafeModePanel } from './SafeModePanel.js'
import { ImageFallbackDock, ImageFallbackInjected } from './ImageFallbackDock.js'
import { uploadImage, getDraftFiles, resendText } from './image-fallback-api.js'
import { FileFallbackDock, FileFallbackInjected } from './FileFallbackDock.js'
import { uploadFile } from './file-fallback-api.js'
import { SettingsSection, SettingsSectionInjected, SerenitySimpleWire } from './SettingsSection.js'

export const inject = ['slots', 'conversation', 'sessions', 'configForms']

/** 设置页命名空间 = profile 条目 id（与 host 侧 `SERENITY_SETTINGS_NS` 同值；单一真相源在 host 侧常量，此处只作字面量引用） */
const SERENITY_SETTINGS_NS = 'serenity-hooks'

export function apply(ctx: ClientContext): void {
  ctx.inject(['slots', 'conversation', 'sessions', 'configForms'], (scope: ClientContext) => {
    // v1.22.4 定稿：container_trajectory rebuild 复用旧会话原地清空（turn 结束 surface replace），
    // 无新会话创建 → 无需 client 自动切换（同会话 id、同工作区天然保持）。

    scope.effect(
      () =>
        scope.slots.register(
          { name: 'conversation.session.header.actions', id: 'serenity-safe', order: 10 },
          SafeModePanel,
        ),
      'serenity: header status badge',
    )

    // 图片自动落盘兜底（S142）：input.dock 条目，inject 提供图片操作回调（conversation/sessions 服务在 apply 闭包持有）
    scope.effect(
      () =>
        scope.slots.register(
          {
            name: 'conversation.input.dock',
            id: 'serenity-image-fallback',
            order: 100,
            inject: (): ImageFallbackInjected => ({
              uploadImage: (file, sessionId) => uploadImage(file, sessionId),
              getDraftFiles: (sessionId, ids) => getDraftFiles(scope, sessionId, ids),
              resendText: (sessionId, text) => resendText(scope, sessionId, text),
            }),
          },
          ImageFallbackDock,
        ),
      'serenity: image fallback dock',
    )

    // 任意文件粘贴自动落盘（v1.24.1）：input.dock 条目——非图片文件粘贴 →
    // _tmp/files_from_user/ + draft 追加路径提示（随发送进消息，不自动发送）；无 UI
    scope.effect(
      () =>
        scope.slots.register(
          {
            name: 'conversation.input.dock',
            id: 'serenity-file-fallback',
            order: 110,
            inject: (): FileFallbackInjected => ({
              uploadFile: (file, sessionId) => uploadFile(file, sessionId),
            }),
          },
          FileFallbackDock,
        ),
      'serenity: file fallback dock',
    )

    // v1.21 分层：简单配置 → dsh 原生设置面板（settings.section）。
    // v1.47（0.1.7-rc.1 A 案）：数据面 = `configForms.get(条目 id)`（条目 Config 投影的表单）；
    // 注册面 = `configForms.whileServed`——**宿主没在 serve 这个命名空间就不注册**，
    // 这正是旧版 `snapshot.status === 'unavailable'` 降级提示的官方替代（页面自动出现/消失）。
    const serenityForm = scope.configForms.get<SerenitySimpleWire>(SERENITY_SETTINGS_NS)
    scope.effect(
      () =>
        scope.configForms.whileServed([SERENITY_SETTINGS_NS], () =>
          scope.slots.inject('settings.section', () =>
            scope.slots.register(
              {
                name: 'settings.section',
                id: SERENITY_SETTINGS_NS,
                order: 90,
                label: () => 'Serenity',
                inject: (): SettingsSectionInjected => ({
                  hooks: { serenitySettings: serenityForm },
                  set: (field, value) => {
                    // 写失败不抛给 UI：表单快照会由宿主回读（镜像）自行收敛
                    void serenityForm.set(field, value).catch((_error: unknown) => { /* 见上 */ })
                  },
                }),
              },
              SettingsSection,
            ),
          ),
        ),
      'serenity: simple settings section',
    )
  })
}
