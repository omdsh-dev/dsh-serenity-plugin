# serenity-skill —— 增强型 skill 标准（设计 v0.1 草案）

> **地位**：**设计件，不是实现**。本文给出「owner 三条令」的需求→范围→方案→接口，**待 owner 拍 §8 的叉口后再进入实现**。
> **归属**：本文件在 **ACC 仓**（`AI_LAB/dsh-serenity-plugin/docs/`）—— 因为三条令的落点**全在 ACC 机制面**（D23：机制归 ACC，数据与措辞归 CCC）。
> **判据前置**：**改它们要不要发版？要 ⇒ 属本文范围。** 三条令都要（新增注入面 ＋ 新工具子命令 ＋ 新的检查）⇒ **须发版**（D14/D118）。

---

## 0. 怎么读

| 你关心什么 | 看 |
|---|---|
| owner 到底要什么（原话与解读） | §1 |
| 今天实际是怎么跑的（带源码指针） | §2 |
| 三条令各自对着哪个缺口 | §3 |
| 方案 | §4 · 接口形态 | §5 |
| 怎么证明做到了（含正控/负控） | §6 |
| 不做什么、边界在哪 | §7 |
| **要我拍板的** | **§8** |
| 分期 | §9 |

**术语**：**披露树** = 分层暴露 skill 内容的机制（第一层 = 目录/头部，第二层 = 正文与参考件，第三层 = 按需读取）。**本体预留口** = ACC 在 skill 目录里**保留一个固定路径**并定义其语义。

---

## 1. 需求层（owner 三条令，逐字 ＋ 解读）

owner 2026-10-11 原话（逐字）：

> 我想做的，在dsp级别，升级skill能力；**1.** skill提供本体建模预留口，一个skill如果完成本体建模，则在目录放置固定名称的ttl，该ttl作为skill文字内容总约束 **2.** skill机制进行增强，注入除了标准的SKILL.md头外，skill目录的reference目录内的*.md文件名也要加载，也就是将skill做成两层披露树 **3.** 扩展skill相关tool，将基于本体论建模的skill编写和优化方法进行交代，其实也就是我们这种增强型skill的creator； 123本质都是在增强skill标准，我们称之为serenity-skill吧

| # | 需求 | 我的解读（**要与 owner 对齐的就是这一列**） |
|---|---|---|
| **令 1** | 本体建模预留口 ＋ 固定名 ttl ＝ 该 skill 文字内容的**总约束** | ACC 在 skill 目录**保留一个固定路径**；有它 ⇒ 该 skill 是「已建模 skill」，它的文字内容（`SKILL.md` ＋ `references/*`）**以该 ttl 的模型/公理为总约束**。关键在「**预留口**」＝**不靠任何注册表也能被找到**（今天的 ttl 找不到——见 §2.3）。 |
| **令 2** | 两层披露树：除 SKILL.md 外，`references/*.md` 的**文件名**也要加载 | 第一层 = 头部/摘要（已有）；**第二层 = 参考件清单**（现在**没有**）；第三层 = 按需读正文（宿主已给这层的语义：`<skill_resources>` 明说 "Load referenced resources only as needed"，但**从不枚举**——见 §2.4）。**只加载文件名，不加载正文**。 |
| **令 3** | 扩展 skill 相关 tool：交代「基于本体论建模的 skill 编写与优化方法」＝ 我们的 **creator** | 两半：**方法文本**（怎么写/怎么改进）＋**机械动作**（脚手架、检查、索引预览）。落点待拍（§8-Q5）。 |
| — | 三者合成一个标准名：**serenity-skill** | 这是**一个标准的名字**，不是一个新工具的名字。⇒ 需要一个**规范文件**（标准正文）＋ 一个**合规检查**（谁符合标准）。 |

---

## 2. 现状取证（今天实际怎么跑 —— 全部读源码，非推断）

### 2.1 skill 有**两条互不相干**的通路

| 通路 | 触发 | 内容 | 代码 |
|---|---|---|---|
| **A. 入口 skill 注入**（每请求） | 该 CCC 的顶层入口（`*-serenity`） | `SKILL.md` **全文，不截断**（只经 `sanitizeSkillContent` 滤掉治理行 `安全模式｜safe-mode｜.serenity-safe-on`） | `src/skills-discovery.ts:findEntrySkills()` ＋ `seams/system-prompt.ts:entrySkillSectionText()` |
| **B. 轨迹声明注入**（每请求） | `SESSION.md` frontmatter 的 `skills:` ∪ CCC 的 `trajectory.skills` | 各 skill 的 `SKILL.md` **全文**，**合计上限 32 KB**，超出截断 | `src/trajectory-skills.ts:buildTrajectorySkillsSection()` |
| **C. 目录 provider**（按需） | 模型调 `skill` 工具 / 用户显式调用 | `SKILL.md` 正文，包成 `<skill_content>` | `src/seams/opencode-skills.ts` → 宿主 `SkillRegistry` |

🔴 **三条通路的注入形态彼此独立**：A 与 B 是**我们自己的** `systemPrompt.section`（order −50 / −45），C 走宿主的 skill 子系统。⇒ **令 2 若只改一条路，另外两条路上就没有第二层**（这是 §8-Q3 的由来）。

### 2.2 skill 目录的现行结构约定

```
.opencode/skills/<name>/
├── SKILL.md            ← 唯一被解析的文件（frontmatter: name/description/whenToUse）
├── references/         ← 参考件（**今天完全不被枚举**）
└── scripts/            ← MSM 脚本（由 mech-registry.json 另行登记）
```

- frontmatter 解析器**只认三个键**：`name` / `description` / `whenToUse`（`src/skills/opencode-scan.ts:parseFrontmatter`）。**多写的键被静默忽略。**
- `resourceBase` 已被设为 skill 目录本身（`opencode-skills.ts` L39）⇒ 宿主会告诉模型「相对路径按此目录解析」。

### 2.3 本体与 skill 的现行关系（**令 1 的缺口在此**）

实测 `.opencode/skills/**/*.ttl` = **16 份**，其中 **14 份落在各 skill 的 `references/` 下**，但**命名各不相同**：

```
home-mail/references/home-mail-domain.ttl        home-media/references/home-media-acquisition.ttl
home-gpu/references/home-gpu-domain.ttl          home-video-production/references/home-video-production.ttl
home-rhetoric/references/home-rhetoric-domain.ttl   zhaocai-memory/references/zhaocai-memory-domain.ttl
…（11 份用 `-domain` 后缀，3 份不用）
```

⇒ 三条事实：

1. **「一个 skill 一份领域本体」这个事实已经存在**，缺的只是**固定名**（令 1 直接命中此点）；
2. 🔴 **没有任何机制知道「哪份 ttl 属于哪个 skill」** —— 注册表 `serenity-skills-ontology.ttl` 里**没有**指向领域 ttl 的属性；链接是**单向**的（领域 ttl 自己写 `sr:imports`）。⇒ **今天只能靠人记得**。
3. 🔴🔴 **领域 ttl 的 `sr:imports` 根本没人读** —— 见下方实测。

**实测（本次跑，含正控）**：

| 输入 | `explain` 的 imports 行 | 结论 |
|---|---|---|
| `home-rhetoric/references/home-rhetoric-domain.ttl`（写的是 `sr:imports true`） | **没有 Imports 行** | 未链上 |
| `serenity-skills-ontology.ttl`（正控，写的是 `owl:imports <ccc-ontology.ttl>`） | **`Imports: ccc-ontology.ttl`** ✅ | 探针不瞎 |

⇒ 根因（读源码）：引擎**只解析 `owl:imports`**（`src/ontology/engine.ts` L541 `s.predicate === OWL + "imports"`），而领域 ttl 用的是 `sr:imports`。⇒ **14 份领域本体全部没链到基础链**，且**没有任何信号**。

🔴 **这正是「检查没跑 ＝ 检查通过」那一族的现行犯**（本仓两天内已撞见三次：V3 两次 ＋ 3 条惰性公理）。**令 1 必须在设计上把这一族堵死**，否则新预留口会复制同一个坑。

**附带观察（同批实测，非本次范围）**：`home-rhetoric-domain.ttl` 用 `@base <…/home-rhetoric>` ＋ `:Source`，引擎解析出的类型名是 `<http://home-serenity/ontology/home-rhetoricSource>`（**base 与本地名直接粘连，缺分隔符**）。`check --level strict` 仍**全绿**。⇒ 骨架设计上**不要依赖这种写法**（§5.2 给推荐骨架）；是否算引擎缺陷另立。

### 2.4 宿主已经给好的缝（**令 2 的落点在此**）

读宿主 `@deepseek-ai/dsh-skill` 的 `renderSkillContent()`（`lib/index.js` L57-81），模型看到的规范形态是：

```
<skill_content name="…">
<skill_resources>
Base directory for this skill: <skill 目录>
Resolve relative paths mentioned by this skill against the base directory before using them.
Load referenced resources only as needed.        ← 🔴 宿主明说「按需加载参考件」
</skill_resources>

<skill_instructions>
<SKILL.md 正文，逐字>
</skill_instructions>
</skill_content>
```

⇒ **两条关键事实**：

- ✅ 宿主**已经承认**「参考件按需加载」的两层模型 —— 令 2 **不是发明新概念**，而是**补上宿主刻意留给 provider 的那一半：枚举**。
- ❌ 宿主**没有**「文件清单」字段：`SkillSummary` / `SkillDefinition` 只有 `resourceBase`（一个**基址**，三种 kind：directory/url/opaque），**没有任何列举子文件的位**。⇒ 枚举**只能由我们生成并放进 `content`**（或放进我们自己的注入块）。
- 🆕 `SkillCandidate` / `SkillDefinition` 有 `metadata?: Readonly<Record<string, unknown>>`（"Parsed optional metadata object from frontmatter"）—— 我们**今天没填**。它是**声明面**的天然落点（§5.3）。

---

## 3. 三条令各自对着的缺口（一句话）

| 令 | 缺口 | 现状证据 |
|---|---|---|
| 1 | **预留口不存在**：无固定名、无发现机制、声明了也没人读 | §2.3 三条事实 ＋ imports 实测 |
| 2 | **第二层不存在**：`references/` 从不被枚举，模型只能靠猜文件名 | §2.4。**精确取证**：全仓 `grep references` = 53 处，**没有一处枚举 skill 目录的 `references/` 用于注入**；唯一的 `references/` 目录枚举在 `src/cro.ts:475`，**对象是轨迹目录**（`AGENT_SESSIONS/<会话>/references/`）、形态是 `{name, bytes, mtime}`、**且只进 CRO 快照不进注入** |
| 3 | **creator 不存在**：`praxis` 只有 eap/neat/cce/ontology 四段，没有「怎么写 skill」这一段 | `docs/dsp-module-map.md` §2.4 `tools/praxis.ts` 行 |

---

## 4. 方案层

### 4.1 令 1 —— 本体预留口

**四个动作，缺一不可**（每一条都针对 §2.3 的一个失败面）：

| # | 动作 | 针对 |
|---|---|---|
| 1.1 | **固定名**：`<skill dir>/skill.ttl`（与 `SKILL.md` 并列，一眼可见）。语义 = **本 skill 的本体（领域模型 ＋ 公理）** | 命名漂移 |
| 1.2 | **可发现**：ACC 侧提供**唯一解析函数** `skillOntologyPath(skillDir)`（照 D120/续 31 那条教训：路径只许有一个出口，**绝不写两遍**）—— 不依赖注册表、不依赖任何索引 | 「没人知道哪份 ttl 属于哪个 skill」 |
| 1.3 | **可链**：预留口内的 ttl **必须** `owl:imports` 基础链（`serenity-skills-ontology.ttl` 或经它到 `ccc/cce`）。**链接失败必须响亮**（error，不是 info）——正是 §2.3 那条现状的修法 | 「声明了但没人读」 |
| 1.4 | **可检**：新增检查 **V5（skill 本体一致性）**，三态**必须互可分辨**（见 §6） | 静默通过 |

**「总约束」的真实强度（诚实边界，必须写清楚）**：

skill 的文字是自然语言 ⇒ **机械上做不到"全量强制"**。我们能做到的是**三档**，且**三档必须分档呈现**（不许糊成一句"已检查"）：

| 档 | 内容 | 机械性 |
|---|---|---|
| **A 结构档** | 预留口存在 ⇒ ttl 必须能 parse ＋ `check --level strict` 通过 ＋ 必须链上基础链 | **纯机械**（可直接红） |
| **B 引用档** | ttl 里出现的 skill 名 / 文件路径 / MSM 名**必须真实存在** | **纯机械** |
| **C 语义档** | 「文字内容是否遵守该 ttl 的模型与公理」 | **半机械**：由 `compliance` 生成**逐条可回答的问题清单**，交 LLM/人 在环回答（**这是今天 `compliance` 已有的形态**，令 1 只是把**领域 ttl 也并进来**） |

⇒ **设计口径**：`compliance` 的合并集从「基础链」扩为「**基础链 ∪ 该 skill 的 `skill.ttl`**」⇒ 产出的就是**该 skill 的总约束清单**。**不做**"编译器式强制"（做不到，硬做只会造假绿）。

### 4.2 令 2 —— 两层披露树

**一个生成器，三个消费点。**

**生成器**（纯函数，零 DSH 依赖，可单测）：`buildResourceIndex(skillDir) → string`，产出形如：

```
### 本 skill 的参考件（第二层 · 按需读取）
> 正文不在此处；需要时用 read 打开下列路径（相对本 skill 目录）。

| 文件 | 摘要 | 字节 |
|---|---|---|
| references/00-churchill-method.md | 丘吉尔方法：主轴 | 12,345 |
| references/50-diagnosis-and-loop.md | 诊断与改稿回路 | 8,901 |
| skill.ttl | 🧬 本 skill 的本体约束（已建模） | 6,789 |
```

**硬性规则**（每条都是判据，不是风格）：

1. **只枚举，不注入正文**（令 2 逐字）—— 第二层是**索引**，正文留给第三层的按需 `read`。
2. **确定性排序**：按相对路径**字节序**（不按 mtime —— 它随检出漂移，会让注入文本抖动）。
   🆕 **先例**：`src/cro.ts:101` 已有「列 `references/`（name ＋ bytes ＋ mtime）」的形态，本设计的**列字段照它**（name/bytes 有用），**但排序刻意不用它的 mtime** —— CRO 快照是**落盘的历史取证**（要人读、要时间序），注入索引是**每请求的派生文本**（要稳定、要可比）。**同一件事在两处的取舍相反，这个差异是判据不是巧合。**
3. **有界 + 响亮**：条数上限与字符上限各有常量；**超出必须显式写"还有 N 项未列出"**，**绝不静默截断**。
4. **摘要来源可复现**：取该文件**首个 `# 标题` 行**（剥 markdown 记号）。取不到 ⇒ 留空，**不编**。（若 owner 选 §8-Q2 的"仅文件名"，此列去掉。）
5. **本体文件特殊标注**（把令 1 与令 2 缝起来）：`skill.ttl` 存在 ⇒ 该行标 🧬 并在索引顶部加一句「**本 skill 已建模，文字内容以 `skill.ttl` 为总约束**」。
6. **`references/` 不存在 ⇒ 整块不产出**（不产生空标题噪声）。

**三个消费点**（§2.1 的三条通路，一个都不能漏，否则"两层树"只在一条路上成立）：

| 点 | 位置 | 形态 |
|---|---|---|
| A | `system-prompt.ts` 的**入口 skill** section（order −50） | 入口 `SKILL.md` 全文 ＋ 其资源索引 |
| B | `trajectory-skills.ts`（order −45） | 每个声明 skill 的 `SKILL.md` 全文 ＋ 其资源索引 |
| C | `opencode-skills.ts` 的 `provider.get()` 的 `content` | 同上（这样 `skill` 工具路径也带第二层） |

**预算**（必须显式，今天是隐式的）：A 无上限（入口全文，实测 ≈43 KB）、B 上限 32 KB。索引新增量按"每 skill ≤ 40 行/4 KB"封顶；**预算耗尽的截断点要写进注入文本**（同 §2.2 的 `truncateContent` 已有"…(truncated…)"形态，沿用）。

### 4.3 令 3 —— creator

分两半，**方法文本与机械动作分开落点**（理由：文本随时可改、不该发版；机械动作改代码、要发版 —— 这正是 §7 的边界）：

| 半 | 内容 | 落点（待拍 §8-Q5） | 发版 |
|---|---|---|---|
| **文本半** | 《serenity-skill 编写与优化方法》：① 何时该建模、何时不该；② 固定名预留口的写法与骨架；③ 两层披露树的写文件习惯（命名前缀、首标题即摘要）；④ 从「领域散文」到「ttl」的建模步骤（复用 `praxis ontology` 的方法群，**不重复其内容**）；⑤ **优化回路**：`check` → `compliance` → 改文字 → 再 check | **倾向 `praxis` 第 5 段（`praxis skill`）** —— 与既有四段同构，零新工具面 | 要 |
| **机械半** | ① **脚手架**：按规范生成 skill 目录骨架（`SKILL.md` ＋ `skill.ttl` 骨架 ＋ `references/`）；② **验证**：跑 §4.1 的三档并给**分档报告**；③ **索引预览**：把 §4.2 的生成器结果打出来（写文档前先看模型会看到什么） | **倾向落在 `ontology` 工具**（新子命令），因为 creator 的核心就是本体建模 ＋ 文字合规，与它同域 | 要 |

---

## 5. 接口层（具体形态）

### 5.1 目录布局（缓存前后对比）

```
.opencode/skills/<name>/
├── SKILL.md                     ← 第一层（已有）
├── skill.ttl                    ← 🆕 预留口（令 1；固定名）
├── references/
│   ├── 00-….md                  ← 第二层：**只枚举文件名**（令 2）
│   └── <旧名>-domain.ttl        ← 兼容期：可读，但**响亮告警**
└── scripts/                     ← 不变
```

### 5.2 推荐骨架（`skill.ttl`）

```turtle
@prefix sr:   <http://home-serenity/ontology#> .
@prefix owl:  <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix :     <http://home-serenity/ontology/<skill-name>#> .   # 🔴 显式默认前缀

# 令 1.3：**必须**链上基础链（用 owl:imports —— 引擎只认它）
<http://home-serenity/ontology/serenity-skills.ttl> owl:imports true .

<> a owl:Ontology ;
   rdfs:label "<skill-name> domain ontology"@en ;
   sr:version "0.1.0" .

# …类型与公理，写法沿用 home-rhetoric-domain.ttl（它 check 全绿，是现成范本）
```

🔴 **两处刻意的选择**（都由 §2.3 的实测逼出）：① 用 `owl:imports` **不用** `sr:imports`（后者没人读）；② **显式声明默认前缀**，不靠 `@base` 拼接（后者实测会粘连）。

### 5.3 声明面（把预留口暴露给宿主）

`SkillDefinition.metadata`（宿主已支持、我们**零成本可填**）承载：

```jsonc
{ "serenity": { "ontology": "skill.ttl", "resources": 8, "modeled": true } }
```

用途：让 `skill` 工具路径与未来的消费方**不必读文件系统**就知道「这个 skill 已建模／有几个参考件」。

### 5.4 检查输出（V5，三态互可分辨）

```
✅ 已建模且全部通过        V5  skill.ttl  ✅ parse ／ ✅ check strict ／ ✅ 链上基础链 ／ 引用 12/12 成立
⚠️ 未建模（非错）          V5  无 skill.ttl —— 本 skill 未建模（**这不是"检查通过"，是"没这项检查"**）
❌ 建模了但检查没跑成      V5  skill.ttl **存在但读不出/未链上** ⇒ error（**绝不许与上面那行同形**）
```

---

## 6. 判据与验收（每条都要有正控 ＋ 负控）

| # | 判据 | 正控 | 负控 |
|---|---|---|---|
| J1 | 固定名可发现 | 放 `skill.ttl` ⇒ 被找到 | 放 `foo.ttl` ⇒ **不**被当预留口 |
| J2 | 链上基础链被真检查 | 故意写 `sr:imports` ⇒ **报错**（今天静默） | 写 `owl:imports` ⇒ 通过 |
| J3 | 三态可分辨 | 无 ttl／有 ttl 但坏／有 ttl 且好 ⇒ **三种输出各不相同** | — |
| J4 | 索引只枚举不注入正文 | 索引含文件名 | 注入文本**不含** `references/*.md` 的**正文**（字节级比对） |
| J5 | 索引确定性 | 同目录跑两次 ⇒ 逐字相同 | 改动文件 mtime ⇒ **输出不变** |
| J6 | 有界且响亮 | 超上限 ⇒ 含"还有 N 项未列出" | 未超 ⇒ **无**该句 |
| J7 | 三条通路都带第二层 | A/B/C 三个入口各断言一次 | 关掉生成器 ⇒ 三处**同时**退化（证明同一来源） |
| J8 | 零回归 | 既有 `test` 全绿；`pack-check` 文件数按预期增 | — |

🔴 **J2 是本设计的"回归钉"**：它是本次实测发现的**真实缺陷**（14 份领域本体未链），**必须有一条测试把它钉死**，否则新预留口会重犯。

---

## 7. 边界与否决项

**不做（写入本文件以免后人重提）**：

- ❌ **不改宿主 DSH**（D4）。宿主的 `SkillRegistry` / `renderSkillContent` 一律**照用**，枚举由我们生成。
- ❌ **不做编译器式强制**（§4.1 已给理由）。
- ❌ **不引入 YAML/本体新依赖**：frontmatter 解析沿用现有最小实现；ttl 解析沿用 `ontology/engine.ts`（纯 node 内建）。
- ❌ **不把 `references/*.md` 的正文注入**（令 2 逐字：只要文件名）。
- ❌ **不为索引新建真相源**：索引是**派生**的（每次现算或按目录指纹缓存），**不落盘成清单**（一落盘就会漂）。

**边界（D23）**：**约定名、生成器、注入、检查、工具 ＝ ACC**；**`skill.ttl` 的内容、`SKILL.md`、`references/*` ＝ CCC**。

**风险**：

| 风险 | 处置 |
|---|---|
| 注入预算膨胀（入口已 43 KB） | 索引按 skill 封顶 ＋ 超限响亮；实施前先量一次真实总量 |
| 三个消费点漂移 | 一套生成器 ＋ J7 判据 |
| 旧名 `-domain.ttl` 造成双真相源 | 兼容期**只读不写**，并在 V5 里**响亮建议改名**（不静默） |
| 宿主升级改了 `skill_resources` 语义 | 并入既有的「DSH 升级必查」清单（D110 那条长期纪律） |

---

## 8. 待 owner 拍的叉口（**先用途、后倾向**）

| # | 用途 | 选项 | 我的倾向 |
|---|---|---|---|
| **Q1** | 决定**预留口的固定名与位置**——所有 skill 与文档都要照它写 | ① `<skill>/skill.ttl` ② `<skill>/references/skill.ttl` ③ 复用 `*-domain.ttl`（不固定名） | **①**：与 `SKILL.md` 并列，是"这个 skill 有本体"最直观的信号；②藏在 references 里、且会与索引条目的语义打架；③等于不要固定名 |
| **Q2** | 决定**第二层披露到什么粒度**——直接决定注入体积与可用性 | ① 只要文件名 ② 文件名 ＋ 首个 `#` 标题（一行） ③ 递归 `references/**` 全部文件 | **②，且范围 = `references/` 一级全部文件**（`.md` 给标题、非 `.md` 只给名）：仅文件名对 `50-…md` 这类有意义、对 `README.md` 类无意义；③会引 `scripts/` 噪声 |
| **Q3** | 决定**第二层落在哪几条通路** | ① 只做轨迹声明注入 ② 只做入口注入 ③ **A/B/C 三点全做** | **③**：否则"两层树"只在你恰好走那条路时成立（§2.1 三条通路彼此独立） |
| **Q4** | 决定**"总约束"的强度** | ① 只声明（不检查） ② **A/B 机械 ＋ C 半机械（现有 compliance 形态）** ③ 试图机械强制自然语言 | **②**：③做不到，硬做＝造假绿（本仓已有先例） |
| **Q5** | 决定 **creator 的落点** | ① 文本进 `praxis skill`，机械动作进 `ontology` 新子命令 **②** 独立新工具 `serenity-skill` ③ 全塞进 `container_admin skill` 域 | **①**：文本与机制分开、各按其"要不要发版"归位（§4.3 表） |
| **Q6** | 决定**旧 14 份 `*-domain.ttl` 怎么过渡** | ① 兼容期（可读 ＋ 告警） ② 同批机械改名 ③ 不管 | **①**：改名要动 CCC 的 14 个文件 ＋ 可能的引用；兼容期给足时间，且**告警响亮** |
| **Q7** | 决定**要不要把"文字内容"也建模**（即 ttl 里声明「本 skill 的文字由哪些文件构成」） | ① 要（令 1 与令 2 缝合：索引由 ttl 驱动） ② 不要（索引纯粹扫目录） | **①** 但**分期**：一期先扫目录（便宜、立即可用），二期再让 ttl 可选地声明文字构成——因为"文字构成"本身是熵源（会漂） |

---

## 9. 分期（建议）

| 期 | 内容 | 为什么这个顺序 |
|---|---|---|
| **P1** | 生成器 `buildResourceIndex` ＋ 三个消费点（令 2）＋ J4~J8 | 独立、便宜、**立即可感知**（模型马上知道有哪些参考件）；不依赖令 1 |
| **P2** | 预留口 ＋ 发现 ＋ **链上检查 V5**（令 1）＋ J1~J3 ＋ **J2 回归钉** | 依赖 P1 的索引（要把 `skill.ttl` 标出来）；V5 是本次实测缺陷的修法 |
| **P3** | creator：`praxis skill` 文本 ＋ `ontology` 脚手架/验证/预览（令 3） | 要等 P1/P2 定形，方法文本才写得准（否则写的是想象中的标准） |

**每期都须发版**（§7 判据前置）。

---

## 附：本次取证用到的可重跑命令

```bash
# 现状：16 份 ttl、命名漂移
find .opencode/skills -name '*.ttl'

# 🔴 缺陷复现（含正控）：领域中文本体**没有** Imports 行，注册表**有**
ontology(command="explain", path=".opencode/skills/home-rhetoric/references/home-rhetoric-domain.ttl")
ontology(command="explain", path=".opencode/skills/home-serenity/references/serenity-skills-ontology.ttl")

# 宿主给好的缝（skill_resources / "Load referenced resources only as needed"）
#   @deepseek-ai/dsh-skill/lib/index.js  L57-81  renderSkillContent / renderResourceHint
```
