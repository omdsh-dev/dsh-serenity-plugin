/**
 * dsh-serenity-hooks — client half 入口（浏览器 bundle）
 *
 * 注册两个 UI 面：
 *  - conversation.session.header.actions — 头部状态徽章（绿点 + safe-mode 开关），
 *    点击徽章展开详情卡（CCC/loop/守卫 + 大开关）。
 *  - conversation.input.dock — 图片自动落盘兜底（S142）：当前模型不支持图片时，
 *    发送失败（MODEL_DOES_NOT_SUPPORT_IMAGES）自动补救——图片上传 _tmp/images_from_user/、
 *    以「用户提供了图片在 {path}」文本重发，agent 经 CCC 自己的 vlm MSM 自主处理。
 * Export 纪律：只暴露 cordis apply 面。
 */

import type {} from '@deepseek-ai/dsh-client-ui-conversation'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { SafeModePanel } from './SafeModePanel.js'
import { ImageFallbackDock, ImageFallbackInjected } from './ImageFallbackDock.js'
import { uploadImage, getDraftFiles, resendText } from './image-fallback-api.js'

export const inject = ['slots', 'conversation', 'sessions']

export function apply(ctx: ClientContext): void {
  ctx.inject(['slots', 'conversation', 'sessions'], (scope: ClientContext) => {
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
  })
}
