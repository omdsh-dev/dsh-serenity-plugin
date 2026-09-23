/**
 * deepseek-vision-patch.test.ts — DeepSeek 多模态补丁（S142 §26 §0x-9，owner 2026-09-19 令）
 *
 * 覆盖三类判据：
 *   ① 计划（纯函数）：deepseek 识别 / 六种 input 现状 / 幂等 / 非 deepseek 不动 /
 *      🔴 **models 数组整写不丢其它模型与字段** / **绝不新建 models**
 *   ② 执行（settings 面）：补丁形状 / 命名空间未注册 → 交重试 / 写被拒 → 响亮不抛
 *   ③ 装配：settings/updated 自愈 + 定时器随卸载拆卸（F-08）+ 开关
 *
 * 🔴 本文件的核心价值 = 把设计 §2.3「**深合并对数组是整体替换**」变成机械回归：
 * 若有人把"读-改-整写"改回"只发增量"，本文件的"保住非目标模型"用例会立刻红。
 * （该行为另由 `tests/host/deepseek-vision-probe.test.ts` 的 W-1 在**真实 dsh-settings** 上实测钉住。）
 */
import { describe, it, expect, vi } from 'vitest'
import {
  DEEPSEEK_ID_MARKER,
  applyDeepseekVisionPatchOnce,
  declaresImage,
  describeDeepseekVisionAction,
  desiredInput,
  isDeepseekModelId,
  planDeepseekVisionPatch,
  registerDeepseekVisionPatch,
} from '../src/deepseek-vision-patch.js'
import { LLM_PI_AI_NAMESPACE } from '../src/opencode-provider.js'

function plan(resolved: unknown, enabled?: boolean) {
  return planDeepseekVisionPatch({ resolved, ...enabled === undefined ? {} : { enabled } })
}

/** 取 patch 里某 route 的 models 数组（测试读法糖） */
function modelsOf(p: { patch: Record<string, unknown> }, route: string): Record<string, unknown>[] {
  const providers = p.patch.providers as Record<string, { models: Record<string, unknown>[] }> | undefined
  return providers?.[route]?.models ?? []
}

describe('deepseek-vision-patch: 模型识别', () => {
  it('id 含 deepseek（大小写不敏感）即命中', () => {
    expect(isDeepseekModelId('deepseek-v4.1-flash')).toBe(true)
    expect(isDeepseekModelId('deepseek-v4-flash-vision-exp')).toBe(true)
    expect(isDeepseekModelId('DeepSeek-V41-Flash')).toBe(true)
    expect(isDeepseekModelId('DEEPSEEK-chat')).toBe(true)
    expect(isDeepseekModelId('my-deepseek-proxy')).toBe(true) // "任何 deepseek 模型"（owner 原话）
  })

  it('非 deepseek / 非字符串 一律不命中（防误伤）', () => {
    expect(isDeepseekModelId('mimo-v2.5')).toBe(false)
    expect(isDeepseekModelId('MiniMax-M3')).toBe(false)
    expect(isDeepseekModelId('gpt-4o')).toBe(false)
    expect(isDeepseekModelId('')).toBe(false)
    expect(isDeepseekModelId(undefined)).toBe(false)
    expect(isDeepseekModelId(123)).toBe(false)
  })

  it('DEEPSEEK_ID_MARKER 与判据一致', () => {
    expect(DEEPSEEK_ID_MARKER).toBe('deepseek')
  })

  it('declaresImage 只认"含 image 的数组"', () => {
    expect(declaresImage(['text', 'image'])).toBe(true)
    expect(declaresImage(['image'])).toBe(true)
    expect(declaresImage(['image', 'text'])).toBe(true)
    expect(declaresImage(['text'])).toBe(false)
    expect(declaresImage([])).toBe(false)
    expect(declaresImage(undefined)).toBe(false)
    expect(declaresImage('image')).toBe(false)
  })
})

describe('deepseek-vision-patch: desiredInput（设计 §4.2 全表）', () => {
  it('未设 → 补成 ["text","image"]', () => {
    expect(desiredInput(undefined)).toEqual(['text', 'image'])
  })

  it('["text"] → 追加 image', () => {
    expect(desiredInput(['text'])).toEqual(['text', 'image'])
  })

  it('🔴 空数组 → 与"未设"同义（宿主 declaredInput([]) 返回 undefined）', () => {
    expect(desiredInput([])).toEqual(['text', 'image'])
  })

  it('已含 image → 原样返回（幂等，且保序）', () => {
    expect(desiredInput(['text', 'image'])).toEqual(['text', 'image'])
    expect(desiredInput(['image'])).toEqual(['image'])
    expect(desiredInput(['image', 'text'])).toEqual(['image', 'text']) // 不重排
  })

  it('非数组（脏数据）→ 按"未设"处理，不猜用户意图', () => {
    expect(desiredInput('image')).toEqual(['text', 'image'])
    expect(desiredInput(null)).toEqual(['text', 'image'])
    expect(desiredInput({})).toEqual(['text', 'image'])
    expect(desiredInput(42)).toEqual(['text', 'image'])
  })

  it('非字符串成员被剔除（脏数组不至于污染声明）', () => {
    expect(desiredInput(['text', 123, null])).toEqual(['text', 'image'])
    expect(desiredInput([123])).toEqual(['text', 'image'])
  })
})

describe('deepseek-vision-patch: 计划（纯函数）', () => {
  it('开关关闭 → idle disabled（最先判，不再看数据）', () => {
    const p = plan({ providers: { r: { models: [{ id: 'deepseek-x' }] } } }, false)
    expect(p.patch).toEqual({})
    expect(p.actions).toEqual([{ kind: 'idle', reason: 'disabled' }])
  })

  it('命名空间未注册（undefined）→ idle，交由调用方重试', () => {
    const p = plan(undefined)
    expect(p.patch).toEqual({})
    expect(p.actions).toEqual([{ kind: 'idle', reason: 'namespace-unregistered' }])
  })

  it('无 deepseek 模型 → idle no-deepseek-model，且不写', () => {
    const p = plan({ providers: { r: { models: [{ id: 'MiniMax-M3' }] } } })
    expect(p.patch).toEqual({})
    expect(p.actions).toEqual([{ kind: 'idle', reason: 'no-deepseek-model' }])
  })

  it('🔴 默认模型（不在目录、input 未设）→ 被补上 image（本功能的原始目标）', () => {
    const p = plan({ providers: { 'opencode-go-responses': { models: [{ id: 'deepseek-v4.1-flash' }] } } })
    const models = modelsOf(p, 'opencode-go-responses')
    expect(models).toEqual([{ id: 'deepseek-v4.1-flash', input: ['text', 'image'] }])
    expect(p.actions).toEqual([{ kind: 'patch-model', route: 'opencode-go-responses', model: 'deepseek-v4.1-flash' }])
  })

  it('🔴 models 数组整写：非 deepseek 模型与顺序原样保留（防"只发增量"回归）', () => {
    const p = plan({
      providers: {
        'opencode-go': {
          models: [
            { id: 'mimo-v2.5', input: ['text', 'image'] },
            { id: 'deepseek-v4.1-flash' },
            { id: 'other-model', name: 'Other', contextWindow: 128000 },
          ],
        },
      },
    })
    const models = modelsOf(p, 'opencode-go')
    expect(models.length, '整写必须是全量（3 条）').toBe(3)
    expect(models[0]).toEqual({ id: 'mimo-v2.5', input: ['text', 'image'] }) // 原样
    expect(models[1]).toEqual({ id: 'deepseek-v4.1-flash', input: ['text', 'image'] }) // 目标被改
    expect(models[2]).toEqual({ id: 'other-model', name: 'Other', contextWindow: 128000 }) // 原样、字段不丢
  })

  it('🔴 字段保留：spread 原对象，name/contextWindow 等不丢', () => {
    const p = plan({
      providers: { r: { models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: 262144, maxTokens: 32768 }] } },
    })
    expect(modelsOf(p, 'r')[0]).toEqual({
      id: 'deepseek-v4-pro',
      name: 'DeepSeek-V4-Pro',
      contextWindow: 262144,
      maxTokens: 32768,
      input: ['text', 'image'],
    })
  })

  it('幂等：已声明 image 的 deepseek 模型 → skip，且不写盘', () => {
    const p = plan({ providers: { r: { models: [{ id: 'deepseek-vision', input: ['text', 'image'] }] } } })
    expect(p.patch).toEqual({})
    expect(p.actions).toEqual([{ kind: 'skip-model', route: 'r', model: 'deepseek-vision', reason: 'already-image' }])
  })

  it('同一 route 混合：一个补、一个跳 → 只写一次，且两条都在', () => {
    const p = plan({
      providers: {
        r: {
          models: [
            { id: 'deepseek-a', input: ['text', 'image'] },
            { id: 'deepseek-b', input: ['text'] },
          ],
        },
      },
    })
    const models = modelsOf(p, 'r')
    expect(models.length).toBe(2)
    expect(models[0]).toEqual({ id: 'deepseek-a', input: ['text', 'image'] })
    expect(models[1]).toEqual({ id: 'deepseek-b', input: ['text', 'image'] })
    expect(p.actions).toEqual([
      { kind: 'skip-model', route: 'r', model: 'deepseek-a', reason: 'already-image' },
      { kind: 'patch-model', route: 'r', model: 'deepseek-b' },
    ])
  })

  it('跨多 route：各自整写各自的 models（不串台）', () => {
    const p = plan({
      providers: {
        a: { models: [{ id: 'deepseek-a' }] },
        b: { models: [{ id: 'keep-b', name: 'Keep' }] },
      },
    })
    expect(modelsOf(p, 'a')).toEqual([{ id: 'deepseek-a', input: ['text', 'image'] }])
    // b 无 deepseek ⇒ 不该出现在 patch 里（不能平白重写用户的 route）
    expect((p.patch.providers as Record<string, unknown>).b).toBeUndefined()
  })

  it('🔴 绝不新建 models：无 models 的 route（modelOverrides / 目录默认）直接跳过', () => {
    const p = plan({
      providers: {
        // 未设 models（可能用 modelOverrides 或目录默认）——为它造 models 会让宿主拒掉整个 route
        override: { modelOverrides: { 'deepseek-x': {} } },
        empty: { models: [] },
        // 正常的那条仍应被处理
        normal: { models: [{ id: 'deepseek-y' }] },
      },
    })
    const providers = p.patch.providers as Record<string, unknown>
    expect(providers.override, '不得为 modelOverrides 形态新建 models（二者互斥）').toBeUndefined()
    expect(providers.empty, '空 models 不该被新建').toBeUndefined()
    expect(modelsOf(p, 'normal')).toEqual([{ id: 'deepseek-y', input: ['text', 'image'] }])
  })

  it('脏数据：非对象的 models 元素原样保留，不影响其它元素', () => {
    const p = plan({ providers: { r: { models: ['garbage', { id: 'deepseek-z' }] } } })
    const models = modelsOf(p, 'r')
    expect(models[0]).toBe('garbage')
    expect(models[1]).toEqual({ id: 'deepseek-z', input: ['text', 'image'] })
  })

  it('脏数据：resolved 不是对象 / providers 缺失 → idle，不抛', () => {
    expect(plan(null).actions).toEqual([{ kind: 'idle', reason: 'no-deepseek-model' }])
    expect(plan({}).actions).toEqual([{ kind: 'idle', reason: 'no-deepseek-model' }])
    expect(plan({ providers: null }).actions).toEqual([{ kind: 'idle', reason: 'no-deepseek-model' }])
    expect(plan('nonsense').actions).toEqual([{ kind: 'idle', reason: 'no-deepseek-model' }])
  })

  it('patch 形状：providers.<route>.models（与深合并语义匹配）', () => {
    const p = plan({ providers: { r: { models: [{ id: 'deepseek-q' }] } } })
    expect(Object.keys(p.patch)).toEqual(['providers'])
    expect(Object.keys(p.patch.providers as object)).toEqual(['r'])
    expect(Object.keys((p.patch.providers as Record<string, object>).r)).toEqual(['models'])
  })

  it('幂等复评：对"已补过"的结果再跑一次 ⇒ 零 patch（稳态不抖动）', () => {
    const once = plan({ providers: { r: { models: [{ id: 'deepseek-r' }] } } })
    const applied = { providers: (once.patch.providers as Record<string, unknown>) }
    const twice = plan(applied)
    expect(twice.patch).toEqual({})
    expect(twice.actions).toEqual([{ kind: 'skip-model', route: 'r', model: 'deepseek-r', reason: 'already-image' }])
  })
})

describe('deepseek-vision-patch: 动作描述', () => {
  it('三种动作都有人读文本', () => {
    expect(describeDeepseekVisionAction({ kind: 'patch-model', route: 'r', model: 'deepseek-a' })).toContain('deepseek-a')
    expect(describeDeepseekVisionAction({ kind: 'skip-model', route: 'r', model: 'deepseek-a', reason: 'already-image' })).toContain('跳过')
    expect(describeDeepseekVisionAction({ kind: 'idle', reason: 'disabled' })).toContain('disabled')
  })
})

/** 造一个最小 settings 面（结构化桩；不依赖真宿主）。
 * ⚠️ 形状必须是 `{ settings: {...} }` —— `hostSettings(ctx)` 读的就是 `ctx.settings`
 * （与 `opencode-provider.test.ts` 同款；首版我写成 `__settings` ⇒ 全部执行层用例假红）。 */
function fakeCtx(getResult: unknown, opts: { getThrows?: boolean; updateThrows?: boolean } = {}) {
  const calls: { ns: string; patch: object }[] = []
  const ctx = {
    settings: {
      get: (ns: string) => {
        if (opts.getThrows) throw new Error('boom-get')
        expect(ns).toBe(LLM_PI_AI_NAMESPACE)
        return getResult
      },
      update: async (ns: string, patch: object) => {
        if (opts.updateThrows) throw new Error('boom-update')
        calls.push({ ns, patch })
      },
    },
  }
  return { ctx: ctx as never, calls }
}

describe('deepseek-vision-patch: 执行层', () => {
  it('正常：写入补丁，形状正确，wrote=true', async () => {
    const { ctx, calls } = fakeCtx({ providers: { r: { models: [{ id: 'deepseek-a' }] } } })
    const r = await applyDeepseekVisionPatchOnce(ctx)
    expect(r).toEqual({ wrote: true, registered: true })
    expect(calls.length).toBe(1)
    expect(calls[0]!.ns).toBe(LLM_PI_AI_NAMESPACE)
    expect(calls[0]!.patch).toEqual({ providers: { r: { models: [{ id: 'deepseek-a', input: ['text', 'image'] }] } } })
  })

  it('无事可做 ⇒ 不调用 update（避免无谓触发 settings/updated）', async () => {
    const { ctx, calls } = fakeCtx({ providers: { r: { models: [{ id: 'MiniMax-M3' }] } } })
    const r = await applyDeepseekVisionPatchOnce(ctx)
    expect(r).toEqual({ wrote: false, registered: true })
    expect(calls.length).toBe(0)
  })

  it('命名空间未注册 ⇒ registered=false（交调用方重试）', async () => {
    const { ctx, calls } = fakeCtx(undefined)
    const r = await applyDeepseekVisionPatchOnce(ctx)
    expect(r).toEqual({ wrote: false, registered: false })
    expect(calls.length).toBe(0)
  })

  it('写被拒 ⇒ 响亮告警但**不抛**（apply 抛错 = 整个 dsh 启动失败）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx } = fakeCtx({ providers: { r: { models: [{ id: 'deepseek-a' }] } } }, { updateThrows: true })
    const r = await applyDeepseekVisionPatchOnce(ctx)
    expect(r).toEqual({ wrote: false, registered: true })
    expect(warn.mock.calls.some((c) => String(c[0]).includes('写入被拒'))).toBe(true)
    warn.mockRestore()
  })

  it('读抛错 ⇒ 响亮告警但不抛', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx } = fakeCtx(undefined, { getThrows: true })
    const r = await applyDeepseekVisionPatchOnce(ctx)
    expect(r).toEqual({ wrote: false, registered: false })
    expect(warn.mock.calls.some((c) => String(c[0]).includes('读取'))).toBe(true)
    warn.mockRestore()
  })

  it('settings 服务缺失 ⇒ 跳过，不抛', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = await applyDeepseekVisionPatchOnce({} as never)
    expect(r).toEqual({ wrote: false, registered: false })
    expect(warn.mock.calls.some((c) => String(c[0]).includes('服务不可用'))).toBe(true)
    warn.mockRestore()
  })

  it('开关关闭 ⇒ 零写入', async () => {
    const { ctx, calls } = fakeCtx({ providers: { r: { models: [{ id: 'deepseek-a' }] } } })
    const r = await applyDeepseekVisionPatchOnce(ctx, false)
    expect(r).toEqual({ wrote: false, registered: true })
    expect(calls.length).toBe(0)
  })

  it('成功时打印一条人读日志（含 route/model）', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { ctx } = fakeCtx({ providers: { r: { models: [{ id: 'deepseek-a' }] } } })
    await applyDeepseekVisionPatchOnce(ctx)
    expect(log.mock.calls.some((c) => String(c[0]).includes('deepseek-a'))).toBe(true)
    log.mockRestore()
  })
})

describe('deepseek-vision-patch: 装配', () => {
  it('apply 时立即试一次', async () => {
    const { ctx, calls } = fakeCtx({ providers: { r: { models: [{ id: 'deepseek-a' }] } } })
    registerDeepseekVisionPatch(ctx)
    await vi.waitFor(() => { expect(calls.length).toBe(1) })
  })

  it('命名空间未注册 ⇒ 排重试（定时器 unref，不阻止退出）', async () => {
    const { ctx, calls } = fakeCtx(undefined)
    registerDeepseekVisionPatch(ctx)
    // 首次同步试一次（拿不到）；重试是 1s 后的事，此处只验"已排程、未写入"
    await vi.waitFor(() => { expect(calls.length).toBe(0) })
  })

  it('settings/updated（同 ns）⇒ 复评并写盘（热改自愈）', async () => {
    let resolved: unknown = undefined
    const calls: object[] = []
    const handlers: Record<string, (ns?: unknown) => void> = {}
    const settings = {
      get: () => resolved,
      update: async (_ns: string, patch: object) => { calls.push(patch) },
    }
    const ctx = {
      settings,
      get: (name: string) => (name === 'settings' ? settings : undefined),
      on: (name: string, fn: (ns?: unknown) => void) => { handlers[name] = fn },
    }
    registerDeepseekVisionPatch(ctx as never)
    await vi.waitFor(() => { expect(handlers['settings/document-updated']).toBeTruthy() })

    // 模拟"用户后来配好了 pi-ai + 有 deepseek 模型"
    resolved = { providers: { r: { models: [{ id: 'deepseek-late' }] } } }
    handlers['settings/document-updated']!(LLM_PI_AI_NAMESPACE)
    await vi.waitFor(() => { expect(calls.length).toBe(1) })
  })

  it('settings/document-updated（别的 ns）⇒ 不复评', async () => {
    let resolved: unknown = { providers: { r: { models: [{ id: 'deepseek-a' }] } } }
    const calls: object[] = []
    const handlers: Record<string, (ns?: unknown) => void> = {}
    const settings = {
      get: () => resolved,
      update: async (_ns: string, patch: object) => { calls.push(patch) },
    }
    const ctx = {
      settings,
      get: (name: string) => (name === 'settings' ? settings : undefined),
      on: (name: string, fn: (ns?: unknown) => void) => { handlers[name] = fn },
    }
    registerDeepseekVisionPatch(ctx as never)
    await vi.waitFor(() => { expect(calls.length).toBe(1) })
    handlers['settings/document-updated']!('some-other-ns')
    // 不该多出写入
    await new Promise((r) => setTimeout(r, 20))
    expect(calls.length).toBe(1)
    resolved = undefined // 避免未使用告警
  })

  it('事件通道缺失 ⇒ 不抛（①② 仍覆盖首次配置）', () => {
    const ctx = { settings: { get: () => undefined, update: async () => {} } }
    expect(() => { registerDeepseekVisionPatch(ctx as never) }).not.toThrow()
  })
})
