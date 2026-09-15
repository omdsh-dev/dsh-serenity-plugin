---
name: acc-session
description: 轨迹追踪知识映射（v1.34：v1.33 logbook 并入 trajectory，v1.34 工具名改 container_trajectory）。list/show/create/use/rebuild + wake-later 操作 AGENT_SESSIONS/ 目录；rebuild = Ship of Theseus 原地清空重建。多步骤工作必须先创建轨迹。
---

# Skill: acc-session — 轨迹追踪（trajectory 知识映射）

> **v1.33/v1.34 工具面重构**：`logbook` **并入 `trajectory`**（v1.33，用户裁决「废除 logbook 这个词」——一条轨迹 = 持久身体 SESSION.md + 时间轴），**v1.34 工具名硬切为 `container_trajectory`**（准确性调整：前缀 `container` 表作用域=本容器内，不表地位）。本技能是知识映射——真实工具由 Native Cordis 插件进程内注册（`container_trajectory`），scripts/ 已退役为空目录。
>
> 动作收敛（原两工具 23 动作 → **6**）：`close` / `archive` 删（归档走 `container_fs mv → _archived/`）｜`health` / `qa` 并入 `use`（内联完整性检查，通过静默、不通过**提示**）｜`summary` 并入 `list`｜`hook-develop-guide` 并进 `container_admin msm guide`｜`wake-add`/`wake-list`/`wake-rm` → **`wake-later`**。

## 用途

管理 CCC 根目录下 `AGENT_SESSIONS/` 的轨迹（与 home-session 约定一致）：
每条轨迹 = 一个工作上下文，`SESSION.md` 是它的持久身体（唯一必需文件）。**多步骤工作（3 步以上）必须先创建轨迹**。

## 调用

```json
container_trajectory { action: "<subcommand>", name: "<S###|目录名|关键词>", summary: "<≤20字>", confirm: true }
```

| 动作 | 说明 |
|--------|------|
| `list` | 清单 + 统计：所有轨迹（目录名 / 状态 / 最后修改）+ 总数 / 进行中 / 已完成 / 最近活动 |
| `show` | 读**单条**轨迹的 SESSION.md 正文（模糊匹配：编号 / 目录名 / 关键词） |
| `create` | 新建轨迹（`--desc <desc>` 或 `--issue <ticket>` 二选一 + `--summary`；目录 `YYYY-MM-DD--S###--<desc>/`） |
| `use` | 激活轨迹（当前 dsh 会话绑定该 SESSION + 重命名为 `S###-YYYY-MM-DD-<summary>`）；**内联完整性检查**（目标存在？SESSION.md 在？长期无活动？——通过静默、不通过只提示）；**硬守卫 G1**（已绑定 + 目标≠当前 → 拒绝需 `--force`） |
| `rebuild` | **原地清空重建（Ship of Theseus）**：完全丢弃当前 dsh 会话 → 新建载体 → 注入「继续 S### 的工作」；需 `--summary`（必填）+ 可选 `--note`（任务焦点 ≤200 字）。**keeper 超限提醒依赖它** |
| `wake-later` | **定时唤醒**：未来时刻（RFC3339 或 `+30m`/`+2h`）+ 一条 message，可唤醒任一轨迹（含自己）；落点 `AGENT_SESSIONS/wake-registry.json`，中心调度器到点投递；**fire-and-forget——无回执、无回收** |

> 周期自唤醒（autopilot）不在本工具：见 `container_admin autopilot`（status / init / generate-bias）。

## 轨迹命名规范

- 目录：`YYYY-MM-DD--S###--<short-description>`（小写英文连词符，≤5 词）
- S###：自动分配（当前最大 + 1，3 位补零）
- dsh 会话标题：`S###-YYYY-MM-DD-<summary>`（summary ≤20 字，use/create/rebuild 必填）
- **SESSION 绑定持久化（v1.29.1）**：`serenity/bound` 会话事件随 session.jsonl 持久化（跨 rebuild/重启）——use 硬守卫防 LLM 静默换 SESSION；编码无关（锚=完整目录名）；**定时唤醒的目标定位也读它**（`.bindings.json` 反查）

## 纪律（强制）

1. **多步骤工作（3 步以上）必须先 `container_trajectory create` 轨迹**，再开始干活
2. 进度记录随时追加（时间戳 + 做了什么）；SESSION.md 体积有上限（缺省 200 KB，超限触发 rebuild 提醒）
3. 收尾时：把未解决问题写进 SESSION.md，并在状态行体现完成（**不再有 close 动作**——完成与否由 SESSION.md 自身表达）

## 何时使用

- 任何多步探索/分析/设计/实施工作
- 被 rebuild 提醒（[TRAJECTORY-ASSISTANT · LIMIT]）要求重建时 → `container_trajectory rebuild`
- 需要"未来某一刻自动继续/提醒另一条轨迹"时 → `container_trajectory wake-later`

## 参考

- 轨迹模板细节：`home-session` 技能（.opencode/skills）
- 身份与工具映射总览：`acc-serenity` 技能
- 调度总览（唤醒时间轴语义 / 五条硬约束）：插件仓 `docs/trajectory-scheduling.md`
