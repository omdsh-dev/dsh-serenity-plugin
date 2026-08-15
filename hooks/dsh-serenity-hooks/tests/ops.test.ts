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
  it('health 输出三原则（对齐 osp schema）', async () => {
    const h = (await runKit(dir, { action: 'health' })) as {
      status: string
      principles: { P1_rooted: { pass: boolean }; P2_git_managed: { pass: boolean }; P3_binary_permissions: { pass: boolean } }
    }
    expect(h.status).toBe('degraded') // 无 .git → degraded
    expect(h.principles.P1_rooted.pass).toBe(true)
    expect(h.principles.P2_git_managed.pass).toBe(false) // 无 .git
    expect(h.principles.P3_binary_permissions.pass).toBe(false) // 无配置
  })

  it('CCC 缺失时返回 degraded（不抛错）', async () => {
    const h = (await runKit(null, { action: 'health' })) as { status: string; root: string | null }
    expect(h.status).toBe('degraded')
    expect(h.root).toBeNull()
  })

  it('time 输出 {now_iso, now_local, epoch_ms}', async () => {
    const t = (await runKit(dir, { action: 'time' })) as { now_iso: string; now_local: string; epoch_ms: number }
    expect(new Date(t.now_iso).toString()).not.toBe('Invalid Date')
    expect(typeof t.epoch_ms).toBe('number')
  })

  it('wait 需正整数秒数（对齐 osp；缺省 1）', async () => {
    // 0 秒拒绝（osp spec：positive int）
    await expect(runKit(dir, { action: 'wait', seconds: 0 })).rejects.toThrow(/正整数/)
    // 负秒数拒绝
    await expect(runKit(dir, { action: 'wait', seconds: -1 })).rejects.toThrow(/正整数/)
  })

  it('wait 1 秒耗时 ≥ 约 1 秒', async () => {
    const started = Date.now()
    const w = await runKit(dir, { action: 'wait', seconds: 1 })
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
    expect(w).toBe('waited 1s') // 对齐 osp 文本输出
  })
})

describe('git-ops', () => {
  beforeEach(() => {
    execFileSync('git', ['init', '-q', '-b', 'master'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir })
    writeFileSync(join(dir, 'a.txt'), 'hi')
  })

  it('commit + status + log（对齐 osp 文本/JSON 输出）', () => {
    const c = runGit(dir, { action: 'commit', message: 'init' }) as string
    expect(c).toContain('master')
    const s = runGit(dir, { action: 'status' }) as { clean: boolean; files: { status: string; file: string }[]; summary: string }
    expect(s.clean).toBe(true)
    expect(Array.isArray(s.files)).toBe(true)
    const l = runGit(dir, { action: 'log' }) as string
    expect(l).toContain('init')
  })

  it('commit 缺消息抛错', () => {
    expect(() => runGit(dir, { action: 'commit' })).toThrow(/message/)
  })

  it('pull：无远程配置报错；diff：无差异返回 (no diff)', () => {
    expect(() => runGit(dir, { action: 'pull' })).toThrow(/no remote configured/)
    expect(runGit(dir, { action: 'diff' })).toBe('(no diff)')
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
    const c = runGit(dir, { action: 'commit', message: 'init' }) as string
    expect(c).toContain('master')
  })

  it('localstore git 联动：allow 配置 → 放行（即使未 gitignore）', () => {
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({ localstore: { gitTrack: 'allow' } }))
    writeFileSync(join(dir, 'localstore.json'), '{"credentials":{"K":"v"}}\n')
    const c = runGit(dir, { action: 'commit', message: 'init' }) as string
    expect(c).toContain('master')
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
