# handyman（杂工）设计方案 — dsh-serenity-plugin v1.24.0

> 状态：**方案待用户确认**（S142，2026-08-27）
> 背景：loop（牛马）在 DSH 的存留问题调研——用户明确需求：**同步**的自主递归 worker（指定模型 → 内部再派同样低能的 subagent → 完成大量工作），模型**必须 CCC 白名单可控**，完成标准对齐 osp loop。命名用户拍板 **handyman（杂工）**。

---

## 0. 需求定位（用户原话 → 设计约束）

| 用户需求 | 设计约束 |
|---------|---------|
| "派一个低能 agent，指定模型" | `handyman` 工具：创建指定模型的 worker agent |
| "只能使用 CCC 配置的模型" | **模型白名单**：`.opencode/serenity.json` 配置 `handyman.models[]`，工具只允许白名单内模型（防手滑用贵模型） |
| "内部可以自己做 subagent（同样低能）" | worker 工具面含 `subagent` 工具 → 子代理**继承 worker 模型**（DSH `resolveChildAgentOptions` 原生机制，child-agent.ts:68-83 实证）——递归同模型零额外代码 |
| "完成标准参考 osp loop" | **stop-token 唯一完成判据** + 100 轮保险阀 + 异常重启 ≤100 + 进度文件续跑（osp loop-runner 语义） |
| "具备 workflow 的能力（主 agent 进行编排）" | `jobs` 参数：主 agent 一次编排多个杂工并行，各自独立 stop-token/进度/完成，全部完成后汇总 |
| "我希望同步" | 工具 execute **同步阻塞**直到完成（与当前 loop 一致，不异步化） |

---

## 1. 工具形态

```text
handyman(task, label, [model], [jobs])
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `task` | string | 单任务时必填 | 既定目标（对齐 osp：>100 字符，含任务背景/目标/完成判定方式/相关路径） |
| `label` | string | 单任务时必填 | 任务标签（进度文件 `handyman-<label>.md/.json`；同 label 续跑） |
| `model` | string | 选 | 必须 ∈ `handyman.models` 白名单；缺省 `handyman.defaultModel` |
| `jobs` | array | 编排模式必填 | `[{task, label, model?}, ...]`——主 agent 编排多个杂工并行 |
| `guide` | boolean | 选 | 打印规模化使用指引（EAP 设计/并行策略/提示词规范） |

### 两种调用形态

**A. 单任务**（既有 loop 语义，改名）：
```
handyman(task="扫描 SQC 并修复 DC 问题", label="sqc-scan", model="minimax-cn-coding-plan/MiniMax-M3")
→ 同步阻塞：worker agent 循环到 stop-token → 返回 { done, rounds, finishReason, lastResponse, progressFile }
```

**B. 多任务编排**（workflow 能力，主 agent 编排）：
```
handyman(jobs=[
  { task="扫描 A 仓库", label="scan-a", model="…" },
  { task="扫描 B 仓库", label="scan-b", model="…" },
  { task="扫描 C 仓库", label="scan-c" },
])
→ 并行 N 个 worker agent（各自独立 session/stop-token/进度文件）
→ 全部完成（或任一 fatal）返回汇总 [{ label, done, rounds, finishReason, lastResponse }]
```

---

## 2. 核心机制

### 2.1 模型白名单（CCC 配置）

`.opencode/serenity.json`（规范位置；`.dsh/serenity.json` 回退）：

```json
{
  "handyman": {
    "models": ["minimax-cn-coding-plan/MiniMax-M3", "deepseek/deepseek-v4-flash"],
    "defaultModel": "minimax-cn-coding-plan/MiniMax-M3",
    "maxRounds": 100,
    "maxParallel": 5
  }
}
```

- `models`：**必配**（白名单）；工具 execute 校验 `model ∈ models`，否则报错并列出可用模型
- `defaultModel`：缺省（必须 ∈ models）；缺省取 models[0]
- **兼容迁移**：旧 `loop.defaultModel` 读取 → 映射到 `handyman.defaultModel`（有 handyman 配置则优先）
- **递归继承**：worker 内部 subagent **不校验白名单**（模型 = 继承的 worker 模型，天然在白名单内）；DSH subagent 工具实例**不得配置固定 agentOptions**（否则覆盖继承，破坏"同样低能"）

### 2.2 完成标准（osp loop 对齐）

```
每轮：
  1. buildRoundPrompt：回顾进度（读 handyman-<label>.json）→ 本轮自由工作 → 汇报
  2. 注入本轮随机 stop-token
  3. worker agent 自由工作（读/写/派 subagent 拆解子任务）
  4. 读回复 → 含 stop-token → done；否则下一轮
保险阀：
  - 轮次上限 maxRounds（默认 100）→ finishReason=max_rounds，可续跑
  - 异常停止重启 ≤100 次 → finishReason=restart_exceeded
进度：
  - handyman-<label>.md（人读）/ .json（机器读，续跑依据）
  - 同 label 再调 → 从进度文件下一轮开始（无重做）
```

### 2.3 递归 subagent（同样低能，DSH 原生机制）

```
worker agent（handyman 创建，模型=M）
  → 工具面含 subagent 工具（继承父 preset/全局层）
  → 内部 subagent 委托 → resolveChildAgentOptions(parent=worker)
     → 子代理 provider/model = worker 的 M ✓（child-agent.ts:68-83 实证）
```

- **零额外代码**：模型继承是 DSH 原生语义，只需保证 worker 工具面含 subagent 且 subagent 工具实例无固定 agentOptions
- **深度控制**：subagent `maxDepth` 默认 3（DSH tool-subagent 配置）——防失控递归

### 2.4 编排（jobs 并行）

- 工具 execute 内 `Promise.all(jobs.map(…))`：每 job 独立 `ctx.agents.create` + 独立 while 循环（独立 stop-token/进度文件/rounds）
- 上限 `maxParallel`（默认 5）防资源爆炸；超出报错
- 语义：**同步等待全部完成**（用户拍板同步）——主 agent 编排者角色，一次提交多任务并行收割
- 与 DSH `workflow` 分工：workflow = 脚本编排（可编程 pipeline/parallel + per-agent 模型 override，适合可拆大批量）；handyman = 主 agent **对话内直接编排** + 模型白名单 + 自主完成判定（适合"任务边界清晰、模型受控、自主长跑"）

---

## 3. 实施改动清单（v1.24.0）

| 文件 | 改动 |
|------|------|
| `src/tools/loop.ts` → `src/tools/handyman.ts` | 重命名 + 模型白名单校验 + `jobs` 编排参数 + 工具名/描述更新 |
| `src/loop-ops.ts` → `src/handyman-ops.ts` | 进度文件 `handyman-<label>.md/.json`；`loopProgressPaths` → `handymanProgressPaths` |
| `src/loop-preset-inherit.ts` → `src/handyman-preset-inherit.ts` | 随工具重命名（worker 创建时 preset 继承——工具面含 subagent 的关键） |
| `src/ccc.ts` | `SerenityConfig.loop.defaultModel` → `handyman.{models, defaultModel, maxRounds, maxParallel}`（读旧 loop.defaultModel 兼容） |
| `src/seams/system-prompt.ts` | 工具清单 `loop` → `handyman`；loop default model 注入 → handyman default model |
| `src/seams/context.ts` | `loop-` session 前缀判定 → `handyman-`（worker session 命名 `handyman-<label>-<uuid>`）；ACC 注入 loop 模型行同步 |
| `src/seams/bootstrap.ts` | `loop-` 前缀恒 promoted / 免锚定 → `handyman-`（或保留双前缀兼容） |
| `src/index.ts` / `src/invariant.ts` | REGISTERED_TOOLS `loop` → `handyman`；inject 不变 |
| `src/api.ts` | `/serenity/loops` → `/serenity/handymen`（WebUI 等待界面数据源） |
| `src/client/SafeModePanel.tsx` | loop 运行状态区块文案同步 |
| `tests/*` | loop-ops/loop tool/keeper/context/bootstrap 测试随改名更新 + 白名单/jobs 新测试 |
| `README.md` / `README.en.md` | loop → handyman 全量同步（特性表/工具表/session_rebuild 段落） |
| `docs/` | 本方案文档归档 `handyman-design.md` |

**不变量**：worker session 命名 `handyman-<label>-<uuid>`（`loop-` 前缀保留兼容判定——已存在的 loop 进度文件不受影响；新调用一律 handyman-）。

---

## 4. 待用户确认

1. **jobs 并行上限**：默认 5 合理？（防资源爆炸）
2. **worker 工具面是否含 handyman 本身**：建议**不含**（递归编排归主 agent，worker 内部只走 subagent）——防无限嵌套失控
3. **旧 loop 进度文件**：保留兼容（`loop-` 前缀进度文件仍可被 handyman 续跑）还是仅新 handyman-？
4. **模型白名单必配**：`handyman.models` 缺失时——报错要求配置，还是回退 `loop.defaultModel` 单模型？
