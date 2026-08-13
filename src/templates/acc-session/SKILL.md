---
name: acc-session
description: 工作会话全周期管理（session 语义，DSH 版）。list/show/create/health/qa/archive/summary 操作 AGENT_SESSIONS/ 目录。多步骤工作必须先创建会话。
---

# Skill: acc-session — 工作会话全周期管理

## 用途

管理 CCC 根目录下 `AGENT_SESSIONS/` 的工作会话（与 home-session 约定一致）：
每个会话目录 = 一个工作上下文，`SESSION.md` 是唯一必需文件。

## 操作协议

```bash
bun "<skill 基目录>/scripts/session-tool.ts" <subcommand> [args...]
```

| 子命令 | 参数 | 说明 |
|--------|------|------|
| `list` | — | 列出所有会话（目录名 + 状态摘要 + 最后修改时间） |
| `show` | `<S###\|目录名\|关键词>` | 查看会话 SESSION.md 内容（模糊匹配：编号/目录名/内容关键词） |
| `create` | `[--name <desc>] [--title <标题>]` | 创建新会话（自动分配 S###，命名 `YYYY-MM-DD--S###--<desc>/`） |
| `health` | — | 健康检查：stale（>14 天未更新）/ 无 SESSION.md / 状态未收口 |
| `qa` | `<S###>` | 事实核对：SESSION.md 中记录的产出物路径是否真实存在 |
| `archive` | `<S###>` | 归档：标记状态为已完成 + 追加归档时间戳 |
| `summary` | — | 仪表盘：总数 / 进行中 / 已完成 / 最近活动 / 警告 |

## 会话命名规范

- 目录：`YYYY-MM-DD--S###--<short-description>`（小写英文连词符，≤5 词）
- S###：自动分配（当前最大 + 1，3 位补零）
- SESSION.md：按 home-session 模板（目标/状态/关键决策/进度记录/产出物/未解决问题）

## 纪律（强制）

1. **多步骤工作（3 步以上）必须先 create 会话**，再开始干活
2. 进度记录随时追加（时间戳 + 做了什么）
3. 关闭/收尾时：记录未解决问题，然后 `archive`

## 退出码

| 码 | 含义 |
|----|------|
| 0 | 成功 |
| 1 | user 错误（缺参数 / 找不到会话） |
| 2 | system 错误（无 CCC / IO 失败） |

## 参考

- 会话模板细节：`home-session` 技能（.opencode/skills）
- 身份与工具映射总览：`acc-serenity` 技能
