/**
 * trajectory/model-string.ts — `provider/model` 串解析（**共用件**，不属于任何工具）
 *
 * ## 为什么单独成模块（2026-10-28，cheap-worker 下线时抽出）
 *
 * 它原本住在 `trajectory/delegate/core.ts`（cheap-worker 的纯逻辑层）。但 grep 调用点后发现
 * **它有两个与 cheap-worker 无关的消费者**：
 *   - `trajectory/session.ts`（`agentOptions` 装配，IM 入站 / send-now 冷启都用）
 *   - `trajectory/model-runtime.ts`（`trajectory.json` 的 `model` 运行时热切换）
 *
 * ⇒ 若跟着 `delegate/` 一起删掉，**轨迹的模型热切换与载体装配会一起断**。
 * ⇒ 判据（可外推）：**删一个模块前，先核它的导出有没有"跨域消费者"** ——
 *    目录归属（谁住在谁的目录里）不等于依赖归属（谁在用）。同族先例：`listWakes` 有完整诊断出口
 *    却被误判成零调用点（续 337 ②b）。
 */

/**
 * 解析 model 字符串（`provider/model`）→ `{ provider, model }`。
 *
 * 无 `/` ⇒ 视为 **model-only**（`provider === undefined`），由调用方决定是否接受这种形态。
 * ⚠️ 只按**第一个** `/` 切分：provider id 不含 `/`，但 model id 可能含（如 `p/ns/model-x`）
 * ⇒ 取 `indexOf` 而非 `split('/')` 才是对的。
 */
export function splitModel(model: string): { provider: string | undefined; model: string } {
  const idx = model.indexOf('/')
  if (idx < 0) return { provider: undefined, model }
  return { provider: model.slice(0, idx), model: model.slice(idx + 1) }
}
