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
  isSuccessfulImSend,
  isWeixinOutputGuardActive,
  noteManualOutputSession,
  registerWeixinOutputGuard,
  __resetWeixinOutputGuardForTest,
} from '../src/im/guard.js'

const SESSION = 'skiff-weixin-0123456789abcdef'
const MANUAL = { root: '/ccc/home-serenity', accountId: 'wechat-1', userId: 'u@im.wechat', role: 'my-role' }

/**
 * 成功的 im-bridge 调用（v1.31.0 主形态：ACC 工具，channel=weixin + action=send/send-file）
 *
 * @param turn 这个工具调用发生在**第几轮**。真机上它由会话事件序推出来
 *   （`guard.currentTurnOf` 的三级兜底），夹具里显式给 —— 因为"是哪一轮"正是本组要验的维度。
 */
function sendExec(sessionId = SESSION, args: Record<string, unknown> = {}, action = 'send', turn?: number) {
  return {
    name: 'im-bridge',
    arguments: { channel: 'weixin', action, user: MANUAL.userId, text: 'hi', ...args },
    ...(turn !== undefined ? { turn } : {}),
    agent: { session: { id: sessionId } },
  }
}

/** 兼容形态：v1.30.x 的 CCC MSM 通道（迁移期闸门同时认） */
function legacyMsmExec(sessionId = SESSION, turn?: number) {
  return {
    name: 'msm',
    arguments: { name: 'weixin-send', args: ['send', '--ccc', MANUAL.root] },
    ...(turn !== undefined ? { turn } : {}),
    agent: { session: { id: sessionId } },
  }
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

describe('weixin-output-guard: 成功发送判定（isSuccessfulImSend）', () => {
  it('im-bridge + channel=weixin + action=send / send-file + 无错误 → 计入', () => {
    expect(isSuccessfulImSend(sendExec(), { isError: false })).toBe(true)
    expect(isSuccessfulImSend(sendExec(SESSION, {}, 'send-file'), { isError: false })).toBe(true)
    expect(isSuccessfulImSend(sendExec(), undefined)).toBe(true) // 宿主成功结果无 isError 字段时也算成功
  })

  it('兼容形态 msm("weixin-send") 仍计入（迁移期并存，逐步退役）', () => {
    expect(isSuccessfulImSend(legacyMsmExec(), { isError: false })).toBe(true)
  })

  it('调用失败（isError:true）→ 不计入（从未送达）', () => {
    expect(isSuccessfulImSend(sendExec(), { isError: true })).toBe(false)
    expect(isSuccessfulImSend(legacyMsmExec(), { isError: true })).toBe(false)
  })

  it('im-bridge 但别的通道 / 别的动作（users/status）→ 不计入', () => {
    expect(isSuccessfulImSend(sendExec(SESSION, { channel: 'other' }), { isError: false })).toBe(false)
    expect(isSuccessfulImSend(sendExec(SESSION, {}, 'users'), { isError: false })).toBe(false)
    expect(isSuccessfulImSend(sendExec(SESSION, {}, 'status'), { isError: false })).toBe(false)
  })

  it('🔴 飞书渠道：`channel:"feishu"` 的成功发送**要计入**（Q4 的反向钉）', () => {
    // 旧实现硬比 `channel !== 'weixin' ⇒ false` ⇒ 飞书会话**永远**被判"未发送"
    // ⇒ 打回 ≤2 次；若 CCC 开了 fallbackOnNoSend 还会再兜底转发一遍 = **重复投递**。
    const feishuExec = { name: 'im-bridge', arguments: { channel: 'feishu', action: 'send', user: 'ou_x', text: 'hi' }, agent: { session: { id: SESSION } } }
    expect(isSuccessfulImSend(feishuExec, { isError: false }, 'feishu')).toBe(true)
    // 通道不匹配两个方向都不成立（不因为"给了 channel 参数"就放宽）
    expect(isSuccessfulImSend(feishuExec, { isError: false }, 'weixin')).toBe(false)
    expect(isSuccessfulImSend(sendExec(), { isError: false }, 'feishu')).toBe(false)
  })

  it('🔴 旧 MSM 形态只对微信渠道成立（飞书从来没有过 weixin-send 这个 MSM）', () => {
    expect(isSuccessfulImSend(legacyMsmExec(), { isError: false }, 'weixin')).toBe(true)
    expect(isSuccessfulImSend(legacyMsmExec(), { isError: false }, 'feishu')).toBe(false)
  })

  it('非目标工具 / msm 但别的 MSM → 不计入', () => {
    expect(isSuccessfulImSend(otherExec('container_fs', { action: 'list' }), { isError: false })).toBe(false)
    expect(isSuccessfulImSend(otherExec('msm', { name: 'weixin-doctor' }), { isError: false })).toBe(false)
  })

  it('形状异常（null/undefined/缺 arguments）→ 不计入且不抛错', () => {
    expect(isSuccessfulImSend(null, { isError: false })).toBe(false)
    expect(isSuccessfulImSend(undefined, undefined)).toBe(false)
    expect(isSuccessfulImSend({ name: 'msm' }, { isError: false })).toBe(false)
    expect(isSuccessfulImSend({ name: 'im-bridge' }, { isError: false })).toBe(false)
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
    expect(msg).toContain('im-bridge({channel:"weixin", action:"send"')
    expect(msg).toContain(`account:"${MANUAL.accountId}"`)
    expect(msg).toContain(`user:"${MANUAL.userId}"`)
    expect(msg).toContain('ccc=/ccc/home-serenity')
    expect(msg).not.toContain('--ccc') // v1.31.0：工具只能操作本会话 CCC → 命令里不再有目标 CCC 参数
  })

  it('不含纪律措辞（v1.30.16 归属二分：措辞归 CCC 角色提示词）', () => {
    const msg = buildManualOutputRebuke(MANUAL)
    expect(msg).not.toContain('Reply Output')
    expect(msg).not.toContain('no fallback')
    expect(msg).not.toContain('MUST')
    expect(msg).not.toContain('你必须')
  })

  it('🔴 飞书会话的打回文案写的是 `channel:"feishu"`（不是写死的 weixin）', () => {
    const msg = buildManualOutputRebuke({ ...MANUAL, channel: 'feishu' })
    expect(msg).toContain('im-bridge({channel:"feishu", action:"send"')
    expect(msg).not.toContain('channel:"weixin"')
    // 事实行也带上渠道（排查时要一眼看出是哪条渠道没发出去）
    expect(msg).toContain('channel=feishu')
  })

  it('未给渠道 ⇒ 文案仍是 weixin（既有调用点读数不变）', () => {
    const msg = buildManualOutputRebuke(MANUAL)
    expect(msg).toContain('im-bridge({channel:"weixin", action:"send"')
    expect(msg).toContain('channel=weixin')
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
    // v1.30.17：闸门不清空——桥在 askTrajectory 后读它决定是否兜底；清空由桥每轮开始执行
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
    expect(steers[0]).toContain('im-bridge({channel:"weixin", action:"send"')
    expect(steers[0]).toContain(`user:"${MANUAL.userId}"`)
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

  /**
   * 🔴 **本组的靶子是真故障**（2026-10-21 真机："同一条消息被处理两轮"）。
   *
   * 现场时刻线：`12:08:25 发送成功 → 12:08:56 新入站 → 12:09:19 那一轮 turn-stopping`。
   * 旧实现：入站到达时 `clearSentThisTurn` 把**正在跑那一轮**的证据抹掉 ⇒ 判"没发" ⇒ 打回 ⇒ 重答。
   * ⇒ 用户看到"同一条消息处理了两轮"。
   *
   * 新契约：记账按**轮号**；陈旧记录靠"轮号不等"淘汰，**不再有清空动作**。
   */
  it('🔴 回归钉：同一轮内"发送成功 → 新入站 → turn-stopping" ⇒ **不得打回**', async () => {
    const f = fakeCtx()
    registerWeixinOutputGuard(f.ctx as never)
    noteManualOutputSession(SESSION, MANUAL)
    const { agent, steers } = fakeAgent()

    await f.runTool(sendExec(SESSION, {}, 'send', 7), { isError: false })   // turn 7 里发出的
    // 桥侧现在**不再清空**（旧实现会在这里把标记抹掉 —— 那就是缺陷本身）
    f.stopTurn(agent, 7)                              // 同一轮收尾
    expect(steers, '本轮确实发过，不许打回').toHaveLength(0)
  })

  it('🔴 反向钉：上一轮发的 **不能**顶替这一轮（跨轮必须重新发）', async () => {
    const f = fakeCtx()
    registerWeixinOutputGuard(f.ctx as never)
    noteManualOutputSession(SESSION, MANUAL)
    const { agent, steers } = fakeAgent()
    // 模拟"turn 7 发过、turn 8 没发" ⇒ 必须打回（否则就退化成"发一次管一辈子"）
    await f.runTool(sendExec(SESSION, {}, 'send', 7), { isError: false })
    f.stopTurn(agent, 8)
    expect(steers, 'turn 8 没发过，必须打回').toHaveLength(1)
  })

  it('取不到轮号时**偏向"发过"**（少打回，绝不误打回）', async () => {
    const f = fakeCtx()
    registerWeixinOutputGuard(f.ctx as never)
    noteManualOutputSession(SESSION, MANUAL)
    const { agent, steers } = fakeAgent()
    // exec 上没有 turn、session 里也没有 turn/start ⇒ 记成 null（"不知道是哪一轮"）
    await f.runTool(sendExec(), { isError: false })
    expect(hasSentThisTurn(SESSION, null), '任一侧取不到轮号 ⇒ 判"发过"').toBe(true)
    f.stopTurn(agent, null as unknown as number)
    expect(steers, '取不到轮号不许打回').toHaveLength(0)
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

  it('未登记的手动模式之外会话 → 零干预（主舱 / 其它 轨迹约束 / ACP 临时会话）', async () => {
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
