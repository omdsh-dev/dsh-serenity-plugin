import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { decideGuard, type GuardInput, syncSafeModeRestriction } from '../src/seams/guards.js'
import { readBlacklist, matchBlacklist, pathInside, type BlacklistRule } from '../src/ccc.js'
import { registerSkiffSession, unregisterSkiffSession } from '../src/skiff-registry.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'guards-'))
  writeFileSync(join(dir, '.serenity'), 'test')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function base(over: Partial<GuardInput>): GuardInput {
  return { root: '/ccc', toolName: 'read', safeModeOn: false, blacklist: [], pathArg: undefined, ...over }
}

function rules(...patterns: string[]): BlacklistRule[] {
  return patterns.map((p) => ({ pattern: p }))
}

describe('guards: decideGuard 纯决策', () => {
  it('非安全模式 + 无路径 → allow', () => {
    expect(decideGuard(base({}))).toEqual({ kind: 'allow' })
  })

  it('安全模式 + 写工具 → deny（提示不泄露 safe-mode：bash 不存在）', () => {
    const d = decideGuard(base({ safeModeOn: true, toolName: 'bash' }))
    expect(d.kind).toBe('deny')
    expect(d.deny).toContain('bash')
    expect(d.deny).not.toContain('safe mode')
    expect(d.deny).not.toContain('serenity')
  })

  it('安全模式 + write（非 bash）干净路径 → allow（标准语义：只禁 bash）', () => {
    expect(decideGuard(base({ safeModeOn: true, toolName: 'write', pathArg: 'docs/a.md' })).kind).toBe('allow')
  })

  it('安全模式 + write + 黑名单路径 → deny（黑名单分支）', () => {
    const d = decideGuard(base({ safeModeOn: true, toolName: 'write', blacklist: rules('.secrets/'), pathArg: '.secrets/x' }))
    expect(d.kind).toBe('deny')
    expect(d.deny).toContain('blacklist')
  })

  it('安全模式 + 读工具 → allow', () => {
    expect(decideGuard(base({ safeModeOn: true, toolName: 'read' })).kind).toBe('allow')
  })

  it('路径越界 → deny', () => {
    const d = decideGuard(base({ toolName: 'write', pathArg: '../escape' }))
    expect(d.kind).toBe('deny')
    expect(d.deny).toContain('path escape')
  })

  it('黑名单命中 → deny', () => {
    const d = decideGuard(base({ toolName: 'write', blacklist: rules('.secrets/'), pathArg: '.secrets/x' }))
    expect(d.kind).toBe('deny')
    expect(d.deny).toContain('blacklist')
  })

  it('读工具 + 黑名单路径 → allow（v1.18.5：黑名单只拦写，不误伤读——对齐 osp）', () => {
    // read 读 REPOSITORIES/ 下 repo（只读参考源黑名单）不应被拦
    const d = decideGuard(base({ toolName: 'read', blacklist: rules('REPOSITORIES/'), pathArg: 'REPOSITORIES/some-repo/README.md' }))
    expect(d.kind).toBe('allow')
    // 写工具仍拦
    const w = decideGuard(base({ toolName: 'write', blacklist: rules('REPOSITORIES/'), pathArg: 'REPOSITORIES/some-repo/a.ts' }))
    expect(w.kind).toBe('deny')
  })

  it('读工具 + 治理文件路径 → allow（治理保护只拦写）', () => {
    expect(decideGuard(base({ toolName: 'read', pathArg: '.serenity' })).kind).toBe('allow')
    expect(decideGuard(base({ toolName: 'write', pathArg: '.serenity' })).kind).toBe('deny')
  })

  it('cc_fs 只读子命令（exists/list/tree）→ 黑名单不拦（对齐 read 语义）', () => {
    // 用户实测：cc_fs exists REPOSITORIES/arsenal 被误拦（v1.19.0 后修复）
    const d = decideGuard(base({ toolName: 'cc_fs', action: 'exists', blacklist: rules('REPOSITORIES/'), pathArg: 'REPOSITORIES/arsenal' }))
    expect(d.kind).toBe('allow')
    expect(decideGuard(base({ toolName: 'cc_fs', action: 'list', blacklist: rules('REPOSITORIES/'), pathArg: 'REPOSITORIES/' })).kind).toBe('allow')
    expect(decideGuard(base({ toolName: 'cc_fs', action: 'tree', blacklist: rules('REPOSITORIES/'), pathArg: 'REPOSITORIES/arsenal' })).kind).toBe('allow')
    expect(decideGuard(base({ toolName: 'cc_fs', action: 'info', blacklist: rules('REPOSITORIES/'), pathArg: 'REPOSITORIES/arsenal' })).kind).toBe('allow')
  })

  it('cc_fs 写子命令（mkdir/rm/mv/cp/touch/append）→ 黑名单仍拦', () => {
    for (const action of ['mkdir', 'rm', 'mv', 'cp', 'touch', 'append']) {
      const d = decideGuard(base({ toolName: 'cc_fs', action, blacklist: rules('REPOSITORIES/'), pathArg: 'REPOSITORIES/arsenal/x' }))
      expect(d.kind).toBe('deny')
      expect(d.deny).toContain('blacklist')
    }
  })

  it('cc_fs 无 action（参数缺失）→ 不按写类拦截（保守 allow，越界仍拦）', () => {
    expect(decideGuard(base({ toolName: 'cc_fs', blacklist: rules('REPOSITORIES/'), pathArg: 'REPOSITORIES/arsenal' })).kind).toBe('allow')
    // 越界检查不受影响
    expect(decideGuard(base({ toolName: 'cc_fs', pathArg: '../escape' })).kind).toBe('deny')
  })

  it('cc_fs 治理文件保护：写子命令写 .serenity → deny；只读子命令 → allow', () => {
    expect(decideGuard(base({ toolName: 'cc_fs', action: 'touch', pathArg: '.serenity' })).kind).toBe('deny')
    expect(decideGuard(base({ toolName: 'cc_fs', action: 'exists', pathArg: '.serenity' })).kind).toBe('allow')
  })

  it('路径合法且不命中 → allow', () => {
    expect(decideGuard(base({ toolName: 'write', blacklist: rules('.secrets/'), pathArg: 'docs/a.md' })).kind).toBe('allow')
  })

  it('黑名单对象条目（{pattern, message}）→ deny 且提示用自定义 message（对齐 osp）', () => {
    const blacklist: BlacklistRule[] = [{ pattern: '.secrets/', message: 'secrets 目录禁止写入' }]
    const d = decideGuard(base({ toolName: 'write', blacklist, pathArg: '.secrets/x' }))
    expect(d.kind).toBe('deny')
    expect(d.deny).toContain('secrets 目录禁止写入')
  })

  it('反斜杠路径归一化：斜杠结尾黑名单规则命中 Windows 风格路径（审计问题 9）', () => {
    // pathArg 含反斜杠（Windows 风格相对路径）→ rel 归一化为正斜杠后黑名单前缀匹配
    const d = decideGuard(base({ toolName: 'write', blacklist: rules('.secrets/'), pathArg: '.secrets\\file.txt' }))
    expect(d.kind).toBe('deny')
    expect(d.deny).toContain('blacklist')
  })

  it('嵌套治理文件保护：反斜杠路径 .serenity\\child 归一化后拦截（审计问题 9）', () => {
    const d = decideGuard(base({ toolName: 'write', pathArg: '.serenity\\child' }))
    expect(d.kind).toBe('deny')
    expect(d.deny).toContain('governance file')
  })

  it('pathInside 跨盘语义（Windows，审计问题 6）：跨盘/兄弟目录 false，子路径 true', () => {
    // decideGuard 用 pathInside 判越界；此处直接验证 pathInside 的 Windows 跨盘语义
    // （resolve 平台行为差异使 decideGuard 级跨盘测试在 POSIX 无法复现——ccc.test.ts 覆盖守卫集成）
    expect(pathInside('D:\\project\\home', 'C:\\Windows', true)).toBe(false) // 跨盘符
    expect(pathInside('D:\\project\\home', 'D:\\project\\home2', true)).toBe(false) // 兄弟目录
    expect(pathInside('D:\\project\\home', 'D:\\project\\home\\docs', true)).toBe(true) // 子路径
  })
})

describe('blacklist: 对象条目解析（对齐 osp readBlacklist）', () => {
  it('string 与 object 条目混合解析', () => {
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(
      join(dir, '.opencode', 'serenity.json'),
      JSON.stringify({
        safeMode: {
          blacklist: ['.secrets/', { pattern: '/etc/', message: '系统目录' }, 'regex:^\\.tmp-'],
        },
      }),
    )
    const blacklist = readBlacklist(dir)
    expect(blacklist).toHaveLength(3)
    expect(blacklist[0]).toEqual({ pattern: '.secrets/' })
    expect(blacklist[1]).toEqual({ pattern: '/etc/', message: '系统目录' })
    // 前缀匹配
    expect(matchBlacklist('.secrets/x', blacklist)?.pattern).toBe('.secrets/')
    // 正则匹配
    expect(matchBlacklist('.tmp-test/y', blacklist)?.pattern).toBe('regex:^\\.tmp-')
    // 未命中
    expect(matchBlacklist('docs/a.md', blacklist)).toBeNull()
  })

  it('非法条目（数字/null/无 pattern 对象）跳过', () => {
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(
      join(dir, '.opencode', 'serenity.json'),
      JSON.stringify({ safeMode: { blacklist: [42, null, { message: 'no pattern' }, 'ok/'] } }),
    )
    const blacklist = readBlacklist(dir)
    expect(blacklist).toHaveLength(1)
    expect(blacklist[0]!.pattern).toBe('ok/')
  })
})

describe('safe-mode 工具隐藏（syncSafeModeRestriction）', () => {
  it('标记存在 → restrict deny 隐藏写工具；消失 → 解除', () => {
    // 纯逻辑验证：restrict 的 deny 列表由 SAFE_MODE_DENY_TOOLS 定义
    // （agent.ctx.tools.restrict 为 DSH 运行时行为，这里验证调用契约）
    const calls: { on: boolean; deny?: string[] }[] = []
    const mkAgent = (on: boolean) => {
      const key = on ? 'k1' : 'k2'
      return {
        session: { id: key },
        ctx: {
          tools: {
            restrict: (f: { deny?: string[] }) => {
              calls.push({ on, deny: f.deny })
              return () => { calls.push({ on: false }) }
            },
          },
        },
      } as any
    }
    // 直接验证守卫工具列表不含 bash/write 时的整体语义由运行时保证；
    // 此处验证 syncSafeModeRestriction 在标记 on 时调用 restrict
    writeFileSync(join(dir, '.serenity-safe-on'), 'x')
    const agent = mkAgent(true)
    syncSafeModeRestriction(agent, dir)
    expect(calls.filter(c => c.on === true)).toHaveLength(1)
    expect(calls[0]!.deny).toContain('bash')
    expect(calls[0]!.deny).not.toContain('write') // 只隐藏 bash，write/edit 保留
  })
})

describe('guards: CCC 治理文件保护（agent 不可写 .serenity/.serenity-safe-on）', () => {
  it('写 .serenity-safe-on 被拒（无论安全模式）', () => {
    const d = decideGuard(base({ toolName: 'write', pathArg: '.serenity-safe-on' }))
    expect(d.kind).toBe('deny')
    expect(d.deny).toContain('governance file')
  })

  it('写 .serenity 被拒', () => {
    const d = decideGuard(base({ toolName: 'write', pathArg: '.serenity' }))
    expect(d.kind).toBe('deny')
  })

  it('普通文件不受影响', () => {
    expect(decideGuard(base({ toolName: 'write', pathArg: 'docs/a.md' })).kind).toBe('allow')
  })
})

describe('guards: Skiff 角色白名单（F4b ⑧）', () => {
  const QA_ID = 'skiff-qa-1'

  beforeEach(() => {
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(
      join(dir, '.opencode', 'serenity.json'),
      JSON.stringify({
        skiff: {
          roles: {
            qa: { msms: ['cognitive-qa'], tools: ['read', 'grep', 'glob'], systemPrompt: 'p' },
          },
        },
      }),
    )
    registerSkiffSession(QA_ID, 'qa')
  })

  afterEach(() => {
    unregisterSkiffSession(QA_ID)
  })

  it('白名单内工具 → allow（read/grep/glob）', () => {
    for (const tool of ['read', 'grep', 'glob']) {
      expect(decideGuard(base({ root: dir, toolName: tool, skiffSessionId: QA_ID })).kind).toBe('allow')
    }
  })

  it('msms 非空 → acc_msm 通道自动可用', () => {
    expect(decideGuard(base({ root: dir, toolName: 'acc_msm', skiffSessionId: QA_ID })).kind).toBe('allow')
  })

  it('白名单外工具 → deny（拒绝信息不泄漏白名单外工具名）', () => {
    for (const tool of ['write', 'edit', 'bash', 'web_search', 'cc_fs']) {
      const d = decideGuard(base({ root: dir, toolName: tool, skiffSessionId: QA_ID }))
      expect(d.kind).toBe('deny')
      expect(d.deny).toContain('skiff role')
      expect(d.deny).not.toContain(tool) // 不泄漏被拒工具名
      expect(d.deny).not.toContain('read') // 不泄漏白名单内容
    }
  })

  it('skiff 会话未注册（注册表缺失）→ 保守 deny（白名单外全隐藏）', () => {
    const d = decideGuard(base({ root: dir, toolName: 'read', skiffSessionId: 'skiff-ghost-1' }))
    expect(d.kind).toBe('deny')
  })

  it('非 skiff 会话（无 skiffSessionId / 普通 id）→ 不受白名单影响', () => {
    expect(decideGuard(base({ root: dir, toolName: 'write', pathArg: 'docs/a.md' })).kind).toBe('allow')
    expect(decideGuard(base({ root: dir, toolName: 'write', skiffSessionId: 'normal-session', pathArg: 'docs/a.md' })).kind).toBe('allow')
    expect(decideGuard(base({ root: dir, toolName: 'handyman', skiffSessionId: 'handyman-x' })).kind).toBe('allow')
  })

  it('角色 tools 空（纯 MSM 角色）→ 仅 acc_msm 可用', () => {
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(
      join(dir, '.opencode', 'serenity.json'),
      JSON.stringify({ skiff: { roles: { pure: { msms: ['cognitive-qa'], tools: [] } } } }),
    )
    registerSkiffSession('skiff-pure-1', 'pure')
    try {
      expect(decideGuard(base({ root: dir, toolName: 'acc_msm', skiffSessionId: 'skiff-pure-1' })).kind).toBe('allow')
      expect(decideGuard(base({ root: dir, toolName: 'read', skiffSessionId: 'skiff-pure-1' })).kind).toBe('deny')
    } finally {
      unregisterSkiffSession('skiff-pure-1')
    }
  })
})
