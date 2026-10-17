/**
 * acp-auth.test.ts — ACP 面**认证与身份层**的判据（v1.59.0）
 *
 * ## 为什么这件必须有（不是"凑覆盖率"）
 * 本模块是**唯一**的接入关口（`dsh-acp` 的 `authenticate()` 恒成功、无认证缝 —— 读其
 * `lib/index.js` 逐字）。它坏了 = **`0.0.0.0` 上的 ACP 面对局域网完全敞开**，
 * 而"敞开"没有任何日常信号会报（没有报错、没有告警、功能一切正常）。
 *
 * ## 本件覆盖什么（按"坏了会怎样"排序）
 * ① 🔴 **常时比较**：错 token 必须**拒**，且**同长度错 token** 也要拒
 *    （防"只比长度"这类假实现混过去）
 * ② 🔴 **fail-closed 三连**：无 token ／ 未启用通道 ／ 无角色 ⇒ **一律拒**
 * ③ **归属正确性**：token → CCC 一一对应；**A 的 token 不能认成 B**
 * ④ 🔴 **越权防护**：`cwd` 落在**令牌归属 CCC 之外** ⇒ 拒（防一枚 token 越权到别的 CCC）
 * ⑤ **取 token 的两种形态**：`Authorization: Bearer` 与 `?token=`
 * ⑥ **幂等与轮换**：`ensureAcpToken` 重复调用**不换号**（换号会让在用客户端全断）；
 *    `resetAcpToken` 才换，且旧号立即失效
 *
 * ## 判据纪律
 * · **真文件树**（不是 mock）：本模块读真配置 ＋ 真 localstore —— 替身会把要验的那一环绕过去
 * · **正控成对**：凡"拒"必须配一条"对 ⇒ 放行"，否则测不出"它是不是一律拒"
 * · **不写 token 明文进断言消息**（失败输出会进日志）
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ACP_TOKEN_KEY,
  readAcpToken,
  ensureAcpToken,
  resetAcpToken,
  safeEqual,
  tokenFingerprint,
  extractToken,
  resolveTokenOwner,
  listAcpRoots,
  readImSettings,
  acpChannelEnabled,
  acpRoleFor,
  cwdInsideRoot,
  authorizeAcpConnection,
  acpChannelStatus,
  tokenOwnerAudit,
  __rawTokenForTest,
} from '../src/acp-auth.js'
import { writeEntry } from '../src/localstore-ops.js'

const made: string[] = []

/** 造一个 CCC（可指定 im 段与角色） */
function mkCcc(im: unknown, roles: Record<string, unknown> = { tester: { systemPrompt: '测试角色' } }): string {
  const root = mkdtempSync(join(tmpdir(), 'acp-auth-'))
  made.push(root)
  mkdirSync(join(root, '.opencode'), { recursive: true })
  writeFileSync(join(root, '.serenity'), '')
  writeFileSync(join(root, '.opencode', 'serenity.json'), JSON.stringify({ im, skiff: { roles } }))
  return root
}

/** 造一个"完整可用"的 ACP CCC（启用 ＋ 有角色 ＋ 有 token） */
function mkAcpCcc(role = 'tester'): string {
  const root = mkCcc({ channel: 'acp', acp: { enabled: true, role } })
  ensureAcpToken(root)
  return root
}

afterEach(() => {
  for (const d of made.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* 已清 */ }
  }
})

describe('acp-auth: token 生成与轮换', () => {
  it('ensureAcpToken 首次生成 64 位 hex（32 字节），且**落进该 CCC 的 localstore**', () => {
    const root = mkAcpCcc()
    const token = readAcpToken(root)!
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    // 判据 = store 里真有这个键（不是"函数返回了就算"）
    expect(__rawTokenForTest(root)).toBe(token)
    expect(ACP_TOKEN_KEY).toBe('IM_ACP_TOKEN')
  })

  it('🔴 ensureAcpToken 幂等：重复调用**不换号**（换号会让在用客户端全部断线）', () => {
    const root = mkAcpCcc()
    const first = readAcpToken(root)!
    const second = ensureAcpToken(root)
    expect(second).toBe(first)
    expect(readAcpToken(root)).toBe(first)
  })

  it('resetAcpToken：**换**新号，且旧号立即失效（显式动作才允许轮换）', () => {
    const root = mkAcpCcc()
    const old = readAcpToken(root)!
    const fresh = resetAcpToken(root)
    expect(fresh).not.toBe(old)
    expect(readAcpToken(root)).toBe(fresh)
  })

  it('未生成时 readAcpToken = null（**不撒谎**：读路径绝不顺手生成）', () => {
    const root = mkCcc({ channel: 'acp', acp: { enabled: true, role: 'tester' } })
    expect(readAcpToken(root)).toBeNull()
    expect(acpChannelStatus(root).hasToken).toBe(false)
    // 读一次之后仍然没有 —— 证明读路径无副作用
    expect(readAcpToken(root)).toBeNull()
  })

  it('指纹是 token 的截断 SHA-256（诊断面只出指纹，**绝不出明文**）', () => {
    const token = 'a'.repeat(64)
    const fp = tokenFingerprint(token)
    expect(fp).toHaveLength(12)
    expect(fp).toMatch(/^[0-9a-f]{12}$/)
    // 指纹不含明文（连子串都不该有）
    expect(fp.includes('aaaa')).toBe(false)
  })
})

describe('acp-auth: 常时比较', () => {
  it('相等 ⇒ true；不等 ⇒ false', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
  })

  it('🔴 长度不同 ⇒ false（且**不抛**——timingSafeEqual 长度不等会抛）', () => {
    expect(() => safeEqual('abc', 'abcd')).not.toThrow()
    expect(safeEqual('abc', 'abcd')).toBe(false)
    expect(safeEqual('', 'a')).toBe(false)
  })

  it('🔴 同长度但内容不同 ⇒ false（防"只比长度"的假实现）', () => {
    expect(safeEqual('a'.repeat(64), 'b'.repeat(64))).toBe(false)
  })
})

describe('acp-auth: 从请求里取 token（两种形态）', () => {
  it('Authorization: Bearer <t>（大小写不敏感）', () => {
    expect(extractToken({ authorization: 'Bearer tok123' }, '/acp')).toBe('tok123')
    expect(extractToken({ authorization: 'bearer tok123' }, '/acp')).toBe('tok123')
  })

  it('?token=<t>（查询串）', () => {
    expect(extractToken({}, '/acp?token=tok456')).toBe('tok456')
  })

  it('Bearer 优先于查询串（两者都在时）', () => {
    expect(extractToken({ authorization: 'Bearer fromHeader' }, '/acp?token=fromQuery')).toBe('fromHeader')
  })

  it('都没有 ⇒ null（不是空串——空串会被误当成"带了 token"）', () => {
    expect(extractToken({}, '/acp')).toBeNull()
    expect(extractToken({}, undefined)).toBeNull()
    expect(extractToken({ authorization: 'Basic xyz' }, '/acp')).toBeNull()
    expect(extractToken({}, '/acp?token=')).toBeNull()
  })

  it('畸形 URL 或畸形头 ⇒ null（不抛）', () => {
    expect(() => extractToken({}, 'http://[bad')).not.toThrow()
    expect(extractToken({}, 'http://[bad')).toBeNull()
  })
})

describe('acp-auth: CCC 配置读（im 段）', () => {
  it('🔴 未配置 im 段 ⇒ **缺省 weixin**（＝升级前行为，向前兼容由缺省值保证）', () => {
    const root = mkCcc(undefined)
    expect(readImSettings(root).channel).toBe('weixin')
    expect(acpChannelEnabled(root)).toBe(false)
  })

  it('旧配置（只有 weixin 段、无 im）⇒ channel 仍是 weixin（一个字节都不用改）', () => {
    const root = mkdtempSync(join(tmpdir(), 'acp-legacy-'))
    made.push(root)
    mkdirSync(join(root, '.opencode'), { recursive: true })
    writeFileSync(join(root, '.serenity'), '')
    writeFileSync(
      join(root, '.opencode', 'serenity.json'),
      // ⚠️ 角色名用占位符，**不得**写 CCC 真实的角色名（那是该 CCC 的数据；本仓有
      //    `privacy-scan.test.ts` 的 `role-name-*` 判据会拦 —— 本轮实测被它抓到过一次）
      JSON.stringify({ weixin: { enabled: true, routes: [{ user: '*', role: 'some-role' }] } }),
    )
    expect(readImSettings(root).channel).toBe('weixin')
    expect(acpChannelEnabled(root)).toBe(false)
  })

  it('🔴 channel=acp 但 enabled 未设 ⇒ **不算启用**（双键是「与」关系）', () => {
    const root = mkCcc({ channel: 'acp', acp: { role: 'tester' } })
    expect(acpChannelEnabled(root)).toBe(false)
  })

  it('🔴 enabled=true 但 channel 未指 acp ⇒ **不算启用**', () => {
    const root = mkCcc({ acp: { enabled: true, role: 'tester' } })
    expect(acpChannelEnabled(root)).toBe(false)
  })

  it('两者都真 ⇒ 启用（正控）', () => {
    const root = mkCcc({ channel: 'acp', acp: { enabled: true, role: 'tester' } })
    expect(acpChannelEnabled(root)).toBe(true)
    expect(acpRoleFor(root)).toBe('tester')
  })

  it('配置损坏（非法 JSON）⇒ 退回缺省 weixin（**绝不因读失败而放行 ACP**）', () => {
    const root = mkdtempSync(join(tmpdir(), 'acp-bad-'))
    made.push(root)
    mkdirSync(join(root, '.opencode'), { recursive: true })
    writeFileSync(join(root, '.serenity'), '')
    writeFileSync(join(root, '.opencode', 'serenity.json'), '{ this is not json')
    expect(readImSettings(root).channel).toBe('weixin')
    expect(acpChannelEnabled(root)).toBe(false)
    expect(acpRoleFor(root)).toBeNull()
  })

  it('角色名为空白 ⇒ 视同未配置（防 `role: "  "` 绕过 fail-closed）', () => {
    const root = mkCcc({ channel: 'acp', acp: { enabled: true, role: '   ' } })
    expect(acpRoleFor(root)).toBeNull()
  })
})

describe('acp-auth: 归属与越权防护', () => {
  it('resolveTokenOwner：认对号 ⇒ 返回该 CCC；认错号 ⇒ null', () => {
    const a = mkAcpCcc()
    const b = mkAcpCcc()
    const ta = readAcpToken(a)!
    const tb = readAcpToken(b)!
    expect(resolveTokenOwner(ta, [a, b])).toBe(a)
    expect(resolveTokenOwner(tb, [a, b])).toBe(b)
    expect(resolveTokenOwner('f'.repeat(64), [a, b])).toBeNull()
  })

  it('🔴 A 的 token **不会**被认成 B（一一对应，不是"容器里有一个就放行"）', () => {
    const a = mkAcpCcc()
    const b = mkAcpCcc()
    expect(resolveTokenOwner(readAcpToken(a)!, [b])).toBeNull()
  })

  it('listAcpRoots：只收「启用通道 ＋ 有 token」的 CCC', () => {
    const ok = mkAcpCcc()
    const noToken = mkCcc({ channel: 'acp', acp: { enabled: true, role: 'tester' } })
    const disabled = mkCcc({ channel: 'acp', acp: { enabled: false, role: 'tester' } })
    ensureAcpToken(disabled)
    const weixin = mkCcc(undefined)
    ensureAcpToken(weixin)
    expect(listAcpRoots([ok, noToken, disabled, weixin])).toEqual([ok])
  })

  it('🔴 cwd 越权：本 CCC 的 token **不能**把会话开到别的 CCC', () => {
    const root = '/home/x/ccc-a'
    expect(cwdInsideRoot(`${root}/sub`, root)).toBe(true)
    expect(cwdInsideRoot(root, root)).toBe(true)
    expect(cwdInsideRoot('/home/x/ccc-b', root)).toBe(false)
    // ⚠️ 前缀陷阱：`/a/bc` 不在 `/a/b` 内（用 startsWith 会误判为在）
    expect(cwdInsideRoot('/home/x/ccc-ab', root)).toBe(false)
  })

  it('cwd 必须绝对路径（相对路径一律拒）', () => {
    expect(cwdInsideRoot('relative/path', '/home/x/ccc-a')).toBe(false)
    expect(cwdInsideRoot('', '/home/x/ccc-a')).toBe(false)
  })
})

describe('acp-auth: authorizeAcpConnection（准入判决，fail-closed 三连）', () => {
  it('🔴 无 token ⇒ null', () => {
    const a = mkAcpCcc()
    expect(authorizeAcpConnection(null, [a])).toBeNull()
    expect(authorizeAcpConnection('', [a])).toBeNull()
  })

  it('🔴 错 token ⇒ null', () => {
    const a = mkAcpCcc()
    expect(authorizeAcpConnection('f'.repeat(64), [a])).toBeNull()
  })

  it('🔴 CCC 未启用 ACP 通道 ⇒ null（token 对也不放行）', () => {
    const root = mkCcc({ channel: 'acp', acp: { enabled: false, role: 'tester' } })
    const token = ensureAcpToken(root)
    expect(authorizeAcpConnection(token, [root])).toBeNull()
  })

  it('🔴 未配角色 ⇒ null（**不给一个无身份、无约束的裸 agent**）', () => {
    const root = mkCcc({ channel: 'acp', acp: { enabled: true } })
    const token = ensureAcpToken(root)
    expect(authorizeAcpConnection(token, [root])).toBeNull()
  })

  it('全部齐备 ⇒ 放下并通过（正控），返回归属 CCC ＋ 角色', () => {
    const a = mkAcpCcc('tester')
    const token = readAcpToken(a)!
    expect(authorizeAcpConnection(token, [a])).toEqual({ root: a, role: 'tester' })
  })

  it('🔴 无 token 名单为空 ⇒ null（不是"名单空所以都放行"）', () => {
    expect(authorizeAcpConnection('f'.repeat(64), [])).toBeNull()
  })
})

describe('acp-auth: 「随即生成」token（owner 令的逐字要求）', () => {
  it('🔴 启用 ACP 通道的 CCC 在准入刷新时**当场获得 token**（owner 不必手敲命令）', () => {
    // 造一个"已启用通道但**尚无 token**"的 CCC（这正是 owner 配完配置那一刻的状态）
    const root = mkCcc({ channel: 'acp', acp: { enabled: true, role: 'tester' } })
    expect(readAcpToken(root)).toBeNull() // 前提：确实还没有
    expect(acpChannelEnabled(root)).toBe(true)

    // 走真实刷新路径（它就是装配层启动时调的那个函数）
    // ⚠️ 这里用 `listAcpRoots` 的前置条件模拟：真实刷新还会调 `listCccs(ctx)` 拿名单，
    //    而那是宿主面（单测里没有 CCC 环境）⇒ 本用例验的是**生成这一步**本身。
    const before = listAcpRoots([root])
    expect(before).toEqual([]) // 没 token ⇒ 不进准入名单（fail-closed）
    const token = ensureAcpToken(root) // ← 刷新路径里对每个启用 CCC 做的正是这一句
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(listAcpRoots([root])).toEqual([root]) // 生成后立即进名单
  })

  it('🔴 未启用 ACP 的 CCC **不会**被生成 token（不碰无关 CCC 的 localstore）', () => {
    const weixinCcc = mkCcc({ channel: 'weixin' })
    expect(readAcpToken(weixinCcc)).toBeNull()
    // 刷新路径里只对 `acpChannelEnabled(...)` 为真的 CCC 生成 ⇒ 这里断言那个条件本身不成立
    expect(acpChannelEnabled(weixinCcc)).toBe(false)
    expect(readAcpToken(weixinCcc)).toBeNull() // 仍未生成
  })
})

describe('acp-auth: 诊断面（绝不泄 token 明文）', () => {
  it('acpChannelStatus 给 channel/enabled/role/hasToken/指纹，**不含 token**', () => {
    const a = mkAcpCcc('tester')
    const token = readAcpToken(a)!
    const s = acpChannelStatus(a)
    expect(s).toMatchObject({ channel: 'acp', enabled: true, role: 'tester', hasToken: true })
    expect(s.tokenFingerprint).toBe(tokenFingerprint(token))
    // 🔴 整个快照的序列化里**不得出现 token 明文**
    expect(JSON.stringify(s).includes(token)).toBe(false)
  })

  it('🔴 token 重复出现在两个 CCC ⇒ 审计**响亮报出**（不静默取第一个）', () => {
    const a = mkAcpCcc()
    const b = mkAcpCcc()
    const shared = readAcpToken(a)!
    // 人为制造重复（模拟"手抄错了 token"）
    writeEntry(b, 'credential', ACP_TOKEN_KEY, shared)
    const audit = tokenOwnerAudit([a, b])
    expect(audit.duplicates).toHaveLength(1)
    expect(audit.duplicates[0]!.roots.sort()).toEqual([a, b].sort())
    expect(audit.duplicates[0]!.fingerprint).toBe(tokenFingerprint(shared))
  })

  it('无重复 ⇒ duplicates 为空（对照）', () => {
    const a = mkAcpCcc()
    const b = mkAcpCcc()
    expect(tokenOwnerAudit([a, b]).duplicates).toEqual([])
  })
})
