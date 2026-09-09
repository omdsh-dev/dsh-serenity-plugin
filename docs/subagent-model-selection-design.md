# ACC subagent 使用低成本模型 —— 方案设计 v0.2（B 面 / ACC 层自实现）

- **需求方**：宁静号天工 Bot 体系（2026-09-09）——「ACC subagent 工具支持按角色指定模型」
- **设计方**：S142（dsp 维护会话）· 2026-09-09
- **用户裁决（v0.2 依据）**：「dsh 有配置但没放开估计是有原因的，我们要在 ACC 层去自动实现才行；所以我主要考虑 B 面，实际上具体的 CCC 总是会指定低成本模型，所以只要有个 subagent 机制可以使用低成本模型就好」
- **状态**：待审核（Q1~Q5 见 §7）；**未动代码**
- **一句话**：**ACC 新增一个"模型绑定委派"工具**——用 CCC 配置的低成本模型跑子 agent，底层复用宿主既有的委派服务 `ctx.subagents.start()`（不重写 agent 创建、不碰宿主设置、不改 harness）。

---

## 1. 为什么走 B 面（用户裁决 + 技术依据 R↓）

| 路线 | 结论 | 理由 |
|------|------|------|
| **A 面：开宿主设置**（`subagent-model-selection` + `modelSelectionSettings`） | ❌ 放弃 | ① 用户判断"DSH 有配置但没放开估计有原因"——不依赖未放开的官方开关 ② 宿主设置是**全局**的（非 per-CCC），与"每个 CCC 自己定低成本模型"的诉求不匹配 ③ 只对新会话采样，存量会话无参数 |
| **B 面：ACC 自实现**（本方案） | ✅ 采用 | 机制归 ACC、模型归 CCC（D23）；不依赖未放开开关；per-CCC 天然成立 |
| 挂第二个 `tool-subagent` 实例（固定 `agentOptions`） | ⚠️ 备选 | 可行（宿主实例配置无需设置即生效），但需 ACC 去挂载宿主插件包 → 组合耦合 + 工具名/模型写死在组合层；且拿不到"按 CCC 配置解析 + 条件可见 + 池校验" |

---

## 2. 机制实证（全部来自安装版 0.1.2-rc.1 的类型/源码）

| # | 事实 | 证据 |
|---|------|------|
| E1 | 宿主提供委派服务 `ctx.subagents`，`start(name, request)` 启动一次性子 agent 并返回 `SubagentRun` | `…/dsh-subagent/lib/types/index.d.ts`：`SubagentRuntime.start(...)`；服务挂 `Context.subagents` |
| E2 | 启动请求**可带子 agent 的 LLM 路由** | `…/lib/types/types.d.ts`：`SubagentStartRequest { label?, prompt, parent, signal, agentOptions?, outputSchema?, maxDepth?, toolFilter?, persona? }`；`agentOptions` 注释："host-Agent provider, model, reasoning-effort, and output-token overrides … in-process providers merge them over the parent Agent's options" |
| E3 | `spawn` 后端**支持** `agentOptions`（能力位为真） | `…/dsh-subagent-spawn-in-process/lib/index.js`：`capabilities = { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true }`；`inheritsParentContext = false` |
| E4 | 能力位由服务在 start 前校验，缺能力**响亮拒绝**（不静默降级） | `types.d.ts`：`SubagentCapabilities` 注释 "fail loud, no silent degradation" |
| E5 | 一次性 run 的收尾：`run.result`（`SubagentResult`）+ `run.dispose()`；非 `completed` 的 stopReason 要映射成错误 | 同 `dsh-tool-subagent` 前台路径实现（`settleRun` / `stopReasonError`） |
| E6 | 宿主**不需要**任何设置即可让 `agentOptions` 生效（该路径与 `subagent-model-selection` 无关） | `tool-subagent/lib/index.js`：`...config.agentOptions !== undefined ? { agentOptions: config.agentOptions } : {}` 无条件进 request；模型选择设置只控制**模型面参数**是否暴露 |

> 结论：**ACC 有正门可用**——`ctx.subagents.start('spawn', { parent, prompt, signal, agentOptions:{provider, model} })`，深度限制 / 所有权 / 生命周期事件 / 清理全部沿用宿主实现。

---

## 3. 方案设计

### 3.1 形态（E↑）

**新增 ACC 工具**（模型绑定委派；与原生 `subagent` 并存，原生不动）：

```
subagent-model(prompt, description, model?, reasoning_effort?)
  → 前台串行：等子 agent 跑完，返回其最终文本（并标注实际使用的模型）
```

| 参数 | 必填 | 语义 |
|------|:---:|------|
| `prompt` | ✓ | 自包含任务（子 agent 不共享本会话上下文——`spawn` 后端 `inheritsParentContext=false`） |
| `description` | ✓ | 3-5 词标签（子会话显示名） |
| `model` | — | 必须是 CCC 模型池成员；缺省 = CCC 配置的默认低成本模型 |
| `reasoning_effort` | — | 透传 `agentOptions.reasoningEffort`（缺省用模型默认） |

- **串行为默认**（无 `run_in_background`）——正对 E2E「单浏览器全局串行」；后台能力留作 v2 扩展点。
- **不建工作台**：子会话是 `origin=subagent` 的临时身份，不建 `AGENT_SESSIONS` 目录（对齐 v1.30.9 的"临时身份不建工作台"修复）。

### 3.2 CCC 配置（数据归 CCC）

```jsonc
// .opencode/serenity.json
"subagent": {
  "model": "minimax-cn-coding-plan/MiniMax-M3",   // 缺省子 agent 模型（低成本）；缺省回退 handyman.defaultModel
  "models": ["minimax-cn-coding-plan/MiniMax-M3"], // 可选：模型池（model 参数须在池内）；缺省 = handyman.models
  "maxDepth": 3,                                    // 可选：委派深度上限（缺省 3，与原生一致）
  "toolFilter": { "deny": ["write", "edit"] }       // 可选：子 agent 工具收窄（T 角色"只留证据"）
}
```

- **零重复配置**：`subagent.models` / `subagent.model` 缺省继承 `handyman.models` / `handyman.defaultModel`——CCC 只维护**一处**"低成本模型池"。
- **条件可见**：无可用模型（`subagent.model` 与 `handyman.defaultModel` 皆空）→ 工具**从 schema 移除**（复用既有 `tools.restrict` 机制，与 `im-bridge` 同一先例）。

### 3.3 实现要点

| 点 | 做法 | 理由 |
|---|------|------|
| 委派 | `ctx.subagents.start('spawn', { label, prompt:[{type:'text',text}], parent: exec.agent, signal: exec.signal, agentOptions:{provider,model,reasoningEffort?}, maxDepth?, toolFilter? })` | 用宿主正门，不重写 agent 创建；深度/所有权/清理/事件全沿用 |
| 模型解析 | `model` 参数（须 ∈ 池）→ `subagent.model` → `handyman.defaultModel`；三者皆空 → 工具不可见 | 解析链单一、可预测 |
| 失败 | 模型不在池 → 拒绝并列出池；模型不可用 → 原样抛错（含路由）；**不静默回退** | 静默降级会掩盖成本/质量问题 |
| 结果 | 返回子 agent 最终文本 + `model=…` 标注；非 `completed` stopReason → errored 结果 | 成本可见 + 失败可见 |
| 可见性同步 | `seams/guards.ts` 新增 `syncSubagentModelVisibility(agent, root)`（对齐 `syncImBridgeVisibility`：Map<sessionId,disposer> + lifecycle 清理 + 判据抛错按放行） | 与既有条件可见机制一致 |
| 工具面 | 11 → **12** | 需同步 `invariant.ts` REGISTERED_TOOLS + `dsh.plugin.json` contributes.tools + 两处 description（**v1.31.1 教训：三处必须同改**） |

### 3.4 E2E 用法（R→C→T）

```
C 协调者：subagent-model(prompt=<T 用例>, description="T-01")                    ← 用 CCC 默认低成本模型
T 测试者：前台串行返回；只采证据不做判断
```

---

## 4. 明确不做（边界）

- ❌ 不改 harness、不依赖未放开的宿主设置（`subagent-model-selection`）
- ❌ 不重写 agent 创建（不用 `ctx.agents.create` 绕开委派服务——会丢深度限制/生命周期/所有权）
- ❌ 不做自动降级/重试（错误清晰即可）
- ❌ 不改原生 `subagent` / `subagent_fork` 的行为

---

## 5. 测试与文档

- **测试**：模型解析链（参数/CCC/回退 handyman/全空）、条件可见（有配置可见 / 无配置隐藏 / 热更新跟随 / 会话清理）、工具执行（fake `ctx.subagents` 断言 `agentOptions` 与 `parent`/`signal` 传递、`run.dispose()` 被调）、错误路径（不在池 / stopReason 非 completed / provider 无能力）、`register.test` 工具数 11→12、`invariant` 真实清单断言
- **文档**：README 中英工具表 + `msm-ops` CCC_CONFIG_REFERENCE 新增 `subagent` 段 + 维护 skill + specs §4.2（宿主特定能力行）+ CHANGELOG
- **版本**：新工具 = **v1.32.0**（minor）；发布链等 D14 显式指令

---

## 6. 风险

| 风险 | 处置 |
|------|------|
| 低成本模型工具遵循度低 | T 角色本就"只留证据不做判断"；失败以 errored 结果暴露，可重试 |
| 子 agent 与原生 subagent 职责重叠（熵） | 分工写进 description：原生=继承父模型；本工具=CCC 指定的低成本模型（并在文档明说） |
| 工具数增长 | 条件可见（未配置 CCC 不可见）；不配置即零占用 |
| `spawn` 能力位在旧版宿主缺失 | 启动时校验能力位，缺失则工具不注册并响亮告警（E4 同族语义） |

---

## 7. 待你拍板

| # | 决策点 | 选项 | 建议 |
|---|--------|------|------|
| Q1 | 工具名 | `subagent-model` / `subagent_model` / `delegate` / 其他 | **`subagent-model`**（与 `im-bridge` 同族连字符风格，语义直白） |
| Q2 | 配置来源 | 新 `subagent` 段（缺省回退 handyman）/ 直接复用 `handyman.*` | **新段 + 回退**（语义清晰且零重复） |
| Q3 | 是否保留 `model` 覆盖参数 | 保留（池内校验）/ 固定只用 CCC 默认 | **保留**（C/T 两档可共用同一工具） |
| Q4 | v1 是否带 `toolFilter` | 带 / 不带 | **带**（T 角色只留证据） |
| Q5 | 版本 | v1.32.0 / 并入下一个 patch | **v1.32.0**（新工具属 minor） |

## 8. 参考

- `…/dsh-subagent/lib/types/index.d.ts`（`SubagentRuntime` 服务）、`…/lib/types/types.d.ts`（`SubagentStartRequest` / `SubagentCapabilities`）
- `…/dsh-subagent-spawn-in-process/lib/index.js`（`agentOptions: true` 能力位）
- `…/dsh-tool-subagent/lib/index.js`（前台 run 的 settle/dispose 范式；本方案的工具实现与之同构）
- 先例：`im-bridge` 条件可见（`seams/guards.ts syncImBridgeVisibility`）
