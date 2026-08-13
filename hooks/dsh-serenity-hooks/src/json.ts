/**
 * json.ts — 本地 JsonValue 类型（与 DSH 的 JsonValue 同构）
 *
 * 纯层（fs-ops/session-ops）保持零 DSH 运行时依赖：仅用本地类型标注，
 * 工具层（defineTool）要求 execute 返回 DSH JsonValue，二者结构等价。
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }
