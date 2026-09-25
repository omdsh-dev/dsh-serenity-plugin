import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildRoundPrompt, handymanProgressPaths, HANDYMAN_GUIDE, listActiveHandymen, newStopToken, providerAvailabilityError, readProgress, requireWhitelistedModel, sanitizeLabel, splitModel, writeFailedStatus, writeProgress } from '../src/handyman-ops.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'handyman-ops-'))
  writeFileSync(join(dir, '.serenity'), 'test')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('handyman-ops: 进度读写（续跑）', () => {
  it('writeProgress 写 md + json；readProgress 读回', () => {
    writeProgress(dir, 'scan', { round: 3, done: false, label: 'scan', model: 'minimax-cn-coding-plan/MiniMax-M3', updated: 't', lastResponse: '做了 X' })
    const { md, json } = handymanProgressPaths(dir, 'scan')
    expect(existsSync(md)).toBe(true)
    expect(existsSync(json)).toBe(true)
    const p = readProgress(dir, 'scan')
    expect(p!.round).toBe(3)
    expect(p!.lastResponse).toContain('X')
    expect(readFileSync(json, 'utf-8')).toContain('MiniMax-M3')
    // v1.24.0：文件名为 handyman- 前缀（不兼容旧 loop-）
    expect(json).toContain('handyman-scan.json')
  })

  it('无进度返回 null', () => {
    expect(readProgress(dir, 'nope')).toBeNull()
  })
})

/**
 * writeFailedStatus（⑤ 第 40 件，S142 2026-09-25）—— 本模块最后一个未执行函数。
 *
 * 可达性取证：**有活调用点** = `src/tools/handyman.ts` 保险阀终止分支
 * （`finishReason !== 'done'` ⇒ `max_rounds` ／ `restart_exceeded`），非死代码。
 * 残余性质 = **失败面**（不是防御性 `??`）⇒ 属挑靶四条里最值钱的一档。
 */
describe('handyman-ops: 失败状态落盘（writeFailedStatus，对齐 osp）', () => {
  it('无既有进度 ⇒ 用文档化默认值落盘：done=true / status=failed / round 0', () => {
    writeFailedStatus(dir, 'boom', { errorCode: 'max_rounds', errorMessage: 'Reached 100 rounds' })
    const { json } = handymanProgressPaths(dir, 'boom')
    expect(existsSync(json)).toBe(true)
    const raw = JSON.parse(readFileSync(json, 'utf-8'))
    expect(raw.status).toBe('failed')
    // 失败即终态：`done=true` 让续跑者一眼看出"别再等它了"（对齐 osp writeFailedStatus）
    expect(raw.done).toBe(true)
    expect(raw.errorCode).toBe('max_rounds')
    expect(raw.errorMessage).toBe('Reached 100 rounds')
    // 无既有进度时的文档化兜底（不是抛错、也不是 undefined）
    expect(raw.round).toBe(0)
    expect(raw.model).toBe('')
    expect(raw.lastResponse).toBe('')
    expect(raw.label).toBe('boom')
    expect(typeof raw.updated).toBe('string')
  })

  it('有既有进度 ⇒ 保留 round / model / lastResponse（只覆盖状态面，不抹掉历史）', () => {
    writeProgress(dir, 'keep', {
      round: 7,
      done: false,
      label: 'keep',
      model: 'minimax-cn-coding-plan/MiniMax-M3',
      updated: 't',
      lastResponse: '已处理 7 轮，剩 X',
    })
    writeFailedStatus(dir, 'keep', { errorCode: 'restart_exceeded' })
    const p = readProgress(dir, 'keep')!
    // 历史读数必须留存 —— 否则"失败"会把"做到哪了"一起抹掉，后续续跑失去依据
    expect(p.round).toBe(7)
    expect(p.model).toBe('minimax-cn-coding-plan/MiniMax-M3')
    expect(p.lastResponse).toContain('剩 X')
    // 状态面被失败覆盖
    expect(p.status).toBe('failed')
    expect(p.done).toBe(true)
    expect(p.errorCode).toBe('restart_exceeded')
    // errorMessage 可选：不给就是 undefined（不是空串占位）
    expect(p.errorMessage).toBeUndefined()
  })

  it('目录不存在也能落盘（mkdirSync recursive）；label 走脱敏', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'handyman-fresh-'))
    rmSync(join(fresh, 'AGENT_SESSIONS'), { recursive: true, force: true })
    try {
      writeFailedStatus(fresh, 'a:b/c', { errorCode: 'max_rounds' })
      const { json } = handymanProgressPaths(fresh, 'a:b/c')
      expect(json).toContain('handyman-a-b-c.json')
      expect(JSON.parse(readFileSync(json, 'utf-8')).errorCode).toBe('max_rounds')
    } finally {
      rmSync(fresh, { recursive: true, force: true })
    }
  })
})

describe('handyman-ops: 模型解析 / stop token / 白名单（v1.24.0）', () => {
  it('splitModel：provider/model 与 model-only', () => {
    expect(splitModel('minimax-cn-coding-plan/MiniMax-M3')).toEqual({ provider: 'minimax-cn-coding-plan', model: 'MiniMax-M3' })
    expect(splitModel('deepseek-v4-flash')).toEqual({ provider: undefined, model: 'deepseek-v4-flash' })
  })

  it('stop token 唯一且长', () => {
    const a = newStopToken()
    const b = newStopToken()
    expect(a).not.toBe(b)
    expect(a.startsWith('SERENITY_HANDYMAN_DONE_')).toBe(true)
  })

  it('requireWhitelistedModel：白名单内通过；白名单外抛错（提示配置 handyman.models）', () => {
    expect(() => requireWhitelistedModel('minimax-cn-coding-plan/MiniMax-M3', ['minimax-cn-coding-plan/MiniMax-M3'])).not.toThrow()
    expect(() => requireWhitelistedModel('other/model', ['minimax-cn-coding-plan/MiniMax-M3'])).toThrow(
      /not in the CCC whitelist/,
    )
    expect(() => requireWhitelistedModel('other/model', ['minimax-cn-coding-plan/MiniMax-M3'])).toThrow(/handyman\.models/)
  })
})

describe('handyman-ops: 轮次 prompt', () => {
  it('第一轮 vs 续跑轮（不重做）', () => {
    const base = { root: dir, session: 'S101', label: 'scan', round: 2, stopToken: 'TOK' }
    const first = buildRoundPrompt({ ...base, progress: null })
    expect(first).toContain('round 2')
    expect(first).toContain('first round')
    const resume = buildRoundPrompt({ ...base, progress: { round: 1, done: false, label: 'scan', model: 'm', updated: 't', lastResponse: '已扫描 10 个' } })
    expect(resume).toContain('never redo completed work')
    expect(resume).toContain('TOK')
  })

  it('prompt EAP 化：固定详尽结构 + 阅读/文字编写类加载 eap 指令（v1.23.0 英化）', () => {
    const p = buildRoundPrompt({ root: dir, label: 'docs', round: 1, stopToken: 'TOK', task: '阅读整理文档' })
    expect(p).toContain('## Work rules (fixed every round, must follow)')
    expect(p).toContain('reading/curating or text-writing work')
    expect(p).toContain('load eap (acc-eap skill)')
    expect(p).toContain('E↑ Explicit')
    expect(p).toContain('R↓ Reconstructable')
    expect(p).toContain('S↑ Stable')
    expect(p).toContain('## Per-round report (fixed format, answer each item)')
    expect(p).toContain('output only TOK')
  })
})

describe('handyman-ops: guide 指引 + 运行状态列表（WebUI 等待界面数据源）', () => {
  it('HANDYMAN_GUIDE 含 eap 要求 / 白名单 / jobs 并行 / 提示词规范 + 双模式（v1.31.3）', () => {
    expect(HANDYMAN_GUIDE).toContain('load eap and design the plan')
    expect(HANDYMAN_GUIDE).toContain('Task decomposition (E↑ Explicit)')
    expect(HANDYMAN_GUIDE).toContain('Model whitelist (CCC-configured, mandatory)')
    expect(HANDYMAN_GUIDE).toContain('handyman.models')
    expect(HANDYMAN_GUIDE).toContain('Parallel strategy (background mode only)')
    expect(HANDYMAN_GUIDE).toContain('handyman-internal agent is also required to load eap')
    expect(HANDYMAN_GUIDE).toContain('the only completion condition = the worker echoes')
    // v1.31.3 双模式：缺省 foreground / background 循环校验 / 选择判据
    expect(HANDYMAN_GUIDE).toContain('Two modes (v1.31.3; default = foreground)')
    expect(HANDYMAN_GUIDE).toContain('foreground (default)')
    expect(HANDYMAN_GUIDE).toContain('ctx.subagents.start("spawn")')
    expect(HANDYMAN_GUIDE).toContain('LOW-COST models')
  })

  it('listActiveHandymen 列出进度文件（按 updated 倒序；坏文件跳过）', () => {
    expect(listActiveHandymen(dir)).toEqual([])
    mkdirSync(join(dir, 'AGENT_SESSIONS'), { recursive: true })
    // 直接写控制 updated 的进度文件（writeProgress 用实时时间戳，排序不可控）
    writeFileSync(
      join(dir, 'AGENT_SESSIONS', 'handyman-a.json'),
      JSON.stringify({ round: 2, done: true, label: 'a', model: 'm2', updated: '2026-08-14T10:00:02.000Z', lastResponse: '做 A' }),
      'utf-8',
    )
    writeFileSync(
      join(dir, 'AGENT_SESSIONS', 'handyman-b.json'),
      JSON.stringify({ round: 1, done: false, label: 'b', model: 'm1', updated: '2026-08-14T10:00:01.000Z', lastResponse: '做 B' }),
      'utf-8',
    )
    // 旧 loop- 进度文件不列入（v1.24.0 不兼容）
    writeFileSync(join(dir, 'AGENT_SESSIONS', 'loop-old.json'), JSON.stringify({ round: 9, done: false, label: 'old', model: 'm', updated: '2026-08-14T10:00:03.000Z', lastResponse: '旧' }), 'utf-8')
    writeFileSync(join(dir, 'AGENT_SESSIONS', 'handyman-broken.json'), '{ bad', 'utf-8')
    const handymen = listActiveHandymen(dir)
    expect(handymen).toHaveLength(2)
    expect(handymen[0]!.label).toBe('a') // updated 更新在前
    expect(handymen[1]!.label).toBe('b')
    expect(handymen[0]!.done).toBe(true)
    expect(handymen[1]!.done).toBe(false)
  })

  it('sanitizeLabel 脱敏 Windows 非法字符（审计问题 17）', () => {
    expect(sanitizeLabel('sqc: scan/v2')).toBe('sqc- scan-v2')
    expect(sanitizeLabel('ok label')).toBe('ok label')
    expect(sanitizeLabel('a?b*c:d')).toBe('a-b-c-d')
    expect(sanitizeLabel('a.b.')).toBe('a.b')
    expect(sanitizeLabel('x'.repeat(80))).toHaveLength(50)
    // 按码点截断（审计问题 24）：代理对不切散，无 U+FFFD（toHaveLength 按 UTF-16 单位，emoji 双单位 → 用 [...str] 数码点）
    expect(sanitizeLabel('a'.repeat(49) + '🎉' + 'b')).toBe('a'.repeat(49) + '🎉')
    expect([...sanitizeLabel('🎉'.repeat(60))]).toHaveLength(50)
    expect(sanitizeLabel('🎉'.repeat(60))).not.toContain('\uFFFD')
    // handymanProgressPaths 用清洗后的 label
    const p = handymanProgressPaths(dir, 'a:b/c')
    expect(p.json).toContain('handyman-a-b-c.json')
  })
})

/**
 * providerAvailabilityError（v1.48，S142 2026-09-25）：owner 在 **Mac** 上实测到
 * `no adapter registered for provider "<p>"`，而前台 `diagnostic` 是空的 ⇒ 调用方无法自我修正。
 * 本组 pin 的是「**把沉默的失败变成可执行的错误**」这条契约。
 */
describe('handyman-ops: provider 可用性判据（可执行错误，v1.48）', () => {
  const reg = [{ id: 'minimax-cn-coding-plan', name: 'MiniMax CN Coding Plan' }, { id: 'deepseek-official', name: 'DeepSeek' }]

  it('全部 provider 本机都有 adapter ⇒ null（不打扰正常路径）', () => {
    expect(providerAvailabilityError(['minimax-cn-coding-plan/MiniMax-M3'], { registered: reg })).toBeNull()
    expect(providerAvailabilityError(['deepseek-official/x', 'minimax-cn-coding-plan/y'], { registered: reg })).toBeNull()
  })

  it('model 串无 "/"（取不到 provider）⇒ 不判定（沿用 agent 默认路由）', () => {
    expect(providerAvailabilityError(['MiniMax-M3'], { registered: [] })).toBeNull()
    expect(providerAvailabilityError([], { registered: [] })).toBeNull()
  })

  it('provider 缺失 ⇒ 报出：请求的模型 / 配置出处 / **本机可用清单** / 两条修法 / 禁止原样重试', () => {
    const msg = providerAvailabilityError(['probe-no-adapter/ProbeModel'], {
      registered: reg,
      configPath: '.opencode/serenity.json',
    })
    expect(msg).not.toBeNull()
    const m = msg as string
    expect(m).toContain('handyman: provider "probe-no-adapter" has no adapter registered on this machine')
    expect(m).toContain('probe-no-adapter/ProbeModel')                    // 请求的模型串
    expect(m).toContain('.opencode/serenity.json')                         // 配置出处
    expect(m).toContain('"handyman.models"')                               // 落点
    expect(m).toContain('Available on this machine (registered adapters)')
    expect(m).toContain('minimax-cn-coding-plan (MiniMax CN Coding Plan)') // 本机真能用的
    expect(m).toContain('deepseek-official (DeepSeek)')
    expect(m).toContain('Declared but NOT active here')
    expect(m).toContain('Fix (pick one, then retry):')
    expect(m).toContain('Do not retry unchanged')                          // 防死循环
  })

  it('已声明但休眠的 provider ⇒ 给出激活用的 settings 命名空间', () => {
    const msg = providerAvailabilityError(['probe-no-adapter/ProbeModel'], {
      registered: reg,
      declared: [
        { provider: 'probe-no-adapter', displayName: 'Probe', settingsNs: 'llm-pi-ai' },
        { provider: 'unrelated-provider', displayName: '其它', settingsNs: 'x' },
      ],
    }) as string
    expect(msg).toContain('probe-no-adapter (Probe) — settings namespace "llm-pi-ai"')
    expect(msg).not.toContain('unrelated-provider')   // 只列与缺失项相关的声明
  })

  it('本机一个 provider 都没有 ⇒ 明确写 (none)，不假装有', () => {
    const m = providerAvailabilityError(['ghost/m'], { registered: [] }) as string
    expect(m).toContain('(none)')
    expect(m).toContain('ghost')
  })

  it('多个缺失 provider 去重且逐个点名；请求的模型串如实回显（供自查）', () => {
    const m = providerAvailabilityError(['a/m1', 'a/m2', 'b/m3'], { registered: [] }) as string
    expect(m).toContain('"a", "b"')   // 去重（a 出现两次只报一次），保持首次出现顺序
    expect(m).toContain('a/m1')
    expect(m).toContain('a/m2')
    expect(m).toContain('b/m3')
  })
})
