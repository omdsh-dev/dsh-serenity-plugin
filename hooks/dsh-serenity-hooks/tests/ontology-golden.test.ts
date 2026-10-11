/**
 * ontology-golden.test.ts — 🔴 **移植保真度**：搬进 ACC 的引擎必须与 CCC 的原 MSM **逐字同输出**
 *
 * 为什么需要这一件（D121）：引擎是从 CCC 的 MSM 脚本 `.opencode/skills/home-ontology/scripts/ontology-engineering.ts`
 * **复制 ＋ 机械改写**来的（三处：输出汇聚成字符串／导出 runner 去 `process.exit`／容器根由调用方给）。
 * "机械改写没改行为"这句话**必须由证据支撑**，不能由"我改得很小心"支撑（D119 的判据）。
 *
 * 🔴 **golden 的采集方式（可重建）**：在 CCC 侧 MSM **注销之前**，用**原引擎**对同一份 fixture
 * 跑 `check --level strict` 与 `explain`，**原样抄下 stdout**（2026-10-11，S142）。
 * 本件把它固化成断言 ⇒ 即使原 MSM 已注销，这份"行为基线"仍然在（这是搬迁能留下的最强证据）。
 *
 * 采集时的两个读数（当时原引擎的输出）：
 *   · `check --level strict` ⇒ **exit 1**（fixture 刻意含一条 M8 错 ＋ 一条 M9 告警）
 *   · `explain`              ⇒ **exit 0**
 *
 * ⚠️ fixture 里 **`sr:name` 必须给**：报告标题用本体名而不是文件路径 ⇒ golden 与**路径无关**
 *    （否则换台机器跑就红 —— 这类"环境相关的 golden"是假红工厂）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runOntologyCli } from '../src/ontology/engine.js'

/** 固定样本：同时含 ① 干净类型 ② 未知点号路径（M9 warning）③ 保留字当属性（M8 error） */
const FIXTURE = `@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix sr: <http://home-serenity/ontology#> .
@prefix : <http://example.org/onto#> .

:onto a owl:Ontology ;
    sr:name "golden-fixture" ;
    owl:versionInfo "0.0.1" .

:Widget a owl:Class ;
    rdfs:label "A widget" ;
    sr:rigidity "rigid" ;
    sr:identity :widgetName ;
    sr:property [
      sr:name "widgetName" ;
      sr:propType "string" ;
      sr:cardinality "exactly 1"
    ] ;
    sr:property [
      sr:name "count" ;
      sr:propType "integer" ;
      sr:cardinality "exactly 1"
    ] .

:Gadget a owl:Class ;
    rdfs:label "A gadget" ;
    sr:rigidity "anti-rigid" ;
    sr:property [
      sr:name "gadgetId" ;
      sr:propType "string" ;
      sr:cardinality "exactly 1"
    ] .

:feeds a owl:ObjectProperty ;
    rdfs:domain :Widget ;
    rdfs:range :Gadget ;
    sr:cardinality "min 0" .

:onto sr:axiom [
    sr:axiomId "AX-GOLDEN-CLEAN" ;
    sr:description "a well-formed rule that the engine fully parses" ;
    sr:rule "Widget.count >= 1" ;
    sr:axiomType "state" ;
    sr:rationale "probe"
  ] .

:onto sr:axiom [
    sr:axiomId "AX-GOLDEN-UNKNOWN-HEAD" ;
    sr:description "a dotted path whose head is not a declared type (M9 warning)" ;
    sr:rule "NoSuchType.someProp == 1" ;
    sr:axiomType "state" ;
    sr:rationale "probe"
  ] .

:onto sr:axiom [
    sr:axiomId "AX-GOLDEN-KEYWORD" ;
    sr:description "a reserved word used as a property (M8 error)" ;
    sr:rule "Widget.exists == true" ;
    sr:axiomType "state" ;
    sr:rationale "probe"
  ] .
`

const RULE = '='.repeat(60)

/** 2026-10-11 原引擎（CCC 的 MSM）实测 stdout，逐字抄录 */
const GOLDEN_CHECK = `
Ontology Validation: golden-fixture
${RULE}

Errors: 1, Warnings: 1

  ERR [M8] Axiom #3 parse error at pos 7: Expected identifier after '.'
  WRN [M9] Axiom #2 references unknown type "NoSuchType" in "NoSuchType.someProp"

── Strict mode — LLM review suggestions ──
  (Run through LLM for L1-L5 semantic checks)
  [L2] Review axioms for domain completeness — are there missing temporal or state constraints?
  [L3] Type "Widget" identity: http://example.org/onto#widgetName — is this sufficient for uniqueness?
  [L4] Review types: Widget, Gadget — are there missing distinctions?
  [L5] Axioms reference concepts — review if all referenced entities are defined
`

const GOLDEN_EXPLAIN = `## Ontology: golden-fixture
Version: 0.0.1

### Types (2)

| Type | SuperTypes | Rigidity | Properties |
|------|-----------|----------|------------|
| Widget | - | rigid | widgetName, count |
| Gadget | - | anti-rigid | gadgetId |

### Relations

| Name | Domain | Range | Cardinality | Flags |
|------|--------|-------|-------------|-------|
| feeds | Widget | Gadget | min 0 | - |

### Axioms (3)

- a well-formed rule that the engine fully parses: \`Widget.count >= 1\` [state]
- a dotted path whose head is not a declared type (M9 warning): \`NoSuchType.someProp == 1\` [state]
- a reserved word used as a property (M8 error): \`Widget.exists == true\` [state]

### Dependency Graph

`

let dir = ''
let ttl = ''

beforeEach(() => {
  dir = join(tmpdir(), `onto-golden-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  ttl = join(dir, 'golden-fixture.ttl')
  writeFileSync(ttl, FIXTURE, 'utf-8')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('ontology 引擎：移植保真度（与 CCC 原 MSM 逐字同输出）', () => {
  it('check --level strict ⇒ stdout 与 golden **逐字相同**，退出码 1', () => {
    const r = runOntologyCli(['check', ttl, '--level', 'strict'], { cwd: dir })
    expect(r.stdout).toBe(GOLDEN_CHECK)
    expect(r.code).toBe(1)
  })

  it('explain ⇒ stdout 与 golden **逐字相同**，退出码 0', () => {
    const r = runOntologyCli(['explain', ttl], { cwd: dir })
    expect(r.stdout).toBe(GOLDEN_EXPLAIN)
    expect(r.code).toBe(0)
  })

  it('🔴 正控：换一份**不同**的 fixture ⇒ 输出必须**不再**等于 golden（否则本件是空断言）', () => {
    // ⚠️ 变异必须落在**报告看得见的地方**：`check` 只列 issue、不回显全部规则
    //    ⇒ 第一次把 `Widget.count >= 1` 改成 `>= 2` 时正控**失败**了（那条本来干净，改了对报告没影响）
    //    —— 这正是"正控本身要先证明不瞎"。改用**悬空运算符**（实测会让 M8 报错 ⇒ Errors 1→2）。
    const variant = FIXTURE.replace('Widget.count >= 1', 'Widget.count >= 1 and')
    writeFileSync(ttl, variant, 'utf-8')
    const r = runOntologyCli(['check', ttl, '--level', 'strict'], { cwd: dir })
    expect(r.stdout).not.toBe(GOLDEN_CHECK)
    expect(r.stdout).toContain('Errors: 2')
  })

  it('🔴 路径无关性：同一内容换个文件名/目录 ⇒ 输出不变（golden 不绑路径）', () => {
    const other = join(dir, 'renamed.ttl')
    writeFileSync(other, FIXTURE, 'utf-8')
    const r = runOntologyCli(['check', other, '--level', 'strict'], { cwd: dir })
    expect(r.stdout).toBe(GOLDEN_CHECK)
  })
})
