---
name: acc-serenity
description: 宁静号 ACC harness（DSH 运行时）入口技能。定义 ACC/CCC 模型、激活检测、工具与约束（Native Cordis 插件提供 11 真实工具 container_fs/container_trajectory/dashboard/container_git/msm/praxis/handyman/localstore/container_admin/im-bridge/acc-diag——后两个按配置条件出现 + 拦截缝机械守卫，v1.34 命名体系）与协作纪律（EAP/Neat/轨迹追踪/SSH 规范）。进入 home-serenity（.serenity 标记目录）后应最先加载。
---

# Skill: acc-serenity — 宁静号 ACC Harness（DSH 运行时）

> 我是 DSH（DeepSeek Harness）运行时中的**宁静号 ACC（Abstract Cognitive Container）**入口。
> 当你在一个带 `.serenity` 标记的 CCC 目录中工作时，请加载我——我定义你的身份、工具与纪律。

## 身份

```
名称: dsh-serenity-plugin (ACC, DSH 运行时)
宿主: DeepSeek Harness (DSH)
标准: 仿照 opencode-serenity-plugin 的 ACC 语义，独立实现（不复用源码）
版本: v1.34.0（npm @shgroup/dsh-serenity-hooks）
发布: GitHub tellmewhattodo/dsh-serenity-plugin + npm registry
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
- `dashboard health` 三原则检查（.serenity / git / 配置 + registry 完整性）
- 本技能 + 其余 acc-* 技能的操作协议

## 工具与约束（v1.34：Native Cordis 插件，11 工具，其中 2 个按配置条件出现）

ACC 由 **`@shgroup/dsh-serenity-hooks`**（dsh-serenity-plugin 仓库，Native Cordis 插件）提供：真实 DSH 工具经 `ctx.tools.register` 进程内注册；约束由拦截缝机械执行（模型不可绕过）。本技能只承载知识（EAP/Neat/纪律）。

**v1.30.0 工具面重构（13 → 10，硬切无别名）＋ v1.31.0 新增 `im-bridge`（11）＋ v1.33 起 `logbook` 并入 `trajectory`（10）＋ 新增专属工具 `acc-diag`（11）＋ v1.34.0 `trajectory` → `container_trajectory`**——以下为本会话实际可用的 11 工具（后两个**按条件出现**）：

| 工具 | 能力 | 隐喻 |
|------|------|------|
| `container_fs` | 容器文件系统（15 子命令，路径逃逸阻断） | The Hull |
| `container_git` | CCC git 操作（status/commit/push/log） | The Hull |
| `container_admin` | 容器管理（机务舱）：role（Skiff 角色）/ msm（注册表管理 + 开发手册）/ config / **autopilot（status/init/generate-bias——周期自唤醒）** | The Manifest + Crew |
| `msm` | MSM **单入口执行+发现**：`msm(name, args)` / 未命中候选 / `inspect:true` 查用法 / 无参目录 | The Machinery |
| `praxis` | 可实践理论注入（section: eap/neat/cce） | Engineering Drawings |
| `container_trajectory` | **一条轨迹**：持久身体（SESSION.md）+ 时间轴。生命周期 `list`（清单+统计）/ `show` / `create` / `use`（激活；内联完整性检查，通过静默）/ `rebuild`（原地清空重建，Ship of Theseus）；投递 **`send-now`**（**即时**递送：live 目标立即注入、非 live 冷载入＝等效于直接 wake；**有同步回执**）/ `send-later`（未来时刻 + 一条 message，可唤醒任一轨迹；fire-and-forget，无回执无回收）/ **`cro-guide`**（**CRO 编写指南**——怎么给**这条轨迹**配一段自己的程序、由它决定"该不该叫我"；无参数、纯读） | The Ship's Log / Theseus |
| `dashboard` | 普适仪表：health（三原则 + registry）/ time / wait | 舰桥仪表盘 |
| `handyman` | 杂工编排（白名单模型；foreground 串行 / background 循环校验） | Crew Rotation |
| `localstore` | 凭据/配置存储（CCC 根 localstore.json） | 保留 |
| `im-bridge` | IM 消息发送（channel/action/user/text/file/caption/account）——**条件可见**：本 CCC 未配置任何 IM 通道（如 `weixin.enabled`）时从工具清单移除 | Crew Rotation |
| `acc-diag` | ACC 运行态诊断（一次调用出全报告：live 会话清单 + 面板解析 + 唤醒注册表 + 唤起条件链）——**专属工具**：**默认对所有 CCC 隐藏**，只有在自己 `.opencode/serenity.json` 的 `exclusiveTools` 里点名的 CCC 可见 | 保留（ACC 负责人专用） |

**改名对照（旧 → 新，硬切无别名；箭头链是**逐个发布版本**的名字，**末项才是今名**）**：`cc_fs`→`container_fs` / `cc_git`→`container_git` / `acc_msm`（执行面）→`msm`、`acc_msm`（管理面）→`container_admin msm` / `skiff_admin`→`container_admin role` / `session`→`logbook`（v1.30）→`trajectory`（v1.33 合并，动作收敛为 6）→**`container_trajectory`**（v1.34） / `session_rebuild`→`logbook rebuild`→`trajectory rebuild`→**`container_trajectory rebuild`** / `acc_kit`→`dashboard` / `eap`·`neat`·`cce` 三合一→`praxis` / `autopilot-trajectory`→`trajectory`（v1.32）→**`container_trajectory`**（v1.34；其周期自唤醒面 `container_admin autopilot`）。旧工具名不再注册。

| 机制 | DSH harness 实现（插件） | 性质 |
|---|---|---|
| 11 真实工具 | `container_fs`/`container_trajectory`/`dashboard`/`container_git`/`msm`/`praxis`/`handyman`/`localstore`/`container_admin`/`im-bridge`/`acc-diag`（进程内） | 机械 |
| 路径守卫 / 安全模式 / 黑名单 | `tools/pre-execute` + `ctx.tools.guard`（.serenity-safe-on 标记 + serenity.json 黑名单） | 机械 |
| 条件可见（im-bridge / acc-diag） | `agent.ctx.tools.restrict({deny})` 按 CCC 配置逐 agent 收窄（同 safe-mode 机制）——im-bridge 看 `weixin` 通道是否启用；acc-diag 看 `exclusiveTools` 是否点名 | 机械 |
| 系统提示注入 / Phase 2 | `agent/session-start` + `agent/prompt-submit`（ACC 身份播种） | 机械 |
| 会话压缩保留 / loop / resident | DSH compact-basic / goal / 后台 subagent（原生超集） | 平台 |
| 知识框架 | `praxis`（eap/neat/cce 三合一，单工具注入） | 知识 |

> 旧工具技能模板（acc-fs/acc-git/acc-msm/acc-kit/acc-session/acc-safe-mode 的 SKILL.md）已被插件工具面取代——本套 acc-* 文件现为**知识映射**（说明该领域由哪个工具提供），scripts/ 已退役为空目录。

## 协作纪律（强制）

### EAP 认知质量框架
每次输出前自检：变量/实体明确定义（E↑）、关系指明方向/基数（E↑）、边界划定、不用歧义词汇（"处理""优化"→具体化）、不跳级讨论。注入：`praxis eap`。

### Neat 协议（设计/需求对齐）
小步对齐、显式决策、文档驱动、不跳级：需求层 → 范围层 → 方案层 → 接口层 → 实现层。注入：`praxis neat`。

### 轨迹追踪（AGENT_SESSIONS/）
多步骤工作（3 步以上）**必须**先创建轨迹：`container_trajectory create` → `AGENT_SESSIONS/YYYY-MM-DD--S###--<desc>/SESSION.md`，记录目标、决策、进度；收尾时把未解决问题写进 SESSION.md（状态由 SESSION.md 里的勾选框体现）。

**skill 供给（两种写法，取并集）**：① **CCC 级** —— `.opencode/serenity.json` 的 `trajectory.skills`（本 CCC **每条**轨迹都带，**含 skiff 会话**）；② **轨迹级** —— 该轨迹 `SESSION.md` **顶部 frontmatter** 写 `skills: [名字, …]`（这条轨迹额外的）。**CCC 级在前、轨迹级追加、同名去重**。两者都在轨迹**被绑定期间**注入这些 skill 的**全文**——⚠️ **不是"`use` 时灌一次"，而是每次请求装配重新求值**（改配置/改 frontmatter 立即生效、不随对话压缩消失）。⚠️ `create` 只新建、**不夺走当前绑定** ⇒ 新轨迹须**显式 `use`** 才挂上。**重写 SESSION.md 时必须保留那段 frontmatter**（抹掉 = 静默撤销该轨迹的声明）。详见 `acc-session` 技能。

### SSH 操作规范（强制）
涉及远程服务器时**禁止裸 `ssh user@ip`**，必须走 `ssh-connect`（或家庭既定通道），优先主机别名（router/ha/pve/ubuntu/gitlab/nas/desk/windows/experimenter/ykn-nas）。

### 命名规范
技能目录 `home-<领域>` 或 `<通用名>` 小写连词符；会话目录 `YYYY-MM-DD--S###--<desc>`；设计文档 `<subject>-<scope>-<type>.md`。

## 路由表

| 任务 | 使用 |
|------|------|
| 进入 CCC / 系统自描述 | 本技能（acc-serenity） |
| 文件系统操作（tree/info/find/resolve） | `container_fs` 工具 |
| git 操作（status/commit/push/log） | `container_git` 工具 |
| 执行 MSM / 发现 | `msm` 工具（`msm()` 目录 / `msm("<name>")` 执行 / `inspect:true` 查用法） |
| 管理 MSM 注册表 / Skiff 角色 / CCC 配置 / autopilot 周期 | `container_admin` 工具（domain: role/msm/config/autopilot） |
| 轨迹创建/读取/激活/重建/定时唤醒/即时递话 | `container_trajectory` 工具（含 `send-now`（现在，有回执）/ `send-later`（未来）） |
| 让轨迹**自己判断何时该被叫醒**（不写死时刻） | ① `container_trajectory cro-guide`（读指南 + 取样例快照）→ ② 照指南在**该轨迹目录**写 `continuous-re-occurrence.ts`（**文件在 = 启用**） |
| 让轨迹**带上某个 skill**（绑定期间注入其全文） | ① **所有轨迹都要** ⇒ `.opencode/serenity.json` 的 `trajectory.skills`（本 CCC 每条都带，**含 skiff**）② **只这条要** ⇒ 其 `SESSION.md` **顶部 frontmatter** 写 `skills: [名字, …]`（**保留 frontmatter**）→ **显式 `container_trajectory use`** 生效（`create` 不夺绑定） |
| 认知质量自检 / 设计协作 / 连续性理论 | `praxis` 工具（section: eap/neat/cce） |
| 健康检查/时间/等待 | `dashboard` 工具 |
| 给微信用户发消息（招财留言/通报） | `im-bridge` 工具（**仅当本 CCC 配置了 IM 通道时可见**；只能操作本会话 CCC） |
| 运行态诊断（live 会话/agent 定位/唤醒注册表/条件链） | `acc-diag` 工具（**专属——仅当本 CCC 在 `exclusiveTools` 里声明了它才可见**；ACC 负责人专用） |
| 远程服务器操作 | home-* 领域技能 + ssh-connect |

## 安装与更新

本 ACC 插件通过 npm 公开分发（当前 v1.34.0）：

```bash
# 安装 / 更新（DSH profile 级）
dsh plugin --profile web add @shgroup/dsh-serenity-hooks
# 卸载
dsh plugin --profile web remove @shgroup/dsh-serenity-hooks
```

- **npm**：`@shgroup/dsh-serenity-hooks`（maintainer shgroup，MIT，README 完整）
- **源码**：https://github.com/tellmewhattodo/dsh-serenity-plugin
- 安装后重启 dsh web；新会话自动获得 11 工具（其中 `im-bridge` / `acc-diag` 按本 CCC 配置出现）+ 系统提示词注入 + WebUI 状态徽章
- 插件开发维护视角（架构/决策/发布流程）见 `dsh-serenity-plugin-development` skill

## 参考

- ACC 标准源头：`serenity-plugin-development` skill（opencode 运行时，osp 侧）
- 本实现（Native 插件）：`AI_LAB/dsh-serenity-plugin/hooks/dsh-serenity-hooks/`（DSH 运行时）
- 宿主系统：`home-serenity` CCC 的 `.opencode/skills/home-serenity/SKILL.md`
