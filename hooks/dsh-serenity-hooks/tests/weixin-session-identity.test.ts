/**
 * weixin-session-identity.test.ts —— 微信桥会话**身份**的钉（S142 2026-10-19，owner 重做令）
 *
 * ## 为什么换掉 `weixin-session-gen.test.ts`（R↓，不许只说"改了需求"）
 *
 * 旧件钉的是 `.weixin-session-gen.json` **换代计数器**：`baseId` → `baseId-g1` → `baseId-g2`…
 * 那套机制存在的**唯一理由**是一条具体的设计：会话身份挂在**微信用户**上（`sha256(用户 id)`），
 * 而**载体**（SESSION 目录）可能先被归档 —— 于是只能靠"换代"给同一个用户续出一条新身份。
 *
 * 旧件的四条判据（零回归 / 换代后不同 / 落盘跨进程 / 坏档退回 0 / 多用户互不串味）
 * **逐条随该机制一起作废**，不是被"削弱"：
 *   - 「零回归返回 baseId」——新模型没有 baseId，只有 `skiff-weixin-<轨迹编码>`；
 *   - 「换代 ⇒ 新 id」——**功能整件删除**：轨迹没了就该在路由层**响亮报错**
 *     （`目标 CCC ... 内没有编码为 X 的认知轨迹`），**不该静默换一个 id 续命**
 *     ——静默续命正是旧 `-g<n>` 干的那件事，它把"投到了不存在的地方"伪装成"还在对话"；
 *   - 「落盘跨进程」——计数器文件没了，无档可读；
 *   - 「坏档退回 0」——同上；
 *   - 「多用户互不串味」——新模型里**用户根本不是身份的一部分**（见下面第 ③ 条）。
 * ⇒ `readSessionGen` / `bumpSessionGen` / `currentSessionIdFor` / `discardCurrentSessionGen`
 *   与 `weixinSessionIdFor` 五个导出**全部删除**；本文件是它们的替代品，只钉**留下的那条不变量**。
 *
 * ## 留下来的不变量：身份 = 轨迹
 *
 * 派生 = `skiff-weixin-<轨迹编码>`。语义与旧模型的差别不是"换了个哈希函数"，而是**换了主体**：
 *  - 旧：同一条轨迹**换个人说话 = 另一条会话**；同一个人**换条轨迹 = 还是原来那条会话**
 *    （症状：改路由之后，新轨迹的约束对不上旧会话的历史工具清单）；
 *  - 新：**同一条轨迹 ⇒ 恒同一条 dsh 会话**（无论谁在跟它说话）；换轨迹 ⇒ 新会话。
 * 前缀 `skiff-weixin-` 只为日志/会话列表里一眼认出这是外部面，**不承载任何身份信息**。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { weixinSessionIdForTrajectory, isWeixinSessionId, matchWeixinRoute } from '../src/im/route.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weixin-identity-'))
  writeFileSync(join(dir, '.serenity'), 'test')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('微信桥会话身份：派生自**认知轨迹编码**（不含用户身份）', () => {
  it('① 同一条轨迹 ⇒ 恒同一条会话 id（跨调用稳定，可重建）', () => {
    const first = weixinSessionIdForTrajectory('qa')
    const second = weixinSessionIdForTrajectory('qa')
    expect(first).toBe(second)
    // 前缀 + 编码逐字：可读、可反查、会话列表里一眼认出这是外部面
    expect(first).toBe('skiff-weixin-qa')
    expect(isWeixinSessionId(first)).toBe(true)
  })

  it('② 不同轨迹 ⇒ 不同会话 id（换目标就是换身份，不再是"同一个人的老会话"）', () => {
    expect(weixinSessionIdForTrajectory('qa')).not.toBe(weixinSessionIdForTrajectory('zc'))
    // 同一编码的多次调用不得漂移（长期记忆 / 重启续接都靠这一条）
    const samples = Array.from({ length: 5 }, () => weixinSessionIdForTrajectory('zc.long-name_1'))
    expect(new Set(samples).size).toBe(1)
  })

  it('③ 🔴 id **不含用户身份**：两个微信用户被路由到同一轨迹 ⇒ 共用同一条会话', () => {
    // 路由表：userA 与 userB 都指向轨迹 `qa`
    const routes = [
      { user: 'userA@im.wechat', trajectory: 'qa' },
      { user: 'userB@im.wechat', trajectory: 'qa' },
    ]
    const codeForA = matchWeixinRoute(routes, 'userA@im.wechat')
    const codeForB = matchWeixinRoute(routes, 'userB@im.wechat')
    expect(codeForA).toBe('qa')
    expect(codeForB).toBe('qa')
    // 两条消息落到**同一条会话**（旧模型里这里会是两个 sha256 ⇒ 两条会话）
    expect(weixinSessionIdForTrajectory(codeForA!)).toBe(weixinSessionIdForTrajectory(codeForB!))
    // 且 id 里找不到任何用户痕迹（旧形态的 sha256 虽是伪名，却是**可复算的稳定标识**）
    const id = weixinSessionIdForTrajectory(codeForA!)
    expect(id).not.toContain('userA')
    expect(id).not.toContain('userB')
    expect(id).not.toContain('@im.wechat')
  })

  it('④ 换用户但换轨迹 ⇒ 换会话（身份跟着轨迹走，不跟着人走）', () => {
    // 同一个 userA，改路由后指向 zc ⇒ 会话 id 必须变（旧模型里它会一直用旧会话）
    const before = weixinSessionIdForTrajectory(matchWeixinRoute([{ user: 'userA@im.wechat', trajectory: 'qa' }], 'userA@im.wechat')!)
    const after = weixinSessionIdForTrajectory(matchWeixinRoute([{ user: 'userA@im.wechat', trajectory: 'zc' }], 'userA@im.wechat')!)
    expect(before).not.toBe(after)
  })

  it('⑤ 派生是纯函数：不落盘任何状态档（`.weixin-session-gen.json` 不再存在）', () => {
    const id = weixinSessionIdForTrajectory('qa')
    // 反复调用也不产生任何文件：换代计数器的存在理由（载体没了要续命）已随身份改挂轨迹而消失
    for (let i = 0; i < 3; i++) weixinSessionIdForTrajectory('qa')
    expect(id).toBe('skiff-weixin-qa')
    expect(existsSync(join(dir, 'AGENT_SESSIONS', '.weixin-session-gen.json'))).toBe(false)
    // 非微信桥会话仍不被误判（前缀判据是"命名形态"，不是权力面判据）
    expect(isWeixinSessionId('轨迹约束-qa-xxx')).toBe(false)
    expect(isWeixinSessionId(undefined)).toBe(false)
  })
})
