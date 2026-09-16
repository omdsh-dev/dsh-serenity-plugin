# dsp 提示词注入整理 —— 可砍候选（待所有者审核）

> **来源**：所有者令 2026-09-16（S142 §0e）：「整理下我们 dsp 做的所有提示词注入，找到可以砍掉的候选
> （口径是 **没有必要 / 冗余 / 对 LLM 造成了干扰**），**我来审核**是否砍掉」
> **状态**：**只出候选与理由，未改一行代码**。每条候选等您裁决。
> **取证方法**：不凭印象 —— 用一次性测量稿（`tests/_measure-injection.test.ts`，跑完即删）
> 在**本机 home-serenity 实况**下逐块称重，见下方体量表。

---

## 1. 体量表（**先看这个，它决定了砍哪里才有意义**）

测量口径 = 字符数（home-serenity 实况，2026-09-16）。**全文装配 = 45 504 chars / 825 行**。

| # | 注入块 | chars | 占全文 | 性质 | 出处 |
|---|---|---:|---:|---|---|
| 1 | **entrySkillSection**（CCC 的 `home-serenity/SKILL.md` **全文**） | **33 498** | **73.6%** | 每轮 | `system-prompt.ts:408` |
| 2 | metaphorBlock（星舰隐喻十条） | 3 258 | 7.2% | 每轮 | `:269` |
| 3 | cceBlock（CCE 学科陈述） | 2 300 | 5.1% | 每轮 | `:124` |
| 4 | toolsBlock（工具清单 + MSM 用法） | 2 164 | 4.8% | 每轮 | `:98` |
| 5 | principlesBlock（含 MSM 三原则） | 1 612 | 3.5% | 每轮 | `:181` |
| 6 | identityBlock（ACC 身份 + 平台说明） | 1 051 | 2.3% | 每轮 | `:67` |
| 7 | safeModeBlock（safe-mode ON 时） | 744 | 1.6% | 条件 | `:349` |
| 8 | eapBlock（EAP 三性质） | 566 | 1.2% | 每轮 | `:243` |
| 9 | **accMessage**（对话消息流侧身份锚点） | 320 | 0.7% | 播种/压缩后 | `context.ts:89` |
| 10 | localstoreBlock | 296 | 0.7% | 每轮 | `:383` |
| 11 | sessionBlock | 0 | 0% | 条件 | `:439` |

> **读表要点**：**第 1 行就是全部问题**。其余十块加起来 12 006 chars，只占 26%。
> ⇒ **任何"砍小块"的动作，总量上都是噪音**；真正值得讨论的只有 `SKILL.md` 全文注入这一条。
> （这不代表小块没有**干扰**价值 —— 干扰与体量是两回事，见候选 B/C。）

---

## 2. 候选清单（按我建议的优先级）

### 🅰️ 候选 1 —— `SKILL.md` 全文注入（**33 498 chars，占 73.6%**）

**现状**：`entrySkillSectionText()` 把该 CCC 的入口 skill（`home-serenity/SKILL.md`，同轮实测 603 行）
**每轮原样注入**，且代码注释明确写着**不截断**、**有意如此**（对齐 osp）。

**为什么它值得砍**（判据 = 您的口径）：

| 口径 | 判断 |
|---|---|
| **没有必要** | SKILL.md 的主体是**参考性内容**：20 个仓库全景表、技能清单表、路由表、文件布局树、双 `references/` 边界……它是**查**用的，不是**每轮都要在场**的。而 README 自己的定位就是「路由表」——**路由表按需查即可**。 |
| **冗余** | 其中「文件系统布局」「技能清单」等内容**与 ACC 侧注入重复或可探测**（工具 schema 已描述工具；目录结构可用 `container_fs` 现场查）。 |
| **干扰** | 825 行里 603 行是"系统自描述"，**恒定压在前**。核心身份/纪律（约 1/8）被大量参考表格稀释 ⇒ 注意力被摊薄。 |

**可选处置（请择一，或另提）**：

| 选项 | 做法 | 代价 |
|---|---|---|
| **A1 截断** | 注入上限（如 8~12K chars），尾部参考表让模型按需 `read` | 最小的机制改动；需定一个上限值 |
| **A2 分层**（我倾向） | 把 SKILL.md 拆成**薄 root**（身份 + 路由 + 纪律，~150 行）+ `references/` 明细；只注入薄 root | CCC 侧结构性改动，工作量中等；**与"单真相源"一致**（明细本就该在 references） |
| **A3 不动** | 接受 33K/轮的 token 成本，换取"skill 完全自包含" | 零风险；但每轮都在付 |

> ⚠️ **必须提醒的一条边界**：**这条不是纯 ACC 改动**。`SKILL.md` 是 **CCC 的文件**（`home-serenity` 仓），
> ACC 只负责"注入全文"这个**机制**。所以 A2 是 CCC 侧写作改造，A1 是 ACC 侧机制改动（A1 要发版）。
> 按 **D23**（ACC 管机制 / CCC 管措辞）：**机制侧的旋钮在 ACC，内容侧的瘦身在 CCC**。

---

### 🅱️ 候选 2 —— `principlesBlock` 的 MSM 三原则（**353 chars**，**设计上已有开关但未启用**）

**现状**：`principlesBlock(root, omitMsmPrinciples = false)` —— **这个开关就是为砍它而存在的**，但
`serenitySystemPrompt()` 调用时**没传 true**（`:495`），于是：

- ACC 注入：`MSM principles — machinery before improvisation:` + Determinism first / Single source of truth / Registered to act
- CCC 的 `SKILL.md`：**同一组原则，措辞不同**（「确定性优先」「单真相源」「已注册才可执行」）

**判断**：**纯冗余**（同一原则两份文本 = 多一处会漂移的真相）。**且修复成本几乎为零**：
传 `omitMsmPrinciples=true` 即可（前提：确认该 CCC 的 SKILL.md 确实覆盖了这三条 —— 本机属实）。

**风险**：低。**需发版**（ACC 机制改动）。

---

### 🅲 候选 3 —— `identityBlock` 的**陈旧引用**（**不是砍，是订正**；~1~2 行）

identityBlock 末尾写：

> `Additional MSMs registered by this CCC are available — call msm("<name>") to execute or discover them (see the "Serenity Tools" heading below).`

**问题**：它把 MSM 能力**指到 toolsBlock 的工具清单标题**上 —— 但 toolsBlock 里列的是
**ACC 内置工具**（`container_fs` / `msm` / `handyman`…），**MSM 是 CCC 注册的另一层**（84 个），
两者不是一回事。⇒ **对 LLM 是干扰**（把一个东西指到另一个东西的名字下）。

**建议**：改写该行，指向 `msm()`（无参目录）而不是 `"Serenity Tools"` 标题。

---

### 🅳 候选 4 —— `metaphorBlock`（**3 258 chars**）：**可砍一半，但需您裁**

**现状**：十条星舰隐喻**每条都有**：`隐喻名 → 断言` + 展开散文 + `Verdict:` 一句。

**三个可选强度**（体量/风险递增的取舍，**我不替您定**）：

| 强度 | 做法 | 省 | 风险 |
|---|---|---|---|
| D1 | 只删每条末尾的 `Verdict:` 句（10 条） | ~700 chars | 低 —— Verdict 是"判词"的应用示例，非约束本体 |
| D2 | 压缩为「**十条一行式**」清单（保留名字 + 核心断言） | ~2 000 chars | 中 —— 失去"物理事实"的叙事力，而那正是隐喻的**作用机制** |
| D3 | 整块退化为**指针**（`praxis` 已有 `cce/eap/neat`，可加 metaphor 段） | ~3 000 chars | 高 —— 隐喻**当前每轮在场**；移出后"约束的生动性"要靠工具调用才能拿回 |

⚠️ **我的倾向**：**D1**（低风险、明确删冗余），D2/D3 我不建议现在做 —— 隐喻的设计意图就是
"**每轮在场**的物理约束"，而它的收益恰恰来自"不必调用就能被记住"。

---

### 🅴️ 候选 5 —— `toolsBlock`（**2 164 chars**）：**有冗余与重复，但风险中等**

**发现两处**：

1. **与独立 `principives` 无关** —— 是**"工具面有一处 MSM 例子重复"**：该块自身既列工具，又给
   **MSM 用法四行**（Execute / Inspect / Index / Manage）。但 DSH 的 `msm` **工具 schema 本身就带 description**，
   模型能看到 ⇒ 属**第二次描述**（判据与候选 2 同：单真相源）。
   **实测取证**（`tools/msm.ts:76-80, 93`）：schema 原文已含
   「`name` not found returns matching candidates」「`inspect=true` shows usage/flags without running」
   「no args returns a summary index」—— **与 `MSM call` 四行逐条对应**（partial name / inspect / index）。
   ⇒ 判为**确凿的重复描述**。
2. **`MSM call` 四行 vs 工具清单**：同块内两种颗粒度并列，信息密度不齐。

**判断**：**中度冗余**。可砍 `MSM call` 示例（~4 行 / ~500 chars），
**风险**：当年加它是因为"模型对 msm 参数面理解不稳"（注释 `:95-96` 明写）⇒ **砍之前建议先测**：
若模型仍能正确调用 `msm`，再砍；否则保留。**故我不建议盲砍**。

---

### 🅵️ 候选 6 —— `cceBlock`（**2 300 chars**）：**持保留意见，倾向不动**

**现状**：CCE 学科陈述（五条行为约束 + H_op + "This is persistence engineering"）。

**观察**：它与 `praxis cce` **内容重叠**（同一个框架的两份文本），也与 candidate 2 同属"原则型长文"。
**但我倾向不砍**：CCE 是**本容器存在的理由**（身份层），且 `praxis` 是**按需注入**——
砍掉常驻版、只留按需版，会让"持续在场的行为约束"变成"想起来才在"。

⇒ **登记为观察项，不建议砍**。

---

## 3. 顺带发现（**不是候选，但您该知道**）

1. 🔴 **`compact.ts:29` 的注释是陈旧的**：它写"复用 context.ts 的**完整** ACC 注入消息（简短头 + ACC 5 块 + CCC 顶层 skill 原文）"，
   但 `accMessage` 实测只有 **320 chars**（早已退化为纯身份锚点，见 `context.ts:84` 的 S134 去重说明）。
   ⇒ **注释与实现不符**，会误导后来者（我这次差点按注释去做无关的优化）。建议订正注释（零风险、不需发版决策）。
2. `sessionBlock` 本机为 **0**（未绑定活跃会话时）⇒ 该块在无轨迹绑定时完全不注入，**健康**。
3. **静态块合计 10 951 chars / 动态 34 538 chars**：动态部分几乎全是 `SKILL.md`。
   ⇒ 再次印证：**要动就动 SKILL.md，否则不必动**。

---

## 4. 请裁决（逐条回即可）

| # | 候选 | 体量 | 我的建议 | 您的裁决 |
|---|---|---|---|---|
| A | `SKILL.md` 全文注入 | **33 498**（73.6%） | **A2 分层**（首选）/ A1 截断 / A3 不动 | ？ |
| B | `principlesBlock` MSM 三原则 | 353 | **砍**（开关已存在，几乎零成本） | ？ |
| C | `identityBlock` 陈旧引用 | ~1 行 | **订正**（不是砍） | ？ |
| D | `metaphorBlock` | 3 258 | **只做 D1**（删 Verdict 句）；D2/D3 不建议 | ？ |
| E | `toolsBlock` 的 `MSM call` 示例 | ~500 | **先测再砍**，不盲砍 | ？ |
| F | `cceBlock` | 2 300 | **不建议砍**（登记观察） | ？ |

**发版口径提醒**：B / C / E 是 **ACC 代码改动 ⇒ 需发版**（D14）；A2 是 **CCC 内容改造**（不发版，但要改 SKILL.md）；
D1 属 ACC 文案改动（需发版）。⇒ 建议**攒一批再发**，不必为单条发一版。
