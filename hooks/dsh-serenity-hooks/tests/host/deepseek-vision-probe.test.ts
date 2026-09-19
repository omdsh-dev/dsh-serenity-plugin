/**
 * deepseek-vision-probe.test.ts — V-1 探针（S142 §26 §0x-9）
 *
 * ## 要回答的唯一问题（V-1）
 *
 * 🔴 **`settings.update('llm-pi-ai', patch)` 去写 `providers.<route>.models[i].input`，
 * 通道本身是否支持？尤其是——发"只含一个元素的 models 数组"会发生什么？**
 *
 * 为什么这是"生死线"：若数组不是整体替换（而是按元素深合并），我们就不必读-改-整写；
 * 若是整体替换，**我们的 patch 必须把整个 models 数组读出来改完再整体回写**，
 * 否则会**静默冲掉用户在该 route 上的其它模型** 🔴。
 * ⇒ **"我读了源码" ≠ "我执行了那条链"**（§4.2 纪律）⇒ 必须真跑一次。
 *
 * ## 为什么用真实 dsh-settings（不是自造脚手架）
 *
 * 本探针 import **宿主真实的 `@deepseek-ai/dsh-settings`**（pnpm store 内 0.1.5-rc.1），
 * 走真实 `SettingsProvider` 子类 → 真实 `register` → 真实 `update`（`write(…,'merge')`）
 * → 真实 `mergeLayers` → 真实 `persist` → 读回。**全程无自造合并逻辑。**
 *
 * ## 取证点
 *
 *   W-0 **正控**：命名空间注册 + `update` 普通对象 patch **能写成功**
 *   W-1 🔴 **关键判据**：`models[]` 整体替换 —— 发只含一个元素的数组，读回若只剩那一个
 *       ⇒ 证实"数组整体替换" ⇒ **我们的 patch 必须整写全量**
 *   W-2 **负控**：非目标字段（同 route 的 `headers`）在 models 整写后**应当还在**
 *       （证明"整写 models 不会伤到同层的其它字段"——这是我们敢用大 patch 的依据）
 *
 * ## 诚实边界（E↑）
 *
 * 本探针验的是 **`dsh-settings` 的注册/合并/持久化链路**。
 * ⚠️ **不含 `llm-pi-ai` 自己的 `validate`**（pi-ai 的 zod schema + `assertServiceable`）——
 * 那需要装载真 pi-ai 包。⇒ 探针结论对"settings 通道"是真的；
 * 对"pi-ai 会不会拒"**只是必要条件**（通道通 ≠ 被 pi-ai 接受）。
 * 这一层留给 P-6 的**真机实测验收**（判据 = 那个模型真能收图）。
 */
import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

type Ctx = Record<string, unknown>

const HERE = dirname(fileURLToPath(import.meta.url))
/** 插件包根（tests/host/ → 上两级） */
const PKG_ROOT = join(HERE, '..', '..')

/** 在 pnpm 目录里按前缀定位实体包入口（版本无关；与 storage-domain.test.ts 同法） */
function findPnpmEntry(prefix: string): string | undefined {
  const root = join(PKG_ROOT, 'node_modules', '.pnpm')
  if (!existsSync(root)) return undefined
  const hit = readdirSync(root).find((n) => n.startsWith(prefix))
  if (!hit) return undefined
  const [scope, rest] = prefix.split('+')
  const name = rest?.split('@')[0]
  const candidate = join(root, hit, 'node_modules', scope!, name!, 'lib', 'index.js')
  return existsSync(candidate) ? candidate : undefined
}

const settingsPath = findPnpmEntry('@deepseek-ai+dsh-settings@')
const cordisPath = [
  process.env.SERENITY_CORDIS_PATH ?? '',
  join(process.env.HOME ?? '', '.dsh', 'profiles', 'web', 'node_modules', 'cordis', 'lib', 'index.js'),
  join(process.env.HOME ?? '', '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js'),
].filter(Boolean).find((p) => existsSync(p))

const depsReady = Boolean(settingsPath && cordisPath)

/** 探针结论（打印 + 回填 SESSION.md 两用） */
const report: Record<string, unknown> = {
  '依赖 dsh-settings': settingsPath ?? '(missing)',
  '依赖 cordis': cordisPath ?? '(missing)',
}
const errors: string[] = []

describe.skipIf(!depsReady)('§26 §0x-9 V-1 探针（真实 dsh-settings）', () => {
  it('W-0/W-1/W-2 一次完整取证', async () => {
    const mod = (await import(settingsPath!)) as {
      SettingsProvider: new (ctx: Ctx) => Record<string, unknown>
    }
    const { Context } = (await import(cordisPath!)) as { Context: new () => Ctx }

    const tmp = mkdtempSync(join(tmpdir(), 'serenity-vision-probe-'))
    const docFile = join(tmp, 'settings.json')
    const writeDoc = (d: unknown): void => { writeFileSync(docFile, JSON.stringify(d), 'utf-8') }
    const readDocRaw = (): Record<string, unknown> => {
      try { return JSON.parse(readFileSync(docFile, 'utf-8')) as Record<string, unknown> } catch { return {} }
    }

    /**
     * 真实 Provider 子类：只实现宿主要求的两件事——`load()` 与 `persist(ns, section)`。
     * `persist` 的签名是 `(ns, section)`（见 `write()` 内 `await this.persist(ns, section)`）。
     */
    class ProbeProvider extends (mod.SettingsProvider as never) {
      /**
       * 🔴 `writable` 由**子类**定义（基类不设 ⇒ falsy ⇒ `write()` 直接抛
       * `settings provider is read-only`，`:448`）。
       * 真机里恒 true 的是 `dsh-settings-file`（`opencode-provider.ts:24` 已记此事实）
       * ⇒ 本探针如实模拟该值——**这是取得真实写入链路的前提**，不是绕过校验。
       */
      writable = true
      async load(): Promise<Record<string, unknown>> { return readDocRaw() }
      async persist(ns: string, section: unknown): Promise<void> {
        const doc = readDocRaw()
        doc[ns] = section
        writeDoc(doc)
      }
    }

    /** llm-pi-ai 式命名空间的数据形状（照 `Config = z.object({providers: z.dict(profile)})`，`:1017`） */
    const initial = {
      providers: {
        r: {
          // 用户已有的两个模型（其中一个带完整字段，用于验"整写不丢字段"）
          models: [
            { id: 'deepseek-keep', name: 'DeepSeek Keep', contextWindow: 262144 },
            { id: 'other-model', name: 'Other', contextWindow: 128000 },
          ],
          headers: { 'x-user-kept': 'yes' },
        },
      },
    }

    try {
      writeDoc({ 'probe-ns': initial })
      const ctx = new Context()
      const provider = new ProbeProvider(ctx as never)

      // 真实 register(ns, schema, options)——schema 直通（本探针不验 pi-ai 的 zod）
      const registration = (provider as unknown as {
        register: (ns: string, schema: unknown, options?: unknown) => {
          get: () => unknown
          update: (patch: object) => Promise<void>
        }
        // schema 是**函数**（`resolve()` 内 `schema(mergeLayers(base, section))`，`:510`）；
        // 本探针用恒等函数——我们验的是合并/落盘链路，不是 schemastery 的校验强度。
      }).register('probe-ns', (v: unknown) => v, {})

      // 读取现状：`section()` 是宿主写入路径用的原样读法（registration.get() 是 resolved）
      const sectionOf = (): Record<string, unknown> => {
        const s = (provider as unknown as { section?: (ns: string) => unknown }).section
        return (typeof s === 'function' ? s.call(provider, 'probe-ns') : undefined) as Record<string, unknown> ?? {}
      }

      report['注册后原样 section'] = JSON.stringify(sectionOf())
      report['resolved 可读'] = registration.get() !== undefined

      // ── W-0 正控：普通对象 patch 能写成功 ──
      try {
        await registration.update({ providers: { r: { headers: { 'x-added': 'ok' } } } })
        const after0 = sectionOf()
        report['W-0 正控写入'] = true
        report['W-0 写后 headers'] = JSON.stringify((after0.providers as Record<string, { headers?: unknown }>)?.r?.headers)
        // 正控加强：深合并不该冲掉用户的 x-user-kept
        report['W-0 用户原 header 仍在'] = JSON.stringify(after0).includes('x-user-kept')
      } catch (e) {
        report['W-0 正控写入'] = false
        errors.push(`W-0: ${(e as Error).message}`)
      }

      // ── W-1 🔴 核心判据：models 数组整体替换（真链路）──
      try {
        await registration.update({
          providers: { r: { models: [{ id: 'only-one', name: 'Only One', input: ['text', 'image'] }] } },
        })
        const after1 = sectionOf()
        const models = ((after1.providers as Record<string, { models?: unknown[] }>)?.r?.models ?? []) as unknown[]
        const asText = JSON.stringify(models)
        report['W-1 写后 models 条数'] = models.length
        report['W-1 写后 models'] = asText
        report['W-1 原两个模型是否被冲掉'] = !asText.includes('deepseek-keep')
        // 负控配对：同层的 headers 不应被 models 整写波及
        report['W-2 同层 headers 仍在'] = JSON.stringify(after1).includes('x-user-kept')
      } catch (e) {
        errors.push(`W-1: ${(e as Error).message}`)
      }

      // ── W-3：读-改-整写（我们要用的正确做法）是否保住其它模型 ──
      // ⚠️ 必须**重置到初始状态**再验：W-1 已把 models 冲成单元素（那是它的**目的**），
      // 若不做这一步，W-3 就是在"已被冲掉的残局"上跑 ⇒ 会把状态污染误报成"整写不保模型"。
      // （本轮实测首跑即踩此坑 —— 探针自身的时序缺陷，非方案缺陷。）
      try {
        writeDoc({ 'probe-ns': initial })
        await provider.load() // 让 provider 重新读盘（`section()` 读的是 this.document）
        ;(provider as unknown as { document?: Record<string, unknown> }).document = readDocRaw()
        const cur = sectionOf()
        const curModels = (((cur.providers as Record<string, unknown>)?.r as { models?: unknown[] })
          ?.models ?? []) as Record<string, unknown>[]
        const rewritten = curModels.map((mm) =>
          typeof mm?.id === 'string' && mm.id.includes('deepseek') ? { ...mm, input: ['text', 'image'] } : mm)
        await registration.update({ providers: { r: { models: rewritten } } })
        const after3 = sectionOf()
        const models3 = ((after3.providers as Record<string, { models?: unknown[] }>)?.r?.models ?? []) as Record<string, unknown>[]
        report['W-3 整写后条数'] = models3.length
        report['W-3 整写后 models'] = JSON.stringify(models3)
        report['W-3 非 deepseek 模型保留'] = JSON.stringify(models3).includes('other-model')
        report['W-3 字段保留(contextWindow)'] = JSON.stringify(models3).includes('262144')
      } catch (e) {
        errors.push(`W-3: ${(e as Error).message}`)
      }

      report['最终落盘文档'] = JSON.stringify(readDocRaw())
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }

    report['errors'] = errors

    // ── 核心断言（三个取证点的判据）──
    expect(report['W-0 正控写入'], '正控失败 ⇒ 链路本身不通，后续判据无意义').toBe(true)
    expect(
      report['W-1 原两个模型是否被冲掉'],
      '🔴 数组整体替换必须成立：发单元素数组应冲掉原有全部模型 ⇒ 我们的 patch 必须整写全量',
    ).toBe(true)
    expect(report['W-3 非 deepseek 模型保留'], '读-改-整写必须保住非目标模型').toBe(true)
    expect(report['W-3 字段保留(contextWindow)'], '整写不得丢字段（spread 原对象）').toBe(true)
  }, 30000)
})

describe('§26 §0x-9：环境自检', () => {
  it('依赖可解析（否则本文件失去保护力）', () => {
    if (process.env.CI) return
    expect(
      { settings: Boolean(settingsPath), cordis: Boolean(cordisPath) },
      '需真实 dsh-settings + cordis（peer-only 时本机仍应能解析）',
    ).toEqual({ settings: true, cordis: true })
  })

  it('打印取证结论（诊断用）', () => {
    // eslint-disable-next-line no-console
    console.log('\n===== §26 §0x-9 V-1 取证结论 =====\n'
      + JSON.stringify(report, null, 2)
      + '\n==================================\n')
  })
})
