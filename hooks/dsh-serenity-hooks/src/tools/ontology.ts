/**
 * ontology.ts — Ontology Engineering 内容源（本体论工程方法群；v1.51.5 并入 praxis 第四段）
 *
 * 内嵌方法内容（自包含，不依赖已安装技能）：把「做本体论工程」的完整方法群
 * （触发 → 编码 → 四组判据 → OEPE 循环 → 工作流 → 公理 → 反模式）压成一份可即时注入的手册。
 *
 * 🔴 **本文件是 ACC 层**（D23：机制与措辞归 ACC、数据与纪律归 CCC）：
 *   · 只写**通用方法**，不出现任何具体 CCC 的名字，也不带任何领域模型；
 *   · 判据群（M/L/D/V）是方法的**标准编号**（与参考实现同源），容器不必有同名引擎也能用；
 *   · **模型语料（.ttl）与具体公理内容属 CCC**，不在本文件。
 */

export const ONTOLOGY_CONTENT = `# Ontology Engineering — Method Family (本体论工程方法群)

> **Any creative action — a new concept, a new term, a new skill, a new MSM, a new architectural layer —
> is preceded by explicitly encoding WHAT EXISTS, HOW THINGS RELATE, and WHAT IS CONSTRAINED.**
>
> Without it: idea → implementation (all ΔH_in becomes H_op).
> With it: idea → structure → implementation (structure absorbs part of ΔH_in).

## 1. When to invoke

- introducing a new concept, term, or vocabulary
- creating a skill, or changing an existing skill's scope/dependencies
- creating an MSM (Mech or Semi-Mech)
- introducing a new architectural layer or a cross-domain concept
- any moment of "what IS this thing here, and how does it relate to everything else?"

## 2. Core cognition

**Ontology = before acting, make explicit what exists, how it relates, and what is constrained.**

Ontology is one of CCE's \`ΔH_org\` operators: it records the *structure* of new content at the moment the
content is produced, so that future agents do not have to reverse-engineer structure out of prose.
It is EAP applied at the layer of domain structure:

| EAP demand | How ontology satisfies it |
|---|---|
| E↑ Explicitness | types / relations / axioms are stated, not implied |
| R↓ Reconstructability | a new agent reads structure directly instead of inferring it |
| S↑ Stability | the \`.ttl\` file is the single structural source of truth |

**Consequence**: in a container, *every act of creation adds an entity to a domain* — so updating the
ontology is part of the creative act, not an extra chore.

## 3. Encoding — Turtle (\`.ttl\`)

All models use W3C Turtle. **Why Turtle**: LLMs already carry RDF/OWL/Turtle in their training data, so the
notation costs ~zero context to explain.

- **Standard namespaces**: \`rdf:\`, \`rdfs:\`, \`owl:\`, \`xsd:\`
- **Container-local namespace**: \`sr:\` — a container-chosen URI used for \`rigidity\`, \`identity\`,
  \`unity\`, \`dependence\`, \`cardinality\`, \`axiom\`, \`dependsOn\`, … (the container fixes the URI; the
  method does not)

**Modelling vocabulary**: *Type* · *Relation* (with domain/range) · *Axiom* (a named constraint), plus
**meta-properties** attached to types: rigidity (\`+R\` rigid / \`~R\` semi-rigid / \`-R\` anti-rigid),
identity, unity, dependence.

## 4. Judgement set A — structural validation \`M1–M10\` (deterministic, machine)

Run after every write; these are decidable from the file alone.

| ID | Check | Catches |
|---|---|---|
| **M1** | Referential integrity | a type/relation/type-in-relation is referenced but not defined |
| **M2** | Taxonomy acyclicity | a cycle in the \`subClassOf\` graph |
| **M3** | Rigidity inheritance | a child is **more rigid** than its parent (rigid must not subsume anti-rigid) |
| **M4** | Identity presence | a **rigid** type carries no identity (own or inherited) |
| **M5** | Dependency acyclicity | a cycle in the existence-dependency graph |
| **M6** | Cardinality consistency | malformed or mutually contradictory cardinalities |
| **M7** | Enum coverage | an enumerated value set is incomplete/inconsistent with its use |
| **M8** | Axiom syntax | an axiom is not syntactically well-formed |
| **M9** | Axiom reference check | an axiom references an undefined type/relation |
| **M10** | Import/file error | an imported \`.ttl\` is missing or unparsable |

## 5. Judgement set B — semantic hints \`L1–L5\` (strict mode; machine emits, model judges)

These are **questions, not verdicts** — the engine prints them so an LLM can answer them.

| ID | Hint |
|---|---|
| **L1** | type has **no rigidity label** — should it be rigid or anti-rigid? |
| **L2** | **missing constraints** — are temporal / state axioms absent? |
| **L3** | **identity adequacy** — is the declared identity sufficient for uniqueness? |
| **L4** | **type semantics** — are there missing distinctions between types? |
| **L5** | **axiom coverage** — do axioms reference concepts that are not defined as types? |

## 6. Judgement set C — semantic review \`D1–D8\` (model, ideally a read-only subagent)

Structure can pass \`M*\` and still be wrong. \`D*\` is where an LLM reviews meaning.

| ID | Dimension | Asks |
|---|---|---|
| **D1** | Type semantics | are names/descriptions/boundaries clear and correct? split or merge needed? |
| **D2** | Taxonomy quality | does every \`subClassOf\` pass the **is-a test**? missing/incorrect links? disjointness? sensible depth (3–7 levels typical)? |
| **D3** | Rigidity audit | is every rigid/anti-rigid/semi-rigid assignment justified? is inheritance consistent? |
| **D4** | Identity criteria | do identity keys guarantee uniqueness? natural vs surrogate? any identity resting on mutable properties? |
| **D5** | Relation semantics | real-world interpretation? domain/range correct? property characteristics true? cardinalities physically possible? |
| **D6** | Axiom completeness & correctness | sound? missing temporal / state / dependency / instance-level cardinality constraints? |
| **D7** | Domain completeness | what real-world entities are **not** modelled? missing relations? lifecycle/state machines? edge cases? wide/deep enough? |
| **D8** | OntoClean deep review | the six meta-properties, applied down the whole taxonomy |

**OntoClean's six meta-properties** (the vocabulary \`D8\` reason with):

| Meta-property | Notation | Question |
|---|---|---|
| Identity | \`+I\` / \`-I\` | what criterion distinguishes instances of this type? |
| Unity | \`+U\` / \`~U\` / \`-U\` | can instances form a whole? any anti-unity type ("pile of sand")? |
| Rigidity | \`+R\` / \`~R\` / \`-R\` | is the property essential to every instance, in every context? |
| Dependence | \`+D\` / \`-D\` | does this type's existence necessarily imply another's? |
| Sortal vs non-sortal | — | can an identity criterion exist at all? |
| Backbone taxonomy | — | does the rigid-only backbone form a consistent tree? |

## 7. Judgement set D — runtime compliance \`V1–V4\` (declaration ↔ reality)

Ontology is not only a model of the world — it also **declares facts about the container itself**, so those
declarations must be checked against the container's actual state.

| ID | Check |
|---|---|
| **V1** | declared skill directories exist |
| **V2** | orphan directories (present on disk, absent from the model) |
| **V3** | MSM registration consistency (declared ownership ↔ registry) |
| **V4** | session health (duplicate goals · session count · stale sessions) |

## 8. The OEPE loop — Ontology → EAP → Prompt-Enhancement

The reusable audit cycle. **Do not spend human effort hand-reviewing prose** — let the ontology be the
structural blueprint, let a subagent do semantic review in an isolated context, and let the human only
confirm the direction of repair.

\`\`\`
O ── Ontology
│    ① write the domain .ttl: types + relations + axioms
│    ② check --level strict         → 0 errors
│    ③ explain                      → natural-language summary (reasoning context for the next stage)
│    ④ review --level onto-clean    → structured review prompt (D7 + D8)
│
├── E ── EAP audit
│    ⑤ take the ontology axioms as the TOP constraint; evaluate the target artifact against each
│    ⑥ EAP scoring (E/R/S) + ambiguous-word scan
│    ⑦ emit a compliance matrix: PASS / WEAK / VIOLATION
│
└── PE ── Prompt-Enhance
     ⑧ VIOLATION → repair (P1)
     ⑨ WEAK → strengthen (P2)
     ⑩ PASS → keep
     ⑪ re-run check → audit → until everything is PASS
\`\`\`

**Severity classes** used across the review dimensions:

| Class | Meaning |
|---|---|
| **P0 Critical** | causes incorrect behaviour, data corruption, or violates a domain law |
| **P1 High** | makes the ontology misleading, or unable to serve its stated purpose |
| **P2 Medium** | reduces quality / clarity / reusability |
| **P3 Low** | minor improvement or style suggestion |

**Typical artifacts**: \`<domain>-ontology.ttl\` (O) · \`onto-clean-review.md\` (O) · \`skill-audit-report.md\` (E).

## 9. Workflows

**New skill**
\`\`\`
① what type is this skill? which skills does it depend on? what are its domain entities?
② if the domain is complex enough → build a domain ontology (types / relations / axioms)
③ write SKILL.md so that its declared dependencies match the axioms
④ structural check → 0 errors
⑤ axiom compliance → no violation of existing axioms
\`\`\`

**New concept / term**
\`\`\`
① is this a SUBTYPE of an existing type, or a NEW type?
② new type → add a subClassOf to the container-level registry ontology
③ subtype   → add a subClassOf to the domain ontology
④ does it need a new relation or axiom?
⑤ structural check → 0 errors
\`\`\`

**New MSM**
\`\`\`
① Mech (deterministic) or Semi-Mech (model in the loop)?
② which ONE skill owns it?
③ consistent with the container's BuiltinTool/MSM type in the architecture ontology?
④ record it in that skill's ontology entry
⑤ register it through the container's registry (never by editing the registry file directly)
\`\`\`

**Retrofit — modelling a system that already exists** (the reverse direction; the three workflows above
assume the model comes first, which is not how it usually goes)

\`\`\`
① draw the boundary as an ACTIVITY, not as a system ("developing X", not "the whole of X")
② enumerate the artefacts by MEASURING, never by recall — list the files, the registry entries, the
  running processes; a model built from memory reproduces memory's errors
③ classify each artefact: type · instance · property. Only types get a class
④ for every type: rigidity + identity. A role/stage is anti-rigid; a thing that persists is rigid
⑤ write the relations that carry OWNERSHIP and CAUSALITY first (owner · produces · guards · proves)
⑥ write axioms from the rules you ALREADY follow but never wrote down — that is where the payout is
⑦ record known failure modes as INSTANCES, not as prose paragraphs
⑧ strict check → 0 errors; then the semantic review
\`\`\`

🔴 **The tell that a retrofit model is worth keeping**: running it surfaces at least one
**contradiction in the existing system** — a thing owned in two places, a declared value that does not
match reality, a rule everyone follows that nobody wrote down. A model that only restates what was
already obvious has not earned its maintenance cost.

## 10. Universal axioms (violating any of these is a defect, not a style choice)

| Axiom | Content | Consequence of violation |
|---|---|---|
| Unique name | two skills may not share a name | routing becomes ambiguous |
| SKILL.md required | every skill has a SKILL.md | agents cannot locate the domain knowledge |
| Dependency complete | using another skill's tool ⇒ declare the dependency | implicit coupling surfaces at runtime (H_op↑) |
| MSM ownership | every MSM belongs to exactly one skill | the MSM cannot be indexed |
| Dependency acyclic | \`skillDependsOn\` must not form a cycle | load order becomes undefined |

**Axiom discipline**: axioms are named (\`AX-*\`), individually citable, and each carries a rationale.
Breaking an axiom is allowed only by stating the break explicitly and recording the reason.

### The axiom rule expression (what \`M8\` parses, and what \`M9\` resolves against)

\`sr:rule\` is **not free text** — it is a small expression language:

\`\`\`
expr        ::= implication
implication ::= or_expr ('implies' or_expr)?
or_expr     ::= and_expr ('or' and_expr)*
and_expr    ::= not_expr ('and' not_expr)*
not_expr    ::= 'not' not_expr | comparison
comparison  ::= additive (cmp additive)?          ← at most ONE comparison; it does not chain
cmp         ::= == | != | > | >= | < | <= | in    ← there is no 'not in'; see the traps below
additive    ::= primary (('+' | '-') primary)*
primary     ::= quantifier | func_call | prop_access | literal | '(' expr ')'
quantifier  ::= ('exists' | 'forall') ident 'in' Type ':' expr
func_call   ::= ident '(' (expr (',' expr)*)? ')'
prop_access ::= ident ('.' ident)*
literal     ::= number | 'string' | true | false | null
\`\`\`

🔴 **The property that makes every other trap dangerous**: \`M8\` accepts a rule as soon as a **prefix**
parses. It never requires the input to be consumed to the end, so whatever follows the longest parsable
prefix is **silently dropped** — and \`M9\` then checks only the AST that survived, so the dropped tail is
invisible to **both** checks. Measured, with its control: \`Thing.count >= 1 NoSuchType.x == 1\` passes
**clean**, while the same fragment alone (\`NoSuchType.x == 1\`) raises an M9 warning. And
\`Thing.count >= 1 garbage here\` passes clean. ⇒ **A green check does not mean the whole rule was
understood.** Keep one rule to a single clause; if you suspect a fragment is being dropped, put it alone
in a throwaway axiom — a fragment that complains alone but not in place is a fragment being dropped.

**Traps, each measured against the engine** (\`check --level strict\`, one probe axiom per boundary):

| Trap | What the engine actually does |
|---|---|
| \`exists\` / \`forall\` / \`in\` are **reserved words** | they cannot be used as identifiers or property names: \`ReleaseTag.exists\` ⇒ \`Expected identifier after '.'\`. Express existence through a counted property (\`X.count >= 1\`) instead |
| there is **no \`distinct\`** | \`count(distinct version)\` ⇒ \`Expected ')' after args of count\` (the argument parse stops at \`distinct\`, then hits \`version\`). Put the derived quantity in its own property (\`VersionTriple.distinctCount == 1\`) |
| there is **no \`not in\`** | the operator is unreachable: \`x not in y\` parses as \`x\` and the rest vanishes **with no message**. Write \`not (x in y)\` — verified clean |
| comparisons do **not chain** | \`a >= 1 >= 0\` parses as \`a >= 1\`; the tail is dropped silently. Use \`and\` |
| \`M9\` checks **exactly two things** | (a) dotted paths of **two or more** segments ⇒ **warning** when the head is neither a declared type nor a relation; (b) a quantifier's **type name** ⇒ **error** when undeclared. Single bare identifiers and **function-call names are never checked**: \`noSuchFunction(X) == 1\` and \`noSuchBareThing == 1\` both pass clean ⇒ a mistyped relation inside \`occupies(…)\` is invisible |
| \`M8\` errors are fatal, **M9's property tier is only a warning** | \`check\` can exit non-zero on M8 alone while a wrong head name slips past as a warning ⇒ read the warnings, not just the exit code |

**Rule of thumb**: if a constraint cannot be said in this grammar, it is probably a
**description + rationale** (prose) rather than a rule — say it there, do not bend the syntax.
⚠️ Prose is also the honest place for anything the checks **cannot** see: a constraint the engine silently
drops is worse than an unstated one, because it reads as verified.

## 11. Dispatching a review subagent

Both OEPE review stages run in an isolated context. Three rules make them work:

1. **Mandatory opening block** — the prompt must begin by requiring the subagent to load the ontology
   method (and EAP, for the audit stage). Without it the subagent does not know the standard it is applying,
   and its output is worthless.
2. **Read-only** — the reviewer never edits files. Review and repair are separated: the reviewer reports,
   the human confirms direction, the agent repairs.
3. **Structured output** — one line per finding: \`<ID> [<Severity>] <Finding> — <Evidence> — <Suggestion>\`,
   then a summary: top issues · health grade (A–F) · prioritized repair list. Findings are written to the
   session directory, never into the skill directory.

## 12. Anti-patterns

| Anti-pattern | Why it is wrong |
|---|---|
| modelling **instances** as **types** | the taxonomy inflates and stops carrying meaning |
| an "is-a" relation that fails the **is-a test** in some context | structural checks pass, semantics rot |
| a rigid type with **no identity** | nothing distinguishes its instances (M4) |
| identity resting on a **mutable property** | the entity's identity changes as data changes |
| a child that is **more rigid** than its parent | OntoClean violation (M3) |
| putting **implementation detail** into the domain ontology | the model then tracks code, not the domain |
| a second, competing source of truth for structure | E↓, and the drift is silent |
| writing the model **after** the code | structure is reverse-engineered from accidents |

## 13. Relation to the other praxis frameworks

- **EAP** — how a piece of knowledge should be structured (static quality). Ontology is EAP applied to
  domain structure.
- **CCE** — how structured knowledge keeps evolving without losing coherence (dynamic persistence).
  Ontology is one of CCE's \`ΔH_org\` operators.
- **Neat** — the collaboration protocol for the *design conversation* that produces the model.
`
