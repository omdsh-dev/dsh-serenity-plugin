import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// createUserMessage 只在打回时构造消息（宿主 llm 包不参与测试）
vi.mock('@deepseek-ai/dsh-llm', () => ({
  createUserMessage: (o: unknown) => o,
}))

import {
  WEIXIN_OUTPUT_REBUKE_MAX,
  buildManualOutputRebuke,
  clearSentThisTurn,
  forgetManualOutputSession,
  hasSentThisTurn,
  isManualOutputSession,
  isSuccessfulWeixinSend,
  isWeixinOutputGuardActive,
  noteManualOutputSession,
  registerWeixinOutputGuard,
  __resetWeixinOutputGuardForTest,
} from '../src/weixin-output-guard.js'

const SESSION = 'skiff-weixin-74b2a0609d13657b'
const MANUAL = { root: '/ccc/home-serenity', accountId: 'wechat-1', userId: 'u@im.wechat', role: 'zhaocai' }

/** 成功的 msm("weixin-send", …) 调用（宿主 ToolExecution 形状：name + arguments + agent） */
function sendExec(sessionId = SESSION, args: Record<string, unknown> = {}) {
  return { name: 'msm', arguments: { name: 'weixin-send', args: ['send', '--ccc', MANUAL.root], ...args }, agent: { session: { id: sessionId } } }
}

/** 其它工具调用（msm 但非 weixin-send / 完全别的工具） */
function otherExec(name: string, args: Record<string, unknown> = {}, sessionId = SESSION) {
  return { name, arguments: args, agent: { session: { id: sessionId } } }
}

function fakeAgent(id = SESSION) {
  const steers: string[] = []
  return {
    steers,
    agent: {
      id,
      session: { id },
      steer: (m: { content?: Array<{ type?: string; text?: string }> }) => {
        steers.push(m.content?.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n') ?? '')
      },
    },
  }
}

/**
 * fake ctx：捕获 `tools/post-execute` 与 `agent/turn-stopping` 两个订阅
 * （守卫只订阅这两个事件——替身镜像宿主契约，E-01 纪律）。
 */
function fakeCtx() {
  const handlers = new Map<string, (...a: unknown[]) => unknown>()
  const on = vi.fn((ev: string, cb: (...a: unknown[]) => unknown) => {
    handlers.set(ev, cb)
    return () => {}
  })
  return {
    ctx: { on },
    on,
    /** 触发一次工具执行（含 next 委托链） */
    async runTool(exec: unknown, result: unknown = { isError: false }): Promise<void> {
      const h = handlers.get('tools/post-execute')
      if (!h) throw new Error('tools/post-execute 未订阅')
      await h(exec, result, async () => ({ decision: 'allow' }))
    },
    /** 触发一次 turn 结束 */
    stopTurn(agent: unknown, turn = 1): void {
      handlers.get('agent/turn-stopping')?.({ agent, turn })
    },
    has: (ev: string) => handlers.has(ev),
  }
}

beforeEach(() => {
  __resetWeixinOutputGuardForTest()
})

afterEach(() => {
  __resetWeixinOutputGuardForTest()
  vi.restoreAllMocks()
})

describe('weixin-output-guard: 成功发送判定（isSuccessfulWeixinSend）', () => {
  it('msm + weixin-send + 无错误 → 计入', () => {
    expect(isSuccessfulWeixinSend(sendExec(), { isError: false })).toBe(true)
    expect(isSuccessfulWeixinSend(sendExec(), undefined)).toBe(true) // 宿主成功结果无 isError 字段时也算成功
  })

  it('msm + weixin-send 但调用失败（isError:true）→ 不计入（从未送达）', () => {
    expect(isSuccessfulWeixinSend(sendExec(), { isError: true })).toBe(false)
  })

  it('非 msm 工具 / msm 但别的 MSM → 不计入', () => {
    expect(isSuccessfulWeixinSend(otherExec('container_fs', { action: 'list' }), { isError: false })).toBe(false)
    expect(isSuccessfulWeixinSend(otherExec('msm', { name: 'weixin-doctor' }), { isError: false })).toBe(false)
  })

  it('形状异常（null/undefined/缺 arguments）→ 不计入且不抛错', () => {
    expect(isSuccessfulWeixinSend(null, { isError: false })).toBe(false)
    expect(isSuccessfulWeixinSend(undefined, undefined)).toBe(false)
    expect(isSuccessfulWeixinSend({ name: 'msm' }, { isError: false })).toBe(false)
  })
})

describe('weixin-output-guard: 登记与注销（桥侧接口）', () => {
  it('登记后可查；注销后不可查（幂等）', () => {
    noteManualOutputSession(SESSION, MANUAL)
    expect(isManualOutputSession(SESSION)).toBe(true)
    forgetManualOutputSession(SESSION)
    expect(isManualOutputSession(SESSION)).toBe(false)
    forgetManualOutputSession(SESSION) // 再次注销不抛错
    expect(isManualOutputSession(SESSION)).toBe(false)
  })

  it('空 / 非法 sessionId → 忽略（不写入状态）', () => {
    noteManualOutputSession('', MANUAL)
    noteManualOutputSession(undefined as unknown as string, MANUAL)
    expect(isManualOutputSession('')).toBe(false)
    expect(isManualOutputSession(undefined as unknown as string)).toBe(false)
  })
})

describe('weixin-output-guard: 打回文案（机制事实 + 标记，无纪律措辞）', () => {
  it('含标记 + 已填参数的完整命令（零解析负担）', () => {
    const msg = buildManualOutputRebuke(MANUAL)
    expect(msg).toContain('[serenity:weixin-manual-output]')
    expect(msg).toContain('msm("weixin-send"')
    expect(msg).toContain(`"--ccc", "${MANUAL.root}"`)
    expect(msg).toContain(`"--account", "${MANUAL.accountId}"`)
    expect(msg).toContain(`"--user", "${MANUAL.userId}"`)
    expect(msg).toContain('ccc=/ccc/home-serenity')
  })

  it('不含纪律措辞（v1.30.16 归属二分：措辞归 CCC 角色提示词）', () => {
    const msg = buildManualOutputRebuke(MANUAL)
    expect(msg).not.toContain('Reply Output')
    expect(msg).not.toContain('no fallback')
    expect(msg).not.toContain('MUST')
    expect(msg).not.toContain('你必须')
  })
})

describe('weixin-output-guard: 闸门接线（tools/post-execute + agent/turn-stopping）', () => {
  it('装配后订阅两个事件通道', () => {
    const f = fakeCtx()
    registerWeixinOutputGuard(f.ctx as never)
    expect(f.has('tools/post-execute')).toBe(true)
    expect(f.has('agent/turn-stopping')).toBe(true)
  })

  it('本轮成功发送 → 不打回；标记保留到桥读取（v1.30.17 起 turn-stopping 不再清空）', async () => {
    const f = fakeCtx()
    registerWeixinOutputGuard(f.ctx as never)
    noteManualOutputSession(SESSION, MANUAL)
    const { agent, steers } = fakeAgent()
    await f.runTool(sendExec(), { isError: false })
    expect(hasSentThisTurn(SESSION)).toBe(true)
    f.stopTurn(agent)
    expect(steers).toEqual([])
    // v1.30.17：闸门不清空——桥在 askSkiff 后读它决定是否兜底；清空由桥每轮开始执行
    expect(hasSentThisTurn(SESSION)).toBe(true)
    clearSentThisTurn(SESSION)
    expect(hasSentThisTurn(SESSION)).toBe(false)
  })

  it('闸门装配成功 → isWeixinOutputGuardActive() true（桥据此决定是否信任"未发送"判定）', () => {
    const f = fakeCtx()
    registerWeixinOutputGuard(f.ctx as never)
    expect(isWeixinOutputGuardActive()).toBe(true)
  })

  it('事件通道缺失 → 闸门未装配且 isWeixinOutputGuardActive() false（桥不兜底，防重复发送）', () => {
    __resetWeixinOutputGuardForTest()
    registerWeixinOutputGuard({ on: () => { throw new Error('no channel') } } as never)
    expect(isWeixinOutputGuardActive()).toBe(false)
  })

  it('本轮未发送 → steer 打回（含标记 + 已填命令）', () => {
    const f = fakeCtx()
    registerWeixinOutputGuard(f.ctx as never)
    noteManualOutputSession(SESSION, MANUAL)
    const { agent, steers } = fakeAgent()
    f.stopTurn(agent)
    expect(steers).toHaveLength(1)
    expect(steers[0]).toContain('[serenity:weixin-manual-output]')
    expect(steers[0]).toContain(`"--ccc", "${MANUAL.root}"`)
  })

  it('发送失败（isError:true）→ 仍打回（失败调用不算已送达）', async () => {
    const f = fakeCtx()
    registerWeixinOutputGuard(f.ctx as never)
    noteManualOutputSession(SESSION, MANUAL)
    const { agent, steers } = fakeAgent()
    await f.runTool(sendExec(), { isError: true })
    expect(hasSentThisTurn(SESSION)).toBe(false)
    f.stopTurn(agent)
    expect(steers).toHaveLength(1)
  })

  it('其它 MSM / 其它工具调用 → 不计入（只认 weixin-send）', async () => {
    const f = fakeCtx()
    registerWeixinOutputGuard(f.ctx as never)
    noteManualOutputSession(SESSION, MANUAL)
    const { agent, steers } = fakeAgent()
    await f.runTool(otherExec('msm', { name: 'weixin-doctor' }), { isError: false })
    await f.runTool(otherExec('container_fs', { action: 'list' }), { isError: false })
    expect(hasSentThisTurn(SESSION)).toBe(false)
    f.stopTurn(agent)
    expect(steers).toHaveLength(1)
  })

  it('连续未发送 → 打回至上限后放弃并响亮告警（不静默）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = fakeCtx()
    registerWeixinOutputGuard(f.ctx as never)
    noteManualOutputSession(SESSION, MANUAL)
    const { agent, steers } = fakeAgent()
    for (let i = 1; i <= WEIXIN_OUTPUT_REBUKE_MAX + 1; i++) f.stopTurn(agent, i)
    expect(steers).toHaveLength(WEIXIN_OUTPUT_REBUKE_MAX)
    expect(warn.mock.calls.some((c) => String(c[0]).includes('连续') && String(c[0]).includes('仍未发送'))).toBe(true)
  })

  it('打回计数在成功发送后清零（先失败后成功再失败 → 重新从 1 起）', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const f = fakeCtx()
    registerWeixinOutputGuard(f.ctx as never)
    noteManualOutputSession(SESSION, MANUAL)
    const { agent, steers } = fakeAgent()
    f.stopTurn(agent, 1) // 打回 1/2
    await f.runTool(sendExec(), { isError: false }) // 成功 → 计数清零
    f.stopTurn(agent, 2) // 本轮已发送 → 不打回
    clearSentThisTurn(SESSION) // v1.30.17：新的一轮由**桥**在轮开始清空标记
    f.stopTurn(agent, 3) // 新的一轮未发送 → 重新 1/2
    expect(steers).toHaveLength(2)
    expect(log.mock.calls.some((c) => String(c[0]).includes('打回 1/2'))).toBe(true)
  })

  it('未登记的手动模式之外会话 → 零干预（主舱 / 其它 skiff / ACP 临时会话）', async () => {
    const f = fakeCtx()
    registerWeixinOutputGuard(f.ctx as never)
    const { agent, steers } = fakeAgent('dsh-main-session')
    await f.runTool(sendExec('dsh-main-session'), { isError: false })
    f.stopTurn(agent)
    expect(steers).toEqual([])
    expect(hasSentThisTurn('dsh-main-session')).toBe(false) // 未登记会话不记状态
  })

  it('注销后闸门立即失效（配置切回自动回发 → 不再打回）', () => {
    const f = fakeCtx()
    registerWeixinOutputGuard(f.ctx as never)
    noteManualOutputSession(SESSION, MANUAL)
    forgetManualOutputSession(SESSION)
    const { agent, steers } = fakeAgent()
    f.stopTurn(agent)
    expect(steers).toEqual([])
  })

  it('agent 缺失 / 无会话 id → 零干预且不抛错', () => {
    const f = fakeCtx()
    registerWeixinOutputGuard(f.ctx as never)
    noteManualOutputSession(SESSION, MANUAL)
    f.stopTurn(undefined)
    f.stopTurn({}) // 无 id
    f.stopTurn({ session: {} })
  })

  it('事件通道缺失（旧宿主 / 测试替身）→ 响亮降级不抛错（apply 不可成为启动单点）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = { on: () => { throw new Error('no event channel') } }
    expect(() => registerWeixinOutputGuard(ctx as never)).not.toThrow()
    expect(warn.mock.calls.some((c) => String(c[0]).includes('weixin 输出闸门未装配'))).toBe(true)
  })
})
