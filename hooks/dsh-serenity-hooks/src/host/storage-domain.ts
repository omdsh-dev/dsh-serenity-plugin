/**
 * host/storage-domain.ts — 宿主存储域上的「会话 ↔ 轨迹」绑定表（§0L，S142 2026-09-19）
 *
 * 为什么存在（R↓）：绑定的载体原本是 CCC 内的 `AGENT_SESSIONS/.bindings.json`。
 * owner 裁定（「放 CCC 不合适」）⇒ 改存**宿主自己的存储域**
 * （`~/.dsh/storages/`，与宿主 `workspace.json` 同处、同类结构、同一套校验）。
 *
 * 能力与边界：
 *  - `openBindingDomain(ctx)`：从插件 ctx 取 `storageDomain`（**经 `hostService` = `ctx.get`**，
 *    **不是**属性直读——dsp 的 `inject` 不含它，属性直读在真实 cordis 下抛
 *    `cannot get property "storageDomain" without inject`，同 v1.31.4 的 subagents 陷阱）；
 *    开域成功返回句柄，任何环节失败返回 `null`（**本模块永不抛错**：宿主对插件 apply 抛错
 *    = 整个 dsh 启动失败，见 `host/access.ts` 的同类契约）。
 *  - 句柄的**读是同步的**（`get` / `entries` / `keys` / `size` 走内存），**写才是异步的**
 *    （`put` / `delete` 等落盘后 resolve）——**这是 §0L 能"向前兼容"的技术前提**：
 *    既有 10 个调用点全是同步签名，故调用方拿到句柄后读法完全不变。
 *
 * 域名约束（实测，`tests/host/storage-domain.test.ts` 钉住）：
 *   `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/` ⇒ **`serenity_bindings`（下划线）**；
 *   连字符形如 `serenity-bindings` **非法**（会在 `defineDomain` 模块加载期抛错）。
 *
 * 记录形状：与旧 `.bindings.json` **同名字段**（`dirName` / `mdPath` / `sessionId` / `action`
 * / `at` / `note` / `supersededAt`）——同形可显著降低迁移风险，也让"双读兜底"易于对账。
 * 硬锚仍是 **`dirName`**（完整目录名，U4：绝不解析编号前缀）。
 */

import { hostService } from './access.js'

/** 域名称（下划线；连字符非法——见文件头） */
export const BINDING_DOMAIN_NAME = 'serenity_bindings'

/** 表名 */
export const BINDING_TABLE_NAME = 'bindings'

/** 域格式版本（`DomainSpec.version`；非负整数） */
export const BINDING_DOMAIN_VERSION = 1

/**
 * 一条绑定记录。字段与旧 `.bindings.json` 的 `SessionBoundRecord` **同名同义**
 * （刻意不重命名：迁移对账不需要映射表，降低出错面）。
 */
export interface BindingRecord {
  /** 🔴 硬锚：完整 `AGENT_SESSIONS` 目录名（不解析编号格式，U4） */
  dirName: string
  /** `SESSION.md` 绝对路径（展示/定位用；**不作锚**——绝对路径绑死机器） */
  mdPath: string
  /** 展示码（`S###` 或任意 CCC 自定义格式；**仅展示**，绝不用于识别） */
  sessionId?: string
  action: string
  at: number
  note?: string
  /** 已被取代（D69：同轨迹多会话只留一条；记录保留、退出"当前"） */
  supersededAt?: number
}

/** 域内的表句柄（宿主 `KvTable` 的**结构子集**——只取本模块用到的成员，便于替身注入） */
export interface BindingTableLike {
  /** 同步读一条（内存） */
  get(key: string): BindingRecord | undefined
  /** 同步快照遍历 */
  entries(): IterableIterator<[string, BindingRecord]>
  /** 当前条数 */
  readonly size: number
  /** 异步落盘写一条 */
  put(key: string, value: BindingRecord): Promise<void>
  /** 异步落盘删一条 */
  delete(key: string): Promise<boolean>
}

/** 域句柄（宿主 `Domain` 的结构子集） */
export interface BindingDomainLike {
  /** 取表句柄（重复调用返回同一实例） */
  table(name: string): BindingTableLike
}

/** `storageDomain` 设施的结构子集（宿主 `DomainFacility`） */
export interface DomainFacilityLike {
  open(spec: unknown): Promise<BindingDomainLike>
}

/**
 * 极简 zod 形状校验（**不引 zod 依赖**）：宿主在"落盘读回边界"用域规格里的 schema 校验，
 * 我们只需提供一个满足其接口的最小实现（`parse` + `safeParse`）。
 * 本模块的做法是**恒等放行**——真正的形状把关在 `asBindingRecord`（读侧容忍旧数据）。
 */
interface MinimalSchema {
  parse: (v: unknown) => unknown
  safeParse: (v: unknown) => { success: boolean; data?: unknown }
}

const passthroughSchema: MinimalSchema = {
  parse: (v: unknown) => v,
  safeParse: (v: unknown) => ({ success: true, data: v }),
}

/**
 * 构造域规格（宿主 `defineDomain` 的入参形状）。
 *
 * 为什么不引 `@deepseek-ai/dsh-storage-domain` 的 `defineDomain`：
 * 它是**宿主 peer 依赖**（本仓 peer-only 打包，不装它）⇒ 直接 import 会让插件在
 * 未装该包的运行时**模块加载即失败**。域规格是**纯数据**，手写等价对象即可
 * （`tests/host/storage-domain.test.ts` 用真实 `defineDomain` 验证本对象被接受）。
 */
export function bindingDomainSpec(): unknown {
  return {
    name: BINDING_DOMAIN_NAME,
    version: BINDING_DOMAIN_VERSION,
    tables: {
      [BINDING_TABLE_NAME]: { valueSchema: passthroughSchema },
    },
  }
}

/** 读侧形状容忍（手改 / 旧数据 / 未来字段）：只要求 `dirName` 是字符串 */
function asBindingRecord(value: unknown): BindingRecord | null {
  const r = value as BindingRecord | null | undefined
  if (!r || typeof r !== 'object' || typeof r.dirName !== 'string') return null
  return r
}

/**
 * 从插件 ctx 打开绑定域。**永不抛错**；不可用一律返回 `null`（调用方决定降级）。
 *
 * 失败面（全部返回 `null`，调用方回落旧 `.bindings.json`）：
 *  - 宿主未提供 `storageDomain`（未装载 storage-domain 插件 / 老宿主）；
 *  - `open` 抛错（域名非法 / 后端缺失 `backend-not-found` / 版本不符 / 记录损坏）；
 *  - 拿到的服务形状不对（无 `open` 函数）。
 *
 * @param ctx 插件上下文（真实 cordis Context；测试可传结构化替身）
 * @returns 域句柄，或 `null`
 */
export async function openBindingDomain(ctx: unknown): Promise<BindingDomainLike | null> {
  const facility = hostService<DomainFacilityLike>(ctx, 'storageDomain')
  if (!facility || typeof facility.open !== 'function') return null
  try {
    const domain = await facility.open(bindingDomainSpec())
    if (!domain || typeof domain.table !== 'function') return null
    const table = domain.table(BINDING_TABLE_NAME)
    if (!table || typeof table.get !== 'function') return null
    return domain
  } catch {
    /* 域不可用（宿主未装载 / 后端缺失 / 规格被拒）⇒ 静默降级到旧表 */
    return null
  }
}

/**
 * 绑定表的**同步读**封装（句柄缺失时全部返回空，语义 = "域里没有"）。
 *
 * 为什么单独包一层（而不是让调用方直接拿 table）：
 *  ① 句柄可能为 `null`（域不可用）⇒ 让 `null` 检查集中在一处；
 *  ② 读侧要统一做形状容忍（`asBindingRecord`）。
 */
export class BindingStore {
  constructor(private readonly domain: BindingDomainLike | null) {}

  /** 域是否可用（`false` ⇒ 调用方应回落旧文件） */
  get available(): boolean {
    return this.domain !== null
  }

  private table(): BindingTableLike | null {
    if (!this.domain) return null
    try {
      return this.domain.table(BINDING_TABLE_NAME)
    } catch {
      return null
    }
  }

  /** 同步读一条（域不可用 → `undefined`） */
  get(sessionId: string): BindingRecord | undefined {
    try {
      const rec = this.table()?.get(sessionId)
      return rec ? asBindingRecord(rec) ?? undefined : undefined
    } catch {
      return undefined
    }
  }

  /** 同步遍历全部 `[会话id, 记录]`（域不可用 → 空） */
  entries(): Array<[string, BindingRecord]> {
    const out: Array<[string, BindingRecord]> = []
    try {
      const t = this.table()
      if (!t) return out
      for (const [k, v] of t.entries()) {
        const rec = asBindingRecord(v)
        if (rec) out.push([k, rec])
      }
    } catch {
      /* 遍历失败视为空（不抛） */
    }
    return out
  }

  /** 异步写一条（域不可用 / 落盘失败 → `false`；**不抛**） */
  async put(sessionId: string, rec: BindingRecord): Promise<boolean> {
    try {
      const t = this.table()
      if (!t) return false
      await t.put(sessionId, rec)
      return true
    } catch {
      return false
    }
  }

  /** 异步删一条（域不可用 / 失败 → `false`；**不抛**） */
  async delete(sessionId: string): Promise<boolean> {
    try {
      const t = this.table()
      if (!t) return false
      return await t.delete(sessionId)
    } catch {
      return false
    }
  }
}

/** 由域句柄造 store（`null` 句柄 → 不可用 store，读全空、写全 false） */
export function bindingStore(domain: BindingDomainLike | null): BindingStore {
  return new BindingStore(domain)
}
