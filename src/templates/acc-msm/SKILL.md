---
name: acc-msm
description: MSM 框架知识映射（v1.30：acc_msm 拆为 msm 单入口执行 + container_admin msm 管理面）。msm(name, args) 直接执行 / 未命中返回候选 / inspect:true 查用法 / 无参返回目录；注册/注销/质检/手册走 container_admin msm。复用 CCC 的 mech-registry.json。
---

# Skill: acc-msm — MSM 框架（msm 单入口 + container_admin 管理面知识映射）

> **v1.30.0 工具面重构**：`acc_msm`（8 action）拆分为——**`msm`**（执行+发现单入口，3 参数 name/args/inspect）+ **`container_admin msm`**（管理面：register/deregister/check/guide/catalog/ccc-config）。本技能是知识映射——真实工具由 Native Cordis 插件进程内注册，scripts/ 已退役为空目录。

## 用途

MSM（Mech & Semi-Mech）是 ACC 的**确定性可执行单元层**——可复用操作注册为可执行单元，通过统一安全通道执行，取代裸 bash 的高风险操作。

- **Mech**: 纯 TS，零 LLM 推理（ssh-connect、pve-connect 等）
- **Semi-Mech**: TS 框架 + LLM 决策点（eap-analyzer 等）

## 调用（msm 单入口——v1.30 直觉用法）

```json
// 执行已注册 MSM（name 直接写，无 action 选择）
msm { name: "ssh-connect", args: ["status"] }
// 查用法（不执行，走 --schema 协议）
msm { name: "ssh-connect", inspect: true }
// 忘了全名？未精确命中 → 返回模糊候选（LLM 下轮选对）
msm { name: "ssh" }
// 新到 CCC？无参 → 返回精简分类目录（按 skill 分组）
msm {}
```

| 场景 | 调用 | 行为 |
|------|------|------|
| 执行已注册 MSM | `msm("ssh-connect", ["status"])` | 直接执行（异步 execFile + 600s 超时 + path 守卫） |
| 想用但忘了名 | `msm("ssh")` | 未命中 → 返回 top-K 模糊候选（name/description 匹配） |
| 查用法 | `msm("ssh-connect", [], inspect: true)` | 返回 usage/flags/schema |
| 新到 CCC | `msm()` | 返回精简分类目录（替代全量 list） |
| 管理注册表 | `container_admin { domain: "msm", action: "register" }` | 管理面（见下） |

## 管理面（container_admin msm）

| action | 说明 |
|--------|------|
| `register` | 注册新 MSM → 写入 mech-registry.json → **自动 git commit**（经 skiffMsmGate 拒绝外部面） |
| `deregister` | 注销 MSM（不删脚本文件）→ 自动 git commit |
| `check` | DC-M1~M4 品质检查（脚本↔注册表一致性） |
| `guide` | MSM 开发手册 |
| `catalog` | ACC 能力目录（7 分区，v1.28.0 ④） |
| `ccc-config` | CCC 配置参考（v1.27.13 8 段扩展） |

## 注册表

- **业务流**：扫描 `.opencode/skills/*/references/mech-registry.json`（主，单级化 v1.28.0 ⑤a）+ CCC 根 `mech-registry.json`（回退）
- 格式：v1 包装 `{version, description, entries[]}` 或兼容数组格式
- 条目字段：`name / path / skill / category / description / usage / flags[]`（`type:"path"` 启用逃逸守卫）
- **写保护（v1.28.0 ⑤b）**：注册表文件写 deny 读 allow（ACC 层机械保护——不可直接 write/edit 编辑 mech-registry.json，只能经 container_admin msm）
- **完整性检查（v1.28.0 ⑤c）**：`dashboard health` 含 registry 健康段（坏不抛错只输出 issues + git 恢复指引）

## 守卫

1. `exec` 前校验 `flags` 中 `type:"path"` 的参数值不越出 CCC 根
2. 脚本路径解析后必须位于 CCC 根内
3. 600s 超时，错误路径保留 stdout/stderr

## 何时使用

- 任何已注册 MSM 的操作（**优先于裸 bash**）
- 新脚本想成为 MSM 时 `container_admin msm register`
- SQC 周期跑 `container_admin msm check`

## 参考

- MSM 开发手册：`.opencode/skills/home-serenity/scripts/` 下脚本约定（退出码/错误类）
- 身份与工具映射总览：`acc-serenity` 技能
