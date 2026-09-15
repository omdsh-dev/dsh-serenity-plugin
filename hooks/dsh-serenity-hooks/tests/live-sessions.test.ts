/**
 * live-sessions.test.ts — 镜像测试（P2-2 门禁要求：src 业务模块不得裸奔）
 *
 * 覆盖 2026-09-15 S142「ACC 侧 autopilot 退场」S1 从 `autopilot-trajectory.ts`
 * 迁出的三个符号：`readSessionTitle` / `listLiveSessions` / `diagLive`。
 *
 * 测试策略：全部走**假 ctx**（`hostInjected` 先直接读 `ctx[name]` ⇒ 普通对象即可），
 * 不依赖真实宿主。`cccRootForCwd` 的归属判定按构造依赖**真实文件系统**（向上找 `.serenity`），
 * 故此处**只断言"与同一函数的独立调用一致"**（接线检查），不硬编码某个 CCC 根——
 * 那是 `ccc-roots` 自己的语义，不属于本模块的职责面。
 */
import { describe, expect, it } from 'vitest'
import { cccRootForCwd } from '../src/ccc-roots.js'
import { diagLive, listLiveSessions, readSessionTitle } from '../src/live-sessions.js'

type FakeCtx = { sessions?: { list?: () => unknown } }

/** 会话替身：`events` 走 `sessionEvents` 的兜底分支（无 `snapshotEvents`） */
function fakeSession(id: string, cwd: string | null, events?: unknown[]): unknown {
  return { id, header: { cwd }, events: events ?? [] }
}

function ctxWith(sessions: unknown[] | (() => unknown[])): FakeCtx {
  return { sessions: { list: typeof sessions === 'function' ? sessions : () => sessions } }
}

describe('readSessionTitle', () => {
  it('从 events 读 `session/title`（latest-wins）', () => {
    const s = fakeSession('s1', null, [
      { type: 'session/title', data: { title: '旧标题' } },
      { type: 'other' },
      { type: 'session/title', data: { title: '新标题' } },
    ])
    expect(readSessionTitle(s)).toBe('新标题')
  })

  it('末尾的空标题被跳过，回退到更早的非空标题（不返回空串）', () => {
    const s = fakeSession('s1', null, [
      { type: 'session/title', data: { title: '有效' } },
      { type: 'session/title', data: { title: '   ' } },
    ])
    expect(readSessionTitle(s)).toBe('有效')
  })

  it('无 title 事件 ⇒ null', () => {
    expect(readSessionTitle(fakeSession('s1', null, [{ type: 'other' }]))).toBeNull()
  })

  it('title 非字符串 ⇒ 忽略（不把对象 toString 出来）', () => {
    const s = fakeSession('s1', null, [{ type: 'session/title', data: { title: { x: 1 } } }])
    expect(readSessionTitle(s)).toBeNull()
  })

  it('优先 `snapshotEvents()`（rc.1 真实形态），且其抛错时回落 `events`', () => {
    const viaSnapshot = {
      snapshotEvents: () => [{ type: 'session/title', data: { title: '快照' } }],
      events: [{ type: 'session/title', data: { title: '兜底' } }],
    }
    expect(readSessionTitle(viaSnapshot)).toBe('快照')

    const snapshotThrows = {
      snapshotEvents: () => {
        throw new Error('boom')
      },
      events: [{ type: 'session/title', data: { title: '兜底' } }],
    }
    expect(readSessionTitle(snapshotThrows)).toBe('兜底')
  })

  it('null / undefined 会话 ⇒ null（不抛）', () => {
    expect(readSessionTitle(null)).toBeNull()
    expect(readSessionTitle(undefined)).toBeNull()
  })
})

describe('listLiveSessions', () => {
  it('逐条映射 id / cwd / cccRoot / title', () => {
    const rows = listLiveSessions(
      ctxWith([
        fakeSession('a', '/tmp/not-a-ccc', [{ type: 'session/title', data: { title: 'A' } }]),
      ]) as never,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      id: 'a',
      cwd: '/tmp/not-a-ccc',
      cccRoot: cccRootForCwd('/tmp/not-a-ccc'), // 与独立调用一致（接线检查，见文件头）
      title: 'A',
    })
  })

  it('cwd 缺失 ⇒ cccRoot 为 null（不拿 undefined 去解析）', () => {
    const rows = listLiveSessions(ctxWith([fakeSession('b', null)] as unknown[]) as never)
    expect(rows[0]?.cwd).toBeNull()
    expect(rows[0]?.cccRoot).toBeNull()
    expect(rows[0]?.title).toBeNull()
  })

  it('id 缺失 ⇒ 空串（保留该行，不静默丢弃）', () => {
    const rows = listLiveSessions(ctxWith([{ header: { cwd: null } }]) as never)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe('')
  })

  it('宿主无 sessions 服务 ⇒ []（服务缺失一律不抛）', () => {
    expect(listLiveSessions({} as never)).toEqual([])
    expect(listLiveSessions(ctxWith([]) as never)).toEqual([])
  })

  it('sessions.list 抛错 ⇒ []（遍历失败忽略，不毒化调用方）', () => {
    const ctx = ctxWith(() => {
      throw new Error('host boom')
    })
    expect(listLiveSessions(ctx as never)).toEqual([])
  })
})

describe('diagLive（精简版：进程归属 + live 会话清单）', () => {
  it('processCwd = 真实 process.cwd()；processCcc 与独立解析一致', () => {
    const r = diagLive(ctxWith([fakeSession('c', null)]) as never)
    expect(r.processCwd).toBe(process.cwd())
    expect(r.processCcc).toBe(cccRootForCwd(process.cwd()))
  })

  it('liveSessions 透传 listLiveSessions 的结果', () => {
    const r = diagLive(ctxWith([fakeSession('c', null), fakeSession('d', null)]) as never)
    expect(r.liveSessions.map((s) => s.id)).toEqual(['c', 'd'])
  })

  it('🔴 退场契约：报告**不含** autopilotCccs / panelResolved 两段（主语随机制退场）', () => {
    const r = diagLive(ctxWith([]) as never) as Record<string, unknown>
    expect(Object.keys(r).sort()).toEqual(['liveSessions', 'processCcc', 'processCwd'])
  })
})
