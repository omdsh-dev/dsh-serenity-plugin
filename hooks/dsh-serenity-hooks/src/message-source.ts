/**
 * message-source.ts — ACC 注入消息的来源标识（**单一真相源**，v1.47.0 / DSH 0.1.7-rc.1 适配）
 *
 * **为什么有这个文件**：DSH 0.1.7-rc.1（session format v3→v4）把消息来源从
 * 「`kind: 'plugin'` ＋ `plugin` 字段」改成**每个生产者声明自己的 kind** ——
 * `@deepseek-ai/dsh-llm` 的 `MessageSourceMap` 逐字写着：
 * *"each producer declares its own `kind` in its own module; there is no shared
 * catch-all `plugin` kind"*。⇒ 旧写法 `{ kind: 'plugin', plugin: 'dsh-serenity-hooks' }`
 * **在类型层不再合法**（合并和类型里没有 `plugin` 这一支），必须用**模块声明合并**
 * 补上自己的 kind（宿主 `dsh-session-title-llm` 与 `dsh-compaction` 都用此法）。
 *
 * **为什么取字面量 `plugin:dsh-serenity-hooks`**：v3→v4 迁移的 `producerKind()`
 * （`session-format-v3-to-v4/src/sources.ts`）把**第一方之外**的旧生产者一律写为
 * `plugin:${旧 plugin 字段}` ⇒ **存量会话升级后就是这个字面量**。新代码沿用同一字面量，
 * 使同一生产者在旧数据与新数据里**只有一个 kind**（否则下游与我方读取面都要处理两种）。
 */

import type { ContextFormed, MessageSource } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'plugin:dsh-serenity-hooks': { kind: 'plugin:dsh-serenity-hooks' } & ContextFormed
  }
}

/** ACC 注入消息的 kind —— 唤醒 / 打回 / keeper 提醒 / 锚定轮 / rebuild 交接等一律同值。 */
export const ACC_MESSAGE_KIND = 'plugin:dsh-serenity-hooks' as const

/** ACC 注入消息的统一来源值（各缝共用；需要 `form` 时按 `ContextFormed` 另加字段）。 */
export const PLUGIN_SOURCE: MessageSource = { kind: ACC_MESSAGE_KIND }
