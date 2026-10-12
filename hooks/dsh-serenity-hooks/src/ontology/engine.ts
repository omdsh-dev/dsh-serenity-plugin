/**
 * engine.ts — Ontology Definition, Validation & Semantic Review（ACC 侧引擎）
 *
 * 来源：宁静号 CCC 的 MSM `ontology-engineering`
 *   （原 `.opencode/skills/home-ontology/scripts/ontology-engineering.ts`；
 *    2026-10-11 owner 裁「搬到 ACC」）。
 *   搬迁方式 = **复制 ＋ 机械改写**，不是重写 —— 判据群（M1–M10／L1–L5／D1–D8／V1–V4）与
 *   全部输出文案**逐字保留**，只在"如何被调用/如何吐字"这一层做了三处改写（见下）。
 *
 * 本文件是**纯引擎**：只用 node 内建模块，不依赖宿主与 CCC。三段分工：
 *   · 引擎（本文件）＝ 解析与检查；
 *   · 工具壳 `src/tools/ontology-eng.ts` ＝ 参数、路径守卫、把结果翻成回执；
 *   · 方法手册 `src/tools/ontology.ts`（praxis 第四段）＝ 人/模型读的方法论。
 *
 * 🔴 搬迁改写清单（相对原 MSM 脚本，行为差异仅此三处）：
 *   ① **输出不再直写 `process.stdout`** ⇒ 经 `emit()`／`emitErr()` 汇聚。宿主是**长驻进程**，
 *      工具调用必须**返回文本**（且不能污染服务器自己的 stdout）。
 *   ② **`main()` ＋ `process.argv` 守卫 ⇒ 导出 `runOntologyCli(argv, opts)`**：**不再 `process.exit`**，
 *      退出码（0/1/2/4）改为**返回值**，由工具壳翻译成可读回执。
 *   ③ **运行时工作目录由调用方给**（`opts.cwd` = CCC 根）：引擎多处按相对路径解析
 *      `.opencode/skills` ⇒ 改用**显式基准目录 `BASE`**（一律 `resolve(BASE, …)`），
 *      **不用 `process.chdir`** —— chdir 在 **worker 线程里不被支持**
 *      （`ERR_WORKER_UNSUPPORTED_OPERATION`；vitest 就用 worker 跑），且长驻进程
 *      改全局 cwd 是隐患。`BASE` 只在本进程内、由 `runOntologyCli` 的 try/finally
 *      保存与恢复；`resolve(BASE, x)` 对**绝对路径天然无害**（原样返回）⇒ 生产路径
 *      （工具壳传绝对路径进来）行为不变。
 *
 * subcommands（与原脚本逐一对应）：
 *   init       <path> [--template minimal|full]       写一份 Turtle 模板
 *   check      <path> [--level normal|strict]         M1–M10 结构检查（strict 另出 L1–L5 提示）
 *   explain    <path>                                 自然语言摘要
 *   verify     <path> [--level operational|continuity|full]  V1–V4 运行时合规
 *   review     <path> [--level semantic|onto-clean|full] [--format prompt|json]  语义审查提示词
 *   compliance <path> [--skills <dir>] [--format prompt|json]  公理↔skill 合规清单
 *
 * 退出码：0 成功 ／ 1 user（参数或校验失败）／ 2 system（文件缺失／解析失败）／ 4 internal
 * 错误码：PARAMETER_MISSING ／ PARAMETER_INVALID_VALUE ／ ONTO_FILE_NOT_FOUND ／ ONTO_PARSE_ERROR
 *        ／ ONTO_AXIOM_PARSE_ERROR ／ ONTO_VALIDATION_FAILED ／ INTERNAL_UNHANDLED_STATE
 */

import { readFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── 输出汇聚（改写 ①）────────────────────────────────────────────────
type Sink = { write(s: string): void };
let OUT: Sink = { write: (s) => void process.stdout.write(s) };
let ERR: Sink = { write: (s) => void process.stderr.write(s) };
function emit(s: string): void { OUT.write(s) }
function emitErr(s: string): void { ERR.write(s) }


// ═══════════════════════════════════════════════════════════════════
// Error class
// ═══════════════════════════════════════════════════════════════════

type Category = "user" | "system" | "operator" | "internal";

class MsmError extends Error {
  constructor(
    public code: string,
    public category: Category,
    public message: string,
    public context: Record<string, unknown> = {},
    public remediation?: string,
    public cause?: unknown,
  ) {
    super(message);
    this.name = "MsmError";
  }

  toStderr(): string {
    const lines: string[] = [
      `[${this.code}]`,
      `  code: ${this.code}`,
      `  category: ${this.category}`,
      `  message: ${this.message}`,
      `  cause: ${this.cause !== undefined && this.cause !== ""
        ? (this.cause instanceof Error ? this.cause.message : String(this.cause))
        : "(no underlying cause)"}`,
    ];
    if (this.remediation) lines.push(`  remediation: ${this.remediation}`);
    if (Object.keys(this.context).length > 0) {
      lines.push(`  context: ${JSON.stringify(this.context)}`);
    }
    return lines.join("\n");
  }

  exitCode(): number {
    return { user: 1, system: 2, operator: 3, internal: 4 }[this.category];
  }
}

function emitError(err: MsmError): void {
  emitErr(err.toStderr() + "\n");
}

// ═══════════════════════════════════════════════════════════════════
// Ontology definition types
// ═══════════════════════════════════════════════════════════════════

interface PropertyDef {
  type: string;
  cardinality?: string;
  values?: string[];
}

interface TypeDef {
  description?: string;
  superTypes?: string[];
  rigidity?: "rigid" | "anti-rigid" | "semi-rigid";
  identity?: string[];
  dependsOn?: string[];
  properties?: Record<string, PropertyDef>;
  axioms?: string[];
}

interface RelationDef {
  domain?: string;
  range?: string;
  cardinality?: string;
  functional?: boolean;
  transitive?: boolean;
  symmetric?: boolean;
  asymmetric?: boolean;
  reflexive?: boolean;
  irreflexive?: boolean;
}

interface AxiomDef {
  description?: string;
  rule: string;
  type?: string;
}

interface OntologyDefinition {
  name?: string;
  version?: string;
  imports?: string[];
  types?: Record<string, TypeDef>;
  relations?: Record<string, RelationDef>;
  axioms?: AxiomDef[];
}

// ═══════════════════════════════════════════════════════════════════
// Turtle (Terse RDF Triple Language) — Lexer + Parser + Mapper
// Standard W3C format; pre-trained in all major LLMs
// ═══════════════════════════════════════════════════════════════════

const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
const OWL = "http://www.w3.org/2002/07/owl#";
const XSD = "http://www.w3.org/2001/XMLSchema#";
/** `sr:` 命名空间 —— **容器约定**（宁静号及同源 CCC 用 `http://home-serenity/ontology#`）。
 *  可用 `runOntologyCli(argv, { namespace })` 覆盖；缺省与原 MSM 脚本**逐字相同**。 */
let SR = "http://home-serenity/ontology#";

/** 顶层 skill 名 —— 引擎有三处按它定位容器级资产（根标记 / MSM 注册表 / 合规扫描）。
 *  可用 `runOntologyCli(argv, { topSkill })` 覆盖；缺省 = 宁静号的顶层 skill。 */
let TOP_SKILL = "home-serenity";

/** 容器根（CCC root）—— 由调用方给定（改写 ③）。**ACC 侧必须给**：插件安装在宿主 profile 下，
 *  沿 `__dirname` 上溯只会走到安装路径，永远命不中 CCC 的 `.opencode/skills/...`。 */
let ROOT: string | undefined = undefined;

/** 相对路径的解析基准 —— 由调用方给（= CCC 根，见改写 ③）。**不用 `process.chdir`**：
 *  chdir 在 worker 线程里不被支持（`ERR_WORKER_UNSUPPORTED_OPERATION`，vitest 就用 worker 跑），
 *  且在长驻进程里改全局 cwd 是隐患。缺省 = 进程启动时的工作目录。 */
let BASE = process.cwd();

const STD_PREFIXES: Record<string, string> = {
  rdf: RDF, rdfs: RDFS, owl: OWL, xsd: XSD, sr: SR,
};

// ---- Turtle Tokenizer ----
type TkKind = "qname" | "iri" | "a" | "literal" | "number" | "boolean" | "prefix" | "base"
  | "dot" | "semi" | "comma" | "lbracket" | "rbracket" | "lparen" | "rparen" | "eof";

interface Tk { kind: TkKind; value: string; pos: number; datatype?: string; lang?: string; }

function tokenizeTurtle(input: string): { tokens: Tk[]; errors: string[] } {
  const tokens: Tk[] = [];
  const errors: string[] = [];
  let i = 0;
  let safety = 0;
  function peek(n: number = 0): string { return i + n < input.length ? input[i + n]! : ""; }

  while (i < input.length) {
    if (++safety > 500000) { errors.push(`Tokenizer safety limit exceeded at position ${i}`); break; }
    const ch = input[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") { i++; continue; }
    if (ch === "#") { while (i < input.length && input[i] !== "\n") i++; continue; }

    if (ch === "@") {
      const start = i;
      i++; // skip '@'
      let kw = "";
      while (i < input.length && /[a-z]/i.test(input[i]!)) { kw += input[i]; i++; }
      if (kw === "prefix" || kw === "base") {
        tokens.push({ kind: kw, value: kw, pos: start });
      } else {
        errors.push(`Unknown directive @${kw} at ${start}`);
      }
      continue;
    }

    if (ch === "<") {
      const start = i;
      let iri = ""; i++;
      while (i < input.length && input[i] !== ">") { iri += input[i]; i++; }
      if (i < input.length) i++; else errors.push(`Unclosed IRI at ${start}`);
      tokens.push({ kind: "iri", value: iri, pos: start });
      continue;
    }

    if (ch === '"' || ch === "'") {
      const start = i, quote = ch;
      let val = ""; i++;
      // Triple-quoted string
      if (input[i] === quote && input[i + 1] === quote) {
        i += 2;
        while (i < input.length && !(input[i] === quote && input[i + 1] === quote && input[i + 2] === quote)) {
          val += input[i]; i++;
        }
        if (i < input.length) i += 3; else errors.push(`Unclosed triple-quoted string at ${start}`);
      } else {
        while (i < input.length && input[i] !== quote) {
          if (input[i] === "\\" && i + 1 < input.length) { val += input[++i]; }
          else { val += input[i]; }
          i++;
        }
        if (i < input.length) i++; else errors.push(`Unclosed string at ${start}`);
      }
      const tk: Tk = { kind: "literal", value: val, pos: start };
      // Optional datatype or language
      if (input[i] === "@" && /[a-z]/i.test(input[i + 1]!)) {
        i++; let lang = "";
        while (i < input.length && /[a-z-]/i.test(input[i]!)) { lang += input[i]; i++; }
        tk.lang = lang;
      } else if (input.slice(i, i + 2) === "^^") {
        i += 2;
        if (input[i] === "<") {
          i++; let dt = "";
          while (i < input.length && input[i] !== ">") { dt += input[i]; i++; }
          if (i < input.length) i++;
          tk.datatype = dt;
        }
      }
      tokens.push(tk);
      continue;
    }

    // Numbers (including negative, floats, exponents)
    if (/[0-9]/.test(ch) || (ch === "-" && /[0-9]/.test(peek(1)))) {
      const start = i;
      let num = "";
      if (ch === "-") { num += ch; i++; }
      if (input[i] === ".") { num += "."; i++; }
      while (i < input.length && /[0-9]/.test(input[i]!)) { num += input[i]; i++; }
      if (input[i] === "." && !/[a-zA-Z]/.test(peek(1))) { num += "."; i++; while (i < input.length && /[0-9]/.test(input[i]!)) { num += input[i]; i++; } }
      if (input[i] === "e" || input[i] === "E") { num += input[i]; i++; if (input[i] === "-" || input[i] === "+") { num += input[i]; i++; } while (i < input.length && /[0-9]/.test(input[i]!)) { num += input[i]; i++; } }
      tokens.push({ kind: "number", value: num, pos: start });
      continue;
    }

    // QNames / identifiers / booleans / 'a'
    if (/[a-zA-Z_:]/.test(ch)) {
      const start = i;
      let ident = "";
      while (i < input.length && /[a-zA-Z0-9_-]/.test(input[i]!)) { ident += input[i]; i++; }
      if (i < input.length && input[i] === ":") {
        ident += ":"; i++;
        while (i < input.length && /[a-zA-Z0-9_-]/.test(input[i]!)) { ident += input[i]; i++; }
        tokens.push({ kind: ident === "a" ? "a" : "qname", value: ident, pos: start });
      } else {
        if (ident === "a") { tokens.push({ kind: "a", value: "a", pos: start }); }
        else if (ident === "true" || ident === "false") { tokens.push({ kind: "boolean", value: ident, pos: start }); }
            else { tokens.push({ kind: "qname", value: ident.startsWith(":") ? ident : (":" + ident), pos: start }); }
      }
      continue;
    }

    switch (ch) {
      case ".": tokens.push({ kind: "dot", value: ".", pos: i }); i++; break;
      case ";": tokens.push({ kind: "semi", value: ";", pos: i }); i++; break;
      case ",": tokens.push({ kind: "comma", value: ",", pos: i }); i++; break;
      case "[": tokens.push({ kind: "lbracket", value: "[", pos: i }); i++; break;
      case "]": tokens.push({ kind: "rbracket", value: "]", pos: i }); i++; break;
      case "(": tokens.push({ kind: "lparen", value: "(", pos: i }); i++; break;
      case ")": tokens.push({ kind: "rparen", value: ")", pos: i }); i++; break;
      default: errors.push(`Unexpected character '${ch}' at position ${i}`); i++;
    }
  }
  tokens.push({ kind: "eof", value: "", pos: i });
  return { tokens, errors };
}

// ---- Turtle → Triples Parser ----
interface Triple { subject: string; predicate: string; object: string | number | boolean; objectType: "iri" | "literal" | "blank"; objectDatatype?: string; }

interface TurtleParseResult { prefixes: Map<string, string>; triples: Triple[]; errors: string[]; }

function parseTurtle(raw: string): TurtleParseResult {
  const { tokens, errors } = tokenizeTurtle(raw);
  if (errors.length > 0) return { prefixes: new Map(), triples: [], errors };

  const prefixes = new Map<string, string>();
  const p2q = new Map<string, string>(); // IRI → qname
  let baseIri = "http://example.org/onto#";
  let pos = 0; let blankCounter = 0;

  function nextBnode(): string { return `_:b${blankCounter++}`; }

  function peek(): Tk { return tokens[pos]!; }
  function advance(): Tk { return tokens[pos++]!; }
  function resolveIri(tk: Tk): string {
    if (tk.kind === "iri") return tk.value;
    if (tk.kind === "a") return RDF + "type";
    if (tk.kind === "qname") {
      const colon = tk.value.indexOf(":");
      const prefix = tk.value.slice(0, colon);
      const local = tk.value.slice(colon + 1);
      // 🔴 **A45 修复（v1.56.1）**：空前缀（`:Local`）**必须先看文件自己声明的默认前缀**
      //    （`@prefix : <…>`），只有它没声明时才回落到 `baseIri`。
      //    修前这里直接 `return baseIri + local` ⇒ 文件写的 `@prefix :` **形同虚设**：
      //    所有 `:Local` 都被解析成 `http://example.org/onto#Local`（硬编码值）。
      //    症状（2026-10-12 探针实测，见 `tests/ontology-engine.test.ts` 的 A45 组）：
      //    `i2q()` 回不到任何前缀 ⇒ 类型名变成 `<完整 IRI>` ⇒ M9 的**裸名查表**失败
      //    ⇒ 对「默认前缀不是那个硬编码值」的文件报**假错**
      //    （`ERR [M9] quantifier references unknown type "X"`）。
      //    ⚠️ 语义顺序：真 Turtle 里 `:X` 由 `:` 前缀展开、`@base` 只管相对 IRI
      //    ⇒ **`@prefix :` 优先于 `@base` 是对的**。
      if (prefix === "") {
        const def = prefixes.get("");
        return def !== undefined ? def + local : baseIri + local;
      }
      const ns = prefixes.get(prefix);
      return ns ? ns + local : `unknown:${tk.value}`;
    }
    return tk.value;
  }

  function parseObject(): { value: string | number | boolean; type: "iri" | "literal" | "blank"; datatype?: string } | null {
    const tk = peek();
    if (tk.kind === "iri") { advance(); return { value: tk.value, type: "iri" }; }
    if (tk.kind === "qname" || tk.kind === "a") { advance(); return { value: resolveIri(tk), type: "iri" }; }
    if (tk.kind === "literal") { advance(); return { value: tk.value, type: "literal", datatype: tk.datatype }; }
    if (tk.kind === "number") { advance(); return { value: tk.value.includes(".") ? parseFloat(tk.value) : parseInt(tk.value, 10), type: "literal", datatype: tk.value.includes(".") ? XSD + "double" : XSD + "integer" }; }
    if (tk.kind === "boolean") { advance(); return { value: tk.value === "true", type: "literal", datatype: XSD + "boolean" }; }
    if (tk.kind === "lbracket") {
      const bnode = nextBnode();
      advance(); // skip [
      while (peek().kind !== "rbracket" && peek().kind !== "eof") {
        const pred = peek();
        if (pred.kind !== "qname" && pred.kind !== "a") { errors.push(`Expected predicate in blank node at ${pred.pos}`); break; }
        advance();
        const obj = parseObject();
        if (!obj) { errors.push(`Expected object in blank node at ${peek().pos}`); break; }
        const objVal = obj.type === "iri" ? obj.value as string : `"${obj.value}"`;
        triples.push({ subject: bnode, predicate: resolveIri(pred), object: obj.value, objectType: obj.type, objectDatatype: obj.datatype });
        if (peek().kind === "semi") advance();
        else if (peek().kind === "dot") { advance(); break; }
        else break;
      }
      if (peek().kind === "dot") advance();
      if (peek().kind === "rbracket") advance();
      else errors.push(`Expected ] at position ${peek().pos}`);
      return { value: bnode, type: "blank" };
    }
    if (tk.kind === "lparen") {
      advance();
      const values: { value: string | number | boolean; type: "iri" | "literal" | "blank"; datatype?: string }[] = [];
      while (peek().kind !== "rparen" && peek().kind !== "eof") {
        // Skip commas between collection items
        if (peek().kind === "comma") { advance(); continue; }
        const obj = parseObject();
        if (obj) values.push(obj);
        else break; // stop on unexpected token
      }
      if (peek().kind === "rparen") advance();
      const lit = values.map(v => v.type === "iri" ? `<${v.value}>` : `"${v.value}"`).join(" ");
      return { value: lit, type: "literal" };
    }
    return null;
  }

  const triples: Triple[] = [];
  let safetyLoop = 0;

  while (peek().kind !== "eof") {
    if (++safetyLoop > 100000) { errors.push("Parser safety limit exceeded"); break; }
    const tk = peek();

    // @prefix name: <IRI> .
    if (tk.kind === "prefix") {
      advance();
      const nameTk = peek();
      if (nameTk.kind !== "qname") { errors.push(`Expected prefix name after @prefix at ${nameTk.pos}`); break; }
      const nameStr = nameTk.value.replace(/:$/, "");
      advance();
      const iriTk = peek();
      if (iriTk.kind !== "iri") { errors.push(`Expected IRI after prefix name at ${iriTk.pos}`); break; }
      advance();
      prefixes.set(nameStr, iriTk.value);
      p2q.set(iriTk.value, nameStr);
      if (peek().kind === "dot") advance();
      continue;
    }

    // @base <IRI> .
    if (tk.kind === "base") {
      advance();
      const iriTk = peek();
      if (iriTk.kind !== "iri") { errors.push(`Expected IRI after @base at ${iriTk.pos}`); break; }
      baseIri = iriTk.value;
      advance();
      if (peek().kind === "dot") advance();
      continue;
    }

    // Subject predicate object [ . | ; | , ]
    let subject = "";
    if (tk.kind === "lbracket") {
      subject = nextBnode();
      advance();
      const subjPred = peek();
      if (subjPred.kind !== "qname" && subjPred.kind !== "a") { errors.push(`Expected predicate in blank node subject at ${subjPred.pos}`); break; }
      advance();
      const subjObj = parseObject();
      if (!subjObj) { errors.push(`Expected object in blank node at ${peek().pos}`); break; }
      triples.push({ subject, predicate: resolveIri(subjPred), object: subjObj.value, objectType: subjObj.type, objectDatatype: subjObj.datatype });
      if (peek().kind === "rbracket") advance();
      else { errors.push(`Expected ] at ${peek().pos}`); break; }
    } else if (tk.kind === "qname" || tk.kind === "iri") {
      subject = resolveIri(tk);
      advance();
    } else {
      errors.push(`Expected subject at position ${tk.pos}, got ${tk.kind}`);
      break;
    }

    // Predicate-object pairs separated by ; or terminated by .
    let subjDone = false;
    let currentPred = "";
    while (!subjDone && peek().kind !== "eof") {
      const pk = peek();
      if (pk.kind === "dot") { advance(); subjDone = true; continue; }
      if (pk.kind === "semi") { advance(); currentPred = ""; continue; }
      if (pk.kind === "comma") {
        advance();
        if (!currentPred) { errors.push(`Comma without preceding predicate at ${pk.pos}`); break; }
        const obj = parseObject();
        if (!obj) { errors.push(`Expected object after comma at ${peek().pos}`); break; }
        triples.push({ subject, predicate: currentPred, object: obj.value, objectType: obj.type, objectDatatype: obj.datatype });
        continue;
      }
      // predicate
      if (pk.kind === "qname" || pk.kind === "a") {
        currentPred = resolveIri(pk);
        advance();
        const obj = parseObject();
        if (!obj) { errors.push(`Expected object after predicate at ${peek().pos}`); break; }
        triples.push({ subject, predicate: currentPred, object: obj.value, objectType: obj.type, objectDatatype: obj.datatype });
        continue;
      }
      if (pk.kind === "rbracket") break;
      errors.push(`Unexpected token ${pk.kind} at ${pk.pos}`);
      break;
    }
  }

  return { prefixes, triples, errors };
}

// ---- Turtle RDF triples → OntologyDefinition ----
function bnodeId(node: string): string {
  return node.startsWith("_:b") ? node : "";
}

function i2q(iri: string, prefixes: Map<string, string>): string {
  // Find the best prefix match
  let best: string | null = null;
  let bestLen = 0;
  for (const [p, ns] of prefixes) {
    if (iri.startsWith(ns) && ns.length > bestLen) {
      best = p;
      bestLen = ns.length;
    }
  }
  if (best !== null) return best + ":" + iri.slice(bestLen);
  // Try standard prefixes
  for (const [p, ns] of Object.entries(STD_PREFIXES)) {
    if (iri.startsWith(ns)) return p + ":" + iri.slice(ns.length);
  }
  return "<" + iri + ">";
}

function stripDefaultPrefix(name: string): string {
  if (name.startsWith(":")) return name.slice(1);
  return name;
}

function turtleToOnto(r: TurtleParseResult): OntologyDefinition {
  const { prefixes, triples, errors } = r;
  const onto: OntologyDefinition = { types: {}, relations: {}, axioms: [] };

  // Group triples by subject
  const subjectMap = new Map<string, Triple[]>();
  for (const t of triples) {
    const list = subjectMap.get(t.subject) || [];
    list.push(t);
    subjectMap.set(t.subject, list);
  }

  // Collect type candidates, property candidates, and bnode mappings first
  const typeIris = new Set<string>();
  const propIris = new Set<string>();
  const ontologyIris = new Set<string>();
  for (const [subj, stmts] of subjectMap) {
    for (const s of stmts) {
      if (s.predicate === RDF + "type") {
        const obj = typeof s.object === "string" ? s.object : "";
        if (obj === OWL + "Class" || obj === RDFS + "Class") typeIris.add(subj);
        else if (obj === OWL + "ObjectProperty" || obj === OWL + "DatatypeProperty" || obj === RDF + "Property") propIris.add(subj);
        else if (obj === OWL + "Ontology") ontologyIris.add(subj);
        else if (obj === OWL + "FunctionalProperty") {
          // marker on existing property
          const pname = stripDefaultPrefix(i2q(subj, prefixes));
          if (!onto.relations![pname]) onto.relations![pname] = {};
          onto.relations![pname].functional = true;
        } else if (obj === OWL + "TransitiveProperty") {
          const pname = stripDefaultPrefix(i2q(subj, prefixes));
          if (!onto.relations![pname]) onto.relations![pname] = {};
          onto.relations![pname].transitive = true;
        } else if (obj === OWL + "SymmetricProperty") {
          const pname = stripDefaultPrefix(i2q(subj, prefixes));
          if (!onto.relations![pname]) onto.relations![pname] = {};
          onto.relations![pname].symmetric = true;
        }
      }
    }
  }

  // Parse ontology-level metadata
  for (const [subj, stmts] of subjectMap) {
    if (ontologyIris.has(subj)) {
      for (const s of stmts) {
        if (s.predicate === SR + "name" || s.predicate === RDFS + "label") onto.name = String(s.object);
        if (s.predicate === OWL + "versionInfo") onto.version = String(s.object);
        if (s.predicate === OWL + "imports") {
          if (!onto.imports) onto.imports = [];
          onto.imports.push(String(s.object));
        }
      }
    }
  }

  // Parse types
  for (const [iri, stmts] of subjectMap) {
    if (!typeIris.has(iri)) continue;
    const name = stripDefaultPrefix(i2q(iri, prefixes));
    const td: TypeDef = {};
    for (const s of stmts) {
      if (s.predicate === RDFS + "subClassOf") td.superTypes = [...(td.superTypes || []), stripDefaultPrefix(i2q(String(s.object), prefixes))];
      if (s.predicate === RDFS + "label" || s.predicate === RDFS + "comment") td.description = String(s.object);
      if (s.predicate === SR + "rigidity") td.rigidity = String(s.object) as TypeDef["rigidity"];
      if (s.predicate === SR + "identity") {
        td.identity = [...(td.identity || []), String(s.object)];
      }
      if (s.predicate === SR + "dependsOn") {
        td.dependsOn = [...(td.dependsOn || []), stripDefaultPrefix(i2q(String(s.object), prefixes))];
      }
    }
    // Parse nested property blank nodes for this type
    for (const s of stmts) {
      if (s.predicate === SR + "property" && s.objectType === "blank") {
        const pnode = String(s.object);
        const pstmts = subjectMap.get(pnode) || [];
        const pdef: PropertyDef = { type: "string" };
        for (const ps of pstmts) {
          if (ps.predicate === SR + "name") { /* stored as key */ }
          if (ps.predicate === SR + "propType" || ps.predicate === RDF + "type") pdef.type = String(ps.object);
          if (ps.predicate === SR + "cardinality") pdef.cardinality = String(ps.object);
          if (ps.predicate === SR + "values") {
            if (ps.objectType === "literal") {
              pdef.values = String(ps.object).split(/\s+/).filter(Boolean);
            }
          }
        }
        const propName = pstmts.find(ps => ps.predicate === SR + "name");
        if (propName && typeof propName.object === "string") {
          if (!td.properties) td.properties = {};
          td.properties[propName.object] = pdef;
        }
      }
    }
    onto.types![name] = td;
  }

  // Parse relations
  for (const [iri, stmts] of subjectMap) {
    if (!propIris.has(iri)) continue;
    const name = stripDefaultPrefix(i2q(iri, prefixes));
    const rd: RelationDef = {};
    for (const s of stmts) {
      if (s.predicate === RDFS + "domain") rd.domain = stripDefaultPrefix(i2q(String(s.object), prefixes));
      if (s.predicate === RDFS + "range") rd.range = stripDefaultPrefix(i2q(String(s.object), prefixes));
      if (s.predicate === SR + "cardinality") rd.cardinality = String(s.object);
      // Functional/Transitive/Symmetric already handled above
    }
    onto.relations![name] = rd;
  }

  // Parse axioms (blank nodes attached to ontology or types)
  for (const [subj, stmts] of subjectMap) {
    for (const s of stmts) {
      if (s.predicate === SR + "axiom" && s.objectType === "blank") {
        const anode = String(s.object);
        const astmts = subjectMap.get(anode) || [];
        const ad: AxiomDef = { rule: "" };
        for (const as_ of astmts) {
          if (as_.predicate === SR + "description" || as_.predicate === RDFS + "label") ad.description = String(as_.object);
          if (as_.predicate === SR + "rule") ad.rule = String(as_.object);
          if (as_.predicate === SR + "axiomType") ad.type = String(as_.object);
        }
        onto.axioms!.push(ad);
      }
    }
  }

  return onto;
}

// ---- OntologyDefinition → Turtle emitter ----
function ontoToTurtle(onto: OntologyDefinition, baseIri: string = "http://example.org/onto#"): string {
  const lines: string[] = [];
  const p = (s: string) => lines.push(s);

  p(`@prefix rdf: <${RDF}> .`);
  p(`@prefix rdfs: <${RDFS}> .`);
  p(`@prefix owl: <${OWL}> .`);
  p(`@prefix xsd: <${XSD}> .`);
  p(`@prefix sr: <${SR}> .`);
  p(`@prefix : <${baseIri}> .`);
  p("");

  // Helper
  function lit(v: string | number | boolean): string {
    if (typeof v === "string") return JSON.stringify(v);
    return String(v);
  }
  function semicolon(i: number, total: number): string {
    return i < total - 1 ? " ;" : " .";
  }
  // Wrap bare names with : prefix if they don't already have a prefix
  function qname(s: string): string {
    if (s.includes(":") || s.startsWith("<") || s.startsWith("_:")) return s;
    return ":" + s;
  }

  // Ontology header
  const headerStmts: string[] = [];
  headerStmts.push("a owl:Ontology");
  if (onto.name) headerStmts.push(`sr:name ${lit(onto.name)}`);
  if (onto.version) headerStmts.push(`owl:versionInfo ${lit(onto.version)}`);
  if (onto.imports && onto.imports.length > 0) {
    for (const imp of onto.imports) headerStmts.push(`owl:imports <${imp}>`);
  }
  for (let i = 0; i < headerStmts.length; i++) {
    if (i === 0) p(`:onto ${headerStmts[i]} ;`);
    else p(`    ${headerStmts[i]}${semicolon(i, headerStmts.length)}`);
  }
  p("");

  // Types
  const types = onto.types || {};
  for (const [name, td] of Object.entries(types)) {
    const stmts: string[] = [];
    stmts.push("a owl:Class");
    if (td.description) stmts.push(`rdfs:label ${lit(td.description)}`);
    if (td.superTypes) {
      for (const st of td.superTypes) stmts.push(`rdfs:subClassOf ${qname(st)}`);
    }
    if (td.rigidity) stmts.push(`sr:rigidity ${lit(td.rigidity)}`);
    if (td.identity) {
      for (const id of td.identity) stmts.push(`sr:identity ${qname(id)}`);
    }
    if (td.dependsOn) {
      for (const dep of td.dependsOn) stmts.push(`sr:dependsOn ${qname(dep)}`);
    }
    if (td.properties) {
      for (const [pname, pd] of Object.entries(td.properties)) {
        const pstmts: string[] = [];
        pstmts.push(`sr:name ${lit(pname)}`);
        pstmts.push(`sr:propType ${lit(pd.type)}`);
        if (pd.cardinality) pstmts.push(`sr:cardinality ${lit(pd.cardinality)}`);
        if (pd.values && pd.values.length > 0) pstmts.push(`sr:values (${pd.values.map(lit).join(" ")})`);
        stmts.push(`sr:property [\n      ${pstmts.join(" ;\n      ")}\n    ]`);
      }
    }
    if (td.axioms) {
      for (const ax of td.axioms) {
        const astmts: string[] = [];
        astmts.push(`sr:rule ${lit(ax)}`);
        stmts.push(`sr:axiom [\n      ${astmts.join(" ;\n      ")}\n    ]`);
      }
    }
    for (let i = 0; i < stmts.length; i++) {
      if (i === 0) p(`:${name} ${stmts[i]} ;`);
      else p(`    ${stmts[i]}${semicolon(i, stmts.length)}`);
    }
    p("");
  }

  // Relations
  const relations = onto.relations || {};
  for (const [name, rd] of Object.entries(relations)) {
    const stmts: string[] = [];
    const flags: string[] = [];
    stmts.push("a owl:ObjectProperty");
    if (rd.functional) flags.push("owl:FunctionalProperty");
    if (rd.transitive) flags.push("owl:TransitiveProperty");
    if (rd.symmetric) flags.push("owl:SymmetricProperty");
    if (flags.length > 0) stmts.push(`a ${flags.join(", ")}`);
    if (rd.domain) stmts.push(`rdfs:domain ${qname(rd.domain)}`);
    if (rd.range) stmts.push(`rdfs:range ${qname(rd.range)}`);
    if (rd.cardinality) stmts.push(`sr:cardinality ${lit(rd.cardinality)}`);
    for (let i = 0; i < stmts.length; i++) {
      if (i === 0) p(`:${name} ${stmts[i]} ;`);
      else p(`    ${stmts[i]}${semicolon(i, stmts.length)}`);
    }
    p("");
  }

  // Axioms
  const axioms = onto.axioms || [];
  for (const ax of axioms) {
    const astmts: string[] = [];
    if (ax.description) astmts.push(`sr:description ${lit(ax.description)}`);
    astmts.push(`sr:rule ${lit(ax.rule)}`);
    if (ax.type) astmts.push(`sr:axiomType ${lit(ax.type)}`);
    p(`:onto sr:axiom [`);
    for (let i = 0; i < astmts.length; i++) {
      // Never emit . inside blank nodes — the outer " ] ." handles termination
      p(`    ${astmts[i]}${i < astmts.length - 1 ? " ;" : ""}`);
    }
    p(`  ] .\n`);
  }

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════
// Axiom Expression Language (AEL) — Lexer + Parser
// ═══════════════════════════════════════════════════════════════════

type TokenKind =
  | "ident" | "number" | "string" | "boolean" | "null" | "dot"
  | "lparen" | "rparen" | "comma" | "colon"
  | "gt" | "gte" | "lt" | "lte" | "eq" | "neq"
  | "and" | "or" | "not" | "implies"
  | "exists" | "forall" | "in"
  | "plus" | "minus"
  | "eof";

interface Token {
  kind: TokenKind;
  value: string;
  pos: number;
}

interface ParseError {
  message: string;
  pos: number;
}

const KEYWORDS: Record<string, TokenKind> = {
  "and": "and", "or": "or", "not": "not", "implies": "implies",
  "exists": "exists", "forall": "forall", "in": "in",
  "true": "boolean", "false": "boolean", "null": "null",
};

function tokenize(input: string): { tokens: Token[]; errors: ParseError[] } {
  const tokens: Token[] = [];
  const errors: ParseError[] = [];
  let i = 0;

  function advance(n: number): void { i += n; }
  function pos(): number { return i; }

  while (i < input.length) {
    const ch = input[i]!;

    // whitespace
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      advance(1);
      continue;
    }

    // single-quoted string
    if (ch === "'") {
      const start = pos();
      advance(1);
      let val = "";
      while (i < input.length && input[i] !== "'") {
        val += input[i];
        advance(1);
      }
      if (i >= input.length) {
        errors.push({ message: "Unterminated string literal", pos: start });
      } else {
        advance(1); // closing quote
      }
      tokens.push({ kind: "string", value: val, pos: start });
      continue;
    }

    // number
    if (/[0-9]/.test(ch)) {
      const start = pos();
      let num = "";
      while (i < input.length && /[0-9]/.test(input[i]!)) {
        num += input[i];
        advance(1);
      }
      if (i < input.length && input[i] === "." && i + 1 < input.length && /[0-9]/.test(input[i + 1]!)) {
        num += ".";
        advance(1);
        while (i < input.length && /[0-9]/.test(input[i]!)) {
          num += input[i];
          advance(1);
        }
      }
      tokens.push({ kind: "number", value: num, pos: start });
      continue;
    }

    // identifiers and keywords
    if (/[a-zA-Z_]/.test(ch)) {
      const start = pos();
      let ident = "";
      while (i < input.length && /[a-zA-Z0-9_]/.test(input[i]!)) {
        ident += input[i];
        advance(1);
      }
      const kw = KEYWORDS[ident];
      tokens.push({ kind: kw || "ident", value: ident, pos: start });
      continue;
    }

    // multi-character operators
    if (ch === ">" || ch === "<" || ch === "=" || ch === "!") {
      const start = pos();
      const op = input.slice(i, i + 2);
      if (op === ">=") { tokens.push({ kind: "gte", value: ">=", pos: start }); advance(2); }
      else if (op === "<=") { tokens.push({ kind: "lte", value: "<=", pos: start }); advance(2); }
      else if (op === "==") { tokens.push({ kind: "eq", value: "==", pos: start }); advance(2); }
      else if (op === "!=") { tokens.push({ kind: "neq", value: "!=", pos: start }); advance(2); }
      else if (ch === ">") { tokens.push({ kind: "gt", value: ">", pos: start }); advance(1); }
      else if (ch === "<") { tokens.push({ kind: "lt", value: "<", pos: start }); advance(1); }
      else {
        errors.push({ message: `Unexpected character: ${ch}`, pos: start });
        advance(1);
      }
      continue;
    }

    // single-character tokens
    switch (ch) {
      case "(": tokens.push({ kind: "lparen", value: "(", pos: pos() }); advance(1); break;
      case ")": tokens.push({ kind: "rparen", value: ")", pos: pos() }); advance(1); break;
      case ",": tokens.push({ kind: "comma", value: ",", pos: pos() }); advance(1); break;
      case ":": tokens.push({ kind: "colon", value: ":", pos: pos() }); advance(1); break;
      case ".": tokens.push({ kind: "dot", value: ".", pos: pos() }); advance(1); break;
      case "+": tokens.push({ kind: "plus", value: "+", pos: pos() }); advance(1); break;
      case "-": tokens.push({ kind: "minus", value: "-", pos: pos() }); advance(1); break;
      default:
        errors.push({ message: `Unexpected character: ${ch}`, pos: pos() });
        advance(1);
    }
  }

  tokens.push({ kind: "eof", value: "", pos: i });
  return { tokens, errors };
}

// AST types
type ExprNode =
  | PropAccessNode
  | LiteralNode
  | FuncCallNode
  | QuantifierNode
  | BinaryOpNode
  | UnaryOpNode
  | ImplicationNode
  | ParensNode;

interface PropAccessNode { kind: "propAccess"; path: string[]; pos: number }
interface LiteralNode { kind: "literal"; value: string | number | boolean | null; raw: string; pos: number }
interface FuncCallNode { kind: "funcCall"; name: string; args: ExprNode[]; pos: number }
interface QuantifierNode { kind: "quantifier"; quant: "exists" | "forall"; variable: string; typeName: string; body: ExprNode; pos: number }
interface BinaryOpNode { kind: "binaryOp"; op: string; left: ExprNode; right: ExprNode; pos: number }
interface UnaryOpNode { kind: "unaryOp"; op: "not" | "minus"; operand: ExprNode; pos: number }
interface ImplicationNode { kind: "implication"; antecedent: ExprNode; consequent: ExprNode; pos: number }
interface ParensNode { kind: "parens"; expr: ExprNode; pos: number }

interface ParseResult {
  ast: ExprNode | null;
  errors: ParseError[];
}

class AxiomParser {
  private tokens: Token[];
  private idx: number;
  public errors: ParseError[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
    this.idx = 0;
    this.errors = [];
  }

  private current(): Token { return this.tokens[this.idx]!; }
  private advance(): Token { return this.tokens[this.idx++]!; }

  private expect(kind: TokenKind, msg: string): Token | null {
    if (this.current().kind === kind) {
      return this.advance();
    }
    this.errors.push({ message: msg, pos: this.current().pos });
    return null;
  }

  parse(): ParseResult {
    const ast = this.parseExpr();
    return { ast: this.errors.length === 0 ? ast : null, errors: this.errors };
  }

  // expr ::= implication
  private parseExpr(): ExprNode {
    return this.parseImplication();
  }

  // implication ::= or_expr ('implies' or_expr)?
  private parseImplication(): ExprNode {
    const left = this.parseLogicalOr();
    if (this.current().kind === "implies") {
      const pos = this.current().pos;
      this.advance();
      const right = this.parseLogicalOr();
      return { kind: "implication", antecedent: left, consequent: right, pos };
    }
    return left;
  }

  // or_expr ::= and_expr ('or' and_expr)*
  private parseLogicalOr(): ExprNode {
    let left = this.parseLogicalAnd();
    while (this.current().kind === "or") {
      const pos = this.current().pos;
      this.advance();
      const right = this.parseLogicalAnd();
      left = { kind: "binaryOp", op: "or", left, right, pos };
    }
    return left;
  }

  // and_expr ::= not_expr ('and' not_expr)*
  private parseLogicalAnd(): ExprNode {
    let left = this.parseUnary();
    while (this.current().kind === "and") {
      const pos = this.current().pos;
      this.advance();
      const right = this.parseUnary();
      left = { kind: "binaryOp", op: "and", left, right, pos };
    }
    return left;
  }

  // unary ::= 'not' unary | comparison
  private parseUnary(): ExprNode {
    if (this.current().kind === "not") {
      const pos = this.current().pos;
      this.advance();
      const operand = this.parseUnary();
      return { kind: "unaryOp", op: "not", operand, pos };
    }
    return this.parseComparison();
  }

  // comparison ::= additive (cmp_op additive)?
  private parseComparison(): ExprNode {
    const left = this.parseAdditive();
    const cmpKinds: TokenKind[] = ["gt", "gte", "lt", "lte", "eq", "neq", "in"];
    if (cmpKinds.includes(this.current().kind)) {
      const pos = this.current().pos;
      let op = this.advance().value;
      // "not in" — check for "not in" sequence
      if (op === "in" && this.tokens[this.idx - 2]?.kind === "not") {
        op = "not in";
      }
      const right = this.parseAdditive();
      return { kind: "binaryOp", op, left, right, pos };
    }
    return left;
  }

  // additive ::= primary (('+' | '-') primary)*
  private parseAdditive(): ExprNode {
    let left = this.parsePrimary();
    while (this.current().kind === "plus" || this.current().kind === "minus") {
      const pos = this.current().pos;
      const op = this.advance().value;
      const right = this.parsePrimary();
      left = { kind: "binaryOp", op, left, right, pos };
    }
    return left;
  }

  // primary ::= prop_access | literal | function_call | '(' expr ')' | quantifier
  private parsePrimary(): ExprNode {
    const tok = this.current();

    // '(' expr ')'
    if (tok.kind === "lparen") {
      const pos = tok.pos;
      this.advance();
      const expr = this.parseExpr();
      this.expect("rparen", "Expected ')' after expression");
      return { kind: "parens", expr, pos };
    }

    // quantifier: exists/forall ident in ident : expr
    if (tok.kind === "exists" || tok.kind === "forall") {
      const pos = tok.pos;
      const quant = tok.kind as "exists" | "forall";
      this.advance();
      const varTok = this.expect("ident", "Expected variable after " + quant);
      if (!varTok) return { kind: "literal", value: null, raw: "null", pos };
      this.expect("in", "Expected 'in' after variable");
      const typeTok = this.expect("ident", "Expected type after 'in'");
      if (!typeTok) return { kind: "literal", value: null, raw: "null", pos };
      this.expect("colon", "Expected ':' after type in quantifier");
      const body = this.parseExpr();
      return { kind: "quantifier", quant, variable: varTok.value, typeName: typeTok.value, body, pos };
    }

    // function_call: IDENT '(' arg_list? ')'
    if (tok.kind === "ident" && this.tokens[this.idx + 1]?.kind === "lparen") {
      const pos = tok.pos;
      const name = this.advance().value;
      this.advance(); // '('
      const args: ExprNode[] = [];
      if (this.current().kind !== "rparen") {
        args.push(this.parseExpr());
        while (this.current().kind === "comma") {
          this.advance();
          args.push(this.parseExpr());
        }
      }
      this.expect("rparen", `Expected ')' after args of ${name}`);
      return { kind: "funcCall", name, args, pos };
    }

    // prop_access: IDENT ('.' IDENT)*
    if (tok.kind === "ident") {
      const pos = tok.pos;
      const path: string[] = [this.advance().value];
      while (this.current().kind === "dot") {
        this.advance(); // consume '.'
        const next = this.expect("ident", "Expected identifier after '.'");
        if (next) path.push(next.value);
      }
      return { kind: "propAccess", path, pos };
    }

    // literal: number | string | boolean | null
    if (tok.kind === "number") {
      const pos = tok.pos;
      const raw = tok.value;
      this.advance();
      return { kind: "literal", value: raw.includes(".") ? parseFloat(raw) : parseInt(raw, 10), raw, pos };
    }
    if (tok.kind === "string") {
      const pos = tok.pos;
      const val = tok.value;
      this.advance();
      return { kind: "literal", value: val, raw: "'" + val + "'", pos };
    }
    if (tok.kind === "boolean") {
      const pos = tok.pos;
      const val = tok.value === "true";
      this.advance();
      return { kind: "literal", value: val, raw: tok.value, pos };
    }
    if (tok.kind === "null") {
      const pos = tok.pos;
      this.advance();
      return { kind: "literal", value: null, raw: "null", pos };
    }

    this.errors.push({ message: `Unexpected token: ${tok.value}`, pos: tok.pos });
    return { kind: "literal", value: null, raw: "null", pos: tok.pos };
  }
}

interface AxiomValidationResult {
  valid: boolean;
  ast: ExprNode | null;
  errors: ParseError[];
  resolvedRefs: ResolvedRef[];
}

interface ResolvedRef {
  kind: "type" | "relation" | "property" | "unknown";
  name: string;
  path: string[];
  pos: number;
}

function collectRefs(node: ExprNode | null, boundVars: Set<string> = new Set()): ResolvedRef[] {
  if (!node) return [];
  const refs: ResolvedRef[] = [];
  function walk(n: ExprNode, bv: Set<string>): void {
    switch (n.kind) {
      case "propAccess": {
        if (n.path.length >= 1) {
          const first = n.path[0]!;
          // Skip if first segment is a bound variable (e.g. 'e' in 'e.h_op')
          if (bv.has(first)) break;
          refs.push({ kind: "property", name: n.path.join("."), path: n.path, pos: n.pos });
        }
        break;
      }
      case "funcCall":
        if (!bv.has(n.name)) {
          refs.push({ kind: "unknown", name: n.name, path: [n.name], pos: n.pos });
        }
        n.args.forEach((a) => walk(a, bv));
        break;
      case "quantifier": {
        refs.push({ kind: "type", name: n.typeName, path: [n.typeName], pos: n.pos });
        const inner = new Set(bv);
        inner.add(n.variable);
        walk(n.body, inner);
        break;
      }
      case "binaryOp":
        walk(n.left, bv);
        walk(n.right, bv);
        break;
      case "unaryOp":
        walk(n.operand, bv);
        break;
      case "implication":
        walk(n.antecedent, bv);
        walk(n.consequent, bv);
        break;
      case "parens":
        walk(n.expr, bv);
        break;
      case "literal":
        break;
    }
  }
  walk(node, boundVars);
  return refs;
}

// ═══════════════════════════════════════════════════════════════════
// Ontology load & validation
// ═══════════════════════════════════════════════════════════════════

function findSerenityRoot(): string {
  // 改写 ③：ACC 侧由调用方给定容器根（插件装在宿主 profile 下，沿 __dirname 上溯是错的）
  if (ROOT !== undefined) return ROOT;
  let dir = resolve(__dirname, "..", "..", "..");
  const maxDepth = 20;
  for (let i = 0; i < maxDepth; i++) {
    const marker = resolve(dir, ".opencode", "skills", TOP_SKILL, "SKILL.md");
    if (existsSync(marker)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new MsmError(
    "HOME_ROOT_NOT_FOUND",
    "system",
    "Cannot locate serenity root",
    { startDir: __dirname, topSkill: TOP_SKILL },
    "Pass the container root via runOntologyCli(argv, { cwd }) — or run from inside the container workspace",
  );
}

function loadOntoFile(filePath: string): { onto: OntologyDefinition; raw: string } {
  const absPath = resolve(BASE, filePath);
  if (!existsSync(absPath)) {
    throw new MsmError(
      "ONTO_FILE_NOT_FOUND",
      "system",
      `Ontology file not found: ${absPath}`,
      { path: absPath },
      "Check the file path",
    );
  }
  let raw: string;
  try {
    raw = readFileSync(absPath, "utf-8");
  } catch (err) {
    throw new MsmError(
      "ONTO_PARSE_ERROR",
      "system",
      `Failed to read file: ${absPath}`,
      { path: absPath },
      undefined,
      err,
    );
  }
  const result = parseTurtle(raw);
  if (result.errors.length > 0) {
    throw new MsmError(
      "ONTO_PARSE_ERROR",
      "system",
      `Failed to parse Turtle: ${absPath}\n  ${result.errors.join("\n  ")}`,
      { path: absPath, errors: result.errors },
      "Check Turtle syntax",
    );
  }
  const onto = turtleToOnto(result);
  return { onto, raw };
}

function loadOntoFileWithImports(
  filePath: string,
  visited: Set<string> = new Set(),
): OntologyDefinition {
  const absPath = resolve(BASE, filePath);
  if (visited.has(absPath)) {
    throw new MsmError(
      "ONTO_VALIDATION_FAILED",
      "user",
      `Circular import detected: ${absPath}`,
      { path: absPath, chain: [...visited, absPath] },
      "Remove the circular dependency in imports",
    );
  }
  visited.add(absPath);

  const { onto: local } = loadOntoFile(absPath);
  const baseDir = dirname(absPath);
  const merged = local.imports && local.imports.length > 0
    ? deepMergeOntoList(local.imports.map((imp) => {
        const impPath = resolve(baseDir, imp);
        return loadOntoFileWithImports(impPath, new Set(visited));
      }))
    : emptyOnto();

  return deepMergeOnto(merged, local);
}

function emptyOnto(): OntologyDefinition {
  return { types: {}, relations: {}, axioms: [], imports: [] };
}

function deepMergeOnto(base: OntologyDefinition, overlay: OntologyDefinition): OntologyDefinition {
  return {
    name: overlay.name !== undefined ? overlay.name : base.name,
    version: overlay.version !== undefined ? overlay.version : base.version,
    imports: [...(base.imports || []), ...(overlay.imports || [])],
    types: { ...(base.types || {}), ...(overlay.types || {}) },
    relations: { ...(base.relations || {}), ...(overlay.relations || {}) },
    axioms: [...(base.axioms || []), ...(overlay.axioms || [])],
  };
}

function deepMergeOntoList(ontos: OntologyDefinition[]): OntologyDefinition {
  return ontos.reduce((acc, o) => deepMergeOnto(acc, o), emptyOnto());
}

// M1-M9 validation checks
interface CheckIssue {
  check: string;
  severity: "error" | "warning";
  message: string;
}

function validateOnto(onto: OntologyDefinition, level: "normal" | "strict"): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const types = onto.types || {};
  const relations = onto.relations || {};
  const axioms = onto.axioms || [];
  const typeNames = new Set(Object.keys(types));
  const relNames = new Set(Object.keys(relations));

  // M1: Referential Integrity
  for (const [name, td] of Object.entries(types)) {
    for (const st of td.superTypes || []) {
      if (!typeNames.has(st)) {
        issues.push({
          check: "M1", severity: "error",
          message: `Type "${name}" superType "${st}" does not exist`,
        });
      }
    }
    for (const dep of td.dependsOn || []) {
      if (!typeNames.has(dep)) {
        issues.push({
          check: "M1", severity: "error",
          message: `Type "${name}" dependsOn "${dep}" which does not exist`,
        });
      }
    }
  }
  for (const [name, rd] of Object.entries(relations)) {
    if (rd.domain && !typeNames.has(rd.domain)) {
      issues.push({
        check: "M1", severity: "error",
        message: `Relation "${name}" domain "${rd.domain}" does not exist`,
      });
    }
    if (rd.range && !typeNames.has(rd.range)) {
      issues.push({
        check: "M1", severity: "error",
        message: `Relation "${name}" range "${rd.range}" does not exist`,
      });
    }
  }

  // M2: Taxonomy Acyclicity
  function detectCycle(typeName: string, visiting: Set<string> = new Set()): boolean {
    if (visiting.has(typeName)) return true;
    visiting.add(typeName);
    const td = types[typeName];
    if (td?.superTypes) {
      for (const st of td.superTypes) {
        if (typeNames.has(st) && detectCycle(st, new Set(visiting))) return true;
      }
    }
    return false;
  }
  for (const tn of typeNames) {
    if (detectCycle(tn)) {
      issues.push({
        check: "M2", severity: "error",
        message: `Inheritance cycle detected involving type "${tn}"`,
      });
      break;
    }
  }

  // M3: Rigidity Inheritance (child cannot be MORE rigid than parent)
  // rigid > anti-rigid > semi-rigid (rigid = strongest constraint)
  for (const [name, td] of Object.entries(types)) {
    if (td.superTypes && td.rigidity) {
      for (const st of td.superTypes) {
        const parent = types[st];
        if (parent?.rigidity) {
          // Child must not be rigid when parent is anti-rigid or semi-rigid
          if (td.rigidity === "rigid" && parent.rigidity !== "rigid") {
            issues.push({
              check: "M3", severity: "error",
              message: `Type "${name}" is rigid but parent "${st}" is ${parent.rigidity} — child cannot be more rigid than parent`,
            });
          }
        }
      }
    }
  }

  // M4: Identity Presence — all rigid types must have identity (own or inherited)
  function getIdentity(typeName: string): string[] | undefined {
    const td = types[typeName];
    if (!td) return undefined;
    if (td.identity && td.identity.length > 0) return td.identity;
    // Inherit from parent
    if (td.superTypes) {
      for (const st of td.superTypes) {
        const inherited = typeNames.has(st) ? getIdentity(st) : undefined;
        if (inherited) return inherited;
      }
    }
    return undefined;
  }
  for (const [name, td] of Object.entries(types)) {
    if (td.rigidity === "rigid") {
      const id = getIdentity(name);
      if (!id || id.length === 0) {
        issues.push({
          check: "M4", severity: "warning",
          message: `Type "${name}" is rigid but has no identity criteria (own or inherited)`,
        });
      }
    }
  }

  // M5: Dependency Acyclicity
  function detectDepCycle(typeName: string, visiting: Set<string> = new Set()): boolean {
    if (visiting.has(typeName)) return true;
    visiting.add(typeName);
    const td = types[typeName];
    if (td?.dependsOn) {
      for (const dep of td.dependsOn) {
        if (typeNames.has(dep) && detectDepCycle(dep, new Set(visiting))) return true;
      }
    }
    return false;
  }
  for (const tn of typeNames) {
    if (detectDepCycle(tn)) {
      issues.push({
        check: "M5", severity: "error",
        message: `Dependency cycle detected involving type "${tn}"`,
      });
      break;
    }
  }

  // M6: Cardinality Consistency
  for (const [name, rd] of Object.entries(relations)) {
    if (rd.functional) {
      const card = rd.cardinality || "";
      // Check if cardinality explicitly allows multiple values
      const allowsMultiple =
        // "min N" where N >= 2
        /min\s+(\d+)/.test(card) && parseInt(card.match(/min\s+(\d+)/)![1]!, 10) >= 2 ||
        // starts with 2-9 (e.g. "2..*")
        /^[2-9]/.test(card) ||
        // range like "1..N" where N >= 2 or "*"
        /\.\.\*/.test(card) ||
        /\.\.[2-9]/.test(card);
      if (allowsMultiple) {
        issues.push({
          check: "M6", severity: "error",
          message: `Relation "${name}" is functional but cardinality "${card}" allows multiple values`,
        });
      }
    }
  }

  // M7: Enum Coverage
  for (const [typeName, td] of Object.entries(types)) {
    if (td.properties) {
      for (const [propName, pd] of Object.entries(td.properties)) {
        if (pd.type === "enum" && (!pd.values || pd.values.length === 0)) {
          issues.push({
            check: "M7", severity: "error",
            message: `Type "${typeName}" property "${propName}" is enum but has no values`,
          });
        }
      }
    }
  }

  // M8: Axiom Syntax
  for (let i = 0; i < axioms.length; i++) {
    const ax = axioms[i]!;
    if (!ax.rule || ax.rule.trim() === "") continue;
    const { errors: parseErrors } = tokenize(ax.rule);
    if (parseErrors.length > 0) {
      issues.push({
        check: "M8", severity: "error",
        message: `Axiom #${i + 1} tokenization error: ${parseErrors[0]!.message}`,
      });
      continue;
    }
    const { tokens } = tokenize(ax.rule);
    const parser = new AxiomParser(tokens);
    const result = parser.parse();
    if (parser.errors.length > 0 || !result.ast) {
      for (const e of parser.errors) {
        issues.push({
          check: "M8", severity: "error",
          message: `Axiom #${i + 1} parse error at pos ${e.pos}: ${e.message}`,
        });
      }
    }
  }

  // M9: Axiom Reference Check
  for (let i = 0; i < axioms.length; i++) {
    const ax = axioms[i]!;
    if (!ax.rule || ax.rule.trim() === "") continue;
    const { tokens } = tokenize(ax.rule);
    const parser = new AxiomParser(tokens);
    const result = parser.parse();
    if (!result.ast || parser.errors.length > 0) continue;

    const refs = collectRefs(result.ast);
    for (const ref of refs) {
      const name = ref.path[0];
      // Only flag multi-segment paths (Type.prop) or quantifier types
      if (ref.kind === "property" && ref.path.length >= 2) {
        if (name && !typeNames.has(name) && !relNames.has(name)) {
          issues.push({
            check: "M9", severity: "warning",
            message: `Axiom #${i + 1} references unknown type "${name}" in "${ref.path.join(".")}"`,
          });
        }
      }
      if (ref.kind === "type") {
        if (name && !typeNames.has(name)) {
          issues.push({
            check: "M9", severity: "error",
            message: `Axiom #${i + 1} quantifier references unknown type "${name}"`,
          });
        }
      }
      if (ref.kind === "unknown") {
        if (name && !typeNames.has(name) && !relNames.has(name)) {
          // Function calls like occupies(...) might be relation names
        }
      }
    }
  }

  return issues;
}

// ═══════════════════════════════════════════════════════════════════
// subcommand: init
// ═══════════════════════════════════════════════════════════════════

const HOSPITAL_TEMPLATE = ontoToTurtle({
  name: "hospital-domain",
  version: "0.1.0",
  types: {
    Person: { description: "A human being", rigidity: "rigid", identity: ["nhsNumber"], properties: { nhsNumber: { type: "string", cardinality: "exactly 1" }, name: { type: "string", cardinality: "exactly 1" }, dateOfBirth: { type: "date", cardinality: "exactly 1" } } },
    Patient: { superTypes: ["Person"], rigidity: "anti-rigid", dependsOn: ["Admission"], properties: { status: { type: "enum", values: ["admitted", "under_treatment", "discharged", "closed"], cardinality: "exactly 1" } } },
    Ward: { description: "A physical location housing beds", rigidity: "rigid", identity: ["wardCode"], properties: { wardCode: { type: "string", cardinality: "exactly 1" }, bedCapacity: { type: "integer", cardinality: "exactly 1" }, status: { type: "enum", values: ["open", "full", "closed"], cardinality: "exactly 1" } } },
    Bed: { description: "A bed within a ward", rigidity: "rigid", identity: ["ward", "bedNumber"], properties: { bedNumber: { type: "integer", cardinality: "exactly 1" } } },
    Admission: { description: "An event of a Patient being admitted", rigidity: "rigid", properties: { admissionDate: { type: "datetime", cardinality: "exactly 1" }, dischargeDate: { type: "datetime", cardinality: "max 1" } } },
  },
  relations: {
    admittedTo: { domain: "Patient", range: "Ward", cardinality: "exactly 1", functional: true },
    admittedAs: { domain: "Admission", range: "Patient", cardinality: "exactly 1", functional: true },
    contains: { domain: "Ward", range: "Bed", cardinality: "min 0" },
    occupies: { domain: "Patient", range: "Bed", cardinality: "max 1" },
  },
  axioms: [
    { description: "Discharge date must be after admission date", rule: "Admission.dischargeDate > Admission.admissionDate", type: "temporal" },
    { description: "Only admitted patients can occupy a bed", rule: "occupies(patient, bed) implies admittedTo(patient, ward) and contains(ward, bed)", type: "dependency" },
    { description: "Closed ward has no patients", rule: "Ward.status == 'closed' implies not exists p in Patient: admittedTo(p, ward)", type: "state" },
  ],
});

const MINIMAL_TEMPLATE = ontoToTurtle({
  name: "example-domain",
  version: "0.1.0",
  types: { Thing: { description: "A generic entity", rigidity: "rigid", identity: ["name"], properties: { name: { type: "string", cardinality: "exactly 1" } } } },
  relations: {},
  axioms: [],
});

function cmdInit(args: string[]): void {
  if (args.length === 0) {
    throw new MsmError(
      "PARAMETER_MISSING",
      "user",
      "init requires a file path",
      { validArgs: ["<path>"] },
      "Usage: ontology init <path> [--template minimal|full]",
    );
  }

  let filePath = resolve(BASE, args[0]!);
  if (!filePath.endsWith(".ttl")) {
    filePath += ".ttl";
  }
  let template = "full";

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--template" && i + 1 < args.length) {
      template = args[i + 1]!;
      i++;
    } else if (args[i]!.startsWith("--template=")) {
      template = args[i]!.slice("--template=".length);
    } else if (args[i]!.startsWith("-")) {
      throw new MsmError(
        "PARAMETER_INVALID_VALUE",
        "user",
        `Unknown flag: ${args[i]}`,
        { flag: args[i], validFlags: ["--template <minimal|full>"] },
        "Usage: ontology init <path> [--template minimal|full]",
      );
    }
  }

  if (template !== "minimal" && template !== "full") {
    throw new MsmError(
      "PARAMETER_INVALID_VALUE",
      "user",
      `Unknown template: ${template}`,
      { template, valid: ["minimal", "full"] },
      "Use --template minimal or --template full",
    );
  }

  const content = template === "minimal" ? MINIMAL_TEMPLATE : HOSPITAL_TEMPLATE;

  if (existsSync(filePath)) {
    throw new MsmError(
      "PARAMETER_INVALID_VALUE",
      "user",
      `File already exists: ${filePath}`,
      { path: filePath },
      "Use a different path or remove the existing file",
    );
  }

  try {
    writeFileSync(filePath, content, "utf-8");
  } catch (err) {
    throw new MsmError(
      "ONTO_PARSE_ERROR",
      "system",
      `Failed to write file: ${filePath}`,
      { path: filePath },
      undefined,
      err,
    );
  }

  emit(`Ontology template created at: ${filePath}\n`);
  emit(`Template: ${template}\n`);
}

// ═══════════════════════════════════════════════════════════════════
// subcommand: check
// ═══════════════════════════════════════════════════════════════════

function cmdCheck(args: string[]): void {
  if (args.length === 0) {
    throw new MsmError(
      "PARAMETER_MISSING",
      "user",
      "check requires a file path",
      { validArgs: ["<path>"] },
      "Usage: ontology check <path> [--level normal|strict]",
    );
  }

  const filePath = args[0]!;
  let level: "normal" | "strict" = "normal";
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--level" && i + 1 < args.length) {
      const v = args[i + 1];
      if (v !== "normal" && v !== "strict") {
        throw new MsmError(
          "PARAMETER_INVALID_VALUE",
          "user",
          `Unknown level: ${v}`,
          { level: v, valid: ["normal", "strict"] },
          "Use --level normal or --level strict",
        );
      }
      level = v;
      i++;
    } else if (args[i]!.startsWith("--level=")) {
      const v = args[i]!.slice("--level=".length);
      if (v !== "normal" && v !== "strict") {
        throw new MsmError(
          "PARAMETER_INVALID_VALUE",
          "user",
          `Unknown level: ${v}`,
          { level: v, valid: ["normal", "strict"] },
          "Use --level normal or --level strict",
        );
      }
      level = v;
    } else if (args[i]!.startsWith("-")) {
      throw new MsmError(
        "PARAMETER_INVALID_VALUE",
        "user",
        `Unknown flag: ${args[i]}`,
        { flag: args[i], validFlags: ["--level <normal|strict>"] },
        "Usage: ontology check <path> [--level normal|strict]",
      );
    }
  }

  let onto: OntologyDefinition;
  let issues: CheckIssue[] = [];

  try {
    onto = loadOntoFileWithImports(filePath);
  } catch (err) {
    if (err instanceof MsmError && err.code === "ONTO_VALIDATION_FAILED" && err.message.startsWith("Circular import")) {
      // Circular import — report and throw
      throw err;
    }
    // M10: import file error
    issues.push({
      check: "M10", severity: "error",
      message: err instanceof MsmError ? err.message : String(err),
    });
    // Fall back to loading just this file (no imports)
    onto = loadOntoFile(filePath).onto;
  }

  issues = [...issues, ...validateOnto(onto, level)];

  emit(`\nOntology Validation: ${onto.name || filePath}\n`);
  emit("=".repeat(60) + "\n");

  if (issues.length === 0) {
    emit("All checks passed.\n");
    return;
  }

  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");

  emit(`\nErrors: ${errors.length}, Warnings: ${warnings.length}\n\n`);

  for (const issue of issues) {
    const icon = issue.severity === "error" ? "ERR" : "WRN";
    emit(`  ${icon} [${issue.check}] ${issue.message}\n`);
  }

  if (level === "strict") {
    emit(`\n── Strict mode — LLM review suggestions ──\n`);
    emit(`  (Run through LLM for L1-L5 semantic checks)\n`);
    printLlmReviewHints(onto, issues);
  }

  if (errors.length > 0) {
    throw new MsmError(
      "ONTO_VALIDATION_FAILED",
      "user",
      `Validation failed: ${errors.length} error(s), ${warnings.length} warning(s)`,
      { errors: errors.length, warnings: warnings.length },
      "Fix the errors listed above and re-run check",
    );
  }
}

function printLlmReviewHints(onto: OntologyDefinition, issues: CheckIssue[]): void {
  const types = onto.types || {};

  // L1: Rigidity review hints
  for (const [name, td] of Object.entries(types)) {
    if (!td.rigidity) {
      emit(`  [L1] Type "${name}" has no rigidity label — should it be rigid or anti-rigid?\n`);
    }
  }

  // L2: Missing constraints detection
  emit(`  [L2] Review axioms for domain completeness — are there missing temporal or state constraints?\n`);

  // L3: Identity adequacy
  for (const [name, td] of Object.entries(types)) {
    if (td.rigidity === "rigid" && td.identity && td.identity.length === 1) {
      emit(`  [L3] Type "${name}" identity: ${td.identity.join(", ")} — is this sufficient for uniqueness?\n`);
    }
  }

  // L4: Type semantics
  const typeNames = Object.keys(types);
  if (typeNames.length > 0) {
    emit(`  [L4] Review types: ${typeNames.join(", ")} — are there missing distinctions?\n`);
  }

  // L5: Missing types in axioms
  const axiomDescription = (onto.axioms || []).map((a) => a.description || a.rule).join("; ");
  if (axiomDescription) {
    emit(`  [L5] Axioms reference concepts — review if all referenced entities are defined\n`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// subcommand: explain (Semi-Mech — outputs structured data for LLM)
// ═══════════════════════════════════════════════════════════════════

function cmdExplain(args: string[]): void {
  if (args.length === 0) {
    throw new MsmError(
      "PARAMETER_MISSING",
      "user",
      "explain requires a file path",
      { validArgs: ["<path>"] },
      "Usage: ontology explain <path>",
    );
  }

  const filePath = args[0]!;
  const { onto } = loadOntoFile(filePath);
  const merged = onto.imports && onto.imports.length > 0
    ? loadOntoFileWithImports(filePath)
    : onto;

  emit(`## Ontology: ${onto.name || filePath}\n`);
  if (onto.version) emit(`Version: ${onto.version}\n`);
  if (onto.imports && onto.imports.length > 0) {
    emit(`Imports: ${onto.imports.join(", ")}\n`);
  }

  // Type hierarchy
  const types = merged.types || {};
  const typeNames = Object.keys(types);
  emit(`\n### Types (${typeNames.length})\n\n`);
  emit("| Type | SuperTypes | Rigidity | Properties |\n");
  emit("|------|-----------|----------|------------|\n");
  for (const [name, td] of Object.entries(types)) {
    const st = (td.superTypes || []).join(", ") || "-";
    const rig = td.rigidity || "-";
    const props = td.properties ? Object.keys(td.properties).join(", ") : "-";
    emit(`| ${name} | ${st} | ${rig} | ${props} |\n`);
  }

  // Relations
  const relations = merged.relations || {};
  if (Object.keys(relations).length > 0) {
    emit(`\n### Relations\n\n`);
    emit("| Name | Domain | Range | Cardinality | Flags |\n");
    emit("|------|--------|-------|-------------|-------|\n");
    for (const [name, rd] of Object.entries(relations)) {
      const flags: string[] = [];
      if (rd.functional) flags.push("functional");
      if (rd.transitive) flags.push("transitive");
      if (rd.symmetric) flags.push("symmetric");
      emit(`| ${name} | ${rd.domain || "-"} | ${rd.range || "-"} | ${rd.cardinality || "-"} | ${flags.join(", ") || "-"} |\n`);
    }
  }

  // Axioms
  const axioms = merged.axioms || [];
  if (axioms.length > 0) {
    emit(`\n### Axioms (${axioms.length})\n\n`);
    for (const ax of axioms) {
      emit(`- ${ax.description || "(no description)"}: \`${ax.rule}\` [${ax.type || "rule"}]\n`);
    }
  }

  // Dependency graph
  emit(`\n### Dependency Graph\n\n`);
  for (const [name, td] of Object.entries(merged.types || {})) {
    const deps: string[] = [];
    if (td.superTypes) deps.push(...td.superTypes.map((s) => `"${name}" -> "${s}" [label="isa"]`));
    if (td.dependsOn) deps.push(...td.dependsOn.map((d) => `"${name}" -> "${d}" [label="depends"]`));
    deps.forEach((d) => emit(`  ${d}\n`));
  }
}

// ═══════════════════════════════════════════════════════════════════
// subcommand: verify (runtime compliance against ontology)
// ═══════════════════════════════════════════════════════════════════

interface VerifyIssue {
  check: string;
  // V3/V4 会产出 "info" 级条目（非阻断，仅告知）——联合类型补全，判决逻辑与文案均未改
  severity: "error" | "warning" | "info";
  message: string;
}

function pascalToKebab(name: string): string {
  return name.replace(/([A-Z])/g, "-$1").toLowerCase().replace(/^-/, "");
}

function isConcreteSkill(typeName: string, onto: OntologyDefinition): boolean {
  if (typeName === "Skill" || typeName === "SystemComponent" || typeName === "AccBuiltin") return false;
  const td = onto.types?.[typeName];
  if (!td) return false;
  const st = td.superTypes || [];
  return st.includes("Skill");
}

function getOntoSkillList(onto: OntologyDefinition): string[] {
  return Object.keys(onto.types || {}).filter((n) => isConcreteSkill(n, onto));
}

/**
 * 🔴 2026-10-11（v1.52.2）：**注册表路径的唯一出口**。
 * 此前这条路径在 `cmdCompliance` 的文案里是对的、在 `loadMechRegistry` 里漏了 `references/`——
 * **同一事实写两遍就必然漂移**。⇒ 抽成一个函数，谁要用谁来取。
 */
function mechRegistryPath(rootPath: string): string {
  return join(rootPath, ".opencode", "skills", TOP_SKILL, "references", "mech-registry.json");
}

function loadMechRegistry(rootPath: string): Record<string, { skill: string }> {
  // 🔴 本函数原有两个**叠加的静默缺陷**（形态相同：读不到 ⇒ 返回 {} ⇒ 上层打印"没有文件"）：
  //   ① 路径漏 `references/` 段 —— 已修（见上 mechRegistryPath）
  //   ② **顶层键找错** —— 真实文件是 `{ version, description, entries: [...] }`，
  //      而这里只找 `raw.msms` ⇒ `entries = raw`（**整个对象**）⇒ `Object.values` 出来的
  //      每个值都没有 `.name` ⇒ **result = {}** ⇒ 与"文件不存在"**完全同形**。
  //   ⚠️ **实测教训：修 ① 不够** —— 只修路径时，`verify` **照样**打印「check skipped」。
  //      是"对真实注册表"的那条断言把它逼出来的（合成 fixture 永远过不了这一关）。
  const regPath = mechRegistryPath(rootPath);
  if (!existsSync(regPath)) return {};
  try {
    const raw = JSON.parse(readFileSync(regPath, "utf-8"));
    const list = Array.isArray(raw) ? raw : raw.entries || raw.msms || [];
    const result: Record<string, { skill: string }> = {};
    for (const e of Array.isArray(list) ? list : Object.values(list as object)) {
      if (e && typeof e === "object" && typeof (e as { name?: unknown }).name === "string") {
        const it = e as { name: string; skill?: string };
        result[it.name] = { skill: it.skill || "" };
      }
    }
    return result;
  } catch {
    return {};
  }
}

function cmdVerify(args: string[]): void {
  if (args.length === 0) {
    throw new MsmError(
      "PARAMETER_MISSING", "user",
      "verify requires a file path",
      { validArgs: ["<path>"] },
      "Usage: ontology verify <path> [--level operational|continuity|full]",
    );
  }

  const filePath = args[0]!;
  let level = "operational";
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--level" && i + 1 < args.length) {
      const v = args[i + 1];
      if (v !== "operational" && v !== "continuity" && v !== "full") {
        throw new MsmError("PARAMETER_INVALID_VALUE", "user", `Unknown level: ${v}`, {}, "Use --level operational|continuity|full");
      }
      level = v;
      i++;
    } else if (args[i]!.startsWith("--level=")) {
      const v = args[i]!.slice("--level=".length);
      if (v !== "operational" && v !== "continuity" && v !== "full") {
        throw new MsmError("PARAMETER_INVALID_VALUE", "user", `Unknown level: ${v}`, {}, "Use --level operational|continuity|full");
      }
      level = v;
    }
  }

  const runOperational = level === "operational" || level === "full";
  const runContinuity = level === "continuity" || level === "full";

  const rootPath = findSerenityRoot();
  let onto: OntologyDefinition;
  try {
    onto = loadOntoFileWithImports(filePath);
  } catch (err) {
    onto = loadOntoFile(filePath).onto;
  }

  const issues: VerifyIssue[] = [];
  const ontoSkills = new Set(getOntoSkillList(onto));

  // ─── V1: Skill directory existence ─────────────────────────────
  const skillsDir = join(rootPath, ".opencode", "skills");
  const actualDirs = existsSync(skillsDir)
    ? readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    : [];

  const declaredSkills: string[] = [];
  for (const typeName of ontoSkills) {
    const kebab = pascalToKebab(typeName);
    declaredSkills.push(kebab);
    const skillMdPath = join(skillsDir, kebab, "SKILL.md");
    if (runOperational && !existsSync(skillMdPath)) {
      issues.push({
        check: "V1", severity: "warning",
        message: `Ontology declares "${typeName}" but "${kebab}/SKILL.md" not found`,
      });
    }
  }

  // ─── V2: Orphan directories ────────────────────────────────────
  if (runOperational) {
    for (const dir of actualDirs) {
      if (!declaredSkills.includes(dir)) {
        issues.push({
          check: "V2", severity: "warning",
          message: `Directory ".opencode/skills/${dir}/" exists but no ontology type declares it`,
        });
      }
    }
  }

  // ─── V3: MSM registration consistency ──────────────────────────
  if (runOperational) {
    const reg = loadMechRegistry(rootPath);
    if (Object.keys(reg).length > 0) {
      for (const [msmName, info] of Object.entries(reg)) {
        if (info.skill) {
          const kebab = info.skill;
          if (!declaredSkills.includes(kebab) && !actualDirs.includes(kebab)) {
            // skill not in ontology → may be inherited
          }
          if (!actualDirs.includes(kebab)) {
            issues.push({
              check: "V3", severity: "error",
              message: `MSM "${msmName}" registered under skill "${kebab}" but directory not found`,
            });
          }
        }
      }
    } else if (!existsSync(mechRegistryPath(rootPath))) {
      issues.push({
        check: "V3", severity: "info",
        message: "No mech-registry.json found — MSM registration check skipped (MSMs managed by ACC at runtime)",
      });
    } else {
      // 🔴 文件**在**、却一条都读不出来 ⇒ **绝不能说成"没有文件"**：那正是本函数两次静默失效的形态
      //   （路径漏段 ／ 顶层键找错）。这条从 info 升为 **error**：检查**没跑成**必须响。
      issues.push({
        check: "V3", severity: "error",
        message: `mech-registry.json exists at ${mechRegistryPath(rootPath)} but yielded 0 readable entries`
          + ` — MSM registration check **could not run**（这不是"没有文件"，是"读了但读不出来"）`,
      });
    }
  }

  // ─── V4: Session health ────────────────────────────────────────
  if (runContinuity) {
    const sessionsDir = join(rootPath, "AGENT_SESSIONS");
    if (existsSync(sessionsDir)) {
      const sessionDirs = readdirSync(sessionsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      const goals: string[] = [];
      for (const sd of sessionDirs) {
        const smPath = join(sessionsDir, sd, "SESSION.md");
        if (existsSync(smPath)) {
          try {
            const content = readFileSync(smPath, "utf-8");
            const goalMatch = content.match(/## Goal\n(.+)/);
            if (goalMatch) goals.push(goalMatch[1]!.trim());
          } catch { /* skip unreadable */ }
        }
      }

      // V4a: duplicate goals
      const seen = new Set<string>();
      for (const g of goals) {
        if (seen.has(g)) {
          issues.push({
            check: "V4", severity: "warning",
            message: `Duplicate session goal: "${g}" — potential entropy duplication`,
          });
        }
        seen.add(g);
      }

      // V4b: session count
      issues.push({
        check: "V4", severity: sessionDirs.length > 100 ? "warning" : "info",
        message: `Session count: ${sessionDirs.length} — ` +
          (sessionDirs.length > 100 ? "consider archiving old sessions to reduce H_op" : "within normal range"),
      });

      // V4c: stale sessions (no recent SESSION.md update)
      let staleCount = 0;
      const now = Date.now();
      for (const sd of sessionDirs) {
        const smPath = join(sessionsDir, sd, "SESSION.md");
        if (existsSync(smPath)) {
          try {
            const stat = readFileSync(smPath); // dummy read to check existence
            // mtime check requires fs.statSync which we don't import — skip for now
          } catch { staleCount++; }
        }
      }
    }
  }

  // ─── Output ────────────────────────────────────────────────────
  emit(`\nOntology Compliance Verification: ${onto.name || filePath}\n`);
  emit("=".repeat(60) + "\n");
  emit(`Level: ${level}\n`);
  emit(`Ontology skills declared: ${ontoSkills.size}\n`);
  emit(`Actual skill dirs found: ${actualDirs.length}\n\n`);

  if (issues.length === 0) {
    emit("All compliance checks passed.\n");
    return;
  }

  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  const info = issues.filter((i) => i.severity === "info");

  emit(`Errors: ${errors.length}, Warnings: ${warnings.length}, Info: ${info.length}\n\n`);

  for (const issue of issues) {
    const icon = issue.severity === "error" ? "ERR" : issue.severity === "warning" ? "WRN" : "INF";
    emit(`  ${icon} [${issue.check}] ${issue.message}\n`);
  }

  if (errors.length > 0) {
    throw new MsmError(
      "ONTO_VALIDATION_FAILED", "user",
      `Compliance verification found ${errors.length} error(s)`,
      { errors: errors.length, warnings: warnings.length },
      "Fix the errors listed above",
    );
  }
}

// ═══════════════════════════════════════════════════════════════════
// subcommand: review — LLM-driven semantic review prompt generator
// ═══════════════════════════════════════════════════════════════════

interface ReviewDimension {
  id: string;
  name: string;
  description: string;
  checklist: string[];
}

const REVIEW_DIMENSIONS: ReviewDimension[] = [
  {
    id: "D1", name: "Type Semantics",
    description: "Are type names, descriptions, and domain boundaries clear and correct?",
    checklist: [
      "Are all type names unambiguous within the domain vocabulary?",
      "Do descriptions clearly demarcate what IS and IS NOT an instance of this type?",
      "Are there types that should be split into finer-grained subtypes (under-modeled)?",
      "Are there types that should be merged (over-modeled, redundant distinctions)?",
      "Are type names consistent with domain conventions (e.g. singular nouns, no verb phrases)?",
    ],
  },
  {
    id: "D2", name: "Taxonomy Quality",
    description: "Is the subclass hierarchy logically sound and semantically defensible?",
    checklist: [
      "Does every superType relation satisfy the 'is-a' test (every X is-a Y in all contexts)?",
      "Are there missing superType links (concepts that should be generalized)?",
      "Are there incorrect superType links (passes structural check but fails semantic 'is-a')?",
      "Are types that should be disjoint from each other declared as disjoint?",
      "Does the taxonomy depth justify itself (3-7 levels is typical for domain ontologies)?",
    ],
  },
  {
    id: "D3", name: "Rigidity Audit",
    description: "Is every rigidity assignment (rigid/anti-rigid/semi-rigid) justified?",
    checklist: [
      "For each 'rigid' type: would removing this property destroy the entity's identity?",
      "For each 'anti-rigid' type: is it a role/stage/state that the same entity can stop being?",
      "For types with no rigidity label: what should it be and why?",
      "Does the rigidity inheritance hold — is any child more rigid than its parent? (M3 catches this)",
      "Are there 'semi-rigid' types where rigid or anti-rigid would be more appropriate?",
    ],
  },
  {
    id: "D4", name: "Identity Criteria",
    description: "Are identity criteria sufficient to guarantee uniqueness for rigid types?",
    checklist: [
      "For each rigid type: do the identity keys actually guarantee uniqueness?",
      "Are identity keys external (natural keys like NHS number) or internal (surrogate)? Prefer natural.",
      "Are there types that depend on mutable properties for identity (anti-pattern)?",
      "For types with a single identity property: could there be edge cases where it's not unique?",
      "Are identity criteria inherited correctly from superTypes?",
    ],
  },
  {
    id: "D5", name: "Relation Semantics",
    description: "Do relations accurately model real-world connections between entities?",
    checklist: [
      "Does every relation have a clear real-world interpretation (not just a technical link)?",
      "Are domain and range constraints correct — could any non-domain instance legitimately participate?",
      "Are property characteristics (functional/transitive/symmetric/etc.) consistent with reality?",
      "Are there missing relations between types that should be connected?",
      "Do cardinality constraints match what's physically possible in the domain?",
    ],
  },
  {
    id: "D6", name: "Axiom Completeness & Correctness",
    description: "Do axioms capture the right constraints, and are there gaps?",
    checklist: [
      "Are all axioms logically sound (no contradictions, no tautologies)?",
      "Are there missing temporal constraints (sequencing rules like 'discharge must follow admission')?",
      "Are there missing state constraints (mutual exclusion, preconditions, invariants)?",
      "Are there missing dependency constraints (an entity's existence depends on another)?",
      "Are there missing cardinality constraints on the instance level (not just relation level)?",
      "Do axioms reference only defined types and relations (M9 catches this)?",
    ],
  },
  {
    id: "D7", name: "Domain Completeness",
    description: "What important concepts or constraints are missing from this ontology?",
    checklist: [
      "What real-world entities in this domain have NOT been modeled?",
      "What relationships between existing types are unrepresented?",
      "What temporal aspects (lifecycle stages, state machines) are missing?",
      "What edge cases (exceptions, rare events) should be representable?",
      "Is the ontology wide enough for its stated purpose, or too narrow?",
      "Is it deep enough (sufficient type granularity), or too shallow?",
    ],
  },
  {
    id: "D8", name: "OntoClean Deep Review",
    description: "Apply OntoClean meta-property analysis to the full taxonomy.",
    checklist: [
      "Identity (+I/-I): For each sortal type, what is the identity criterion? Is it consistent down the hierarchy?",
      "Unity (+U/~U/-U): Can all instances form wholes? Any anti-unity types (e.g. 'pile of sand')?",
      "Rigidity inheritance: Run the full OntoClean constraint checker — rigid types cannot subsume anti-rigid.",
      "Dependence (+D/-D): Does any type's existence necessarily imply another type's existence?",
      "Sortal vs. Non-sortal: Are there types that should be non-sortal (no identity criteria possible)?",
      "Backbone taxonomy: Does the rigid-only backbone form a consistent tree?",
    ],
  },
];

type ReviewLevel = "semantic" | "onto-clean" | "full";
type ReviewFormat = "prompt" | "json";

function cmdReview(args: string[]): void {
  if (args.length === 0) {
    throw new MsmError(
      "PARAMETER_MISSING",
      "user",
      "review requires a file path",
      { validArgs: ["<path>"] },
      "Usage: ontology review <path> [--level semantic|onto-clean|full] [--format prompt|json]",
    );
  }

  const filePath = args[0]!;
  let level: ReviewLevel = "full";
  let format: ReviewFormat = "prompt";

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--level" && i + 1 < args.length) {
      const v = args[i + 1];
      if (v !== "semantic" && v !== "onto-clean" && v !== "full") {
        throw new MsmError(
          "PARAMETER_INVALID_VALUE", "user",
          `Unknown level: ${v}`,
          { level: v, valid: ["semantic", "onto-clean", "full"] },
        );
      }
      level = v;
      i++;
    } else if (args[i]!.startsWith("--level=")) {
      const v = args[i]!.slice("--level=".length);
      if (v !== "semantic" && v !== "onto-clean" && v !== "full") {
        throw new MsmError("PARAMETER_INVALID_VALUE", "user", `Unknown level: ${v}`);
      }
      level = v;
    } else if (args[i] === "--format" && i + 1 < args.length) {
      const v = args[i + 1];
      if (v !== "prompt" && v !== "json") {
        throw new MsmError("PARAMETER_INVALID_VALUE", "user", `Unknown format: ${v}`);
      }
      format = v;
      i++;
    } else if (args[i]!.startsWith("--format=")) {
      const v = args[i]!.slice("--format=".length);
      if (v !== "prompt" && v !== "json") {
        throw new MsmError("PARAMETER_INVALID_VALUE", "user", `Unknown format: ${v}`);
      }
      format = v;
    } else if (args[i]!.startsWith("-")) {
      throw new MsmError(
        "PARAMETER_INVALID_VALUE", "user",
        `Unknown flag: ${args[i]}`,
      );
    }
  }

  const { onto } = loadOntoFile(filePath);
  const merged = onto.imports && onto.imports.length > 0
    ? loadOntoFileWithImports(filePath)
    : onto;

  // Determine which dimensions to include
  let dimensions: ReviewDimension[];
  if (level === "semantic") {
    dimensions = REVIEW_DIMENSIONS.filter((d) =>
      parseInt(d.id.slice(1)) <= 6
    );
  } else if (level === "onto-clean") {
    dimensions = REVIEW_DIMENSIONS.filter((d) =>
      d.id === "D7" || d.id === "D8"
    );
  } else {
    dimensions = REVIEW_DIMENSIONS;
  }

  if (format === "json") {
    // Structured JSON format for programmatic consumption
    const types = merged.types || {};
    const relations = merged.relations || {};
    const axioms = merged.axioms || [];

    const out = {
      ontology: {
        name: onto.name || filePath,
        version: onto.version,
        imports: onto.imports || [],
        types: Object.entries(types).map(([n, t]) => ({
          name: n,
          description: t.description,
          superTypes: t.superTypes,
          rigidity: t.rigidity,
          identity: t.identity,
          dependsOn: t.dependsOn,
          properties: t.properties,
        })),
        relations: Object.entries(relations).map(([n, r]) => ({ name: n, ...r })),
        axioms: axioms,
      },
      reviewLevel: level,
      dimensions: dimensions.map((d) => ({ id: d.id, name: d.name, checklist: d.checklist })),
      instruction: "For each checklist item in each dimension, provide: {severity: 'P0'|'P1'|'P2'|'P3', finding: string, location: string, evidence: string, suggestion: string}",
    };
    emit(JSON.stringify(out, null, 2) + "\n");
    return;
  }

  // Markdown prompt format — designed to feed directly into an LLM subagent
  const types = merged.types || {};
  const relations = merged.relations || {};
  const axioms = merged.axioms || [];

  emit(`# Ontology Semantic Review\n`);
  emit(`**Ontology**: ${onto.name || filePath}\n`);
  if (onto.version) emit(`**Version**: ${onto.version}\n`);
  if (onto.imports && onto.imports.length > 0) {
    emit(`**Imports**: ${onto.imports.join(", ")}\n`);
  }
  emit(`**Review Level**: ${level}\n\n`);

  emit(`## Context: Ontology to Review\n\n`);

  // Types table
  emit(`### Types (${Object.keys(types).length})\n\n`);
  emit("| Type | SuperTypes | Rigidity | Identity | Properties |\n");
  emit("|------|-----------|----------|----------|------------|\n");
  for (const [name, td] of Object.entries(types)) {
    const st = (td.superTypes || []).join(", ") || "-";
    const rig = td.rigidity || "-";
    const idt = (td.identity || []).join(", ") || "-";
    const props = td.properties ? Object.keys(td.properties).join(", ") : "-";
    emit(`| ${name} | ${st} | ${rig} | ${idt} | ${props} |\n`);
  }

  // Relations table
  if (Object.keys(relations).length > 0) {
    emit(`\n### Relations\n\n`);
    emit("| Name | Domain | Range | Cardinality | Flags |\n");
    emit("|------|--------|-------|-------------|-------|\n");
    for (const [name, rd] of Object.entries(relations)) {
      const flags: string[] = [];
      if (rd.functional) flags.push("functional");
      if (rd.transitive) flags.push("transitive");
      if (rd.symmetric) flags.push("symmetric");
      emit(`| ${name} | ${rd.domain || "-"} | ${rd.range || "-"} | ${rd.cardinality || "-"} | ${flags.join(", ") || "-"} |\n`);
    }
  }

  // Axioms
  if (axioms.length > 0) {
    emit(`\n### Axioms (${axioms.length})\n\n`);
    for (const ax of axioms) {
      emit(`- \`${ax.rule}\` — ${ax.description || "(no description)"} [${ax.type || "rule"}]\n`);
    }
  }

  // Dependency graph (compact)
  emit(`\n### Type Hierarchy\n\n`);
  for (const [name, td] of Object.entries(types)) {
    if (td.superTypes && td.superTypes.length > 0) {
      emit(`- ${td.superTypes.join(", ")} → ${name}\n`);
    }
  }

  emit(`\n---\n\n`);

  // Review dimensions
  emit(`## Review Dimensions (${dimensions.length})\n\n`);
  emit(`Review this ontology systematically. For each dimension, examine every checklist item.\n`);
  emit(`Classify findings by severity:\n`);
  emit(`- **P0 (Critical)**: Would cause incorrect behavior, data corruption, or violates domain laws\n`);
  emit(`- **P1 (High)**: Makes the ontology misleading or unusable for its stated purpose\n`);
  emit(`- **P2 (Medium)**: Reduces quality, clarity, or reusability\n`);
  emit(`- **P3 (Low)**: Minor improvement or style concern\n\n`);

  for (const dim of dimensions) {
    emit(`### ${dim.id}: ${dim.name}\n\n`);
    emit(`${dim.description}\n\n`);
    emit("**Checklist**:\n\n");
    for (let ci = 0; ci < dim.checklist.length; ci++) {
      emit(`${ci + 1}. ${dim.checklist[ci]}\n`);
    }
    emit(`\n`);
  }

  emit(`---\n\n`);
  emit(`## Expected Output Format\n\n`);
  emit(`For each finding, produce a row in this format:\n\n`);
  emit("| Dimension | Severity | Type/Relation/Axiom | Finding | Evidence | Suggestion |\n");
  emit("|-----------|----------|---------------------|---------|----------|------------|\n\n");
  emit(`At the end, provide a summary section:\n`);
  emit("1. **Top 3 issues** — most critical findings that MUST be addressed\n");
  emit("2. **Ontology health assessment** — overall quality rating (A-F) with justification\n");
  emit("3. **Recommendations** — ordered list of concrete changes\n");
}

// ═══════════════════════════════════════════════════════════════════
// subcommand: compliance — axiom-skill compliance checklist
// ═══════════════════════════════════════════════════════════════════

interface ComplianceCheckItem {
  id: string;
  axiomIndex: number;
  axiomRule: string;
  axiomDescription: string;
  axiomType: string;
  pattern: string;
  severity: "P0" | "P1" | "P2";
  targets: string[];         // skill names, or ["*"] for all
  question: string;
  verification: string;      // what files to read, what to look for
}

function cmdCompliance(args: string[]): void {
  if (args.length === 0) {
    throw new MsmError(
      "PARAMETER_MISSING", "user",
      "compliance requires a file path",
      { validArgs: ["<path>"] },
      "Usage: ontology compliance <path> [--skills <dir>] [--format prompt|json]",
    );
  }

  const filePath = args[0]!;
  let skillsDir = resolve(BASE, ".opencode", "skills");
  let format: "prompt" | "json" = "prompt";

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--skills" && i + 1 < args.length) {
      skillsDir = resolve(BASE, args[i + 1]!);
      i++;
    } else if (args[i]!.startsWith("--skills=")) {
      skillsDir = resolve(BASE, args[i]!.slice("--skills=".length));
    } else if (args[i] === "--format" && i + 1 < args.length) {
      const v = args[i + 1];
      if (v !== "prompt" && v !== "json") {
        throw new MsmError("PARAMETER_INVALID_VALUE", "user", `Unknown format: ${v}`);
      }
      format = v;
      i++;
    } else if (args[i]!.startsWith("--format=")) {
      const v = args[i]!.slice("--format=".length);
      if (v !== "prompt" && v !== "json") {
        throw new MsmError("PARAMETER_INVALID_VALUE", "user", `Unknown format: ${v}`);
      }
      format = v;
    } else if (args[i]!.startsWith("-")) {
      throw new MsmError("PARAMETER_INVALID_VALUE", "user", `Unknown flag: ${args[i]}`);
    }
  }

  // Ensure skills dir exists (may be discovered and auto-populated)
  let skillNames: string[] = [];
  if (existsSync(skillsDir)) {
    skillNames = readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  }

  const { onto } = loadOntoFile(filePath);
  const merged = onto.imports && onto.imports.length > 0
    ? loadOntoFileWithImports(filePath)
    : onto;

  const axioms = merged.axioms || [];
  const types = merged.types || {};
  const relations = merged.relations || {};
  const typeNames = new Set(Object.keys(types));

  // Find the "Skill" type (could be named Skill or have subtypes that are skills)
  const skillTypeNames = new Set<string>();
  const skillSubtypeNames = new Set<string>();
  for (const [name, td] of Object.entries(types)) {
    if (name === "Skill" || name.endsWith("Skill")) {
      skillTypeNames.add(name);
      // Also find its subtypes
      for (const [sn, sd] of Object.entries(types)) {
        if (sd.superTypes?.includes(name)) {
          skillSubtypeNames.add(sn);
        }
      }
    }
  }
  if (skillTypeNames.size === 0) {
    // No explicit Skill type — treat all types as potential targets
    for (const name of typeNames) {
      skillTypeNames.add(name);
    }
  }

  const checks: ComplianceCheckItem[] = [];

  for (let ai = 0; ai < axioms.length; ai++) {
    const ax = axioms[ai]!;
    if (!ax.rule || ax.rule.trim() === "") continue;
    const ruleText = ax.rule;

    // Parse axiom AST
    const { tokens, errors: tokErrors } = tokenize(ax.rule);
    if (tokErrors.length > 0) continue;
    const parser = new AxiomParser(tokens);
    const result = parser.parse();
    if (!result.ast || parser.errors.length > 0) continue;

    // Collect references (with bound variable tracking)
    const refs = collectRefs(result.ast);

    // Extract all type references
    const axiomTypeRefs = refs.filter((r) => r.kind === "type").map((r) => r.name);
    const axiomPropRefs = refs.filter((r) => r.kind === "property").map((r) => r.name);

    // Determine which skills are affected
    let targets: string[] = [];
    let pattern = "unknown";

    // Check if this axiom targets the Skill type hierarchy
    const affectedSkillTypes = axiomTypeRefs.filter((t) => skillTypeNames.has(t) || skillSubtypeNames.has(t));

    if (affectedSkillTypes.length > 0) {
      // Universal: applies to all skills
      pattern = "universal-skill";
      if (skillNames.length > 0) {
        targets = [...skillNames];
      } else {
        targets = ["*"];
      }
    }

    // Check for specific skill dependencies (e.g., skillDependsOn(HomeResearch, HomeSearch))
    for (const ref of refs) {
      if (ref.kind === "unknown" && ref.name === "skillDependsOn") {
        // Find the funcCall in the AST to extract args
        function findDependsOnArgs(node: ExprNode | null): string[] {
          if (!node) return [];
          switch (node.kind) {
            case "funcCall":
              if (node.name === "skillDependsOn" && node.args.length >= 1) {
                return node.args.map((a) => a.kind === "propAccess" ? a.path.join(".") : "");
              }
              return node.args.flatMap(findDependsOnArgs);
            case "quantifier":
              return findDependsOnArgs(node.body);
            case "binaryOp":
              return [...findDependsOnArgs(node.left), ...findDependsOnArgs(node.right)];
            case "unaryOp":
              return findDependsOnArgs(node.operand);
            case "implication":
              return [...findDependsOnArgs(node.antecedent), ...findDependsOnArgs(node.consequent)];
            case "parens":
              return findDependsOnArgs(node.expr);
            default:
              return [];
          }
        }
        /**
         * 只为每条依赖子句取**第一参数**（= 声明义务承担方）。
         *
         * 2026-09-14 S188 修（缺陷④）：旧实现把 `skillDependsOn(A, B)` 的两端都收进 targets，
         * 于是按生成指引逐 target 审会得到一半**方向错误的伪 Fail**（如"home-memory 未声明
         * 依赖 zhaocai-memory"——B 端根本不欠任何声明）。同时修缺陷⑤：合取式
         * （`dependsOn(X,A) and dependsOn(X,B)`）里 X 出现两次，旧实现不去重。
         */
        function findDependsOnDeclarers(node: ExprNode | null): string[] {
          if (!node) return [];
          switch (node.kind) {
            case "funcCall":
              if (node.name === "skillDependsOn" && node.args.length >= 1) {
                const a = node.args[0]!;
                return [a.kind === "propAccess" ? a.path.join(".") : ""];
              }
              return node.args.flatMap(findDependsOnDeclarers);
            case "quantifier":
              return findDependsOnDeclarers(node.body);
            case "binaryOp":
              return [...findDependsOnDeclarers(node.left), ...findDependsOnDeclarers(node.right)];
            case "unaryOp":
              return findDependsOnDeclarers(node.operand);
            case "implication":
              return [...findDependsOnDeclarers(node.antecedent), ...findDependsOnDeclarers(node.consequent)];
            case "parens":
              return findDependsOnDeclarers(node.expr);
            default:
              return [];
          }
        }
        const depArgs = findDependsOnDeclarers(result.ast);
        /**
         * 2026-09-14 S188 修（缺陷③）：旧实现用 `pascalToKebab(a) === s` 做**过滤**，
         * 却输出 `a`（原 PascalCase 类名），导致生成的 verification 路径
         * `.opencode/skills/HomeMemory/SKILL.md` **根本不存在**。此处输出**匹配到的目录名**。
         */
        const renameMap = new Map<string, string>();
        for (const s of skillNames) renameMap.set(pascalToKebab(s), s);
        const depTarget = Array.from(new Set(
          depArgs
            .filter((a) => !!a)
            .map((a) => (skillNames.includes(a) ? a : renameMap.get(pascalToKebab(a))))
            .filter((s): s is string => !!s),
        ));
        if (depTarget.length > 0) {
          pattern = "specific-dependency";
          targets = depTarget;
        }
        break;
      }
    }

    /**
     * 2026-09-14 S188 修（缺陷②）：**全称量词曾被静默降级为单目标**。
     *
     * 根因（两处合谋）：① 依赖检测的 `targets = depTarget` 是**整体覆盖**；
     * ② `HomeSerenity` 恰因 `pascalToKebab("HomeSerenity") === "home-serenity"` 命中映射。
     * ⇒ `forall s in Skill: s.skillName != 'home-serenity' implies skillDependsOn(s, HomeSerenity)`
     * 被压缩成 targets=["home-serenity"]（**只检查根 skill 自己**）⇒ 该检查项必然误判 Pass。
     * C029 正是靠此路径发现的「2 个 skill 未声明根依赖」——按生成结果走则永远看不到。
     *
     * 判据修正（第一版修错了分支，实测纠正）：不能按 `pattern` 判定——该公理的 pattern 是
     * `constraint`（依赖检测只在 `depTarget.length > 0` 时才改成 specific-dependency）。
     * 正确的判据是**规则文本本身含 `forall ? in Skill`**：此时 targets 必须覆盖全部 skill。
     */
    const forallOverSkill = /forall\s+\w+\s+in\s+Skill\b/.test(ruleText);
    if (forallOverSkill && skillNames.length > 0) {
      // 量词公理：断言对**每个** skill 成立 → targets = 全部 skill
      targets = [...skillNames];
    }
    // 去重（合取式/重复公理都可能造成重复元素）
    targets = Array.from(new Set(targets));

    // Check for precedes/load-order patterns
    if (ruleText.includes("skillPrecedes") || ruleText.includes("precedes")) {
      pattern = "precedence";
    }

    // ── 主体判定：公理讲的是"skill 本身"还是"注册表自身"？ ──
    // 2026-09-14 S188 修（缺陷②）：注册表级公理（如"本文件不得枚举 MSM 清单"）过去被
    // 压成 35 行"读 SKILL.md 判约束"——**原理上不可判定**（读 35 遍 SKILL.md 也答不出
    // 注册表自己抄没抄工具名）。此处给它们正确的主体与取证方式。
    const mentionsThisFile = /\bthisFile\b/.test(ruleText) || /本(文件|注册表)/.test(ax.description || "");
    const mentionsMsmInventory = /MSMInventory|MSM 清单|mech-registry/.test(ruleText + (ax.description || "")) ||
      /forall\s+\w+\s+in\s+MSM\b/.test(ruleText);

    // Determine which files to check
    let verification = "";
    let question = "";

    if (mentionsThisFile || mentionsMsmInventory) {
      const subject = mentionsMsmInventory
        ? `MSM 注册表（.opencode/skills/${TOP_SKILL}/references/mech-registry.json）`
        : "本注册表文件自身";
      pattern = "self-check";
      targets = [subject];
      question = `Does ${subject} satisfy this axiom?`;
      verification = `Read ${subject}，核对该约束（**不是**读 skill 文档）`;
    } else if (ax.type === "structural" || ruleText.includes("Skill.hasSkillMd") || ruleText.includes("SKILL.md")) {
      pattern = "structural-hasSkillMd";
      if (targets.length === 0 || targets[0] === "*") targets = skillNames.length > 0 ? [...skillNames] : ["*"];
      question = `Does this skill have a SKILL.md file?`;
      verification = `Check if .opencode/skills/{skill}/SKILL.md exists`;
    } else if (ax.type === "dependency" || pattern === "specific-dependency") {
      question = `Is this dependency declared in the skill's SKILL.md?`;
      verification = `Read .opencode/skills/{skill}/SKILL.md, check \"相关技能\" / \"Related Skills\" section for the required dependency`;
    } else if (ax.type === "cce" || ax.type === "eap") {
      question = `Does this skill's implementation satisfy the CCE/EAP constraint?`;
      verification = `Read .opencode/skills/{skill}/SKILL.md and references/, evaluate against the axiom`;
      pattern = pattern === "unknown" ? ax.type : pattern;
    } else if (ax.type === "constraint" || ax.type === "domain") {
      question = `Does this skill satisfy the constraint?`;
      verification = `Read .opencode/skills/{skill}/SKILL.md and check constraint compliance`;
    } else if (pattern === "universal-skill") {
      question = `Does this skill satisfy the axiom?`;
      verification = `Read .opencode/skills/{skill}/SKILL.md, evaluate compliance`;
    } else {
      question = `Is this axiom satisfied?`;
      verification = `Read relevant skill files and evaluate`;
    }

    // Determine severity
    let severity: "P0" | "P1" | "P2" = "P1";
    if (ax.type === "structural") severity = "P0";
    else if (ax.type === "cce") severity = "P0";
    else if (ruleText.includes("Skill.hasSkillMd")) severity = "P0";
    else if (ruleText.includes("not exists")) severity = "P1";
    else if (ax.type === "eap") severity = "P2";

    if (targets.length === 0) {
      // Axiom doesn't directly reference skills — skip for compliance
      continue;
    }

    /**
     * 2026-09-14 S188 修（缺陷①）：检查 ID 由**位置派生**（`C{axiomIndex+1}`）改为
     * **规则文本稳定哈希**。
     *
     * 旧行为之害（实测）：axiom 集合是 `cce ← ccc ← serenity-skills` 三者合并，
     * 注册表一增删公理，**全体 ID 平移** —— v0.2.0（55 公理/33 检查）与 v0.3.0（53/29）
     * 之间，同一字母数字指向不同公理；历史报告引用的 C055 在现行清单中已不存在。
     * 任何「关闭 C0xx」式的跨会话交接都会失准。
     *
     * 新 ID = `C-` + 规则文本 sha256 前 6 位十六进制：与公理内容绑定，与顺序无关；
     * 同一规则在任意版本生成同一 ID，跨报告可比。旧的**序号**另存为 `axiomIndex` 字段
     * （仅供排序/展示，不用于引用）。
     */
    const idHash = createHash("sha256")
      // 只用**规范化后的规则文本**：ID 是"这条公理"的身份，不是"这次生成"的序号。
      // 同一规则在 ccc 基础层与 serenity 注册表层各写一遍时 → 同名 ID（冗余被显式暴露，
      // 而非靠描述差异掩盖）；注册表增删其他公理则完全不影响本 ID。
      .update(ax.rule.trim().replace(/\s+/g, " "))
      .digest("hex")
      .slice(0, 6);

    checks.push({
      id: `C-${idHash}`,
      axiomIndex: ai,
      axiomRule: ax.rule,
      axiomDescription: ax.description || "(no description)",
      axiomType: ax.type || "rule",
      pattern,
      severity,
      targets,
      question,
      verification,
    });
  }

  /**
   * 2026-09-14 S188 修（缺陷①收尾）：按**规范化规则**去重。
   *
   * 为什么要去重而不是保留重复项：ID 现在绑定规则文本，重复公理会产生**同名 ID 的两条
   * 检查**——对下游审计是毒药（同一 ID 两条记录，无法引用）。去重后「一个 ID = 一条公理」，
   * 冗余则通过 stderr 显式报告，交给注册表维护者决定是否清理（不静默吞掉）。
   */
  const byRule = new Map<string, ComplianceCheckItem>();
  const dupReports: string[] = [];
  for (const c of checks) {
    const key = c.axiomRule.trim().replace(/\s+/g, " ");
    const prev = byRule.get(key);
    if (prev) {
      dupReports.push(`  ${c.id}  重复公理：${c.axiomRule}`);
      // 合并 targets（取并集），避免因去重丢掉覆盖面
      prev.targets = Array.from(new Set([...prev.targets, ...c.targets]));
      continue;
    }
    byRule.set(key, c);
  }
  const dedupedChecks = Array.from(byRule.values());
  if (dupReports.length > 0) {
    emitErr(
      `[compliance] 警告：注册表内存在 ${dupReports.length} 条重复公理（同一规则写了多遍）。\n` +
        `已按规则合并为单一检查项；建议清理注册表以消除冗余：\n` +
        dupReports.join("\n") +
        "\n",
    );
  }
  checks.length = 0;
  checks.push(...dedupedChecks);

  if (format === "json") {
    const output = {
      ontology: merged.name || filePath,
      skills_dir: skillsDir,
      skill_count: skillNames.length,
      axiom_count: axioms.length,
      check_count: checks.length,
      checks: checks.map((c) => ({
        ...c,
        targets: c.targets.filter((t) => t !== "*"),
      })),
    };
    emit(JSON.stringify(output, null, 2) + "\n");
    return;
  }

  // Markdown prompt format
  emit(`# Compliance Checklist — ${merged.name || filePath}\n\n`);
  emit(`**Generated by ontology-engineering compliance**\n\n`);
  emit(`- Skills directory: \`${skillsDir}\`\n`);
  emit(`- Skills found: ${skillNames.length}\n`);
  emit(`- Axioms analyzed: ${axioms.length}\n`);
  emit(`- Compliance checks generated: ${checks.length}\n\n`);
  emit(`---\n\n`);

  emit(`## Instructions for Subagent\n\n`);
  emit(`You are auditing skill implementations against an ontology. For each check item:\n\n`);
  emit(`1. **Read the relevant files** as specified in the verification column\n`);
  emit(`2. **Determine pass/fail** based on evidence from the files\n`);
  emit(`3. **Report** in table format: Check ID | Skill | Pass/Fail | Evidence | Notes\n\n`);
  emit(`---\n\n`);

  emit(`## Checks\n\n`);

  // Group checks by target for readability
  const byTarget = new Map<string, ComplianceCheckItem[]>();
  for (const c of checks) {
    for (const t of c.targets) {
      const key = t === "*" ? "ALL" : t;
      if (!byTarget.has(key)) byTarget.set(key, []);
      byTarget.get(key)!.push(c);
    }
  }

  for (const [target, items] of byTarget.entries()) {
    emit(`### ${target === "ALL" ? "All Skills" : target}\n\n`);
    emit("| ID | Severity | Pattern | Axiom | What to Verify |\n");
    emit("|----|----------|---------|-------|----------------|\n");
    for (const item of items) {
      const axShort = item.axiomDescription.length > 60
        ? item.axiomDescription.slice(0, 57) + "..."
        : item.axiomDescription;
      const verifyShort = item.verification.length > 80
        ? item.verification.slice(0, 77) + "..."
        : item.verification;
      emit(`| ${item.id} | **${item.severity}** | ${item.pattern} | ${axShort} | ${verifyShort} |\n`);
    }
    emit("\n");

    // Detailed verification instructions per item
    for (const item of items) {
      emit(`<details>\n<summary>**${item.id}** — ${item.axiomDescription}</summary>\n\n`);
      emit(`- **Axiom:** \`${item.axiomRule}\`\n`);
      emit(`- **Type:** ${item.axiomType}\n`);
      emit(`- **Severity:** ${item.severity}\n`);
      emit(`- **Target skills:** ${item.targets.join(", ")}\n\n`);
      emit(`**Verification:** ${item.verification}\n\n`);
      if (item.targets.length === 1 && item.targets[0] !== "*") {
        const vPath = item.verification.replace(/\{skill\}/g, item.targets[0]!);
        emit(`**File path:** \`${vPath}\`\n\n`);
      }
      emit(`</details>\n\n`);
    }
  }

  emit(`---\n\n`);
  emit(`## Summary\n\n`);
  emit(`- **P0 (blocking):** ${checks.filter((c) => c.severity === "P0").length} checks\n`);
  emit(`- **P1 (important):** ${checks.filter((c) => c.severity === "P1").length} checks\n`);
  emit(`- **P2 (nice-to-have):** ${checks.filter((c) => c.severity === "P2").length} checks\n`);
}

// ═══════════════════════════════════════════════════════════════════
// Protocol flag rejection
// ═══════════════════════════════════════════════════════════════════

function rejectProtocolFlags(args: string[]): void {
  for (const arg of args) {
    if (arg === "--json" || arg === "--help" || arg === "-h" || arg === "--log") {
      throw new MsmError(
        "PARAMETER_INVALID_VALUE",
        "user",
        `Business MSM does not accept protocol flag: ${arg}`,
        { arg, validSubcommands: ["init", "check", "explain", "verify", "review", "compliance"] },
        "Use the `ontology` tool (see its description for flags) — e.g. ontology(command=\"check\", path=…)",
      );
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// Main router —— 改写 ②：导出 runner（退出码作为返回值，绝不 process.exit）
// ═══════════════════════════════════════════════════════════════════

const VALID_SUBCOMMANDS = ["init", "check", "explain", "verify", "review", "compliance"];

function dispatch(argv: string[]): number {
  if (argv.length === 0) {
    throw new MsmError(
      "PARAMETER_MISSING",
      "user",
      "Missing subcommand",
      { validSubcommands: VALID_SUBCOMMANDS },
      "Usage: ontology <init|check|explain|verify|review|compliance> [args...]",
    );
  }

  rejectProtocolFlags(argv);

  const subcommand = argv[0];
  const subArgs = argv.slice(1);

  switch (subcommand) {
    case "init":
      cmdInit(subArgs);
      return 0;

    case "check":
      cmdCheck(subArgs);
      return 0;

    case "explain":
      cmdExplain(subArgs);
      return 0;

    case "verify":
      cmdVerify(subArgs);
      return 0;

    case "review":
      cmdReview(subArgs);
      return 0;

    case "compliance":
      cmdCompliance(subArgs);
      return 0;

    default:
      throw new MsmError(
        "PARAMETER_INVALID_VALUE",
        "user",
        `Unknown subcommand: ${subcommand}`,
        { subcommand, validSubcommands: VALID_SUBCOMMANDS },
        "Usage: ontology <init|check|explain|verify|review|compliance> [args...]",
      );
  }
}

export interface OntologyRunOptions {
  /** 运行时工作目录（= CCC 根）：引擎多处按相对路径解析 `.opencode/skills` 等。
   *  ⇒ 落到**解析基准 `BASE`**（改写 ③）；**不做 `process.chdir`**（worker 线程不支持）。 */
  cwd?: string
  /** 顶层 skill 名（缺省 `home-serenity`）：容器级资产（根标记／MSM 注册表／合规扫描）按它定位 */
  topSkill?: string
  /** `sr:` 命名空间（缺省 `http://home-serenity/ontology#`） */
  namespace?: string
}

export interface OntologyRunResult {
  /** 退出码：0 成功 ／ 1 user ／ 2 system ／ 4 internal */
  code: number
  stdout: string
  stderr: string
}

/**
 * runOntologyCli —— 同步跑一次引擎调用，**返回**输出与退出码（不打印、不退出）。
 *
 * 调用方（工具壳 `src/tools/ontology-eng.ts`）负责：路径守卫（必须落在 CCC 内）、
 * 以及把 `code !== 0` 翻成响亮的回执（引擎的 stderr 文案**逐字保留**，不重写）。
 */
export function runOntologyCli(argv: string[], opts: OntologyRunOptions = {}): OntologyRunResult {
  let out = "";
  let err = "";
  const prevOut = OUT;
  const prevErr = ERR;
  const prevRoot = ROOT;
  const prevTopSkill = TOP_SKILL;
  const prevSr = SR;
  const prevBase = BASE;
  OUT = { write: (s) => { out += s } };
  ERR = { write: (s) => { err += s } };
  let code = 0;
  try {
    if (opts.cwd !== undefined) {
      ROOT = opts.cwd;
      BASE = opts.cwd; // 显式基准目录 —— **不用 process.chdir**（worker 线程不支持），见改写 ③
    }
    if (opts.topSkill !== undefined) TOP_SKILL = opts.topSkill;
    if (opts.namespace !== undefined) SR = opts.namespace;
    code = dispatch(argv);
  } catch (e) {
    if (e instanceof MsmError) {
      emitError(e);
      code = e.exitCode();
    } else {
      const ie = e instanceof Error ? e : new Error(String(e));
      const fallback = new MsmError(
        "INTERNAL_UNHANDLED_STATE",
        "internal",
        `Unhandled exception: ${ie.message}`,
        { stack: ie.stack },
        "Report this bug to the Agent",
        ie,
      );
      emitError(fallback);
      code = fallback.exitCode();
    }
  } finally {
    BASE = prevBase;
    ROOT = prevRoot;
    TOP_SKILL = prevTopSkill;
    SR = prevSr;
    OUT = prevOut;
    ERR = prevErr;
  }
  return { code, stdout: out, stderr: err };
}

export { MsmError, validateOnto, type OntologyDefinition, type CheckIssue, type ExprNode };
