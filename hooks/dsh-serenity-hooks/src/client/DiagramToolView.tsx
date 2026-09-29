/**
 * client/DiagramToolView.tsx — `diagram` 工具的**客户端工具视图**（v1.51.2）
 *
 * ## 它修的是什么（症状 → 根因）
 *
 * `diagram` 的结果是 `[text 信封, image 图块]`（见 `src/tools/diagram.ts` 的 `output.render`）。
 * 但 Chat 视图此前**看不到图**：宿主的 durable 图片画廊是**子槽** `tool.call.images`，
 * 而全仓**只有一个条目声明了它** —— 宿主内建的 `read_image` 行。未注册的 Tool 名
 * 落到通用行 ⇒ 只把结果 flatten 成文字 ⇒ 图片不出现（Trajectory 视图另走一条通路，故那边能看）。
 *
 * ## 为什么**不能**声明 `tool.call.images`（🔴 硬约束，不是风格选择）
 *
 * 宿主 `dsh-client-ui-tool` 的槽契约原话（`lib/types/client/contract/slots.d.ts`，
 * 副本在 `_tmp/hostpkg/toolcontract-slots.d.ts`）：
 *
 * > "A child slot is declared by exactly one entry: registering a second toolview that
 * >  declares the same child **throws at load**, so a future image-bearing tool must
 * >  **reuse this entry or own a distinct slot**."
 *
 * ⇒ 我们**不声明任何子槽**，改由本行自己用 owner 交来的 `loadImage` 取图并渲染 `<img>`。
 *
 * ## 类型来源：**槽契约走真包，本地不抄**（v1.51.2 定稿；别再退回"自带一份声明"）
 *
 * `SlotMap['tool.call.toolview']` 由宿主包 `@deepseek-ai/dsh-client-ui-tool` 声明
 * （`lib/types/client/contract/slots.d.ts`）。该包**已进本仓 devDependencies**
 * （`@deepseek-ai/dsh-client-ui-tool@0.1.7-rc.1`）＋ `client/tsconfig.json` 的 `paths`
 * ⇒ 本文件**不再自带任何 `declare module`**：注册与 props 全部**对着真宿主类型**编译。
 *
 * 🔴 **为什么必须这样**（本仓 F7 ／ README §9「宿主类型基准 = devDependencies」）：
 *    最初一版的做法是**本地 `declare module` 抄一份**槽形状 —— 那让槽类型在**拿不到真契约**时
 *    也编译通过 = **F7 要防的假绿**，并把"宿主槽契约变了"变成**我们不知道**。
 *    接上真包之后，`dsh-develop typecheck-host <ver>` 会在**宿主升级时自动抓住类型面漂移**
 *    （它把解包的真宿主挂进 paths 重编 client 半）—— 这正是 owner 2026-09-29 要的那条
 *    「DSH 升级必查该依赖」里**可机械化的那一半**。另一半（**语义面**：那个槽的声明者是谁、
 *    我们要用的 key 有没有被占、`loadImage` 的行为是否仍如文档）**类型抓不住** ⇒
 *    按 `docs/dsp-top-level-constraints.md` **§2.5.1** 在升级时人工逐条对。
 *
 * 其余用到的类型：`ToolResultNode` ／ `MessageImageLoader` 取自
 * `@deepseek-ai/dsh-client-ui-conversation/client` —— 那是它们的**真实定义处**（`ui-chat` 只再导出）；
 * 三阶段的 `phase`/`block` 联合则由上面那份**真槽声明**给出，本行**不再自带任何 owner 形状**
 * （此前那一版自带 3 个 interface 镜像宿主契约 —— 接了真包之后它们全是死码，已删；
 *  **镜像宿主形状的本地声明，正是"抄一份"这个毛病的载体，别再写回来**）。
 */
import type {} from '@deepseek-ai/dsh-client-ui-conversation'
import type {
  MessageImageLoader,
  ToolResultNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import { DIAGRAM_TOOL_NAME, diagramResultModel } from './diagram-result.js'
import type { DiagramImageRef } from './diagram-result.js'
import './DiagramToolView.css'

/**
 * 本行认领的 wire Tool 名（= 注册键；拼错则永不派发）。
 * 🔴 **单一真相源在 `diagram-result.ts`**（v1.51.3 起）：轮尾行（`diagram-tail.ts`）读**同一个**常量 ——
 * 两处各写一份字面量，迟早会漂成两条真相。
 */
export { DIAGRAM_TOOL_NAME }

/** 本行 props = 框架合成的完整面（owner ＋ keyed key ＋ session 标准套件）。 */
export type DiagramToolViewProps = PropsRuntime<'tool.call.toolview'>

/** 图片加载的三种落点（`loading` 只在有图块、URL 还没到时出现）。 */
interface DiagramImageState {
  readonly url: string | null
  readonly failed: boolean
}

/**
 * 用会话授权的 loader 把 durable 引用换成浏览器 URL。
 *
 * 顺序：先问同步缓存（`loadImage.peek`，命中则**不发起读取**），未命中才 `await loadImage(ref)`。
 * 组件卸载后不再 setState（`live` 旗），加载失败落到 `failed`（**不抛上 React 树**）。
 * @param loadImage - owner 交来的会话授权加载器。
 * @param image - 已校验的引用；`null` = 本次没图（降级）。
 * @returns 当前 URL 与失败标志。
 */
function useDiagramImage(loadImage: MessageImageLoader, image: DiagramImageRef | null): DiagramImageState {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (image === null) {
      setUrl(null)
      setFailed(false)
      return
    }
    setFailed(false)
    const cached = loadImage.peek?.(image)
    if (cached !== undefined) {
      setUrl(cached)
      return
    }
    let live = true
    void loadImage(image).then(
      (resolved) => {
        if (live) setUrl(resolved)
      },
      () => {
        if (live) {
          setUrl(null)
          setFailed(true)
        }
      },
    )
    return () => {
      live = false
    }
  }, [image, loadImage])

  return { url, failed }
}

/**
 * 未结算阶段的行：只有工具名与一句状态，**不猜参数**（`preparing` 阶段没有已派发的实参）。
 * @param phase - `preparing` 或 `start`。
 */
function DiagramRunningRow({ phase }: { readonly phase: 'preparing' | 'start' }): ReactNode {
  return (
    <div className="sp-dgRow" data-state="running">
      <div className="sp-dgTitle">{DIAGRAM_TOOL_NAME}</div>
      <div className="sp-dgHint">{phase === 'preparing' ? '准备中…' : '绘制中…'}</div>
    </div>
  )
}

/**
 * 已结算阶段的行：图（有则贴）＋ 信封文字（**只来自结果自己的 text 块**）。
 *
 * 🔴 绝不把 `block.content` 整体 flatten：图块被 `JSON.stringify` 后会在图片下面
 * 印出原始 attachment 对象 —— 这正是本行要消除的症状（宿主 `imageCardModel` 文档同款理由）。
 * @param props - 已结算结果与加载器。
 */
function DiagramResultRow({
  block,
  loadImage,
}: {
  readonly block: ToolResultNode
  readonly loadImage: MessageImageLoader
}): ReactNode {
  const model = useMemo(() => diagramResultModel(block), [block])
  const { url, failed } = useDiagramImage(loadImage, model.image)

  return (
    <div className="sp-dgRow" data-state={model.isError ? 'error' : 'ok'}>
      {model.title === '' ? null : <div className="sp-dgTitle">{model.title}</div>}
      {model.image === null ? null : failed ? (
        <div className="sp-dgError">图片加载失败（attachment 读取被拒或已过期）</div>
      ) : url === null ? (
        <div className="sp-dgHint">图片加载中…</div>
      ) : (
        <img
          className="sp-dgImage"
          src={url}
          alt={model.image.name ?? DIAGRAM_TOOL_NAME}
          width={model.image.width}
          height={model.image.height}
        />
      )}
      {model.text === '' ? null : <div className="sp-dgText">{model.text}</div>}
    </div>
  )
}

/**
 * `diagram` 的原子工具视图（注册进 keyed 槽 `tool.call.toolview`，key = `diagram`）。
 *
 * 三阶段分流：`result` → {@link DiagramResultRow}（带图）；其余 → {@link DiagramRunningRow}。
 * 本组件自身不调 Hook ⇒ 条件返回安全。
 * @param props - 框架合成的槽 props。
 */
export function DiagramToolView(props: DiagramToolViewProps): ReactNode {
  if (props.phase !== 'result') return <DiagramRunningRow phase={props.phase} />
  return <DiagramResultRow block={props.block} loadImage={props.loadImage} />
}
