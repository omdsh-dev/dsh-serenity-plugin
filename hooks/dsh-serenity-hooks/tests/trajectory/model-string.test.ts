/**
 * trajectory/model-string.test.ts — `splitModel` 的解析判据
 *
 * 本模块是 2026-10-28 从 `trajectory/delegate/core.ts` 抽出时**新建**的
 * （cheap-worker 下线，但它有两个跨域消费者：`trajectory/session.ts` 的 agentOptions 装配
 *  与 `trajectory/model-runtime.ts` 的模型热切换）。所以这份镜像测试也必须存在 ——
 * SQC 的镜像门禁查的就是"src 模块有没有测试引用"。
 */
import { describe, it, expect } from 'vitest'
import { splitModel } from '../../src/trajectory/model-string.js'

describe('splitModel：provider/model 串解析', () => {
  it('标准形态 → 切成两段', () => {
    expect(splitModel('provider-a/model-x')).toEqual({ provider: 'provider-a', model: 'model-x' })
  })

  it('无 `/` ⇒ provider 为 undefined（model-only；是否接受由调用方定）', () => {
    expect(splitModel('bare-model')).toEqual({ provider: undefined, model: 'bare-model' })
  })

  /**
   * 🔴 关键判据（这条是模块存在的理由）：**只按第一个 `/` 切**。
   * model id 里可能再带 `/`（上游有些命名空间型 id 就是这样），
   * 用 `split('/')` 会把 provider 之后的整段切碎 ⇒ 模型名变成 `undefined`。
   */
  it('model id 里带 `/` ⇒ 只切第一个斜杠，其余原样留在 model 侧', () => {
    expect(splitModel('provider-a/ns/model-x')).toEqual({ provider: 'provider-a', model: 'ns/model-x' })
  })

  it('两个斜杠同族（多个 `/`）⇒ 仍然只切第一个', () => {
    expect(splitModel('p/a/b/c')).toEqual({ provider: 'p', model: 'a/b/c' })
  })

  it('空串 ⇒ provider undefined ＋ model 空串（不抛错，交给调用方判）', () => {
    expect(splitModel('')).toEqual({ provider: undefined, model: '' })
  })

  it('以 `/` 开头 ⇒ provider 为空串、model 为其余部分（不吞字符）', () => {
    expect(splitModel('/model-x')).toEqual({ provider: '', model: 'model-x' })
  })

  it('以 `/` 结尾 ⇒ model 为空串（不吞斜杠）', () => {
    expect(splitModel('provider-a/')).toEqual({ provider: 'provider-a', model: '' })
  })
})
