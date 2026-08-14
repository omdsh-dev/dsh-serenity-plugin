import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runKit } from '../src/kit-ops.js'
import { runGit } from '../src/git-ops.js'
import { runMsm, findEntry } from '../src/msm-ops.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hooks-ops-'))
  writeFileSync(join(dir, '.serenity'), 'test')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('kit-ops', () => {
  it('health 输出三原则', async () => {
    const h = (await runKit(dir, { action: 'health' })) as { p1: boolean; p2: boolean }
    expect(h.p1).toBe(true)
    expect(h.p2).toBe(false) // 无 .git
  })

  it('time 输出 ISO', async () => {
    const t = (await runKit(dir, { action: 'time' })) as string
    expect(new Date(t).toString()).not.toBe('Invalid Date')
  })

  it('wait 纯 Node 实现（不依赖外部 sleep；0 秒立即返回）', async () => {
    const started = Date.now()
    const w = (await runKit(dir, { action: 'wait', seconds: 0 })) as { waited: number }
    expect(w.waited).toBe(0)
    expect(Date.now() - started).toBeLessThan(500)

    // 负秒数拒绝
    await expect(runKit(dir, { action: 'wait', seconds: -1 })).rejects.toThrow(/非负秒数/)
  })

  it('wait 1 秒耗时 ≥ 约 1 秒', async () => {
    const started = Date.now()
    await runKit(dir, { action: 'wait', seconds: 1 })
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
  })
})

describe('git-ops', () => {
  beforeEach(() => {
    execFileSync('git', ['init', '-q', '-b', 'master'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir })
    writeFileSync(join(dir, 'a.txt'), 'hi')
  })

  it('commit + status + log', () => {
    const c = runGit(dir, { action: 'commit', message: 'init' }) as { committed: boolean }
    expect(c.committed).toBe(true)
    const s = runGit(dir, { action: 'status' }) as { clean: boolean }
    expect(s.clean).toBe(true)
    const l = runGit(dir, { action: 'log' }) as { entries: string[] }
    expect(l.entries.some((e) => e.includes('init'))).toBe(true)
  })

  it('commit 缺消息抛错', () => {
    expect(() => runGit(dir, { action: 'commit' })).toThrow(/message/)
  })

  it('localstore git 联动：deny 且未 gitignore → commit 拒绝 + status warning', () => {
    // 模拟：localstore.json 已存在，但 .gitignore 未覆盖（用户手删了行）
    writeFileSync(join(dir, 'localstore.json'), '{"credentials":{"K":"v"}}\n')
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n')

    const s = runGit(dir, { action: 'status' }) as { warning?: string }
    expect(s.warning).toContain('localstore.json')

    expect(() => runGit(dir, { action: 'commit', message: 'x' })).toThrow(/localstore\.json/)
  })

  it('localstore git 联动：deny + gitignore 覆盖 → 放行 commit', () => {
    writeFileSync(join(dir, 'localstore.json'), '{"credentials":{"K":"v"}}\n')
    writeFileSync(join(dir, '.gitignore'), 'localstore.json\n')
    const c = runGit(dir, { action: 'commit', message: 'init' }) as { committed: boolean }
    expect(c.committed).toBe(true)
  })

  it('localstore git 联动：allow 配置 → 放行（即使未 gitignore）', () => {
    mkdirSync(join(dir, '.dsh'), { recursive: true })
    writeFileSync(join(dir, '.dsh', 'serenity.json'), JSON.stringify({ localstore: { gitTrack: 'allow' } }))
    writeFileSync(join(dir, 'localstore.json'), '{"credentials":{"K":"v"}}\n')
    const c = runGit(dir, { action: 'commit', message: 'init' }) as { committed: boolean }
    expect(c.committed).toBe(true)
  })
})

describe('msm-ops', () => {
  it('注册表扫描 + exec 执行脚本', () => {
    const scriptsDir = join(dir, '.opencode', 'skills', 't', 'scripts')
    mkdirSync(scriptsDir, { recursive: true })
    writeFileSync(join(scriptsDir, 'hello.ts'), 'console.log("hi");\n')
    const refs = join(dir, '.opencode', 'skills', 't', 'references')
    mkdirSync(refs, { recursive: true })
    writeFileSync(
      join(refs, 'mech-registry.json'),
      JSON.stringify({ version: 1, entries: [{ name: 'hello', path: '.opencode/skills/t/scripts/hello.ts', skill: 't', category: 'mech' }] }),
    )
    expect(findEntry(dir, 'hello')).not.toBeNull()
    const r = runMsm(dir, { action: 'exec', name: 'hello', args: [] }) as { exit: number; stdout: string }
    expect(r.exit).toBe(0)
    expect(r.stdout).toContain('hi')
  })

  it('exec 未注册抛错', () => {
    expect(() => runMsm(dir, { action: 'exec', name: 'nope' })).toThrow(/not registered/)
  })

  it('register 写注册表 + check 报告 M1', () => {
    const scriptsDir = join(dir, '.opencode', 'skills', 't', 'scripts')
    mkdirSync(scriptsDir, { recursive: true })
    writeFileSync(join(scriptsDir, 'tool.ts'), 'console.log("x");\n')
    const r = runMsm(dir, {
      action: 'register',
      name: 'tool',
      skill: 't',
      path: '.opencode/skills/t/scripts/tool.ts',
      category: 'mech',
      description: '测试',
    }) as { registered: string }
    expect(r.registered).toBe('tool')
    const check = runMsm(dir, { action: 'check' }) as { issues: { name: string; check: string }[] }
    expect(check.issues.some((i) => i.name === 'tool' && i.check === 'M1')).toBe(true)
  })
})
