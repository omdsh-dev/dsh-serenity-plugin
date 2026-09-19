/**
 * trajectory-bound.test.ts — SESSION 绑定持久化模块
 *
 * v1.30.6（S142 review F-01）：绑定从「dsh 会话日志事件」迁移为「CCC 内
 * `AGENT_SESSIONS/.bindings.json` 文件」——宿主读路径拒绝未知且非 ignorable 的
 * 会话事件（`Session.append` 无法写 `ignorable`），故不再向会话日志写自定义事件。
 * 覆盖：文件写入/读取（latest-wins）/ 编码无关（dirName 锚）/ 旧事件形态回落 /
 * 无 header 不阻断 / 损坏文件容忍 / 无临时文件残留。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { appendBound, readLastBound, hasAnyBound, bindingsPathFor, BINDINGS_REL_PATH, listBoundSessionIds, pruneMissingBindings, resolveSessionTrajectoryLabel, supersedeOtherBindings, setBindingStore, migrateBindingsToDomain } from '../src/trajectory-bound.js'
import { bindingStore } from '../src/host/storage-domain.js'
import { resetActiveSessionStore, setActiveSessionInfo } from '../src/trajectory-ops.js'

let ccc: string

beforeEach(() => {
  ccc = mkdtempSync(join(tmpdir(), 'bound-'))
  writeFileSync(join(ccc, '.serenity'), '')
  mkdirSync(join(ccc, 'AGENT_SESSIONS'), { recursive: true })
  resetActiveSessionStore() // 内存激活表按用例隔离（进程级单例，否则跨用例串味）
  setBindingStore(null) // §0L：域句柄是模块级单例 ⇒ 每例复位，避免跨用例串味
})

afterEach(() => {
  rmSync(ccc, { recursive: true, force: true })
  setBindingStore(null)
})

/** 最小可测 dsh 会话：header（id + cwd 定位 CCC）+ snapshotEvents（旧事件回落用） */
function makeSession(id = 'sess-1', events: unknown[] = [], cwd = ccc) {
  return { header: { id, cwd }, snapshotEvents: () => events }
}

describe('trajectory-bound: appendBound（文件持久化）', () => {
  it('写入 AGENT_SESSIONS/.bindings.json（含 dirName/mdPath/sessionId/action/at）', () => {
    const s = makeSession()
    const ok = appendBound(s, 'activate', {
      dirName: '2026-09-05--S142--dsp 维护',
      mdPath: '/root/AGENT_SESSIONS/2026-09-05--S142--dsp 维护/SESSION.md',
      sessionId: 'S142',
    })
    expect(ok).toBe(true)
    const file = JSON.parse(readFileSync(join(ccc, BINDINGS_REL_PATH), 'utf-8')) as {
      version: number; sessions: Record<string, { dirName: string; action: string; at: number }>
    }
    expect(file.version).toBe(1)
    const rec = file.sessions['sess-1']
    expect(rec?.dirName).toBe('2026-09-05--S142--dsp 维护')
    expect(rec?.action).toBe('activate')
    expect(typeof rec?.at).toBe('number')
    // 原子写：无 .tmp 残留
    expect(existsSync(`${join(ccc, BINDINGS_REL_PATH)}.tmp`)).toBe(false)
  })

  it('无 header / 无法定位 CCC 根 → false 不抛错（绑定失败不阻断主流程）', () => {
    expect(appendBound(null, 'activate', { dirName: 'x', mdPath: '/x/SESSION.md' })).toBe(false)
    expect(appendBound({}, 'activate', { dirName: 'x', mdPath: '/x/SESSION.md' })).toBe(false)
    const outside = { header: { id: 's', cwd: tmpdir() } } // 无 .serenity
    expect(appendBound(outside, 'activate', { dirName: 'x', mdPath: '/x/SESSION.md' })).toBe(false)
  })

  it('同一会话多次写入 → latest-wins 覆盖（不追加）', () => {
    const s = makeSession()
    appendBound(s, 'activate', { dirName: '2026-08-01--S100--a', mdPath: '/r/A/SESSION.md', sessionId: 'S100' })
    appendBound(s, 'switch', { dirName: '2026-08-24--S142--b', mdPath: '/r/B/SESSION.md', sessionId: 'S142' })
    const file = JSON.parse(readFileSync(join(ccc, BINDINGS_REL_PATH), 'utf-8')) as {
      sessions: Record<string, unknown>
    }
    expect(Object.keys(file.sessions)).toEqual(['sess-1']) // 单条记录
    expect(readLastBound(s)?.dirName).toBe('2026-08-24--S142--b')
  })

  it('不同会话各自独立记录（scope 隔离）', () => {
    const a = makeSession('sess-a')
    const b = makeSession('sess-b')
    appendBound(a, 'activate', { dirName: '2026-09-07--S160--zhaocai skiff', mdPath: '/r/A/SESSION.md' })
    appendBound(b, 'activate', { dirName: '2026-09-05--S142--dsp', mdPath: '/r/B/SESSION.md' })
    expect(readLastBound(a)?.dirName).toBe('2026-09-07--S160--zhaocai skiff')
    expect(readLastBound(b)?.dirName).toBe('2026-09-05--S142--dsp')
  })
})

describe('trajectory-bound: readLastBound / hasAnyBound', () => {
  it('无记录 → null', () => {
    expect(readLastBound(makeSession())).toBeNull()
    expect(hasAnyBound(makeSession())).toBe(false)
  })

  it('写入后 hasAnyBound → true', () => {
    const s = makeSession()
    appendBound(s, 'reconcile', { dirName: 'd', mdPath: '/r/SESSION.md', note: 'auto from title' })
    expect(hasAnyBound(s)).toBe(true)
  })

  it('文件损坏 → 视为空，不抛错（下次写入重建）', () => {
    const s = makeSession()
    writeFileSync(join(ccc, BINDINGS_REL_PATH), '{ not json')
    expect(readLastBound(s)).toBeNull()
    expect(appendBound(s, 'activate', { dirName: 'd', mdPath: '/r/SESSION.md' })).toBe(true)
    expect(readLastBound(s)?.dirName).toBe('d')
  })

  it('记录缺 dirName/mdPath → 跳过（宽容），回落旧事件形态', () => {
    const s = makeSession('sess-1', [
      { type: 'serenity/bound', data: { dirName: '2026-09-05--apaas-26116', mdPath: '/r/D/SESSION.md', action: 'activate', at: 2 } },
    ])
    writeFileSync(join(ccc, BINDINGS_REL_PATH), JSON.stringify({ version: 1, sessions: { 'sess-1': { action: 'activate' } } }))
    expect(readLastBound(s)?.dirName).toBe('2026-09-05--apaas-26116')
  })
})

describe('trajectory-bound: 旧事件形态回落（v1.29.1~v1.30.5 存量绑定）', () => {
  it('文件中无记录 → 回落扫描会话日志中的 serenity/bound（最后一条胜出）', () => {
    const events = [
      { type: 'user/message', data: { content: [] } },
      { type: 'serenity/bound', data: { dirName: '2026-09-01--S151--auto--auto', mdPath: '/r/C/SESSION.md', action: 'activate', at: 1 } },
      { type: 'serenity/bound', data: { dirName: '2026-09-05--S142--dsp', mdPath: '/r/E/SESSION.md', action: 'reconcile', at: 2 } },
    ]
    expect(readLastBound(makeSession('sess-1', events))?.dirName).toBe('2026-09-05--S142--dsp')
  })

  it('旧形态坏数据跳过；文件记录优先于事件', () => {
    const events = [
      { type: 'serenity/bound', data: 'garbage' },
      { type: 'serenity/bound', data: { dirName: 'legacy', mdPath: '/r/L/SESSION.md', action: 'activate', at: 3 } },
    ]
    const s = makeSession('sess-1', events)
    expect(readLastBound(s)?.dirName).toBe('legacy')
    appendBound(s, 'activate', { dirName: 'file-wins', mdPath: '/r/F/SESSION.md' })
    expect(readLastBound(s)?.dirName).toBe('file-wins')
  })
})

describe('trajectory-bound: 编码无关（U4）', () => {
  it('issue 会话（无 S 前缀）同样可绑定——dirName 是唯一硬锚', () => {
    const s = makeSession()
    const ok = appendBound(s, 'activate', {
      dirName: '2026-09-04--apaas-26116',
      mdPath: '/root/AGENT_SESSIONS/2026-09-04--apaas-26116/SESSION.md',
    })
    expect(ok).toBe(true)
    const b = readLastBound(s)
    expect(b?.dirName).toBe('2026-09-04--apaas-26116')
    expect(b?.sessionId).toBeUndefined()
  })

  it('autopilot 变体（--auto 尾缀）目录同样可绑定', () => {
    const s = makeSession()
    appendBound(s, 'activate', {
      dirName: '2026-09-01--S151--autopilot-daily-housekeeping--auto',
      mdPath: '/root/AGENT_SESSIONS/2026-09-01--S151--autopilot-daily-housekeeping--auto/SESSION.md',
      sessionId: 'S151',
    })
    expect(readLastBound(s)?.dirName).toBe('2026-09-01--S151--autopilot-daily-housekeeping--auto')
  })

  it('bindingsPathFor：由 cwd 上溯 .serenity 定位（子目录 cwd 同样正确）', () => {
    const sub = join(ccc, 'AI_LAB', 'dsh-serenity-plugin')
    mkdirSync(sub, { recursive: true })
    expect(bindingsPathFor({ header: { id: 's', cwd: sub } })).toBe(join(ccc, BINDINGS_REL_PATH))
  })
})

describe('trajectory-bound: resolveSessionTrajectoryLabel（createdBy 审计归属）', () => {
  /**
   * 回归（S142 §30.12.1 实测缺陷）：唤醒注册表的 createdBy 曾直接取**全局** lastActive 指针，
   * 而它记录的是"进程内最近一次被激活的 trajectory"——多会话并发时张冠李戴
   * （实测：S142 登记唤醒被写成 `by=S060`）。本组用例把"以调用方自己为准"钉死。
   */
  it('① 持久 bound 命中 → 取该会话自己的标签（不看全局指针）', () => {
    const caller = makeSession('sess-caller')
    appendBound(caller, 'activate', {
      dirName: '2026-08-24--S142--dsp 维护',
      mdPath: '/r/A/SESSION.md',
      sessionId: 'S142',
    })
    // 全局指针被**别的**会话污染（模拟 S060 刚激活）
    setActiveSessionInfo('sess-other', { sessionId: 'S060', dirName: '2026-01-01--S060--x', mdPath: '/r/B/SESSION.md' })
    expect(resolveSessionTrajectoryLabel(caller, 'sess-caller')).toBe('S142')
  })

  it('② 无 bound 但本 scope 有内存激活 → 取本 scope（不看全局指针）', () => {
    const caller = makeSession('sess-caller')
    setActiveSessionInfo('sess-caller', { sessionId: 'S142', dirName: '2026-08-24--S142--dsp', mdPath: '/r/A/SESSION.md' })
    setActiveSessionInfo('sess-other', { sessionId: 'S060', dirName: '2026-01-01--S060--x', mdPath: '/r/B/SESSION.md' })
    expect(resolveSessionTrajectoryLabel(caller, 'sess-caller')).toBe('S142')
  })

  it('③ 两级皆空 → 回退全局最近活跃（无绑定会话的兼容）', () => {
    const caller = makeSession('sess-caller')
    setActiveSessionInfo('sess-other', { sessionId: 'S060', dirName: '2026-01-01--S060--x', mdPath: '/r/B/SESSION.md' })
    expect(resolveSessionTrajectoryLabel(caller, 'sess-caller')).toBe('S060')
  })

  it('④ 三级全落空 → 空串（渲染为 `?`，不抛错）', () => {
    expect(resolveSessionTrajectoryLabel(makeSession('sess-caller'), 'sess-caller')).toBe('')
    expect(resolveSessionTrajectoryLabel(null, '')).toBe('')
    expect(resolveSessionTrajectoryLabel({}, '')).toBe('')
  })

  it('⑤ 编码无关（U4）：目录名无 --S###-- → 原样返回目录名', () => {
    const caller = makeSession('sess-caller')
    appendBound(caller, 'activate', { dirName: '2026-09-04--apaas-26116', mdPath: '/r/C/SESSION.md' })
    expect(resolveSessionTrajectoryLabel(caller, 'sess-caller')).toBe('2026-09-04--apaas-26116')
  })
})

/**
 * S142 §0y (b)/(c)（所有者 2026-09-18 裁「不上 a、做 b + c」）
 *
 * 实证背景：`.bindings.json` 只增不清——真实盘上 S142 名下挂 **4 代**、S185 挂 **2 代**，
 * 而唤醒选人是"遍历全部绑定 id、任一条 live 就用它" ⇒ **两条 live 会话都能被唤醒选中**
 * （各持一份完整上下文 = 内存翻倍，且都在写同一批文件 = 双写者）。
 */
describe('trajectory-bound: (b) 多 live 会话守卫 + (c) 悬空绑定清理', () => {
  const DIR = '2026-08-24--S142--dsp 维护'
  const MD = '/r/AGENT_SESSIONS/2026-08-24--S142--dsp 维护/SESSION.md'

  /** 直接写绑定文件（绕过 appendBound 的 cwd 定位，便于构造多会话场景） */
  function seed(records: Record<string, { dirName: string; at: number }>): void {
    const sessions: Record<string, unknown> = {}
    for (const [id, r] of Object.entries(records)) {
      sessions[id] = { dirName: r.dirName, mdPath: MD, action: 'rebuild', at: r.at }
    }
    writeFileSync(join(ccc, BINDINGS_REL_PATH), JSON.stringify({ version: 1, sessions }, null, 2))
  }

  function readSessions(): Record<string, { dirName: string; supersededAt?: number }> {
    return (JSON.parse(readFileSync(join(ccc, BINDINGS_REL_PATH), 'utf-8')) as {
      sessions: Record<string, { dirName: string; supersededAt?: number }>
    }).sessions
  }

  it('listBoundSessionIds：按 at 倒序（最新在前）返回该轨迹的全部绑定', () => {
    seed({ a: { dirName: DIR, at: 100 }, b: { dirName: DIR, at: 300 }, c: { dirName: DIR, at: 200 } })
    expect(listBoundSessionIds(ccc, DIR)).toEqual(['b', 'c', 'a'])
  })

  it('listBoundSessionIds：**不返回**已被取代的绑定（(b) 守卫的核心判据）', () => {
    seed({ a: { dirName: DIR, at: 100 }, b: { dirName: DIR, at: 300 } })
    const marked = supersedeOtherBindings(ccc, DIR, new Set(['b']))
    expect(marked).toEqual(['a'])
    expect(listBoundSessionIds(ccc, DIR)).toEqual(['b']) // a 不再进入唤醒候选
  })

  it('supersedeOtherBindings：**保留记录**（沿革不丢，仅退出候选）', () => {
    seed({ a: { dirName: DIR, at: 100 }, b: { dirName: DIR, at: 300 } })
    supersedeOtherBindings(ccc, DIR, new Set(['b']))
    const sessions = readSessions()
    expect(sessions.a?.dirName).toBe(DIR) // 记录仍在
    expect(typeof sessions.a?.supersededAt).toBe('number')
    expect(sessions.b?.supersededAt).toBeUndefined() // keepIds 不动
  })

  it('supersedeOtherBindings：幂等（第二次无新标记 → 空数组）', () => {
    seed({ a: { dirName: DIR, at: 100 }, b: { dirName: DIR, at: 300 } })
    expect(supersedeOtherBindings(ccc, DIR, new Set(['b']))).toEqual(['a'])
    expect(supersedeOtherBindings(ccc, DIR, new Set(['b']))).toEqual([])
  })

  it('supersedeOtherBindings：**不碰别的轨迹**的绑定', () => {
    seed({ a: { dirName: DIR, at: 100 }, b: { dirName: DIR, at: 300 }, x: { dirName: '2026-09-13--S185--别的', at: 50 } })
    supersedeOtherBindings(ccc, DIR, new Set(['b']))
    expect(readSessions().x?.supersededAt).toBeUndefined()
  })

  it('pruneMissingBindings：只删判据**确认缺失**的条目，返回升序 id', () => {
    seed({ a: { dirName: DIR, at: 1 }, b: { dirName: DIR, at: 2 }, c: { dirName: DIR, at: 3 } })
    const removed = pruneMissingBindings(ccc, (id) => id === 'c' || id === 'a')
    expect(removed).toEqual(['a', 'c'])
    expect(Object.keys(readSessions())).toEqual(['b'])
  })

  it('pruneMissingBindings：判据抛错 → **保留**该条（fail-closed，宁可不删）', () => {
    seed({ a: { dirName: DIR, at: 1 }, b: { dirName: DIR, at: 2 } })
    const removed = pruneMissingBindings(ccc, (id) => {
      if (id === 'a') throw new Error('判据自身炸了')
      return true
    })
    expect(removed).toEqual(['b'])
    expect(Object.keys(readSessions())).toEqual(['a'])
  })

  it('pruneMissingBindings：无可删 → 空数组且**不改写文件**', () => {
    seed({ a: { dirName: DIR, at: 1 } })
    const before = readFileSync(join(ccc, BINDINGS_REL_PATH), 'utf-8')
    expect(pruneMissingBindings(ccc, () => false)).toEqual([])
    expect(readFileSync(join(ccc, BINDINGS_REL_PATH), 'utf-8')).toBe(before)
  })

  /**
   * 接线钉（同 `client-popover-clip-guard.test.ts` 的形态）：
   * 上面两个函数**本身对**不等于**被接上了**——机制死在"实现了但没人调用"是最常见的静默失效。
   * 这里钉住 `container_trajectory use` 这条真实路径确实调用它们，并确实把结果报出去。
   */
  it('🔴 接线钉：`use` 路径确实调用 supersedeOtherBindings + pruneMissingBindings 并回报结果', () => {
    const src = readFileSync(new URL('../src/tools/trajectory.ts', import.meta.url), 'utf-8')
    const useCase = src.slice(src.indexOf("case 'use':"), src.indexOf("case 'rebuild':", src.indexOf("case 'use':")))
    expect(useCase).toContain('supersedeOtherBindings(')
    expect(useCase).toContain('pruneMissingBindings(')
    expect(useCase).toContain('hasSessionLogById(') // (c) 判据必须 fail-closed 的那个函数
    expect(useCase).toContain("out.supersededBindings = ") // 结果要报出去（否则用户不知道发生了什么）
    expect(useCase).toContain("out.prunedBindings = ")
  })
})

/**
 * §0L（S142 2026-09-19）：宿主存储域作为**权威载体**，旧文件作**兜底**。
 *
 * 这组用例钉住 owner 的硬约束「**向前兼容**」：
 *  · 域可用 ⇒ 域优先（新载体生效，owner 要的"放对地方"）；
 *  · 域不可用 ⇒ **行为与升级前完全一致**（零回归——上面 27 条既有用例即此证明）；
 *  · 迁移期 ⇒ 域里没有的条目仍能从旧文件读到（不丢绑定）。
 *
 * 域用**替身**注入（`bindingStore(fakeDomain)`）——真实域的行为已由
 * `tests/host/storage-domain-module.test.ts` 与 `tests/host/storage-domain.test.ts` 钉住。
 */
describe('trajectory-bound: §0L 域优先 / 文件兜底 / 双写', () => {
  const DIR = '2026-09-05--S142--dsp'

  /** 造一个可读写的假域（形状 = BindingStore 期望的 DomainLike 结构子集） */
  function fakeDomain(initial: Record<string, unknown> = {}) {
    const records: Record<string, unknown> = { ...initial }
    return {
      records,
      domain: {
        table: () => ({
          get: (k: string) => records[k],
          entries: () => Object.entries(records)[Symbol.iterator](),
          size: Object.keys(records).length,
          put: async (k: string, v: unknown) => { records[k] = v },
          delete: async (k: string) => delete records[k],
        }),
      },
    }
  }

  it('🔴 域可用 ⇒ **域优先**（域与文件冲突时以域为准）', () => {
    const s = makeSession('sess-1')
    appendBound(s, 'activate', { dirName: 'file-wins-before-0L', mdPath: '/r/F/SESSION.md' })
    const { domain } = fakeDomain({
      'sess-1': { dirName: DIR, mdPath: '/r/D/SESSION.md', action: 'activate', at: 9 },
    })
    setBindingStore(bindingStore(domain as never))
    expect(readLastBound(s)?.dirName).toBe(DIR) // 域覆盖了文件里的旧值
  })

  it('🔴 域不可用 ⇒ 回落旧文件（**零回归**：与升级前逐字一致）', () => {
    const s = makeSession('sess-1')
    appendBound(s, 'activate', { dirName: DIR, mdPath: '/r/F/SESSION.md' })
    setBindingStore(null)
    expect(readLastBound(s)?.dirName).toBe(DIR)
  })

  it('🔴 迁移期：域里没有该会话 ⇒ 仍从旧文件兜底读到（不丢绑定）', () => {
    const s = makeSession('sess-legacy')
    appendBound(s, 'activate', { dirName: DIR, mdPath: '/r/L/SESSION.md' })
    const { domain } = fakeDomain({}) // 空域 = 尚未迁移
    setBindingStore(bindingStore(domain as never))
    expect(readLastBound(s)?.dirName).toBe(DIR)
  })

  it('🔴 双写：appendBound 同时写域与旧文件（迁移期两道保险）', async () => {
    const { domain, records } = fakeDomain({})
    setBindingStore(bindingStore(domain as never))
    const s = makeSession('sess-w')
    appendBound(s, 'activate', { dirName: DIR, mdPath: '/r/W/SESSION.md' })

    // 旧文件已同步写入
    const file = JSON.parse(readFileSync(join(ccc, BINDINGS_REL_PATH), 'utf-8')) as {
      sessions: Record<string, { dirName?: string }>
    }
    expect(file.sessions['sess-w']?.dirName).toBe(DIR)

    // 域写是异步 fire-and-forget ⇒ 让微任务队列跑完再断言
    await Promise.resolve()
    expect((records['sess-w'] as { dirName?: string })?.dirName).toBe(DIR)
  })

  it('listBoundSessionIds：域优先，且排除 superseded（与文件侧同判据）', () => {
    const s1 = makeSession('d1')
    const s2 = makeSession('d2')
    appendBound(s1, 'activate', { dirName: DIR, mdPath: '/r/1/SESSION.md' })
    appendBound(s2, 'activate', { dirName: DIR, mdPath: '/r/2/SESSION.md' })
    const { domain } = fakeDomain({
      d1: { dirName: DIR, mdPath: '/r/1/SESSION.md', action: 'activate', at: 10 },
      d2: { dirName: DIR, mdPath: '/r/2/SESSION.md', action: 'activate', at: 20, supersededAt: 99 },
    })
    setBindingStore(bindingStore(domain as never))
    expect(listBoundSessionIds(ccc, DIR)).toEqual(['d1']) // d2 已被取代 ⇒ 退出候选
  })

  it('supersedeOtherBindings：域可用时**域侧也标记**（不只改文件）', async () => {
    const { domain, records } = fakeDomain({
      keep: { dirName: DIR, mdPath: '/r/K/SESSION.md', action: 'activate', at: 1 },
      other: { dirName: DIR, mdPath: '/r/O/SESSION.md', action: 'activate', at: 2 },
      alien: { dirName: '2026-01-01--S001--x', mdPath: '/r/X/SESSION.md', action: 'activate', at: 3 },
    })
    setBindingStore(bindingStore(domain as never))
    supersedeOtherBindings(ccc, DIR, new Set(['keep']))
    await Promise.resolve()
    expect((records.other as { supersededAt?: number }).supersededAt).toBeTypeOf('number')
    expect((records.keep as { supersededAt?: number }).supersededAt).toBeUndefined()
    expect((records.alien as { supersededAt?: number }).supersededAt).toBeUndefined() // 不碰别的轨迹
  })
})

/**
 * §0L **一次性迁移**（N-3）：旧 `.bindings.json` → 宿主存储域。
 *
 * 🔴 这是**唯一会碰历史数据**的一步 ⇒ 判据必须最严：
 *  ① **不丢绑定**（逐条灌入，实测 15 条的量级）；
 *  ② **幂等**（每次启动都调用，不得覆盖域里的现行状态）；
 *  ③ **不动旧文件**（向前兼容的第二道保险必须完好）；
 *  ④ 域不可用 ⇒ 静默返回零计数、**不抛**（装载期，不能成为启动单点）。
 */
describe('trajectory-bound: §0L 一次性迁移 migrateBindingsToDomain', () => {
  const DIR = '2026-09-05--S142--dsp'

  function fakeDomain(initial: Record<string, unknown> = {}) {
    const records: Record<string, unknown> = { ...initial }
    return {
      records,
      domain: {
        table: () => ({
          get: (k: string) => records[k],
          entries: () => Object.entries(records)[Symbol.iterator](),
          size: Object.keys(records).length,
          put: async (k: string, v: unknown) => { records[k] = v },
          delete: async (k: string) => delete records[k],
        }),
      },
    }
  }

  /** 直接写旧表（绕过 appendBound 的 cwd 定位，便于构造多会话场景） */
  function seedFile(sessions: Record<string, unknown>): void {
    writeFileSync(
      join(ccc, BINDINGS_REL_PATH),
      JSON.stringify({ version: 1, sessions }, null, 2),
    )
  }

  it('🔴 全量灌入：旧表 N 条 → 域 N 条（不丢绑定）', async () => {
    seedFile({
      a: { dirName: DIR, mdPath: '/r/A/SESSION.md', action: 'activate', at: 1 },
      b: { dirName: '2026-09-13--S185--x', mdPath: '/r/B/SESSION.md', action: 'rebuild', at: 2 },
      c: { dirName: '2026-09-01--S151--y--auto', mdPath: '/r/C/SESSION.md', action: 'activate', at: 3 },
    })
    const { domain, records } = fakeDomain({})
    setBindingStore(bindingStore(domain as never))
    const stats = migrateBindingsToDomain(ccc)
    expect(stats).toEqual({ migrated: 3, skipped: 0, failed: 0 })
    await Promise.resolve()
    expect(Object.keys(records).sort()).toEqual(['a', 'b', 'c'])
    // 字段完整搬运（dirName 硬锚 + action + at 不能丢）
    expect((records.a as { dirName?: string }).dirName).toBe(DIR)
    expect((records.b as { action?: string }).action).toBe('rebuild')
    expect((records.c as { at?: number }).at).toBe(3)
  })

  it('🔴 幂等：域里已有的**跳过、不覆盖**（重复调用安全）', async () => {
    seedFile({
      a: { dirName: 'old-value', mdPath: '/r/A/SESSION.md', action: 'activate', at: 1 },
      b: { dirName: DIR, mdPath: '/r/B/SESSION.md', action: 'activate', at: 2 },
    })
    const { domain, records } = fakeDomain({
      // 域里 a 已有**更新的**状态（例如 0L 生效后被重新绑定过）
      a: { dirName: 'NEWER', mdPath: '/r/A2/SESSION.md', action: 'switch', at: 99 },
    })
    setBindingStore(bindingStore(domain as never))
    const stats = migrateBindingsToDomain(ccc)
    expect(stats).toEqual({ migrated: 1, skipped: 1, failed: 0 })
    await Promise.resolve()
    // 域里的新值**未被旧表覆盖**（这是幂等的核心判据）
    expect((records.a as { dirName?: string }).dirName).toBe('NEWER')
    expect((records.b as { dirName?: string }).dirName).toBe(DIR)
  })

  it('🔴 不动旧文件（迁移只读不写旧表）', () => {
    seedFile({ a: { dirName: DIR, mdPath: '/r/A/SESSION.md', action: 'activate', at: 1 } })
    const before = readFileSync(join(ccc, BINDINGS_REL_PATH), 'utf-8')
    const { domain } = fakeDomain({})
    setBindingStore(bindingStore(domain as never))
    migrateBindingsToDomain(ccc)
    expect(readFileSync(join(ccc, BINDINGS_REL_PATH), 'utf-8')).toBe(before)
  })

  it('域不可用 ⇒ 零计数且不抛（装载期不能成为启动单点）', () => {
    seedFile({ a: { dirName: DIR, mdPath: '/r/A/SESSION.md', action: 'activate', at: 1 } })
    setBindingStore(null)
    expect(() => migrateBindingsToDomain(ccc)).not.toThrow()
    expect(migrateBindingsToDomain(ccc)).toEqual({ migrated: 0, skipped: 0, failed: 0 })
  })

  it('旧表不存在 / 损坏 ⇒ 零计数且不抛', () => {
    const { domain } = fakeDomain({})
    setBindingStore(bindingStore(domain as never))
    expect(migrateBindingsToDomain(ccc)).toEqual({ migrated: 0, skipped: 0, failed: 0 })
    writeFileSync(join(ccc, BINDINGS_REL_PATH), '{ not json')
    expect(migrateBindingsToDomain(ccc)).toEqual({ migrated: 0, skipped: 0, failed: 0 })
  })

  it('形状不符的条目被跳过（缺 dirName 不迁移）', async () => {
    seedFile({
      good: { dirName: DIR, mdPath: '/r/G/SESSION.md', action: 'activate', at: 1 },
      bad: { action: 'activate' },
    })
    const { domain, records } = fakeDomain({})
    setBindingStore(bindingStore(domain as never))
    expect(migrateBindingsToDomain(ccc)).toEqual({ migrated: 1, skipped: 0, failed: 0 })
    await Promise.resolve()
    expect(Object.keys(records)).toEqual(['good'])
  })

  it('🔴 迁移后 readLastBound 能从域读到（迁移与读路径闭环）', async () => {
    seedFile({ 'sess-m': { dirName: DIR, mdPath: '/r/M/SESSION.md', action: 'rebuild', at: 7 } })
    const { domain } = fakeDomain({})
    setBindingStore(bindingStore(domain as never))
    migrateBindingsToDomain(ccc)
    await Promise.resolve()
    // 把旧文件删掉，证明这次读到的是**域**而不是文件
    rmSync(join(ccc, BINDINGS_REL_PATH), { force: true })
    expect(readLastBound(makeSession('sess-m'))?.dirName).toBe(DIR)
    expect(readLastBound(makeSession('sess-m'))?.action).toBe('rebuild')
  })
})

/**
 * **D69「只留一条」**（owner 2026-09-19 裁定：「2.只留一条」）。
 *
 * 语义（owner 原话 → 机械形态）：
 *  · 新会话绑上时，同一轨迹的**旧载体自动退休**；
 *  · **不删**（记录保留 → 沿革与"我曾属于哪条轨迹"仍可查）；
 *  · 效果 = 唤醒不再选中旧载体（消除"两条 live 各持一份完整上下文 + 双写者"）。
 *
 * 为什么这组用例重要：§0L 换了载体（文件 → 域），**退休语义必须在域上同样成立**，
 * 否则"只留一条"会随载体迁移**静默失效**——这正是 owner 这条裁定要防的病。
 */
describe('trajectory-bound: D69「只留一条」（域路径）', () => {
  const DIR = '2026-08-24--S142--dsp 长期维护'

  function fakeDomain(initial: Record<string, unknown> = {}) {
    const records: Record<string, unknown> = { ...initial }
    return {
      records,
      domain: {
        table: () => ({
          get: (k: string) => records[k],
          entries: () => Object.entries(records)[Symbol.iterator](),
          size: Object.keys(records).length,
          put: async (k: string, v: unknown) => { records[k] = v },
          delete: async (k: string) => delete records[k],
        }),
      },
    }
  }

  it('🔴 旧载体退休：候选只剩最新的那条（唤醒不再选中旧的）', async () => {
    // 复刻实测现状：S142 曾同时挂 4 个载体
    const { domain } = fakeDomain({
      'carrier-1': { dirName: DIR, mdPath: '/r/1/SESSION.md', action: 'rebuild', at: 1 },
      'carrier-2': { dirName: DIR, mdPath: '/r/2/SESSION.md', action: 'rebuild', at: 2 },
      'carrier-3': { dirName: DIR, mdPath: '/r/3/SESSION.md', action: 'rebuild', at: 3 },
      'carrier-4': { dirName: DIR, mdPath: '/r/4/SESSION.md', action: 'rebuild', at: 4 },
    })
    setBindingStore(bindingStore(domain as never))
    // 有 4 条时：唤醒候选 = 4（这就是 owner 要根治的"挂 4 条"）
    expect(listBoundSessionIds(ccc, DIR).length).toBe(4)

    // 新会话（carrier-4）绑上 ⇒ 其余自动退休
    const marked = supersedeOtherBindings(ccc, DIR, new Set(['carrier-4']))
    expect(marked.sort()).toEqual(['carrier-1', 'carrier-2', 'carrier-3'])
    await Promise.resolve()

    // ⇒ 只留一条
    expect(listBoundSessionIds(ccc, DIR)).toEqual(['carrier-4'])
  })

  it('🔴 退休 = **不删**：旧载体的记录仍在，正向查询仍能查到"我曾属于哪条轨迹"', async () => {
    const { domain, records } = fakeDomain({
      old: { dirName: DIR, mdPath: '/r/O/SESSION.md', action: 'rebuild', at: 1 },
      fresh: { dirName: DIR, mdPath: '/r/F/SESSION.md', action: 'activate', at: 2 },
    })
    setBindingStore(bindingStore(domain as never))
    supersedeOtherBindings(ccc, DIR, new Set(['fresh']))
    await Promise.resolve()

    // 记录仍在（不删）
    expect(records.old).toBeTruthy()
    // 且带上了退休标记（可审计"何时退休的"）
    expect((records.old as { supersededAt?: number }).supersededAt).toBeTypeOf('number')
    // 正向查询（"这条旧会话属于哪条轨迹"）**不受影响** —— D69 的"可逆/不丢沿革"语义
    expect(readLastBound(makeSession('old'))?.dirName).toBe(DIR)
  })

  it('幂等：对已退休的再调一次 → 不重复标记（空数组）', async () => {
    const { domain } = fakeDomain({
      a: { dirName: DIR, mdPath: '/r/A/SESSION.md', action: 'activate', at: 1 },
      b: { dirName: DIR, mdPath: '/r/B/SESSION.md', action: 'activate', at: 2 },
    })
    setBindingStore(bindingStore(domain as never))
    expect(supersedeOtherBindings(ccc, DIR, new Set(['b']))).toEqual(['a'])
    expect(supersedeOtherBindings(ccc, DIR, new Set(['b']))).toEqual([])
  })

  /**
   * 🔴 **同族回归钉**（实测缺陷，2026-09-19）：`pruneMissingBindings` 的首版实现
   * 与 `supersedeOtherBindings` 犯了**同一个错**——返回值只在**文件循环**里收集，
   * 于是"记录只在域里"时调用方拿到 `[]`（回报不出 `prunedBindings`，静默）。
   * 这条用例专门钉"域侧也要被计入返回值"。
   */
  it('🔴 pruneMissingBindings：**域侧**记录的删除也被计入返回值（同族缺陷回归钉）', async () => {
    const { domain, records } = fakeDomain({
      'domain-only': { dirName: DIR, mdPath: '/r/D/SESSION.md', action: 'activate', at: 1 },
    })
    setBindingStore(bindingStore(domain as never))
    // 旧文件里**没有**任何条目 ⇒ 首版实现会返回 []
    const removed = pruneMissingBindings(ccc, (id) => id === 'domain-only')
    expect(removed).toEqual(['domain-only'])
    await Promise.resolve()
    expect(records['domain-only']).toBeUndefined()
  })
})

/**
 * 🔴 **惰性补迁移**（§0L 修正，S142 2026-09-19）——修复一个**发布后实测**才暴露的缺陷。
 *
 * 首版把迁移放在装载期、用 `process.cwd()` 当 CCC 根。而 dsh **服务进程的 cwd 是 `/home/yh`**
 * （`acc-diag` 实测：`进程 cwd: /home/yh ｜ 进程 CCC: （无）`）⇒ 迁移读到不存在的文件，
 * **静默迁移 0 条**：v1.40.0 发布重启后 `~/.dsh/storages/serenity_bindings.json` **没出现**。
 *
 * 判据：**任何一次能定位 CCC 根的绑定读写，都应顺带把该 CCC 的历史绑定补灌进域**。
 */
describe('trajectory-bound: §0L 惰性补迁移（bindingsPathFor 触发）', () => {
  const DIR = '2026-09-05--S142--dsp'

  function fakeDomain(initial: Record<string, unknown> = {}) {
    const records: Record<string, unknown> = { ...initial }
    return {
      records,
      domain: {
        table: () => ({
          get: (k: string) => records[k],
          entries: () => Object.entries(records)[Symbol.iterator](),
          size: Object.keys(records).length,
          put: async (k: string, v: unknown) => { records[k] = v },
          delete: async (k: string) => delete records[k],
        }),
      },
    }
  }

  it('🔴 读路径即触发迁移：只需一次 readLastBound，旧表就被补灌进域', async () => {
    writeFileSync(
      join(ccc, BINDINGS_REL_PATH),
      JSON.stringify({
        version: 1,
        sessions: {
          'sess-a': { dirName: DIR, mdPath: '/r/A/SESSION.md', action: 'activate', at: 1 },
          'sess-b': { dirName: '2026-09-13--S185--x', mdPath: '/r/B/SESSION.md', action: 'rebuild', at: 2 },
        },
      }, null, 2),
    )
    const { domain, records } = fakeDomain({})
    setBindingStore(bindingStore(domain as never))
    // 只做一次普通读——迁移应被**惰性**带出来
    readLastBound(makeSession('sess-a'))
    await Promise.resolve()
    expect(Object.keys(records).sort()).toEqual(['sess-a', 'sess-b'])
  })

  it('🔴 bindingsPathFor 本身即触发（它标定了"该 CCC 的绑定在哪"）', async () => {
    writeFileSync(
      join(ccc, BINDINGS_REL_PATH),
      JSON.stringify({ version: 1, sessions: { 'sess-z': { dirName: DIR, mdPath: '/r/Z/SESSION.md', action: 'activate', at: 3 } } }),
    )
    const { domain, records } = fakeDomain({})
    setBindingStore(bindingStore(domain as never))
    expect(bindingsPathFor(makeSession('sess-z'))).toBe(join(ccc, BINDINGS_REL_PATH))
    await Promise.resolve()
    expect(records['sess-z']).toBeTruthy()
  })

  it('域不可用 ⇒ 惰性迁移是 no-op（不抛、不写；旧文件仍可读 = 零回归）', () => {
    writeFileSync(
      join(ccc, BINDINGS_REL_PATH),
      JSON.stringify({ version: 1, sessions: { 'sess-a': { dirName: DIR, mdPath: '/r/A/SESSION.md', action: 'activate', at: 1 } } }),
    )
    setBindingStore(null)
    expect(() => readLastBound(makeSession('sess-a'))).not.toThrow()
    expect(readLastBound(makeSession('sess-a'))?.dirName).toBe(DIR)
  })
})
