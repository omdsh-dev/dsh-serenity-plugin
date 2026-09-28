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

| 件 | 谁指着它 |
|---|---|
| [`trajectory-skill-injection.md`](./trajectory-skill-injection.md) | `seams/keeper.ts` · `seams/system-prompt.ts` · `tools/trajectory.ts` · `trajectory-skills.ts` · `skills-discovery.ts` · 两个测试 |
| [`metaphor-domain.md`](./metaphor-domain.md) | `seams/system-prompt.ts` · `tests/osp-alignment.test.ts` |
| [`failure-policy.md`](./failure-policy.md) | `tests/failure-policy.test.ts` |
| [`cro-design.md`](./cro-design.md) | `wake-scheduler.ts` · `cro-turns.ts` · `index.ts` · `trajectory-ops.ts` · 三个测试 |
| [`trajectory-send-message-design.md`](./trajectory-send-message-design.md) | `tools/trajectory.ts` · `trajectory-ops.ts` · `tests/wake-registry.test.ts` |
| [`trajectory-scheduling.md`](./trajectory-scheduling.md) | `wake-scheduler.ts` |
| [`human-channel-plan.md`](./human-channel-plan.md) | `settings-section.ts` · `human-channel.ts` · `tests/human-channel-config.test.ts`（**§11 定案 = 权威规格**） |
| [`weixin-bot-api.md`](./weixin-bot-api.md) | `weixin-api.ts`（协议真相源：§6 媒体 CDN/AES） |
| [`weixin-message-hook-design.md`](./weixin-message-hook-design.md) | `weixin-hook.ts` |
| [`session-binding-hardening-research.md`](./session-binding-hardening-research.md) | `trajectory-bound.ts`（`ignorable` 的机制取证） |
| [`plugin-development-standard.md`](./plugin-development-standard.md) · [`plugin-development-guide.md`](./plugin-development-guide.md) | `tests/compliance.test.ts` · `dsp-top-level-constraints.md` |
| [`dsh-0.2.0-rc.1-adaptation-plan.md`](./dsh-0.2.0-rc.1-adaptation-plan.md) | `host/contract.ts`（**本轮适配的权威方案**） |
| [`dsp-top-level-constraints.md`](./dsp-top-level-constraints.md) | 不变量 I1~I7 ／ 六层模型 ／ 宿主接触白名单 ／ 五层测试地图 —— **重构以它为准绳** |
| [`dsp-module-map.md`](./dsp-module-map.md) | `bench/profile-patch.yml` §2.9；**功能块落位 ＋ 欠账台账**（与上者**不许互相抄写**） |
| [`host-adaptation-bench-design.md`](./host-adaptation-bench-design.md) | `bench/README.md` ＋ `dsp-top-level-constraints.md` §5.4 |
| [`cognitive-container-theory.md`](./cognitive-container-theory.md) · [`codebase-overview-v1.22.md`](./codebase-overview-v1.22.md) | 中英 README（⚠️ 后者名里带版本号但**仍被链着**，属"该更新"而非"该归档"） |

## ② 在办 / 待裁决的依据件（活着，但不是契约）

[`bindings-json-retirement-reconciliation.md`](./bindings-json-retirement-reconciliation.md)（**A7** 三形态待裁）·
[`deadcode-batch2-ruling.md`](./deadcode-batch2-ruling.md)（**②第 2 批**逐条裁决清单）·
[`unattended-proxy-design.md`](./unattended-proxy-design.md)（**D77** 未发布实现）·
[`git-commit-push-coupling-design.md`](./git-commit-push-coupling-design.md)（**D92** 交付物；P3b/B4 未做）·
[`rebuild-todo-design.md`](./rebuild-todo-design.md)（**D93**）· [`injection-audit.md`](./injection-audit.md)（注入面审计）

## ③ 功能设计（已实现 ⇒ **回溯用**，不再是最新真相）

`skiff-design` / `skiff-followup-design` / `skiff-bound-trajectory-design` / `skiff-trajectory-bound-mode-design` /
`skiff-type-and-injection-design` ｜ `weixin-bridge-design` / `weixin-media-design` / `weixin-as-acc-tool-design` /
`weixin-acc-layer-design` / `acp-wecom-design` ｜ `trajectory-identity-design` / `trajectory-identity-deep-insights` /
`trajectory-merge-naming` / `container-trajectory-rename` / `trajectory-wake-registry-design` /
`trajectory-assistant-design` / `trajectory-assistant-plan` ｜ `acc-autopilot-retirement` /
`acc-component-relations-review` / `acc-component-relations-current-state` / `acc-tool-naming-rework` /
`acc-tool-merge-and-msm-entry-rework` ｜ `autopilot-trajectory` / `autopilot-trajectory-design` /
`rebuild-focus-note-and-autopilot-bound-wake` ｜ `handyman-design` / `handyman-dual-mode-design` ｜
`cro-wake-log-design` / `im-bridge-redesign` ｜ `deepseek-multimodal-patch-design` / `web-fetch-fakeip-design` /
`advanced-settings-design` / `dsh-serenity-hooks-design` ｜ `session-binding-persist-plan` ｜
`three-improvements-design` / `testability-architecture-plan` ｜ `LOOP-DESIGN`

## ④ 适配轮（按宿主版本；**最新一轮才是现行**）

[`dsh-0.2.0-rc.1-adaptation-plan.md`](./dsh-0.2.0-rc.1-adaptation-plan.md)（**现行**）·
[`dsh-0.1.7-rc.1-adaptation-plan.md`](./dsh-0.1.7-rc.1-adaptation-plan.md) ·
[`dsh-0.1.5-rc.3-adaptation-plan.md`](./dsh-0.1.5-rc.3-adaptation-plan.md) ·
[`dsh-0.1.5-rc-adaptation-plan.md`](./dsh-0.1.5-rc-adaptation-plan.md)（后三者**被现行件引用为体裁先例** ⇒ 留）
🔵 0.1.2 轮的三件**已归档**（见 `_archive/`）。

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
