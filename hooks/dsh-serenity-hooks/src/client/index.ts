/**
 * dsh-serenity-hooks — client half 入口（浏览器 bundle）
 *
 * 注册一个 UI 面：
 *  - conversation.session.header.actions — 头部状态徽章（绿点 + safe-mode 开关），
 *    点击徽章展开详情卡（CCC/loop/守卫 + 大开关）。
 * Export 纪律：只暴露 cordis apply 面。
 */

import type {} from '@deepseek-ai/dsh-client-ui-conversation'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { SafeModePanel } from './SafeModePanel.js'

export const inject = ['slots', 'conversation']

export function apply(ctx: ClientContext): void {
  ctx.inject(['slots', 'conversation'], (scope: ClientContext) => {
    scope.effect(
      () =>
        scope.slots.register(
          { name: 'conversation.session.header.actions', id: 'serenity-safe', order: 10 },
          SafeModePanel,
        ),
      'serenity: header status badge',
    )
  })
}
