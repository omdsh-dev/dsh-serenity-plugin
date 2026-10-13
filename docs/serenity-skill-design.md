# serenity-skill —— 增强型 skill 标准（设计 v0.2 · **接口已冻结**）

> **地位**：**设计件（方案层＋接口层已定）**，实现未开始。v0.2 = **owner 2026-10-11 对 §8 七个叉口的裁决已逐条折入**（见 §0.1）。
> **归属**：ACC 仓（`AI_LAB/dsh-serenity-plugin/docs/`）—— 三条令的落点全在 ACC 机制面（D23：机制归 ACC，数据与措辞归 CCC）。
> **判据前置**：**改它们要不要发版？要 ⇒ 属本文范围。** 三条令都要 ⇒ **须发版**（D14/D118 默认反转 ⇒ 交付链默认含 npm 发布）。

---

## 0. 怎么读

| 关心什么 | 看 |
|---|---|
| **v0.1 → v0.2 改了什么（含被否项）** | **§0.1** |
| owner 要什么（原话与解读） | §1 |
| 今天实际怎么跑（带源码指针） | §2 |
| 三条令对着哪个缺口 | §3 |
| 方案 · 接口 | §4 · §5 |
| 怎么证明做到了（正控/负控） | §6 |
| 不做什么、边界 | §7 |
| 叉口裁决留档 | §8 |
| 分期与实施清单 | §9 |

**术语**：**披露树** = 分层暴露 skill 内容（一层＝目录/头部，二层＝参考件清单，三层＝按需读正文）。**本体预留口** = ACC 在 skill 目录里保留的固定路径。

### 0.1 v0.2 变更表（逐条对应 owner 裁决）

| 裁决 | 对设计的影响 |
|---|---|
| **Q1 同意** | 预留口 = `<skill>/skill.ttl`（与 `SKILL.md` 并列）。**不变。** |
| **Q2 同意** | 二层 = **文件名 ＋ 首个 `#` 标题**；范围 = `references/` **一级全部文件**。**不变。** |
| **Q3 三条都包括** | 注入落点 = **A/B/C 三条全做**。**不变**（原倾向即此）。 |
| **Q4 A/B 可以；C 归 creator** | 🔴 **改动**：`skill.ttl` 的**语义档（C）从 skill 机制里移出**，归 **creator 工具**（不在每请求跑、不进注入）。机制只做 **A 结构档 ＋ B 引用档**（纯机械）。 |
| **Q5 要一个 `serenity-skill-creator` tool** | 🔴 **改动（覆盖我的原倾向）**：creator = **新增一个 ACC 工具 `serenity-skill-creator`**（**工具面 13 → 14**）。**否决**原倾向的「文本进 `praxis` 第 5 段 ＋ 机械动作进 `ontology` 子命令」。 |
| **Q6 静默 · CCC 自行修正 · 继续兼容普通 skill** | 🔴 **改动**：**取消**「旧名兼容读取 ＋ 响亮告警」。机制**只认 `skill.ttl`**；旧的 `*-domain.ttl` 由 **CCC 自行修正**（ACC 不催、不告警、不代读）。**且「无 `skill.ttl`」＝普通 skill ⇒ 全程无声、零报错**（这是硬要求，见 J9）。 |
| **Q7 不做** | 🔴 **删除**「ttl 声明本 skill 的文字构成」。理由（owner 原话）：**ttl 是 skill 构建与维护的有效方法**，不是文字文件的登记簿。第二层索引**纯粹扫目录**（不读 ttl 决定列什么）。 |

---

## 1. 需求层（owner 三条令，逐字 ＋ 解读）

owner 2026-10-11 原话（逐字）：

> 我想做的，在dsp级别，升级skill能力；**1.** skill提供本体建模预留口，一个skill如果完成本体建模，则在目录放置固定名称的ttl，该ttl作为skill文字内容总约束 **2.** skill机制进行增强，注入除了标准的SKILL.md头外，skill目录的reference目录内的*.md文件名也要加载，也就是将skill做成两层披露树 **3.** 扩展skill相关tool，将基于本体论建模的skill编写和优化方法进行交代，其实也就是我们这种增强型skill的creator； 123本质都是在增强skill标准，我们称之为serenity-skill吧

| # | 需求 | 解读（**已与 owner 对齐**） |
|---|---|---|
| **令 1** | 本体建模预留口 ＋ 固定名 ttl ＝ 该 skill 文字内容的**总约束** | ACC 保留固定路径 `<skill>/skill.ttl`；有它 ⇒ 该 skill **已建模**，其文字内容以该 ttl 为总约束。**「预留口」的关键 = 不靠任何注册表也能被找到**（今天找不到，见 §2.3）。 |
| **令 2** | 两层披露树：除 SKILL.md 外，`references/*.md` 的**文件名**也要加载 | 一层 = 头部/摘要（已有）；**二层 = 参考件清单**（现在没有）；三层 = 按需读正文（宿主已给语义，但**从不枚举**，见 §2.4）。**只加载文件名，不加载正文。** |
| **令 3** | 扩展 skill 相关 tool ＝ 我们的 **creator** | **一个专门的工具 `serenity-skill-creator`**：承载 ①**方法**（怎么写/怎么优化）②**机械动作**（脚手架/检查/预览）③**语义档 C**（文字与 ttl 的合规审查）。 |
| — | 三者合成一个标准名：**serenity-skill** | 是**标准的名字**，不是一个工具的名字 ⇒ 需要**标准正文**（在本设计 §5）＋ **合规入口**（= creator 工具）。 |

---

## 2. 现状取证（今天实际怎么跑 —— 全部读源码，非推断）

### 2.1 skill 有**三条互不相干**的通路

| 通路 | 触发 | 内容 | 代码 |
|---|---|---|---|
| **A. 入口 skill 注入**（每请求） | 该 CCC 的顶层入口（`*-serenity`） | `SKILL.md` **全文，不截断**（只经 `sanitizeSkillContent` 滤掉治理行 `安全模式｜safe-mode｜.serenity-safe-on`） | `src/skills-discovery.ts:findEntrySkills()` ＋ `seams/system-prompt.ts:entrySkillSectionText()` |
| **B. 轨迹声明注入**（每请求） | `SESSION.md` frontmatter 的 `skills:` ∪ CCC 的 `trajectory.skills` | 各 skill 的 `SKILL.md` **全文**，**合计上限 32 KB**，超出截断 | `src/trajectory-skills.ts:buildTrajectorySkillsSection()` |
| **C. 目录 provider**（按需） | 模型调 `skill` 工具 / 用户显式调用 | `SKILL.md` 正文，包成 `<skill_content>` | `src/seams/opencode-skills.ts` → 宿主 `SkillRegistry` |

🔴 三条通路的注入形态彼此独立 ⇒ **令 2 只改一条，另外两条就没有第二层**（Q3 裁决 = 三条全做的由来）。

### 2.2 skill 目录的现行结构约定

```
.opencode/skills/<name>/
├── SKILL.md            ← 唯一被解析的文件（frontmatter: name/description/whenToUse）
├── references/         ← 参考件（**今天完全不被枚举**）
└── scripts/            ← MSM 脚本（由 mech-registry.json 另行登记）
```

- frontmatter 解析器**只认三个键**（`src/skills/opencode-scan.ts:parseFrontmatter`）——多写的键**静默忽略**。
- `resourceBase` 已设为 skill 目录本身（`opencode-skills.ts` L39）⇒ 宿主会告诉模型「相对路径按此目录解析」。

### 2.3 本体与 skill 的现行关系（**令 1 的缺口在此**）

实测 `.opencode/skills/**/*.ttl` = **16 份**，其中 **14 份**落在各 skill 的 `references/` 下，**命名各不相同**（11 份 `-domain`、3 份不用；如 `home-media-acquisition.ttl`／`home-video-production.ttl`）。

1. **「一 skill 一领域本体」这个事实已经存在**，缺的只是**固定名**（Q1 直接命中）；
2. 🔴 **没有任何机制知道「哪份 ttl 属于哪个 skill」** —— 注册表 `serenity-skills-ontology.ttl` **没有**指向领域 ttl 的属性；链接是**单向**的。⇒ **今天只能靠人记得**。
3. 🔴🔴 **领域 ttl 的 `sr:imports` 根本没人读** —— 见下方实测。

**实测（含正控）**：

| 输入 | `explain` 的 imports 行 | 结论 |
|---|---|---|
| `home-rhetoric/references/home-rhetoric-domain.ttl`（写 `sr:imports true`） | **没有 Imports 行** | 未链上 |
| `serenity-skills-ontology.ttl`（正控，写 `owl:imports <ccc-ontology.ttl>`） | **`Imports: ccc-ontology.ttl`** ✅ | 探针不瞎 |

⇒ 根因（读源码）：引擎**只解析 `owl:imports`**（`src/ontology/engine.ts` L541），领域 ttl 用的是 `sr:imports` ⇒ **14 份领域本体全部没链到基础链，且无任何信号**。

🔴 **这正是「检查没跑＝检查通过」族的现行犯**（本仓两天内已撞见四次）。**令 1 必须在机制上堵死这一族**，否则新预留口会复制同一个坑。

**处置（按 Q6 裁决）**：**ACC 不为旧名做特殊处理**（不兼容读取、不告警）；这 14 份由 **CCC 自行修正**（改名为 `skill.ttl` ＋ 把 `sr:imports` 改成 `owl:imports`）。机制侧只保证：**`skill.ttl` 里缺 `owl:imports` ⇒ A 档报 error**（J2）。

**附带观察（非本次范围）**：`home-rhetoric-domain.ttl` 用 `@base <…/home-rhetoric>` ＋ `:Source`，引擎解析出的类型名是 `<http://home-serenity/ontology/home-rhetoricSource>`（**base 与本地名直接粘连、缺分隔符**），而 `check --level strict` **全绿**。⇒ 骨架**避开此写法**（§5.2 显式声明默认前缀）。

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

- ✅ 宿主**已经承认**「参考件按需加载」的两层模型 —— 令 2 **不是发明新概念**，而是**补上宿主刻意留给 provider 的那一半：枚举**。
- ❌ 宿主**没有**「文件清单」字段：`SkillSummary` / `SkillDefinition` 只有 `resourceBase`（一个**基址**，三种 kind）⇒ 枚举**只能由我们生成并放进 `content`**。
- 🆕 `SkillCandidate` / `SkillDefinition` 有 `metadata?: Readonly<Record<string, unknown>>`（"Parsed optional metadata object from frontmatter"）—— 我们**今天没填**，它是**声明面的天然落点**（§5.3）。

---

## 3. 三条令各自对着的缺口

| 令 | 缺口 | 现状证据 |
|---|---|---|
| 1 | **预留口不存在**：无固定名、无发现机制、声明了也没人读 | §2.3 三条事实 ＋ imports 实测 |
| 2 | **第二层不存在**：`references/` 从不被枚举，模型只能猜文件名 | §2.4。**精确取证**：全仓 `grep references` = 53 处，**没有一处枚举 skill 目录的 `references/` 用于注入**；唯一的枚举在 `src/cro.ts:475`，**对象是轨迹目录**（`AGENT_SESSIONS/<会话>/references/`）、形态 `{name, bytes, mtime}`、**只进 CRO 快照不进注入** |
| 3 | **creator 不存在** | `praxis` 只有 eap/neat/cce/ontology 四段；无「怎么写 skill」的方法，也无脚手架/验证入口 |

---

## 4. 方案层

### 4.1 令 1 —— 本体预留口

| # | 动作 | 针对的失败面 |
|---|---|---|
| 1.1 | **固定名**：`<skill dir>/skill.ttl`（与 `SKILL.md` 并列）。语义 = **本 skill 的本体（领域模型 ＋ 公理）** | 命名漂移 |
| 1.2 | **可发现**：ACC 侧**唯一解析函数** `skillOntologyPath(skillDir)`（照「路径只许有一个出口」的既有教训）—— 不依赖注册表、不依赖任何索引 | 「没人知道哪份 ttl 属于哪个 skill」 |
| 1.3 | **可链**：`skill.ttl` **必须** `owl:imports` 基础链；**链不上 ⇒ error** | 「声明了但没人读」 |
| 1.4 | **可检**：**A1 结构 ＋ A2 链上**（见下），由 creator 工具的 `check` 呈现 | 静默通过 |

**「总约束」的强度（Q4 裁决后的最终形态）**：

| 档 | 内容 | 机械性 | 归属（**裁决后**） |
|---|---|---|---|
| **A1 结构合法** | `check --level strict` exit 0（引擎的 M1–M10） | 纯机械 | **skill 机制（P2 已实现）** |
| **A2 链上基础链** | `explain` exit 0 **且**报告里有 `Imports:` 行 | 纯机械 | **skill 机制（P2 已实现）** |
| **B 引用档** | 「ttl 里的引用必须真实存在」 | 🔴 **不做** —— 引擎已经做了且是**响亮的**（见下） | — |
| **C 语义档** | 「文字内容是否遵守该 ttl 的模型与公理」 | **半机械**（生成逐条可回答问题清单，LLM/人在环回答） | 🔴 **归 creator 工具**（Q4）—— **不进注入、不在每请求跑** |

🔴 **P2 实现期实测修正（2026-10-11，逐条带读数）**：

1. **A1 绿 ≠ 链上了** —— 这是 A2 存在的**唯一理由**。对照（同一引擎、同一天）：
   `home-rhetoric-domain.ttl`（写 `sr:imports`）⇒ `check --level strict` = **✓ exit 0 · All checks passed**，
   而 `explain` **没有** `Imports:` 行；注册表（写 `owl:imports`）⇒ `explain` **打印** `Imports: ccc-ontology.ttl`。
   ⇒ 只看 A1，会把 CCC 侧 **14 份没链上的本体判成合格**。**已立为回归钉**（`skill-ontology.test.ts` 的 J2 负控）。
2. **原设计的「A3 引用可兑现」被删** —— 引擎**已经**在两条路上响亮地做这件事：
   import 目标不存在 ⇒ `check` 报 **`ERR [M10] Ontology file not found: <abs>`**（**exit 1**）／
   `explain` 报 **exit 2 · `ONTO_FILE_NOT_FOUND`**。⇒ 再写一遍 = **同一件事的第二实现**。
   🔵 **而被删的起因值得记**：我原本照源码里那句 `Fall back to loading just this file (no imports)`
   **推断**引擎对缺失 import 是静默的 —— **实测把这条推断打假**（两条路都响亮）。
   ⇒ **D119 同族：照源码的"意图"抄 ≠ 引擎实际怎么行为。**
3. **§5.2 的骨架原文是错的**（`<URI> owl:imports true .`）—— 那样写，引擎会把 import 目标读成字面量
   `true`。**正确形式见 §5.2（已改）**，且**相对路径由 creator 的 `create` 计算**，不靠人肉推。

🔴 **诚实边界**：skill 的文字是自然语言 ⇒ **机械上做不到"全量强制"**。**不设计编译器式强制**（做不到，硬做只会造假绿）。

### 4.2 令 2 —— 两层披露树

**一个生成器，三个消费点。**

**生成器**（纯函数，零 DSH 依赖，可单测）：`buildResourceIndex(skillDir) → string`：

```
### 本 skill 的参考件（第二层 · 按需读取）
> 正文不在此处；需要时用 read 打开下列路径（相对本 skill 目录）。

| 文件 | 摘要 | 字节 |
|---|---|---|
| references/00-churchill-method.md | 丘吉尔方法：主轴 | 12,345 |
| references/50-diagnosis-and-loop.md | 诊断与改稿回路 | 8,901 |
| skill.ttl | 🧬 本 skill 的本体约束（已建模） | 6,789 |
```

**硬性规则**（每条都是判据）：

1. **只枚举，不注入正文**（令 2 逐字）。
2. **确定性排序**：按相对路径**字节序**（**不按 mtime**）。
   🆕 **先例**：`src/cro.ts:101` 已有「列 `references/`（name ＋ bytes ＋ mtime）」的形态，本设计**字段照它、排序刻意不用 mtime** —— 快照是**落盘的历史取证**（要时间序），注入索引是**每请求的派生文本**（要稳定）。**同一件事两处取舍相反，这个差异是判据不是巧合。**
3. **有界 ＋ 响亮**：条数/字符各有常量；超出必须显式写「还有 N 项未列出」，**绝不静默截断**。
4. **摘要来源可复现**：取该文件**首个 `#` 标题**（剥 markdown 记号）；取不到 ⇒ 留空，**不编**。
5. **本体文件特殊标注**（缝令 1 与令 2）：`skill.ttl` 存在 ⇒ 该行标 🧬，并在索引顶部加一句「**本 skill 已建模，文字内容以 `skill.ttl` 为总约束**」。
6. **范围 = `references/` 一级条目 ＋ `skill.ttl`**（`.md` 给标题、非 `.md` 只给名）；**无可列项 ⇒ 整块不产出**（规则的**一般化**：`references/` 与 `skill.ttl` 都没有时，空标题只是噪声）。
   🔴 **2026-10-11 修订（实施 P1a 时由**真实输入**逼出，非推测）**：本规则原写「递归不进子目录」，**被实测推翻** —— 真实 `references/` 下确有**内容目录**：`home-rhetoric/references/corpus-subject-own`（**3 文件 / 190,161 B**，正是 owner 自己的语域语料）／`family-profiles/references/baby-handlebook`／`home-serenity/references/diagram-lab`。只写一句「另有 N 个子目录未列出」而**不给名字 = 不可行动**（模型知道有东西、却无法去读）。
   ⇒ **改为：子目录列一行（名字 ＋ 其下文件数 ＋ 汇总字节），仍不展开、仍不读正文** —— 仍在裁决 Q2「只披露名字、不注入正文」的意图内。**若 owner 认为这是越界，回退点即本段**（退回"只计数不给名"）。

**三个消费点**（Q3 裁决 = 三条全做）：

| 点 | 位置 | 形态 |
|---|---|---|
| A | `seams/system-prompt.ts` 的入口 skill section（order −50） | 入口 `SKILL.md` 全文 ＋ 其资源索引 |
| B | `trajectory-skills.ts`（order −45） | 每个声明 skill 的 `SKILL.md` 全文 ＋ 其资源索引 |
| C | `opencode-skills.ts` 的 `provider.get()` 的 `content` | 同上（`skill` 工具路径也带第二层） |

**预算**（必须显式）：A 无上限（入口全文，实测 ≈43 KB）、B 上限 32 KB。索引按「每 skill ≤ 40 行 / 4 KB」封顶；截断点写进注入文本（沿用既有 `truncateContent` 的 "…(truncated…)" 形态）。

### 4.3 令 3 —— creator ＝ 新工具 `serenity-skill-creator`

**工具面 13 → 14**（Q5 裁决）。子命令（方法 ＋ 机械 ＋ 语义三半都在它身上）：

| 子命令 | 归哪半 | 做什么 | 机械性 |
|---|---|---|---|
| `guide` | **方法** | 印《serenity-skill 编写与优化方法》：何时该建模/何时不该；预留口骨架；两层披露树的写文件习惯；从领域散文到 ttl 的步骤（**不重复 `praxis ontology` 的内容，只指路**）；优化回路 | 文本 |
| `create <name>` | **机械** | 按规范生成 skill 骨架（`SKILL.md` ＋ `skill.ttl` 骨架 ＋ `references/`），并**把 `owl:imports` 基础链写对** | 写文件 |
| `check <skill>` | **机械** | 跑 **A 结构档 ＋ B 引用档**，出**分档报告** | 纯机械 |
| `review <skill>` | **语义** | **C 档**：把 `skill.ttl` 与基础链合并 ⇒ 生成「文字 vs 模型/公理」的**逐条问题清单**（复用 `compliance` 既有形态） | 半机械 |
| `index <skill>` | 机械 | 把 §4.2 生成器的结果打出来（**写文字前先看模型会看到什么**） | 纯机械 |
| `status` | 机械 | 全 CCC 一览：哪些 skill 已建模、哪些是普通 skill（**普通 skill 不是异常**，见 J9） | 纯机械 |

🔴 **命名说明**：本名字由 owner 给定（含 `check`/`review`/`index` 等非"创建"动作）。**不另起名、不再提请**。

---

## 5. 接口层（**已冻结**）

### 5.1 目录布局

```
.opencode/skills/<name>/
├── SKILL.md                     ← 第一层（已有）
├── skill.ttl                    ← 🆕 预留口（令 1；固定名；**唯一被认的名字**）
├── references/
│   ├── 00-….md                  ← 第二层：**只枚举文件名 ＋ 首标题**
│   └── <旧名>-domain.ttl        ← 普通参考件（**机制不特殊对待**；由 CCC 自行改名，Q6）
└── scripts/                     ← 不变
```

### 5.2 推荐骨架（`skill.ttl`）

```turtle
@prefix sr:   <http://home-serenity/ontology#> .
@prefix owl:  <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix :     <http://home-serenity/ontology/<skill-name>#> .   # 🔴 显式默认前缀（避开 @base 粘连）

# 令 1.3：**必须**链上基础链。🔴 形式 = `owl:imports <相对路径>`（相对**本文件所在目录**解析）
:onto a owl:Ontology ;
   sr:name "<skill-name>" ;
   owl:versionInfo "0.1.0" ;
   owl:imports <../home-serenity/references/serenity-skills-ontology.ttl> .
```

🔴 **两条实测约束（P2 期定的，照抄别改）**：
1. **必须**用 `owl:imports` —— 引擎**只解析它**；写 `sr:imports` **不会被读**，而且 `check` 对它**照样报全绿**
   （见 §4.1 实测 ①）⇒ 这正是 A2 那一档存在的理由。
2. **不能**写成 `<URI> owl:imports true .` —— 那样引擎会把 import 目标读成**字面量 `true`**。
   （这是本设计 v0.2 的原文，**是实现期查出来的错**，留此一行做墓碑。）
   ⇒ **相对路径不靠人肉推**：由 creator 的 `create` **从 skill 目录算到顶层 skill 的
   `references/serenity-skills-ontology.ttl`**（ACC 知道 CCC 根与顶层 skill 名）。
   ⚠️ 上例的 `home-serenity` 是**本 CCC 的顶层 skill 名**；别的 CCC（如 `tiangong-serenity`）按同规则由 `create` 算。

### 5.3 声明面（把预留口暴露给宿主，零成本）

`SkillDefinition.metadata`（宿主已支持、我们**今天没填**）：

```jsonc
{ "serenity": { "ontology": "skill.ttl", "resources": 8, "modeled": true } }
```

用途：让 `skill` 工具路径与未来消费方**不必读文件系统**就知道「已建模／有几个参考件」。

### 5.4 检查输出（**三态必须互可分辨**）

```
✅ 已建模且通过      check  skill.ttl  ✅ parse ／ ✅ strict ／ ✅ 链上基础链 ／ 引用 12/12
⬜ 普通 skill        status 无 skill.ttl —— **未建模**（这不是"检查通过"，也不是异常；J9）
❌ 建模了但没跑成    check  skill.ttl **存在但读不出／未链上** ⇒ error（**绝不许与上面两行同形**）
```

### 5.5 工具面变更清单（照「加一个工具＝四处同批」的既有教训）

| # | 位置 | 改动 |
|---|---|---|
| 1 | `src/invariant.ts:REGISTERED_TOOLS` | 13 → 14 |
| 2 | `dsh.plugin.json` 的 `contributes.tools` ＋ 描述里的工具数 | 13 → 14，**点名**（不用"后 N 个"那种位置指代） |
| 3 | `seams/system-prompt.ts` 的工具行 | 新增一行 |
| 4 | `tests/register.test.ts`（注册次数 12/13 ⇒ 13/14）＋ `tests/invariant.test.ts`（清单样本） | 同步 |
| 5 | `README.md` 的工具表 | 加一行 |

---

## 6. 判据与验收（每条都要正控 ＋ 负控）

| # | 判据 | 正控 | 负控 |
|---|---|---|---|
| J1 | 固定名可发现 | 放 `skill.ttl` ⇒ 被找到 | 放 `foo.ttl` ⇒ **不**被当预留口 |
| J2 | 链上基础链被真检查 | 写 `sr:imports`（**CCC 侧 14 份的真实形态**）⇒ **A1 照样绿、A2 红** ⇒ error（今天**没人看**） | 写对 `owl:imports` ＋ 目标存在 ⇒ 两档全绿 |
| J3 | 三态可分辨 | 普通 skill／有 ttl 但坏／有 ttl 且好 ⇒ **三种输出各不相同** | — |
| J4 | 索引只枚举不注入正文 | 索引含文件名 | 注入文本**不含** `references/*.md` 的**正文**（字节级比对） |
| J5 | 索引确定性 | 同目录跑两次 ⇒ 逐字相同 | 改 mtime ⇒ **输出不变** |
| J6 | 有界且响亮 | 超上限 ⇒ 含「还有 N 项未列出」 | 未超 ⇒ **无**该句 |
| J7 | 三条通路都带第二层 | A/B/C 各断言一次 | 关掉生成器 ⇒ 三处**同时**退化（证明同一来源） |
| **J9** | 🔴 **普通 skill 全程无声**（Q6 硬要求） | 无 `skill.ttl` 的 skill：注入照常、**零告警、零误差** | 有 `skill.ttl` 且坏的 ⇒ **必须响**（负控证明"静默"只针对未建模，不是普遍静默） |
| J10 | 工具面四处一致 | `REGISTERED_TOOLS` ＝ `contributes.tools` ＝ 14 | 改动一处 ⇒ 既有 `verifyToolConsistency` 报错 |
| J8 | 零回归 | 既有 `test` 全绿；`pack-check` 文件数按预期增 | — |

🔴 **J2 是本设计的回归钉**：它是本次实测发现的**真实缺陷**（14 份领域本体未链），必须钉死。
🔴 **J9 是 Q6 的机械表达**：**「未建模」不是错** —— 增强必须对**普通 skill** 完全向后兼容。

---

## 7. 边界与否决项

**不做**：

- ❌ **不改宿主 DSH**（D4）。`SkillRegistry` / `renderSkillContent` 一律**照用**，枚举由我们生成。
- ❌ **不做编译器式强制**（§4.1 已给理由）。
- ❌ **不引入新依赖**：frontmatter 沿用现有最小解析；ttl 沿用 `ontology/engine.ts`（纯 node 内建）。
- ❌ **不把 `references/*.md` 正文注入**（令 2 逐字）。
- ❌ **不为索引新建真相源**：索引**派生**（每次现算或按目录指纹缓存），**不落盘成清单**（一落盘就会漂）。
- ❌ **不读旧名 `*-domain.ttl` 作为"本体"**（Q6）：引擎**只认 `skill.ttl``**；旧名由 CCC 自行修正。
- ❌ **不告警旧名**（Q6：静默）。
- ❌ **ttl 不承担"文字构成登记"**（Q7 不做）。

**被否（v0.1 的倾向，留档以免重提）**：

| 被否项 | 否的理由 |
|---|---|
| 方法文本进 `praxis` 第 5 段 | owner Q5：要一个**专门工具** `serenity-skill-creator` |
| 机械动作进 `ontology` 子命令 | 同上 —— 与 creator 拆成两处会让"标准"没有单一入口 |
| 旧名兼容读取 ＋ 响亮告警 | owner Q6：**静默**，CCC 自行修正；且增强后仍兼容普通 skill |
| ttl 声明「本 skill 的文字由哪些文件构成」 | owner Q7：**不做**（ttl 是构建与维护 skill 的方法，不是文件登记簿） |

**边界（D23）**：**约定名、生成器、注入、检查、工具 ＝ ACC**；**`skill.ttl` 的内容、`SKILL.md`、`references/*` ＝ CCC**。

**风险**：

| 风险 | 处置 |
|---|---|
| 注入预算膨胀（入口已 43 KB） | 索引按 skill 封顶 ＋ 超限响亮；实施前先量一次真实总量 |
| 三个消费点漂移 | 一套生成器 ＋ J7 |
| 宿主升级改了 `skill_resources` 语义 | 并入既有「DSH 升级必查」清单（D110 那条长期纪律） |
| 工具面计数失真（v1.52.1 有过一次） | §5.5 五处清单 ＋ J10 |

---

## 8. 叉口裁决留档（owner 2026-10-11）

| # | 裁决 | 原倾向 → 结果 |
|---|---|---|
| Q1 | **同意** | `<skill>/skill.ttl` ⇒ 照准 |
| Q2 | **同意** | 文件名＋首标题、`references/` 一级 ⇒ 照准 |
| Q3 | **三条都包括** | A/B/C 三点全做 ⇒ 照准 |
| Q4 | **A/B 可以；C 包含在 creator 里** | 原「C 留机制内」⇒ **改为归 creator** |
| Q5 | **要一个 `serenity-skill-creator` tool** | 原「praxis 段＋ontology 子命令」⇒ **整体改成一个新工具**（工具面 13→14） |
| Q6 | **静默，CCC 自行修正，仍兼容普通 skill** | 原「兼容期＋响亮告警」⇒ **改为静默＋只认固定名＋普通 skill 全程无声** |
| Q7 | **不做** | 原「一期不做、二期再说」⇒ **彻底不做**（写入否决项） |

---

## 9. 分期与实施清单

| 期 | 内容 | 依赖 |
|---|---|---|
| **P1** | 生成器 `buildResourceIndex` ＋ **三个消费点** ＋ J4~J7、J9 | 无（独立、便宜、**立即可感知**） |
| **P2** | 预留口解析 ＋ A1/A2 档检查 ＋ J1~J3 ＋ **J2 回归钉** | ✅ **已实现**（`src/skills/skill-ontology.ts` ＋ 8 例判据；**本档不发版**：库层无对外面 ⇒ 与 P3 同批发 v1.54.0）｜依赖 P1（索引要标 `skill.ttl`） |
| **P3** | 工具 `serenity-skill-creator`（guide/create/check/review/index/status）＋ §5.5 五处 ＋ J10 | ⏳ 依赖 P2（`check`/`review` 调 P2 的检查） |

**每期都须发版**（§0 判据前置）。**CCC 侧配套**（不由 ACC 做）：把 14 份 `*-domain.ttl` 改名为 `skill.ttl` ＋ `sr:imports` 改 `owl:imports`（Q6 的「CCC 自行修正」）。

---

## 附：本次取证用到的可重跑命令

```bash
find .opencode/skills -name '*.ttl'          # 现状：16 份、命名漂移

# 🔴 缺陷复现（含正控）：领域中文本体**没有** Imports 行，注册表**有**
ontology(command="explain", path=".opencode/skills/home-rhetoric/references/home-rhetoric-domain.ttl")
ontology(command="explain", path=".opencode/skills/home-serenity/references/serenity-skills-ontology.ttl")

# 宿主给好的缝（skill_resources / "Load referenced resources only as needed"）
#   @deepseek-ai/dsh-skill/lib/index.js  L57-81  renderSkillContent / renderResourceHint
```

---

## 11. A3 分层抽象树档（v1.55.0 新增；owner 2026-10-12 令）

**来源**：owner 令「**根据本次经验完善 serenity-skill-creator；确保未来创建和改进 skill 都保持 EAP
分层抽象树结构**」。触发事故 = 同一天把 dsp 开发 skill 的 `SKILL.md` 切成 3.4 KB 的"导航层" ⇒
**顶层只指向下、不说顶层的话**（树倒置）。事后该 skill 按"顶层归位（hoist）"修好。

**接口变化（本设计件 §4.3／§5／§6 的补充，不改变既有条款）**：

| 面 | 变化 |
|---|---|
| `guide` | 增《分层抽象树（EAP）》一节：三层树 ＋ 四条硬规矩（顶层说顶层的话 ／ 不许自称导航层 ／ 顶层是地图 ／ 一条内容只有一个家）＋ 事故作为反例 |
| `create` | 骨架 `SKILL.md` = **带顶层骨架**（身份与边界／用途与触发／领域模型（形状）／永远成立的约束／抽象树读法表／相关技能） |
| `check <name>` | 打印 **A3 → A1/A2**；**A3 对每个 skill 都适用**（与有无 `skill.ttl` 无关），A1/A2 仍只对已建模者适用（**J9 未动**） |
| `status` | 增 **A3 存量一览**（通过 N ／ 总数 M ＋ 未过前 12 个）；**只报不拦**（「上闸分两步：先量存量、再决定当不当门」） |

**A3 三条判据**（`src/skills/skill-layering.ts`，纯逻辑、零 DSH 依赖）：

- **A3-1 顶层非桩**：顶层正文（**已扣** frontmatter 与生成的导航块）≥ **2,048 B**。
  🔴 扣生成物是判据的关键 —— 否则一份大清单会把桩撑"厚"（有专门用例钉住）。
- **A3-2 顶层不自述"只是导航层"**：事故的**直接症状**；正常 skill 不会写 ⇒ 几乎不假阳。
- **A3-3 顶层是地图**：`references/` 一级的 `.md` 必须**在 SKILL.md 里被点名**。

**判据面**：`tests/skill-layering.test.ts`（10 例；A3-1／A3-2／A3-3 各自**正控＋负控**、
导航块与 frontmatter **不计入**顶层正文、无 SKILL.md 不抛、渲染带可行动指引）＋ **真实输入件**
（跑真实 CCC 的 38 个 skill：CCC 根守卫 ／ 探针不瞎 ／ **回归钉** = `dsh-serenity-plugin-development`
必须过 A3）。

🔴 **编号消歧**：本档的 **A3** 与 v1.54.0 记录里那个**已下线的旧 A3（"引用可兑现"）不是同一档** ——
旧那条照引擎源码"意图"推断、实测打假后**决定不写第二实现**；本条是**新立的分层形态档**。
