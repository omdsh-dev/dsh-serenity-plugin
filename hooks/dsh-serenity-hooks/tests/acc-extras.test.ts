import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-tools', () => ({
  defineTool: (opts: unknown) => opts,
}))
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runMsm, MSM_GUIDE, MSM_ACTIONS } from '../src/tools/msm/service.js'
import { EAP_PAPER_ASSET, eapPaperPath, loadEapPaper, resetEapCache } from '../src/tools/eap.js'
import { CCE_CONTENT } from '../src/tools/cce.js'
import { NEAT_CONTENT } from '../src/tools/neat.js'
import { resolveSerenityEnv } from '../src/seams/env.js'

let dir: string

/**
 * MSM `exec` 真跑 `.ts` 脚本需要 **TS 运行时**：有 bun 则直跑（`tools/msm/service.ts` 的 `bunExecutablePath()`），
 * 无 bun 时回落 `npx tsx <script>`——脚本位于**临时 CCC 目录**（`mkdtemp`），那里没有本地 tsx，
 * npx 只能**联网拉取**。CI runner 无 bun 且网络抖动 → 偶发 exit 1。
 * **实证**：`exec --format=json 包装输出` 在 CI run #33（`ef71d2b`）通过、run #34（`e35aa17`，
 * 与前者只差版本号/README）失败——同代码不同结果 = 环境/网络耦合，不是被测逻辑的问题。
 * 故本用例**仅在 bun 在场时执行**（与 `tests/ops.test.ts` 的 `HAS_BUN` 同一先例与理由；
 * 本文件其余用例不执行脚本，保持无条件运行）。
 */
const HAS_BUN = ((): boolean => {
  try {
    execFileSync('bun', ['--version'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
})()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'acc-extras-'))
  // 需求⑤a：注册表单级化——cccName（.serenity 首行）= t → 聚合档 .opencode/skills/t/references/mech-registry.json
  writeFileSync(join(dir, '.serenity'), 't')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('msm: guide + 协议 flag + path-arg', () => {
  it('guide 返回开发手册', () => {
    expect(MSM_ACTIONS).toContain('guide')
    const r = runMsm(dir, { action: 'guide' }) as { guide: string }
    expect(r.guide).toContain('MSM Development Manual')
    expect(r.guide).toContain('main() CLI guard')
    // v1.17.3：交互与确认规范（禁止阻塞性确认）
    expect(r.guide).toContain('confirmation conventions')
    expect(r.guide).toContain('no blocking confirmation')
    expect(r.guide).toContain('--confirm')
  })

  /**
   * 🔴 **2026-10-19 v1.75.0：`catalog` 动作降为指针**（owner 裁 Q3「指针」）。
   *
   * 起因：`msm catalog` 与 `config docs catalog` 返回**同一份常量** ⇒ 两个正文入口。
   * 现在正文唯一入口 = `container_admin config docs catalog`，本动作只指路。
   *
   * ⚠️ **为什么本用例不是"被削弱了"**：目录正文（7 分区、指向各功能）**仍然被逐条钉住** ——
   * 只是挪到了 `container-admin.test.ts` 的 `docs catalog` 章用例里。
   * 本用例的职责从"正文对不对"变成"**旧入口是否正确地降成了指针**"。
   */
  it('catalog 降为指针（正文唯一入口 = config docs catalog）', () => {
    expect(MSM_ACTIONS).toContain('catalog')
    const r = runMsm(dir, { action: 'catalog' }) as { catalog: string }
    // 指路：告诉调用方正文在哪一章
    expect(r.catalog).toContain('container_admin config docs catalog')
    expect(r.catalog).toContain('正文已统一')
    // 🔴 反向钉：**不再返回正文**（这是"一个内容一个入口"的核心判据）
    expect(r.catalog).not.toContain('ACC Usage Catalog')
    expect(r.catalog).not.toContain('weixin-doctor')
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

  it.skipIf(!HAS_BUN)('exec --format=json 包装输出（需 bun 直跑 TS：见 HAS_BUN）', () => {
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

describe('eap/neat 内容源', () => {
  it('EAP 正文 = 随包论文全文（资产在位、可读、且是全文）', () => {
    resetEapCache()
    const paper = loadEapPaper()
    // 资产路径解析到包根下的 assets/（不是 src/assets/ —— 那正是"层级算错"的故障形态）
    expect(eapPaperPath().endsWith(EAP_PAPER_ASSET)).toBe(true)
    // 全文而非节选：首章 ＋ 尾章（附录）都在
    expect(paper).toContain('# Explicit Abstraction Principle (EAP)')
    expect(paper).toContain('## 1. 引言：前置抽象的无穷性')
    expect(paper).toContain('## 附录：EAP的公理化可能性（可选）')
    // 🔴 篇幅判据必须**按字节**（论文以中文为主：1 汉字 = 3 字节 UTF-8，但只占 1~2 个
    //    UTF-16 码元 ⇒ 拿 `.length` 当"篇幅"会少读一半 —— 我首版正是这么错的）。
    //    分母 = 资产实测：58 723 B ／ 25 547 字符（旧「简易说明」约 1.5 KB）。
    expect(Buffer.byteLength(paper, 'utf-8')).toBeGreaterThan(50_000)
    expect(paper.length).toBeGreaterThan(20_000)
  })

  it('🔴 保真：当年「简易说明」自造的三个串**不得**再出现在 EAP 正文里', () => {
    // 这三个串在**真论文里逐字不存在**（它们是写简易说明时自造的）——
    // 它们回来 ⇒ 说明有人又把那份简易说明抄了回来（本缺陷的复发形态）。
    const paper = loadEapPaper()
    expect(paper).not.toContain('EAP Cognitive Quality Framework')
    expect(paper).not.toContain('E↑ Explicitness')
    expect(paper).not.toContain('Pre-Output Self-Check Checklist')
  })

  it('读一次即缓存；显式传入不存在的路径 → 抛错（不静默返回空）', () => {
    resetEapCache()
    expect(loadEapPaper()).toBe(loadEapPaper())
    expect(() => loadEapPaper('/nonexistent/eap-paper.md')).toThrow()
  })

  it('Neat 完整协议含四铁律与五层（v1.23.0 英化）', () => {
    expect(NEAT_CONTENT).toContain('Four Iron Rules')
    expect(NEAT_CONTENT).toContain('Requirements')
    expect(NEAT_CONTENT).toContain('Five-Layer Progression')
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

describe('cce 内容常量', () => {
  it('CCE 完整框架含核心命题与六阶段（v1.23.0 英化）', () => {
    expect(CCE_CONTENT).toContain('Cognitive Continuity Engineering')
    expect(CCE_CONTENT).toContain('H_op')
    expect(CCE_CONTENT).toContain('Six-Phase Lifecycle')
    expect(CCE_CONTENT).toContain('Reconstruction')
  })
})
