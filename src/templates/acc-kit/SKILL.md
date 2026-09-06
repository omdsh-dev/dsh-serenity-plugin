---
name: acc-kit
description: 普适仪表知识映射（v1.30：acc_kit → dashboard）。health（CCC 三原则 P1/P2/配置 + MSM registry 完整性报告）/ time（now）/ wait（N 秒）。进入 CCC 工作前的例行自检，随时可看无副作用。
---

# Skill: acc-kit — 普适仪表（dashboard 知识映射）

> **v1.30.0 工具面重构**：`acc_kit` → **`dashboard`**（硬切无别名——舰桥仪表盘隐喻）。本技能是知识映射——真实工具由 Native Cordis 插件进程内注册（`dashboard`），scripts/ 已退役为空目录。

## 用途

提供三个随时可看的轻量能力（无副作用）：
- **health** — CCC 三原则健康检查（进入工作前例行自检）
- **time** — 当前时间（ISO 8601）
- **wait** — 等待 N 秒（脚本编排用）

## 调用

```json
dashboard { action: "health" | "time" | "wait", seconds: <n> }
```

| 子命令 | 输出 |
|--------|------|
| `health` | 逐项检查结果（JSON）：`serenityRoot`（P1）/ `gitRoot`（P2）/ `config`（.dsh/serenity.json 或 .opencode/serenity.json）/ 每项 `ok: true/false` + **MSM registry 完整性报告段（v1.28.0 ⑤c checkRegistryHealth：parse 剥 BOM/entry 字段/name 唯一/path 根内+脚本存在——坏不抛错只输出 issues + git 恢复指引）** |
| `time` | ISO 8601 时间戳（`now_iso`/`now_local`/`epoch_ms` 三字段） |
| `wait` | 静默等待 n 秒后退出（缺省 1s） |

## 三原则定义（与 ACC 标准一致）

| 原则 | 检查 | 含义 |
|------|------|------|
| **P1 有根** | 从 cwd 上溯找 `.serenity` | CCC 有且仅有一个标记根目录 |
| **P2 git 管** | 上溯找 `.git` | 根目录处于 git 管理下 |
| **P3 路径二分** | DSH fs 沙箱（workspace-write）原生执行 | 根内完整权限、根外零权限 |

## 何时使用

- 进入 CCC 后第一件事：`dashboard health` 确认激活
- 脚本编排中需要时间戳或延时
- 排查"为什么约束没生效"时先跑 health 定位

## 参考

- 身份与工具映射总览：`acc-serenity` 技能
