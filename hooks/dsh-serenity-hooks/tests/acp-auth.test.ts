/**
 * acp-auth.test.ts — ACP 面**认证与身份层**的判据（v1.59.1：账户模型）
 *
 * ## 为什么这件必须有（不是"凑覆盖率"）
 * 本模块是**唯一**的接入关口（`dsh-acp` 的 `authenticate()` 恒成功、无认证缝 —— 读其
 * `lib/index.js` 逐字）。它坏了 = **`0.0.0.0` 上的 ACP 面对局域网完全敞开**，
 * 而"敞开"没有任何日常信号会报（没有报错、没有告警、功能一切正常）。
 *
 * ## v1.59.1 的模型变更（owner 2026-10-17 令）
 * 「**token 生成和 skiff 绑定都做配置上**」⇒ 判据单元从「CCC ↔ 一枚 token」
 * 变成「**（CCC, 账户）↔ 一枚 token ↔ 一个角色**」。形状照 `weixin.accounts[]`：
 * 结构在 `serenity.json`，凭据按键 `IM_ACP_TOKEN_<ACCOUNT_ID>` 派生落 localstore。
 *
 * 🔴 **没有"单账户简写"退回** —— 不写 `accounts` ⇒ 一个账户都没有 ⇒ 谁都认证不了。
 *    刻意如此：多一条永不生效的分支只会把"配置写错"伪装成"用了简写"。
 *
 * ## 本件覆盖什么（按"坏了会怎样"排序）
 * ① 🔴 **常时比较**：错 token 必须**拒**，且**同长度错 token** 也要拒
 * ② 🔴 **fail-closed 四连**：无 token ／ 通道未启用 ／ 账户无 role ／ 无 accounts ⇒ **一律拒**
 * ③ **账户隔离**：A 的 token 认不成 B；同 CCC 内两个账户**互不影响**
 * ④ 🔴 **越权防护**：`cwd` 落在令牌归属 CCC 之外 ⇒ 拒
 * ⑤ **令牌键派生**：`accountId` → `IM_ACP_TOKEN_<UPPER_SNAKE>`
 * ⑥ **幂等与轮换**：重复 `ensureAcpToken` **不换号**；`resetAcpToken` 才换
 * ⑦ 🔴 **配置即真相**：改配置后**下一次判定**就用新值（不重启、不重算快照）
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
  readAcpToken,
  ensureAcpToken,
  resetAcpToken,
  acpTokenKeyFor,
  safeEqual,
  tokenFingerprint,
  extractToken,
  resolveTokenAccount,
  expandAcpAccounts,
  ensureAcpChannelTokens,
  listAcpRoots,
  readImSettings,
  acpChannelEnabled,
  cwdInsideRoot,
  authorizeAcpConnection,
  acpChannelStatus,
  tokenOwnerAudit,
  __rawTokenForTest,
} from '../src/acp-auth.js'
import { writeEntry } from '../src/localstore-ops.js'

const made: string[] = []

/** 默认账户声明（一台"完整可用"的客户端） */
function acct(accountId = 'agmente-phone', role = 'tester', enabled = true) {
  return { accountId, role, enabled }
}

/**
 * 造一个 CCC。
 * @param im  `im` 段（原样写进配置）
 * @param roles `skiff.roles` 声明
 */
function mkCcc(im: unknown, roles: Record<string, unknown> = { tester: { systemPrompt: '测试角色' } }): string {
  const root = mkdtempSync(join(tmpdir(), 'acp-auth-'))
  made.push(root)
  mkdirSync(join(root, '.opencode'), { recursive: true })
  writeFileSync(join(root, '.serenity'), '')
  writeFileSync(join(root, '.opencode', 'serenity.json'), JSON.stringify({ im, skiff: { roles } }))
  return root
}

/** 造一个"完整可用"的 ACP CCC（启用 ＋ 一个声明账户 ＋ 该账户有 token） */
function mkAcpCcc(role = 'tester', accountId = 'agmente-phone'): string {
  const root = mkCcc({ channel: 'acp', acp: { enabled: true, accounts: [acct(accountId, role)] } })
  ensureAcpToken(root, accountId)
  return root
}

/** 重写该 CCC 的 im 段（用于验"改配置即生效"，不重启任何东西） */
function rewriteIm(root: string, im: unknown): void {
  writeFileSync(join(root, '.opencode', 'serenity.json'), JSON.stringify({ im, skiff: { roles: { tester: { systemPrompt: 'x' } } } }))
}

afterEach(() => {
  for (const d of made.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* 已清 */ }
  }
})

describe('acp-auth: token 生成与轮换（按账户）', () => {
  it('ensureAcpToken 首次生成 64 位 hex（32 字节），且**落进该 CCC 的 localstore**', () => {
    const root = mkAcpCcc()
    const token = readAcpToken(root, 'agmente-phone')!
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    // 判据 = store 里真有这个键（不是"函数返回了就算"）
    expect(__rawTokenForTest(root, 'agmente-phone')).toBe(token)
  })

  it('🔴 凭据键按 accountId 派生：`IM_ACP_TOKEN_<UPPER_SNAKE>`（与微信桥同规则）', () => {
    expect(acpTokenKeyFor('agmente-phone')).toBe('IM_ACP_TOKEN_AGMENTE_PHONE')
    expect(acpTokenKeyFor('script_2')).toBe('IM_ACP_TOKEN_SCRIPT_2')
    // 大小写与分隔符都归一
    expect(acpTokenKeyFor('My.Device X')).toBe('IM_ACP_TOKEN_MY_DEVICE_X')
  })

  it('🔴 ensureAcpToken 幂等：重复调用**不换号**（换号会让在用客户端全部断线）', () => {
    const root = mkAcpCcc()
    const t1 = readAcpToken(root, 'agmente-phone')
    ensureAcpToken(root, 'agmente-phone')
    expect(readAcpToken(root, 'agmente-phone')).toBe(t1)
  })

  it('resetAcpToken：**换**新号，且旧号立即失效（显式动作才允许轮换）', () => {
    const root = mkAcpCcc()
    const old = readAcpToken(root, 'agmente-phone')!
    const fresh = resetAcpToken(root, 'agmente-phone')
    expect(fresh).not.toBe(old)
    expect(readAcpToken(root, 'agmente-phone')).toBe(fresh)
    expect(resolveTokenAccount(old, [root])).toBeNull()
    expect(resolveTokenAccount(fresh, [root])).toMatchObject({ role: 'tester' })
  })

  it('未生成时 readAcpToken = null（**不撒谎**：读路径绝不顺手生成）', () => {
    const root = mkCcc({ channel: 'acp', acp: { enabled: true, accounts: [acct()] } })
    expect(readAcpToken(root, 'agmente-phone')).toBeNull()
    expect(expandAcpAccounts(root)).toEqual([])
    // 读一次之后仍然没有 —— 证明读路径无副作用
    expect(readAcpToken(root, 'agmente-phone')).toBeNull()
  })

  it('🔴 两个账户各自一枚 token，**互不相同、互不覆盖**', () => {
    const root = mkCcc({
      channel: 'acp',
      acp: { enabled: true, accounts: [acct('phone', 'tester'), acct('script', 'tester')] },
    })
    ensureAcpToken(root, 'phone')
    ensureAcpToken(root, 'script')
    const a = readAcpToken(root, 'phone')!
    const b = readAcpToken(root, 'script')!
    expect(a).not.toBe(b)
    // 撤掉一个不动另一个
    expect(resolveTokenAccount(a, [root])).toMatchObject({ accountId: 'phone' })
    expect(resolveTokenAccount(b, [root])).toMatchObject({ accountId: 'script' })
  })
})

describe('acp-auth: CCC 配置读（im 段）', () => {
  it('🔴 两者都真 ⇒ 启用（正控）', () => {
    const root = mkCcc({ channel: 'acp', acp: { enabled: true, accounts: [acct()] } })
    expect(acpChannelEnabled(root)).toBe(true)
    expect(expandAcpAccounts(root)).toEqual([]) // 尚未生成 token
  })

  it('🔴 channel=acp 但 enabled 未设 ⇒ **不算启用**（双键是「与」关系）', () => {
    const root = mkCcc({ channel: 'acp', acp: { accounts: [acct()] } })
    expect(acpChannelEnabled(root)).toBe(false)
  })

  it('🔴 enabled=true 但 channel 未指 acp ⇒ **不算启用**', () => {
    const root = mkCcc({ acp: { enabled: true, accounts: [acct()] } })
    expect(acpChannelEnabled(root)).toBe(false)
  })

  it('配置损坏（非法 JSON）⇒ 退回缺省 weixin（**绝不因读失败而放行 ACP**）', () => {
    const root = mkdtempSync(join(tmpdir(), 'acp-bad-'))
    made.push(root)
    mkdirSync(join(root, '.opencode'), { recursive: true })
    writeFileSync(join(root, '.serenity'), '')
    writeFileSync(join(root, '.opencode', 'serenity.json'), '{ this is not json')
    expect(readImSettings(root).channel).toBe('weixin')
    expect(acpChannelEnabled(root)).toBe(false)
    expect(expandAcpAccounts(root)).toEqual([])
  })

  it('🔴 账户 role 为空白 ⇒ 该账户**不出现**（防 `role: "  "` 绕过 fail-closed）', () => {
    const root = mkCcc({ channel: 'acp', acp: { enabled: true, accounts: [acct('a', '   ')] } })
    ensureAcpToken(root, 'a')
    expect(expandAcpAccounts(root)).toEqual([])
  })

  it('🔴 **没有 accounts ⇒ 一个账户都没有**（无简写退回；owner 2026-10-17 裁）', () => {
    const root = mkCcc({ channel: 'acp', acp: { enabled: true, role: 'tester' } })
    // 旧形态的 role 不再被当作"唯一账户" —— 必须写 accounts
    expect(expandAcpAccounts(root)).toEqual([])
    // 即便有人手搓了旧键，也不认
    writeEntry(root, 'credential', 'IM_ACP_TOKEN', 'a'.repeat(64))
    expect(resolveTokenAccount('a'.repeat(64), [root])).toBeNull()
  })

  it('accountId 为空白 ⇒ 跳过（凭据键无从派生）', () => {
    const root = mkCcc({ channel: 'acp', acp: { enabled: true, accounts: [{ accountId: '  ', role: 'tester' }] } })
    expect(expandAcpAccounts(root)).toEqual([])
  })

  it('enabled=false 的账户 ⇒ 不出现（撤一台设备不必删条目）', () => {
    const root = mkCcc({ channel: 'acp', acp: { enabled: true, accounts: [acct('off', 'tester', false)] } })
    ensureAcpToken(root, 'off')
    expect(expandAcpAccounts(root)).toEqual([])
  })
})

describe('acp-auth: 归属与越权防护', () => {
  it('resolveTokenAccount：认对号 ⇒ 返回该账户；认错号 ⇒ null', () => {
    const a = mkAcpCcc()
    const b = mkAcpCcc()
    const ta = readAcpToken(a, 'agmente-phone')!
    const tb = readAcpToken(b, 'agmente-phone')!
    expect(resolveTokenAccount(ta, [a, b])).toMatchObject({ root: a, role: 'tester' })
    expect(resolveTokenAccount(tb, [a, b])).toMatchObject({ root: b, role: 'tester' })
    expect(resolveTokenAccount('f'.repeat(64), [a, b])).toBeNull()
  })

  it('🔴 A 的 token **不会**被认成 B（一一对应，不是"容器里有一个就放行"）', () => {
    const a = mkAcpCcc()
    const b = mkAcpCcc()
    expect(resolveTokenAccount(readAcpToken(a, 'agmente-phone')!, [b])).toBeNull()
  })

  it('🔴 同 CCC 内**不同账户可有不同角色**（各管各的，不互相覆盖）', () => {
    const root = mkCcc({
      channel: 'acp',
      acp: {
        enabled: true,
        accounts: [
          { accountId: 'phone', role: 'tester' },
          { accountId: 'script', role: 'tester' },
        ],
      },
    })
    ensureAcpToken(root, 'phone')
    ensureAcpToken(root, 'script')
    const byPhone = resolveTokenAccount(readAcpToken(root, 'phone')!, [root])!
    const byScript = resolveTokenAccount(readAcpToken(root, 'script')!, [root])!
    expect(byPhone.accountId).toBe('phone')
    expect(byScript.accountId).toBe('script')
  })

  it('listAcpRoots：只收「启用通道 ＋ 至少一个可用账户」的 CCC', () => {
    const ok = mkAcpCcc()
    const noToken = mkCcc({ channel: 'acp', acp: { enabled: true, accounts: [acct()] } })
    const disabled = mkCcc({ channel: 'acp', acp: { enabled: false, accounts: [acct()] } })
    ensureAcpToken(disabled, 'agmente-phone')
    const weixin = mkCcc(undefined)
    expect(listAcpRoots([ok, noToken, disabled, weixin])).toEqual([ok])
  })

  it('🔴 cwd 越权：本 CCC 的 token **不能**把会话开到别的 CCC', () => {
    const root = '/home/x/ccc-a'
    expect(cwdInsideRoot(`${root}/sub`, root)).toBe(true)
    expect(cwdInsideRoot(root, root)).toBe(true)
    expect(cwdInsideRoot('/home/x/ccc-b', root)).toBe(false)
    expect(cwdInsideRoot('/home/x/ccc-a-sibling', root)).toBe(false)
  })

  it('常时比较：同长度错 token 也拒（防"只比长度"的假实现）', () => {
    const t = 'a'.repeat(64)
    expect(safeEqual(t, 'b'.repeat(64))).toBe(false)
    expect(safeEqual(t, t)).toBe(true)
    expect(safeEqual('short', 'longer')).toBe(false) // 长度不等不抛
  })
})

describe('acp-auth: authorizeAcpConnection（准入判决，fail-closed 四连）', () => {
  it('🔴 无 token ⇒ null', () => {
    const root = mkAcpCcc()
    expect(authorizeAcpConnection(null, [root])).toBeNull()
  })

  it('🔴 错 token ⇒ null', () => {
    const root = mkAcpCcc()
    expect(authorizeAcpConnection('f'.repeat(64), [root])).toBeNull()
  })

  it('🔴 CCC 未启用 ACP 通道 ⇒ null（token 对也不放行）', () => {
    const root = mkCcc({ channel: 'acp', acp: { enabled: false, accounts: [acct()] } })
    ensureAcpToken(root, 'agmente-phone')
    expect(authorizeAcpConnection(readAcpToken(root, 'agmente-phone'), [root])).toBeNull()
  })

  it('🔴 账户未配角色 ⇒ null（**不给一个无身份、无约束的裸 agent**）', () => {
    const root = mkCcc({ channel: 'acp', acp: { enabled: true, accounts: [acct('x', '')] } })
    ensureAcpToken(root, 'x')
    expect(authorizeAcpConnection(readAcpToken(root, 'x'), [root])).toBeNull()
  })

  it('全部齐备 ⇒ 放行（正控），返回归属 CCC ＋ 账户 ＋ 角色', () => {
    const root = mkAcpCcc()
    expect(authorizeAcpConnection(readAcpToken(root, 'agmente-phone'), [root])).toMatchObject({
      root,
      accountId: 'agmente-phone',
      role: 'tester',
    })
  })
})

describe('acp-auth: 「随即生成」token（owner 令的逐字要求）', () => {
  it('🔴 声明的账户在 ensureAcpChannelTokens 时**当场获得 token**（不必手敲命令）', () => {
    const root = mkCcc({
      channel: 'acp',
      acp: { enabled: true, accounts: [acct('phone'), acct('script')] },
    })
    expect(expandAcpAccounts(root)).toEqual([]) // 之前一个都不可用
    const created = ensureAcpChannelTokens(root)
    expect(created.sort()).toEqual(['phone', 'script'])
    expect(expandAcpAccounts(root)).toHaveLength(2)
    // 幂等：再跑一次不新生成
    expect(ensureAcpChannelTokens(root)).toEqual([])
  })

  it('🔴 只对**当前声明里**的账户生成：撤掉的账户不会被复活', () => {
    const root = mkCcc({ channel: 'acp', acp: { enabled: true, accounts: [acct('phone'), acct('script')] } })
    ensureAcpChannelTokens(root)
    expect(readAcpToken(root, 'script')).not.toBeNull()
    // 撤掉 script
    rewriteIm(root, { channel: 'acp', acp: { enabled: true, accounts: [acct('phone')] } })
    ensureAcpChannelTokens(root)
    // 不再被接受（即便 store 里还留着那个键）
    expect(resolveTokenAccount(readAcpToken(root, 'script')!, [root])).toBeNull()
    expect(expandAcpAccounts(root)).toHaveLength(1)
  })

  it('未启用通道的 CCC ⇒ 一个字节都不动（不生成任何 token）', () => {
    const root = mkCcc({ channel: 'acp', acp: { enabled: false, accounts: [acct()] } })
    expect(ensureAcpChannelTokens(root)).toEqual([])
    expect(readAcpToken(root, 'agmente-phone')).toBeNull()
  })
})

describe('🔴 acp-auth: 配置即真相（v1.59.1 的核心回归钉）', () => {
  it('改配置后**下一次判定**立即生效 —— 不需要重启，也不等任何事件', () => {
    const root = mkAcpCcc() // accounts: [agmente-phone]
    const token = readAcpToken(root, 'agmente-phone')!
    expect(authorizeAcpConnection(token, [root])).not.toBeNull()

    // 加一个账户 —— 同一进程、无重启、无事件
    rewriteIm(root, {
      channel: 'acp',
      acp: { enabled: true, accounts: [acct('agmente-phone'), acct('tablet')] },
    })
    const fresh = ensureAcpToken(root, 'tablet')
    expect(authorizeAcpConnection(fresh, [root])).toMatchObject({ accountId: 'tablet' })

    // 关掉整条通道 —— 下一次判定就该拒
    rewriteIm(root, { channel: 'acp', acp: { enabled: false, accounts: [acct('agmente-phone')] } })
    expect(authorizeAcpConnection(token, [root])).toBeNull()
  })

  it('🔴 撤销账户后，其 token **立刻不被接受**（即使 localstore 里还在）', () => {
    const root = mkAcpCcc()
    const token = readAcpToken(root, 'agmente-phone')!
    expect(authorizeAcpConnection(token, [root])).not.toBeNull()
    rewriteIm(root, { channel: 'acp', acp: { enabled: true, accounts: [] } })
    expect(authorizeAcpConnection(token, [root])).toBeNull()
    // 但 store 里的键确实还在 —— 证明"拒绝"来自配置，不是键被删了
    expect(readAcpToken(root, 'agmente-phone')).toBe(token)
  })
})

describe('acp-auth: 诊断面（绝不泄 token 明文）', () => {
  it('acpChannelStatus 逐账户给出 role/hasToken/指纹/可用性，**不含 token**', () => {
    const root = mkAcpCcc()
    const s = acpChannelStatus(root)
    expect(s.channel).toBe('acp')
    expect(s.enabled).toBe(true)
    expect(s.accounts).toHaveLength(1)
    const a = s.accounts[0]!
    expect(a).toMatchObject({ accountId: 'agmente-phone', role: 'tester', hasToken: true, usable: true, blockedBy: null })
    expect(a.tokenFingerprint).toMatch(/^[0-9a-f]{12}$/)
    // 整个返回值里不含 token 明文
    expect(JSON.stringify(s)).not.toContain(readAcpToken(root, 'agmente-phone')!)
  })

  it('🔴 不可用账户给出**能指向该改哪个字段**的原因', () => {
    const root = mkCcc({ channel: 'acp', acp: { enabled: true, accounts: [acct('x', '')] } })
    const a = acpChannelStatus(root).accounts[0]!
    expect(a.usable).toBe(false)
    expect(a.blockedBy).toContain('role')
  })

  it('🔴 token 重复出现在两个账户 ⇒ 审计**响亮报出**（不静默取第一个）', () => {
    const a = mkAcpCcc('tester', 'one')
    const b = mkAcpCcc('tester', 'two')
    const shared = 'c'.repeat(64)
    writeEntry(a, 'credential', acpTokenKeyFor('one'), shared)
    writeEntry(b, 'credential', acpTokenKeyFor('two'), shared)
    const audit = tokenOwnerAudit([a, b])
    expect(audit.duplicates).toHaveLength(1)
    expect(audit.duplicates[0]!.owners).toHaveLength(2)
  })

  it('无重复 ⇒ duplicates 为空（对照）', () => {
    const a = mkAcpCcc('tester', 'one')
    const b = mkAcpCcc('tester', 'two')
    expect(tokenOwnerAudit([a, b]).duplicates).toEqual([])
  })

  it('extractToken 认两种携带形态', () => {
    expect(extractToken({ authorization: 'Bearer abc123' }, '/acp')).toBe('abc123')
    expect(extractToken({}, '/acp?token=xyz')).toBe('xyz')
    expect(extractToken({}, '/acp')).toBeNull()
  })

  it('tokenFingerprint 不可逆且定长 12 位', () => {
    const f = tokenFingerprint('secret-value')
    expect(f).toMatch(/^[0-9a-f]{12}$/)
    expect(f).not.toContain('secret')
  })
})
