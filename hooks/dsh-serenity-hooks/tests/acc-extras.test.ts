import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-tools', () => ({
  defineTool: (opts: unknown) => opts,
}))
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runMsm, MSM_GUIDE, MSM_ACTIONS } from '../src/msm-ops.js'
import { EAP_CONTENT, eapTool } from '../src/tools/eap.js'
import { cceTool, CCE_CONTENT } from '../src/tools/cce.js'
import { NEAT_CONTENT, neatTool } from '../src/tools/neat.js'
import { resolveSerenityEnv } from '../src/seams/env.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'acc-extras-'))
  writeFileSync(join(dir, '.serenity'), 'test')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('msm: guide + 协议 flag + path-arg', () => {
  it('guide 返回开发手册', () => {
    expect(MSM_ACTIONS).toContain('guide')
    const r = runMsm(dir, { action: 'guide' }) as { guide: string }
    expect(r.guide).toContain('MSM 开发手册')
    expect(r.guide).toContain('main() CLI 守卫')
    // v1.17.3：交互与确认规范（禁止阻塞性确认）
    expect(r.guide).toContain('交互与确认规范')
    expect(r.guide).toContain('禁止阻塞性确认')
    expect(r.guide).toContain('--confirm')
  })

  it('exec --schema 返回条目 schema', () => {
    const scriptsDir = join(dir, '.opencode', 'skills', 't', 'scripts')
    mkdirSync(scriptsDir, { recursive: true })
    writeFileSync(join(scriptsDir, 'x.ts'), 'console.log(1);\n')
    const refs = join(dir, '.opencode', 'skills', 't', 'references')
    mkdirSync(refs, { recursive: true })
    writeFileSync(
      join(refs, 'mech-registry.json'),
      JSON.stringify({ version: 1, entries: [{ name: 'x', path: '.opencode/skills/t/scripts/x.ts', skill: 't', category: 'mech', flags: [{ name: 'out', type: 'path' }] }] }),
    )
    const schema = runMsm(dir, { action: 'exec', name: 'x', args: ['--schema', 'x'] }) as { name: string; flags: { name: string; type: string }[] }
    expect(schema.name).toBe('x')
    expect(schema.flags[0]!.type).toBe('path')
  })

  it('exec --format=json 包装输出', () => {
    const scriptsDir = join(dir, '.opencode', 'skills', 't', 'scripts')
    mkdirSync(scriptsDir, { recursive: true })
    writeFileSync(join(scriptsDir, 'x.ts'), 'console.log("hi");\n')
    const refs = join(dir, '.opencode', 'skills', 't', 'references')
    mkdirSync(refs, { recursive: true })
    writeFileSync(join(refs, 'mech-registry.json'), JSON.stringify({ version: 1, entries: [{ name: 'x', path: '.opencode/skills/t/scripts/x.ts', skill: 't', category: 'mech' }] }))
    const r = runMsm(dir, { action: 'exec', name: 'x', args: ['--format=json'] }) as { ok: boolean; data: string }
    expect(r.ok).toBe(true)
    expect(r.data).toContain('hi')
  })

  it('path-arg 逃逸阻断', () => {
    const scriptsDir = join(dir, '.opencode', 'skills', 't', 'scripts')
    mkdirSync(scriptsDir, { recursive: true })
    writeFileSync(join(scriptsDir, 'x.ts'), 'console.log(1);\n')
    const refs = join(dir, '.opencode', 'skills', 't', 'references')
    mkdirSync(refs, { recursive: true })
    writeFileSync(
      join(refs, 'mech-registry.json'),
      JSON.stringify({ version: 1, entries: [{ name: 'x', path: '.opencode/skills/t/scripts/x.ts', skill: 't', category: 'mech', flags: [{ name: 'out', type: 'path' }] }] }),
    )
    expect(() => runMsm(dir, { action: 'exec', name: 'x', args: ['--out', '../escape'] })).toThrow(/Path escape blocked/)
  })
})

describe('eap/neat 工具内容', () => {
  it('EAP 完整框架含三变量与自检清单', async () => {
    expect(EAP_CONTENT).toContain('E↑ 显式度')
    expect(EAP_CONTENT).toContain('输出前自检清单')
    const v = await eapTool.execute({ section: 'checklist' }, {} as never)
    expect(String(v)).toContain('自检清单')
  })

  it('Neat 完整协议含四铁律与五层', async () => {
    expect(NEAT_CONTENT).toContain('四条铁律')
    expect(NEAT_CONTENT).toContain('需求层')
    const v = await neatTool.execute({ section: 'layers' }, {} as never)
    expect(String(v)).toContain('五层推进')
  })
})

describe('env: DSH_SERENITY_* 事实', () => {
  it('CCC 内返回根/名/版本', () => {
    const f = resolveSerenityEnv(dir)
    expect(f.DSH_SERENITY_ROOT).toBe(dir)
    expect(f.DSH_SERENITY_CCC).toBe(dir.split('/').pop())
    expect(f.DSH_SERENITY_VERSION).toBeTruthy()
  })

  it('非 CCC 返回空', () => {
    expect(resolveSerenityEnv('/tmp')).toEqual({})
  })
})

describe('cce 工具内容', () => {
  it('CCE 完整框架含核心命题与六阶段', async () => {
    const { cceTool, CCE_CONTENT } = await import('../src/tools/cce.js')
    expect(CCE_CONTENT).toContain('认知连续性工程')
    expect(CCE_CONTENT).toContain('H_op')
    expect(CCE_CONTENT).toContain('六阶段生命周期')
    const v = await cceTool.execute({ section: 'lifecycle' }, {} as never)
    expect(String(v)).toContain('Reconstruction')
  })
})
