/**
 * client/host-type-contract.ts — client 半·宿主**类型**契约（编译期反证层，v1.31.8，S142 全量 review 产物）
 *
 * ## 为什么存在（R↓）
 *
 * 这是 `src/host/type-contract.ts` 的 client 半对照物：浏览器侧同样用结构化断言
 * （`as unknown as` + 手写 `*Like` 影子接口）读取宿主 ui 包，宿主改名同样**编译期失明**。
 *
 * v1.31.8 全量 review 实证（域 A 审计）抓到的两条真实静默失效就发生在这里：
 *  - **DRIFT-1**：`input.imageIds` → 宿主 `InputState.attachmentIds`——整条"图片自动落盘兜底"
 *    链路从不触发（`?? []` 恒空 → 早退），不报错、用户无感，功能整体死亡
 *  - **DRIFT-2**：`inputActions.removeImage` → 宿主 `InputActions.removeAttachment`——被前条掩盖，
 *    修好前者立即暴露，两条必须同批修
 *
 * 这两条**本可被编译器抓住**：`PropsRuntime<'conversation.input.dock'>` 上本来就挂着真实的
 * `InputZone { session, input }` 与 `SessionStandardProps.inputActions`（ui-slots 声明合并）。
 * 是 `as unknown as` 把可查证的契约降级成了不可查证的假设。
 *
 * ## 机制
 *
 * 与 node 半同款：`import type` 拉入真实类型 + `Expect<Extends<宿主真相, dsp 依赖形状>>` 编译期断言。
 * client 半 tsconfig（`client/tsconfig.json`）包含 `../src/client`，`dsh-develop typecheck` 会检查本文件。
 * **宿主把 dsp 依赖的字段改名/改形状 → typecheck 当场红。**
 *
 * ## 局限（诚实边界）
 *
 * - `RemoteFailure` 是 **owner 自由合并的 code 判别联合**（`RemoteErrorDetailsMap`）：
 *   任一 owner 给某 code 塞非对象 `details` 都会让"全形状断言"误报，故只锁顶层
 *   （`promptError` 有 `error`、`RemoteFailure` 有 `code`）；`details.reason` 依赖
 *   `isImageFallbackTrigger` 的 `?.` 读路径软处理（缺字段 = 不触发 = 安全降级）。
 * - 本文件只覆盖 dsp **真正读写的字段**；宿主新增字段不会误报。
 */
import type { DraftAttachmentId, InputActions, InputState, InputZone } from '@deepseek-ai/dsh-client-ui-conversation'
import type { MessageImageLoader } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { DiagramImageRef } from './diagram-result.js'

type Expect<T extends true> = T
type Extends<A, B> = [A] extends [B] ? true : false
type Ret<F> = F extends (...args: never[]) => infer R ? R : never
/** 布尔取反（用于"**必须不**满足"的断言）。 */
type Not<T extends boolean> = T extends true ? false : true
/** `any` 判定：`0 extends 1 & T` 仅当 `T` 是 `any`。 */
type IsAny<T> = 0 extends 1 & T ? true : false
/** `never` 判定：`[T] extends [never]` 仅当 `T` 是 `never`。 */
type IsNever<T> = [T] extends [never] ? true : false

// ─────────────────────────────────────────────────────────────
// ① ImageFallbackDock 读取面（DRIFT-1 / DRIFT-2 的守护闸门）
// ─────────────────────────────────────────────────────────────

/**
 * `input.attachmentIds` —— 图片落盘兜底的输入。
 * 宿主把 `attachmentIds` 改名 → 本行报"Property 'attachmentIds' does not exist" →
 * 在升级当天报警，而不是像 v1.31.8 之前那样让整条链静默死亡。
 */
type _InputAttachmentIds = Expect<Extends<InputState['attachmentIds'], readonly unknown[]>>

/** `DraftAttachmentId` 可赋给 string（`getDraftFiles(ids: readonly string[])` 直接收） */
type _DraftAttachmentIsString = Expect<Extends<DraftAttachmentId, string>>

/** `inputActions.removeAttachment(id)` —— 清 rail 图片的官方方法名。改名 → 此处红。 */
type _InputRemoveAttachment = Expect<Extends<Ret<InputActions['removeAttachment']>, void>>

/** `inputActions.setDraft(text)` / `inputActions.submit()` */
type _InputSetDraft = Expect<Extends<Ret<InputActions['setDraft']>, void>>
type _InputSubmit = Expect<Extends<Ret<InputActions['submit']>, void>>

// ─────────────────────────────────────────────────────────────
// ② InputZone 面：session + input 双字段存在（两个 dock 都读）
// ─────────────────────────────────────────────────────────────

type _InputZoneSession = Expect<Extends<InputZone['session'], unknown>>
type _InputZoneInput = Expect<Extends<InputZone['input'], { draft: string }>>

/**
 * `session.promptError` —— 触发判定（存在性-lite）：
 *  - 顶层锁 `PromptError` 有 `error` 字段；
 *  - 锁 `RemoteFailure` 有 `code` 字段（code 判别联合，`details` 形状由各 owner 自由合并
 *    —— 不可全形状断言，否则任何 owner 加非对象 details 都会误报；`details.reason` 由
 *    `isImageFallbackTrigger` 的 `?.` 读路径软处理）。
 */
type _PromptError = Expect<Extends<NonNullable<InputZone['session']['promptError']>, { error: unknown }>>
type _RemoteFailureCode = Expect<Extends<NonNullable<NonNullable<InputZone['session']['promptError']>['error']>, { code: unknown }>>

// ─────────────────────────────────────────────────────────────
// ③ 会话作用域 props（SafeModePanel / 两个 dock 的 sessionId）
// ─────────────────────────────────────────────────────────────

/** `props.sessionId`（SessionStandardProps）——ui-session 迁移类改名 → 此处红。 */
type _SessionStandardId = Expect<Extends<SessionStandardProps['sessionId'], string>>

// ─────────────────────────────────────────────────────────────
// ④ diagram 图片行（v1.51.2）：类型链"真的解析出来了"的反证
// ─────────────────────────────────────────────────────────────
//
// 背景（诚实边界）：`@deepseek-ai/dsh-client-ui-tool`（`tool.call.toolview` 槽的声明处）
// 与 `@deepseek-ai/dsh-attachment` 都**不能在本仓直接 import**（实测 TS2307），
// 而 `@deepseek-ai/dsh-client-ui-conversation/client` 可以。故 `diagram-result.ts`
// 沿 `ToolResultNode['content'][number] → Extract<…,{type:'image'}> → ['attachment']`
// 取真类型。这条链有个**静默退化**风险：任一段解析不到就会变成 `any`（`skipLibCheck` 下不报错），
// 于是 `loadImage(ref)` 照样编译过、运行期才炸。下面五条断言把"退化成 any/never/裸 string"全部钉红。

/** 类型链没退化成 `any`（`any` 会让后面每条断言都假绿）。 */
type _DiagramRefNotAny = Expect<Not<IsAny<DiagramImageRef>>>

/** 类型链没断成 `never`（`Extract` 不匹配时静默得 `never`）。 */
type _DiagramRefNotNever = Expect<Not<IsNever<DiagramImageRef>>>

/** `attachmentId` 是**品牌** id（裸 `string` 或 `any` 都假 ⇒ 红）。 */
type _DiagramRefIdBranded = Expect<Not<Extends<string, DiagramImageRef['attachmentId']>>>

/** 尺寸字段仍是数值（宿主改形状 → 此处红）。 */
type _DiagramRefSize = Expect<Extends<DiagramImageRef, { width: number; height: number }>>

/** 取出来的引用**正是** loader 的形参类型 —— 这就是 `loadImage(ref)` 无需 cast 的依据。 */
type _DiagramRefIsLoaderArg = Expect<Extends<DiagramImageRef, Parameters<MessageImageLoader>[0]>>
