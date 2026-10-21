/**
 * im-session-lock.test.ts — 同会话入站**串行化**（2026-10-21，修"同一条消息被处理两轮"的第二个缺陷）
 *
 * ## 这条测试要钉的是什么（R↓）
 *
 * 现场：两条入站**并发**时，`askTrajectory` 的成功判据是"`assistant/message` **条数增长**"，
 * 而后一条的快照包含前一条尚未落盘的产出 ⇒ **前一轮的产出会满足后一条的判据**
 * ⇒ 兜底/`reply-fallback` 可能拿到**错轮**的答案（真机实测：把内部过程话发给了家人）。
 *
 * ## 判据怎么选才有效（D174：两种假设必须产生不同观测）
 *
 * 不用"调用次数"或"耗时"这类在两种实现下都成立的读数，而是**记进入/离开的先后顺序**：
 * 串行 ⇒ `A-in, A-out, B-in, B-out`；并发 ⇒ `A-in, B-in, ...`。
 * 这两个序列在读数上**不可混淆**，所以这个探针有判别力。
 */
import { describe, it, expect } from 'vitest'
import { __sessionLockCountForTest } from '../src/im/inbound-event.js'

/**
 * 拿同一份锁协议跑两"条入站"（不经过完整主流程 —— 主流程需要整个宿主面，
 * 而本测试要钉的是**锁的语义**，不是那条链路；链路由既有 weixin/im-inbound 用例覆盖）。
 *
 * ⚠️ 这里**复刻**的是 `acquireSessionLock` 的对外契约（acquire → 干活 → release），
 * 不是它的实现：实现若换了形状，本文件会因导入失败而**响亮报错**，不会静默失效。
 */
async function withLockReplica<T>(key: string, tag: string, log: string[], work: () => Promise<T>): Promise<T> {
  const release = await acquireForTest(key)
  try {
    log.push(`${tag}-in`)
    return await work()
  } finally {
    log.push(`${tag}-out`)
    release()
  }
}

// 从被测模块拿真锁（不是复制实现）
const { __acquireSessionLockForTest: acquireForTest } = await import('../src/im/inbound-event.js')

describe('im-session-lock: 同会话串行化（真故障靶子）', () => {
  it('🔴 同一会话：两条入站**不重叠**（A-in → A-out → B-in → B-out）', async () => {
    const log: string[] = []
    const gap = () => new Promise<void>((r) => setTimeout(r, 10))

    const a = withLockReplica('sess-1', 'A', log, async () => { await gap() })
    const b = withLockReplica('sess-1', 'B', log, async () => { await gap() })
    await Promise.all([a, b])

    // 串行的判据：不会出现 B-in 排在 A-out 之前
    const outA = log.indexOf('A-out')
    const inB = log.indexOf('B-in')
    expect(outA, `实际序列 = ${log.join(',')}`).toBeGreaterThanOrEqual(0)
    expect(inB, `实际序列 = ${log.join(',')}`).toBeGreaterThan(outA)
  })

  it('🔴 不同会话：**互不阻塞**（两条可以同时在跑）', async () => {
    const log: string[] = []
    let inside = 0
    let peak = 0
    const track = async (): Promise<void> => {
      inside += 1
      peak = Math.max(peak, inside)
      await new Promise<void>((r) => setTimeout(r, 15))
      inside -= 1
    }
    await Promise.all([
      withLockReplica('sess-x', 'X', log, track),
      withLockReplica('sess-y', 'Y', log, track),
    ])
    expect(peak, '不同会话不该被同一把锁串起来').toBe(2)
  })

  it('锁在位时可观测、全部释放后归零（不漏锁）', async () => {
    expect(__sessionLockCountForTest()).toBe(0)
    const held: Array<() => void> = []
    const p = (async () => {
      held.push(await acquireForTest('sess-leak'))
    })()
    await p
    expect(__sessionLockCountForTest()).toBeGreaterThan(0)
    held[0]!()
    expect(__sessionLockCountForTest()).toBe(0)
  })

  it('前一条**抛错**不毒死后来者（下一条仍能拿到锁）', async () => {
    const log: string[] = []
    const bad = withLockReplica('sess-err', 'bad', log, async () => { throw new Error('boom') })
    const good = withLockReplica('sess-err', 'good', log, async () => 'ok')
    await expect(bad).rejects.toThrow('boom')
    await expect(good).resolves.toBe('ok')
    expect(log).toContain('good-in')
  })
})
