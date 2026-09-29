/**
 * client/diagram-tail.ts — 从**一个 Turn 的 Chat 快照**里挑出 `diagram` 的图（v1.51.3）
 *
 * ## 为什么需要它（症状 → 根因）
 *
 * v1.51.2 让图在**工具卡**里内联显示，但工具卡是**可折叠**的宿主外壳 —— 折起来就只剩标题，
 * 图随之消失。owner 的诉求：**图要出现在「回答」区域、且仍然不落盘**。
 *
 * 宿主给的正路不是改 markdown 渲染器（那是宿主包、DOM 被 fixtures 逐字钉死，且我们有"零改 DSH"约束），
 * 而是 `conversation.chat.turnTail`：**宿主声明的 list 槽**，用来在"一轮回答的尾部"追加功能行
 * （官方 `ui-deliverables` 就是这么挂交付物的）。它给的 owner 货币是 `{ turn, seq, openFile }`
 * —— **不含本轮的工具结果**，所以本模块负责把"这一轮里有哪些 diagram 图"**挑出来**。
 *
 * ## 为什么是纯函数（无 React）
 *
 * 本仓 client 单测跑在 node（`vitest.config.ts` 的 `environment: 'node'`，**无 DOM**）
 * ⇒ 能测、也该测的是"**从这些工具调用里挑什么**"这条规则；渲染只能靠真浏览器看。
 * 分工与 `diagram-result.ts` 同款：纯派生归纯模块，组件只做装配。
 *
 * ## 类型来源：**接真契约**，不抄形状（§2.5.1 三件齐）
 *
 * `ToolCallBlock` / `ToolResultNode` 取自宿主包 `@deepseek-ai/dsh-client-ui-conversation/client`
 * 的**真定义处**；本文件不自带 `declare module`。
 *
 * 🔴 **"已结算"判定用本模块自己的一行守卫，而不是宿主导出的 `isSettledTool`** —— 两个理由：
 *  1. **收窄**：`ToolCallBlock = PreparingToolCall | StartedToolCall | ToolResultNode`，而前两者
 *     **没有 `kind` 字段**（只有 `phase`，实测 0.1.7-rc.1 的 records 契约）⇒ 直接写 `block.kind`
 *     收窄不了联合类型（tsc 报 TS2339）；先 `'kind' in block` 收窄到**唯一带 `kind` 的成员**
 *     （= `ToolResultNode`），再比字面量值即可，**不需要任何 cast**。
 *  2. **可单测**：宿主的 `isSettledTool` 是**运行期值**，而宿主 client 包在 **import 期**就要 `window`
 *     ⇒ 纯模块一旦 import 它，node 环境下的单测直接起不来（实测 `ReferenceError: window is not defined`）。
 *     本模块只允许**类型**导入宿主包（类型在运行期被擦除）。
 *     判据面：若宿主哪天把判别字段改掉，`block.kind === 'tool-result'` 会变成"无交集比较"⇒ **编译期就红**。
 */
import type { ToolCallBlock, ToolResultNode } from '@deepseek-ai/dsh-client-ui-conversation/client'

import { DIAGRAM_TOOL_NAME, diagramResultModel } from './diagram-result.js'
import type { DiagramImageRef } from './diagram-result.js'

/** 本轮里一个**已结算且带可显示图**的 `diagram` 结果。 */
export interface DiagramTailImage {
  /** 那次工具调用的 id（React key 与去重都用它）。 */
  readonly callId: string
  /** 结果事件的序号（只在同一轮内排序用）。 */
  readonly seq: number
  /** 图块本身 —— **结果里那个对象**，不重建（品牌 id 与 loader 调用保持真身）。 */
  readonly image: DiagramImageRef
}

/**
 * 递归上限：宿主自己的 `MAX_TOOL_CALL_TREE_DEPTH` 是 256，这里只需要"别被畸形/超深树拖住"，
 * 取一个小得多的值 —— 超过就**停止下探**（已经拿到的照常返回，不抛）。
 */
const MAX_DEPTH = 32

/** 单轮里最多看多少个 tool-call 根（防一次超长轮把渲染拖住）。 */
const MAX_ROOTS = 512

/**
 * 该块是不是**已结算**的工具结果。
 *
 * `'kind' in block` 先把联合类型收窄到**唯一带 `kind` 的成员**（运行中的两个只有 `phase`），
 * 再比字面量值 —— 全程无 cast（理由见文件头）。
 * @param block - 候选块。
 * @returns 是否为已结算结果（`true` 时类型收窄为 {@link ToolResultNode}）。
 */
function isSettled(block: ToolCallBlock): block is ToolResultNode {
  return 'kind' in block && block.kind === 'tool-result'
}

/**
 * 深度优先收集一个工具调用子树里的 diagram 图（**发现顺序** = 该轮的调用顺序）。
 * @param block - 工具调用块（只有**已结算且工具名匹配**的才可能带图；运行中有子调用也照常下探）。
 * @param out - 收集器。
 * @param depth - 当前深度（超过 {@link MAX_DEPTH} 即停）。
 */
function collect(block: ToolCallBlock, out: DiagramTailImage[], depth: number): void {
  // 快照/日志可被截断或改写 ⇒ 逐层做**结构性**兜底（声明不是运行期保证）
  if (depth > MAX_DEPTH || block === null || typeof block !== 'object') return
  if (isSettled(block) && block.call?.name === DIAGRAM_TOOL_NAME) {
    // 复用工具卡那条**同一条**派生规则（同一个模型 ⇒ 工具卡与轮尾两处显示不会打架）
    const image = diagramResultModel(block).image
    if (image !== null) out.push({ callId: block.callId, seq: block.seq, image })
  }
  const children: readonly ToolCallBlock[] = Array.isArray(block.subCalls) ? block.subCalls : []
  for (const child of children) collect(child, out, depth + 1)
}

/**
 * 挑出**某一轮**里 `diagram` 产出的图。
 *
 * 输入 = 该 Turn 的 tool-call **根**列表（调用方用宿主的
 * `chat.nodes.turnDataSource(turn, 'tool-call')` 取，**含被隐藏的节点** ⇒ 折叠与否都不影响结果）。
 * @param roots - 本轮的工具调用根（顺序 = 锚点顺序）。
 * @returns 按发现顺序排列的图（无图 ⇒ 空数组；任何畸形输入都不抛）。
 */
export function diagramImagesOfRoots(roots: readonly ToolCallBlock[]): readonly DiagramTailImage[] {
  if (!Array.isArray(roots)) return []
  const out: DiagramTailImage[] = []
  let seen = 0
  for (const root of roots) {
    if (seen >= MAX_ROOTS) break
    seen += 1
    collect(root, out, 0)
  }
  return out
}
