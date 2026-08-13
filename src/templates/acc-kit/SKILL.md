---
name: acc-kit
description: ACC 通用能力工具包（health/time/wait）。health 执行 CCC 三原则健康检查（P1 有根 / P2 git 管 / P3 路径二分 + 配置校验）；time 输出当前时间；wait 等待 N 秒。进入 CCC 工作前的例行自检。
---

# Skill: acc-kit — ACC 通用能力工具包

## 用途

提供三个轻量能力：
- **health** — CCC 三原则健康检查（进入工作前例行自检）
- **time** — 当前时间（ISO 8601）
- **wait** — 等待 N 秒（脚本编排用）

## 操作协议

在 CCC 根目录（或任意子目录）执行：

```bash
bun "<skill 基目录>/scripts/acc-kit.ts" health
bun "<skill 基目录>/scripts/acc-kit.ts" time
bun "<skill 基目录>/scripts/acc-kit.ts" wait <秒数>
```

> `<skill 基目录>` 即本技能所在目录（DSH 加载技能时会给出 base directory）。

## 输出

| 子命令 | 输出 |
|--------|------|
| `health` | 逐项检查结果（JSON）：`serenityRoot`（P1）/ `gitRoot`（P2）/ `config`（.dsh/serenity.json 或 .opencode/serenity.json）/ 每项 `ok: true/false` |
| `time` | ISO 8601 时间戳（`YYYY-MM-DDTHH:mm:ss.sssZ`） |
| `wait <n>` | 静默等待 n 秒后退出 0 |

## 退出码

| 码 | 含义 |
|----|------|
| 0 | 成功（health 全部通过 / time / wait 完成） |
| 1 | user 错误（缺参数 / 未知子命令 / 非数字秒数） |
| 2 | system 错误（health 检查失败即返回 2，逐项原因见输出） |

## 三原则定义（与 ACC 标准一致）

| 原则 | 检查 | 含义 |
|------|------|------|
| **P1 有根** | 从 cwd 上溯找 `.serenity` | CCC 有且仅有一个标记根目录 |
| **P2 git 管** | 上溯找 `.git` | 根目录处于 git 管理下 |
| **P3 路径二分** | DSH fs 沙箱（workspace-write）原生执行 | 根内完整权限、根外零权限；本脚本只读检查 |

## 何时使用

- 进入 CCC 后第一件事：`health` 确认激活
- 脚本编排中需要时间戳或延时
- 排查"为什么约束没生效"时先跑 health 定位

## 参考

- 身份与工具映射总览：`acc-serenity` 技能
