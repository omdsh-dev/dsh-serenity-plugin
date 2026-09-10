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
import type { PropsRuntime, SessionStandardProps } from '@deepseek-ai/dsh-client-ui-slots'

type Expect<T extends true> = T
type Extends<A, B> = [A] extends [B] ? true : false
type Ret<F> = F extends (...args: never[]) => infer R ? R : never

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

/** 哨兵：`PropsRuntime<'conversation.input.dock'>` 本身必须可解析（两个 dock 的 props 基） */
export type ClientDockPropsResolvable = PropsRuntime<'conversation.input.dock'>