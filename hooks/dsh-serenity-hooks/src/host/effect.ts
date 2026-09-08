/**
 * host/effect.ts — 插件资源拆卸登记（S142 review F-08）
 *
 * 宿主把"注册即效果"作为统一模型：每个贡献都走 `ctx.effect()` / `ctx.on()`，
 * 注册返回 disposer，fiber 销毁时自动回收（`cordis` Context.effect，rc.1 全量使用，
 * 如 `core/tools/src/index.ts:943`）。
 *
 * 本模块是 dsp 各装配点登记自起资源（端口监听器/定时器/轮询器）的**唯一入口**，
 * 理由：
 *  - `ctx.effect` 是宿主成员，但**不可假定存在**（测试替身、极旧宿主、HMR 早期阶段）。
 *    直接裸调会让 `apply` 抛错 = 整个 dsh 启动失败（app-boot "plugin(s) failed to load"），
 *    这比"资源没拆卸"严重得多——所以缺失时**响亮降级**（记录 + 返回 false）。
 *  - 零依赖叶模块：gateway / autopilot 等模块只引它，不会因此被拖进 skiff/rebuild 的依赖链。
 */

/** 与宿主 `ctx.effect` 同形的最小结构（避免为一次调用引入 cordis 类型依赖） */
interface EffectCapable {
  effect?: (callback: () => () => void, label?: string) => unknown
}

/** 已告警的标签（进程级去重：重复装配/多测试替身不刷屏，但绝不静默） */
const warnedLabels = new Set<string>()

/** 测试辅助：重置"未装配"告警去重（生产零调用） */
export function __resetDisposerWarningsForTest(): void {
  warnedLabels.clear()
}

/**
 * 登记一个卸载时执行的清理。
 * @param ctx 宿主插件上下文
 * @param label 日志标签（定位是哪个资源未装配）
 * @param cleanup 卸载时执行；抛错被吞掉（不阻断其它清理）
 * @returns 是否成功装配（false = 宿主无 `ctx.effect`，已告警）
 */
export function registerDisposer(ctx: unknown, label: string, cleanup: () => void): boolean {
  const effect = (ctx as EffectCapable | undefined)?.effect
  if (typeof effect !== 'function') {
    if (!warnedLabels.has(label)) {
      warnedLabels.add(label)
      console.warn(`[serenity-hooks] ✗ 资源拆卸未装配（${label}）：ctx.effect 不可用（宿主契约缺失）`)
    }
    return false
  }
  try {
    effect.call(ctx, () => () => {
      try {
        cleanup()
      } catch (err) {
        console.warn(`[serenity-hooks] ✗ 资源清理失败（${label}）: ${String((err as Error)?.message ?? err)}`)
      }
    }, `dsh-serenity-hooks: ${label}`)
    return true
  } catch (err) {
    console.warn(`[serenity-hooks] ✗ 资源拆卸注册失败（${label}）: ${String((err as Error)?.message ?? err)}`)
    return false
  }
}
