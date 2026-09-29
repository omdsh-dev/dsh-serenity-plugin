/**
 * client/diagram-result.ts — `diagram` 工具结果的**纯派生**（v1.51.2）
 *
 * ## 为什么单独一个模块（R↓）
 *
 * 「把结果里的图块与信封文字挑出来」是**纯逻辑**，与 React、与宿主运行时都无关。
 * 放在这里 ⇒ 可在 node 环境直接单测（本仓 client 侧单测全是 node 环境、无 DOM，
 * 见 `vitest.config.ts` 的 `environment: 'node'`）——与宿主自身的分法同构
 * （`dsh-client-ui-tool` 把 `image-card-model.ts`（纯）与 `read-image-row.tsx`（组件）分开）。
 *
 * ## 两条硬规则（宿主契约的原话）
 *
 * ① **信封文字只从结果自己的 `text` 块取，绝不 flatten 整个 content**。
 *    图块若被 `JSON.stringify`，屏幕上会在图片下面印出**原始 attachment 对象**
 *    —— 正是宿主 `imageCardModel` 文档点名的那个症状（"the symptom this card exists to remove"）。
 *
 * ② **图块可能不存在**：`diagram` 降级时（附件服务没挂 / 当前模型路由不收图 / 落盘失败）
 *    结果只有 text 块，原因写在文字里 ⇒ 本模型返回 `image: null`，调用方只渲染文字。
 *
 * ## 类型来源（关键——别退回"抄一份形状"）
 *
 * `ToolResultNode` 取自 `@deepseek-ai/dsh-client-ui-conversation/client`：那是它的**真实定义处**
 * （`dsh-client-ui-chat` 只是再导出），且该包**在本仓 node_modules 可解析**。
 * `@deepseek-ai/dsh-attachment` 本仓**不能直接 import**（实测 TS2307），但其类型
 * **在 program 内是解析出来的**（否则 `loadImage(ref)` 不会报 `AttachmentId` 的品牌错）。
 * ⇒ 本模块**不抄字段**，而是沿可达类型链把真类型取出来：
 *
 * ```
 * ToolResultNode['content'][number]        // ContentBlock 联合
 *   → Extract<…, { type: 'image' }>        // ImageBlock
 *     → ['attachment']                     // ImageAttachmentRef（含品牌 id）
 * ```
 *
 * 于是校验通过后**原样返回**结果里那个引用 —— 全程**零 cast**，直接可交给宿主的 loader。
 * （`src/client/host-type-contract.ts` 里钉了"这条链真的解析成了品牌类型、没退化成 any"。）
 */
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-conversation/client'

/** 结果里的内容块 —— 取自宿主自己的联合类型，不另抄一份。 */
type DiagramContentBlock = ToolResultNode['content'][number]

/** 图块（`type: 'image'`）。 */
type DiagramImageBlock = Extract<DiagramContentBlock, { type: 'image' }>

/** 宿主 durable 图片引用（= `ImageAttachmentRef`；含品牌 `attachmentId`，不透明，不解析成路径）。 */
export type DiagramImageRef = DiagramImageBlock['attachment']

/**
 * 附件路径接受的栅格格式 —— **宿主 `ImageMediaType` 的逐字副本**
 * （`dsh-attachment/types.d.ts`）。校验用；同时挡住 SVG 之类非栅格
 * （本工具只产出 PNG，见 `src/tools/diagram.ts`）。
 */
export const DIAGRAM_IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

/** 一次已结算 `diagram` 调用贡献的全部展示材料。 */
export interface DiagramResultView {
  /** 首行信封文字（行摘要；无文字块时为空串）。 */
  readonly title: string
  /** 完整信封文字（**只来自 text 块**；行与行以 `\n` 相连）。 */
  readonly text: string
  /** durable 图片引用（宿主原对象）；`null` = 本次降级没贴成图（原因在 `text` 里）。 */
  readonly image: DiagramImageRef | null
  /** 已结算调用是否失败（供行样式用；不改变上面的取数规则）。 */
  readonly isError: boolean
}

/** 非空对象视图（`null` = 不是对象）。 */
function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

/** 非空字符串（去空白后仍非空），否则 `null`。 */
function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** 正有限数（尺寸/字节数必须为正），否则 `null`。 */
function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/**
 * 该 attachment 是否能安全当作栅格图渲染。
 *
 * 宿主已声明其类型，但**声明不是运行期保证**（快照/日志可被截断或改写）⇒ 仍逐字段校验；
 * 校验只看结构化视图，**通过则原样返回宿主那个对象**（不重建、不 cast，保住品牌 id）。
 * @param attachment - 候选引用。
 * @returns 同一个引用，或 `null`（形状不合法 ⇒ 当作"这次没图"）。
 */
export function renderableImage(attachment: DiagramImageRef): DiagramImageRef | null {
  const rec = recordOf(attachment)
  if (rec === null) return null
  if (nonEmptyString(rec.attachmentId) === null) return null
  if (!DIAGRAM_IMAGE_MEDIA_TYPES.some((known) => known === rec.mediaType)) return null
  if (positiveNumber(rec.bytes) === null) return null
  if (positiveNumber(rec.width) === null || positiveNumber(rec.height) === null) return null
  return attachment
}

/**
 * 从一份已结算的工具结果派生展示材料。
 *
 * 取数规则（顺序固定）：
 *  - `text`：收集**全部** `type === 'text'` 块的文字，按出现顺序以 `\n` 相连；
 *  - `image`：取**第一个**通过 {@link renderableImage} 的 `type === 'image'` 块
 *    （宿主按结果顺序只放一张）；
 *  - 其余块（`reasoning` / `file` / 未知扩展块）**忽略**，不做任何 flatten。
 *
 * @param block - 已结算的工具结果节点（`phase === 'result'` 的 `block`）。
 * @returns 展示材料；**任何输入都返回一个视图**（最坏情况是空文字 + 无图），不抛。
 */
export function diagramResultModel(block: ToolResultNode): DiagramResultView {
  const raw: unknown = block.content
  const content: readonly DiagramContentBlock[] = Array.isArray(raw) ? (raw as readonly DiagramContentBlock[]) : []
  const texts: string[] = []
  let image: DiagramImageRef | null = null

  for (const entry of content) {
    // 🔴 运行期兜底：类型层说"这里一定是块对象"，但快照可被截断/改写（同一前提也适用于下面的
    // attachment 校验）。少了这一句，一个 `null` 块就能把整行抛崩
    // —— 2026-09-29 实测被 tests/diagram-toolview.test.ts 的「非对象/null 块不抛」抓出来。
    // 注意：这里只**丢弃** recordOf 的结果、不用它取字段（用它会丢掉联合类型收窄 ⇒ 需 cast）。
    if (recordOf(entry) === null) continue
    if (entry.type === 'text') {
      texts.push(entry.text)
      continue
    }
    if (entry.type === 'image' && image === null) image = renderableImage(entry.attachment)
  }

  let text = texts.join('\n')

  // 失败且**一个文字块都没有**时的兜底（execute 抛异常 ⇒ content 为空）。
  // 这不是自造文案：宿主 `resultText` 的文档原话就是
  // "Empty content on a failed call falls back to the structured error's `name: code` line"。
  // 不给这一手的话，本行会渲染出一张**空卡片** —— 比它替换掉的通用行更差。
  if (text === '' && block.isError === true) {
    const error = recordOf(block.error)
    if (error !== null) {
      const name = nonEmptyString(error.name)
      const code = nonEmptyString(error.code)
      if (name !== null && code !== null) text = `${name}: ${code}`
    }
  }

  const newline = text.indexOf('\n')
  return {
    title: newline === -1 ? text : text.slice(0, newline),
    text,
    image,
    isError: block.isError === true,
  }
}
