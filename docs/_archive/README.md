# docs/_archive — 历史档（**只读区**）

> **本目录 = 已被取代的旧件**。**现行文档在 `../`（`docs/`）**，索引见 [`../README.md`](../README.md)。

## 为什么有这一层（R↓）

`docs/` 曾是**只增不减**的：每一轮适配、每一次 review 都在根上留一份新件，
于是 **81 个条目平铺在同一层**——找"现在哪一份才算数"要逐个打开看。
**分层判据**（与 CCC 侧 `docs/` 同规矩：**现行在 `docs/`，历史移入 `docs/_archive/`**）：

1. **已被更新的同类件取代**（如 0.1.2 轮的两份适配方案 ⇒ 0.1.5 ⇒ 0.1.7 ⇒ **0.2.0-rc.1**），**且**
2. **活引用为零** —— `src/**`、`tests/**`、`bench/**`、skill、README **都不指向它**（逐条 grep 过），**且**
3. **只剩历史记录引用**（`CHANGELOG.md` 的版本条目、其它历史档）。

三条**同时**成立才搬。**只满足 1 或 2 的不搬** —— 例如 `dsh-0.1.5-rc-adaptation-plan.md` 虽已被取代，
但**现行**的 `dsh-0.2.0-rc.1-adaptation-plan.md` 把它当"体裁对齐先例"引用着 ⇒ **它是活引用**，留在 `docs/`。

## 🔴 搬移不改写历史（指针靠本表转译）

历史文档（`CHANGELOG.md` 的旧版本条目、各历史设计稿）里写着**旧路径**——**刻意不改**
（判据："历史真记录不改"：那些行逐字为真，改了就毁了证据）。**旧路径 ⇒ 新路径**：

| 旧路径 | 现路径 | 为什么搬 |
|---|---|---|
| `docs/changelog-draft-v1.28.0.md` | [`changelog-draft-v1.28.0.md`](./changelog-draft-v1.28.0.md) | 🔴 **第二真相源**：它的内容**逐字已在** `CHANGELOG.md` 的 `## v1.28.0` 段里 ⇒ 同一件事有两份家。**全仓零引用**（连 CHANGELOG 都没提它）⇒ 是那份最该走的 |
| `docs/architecture-v0.md` | [`architecture-v0.md`](./architecture-v0.md) | v0 架构稿（守卫映射 §4）；被 `contract-v0.md` 与 CHANGELOG 旧条目引用 |
| `docs/contract-v0.md` | [`contract-v0.md`](./contract-v0.md) | v0 契约稿（C10 条）；指向 §4 的 `architecture-v0` 一并 |
| `docs/dsh-0.1.2-alpha-impact-assessment.md` | [`dsh-0.1.2-alpha-impact-assessment.md`](./dsh-0.1.2-alpha-impact-assessment.md) | 0.1.2-alpha 评估（D13 等待策略）——**已被三代适配取代** |
| `docs/dsh-0.1.2-rc1-adapt-plan.md` | [`dsh-0.1.2-rc1-adapt-plan.md`](./dsh-0.1.2-rc1-adapt-plan.md) | 0.1.2-rc1 适配方案 —— 同上 |
| `docs/dsh-0.1.2-rc1-adapt-report.md` | [`dsh-0.1.2-rc1-adapt-report.md`](./dsh-0.1.2-rc1-adapt-report.md) | 0.1.2-rc1 适配报告 —— 同上 |
| `docs/review/slice-{A..H}-*.md`（8 份） | [`review/`](./review/) | 0.1.5 那一轮的**八分片审计**（190 KB，`dsp-implementation-review.md` 的配套件）。审计所见的问题**已逐条修完或被后继轮覆盖**；⚠️ 引用它的 `dsp-implementation-review.md` 自己也是历史件（"六分片"的说法**在当年就不准**：实有 8 片） |

## 边界

- 🔴 **本目录是只读区**：不再更新、不再引用；需要**现行**结论时回到 `docs/`。
- ⚠️ **搬进来不是"删除"**：文件仍在 git 里、路径可查（`git log --follow -- <新路径>` 追得到搬移前的历史）。
- ⚠️ **反向不自动**：若日后某份归档件重新成为**活引用**（例如要照 0.1.2 轮的体裁办事），
  **把它搬回 `docs/` 并同批删掉本表对应行** —— 否则 `docs/` 的"现行面"又会开始说谎。
