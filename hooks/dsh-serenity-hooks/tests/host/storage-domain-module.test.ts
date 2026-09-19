/**
 * host/storage-domain.test.ts — 绑定域模块（§0L，S142 2026-09-19）
 *
 * 这是「会话 ↔ 轨迹」绑定表的**新载体封装**，它的降级行为决定：
 *  ① 宿主没装载 storage-domain 插件时，ACC 还能不能正常工作（⇒ 必须回落旧表）；
 *  ② 域可用时，读法是否与旧实现**同形**（⇒ 既有 10 个调用点才能不改签名）。
 *
 * 逐条钉死：
 *  - `openBindingDomain` 在服务缺失 / open 抛错 / 形状不对时 **返回 null 且不抛**；
 *  - `bindingDomainSpec()` 是**纯数据**，且被**真实 `defineDomain` 接受**（关键：手写规格的合法性）；
 *  - `bindingStore(null)` 读全空、写全 false（= 降级路径的机械保证）；
 *  - 读侧形状容忍（缺 `dirName` 的记录被丢弃）。
 *
 * 依赖说明（E↑）：真实 `dsh-storage-domain` / `dsh-storage` 是**宿主 peer 依赖**，
 * 本仓 peer-only 打包不装它们；测试按"离运行时最近"的顺序探测，探测不到时
 * 「规格被真实 defineDomain 接受」一条**跳过**（其余用例不依赖真实包）。
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BINDING_DOMAIN_NAME,
  BINDING_DOMAIN_VERSION,
  BINDING_TABLE_NAME,
  bindingDomainSpec,
  bindingStore,
  openBindingDomain,
} from '../../src/host/storage-domain.js'

/**
 * 宿主 `UNIT_NAME_RE` 的**镜像子集**（判据来源见 src/host/storage-domain.ts 文件头）：
 * `@deepseek-ai/dsh-storage` 的 `lib/index.js:80` = `/^[a-z][a-z0-9_]*$/`。
 * 这里刻意**不 import 真实包**（宿主 peer 依赖）：正则字面量足够，且本文件
 * 另有一条用例用**真实** storage 包复核它（探测不到则跳过）。
 */
const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..', '..')
const HOME = process.env.HOME ?? ''

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

const domainPath = findPnpmEntry('@deepseek-ai+dsh-storage-domain@')

/** 造一个假域句柄（形状对照宿主 `Domain`/`KvTable` 的结构子集） */
function fakeDomain(records: Record<string, unknown> = {}): {
  table: (n: string) => unknown
  writeLog: Array<[string, unknown]>
} {
  const writeLog: Array<[string, unknown]> = []
  return {
    writeLog,
    table: () => ({
      get: (k: string) => records[k],
      entries: () => Object.entries(records)[Symbol.iterator](),
      size: Object.keys(records).length,
      put: async (k: string, v: unknown) => { records[k] = v; writeLog.push([k, v]) },
      delete: async (k: string) => delete records[k],
    }),
  }
}

describe('host/storage-domain: 域名与规格（§0M-3 实测约束）', () => {
  it('🔴 域名用下划线（连字符会被宿主 UNIT_NAME_RE 拒绝）', () => {
    expect(BINDING_DOMAIN_NAME).toBe('serenity_bindings')
    // 与宿主同一判据（src/host/unit-name.ts 镜像子集）
    expect(UNIT_NAME_RE.test(BINDING_DOMAIN_NAME)).toBe(true)
    expect(UNIT_NAME_RE.test('serenity-bindings'), '连字符形必须非法（否则 §0L 会照错写）').toBe(false)
  })

  it('规格含 name/version/tables，且 version 是非负整数', () => {
    const spec = bindingDomainSpec() as {
      name: string
      version: number
      tables: Record<string, unknown>
    }
    expect(spec.name).toBe(BINDING_DOMAIN_NAME)
    expect(Number.isInteger(spec.version)).toBe(true)
    expect(spec.version).toBeGreaterThanOrEqual(0)
    expect(spec.version).toBe(BINDING_DOMAIN_VERSION)
    expect(Object.keys(spec.tables)).toContain(BINDING_TABLE_NAME)
  })

  it('表名也须过 UNIT_NAME_RE', () => {
    expect(UNIT_NAME_RE.test(BINDING_TABLE_NAME)).toBe(true)
  })
})

describe.skipIf(!domainPath)('host/storage-domain: 手写规格必须被**真实 defineDomain** 接受', () => {
  it('本机必须能解析到真实 dsh-storage-domain（否则上面两条失去保护力）', () => {
    // CI runner 未安装宿主包（peer-only）→ 允许跳过；本机（开发/发布机）必须能解析。
    if (process.env.CI) return
    expect(domainPath, '需 dsh-storage-domain（peer 依赖，本机应可解析）').toBeTruthy()
  })

  it('真实 defineDomain 不抛错（手写纯数据规格的合法性）', async () => {
    const mod = (await import(domainPath!)) as { defineDomain: (spec: unknown) => unknown }
    expect(() => mod.defineDomain(bindingDomainSpec())).not.toThrow()
  })

  it('真实 descriptorOf 能把规格投影成后端可用的 unit 描述符', async () => {
    const mod = (await import(domainPath!)) as {
      defineDomain: (spec: unknown) => unknown
      descriptorOf: (spec: unknown) => { name: string; version: number; tables: readonly string[] }
    }
    const desc = mod.descriptorOf(mod.defineDomain(bindingDomainSpec()))
    expect(desc.name).toBe(BINDING_DOMAIN_NAME)
    expect(desc.version).toBe(BINDING_DOMAIN_VERSION)
    expect([...desc.tables]).toEqual([BINDING_TABLE_NAME])
  })
})

describe('host/storage-domain: openBindingDomain 降级（永不抛错）', () => {
  it('服务缺失 → null', async () => {
    expect(await openBindingDomain({})).toBeNull()
    expect(await openBindingDomain({ get: () => undefined })).toBeNull()
    expect(await openBindingDomain(undefined)).toBeNull()
  })

  it('服务形状不对（无 open 函数）→ null', async () => {
    expect(await openBindingDomain({ get: () => ({}) })).toBeNull()
    expect(await openBindingDomain({ get: () => ({ open: 42 }) })).toBeNull()
  })

  it('open 抛错（后端缺失/规格被拒）→ null 且不抛', async () => {
    const ctx = {
      get: () => ({
        open: async () => {
          throw new Error("storage backend 'json' is not registered")
        },
      }),
    }
    await expect(openBindingDomain(ctx)).resolves.toBeNull()
  })

  it('open 返回的形状不对（无 table）→ null', async () => {
    expect(await openBindingDomain({ get: () => ({ open: async () => ({}) }) })).toBeNull()
  })

  it('happy path：open + table 可用 → 返回域句柄', async () => {
    const d = fakeDomain()
    const ctx = { get: () => ({ open: async () => d }) }
    const domain = await openBindingDomain(ctx)
    expect(domain).not.toBeNull()
    expect(typeof domain?.table).toBe('function')
  })

  it('getter 抛错 → 吞掉返回 null（访问层不是单点）', async () => {
    const ctx = {
      get: () => {
        throw new Error('boom')
      },
    }
    await expect(openBindingDomain(ctx)).resolves.toBeNull()
  })
})

describe('host/storage-domain: BindingStore 读同步 / 写异步 / 降级', () => {
  it('🔴 null 句柄 → available=false，读全空、写全 false（降级路径的机械保证）', async () => {
    const s = bindingStore(null)
    expect(s.available).toBe(false)
    expect(s.get('x')).toBeUndefined()
    expect(s.entries()).toEqual([])
    expect(await s.put('x', { dirName: 'd', mdPath: '/d/SESSION.md', action: 'activate', at: 1 })).toBe(false)
    expect(await s.delete('x')).toBe(false)
  })

  it('域可用：get/entries 是**同步**的（§0L 向前兼容的技术前提）', () => {
    const s = bindingStore(fakeDomain({
      'sess-1': { dirName: '2026-08-24--S142--a', mdPath: '/r/A/SESSION.md', action: 'activate', at: 1 },
    }) as never)
    expect(s.available).toBe(true)
    // 同步调用：不 await 也能拿到值（若退化成异步，这两行会是 Promise ⇒ 断言失败）
    expect(s.get('sess-1')?.dirName).toBe('2026-08-24--S142--a')
    expect(Array.isArray(s.entries())).toBe(true)
    expect(s.entries().length).toBe(1)
  })

  it('域可用：put 落盘（写是异步的）', async () => {
    const d = fakeDomain()
    const s = bindingStore(d as never)
    const ok = await s.put('sess-9', { dirName: 'D', mdPath: '/D/SESSION.md', action: 'use', at: 2 })
    expect(ok).toBe(true)
    expect(d.writeLog.length).toBe(1)
    expect(d.writeLog[0]![0]).toBe('sess-9')
  })

  it('读侧形状容忍：缺 dirName 的记录被丢弃（手改/旧数据不炸）', () => {
    const s = bindingStore(fakeDomain({
      good: { dirName: 'D', mdPath: '/D/SESSION.md', action: 'activate', at: 1 },
      bad: { action: 'activate' },
      alsoBad: null,
    }) as never)
    expect(s.get('good')?.dirName).toBe('D')
    expect(s.get('bad')).toBeUndefined()
    expect(s.entries().map(([k]) => k)).toEqual(['good'])
  })

  it('put 落盘失败 → false 且不抛（尽力而为口径，与旧 appendBound 一致）', async () => {
    const s = bindingStore({
      table: () => ({
        get: () => undefined,
        entries: () => [][Symbol.iterator](),
        size: 0,
        put: async () => {
          throw new Error('disk full')
        },
        delete: async () => true,
      }),
    } as never)
    await expect(s.put('x', { dirName: 'd', mdPath: '/d/SESSION.md', action: 'a', at: 1 })).resolves.toBe(false)
  })

  it('table() 抛错 → 读空/写 false（不抛）', async () => {
    const s = bindingStore({
      table: () => {
        throw new Error('closed')
      },
    } as never)
    expect(s.get('x')).toBeUndefined()
    expect(s.entries()).toEqual([])
    await expect(s.put('x', { dirName: 'd', mdPath: '/m', action: 'a', at: 1 })).resolves.toBe(false)
  })
})
