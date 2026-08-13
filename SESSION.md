# SESSION: dsh-serenity-plugin

> **项目即会话模式**（home-session 定义）—— 本仓是独立 git 项目；日常演进通过 git commit 记录，本文件追踪**当前焦点 + 关键决策 + 未决问题 + 项目演进历史**。
>
> 立项事项化 session：`AGENT_SESSIONS/2026-08-06--S113--dsh-serenity-plugin-init/`（home-serenity 仓内）

---

## 当前焦点（2026-08-13）

**v1.16.0 完成**：适配 DSH 公开测试版（deepseek-ai/deepseek-harness 0.1.0-rc.6，github.com/deepseek-ai/deepseek-harness）。

- 公开版改名全量适配：`dsh-compact`→`dsh-compaction`（事件 `compact/*`→`compaction/*`）、`dsh-bash`→`dsh-shell`、`dsh-bash-env`→`dsh-shell-env`（服务 `bashEnv`→`shellEnv`）、`httpServer`→`webServer`、`schemastery`→`@deepseek-ai/schemastery`
- 类型基准从私有 staging（`~/.dsh/source/current`）切换为公开版已安装包（rc.6）；tsconfig/client tsconfig 重指；typecheck 全绿
- 系统提示词对齐 osp 收紧：块间去 `---` 分隔线、SKILL 全文原文直推（去包裹头）、修复 Session 块目录名解析 bug；新增 `tests/osp-alignment.test.ts`（CCE/Constraints/Session 与 osp v0.8.5 逐字节断言）
- 运行时加载根因修复：profile 插件目录原为指向旧 staging 的符号链接（依赖解析错配）→ 改真实目录安装；headless 验证 9 工具 + serenity-entry section 注册
- 测试 184/184（原 178 + 6）

**待办（需用户批准）**：重启 dsh web（当前进程仍加载旧插件 v1.15.8）；GUI 会话中 cc_fs/session/acc_msm 等工具 + 系统提示词注入在重启后生效。

## 关键决策

| # | 决策 | 理由 |
|---|------|------|
| D1 | 独立实现，不复用 opencode-serenity-plugin 源码 | 用户明确要求 |
| D2 | remote = `git@home.gitlab:yh/dsh-serenity-plugin.git`（private） | 暂存家里私有 GitLab |
| D3 | DSH 工具形态 = 技能束 + 脚本 | DSH 无插件工具 API，技能是唯一扩展面 |
| D4 | 模板放 `src/templates/`，安装器拷贝到 `.dsh/skills/` | 仿照 opencode 插件结构 |
| D5 | 平台原生能力（守卫/loop/resident/压缩）不重造 | 避免重复实现 |
| D6 | 全量 7 个 acc-* 技能一次实现（用户选择） | 用户决策 |
| D7 | 安装支持 CCC 级 + 用户级（用户选择） | 用户决策 |
| D8 | runner 自包含（零三方依赖，不 import 插件 src） | 安装到 CCC 后独立可用 |

## 未决问题

- init 向导（Phase 2 访谈）范围
- safe-mode / session-keeper 的 DSH 近似实现
- 是否最终迁移 GitHub（用户说"暂时"私有 GitLab；后改为**永不公开**）

## 项目演进历史

- **v0.0.1 (2026-08-06)** — 立项 + 骨架 + CLI + 激活层 + 错误类 + 安装器 + 入口技能模板
- **v0.1.0 (2026-08-06)** — 全量 7 个 acc-* 工具技能 + 43/43 测试 + 双目标安装 + 冒烟验证
- **v0.2.0 (2026-08-06)** — acc-safe-mode 协议 + init Phase 2 EAP 访谈 + 守卫映射文档（54/54 测试）
- **v0.3.0 (2026-08-06)** — native 插件设计里程碑：dsh-serenity-hooks（6 拦截缝方案，改核心 loop）
- **v0.3.1 (2026-08-06)** — 验证 config.yaml insert 加载可行性（免改 DSH 源码）
- **v1.0.0 (2026-08-06)** — 方向修正：hooks/dsh-serenity-hooks 独立包（2 真实工具 + 守卫 + 落盘 + invariant + 清单），typecheck 过真实 DSH 类型 + 37/37 测试；参考 dsh-external 已写插件校准
- **v1.1.0 (2026-08-06)** — 全量 5 工具（+acc_kit/cc_git/acc_msm）+ session-keeper DCP（post-execute observe-and-enrich）+ 48/48 测试
- **v1.2.0 (2026-08-06)** — ACC 上下文注入缝（session-start/prompt-submit）+ load-plugin.sh 加载脚本 + 51/51 测试
- **v1.3.1 (2026-08-06)** — 加载路径源码验证（baseUrl=apps/cli/config → staging 根 node_modules 解析链）
- **v1.4.0 (2026-08-06)** — 解析链实证（workspace 链接在 apps/cli/node_modules；symlink 陷阱 → 复制方案）+ schemastery shim + 端到端预检通过
