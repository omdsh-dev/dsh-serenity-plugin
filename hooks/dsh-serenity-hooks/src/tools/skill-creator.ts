/**
 * skill-creator.ts（工具面）— `serenity-skill-creator`：**增强型 skill（serenity-skill）的 creator**
 *
 * 设计真相源：`docs/serenity-skill-design.md` §4.3（六个子命令）／§5（接口）／§6（判据 J9/J10）。
 * 来源：owner 2026-10-11 令 —— 「扩展 skill 相关 tool，将**基于本体论建模的 skill 编写和优化方法**进行交代，
 * 其实也就是我们这种增强型 skill 的 creator」，且**点名**要一个专门的工具、**名字由他给**。
 *
 * 🔴 **三段分工（别混）**：
 *   · **方法文本** = 本文件的 `SKILL_CREATOR_GUIDE`（`guide` 子命令印它）—— 给人/模型读"怎么做"。
 *   · **机械判据** = `src/skills/skill-ontology.ts`（P2）与 `src/skills/resource-index.ts`（P1）——
 *     本工具**只做转发与呈现，绝不重写一遍检查**（同一件事的第二实现是本仓的老账）。
 *   · **语义档 C** = 引擎的 `compliance`（半机械：出逐条可回答问题清单，交 LLM/人在环回答）。
 *
 * 🔴 **J9：未建模 ≠ 异常。** 没有 `skill.ttl` 的**普通 skill** 全程无声 —— 本工具任何子命令都
 *   不许把它渲染成错误或告警，只是"少一项能力"。
 *
 * 🔴 **写文件只发生在 `create`**，且**目标已存在一律拒**（不许静默覆盖别人目录）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { cccRootForExec, NO_CCC_FROM_AGENT_CWD } from '../ccc-roots.js'
import { resolveInside } from '../ccc.js'
import { isSafeSkillName } from '../skills-discovery.js'
import { runOntologyCli } from '../ontology/engine.js'
import { buildResourceIndex, REFERENCE_DIR, SKILL_ONTOLOGY_FILE } from '../skills/resource-index.js'
import { formatSkillOntologyInspection, inspectSkillOntology } from '../skills/skill-ontology.js'

const ACTIONS = ['guide', 'create', 'check', 'review', 'index', 'status'] as const

/** 基础链（skill.ttl 必须链上的那个文件）在**顶层 skill** 的 references/ 下 */
const BASE_CHAIN_FILE = 'serenity-skills-ontology.ttl'

/** 缺省顶层 skill 名（与引擎的 TOP_SKILL 缺省一致；`create` 会优先读 `.serenity`） */
const DEFAULT_TOP_SKILL = 'home-serenity'

/**
 * 《serenity-skill 编写与优化方法》（`guide` 印它）。
 *
 * 边界（D23）：**本文只是方法**；判据在代码里（P1/P2），语义审查在引擎的 `compliance` 里 ——
 * 三者**不许互相抄**（同一件事写两遍必然漂移）。
 */
export const SKILL_CREATOR_GUIDE = `# serenity-skill —— 增强型 skill 的编写与优化方法

## 何时该建模，何时不该

**该建模**：该领域有**稳定的类型与关系**（谁是谁、一对多、什么必须先于什么），且这些结构**会反复被引用**
（排错、审查、写文档都要回去看它）—— 典型如"一个 skill 管哪些资产、资产之间什么约束"。

**不该建模**（**不建模不是缺陷**）：
· 纯操作规程（"先跑 A 再跑 B"）—— 那是 SKILL.md 的正文，给它套本体只是换个地方写散文；
· 一次性/短命的事；
· 你自己都还说不清领域里到底有哪几类东西时 —— **先写散文，等结构浮现再建模**（建模不是入场券）。

## 三个动作（做完即"已建模"）

1. 在 skill 目录放**固定名** \`skill.ttl\`（与 \`SKILL.md\` 并列）—— 这是**唯一**被认的名字。
   ⚠️ 旧写法 \`references/<name>-domain.ttl\` **不被认**（静默当普通参考件）：不是报错，是**没有人会看它**。
2. \`skill.ttl\` **必须链上基础链**，形式是 \`owl:imports <相对路径>\`：
   \`\`\`turtle
   :onto a owl:Ontology ;
      sr:name "<skill-name>" ;
      owl:versionInfo "0.1.0" ;
      owl:imports <../home-serenity/references/serenity-skills-ontology.ttl> .
   \`\`\`
   🔴 **相对路径由 \`create\` 算**（从本 skill 目录指向顶层 skill 的 references/），**不要人肉推**。
   🔴 引擎**只解析 \`owl:imports\`**；写 \`sr:imports\` **不会被读**，而且 \`check\` 对它**照样报全绿** ——
   所以别只看 \`check\` 绿就以为链上了（这正是本工具 \`check\` 要同时跑 A2 的原因）。
3. 让 \`check\` 全绿（A1 结构合法 ＋ A2 链上基础链）。

## 两层披露树的写法习惯（影响模型能不能找得到）

· \`references/\` 里的文件名**就是目录**：前缀数字（\`00-\`…\`90-\`）给稳定次序，名字**写成能读懂的一句**。
· 每个参考文件的**首个 \`#\` 标题**会被当作索引里的摘要 ⇒ **给每个 .md 写一个说人话的首标题**（别写文件名复读）。
· 索引**只列不读**：正文永远留给按需 \`read\` ⇒ 别把大段内容塞进 SKILL.md（它每请求都注入）。
· \`references/\` 下的**子目录**会被列成一行（名字＋文件数），**不展开** ⇒ 目录名要起得让人知道里面是什么。

## 从领域散文到 ttl（具体步骤）

1. 把 SKILL.md 里的名词圈出来 → 挑出**反复出现、有身份**的那些 = 候选类型；
2. 给每个类型写：\`rdfs:label\` ＋ \`sr:rigidity\`（\`rigid\` 身份固定／\`anti-rigid\` 会变）＋ 身份属性（\`sr:identity\`）；
3. 把动词圈出来 → 有方向、有基数的 = 关系（\`rdfs:domain\`/\`rdfs:range\` ＋ \`sr:cardinality\`）；
4. 把"永远成立的话"写成公理（\`sr:axiom\`）—— **只写真能判真假的**，别写口号；
5. 补 \`sr:source\`/来源（对外部主张）。
**方法正文不在这里重复**：见 \`praxis ontology\`（本体工程方法群：四组判据 M1–M10／L1–L5／D1–D8／V1–V4、OEPE 回路、反模式）。

## 优化回路（改完之后再走一遍）

\`\`\`
serenity-skill-creator index <skill>    ← 先看模型到底会看到什么（露没露、顺序对不对）
serenity-skill-creator check <skill>    ← A1 结构 ＋ A2 链上（机械，必须全绿）
serenity-skill-creator review <skill>   ← C 档：文字与 ttl 逐条的合规问题清单（要人在环答）
（改 SKILL.md / skill.ttl / references）
   ↑__________________________ 回到第一步
\`\`\`

**判据**：改完**必须重跑** \`check\` —— 本仓的教训是"检查没跑"和"检查通过"在输出上必须分得开；
\`review\` 出的是**问题清单**（半机械、要人回答），**不是**通过/不通过。
`

function renderText(value: unknown): ContentBlock[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

/** 顶层 skill 名：优先 `.serenity` 记号文件（CCC 的权威语义），否则缺省 */
function readTopSkill(root: string): string {
  try {
    const marker = join(root, '.serenity')
    if (existsSync(marker)) {
      const name = readFileSync(marker, 'utf-8').trim()
      if (name !== '') return name
    }
  } catch {
    /* 读不到就用缺省 */
  }
  return DEFAULT_TOP_SKILL
}

/** skill 目录（容器内相对路径 → 绝对）；名字先过安全门 */
function skillDirOf(root: string, name: string): string {
  if (!isSafeSkillName(name)) {
    throw new Error(`serenity-skill-creator: 非法 skill 名 "${name}"（只允许简单目录名，不许含 / 或 ..）`)
  }
  return resolveInside(root, join('.opencode', 'skills', name))
}

/** 从 skill 目录算到基础链的相对路径（**由本工具算，不靠人肉推**） */
function baseChainImport(root: string, skillDir: string): string {
  const top = readTopSkill(root)
  const base = join(root, '.opencode', 'skills', top, 'references', BASE_CHAIN_FILE)
  return relative(skillDir, base).split('\\').join('/')
}

/** 列出 CCC 的全部 skill 目录名（有 SKILL.md 的一级目录） */
function listSkillNames(root: string): string[] {
  const skillsRoot = join(root, '.opencode', 'skills')
  if (!existsSync(skillsRoot)) return []
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(skillsRoot, e.name, 'SKILL.md')))
    .map((e) => e.name)
    .sort()
}

/** `create` 的脚手架内容 */
function scaffoldFiles(name: string, importPath: string): Record<string, string> {
  return {
    'SKILL.md': `---
name: ${name}
description: （一句话说清这个 skill 管什么、什么时候该加载它）
---

# Skill: ${name}

## 用途

（这个领域是什么、管什么、不管什么）

## 触发条件/何时加载

（什么情况下该加载本 skill）

## 领域结构

（有本体时：本领域的类型与关系在这里只做**指路**，真相源是同级 \`${SKILL_ONTOLOGY_FILE}\`）

## 相关技能

（上下游 skill）
`,
    [SKILL_ONTOLOGY_FILE]: `@prefix sr:   <http://home-serenity/ontology#> .
@prefix owl:  <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix :     <http://home-serenity/ontology/${name}#> .

# 令 1.3：**必须**链上基础链。形式 = owl:imports <相对路径>（相对本文件所在目录解析）。
# 🔴 本行由 serenity-skill-creator 的 create 计算，别改成 sr:imports、也别手推路径。
:onto a owl:Ontology ;
   sr:name "${name}" ;
   owl:versionInfo "0.1.0" ;
   owl:imports <${importPath}> .

# ── 类型（把领域里"有身份、会反复被提到"的名词放这里）──────────────
:Thing a owl:Class ;
   rdfs:label "Thing" ;
   rdfs:comment "（一句话说清这类东西是什么）" ;
   sr:rigidity sr:rigid ;
   sr:identity ("thingId") ;
   sr:property [ sr:name "thingId" ; sr:type "string" ; sr:cardinality "exactly 1" ] .
`,
  }
}

export function createSkillCreatorTool() {
  return defineTool({
    name: 'serenity-skill-creator',
    description:
      'Creator for serenity-skills (this container\'s enhanced skill standard): write and optimize ontology-modeled skills. '
      + 'Subcommands: guide (the authoring/optimization method — read this first when creating or reworking a skill) / '
      + 'create <name> (scaffold a skill dir: SKILL.md + skill.ttl + references/, with the base-chain import path computed) / '
      + 'check <name> (A1 structural + A2 base-chain chained; three states — modeled-ok / plain-skill / modeled-but-check-could-not-run) / '
      + 'review <name> (C tier: axiom-vs-text compliance question list, half-mechanical — a human/LLM answers it) / '
      + 'index <name> (preview the second-layer resource list the model will actually see) / '
      + 'status (whole container: which skills are modeled, which are plain). '
      + 'A skill is "modeled" iff it has a file named exactly skill.ttl next to SKILL.md; '
      + 'a plain skill (no skill.ttl) is NOT an anomaly — it simply has no ontology. '
      + 'Only `create` writes, and it refuses to touch an existing skill directory.',
    parameters: {
      action: { type: 'string', enum: [...ACTIONS], description: 'guide / create / check / review / index / status.' },
      name: { type: 'string', description: 'Skill name (required for create/check/review/index; must be a simple directory name).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => renderText(value),
    },
    async execute(args, exec) {
      const root = cccRootForExec(exec)
      if (!root) throw new Error(NO_CCC_FROM_AGENT_CWD)

      const action = typeof args.action === 'string' ? args.action.trim() : ''
      if (!(ACTIONS as readonly string[]).includes(action)) {
        throw new Error(`serenity-skill-creator: \`action\` must be one of ${ACTIONS.join(' / ')} (got: ${action === '' ? '(missing)' : action})`)
      }
      const name = typeof args.name === 'string' ? args.name.trim() : ''
      const needName = (): string => {
        if (name === '') throw new Error(`serenity-skill-creator: \`name\` is required for \`${action}\``)
        return name
      }

      if (action === 'guide') return SKILL_CREATOR_GUIDE

      // ── status：全 CCC 一览（**未建模不是异常**，J9）─────────────────────
      if (action === 'status') {
        const names = listSkillNames(root)
        if (names.length === 0) return `（\`.opencode/skills\` 下没有带 SKILL.md 的 skill）`
        const modeled: string[] = []
        const plain: string[] = []
        const broken: string[] = []
        for (const n of names) {
          const dir = join(root, '.opencode', 'skills', n)
          if (!existsSync(join(dir, SKILL_ONTOLOGY_FILE))) {
            plain.push(n)
            continue
          }
          const insp = inspectSkillOntology(dir, { root })
          if (insp.state === 'ok') modeled.push(n)
          else broken.push(formatSkillOntologyInspection(n, insp))
        }
        return [
          `serenity-skill 一览（顶层 skill = ${readTopSkill(root)}）`,
          `\n🧬 **已建模且通过** ${modeled.length} 个` + (modeled.length > 0 ? `：${modeled.join(', ')}` : ''),
          `\n⬜ **普通 skill（未建模）** ${plain.length} 个`,
          '   ⚠️ 这**不是异常**，只是少一项能力（J9：增强对普通 skill 完全向后兼容）。',
          broken.length > 0 ? `\n❌ **建模了但检查没跑成** ${broken.length} 个：\n${broken.join('\n')}` : '',
        ]
          .filter((s) => s !== '')
          .join('\n')
      }

      const dir = skillDirOf(root, needName())

      // ── create：脚手架（**唯一会写文件的动作**；已存在一律拒）──────────────
      if (action === 'create') {
        if (existsSync(dir)) {
          throw new Error(
            `serenity-skill-creator: 目录已存在，拒绝覆盖 → ${relative(root, dir)}`
              + '（改造既有 skill 请直接编辑它的 SKILL.md/skill.ttl；本工具不代劳，免得静默盖掉你的东西）',
          )
        }
        const files = scaffoldFiles(name, baseChainImport(root, dir))
        mkdirSync(join(dir, REFERENCE_DIR), { recursive: true })
        for (const [rel, content] of Object.entries(files)) {
          writeFileSync(join(dir, rel), content, 'utf-8')
        }
        return [
          `✅ 已生成 skill 脚手架：${relative(root, dir)}`,
          '',
          ...Object.keys(files).map((f) => `   · ${f}`),
          `   · ${REFERENCE_DIR}/（空目录）`,
          '',
          `🔗 skill.ttl 已链上基础链（相对路径由本工具算）：\`${baseChainImport(root, dir)}\``,
          '👉 下一步：填 SKILL.md 的用途/触发条件 → 跑 `check` 让它全绿 → 需要时 `index` 看模型会看到什么。',
          '   （方法论：`serenity-skill-creator guide`；本体工程方法群：`praxis ontology`。）',
        ].join('\n')
      }

      if (!existsSync(dir)) {
        throw new Error(`serenity-skill-creator: 找不到 skill 目录 → ${relative(root, dir)}（名字拼错？）`)
      }

      // ── index：第二层披露预览（调 P1 的生成器，**不重写**）────────────────
      if (action === 'index') {
        const idx = buildResourceIndex(dir)
        return idx === ''
          ? `${name}：**无参考件可列**（无 \`${REFERENCE_DIR}/\` 且无 \`${SKILL_ONTOLOGY_FILE}\`）⇒ 注入时**不产出**第二层块。`
          : `以下就是模型在提示词里**真正会看到**的第二层（只有清单，没有正文）：\n\n${idx}`
      }

      // ── check：A1/A2 两档（调 P2 的检查，**不重写**）─────────────────────
      if (action === 'check') {
        const insp = inspectSkillOntology(dir, { root })
        const body = formatSkillOntologyInspection(name, insp)
        if (insp.state === 'none') {
          return `${body}\n\n（要建模：\`serenity-skill-creator guide\` 看三个动作，或 \`create\` 生成骨架。）`
        }
        return insp.state === 'ok'
          ? `${body}\n\n👉 机械档过了。语义档（文字是否真遵守模型/公理）走 \`review\`。`
          : `${body}\n\n👉 修完**重跑本命令**（本仓教训：「检查没跑」与「检查通过」必须分得开）。`
      }

      // ── review：C 档（半机械；调引擎的 compliance，**不重写**）─────────────
      const ttl = join(dir, SKILL_ONTOLOGY_FILE)
      if (!existsSync(ttl)) {
        return formatSkillOntologyInspection(name, inspectSkillOntology(dir, { root }))
          + `\n\n（\`review\` 需要 \`${SKILL_ONTOLOGY_FILE}\`；普通 skill 没有可审的模型 —— 这不是错误。）`
      }
      const r = runOntologyCli(['compliance', ttl, '--skills', join(root, '.opencode', 'skills')], { cwd: root })
      return [
        `[review ${name}] 引擎 compliance ${r.code === 0 ? '✓' : '✗'} exit ${r.code}`,
        '',
        r.stdout.trim() !== '' ? r.stdout.trimEnd() : '(引擎无输出)',
        r.code !== 0 && r.stderr.trim() !== '' ? `\n${r.stderr.trimEnd()}` : '',
        '',
        '⚠️ 这是 **C 档（半机械）**：它给的是**逐条要回答的问题清单**，不是"通过/不通过"。',
        '   请**逐条回答**；发现文字与模型不符 ⇒ 改文字或改 ttl，然后重跑 `check`。',
      ]
        .filter((s) => s !== '')
        .join('\n')
    },
  })
}
