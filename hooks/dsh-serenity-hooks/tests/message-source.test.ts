import { describe, it, expect } from 'vitest'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import { ACC_MESSAGE_KIND, PLUGIN_SOURCE } from '../src/message-source.js'

/**
 * message-source 镜像测试（v1.47.0 / DSH 0.1.7-rc.1 适配）。
 *
 * 本模块承载两件**类型门禁管不到**的事，因此必须由测试钉住：
 *   ① kind 的**字面量**（类型层只要求它自洽，不会阻止有人把它"简化"成 `dsh-serenity-hooks`）
 *   ② 「不再有 `plugin` 字段」这一形状变化（0.1.7 起该字段不属于任何来源支）
 *
 * 旧写法 `{ kind: 'plugin', plugin: '…' }` 的**回归**由 `typecheck` 兜住（它已是类型错误），
 * 此处不重复做文本扫描。
 */
describe('message-source: ACC 注入消息的来源标识', () => {
  it('kind 取值 = `plugin:dsh-serenity-hooks`，且来源对象只带 kind', () => {
    expect(ACC_MESSAGE_KIND).toBe('plugin:dsh-serenity-hooks')
    expect(PLUGIN_SOURCE).toEqual({ kind: ACC_MESSAGE_KIND })
    expect(Object.keys(PLUGIN_SOURCE)).toEqual(['kind'])
  })

  it('🔴 必须保留 `plugin:` 前缀 —— 去掉它会让新旧数据的 kind 分叉', () => {
    // 依据：v3→v4 迁移的 producerKind()（session-format-v3-to-v4/src/sources.ts）把
    // **第一方之外**的旧生产者一律写为 `plugin:${旧 plugin 字段}`，而本插件旧字段值
    // 逐字就是 'dsh-serenity-hooks' ⇒ 存量会话升级后即 `plugin:dsh-serenity-hooks`。
    // 新代码若去掉前缀，同一生产者会在旧数据与新数据里各有一个 kind。
    expect(ACC_MESSAGE_KIND.startsWith('plugin:')).toBe(true)
    expect(ACC_MESSAGE_KIND.slice('plugin:'.length)).toBe('dsh-serenity-hooks')
  })

  it('类型面：该 kind 已并入 MessageSource 联合（模块声明合并生效）', () => {
    const source: MessageSource = { kind: ACC_MESSAGE_KIND }
    expect(source.kind).toBe(ACC_MESSAGE_KIND)
  })
})
