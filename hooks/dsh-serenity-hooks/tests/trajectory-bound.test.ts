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
import { appendBound, readLastBound, hasAnyBound, bindingsPathFor, BINDINGS_REL_PATH, listBoundSessionIds, pruneMissingBindings, resolveSessionTrajectoryLabel, supersedeOtherBindings } from '../src/trajectory-bound.js'
import { resetActiveSessionStore, setActiveSessionInfo } from '../src/trajectory-ops.js'

let ccc: string

beforeEach(() => {
  ccc = mkdtempSync(join(tmpdir(), 'bound-'))
  writeFileSync(join(ccc, '.serenity'), '')
  mkdirSync(join(ccc, 'AGENT_SESSIONS'), { recursive: true })
  resetActiveSessionStore() // 内存激活表按用例隔离（进程级单例，否则跨用例串味）
})

afterEach(() => {
  rmSync(ccc, { recursive: true, force: true })
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
