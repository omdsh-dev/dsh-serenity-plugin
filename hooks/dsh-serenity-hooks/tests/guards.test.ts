import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  decideGuard,
  type GuardInput,
  syncSafeModeRestriction,
  syncImBridgeVisibility,
  forgetImBridgeVisibility,
  getImBridgeVisibilityDiagnostics,
  syncExclusiveToolsVisibility,
  forgetExclusiveToolsVisibility,
  getExclusiveToolsDiagnostics,
  syncCccToolVisibility,
  forgetNonCccToolVisibility,
  getNonCccHiddenDiagnostics,
  syncHostScheduleToolHiding,
  forgetHostScheduleToolHiding,
  getHostScheduleHiddenDiagnostics,
} from '../src/seams/guards.js'
import { REGISTERED_TOOLS, CONDITIONAL_TOOL_COUNT } from '../src/invariant.js'
import { registerImChannel, __resetImChannelsForTest } from '../src/im-bridge.js'
import { readBlacklist, matchBlacklist, pathInside, readSafeModeHiddenTools, type BlacklistRule } from '../src/ccc.js'
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

  it('container_fs 只读子命令（exists/list/tree）→ 黑名单不拦（对齐 read 语义）', () => {
    // 用户实测：container_fs exists REPOSITORIES/arsenal 被误拦（v1.19.0 后修复）
    const d = decideGuard(base({ toolName: 'container_fs', action: 'exists', blacklist: rules('REPOSITORIES/'), pathArg: 'REPOSITORIES/arsenal' }))
    expect(d.kind).toBe('allow')
    expect(decideGuard(base({ toolName: 'container_fs', action: 'list', blacklist: rules('REPOSITORIES/'), pathArg: 'REPOSITORIES/' })).kind).toBe('allow')
    expect(decideGuard(base({ toolName: 'container_fs', action: 'tree', blacklist: rules('REPOSITORIES/'), pathArg: 'REPOSITORIES/arsenal' })).kind).toBe('allow')
    expect(decideGuard(base({ toolName: 'container_fs', action: 'info', blacklist: rules('REPOSITORIES/'), pathArg: 'REPOSITORIES/arsenal' })).kind).toBe('allow')
  })

  it('container_fs 写子命令（mkdir/rm/mv/cp/touch/append）→ 黑名单仍拦', () => {
    for (const action of ['mkdir', 'rm', 'mv', 'cp', 'touch', 'append']) {
      const d = decideGuard(base({ toolName: 'container_fs', action, blacklist: rules('REPOSITORIES/'), pathArg: 'REPOSITORIES/arsenal/x' }))
      expect(d.kind).toBe('deny')
      expect(d.deny).toContain('blacklist')
    }
  })

  it('container_fs 无 action（参数缺失）→ 不按写类拦截（保守 allow，越界仍拦）', () => {
    expect(decideGuard(base({ toolName: 'container_fs', blacklist: rules('REPOSITORIES/'), pathArg: 'REPOSITORIES/arsenal' })).kind).toBe('allow')
    // 越界检查不受影响
    expect(decideGuard(base({ toolName: 'container_fs', pathArg: '../escape' })).kind).toBe('deny')
  })

  it('container_fs 治理文件保护：写子命令写 .serenity → deny；只读子命令 → allow', () => {
    expect(decideGuard(base({ toolName: 'container_fs', action: 'touch', pathArg: '.serenity' })).kind).toBe('deny')
    expect(decideGuard(base({ toolName: 'container_fs', action: 'exists', pathArg: '.serenity' })).kind).toBe('allow')
  })

  // ── v1.26.3 数据面守卫：localstore.json 凭据文件任何工具不可读（S142 用户指令）──

  it('read localstore.json → deny（用户：localstore.json 需要在 read 工具的黑名单里）', () => {
    const d = decideGuard(base({ toolName: 'read', pathArg: 'localstore.json' }))
    expect(d.kind).toBe('deny')
    expect(d.deny).toContain('sensitive credential file')
    // 不依赖 safe-mode 开关（结构性边界）
    expect(decideGuard(base({ toolName: 'read', safeModeOn: true, pathArg: 'localstore.json' })).kind).toBe('deny')
  })

  it('grep/glob/container_fs 只读子命令 localstore.json → deny（数据面不看工具读写性）', () => {
    expect(decideGuard(base({ toolName: 'grep', pathArg: 'localstore.json' })).kind).toBe('deny')
    expect(decideGuard(base({ toolName: 'glob', pathArg: 'localstore.json' })).kind).toBe('deny')
    expect(decideGuard(base({ toolName: 'container_fs', action: 'info', pathArg: 'localstore.json' })).kind).toBe('deny')
    // 嵌套目录同名文件不误伤（凭据文件只在根）
    expect(decideGuard(base({ toolName: 'read', pathArg: 'docs/localstore.json' })).kind).toBe('allow')
  })

  it('写工具 localstore.json → deny（写入同样阻断——凭据文件不可由 agent 改写）', () => {
    expect(decideGuard(base({ toolName: 'write', pathArg: 'localstore.json' })).kind).toBe('deny')
    expect(decideGuard(base({ toolName: 'container_fs', action: 'touch', pathArg: 'localstore.json' })).kind).toBe('deny')
  })

  it('凭据文件守卫先于黑名单/读保护（localstore.json 恒 deny 无论 blacklist）', () => {
    const d = decideGuard(base({ toolName: 'read', blacklist: rules('.secrets/'), pathArg: 'localstore.json' }))
    expect(d.kind).toBe('deny')
    expect(d.deny).toContain('sensitive credential file')
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

describe('readSafeModeHiddenTools（判据：fail-open）', () => {
  function write(cfg: unknown): void {
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'serenity.json'), typeof cfg === 'string' ? cfg : JSON.stringify(cfg))
  }

  it('未配置 / 无该键 / 非数组 ⇒ []（不抛）', () => {
    expect(readSafeModeHiddenTools(dir)).toEqual([])
    write({ safeMode: {} })
    expect(readSafeModeHiddenTools(dir)).toEqual([])
    write({ safeMode: { hiddenTools: 'workflow' } })
    expect(readSafeModeHiddenTools(dir)).toEqual([])
  })

  it('读数组 / 去空白 / 丢非字符串 / 保序', () => {
    write({ safeMode: { hiddenTools: [' workflow ', 42, null, '', 'job_kill'] } })
    expect(readSafeModeHiddenTools(dir)).toEqual(['workflow', 'job_kill'])
  })

  it('🔴 配置损坏 ⇒ []（fail-open：隐藏是危险方向，读不到声明就不多藏）', () => {
    write('{ this is not json')
    expect(() => readSafeModeHiddenTools(dir)).not.toThrow()
    expect(readSafeModeHiddenTools(dir)).toEqual([])
  })
})

describe('safe-mode 工具隐藏（syncSafeModeRestriction）', () => {
  /**
   * 替身 agent：记录 restrict 调用与 disposer 触发。
   * `rejectUnknown` 复刻宿主契约——**未注册的工具名会让整次 restrict 失败**
   * （`dsh-tools` 类型面逐字："Empty filters, unknown names, scope-local names,
   * and reserved transport names fail"）。
   */
  function mkAgent(id: string, opts: { rejectUnknown?: string } = {}) {
    const calls: { deny?: string[] }[] = []
    const disposed: string[] = []
    const agent = {
      session: { id },
      ctx: {
        tools: {
          restrict: (f: { deny?: string[] }) => {
            if (opts.rejectUnknown !== undefined && (f.deny ?? []).includes(opts.rejectUnknown)) {
              throw new Error(`unknown tool: ${opts.rejectUnknown}`)
            }
            calls.push(f)
            return () => { disposed.push((f.deny ?? []).join(',')) }
          },
        },
      },
    } as any
    return { agent, calls, disposed }
  }

  function declareHidden(list: unknown): void {
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({ safeMode: { hiddenTools: list } }))
  }

  it('未声明 → 只隐藏基础表（bash），write/edit 保留', () => {
    writeFileSync(join(dir, '.serenity-safe-on'), 'x')
    const m = mkAgent('sm-base')
    syncSafeModeRestriction(m.agent, dir)
    expect(m.calls).toHaveLength(1)
    expect(m.calls[0]!.deny).toEqual(['bash'])
    expect(m.calls[0]!.deny).not.toContain('write')
  })

  it('声明 hiddenTools → deny = 基础表 ∪ 声明（安全模式开启期间）', () => {
    writeFileSync(join(dir, '.serenity-safe-on'), 'x')
    declareHidden(['workflow', 'job_kill'])
    const m = mkAgent('sm-declared')
    syncSafeModeRestriction(m.agent, dir)
    expect(m.calls).toHaveLength(1)
    expect(m.calls[0]!.deny).toEqual(['bash', 'workflow', 'job_kill'])
  })

  it('无安全模式标记 → 声明不生效（一次 restrict 都不发）', () => {
    declareHidden(['workflow'])
    const m = mkAgent('sm-off')
    syncSafeModeRestriction(m.agent, dir)
    expect(m.calls).toHaveLength(0)
  })

  it('标记消失 → 解除隐藏（disposer 被调用），且是可逆的', () => {
    writeFileSync(join(dir, '.serenity-safe-on'), 'x')
    declareHidden(['workflow'])
    const m = mkAgent('sm-toggle')
    syncSafeModeRestriction(m.agent, dir)
    expect(m.calls).toHaveLength(1)
    rmSync(join(dir, '.serenity-safe-on'))
    syncSafeModeRestriction(m.agent, dir)
    expect(m.disposed).toEqual(['bash,workflow'])
  })

  it('清单未变 → 幂等（不重复 restrict）', () => {
    writeFileSync(join(dir, '.serenity-safe-on'), 'x')
    declareHidden(['workflow'])
    const m = mkAgent('sm-idem')
    syncSafeModeRestriction(m.agent, dir)
    syncSafeModeRestriction(m.agent, dir)
    expect(m.calls).toHaveLength(1)
  })

  it('🔴 改声明 → 热重算（解除旧的，应用新的）', () => {
    writeFileSync(join(dir, '.serenity-safe-on'), 'x')
    declareHidden(['workflow'])
    const m = mkAgent('sm-reload')
    syncSafeModeRestriction(m.agent, dir)
    expect(m.calls[0]!.deny).toEqual(['bash', 'workflow'])
    declareHidden(['workflow', 'interrupt_agent'])
    syncSafeModeRestriction(m.agent, dir)
    expect(m.disposed).toEqual(['bash,workflow'])
    expect(m.calls).toHaveLength(2)
    expect(m.calls[1]!.deny).toEqual(['bash', 'workflow', 'interrupt_agent'])
  })

  it('🔴 未注册的名字 → 整次 restrict 失败 ⇒ 退化为基础表（不丢掉 bash 的隐藏）', () => {
    writeFileSync(join(dir, '.serenity-safe-on'), 'x')
    declareHidden(['workflow', 'not_a_real_tool'])
    const m = mkAgent('sm-unknown', { rejectUnknown: 'not_a_real_tool' })
    syncSafeModeRestriction(m.agent, dir)
    expect(m.calls).toHaveLength(1)
    expect(m.calls[0]!.deny).toEqual(['bash'])
  })

  it('退化态按期望签名记账 ⇒ 下一步不重试刷屏', () => {
    writeFileSync(join(dir, '.serenity-safe-on'), 'x')
    declareHidden(['not_a_real_tool'])
    const m = mkAgent('sm-unknown-idem', { rejectUnknown: 'not_a_real_tool' })
    syncSafeModeRestriction(m.agent, dir)
    syncSafeModeRestriction(m.agent, dir)
    expect(m.calls).toHaveLength(1)
  })

  it('非法声明项（数字/空白）跳过，只留字符串', () => {
    writeFileSync(join(dir, '.serenity-safe-on'), 'x')
    declareHidden([42, null, '  ', 'workflow'])
    const m = mkAgent('sm-invalid')
    syncSafeModeRestriction(m.agent, dir)
    expect(m.calls[0]!.deny).toEqual(['bash', 'workflow'])
  })

  it('声明与基础表重名 ⇒ 去重', () => {
    writeFileSync(join(dir, '.serenity-safe-on'), 'x')
    declareHidden(['bash', 'workflow'])
    const m = mkAgent('sm-dedupe')
    syncSafeModeRestriction(m.agent, dir)
    expect(m.calls[0]!.deny).toEqual(['bash', 'workflow'])
  })
})

describe('guards: im-bridge 条件可见（v1.31.0——未配置 IM 通道则工具不可见）', () => {
  /** 替身 agent：记录 restrict 调用与 disposer 触发 */
  function mkAgent(id = 's-im') {
    const restrictCalls: { deny?: string[] }[] = []
    const disposed: string[] = []
    const agent = {
      session: { id },
      ctx: {
        tools: {
          restrict: (f: { deny?: string[] }) => {
            restrictCalls.push(f)
            return () => { disposed.push('disposed') }
          },
        },
      },
    } as any
    return { agent, restrictCalls, disposed }
  }

  afterEach(() => {
    __resetImChannelsForTest()
  })

  it('未配置任何 IM 通道 → restrict deny im-bridge；重复同步幂等（只隐藏一次）', () => {
    __resetImChannelsForTest()
    const { agent, restrictCalls } = mkAgent()
    syncImBridgeVisibility(agent, dir)
    syncImBridgeVisibility(agent, dir)
    expect(restrictCalls).toHaveLength(1)
    expect(restrictCalls[0]!.deny).toEqual(['im-bridge'])
  })

  it('配置了通道 → 不隐藏（工具可见）', () => {
    __resetImChannelsForTest()
    registerImChannel({ id: 'fake', isEnabled: () => true } as never)
    const { agent, restrictCalls } = mkAgent()
    syncImBridgeVisibility(agent, dir)
    expect(restrictCalls).toHaveLength(0)
  })

  it('配置从有到无 / 从无到有 → 隐藏与解除实时跟随（配置热更新）', () => {
    __resetImChannelsForTest()
    const { agent, restrictCalls, disposed } = mkAgent()
    syncImBridgeVisibility(agent, dir) // 无通道 → 隐藏
    expect(restrictCalls).toHaveLength(1)
    registerImChannel({ id: 'fake', isEnabled: () => true } as never)
    syncImBridgeVisibility(agent, dir) // 有通道 → 解除
    expect(disposed).toHaveLength(1)
    syncImBridgeVisibility(agent, dir) // 已解除 → 不再动作
    expect(restrictCalls).toHaveLength(1)
  })

  it('restrict 抛错 → 不抛且不记状态（apply/step 不可被拖垮）', () => {
    __resetImChannelsForTest()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const agent = {
      session: { id: 's-boom' },
      ctx: { tools: { restrict: () => { throw new Error('restrict unavailable') } } },
    } as any
    expect(() => syncImBridgeVisibility(agent, dir)).not.toThrow()
    expect(err.mock.calls.some((c) => String(c[0]).includes('im-bridge 隐藏失败'))).toBe(true)
    err.mockRestore()
  })

  it('会话销毁清理：forgetImBridgeVisibility 解除隐藏并清状态（防 per-会话 Map 无界增长）', () => {
    __resetImChannelsForTest()
    const { agent, disposed } = mkAgent('s-gone')
    syncImBridgeVisibility(agent, dir)
    expect(getImBridgeVisibilityDiagnostics().hiddenKeys).toContain('s-gone')
    forgetImBridgeVisibility('s-gone')
    expect(disposed).toHaveLength(1)
    expect(getImBridgeVisibilityDiagnostics().hiddenKeys).not.toContain('s-gone')
    forgetImBridgeVisibility('s-gone') // 幂等
    expect(disposed).toHaveLength(1)
  })

  it('不同会话各自独立（一个会话的隐藏不影响另一个）', () => {
    __resetImChannelsForTest()
    const a = mkAgent('s-a')
    const b = mkAgent('s-b')
    syncImBridgeVisibility(a.agent, dir)
    expect(getImBridgeVisibilityDiagnostics().hiddenKeys).toEqual(['s-a'])
    expect(b.restrictCalls).toHaveLength(0)
  })
})

describe('guards: 专属工具条件可见（v1.33——未在 exclusiveTools 里声明则工具不可见）', () => {
  /** 替身 agent（同 im-bridge 块形状） */
  function mkAgent(id: string) {
    const restrictCalls: { deny?: string[] }[] = []
    const disposed: string[] = []
    const agent = {
      session: { id },
      ctx: {
        tools: {
          restrict: (f: { deny?: string[] }) => {
            restrictCalls.push(f)
            return () => { disposed.push('disposed') }
          },
        },
      },
    } as any
    return { agent, restrictCalls, disposed }
  }

  /** 写 CCC 配置（undefined = 不写 exclusiveTools 字段） */
  function writeConfig(exclusiveTools?: unknown): void {
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(
      join(dir, '.opencode', 'serenity.json'),
      JSON.stringify(exclusiveTools === undefined ? { hooks: {} } : { exclusiveTools }),
    )
  }

  it('未声明（字段缺失）→ restrict deny acc-diag；重复同步幂等（只隐藏一次）', () => {
    writeConfig(undefined)
    const { agent, restrictCalls } = mkAgent('s-diag-a')
    syncExclusiveToolsVisibility(agent, dir)
    syncExclusiveToolsVisibility(agent, dir)
    expect(restrictCalls).toHaveLength(1)
    expect(restrictCalls[0]!.deny).toEqual(['acc-diag'])
    forgetExclusiveToolsVisibility('s-diag-a')
  })

  it('声明 ["acc-diag"] → 不隐藏（工具可见）', () => {
    writeConfig(['acc-diag'])
    const { agent, restrictCalls } = mkAgent('s-diag-b')
    syncExclusiveToolsVisibility(agent, dir)
    expect(restrictCalls).toHaveLength(0)
  })

  it('声明 → 取消声明 → 再声明：隐藏与解除实时跟随（配置热更新）', () => {
    writeConfig(undefined)
    const { agent, restrictCalls, disposed } = mkAgent('s-diag-c')
    syncExclusiveToolsVisibility(agent, dir) // 未声明 → 隐藏
    expect(restrictCalls).toHaveLength(1)
    writeConfig(['acc-diag'])
    syncExclusiveToolsVisibility(agent, dir) // 声明 → 解除
    expect(disposed).toHaveLength(1)
    syncExclusiveToolsVisibility(agent, dir) // 已解除 → 不再动作
    expect(restrictCalls).toHaveLength(1)
  })

  it('配置损坏（坏 JSON）→ fail-closed 隐藏（专属工具默认不可见；配置损坏本身响亮告警）', () => {
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'serenity.json'), '{ broken')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { agent, restrictCalls } = mkAgent('s-diag-d')
    syncExclusiveToolsVisibility(agent, dir)
    expect(restrictCalls[0]?.deny).toEqual(['acc-diag'])
    expect(warn.mock.calls.some((c) => String(c[0]).includes('CCC 配置解析失败'))).toBe(true)
    warn.mockRestore()
    forgetExclusiveToolsVisibility('s-diag-d')
  })

  it('非字符串项被忽略（只认字符串工具名）', () => {
    writeConfig(['acc-diag', 42, null, '  '])
    const { agent, restrictCalls } = mkAgent('s-diag-e')
    syncExclusiveToolsVisibility(agent, dir)
    expect(restrictCalls).toHaveLength(0)
  })

  it('restrict 抛错 → 不抛且不记状态（step 不可被拖垮）', () => {
    writeConfig(undefined)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const agent = {
      session: { id: 's-diag-boom' },
      ctx: { tools: { restrict: () => { throw new Error('restrict unavailable') } } },
    } as any
    expect(() => syncExclusiveToolsVisibility(agent, dir)).not.toThrow()
    expect(err.mock.calls.some((c) => String(c[0]).includes('专属工具隐藏失败'))).toBe(true)
    err.mockRestore()
  })

  it('会话销毁清理：forgetExclusiveToolsVisibility 解除隐藏并清状态（防 per-会话 Map 无界增长）', () => {
    writeConfig(undefined)
    const { agent, disposed } = mkAgent('s-diag-gone')
    syncExclusiveToolsVisibility(agent, dir)
    expect(getExclusiveToolsDiagnostics().hidden).toContain('s-diag-gone::acc-diag')
    forgetExclusiveToolsVisibility('s-diag-gone')
    expect(disposed).toHaveLength(1)
    expect(getExclusiveToolsDiagnostics().hidden).not.toContain('s-diag-gone::acc-diag')
    forgetExclusiveToolsVisibility('s-diag-gone') // 幂等
    expect(disposed).toHaveLength(1)
  })

  it('不同会话各自独立（一个会话的隐藏不影响另一个）', () => {
    writeConfig(undefined)
    const a = mkAgent('s-diag-x')
    const b = mkAgent('s-diag-y')
    syncExclusiveToolsVisibility(a.agent, dir)
    expect(getExclusiveToolsDiagnostics().hidden).toContain('s-diag-x::acc-diag')
    expect(b.restrictCalls).toHaveLength(0)
    forgetExclusiveToolsVisibility('s-diag-x')
  })
})

/**
 * 🔴 v1.56.6（owner 2026-10-13 报缺陷）：「宁静号所有功能在非宁静号目录不生效」。
 *
 * 靶 = **工具可见性这一层唯独没有非 CCC 的门**：工具注册在宿主级 ⇒ 与会话 cwd 无关地
 * 出现在每个会话清单里；其余各缝有 `if (!root) return`，而这里没有 ⇒ 非 CCC 目录下
 * 模型仍看得见 14 个工具，调了才抛 `No CCC found`（**运行时报错 ≠ 事先不可见**）。
 *
 * ⚠️ **本组必须同时钉两态**：只钉"非 CCC 隐藏"会漏掉"CCC 内**一次 restrict 都不发**"
 * —— 后半条是"既有行为零改变"的机械证据（否则修复会把 CCC 内的可见性也改坏）。
 */
describe('guards: 非 CCC 会话的全工具面隐藏（v1.56.6）', () => {
  /** 替身 agent（同前两块形状） */
  function mkAgent(id: string) {
    const restrictCalls: { deny?: string[] }[] = []
    const disposed: string[] = []
    const agent = {
      session: { id },
      ctx: {
        tools: {
          restrict: (f: { deny?: string[] }) => {
            restrictCalls.push(f)
            return () => { disposed.push('disposed') }
          },
        },
      },
    } as any
    return { agent, restrictCalls, disposed }
  }

  it('🔴 不在 CCC 内（root=null）⇒ restrict 隐藏**全部** REGISTERED_TOOLS', () => {
    const { agent, restrictCalls } = mkAgent('s-noccc-a')
    syncCccToolVisibility(agent, null)
    expect(restrictCalls).toHaveLength(1)
    // 与"插件具备的工具面"对齐（不硬编码清单——加工具时本条自动跟随）
    expect(restrictCalls[0]!.deny).toEqual([...REGISTERED_TOOLS])
    forgetNonCccToolVisibility('s-noccc-a')
  })

  it('🔴 在 CCC 内（root 为真）⇒ **一次 restrict 都不发**（既有行为零改变）', () => {
    const { agent, restrictCalls } = mkAgent('s-noccc-b')
    syncCccToolVisibility(agent, dir)
    expect(restrictCalls).toHaveLength(0)
  })

  it('幂等：重复同步非 CCC 不重复 restrict', () => {
    const { agent, restrictCalls } = mkAgent('s-noccc-c')
    syncCccToolVisibility(agent, null)
    syncCccToolVisibility(agent, null)
    syncCccToolVisibility(agent, null)
    expect(restrictCalls).toHaveLength(1)
    forgetNonCccToolVisibility('s-noccc-c')
  })

  it('🔴 会话从非 CCC 迁入 CCC ⇒ 解除隐藏（可逆）', () => {
    const { agent, restrictCalls, disposed } = mkAgent('s-noccc-d')
    syncCccToolVisibility(agent, null)
    expect(restrictCalls).toHaveLength(1)
    syncCccToolVisibility(agent, dir) // 迁入 CCC
    expect(disposed).toHaveLength(1)
    expect(getNonCccHiddenDiagnostics().hidden).not.toContain('s-noccc-d')
  })

  it('不同会话各自独立（非 CCC 的隐藏不波及 CCC 内的会话）', () => {
    const a = mkAgent('s-noccc-e')
    const b = mkAgent('s-noccc-f')
    syncCccToolVisibility(a.agent, null)
    syncCccToolVisibility(b.agent, dir)
    expect(getNonCccHiddenDiagnostics().hidden).toEqual(['s-noccc-e'])
    expect(b.restrictCalls).toHaveLength(0)
    forgetNonCccToolVisibility('s-noccc-e')
  })

  it('会话销毁清理：forgetNonCccToolVisibility 解除隐藏并清状态（防 Map 无界增长）', () => {
    const { agent, disposed } = mkAgent('s-noccc-gone')
    syncCccToolVisibility(agent, null)
    expect(getNonCccHiddenDiagnostics().hidden).toContain('s-noccc-gone')
    forgetNonCccToolVisibility('s-noccc-gone')
    expect(disposed).toHaveLength(1)
    expect(getNonCccHiddenDiagnostics().hidden).not.toContain('s-noccc-gone')
    forgetNonCccToolVisibility('s-noccc-gone') // 幂等
    expect(disposed).toHaveLength(1)
  })

  it('restrict 抛错 → 不抛且不记状态（step 不可被拖垮；调用时仍有各工具自身的 !root 兜底）', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const agent = {
      session: { id: 's-noccc-boom' },
      ctx: { tools: { restrict: () => { throw new Error('restrict unavailable') } } },
    } as any
    expect(() => syncCccToolVisibility(agent, null)).not.toThrow()
    expect(err.mock.calls.some((c) => String(c[0]).includes('两档全失败'))).toBe(true)
    expect(getNonCccHiddenDiagnostics().hidden).not.toContain('s-noccc-boom')
    err.mockRestore()
  })

  it('🔴 对照：宿主 `restrict` 对未注册名会让整次失败 ⇒ deny 清单必须只含 REGISTERED_TOOLS 里的名字', () => {
    // 复刻宿主契约（同 safe-mode 块）：未知名字 ⇒ 抛
    const known = new Set<string>(REGISTERED_TOOLS)
    const agent = {
      session: { id: 's-noccc-contract' },
      ctx: {
        tools: {
          restrict: (f: { deny?: string[] }) => {
            for (const n of f.deny ?? []) if (!known.has(n)) throw new Error(`unknown tool: ${n}`)
            return () => {}
          },
        },
      },
    } as any
    // 真契约下必须成功（若清单里混入未注册名，这里会抛 ⇒ 隐藏整体失效）
    expect(() => syncCccToolVisibility(agent, null)).not.toThrow()
    expect(getNonCccHiddenDiagnostics().hidden).toContain('s-noccc-contract')
    forgetNonCccToolVisibility('s-noccc-contract')
  })

  it('🔴 两档尝试：全表被拒（条件工具不在册）⇒ 退到常驻段，**仍然隐藏**（不静默退回"可见"）', () => {
    // 复刻"diagram 关着"的真实形态：`diagram` 未注册 ⇒ 全表 deny 被整次拒绝
    const residentKnown = new Set<string>(
      REGISTERED_TOOLS.slice(0, REGISTERED_TOOLS.length - CONDITIONAL_TOOL_COUNT),
    )
    const calls: { deny?: string[] }[] = []
    const agent = {
      session: { id: 's-noccc-tier' },
      ctx: {
        tools: {
          restrict: (f: { deny?: string[] }) => {
            for (const n of f.deny ?? []) if (!residentKnown.has(n)) throw new Error(`unknown tool: ${n}`)
            calls.push(f)
            return () => {}
          },
        },
      },
    } as any
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(() => syncCccToolVisibility(agent, null)).not.toThrow()
    // 第一次（全表）被拒、第二次（常驻段）成功 ⇒ **只记一次** restrict 调用（档①那次没记）
    expect(calls).toHaveLength(1)
    expect(calls[0]!.deny).toEqual([...residentKnown])
    // 判别性：**必须真的隐藏了常驻段**，而不是"两档都失败、静默放过"
    expect(getNonCccHiddenDiagnostics().hidden).toContain('s-noccc-tier')
    // 🔴 档①失败是**常态**（diagram 缺省不在册）⇒ **不许**刷假警报（只看得到"两档全失败"那种真失败）
    expect(err.mock.calls.some((c) => String(c[0]).includes('两档全失败'))).toBe(false)
    err.mockRestore()
    forgetNonCccToolVisibility('s-noccc-tier')
  })

  it('🔴 两档全失败 ⇒ 不记状态（下轮可重试）＋ 响亮告警（不静默假成功）', () => {
    const agent = {
      session: { id: 's-noccc-allfail' },
      ctx: { tools: { restrict: () => { throw new Error('restrict unavailable') } } },
    } as any
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(() => syncCccToolVisibility(agent, null)).not.toThrow()
    expect(getNonCccHiddenDiagnostics().hidden).not.toContain('s-noccc-allfail')
    expect(err.mock.calls.some((c) => String(c[0]).includes('两档全失败'))).toBe(true)
    err.mockRestore()
  })
})

describe('guards: CCC 治理文件保护（agent 不可写 .serenity/.serenity-safe-on）', () => {  it('写 .serenity-safe-on 被拒（无论安全模式）', () => {
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
    registerSkiffSession(QA_ID, 'qa', dir)
  })

  afterEach(() => {
    unregisterSkiffSession(QA_ID)
  })

  it('白名单内工具 → allow（read/grep/glob）', () => {
    for (const tool of ['read', 'grep', 'glob']) {
      expect(decideGuard(base({ root: dir, toolName: tool, skiffSessionId: QA_ID })).kind).toBe('allow')
    }
  })

  it('msms 非空 → msm 通道自动可用', () => {
    expect(decideGuard(base({ root: dir, toolName: 'msm', skiffSessionId: QA_ID })).kind).toBe('allow')
  })

  it('白名单外工具 → deny（拒绝信息不泄漏白名单外工具名）', () => {
    for (const tool of ['write', 'edit', 'bash', 'web_search', 'container_fs']) {
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
    expect(decideGuard(base({ root: dir, toolName: 'cheap-worker', skiffSessionId: 'cheap-worker-x' })).kind).toBe('allow')
  })

  it('角色 tools 空（纯 MSM 角色）→ 仅 msm 可用', () => {
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(
      join(dir, '.opencode', 'serenity.json'),
      JSON.stringify({ skiff: { roles: { pure: { msms: ['cognitive-qa'], tools: [] } } } }),
    )
    registerSkiffSession('skiff-pure-1', 'pure', dir)
    try {
      expect(decideGuard(base({ root: dir, toolName: 'msm', skiffSessionId: 'skiff-pure-1' })).kind).toBe('allow')
      expect(decideGuard(base({ root: dir, toolName: 'read', skiffSessionId: 'skiff-pure-1' })).kind).toBe('deny')
    } finally {
      unregisterSkiffSession('skiff-pure-1')
    }
  })

  it('skill 加载恒可用（不设白名单，v1.25.3）：白名单不含 skill 也 allow', () => {
    // 纯 MSM 角色（tools 空）→ 其余工具全 deny，但 skill 恒 allow
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(
      join(dir, '.opencode', 'serenity.json'),
      JSON.stringify({ skiff: { roles: { pure: { msms: ['cognitive-qa'], tools: [] } } } }),
    )
    registerSkiffSession('skiff-pure-2', 'pure', dir)
    try {
      expect(decideGuard(base({ root: dir, toolName: 'skill', skiffSessionId: 'skiff-pure-2' })).kind).toBe('allow')
      // 对照：未注册会话 + skill 也放行（豁免在角色查询之前）
      expect(decideGuard(base({ root: dir, toolName: 'skill', skiffSessionId: 'skiff-ghost-9' })).kind).toBe('allow')
      // 非 skill 工具仍被白名单约束
      expect(decideGuard(base({ root: dir, toolName: 'read', skiffSessionId: 'skiff-pure-2' })).kind).toBe('deny')
    } finally {
      unregisterSkiffSession('skiff-pure-2')
    }
  })
})

describe('guards: Skiff 角色白名单——真实 my-role 配置形态（S142 微信 msm 全拒 bug 回归钉死）', () => {
  // 复刻 .opencode/serenity.json my-role 角色（2026-09-07 磁盘态；v1.33 白名单里 logbook → trajectory，
  // v1.34 工具名硬切为 container_trajectory）：
  // tools 含 msm/container_trajectory + 19 msms——运行时实测全拒"tool not allowed in this skiff role"
  // 而 read/web_search 通。此测试钉死逻辑层：该配置形态下 decideGuard 必须放行
  // msm/container_trajectory/read/web_search（若此测试红 = 守卫逻辑 bug；绿 = 逻辑正确，差异在运行时层）。
  const MY_ROLE_MSMS = [
    'anysearch', 'web-search', 'memory-tool', 'mail-tool', 'vlm-describe',
    'eap-analyzer', 'qbit', 'session-log-tool', 'movie-search', 'home-diag',
    'bill-analyzer', 'mortgage-rate-compare', 'sheet-parser', 'pdf-extract',
    'archive-extract', 'profile-tool', 'weixin-send', 'autopilot-todo', 'subscription-tool',
  ]
  const ZC_ID = 'skiff-weixin-0123456789abcdef'

  beforeEach(() => {
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(
      join(dir, '.opencode', 'serenity.json'),
      JSON.stringify({
        skiff: {
          roles: {
            'my-role': {
              model: 'minimax-cn-coding-plan/MiniMax-M3',
              msms: MY_ROLE_MSMS,
              tools: ['read', 'grep', 'glob', 'web_search', 'container_trajectory', 'msm'],
              trajectory: { session: true, keeper: false, rebuild: true },
              systemPromptFile: '.opencode/skiff/zhaocai.md',
            },
          },
        },
      }),
    )
    registerSkiffSession(ZC_ID, 'my-role', dir)
  })

  afterEach(() => {
    unregisterSkiffSession(ZC_ID)
  })

  it('my-role 形态：白名单内工具全放行（read/web_search/container_trajectory/msm）', () => {
    for (const tool of ['read', 'grep', 'glob', 'web_search', 'container_trajectory', 'msm']) {
      expect(decideGuard(base({ root: dir, toolName: tool, skiffSessionId: ZC_ID })).kind, `tool ${tool} 应 allow`).toBe('allow')
    }
  })

  it('my-role 形态：白名单外工具 deny（write/bash 等）', () => {
    for (const tool of ['write', 'edit', 'bash', 'container_fs', 'cheap-worker', 'container_admin', 'dashboard', 'praxis']) {
      const d = decideGuard(base({ root: dir, toolName: tool, skiffSessionId: ZC_ID }))
      expect(d.kind, `tool ${tool} 应 deny`).toBe('deny')
      expect(d.deny).toContain('skiff role')
    }
  })

  it('my-role 形态：msms 非空 → msm 工具本身放行（roleToolWhitelist msm 通道）', () => {
    // 关键回归：即使 tools 不含 msm，msms 非空也必须放行 msm（roleToolWhitelist 自动加 msm）
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(
      join(dir, '.opencode', 'serenity.json'),
      JSON.stringify({
        skiff: { roles: { 'my-role': { msms: MY_ROLE_MSMS, tools: ['read'] } } },
      }),
    )
    registerSkiffSession('skiff-weixin-zc2', 'my-role', dir)
    try {
      expect(decideGuard(base({ root: dir, toolName: 'msm', skiffSessionId: 'skiff-weixin-zc2' })).kind).toBe('allow')
    } finally {
      unregisterSkiffSession('skiff-weixin-zc2')
    }
  })

  it('v1.30.2 回归：模型把 MSM 名当直接工具调 → 明确指引经 msm()（非泛化"未授权"）', () => {
    // 用户 bug（S142）：my-role 调 memory-tool 等得到 "tool not allowed in this skiff role" →
    // 误导成"没权限"。根因 = 把 MSM 名当直接工具调用。修复 = deny 消息给出 msm() 通道指引。
    for (const msmName of MY_ROLE_MSMS) {
      const d = decideGuard(base({ root: dir, toolName: msmName, skiffSessionId: ZC_ID }))
      expect(d.kind, `直接调 ${msmName} 应 deny`).toBe('deny')
      // 明确说这是 MSM + 给调用法（可行动规避指引），不说"not allowed in this skiff role"
      expect(d.deny, `deny 消息应含 ${msmName} 与 msm() 指引`).toContain(msmName)
      expect(d.deny).toContain('msm("')
      expect(d.deny).toContain('not a direct tool')
      expect(d.deny).not.toContain('not allowed in this skiff role')
    }
  })

  it('v1.30.2：白名单外真工具（write/bash 等）仍保守泛化 deny（不泄漏）', () => {
    for (const tool of ['write', 'bash', 'container_fs', 'acc_msm', 'cc_fs', 'session_rebuild']) {
      const d = decideGuard(base({ root: dir, toolName: tool, skiffSessionId: ZC_ID }))
      expect(d.kind, `工具 ${tool} 应 deny`).toBe('deny')
      expect(d.deny).toContain('not allowed in this skiff role')
      expect(d.deny).not.toContain(tool) // 不泄漏被拒工具名
    }
  })
})

describe('guards: MSM 注册表写保护（需求⑤b——写 deny 读 allow，防 CCC 意外写坏搞崩自己）', () => {
  // dir 的 .serenity=test → cccName=test → 聚合档 .opencode/skills/test/references/mech-registry.json
  const aggRel = '.opencode/skills/test/references/mech-registry.json'

  it('write/edit 直写 cccName 聚合档 → deny（ACC-managed）', () => {
    expect(decideGuard(base({ root: dir, toolName: 'write', pathArg: aggRel })).kind).toBe('deny')
    expect(decideGuard(base({ root: dir, toolName: 'edit', pathArg: aggRel })).kind).toBe('deny')
    expect(decideGuard(base({ root: dir, toolName: 'container_fs', action: 'touch', pathArg: aggRel })).kind).toBe('deny')
    expect(decideGuard(base({ root: dir, toolName: 'container_fs', action: 'append', pathArg: aggRel })).kind).toBe('deny')
  })

  it('root 级 mech-registry.json 写 → allow（review P1：废弃形态不再保护——永不被读的文件保护=死锁，可删可迁移）', () => {
    expect(decideGuard(base({ root: dir, toolName: 'write', pathArg: 'mech-registry.json' })).kind).toBe('allow')
    expect(decideGuard(base({ root: dir, toolName: 'container_fs', action: 'rm', pathArg: 'mech-registry.json' })).kind).toBe('allow')
  })

  it('聚合档 references/ 祖先目录写 → deny（review P2-2：rm -r references/ 会绕过文件级保护删掉注册表）', () => {
    // references/ 目录本身
    expect(decideGuard(base({ root: dir, toolName: 'container_fs', action: 'rm', pathArg: '.opencode/skills/test/references' })).kind).toBe('deny')
    expect(decideGuard(base({ root: dir, toolName: 'container_fs', action: 'rm', pathArg: '.opencode/skills/test/references/' })).kind).toBe('deny')
    expect(decideGuard(base({ root: dir, toolName: 'container_fs', action: 'mv', pathArg: '.opencode/skills/test/references' })).kind).toBe('deny')
    // 共享父目录不误伤（.opencode/skills 属所有 skill——删它不属于本 CCC 专属保护）
    expect(decideGuard(base({ root: dir, toolName: 'container_fs', action: 'rm', pathArg: '.opencode/skills/test' })).kind).toBe('allow')
    expect(decideGuard(base({ root: dir, toolName: 'container_fs', action: 'rm', pathArg: '.opencode/skills' })).kind).toBe('allow')
    expect(decideGuard(base({ root: dir, toolName: 'container_fs', action: 'rm', pathArg: '.opencode' })).kind).toBe('allow')
  })

  it('读工具读注册表 → allow（注册表需被读——output-guard/skiff-admin 建 MSM 词表；读 deny 只用于凭据）', () => {
    expect(decideGuard(base({ root: dir, toolName: 'read', pathArg: aggRel })).kind).toBe('allow')
    expect(decideGuard(base({ root: dir, toolName: 'container_fs', action: 'info', pathArg: aggRel })).kind).toBe('allow')
    expect(decideGuard(base({ root: dir, toolName: 'grep', pathArg: aggRel })).kind).toBe('allow')
  })

  it('非 cccName skill 目录的 mech-registry.json（历史分散残留）→ 不再保护（单级化后废弃，允许删除迁移）', () => {
    const legacy = '.opencode/skills/home-media/references/mech-registry.json'
    expect(decideGuard(base({ root: dir, toolName: 'write', pathArg: legacy })).kind).toBe('allow')
  })

  it('其他普通文件写 → 不受注册表保护影响（allow）', () => {
    expect(decideGuard(base({ root: dir, toolName: 'write', pathArg: 'docs/a.md' })).kind).toBe('allow')
  })

  it('references/ 内非注册表兄弟文档写 → allow（review P1-1：只保护注册表文件与 references/ 目录节点本身，不误伤并置知识文档）', () => {
    // home-serenity 实测：msm-writing-standards.md 等 8 个知识文档与 mech-registry.json 并置——必须可正常维护
    const sibling = '.opencode/skills/test/references/msm-writing-standards.md'
    expect(decideGuard(base({ root: dir, toolName: 'write', pathArg: sibling })).kind).toBe('allow')
    expect(decideGuard(base({ root: dir, toolName: 'edit', pathArg: sibling })).kind).toBe('allow')
    expect(decideGuard(base({ root: dir, toolName: 'container_fs', action: 'touch', pathArg: sibling })).kind).toBe('allow')
    expect(decideGuard(base({ root: dir, toolName: 'container_fs', action: 'append', pathArg: sibling })).kind).toBe('allow')
    expect(decideGuard(base({ root: dir, toolName: 'container_fs', action: 'rm', pathArg: sibling })).kind).toBe('allow')
    // 子树深层（references/sub/x.md）同样放行——只目录节点本身受保护
    expect(decideGuard(base({ root: dir, toolName: 'write', pathArg: '.opencode/skills/test/references/sub/x.md' })).kind).toBe('allow')
  })

  it('references/ 目录节点本身 rm -r/mv → deny（review P1-1 收窄后仍防删目录绕过）', () => {
    expect(decideGuard(base({ root: dir, toolName: 'container_fs', action: 'rm', pathArg: '.opencode/skills/test/references' })).kind).toBe('deny')
    expect(decideGuard(base({ root: dir, toolName: 'container_fs', action: 'mv', pathArg: '.opencode/skills/test/references' })).kind).toBe('deny')
  })

  it('cccName 非 test 的 CCC（.serenity=other）→ 只保护自己的聚合档，test 聚合档对其不保护', () => {
    const otherDir = mkdtempSync(join(tmpdir(), 'guards-other-'))
    try {
      writeFileSync(join(otherDir, '.serenity'), 'other')
      // other 的聚合档被保护
      expect(decideGuard(base({ root: otherDir, toolName: 'write', pathArg: '.opencode/skills/other/references/mech-registry.json' })).kind).toBe('deny')
      // test 的聚合档对 other CCC 不特殊保护（root 级除外）
      expect(decideGuard(base({ root: otherDir, toolName: 'write', pathArg: aggRel })).kind).toBe('allow')
    } finally {
      rmSync(otherDir, { recursive: true, force: true })
    }
  })
})

/**
 * 🆕 v1.59.5（owner 令 2026-10-17）：「宿主 0.2.1-rc.2 新增的调度工具与 CRO 冲突，
 * 要求在宁静号激活情况下屏蔽掉」。
 *
 * 判据（三条，缺一则这个屏蔽可能是假的）：
 *  ① **CCC 内必须屏蔽**那 4 个宿主定时器工具；
 *  ② **非 CCC 不屏蔽**（那是宿主的正常能力，owner 只要求"宁静号激活时"）；
 *  ③ **某个名字不在册时不得连累其余** —— 宿主 `restrict` 对未知名字会让**整次调用失败**，
 *     若整批发就会"一个都没藏住、只有一行 log" ⇒ 缺陷静默。这条是**防御性**的，也是本族的真风险。
 */
describe('guards: CCC 内屏蔽宿主自带定时器工具（v1.59.5，防与 CRO/唤醒注册表冲突）', () => {
  /** 替身 agent：可模拟"某些工具名不在册"（restrict 对未知名字整次失败） */
  function mkAgent(id: string, opts: { unknownNames?: string[] } = {}) {
    const restrictCalls: { deny?: string[] }[] = []
    const disposed: string[] = []
    const unknown = new Set(opts.unknownNames ?? [])
    const agent = {
      session: { id },
      ctx: {
        tools: {
          restrict: (f: { deny?: string[] }) => {
            // 与宿主契约同形：deny 里含未注册名 ⇒ **整次抛**（不是"忽略那一个"）
            if ((f.deny ?? []).some((n) => unknown.has(n))) throw new Error('unknown tool name in filter')
            restrictCalls.push(f)
            return () => { disposed.push('disposed') }
          },
        },
      },
    } as any
    return { agent, restrictCalls, disposed }
  }

  const EXPECTED = ['schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete']

  it('① CCC 内 ⇒ 4 个宿主定时器工具逐个被 deny（不是整批一次）', () => {
    const { agent, restrictCalls } = mkAgent('s-sched-a')
    try {
      syncHostScheduleToolHiding(agent, dir)
      // 逐个发：每个 deny 只含一个名字（这样任何一个名字不成立都不会连累其余）
      expect(restrictCalls.map((c) => c.deny)).toEqual(EXPECTED.map((n) => [n]))
      expect(getHostScheduleHiddenDiagnostics().hidden).toEqual(
        EXPECTED.map((n) => `s-sched-a::${n}`),
      )
    } finally {
      // 🔴 **必须 finally**：本模块的状态是**模块级 Map**（按 sessionId 索引），
      //   断言一旦失败就跳过清理 ⇒ 残留状态会**污染后面所有用例**
      //   （本轮变异对照时真的发生了：① 挂掉后 ⑤ 读到 8 条而不是 4 条）。
      forgetHostScheduleToolHiding('s-sched-a')
    }
  })

  it('② 非 CCC（root === null）⇒ 一次 restrict 都不发（那是宿主的正常能力）', () => {
    const { agent, restrictCalls } = mkAgent('s-sched-b')
    syncHostScheduleToolHiding(agent, null)
    expect(restrictCalls).toHaveLength(0)
    expect(getHostScheduleHiddenDiagnostics().hidden).not.toContain('s-sched-b::schedule_create')
  })

  it('③ 某个名字不在册 ⇒ 只跳过它，其余三个仍被藏住（不整批失败）', () => {
    const { agent, restrictCalls } = mkAgent('s-sched-c', { unknownNames: ['schedule_update'] })
    try {
      expect(() => syncHostScheduleToolHiding(agent, dir)).not.toThrow()
      const denied = restrictCalls.map((c) => c.deny?.[0])
      expect(denied).toEqual(['schedule_create', 'schedule_list', 'schedule_delete'])
      expect(denied).not.toContain('schedule_update')
    } finally {
      forgetHostScheduleToolHiding('s-sched-c')
    }
  })

  it('幂等：重复同步不重复 restrict', () => {
    const { agent, restrictCalls } = mkAgent('s-sched-d')
    try {
      syncHostScheduleToolHiding(agent, dir)
      syncHostScheduleToolHiding(agent, dir)
      expect(restrictCalls).toHaveLength(4)
    } finally {
      forgetHostScheduleToolHiding('s-sched-d')
    }
  })

  it('会话销毁清理：解除隐藏并清状态（防 per-会话 Map 无界增长），且幂等', () => {
    const { agent, disposed } = mkAgent('s-sched-e')
    syncHostScheduleToolHiding(agent, dir)
    // 🔴 断言**本会话前缀**的条数（不是全局条数）：全局读数会被其它用例的残留影响
    const mine = () => getHostScheduleHiddenDiagnostics().hidden.filter((k) => k.startsWith('s-sched-e::'))
    expect(mine()).toHaveLength(4)
    forgetHostScheduleToolHiding('s-sched-e')
    expect(disposed).toHaveLength(4)
    expect(mine()).toHaveLength(0)
    forgetHostScheduleToolHiding('s-sched-e') // 幂等
    expect(disposed).toHaveLength(4)
  })
})
