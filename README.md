# dsh-serenity-plugin — Serenity ACC for DeepSeek Harness

> **不是安全沙箱——是认知容器。** DeepSeek Harness（DSH）上的宁静号 ACC（Abstract Cognitive Container）实现：
> 为 DSH 会话提供认知容器基础设施——真实工具、机械约束、系统提示词注入与 WebUI 状态。
>
> 面向 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 0.1.0-rc 及以上版本。

## 这是什么

[opencode-serenity-plugin](https://github.com/tellmewhattodo/opencode-serenity-plugin) 是 OpenCode 运行时的宁静号 ACC；本仓库是 **DSH（DeepSeek Harness）运行时的独立实现**。

- **独立实现**：不复用 opencode-serenity-plugin 源码；语义对齐其 ACC 标准（工具集 + 机械守卫 + 协作纪律），**系统提示词注入五块逐字节对齐**（见下文）
- **主产物 = Native Cordis 插件**（`@shgroup/dsh-serenity-hooks`）：真实 DSH 工具（`ctx.tools.register` 进程内注册）+ 拦截缝机械约束——DSH 官方扩展形态（与 harness 自身 200+ 包同构）
- **知识层 = 技能**（acc-serenity 等）：只承载知识，约束交给插件机械执行
- **平台复用**：路径守卫（fs 沙箱）、循环/常驻（goal/subagent）、压缩保留（compaction）等 DSH 原生能力直接复用，不重造

## 特性

| 能力 | 说明 |
|------|------|
| **真实 DSH 工具 ×9** | `cc_fs`（文件系统 15 子命令）/ `session`（会话全周期 9 子命令）/ `acc_kit`（health/time/wait）/ `cc_git` / `acc_msm`（MSM 框架）/ `eap` / `neat` / `cce` / `loop`（牛马循环），全部 `ctx.tools.register` 进程内注册 |
| **系统提示词注入（5 块）** | `systemPrompt.section`（全局，order -50）：`=== Serenity ACC ===`（身份+工具清单）/ `=== Serenity CCE ===`（CCE 5 行为约束+H_op）/ `=== Serenity Constraints ===`（Root+文件/shell/subagent/session-first）/ 该 CCC 顶层入口 skill 全文（按 `.serenity` 记号发现，任意 `xx-serenity`）/ `=== Serenity Session ===`（活跃会话+todowrite 首位约定）——对齐 opencode-serenity-plugin `system.transform`，平台无关文本逐字节一致 |
| **拦截缝机械约束** | safe-mode（bash 从工具列表消失）/ 路径逃逸阻断（P3 根内完整、根外零权限）/ 黑名单 / 治理文件保护 / session-keeper DCP 提醒——模型不可绕过 |
| **压缩保留** | `compaction/end` 后重注入 ACC 身份（上下文压缩不丢失 CCC 约束） |
| **WebUI 状态徽章** | 会话头部绿状态点徽章 + safe-mode 一键开关；点击展开详情卡（CCC 根 / loop 模型 / 守卫信息） |
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

插件加载后，进入 CCC 目录的 DSH 会话自动获得：9 个 ACC 工具 + 机械守卫 + ACC 身份注入 + 入口 skill 系统提示 + session-keeper 提醒。WebUI 会话头部出现 Serenity 状态徽章（safe-mode 一键开关 + 点击展开详情）。

**开启安全模式**：点击 WebUI 徽章中的 safe-mode 开关 → bash 从工具列表消失 → agent 走 MSM 白名单通道。

## 功能详解

### 一、工具 ×9

| 工具 | 能力 | 说明 |
|------|------|------|
| `cc_fs` | 15 子命令 | root / resolve / exists / list / tree / relative / mkdir / rm / mv / cp / touch / append / reveal / info / find；路径逃逸阻断 + 根保护 + `regex:` find |
| `session` | 9 子命令 | list / show / create / use / close / health / qa / archive / summary；`AGENT_SESSIONS/` 全周期，S### 自动分配 |
| `acc_kit` | 3 子命令 | health（CCC 三原则 P1/P2/配置）/ time / wait |
| `cc_git` | 4 子命令 | status / commit / push / log；push 非快进输出操作建议（绝不自动 force） |
| `acc_msm` | 6 子命令 | list / exec / register / deregister / check / guide；异步执行 + 600s 超时 kill |
| `eap` | 渐进披露 | EAP 认知质量框架 |
| `neat` | 渐进披露 | Neat 设计协作协议 |
| `cce` | 渐进披露 | 认知连续性工程 |
| `loop` | 牛马循环 | 指定模型专用 agent 反复执行；maxRounds 默认 100；进度文件续跑 |

### 二、拦截缝机械约束

| 拦截缝 | 能力 |
|--------|------|
| `tools/pre-execute` | safe-mode bash deny / 治理文件保护 / 黑名单 / 路径逃逸 → deny |
| `ctx.tools.guard` | 终局 deny（顺序无关的终局不变式） |
| `tools/restrict` | safe-mode 时 bash 从模型工具列表消失（每 step 同步） |
| `agent/session-start` + `agent/pre-step` | ACC 注入消息 + safe-mode restrict 每步同步 |
| `systemPrompt.section` | 完整系统提示词 5 块注入（全局，order -50） |
| `agent/turn-stopping` | 活动会话心跳自动落盘 |
| `session/event`（compaction/end） | 压缩保留：压缩后重注入 ACC 身份 |
| `tools/post-execute` | session-keeper DCP：计分达阈值注入提醒（observe-and-enrich，绝不 veto） |

### 三、safe-mode 机制

```
用户（WebUI）开关 .serenity-safe-on
  → pre-step 每步检测标记 → agent.ctx.tools.restrict({deny:['bash']})
    → bash 从模型工具列表【消失】（下一 step 生效）
  → 守卫兜底：即使 restrict 未生效，bash 调用也被 deny
```

- **bash 消失，不是报错**：模型看不到 bash 工具，自然不发起调用
- **用户能力**：开关仅限 WebUI（POST 需 `x-serenity-ui: 1` 头）；agent 不可见、不可自开关（治理文件保护）

### 四、激活门控

所有能力只在 `.serenity` 标记的 CCC 目录内生效；其他目录对 DSH 原生行为零影响（守卫/注入/落盘直接放行，工具调用降级报错）。

### 五、配置（运行时）

`.dsh/serenity.json`（回退 `.opencode/serenity.json`）：

```jsonc
{
  "loop": { "defaultModel": "provider/model" },   // loop 默认模型
  "sessionKeeper": { "threshold": 100 },           // keeper 提醒阈值
  "safeMode": { "blacklist": [".secrets/", "regex:\\.env$"] }  // 守卫黑名单
}
```

## 系统提示词（对齐 opencode-serenity-plugin）

五块注入与 opencode-serenity-plugin `system.transform` 结构一致（顺序 ACC → CCE → Constraints → SKILL 全文 → Session），CCE / Constraints / Session 文本**逐字节一致**（机械断言见 `hooks/dsh-serenity-hooks/tests/osp-alignment.test.ts`）；唯一平台差异为工具名（`acc_msm` 等 DSH 真实工具）与 SKILL 治理内容过滤。

## WebUI

- **会话头部状态徽章**（`conversation.session.header.actions` 槽）：绿状态点（CCC 内/外）+ 版本 + safe-mode 开关；点击展开详情卡（CCC 根路径 / loop 模型 / 守卫信息：blacklist、keeper 阈值）
- 样式遵循 [web-styling.md](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/web-styling.md)：`--dsw-alias-*` 语义 token，明暗主题自适应

## 开发

```bash
# 完整开发循环（safe-mode 下经 acc_msm 亦可）
pnpm typecheck          # hooks/dsh-serenity-hooks（node + client 双面）
pnpm test               # vitest 全量（184 tests）
pnpm build              # tsc + tsdown 双 bundle（lib/index.js + client.js）
```

- **测试**：184 个测试（28 files），typecheck 通过真实 DSH 类型契约（tsconfig paths 指向本地 DSH 安装，见 `hooks/dsh-serenity-hooks/tsconfig.json`）
- **构建**：tsc（类型+声明）+ tsdown（Node half + WebUI client bundle + CSS 内联）

## 与 opencode-serenity-plugin 的关系

| | opencode-serenity-plugin | dsh-serenity-plugin |
|---|------|------|
| 宿主 | OpenCode | DeepSeek Harness |
| 实现 | 独立 | **独立**（不复用源码） |
| 系统提示词 | `system.transform` | `systemPrompt.section`，平台无关文本逐字节对齐 |
| 工具 | msm_list/exec/cc-fs/session 等 | cc_fs/session/acc_msm/cc_git/eap/neat/cce/loop |

## CCC 运行时可互换（osp / dsh 任意换用）

**同一套 CCC 与运行时插件解耦——任意 CCC 可以随时换用 opencode-serenity-plugin 或 dsh-serenity-plugin 作为其 ACC 运行时：**

- **CCC 文件格式跨运行时一致**：`.serenity` 记号文件（内容 = 顶层入口 skill 名）、`.opencode/skills/`（知识技能）、`.dsh/serenity.json`（配置）、`AGENT_SESSIONS/`（会话追踪）——两个插件读写同一套文件，语义相同
- **任选其一**：在 OpenCode 宿主中安装 opencode-serenity-plugin，或在 DSH 宿主中安装本插件；同一 CCC 可随时切换运行时，知识技能与既有数据无需任何改动
- **差异仅在平台层**：工具命名（`msm_exec`/`cc-fs` vs `acc_msm`/`cc_fs`）、系统提示词注入通道（`system.transform` vs `systemPrompt.section`）——平台无关文本逐字节对齐，切换后 Agent 收到的认知约束完全一致

## 许可

MIT（见 [LICENSE](LICENSE)）

> **版本**: v1.16.0 &nbsp;|&nbsp; **前置**: DSH 0.1.0-rc+ / Node ≥ 20 / bun
