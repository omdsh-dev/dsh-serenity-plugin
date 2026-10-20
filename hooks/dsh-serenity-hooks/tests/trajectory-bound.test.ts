/**
 * trajectory-bound.test.ts — 绑定关系（D172：**归属 = 认知轨迹自己的交代**）
 *
 * ## 判决背景（owner 2026-10-20 原话）
 *
 * > 「**认知轨迹自己交代永远是最好的交代**」
 * > 「绑定表是没有意义的…本质就搞成**第二真相源**了」
 * > 「每个认知轨迹目录内放一个 `current.dsh_session_bind`，以这个为绑定真相源」
 * > 「文件里写的 sessionId 可能已经不存在了，这个情况下就**视同没绑定**」
 * > 「**调用 use 会覆盖掉这个文件，完整生命周期要实现**」
 *
 * ## 本文件守什么（旧用例的去向一并写明，避免"删断言"式过关）
 *
 * | 判据 | 旧形态怎么钉 | 本文件 |
 * |---|---|---|
 * | 绑定能写能读 | 读 `.bindings.json` | 读**轨迹目录里的** `current.dsh_session_bind` |
 * | 一个会话只能绑一条轨迹 | 靠 `supersededAt` 标记 | **`claimBinding` 拒绝**（`SESSION_TAKEN`） |
 * | 一条轨迹只有一个载体 | 同上（标记退掉其它） | **单槽位**：写入即覆盖；换代需显式 `takeover` |
 * | 会话没了怎么办 | `pruneMissingBindings` 清理 | **视同没绑定**（`isBindUsable` ⇒ `stale`），不清理 |
 * | `switch` 生命周期 | 多记录，天然无残留 | 🔴 **先清 A 再写 B**（本文件专钉） |
 * | 旧 `serenity/bound` 事件 | 兼容读取 | 保留（只读兼容，永不写） |
 *
 * ⚠️ 已**整条退役**的判据（不再有对应用例，因为对象不存在了）：
 * `supersedeOtherBindings` / `pruneMissingBindings` / `migrateBindingsToDomain` /
 * `.bindings.json` 双写 / 存储域优先。它们由 `D172` 判决删除，**不是漏测**。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendBound,
  readLastBound,
  hasAnyBound,
  listBoundSessionIds,
  carrierState,
  resolveSessionCognitiveTrajectoryLabel,
  BIND_FILENAME,
  writeBindDeclaration,
  type BindDeclaration,
} from '../src/trajectory/bound.js'
import { claimBinding, isBindUsable, releaseBinding, readBindDeclaration } from '../src/trajectory/bind-file.js'
import { resetActiveSessionStore, setActiveSessionInfo } from '../src/trajectory/core.js'

const DIR = '2026-09-05--S142--dsp'
const DIR2 = '2026-09-01--S151--other'
const SESS = 'AGENT_SESSIONS'

let ccc = ''

beforeEach(() => {
  ccc = mkdtempSync(join(tmpdir(), 'bind-'))
  writeFileSync(join(ccc, '.serenity'), '')
  mkdirSync(join(ccc, SESS), { recursive: true })
  resetActiveSessionStore()
})

afterEach(() => {
  rmSync(ccc, { recursive: true, force: true })
})

/** 最小可测 dsh 会话：`header` 提供 id + cwd（定位 CCC 根） */
function makeSession(id = 'sess-1', events: unknown[] = [], cwd = ccc) {
  return { header: { id, cwd }, snapshotEvents: () => events }
}

/** 建轨迹目录（有目录才有槽位） */
function mkTraj(dir = DIR): string {
  const p = join(ccc, SESS, dir)
  mkdirSync(p, { recursive: true })
  return p
}

/** 读某轨迹的槽位声明 */
function declOf(dir = DIR): BindDeclaration | null {
  return readBindDeclaration(join(ccc, SESS, dir))
}

/** 读磁盘上的原始 JSON（证明"真的落盘了"，而不只是内存里对） */
function rawFile(dir = DIR): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ccc, SESS, dir, BIND_FILENAME), 'utf-8')) as Record<string, unknown>
}

describe('D172 · 归属写在轨迹目录自己的交代里', () => {
  it('appendBound 写出 current.dsh_session_bind（含 sessionId/at/action）', () => {
    mkTraj()
    const ok = appendBound(makeSession('sess-1'), 'activate', { dirName: DIR, mdPath: '/x/SESSION.md' })
    expect(ok).toBe(true)
    // ① 文件真的在**轨迹目录**里（不是任何旁路位置）
    expect(existsSync(join(ccc, SESS, DIR, BIND_FILENAME))).toBe(true)
    // ② 内容对得上
    const raw = rawFile()
    expect(raw['sessionId']).toBe('sess-1')
    expect(raw['action']).toBe('activate')
    expect(typeof raw['at']).toBe('number')
    // ③ 原子写：无 .tmp 残留
    expect(existsSync(join(ccc, SESS, DIR, `${BIND_FILENAME}.tmp`))).toBe(false)
  })

  it('🔴 反向：**不再**写 `.bindings.json`（旧旁路表已退役）', () => {
    mkTraj()
    appendBound(makeSession('sess-1'), 'activate', { dirName: DIR, mdPath: '/x/SESSION.md' })
    expect(existsSync(join(ccc, SESS, '.bindings.json'))).toBe(false)
  })

  it('无 header / 定位不到 CCC 根 ⇒ false，不抛（绑定失败不阻断主流程）', () => {
    mkTraj()
    expect(appendBound({}, 'activate', { dirName: DIR, mdPath: '/x' })).toBe(false)
    expect(appendBound({ header: { id: 'x' } }, 'activate', { dirName: DIR, mdPath: '/x' })).toBe(false)
  })

  it('readLastBound 正查：会话 → 它承载的轨迹', () => {
    mkTraj()
    appendBound(makeSession('sess-9'), 'activate', { dirName: DIR, mdPath: '/x/SESSION.md' })
    const b = readLastBound(makeSession('sess-9'))
    expect(b?.dirName).toBe(DIR)
    expect(b?.sessionId).toBe('sess-9')
    // mdPath 由 dirName 重新拼（**不信文件里的路径**：它可能是别的机器的绝对路径）
    expect(b?.mdPath).toBe(join(ccc, SESS, DIR, 'SESSION.md'))
  })

  it('没有交代 ⇒ null；hasAnyBound 同步为 false', () => {
    mkTraj()
    expect(readLastBound(makeSession('sess-none'))).toBeNull()
    expect(hasAnyBound(makeSession('sess-none'))).toBe(false)
  })

  it('坏 JSON ⇒ 视为"没交代"，不抛', () => {
    mkTraj()
    writeFileSync(join(ccc, SESS, DIR, BIND_FILENAME), '{ 坏')
    expect(readLastBound(makeSession('sess-1'))).toBeNull()
  })

  it('🔴 空文件夹不是绑定：`.serenity` 之外找不到会话归属时返回 null', () => {
    mkTraj()
    writeFileSync(join(ccc, SESS, DIR, BIND_FILENAME), JSON.stringify({ sessionId: '' }))
    expect(readLastBound(makeSession('sess-1'))).toBeNull()
  })
})

describe('D172 · 不变量 2：一个会话至多承载一条轨迹', () => {
  it('🔴 会话已属于 A ⇒ 认领 B 被拒（SESSION_TAKEN），且 A 的交代不被改坏', () => {
    mkTraj(DIR)
    mkTraj(DIR2)
    expect(claimBinding(join(ccc, SESS), DIR, { sessionId: 'sess-1', at: 1, action: 'activate' }).ok).toBe(true)
    const r = claimBinding(join(ccc, SESS), DIR2, { sessionId: 'sess-1', at: 2, action: 'activate' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('SESSION_TAKEN')
    // A 仍在，B 没被写
    expect(declOf(DIR)?.sessionId).toBe('sess-1')
    expect(declOf(DIR2)).toBeNull()
  })

  it('同一会话重复认领同一条轨迹 ⇒ 幂等通过（合法重入）', () => {
    mkTraj()
    expect(claimBinding(join(ccc, SESS), DIR, { sessionId: 'sess-1', at: 1, action: 'activate' }).ok).toBe(true)
    expect(claimBinding(join(ccc, SESS), DIR, { sessionId: 'sess-1', at: 2, action: 'activate' }).ok).toBe(true)
    expect(declOf(DIR)?.at).toBe(2)
  })
})

describe('D172 · 不变量 1：一条轨迹至多一个载体（单槽位）', () => {
  it('换一个会话承载同一条轨迹 ⇒ 需显式 takeover；否则 TRAJECTORY_OCCUPIED', () => {
    mkTraj()
    claimBinding(join(ccc, SESS), DIR, { sessionId: 'sess-old', at: 1, action: 'activate' })
    const r = claimBinding(join(ccc, SESS), DIR, { sessionId: 'sess-new', at: 2, action: 'rebuild' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('TRAJECTORY_OCCUPIED')
    // 旧载体原封不动（拒绝必须是**真拒绝**）
    expect(declOf(DIR)?.sessionId).toBe('sess-old')
  })

  it('显式 takeover ⇒ 覆盖成功，槽位只剩新载体（不是两条）', () => {
    mkTraj()
    claimBinding(join(ccc, SESS), DIR, { sessionId: 'sess-old', at: 1, action: 'activate' })
    const r = claimBinding(join(ccc, SESS), DIR, { sessionId: 'sess-new', at: 2, action: 'rebuild' }, { takeover: true })
    expect(r.ok).toBe(true)
    expect(declOf(DIR)?.sessionId).toBe('sess-new')
    expect(listBoundSessionIds(ccc, DIR)).toEqual(['sess-new'])
  })
})

describe('D172 · 不变量 3：会话不存在 ⇒ 视同没绑定', () => {
  it('🔴 交代还在、会话已死 ⇒ listBoundSessionIds 返回空（**不清理文件**）', () => {
    mkTraj()
    claimBinding(join(ccc, SESS), DIR, { sessionId: 'sess-dead', at: 1, action: 'activate' })
    const alive = (id: string) => id !== 'sess-dead'
    expect(listBoundSessionIds(ccc, DIR, alive)).toEqual([])
    // 文件仍在 —— 它记录"上一次由谁承载"，是有用的沿革
    expect(existsSync(join(ccc, SESS, DIR, BIND_FILENAME))).toBe(true)
  })

  it('会话活着 ⇒ 返回它', () => {
    mkTraj()
    claimBinding(join(ccc, SESS), DIR, { sessionId: 'sess-live', at: 1, action: 'activate' })
    expect(listBoundSessionIds(ccc, DIR, () => true)).toEqual(['sess-live'])
  })

  it('无探针 ⇒ 信文件（降级，不是"保证会话在"）', () => {
    mkTraj()
    claimBinding(join(ccc, SESS), DIR, { sessionId: 'sess-x', at: 1, action: 'activate' })
    expect(listBoundSessionIds(ccc, DIR)).toEqual(['sess-x'])
  })

  it('isBindUsable 三态：absent / usable / stale', () => {
    expect(isBindUsable(null, () => true).state).toBe('absent')
    const decl: BindDeclaration = { sessionId: 's', at: 1, action: 'activate' }
    expect(isBindUsable(decl, () => true).state).toBe('usable')
    expect(isBindUsable(decl, () => false).state).toBe('stale')
  })

  it('🔴 探针自己抛 ⇒ 判 stale（宁可当作没绑定，也不拿不可验证的绑定去投递）', () => {
    const decl: BindDeclaration = { sessionId: 's', at: 1, action: 'activate' }
    expect(isBindUsable(decl, () => { throw new Error('boom') }).state).toBe('stale')
  })
})

describe('D172 · 完整生命周期（owner：「调用 use 会覆盖掉这个文件」）', () => {
  it('🔴 switch：会话从 A 改宗到 B ⇒ **A 的槽位必须被清掉**（否则残留指向它）', () => {
    mkTraj(DIR)
    mkTraj(DIR2)
    claimBinding(join(ccc, SESS), DIR, { sessionId: 'sess-1', at: 1, action: 'activate' })
    // 手工模拟"先清 A 再写 B"——这正是 claimBinding 在 takeover 语义外的配对要求
    expect(releaseBinding(join(ccc, SESS), DIR, 'sess-1')).toBe(true)
    expect(claimBinding(join(ccc, SESS), DIR2, { sessionId: 'sess-1', at: 2, action: 'switch' }).ok).toBe(true)
    // 判据：扫全表，这个会话只能出现一次
    expect(declOf(DIR)).toBeNull()
    expect(declOf(DIR2)?.sessionId).toBe('sess-1')
  })

  it('🔴 release 只在槽位确实是那个会话时才清（防误清别人的）', () => {
    mkTraj()
    claimBinding(join(ccc, SESS), DIR, { sessionId: 'sess-real', at: 1, action: 'activate' })
    expect(releaseBinding(join(ccc, SESS), DIR, 'sess-other')).toBe(false)
    expect(declOf(DIR)?.sessionId).toBe('sess-real')
    expect(releaseBinding(join(ccc, SESS), DIR, 'sess-real')).toBe(true)
    expect(declOf(DIR)).toBeNull()
  })

  it('release 对空槽位 ⇒ false（不抛）', () => {
    mkTraj()
    expect(releaseBinding(join(ccc, SESS), DIR)).toBe(false)
  })
})

describe('D172 · carrierState：判"能不能自建载体"（owner 第 2 条）', () => {
  it('从未有过交代 ⇒ never（允许自建）', () => {
    mkTraj()
    expect(carrierState(ccc, DIR, () => true)).toEqual({ state: 'never' })
  })

  it('🔴 有过交代但会话已死 ⇒ **occupied**（禁止自建；这正是"表被退掉了"的旧缺陷根因）', () => {
    mkTraj()
    claimBinding(join(ccc, SESS), DIR, { sessionId: 'sess-gone', at: 1, action: 'activate' })
    expect(carrierState(ccc, DIR, () => false)).toEqual({ state: 'occupied', sessionId: 'sess-gone' })
  })

  it('交代有效 ⇒ live', () => {
    mkTraj()
    claimBinding(join(ccc, SESS), DIR, { sessionId: 'sess-on', at: 1, action: 'activate' })
    expect(carrierState(ccc, DIR, () => true)).toEqual({ state: 'live', sessionId: 'sess-on' })
  })
})

describe('D172 · 编码无关（U4）：目录名是硬锚，S 前缀不重要', () => {
  it('issue 会话（无 S 前缀）同样可绑定', () => {
    const dir = '2026-09-04--apaas-26116'
    mkTraj(dir)
    expect(appendBound(makeSession('sess-1'), 'activate', { dirName: dir, mdPath: '/x' })).toBe(true)
    const b = readLastBound(makeSession('sess-1'))
    expect(b?.dirName).toBe(dir)
    // sessionId 是 dsh 会话 id（硬锚），展示码另给
    expect(b?.sessionId).toBe('sess-1')
    expect(b?.sessionId2).toBe('apaas-26116')
  })
})

describe('D172 · resolveSessionCognitiveTrajectoryLabel（createdBy 审计归属）', () => {
  it('① 有交代 ⇒ 取该会话自己的标签（不看全局指针）', () => {
    mkTraj()
    setActiveSessionInfo('', { dirName: '2026-01-01--S999--global', mdPath: '/g', sessionId: 'S999' })
    appendBound(makeSession('sess-a'), 'activate', { dirName: DIR, mdPath: '/x' })
    expect(resolveSessionCognitiveTrajectoryLabel(makeSession('sess-a'), 'sess-a')).toBe('S142')
  })

  it('② 无交代但本 scope 有内存激活 ⇒ 取本 scope', () => {
    setActiveSessionInfo('sess-b', { dirName: DIR, mdPath: '/x', sessionId: 'S142' })
    expect(resolveSessionCognitiveTrajectoryLabel(makeSession('sess-b'), 'sess-b')).toBe('S142')
  })

  it('③ 两级皆空 ⇒ 回退全局最近活跃', () => {
    setActiveSessionInfo('', { dirName: DIR, mdPath: '/x', sessionId: 'S142' })
    expect(resolveSessionCognitiveTrajectoryLabel(makeSession('sess-c'), 'sess-c')).toBe('S142')
  })

  it('④ 三级全落空 ⇒ 空串（渲染为 `?`，不抛）', () => {
    expect(resolveSessionCognitiveTrajectoryLabel(makeSession('sess-d'), 'sess-d')).toBe('')
  })
})

describe('D172 · 旧事件形态回落（v1.30.5 及更早的存量，只读兼容）', () => {
  it('无交代 ⇒ 回落扫会话日志里的 serenity/bound（最后一条胜出）', () => {
    mkTraj()
    const events = [
      { type: 'serenity/bound', data: { dirName: '2026-01-01--S1--old', mdPath: '/o', sessionId: 'S1', action: 'activate', at: 10 } },
      { type: 'serenity/bound', data: { dirName: DIR, mdPath: '/n', sessionId: 'S142', action: 'activate', at: 20 } },
    ]
    const b = readLastBound(makeSession('sess-legacy', events))
    expect(b?.dirName).toBe(DIR)
    expect(b?.at).toBe(20)
  })

  it('旧形态坏数据跳过（不抛）', () => {
    const events = [{ type: 'serenity/bound', data: { nope: 1 } }]
    expect(readLastBound(makeSession('sess-bad', events))).toBeNull()
  })

  it('🔴 有交代时**优先**交代，不回落旧事件', () => {
    mkTraj()
    appendBound(makeSession('sess-both'), 'activate', { dirName: DIR, mdPath: '/x' })
    const events = [{ type: 'serenity/bound', data: { dirName: '2026-01-01--S1--stale', mdPath: '/s', sessionId: 'S1', action: 'activate', at: 1 } }]
    expect(readLastBound(makeSession('sess-both', events))?.dirName).toBe(DIR)
  })
})

describe('D172 · createdAsUser 审计事实（D170 配套）', () => {
  it('带上就落盘，读回可见（不从 note 文案推）', () => {
    mkTraj()
    appendBound(makeSession('sess-u'), 'activate', { dirName: DIR, mdPath: '/x', createdAsUser: true })
    expect(declOf(DIR)?.createdAsUser).toBe(true)
    expect(readLastBound(makeSession('sess-u'))?.createdAsUser).toBe(true)
  })

  it('不带就是没有（不留 `createdAsUser: false` 噪音）', () => {
    mkTraj()
    appendBound(makeSession('sess-n'), 'activate', { dirName: DIR, mdPath: '/x' })
    expect(rawFile()['createdAsUser']).toBeUndefined()
  })
})

describe('D172 · writeBindDeclaration 是低层原语（不做唯一性检查）', () => {
  it('直接写不做校验 —— 唯一性只在 claimBinding（分离的理由：写不必扫全盘）', () => {
    mkTraj(DIR)
    mkTraj(DIR2)
    writeBindDeclaration(join(ccc, SESS, DIR), { sessionId: 'dup', at: 1, action: 'activate' })
    writeBindDeclaration(join(ccc, SESS, DIR2), { sessionId: 'dup', at: 2, action: 'activate' })
    // 两个都写成功 ⇒ 证明本原语不校验（校验是 claimBinding 的职责）
    expect(declOf(DIR)?.sessionId).toBe('dup')
    expect(declOf(DIR2)?.sessionId).toBe('dup')
  })
})
