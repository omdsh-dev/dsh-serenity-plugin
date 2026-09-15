/**
 * autopilot-ops.test.ts — `container_admin autopilot` 三动作的**进程内实现**测试（⑥ C6a 块 A）
 *
 * 覆盖（派单要求的三条 + 一条退场钉）：
 *  · **三动作各有直接单测**：`init`（写配置 + **迁移删旧键**）/ `generate-bias`（**复用既有执行路径**）
 *    / `status`+`check`（判据来自条件链）
 *  · 🔑 **全局闸可见性**：桩住 `readSimpleSettings` 的闸值 on/off，断言 `status` 输出随之变
 *    ——这正是"8 项分歧一次全消"的机制（旧独立脚本读不到 `autopilotGloballyEnabled()`）
 *  · **进程内独有的事实**：live 会话/agent 可解析性（离线通道只能标"不可知"）
 *  · **退场回归钉**：`src/**` 内对已删符号（转发层/包内脚本/`spawnSync('bun'`）的引用数为 0，
 *    且两个文件确实不存在（"删了就不要再悄悄回来"）
 *
 * mock 说明：`@deepseek-ai/dsh-llm`（autopilot-trajectory 运行时 import）/`@deepseek-ai/dsh-tools`
 * 与 settings 链所需的 schemastery/dsh-settings 都是 peerDep（测试环境无解析）→ 按既有测试同款桩。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

vi.mock('@deepseek-ai/dsh-llm', () => ({ createUserMessage: (o: unknown) => o }))
vi.mock('@deepseek-ai/dsh-tools', () => ({ defineTool: (o: unknown) => o }))
vi.mock('@deepseek-ai/schemastery', () => {
  const chain: unknown = new Proxy(function () {}, {
    get: (_t, prop) => {
      if (prop === Symbol.toPrimitive) return () => ''
      if (prop === 'valueOf') return () => 0
      if (prop === 'toString') return () => ''
      return chain
    },
    apply: () => chain,
  })
  return {
    default: {
      object: (spec: unknown) => spec,
      array: () => chain,
      string: () => chain,
      boolean: () => chain,
      number: () => chain,
    },
  }
})
vi.mock('@deepseek-ai/dsh-settings', () => ({
  installSettingsSection: () => {},
  settingsNamespace: (v: string) => v,
}))

import { autopilotCheck, autopilotGenerateBias, autopilotInit, autopilotStatus } from '../src/autopilot-ops.js'
import { __setSimpleSourceForTest, defaultSimpleSettings } from '../src/settings-section.js'
import { __resetAutopilotClockStateForTest } from '../src/autopilot-trajectory.js'

/** 把插件全局闸（周期自唤醒）置为指定值——`status` 必须随之变化（可见性回归钉） */
function stubGate(enabled: boolean): void {
  __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), autopilotWakeEnabled: enabled }))
}

const HOOKS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ap-ops-'))
  writeFileSync(join(root, '.serenity'), 'test\n')
  __resetAutopilotClockStateForTest()
  stubGate(true)
})
afterEach(() => {
  __setSimpleSourceForTest(null)
  rmSync(root, { recursive: true, force: true })
})

function readConfigJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, '.opencode', 'serenity.json'), 'utf-8')) as Record<string, unknown>
}

function writeConfigJson(obj: unknown, rel = '.opencode/serenity.json'): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), JSON.stringify(obj, null, 2))
}

/** 造目标会话（`--auto` 形态）+ 齐备配置（status/check 的基准场景） */
function seedReadyScenario(autopilot: Record<string, unknown> = {}): void {
  writeConfigJson({ trajectory: { autopilot: { enabled: true, intervalHours: 12, session: 'S151', biasProvider: 'bias.js', ...autopilot } } })
  const dir = join(root, 'AGENT_SESSIONS', '2026-09-01--S151--x--auto')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SESSION.md'), '# session\n')
}

/** 最小 fake ctx（live 会话清单；无 agents 服务 ⇒ agent 不可解析） */
function fakeCtx(sessions: Array<{ id: string; cwd: string }> = []): unknown {
  return {
    get: () => undefined,
    sessions: { list: () => sessions.map((s) => ({ id: s.id, header: { cwd: s.cwd }, events: [] })) },
  }
}

describe('autopilot 进程内：init（写配置 + 迁移删旧键）', () => {
  it('全新 CCC → 写 trajectory.autopilot（enabled/intervalHours/biasProvider/topPrompt 占位）+ 生成偏见脚本模板', () => {
    const r = autopilotInit(root)
    expect(r.action).toBe('init')
    expect(r.output).toContain('✓ 配置写入')
    const cfg = readConfigJson()
    const at = ((cfg.trajectory as Record<string, unknown>).autopilot) as Record<string, unknown>
    expect(at).toMatchObject({ enabled: true, intervalHours: 12, biasProvider: 'autopilot-bias.ts' })
    expect(String(at.topPrompt)).toContain('CCC 填写') // 占位（CCC 必须自己改写）
    expect(at.session).toBeUndefined() // session 必填但不代填（不默认任何会话）
    // 偏见脚本模板（CCC 根）
    const tpl = join(root, 'autopilot-bias.ts')
    expect(existsSync(tpl)).toBe(true)
    expect(readFileSync(tpl, 'utf-8')).toContain('本文件为脚手架')
    expect(r.output).toContain('已生成偏见提供者脚本模板')
  })

  it('🔴 迁移：旧键 autopilotTrajectory 的值被带入新键，**旧键被删除**（不留双真相源）', () => {
    writeConfigJson({
      autopilotTrajectory: { enabled: true, intervalHours: 3, session: 'S151', topPrompt: '旧焦点' },
      weixin: { enabled: false }, // 其他段必须原样保留
    })
    const r = autopilotInit(root)
    const cfg = readConfigJson()
    const at = ((cfg.trajectory as Record<string, unknown>).autopilot) as Record<string, unknown>
    expect(at).toMatchObject({ intervalHours: 3, session: 'S151', topPrompt: '旧焦点' })
    expect(cfg.autopilotTrajectory).toBeUndefined()
    expect(cfg.weixin).toEqual({ enabled: false })
    expect(r.output).toContain('已从旧键 autopilotTrajectory/autotrajectory 迁移')
  })

  it('🔴 迁移：更早的旧键 autotrajectory 同样被迁移并删除', () => {
    writeConfigJson({ autotrajectory: { enabled: true, intervalHours: 5 } })
    autopilotInit(root)
    const cfg = readConfigJson()
    expect(cfg.autotrajectory).toBeUndefined()
    expect(((cfg.trajectory as Record<string, unknown>).autopilot as Record<string, unknown>).intervalHours).toBe(5)
  })

  it('.opencode 缺失 → 写进 .dsh/serenity.json（回退链与读侧同序）', () => {
    mkdirSync(join(root, '.dsh'), { recursive: true })
    writeFileSync(join(root, '.dsh', 'serenity.json'), JSON.stringify({ trajectory: { autopilot: { enabled: true } } }))
    autopilotInit(root)
    expect(existsSync(join(root, '.dsh', 'serenity.json'))).toBe(true)
    expect(existsSync(join(root, '.opencode', 'serenity.json'))).toBe(false)
  })

  it('已存在偏见脚本 → 保留不覆盖（不毁 CCC 自己的实现）', () => {
    writeFileSync(join(root, 'autopilot-bias.ts'), '// 我的实现\n')
    const r = autopilotInit(root)
    expect(readFileSync(join(root, 'autopilot-bias.ts'), 'utf-8')).toBe('// 我的实现\n')
    expect(r.output).toContain('已存在（保留）')
  })

  it('🔑 全局闸关着 → init 报告里响亮提示"配置写完也不会唤起"（旧脚本不知道闸存在）', () => {
    stubGate(false)
    const r = autopilotInit(root)
    expect(r.output).toContain('周期自唤醒全局闸**关着**')
    stubGate(true)
    expect(autopilotInit(root).output).toContain('周期自唤醒全局闸已开')
  })
})

describe('autopilot 进程内：generate-bias（复用既有执行路径，不另写 spawn）', () => {
  it('正常：运行 CCC 的偏见脚本并把 stdout 原样返回', async () => {
    writeConfigJson({ trajectory: { autopilot: { enabled: true, biasProvider: 'bias.js' } } })
    writeFileSync(join(root, 'bias.js'), 'console.log("本轮偏见：反事实 X")\n')
    const r = await autopilotGenerateBias(root)
    expect(r.action).toBe('generate-bias')
    expect(r.error).toBeUndefined()
    expect(r.output).toContain('本轮偏见：反事实 X')
    expect(r.output).toContain('bias.js')
  })

  it('脚本缺失 → 错误文本来自**同一份**执行代码（fetchBiasContent 的提示，不静默）', async () => {
    writeConfigJson({ trajectory: { autopilot: { enabled: true, biasProvider: 'autopilot-bias.ts' } } })
    const r = await autopilotGenerateBias(root)
    expect(r.output).toBe('')
    expect(r.error).toContain('请在 CCC 根目录实现偏见内容提供者脚本')
    expect(r.error).toContain('container_admin autopilot init 可生成模板')
  })

  it('脚本非零退出 → 错误含退出码（响亮失败）', async () => {
    writeConfigJson({ trajectory: { autopilot: { enabled: true, biasProvider: 'bias.js' } } })
    writeFileSync(join(root, 'bias.js'), 'process.exit(3)\n')
    const r = await autopilotGenerateBias(root)
    expect(r.error).toContain('执行失败（exit 3）')
  })

  it('未配置任何 autopilot 段 → 用缺省偏见脚本名（与 tick 同一缺省）', async () => {
    const r = await autopilotGenerateBias(root)
    expect(r.error).toContain('autopilot-bias.ts')
  })

  it('🔴 静态钉：autopilot-ops.ts 内**没有** spawnSync（执行归 autopilot-core 的唯一一份）', () => {
    const src = readFileSync(join(HOOKS_DIR, 'src', 'autopilot-ops.ts'), 'utf-8')
    expect(src).not.toContain('spawnSync')
    expect(src).toContain('fetchBiasContent')
  })
})

describe('autopilot 进程内：status / check（判据 = 条件链；含进程内事实）', () => {
  it('🔑 全局闸可见性：闸关 → status 报阻断且不印 ✅；闸开 → 报闸开', async () => {
    seedReadyScenario()
    stubGate(false)
    const off = await autopilotStatus(root)
    expect(off.output).toContain('周期自唤醒全局闸关闭')
    expect(off.output).not.toContain('✅ 唤起条件全部满足')

    stubGate(true)
    const on = await autopilotStatus(root)
    expect(on.output).toContain('✓ 周期自唤醒全局闸开启')
    expect(on.output).not.toContain('周期自唤醒全局闸关闭')
  })

  it('🔑 闸关时「下一步」指向闸（否则"条件全绿却不唤起"无从解释）', async () => {
    seedReadyScenario()
    stubGate(false)
    const r = await autopilotStatus(root)
    expect(r.output).toContain('═══ 下一步 ═══')
    expect(r.output).toContain('未就绪项')
  })

  it('进程内增益：status 含进程态（时钟是否武装 / tick 次数 / 上次跳过）', async () => {
    seedReadyScenario()
    const r = await autopilotStatus(root)
    expect(r.output).toContain('进程态（本插件进程）')
    expect(r.output).toContain('时钟已武装=')
    expect(r.output).toContain('tick 次数=')
    expect(r.output).toContain('本轮唤起进行中=')
  })

  it('status 是完整一站式报告（背景 + 条件链 + 进程态 + 状态 + 下一步 + 指引）', async () => {
    seedReadyScenario()
    const r = await autopilotStatus(root)
    for (const seg of ['自主轨迹实验', '自主轨迹唤起诊断', '进程态（本插件进程）', '实验状态', '═══ 下一步 ═══', '实验步骤指引']) {
      expect(r.output).toContain(seg)
    }
  })

  it('🔑 进程内 live 事实：CCC 有 live 会话但 agent 未加载 → 阻断（离线通道只能标"不可知"）', async () => {
    seedReadyScenario()
    const r = await autopilotStatus(root, fakeCtx([{ id: 's1', cwd: root }]) as never)
    expect(r.output).toContain('目标会话 agent 未定位')
    expect(r.output).toContain('live 会话 1 个')
    // 离线通道（无 ctx）同场景只能标不可知——两者差别正是本轮收益
    const offline = await autopilotStatus(root)
    expect(offline.output).toContain('live 运行态：不可知')
  })

  it('未配置 CCC：status 明说未配置并指向 init', async () => {
    const r = await autopilotStatus(root)
    expect(r.output).toContain('trajectory.autopilot 未配置')
    expect(r.output).toContain('container_admin autopilot init')
  })

  it('check 直接给出条件链报告（判决档 + 分类清单，不解析文本）', async () => {
    seedReadyScenario()
    const blocked = await autopilotCheck(root, fakeCtx([]) as never)
    expect(blocked.verdict).toBe('blocked')
    expect(blocked.blockers.length).toBeGreaterThan(0)
    stubGate(false)
    const gateOff = await autopilotCheck(root)
    expect(gateOff.verdict).toBe('blocked')
    expect(gateOff.blockers.some((b) => b.includes('全局闸关闭'))).toBe(true)
  })
})

describe('退场回归钉（⑥ C6a 块 C：独立脚本退场后不得悄悄回来）', () => {
  const SRC_DIR = join(HOOKS_DIR, 'src')

  function collectTs(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) out.push(...collectTs(full))
      else if (entry.endsWith('.ts')) out.push(full)
    }
    return out
  }

  it('两个已退场文件确实不存在（转发层 + 包内脚本）', () => {
    expect(existsSync(join(SRC_DIR, 'autopilot-script.ts'))).toBe(false)
    expect(existsSync(join(HOOKS_DIR, 'experiments', 'autopilot-trajectory', 'scripts', 'autopilot-trajectory.ts'))).toBe(false)
  })

  it('src/** 内对已删符号 / spawnSync(\'bun\' 的引用数为 0，且无 import 指向已删脚本路径', () => {
    const needles = [
      'autopilot-script',
      'runAutopilotScript',
      'findExpScript',
      'EXP_SCRIPT',
      "spawnSync('bun'",
    ]
    const hits: string[] = []
    for (const file of collectTs(SRC_DIR)) {
      const text = readFileSync(file, 'utf-8')
      for (const n of needles) if (text.includes(n)) hits.push(`${relative(HOOKS_DIR, file)}: ${n}`)
      // 路径钉只查 **import 语句**（说明里提到"该脚本已退场"属文档，不是引用）
      for (const line of text.split('\n')) {
        if (/from\s+['"][^'"]*experiments\/autopilot-trajectory/.test(line)) {
          hits.push(`${relative(HOOKS_DIR, file)}: import ${line.trim()}`)
        }
      }
    }
    expect(hits).toEqual([])
  })

  it('SKILL.md 留作文档（不退场），但已无"bun 本脚本"式指令形态', () => {
    const skill = join(HOOKS_DIR, 'experiments', 'autopilot-trajectory', 'SKILL.md')
    expect(existsSync(skill)).toBe(true)
    const text = readFileSync(skill, 'utf-8')
    expect(text).not.toContain('bun <本脚本>')
    expect(text).not.toContain('bun <包内脚本>')
    expect(text).toContain('已退场')
  })

  it('发布物不再声明该脚本（package.json files 清空 experiments 两行）', () => {
    const pkg = JSON.parse(readFileSync(join(HOOKS_DIR, 'package.json'), 'utf-8')) as { files: string[] }
    expect(pkg.files.some((f) => f.includes('experiments/'))).toBe(false)
  })
})
