# docs/ — 索引与分层规矩

> **一句话**：`docs/` 放**现行**件；**历史件在 [`_archive/`](./_archive/)**。本文件回答"**现在哪一份才算数**"。
>
> 🔴 **为什么需要本文件**：这一层曾平铺 **81 个条目**、只增不减 ⇒ 想找"现行规格是哪份"得逐个打开。
> 索引把**分层判据**写死，让下一次加文档的人（和我自己）知道**该放哪、什么该搬走**。

## 分层判据（三条同时成立才搬去 `_archive/`）

1. **已被更新的同类件取代**（例：适配方案按轮取代：0.1.2 ⇒ 0.1.5 ⇒ 0.1.7 ⇒ **0.2.0-rc.1**）
2. **活引用为零** —— `hooks/**`（代码/测试）、`bench/**`、skill、README **都不指向它**（**逐条 grep 过**才算）
3. **只剩历史记录引用**（`CHANGELOG.md` 旧条目、其它历史档）

⚠️ **只满足 1 或 2 的不搬。** 反例：`dsh-0.1.5-rc-adaptation-plan.md` 虽已被取代，但**现行**的
`dsh-0.2.0-rc.1-adaptation-plan.md` 把它当"体裁对齐先例"引用 ⇒ **活引用**，留在本层。

## ① 契约面（🔴 被**代码 / 测试 / README / bench** 直接引用 —— 改它要同批改代码）

> 🔴 **本表 2026-10-19 按 S1~S15 目录重构后的新树重排**（原表仍指旧扁平路径 `tools/trajectory.ts`、
> `wake-scheduler.ts`、`skills-discovery.ts` … —— 那些文件**已不在那些位置**）。
> **判据**：本表只写**现在指得到**的路径；路径对不对由 `tests/docs-ref-gate.test.ts` 机械守着。
> ⚠️ 该门禁只判**文件存在性**，不判"这份文档是否仍然描述现状"——后半句无机械判据，属人工复核档。

| 件 | 谁指着它（现行路径） |
|---|---|
| [`cognitive-trajectory-skill-injection.md`](./cognitive-trajectory-skill-injection.md) | `seams/keeper.ts` · `seams/system-prompt.ts` · `tools/cognitive-trajectory.ts` · `trajectory/skills.ts` · `skills/discovery.ts` · 两个测试 |
| [`metaphor-domain.md`](./metaphor-domain.md) | `seams/system-prompt.ts` · `tests/osp-alignment.test.ts` |
| [`failure-policy.md`](./failure-policy.md) | `tests/failure-policy.test.ts` |
| [`cro-design.md`](./cro-design.md) | `wake/scheduler.ts` · `cro/turns.ts` · `index.ts` · `tools/cognitive-trajectory.ts` · 三个测试 |
| [`cognitive-trajectory-send-message-design.md`](./cognitive-trajectory-send-message-design.md) | `tools/cognitive-trajectory.ts` · `trajectory/core.ts` · `tests/wake-registry.test.ts` |
| [`cognitive-trajectory-scheduling.md`](./cognitive-trajectory-scheduling.md) | `wake/scheduler.ts` |
| [`human-channel-plan.md`](./human-channel-plan.md) | `surface/settings.ts` · `im/inbound.ts` · `tests/human-channel-config.test.ts`（**§11 定案 = 权威规格**） |
| [`weixin-bot-api.md`](./weixin-bot-api.md) | `im/ilink.ts`（协议真相源：§6 媒体 CDN/AES） |
| [`weixin-message-hook-design.md`](./weixin-message-hook-design.md) | `im/hook.ts` |
| [`session-binding-hardening-research.md`](./session-binding-hardening-research.md) | `trajectory/bound.ts`（`ignorable` 的机制取证） |
| [`plugin-development-standard.md`](./plugin-development-standard.md) · [`plugin-development-guide.md`](./plugin-development-guide.md) | `tests/compliance.test.ts` · `dsp-top-level-constraints.md` |
| [`dsh-0.2.0-rc.1-adaptation-plan.md`](./dsh-0.2.0-rc.1-adaptation-plan.md) | `host/contract.ts`（**本轮适配的权威方案**） |
| [`dsp-top-level-constraints.md`](./dsp-top-level-constraints.md) | 不变量 I1~I7 ／ 六层模型 ／ 宿主接触白名单 ／ 五层测试地图 —— **重构以它为准绳** |
| [`dsp-module-map.md`](./dsp-module-map.md) | `bench/profile-patch.yml` §2.9；**功能块落位 ＋ 欠账台账**（与上者**不许互相抄写**） |
| [`host-adaptation-bench-design.md`](./host-adaptation-bench-design.md) | `bench/README.md` ＋ `dsp-top-level-constraints.md` §5.4 |
| [`cognitive-container-theory.md`](./cognitive-container-theory.md) · [`codebase-overview-v1.22.md`](./codebase-overview-v1.22.md) | 中英 README（⚠️ 后者名里带版本号但**仍被链着**，属"该更新"而非"该归档"） |

## ② 在办 / 待裁决的依据件（活着，但不是契约）

[`bindings-json-retirement-reconciliation.md`](./bindings-json-retirement-reconciliation.md)（**A7** 三形态待裁）·
[`deadcode-batch2-ruling.md`](./deadcode-batch2-ruling.md)（**②第 2 批**逐条裁决清单）·
[`cro-wake-log-design.md`](./cro-wake-log-design.md)（**CRO 流水**；🔴 **v1.75.0 形态已变**：JSON → 纯文本 `.log`，见文首告示）·
[`unattended-proxy-design.md`](./unattended-proxy-design.md)（**D77；🔴 功能已于 2026-10-18 整条退役**
—— owner 判「已经证实没意义」，本件**降级为历史留档**，不再描述现行能力）·
[`git-commit-push-coupling-design.md`](./git-commit-push-coupling-design.md)（**D92** 交付物；P3b/B4 未做）·
[`rebuild-todo-design.md`](./rebuild-todo-design.md)（**D93**）· [`injection-audit.md`](./injection-audit.md)（注入面审计）

## ③ 功能设计（已实现 ⇒ **回溯用**，不再是最新真相）

🆕 [`trajectory-declaration-file.md`](./trajectory-declaration-file.md)（**v1.75.0 轨迹声明面**：
`trajectory.json` 收拢约束＋`uid`＋`cro.host`；认族不认名；流水为何不并；**迁移时机判据**）·
[`trajectory-centric-architecture.md`](./trajectory-centric-architecture.md)（**v1.72.0 轨迹中心架构**：
"所有读数器过时类缺陷，形态都是同一个"＋ 九次折叠台账）

`skiff-design` / `skiff-followup-design` / `skiff-bound-trajectory-design` / `skiff-trajectory-bound-mode-design` /
`skiff-type-and-injection-design` ｜ `weixin-bridge-design` / `weixin-media-design` / `weixin-as-acc-tool-design` /
`weixin-acc-layer-design` / `acp-wecom-design` ｜ `cognitive-trajectory-identity-design` / `trajectory-identity-deep-insights` /
`cognitive-trajectory-merge-naming` / `container-trajectory-rename` / `cognitive-trajectory-wake-registry-design` /
`cognitive-trajectory-assistant-design` / `cognitive-trajectory-assistant-plan` ｜ `acc-autopilot-retirement` /
`acc-component-relations-review` / `acc-component-relations-current-state` / `acc-tool-naming-rework` /
`acc-tool-merge-and-msm-entry-rework` ｜ `autopilot-trajectory` / `autopilot-trajectory-design` /
`rebuild-focus-note-and-autopilot-bound-wake` ｜ `cheap-worker-design` / `cheap-worker-dual-mode-design` ｜
`cro-wake-log-design` / `im-bridge-redesign` ｜ `deepseek-multimodal-patch-design` / `web-fetch-fakeip-design` /
`advanced-settings-design` / `dsh-serenity-hooks-design` ｜ `session-binding-persist-plan` ｜
`three-improvements-design` / `testability-architecture-plan` ｜ `LOOP-DESIGN`

## ④ 适配轮（按宿主版本；**最新一轮才是现行**）

[`dsh-0.2.0-rc.1-adaptation-plan.md`](./dsh-0.2.0-rc.1-adaptation-plan.md)（**现行**）·
[`dsh-0.1.7-rc.1-adaptation-plan.md`](./dsh-0.1.7-rc.1-adaptation-plan.md) ·
[`dsh-0.1.5-rc.3-adaptation-plan.md`](./dsh-0.1.5-rc.3-adaptation-plan.md) ·
[`dsh-0.1.5-rc-adaptation-plan.md`](./dsh-0.1.5-rc-adaptation-plan.md)
🔵 后三者**为什么留在本层**（而不是随 0.1.2 三件一起归档）：**0.1.7 被"现行"件逐字引用**
（现行件第 3 行：「体例照 `dsh-0.1.7-rc.1-adaptation-plan.md`（上一轮的同名产物）」）；
**0.1.5 两件经"先例链"被引用**（0.1.7 件引它们为体裁先例）。⇒ 三者都**不是**"只剩历史记录引用"。
🔵 0.1.2 轮的三件**已归档**（见 `_archive/`）。

### 📌 本轮筛过的范围（诚实边界）

**全部 81 个条目都过了一遍**三条判据；**14 件满足**（已搬）。其余 **67 件至少有一条不满足**，主因两类：
① **唯一记录**（"已实现的功能设计"／研究／审计 —— **没有被更新的同类件取代**，如 `skiff-*`、`weixin-*`、
`trajectory-*`、`cheap-worker-*` 诸件：它们记录的是**当时为什么这么设计**，属认知资产）；
② **仍是活引用**（契约面 ／ 被现行件引用 ／ 被代码注释点名）。
⚠️ **一个刻意的边界**：① 那 25 件"**已实现的功能设计**"**按本文件的判据不搬**（没被取代），
但若口径改成"**功能已上线 ⇒ 设计稿使命完成**"，它们即**最大的一批候选** —— 那是**口径裁决**，
不是机械判断 ⇒ 见 SESSION §待裁（**A27**）。


## ⑤ 研究 / 审计（一次性调研，供结论回溯）

`knowledge-ccc-release-research` ｜ `sensitive-data-protection-research` ｜ `three-feature-requests-research` ｜
`three-tier-hierarchy-feasibility` ｜ `dsp-implementation-review`（⚠️ 其配套八分片已归档）

## ⑥ 运维 / 使用

[`DEPLOYMENT.md`](./DEPLOYMENT.md) ｜ [`PLUGIN-MANAGEMENT.md`](./PLUGIN-MANAGEMENT.md) ｜ [`WEBUI.md`](./WEBUI.md)

## ⑦ 单项存档件（**备查**，非现行）

`status-card-scheme-O-shield.html`（用户原始 HTML 落盘存档）· `system-prompt-v1.19.5-baseline.ts`（注入文本基线，回退参照）

---

🔴 **新增文档时**：先问"它是**取代**某件、还是**新主题**？"——取代 ⇒ 旧件按三条判据搬 `_archive/` 并在
其 `README.md` 补一行映射；新主题 ⇒ 归上面某一类，**并更新本文件**（否则索引立刻开始说谎）。
