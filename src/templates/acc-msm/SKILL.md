---
name: acc-msm
description: MSM（Mech & Semi-Mech）框架工具（msm_list/exec/admin 语义，DSH 版）。list 列出注册 MSM；exec 安全执行（路径逃逸阻断、600s 超时）；admin 注册/注销/品质检查。复用 CCC 的 mech-registry.json。
---

# Skill: acc-msm — MSM 框架（msm_list/exec/admin 语义）

## 用途

MSM（Mech & Semi-Mech）是 ACC 的**确定性可执行单元层**——可复用操作注册为可执行单元，通过统一安全通道执行，取代裸 bash 的高风险操作。

- **Mech**: 纯 TS，零 LLM 推理（cc-fs、ssh-connect 等）
- **Semi-Mech**: TS 框架 + LLM 决策点（session qa、sqc pipeline 等）

## 操作协议

```bash
bun "<skill 基目录>/scripts/msm.ts" list
bun "<skill 基目录>/scripts/msm.ts" exec <name> [args...] [--format=json]
bun "<skill 基目录>/scripts/msm.ts" admin register <name> --skill <skill> --path <script> --category <mech|semi-mech> --description <desc>
bun "<skill 基目录>/scripts/msm.ts" admin deregister <name>
bun "<skill 基目录>/scripts/msm.ts" admin check
```

| 子命令 | 说明 |
|--------|------|
| `list` | 列出所有注册 MSM（name \| skill \| category \| description） |
| `exec <name> [args...]` | 执行 MSM：cwd 钉在 CCC 根，600s 超时，`type:"path"` flag 自动逃逸校验；`--format=json` 包装输出 |
| `admin register` | 注册新 MSM → 写入 mech-registry.json → **自动 git commit** |
| `admin deregister` | 注销 MSM（不删脚本文件）→ 自动 git commit |
| `admin check` | DC-M1~M4 品质检查（脚本↔注册表一致性） |

## 注册表

- **业务流**：扫描 `.opencode/skills/*/references/mech-registry.json`（主）+ CCC 根 `mech-registry.json`（回退），按 name 去重合并
- 格式：v1 包装 `{version, description, entries[]}` 或兼容数组格式
- 条目字段：`name / path / skill / category / description / usage / flags[]`（`type:"path"` 启用逃逸守卫）
- **ACC 层不占用 CCC 注册表空间**：本工具只读写 CCC 的注册表，不注册自身

## 守卫

1. `exec` 前校验 `flags` 中 `type:"path"` 的参数值不越出 CCC 根（`--flag val` 与 `--flag=val` 均支持）
2. 脚本路径解析后必须位于 CCC 根内
3. 600s 超时，错误路径保留 stdout/stderr

## 退出码

| 码 | 含义 |
|----|------|
| 0 | 成功 |
| 1 | user（缺参数 / 未知 MSM / 未注册） |
| 2 | system（注册表缺失 / 路径逃逸 / 子进程失败） |
| 3 | operator（业务 MSM 自身非 0 退出，--format=json 时透传） |

## 何时使用

- 任何已注册 MSM 的操作（**优先于裸 bash**）
- 新脚本想成为 MSM 时 `admin register`
- SQC 周期跑 `admin check`

## 参考

- MSM 开发手册：`.opencode/skills/home-serenity/scripts/` 下脚本约定（退出码/错误类）
- 身份与工具映射总览：`acc-serenity` 技能
