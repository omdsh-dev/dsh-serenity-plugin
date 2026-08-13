# dsh-serenity-plugin — 契约 v0

> 仿照 opencode-serenity-plugin 的契约集（C1-C8），DSH 运行时适配版。

| ID | 约束 | 实现 |
|----|------|------|
| C1 | ACC 不得直接调用 LLM API — 认知行为由 CCC 内 Agent 执行 | 所有 runner 为纯 TS（node/bun），零 LLM 调用 |
| C2 | 所有文件操作限定 CCC 根内（P3） | DSH fs 沙箱（workspace-write）+ 脚本内 resolveInside 双保险 |
| C3 | `msm_exec` 错误路径保留 stdout/stderr | `MsmExecutionError` 含 stdout/stderr |
| C4 | 兼容 `mech-registry.json` v1 与数组格式 | acc-msm runner 解析两种格式 |
| C5 | 双注册表（plugin-root vs CCC），业务流走 CCC | 同 opencode 插件 D13 收口 |
| C6 | **私有** — 仅 dsh-external 组织可见（GitHub private），不发布 npm | remote = `git@github.com:dsh-external/dsh-serenity-plugin.git`；package.json `private: true` |
| C7 | 开发流程：skill 驱动 + AGENT_SESSIONS 追踪 + 独立 git 仓 | 本仓即实践 |
| C8 | ACC 层不占用 CCC 注册表空间 — 读取合法，注册由 CCC 管理 | acc-msm 不自动注册 ACC 工具 |
| C9 | 技能模板安装幂等 — 重复安装不覆盖已有内容 | install-skill 默认 skip（--force 覆盖） |
| C10 | 平台原生能力（守卫/循环/常驻/压缩）不重复实现 | 见 architecture-v0 §3 DD-07 |

## 错误类（13）

| 类 | serenityCode | 触发 |
|----|--------------|------|
| NotInGitRepoError | E-GIT-001 | cwd 不在 git 仓库（P2 违反） |
| SerenityFileNotFoundError | E-CCC-001 | 未找到 .serenity（P1 违反） |
| SkillNotFoundError | E-SKILL-001 | 入口技能缺失 |
| MsmNotRegisteredError | E-MSM-001 | MSM 未注册 |
| MsmAlreadyRegisteredError | E-MSM-002 | MSM 重复注册 |
| MsmNotInRegistryError | E-MSM-003 | 注册表无此 MSM |
| MsmExecutionError | E-MSM-004 | 执行失败（含 stdout/stderr） |
| MsmPathEscapeError | E-PATH-001 | path-arg 逃逸阻断 |
| MsmSymlinkError | E-PATH-002 | symlink 逃逸防御 |
| MsmScriptNotFoundError | E-PATH-003 | 脚本不存在 |
| InvalidCccNameError | E-CCC-002 | CCC 名非 kebab-case |
| FileNotInsideSerenityError | E-PATH-004 | 文件在根外 |
| CccStatusError | E-CCC-003 | CCC 完整性警告 |
