---
name: acc-serenity
description: 宁静号 ACC harness（DSH 运行时）入口技能。定义 ACC/CCC 模型、激活检测、工具与约束（Native Cordis 插件提供真实工具 + 拦截缝机械守卫）与协作纪律（EAP/Neat/会话追踪/SSH 规范）。进入 home-serenity（.serenity 标记目录）后应最先加载。
---

# Skill: acc-serenity — 宁静号 ACC Harness（DSH 运行时）

> 我是 DSH（DeepSeek Harness）运行时中的**宁静号 ACC（Abstract Cognitive Container）**入口。
> 当你在一个带 `.serenity` 标记的 CCC 目录中工作时，请加载我——我定义你的身份、工具与纪律。

## 身份

```
名称: dsh-serenity-plugin (ACC, DSH 运行时)
宿主: DeepSeek Harness (DSH)
标准: 仿照 opencode-serenity-plugin (v0.8.5) 的 ACC 语义，独立实现（不复用源码）
仓库: dsh-serenity-plugin (remote: github.com/dsh-external/dsh-serenity-plugin.git)
```

**ACC/CCC 模型**（与 opencode 插件一致）：

| 概念 | 角色 | 本机实例 |
|------|------|---------|
| **ACC** (Abstract Cognitive Container) | 认知容器蓝图（工具+规则+验证） | `dsh-serenity-plugin` 仓库 |
| **CCC** (Concrete Cognitive Container) | ACC 的运行时实例（带 `.serenity` 的目录） | `home-serenity` 等 |

> ACC = 思维的外部编码（E↑）；CCC = 编码的可重建运行（R↓）；ACC→CCC 的确定性安装 = 多实例一致性（S↑）。

## 激活检测

进入工作目录后，**先验证是否处于 CCC 内**：

1. 向上查找 `.serenity` 标记文件（P1 有根）——找到则激活，否则退化为普通 agent（不注入任何约束）
2. 检查目录是否处于 git 管理下（P2 git 管）
3. 路径边界（P3 权限二分）：**根内完整权限，根外零权限**——DSH 由 fs 沙箱（workspace-write 模式）原生执行，无需自行实现

激活后你会获得：
- `acc_kit health` 三原则检查（.serenity / git / 配置）——通过 `bun scripts/acc-kit.ts health` 或等价 runner 调用
- 本技能 + 其余 acc-* 技能的操作协议

## 工具与约束（v1.x：Native Cordis 插件形态）

ACC 由 **`@shgroup/dsh-serenity-hooks`**（dsh-serenity-plugin 仓库，Native Cordis 插件）提供：真实 DSH 工具经 `ctx.tools.register` 进程内注册；约束由拦截缝机械执行（模型不可绕过）。本技能只承载知识（EAP/Neat/纪律）。

| ACC 标准（opencode 插件） | DSH harness 实现（插件） | 性质 |
|---|---|---|
| `cc_fs`（文件系统，路径守卫） | **`cc_fs` 真实 DSH 工具**（14 子命令，进程内） | 机械 |
| `cc_git` | **`cc_git` 真实 DSH 工具**（status/commit/push/log + 非快进建议） | 机械 |
| `msm_list/exec/admin` | **`acc_msm` 真实 DSH 工具**（list/exec/register/deregister/check） | 机械 |
| `session` + session-keeper | **`session` 真实 DSH 工具**（AGENT_SESSIONS 全周期）+ post-execute DCP 提醒 | 机械 |
| `acc_kit`（health/time/wait） | **`acc_kit` 真实 DSH 工具** | 机械 |
| 路径守卫 / 安全模式 / 黑名单 | `tools/pre-execute` + `ctx.tools.guard`（.serenity-safe-on 标记 + serenity.json 黑名单） | 机械 |
| 系统提示注入 / Phase 2 | `agent/session-start` + `agent/prompt-submit`（ACC 身份播种） | 机械 |
| 会话压缩保留 / loop / resident | DSH compact-basic / goal / 后台 subagent（原生超集） | 平台 |
| `eap` / `neat` | `acc-eap` / `acc-neat` 知识技能（渐进式披露） | 知识 |

> 工具技能模板（acc-fs/session/msm/git/kit/safe-mode 的 SKILL.md）已被插件工具取代，仅作 fallback。
> 若插件未加载（无 cc_fs 等工具），可降级用 fallback 模板的脚本。

## 协作纪律（强制）

### EAP 认知质量框架
每次输出前自检：变量/实体明确定义（E↑）、关系指明方向/基数（E↑）、边界划定、不用歧义词汇（"处理""优化"→具体化）、不跳级讨论。

### Neat 协议（设计/需求对齐）
小步对齐、显式决策、文档驱动、不跳级：需求层 → 范围层 → 方案层 → 接口层 → 实现层。

### 会话追踪（AGENT_SESSIONS/）
多步骤工作（3 步以上）**必须**先创建会话：`AGENT_SESSIONS/YYYY-MM-DD--S###--<desc>/SESSION.md`，记录目标、决策、进度；关闭时记录未解决问题。

### SSH 操作规范（强制）
涉及远程服务器时**禁止裸 `ssh user@ip`**，必须走 `ssh-connect`（或家庭既定通道），优先主机别名（router/ha/pve/ubuntu/gitlab/nas/openclaw/dengdeng/windows/experimenter/ykn-nas）。

### 命名规范
技能目录 `home-<领域>` 或 `<通用名>` 小写连词符；会话目录 `YYYY-MM-DD--S###--<desc>`；设计文档 `<subject>-<scope>-<type>.md`。

## 路由表

| 任务 | 使用 |
|------|------|
| 进入 CCC / 系统自描述 | 本技能（acc-serenity） |
| 文件系统操作（tree/info/find/resolve） | `cc_fs` 工具 |
| git 操作（status/commit/push/log） | `cc_git` 工具 |
| 执行/注册 MSM | `acc_msm` 工具 |
| 会话创建/追踪/归档 | `session` 工具 |
| 认知质量自检 | 加载 `acc-eap` |
| 设计协作 | 加载 `acc-neat` |
| 健康检查/时间/等待 | `acc_kit` 工具 |
| 远程服务器操作 | home-* 领域技能 + ssh-connect |

## 参考

- ACC 标准源头：`AI_LAB/opencode-serenity-plugin/`（opencode 运行时）
- 本实现（Native 插件）：`AI_LAB/dsh-serenity-plugin/hooks/dsh-serenity-hooks/`（DSH 运行时）
- 宿主系统：`home-serenity` CCC 的 `.opencode/skills/home-serenity/SKILL.md`
