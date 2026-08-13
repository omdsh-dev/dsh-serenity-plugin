---
name: acc-git
description: CCC 内 git 操作工具（cc-git 语义，DSH 版）。status/commit/push/log，非快进推送自动输出操作建议。pull/merge/rebase/冲突解决走 bash（不 Mech 化）。
---

# Skill: acc-git — git 操作（cc-git 语义）

## 用途

在 CCC 根内执行高频 git 操作，输出可审计。与 DSH bash 中的裸 git 相比：路径钉在 CCC 根、push 带非快进保护建议。

## 操作协议

```bash
bun "<skill 基目录>/scripts/cc-git.ts" <subcommand> [args...]
```

| 子命令 | 参数 | 说明 |
|--------|------|------|
| `status` | — | `git status --porcelain`（透传输出） |
| `commit` | `-m <msg>` | `git add -A` + `git commit -m`（无改动时输出提示） |
| `push` | — | `git push origin HEAD`；非快进被拒时输出操作建议（不自动 force） |
| `log` | `[-n <count>]` | `git log --oneline`（默认 10 条） |

## 退出码

| 码 | 含义 |
|----|------|
| 0 | 成功 |
| 1 | user 错误（缺参数 / commit 无消息） |
| 2 | system 错误（非 git 仓库 / git 命令失败 / push 被拒） |

## 不 Mech 化的操作（与 ACC 标准一致）

`pull` / `merge` / `rebase` / 冲突解决 → 走 bash（需要人工判断与交互），不封装。

## push 非快进建议

push 被拒（non-fast-forward）时，本工具输出建议并退出 2，**绝不自动 force**：

```
push rejected (non-fast-forward)
建议：
  1. git pull --rebase   # 先合并远程变更
  2. 重新 push
  3. 若确需覆盖远程：git push --force-with-lease（人工确认后）
```

## 何时使用

- 任何 CCC 内的提交/推送（取代裸 `git commit/push`）
- 会话记录收尾、MSM 注册后的自动提交

## 参考

- 身份与工具映射总览：`acc-serenity` 技能
- 分支约定/远程格式：`home-git` 技能（家庭 GitLab）
