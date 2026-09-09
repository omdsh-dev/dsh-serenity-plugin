# handyman 双模式（background / foreground）—— 方案设计 v0.3（ACC 自实现）

- **需求方**：宁静号天工 Bot 体系（2026-09-09）——「ACC subagent 工具支持按角色指定模型」
- **设计方**：S142（dsp 维护会话）· 2026-09-09
- **用户裁决链（R↓）**：
  1. 「dsh 有配置但没放开估计是有原因的，我们要在 ACC 层去自动实现才行；所以我主要考虑 B 面」→ **放弃宿主设置路线**
  2. 「实际上具体的 CCC 总是会指定低成本模型，所以只要有个 subagent 机制可以使用低成本模型就好」→ **目标收窄为：一个能用低成本模型的委派机制**
  3. 「名字上我们都叫 handyman 吧，分为 background 和非 background 两种，前者是旧的自带循环校验的实现，后者是我们本次所需的简单实现」→ **不新增工具；`handyman` 加模式维度**
- **状态**：待审核（Q1~Q4 见 §7）；**未动代码**

---

## 1. 形态（E↑）

**工具名不变（`handyman`），新增 `mode` 参数，工具面 11 保持不变**：

```
handyman(mode?, task?, label?, model?, jobs?, session?, guide?)
  mode = "background"（缺省，旧实现，向后兼容） | "foreground"（新，本次所需）
```

| 模式 | 实现 | 语义 | 适用 |
|------|------|------|------|
| **background**（缺省） | **既有实现，一行不改**：`ctx.agents.create` + 内部 while 硬循环 + 随机完成码（stop-token）判据 + 轮次上限（默认 100）+ 异常自动重启（≤100）+ 进度文件 `AGENT_SESSIONS/handyman-<label>.md/.json` + `jobs` 并行（`maxParallel` 默认 10） | "自带循环校验的杂工"：抗低智模型提前收工，适合长任务/无人值守 | 大规模扫描、多 job 并行、可续跑 |
| **foreground**（新） | **本次新增，最小实现**：`ctx.subagents.start('spawn', {…})` → `await run.result` → `await run.dispose()` → 返回子 agent 最终文本 | "一次前台串行委派"：不循环、不校验、不写进度文件 | **E2E 的 T 层**（77 例逐个串行、用低成本模型、只采证据） |

**为什么 foreground 走 `ctx.subagents.start` 而不是沿用 `ctx.agents.create`**（R↓）：
- `subagents.start` 是宿主**委派正门**——深度上限、子 agent 所有权、`subagent/start|end` 生命周期事件、`run.dispose()` 静默收尾全部沿用宿主实现；
- 启动请求原生支持 `agentOptions: { provider, model }`（`SubagentStartRequest.agentOptions`，`spawn` 后端能力位 `agentOptions: true`），**无需任何宿主设置**；
- background 模式**保持 `ctx.agents.create` 原路径不动**——改它属行为变更、零收益、有回归风险。

---

## 2. 参数矩阵

| 参数 | background | foreground | 说明 |
|------|:---:|:---:|------|
| `mode` | — | ✓ | `"background"`（缺省）/ `"foreground"`；缺省=旧行为（零影响） |
| `task` | ✓（单任务） | ✓ | 任务描述（foreground 要求自包含：子 agent 不共享本会话上下文） |
| `label` | ✓（进度文件名） | 可选（子会话显示名） | foreground 不写进度文件 |
| `model` | ✓ | ✓ | `provider/model`，**必须 ∈ CCC `handyman.models`**；缺省 = `handyman.defaultModel` |
| `jobs` | ✓ | ✗ | foreground 只接受单个 `task`（多任务请循环调用或走 background） |
| `session` | ✓ | ✗ | 进度上下文提示（仅 background 有进度文件） |
| `guide` | ✓ | ✓ | 打印使用指引（不创建 agent） |

> **零新增配置**：模型池与缺省模型**沿用既有 `handyman.models` / `handyman.defaultModel`**——CCC 只维护一处"低成本模型池"（这正是"具体的 CCC 总是会指定低成本模型"的直接落地）。

---

## 3. foreground 的机制细节

### 3.1 调用（与 `dsh-tool-subagent` 前台路径同构）

```ts
const run = await ctx.subagents.start('spawn', {
  label,                                        // 子会话显示名（可选）
  prompt: [{ type: 'text', text: task }],
  parent: exec.agent,                           // 委派归属（深度/谱系由此派生）
  signal: exec.signal,                          // 取消通道（与原生工具同源）
  agentOptions: { provider, model },            // ← 低成本模型
  toolFilter: { deny: ['handyman'] },           // 递归防护（见 3.3）
})
const result = await run.result                 // SubagentResult
await run.dispose()                             // 幂等，必调
```

### 3.2 结果与失败

| 情形 | 行为 |
|------|------|
| `stopReason === 'completed'` | 返回子 agent 最终文本（`result.output` 文本块拼接）+ `model` 标注 |
| 其他 stopReason（`error` / `aborted` / `max-tokens` / `refusal`） | **errored 结果**：含 stopReason + `result.diagnostic`（若有）+ 已产出的部分文本——**不静默、不假装成功** |
| `model` 不在 CCC 白名单 | 调用前拒绝，并列出白名单（与 background 同一 `requireWhitelistedModel`） |
| `ctx.subagents` 服务缺失 | 响亮报错并指引（服务缺失=宿主契约降级，不进 hostContract 必需集） |
| 模型不可用 / provider 无 `agentOptions` 能力 | 宿主服务在 start 前拒绝 → 原样抛出（含路由信息），**不自动降级到父模型** |

### 3.3 递归防护

background 模式靠 `handymanPresetInheritance` 在子 scope `tools.restrict({ deny: ['handyman'] })`；foreground 用 spawn 的 `toolFilter` 能力做同一件事：`toolFilter: { deny: ['handyman'] }`——**编排归主 agent**，子 agent 不能自己再开杂工。

### 3.4 不写进度文件 / 不建工作台

foreground 是"一次调用一次结果"，不产生 `AGENT_SESSIONS/handyman-<label>.*`；子会话是 `origin=subagent` 的临时身份，不建 SESSION 工作台（对齐 v1.30.9 的"临时身份不建工作台"修复）。

---

## 4. 返回形状（两种模式可区分）

```jsonc
// background（不变）
{ "done": true, "jobs": [{ "label": "scan-a", "rounds": 3, "finishReason": "done", "model": "…", … }], "usage": {…} }

// foreground（新）
{ "done": true, "mode": "foreground", "model": "minimax-cn-coding-plan/MiniMax-M3",
  "stopReason": "completed", "output": "<子 agent 最终文本>", "childId": "…", "usage": {…} }
```

---

## 5. 实现清单

| 文件 | 改动 |
|------|------|
| `src/tools/handyman.ts` | 新增 `mode` 参数 + 分支：`foreground` → 新 `runForegroundJob()`（`ctx.subagents.start` 路径）；`background` 原逻辑零改动；description 写清两模式与选择判据 |
| `src/host/contract.ts` | 服务表新增 `subagents`（lazy，`required: false`；成员 `start`）→ hostContract 检查数 34 → 35 |
| `src/handyman-ops.ts` | 复用既有 `readHandymanConfig` / `splitModel` / `requireWhitelistedModel`（无新配置段） |
| 文档 | `msm-ops` CCC_CONFIG_REFERENCE handyman 段补两模式说明 + README 中英 + 维护 skill + CHANGELOG |
| 工具面 | **11 不变**（无声明面三处同步问题；`invariant.ts` / `dsh.plugin.json` / description 均无需改工具清单） |
| 版本 | **v1.32.0**（新能力，工具数不变 → 仍属 minor） |

### 测试

- `mode` 缺省 = background（向后兼容，现有用例零改动）
- foreground 路径（fake `ctx.subagents`）：断言 `agentOptions.{provider,model}`、`parent`、`signal`、`toolFilter.deny=['handyman']` 传递；`dispose()` 被调；返回形状含 `output`/`model`/`stopReason`
- 失败矩阵：stopReason 非 completed → errored + diagnostic；模型不在白名单 → 拒绝；`ctx.subagents` 缺失 → 响亮报错
- 两模式共享模型解析（白名单/缺省）的对照用例

---

## 6. 风险

| 风险 | 处置 |
|------|------|
| 一个工具两套语义 → 模型误用（该 foreground 却用 background，或反之） | description 首行给**选择判据**："要一次串行结果 → foreground；要抗提前收工/并行/可续跑 → background"；参数矩阵写进 guide |
| 低成本模型遵循度低 | foreground 只做"一次委派"，不依赖模型自评完成（这正是 background 循环校验存在的原因）；失败以 errored 结果暴露 |
| 子 agent 与原生 `subagent` 职责重叠 | 文档明确：原生 `subagent` = 继承父模型；`handyman` = CCC 配置的模型（低成本池） |
| `subagents` 服务在旧宿主缺失 | hostContract 标记为 lazy/非必需 + 调用时响亮报错 |

---

## 7. 待你拍板

| # | 决策点 | 选项 | 建议 |
|---|--------|------|------|
| Q1 | 模式参数形态 | `mode: "background"\|"foreground"` / `background: boolean` / 其他 | **`mode`**（显式、可扩展；缺省 `background` 保证兼容） |
| Q2 | 缺省模式 | `background`（兼容） / `foreground` | **`background`**（现有调用零影响） |
| Q3 | foreground 是否写进度文件 | 不写 / 写 | **不写**（一次调用一次结果；保持工作区干净） |
| Q4 | 版本 | v1.32.0 / 并入下一个 patch | **v1.32.0** |

> 另：`reasoning_effort` 参数 v1 **不加**（"简单实现"优先；`AgentOptions` 已支持，留作扩展点）。

## 8. 参考

- `…/dsh-subagent/lib/types/types.d.ts`：`SubagentStartRequest`（`agentOptions` / `toolFilter` / `maxDepth`）、`SubagentRun`（`result` / `dispose`）、`SubagentResult`（`output` / `diagnostic` / `stopReason`）
- `…/dsh-subagent-spawn-in-process/lib/index.js`：`capabilities = { agentOptions: true, toolFilter: true, … }`
- `…/dsh-tool-subagent/lib/index.js`：前台 run 的 settle/dispose 范式（本方案同构）
- 本仓先例：`src/tools/handyman.ts`（background 实现）、`src/handyman-preset-inherit.ts`（递归防护）
