# 五项需求调研 v0.2（2026-09-02 首版 / 2026-09-04 加第⑤项，S142）— 等用户回家拍板后实现

> 状态: **调研完成，未实现**（用户"先调研方案，等我回家再动手" / "调研好了回家一并决定" / 2026-09-04 追加第⑤项"还是先调研"）
> 范围: ① rebuild 阈值百分比→K 数值 ② 会话命名加 20 字内容概括（use/rebuild summary 参数）
> ③ 系统提示词：MSM 调用示例 + 工具列表移末尾 ④ 目录式 ACC 使用指南（整合分散 guide）
> ⑤ **MSM 注册表（mech-registry.json）写保护 + ACC 层完整性检查**（用户："msm注册的文件需要写保护起来，避免CCC意外写坏搞崩自己，同时要有ACC层检查方法检查注册表没坏，这东西太核心了"）

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

## 需求 ⑤：MSM 注册表写保护 + ACC 层完整性检查（2026-09-04，用户追加）

**用户意图**："msm注册的文件需要写保护起来，避免CCC意外写坏搞崩自己，同时要有ACC层检查方法检查注册表没坏，这东西太核心了"——mech-registry.json（MSM 注册表）是 CCC 执行层的地基：写坏 → `loadMsmEntries` JSON.parse 抛错 → acc_msm 全崩 + register 也无法修复（自锁）→ CCC 工具面瘫痪。需要 ① **结构性写保护**（只有 acc_msm register/deregister 可写）② **ACC 层检查方法**（注册表完整性/健康诊断）。

### 现状（源码实证，2026-09-04）

**注册表形态**：v1 wrapper `{version:1, description, entries:[...]}` 或裸数组（writeRegistry 保留原格式）。位置两类：
- **root 级**：`<CCC根>/mech-registry.json`（`registryPathFor(root, undefined)`——register 无 --skill 时）
- **skill 级**：`.opencode/skills/<skill>/references/mech-registry.json`（`findRegistries` 扫 skillsDir 收集 + root 级）
- 消费方：`loadMsmEntries`（聚合去重 byName）被 acc_msm list/exec/register/deregister/check + `skiff-admin` validate（registered.has）+ `output-guard`（MSM 工具名词表）+ `session`（hook 开发指南）共用——**注册表坏 = 大面积崩**。

**现有保护（dsp 侧，逐通道核对）**：

| 通道 | 现有保护 | 缺口 |
|------|---------|------|
| `cc_fs` 写子命令（fs-ops.ts `validateWritePath` L131-146） | **skill 级 ✓**：`relCi.endsWith('/mech-registry.json') && /(^|\/)(opencode|\.opencode)\/skills\//` → throw "refusing to directly modify mech-registry.json — use acc_msm register/deregister" | **root 级 ✗**：root rel = `mech-registry.json` 不以 `/` 结尾 → `endsWith('/mech-registry.json')` false → **cc_fs 可直接写坏 root 级注册表** |
| `write`/`edit`/`append`/`touch` 原生工具（guards.ts `decideGuard`） | 无注册表保护——凭据硬名单仅 `localstore.json`（v1.26.3），治理文件仅 `.serenity*`，黑名单用户可配 | **✗ 完全无保护**：write/edit 直接覆盖任意 mech-registry.json（skill 级+root 级）——模型误操作/坏 JSON/截断写 → 注册表坏 |
| `acc_msm register/deregister`（msm-ops.ts `writeRegistry`） | 合法通道 ✓：写前 parseRegistry 校验现存 + 路径根内校验 + name 全局唯一 + 精 git commit（只 add 注册表文件） | 非原子写（直接 writeFileSync）；写中断（进程 kill）→ 半写 JSON？罕见（写前有 parse 无写后校验） |
| `bash` | safe-mode 禁 bash；非 safe-mode bash 可绕过一切路径守卫（用户全权面，含 localstore 同理） | 结构性边界不依赖 safe-mode（wardn）；与 localstore.json 同级别考虑——但 localstore 走"读 deny"，注册表走"写 deny"（注册表需可读——output-guard/skiff-admin 读它建表） |

**osp 对照**：osp `file-system-tool.ts` L96 有同句 cc_fs 保护（聚合单注册表模式，ccc_admin 管理）；osp 无注册表完整性检查（check 只 DC-M1~M4）。**本需求 dsp/osp 双实现**（D11 同一 spec——保护语义 + 检查方法两仓同做）。

### 方案要点

**① 结构性写保护（guards.ts 扩展——仿 localstore 数据面守卫先例，语义 = 写 deny 读 allow）**

- `SENSITIVE_CREDENTIAL_FILES`（读 deny 集合）旁新增 **`PROTECTED_REGISTRY_FILES`（写 deny 集合）**：匹配 `mech-registry.json`（root 级 `rel === 'mech-registry.json'`）+ skill 级（`rel.endsWith('/references/mech-registry.json')` 或 `/(^|\/)(opencode|\.opencode)\/skills\/.*\/mech-registry\.json$/`）
- `decideGuard` 2a 段扩展：写工具（isWriteTool 含 cc_fs 写子命令）命中 → deny `"mech-registry.json is ACC-managed — use acc_msm register/deregister"`；读工具放行（注册表必须可读——output-guard/skiff-admin/模型自查）
- **豁免面**：`acc_msm register/deregister` 自身走 `writeRegistry`（工具内部实现非 pre-execute 工具调用）→ 天然豁免 ✓；外部面 skiff 角色白名单不含 write/edit → 无冲突
- **fs-ops 补漏**：`validateWritePath` root 级匹配补 `relCi === 'mech-registry.json'`（修 endsWith 前导斜杠盲区）——或统一收口到 guards（cc_fs 也过 pre-execute，guards deny 已覆盖；fs-ops 内层校验保留作纵深）
- **原子写增强（可选）**：writeRegistry 改 tmp + rename（同目录原子替换）——写中断不留半文件

**② ACC 层检查方法（新增 `acc_msm check-registry` 或并入 check？）**

- 现状：`acc_msm check`（DC-M1~M4）检查**脚本质量**（.test/main guard/双向注册/type:path）——**注册表结构健康不在内**；且 check 首行 `loadMsmEntries` 在注册表坏时直接 throw → 连诊断都出不来
- 目标检查项（纯函数可单测）：
  - **格式**：每个注册表文件 JSON.parse 合法（剥 BOM）+ v1 wrapper 或数组结构
  - **结构**：entries[] 存在、每 entry 字段（name/path/skill/category/description）类型合法
  - **唯一性**：name 全局唯一（loadMsmEntries byName 聚合语义——重复即歧义）
  - **引用完整**：path 根内 + 脚本 existsSync（DC-M3 反向已有，并入汇总）
  - **flags 合法**：数组 + name/type/description 形态（新旧 style 兼容）
  - **可执行性**：`prepareExec` 级 dry 验证（--schema 面）？
- **输出**：每文件状态（ok/损坏）+ 损坏定位（哪文件哪条）+ 修复指引（git 恢复：register/deregister 精提交 = 每次变更都有 git 历史 → `git checkout -- <registry>` 或 cc_git 无 checkout 子命令？——bash 可用时 git restore；safe-mode 下建议手动恢复/用户介入）
- **落点候选**：A 并入 `acc_msm check`（加 DC-M5 "registry health"——check 语义扩为"MSM 全链健康"；坏时不 throw 先报）/ B 新 action `check-registry`（独立可脚本化，autopilot 例行可跑）/ C `acc_kit health` 加一段（健康检查聚合入口）
- **损坏自愈（可选延伸）**：check-registry 检测坏 + 注册表有 git 历史 → 提供 `--restore` 从 git 恢复（需 cc_git checkout 能力或 execFileSync git——msm-ops 已用 execFileSync git commit，可加 restore 子命令）

### 影响面清单

| 文件 | 改动 |
|------|------|
| `src/seams/guards.ts` | PROTECTED_REGISTRY_FILES 写 deny 集合 + decideGuard 2a 扩展 + deny 文案 |
| `src/fs-ops.ts` | validateWritePath root 级匹配补漏（纵深保留） |
| `src/msm-ops.ts` | check-registry 纯逻辑（或 check 扩展）+ 可选 writeRegistry 原子写 + 可选 git restore |
| `src/tools/msm.ts` | action enum + description（+check-registry） |
| `src/skiff-core.ts` | skiff MSM 白名单：check-registry 是否放行（读全零写——倾向放行） |
| tests | guards.test（write/edit/cc_fs 写 root+skill 级 deny、读放行、register 豁免语义）+ msm.test（check-registry 各损坏形态）+ fs-ops.test（root 级补漏） |
| osp 同步 | 同 spec 双实现（file-system-tool/guards/msm check） |
| README/ccc-config | 工具面说明 + 恢复指引 |

### 建议拍板

1. 保护范围：仅注册表文件自身（mech-registry.json 两形态）vs 含 `.opencode/serenity.json`（CCC 配置同为核心——用户说"这东西太核心了"指注册表；serenity.json 是否一并纳入？）
2. 检查方法落点：A 并入 acc_msm check（DC-M5）/ B 新 action check-registry / C acc_kit health 段
3. 恢复能力：只输出修复指引（git restore 由用户/cc_git 执行）vs check-registry 内置 `--restore`（git 历史恢复）
4. 写保护豁免确认：register/deregister 走内部 writeRegistry 天然豁免 ✓（无需白名单）；bash 非 safe-mode 不拦（与 localstore 同语义——结构性边界依赖 safe-mode 禁 bash）
5. 是否顺带原子写（tmp+rename）防半写
6. 与需求④（目录式 acc_guide）关系：check-registry 的恢复指引是否入 acc_guide

---

## 执行顺序建议（等用户回家拍板后）

1. **需求 ③**（纯文本结构，改动集中、测试面清晰）→ 2. **需求 ②**（命名链路 + rebuild 透传）→ 3. **需求 ①**（配置语义变更 + 面板）→ 4. **需求 ④**（新工具，独立增量）→ 5. **需求 ⑤**（保护 + 检查，核心加固——可与 ④ 并行或按其紧急性提前；**倾向：⑤ 先于 ④**——注册表保护是地基，acc_guide 是便利层）
2. 每项：实现 → test 全绿 → deploy 本机 → 用户验证 → 合并 bump 1.27.13/1.27.14（等用户显式要求发版，D14）

## 决策记录（R↓）

| # | 决策 | 理由 |
|---|------|------|
| R1 | 五项均为用户回家后拍板项（本调研不改代码） | 用户"调研好了回家一并决定" / "还是先调研" |
| R2 | 需求①语义 = 绝对 token K（非比例） | 用户明确"从百分比改为具体数值，单位 K" |
| R3 | 需求②编号日期固定派生、概括来自 summary 参数 | 用户"做成必填，但只影响那个概括，编号和日期还是固定的" |
| R4 | 需求③工具清单独立成块移末尾 | 用户"把工具列表放到最后，减少对整个认知轨迹的负面影响" |
| R5 | 需求④目录式指南：目录在前、详情各归各（单一真相源） | 用户"各自做 guide…要整合起来做个目录式的"——目录不复制详情，只索引 |
| R6 | 需求⑤保护语义 = **写 deny 读 allow**（vs localstore 读 deny） | 注册表需被读（output-guard/skiff-admin/模型自查建 MSM 词表）；敏感值才读 deny——注册表是结构核心不是秘密 |
| R7 | 需求⑤损坏后果 = 自锁（register 也崩无法自救）→ 恢复依赖 git 历史（register/deregister 精提交） | 实证：check 首行 loadMsmEntries throw → 无诊断输出；register 判重也 loadMsmEntries → 坏表无法 register 覆盖 |
