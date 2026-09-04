import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('@deepseek-ai/dsh-llm', () => ({
  createUserMessage: (o: unknown) => o,
}))

import {
  buildSensitiveTable,
  detectSensitive,
  buildRebuke,
  REBUKE_MAX_ROUNDS,
  rebukeStates,
} from '../src/output-guard.js'
import { registerOutputGuardHook } from '../src/output-guard-seam.js'
import { stripThink } from '../src/skiff-debug.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'output-guard-'))
  // 需求⑤a：注册表单级化——cccName = demo → 聚合档 .opencode/skills/demo/references/mech-registry.json
  writeFileSync(join(dir, '.serenity'), 'demo')
  mkdirSync(join(dir, '.opencode'), { recursive: true })
  mkdirSync(join(dir, '.opencode', 'skills', 'demo', 'references'), { recursive: true })
  // 凭据文件（测试敏感词源）
  writeFileSync(join(dir, 'localstore.json'), JSON.stringify({
    credentials: { SSH_UBUNTU_PASSWORD: 'hunter2-secret', HOME_GITLAB_TOKEN: 'glpat-xyz' },
  }))
  // mech-registry（测试 MSM 词源）
  writeFileSync(join(dir, '.opencode', 'skills', 'demo', 'references', 'mech-registry.json'), JSON.stringify({
    entries: [
      { name: 'web-search', script: 'web-search.ts' },
      { name: 'vlm-describe', script: 'vlm-describe.ts' },
    ],
  }))
})

afterEach(() => {
  rebukeStates.clear()
  rmSync(dir, { recursive: true, force: true })
})

describe('output-guard: 敏感词表构建（v1.26.3）', () => {
  it('凭据词：localstore credentials 条目名 + 值入精确表', () => {
    const t = buildSensitiveTable(dir)
    expect(t.exact.has('SSH_UBUNTU_PASSWORD')).toBe(true)
    expect(t.exact.has('hunter2-secret')).toBe(true)
    expect(t.exact.has('HOME_GITLAB_TOKEN')).toBe(true)
    expect(t.exact.has('glpat-xyz')).toBe(true)
  })

  it('MSM 词：mech-registry 注册的工具名入精确表（用户补充：msm_list 列表里的工具名）', () => {
    const t = buildSensitiveTable(dir)
    expect(t.exact.has('web-search')).toBe(true)
    expect(t.exact.has('vlm-describe')).toBe(true)
  })

  it('机制词：静态内部结构词入子串表（插件名/配置路径/内部实现词）', () => {
    const t = buildSensitiveTable(dir)
    expect(t.substring).toContain('dsh-serenity-hooks')
    expect(t.substring).toContain('mech-registry.json')
    expect(t.substring).toContain('.opencode/serenity.json')
    expect(t.substring).toContain('session_rebuild')
  })

  it('凭据文件缺失 → 表仍含机制词 + MSM 词（不抛错）', () => {
    const noCred = mkdtempSync(join(tmpdir(), 'og-nocred-'))
    writeFileSync(join(noCred, '.serenity'), 'test')
    const t = buildSensitiveTable(noCred)
    expect(t.substring.length).toBeGreaterThan(0)
    rmSync(noCred, { recursive: true, force: true })
  })
})

describe('output-guard: 检测（detectSensitive）', () => {
  it('正常认知结果 → 无命中（公开概念词不敏感）', () => {
    const t = buildSensitiveTable(dir)
    const hits = detectSensitive('根据宁静号的知识，EAP 强调外部可重建性。建议使用 CCE 框架评估。', t)
    expect(hits).toEqual([])
  })

  it('回答含凭据值 → 命中（精确匹配，分类 credential）', () => {
    const t = buildSensitiveTable(dir)
    expect(detectSensitive('服务器密码是 hunter2-secret', t)).toContainEqual({ word: 'hunter2-secret', category: 'credential' })
  })

  it('回答含凭据条目名 → 命中（分类 credential）', () => {
    const t = buildSensitiveTable(dir)
    expect(detectSensitive('我读取了 SSH_UBUNTU_PASSWORD 配置', t)).toContainEqual({ word: 'SSH_UBUNTU_PASSWORD', category: 'credential' })
  })

  it('回答含 MSM 工具名 → 命中（分类 msm）', () => {
    const t = buildSensitiveTable(dir)
    expect(detectSensitive('我调用 web-search 搜索了资料', t)).toContainEqual({ word: 'web-search', category: 'msm' })
  })

  it('回答含机制词（插件名/内部路径）→ 命中（分类 mechanism）', () => {
    const t = buildSensitiveTable(dir)
    expect(detectSensitive('这是 dsh-serenity-hooks 的实现', t)).toContainEqual({ word: 'dsh-serenity-hooks', category: 'mechanism' })
    expect(detectSensitive('配置在 .opencode/serenity.json', t)).toContainEqual({ word: '.opencode/serenity.json', category: 'mechanism' })
  })

  it('回答含内部端口 → 命中（分类 port，v1.26.11）', () => {
    const t = buildSensitiveTable(dir)
    expect(detectSensitive('端口 3100 提供服务', t)).toContainEqual({ word: '3100', category: 'port' })
  })

  it('空文本 → 无命中', () => {
    const t = buildSensitiveTable(dir)
    expect(detectSensitive('', t)).toEqual([])
  })
})

describe('output-guard: 打回消息（buildRebuke，v1.26.11 分类指引）', () => {
  it('逐词列出命中词 + 分类规避指引（端口类：告知是内部端口）', () => {
    const msg = buildRebuke([{ word: '3080', category: 'port' }])
    expect(msg).toContain('sensitive internal term')
    expect(msg).toContain('"3080"')
    expect(msg).toMatch(/internal service port or address/)
    expect(msg).toMatch(/never mention internal ports, addresses, or service endpoints/)
  })

  it('凭据/机制/工具名分类各给对应指引 + 多命中全列出', () => {
    const msg = buildRebuke([
      { word: 'hunter2-secret', category: 'credential' },
      { word: 'dsh-serenity-hooks', category: 'mechanism' },
      { word: 'web-search', category: 'msm' },
    ])
    expect(msg).toContain('3 sensitive internal terms')
    expect(msg).toContain('"hunter2-secret"')
    expect(msg).toContain('"dsh-serenity-hooks"')
    expect(msg).toContain('"web-search"')
    expect(msg).toMatch(/credential identifier/)
    expect(msg).toMatch(/internal mechanism term/)
    expect(msg).toMatch(/internal tool name/)
    expect(msg).toMatch(/Regenerate the response/)
    expect(msg).toMatch(/without referencing internal machinery/)
  })

  it('单数名词（1 term）', () => {
    const msg = buildRebuke([{ word: '3100', category: 'port' }])
    expect(msg).toContain('1 sensitive internal term')
    expect(msg).not.toContain('term(s)')
  })
})

describe('output-guard-seam: turn-stopping 接线（v1.26.3）', () => {
  function fakeCtx(id = 'skiff-qa-uuid') {
    const steers: string[] = []
    let hook: ((p: { agent?: unknown; turn?: number }) => void) | undefined
    const agent = {
      id,
      session: {
        id,
        header: { cwd: dir },
        events: [] as unknown[],
      },
      steer: (m: { content?: Array<{ type?: string; text?: string }> }) => {
        steers.push(m.content?.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n') ?? '')
      },
    }
    return {
      steers,
      agent,
      fire: (turn: number) => hook?.({ agent, turn }),
      ctx: {
        on: (_ev: string, cb: (p: unknown) => void) => { hook = cb as (p: unknown) => void },
      },
    }
  }

  it('外部面合规输出 → 不打回（steer 不调用）', () => {
    const f = fakeCtx()
    registerOutputGuardHook(f.ctx as never)
    f.agent.session.events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '这是一个正常的认知回答' }] } } })
    f.fire(1)
    expect(f.steers).toEqual([])
  })

  it('外部面命中敏感词 → steer 打回（v1.26.10：打回文本含命中词，模型据此重写）', () => {
    const f = fakeCtx()
    registerOutputGuardHook(f.ctx as never)
    f.agent.session.events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '密码是 hunter2-secret' }] } } })
    f.fire(1)
    expect(f.steers.length).toBe(1)
    expect(f.steers[0]).toContain('SERENITY OUTPUT GUARD')
    expect(f.steers[0]).toContain('hunter2-secret')
  })

  it('连续命中达上限 → 放弃打回（不再 steer）+ 状态清理', () => {
    const f = fakeCtx()
    registerOutputGuardHook(f.ctx as never)
    f.agent.session.events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'web-search 工具' }] } } })
    for (let i = 1; i <= REBUKE_MAX_ROUNDS + 1; i++) f.fire(i)
    // REBUKE_MAX_ROUNDS 次打回 + 最后一次放弃
    expect(f.steers.length).toBe(REBUKE_MAX_ROUNDS)
    expect(rebukeStates.has('skiff-qa-uuid')).toBe(false)
  })

  it('合规轮重置连续计数（先命中后合规 → 计数清零）', () => {
    const f = fakeCtx()
    registerOutputGuardHook(f.ctx as never)
    f.agent.session.events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'SSH_UBUNTU_PASSWORD' }] } } })
    f.fire(1)
    expect(f.steers.length).toBe(1)
    expect(rebukeStates.get('skiff-qa-uuid')?.consecutive).toBe(1)
    // 合规轮
    f.agent.session.events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '正常回答' }] } } })
    f.fire(2)
    expect(rebukeStates.has('skiff-qa-uuid')).toBe(false)
  })

  it('本地维护会话（普通 dsh id）→ 豁免不检测（用户拍板：仅外部面）', () => {
    const f = fakeCtx('dsh-local-maintenance')
    registerOutputGuardHook(f.ctx as never)
    f.agent.session.events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'dsh-serenity-hooks 与 mech-registry 维护记录' }] } } })
    f.fire(1)
    expect(f.steers).toEqual([])
  })

  it('ACP 会话（acp- 前缀）→ 检测（外部程序化面）', () => {
    const f = fakeCtx('acp-session-uuid')
    registerOutputGuardHook(f.ctx as never)
    f.agent.session.events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'vlm-describe 输出' }] } } })
    f.fire(1)
    expect(f.steers.length).toBe(1)
  })

  it('非 CCC 目录（无 .serenity）→ 零干预', () => {
    const outside = mkdtempSync(join(tmpdir(), 'og-outside-'))
    const f = fakeCtx()
    f.agent.session.header = { cwd: outside }
    registerOutputGuardHook(f.ctx as never)
    f.agent.session.events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'hunter2-secret 密码' }] } } })
    f.fire(1)
    expect(f.steers).toEqual([])
    rmSync(outside, { recursive: true, force: true })
  })

  it('v1.27.7 think 块内敏感词 → 不检测不打回（think 不输出给用户）', () => {
    const f = fakeCtx()
    registerOutputGuardHook(f.ctx as never)
    // think 内含凭据词 + 机制词（思考过程推演内部机制是正常的）——检测只针对最终呈现文本
    // 真实标签 = <think>（5 字母）——matchOpenThink 只匹配 `<think` 后跟 `>`/空白
    const raw = '<think>\n这里需要检查 SSH_UBUNTU_PASSWORD 与 dsh-serenity-hooks 的配置\n</think>\n这是正常的回答内容'
    f.agent.session.events.push({
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: raw }] } },
    })
    f.fire(1)
    expect(f.steers).toEqual([])
  })
})
