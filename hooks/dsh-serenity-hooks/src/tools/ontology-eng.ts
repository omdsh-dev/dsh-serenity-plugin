/**
 * ontology-eng.ts（工具面）— 本体工程**引擎**（v1.52.0，S142 D121）
 *
 * 来源：宁静号 CCC 的 MSM `ontology-engineering`，owner 2026-10-11 裁「**搬到 ACC**」。
 * 判据：ACC 侧此前只有 `praxis ontology` 的**文本手册**（说得出判据 M1–M10 的编号与含义），
 * 却**一行可执行代码都没有** —— 能真跑 `check/verify/compliance` 的是引擎，不是手册。
 *
 * 🔴 **三段分工，别混**：
 *   · **引擎** `src/ontology/engine.ts` —— 解析 Turtle、M1–M10 结构检查、L1–L5 提示、
 *     V1–V4 运行时合规、review/compliance 提示词生成。纯函数、只用 node 内建模块。
 *   · **本文件（工具壳）** —— 参数 → argv、**路径守卫**、把 `(code, stdout, stderr)` 翻成回执。
 *   · **方法手册** `src/tools/ontology.ts`（praxis 第四段）—— 给人/模型读的"怎么做本体工程"。
 *
 * 🔴 **为什么路径必须先过 `resolveInside`**：引擎会 `process.chdir(cccRoot)` 再按路径读写，
 *   且 `init` **会写文件** ⇒ 入参路径不先证"在容器内"，就等于绕过 CCC 边界（P3）。
 *
 * 🔴 **退出码是返回值不是进程退出**（搬迁改写 ②）：引擎不再 `process.exit`，
 *   本壳把 `code !== 0` 连同引擎**逐字保留**的 stderr 文案一起回执（不重写引擎的报错）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { relative, dirname, join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cccRootForExec, NO_CCC_FROM_AGENT_CWD } from '../kernel/ccc-roots.js'
import { resolveInside } from '../kernel/ccc.js'
import { runOntologyCli } from '../ontology/engine.js'
import { fromEngine, layout, toSvg, toHtml } from '../ontology/viz.js'
import { rasterizeSvg } from '../diagram/rasterize.js'

const COMMANDS = ['init', 'check', 'explain', 'verify', 'review', 'compliance', 'viz'] as const
const LEVELS = ['normal', 'strict', 'operational', 'continuity', 'full', 'semantic', 'onto-clean'] as const
const TEMPLATES = ['minimal', 'full'] as const
const FORMATS = ['prompt', 'json'] as const

/** 各子命令接受的 level 取值（否则引擎会以 PARAMETER_INVALID_VALUE 拒掉——这里先拦，报错更直白） */
const LEVELS_BY_COMMAND: Record<string, readonly string[]> = {
  check: ['normal', 'strict'],
  verify: ['operational', 'continuity', 'full'],
  review: ['semantic', 'onto-clean', 'full'],
}

export interface OntologyToolResult {
  ok: boolean
  code: number
  command: string
  /** 容器内相对路径（回执里给相对路径：它是可重建的那一个） */
  path: string
  stdout: string
  stderr: string
}

function renderText(value: unknown): ContentBlock[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

/**
 * 把引擎结果翻成**一段文本回执**（本工具返回 string —— 见 `schema: 'string'` 的理由）。
 *
 * 🔴 **为什么返回字符串而不是 JSON 对象**：引擎的报告是**多行 Markdown 式**（表格 ＋ 逐条 ERR/WRN），
 *   走 `schema:'json'` 会被 `JSON.stringify` 把换行转义成 `\n` ⇒ 模型读到的是**一坨转义串**，
 *   可读性直接没了。字符串形态还能原样保留引擎文案（"逐字"是搬迁的硬要求）。
 *   退出码印在**首行**（回执自带判据，不必让调用方去数文本）。
 */
function receiptOf(v: OntologyToolResult): string {
  const head = `[ontology ${v.command}] ${v.ok ? '✓' : '✗'} exit ${v.code} — ${v.path}`
  const parts = [head]
  if (v.stdout.trim() !== '') parts.push(v.stdout.trimEnd())
  if (!v.ok && v.stderr.trim() !== '') parts.push(v.stderr.trimEnd())
  if (!v.ok) {
    parts.push(
      v.code === 1
        ? '（exit 1 = 参数或校验失败：修完再跑；引擎的 ERR 行在正文里）'
        : v.code === 2
          ? '（exit 2 = 文件缺失／解析失败：先确认路径与 .ttl 语法）'
          : '（exit 4 = 引擎内部错误：把上面整段报给 ACC 维护者）',
    )
  }
  return parts.join('\n\n')
}

/**
 * 本体工程引擎（`ontology`）—— 六个子命令：init/check/explain/verify/review/compliance。
 * 只读的五个不写任何文件；`init` 会在容器内**新建** .ttl 模板。
 */
export function createOntologyTool() {
  return defineTool({
    name: 'ontology',
    description:
      'Ontology engineering engine (parses Turtle .ttl, runs the judgement sets, emits reports). '
      + 'Subcommands: init (write a template) / check (M1-M10 structural validation; level=strict adds L1-L5 hints) / '
      + 'explain (natural-language summary) / verify (V1-V4 runtime compliance: declaration vs reality) / '
      + 'review (semantic review prompt for a read-only subagent; level=semantic|onto-clean|full) / '
      + 'compliance (axiom-vs-skill compliance checklist; skill by skill). '
      + 'path must stay inside this container (relative to the container root, or an absolute path inside it). '
      + 'Exit code is returned in the receipt: 0 = clean, 1 = parameter/validation failure, 2 = file/parse failure, '
      + '4 = internal. The engine text is passed through verbatim — read it, do not assume success from the call alone.',
    parameters: {
      command: {
        type: 'string',
        enum: [...COMMANDS],
        description: 'Subcommand: init / check / explain / verify / review / compliance.',
      },
      path: {
        type: 'string',
        description: 'Path to the .ttl file, inside this container (relative to the container root, or an absolute path that stays inside it).',
      },
      level: {
        type: 'string',
        enum: [...LEVELS],
        description: 'Depth knob, meaning depends on the subcommand: check → normal|strict; verify → operational|continuity|full; review → semantic|onto-clean|full.',
      },
      template: {
        type: 'string',
        enum: [...TEMPLATES],
        description: 'init only: template size, minimal (default) or full.',
      },
      skills: {
        type: 'string',
        description: 'compliance only: skills directory to scan (default .opencode/skills inside the container).',
      },
      format: {
        type: 'string',
        enum: [...FORMATS],
        description: 'review / compliance only: prompt (LLM-readable checklist, default) or json.',
      },
      png: {
        type: 'boolean',
        description: 'viz only: also rasterize a PNG next to the HTML (for pasting a static image into the conversation).',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => renderText(value),
    },
    async execute(args, exec) {
      const root = cccRootForExec(exec)
      if (!root) throw new Error(NO_CCC_FROM_AGENT_CWD)

      const command = typeof args.command === 'string' ? args.command.trim() : ''
      if (!(COMMANDS as readonly string[]).includes(command)) {
        throw new Error(
          `ontology: \`command\` must be one of ${COMMANDS.join(' / ')} (got: ${command === '' ? '(missing)' : command})`,
        )
      }

      const rawPath = typeof args.path === 'string' ? args.path.trim() : ''
      if (rawPath === '') throw new Error('ontology: `path` is required (a .ttl file inside this container)')
      // 路径逃逸 ⇒ resolveInside 抛错（P3：容器边界）
      const absPath = resolveInside(root, rawPath)
      const relPath = relative(root, absPath) || '.'

      const argv: string[] = [command, absPath]

      // ── viz：**不走引擎 CLI**（它是独立渲染模块），单独一条分支 ──────────────
      // 🔴 与其余六个子命令的分工：那六个跑引擎、回一段报告文本；viz **产出文件**
      //    （html 交互版 ＋ 可选 PNG），回执给**路径与读数**。
      if (command === 'viz') {
        const model = fromEngine(relPath, absPath)
        const L = layout(model, { axioms: false, instances: true, imports: true })
        const svg = toSvg(model, L, { axioms: false })
        const html = toHtml(model, L, svg)
        // 🔴 **文件名必须含来源路径**（2026-10-13 实测缺陷）：只取 basename 时，
        //    `home-mail/skill.ttl` 与 `dsp-dev/skill.ttl` **都叫 `skill.ttl`** ⇒
        //    产物 `skill.html`／`skill.png` **互相覆盖**，而两次调用的回执**都报成功**
        //    （最坏形态：用户以为有两张图，其实只剩后一张）。
        //    ⇒ 用**相对路径**压平（`/` → `__`），与 CCC 侧 `ontology-viz all` 的命名同形。
        const stem = relPath.replace(/\.ttl$/, '').replace(/[\\/]/g, '__')
        const outDir = join(root, '_tmp', 'ontology-viz')
        mkdirSync(outDir, { recursive: true })
        const htmlPath = join(outDir, `${stem}.html`)
        writeFileSync(htmlPath, html, 'utf-8')
        const lines = [
          `[ontology viz] ✓ ${relPath}`,
          ``,
          `类 ${model.classes.length} ／ 关系 ${model.relations.length} ／ 公理 ${model.axioms.length} ／ 实例 ${model.instances.length}`,
          `交互版 HTML ⇒ ${relative(root, htmlPath)}`,
          `  打开后可拖动平移、滚轮缩放、点节点看详情（注释／属性／进出关系／涉及的公理）`,
        ]
        // `--png`：复用 diagram 既有的进程内光栅化（不新起浏览器）
        if (args.png === true) {
          const r = await rasterizeSvg(svg, 2400)
          const pngPath = join(outDir, `${stem}.png`)
          writeFileSync(pngPath, r.png)
          lines.push(`静态 PNG ⇒ ${relative(root, pngPath)}（${r.width}×${r.height}，${r.ms} ms）`)
        }
        return lines.join('\n')
      }

      const level = typeof args.level === 'string' ? args.level.trim() : ''
      if (level !== '') {
        const allowed = LEVELS_BY_COMMAND[command]
        if (allowed === undefined) {
          throw new Error(`ontology: \`level\` does not apply to \`${command}\` (it applies to: check / verify / review)`)
        }
        if (!allowed.includes(level)) {
          throw new Error(`ontology: level "${level}" is not valid for \`${command}\` — use one of ${allowed.join(' / ')}`)
        }
        argv.push('--level', level)
      }

      const template = typeof args.template === 'string' ? args.template.trim() : ''
      if (template !== '') {
        if (command !== 'init') throw new Error(`ontology: \`template\` applies to \`init\` only (got command: ${command})`)
        if (!(TEMPLATES as readonly string[]).includes(template)) {
          throw new Error(`ontology: template "${template}" is not valid — use one of ${TEMPLATES.join(' / ')}`)
        }
        argv.push('--template', template)
      }

      const format = typeof args.format === 'string' ? args.format.trim() : ''
      if (format !== '') {
        if (command !== 'review' && command !== 'compliance') {
          throw new Error(`ontology: \`format\` applies to review / compliance only (got command: ${command})`)
        }
        if (!(FORMATS as readonly string[]).includes(format)) {
          throw new Error(`ontology: format "${format}" is not valid — use one of ${FORMATS.join(' / ')}`)
        }
        argv.push('--format', format)
      }

      const skills = typeof args.skills === 'string' ? args.skills.trim() : ''
      if (skills !== '') {
        if (command !== 'compliance') throw new Error(`ontology: \`skills\` applies to \`compliance\` only (got command: ${command})`)
        argv.push('--skills', resolveInside(root, skills)) // 同样是容器内路径守卫
      }

      const res = runOntologyCli(argv, { cwd: root })
      return receiptOf({
        ok: res.code === 0,
        code: res.code,
        command,
        path: relPath,
        stdout: res.stdout,
        stderr: res.stderr,
      })
    },
  })
}
