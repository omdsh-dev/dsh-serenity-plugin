/**
 * user-carrier.test.ts — **程序性创建载体 = 用户人工创建**（D171 / owner 裁 B）的判据
 *
 * ## 它守的是什么
 *
 * 宿主 `dsh-session-title` 的 `sessionTitleUserMessageOf()` 第一行：
 *   `if (event.type !== "user/message" || event.data.source.kind !== "user") return void 0`
 *
 * ⇒ 只有 `kind === 'user'` 的消息才被当成"有人说过话"。ACC 常规注入一律是
 * `plugin:dsh-serenity-hooks` ⇒ 自建会话 `titleInput` 恒 0、标题恒 null（实测：用户建 6 / 自建 0）。
 *
 * 本文件钉三件事（每条都有**反向断言**，因为"我传了 kind:user"是弱断言）：
 *   S1 开场白确实以 `kind:'user'` 构造，且**刻意区别于**全仓其它注入的 `ACC_MESSAGE_KIND`；
 *   S2 正文**逐字**带自证标记（人类与语料过滤器都靠它），且**不带**版本号（D159）；
 *   S3 🔴 **顺序**：真主发了开场白之后，`hasUserMessageHistory` 必须返回 true ——
 *      这正是"假首轮会被挡掉"的机制，故**必须显式钉住**（见 S3 的说明）。
 *
 * ## 隐私门（D145）
 * 本文件不写真实家目录 / 私有 CCC 名。
 */
import { describe, it, expect, vi } from 'vitest'
import {
  CARRIER_OPENING_MARK,
  buildCarrierOpening,
  deliverCarrierOpening,
} from '../src/trajectory/user-carrier.js'
import { ACC_MESSAGE_KIND } from '../src/kernel/message-source.js'
import { hasUserMessageHistory } from '../src/seams/bootstrap.js'

/** 取一条 `createUserMessage` 产出的消息（结构断言用） */
function captured(): {
  msg: Record<string, unknown>
  agent: { followup: (m: unknown) => void }
} {
  let msg: Record<string, unknown> = {}
  const agent = {
    followup: (m: unknown) => {
      msg = m as Record<string, unknown>
    },
  }
  return { get msg() { return msg }, agent } as unknown as {
    msg: Record<string, unknown>
    agent: { followup: (m: unknown) => void }
  }
}

describe('D171 · 开场白正文', () => {
  it('S2 逐字带自证标记（人类一眼可辨 ＋ 语料过滤器靠它排除）', () => {
    const text = buildCarrierOpening('S999', '演示用')
    expect(text.startsWith(CARRIER_OPENING_MARK)).toBe(true)
  })

  it('S2 反向：不带版本号（D159 —— 判据必须与版本无关）', () => {
    const text = buildCarrierOpening('S999', '演示用')
    // 形如 v1.2.3 / 1.2.3 的版本串一律不许出现
    expect(/\bv?\d+\.\d+\.\d+\b/u.test(text)).toBe(false)
  })

  it('S2 编码与描述都进正文；描述为空时只留编码（不出现空括号）', () => {
    expect(buildCarrierOpening('S999', '演示用')).toContain('S999（演示用）')
    expect(buildCarrierOpening('S999', '   ')).not.toContain('（）')
  })
})

describe('D171 · 投递形态（B 的核心）', () => {
  it('S1 消息 source.kind === "user"（宿主自动命名／titleInput 的唯一入口）', () => {
    const c = captured()
    expect(deliverCarrierOpening(c.agent, buildCarrierOpening('S999', '演示用'))).toBe(true)
    expect((c.msg.source as { kind?: string }).kind).toBe('user')
  })

  it('🔴 S1 反向：它与 ACC 常规注入**不是同一个 kind**（否则等于没改）', () => {
    const c = captured()
    deliverCarrierOpening(c.agent, buildCarrierOpening('S999', '演示用'))
    expect((c.msg.source as { kind?: string }).kind).not.toBe(ACC_MESSAGE_KIND)
  })

  it('正文原样进 content（不截断、不改写）', () => {
    const c = captured()
    const text = buildCarrierOpening('S999', '演示用')
    deliverCarrierOpening(c.agent, text)
    const blocks = c.msg.content as Array<{ type: string; text?: string }>
    expect(blocks[0]?.text).toBe(text)
  })

  it('没有 followup 能力 ⇒ 返回 false，不抛（失败要能被调用方降级）', () => {
    expect(deliverCarrierOpening({}, 'x')).toBe(false)
  })

  it('followup 抛错 ⇒ 返回 false，不把异常甩给投递主流程', () => {
    const boom = {
      followup: () => {
        throw new Error('boom')
      },
    }
    expect(deliverCarrierOpening(boom, 'x')).toBe(false)
  })
})

describe('🔴 D171 · S3 顺序（这条是"做细"的关键，别删）', () => {
  /**
   * 机制真相：`bootstrap.ts` 在 `depth === 0` 分支里，若
   * `hasUserMessageHistory(session)` 为真就 **return**（不注入假首轮）。
   * 而该函数只认 `source.kind === 'user'`。
   *
   * ⇒ 开场白一旦**先于**假首轮写进日志，假首轮就永远不注入。
   *   现机制的保证是：注入发生在 `agent/inbox/inserted`（宿主写入之前、只动队列），
   *   而开场白是 `followup`（排在队尾）⇒ **注入先、开场白后**。
   *   这里把那个保证的**后果**钉死：带开场白历史的会话，确实会被判成"已有真人历史"。
   */
  it('会话里已有开场白（kind:user）⇒ hasUserMessageHistory 为真 ⇒ 假首轮会因此被跳过', () => {
    const session = {
      snapshotEvents: () => [
        { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: buildCarrierOpening('S999', '演示用') }] } },
      ],
    }
    expect(hasUserMessageHistory(session)).toBe(true)
  })

  it('反向：只含 ACC 注入（plugin:*）的会话 ⇒ 不判成"已有真人历史"', () => {
    const session = {
      snapshotEvents: () => [
        { type: 'user/message', data: { source: { kind: ACC_MESSAGE_KIND }, content: [{ type: 'text', text: 'x' }] } },
      ],
    }
    expect(hasUserMessageHistory(session)).toBe(false)
  })

  it('反向对照：空会话 ⇒ false（假首轮可以注入）', () => {
    expect(hasUserMessageHistory({ snapshotEvents: () => [] })).toBe(false)
  })
})

describe('D171 · 语料排除的判据必须可机械执行', () => {
  /**
   * `session-corpus` 要排除这条伪造发言。它需要的是一个**能直接跑的正则/子串**。
   * 这里把那条判据固化下来：正文含标记 ⇒ 该条不是所有者发言。
   */
  it('标记本身不含正则元字符，可直接当子串匹配', () => {
    // 若将来有人往标记里塞 [ ] ( ) * + ? . 之类，这条会红 —— 提醒他同时改语料侧
    expect(/^\[ACC 代用户开场\]$/u.test(CARRIER_OPENING_MARK)).toBe(true)
  })

  it('真实用户文本不会误命中（反向：普通中文句子）', () => {
    const real = '帮我把这集字幕对一下时间轴'
    expect(real.includes(CARRIER_OPENING_MARK)).toBe(false)
  })
})
