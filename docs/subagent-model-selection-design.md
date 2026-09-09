# ACC subagent 按角色指定模型 —— 方案设计（v0.1，待审核）

- **提交方需求**：宁静号天工 Bot 体系（2026-09-09）——「ACC subagent 工具支持按角色指定模型（model/provider 参数）」
- **设计方**：S142（dsp 维护会话）· 2026-09-09
- **状态**：待用户审核（Q1~Q6 见 §6）；**未动代码**
- **一句话结论**：**该能力 DSH 0.1.2-rc.1 已原生实现**（`subagent` 工具已有 `provider` / `model` / `reasoning_effort` 参数 + `list_subagent_models` 发现工具），**缺的只是"开启"与"CCC 侧治理面"**——因此本方案**不新增工具、不改 harness**，只做三件事：① 部署面开启 ② ACC 提供 CCC 级白名单守卫 ③ 可发现性与文档。

---

## 1. 实证链（全部源码级，可复验）

| # | 事实 | 证据（安装版 0.1.2-rc.1） |
|---|------|--------------------------|
| E1 | `subagent` 工具**参数里已有** `provider` / `model` / `reasoning_effort`（条件暴露） | `…/dsh-tool-subagent/lib/index.js`：`...modelSelectionEnabled ? { provider: {…}, model: {…}, reasoning_effort: {…} } : {}` |
| E2 | 参数由**实例配置** `modelSelectionSettings: true` 打开 | `lib/types/index.d.ts`：`modelSelectionSettings?: boolean`（"Sample the Host `subagent-model-selection` user setting for each new top-level session"） |
| E3 | 开关背后的**宿主设置**是 `subagent-model-selection`，含 `enabled` + `allowedModels`（精确 provider/model 路由列表） | `lib/model-selection-settings.js`：`SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE = "subagent-model-selection"`；schema `{ enabled: boolean(default false), allowedModels: AllowedModelRoute[] }`；`enabled && allowedModels.length===0` → 抛错 |
| E4 | 选择语义：`provider` 与 `model` **必须成对**；只给 effort 时沿用配置/父级路由 | `lib/types/model-selection.d.ts`：`DelegationModelRequest{provider?,model?,reasoning_effort?}` + `requestedAgentOptions(parentOptions, configured, request, enabled)` |
| E5 | **白名单强制**：任何显式选择必须落在允许路由内；纯继承不受此策略约束 | 同上：`assertAllowedModelSelection(policy, parentOptions, requested, request)` |
| E6 | **降级语义（需求④已满足）**：创建子 agent 前经实时适配器 preflight，非法模型报清晰错误，不静默 | 同上：`preflightChildLlmRoute(llm, parentOptions, requested, signal, inheritParentReasoningEffort?)` |
| E7 | **可发现性（需求⑤已满足）**：开启后注册全局工具 `list_subagent_models` | `lib/types/list-models.d.ts`：`registerListSubagentModels(ctx, policy)` |
| E8 | 实例是 `@deepseek-ai/dsh-tool-subagent`，当前 profile 挂了两实例 | `dsh-develop dump-config subagent`：`tool-subagent`（provider `spawn` / toolName `subagent` / backgroundMode `continuable`）+ `tool-subagent-fork`（provider `fork` / toolName `subagent_fork` / `one-shot`） |
| E9 | 宿主设置服务**已挂载**（只差开与填值） | 同上 dump：`- id: subagent-model-selection-settings` = `@deepseek-ai/dsh-tool-subagent/model-selection-settings` |
| E10 | **当前未开启**：本会话 `subagent` 工具 schema 只有 `description` / `prompt` / `run_in_background`（无 provider/model）；`~/.dsh/settings.yaml` 无 `subagent-model-selection` 段 | 本会话工具 schema 实测 + `read-dsh /home/yh/.dsh/settings.yaml` |

### 三条关键约束（决定了方案形态，必须写进决策）

| # | 约束 | 影响 |
|---|------|------|
| C1 | 策略在**每个新的顶层会话**组合时采样一次，**记录进会话**、子会话继承、**后续改设置不影响已记录会话**；"恢复的会话没有记录策略则保持关闭" | **已存在的会话（含当前 S142）开启后也不会出现参数**；验证必须新开会话 |
| C2 | **同一 tool scope 内只允许一个实例拥有模型选择**（因为 `list_subagent_models` 是全局名） | 只能在 `subagent` 或 `subagent_fork` 中**选一个**开；建议 `subagent`（见 §4.1） |
| C3 | 宿主设置是**全局**（非 per-CCC）；`allowedModels` 是精确路由白名单，catalog 成员性仅"建议性" | 需求里的"CCC 级白名单"**不能**靠宿主设置实现 → 需 ACC 侧守卫（§4.2） |

---

## 2. 需求逐条对账（用户 R1~R5 → 现状）

| 用户需求 | 现状 | 处置 |
|---------|------|------|
| R1 可选 `model`/`provider`，不传=现状 | **已实现**（E1/E4）；不传即继承父路由 | 只需开启 |
| R2 模型白名单 | 宿主侧**已有** `allowedModels`（E3/E5），但**全局**、非 per-CCC | 宿主白名单照用；**CCC 级收窄由 ACC 补**（§4.2） |
| R3 只切 LLM 后端，注入/工具/回传不变；嵌套继承 | **已实现**（E4：只影响 `agentOptions`；子会话继承策略 C1） | 无需动作 |
| R4 目标模型不可用 → 清晰报错不静默 | **已实现**（E6 preflight） | 无需动作 |
| R5 可发现模型清单 | **已实现**（E7 `list_subagent_models`） | ACC 再把允许路由写进注入（免模型多跑一次） |

> 结论：**R1/R3/R4/R5 是"开箱即有"**；只有 R2 的 CCC 粒度是真正的缺口。

---

## 3. 需求场景核对（R→C→T 与工具形态）

| 角色 | 工具调用形态 | 说明 |
|------|------------|------|
| R 研究员（主 agent） | 不变 | — |
| C 协调者 | `subagent(prompt, description, run_in_background:false)` | 继承主会话模型（现状即满足） |
| **T 测试者 ×77** | `subagent(prompt, description, provider:"minimax-cn-coding-plan", model:"MiniMax-M3", run_in_background:false)` | **串行前台等待**：`subagent` 实例是 `continuable`（默认后台），显式 `run_in_background:false` 才前台等结果 → 与"单浏览器全局串行"契合 |

- **为什么用 `subagent` 而非 `subagent_fork`**：fork 把父会话已完成轮次喂给子 agent（继承上下文），T 用例应"自包含、只留证据不做判断" → `subagent`（spawn，自包含）正确；且 fork 改路由会"阻止 provider 侧复用继承前缀"（README 明示）。
- **成本杠杆**：T 层从 flash 切 M3，按两家现行计价即得节省（具体比例由你核算，本方案不臆造数字）。

---

## 4. 方案设计

### 4.1 A 面：部署开启（一次性，机器级）

**A1 给 `subagent` 实例打开开关**（`~/.dsh/profiles/web/cordis.patch.yml` 追加 patch 行；只选一个实例，C2）：

```yaml
- id: tool-subagent
  config:
    modelSelectionSettings: true
```

**A2 填宿主设置**（`~/.dsh/settings.yaml`，或 WebUI 设置面板同名字段）：

```yaml
subagent-model-selection:
  enabled: true
  allowedModels:
    - provider: minimax-cn-coding-plan
      model: MiniMax-M3          # T 层廉价模型
    - provider: deepseek-official
      model: deepseek-v4-flash   # C 层中档
```

**A3 生效条件**：重启 dsh web（profile patch 变更）+ **新开会话**（C1；已存在会话不获得参数）。

**A4 验证（四条，缺一不可）**：① 新会话 `subagent` schema 出现 `provider`/`model`/`reasoning_effort` ② 工具列表出现 `list_subagent_models` ③ 调 `list_subagent_models` 返回两条路由 ④ 用非法 model 调用 → 得到**清晰报错**（preflight，E6）而非静默失败。

### 4.2 B 面：ACC（dsp）侧贡献 —— CCC 级治理与可发现性

> 归属二分（D23）：**机制与数据归 ACC，措辞与纪律归 CCC**。宿主开关是部署事实，CCC 的"哪些模型允许在本容器内被用"是数据。

| 项 | 设计 | 理由（R↓） |
|---|------|-----------|
| **B1 CCC 白名单守卫** | CCC 配置新增 `subagent.models: ["provider/model", ...]`（缺省=不额外收窄，宿主策略生效）；`seams/guards.ts` 在既有 `tools/pre-execute` 里对 `exec.name ∈ {subagent, subagent_fork}` 且 args 带 `provider`/`model` 的调用做校验，路由不在 CCC 列表 → `{kind:'deny', reason:"…允许的路由：… 用 list_subagent_models 查看"}` | 宿主 `allowedModels` 是全局的（C3），per-CCC 收窄只能由 ACC 机械守卫实现；守卫是 deny 而非"提醒"，与路径边界同族 |
| **B2 可发现性注入** | 注入块（toolsBlock 或状态块）加一行：`Subagent model routes allowed in this CCC: <列表>`（未配置则不注入） | 免去模型每轮先调 `list_subagent_models`；且让"允许什么"在系统提示里可见 |
| **B3 配置文档与指南** | `msm-ops.ts` CCC_CONFIG_REFERENCE 新增 `subagent` 段；`container_admin msm guide` / CCC 配置参考同步；skill 记录"开启姿势 + 三条约束 C1~C3" | 这是最容易踩坑的地方（新会话才生效、只能一个实例）——必须落文档 |
| **B4（可选）设置面板** | 若你希望 WebUI 能配，ACC 设置面板加只读展示 + 链接指引（**不代管宿主设置**） | ACC 不应拥有宿主设置；只做指引 |
| **B5（可选）回退兜底** | 若目标模型不可用，ACC 不做自动降级（错误已清晰，E6）；仅在 guide 里给"改回继承"的写法 | 静默降级会掩盖成本/质量问题 |

### 4.3 明确不做（边界）

- ❌ **不改 harness**（D4）：不 patch `dsh-tool-subagent` 源码、不 fork 该包。
- ❌ **不新增 ACC 工具**：不造 `subagent_model` 之类平行工具——会与原生参数形成双真相源。
- ❌ **不重复实现 model 解析/白名单**：宿主已做（E4/E5/E6）；ACC 只做 CCC 收窄。
- ❌ **不动 `subagent_fork` 的开关**（C2：全局名冲突）。

---

## 5. 备选方案（若 A 面不想动部署）

| 备选 | 做法 | 代价 | 何时选 |
|------|------|------|--------|
| **B-1 静态角色实例** | 额外挂一个 tool-subagent 实例：`toolName: subagent_m3` + `agentOptions: {provider, model}`（无需宿主设置、**无需新会话**，立即生效） | 每加一个模型加一个实例；工具名≠`subagent`，"角色=工具名" | 想要"角色级默认模型"且不想碰宿主设置 |
| **B-2 只改实例默认模型** | 直接给现有 `subagent` 实例加 `agentOptions.model`（所有子 agent 固定廉价模型） | 全局一刀切，C 层也被降级 | 仅当所有子 agent 都该用廉价模型 |
| **B-3 继续绕道 handyman** | 现状（并行 jobs） | 与 E2E 全局串行冲突 | 不推荐 |
| **B-4 上游提需求** | 让 DSH 把 model 做成默认参数（无需设置） | 不可控时点 | 长期最干净，但当前已无需等待 |

> **推荐**：A1+A2+B1+B2+B3（动态选择为主）；若你更看重"无需新会话、角色即工具名"，则改用 B-1。

---

## 6. 待你拍板（Q1~Q6）

| # | 决策点 | 选项 | 我方建议 |
|---|--------|------|---------|
| Q1 | 是否走 A 面（部署开启动态选择） | 是 / 否（改走 B-1 静态实例） | **是**（能力最全，含 reasoning_effort 与发现工具） |
| Q2 | 开在哪个实例（C2 只能一个） | `subagent` / `subagent_fork` | **`subagent`**（spawn 自包含；fork 不适合 T 用例） |
| Q3 | `allowedModels` 初始清单 | 仅 M3 / M3+flash / 更多 | **M3 + flash**（T/C 两档） |
| Q4 | 是否要 CCC 级白名单守卫（B1） | 要 / 不要（只靠宿主全局） | **要**（per-CCC 收窄是唯一真缺口） |
| Q5 | 是否要注入可发现性（B2） | 要 / 不要 | **要** |
| Q6 | 版本与节奏 | 并入下一个 patch（v1.31.3）/ 单独一版 / 先只在你这台机器手工开（不写代码） | **先手工开启验证 E2E**（零代码验证价值），确认有效后再做 B1/B2 落版 |

---

## 7. 落地步骤与验证清单

1. **手工验证（0 代码，最快闭环）**：A1+A2 → 重启 dsh web → **新开会话** → 四条验证（A4）→ 在 E2E 里把 T 层换成带 `provider`/`model` 的 `subagent` 调用，跑 2~3 例看成本与成功率。
2. **若验证通过**：实现 B1（守卫）+ B2（注入）+ B3（文档）→ test/typecheck/build → CHANGELOG + bump（v1.31.3）→ 三仓 commit → 发布链（D14 你点头）。
3. **若 A 面不可行**（例如 patch 不生效或 provider 不支持 agentOptions）：改走 B-1 静态实例，再评估 B1/B2。
4. **回归项**：不开启时不传参数的行为必须与现状逐字一致（现有 `subagent` 调用零影响）。

## 8. 风险与回滚

| 风险 | 处置 |
|------|------|
| 廉价模型工具遵循度低 → T 层"只采证据"也可能漏采 | 先跑 2~3 例对照；T 层设计本就"只留证据不做判断"，且失败会 errored 返回（可重试） |
| 改路由使 fork 无法复用继承前缀 | 只对 `subagent`（spawn）用模型选择；fork 不开 |
| 宿主设置改错导致挂载失败 | `enabled:true` 且 `allowedModels:[]` 会被校验拒绝（E3）——设置层即兜底 |
| patch 改坏 profile 组合 | 回滚 `cordis.patch.yml`（同目录已有多个 `.bak`）+ 重启 |
| 已存在会话看不到参数（C1）被误判为"没生效" | 写进文档与验证清单：**必须新开会话** |

## 9. 参考

- 安装版源码：`/home/yh/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tool-subagent/`（`lib/index.js` / `lib/model-selection-settings.js` / `lib/types/*.d.ts`）
- 包文档：同目录 `README.md` §"Selecting a child LLM"（权威描述：开关、采样时机、一条实例限制、route 合并与 preflight）
- 配置现状：`dsh-develop dump-config subagent`｜`~/.dsh/settings.yaml`｜`~/.dsh/profiles/web/cordis.patch.yml`
- 使用方手册：`tg-bot/references/BOT-TESTING.md`（R→C→T 成本分工）
