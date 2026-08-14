/**
 * loop-preset-inherit.ts — loop agent 的 preset 继承决策（纯函数，可单测）
 *
 * 对齐 subagent 先例（applyChildComposition → agentPresets.composeFrom）：
 * loop agent 在创建窗口内 join 发起方 agent 的 standing preset 组合，从而获得
 * preset 层工具（read/write/edit 等）。agentPresets 是可选服务（ctx.get 读取）：
 *   - 无该服务 / 父未 join preset → 返回空（loop agent 落全局工具层，历史行为）；
 *   - 有且父已 join → 返回 preset id（写入 session meta 供重建）+ setup 钩子
 *     （在 agent 未发布前执行 composeFrom，失败由创建事务回滚）。
 *
 * 仅依赖 cordis 的 Context 类型（type-only，运行时擦除）——保持可被 vitest
 * 直接加载（与 ccc.ts / loop-ops.ts 同级的纯模块约定）。
 */

import type { Context } from 'cordis'

/** 从父 agent ctx 解析 preset 继承的创建期组合。 */
export interface LoopPresetInheritance {
  /** 父 agent 的 preset id（写入子 session meta.agentPreset，供持久化重建）；无则不写。 */
  readonly agentPreset?: string
  /** 创建 setup 钩子：子 scope join 父的 standing preset；无 preset 继承时缺省。 */
  readonly setup?: (childCtx: Context) => void
}

/**
 * 解析 loop agent 从父 agent 继承的 preset，并组装创建 setup 钩子。
 * @param parentCtx - 发起 loop 的 agent 的 scope ctx；无（headless/非 agent 上下文）时为 undefined。
 * @returns 继承结果：meta 用的 agentPreset 与创建 setup 钩子。
 */
export function loopPresetInheritance(
  parentCtx: Context | undefined,
): LoopPresetInheritance {
  if (parentCtx === undefined) return {}
  const presets = parentCtx.get('agentPresets')
  const agentPreset = presets?.composedPreset(parentCtx)
  if (agentPreset === undefined) return {}
  return {
    agentPreset,
    setup: (childCtx: Context) => {
      childCtx.get('agentPresets')?.composeFrom(childCtx, parentCtx)
    },
  }
}
