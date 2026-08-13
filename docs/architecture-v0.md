# dsh-serenity-plugin — 架构设计 v0

> 状态：v0.0.1 立项版。仿照 opencode-serenity-plugin 的 8 层架构，DSH 运行时适配。

## 0. 核心差异（opencode vs DSH）

| 维度 | opencode-serenity-plugin | dsh-serenity-plugin |
|------|--------------------------|---------------------|
| 宿主 | OpenCode（插件 API：tools + hooks） | DeepSeek Harness（无插件工具 API） |
| 工具注册 | `hooks.tool` 注册 11 工具 | **技能束**（`.dsh/skills/<name>/SKILL.md`）+ **runner 脚本**（技能束内 `scripts/`） |
| hook 注入 | system.transform / tool.execute.before / shell.env 等 | DSH skill 加载 + fs 沙箱（原生） |
| 安装 | npm 包 + opencode.json plugin 引用 | CLI 安装器拷贝模板到 `.dsh/skills/` |
| 复用策略 | — | **独立实现**（用户要求，不复用源码） |

**模型侧唯一扩展面是技能系统**（skill-local：`<projectRoot>/.dsh/skills/` + `~/.dsh/skills/`）→ ACC 工具全部以「技能文档定义协议 + 脚本实现执行」呈现，与 .opencode 技能的 scripts/ 模式同构。

## 1. 分层架构（DSH 适配）

```
L0 标准层   src/templates/           ACC 技能模板（安装到 CCC 后成为 .dsh/skills/*）
L1 实现层   src/{index,install,activation,errors,config-schema}.ts + src/skills/
L2 平台层   DSH 原生：fs 沙箱(P3) / goal+subagent(loop/resident) / compact-basic(压缩) / todo
```

| 层 | 组件 | 职责 |
|----|------|------|
| 激活 | `src/activation.ts` | P1 有根（.serenity 上溯）/ P2 git 管 / P3 路径二分（DSH fs 沙箱执行） |
| 配置 | `src/config-schema.ts` | `.dsh/serenity.json` zod schema（loop/sessionKeeper/safeMode） |
| 错误 | `src/errors.ts` | 13 错误类（serenityCode + impact），C3 保留 stdout/stderr |
| 安装 | `src/skills/install-skill.ts` + `template-loader.ts` | 模板→目标 .dsh/skills，占位符替换，幂等 |
| CLI | `src/index.ts` + `bin/` | install / init / list / status |
| 技能模板 | `src/templates/acc-*` | ACC 工具协议（文档）+ runner（脚本） |

## 2. 激活协议

```
进入工作目录
  → 上溯查找 .serenity（P1）→ 无 → 退化：不注入约束，普通 agent
  → 检查 git（P2）→ 无 → 记录 reason，仍激活（警告）
  → 激活：加载 acc-serenity 入口技能 → 获得工具映射 + 协作纪律
```

## 3. 工具映射决策

| ACC 标准 | DSH 实现方式 | 决策编号 |
|----------|-------------|---------|
| cc_fs | acc-fs 技能 + scripts/cc-fs.ts | DD-01 |
| cc_git | acc-git 技能 + scripts/cc-git.ts | DD-02 |
| msm 三件套 | acc-msm 技能 + scripts/msm.ts（mech-registry.json） | DD-03 |
| session | acc-session 技能 + scripts/session-tool.ts（AGENT_SESSIONS/） | DD-04 |
| eap / neat | 纯知识技能（渐进式披露） | DD-05 |
| acc_kit | acc-kit 技能 + scripts/acc-kit.ts | DD-06 |
| 路径守卫 / loop / resident / 压缩 | **DSH 原生，不重造** | DD-07 |

## 4. 守卫映射（Route 1：约束映射到平台机制）

> DSH 无 OpenCode 式 hook。约束层的落地原则：**能由平台机械执行的，不依赖模型自觉。**
> 技能层只承载"协议与知识"；约束交给 DSH 平台原生机制。

| ACC 守卫（opencode hook） | DSH 机械层（平台） | DSH 协议层（技能） |
|---------------------------|--------------------|--------------------|
| P3 路径隔离（tool.execute.before） | **fs 沙箱**（workspace-write / danger-full-access）——平台强制 | acc-fs 文档声明等价性 |
| 权限审批（permission 自动应答） | **approval 系统**（bash ask / 沙箱升级审批） | 技能说明触发审批的场景 |
| bash 开关（标记文件 → hook 禁用） | **会话权限降级**（allow → ask）——机械生效 | acc-safe-mode 协议（on/off/status/check） |
| 写入黑名单（hook 拦截 write/edit） | **fs 沙箱边界 + 审批**；敏感路径 → 审批拦截 | acc-safe-mode `check`（前缀/regex 规则） |
| 系统提示注入（system.transform） | 无等价平台机制 → skill 加载（advisory） | acc-serenity 入口技能 |
| session-keeper 提醒 | 无等价平台机制 | acc-session 纪律（todo/进度记录） |
| loop / resident | goal / 后台 subagent（原生超集） | 文档映射 |

**关键认知**：DSH 上"插件"的机械性来自平台（沙箱/审批），而非自定义 hook。acc-safe-mode 的 `.serenity-safe-on` 标记 + 黑名单是协议层；机械层 = 把会话权限降为 `ask`（用户或会话配置），二者叠加才构成完整的安全模式。

## 5. 决策记录（DSH 侧）

| # | 决策 | 结论 |
|---|------|------|
| DD-01 | 包名 | `@shgroup/dsh-serenity-plugin`（与 opencode 插件同 scope，未来可发布） |
| DD-02 | 远程 | 原 home GitLab（private）；v1.14.2 起 GitHub `git@github.com:dsh-external/dsh-serenity-plugin.git`（private） |
| DD-03 | 默认分支 | master（home-git 约定：AI_LAB 域） |
| DD-04 | 技能安装目标 | v0.1 先支持 `--scope ccc`（CCC 级），`user` 级为可选 |
| DD-05 | 模板占位符 | `{{prefix}} / {{ccc_name}} / {{date}}`（与 opencode 插件一致） |
| DD-06 | MSM 注册表 | 复用 `mech-registry.json` v1 格式（CCC 内），plugin-root 注册表仅 CLI 调试 |
| DD-07 | 测试标准 | vitest，随工具技能逐步补齐（对齐 opencode 插件 487+ 的纪律） |
| DD-08 | 私有 | package.json `private: true`；仅 dsh-external 组织（GitHub private），不发布 npm |
| DD-09 | 守卫落地 | Route 1：约束映射平台机制（沙箱/审批），技能层只承载协议与知识（见 §4） |
| DD-10 | init 两阶段 | Phase 1 骨架 + Phase 2 EAP 访谈（生成 .dsh/PHASE2-PROMPT.md） |

## 6. 待办路线（已完成的打 ✓）

- ✓ v0.1：acc-fs / acc-git / acc-msm / acc-session / acc-eap / acc-neat / acc-kit + 测试（43/43）
- ✓ v0.2：acc-safe-mode 协议 + init Phase 2 访谈（54/54）
- 🔜 v0.3：safe-mode 的机械层落地（会话权限降级为 ask 的实操指引）
- 🔜 v0.4：SQC 周期接入、session-keeper 近似
