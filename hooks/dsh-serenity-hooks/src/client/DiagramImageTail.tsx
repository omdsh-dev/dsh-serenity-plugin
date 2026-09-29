/**
 * client/DiagramImageTail.tsx — **本轮回答尾部**的 `diagram` 图（v1.51.3）
 *
 * ## 它修的是什么
 *
 * v1.51.2 让图出现在**工具卡**里 —— 但工具卡是**可折叠**的宿主外壳，折起来图就没了。
 * owner 的诉求：**图要出现在「回答」区域，且仍然不落盘**。
 *
 * ## 为什么是"槽"而不是"markdown 里的地址"（两条路都量过，2026-09-30）
 *
 *  - **markdown 内联图**：宿主契约逐字写着 *"Images additionally require absolute HTTP(S)"*，
 *    且渲染器的 DOM 被 fixtures **逐字钉死**（`md-render.d.ts` 首行）—— 那是宿主包，我们**零改 DSH**；
 *    那条"把自定义目的地解成可显示 URL"的缝（`pathImages`）在宿主组件里用 `useMemo` 写死成
 *    本地文件路径解析、**不查任何服务** ⇒ 插件塞不进去。⇒ **"包装地址"这条路不成**。
 *  - **`conversation.chat.turnTail`**：宿主声明的 **list 槽**，专用于"在一轮完成后的尾部追加功能行"
 *    （官方 `ui-deliverables` 就是这么挂交付物的）⇒ 图的渲染**归我们**，于是既不需要地址、
 *    也不需要新的 HTTP 路由。
 *
 * ## 数据与 URL 从哪来（**都不新增存储**）
 *
 * - **图**：宿主自己的 Chat 快照 —— `ctx.uiConversation.binding(sessionId).target('chat')`，
 *   再用 `chat.nodes.turnDataSource(turn, 'tool-call')` 取**本轮**的工具调用根
 *   （契约原话：*"Observe one Turn's data for a single Node kind, **including hidden Nodes**, in anchor order"*
 *   ⇒ 工具卡折叠与否都不影响取数）→ 交给纯模块 `diagram-tail.ts` 挑图。
 * - **URL**：宿主自己的 per-session 授权 URL 缓存 `ctx.uiConversation.imageUrl(sessionId, ref)`
 *   （先问 `peekImageUrl`，命中则**不发起读取**）。字节仍在**宿主的 durable 附件库**里
 *   （`src/tools/diagram.ts` 的 `attachments.saveImage` 产出的那个引用）
 *   ⇒ **不落工作区文件、不常驻内存**。🔴 因此**不做**任何"自己存一份图"的设计
 *   （owner 2026-09-30 明确否掉过 loop/内存常驻：那会长期占内存）。
 *
 * ## 两个"被契约纠正"的实现细节（实测 0.1.7-rc.1）
 *
 * 1. 🔴 **本槽需要 `inject` 面**（与线上 0.2.0-rc.1 的 `TurnTailOwnerProps` 契约不同）——
 *    tsc 直接报 *"Property 'inject' is missing … but required"*。故按**官方同款**走 `inject`，
 *    组件用 `InjectFace<DiagramTailInjected>` 声明自己的面（`ui-deliverables` 亦如此）。
 * 2. 🔴 **`sessionId` 是品牌类型 `SessionId`，不是 `string`**（`string` 赋不进去）。
 *    这里不引入 `@deepseek-ai/dsh-session/types` 新依赖，直接从本行 props 上取类型。
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ChatSnapshot, ToolChatData } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

import type { DiagramImageRef } from './diagram-result.js'
import { DIAGRAM_TOOL_NAME } from './diagram-result.js'
import type { DiagramTailImage } from './diagram-tail.js'
import { diagramImagesOfRoots } from './diagram-tail.js'
import './DiagramImageTail.css'

/** 本行的会话 id 类型（**取自 props**：品牌类型 `SessionId`，不从别处抄一份）。 */
type DiagramTailSessionId = DiagramImageTailProps['sessionId']

/**
 * 该会话的 Chat 目标快照源（拿不到时为 `null`）。
 * 🔴 由 `chatTargetOf` 的**推断**返回类型派生 —— 别给那个函数写返回注解，
 * 否则本别名与它会互相引用（TS2456 circular）。
 */
type DiagramTailChatTarget = NonNullable<ReturnType<typeof chatTargetOf>>

/** 注入面：本行要用的三件事（都取自宿主自己的服务，不自己造）。 */
export interface DiagramTailInjected {
  /** 取该会话的 Chat 目标快照源；会话未知/绑定已换代 ⇒ `null`（按"本轮不显示"处理）。 */
  readonly chatTarget: (sessionId: DiagramTailSessionId) => DiagramTailChatTarget | null
  /** 同步取已缓存的图片 URL（命中则**不发起读取**）；没有 ⇒ `null`。 */
  readonly peekImageUrl: (sessionId: DiagramTailSessionId, ref: DiagramImageRef) => string | null
  /** 发起一次会话授权的图片读取（失败 ⇒ `null`，**不抛**）。 */
  readonly loadImageUrl: (sessionId: DiagramTailSessionId, ref: DiagramImageRef) => Promise<string | null>
}

/** 本行 props = 框架合成的完整面（owner 货币 ＋ session 标准套件 ＋ 本行注入面）。 */
export type DiagramImageTailProps = PropsRuntime<'conversation.chat.turnTail'> & InjectFace<DiagramTailInjected>

/** 没有可用目标快照时的稳定空订阅（`useSyncExternalStore` 要求引用稳定）。 */
const NO_SUBSCRIBE = (): (() => void) => () => {}
/** 没有可用目标快照时的稳定空读数。 */
const NO_SNAPSHOT = (): ChatSnapshot | undefined => undefined

/**
 * 取该会话的 Chat 目标快照源。
 *
 * 宿主契约写明 `binding()` 在**会话未知或绑定已换代**时**抛错** ⇒ 这里按"本轮不显示"处理
 * （不是错误态：换会话/竞态都会走到这里）。
 * @param scope - 客户端 ctx（含 `uiConversation`）。
 * @param sessionId - 槽的 session 作用域。
 * @returns 目标快照源，或 `null`（拿不到 ⇒ 不渲染）。
 */
function chatTargetOf(scope: ClientContext, sessionId: DiagramTailSessionId) {
  try {
    return scope.uiConversation.binding(sessionId).target('chat')
  } catch {
    return null
  }
}

/**
 * 造一行的注入面（在 `index.ts` 注册时由 `scope` 闭包）。
 * @param scope - 客户端 ctx。
 * @returns 该槽的注入面。
 */
export function diagramTailInjected(scope: ClientContext): DiagramTailInjected {
  return {
    chatTarget: (sessionId) => chatTargetOf(scope, sessionId),
    peekImageUrl: (sessionId, ref) => {
      try {
        return scope.uiConversation.peekImageUrl(sessionId, ref) ?? null
      } catch {
        return null
      }
    },
    loadImageUrl: (sessionId, ref) => {
      try {
        return scope.uiConversation.imageUrl(sessionId, ref).catch(() => null)
      } catch {
        return Promise.resolve(null)
      }
    },
  }
}

/**
 * 把每张图的 durable 引用解成**浏览器可直接用的 URL**（先查缓存，未命中才发起读取）。
 * @param injected - 本行的注入面。
 * @param sessionId - 授权作用域。
 * @param images - 本轮挑出的图（顺序即渲染顺序）。
 * @returns 与 `images` 等长的 URL 数组；未就绪或读取失败的位置为 `null`。
 */
function useTailUrls(
  injected: DiagramTailInjected,
  sessionId: DiagramTailSessionId,
  images: readonly DiagramTailImage[],
): readonly (string | null)[] {
  const [urls, setUrls] = useState<readonly (string | null)[]>([])

  useEffect(() => {
    let live = true
    const initial = images.map((entry) => injected.peekImageUrl(sessionId, entry.image))
    setUrls(initial)
    images.forEach((entry, index) => {
      if (initial[index] !== null) return
      void injected.loadImageUrl(sessionId, entry.image).then((url) => {
        if (!live || url === null) return
        setUrls((prev) => prev.map((value, at) => (at === index ? url : value)))
      })
    })
    return () => {
      live = false
    }
  }, [injected, sessionId, images])

  return urls
}

/**
 * `diagram` 的**轮尾图行**：注册进 `conversation.chat.turnTail`（`kind: 'list'`，入口 id `serenity-diagram-tail`）。
 *
 * 本轮没有图 ⇒ 返回 `null`（"entries without content return null"，不占位）。
 * @param props - 框架合成的槽 props。
 */
export function DiagramImageTail(props: DiagramImageTailProps): ReactNode {
  const { sessionId, chatTarget, peekImageUrl, loadImageUrl } = props
  const injected = useMemo<DiagramTailInjected>(
    () => ({ chatTarget, peekImageUrl, loadImageUrl }),
    [chatTarget, peekImageUrl, loadImageUrl],
  )
  const turn = props.turn?.turn
  const source = useMemo(() => injected.chatTarget(sessionId), [injected, sessionId])
  const chat = useSyncExternalStore(
    useMemo(() => (source === null ? NO_SUBSCRIBE : (notify: () => void) => source.subscribe(notify)), [source]),
    useMemo(() => (source === null ? NO_SNAPSHOT : () => source.getSnapshot()), [source]),
  )
  const images = useMemo(() => {
    if (chat === undefined || turn === undefined) return []
    // 本轮的 tool-call 根（契约：`turnDataSource` 含**被隐藏**的节点 ⇒ 工具卡折叠与否都不影响）
    const roots = chat.nodes
      .turnDataSource(turn, 'tool-call')
      .getSnapshot()
      .map((data: ToolChatData) => data.root)
    return diagramImagesOfRoots(roots)
  }, [chat, turn])
  const urls = useTailUrls(injected, sessionId, images)

  if (images.length === 0) return null
  return (
    <div className="sp-dtRoot" data-count={images.length}>
      {images.map((entry, index) => {
        const url = urls[index] ?? null
        return url === null ? (
          <div className="sp-dtPending" key={entry.callId} />
        ) : (
          <img
            className="sp-dtImage"
            key={entry.callId}
            src={url}
            alt={entry.image.name ?? DIAGRAM_TOOL_NAME}
            width={entry.image.width}
            height={entry.image.height}
          />
        )
      })}
    </div>
  )
}
