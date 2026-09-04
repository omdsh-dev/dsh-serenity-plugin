# 四项需求调研 v0.1（2026-09-02，S142）— 等用户回家拍板后实现

> 状态: **调研完成，未实现**（用户"先调研方案，等我回家再动手" / "调研好了回家一并决定"）
> 范围: ① rebuild 阈值百分比→K 数值 ② 会话命名加 20 字内容概括（use/rebuild summary 参数）
> ③ 系统提示词：MSM 调用示例 + 工具列表移末尾 ④ 目录式 ACC 使用指南（整合分散 guide）

---

## 需求 ①：session_rebuild 阈值从百分比改为具体数值（单位 K）

### 现状（实证）

| 层 | 位置 | 现状 |
|----|------|------|
| 简单配置 schema | `src/settings-section.ts` | `rebuildThreshold: z.number().min(0.01).max(1).default(0.9)`——**比例 0~1**（settings.yaml 持久化） |
| 插件 Config 片段 | `src/config-ops.ts` `RebuildSettings.thresholdRatio`（0~1 注释） | Config 层同名比例 |
| 触发判定 | `src/seams/keeper.ts` L199-200 | `ratio = projectedTokens / contextWindow; if (ratio >= threshold)` 注入 [TRAJECTORY] 提醒 |
| 提醒文案 | `keeper.ts` `rebuildReminderText` | `Context usage at ${pct}% (threshold ${thr}%)`（比例转百分数显示） |
| 面板 | `src/client/SettingsSection.tsx` | range 滑块 0.10~1.00，`scope.set('rebuildThreshold', ...)` clamp 0.01~1 |
| 测试 | `settings-section.test.ts`（0.9/0.5 断言）、`keeper.test.ts`（rebuildReminderText(0.91, 0.9)） | 比例语义贯穿 |

**用户意图**："session_rebuild 的设定从百分比改为具体数值，单位 K"——触发条件从"占窗口 90%"变为"达到 N K tokens"（如 400K = 400,000 projectedTokens）。

### 方案要点（K 语义）

- 触发判定改：`projectedTokens >= thresholdK * 1000`（不再依赖 contextWindow 比例）
- 文案改：`Context usage at ${Math.round(tokens/1000)}K (threshold ${thresholdK}K)`——keep 英文结构（v1.23.0 全英化 + osp 对齐？**注意 rebuildReminderText 非 osp 对齐块**——仅 CCE/Session 逐字节对齐，rebuild 文案为 dsp 自有，可自由改）
- 配置默认值：需按常用模型窗口取（如 deepseek 系大窗口）；**拍板项**——默认 K 值与上下限
- 字段命名：settings 键 `rebuildThreshold`（现比例 0.9）→ 若直接复用此键则值 0.9 会变成 0.9K（错误语义）；建议**新键 `rebuildThresholdK`**（保留旧键读取做迁移/降级？或直接断——settings.yaml 用户少，可拍板）

### 影响面清单

| 文件 | 改动 |
|------|------|
| `settings-section.ts` | schema 改 K 数值（z.number().min(50).max(2000)?）+ 类型 + default + entryDefaults |
| `config-ops.ts` | RebuildSettings.thresholdRatio → thresholdK（注释/类型） |
| `seams/keeper.ts` | 判定改绝对 K + 文案 K 化 + readContextPressure 不变 |
| `client/SettingsSection.tsx` | 滑块→数字输入（K 单位）或保留滑块改刻度；help 文案 |
| 测试 | settings-section / keeper（文案断言改 K）|
| README/hooks README（如提阈值） | 文案同步（README 目前只说"rebuild 阈值"，未写比例——查证后确认） |

### 建议拍板

1. 默认 K 值（0.9 比例在 1M 窗口 ≈ 900K？常见 LLM 窗口大小不一——建议默认 400K？或按会话实际 contextWindow 反推）
2. 键名：复用 rebuildThreshold（断语义迁移）vs 新键 rebuildThresholdK（干净）
3. 是否保留窗口比例上限保护（`min(thresholdK*1000, contextWindow*0.95)`——防配置 K 超窗口永不触发；可选）

---

## 需求 ②：会话命名——编号日期后加 ≤20 字内容概括（use/rebuild 加 summary）

### 现状（实证）

- 命名标题格式：`src/tools/session.ts` `namingTitleFor()` → **`S143-2026-08-26`**（sessionId + 日期，从目录名派生；无概括）
- 触发点：① `session use` 激活后 `renameDshSessionForActive`（tools/session.ts L364）② `session create` 后立即命名（L337，v1.25.11）——use/create 共用
- `session_rebuild`：**同会话原地 replace**（tools/rebuild.ts 描述："复用当前 dsh 会话（同一 id）turn 结束清空重建"）——**无新标题**（标题保持原 S###-日期）
- 标题写入：`sessionTitle.rename(session, title)` → session log `session/title` 事件（latest-wins）
- autopilot 匹配：`resolveTargetAgent` L417 `title === sid || title.startsWith(sid-)`——**加概括后 `S143-2026-08-26-概括` 仍 startsWith `S143-`，天然兼容 ✓**
- 命名工具名含中文可？标题仅展示/匹配用途，无文件系统限制

**用户意图**："会话命名还是不够完善，希望能在编号日期后面加个 20 字以内内容概括；为了实现这个，session use 加上 summary 参数，session_rebuild 也加——做成必填，但只影响那个概括，编号和日期还是固定的。"

解读：标题 `S###-YYYY-MM-DD-<概括≤20字>`；概括由调用方（LLM/用户）经 summary 参数显式给出（可靠——不依赖 LLM 从别处猜），编号日期服务端固定派生（不信任 LLM 输入）。

### 方案要点

- **标题格式**：`namingTitleFor(active, summary?)` → 有 summary 则 `${sid}-${date}-${summary}`（summary 服务端截断 ≤20 字符 + 去换行/控制字符防注入）
- **session use**：参数加 `summary`（**必填 required**——拍板项：严格必填 vs 可选但建议）；use 分支把 summary 传入 rename
- **session_rebuild**：参数加 `summary`（必填）；rebuild 排队时存 summary → turn-stopping 执行 replace 后**重命名**（agent 会话标题更新为新概括——重建代表新工作阶段）；需经 `ctx.get('sessionTitle')` + `exec.agent.session`（registerRebuildTurnHook 有 ctx ✓）
- **session create**：现已有 desc（目录名 `YYYY-MM-DD--S###--<desc>`，≤5 词）——create 命名概括可直接用 desc（拍板项：create 是否需要单独 summary 参数，还是沿用 desc？用户未提 create——最小改动=create 概括用 desc 自动带）
- 事件：多 scope（并行会话）各自 rename——标题按 agent.session 独立 ✓

### 影响面清单

| 文件 | 改动 |
|------|------|
| `tools/session.ts` | use 参数 +summary（必填?）、namingTitleFor(active, summary?)、renameDshSessionOnUse/ForActive 透传、create desc→概括 |
| `session-ops.ts` | ActiveSessionInfo 或调用侧带 summary；useSession 不改（摘要不落 SESSION.md——只影响 dsh 会话标题） |
| `tools/rebuild.ts` | 参数 +summary → queueRebuild opts |
| `rebuild.ts` | queueRebuild 存 summary → PendingRebuild 扩展 → performRebuild 后（或 registerRebuildTurnHook 内）rename agent 会话标题 |
| autopilot | **无需改**（startsWith(sid-) 兼容验证 ✓）；但注意 readSessionTitle 在 rebuild/autopilot 的读取兼容（latest-wins 读新标题） |
| 测试 | session-title.test / session-tool.test / rebuild.test / autopilot 标题匹配用例（若断言精确标题 `S143-日期` 需放宽为 startsWith） |

### 建议拍板

1. use/rebuild 的 summary **必填语义**：严格必填（required，缺省报错引导）vs 可选（给则带、不给则 S###-日期）——用户说"做成必填"
2. create 是否也带概括（用 desc 自动）——一致性
3. 20 字截断是**字符数**（中英混排）——建议按字符 slice；summary 清洗规则（去 `/`、换行、控制字符）
4. rebuild 加概括 = 重建后 rename——确认语义（重建代表新阶段，标题概括应更新？）还是 rebuild 不改标题只用 summary 进锚点？

---

## 需求 ③：系统提示词——MSM 调用示例 + 工具列表移末尾

### 现状（实证）

- 装配顺序 `serenitySystemPrompt()`（seams/system-prompt.ts L453）：**ACC（身份+13 工具清单）→ Metaphor → Principles → CCE → EAP → 状态 → SKILL → Session**；code-mode 适配行 append 在 base 后
- `accBlock()` L59：第 1 块，含身份行 + CCC + **工具清单 13 行** + platform 说明 + "acc_msm list 发现更多"指引——**工具清单目前位于最前**
- MSM 调用指引现状：仅 Principles 有 MSM 原则（Determinism/Single source/Registered）；accBlock 有 "acc_msm list to discover"——**无具体调用示例**（如 `acc_msm exec <name> --schema 1`）
- osp 对齐断言：`tests/osp-alignment.test.ts` L201-225 **块序断言**（ACC→Metaphor→…→Session 递增 indexOf）+ system-prompt.test L66-86 accBlock 含工具名断言

**用户意图**：① 顶层提示词对 MSM 加**调用方式示例说明**（避免偶发调用错误——模型对 acc_msm 参数面/协议 flag 理解不稳）② **工具列表放到最后**（13 行工具清单占开头大段，干扰认知轨迹开头——身份先行、工具参考殿后）

### 方案要点

- **拆分 accBlock**：身份块（ACC/CCC/约束声明，短）留在首位；**工具清单独立成块**（如 `=== Serenity Tools ===`，含 13 工具行 + platform 说明 + `acc_msm list` 指引）移到装配**末尾**（Session 块之后 / code-mode 行之前）
- **MSM 调用示例**：工具块内附 2-3 个可执行示例（如 `acc_msm list` 发现 / `acc_msm exec <name> --schema 1` 查用法 / `acc_msm exec <name> <args>` 执行；参数/协议 flag 位置）
- 装配：parts 顺序 [身份, Metaphor, Principles, CCE, EAP, 状态, SKILL, Session, Tools]（或 Tools 在 Session 前？拍板——用户说"最后"）
- code-mode 适配行仍在 base 之后（含 Tools 块整体尾部）

### 影响面清单

| 文件 | 改动 |
|------|------|
| `seams/system-prompt.ts` | accBlock 拆分 + toolsBlock 新建 + serenitySystemPrompt 顺序 |
| `tests/osp-alignment.test.ts` | L201-225 块序断言改（新序 + Tools 块位置）；L229 accBlock 工具断言改指 toolsBlock |
| `tests/system-prompt.test.ts` | L66-86 断言同步 |
| osp 对照 | dsp 领先——装配顺序是 dsp 自有结构（仅 CCE/Session 块逐字节对齐 osp）；顺序变化记录 spec/osp 对齐待同步 |
| SKILL.md/README | 系统提示词结构描述（8 块）同步新块 |

### 建议拍板

1. 工具块位置：Session 后（最末）vs SKILL 后 Session 前（Session 是"当前会话"动态信息，放最后有临场感）
2. MSM 示例数量与措辞（2-3 个典型；示例进 toolsBlock 还是 Principles MSM 原则段）
3. 身份块是否保留一行工具提示（"工具清单见文末 Tools 块"）——防模型以为没工具

---

## 需求 ④：目录式 ACC 使用指南（整合分散 guide）

### 现状（实证盘点——ACC 侧 CCC 相关 guide 散落 6+ 处）

| # | 入口 | 载体 | 定位 |
|---|------|------|------|
| 1 | `acc_msm guide` | `msm-ops.ts MSM_GUIDE` | MSM 开发手册（面向写 MSM 的 CCC） |
| 2 | `acc_msm ccc-config` | `msm-ops.ts CCC_CONFIG_REFERENCE` | **CCC 配置参考**（8 段：handyman/sessionKeeper/localstore/hooks/safeMode/skiff/autopilotTrajectory/weixin）——唯一接近"目录"的现成物，但只讲配置段不讲用法 |
| 3 | `skiff_admin guide` | `tools/skiff-admin.ts SKIFF_GUIDE` | Skiff 角色定义教程（F4） |
| 4 | `handyman guide` | `handyman-ops.ts HANDYMAN_GUIDE` | handyman 规模化使用指引（v1.24.0） |
| 5 | `autopilot-trajectory`（doc/check/status/guide） | `tools/autopilot-trajectory.ts` + `experiments/autopilot-trajectory/SKILL.md` | Autopilot 一站式管理 + 实验参与指南 |
| 6 | `weixin-doctor guide`（CCC 侧 MSM） | `.opencode/skills/home-serenity/scripts/weixin-doctor.ts` | 微信桥 CCC 指南（今天新增，含 hook 事件格式） |
| 7 | `session hook-develop-guide` | `tools/session.ts` | CCC session-tool 扩展指南 |

**问题（用户洞察）**："目前 acc 提供的各类供 ccc 用的配置，都是各自做 guide，后续这种东西越来越多，要整合起来做个**目录式的 acc 使用指南**"——CCC 用户/agent 不知道"ACC 有哪些能力、每个怎么配、哪里有详细说明"；每新增一个功能（skiff/autopilot/weixin/hook…）就多一个独立 guide 入口，发现成本线性上升。

### 方案要点（目录式指南）

**目标形态**：一个"能力目录"入口——CCC 一问即知：
```
═══ ACC 使用指南（目录）═══
按能力分区列出：
  ① 会话与轨迹   → session / session_rebuild（rebuild 阈值 K 见配置 §）
  ② 认知质量框架 → eap / neat / cce（渐进披露，工具直达）
  ③ 工具与执行   → cc_fs / cc_git / acc_kit / acc_msm / handyman（handyman guide）
  ④ 角色与对外   → skiff_admin guide（Skiff 子集角色）/ ACP / 问答页
  ⑤ 自主与接入   → autopilot-trajectory（自动巡航）/ weixin（微信桥 weixin-doctor guide）
  ⑥ CCC 配置总览 → ccc-config（每段配置 + 钩子用法）
每区：一句话定位 + 详细入口（工具名/guide 子命令）+ 配置归属（DSH settings / serenity.json / localstore）
```

**落点候选（拍板）**：

| 方案 | 描述 | 成本 | 备注 |
|------|------|------|------|
| A（推荐） | 新建第 14 工具 `acc_guide`（无参=目录；`acc_guide <topic>` = 主题详情跳转/内联）——轻量纯文本工具，类似 eap/neat/cce 渐进披露模式 | 新工具注册 + 目录文本 + 索引逻辑 | 工具 desc 一句话；内容维护随功能演进更新；skiff 白名单可选放行 |
| B | 扩展现有 `ccc-config` 为"配置 + 目录"两段 | 低成本（改一个常量） | ccc-config 定位是"配置参考"，塞目录会偏离主题、越做越臃肿 |
| C | 扩展现有某一工具（如 session / acc_kit）加 guide 子命令 | 低成本 | 归属不当——session 的 guide 管不了 weixin/autopilot 域 |
| D | 不动插件：把目录做进 home-serenity 的入口 skill（SKILL.md 路由表） | 零插件改动 | 只服务 home-serenity 一个 CCC，非通用 ACC 能力 |

**推荐 A**：独立工具 `acc_guide`——与现有各功能 guide 关系 = **目录在前、详情各归各**（单一真相源：不复制 skiff_admin/weixin-doctor 全文，只索引"去哪个工具看详情"）；零复制 → 后续新增功能只需在目录文本加一行（低熵、可演进）。

### 影响面清单（若选 A）

| 文件 | 改动 |
|------|------|
| `src/tools/acc-guide.ts`（新） | 第 14 工具：无参目录 / `acc_guide <topic>` 主题详情（映射表 → 内联简介或指引子命令） |
| `src/index.ts` | 注册 accGuideTool（第 14 工具，tools 门控内） |
| `src/constants.ts` / `src/client` | ACC_VERSION 无关；工具计数处（register.test 断言 13 工具 → 14） |
| `src/skiff-core.ts` | skiff 角色白名单：acc_guide 若放行需加（读全零写——可参考 eap/neat/cce 处理） |
| `src/seams/system-prompt.ts` | accBlock 工具清单 +1 行；若需求③工具列表移尾一并处理 |
| 测试 | register.test（14 工具断言）+ acc-guide.test（新：目录含 6 区/主题映射/未知主题提示） |
| README/ccc-config | 工具面 13→14；ccc-config 可加一行"详细能力指南：acc_guide"互链 |

### 建议拍板

1. 落点 A/B/C/D（推荐 A：独立 `acc_guide` 工具）
2. 目录粒度：6 区是否合适 / 每行是否要含示例调用
3. acc_guide 是否对 skiff 角色放行（读全零写——倾向放行，知识查询不越权）
4. 与需求③的关系：若工具清单块移末尾，acc_guide 的目录是否作为其中"文档入口"链接

---

## 执行顺序建议（等用户回家拍板后）

1. **需求 ③**（纯文本结构，改动集中、测试面清晰）→ 2. **需求 ②**（命名链路 + rebuild 透传）→ 3. **需求 ①**（配置语义变更 + 面板）→ 4. **需求 ④**（新工具，独立增量，可随时插入）
2. 每项：实现 → test 全绿 → deploy 本机 → 用户验证 → 合并 bump 1.27.13/1.27.14（等用户显式要求发版，D14）

## 决策记录（R↓）

| # | 决策 | 理由 |
|---|------|------|
| R1 | 四项均为用户回家后拍板项（本调研不改代码） | 用户"调研好了回家一并决定" |
| R2 | 需求①语义 = 绝对 token K（非比例） | 用户明确"从百分比改为具体数值，单位 K" |
| R3 | 需求②编号日期固定派生、概括来自 summary 参数 | 用户"做成必填，但只影响那个概括，编号和日期还是固定的" |
| R4 | 需求③工具清单独立成块移末尾 | 用户"把工具列表放到最后，减少对整个认知轨迹的负面影响" |
| R5 | 需求④目录式指南：目录在前、详情各归各（单一真相源） | 用户"各自做 guide…要整合起来做个目录式的"——目录不复制详情，只索引 |
