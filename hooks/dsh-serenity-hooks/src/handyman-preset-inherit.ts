/**
 * handyman-preset-inherit.ts — handyman worker 的 preset 继承 + 工具面收窄（纯函数，可单测）
 *
 * v1.24.0：loop → handyman 重命名。对齐 subagent 先例（applyChildComposition →
 * agentPresets.composeFrom）：handyman worker 在创建窗口内 join 发起方 agent 的 standing
 * preset 组合，从而获得 preset 层工具（read/write/edit 等）。
 *
 * **工具面收窄（用户拍板）**：worker 内部**不含 handyman 工具本身**——递归编排归主
 * agent，worker 内部只走 subagent（模型继承 worker，同样低能）。实现：setup 钩子
 * composeFrom 后对子 scope `tools.restrict({ deny: ['handyman'] })`（同 scope 注册的
 * 规则，最近 scope 胜出——worker 看不到 handyman，主 agent 不受影响）。
 *
 * agentPresets 是可选服务（ctx.get 读取）：
 *   - 无该服务 / 父未 join preset → 返回空（worker 落全局工具层 + deny handyman）；
 *   - 有且父已 join → 返回 preset id（写入 session meta 供重建）+ setup 钩子
 *     （在 agent 未发布前执行 composeFrom + restrict，失败由创建事务回滚）。
 *
 * 仅依赖 cordis 的 Context 类型（type-only，运行时擦除）——保持可被 vitest
 * 直接加载（与 ccc.ts / handyman-ops.ts 同级的纯模块约定）。
 */

import type { Context } from 'cordis'

/** 从父 agent ctx 解析 preset 继承的创建期组合。 */
export interface HandymanPresetInheritance {
  /** 父 agent 的 preset id（写入子 session meta.agentPreset，供持久化重建）；无则不写。 */
  readonly agentPreset?: string
  /** 创建 setup 钩子：子 scope join 父的 standing preset + deny handyman 工具；无 preset 继承时仅 deny。 */
  readonly setup?: (childCtx: Context) => void
}

/**
 * 解析 handyman worker 从父 agent 继承的 preset，并组装创建 setup 钩子。
 * @param parentCtx - 发起 handyman 的 agent 的 scope ctx；无（headless/非 agent 上下文）时为 undefined。
 * @returns 继承结果：meta 用的 agentPreset 与创建 setup 钩子。
 */
export function handymanPresetInheritance(
  parentCtx: Context | undefined,
): HandymanPresetInheritance {
  if (parentCtx === undefined) {
    return { setup: (childCtx: Context) => { childCtx.tools.restrict({ deny: ['handyman'] }) } }
  }
  const presets = parentCtx.get('agentPresets')
  const agentPreset = presets?.composedPreset(parentCtx)
  if (agentPreset === undefined) {
    return { setup: (childCtx: Context) => { childCtx.tools.restrict({ deny: ['handyman'] }) } }
  }
  return {
    agentPreset,
    setup: (childCtx: Context) => {
      childCtx.get('agentPresets')?.composeFrom(childCtx, parentCtx)
      childCtx.tools.restrict({ deny: ['handyman'] })
    },
  }
}
