# dsh-serenity-plugin — Serenity ACC for DeepSeek Harness

> **不是安全沙箱——是认知容器。**
> DeepSeek Harness（DSH）上的宁静号 ACC（Abstract Cognitive Container）实现：让 DSH 会话成为**认知发生、存储、再发生的地方**。
>
> 面向 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 0.1.0-rc 及以上版本。

## 认知容器：这个插件在做什么

> 理论根基见 [serenity-acc-specs](https://github.com/tellmewhattodo/serenity-acc-specs) §0（认知容器标准，v1.3.1）。

**认知容器是认知发生、存储、再发生的地方。** 本插件把任意带 `.serenity` 标记的目录（CCC, Concrete Cognitive Container）变成这样的容器：

| 认知环节 | 机制 |
|---------|------|
| **发生** | 认知以 Loop 形式进行——agent 的每一轮 turn 都是认知 Loop 的一次迭代；Loop 中一切外部交互（工具调用、等待用户、系统事件）**都是反馈**，是 Loop 在采样世界以验证内生预测 |
| **存储** | 轨迹（trajectory）持久化——`SESSION.md` 是轨迹的**持久身体**（永远原位），`AGENT_SESSIONS/` 是轨迹的库房 |
| **再发生** | 轨迹被新的 agent 重新推动——`session_rebuild`（Ship of Theseus）：载体可重建，本体不变 |

核心认知：

```
Trajectory（主体，跨越时间的存在）
    ↑ 由某个 Agent 推动
Session（载体，可重建——轨迹此刻的承载实例）
LLM / Runtime / Tools（认知介质，可替换）
```

- **Agent 是可替换的，Trajectory 才是连续的**——LLM 是认知介质不是大脑；agent 是过程中的角色；`SESSION.md` 是轨迹的持久身体，工作会话（dsh conversation）是轨迹的可重建运行副本
- **认知闭环**：人类介入 = trajectory 的反馈输入之一（与 tool 调用同质）——在轨迹主体 + 相对时间视角下，宁静号已经实现**人类-LLM 协作闭环**
- **协作规模不受单个 agent 生命周期限制，而受轨迹连续性限制**——只要轨迹连续，参与的 agent、模型、宿主都可替换

## 本仓库是什么

[opencode-serenity-plugin](https://github.com/tellmewhattodo/opencode-serenity-plugin) 是 OpenCode 运行时的宁静号 ACC；本仓库是 **DSH（DeepSeek Harness）运行时的独立实现**。

- **独立实现**：不复用 opencode-serenity-plugin 源码；语义对齐同一 ACC 标准（工具集 + 机械守卫 + 协作纪律），**系统提示词注入逐字节对齐**（见下文）
- **主产物 = Native Cordis 插件**（`@shgroup/dsh-serenity-hooks`）：真实 DSH 工具（`ctx.tools.register` 进程内注册）+ 拦截缝机械约束——DSH 官方扩展形态（与 harness 自身 200+ 包同构）
- **知识层 = 技能**（acc-serenity 等）：只承载知识，约束交给插件机械执行
- **平台复用**：路径守卫（fs 沙箱）、循环/常驻（goal/subagent）、压缩保留（compaction）等 DSH 原生能力直接复用，不重造

## 特性

| 能力 | 说明 |
|------|------|
| **真实 DSH 工具 ×11** | `cc_fs`（文件系统 15 子命令）/ `session`（会话全周期 9 子命令）/ `acc_kit`（health/time/wait）/ `cc_git` / `acc_msm`（MSM 框架）/ `eap` / `neat` / `cce` / `handyman`（杂工循环 + jobs 并行）/ `session_rebuild`（轨迹跟踪器超限重建）/ `localstore`（凭据/配置存储），全部 `ctx.tools.register` 进程内注册 |
| **系统提示词注入（8 块）** | `systemPrompt.section`（全局，order -50）：`=== Serenity ACC ===`（身份）/ `=== Serenity Metaphor ===`（世界模型：船/航行/船员三层隐喻）/ `=== Serenity Principles ===`（认知容器本体论 + MSM 原则）/ `=== Serenity CCE ===`（5 行为约束 + H_op）/ `=== Serenity EAP ===`（E↑R↓S↑ 自检）/ 状态块（Safe Mode / Localstore）/ 该 CCC 顶层入口 skill 全文（按 `.serenity` 记号发现）/ `=== Serenity Session ===`（活跃会话 + todowrite 首位约定）——对齐 opencode-serenity-plugin，平台无关文本逐字节一致 |
| **first-anchor 锚定（零配置）** | 任何 CCC 在抽象层都是宁静号/ACC——新会话首轮注入 2 条协议锚定消息（ACC 身份 + 协作协议），0 工具纯文字确认后晋升完整工具目录；机制与内容代码固化，无 CCC 配置面 |
| **拦截缝机械约束** | safe-mode（bash 从工具列表消失）/ 路径逃逸阻断（P3 根内完整、根外零权限）/ 黑名单 / 治理文件保护 / Trajectory Steward DCP 提醒——模型不可绕过 |
| **session_rebuild 轨迹跟踪器** | 上下文超阈值提示 LLM 主动触发 `session_rebuild`：同一会话 surface 完全清空（Ship of Theseus），锚点保留 first-anchor 协议正文 + 「继续 S### 的工作」，**自动继续**（steer）无需用户手工输入；SESSION.md 持久轨迹原位不动；shadow-price 协议合规（token-meter 计量正确回落） |
| **Trajectory Steward** | 计分提醒机制（`[TRAJECTORY-STEWARD]` + ACK 协议）：督促 agent 把进度落回 SESSION.md——机制先于提醒，预声明在系统提示词中 |
| **双端口网关（外部访问）** | 插件自起第二 node:http 监听器（默认 0.0.0.0:3081）+ 登录页（scrypt 密码 或 TOTP 验证码**二选一** + 二维码扫码绑定 + CSRF token 集合 + 失败锁定指数退避）+ HttpOnly cookie（滑动 24h）+ 反代主端口（Host/Origin 改写过信任栅栏）+ WS 转发 + 工作区白名单 |
| **图片自动落盘兜底** | 模型不支持图片时自动补救：粘贴图片 → 落盘 `_tmp/images_from_user/` → 注入「用户提供了一张图片（路径：…）」文本重发 → agent 经 CCC 自有 vlm MSM 识别 |
| **任意文件粘贴自动落盘** | 非图片文件粘贴 → 自动落盘 `_tmp/files_from_user/`（可执行扩展名拒绝 + 10MB 上限 + 文件名脱敏）+ 输入框 draft 追加路径提示（随消息进对话）→ agent 经 CCC 自有 MSM 处理（PDF 提取 / 压缩包解压 / 表格解析） |
| **persona 彩蛋模式** | 插件设定中可替换 ACC 系统提示词的输出约束/指令遵循约束部分（EAP 块 + MSM 原则段）——配置后用户文本替代原本；未配置完全默认零影响 |
| **压缩保留** | `compaction/end` 后重注入 ACC 身份（上下文压缩不丢失 CCC 约束） |
| **WebUI 状态徽章 + 高级面板** | 会话头部状态徽章（**方案 O 盾牌版**：绿点=激活恒绿 + 盾牌=SAFE 状态琥珀/绿 + 滑块快速开关）+ 点击展开 CCC 状态卡；DSH 设置面板承载插件开关/阈值/外部访问 |
| **激活门控** | 所有能力只在 `.serenity` 标记的 CCC 目录内生效；其他目录对 DSH 原生行为零影响 |

## 核心哲学：为什么 MSM 比 bash 强，为什么需要安全模式

```
安全模式的存在，不是因为「禁 bash 让人不方便」，
而是因为「经过编写与测试的 MSM 在可靠性与安全性上强于裸 bash」。
```

| 维度 | 裸 bash | 编写测试的 MSM |
|------|---------|----------------|
| **确定性** | 每条命令都是新的，结果依赖环境、工作目录、时序 | 纯 TS 脚本，同一输入同一输出，可单测（vitest） |
| **安全边界** | 无内置约束；路径、范围全靠提示词纪律 | 注册表 + 路径逃逸校验 + 600s 超时强杀 |
| **可审计** | 调用即焚，无留痕 | 注册表 + 退出码协议（0/1/2）+ 配对测试 |
| **自我描述** | `--help` 随写随忘 | `--schema` / `--list` 协议自描述 |
| **可靠运行** | 死锁/挂起只能靠人工 | 异步执行（不阻塞事件循环）+ 超时自动 kill |

**安全模式的真正含义**：开启后，DSH 的 `tools.restrict` 机制让 **bash 从模型的工具列表中彻底消失**（模型根本看不到它，不是调用时报错）——迫使 agent 走 MSM 白名单通道：注册的、测试过的、带边界的确定性操作。安全模式开关是**用户能力**（仅 WebUI 可操作，agent 不可见、不可自开关）。

## 快速开始

前置：Node ≥ 20（或 bun）、DSH 0.1.0-rc 及以上、pnpm。

### 方式一：npm 安装（推荐，已发布到 npm registry）

```bash
# 1. 从 npm registry 安装插件到 DSH profile（自动加入 bundles 层）
dsh plugin --profile web add @shgroup/dsh-serenity-hooks

# 2. 重启 dsh web（插件与 WebUI client 生效）
dsh web
```

安装即用：`dsh plugin` 检测到包的 `dsh.bundle` 声明后自动激活配置层，无需手写任何配置。卸载：

```bash
dsh plugin --profile web remove @shgroup/dsh-serenity-hooks
```

### 方式二：从 GitHub 源码安装（本地 clone + link 到 hooks 子包）

```bash
# 1. 克隆公开仓库
git clone https://github.com/tellmewhattodo/dsh-serenity-plugin.git
cd dsh-serenity-plugin

# 2. link 安装 hooks 子包（npm 发布单元 = hooks/dsh-serenity-hooks；仓库根包非插件）
dsh plugin --profile web add link:$(pwd)/hooks/dsh-serenity-hooks

# 3. 重启 dsh web
dsh web
```

> ⚠️ 不要用 `dsh plugin add github:tellmewhattodo/dsh-serenity-plugin`——git URL 只能指向仓库根，而根包（`@shgroup/dsh-serenity-plugin`）是 workspace 容器、非 bundle 层插件，安装了也不会激活。git 安装获取的是源码：作者侧自包含 `prepare` 构建（本包已提供，构建完整 Node + client 双 bundle），用户侧需在 profile 的 `pnpm-workspace.yaml` 中 `allowBuilds` 放行构建脚本。

### 方式三：本地开发安装（同仓）

```bash
dsh plugin --profile web add link:<本仓>/hooks/dsh-serenity-hooks
```

### 安装后

```bash
# 在目标 CCC（带 .serenity 标记的目录）安装知识技能
dsh-serenity-plugin install --scope ccc

# 检查激活状态
dsh-serenity-plugin status
```

插件加载后，进入 CCC 目录的 DSH 会话自动获得：11 个 ACC 工具 + 机械守卫 + ACC 身份注入 + first-anchor 锚定 + 入口 skill 系统提示 + Trajectory Steward 提醒。WebUI 会话头部出现 Serenity 状态徽章（方案 O 盾牌版：绿点 + 盾牌 + 滑块快速开关 + 点击展开详情）。

**开启安全模式**：点击 WebUI 徽章中的 safe-mode 开关 → bash 从工具列表消失 → agent 走 MSM 白名单通道。

## 最佳实践：一个家庭认知基础设施

> 以真实部署「宁静号」为范例（本文所有地址/账号/路径/密钥均已泛化，不涉及任何隐私）。
> 一个带 `.serenity` 标记的目录 = 一个 CCC。本节展示这个系统**真实能做什么**——
> 每个用例给到具体的工具调用链，读者可照做。

### 一、一个 CCC 的目录解剖

```
home-serenity/                    ← CCC 根（.serenity 记号文件标记）
├── .serenity                     ← 记号：本目录是一个认知容器
├── .opencode/
│   ├── serenity.json             ← CCC 级配置：handyman 模型白名单 / 会话阈值 / 黑名单
│   └── skills/                   ← 领域技能（每个 = 一个领域知识的 EAP 封装）
│       ├── home-media/           ←   媒体：获取 / 字幕 / 分发
│       ├── home-wealth/          ←   财务：资产 / 负债 / 收支 / 预算
│       ├── family-profiles/      ←   成员档案（唯一真相源）
│       └── …（每个 skill 可持有 MSM 脚本）
├── AGENT_SESSIONS/               ← 会话库房：每目录一个 SESSION.md（持久轨迹）
│   └── 2026-08-27--S142--xxx/
│       └── SESSION.md            ← 轨迹身体：目标 / 决策 / 进度（永远原位）
└── _tmp/                         ← 运行时落盘（图片 / 用户粘贴文件）
    ├── images_from_user/
    └── files_from_user/
```

### 二、日常能做什么（真实用例，含操作链）

| # | 场景 | 操作链（工具 → 子命令 → 效果） |
|---|------|--------------------------------|
| 1 | **长期项目维护** | `session create --desc xxx` → 自动建 `YYYY-MM-DD--S###--xxx/SESSION.md` → 多步工作逐段落进度 → 中断后 `session use` 恢复 → 上下文超限时 `session_rebuild` 从轨迹自动接续（Ship of Theseus） |
| 2 | **批量代码同步** | 根仓 `cc_git commit/push`；多个子仓库一键 `resources-management sync`（自动 commit + push 全部）；多仓状态 `status --all` |
| 3 | **媒体字幕生产** | 搜索片源（BT）→ 下载 → Whisper 转写 → 大模型翻译 → 双语 SRT → 机械 QC（时间轴/时长/CPS/双语对齐 7 项检查）→ 分发（RSS/邮件） |
| 4 | **服务器巡检** | `server-tool health` → CPU/内存/GPU/容器/服务状态一键报告；`server-tool container` 查看/重启容器；`server-tool vllm` 查询推理服务；全部经 ssh-connect 白名单通道 |
| 5 | **内网服务定位** | `landscape-tool` 仓库全景（20+ 仓库分类/技术栈/关联）；`network-tool` 设备/端口扫描——回答「XX 服务在哪台机器、什么端口」 |
| 6 | **财务数据管理** | 本地结构化记录资产/负债/收入/支出/预算 → 查询/汇总；宏观跟踪框架（可选接入外部利率数据，如房贷利率对比工具） |
| 7 | **成员档案** | `profile list/show/create/update`——成员资料统一维护，CCC 是唯一真相源 |
| 8 | **想法随手记** | 有想法随时开聊 → AI 访谈式理清 → 结构化归档 → 定期回顾思考模式 |
| 9 | **外部访问（手机/出差）** | 浏览器开 `http://内网地址:3081` → 登录页：用户名 + 密码 **或** Authenticator 6 位码（二选一）→ 手机直接操作 WebUI；账号在设置面板管理（密码 + TOTP 扫码绑定 + 失败 5 次锁定 15 分钟） |
| 10 | **粘贴资料自动处理** | **图片**：粘贴 → 自动落盘 `_tmp/images_from_user/` → 视觉模型识别（识别快递单/截图/图表）→ 对话中直接可用；**任意文件**：粘贴 PDF/压缩包/文档 → 自动落盘 `_tmp/files_from_user/` → agent 自动提取（PDF 提取 / 压缩包解压 / 表格解析，均有专用 MSM） |

### 三、管理什么（治理面，含机制细节）

| 治理对象 | 机制细节 |
|----------|----------|
| **可执行单元** | `acc_msm list` 看全量注册表；`acc_msm check` 品质检查（4 项 DC：有测试 / 有 main 守卫 / 双向引用一致 / path 参数类型守卫）；`register/deregister` 管理——所有操作是注册的、测试过的、自描述的 |
| **认知质量** | 定期 SQC 扫描 → 每个技能保持 EAP 合规（显式 / 可重建 / 稳定）；设计协作走 Neat 协议（小步对齐 / 显式决策 / 文档驱动） |
| **安全模式** | WebUI 一键开启 → bash 从模型工具列表**消失**（非报错）→ agent 只能走注册 MSM；开关是用户能力，agent 不可见不可自开关 |
| **凭据** | `localstore.json` 集中存凭据/密钥（git 默认拒绝提交，物理保证不外泄）；`credential list/get` 统一读取 |
| **外部访问安全** | 登录审计（scrypt + 常量时间比较 + 256-bit token + 滑动 24h）；TOTP 扫码绑定（二维码渲染）；失败锁定（5 次 → 15min 指数退避）；CSRF token 服务端集合（多标签不冲突）；工作区白名单（仅允许的外部工作区可见） |
| **会话库房** | 会话全生命周期：create / show / health（stale/stalled/drift）/ qa（事实核查）/ archive——每段工作的轨迹可追溯可重建 |
| **上下文卫生** | Trajectory Steward 计分提醒（超阈值督促把进度落回 SESSION.md）；上下文超限时自动提示重建（阈值可在设置面板调节） |

### 四、典型一天（串联用例）

```
早上：内网服务巡检（server-tool health）→ 一切正常，无需干预
上午：同步昨日代码（resources-management sync）→ 子仓库全部推送到 GitLab
午间：收到一份 PDF 账单 → 粘贴到对话 → 自动落盘 + 表格提取 → 记入财务数据
下午：制作一期视频字幕（Whisper → 翻译 → 双语 SRT → QC）→ 推送到订阅
晚间：外部设备访问家庭服务（登录页：TOTP 码验证）→ 处理一个运维问题
全程：每段工作落 SESSION.md → 轨迹连续，随时可换人/换模型/换宿主接续
```

## 功能详解

### 一、工具 ×11

| 工具 | 能力 | 说明 |
|------|------|------|
| `cc_fs` | 15 子命令 | root / resolve / exists / list / tree / relative / mkdir / rm / mv / cp / touch / append / reveal / info / find；路径逃逸阻断 + 根保护 + `regex:` find |
| `session` | 9 子命令 | list / show / create / use / close / health / qa / archive / summary；`AGENT_SESSIONS/` 全周期，S### 自动分配；use 激活时同步命名 dsh 会话（S###-日期） |
| `acc_kit` | 3 子命令 | health（CCC 三原则 P1/P2/配置）/ time / wait |
| `cc_git` | 5 子命令 | status / commit / push / log / pull；push 非快进输出操作建议（绝不自动 force） |
| `acc_msm` | 7 子命令 | list / exec / register / deregister / check / guide / ccc-config；异步执行 + 600s 超时 kill |
| `eap` | 渐进披露 | EAP 认知质量框架 |
| `neat` | 渐进披露 | Neat 设计协作协议 |
| `cce` | 渐进披露 | 认知连续性工程 |
| `handyman` | 杂工循环 | 指定白名单模型专用 worker agent 同步循环到完成；jobs 并行编排（maxParallel 默认 10）；进度文件续跑；worker 非正常停止自动重启；worker 不含 handyman 自身（递归只走 subagent） |
| `session_rebuild` | 轨迹跟踪器 | 上下文超阈值时完全清空重建（Ship of Theseus）：surface replace → first-anchor 协议正文 + 继续指令 → 自动继续 |
| `localstore` | 凭据存储 | 凭据/配置命名空间（credential/config），git 策略可配 |

### 二、拦截缝机械约束

| 拦截缝 | 能力 |
|--------|------|
| `tools/pre-execute` | safe-mode bash deny / 治理文件保护 / 黑名单 / 路径逃逸 → deny |
| `ctx.tools.guard` | 终局 deny（顺序无关的终局不变式） |
| `tools/restrict` | safe-mode 时 bash 从模型工具列表消失（每 step 同步） |
| `agent/session-start` + `agent/pre-step` | ACC 注入消息 + safe-mode restrict 每步同步 |
| `systemPrompt.section` | 完整系统提示词 8 块注入（全局，order -50） |
| `agent/inbox/inserted` | first-anchor 锚定注入（新会话首轮 2 条协议消息） |
| `agent/turn-stopping` | session_rebuild 执行点（turn 结束清空 + steer 自动继续） |
| `session/event`（compaction/end） | 压缩保留：压缩后重注入 ACC 身份 |
| `tools/post-execute` | Trajectory Steward DCP（计分提醒）+ 轨迹跟踪器 contextPressure 检测（独立机制） |

### 三、safe-mode 机制

```
用户（WebUI）开关 .serenity-safe-on
  → pre-step 每步检测标记 → agent.ctx.tools.restrict({deny:['bash']})
    → bash 从模型工具列表【消失】（下一 step 生效）
  → 守卫兜底：即使 restrict 未生效，bash 调用也被 deny
```

- **bash 消失，不是报错**：模型看不到 bash 工具，自然不发起调用
- **用户能力**：开关仅限 WebUI（POST 需 `x-serenity-ui: 1` 头）；agent 不可见、不可自开关（治理文件保护）

### 四、session_rebuild（轨迹跟踪器）+ Trajectory Steward

```
Trajectory Steward post-execute：contextPressure 投影 ≥ rebuildThreshold → 追加 [TRAJECTORY] 提示
  → LLM 主动调用 session_rebuild（不自动执行——防误清空）
  → queueRebuild：门控 + 构建锚点 → pending 队列
  → agent/turn-stopping：surface replace 全部节点 → 锚点消息
    （[TRAJECTORY-REBUILD] + first-anchor 协议正文 + 「继续 S### 的工作」+ SESSION.md 路径）
  → agent.steer(自动继续) → next-step 非空 → turn 不 break → 模型自动读 SESSION.md 继续
```

- **SESSION.md = 持久轨迹**（身份/决策/进度本体，永远原位）；**dsh 会话 = 临时可重建工作副本**——载体可重建，轨迹连续（Ship of Theseus）
- 同一会话 id 原地重建 → 同工作区天然满足、无需销毁/切换/归档
- **shadow-price 协议合规（v1.23.5）**：replace 前 append `compaction/prune` 定价被替换范围 → token-meter 计量正确回落（UI「对话消息」不再虚高累计）
- 触发阈值可在 DSH 设置面板调节（rebuildThreshold，默认 0.9）

**Trajectory Steward**（v1.23.0 定名）：计分提醒机制——工具使用达阈值时以 `[TRAJECTORY-STEWARD]` 前缀 + ACK 协议督促 agent 把进度落回 SESSION.md；机制预声明在系统提示词 Session 块中（机制先于提醒）。

### 五、双端口网关（外部访问）

```
外部浏览器 → http://LAN-IP:3081（第二监听器，插件自起）
  → 未登录 → 极简登录页（用户名 + 密码 或 6 位验证码，二选一；移动端适配）
  → POST /serenity/login：scrypt 验证 / TOTP 校验（独立于密码，任一通过即登录）
      + CSRF 双提交（服务端 token 集合，多标签不冲突） + 失败锁定（5 次→15min 指数退避）
  → HttpOnly cookie（SameSite=Strict，滑动 24h）→ 302 反代
  → 已登录 → 反代 127.0.0.1:主端口（Host/Origin 改写 loopback 过信任栅栏）
  → /api/workspace.list 白名单过滤 + workspace.create 校验
  → WS upgrade 转发（101 回写 + 双向 error 监听防崩溃）
```

- 账号密码/TOTP/白名单 = **plugin 全局配置**（`~/.dsh/serenity-hooks.json`，0600）——plugin 是全局的，CCC 是具体的
- 开关（gatewayEnabled）在 DSH 设置面板；登录账号 CRUD 在设置面板「外部访问」区块
- **登录凭据二选一（v1.24.6）**：绑定验证器的账号可用密码 或 Authenticator 6 位码任一登录（未绑定仅密码；totpEnabled 关闭时 TOTP 完全禁用）
- **TOTP 二维码扫码绑定（v1.24.6~7）**：绑定验证器 → 随机生成 secret + 渲染二维码 → Authenticator 扫码即录入 → 保存即绑定（无确认码）
- 安全审计（S1-S12）：scrypt + timing-safe + 256-bit token + CSRF token 集合 + TOTP + 失败锁定 + 审计日志

### 六、激活门控

所有能力只在 `.serenity` 标记的 CCC 目录内生效；其他目录对 DSH 原生行为零影响（守卫/注入/落盘直接放行，工具调用降级报错）。

### 七、配置分层

| 配置 | 位置 | 内容 |
|------|------|------|
| DSH settings 面板 | settings.yaml（DSH 原生） | gatewayEnabled / rebuildEnabled / rebuildThreshold / namingEnabled |
| plugin 全局文件 | `~/.dsh/serenity-hooks.json`（0600） | gateway 账号（scrypt + TOTP）/ host / port / workspaces 白名单 / cookieSecure |
| CCC 配置 | `.opencode/serenity.json` | handyman.models（白名单+缺省模型）/ sessionKeeper.threshold / safeMode.blacklist / hooks.autoRestoreSession |
| CCC 凭据 | `localstore.json` | 凭据/配置命名空间（git 策略可配） |

## 系统提示词（对齐 opencode-serenity-plugin）

八块注入与 opencode-serenity-plugin 结构一致（ACC → Metaphor → Principles → CCE → EAP → 状态 → SKILL 全文 → Session），平台无关文本**逐字节一致**（机械断言见 `hooks/dsh-serenity-hooks/tests/osp-alignment.test.ts`）；唯一平台差异为工具名（`acc_msm` 等 DSH 真实工具）与 SKILL 治理内容过滤。v1.23.0 起模型可见文本全英化（Session=载体定义 + Trajectory Steward 预声明随 specs v1.3.1）。

## WebUI

- **会话头部状态徽章**（`conversation.session.header.actions` 槽）：**方案 O 盾牌版**（v1.24.2~5）——绿点 = Serenity 激活（恒绿）+ 盾牌 = SAFE 状态（琥珀空心 = OFF 提醒 / 绿 = ON 安心）+ **滑块快速开关**（点击直切安全模式）+ 点击卡片展开 CCC 状态卡（根路径 / handyman 模型 / 守卫信息 / 运行状态）
- **DSH 设置面板 section**（`settings.section` 槽）：Serenity 页——三功能开关 + 阈值 + 「外部访问」区块（监听地址/端口 + 登录账号 CRUD + TOTP 二维码绑定 + 工作区白名单 chips + Secure Cookie）
- **图片自动落盘**（`conversation.input.dock` 槽）：模型不支持图片时静默补救（上传 + 清 rail + 文本重发）
- **任意文件自动落盘**（`conversation.input.dock` 槽）：非图片文件粘贴 → 自动落盘 `_tmp/files_from_user/` + draft 追加路径提示（随消息进对话）
- 样式遵循 [web-styling.md](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/web-styling.md)：`--dsw-alias-*` 语义 token，明暗主题自适应

## 开发

```bash
# 完整开发循环（safe-mode 下经 acc_msm exec dsh-develop 亦可）
pnpm typecheck          # hooks/dsh-serenity-hooks（node + client 双面）
pnpm test               # vitest 全量（42 files / 465 tests）
pnpm build              # tsc + tsdown 双 bundle（lib/index.js + client.js）
```

- **测试**：42 files / 465 tests，typecheck 通过真实 DSH 类型契约（tsconfig paths 指向本地 DSH 安装，见 `hooks/dsh-serenity-hooks/tsconfig.json`）
- **构建**：tsc（类型+声明）+ tsdown（Node half + WebUI client bundle + CSS 内联；第三方库如 qrcode-generator 经 noExternal 内联，零运行时新依赖）
- **开发 MSM**：`scripts/dsh-develop.ts`（typecheck/test/build/status/commit/push/version/bump/deploy/restart-web/publish/github-push/**npm-install-dev**）+ `scripts/dsh-crash-investigate.ts`（崩溃调查，只读）
- **代码地图**：`docs/codebase-overview-v1.22.md`（分层架构/模块职责/数据流/配置分层/熵点）

## 与 opencode-serenity-plugin 的关系

| | opencode-serenity-plugin | dsh-serenity-plugin |
|---|------|------|
| 宿主 | OpenCode | DeepSeek Harness |
| 实现 | 独立 | **独立**（不复用源码） |
| 系统提示词 | `system.transform` | `systemPrompt.section`，平台无关文本逐字节对齐 |
| 工具 | msm_list/exec/cc-fs/session 等 | cc_fs/session/acc_msm/cc_git/eap/neat/cce/handyman/session_rebuild/localstore |

## CCC 运行时可互换（osp / dsh 任意换用）

**同一套 CCC 与运行时插件解耦——任意 CCC 可以随时换用 opencode-serenity-plugin 或 dsh-serenity-plugin 作为其 ACC 运行时：**

- **CCC 文件格式跨运行时一致**：`.serenity` 记号文件（内容 = 顶层入口 skill 名）、`.opencode/skills/`（知识技能）、`.dsh/serenity.json`（配置）、`AGENT_SESSIONS/`（会话追踪）——两个插件读写同一套文件，语义相同
- **任选其一**：在 OpenCode 宿主中安装 opencode-serenity-plugin，或在 DSH 宿主中安装本插件；同一 CCC 可随时切换运行时，知识技能与既有数据无需任何改动
- **差异仅在平台层**：工具命名（`msm_exec`/`cc-fs` vs `acc_msm`/`cc_fs`）、系统提示词注入通道（`system.transform` vs `systemPrompt.section`）——平台无关文本逐字节对齐，切换后 Agent 收到的认知约束完全一致

## 许可

MIT（见 [LICENSE](LICENSE)）

> **版本**: v1.24.9 &nbsp;|&nbsp; **前置**: DSH 0.1.0-rc+ / Node ≥ 20 / bun
