/**
 * cro.test.ts — CRO（Continuous Re-Occurrence）机制层（S142 §7.8，2026-09-19）
 *
 * 覆盖（设计档 `docs/cro-design.md`）：
 *  - §2 位置与形态：路径约定 / 路径逃逸阻断 / "文件在即启用"
 *  - §3 输入快照：装配（纯函数）+ 展示码派生（**不解析格式**，取不到不拒服务）
 *  - §4 输出：**全部边界**（空 / 非 JSON / 数组 / 缺 prompt / 非布尔 wake / reason）
 *  - §5 容错：🔴 **旁路容忍铁律**（失败绝不抛、绝不影响既有机制）
 *  - 执行：真实 spawn（成功 / 非 0 退出 / 超时 kill）
 *
 * 🔴 本文件刻意**不 mock spawn 的成功路径** —— 用真实子进程证明"那条链真的跑得通"
 *    （判据纪律：**"我读了源码"与"我执行了那条链"是两个证据等级**）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildCroSnapshot,
  CRO_FILENAME,
  croScriptPath,
  deriveCode,
  evaluateCro,
  isCroEnabled,
  parseCroOutput,
  readCroSnapshotInput,
  renderCroOutcome,
  runCroProcess,
  type CroRunner,
  type CroSnapshotInput,
} from '../src/cro.js'

const DIR_NAME = '2026-09-13--S185--desk-camera'
const NOW = 1_789_800_000_000

let root: string

/** 在 CCC 根下建一条轨迹目录（可选写入 CRO 程序） */
function makeTrajectory(dirName = DIR_NAME, croSource?: string): string {
  const dir = join(root, 'AGENT_SESSIONS', dirName)
  mkdirSync(join(dir, 'references'), { recursive: true })
  writeFileSync(join(dir, 'SESSION.md'), '# SESSION\n', 'utf-8')
  if (croSource !== undefined) writeFileSync(join(dir, CRO_FILENAME), croSource, 'utf-8')
  return dir
}

/** 一份最小可用的快照输入 */
function snapshotInput(over: Partial<CroSnapshotInput> = {}): CroSnapshotInput {
  return {
    dirName: DIR_NAME,
    cccRoot: root,
    nowMs: NOW,
    sessionMdPath: join(root, 'AGENT_SESSIONS', DIR_NAME, 'SESSION.md'),
    sessionMdBytes: 1234,
    sessionMdMtimeMs: NOW - 60_000,
    references: [{ name: 'a.md', bytes: 10, mtimeMs: NOW - 120_000 }],
    boundSessionIds: ['session-aaa'],
    liveSessionIds: ['session-aaa'],
    runningSessionIds: [],
    pendingWakes: [],
    scheduler: { armed: true, enabled: true, ticks: 7, lastSkipReason: null },
    ...over,
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cro-test-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// ── §2 位置与形态 ──

describe('CRO: 位置与形态（设计 §2）', () => {
  it('入口文件名是全写（所有者令，不许改缩写）', () => {
    expect(CRO_FILENAME).toBe('continuous-re-occurrence.ts')
  })

  it('路径约定 = <CCC 根>/AGENT_SESSIONS/<目录名>/continuous-re-occurrence.ts', () => {
    expect(croScriptPath(root, DIR_NAME)).toBe(join(root, 'AGENT_SESSIONS', DIR_NAME, CRO_FILENAME))
  })

  it('🔴 路径逃逸被阻断（dirName 来自入参，必须钉在 CCC 根内）', () => {
    expect(() => croScriptPath(root, '../../etc')).toThrow(/escape/i)
  })

  it('🔴 启用判据 = 文件在不在（无 enabled 字段、无注册表）', () => {
    makeTrajectory(DIR_NAME) // 不写 CRO 文件
    expect(isCroEnabled(root, DIR_NAME)).toBe(false)
    writeFileSync(join(root, 'AGENT_SESSIONS', DIR_NAME, CRO_FILENAME), 'export {}', 'utf-8')
    expect(isCroEnabled(root, DIR_NAME)).toBe(true)
  })

  it('路径逃逸时 isCroEnabled 返回 false（不抛）', () => {
    expect(isCroEnabled(root, '../outside')).toBe(false)
  })
})

// ── §3 输入快照 ──

describe('CRO: 展示码派生（§3，**不解析编号格式**——§0I U4）', () => {
  it('取得到 S### 时给出展示码', () => {
    expect(deriveCode('2026-09-13--S185--desk-camera')).toBe('S185')
    expect(deriveCode('2026-08-24--S142--dsh-serenity-plugin 长期维护')).toBe('S142')
  })

  it('🔴 取不到（issue 号 / 自定义前缀 / 无编号）⇒ 空串，**不是错误**', () => {
    expect(deriveCode('2026-09-04--apaas-26116')).toBe('')
    expect(deriveCode('2026-09-01--custom-prefix--thing')).toBe('')
    expect(deriveCode('plain-dir')).toBe('')
  })

  it('🔴 硬锚永远是 dirName：展示码取不到也照常装配快照', () => {
    const snap = buildCroSnapshot(snapshotInput({ dirName: '2026-09-04--apaas-26116' }))
    expect(snap.identity.dirName).toBe('2026-09-04--apaas-26116')
    expect(snap.identity.code).toBe('')
  })
})

describe('CRO: 快照装配（纯函数，§3）', () => {
  it('装配出四组字段（身份/时间/身体/调度）', () => {
    const snap = buildCroSnapshot(snapshotInput())
    expect(snap.version).toBe(1)
    expect(snap.identity).toEqual({ dirName: DIR_NAME, code: 'S185', cccRoot: root })
    expect(snap.time.nowMs).toBe(NOW)
    expect(snap.body.sessionMdBytes).toBe(1234)
    expect(snap.body.references).toHaveLength(1)
    expect(snap.scheduling.scheduler.ticks).toBe(7)
  })

  it('体积/mtime 缺失 ⇒ null（不是 0，不假装知道）', () => {
    const snap = buildCroSnapshot(snapshotInput({ sessionMdBytes: null, sessionMdMtimeMs: null }))
    expect(snap.body.sessionMdBytes).toBeNull()
    expect(snap.body.sessionMdMtime).toBeNull()
  })

  it('🔴 携带 runningSessionIds（**本机制唯一新增的状态**，§3.2）', () => {
    const snap = buildCroSnapshot(snapshotInput({ runningSessionIds: ['session-aaa'] }))
    expect(snap.binding.runningSessionIds).toEqual(['session-aaa'])
  })

  it('无待办唤醒 ⇒ 空数组', () => {
    expect(buildCroSnapshot(snapshotInput()).scheduling.pendingWakes).toEqual([])
  })
})

describe('CRO: 快照读取（fs 侧）', () => {
  it('读到 SESSION.md 体积与 references 清单', () => {
    const dir = makeTrajectory()
    writeFileSync(join(dir, 'references', 'note.md'), 'hello', 'utf-8')
    const input = readCroSnapshotInput(root, DIR_NAME, NOW, {
      liveSessionIds: [],
      runningSessionIds: [],
      boundSessionIds: [],
      pendingWakes: [],
      scheduler: { armed: true, enabled: true, ticks: 0, lastSkipReason: null },
    })
    expect(input.sessionMdBytes).toBe(10) // '# SESSION\n'
    expect(input.references.map((r) => r.name)).toContain('note.md')
  })

  it('轨迹目录不存在 ⇒ 体积 null + 空 references（**不抛**）', () => {
    const input = readCroSnapshotInput(root, 'no-such-dir', NOW, {
      liveSessionIds: [],
      runningSessionIds: [],
      boundSessionIds: [],
      pendingWakes: [],
      scheduler: { armed: false, enabled: false, ticks: 0, lastSkipReason: null },
    })
    expect(input.sessionMdBytes).toBeNull()
    expect(input.references).toEqual([])
  })
})

// ── §4 输出（全部边界）──

describe('CRO: 输出解析（§4，全部边界）', () => {
  it('wake=true + prompt ⇒ 唤起', () => {
    const r = parseCroOutput('{"wake":true,"prompt":"该起床了"}')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.decision).toEqual({ wake: true, prompt: '该起床了', reason: null })
  })

  it('wake=false ⇒ 不唤起（**这是常态**）', () => {
    const r = parseCroOutput('{"wake":false}')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.decision.wake).toBe(false)
  })

  it('🔴 缺省（空对象）⇒ 不唤起 —— 缺省必须是"不打扰"', () => {
    const r = parseCroOutput('{}')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.decision).toEqual({ wake: false, prompt: null, reason: null })
  })

  it('reason 被捕获（供事后重建，§4.2）', () => {
    const r = parseCroOutput('{"wake":true,"prompt":"x","reason":"SESSION.md 已超限"}')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.decision.reason).toBe('SESSION.md 已超限')
  })

  it('🔴 wake=true 但 prompt 空 ⇒ **非法**（不投递空消息）', () => {
    for (const bad of ['{"wake":true}', '{"wake":true,"prompt":""}', '{"wake":true,"prompt":"   "}', '{"wake":true,"prompt":42}']) {
      const r = parseCroOutput(bad)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toBe('cro-missing-prompt')
    }
  })

  it('🔴 非布尔 wake 一律当"不唤起"（严格 === true，防 "yes"/1 被误读为真）', () => {
    for (const v of ['{"wake":"yes"}', '{"wake":1}', '{"wake":"true"}', '{"wake":null}']) {
      const r = parseCroOutput(v)
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.decision.wake).toBe(false)
    }
  })

  it('空输出 ⇒ cro-empty-output', () => {
    const r = parseCroOutput('   \n  ')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('cro-empty-output')
  })

  it('非 JSON ⇒ cro-bad-json', () => {
    const r = parseCroOutput('not json at all')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('cro-bad-json')
  })

  it('🔴 数组 / 标量 / null ⇒ 拒绝（只接受对象）', () => {
    for (const bad of ['[1,2]', '"str"', '42', 'null', 'true']) {
      const r = parseCroOutput(bad)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toBe('cro-bad-json')
    }
  })

  it('前后空白与换行被容忍', () => {
    const r = parseCroOutput('\n  {"wake":true,"prompt":"ok"}  \n')
    expect(r.ok).toBe(true)
  })
})

// ── 执行（真实 spawn）──

describe('CRO: 真实 spawn 执行（§2.2）', () => {
  it('🟢 真跑一个程序：stdout 被捕获（证明"那条链真的通"）', async () => {
    const script = join(root, 'ok.mjs')
    writeFileSync(script, 'process.stdout.write(JSON.stringify({wake:true,prompt:"hi"}))\n', 'utf-8')
    const res = await runCroProcess(script, '{"x":1}', 10_000)
    expect(res.ok).toBe(true)
    expect(JSON.parse(res.stdout)).toEqual({ wake: true, prompt: 'hi' })
  })

  it('程序能读到 stdin（快照确实喂进去了）', async () => {
    const script = join(root, 'echo.mjs')
    writeFileSync(
      script,
      'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);process.stdout.write(JSON.stringify({wake:false,reason:o.identity.dirName}))})\n',
      'utf-8',
    )
    const res = await runCroProcess(script, JSON.stringify({ identity: { dirName: 'X' } }), 10_000)
    expect(res.ok).toBe(true)
    expect(JSON.parse(res.stdout).reason).toBe('X')
  })

  it('🔴 非 0 退出 ⇒ 结构化失败（**半成品报错即可**，所有者令）', async () => {
    const script = join(root, 'boom.mjs')
    writeFileSync(script, 'process.stderr.write("SyntaxError: bad\\n");process.exit(3)\n', 'utf-8')
    const res = await runCroProcess(script, '{}', 10_000)
    expect(res.ok).toBe(false)
    expect(res.code).toBe('cro-exit-nonzero')
    expect(res.error).toContain('3')
  })

  it('🔴 超时 ⇒ kill + 结构化失败（不许挂死调度器）', async () => {
    const script = join(root, 'slow.mjs')
    writeFileSync(script, 'setTimeout(()=>{}, 60_000)\n', 'utf-8')
    const res = await runCroProcess(script, '{}', 400)
    expect(res.ok).toBe(false)
    expect(res.code).toBe('cro-timeout')
  }, 15_000)

  it('🔴 不存在的二进制/路径 ⇒ 结构化失败（**绝不抛**）', async () => {
    const res = await runCroProcess(join(root, 'no-such-file.mjs'), '{}', 5_000)
    expect(res.ok).toBe(false)
    expect(typeof res.error).toBe('string')
  })
})

// ── §5 编排与容错（注入 runner ⇒ 无需真实 spawn）──

describe('CRO: 评估四态（§5）', () => {
  const neverRun: CroRunner = async () => {
    throw new Error('runner 本不该被调用')
  }

  it('无程序文件 ⇒ disabled（不跑、不报错）', async () => {
    makeTrajectory(DIR_NAME)
    const out = await evaluateCro(root, DIR_NAME, snapshotInput(), { runner: neverRun })
    expect(out.status).toBe('disabled')
  })

  it('🔴 程序抛错/非 0 ⇒ skipped（**跳过本轮**，不影响既有机制）', async () => {
    makeTrajectory(DIR_NAME, 'export {}')
    const out = await evaluateCro(root, DIR_NAME, snapshotInput(), {
      runner: async () => ({ ok: false, stdout: '', error: 'boom', code: 'cro-exit-nonzero' }),
    })
    expect(out.status).toBe('skipped')
    if (out.status === 'skipped') expect(out.code).toBe('cro-exit-nonzero')
  })

  it('输出是垃圾 ⇒ skipped（含稳定码）', async () => {
    makeTrajectory(DIR_NAME, 'export {}')
    const out = await evaluateCro(root, DIR_NAME, snapshotInput(), {
      runner: async () => ({ ok: true, stdout: 'garbage', error: null }),
    })
    expect(out.status).toBe('skipped')
    if (out.status === 'skipped') expect(out.code).toBe('cro-bad-json')
  })

  it('wake=false ⇒ no-wake', async () => {
    makeTrajectory(DIR_NAME, 'export {}')
    const out = await evaluateCro(root, DIR_NAME, snapshotInput(), {
      runner: async () => ({ ok: true, stdout: '{"wake":false,"reason":"天还没亮"}', error: null }),
    })
    expect(out.status).toBe('no-wake')
    if (out.status === 'no-wake') expect(out.detail).toBe('天还没亮')
  })

  it('🟢 wake=true ⇒ wake + prompt 透传', async () => {
    makeTrajectory(DIR_NAME, 'export {}')
    const out = await evaluateCro(root, DIR_NAME, snapshotInput(), {
      runner: async () => ({ ok: true, stdout: '{"wake":true,"prompt":"该醒了"}', error: null }),
    })
    expect(out.status).toBe('wake')
    if (out.status === 'wake') expect(out.prompt).toBe('该醒了')
  })

  it('🔴 喂进去的是**快照 JSON**（程序真能拿到轨迹状态）', async () => {
    makeTrajectory(DIR_NAME, 'export {}')
    let seen = ''
    await evaluateCro(root, DIR_NAME, snapshotInput({ runningSessionIds: ['s1'] }), {
      runner: async (_p, stdin) => {
        seen = stdin
        return { ok: true, stdout: '{"wake":false}', error: null }
      },
    })
    const parsed = JSON.parse(seen)
    expect(parsed.identity.dirName).toBe(DIR_NAME)
    expect(parsed.binding.runningSessionIds).toEqual(['s1'])
    expect(parsed.body.sessionMdBytes).toBe(1234)
  })

  it('🔴 路径逃逸 ⇒ disabled（不执行根外的程序）', async () => {
    const out = await evaluateCro(root, '../../evil', snapshotInput(), { runner: neverRun })
    expect(out.status).toBe('disabled')
  })

  it('🟢 端到端：真实 spawn 一个程序并拿到唤起决定', async () => {
    makeTrajectory(
      DIR_NAME,
      'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{' +
        'const o=JSON.parse(s);' +
        'const tooBig=(o.body.sessionMdBytes??0)>1000;' +
        'process.stdout.write(JSON.stringify(tooBig?{wake:true,prompt:"先整理",reason:"日志过大"}:{wake:false}))})\n',
    )
    const out = await evaluateCro(root, DIR_NAME, snapshotInput({ sessionMdBytes: 9999 }))
    expect(out.status).toBe('wake')
    if (out.status === 'wake') expect(out.prompt).toBe('先整理')
  }, 20_000)
})

describe('CRO: 人读摘要', () => {
  it('四态各有一行', () => {
    expect(renderCroOutcome('D', { status: 'disabled', detail: '未启用（无 x）' })).toContain('未启用')
    expect(renderCroOutcome('D', { status: 'skipped', detail: 'boom' })).toContain('跳过本轮')
    expect(renderCroOutcome('D', { status: 'no-wake', decision: { wake: false, prompt: null, reason: null }, detail: 'r' })).toContain('不唤起')
    expect(renderCroOutcome('D', { status: 'wake', decision: { wake: true, prompt: 'p', reason: null }, prompt: 'p', detail: 'r' })).toContain('唤起')
  })
})
