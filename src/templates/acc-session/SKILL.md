---
name: acc-session
description: 工作会话全周期知识映射（v1.30：session + session_rebuild → logbook）。list/show/create/use/close/health/qa/archive/summary/rebuild 操作 AGENT_SESSIONS/ 目录；rebuild = Ship of Theseus 原地清空重建。多步骤工作必须先创建会话。
---

# Skill: acc-session — 工作会话全周期（logbook 知识映射）

> **v1.30.0 工具面重构**：`session` + `session_rebuild` → **`logbook`**（The Logbook / Theseus 隐喻——rebuild 并入为子命令）。本技能是知识映射——真实工具由 Native Cordis 插件进程内注册（`logbook`），scripts/ 已退役为空目录。

## 用途

管理 CCC 根目录下 `AGENT_SESSIONS/` 的工作会话（与 home-session 约定一致）：
每个会话目录 = 一个工作上下文，`SESSION.md` 是唯一必需文件。**多步骤工作（3 步以上）必须先创建会话**。

## 调用

```json
logbook { action: "<subcommand>", name: "<S###|目录名|关键词>", summary: "<≤20字>", confirm: true }
```

| 子命令 | 说明 |
|--------|------|
| `list` | 状态摘要：列出所有会话（目录名 + 状态 + 最后修改时间） |
| `show` | 查看会话 SESSION.md 内容（模糊匹配：编号/目录名/内容关键词） |
| `create` | 创建新会话（`--desc <desc>` 或 `--issue <ticket>` 二选一 + `--summary`；目录 `YYYY-MM-DD--S###--<desc>/`） |
| `use` | 激活会话（当前 dsh 会话绑定该 SESSION + 重命名为 `S###-YYYY-MM-DD-<summary>`）；**硬守卫 G1**（已绑定 + 目标≠当前 → 拒绝需 `--force`） |
| `close` | 关闭会话（需 `--name` + `--confirm`，不可逆） |
| `health` | 健康检查：stale（>14 天未更新）/ 无 SESSION.md / 状态未收口 |
| `qa` | 事实核对：SESSION.md 中记录的产出物路径是否真实存在 |
| `archive` | 归档：标记状态为已完成 + 追加归档时间戳 |
| `summary` | 仪表盘：总数 / 进行中 / 已完成 / 最近活动 / 警告 |
| `rebuild` | **F2 轨迹重建（原 session_rebuild）**：完全丢弃当前 dsh 会话 → 归档旧 → 新建 rebuild-* → 注入「继续 S### 的工作」；需 `--summary`（必填）+ 可选 `--note`（任务焦点 ≤200 字） |
| `hook-develop-guide` | CCC 会话扩展指南 |

## 会话命名规范

- 目录：`YYYY-MM-DD--S###--<short-description>`（小写英文连词符，≤5 词）
- S###：自动分配（当前最大 + 1，3 位补零）
- dsh 会话标题：`S###-YYYY-MM-DD-<summary>`（summary ≤20 字，use/create/rebuild 必填）
- **SESSION 绑定持久化（v1.29.1）**：`serenity/bound` 会话事件随 session.jsonl 持久化（跨 rebuild/重启）——use 硬守卫防 LLM 静默换 SESSION；编码无关（锚=完整目录名）

## 纪律（强制）

1. **多步骤工作（3 步以上）必须先 `logbook create` 会话**，再开始干活
2. 进度记录随时追加（时间戳 + 做了什么）
3. 关闭/收尾时：记录未解决问题，然后 `logbook close --confirm` 或 archive

## 何时使用

- 任何多步探索/分析/设计/实施工作
- 被 rebuild 提醒（[TRAJECTORY-ASSISTANT · LIMIT]）要求重建时 → `logbook rebuild`

## 参考

- 会话模板细节：`home-session` 技能（.opencode/skills）
- 身份与工具映射总览：`acc-serenity` 技能
