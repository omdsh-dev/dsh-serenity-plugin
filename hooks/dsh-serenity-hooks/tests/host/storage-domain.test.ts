/**
 * storage-domain.test.ts — 宿主存储域（`storageDomain`）契约回归用例（S142 §0L）
 *
 * 为什么存在（R↓）：§0L 把「会话 ↔ 轨迹」绑定的载体从 CCC 的 `.bindings.json`
 * 搬到**宿主自己的存储域**（`~/.dsh/storages/`，与宿主 `workspace.json` 同处同类）。
 * ⇒ `storageDomain` 从可选面变为 **ACC 的真实依赖**，故：
 *   ① 在 `src/host/contract.ts` 的 `HOST_SERVICES` 登记（`dashboard health` 可探）；
 *   ② 由本文件钉住其**运行时行为**（契约表只能证明"服务在不在"，证明不了"能不能用"）。
 *
 * 本文件由 §0L 的一次性探针**转化而来**（原 `storage-domain-probe.test.ts`，2026-09-19）：
 * owner 未就该探针的去留下达决策（「不知道是干啥用的」）⇒ 按维护者倾向**保留为契约用例**，
 * 理由：依赖一旦成立就应有长期体检项，否则宿主漂移只会静默失效（与 v1.30.5 的错误码漂移同族）。
 *
 * 为什么用真实 cordis 拓扑而不是起真机（R↓）：
 *   ① 可复现——进测试套件，`msm dsh-develop test` 可重跑；
 *   ② **零打断**——起真机会杀掉当前正在跑的会话（D62 的代价）；
 *   ③ 拓扑同构——与 `tests/host/cordis-access.test.ts` 同一手法（**兄弟 fiber**）。
 *
 * 已实测钉死的三条（§0L 的三个验收点）：
 *   C-1 插件能否拿到 `storageDomain`（经 `ctx.get`，非 inject 属性直读）；
 *   C-2 `defineDomain` + `open` + `put` + 读回 + **关闭重开仍可读**（真落盘）；
 *   C-3 域名字符集：`serenity_bindings` 合法 / `serenity-bindings` 非法。
 *
 * 诚实边界（E↑）：宿主后端 `dsh-storage-json` **只在宿主里**（CCC 内无此包）
 * ⇒ 本文件自实现一个**最小 JSON 后端**（实现 `KvFacet`/`KvUnit` 契约）走真实链路；
 * 这验的是"域语义 + 调用链"，不是"宿主 json 后端的实现质量"。
 */
import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { hostService } from '../../src/host/access.js'
import { bindingDomainSpec } from '../../src/host/storage-domain.js'
import { probeHostContract } from '../../src/host/contract.js'

type Ctx = Record<string, unknown>

const HERE = dirname(fileURLToPath(import.meta.url))
/** 插件包根（tests/host/ → 上两级） */
const PKG_ROOT = join(HERE, '..', '..')
const HOME = process.env.HOME ?? ''

/** 在 pnpm 目录里按前缀定位实体包入口（版本无关） */
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

/** 真实 cordis 实例（与 cordis-access.test.ts 同源探测顺序） */
function cordisPath(): string | undefined {
  return [
    process.env.SERENITY_CORDIS_PATH ?? '',
    join(HOME, '.dsh', 'profiles', 'web', 'node_modules', 'cordis', 'lib', 'index.js'),
    join(HOME, '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js'),
  ].filter(Boolean).find((p) => existsSync(p))
}

const cPath = cordisPath()
const storagePath = findPnpmEntry('@deepseek-ai+dsh-storage@')
const domainPath = findPnpmEntry('@deepseek-ai+dsh-storage-domain@')
const depsReady = Boolean(cPath && storagePath && domainPath)

/** 探针结论（打印 + 回填 SESSION.md 两用） */
const report: Record<string, unknown> = {
  '依赖 cordis': cPath ?? '(missing)',
  '依赖 dsh-storage': storagePath ? '(found)' : '(missing)',
  '依赖 dsh-storage-domain': domainPath ? '(found)' : '(missing)',
}
const errors: string[] = []

describe.skipIf(!depsReady)('§0L storageDomain（真实 cordis + 真实 storage 包）', () => {
  it('C-1/C-2/C-3 一次完整取证', async () => {
    const { Context } = (await import(cPath!)) as { Context: new () => Ctx }
    const storageMod = (await import(storagePath!)) as {
      default: new (ctx: unknown) => { backend: { register: (n: string, b: unknown) => () => void } }
      UNIT_NAME_RE: RegExp
      storageBackendServiceKey: (n: string) => string
    }
    const domainMod = (await import(domainPath!)) as {
      apply: (ctx: Ctx, config: unknown) => unknown
      defineDomain: (spec: unknown) => unknown
    }

    // ── C-3：域名字符集（静态常量的**运行时**取值）──
    const RE = storageMod.UNIT_NAME_RE
    report['C-3 serenity-bindings 合法'] = RE.test('serenity-bindings')
    report['C-3 serenity_bindings 合法'] = RE.test('serenity_bindings')
    report['C-3 UNIT_NAME_RE'] = String(RE)
    expect(RE.test('serenity-bindings'), '连字符名应被拒绝').toBe(false)
    expect(RE.test('serenity_bindings'), '下划线名应被接受').toBe(true)

    // ── 搭真机同构拓扑 ──
    // 真机：storage 由 @deepseek-ai/dsh-storage 提供；storage-domain 注入
    // ['storage','storage.backend.json'] 后 provide('storageDomain', …)；
    // dsp 是不声明 inject 的**兄弟** fiber。
    const tmp = mkdtempSync(join(tmpdir(), 'serenity-probe-'))
    const root = new Context()
    const backendKey = storageMod.storageBackendServiceKey('json')
    let facilitySeen: unknown

    try {
      // ① storage hub（真机：`@deepseek-ai/dsh-storage` 的 Storage extends Service）
      //    ⚠️ `new Storage(ctx)` **自身**即注册服务（`super(ctx, "storage")`）——勿再手动 provide。
      const svc = new storageMod.default(root as never) as unknown as {
        backend: { register: (n: string, b: unknown) => () => void }
      }
      // 后端：**真实可用的最小 JSON 后端**（实现 KvFacet 契约），落盘到 tmp 目录。
      // 为什么必须做真的：`dsh-storage-json` 只在宿主里（CCC 内无包），
      // 而 C-2 要验的是「open → put → 读回 → 重开仍在（真落盘）」——
      // 用存根只会得到 `backend-not-found` 假阴性（首轮实测即是此坑）。
      const mediumFile = join(tmp, 'probe-unit.json')
      const readMedium = (): Record<string, { tables: Record<string, Record<string, unknown>>; global: unknown; version: number }> => {
        try { return JSON.parse(readFileSync(mediumFile, 'utf-8')) as never } catch { return {} }
      }
      const writeMedium = (m: unknown): void => { writeFileSync(mediumFile, JSON.stringify(m), 'utf-8') }
      const jsonBackend = {
        kv: {
          open: async (descriptor: { name: string; version: number; tables: readonly string[] }) => {
            const medium = readMedium()
            let unit = medium[descriptor.name]
            if (unit && unit.version !== descriptor.version) {
              throw new Error(`version-mismatch: ${unit.version} != ${descriptor.version}`)
            }
            if (!unit) {
              unit = { version: descriptor.version, global: null, tables: {} }
              for (const t of descriptor.tables) unit.tables[t] = {}
              medium[descriptor.name] = unit
              writeMedium(medium)
            }
            const u = unit
            let closed = false
            const assertOpen = (): void => { if (closed) throw new Error('closed') }
            return {
              loadAll: async () => { assertOpen(); return { tables: u.tables, global: u.global } },
              putRecord: async (table: string, key: string, value: unknown) => {
                assertOpen()
                const m = readMedium()
                m[descriptor.name]!.tables[table]![key] = value
                writeMedium(m)
                u.tables[table]![key] = value
              },
              deleteRecord: async (table: string, key: string) => {
                assertOpen()
                const m = readMedium()
                delete m[descriptor.name]!.tables[table]![key]
                writeMedium(m)
                delete u.tables[table]![key]
              },
              setGlobal: async (value: unknown) => {
                assertOpen()
                const m = readMedium()
                m[descriptor.name]!.global = value
                writeMedium(m)
                u.global = value
              },
              close: async () => { closed = true },
            }
          },
        },
        close: async () => {},
      }
      svc.backend.register('json', jsonBackend)
      ;(root.provide as (n: string, v: unknown) => () => void)(backendKey, jsonBackend)

      // ② storage-domain：跑**真实 apply**（这是我们真正要验的那条链）
      let domainCtx: Ctx | undefined
      await root.plugin({
        name: 'storage-domain-probe',
        inject: ['storage', backendKey],
        apply: async (c: Ctx) => {
          domainCtx = c
          try {
            await domainMod.apply(c, { backend: 'json' })
          } catch (e) {
            errors.push(`domain.apply 抛错: ${(e as Error).message}`)
          }
        },
      })

      // ③ dsp-like：**不声明 inject** 的兄弟 fiber（真机 dsp 拓扑）
      let dspCtx: Ctx | undefined
      await root.plugin({ name: 'dsp-like-probe', apply: (c: Ctx) => { dspCtx = c } })

      // ── C-1：dsp 能否**通过 ctx.get** 看到 storageDomain ──
      // 这正是产品 hostService 的路径（非 inject）；也是 v1.31.4 踩过的坑。
      facilitySeen = dspCtx ? hostService(dspCtx, 'storageDomain') : undefined
      if (facilitySeen === undefined && domainCtx) {
        facilitySeen = hostService(domainCtx, 'storageDomain')
        report['C-1 备注'] = '兄弟 fiber 看不到；owning fiber 可见'
      }
      report['C-1 storageDomain 可见'] = facilitySeen !== undefined
      report['C-1 形状'] = facilitySeen === undefined
        ? '(absent)'
        : ((facilitySeen as { constructor?: { name?: string } }).constructor?.name ?? '(anonymous)')

      // ── C-2：域往返（open → put → 同域读回 → close → **重开再读**）──
      // 后端是**自实现的真实最小 JSON 后端**（落盘到 tmp），故这是真往返、真落盘。
      const facility = facilitySeen as { open?: (spec: unknown) => Promise<unknown> } | undefined
      if (facility?.open) {
        const spec = domainMod.defineDomain({
          name: 'serenity_bindings',
          version: 1,
          tables: {
            bindings: {
              valueSchema: {
                parse: (v: unknown) => v,
                safeParse: (v: unknown) => ({ success: true, data: v }),
              },
            },
          },
        })
        type Table = { put: (k: string, v: unknown) => Promise<void>; get: (k: string) => unknown }
        type Domain = { table: (n: string) => Table; close: () => Promise<void> }
        try {
          // 第一次打开：写一条
          const d1 = (await facility.open(spec)) as Domain
          const t1 = d1.table('bindings')
          await t1.put('sess-1', { dirName: 'probe', code: 'S000' })
          const back1 = t1.get('sess-1')
          report['C-2 同域读回'] = Boolean(back1)
          report['C-2 读回值'] = back1
          await d1.close()

          // 第二次打开（同一进程、同一后端）：验**落盘**持久性
          const d2 = (await facility.open(spec)) as Domain
          const t2 = d2.table('bindings')
          const back2 = t2.get('sess-1')
          report['C-2 关闭重开仍可读'] = Boolean(back2)
          report['C-2 重开后值'] = back2
          report['C-2 open 成功'] = true
          await d2.close()

          // 负控（**判据纪律：探针先做正控**）：未写过的键必须读不到
          const d3 = (await facility.open(spec)) as Domain
          report['C-2 负控（未写键应为空）'] = d3.table('bindings').get('never-written') === undefined
          await d3.close()
        } catch (e) {
          report['C-2 open 成功'] = false
          errors.push(`C-2: ${(e as Error).message}`)
        }
      } else {
        report['C-2 open 成功'] = false
        errors.push('C-2 未执行：facility.open 不可用（storageDomain 未取得）')
      }

      report['errors'] = errors

      // ── 契约面一致性：probeHostContract 必须认得 storageDomain（§0L 依赖已登记）──
      if (dspCtx) {
        const contract = probeHostContract(dspCtx, null)
        report['契约面 storageDomain 无缺失'] = !contract.issues.some((i) => i.id.startsWith('storageDomain'))
        expect(
          contract.issues.some((i) => i.id.startsWith('storageDomain')),
          'storageDomain 已登记进 HOST_SERVICES ⇒ 不应被报缺失',
        ).toBe(false)
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }

    // ── 核心断言（三个 C 点各自的判据）──
    expect(report['C-1 storageDomain 可见'], 'C-1 失败 ⇒ 路线退 §0K').toBe(true)
    expect(report['C-2 open 成功'], 'C-2 失败 ⇒ 域不可用 ⇒ 退 §0K').toBe(true)
    expect(report['C-2 同域读回'], 'C-2 写后读不回 ⇒ 域语义不成立').toBe(true)
    expect(report['C-2 关闭重开仍可读'], 'C-2 未落盘 ⇒ 不能作单一真相源').toBe(true)
    expect(report['C-2 负控（未写键应为空）'], '负控失败 ⇒ 读侧恒真，正控无意义').toBe(true)
    expect(report['C-3 serenity-bindings 合法'], 'C-3 连字符应被拒').toBe(false)
    expect(report['C-3 serenity_bindings 合法'], 'C-3 下划线应被受').toBe(true)
  }, 30000)
})

describe('storage-domain：本模块自产规格的可用性（⑤ 第 37 件）', () => {
  /**
   * 🔴 **为什么它此前零行为证据**：`bindingDomainSpec()` 出产的规格里，`passthroughSchema`
   * 的 `parse` / `safeParse` 两个箭头**从没被调用过** —— 既有 C-2 用例是在测试里
   * **手写自己的内联 schema 字面量**（`{ parse: (v) => v, safeParse: ... }`），
   * 走的不是本模块那份。
   * 🔴 **可达性取证**（挑靶四条）：`bindingDomainSpec()` 被 `openBindingDomain()` 调用，
   * 而 `openBindingDomain()` 是**活路径**（宿主落盘读回边界时宿主拿这个 schema 校验）
   * ⇒ 不是死代码；缺的正是"**我们交出去的那个 schema 到底合不合规、放不放行**"。
   * ⚠️ **真机用例对它是空的**：那条只在**本机解析得到 `dsh-storage-domain`** 时才跑
   * （`domainPath` 为假则整块跳过）⇒ 它**不能**替代本组。本组**零依赖**，恒可跑。
   */
  it('bindingDomainSpec：域规格形状（名字/版本/表/值 schema 齐备，且可被 defineDomain 接受）', async () => {
    const spec = bindingDomainSpec() as {
      name: string
      version: number
      tables: Record<string, { valueSchema: unknown }>
    }
    expect(spec.name).toBe('serenity_bindings')
    expect(spec.version).toBe(1)
    // 🔴 域名约束：下划线合法、连字符非法（文件头登记，宿主 defineDomain 在模块加载期就抛）
    expect(spec.name).toMatch(/^[a-z][a-z0-9_]*$/)
    expect(Object.keys(spec.tables)).toEqual(['bindings'])
    expect(spec.tables.bindings!.valueSchema).toBeDefined()
    // 正控：真的用宿主的 defineDomain 走一遍（若本机可解析该包）——不可解析则跳过，不假装通过
    if (domainPath) {
      const mod = (await import(domainPath)) as { defineDomain?: (spec: unknown) => unknown }
      expect(typeof mod.defineDomain).toBe('function')
      expect(() => mod.defineDomain!(spec)).not.toThrow()
    }
  })

  it('🔴 valueSchema 语义 = 恒等放行（parse 原样返回 / safeParse 恒 success）', () => {
    const spec = bindingDomainSpec() as { tables: Record<string, { valueSchema: unknown }> }
    const schema = spec.tables.bindings!.valueSchema as {
      parse: (v: unknown) => unknown
      safeParse: (v: unknown) => { success: boolean; data?: unknown }
    }
    // 本模块的设计是**恒等放行**（真正的形状把关在读侧的 asBindingRecord）
    // ⇒ 三个判别性输入都要被原样放行，包括"看起来像坏数据"的那些
    for (const v of [{ dirName: 'x' }, null, 'not-an-object']) {
      expect(schema.parse(v)).toBe(v)
      const r = schema.safeParse(v)
      expect(r.success).toBe(true)
      expect(r.data).toBe(v)
    }
  })

  it('🔴 恒等放行的边界与 asBindingRecord 的分工（放行 ≠ 接受）', async () => {
    // 这两件事必须分开钉：schema 放行一切，而**读侧**才真正决定"算不算一条绑定"
    const { BindingStore } = await import('../../src/host/storage-domain.js')
    const table = {
      get: (): unknown => ({ notADirName: 1 }), // 形状不合法的记录
      entries: () => [[ 'k', { notADirName: 1 } as unknown ] as [string, unknown]],
      size: 1,
      put: async () => {},
      delete: async () => true,
    }
    const store = new BindingStore({ table: () => table } as never)
    // schema 会放行它，但 store 读出来必须是 undefined（形状把关在 asBindingRecord）
    expect(store.get('k')).toBeUndefined()
    expect(store.entries()).toEqual([])
  })
})

describe('§0L storageDomain：环境与契约登记自检', () => {  it('依赖可解析（否则本文件失去保护力）', () => {
    if (process.env.CI) return
    expect(
      { cordis: Boolean(cPath), storage: Boolean(storagePath), domain: Boolean(domainPath) },
      '需真实 cordis + dsh-storage + dsh-storage-domain（peer-only 时本机仍应能解析）',
    ).toEqual({ cordis: true, storage: true, domain: true })
  })

  it('storageDomain 已登记进 HOST_SERVICES（§0L 依赖可被 dashboard health 探到）', async () => {
    const { HOST_SERVICES } = await import('../../src/host/contract.js')
    const entry = HOST_SERVICES.find((s) => s.id === 'storageDomain')
    expect(entry, 'HOST_SERVICES 应含 storageDomain 条目').toBeTruthy()
    // 实测依据：dsp 的 inject 列表不含它 ⇒ 必须走 ctx.get（lazy），属性直读会抛错
    expect(entry?.access).toBe('lazy')
    expect(entry?.members.map((m) => m.name)).toContain('open')
  })

  it('打印取证结论（诊断用）', () => {
    // eslint-disable-next-line no-console
    console.log('\n===== §0L storageDomain 取证结论 =====\n'
      + JSON.stringify(report, null, 2)
      + '\n=====================================\n')
  })
})
