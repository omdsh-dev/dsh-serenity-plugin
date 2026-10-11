/**
 * ontology-tool.test.ts — `ontology` 工具（本体工程**引擎**，v1.52 D121）的工具面
 *
 * 覆盖三件（引擎内部逻辑由随引擎搬来的 `ontology-engine.test.ts` 覆盖，此处只管**壳**）：
 *   ① **参数 → argv 的翻译**：六个子命令 ＋ level/template/format/skills 各自的适用面与取值拦截；
 *   ② 🔴 **路径守卫**（P3）：`path` / `skills` 逃出容器必须被拒 —— 引擎以 `cwd`（= CCC 根）为**解析基准**
 *      且 `init` 写文件，少了这道守卫就等于绕过 CCC 边界；
 *   ③ **退出码随回执返回**（搬迁改写 ②）：`code !== 0` **不抛异常**，而是 `ok:false` ＋ 引擎原文，
 *      让调用方能读到校验报告（`check` 失败时 stdout 里才有 ERR 明细）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('@deepseek-ai/dsh-tools', () => ({ defineTool: (o: unknown) => o }))

import { createOntologyTool } from '../src/tools/ontology-eng.js'

interface ExecutableTool {
  name: string
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

/** 真值形态的 `exec`：`cccRootForExec` 读 `agent.session.header.cwd` */
function execIn(cwd: string): unknown {
  return { agent: { session: { header: { cwd } } } }
}

const tool = createOntologyTool() as unknown as ExecutableTool

const GOOD_TTL = `@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix sr: <http://home-serenity/ontology#> .
@prefix : <http://example.org/onto#> .

:onto a owl:Ontology ;
    sr:name "probe" ;
    owl:versionInfo "0.0.1" .

:Thing a owl:Class ;
    rdfs:label "A thing" ;
    sr:rigidity "rigid" ;
    sr:identity :thingName ;
    sr:property [
      sr:name "thingName" ;
      sr:propType "string" ;
      sr:cardinality "exactly 1"
    ] .
`

/** 一个必然触发 M8 的规则（`exists` 是保留字，不能当属性名 —— 见 praxis ontology §10 的实测陷阱表） */
const BAD_TTL = GOOD_TTL + `
:onto sr:axiom [
    sr:axiomId "AX-PROBE-KEYWORD" ;
    sr:description "reserved word used as a property" ;
    sr:rule "Thing.exists == true" ;
    sr:axiomType "state" ;
    sr:rationale "probe"
  ] .
`

let ccc = ''
let outside = ''

beforeEach(() => {
  ccc = mkdtempSync(join(tmpdir(), 'onto-tool-ccc-'))
  writeFileSync(join(ccc, '.serenity'), 'home-serenity\n', 'utf-8')
  writeFileSync(join(ccc, 'good.ttl'), GOOD_TTL, 'utf-8')
  writeFileSync(join(ccc, 'bad.ttl'), BAD_TTL, 'utf-8')
  mkdirSync(join(ccc, '.opencode', 'skills'), { recursive: true })

  outside = mkdtempSync(join(tmpdir(), 'onto-tool-out-'))
  writeFileSync(join(outside, 'evil.ttl'), GOOD_TTL, 'utf-8')
})

afterEach(() => {
  rmSync(ccc, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe('ontology 工具：参数面', () => {
  it('可达性自证：工具对象真的暴露 execute（本件全部断言的前提）', () => {
    expect(typeof tool.execute).toBe('function')
    expect(tool.name).toBe('ontology')
  })

  it('缺 command / command 非法 ⇒ 抛错（且错误里列出合法取值）', async () => {
    await expect(tool.execute({ path: 'good.ttl' }, execIn(ccc))).rejects.toThrow(/`command` must be one of/)
    await expect(tool.execute({ command: 'nope', path: 'good.ttl' }, execIn(ccc))).rejects.toThrow(/`command` must be one of/)
  })

  it('缺 path ⇒ 抛错', async () => {
    await expect(tool.execute({ command: 'check' }, execIn(ccc))).rejects.toThrow(/`path` is required/)
  })

  it('level 只适用于 check/verify/review，且取值按子命令分流', async () => {
    await expect(tool.execute({ command: 'explain', path: 'good.ttl', level: 'strict' }, execIn(ccc)))
      .rejects.toThrow(/`level` does not apply to `explain`/)
    await expect(tool.execute({ command: 'check', path: 'good.ttl', level: 'onto-clean' }, execIn(ccc)))
      .rejects.toThrow(/level "onto-clean" is not valid for `check`/)
  })

  it('template / format / skills 各自的适用面被拦住', async () => {
    await expect(tool.execute({ command: 'check', path: 'good.ttl', template: 'full' }, execIn(ccc)))
      .rejects.toThrow(/`template` applies to `init` only/)
    await expect(tool.execute({ command: 'check', path: 'good.ttl', format: 'json' }, execIn(ccc)))
      .rejects.toThrow(/`format` applies to review \/ compliance only/)
    await expect(tool.execute({ command: 'check', path: 'good.ttl', skills: '.opencode/skills' }, execIn(ccc)))
      .rejects.toThrow(/`skills` applies to `compliance` only/)
  })

  it('🔴 路径守卫：path / skills 逃出容器 ⇒ 抛错（引擎按 cwd 解析相对路径，且 init 会写文件）', async () => {
    await expect(tool.execute({ command: 'check', path: join(outside, 'evil.ttl') }, execIn(ccc)))
      .rejects.toThrow(/escape|escapes/i)
    await expect(tool.execute({ command: 'check', path: '../evil.ttl' }, execIn(ccc)))
      .rejects.toThrow(/escape|escapes/i)
    await expect(tool.execute({ command: 'compliance', path: 'good.ttl', skills: outside }, execIn(ccc)))
      .rejects.toThrow(/escape|escapes/i)
  })

  it('cwd 不在任何 CCC 内 ⇒ 抛错（不造假根）', async () => {
    await expect(tool.execute({ command: 'check', path: 'good.ttl' }, execIn(outside)))
      .rejects.toThrow()
  })
})

describe('ontology 工具：执行面（退出码随回执返回）', () => {
  it('check 合法本体 ⇒ 回执首行 ✓ exit 0，正文含引擎原文', async () => {
    const r = (await tool.execute({ command: 'check', path: 'good.ttl' }, execIn(ccc))) as string
    expect(r).toContain('[ontology check] ✓ exit 0 — good.ttl') // 回执给**容器内相对路径**
    expect(r).toContain('All checks passed')
  })

  it('🔴 check 非法本体 ⇒ ✗ exit 1，且**不抛异常**（ERR 明细必须能被读到）', async () => {
    const r = (await tool.execute({ command: 'check', path: 'bad.ttl' }, execIn(ccc))) as string
    expect(r).toContain('[ontology check] ✗ exit 1')
    expect(r).toContain('[M8]')
    expect(r).toContain('Errors: 1')
    expect(r).toContain('exit 1 = 参数或校验失败') // 退出码含义随回执给出
  })

  it('explain ⇒ ✓ exit 0，且输出是人类可读摘要（标题带本体名）', async () => {
    const r = (await tool.execute({ command: 'explain', path: 'good.ttl' }, execIn(ccc))) as string
    expect(r).toContain('✓ exit 0')
    expect(r).toContain('## Ontology: probe')
    expect(r).toContain('### Types (')
  })

  it('init ⇒ 真在容器内写出模板文件（引擎唯一的写路径）', async () => {
    const r = (await tool.execute({ command: 'init', path: 'fresh.ttl' }, execIn(ccc))) as string
    expect(r).toContain('✓ exit 0')
    expect(existsSync(join(ccc, 'fresh.ttl'))).toBe(true)
  })

  it('文件不存在 ⇒ ✗ exit 2（system 档），且 stderr 是引擎原文', async () => {
    const r = (await tool.execute({ command: 'check', path: 'nope.ttl' }, execIn(ccc))) as string
    expect(r).toContain('✗ exit 2')
    expect(r).toContain('ONTO_FILE_NOT_FOUND')
    expect(r).toContain('exit 2 = 文件缺失')
  })
})
