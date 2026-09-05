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
// v1.28.0 适配 0.1.2-rc.1（A1 补充）：官方 feature 插件经 ui-renderer/client 类型 import
// 获得 Context.slots 等 client 面声明合并（原 dsh-client-runtime 包提供；rc.1 已删）。
import type {} from '@deepseek-ai/dsh-client-ui-renderer'
// v1.28.0 适配 0.1.2-rc.1（A1）：dsh-client-runtime 包已删 →
// ClientContext 用官方同款 `Context as ClientContext` from '@deepseek-ai/cordis'；
// SettingsScope/SettingsScopeSpec 改从 '@deepseek-ai/dsh-client-ui-settings/client'（官方再导出实证）。
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SettingsScope, SettingsScopeSpec } from '@deepseek-ai/dsh-client-ui-settings/client'
import { SafeModePanel } from './SafeModePanel.js'
import { ImageFallbackDock, ImageFallbackInjected } from './ImageFallbackDock.js'
import { uploadImage, getDraftFiles, resendText } from './image-fallback-api.js'
import { FileFallbackDock, FileFallbackInjected } from './FileFallbackDock.js'
import { uploadFile } from './file-fallback-api.js'
import { SettingsSection, SettingsSectionInjected, SerenitySimpleWire } from './SettingsSection.js'

export const inject = ['slots', 'conversation', 'sessions', 'settingsScope']

/** serenity-hooks 简单配置 scope spec（与 host 侧 registerSettingsSection 对齐） */
const SERENITY_SCOPE_SPEC: SettingsScopeSpec<SerenitySimpleWire> = {
  namespace: 'serenity-hooks',
  decode: (section) => (section !== null && typeof section === 'object' ? (section as SerenitySimpleWire) : undefined),
}

export function apply(ctx: ClientContext): void {
  ctx.inject(['slots', 'conversation', 'sessions', 'settingsScope'], (scope: ClientContext) => {
    // v1.22.4 定稿：session_rebuild 复用旧会话原地清空（turn 结束 surface replace），
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

    // v1.21 分层：简单配置 → dsh 原生设置面板（settings.section；降级守卫在组件内）
    const settingsScope = scope.get('settingsScope') as {
      bind: <T>(spec: SettingsScopeSpec<T>) => SettingsScope<T>
    }
    const serenityScope = settingsScope.bind<SerenitySimpleWire>(SERENITY_SCOPE_SPEC)
    scope.effect(
      () =>
        scope.slots.register(
          {
            name: 'settings.section',
            id: 'serenity-hooks',
            order: 90,
            label: () => 'Serenity',
            inject: (): SettingsSectionInjected => ({ scope: serenityScope }),
          },
          SettingsSection,
        ),
      'serenity: simple settings section',
    )
  })
}
