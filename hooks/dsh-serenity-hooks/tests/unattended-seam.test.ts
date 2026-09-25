import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('@deepseek-ai/dsh-llm', () => ({
  createUserMessage: (o: unknown) => o,
}))

vi.mock('@deepseek-ai/schemastery', () => {
  const chain: unknown = new Proxy(function () {}, {
    get: (_t, prop) => {
      if (prop === Symbol.toPrimitive) return () => ''
      if (prop === 'valueOf') return () => 0
      if (prop === 'toString') return () => ''
      return chain
    },
    apply: () => chain,
  })
  return { default: { object: (s: unknown) => s, array: () => chain, string: () => chain, boolean: () => chain, number: () => chain } }
})

vi.mock('@deepseek-ai/dsh-settings', () => ({
  installSettingsSection: () => {},
  settingsNamespace: (v: string) => v,
}))

import { registerUnattendedSeam } from '../src/unattended-seam.js'
import { defaultSimpleSettings, __setSimpleSourceForTest } from '../src/settings-section.js'
import { appendBound } from '../src/trajectory-bound.js'
import {
  UNATTENDED_MAX_ROUNDS,
  __resetUnattendedForTest,
  doneToken,
  getProxyRun,
  hasOutboundSendSince,
  isUserTurn,
  loadUnattendedLog,
  noteOutboundSend,
  parseDoneNonces,
  setProxyRun,
} from '../src/unattended-ops.js'
import { CRO_FILENAME } from '../src/cro.js'

/**
 * unattended-seam 镜像测试（S142 **D77**，2026-09-23）。
 *
 * 覆盖：闸门 ｜**「本轮是否由真实用户发起」判据**（`agent/inbox/claimed` + `source.kind`）｜
 * 排除面（外部面/桥/worker/子代理/非 CCC）｜CRO 轨迹让位 ｜注入 → 回码放过 → 旧码不算 →
 * 撞轮上限 ｜假完成打回（无发送记录）｜**用户回来即让位** ｜载体销毁清表 ｜流水落盘。
 */

let dir = ''
const DIR_NAME = '2026-09-23--S142--fake'
const SESSION_ID = 'dsh-unattended-test'

/** 建一个 CCC 目录（`.serenity` 存在 = `cccRootForCwd` 认它） */
function makeCcc(extra = ''): string {
  const root = mkdtempSync(join(tmpdir(), 'unattended-seam-'))
  writeFileSync(join(root, '.serenity'), 'demo')
  if (extra) mkdirSync(join(root, extra), { recursive: true })
  return root
}

interface Harness {
  steers: string[]
  agent: { id: string; session: { id: string; header: Record<string, unknown>; events: unknown[] }; steer: (m: unknown) => void }
  claims: (opts?: { kind?: string; turn?: number }) => void
  stop: (turn: number) => void
  disposeAgent: () => void
  disposeSession: (id: string) => void
}

/** 装配替身 ctx：捕获四路事件，暴露触发入口 */
function harness(sessionId = SESSION_ID, agentId = 'agent-1'): Harness {
  const steers: string[] = []
  const handlers = new Map<string, (p: unknown) => void>()
  const ctx = {
    on: (event: string, cb: (p: unknown) => void) => {
      handlers.set(event, cb)
      return () => {}
    },
    effect: (_cb: () => () => void) => () => {},
  }
  registerUnattendedSeam(ctx as never)
  const agent = {
    id: agentId,
    session: { id: sessionId, header: { cwd: dir, id: sessionId, delegationDepth: 0 } as Record<string, unknown>, events: [] as unknown[] },
    steer: (m: unknown) => {
      const content = (m as { content?: Array<{ type?: string; text?: string }> }).content ?? []
      steers.push(content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n'))
    },
  }
  return {
    steers,
    agent,
    claims: (opts = {}) => {
      handlers.get('agent/inbox/claimed')?.({
        agent,
        message: { source: { kind: opts.kind ?? 'user' } },
        turn: opts.turn ?? 1,
      })
    },
    stop: (turn: number) => handlers.get('agent/turn-stopping')?.({ agent, turn }),
    disposeAgent: () => handlers.get('agent/disposed')?.({ agent }),
    disposeSession: (id: string) => handlers.get('session/disposed')?.({ id }),
  }
}

/** 让 agent 的"最后一条 assistant 文本"变成 text（seam 经 sessionEvents 读它） */
function say(h: Harness, text: string): void {
  h.agent.session.events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
}

/** 绑定替身会话到轨迹目录（流水才有落点） */
function bind(h: Harness, dirName = DIR_NAME): void {
  appendBound(h.agent.session, 'activate', {
    dirName,
    mdPath: join(dir, 'AGENT_SESSIONS', dirName, 'SESSION.md'),
    sessionId: 'S142',
  })
}

function enable(on: boolean): void {
  __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), unattendedEnabled: on }))
}

beforeEach(() => {
  __resetUnattendedForTest()
  dir = makeCcc('AGENT_SESSIONS')
  enable(true)
})

afterEach(() => {
  __resetUnattendedForTest()
  __setSimpleSourceForTest(null)
  rmSync(dir, { recursive: true, force: true })
})

describe('unattended-seam: 前置门（闸 / 空间 / 会话资格）', () => {
  it('总闸关（缺省）⇒ 一轮都不注入', () => {
    enable(false)
    const h = harness()
    say(h, '我先停一下。')
    h.stop(1)
    expect(h.steers).toEqual([])
  })

  it('非 CCC 目录 ⇒ 零干预', () => {
    const outside = mkdtempSync(join(tmpdir(), 'unattended-outside-'))
    const h = harness()
    h.agent.session.header.cwd = outside
    say(h, '停一下')
    h.stop(1)
    expect(h.steers).toEqual([])
    rmSync(outside, { recursive: true, force: true })
  })

  it('子代理（delegationDepth > 0）⇒ 不代理（只看主会话）', () => {
    const h = harness()
    h.agent.session.header.delegationDepth = 1
    say(h, '停一下')
    h.stop(1)
    expect(h.steers).toEqual([])
  })

  it('外部面 / 桥 / worker 会话 ⇒ **写死不许开**（替家人说话 = 冒充）', () => {
    for (const sid of ['skiff-weixin-abc', 'acp-1', 'handyman-w1']) {
      const h = harness(sid)
      say(h, '停一下')
      h.stop(1)
      expect(h.steers, `${sid} 不该被代理`).toEqual([])
    }
  })
})

describe('unattended-seam: 「本轮是否由真实用户发起」的判据', () => {
  it('真实用户发起（source.kind=user）⇒ 人在场 ⇒ 不代理', () => {
    const h = harness()
    h.claims({ kind: 'user', turn: 4 })
    say(h, '请确认一下')
    h.stop(4)
    expect(h.steers).toEqual([])
  })

  it('插件注入的轮（唤醒 / send-later / keeper ⇒ source.kind=plugin）⇒ **不是**用户在场 ⇒ 注入第 1 轮', () => {
    const h = harness()
    h.claims({ kind: 'plugin', turn: 7 })
    say(h, '这轮由唤醒发起，先停一下。')
    h.stop(7)
    expect(h.steers).toHaveLength(1)
    expect(h.steers[0]).toContain('[[UNATTENDED-PROXY v1]]')
    expect(h.steers[0]).toContain('round=1/')
  })

  it('🔴 轮号必须逐轮比对：用户发起的第 4 轮不影响第 5 轮（唤醒轮仍受管）', () => {
    const h = harness()
    h.claims({ kind: 'user', turn: 4 })
    say(h, '第 4 轮')
    h.stop(4)
    expect(h.steers).toEqual([])
    h.claims({ kind: 'plugin', turn: 5 })
    say(h, '第 5 轮由唤醒发起')
    h.stop(5)
    expect(h.steers).toHaveLength(1)
  })

  it('turn 取不到 ⇒ 保守视为用户发起（宁可不动）', () => {
    const h = harness()
    say(h, '停一下')
    ;(h as unknown as { stop: (t: unknown) => void }).stop(undefined)
    expect(h.steers).toEqual([])
  })
})

describe('unattended-seam: 单一续驱者（CRO 程序在场 ⇒ 让位）', () => {
  it('该轨迹目录下有 `continuous-re-occurrence.ts` ⇒ 不代理（窄口径唯一排除项）', () => {
    const h = harness()
    bind(h)
    mkdirSync(join(dir, 'AGENT_SESSIONS', DIR_NAME), { recursive: true })
    writeFileSync(join(dir, 'AGENT_SESSIONS', DIR_NAME, CRO_FILENAME), '// cro program')
    say(h, '停一下')
    h.stop(1)
    expect(h.steers).toEqual([])
  })

  it('无 CRO 文件（同一条轨迹）⇒ 照常代理', () => {
    const h = harness()
    bind(h)
    say(h, '停一下')
    h.stop(1)
    expect(h.steers).toHaveLength(1)
  })
})

describe('unattended-seam: 验证码回路（注入 → 放过 / 旧码不算 / 撞上限）', () => {
  it('注入后回**当前轮**那枚码 ⇒ 放过（不再 steer），代理段清空', () => {
    const h = harness()
    say(h, '先停')
    h.stop(1)
    expect(h.steers).toHaveLength(1)
    const nonce = parseDoneNonces(h.steers[0] ?? '')[0]
    expect(nonce).toBeTruthy()
    expect(getProxyRun(SESSION_ID)?.nonce).toBe(nonce)
    say(h, `做完了 [[UNATTENDED-DONE:${nonce}]]`)
    h.stop(2)
    expect(h.steers).toHaveLength(1) // 没有第二次注入
    expect(getProxyRun(SESSION_ID)).toBeNull()
  })

  it('回**上一轮的旧码** ⇒ 不算合法收束 ⇒ 注入下一轮（且新消息明写"旧码一律作废"）', () => {
    const h = harness()
    say(h, '先停')
    h.stop(1) // 第 1 轮：N1
    const stale = parseDoneNonces(h.steers[0] ?? '')[0] ?? ''
    say(h, '还没做完')
    h.stop(2) // 第 2 轮：N2（N1 已作废）
    expect(h.steers).toHaveLength(2)
    say(h, `[[UNATTENDED-DONE:${stale}]]`) // 交的是 N1
    h.stop(3)
    expect(h.steers).toHaveLength(3)
    expect(h.steers[2]).toContain('round=3/')
    expect(h.steers[2]).toContain('旧码一律作废')
    expect(getProxyRun(SESSION_ID)?.round).toBe(3)
  })

  it('一直不回码 ⇒ 撞轮上限停下（不再注入，退回改造前行为）', () => {
    const h = harness()
    say(h, '先停')
    // 首轮 + 每轮一次 steer；注入到第 MAX 轮后再停一次 ⇒ cap
    for (let i = 0; i < UNATTENDED_MAX_ROUNDS; i++) {
      h.stop(i + 1)
      say(h, `第 ${i + 1} 轮还没做完`)
    }
    h.stop(UNATTENDED_MAX_ROUNDS + 1)
    expect(h.steers).toHaveLength(UNATTENDED_MAX_ROUNDS)
    expect(getProxyRun(SESSION_ID)).toBeNull()
  })

  it('steer 抛错 ⇒ 不抛、清代理段（不留悬挂）', () => {
    const h = harness()
    h.agent.steer = () => {
      throw new Error('steer boom')
    }
    say(h, '先停')
    expect(() => h.stop(1)).not.toThrow()
    expect(getProxyRun(SESSION_ID)).toBeNull()
  })
})

describe('unattended-seam: 假完成核验（设计 §7 —— 声称已通知用户必须真有发送记录）', () => {
  it('交码 + 声称已通知 + **无发送记录** ⇒ 不算收束，注入一轮打回', () => {
    const h = harness()
    say(h, '先停')
    h.stop(1)
    const nonce = parseDoneNonces(h.steers[0] ?? '')[0] ?? ''
    say(h, `我已经发微信通知用户了 [[UNATTENDED-DONE:${nonce}]]`)
    h.stop(2)
    expect(h.steers).toHaveLength(2)
    expect(h.steers[1]).toContain('查不到任何发送记录')
    expect(h.steers[1]).toContain('round=2/')
  })

  it('**真有**发送记录（im-bridge 成功发送记的账）⇒ 放过', () => {
    const h = harness()
    say(h, '先停')
    h.stop(1)
    const nonce = parseDoneNonces(h.steers[0] ?? '')[0] ?? ''
    noteOutboundSend(dir)
    expect(hasOutboundSendSince(dir, 0)).toBe(true)
    say(h, `我已经发微信通知用户了 [[UNATTENDED-DONE:${nonce}]]`)
    h.stop(2)
    expect(h.steers).toHaveLength(1)
    expect(getProxyRun(SESSION_ID)).toBeNull()
  })
})

describe('unattended-seam: 让位与清理', () => {
  it('🔴 代理进行中**用户回来了** ⇒ 立刻让位（清代理段 + 记 yield 流水）', () => {
    const h = harness()
    bind(h)
    say(h, '先停')
    h.stop(1)
    expect(getProxyRun(SESSION_ID)).not.toBeNull()
    h.claims({ kind: 'user', turn: 2 })
    expect(getProxyRun(SESSION_ID)).toBeNull()
    const { log } = loadUnattendedLog(dir, DIR_NAME)
    expect(log.entries.map((e) => e.event)).toEqual(['inject', 'yield'])
    // 用户这一轮本身也不会被代理
    say(h, '我回来了')
    h.stop(2)
    expect(h.steers).toHaveLength(1)
  })

  it('载体销毁（agent/disposed 与 session/disposed）⇒ 清表（防"按载体只增"）', () => {
    const h = harness()
    say(h, '先停')
    h.stop(1)
    expect(getProxyRun(SESSION_ID)).not.toBeNull()
    h.disposeAgent()
    expect(getProxyRun(SESSION_ID)).toBeNull()

    say(h, '再停')
    h.stop(3)
    expect(getProxyRun(SESSION_ID)).not.toBeNull()
    h.disposeSession(SESSION_ID)
    expect(getProxyRun(SESSION_ID)).toBeNull()
  })

  it('流水落盘：绑定轨迹 ⇒ 写进 `<轨迹目录>/unattended-log.json`（机制事实，非散文）', () => {
    const h = harness()
    bind(h)
    say(h, '先停')
    h.stop(1)
    const { log, error } = loadUnattendedLog(dir, DIR_NAME)
    expect(error).toBeNull()
    expect(log.entries).toHaveLength(1)
    expect(log.entries[0]).toMatchObject({ event: 'inject', round: 1, reason: 'first-stop', sessionId: SESSION_ID })
    expect(log.entries[0]?.nonce).toMatch(/^[0-9a-f]{16}$/)
  })

  it('未绑定轨迹 ⇒ 无落点也不抛（机制照常工作）', () => {
    const h = harness()
    say(h, '先停')
    expect(() => h.stop(1)).not.toThrow()
    expect(h.steers).toHaveLength(1)
  })

  it('注入消息里那枚码就是代理段的当前码（`doneToken` 一致性）', () => {
    const h = harness()
    say(h, '先停')
    h.stop(1)
    const run = getProxyRun(SESSION_ID)
    expect(h.steers[0]).toContain(doneToken(run?.nonce ?? ''))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 🆕 2026-09-25 ⑤ 第 30 件：`unattended-seam.ts` 的**装配面 / 守卫面 / 清理面**
//
// 挑靶依据 = **先逐行读覆盖率报告的 `cstat-no`/`cbranch-no` 判可达性**（别按 branch% 排序硬上）。
// 本件残余的性质 = **三条 handler 的守卫与 catch ＋ 装配 catch ＋ 卸载 disposer** —— 都是
// 「失败不得影响 turn 收尾」「防按载体只增」这两条**铁律**的落点，不是纯防御性 `??`。
// 🔴 失败形态一律真实：宿主形态的**抛错 getter**（同 §2.7k 的 `authenticatedUrl`）／
//    **tmp 路径被占成目录**（同 §2.7n 的手法）—— **不用 mock**。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 自建装配替身：**暴露事件处理器表与 effect 回调**。
 * （上方 `harness()` 把二者都吞掉了 ⇒ 驱动不了"畸形 payload"与"卸载"两类形态。）
 */
function seamRig(): {
  handlers: Map<string, (p: unknown) => void>
  effects: Array<() => () => void>
  fire: (event: string, payload?: unknown) => void
} {
  const handlers = new Map<string, (p: unknown) => void>()
  const effects: Array<() => () => void> = []
  registerUnattendedSeam({
    on: (e: string, cb: (p: unknown) => void) => {
      handlers.set(e, cb)
    },
    effect: (cb: () => () => void) => {
      effects.push(cb)
    },
  } as never)
  return { handlers, effects, fire: (event, payload) => handlers.get(event)?.(payload) }
}

/** 极简 agent 替身：`session` 可整个畸形／省字段（驱动守卫面），并收集 steer 正文 */
function bareAgent(session: unknown, steers: string[] = []): { session: unknown; steer: (m: unknown) => void } {
  return {
    session,
    steer: (m: unknown) => {
      const content = (m as { content?: Array<{ type?: string; text?: string }> }).content ?? []
      steers.push(content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n'))
    },
  }
}

/** 捕获 console.log（本块多处判据 = "是否**如实**记了一行"） */
function captureLog(fn: () => void): string[] {
  const logs: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.join(' '))
  })
  try {
    fn()
  } finally {
    spy.mockRestore()
  }
  return logs
}

describe('unattended-seam: 装配面 / 守卫面 / 清理面（⑤ 第 30 件）', () => {
  it('① 装配面：`ctx.on` 不可用 ⇒ 不抛，且**四个事件各自响亮降级**（装配不可成为启动单点）', () => {
    const logs = captureLog(() => {
      expect(() => registerUnattendedSeam({} as never)).not.toThrow()
    })
    expect(logs.filter((l) => l.includes('无人值守代理未装配')), '四条订阅各自如实记一行').toHaveLength(4)
  })

  it('② turn-stopping 守卫：载体 id 取不到 ⇒ 短路（正控：只把 id 换成合法串 ⇒ 照常注入）', () => {
    const rig = seamRig()
    const bad: string[] = []
    rig.fire('agent/turn-stopping', {
      agent: bareAgent({ id: 42, header: { cwd: dir, delegationDepth: 0 }, events: [] }, bad),
      turn: 1,
    })
    expect(bad, 'id 非串 ⇒ 短路在"取事实"之前').toHaveLength(0)

    const good: string[] = []
    rig.fire('agent/turn-stopping', {
      agent: bareAgent({ id: SESSION_ID, header: { cwd: dir, delegationDepth: 0 }, events: [] }, good),
      turn: 1,
    })
    expect(good, '正控：同一条链、只换 id ⇒ 真注入').toHaveLength(1)
  })

  it('③ turn-stopping：payload 里没有 agent ⇒ 直接返回（不抛、不注入）', () => {
    const rig = seamRig()
    expect(() => rig.fire('agent/turn-stopping', {})).not.toThrow()
    expect(() => rig.fire('agent/turn-stopping', undefined)).not.toThrow()
  })

  it('④ `delegationDepth` 缺省 ⇒ 视为主会话（仍注入）；显式子代理 ⇒ 不代理（对照）', () => {
    const rig = seamRig()
    const main: string[] = []
    rig.fire('agent/turn-stopping', { agent: bareAgent({ id: SESSION_ID, header: { cwd: dir }, events: [] }, main), turn: 1 })
    expect(main, '缺省 0 = 主会话').toHaveLength(1)

    const sub: string[] = []
    rig.fire('agent/turn-stopping', { agent: bareAgent({ id: `${SESSION_ID}-sub`, header: { cwd: dir, delegationDepth: 2 }, events: [] }, sub), turn: 1 })
    expect(sub, '子代理不代理').toHaveLength(0)
  })

  it('⑤ turn-stopping：处置内部抛错 ⇒ 吞掉并记一行（**turn 收尾不可被本机制影响**）', () => {
    const rig = seamRig()
    const bad = {
      get session(): never {
        throw new Error('session getter boom')
      },
      steer: () => {},
    }
    const logs = captureLog(() => {
      expect(() => rig.fire('agent/turn-stopping', { agent: bad, turn: 1 })).not.toThrow()
    })
    expect(logs.some((l) => l.includes('turn-stopping 处置失败（已忽略）'))).toBe(true)
  })

  it('⑥ claimed 守卫：载体 id 取不到 ⇒ 直接返回；`turn` 非数字 ⇒ 记作 **-1**（用户在场信号不丢）', () => {
    const rig = seamRig()
    rig.fire('agent/inbox/claimed', { agent: bareAgent({ id: 42 }), message: { source: { kind: 'user' } }, turn: 3 })
    expect(isUserTurn('', -1), 'id 取不到 ⇒ 什么都没记').toBe(false)

    rig.fire('agent/inbox/claimed', { agent: bareAgent({ id: SESSION_ID }), message: { source: { kind: 'user' } } })
    expect(isUserTurn(SESSION_ID, -1), 'turn 缺省 ⇒ 记 -1，而不是"当没发生"').toBe(true)
  })

  it('⑦ `header.cwd` 取不到 ⇒ 回落 `process.cwd()`（让位照常发生，不因缺 cwd 卡住）', () => {
    const rig = seamRig()
    setProxyRun(SESSION_ID, { round: 1, nonce: 'abc123', startedAt: Date.now() })
    expect(getProxyRun(SESSION_ID)).not.toBeNull()
    // 🔴 刻意**不绑定轨迹** ⇒ 下面那条 I/O 路径无落点、只回 false（不把测试写进真 CCC）
    expect(() =>
      rig.fire('agent/inbox/claimed', { agent: bareAgent({ id: SESSION_ID, events: [] }), message: { source: { kind: 'user' } }, turn: 5 }),
    ).not.toThrow()
    expect(getProxyRun(SESSION_ID), '用户回来 ⇒ 让位（清代理段）').toBeNull()
  })

  it('⑧ claimed：观察内部抛错 ⇒ 吞掉并记一行（不干扰宿主事件链）', () => {
    const rig = seamRig()
    const bad = {
      get session(): never {
        throw new Error('claimed boom')
      },
    }
    const logs = captureLog(() => {
      expect(() => rig.fire('agent/inbox/claimed', { agent: bad, message: { source: { kind: 'user' } }, turn: 1 })).not.toThrow()
    })
    expect(logs.some((l) => l.includes('claimed 观察失败'))).toBe(true)
  })

  it('⑨ 两条 disposed 在 id 缺失/畸形时直接返回 —— 且**不得误清别的载体**', () => {
    const rig = seamRig()
    setProxyRun(SESSION_ID, { round: 2, nonce: 'beef', startedAt: Date.now() })
    expect(() => rig.fire('agent/disposed', { agent: bareAgent({ id: 42 }) })).not.toThrow()
    expect(() => rig.fire('agent/disposed', {})).not.toThrow()
    expect(() => rig.fire('session/disposed', {})).not.toThrow()
    expect(() => rig.fire('session/disposed', { id: '' })).not.toThrow()
    expect(() => rig.fire('session/disposed', { id: 7 })).not.toThrow()
    expect(getProxyRun(SESSION_ID), '畸形 id 不得误清别的载体').not.toBeNull()
  })

  it('⑩ 卸载（disposer）⇒ 清**两张**进程内表（"按载体只增"的卸载面）', () => {
    const rig = seamRig()
    // 🔵 先记用户轮次（此刻**还没有**代理段 ⇒ 不触发让位）；再开代理段
    //    （⚠️ 反过来写就测不到了：`claimed` 一旦发现 run 存在会**当场让位清掉它** —— 见 ⑩ 首跑红）
    rig.fire('agent/inbox/claimed', { agent: bareAgent({ id: SESSION_ID }), message: { source: { kind: 'user' } } })
    setProxyRun(SESSION_ID, { round: 2, nonce: 'deadbeef', startedAt: Date.now() })
    expect(getProxyRun(SESSION_ID)).not.toBeNull()
    expect(isUserTurn(SESSION_ID, -1)).toBe(true)

    expect(rig.effects, '装配时登记了一个 disposer').toHaveLength(1)
    rig.effects[0]!()() // 宿主在 fiber 销毁时执行的那一次
    expect(getProxyRun(SESSION_ID)).toBeNull()
    expect(isUserTurn(SESSION_ID, -1), '用户轮次表同样清空').toBe(false)
  })

  it('⑪ 流水落盘失败（tmp 被占成目录）⇒ 如实记一行，且**机制本体照常**（打回已发生）', () => {
    const h = harness()
    bind(h)
    say(h, '先停')
    const logPath = join(dir, 'AGENT_SESSIONS', DIR_NAME, 'unattended-log.json')
    mkdirSync(`${logPath}.tmp`, { recursive: true }) // 真实故障形态：写 tmp 必 EISDIR
    const logs = captureLog(() => {
      h.stop(1)
    })
    expect(h.steers, '落盘失败不得影响机制本体').toHaveLength(1)
    expect(logs.some((l) => l.includes('流水未落盘'))).toBe(true)
  })
})
