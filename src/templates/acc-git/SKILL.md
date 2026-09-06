---
name: acc-git
description: 容器 git 知识映射（v1.30：cc_git → container_git）。status/commit/push/log/pull/diff 六子命令，非快进推送自动输出建议。pull/merge/rebase/冲突解决走 bash（不 Mech 化）。localstore git 合规联动。
---

# Skill: acc-git — 容器 git 操作（container_git 知识映射）

> **v1.30.0 工具面重构**：`cc_git` → **`container_git`**（硬切无别名）。本技能是知识映射——真实工具由 Native Cordis 插件进程内注册（`container_git`），scripts/ 已退役为空目录。

## 用途

在 CCC 根内执行高频 git 操作，输出可审计。与 DSH bash 中的裸 git 相比：路径钉在 CCC 根、push 带非快进保护建议。

## 调用

```json
container_git { action: "<subcommand>", message: "<msg>", count: <n> }
```

| 子命令 | 说明 |
|--------|------|
| `status` | `git status --porcelain`（透传输出） |
| `commit` | `git add -A` + `git commit -m`（无改动时输出提示） |
| `push` | `git push`；非快进被拒时输出操作建议（不自动 force） |
| `log` | `git log --oneline`（默认 10 条，max 100） |
| `pull` | 拉取远程变更 |
| `diff` | 查看工作区/暂存区/ref 差异 |

## 不 Mech 化的操作（与 ACC 标准一致）

`merge` / `rebase` / 冲突解决 → 走 bash（需要人工判断与交互），不封装。

## push 非快进建议

push 被拒（non-fast-forward）时，本工具输出建议并拒绝，**绝不自动 force**：

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
