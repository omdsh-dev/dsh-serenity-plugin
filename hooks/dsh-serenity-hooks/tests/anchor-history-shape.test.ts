/**
 * anchor-history-shape.test.ts — first-anchor「造历史」形状判据
 *
 * ## 它回答什么问题
 *
 * 锚定历史**该造成什么形状**？—— 判据不是我们的推断，而是**宿主自己的**
 * `assertReleasedV4Relationships()`。探针只负责喂形状，判词由宿主给。
 *
 * ## 为什么必须直接调宿主（D141 / D119）
 *
 * D140 当初把「不能代写 assistant/message」的**理由**记成「它在 `STEP_EVENT_TYPES` 里」。
 * 实测源码：`STEP_EVENT_TYPES` = { system/message, developer/message, assistant/attempt }
 * —— **`assistant/message` 不在其中**。它仍要 `requireStep`，但走的是另一条路
 * （`Relationships.accept()` 的 `case "assistant/message"` → `tool()` → `requireStep`）。
 * ⇒ **结论对、理由错**。这类"理由错"最危险：它会让后续修复朝错误方向走
 *   （比如以为"只要不写 assistant 就安全"，而真正的约束是 turn/step 是否打开）。
 *
 * ## 本轮要判的三件事
 *
 *   S1  只造 `user/message`（现状 A 形）—— 宿主接不接受
 *   S2  `user` ＋ `assistant` 交替（B 形），落在**当前打开的** turn/step 内
 *   S3  `assistant` 落在**未打开**的 turn/step 上（负控：必须被拒）
 *
 * ## 隐私门（D145）
 *
 * 本文件不写真实家目录 / 私有 CCC 名；宿主安装位置由 `os.homedir()` 推导。
 */
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { appendAnchorHistory } from '../src/seams/bootstrap.js'

type Event = { type: string; seq: number; time: number; data?: unknown; surfaceOp?: unknown }
type Validator = (artifact: unknown, known: Set<string>) => void

/**
 * 解析宿主的格式校验器。
 *
 * 🔴 读数器先自证（判据纪律）：解析不到 ⇒ 明确 skip 并说清原因，
 *    ⛔ 不许让它以"形状合法"的面目出现。
 */
function loadHostValidator(): { validate?: Validator; why?: string } {
  const candidates = [
    join(homedir(), '.npm-global/lib/node_modules/@deepseek-ai/dsh/package.json'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json',
    join(process.cwd(), 'node_modules/@deepseek-ai/dsh/package.json'),
  ]
  const tried: string[] = []
  for (const pkg of candidates) {
    if (!existsSync(pkg)) {
      tried.push(`${pkg}（不存在）`)
      continue
    }
    try {
      const req = createRequire(pkg)
      const fmt = req('@deepseek-ai/dsh-session-format-v3-to-v4') as {
        assertReleasedV4Relationships?: Validator
      }
      if (typeof fmt?.assertReleasedV4Relationships === 'function') {
        return { validate: fmt.assertReleasedV4Relationships }
      }
      tried.push(`${pkg}（模块在、但缺 assertReleasedV4Relationships）`)
    } catch (error) {
      tried.push(`${pkg}（${String((error as Error)?.message ?? error)}）`)
    }
  }
  return { why: `宿主校验器不可解析：${tried.join(' | ')}` }
}

const host = loadHostValidator()

/** 一条消息事件的最小合法形状（v4：source.kind 必须是非 `plugin` 的非空串） */
function messageEvent(
  seq: number,
  type: 'user/message' | 'assistant/message',
  turn: number | null,
  step: number | null,
  text: string,
): Event {
  const source = type === 'user/message' ? { kind: 'user' } : { kind: 'model' }
  const message = { id: `m-${seq}`, role: type === 'user/message' ? 'user' : 'assistant', content: [{ type: 'text', text }], source }
  const data = turn === null ? message : { turn, step, message }
  return { type, seq, time: 1_000 + seq, data, surfaceOp: 'append' }
}

function systemEvent(seq: number, turn: number, step: number): Event {
  return {
    type: 'system/message',
    seq,
    time: 1_000 + seq,
    data: { turn, step, message: { id: `s-${seq}`, role: 'system', source: { kind: 'system-prompt' }, content: [] } },
    surfaceOp: 'append',
  }
}

/** 一个「已打开 turn 1 / step 1」的最小会话前缀（与真机日志同形） */
function openTurnPrefix(): Event[] {
  return [
    { type: 'turn/start', seq: 0, time: 1_000, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 1_001, data: { turn: 1, step: 1 } },
    systemEvent(2, 1, 1),
  ]
}

/** 按宿主自己的校验器判一个事件序列；返回 null 表示通过，否则返回报错原文 */
function judge(events: Event[]): string | null {
  try {
    host.validate?.({ header: { id: 'probe', formatVersion: 4 }, inheritedEventCount: 0, events }, new Set(events.map((e) => e.type)))
    return null
  } catch (error) {
    return String((error as Error)?.message ?? error)
  }
}

const skip = host.why !== undefined ? host.why : false

describe('first-anchor 造历史：形状由宿主校验器判定', () => {
  it('读数器自证：宿主校验器已解析到', () => {
    expect(host.validate, host.why ?? '').toBeTypeOf('function')
  })

  it('S1 现状 A 形（只造 user/message×2，落在打开的 turn/step 之外）', () => {
    const events = [...openTurnPrefix()]
    // 现状实现：`user/message` 的 data 就是消息本体（无 turn/step 包裹）
    events.push({ type: 'user/message', seq: 3, time: 1_003, data: { id: 'a-1', role: 'user', content: [{ type: 'text', text: 'anchor 1' }], source: { kind: 'user' } }, surfaceOp: 'append' })
    events.push({ type: 'user/message', seq: 4, time: 1_004, data: { id: 'a-2', role: 'user', content: [{ type: 'text', text: 'anchor 2' }], source: { kind: 'user' } }, surfaceOp: 'append' })
    expect(judge(events), 'A 形应被宿主接受（这就是当前发布的实现）').toBeNull()
  })

  it('S2 目标 B 形：user ＋ assistant 交替，落在**打开**的 turn/step 内', () => {
    const events = [...openTurnPrefix()]
    events.push(messageEvent(3, 'user/message', null, null, 'anchor 1'))
    events.push(messageEvent(4, 'assistant/message', 1, 1, 'acknowledge'))
    events.push(messageEvent(5, 'user/message', null, null, 'anchor 2'))
    events.push(messageEvent(6, 'assistant/message', 1, 1, 'acknowledge'))
    expect(judge(events), 'B 形（带 assistant ack，turn/step 匹配已打开的）应被接受').toBeNull()
  })

  it('S3 负控：assistant 落在**未打开**的 turn/step 上 ⇒ 宿主必须拒绝', () => {
    const events = [...openTurnPrefix()]
    events.push(messageEvent(3, 'user/message', null, null, 'anchor 1'))
    // turn 2 / step 9 从未打开 —— 这是"代写 assistant 结构性非法"的真正机制
    events.push(messageEvent(4, 'assistant/message', 2, 9, 'acknowledge'))
    const verdict = judge(events)
    expect(verdict, '未打开的 turn/step 上的 assistant/message 必须被拒').not.toBeNull()
    expect(verdict).toMatch(/open turn and step/)
  })

  it('S4 负控：没有任何 turn 打开时写 assistant ⇒ 同样必须被拒', () => {
    const events: Event[] = [
      { type: 'turn/start', seq: 0, time: 1_000, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 1_001, data: { turn: 1, step: 1 } },
      systemEvent(2, 1, 1),
      { type: 'step/end', seq: 3, time: 1_003, data: { turn: 1, step: 1 } },
      messageEvent(4, 'user/message', null, null, 'anchor 1'),
      messageEvent(5, 'assistant/message', 1, 1, 'acknowledge'),
    ]
    const verdict = judge(events)
    expect(verdict, 'step 已关后写 assistant/message 必须被拒').not.toBeNull()
  })
})

// 让 skip 变量参与编译（skip 为 false 时本文件照常跑；解析失败时上面的自证用例会红）
void skip

// ── 被测实现的事件序列（v1.69.4：成对造 user ＋ assistant ack）──

/** 一个只记录 append 的替身 session（形状判据只看我们写了什么） */
function recorder(): { events: Event[]; session: unknown } {
  const events: Event[] = []
  const session = {
    append: (type: string, data: unknown, opts?: unknown) => {
      const seq = events.length
      events.push({ type, seq, time: 1_000 + seq, data, surfaceOp: (opts as { surfaceOp?: unknown })?.surfaceOp })
      return { seq }
    },
  }
  return { events, session }
}

describe('appendAnchorHistory：事件序列', () => {
  it('有打开坐标 ⇒ user 与 assistant 逐条交替（user → ack → user → ack）', () => {
    const { events, session } = recorder()
    const ok = appendAnchorHistory(session, ['anchor 1', 'anchor 2'], { turn: 1, step: 1 })
    expect(ok).toBe(true)
    expect(events.map((e) => e.type)).toEqual([
      'user/message',
      'assistant/message',
      'user/message',
      'assistant/message',
    ])
    // assistant 那半必须带**精确匹配**的 turn/step（宿主只认这个）
    for (const ack of events.filter((e) => e.type === 'assistant/message')) {
      const data = ack.data as { turn?: number; step?: number }
      expect(data.turn).toBe(1)
      expect(data.step).toBe(1)
    }
  })

  it('🔴 无打开坐标 ⇒ 只造 user（⛔ 绝不在非法坐标上写 assistant）', () => {
    for (const slot of [undefined, {}, { turn: 0, step: 0 }, { turn: null, step: null }]) {
      const { events, session } = recorder()
      expect(appendAnchorHistory(session, ['a', 'b'], slot as never)).toBe(true)
      expect(events.every((e) => e.type === 'user/message')).toBe(true)
      expect(events).toHaveLength(2)
    }
  })

  it('**整段写入可被宿主校验器接受**（正控：与真机同序的后缀）', () => {
    const prefix = openTurnPrefix()
    const { events, session } = recorder()
    appendAnchorHistory(session, ['anchor 1', 'anchor 2'], { turn: 1, step: 1 })
    // 拼成「打开 turn/step → system → 锚定写入」的真机同序序列
    const full = [...prefix, ...events.map((e, i) => ({ ...e, seq: prefix.length + i }))]
    expect(judge(full), '成对锚定历史必须能被宿主重放接受').toBeNull()
  })
})
