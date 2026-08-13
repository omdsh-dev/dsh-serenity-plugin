# dsh-serenity-plugin（宁静号 ACC · DSH 运行时）

> **不是安全沙箱——是认知容器。** DeepSeek Harness 上的宁静号 ACC（Abstract Cognitive Container）实现。
> **私有仓库**：`github.com/dsh-external/dsh-serenity-plugin`（private，仅组织成员可见）。
> **合规基线**：遵循 `docs/plugin-development-standard.md`（DSH plugin 开发标准，A–G 七节）。

## 这是什么

opencode-serenity-plugin 是 OpenCode 运行时的宁静号 ACC；本仓是 **DSH（DeepSeek Harness）运行时的独立实现**。

- **独立实现**：不复用 opencode-serenity-plugin 源码，语义对齐其 ACC 标准（工具集 + 守卫 + 协作纪律）
- **主产物 = Native Cordis 插件**（`@shgroup/dsh-serenity-hooks`）：真实 DSH 工具（`ctx.tools.register` 进程内注册）+ 拦截缝机械约束——DSH 的官方扩展形态（与 harness 自身 200+ 包同构）
- **知识层 = 技能**（acc-serenity 等）：只承载知识，约束交给插件机械执行
- **平台复用**：路径守卫（fs 沙箱）、循环/常驻（goal/subagent）、压缩保留（compact-basic）等 DSH 原生能力直接复用，不重造

---

## 核心哲学：为什么 MSM 比 bash 强，为什么需要安全模式

```
安全模式的存在，不是因为「禁 bash 让人不方便」，
而是因为「经过编写与测试的 MSM 在可靠性与安全性上强于裸 bash」。
```

**MSM（Mech & Semi-Mech）是安全模式的主角，不是 bash 的替代品——是更好的工具：**

| 维度 | 裸 bash | 编写测试的 MSM |
|------|---------|----------------|
| **确定性** | 每条命令都是新的，结果依赖环境、工作目录、时序 | 纯 TS 脚本，同一输入同一输出，可单测（vitest） |
| **安全边界** | 无内置约束；路径、范围全靠提示词纪律 | 注册表 + 路径逃逸校验（`type:"path"` 强制根内）+ 600s 超时强杀 |
| **可审计** | 调用即焚，无留痕 | mech-registry.json 注册 + 退出码协议（0/1/2/3）+ 配对测试 |
| **自我描述** | `--help` 随写随忘 | `--schema` / `--list` 协议自描述，压缩的唯一解压入口 |
| **可靠运行** | 死锁/挂起只能靠人工 | 超时自动 kill（异步 execFile，不阻塞事件循环） |

**安全模式的真正含义**：当用户开启 safe-mode，DSH 的 `tools.restrict` 机制让 **bash 从模型的工具列表中彻底消失**（不是调用时报错——是模型根本看不到它）。这迫使 agent 走 MSM 白名单通道：注册的、测试过的、带边界的确定性操作。

**用户限制体系**（safe-mode 存在的主要原因——用户能设定一系列特定限制，机械执行，模型不可绕过）：

| 限制 | 机制 | 说明 |
|------|------|------|
| **safe-mode（bash 消失）** | `agent.ctx.tools.restrict({deny:['bash']})` + 守卫兜底 | bash 从工具列表消失；调用亦被 deny。**用户能力**：仅 WebUI 可开关（`x-serenity-ui` 头），agent 不可见、不可自开关 |
| **黑名单路径** | 前缀匹配 + `regex:` 规则 | `.dsh/serenity.json` 的 `safeMode.blacklist`，写类工具命中即 deny |
| **路径逃逸** | CCC 根内相对路径校验 | 根内完整权限，根外零权限（P3） |
| **治理文件保护** | `.serenity` / `.serenity-safe-on` 对 agent 永远 deny | safe-mode 开关本身是用户能力，agent 不能篡改 |
| **MSM 路径校验** | flags `type:"path"` 参数强制根内 | 脚本路径与业务路径双重逃逸阻断 |

---

## 功能列表（v1.15.0）

### 一、Native Cordis 插件 `@shgroup/dsh-serenity-hooks`

位于 `hooks/dsh-serenity-hooks/`，标准 Cordis 插件契约（`name` / `inject` / `Config` / `apply`，无 default export）。**v1.15 合规化**：官方 bundle 形态（`dsh.bundle.patch` 声明 + 插件自带 `cordis.patch.yml` + `prepare` 消费端构建 + `peerDependencies`）——见 `docs/plugin-development-standard.md` B/E/F 节。

#### 1. 真实 DSH 工具 ×9（`ctx.tools.register(defineTool(...))`，进程内）

| 工具 | 能力 | 说明 |
|------|------|------|
| `cc_fs` | 15 子命令 | root / resolve / exists / list / tree / relative / mkdir / rm / mv / cp / touch / append / reveal / info / find；路径逃逸阻断 + 根保护 + `regex:` find；reveal 在 OS 文件管理器中打开路径（xdg-open/Finder/Explorer） |
| `session` | 9 子命令 | list / show / create / **use** / **close** / health / qa / archive / summary；AGENT_SESSIONS/ 全周期，S### 自动分配；use 写 `.dsh/active-session` 标记（系统提示词 Session 块生效）；委派失败回退内置 |
| `acc_kit` | 3 子命令 | health（CCC 三原则 P1/P2/配置）/ time / wait |
| `cc_git` | 4 子命令 | status / commit / push / log；push 非快进输出操作建议（绝不自动 force） |
| `acc_msm` | 6 子命令 | list / exec / register / deregister / check / guide；复用 mech-registry.json（v1 + 数组格式）；**异步 execFile 执行（不阻塞事件循环）**，600s 超时 kill |
| `eap` | 渐进披露 | EAP 认知质量框架（三变量 / 自检清单 / ACC 关系） |
| `neat` | 渐进披露 | Neat 设计协作协议（四铁律 / 五层推进） |
| `cce` | 渐进披露 | 认知连续性工程（容器 / 熵 / 生命周期 / EAP 关系） |
| `loop` | 牛马循环 | 指定模型（默认 MiniMax-M3 廉价牛马）专用 agent 反复执行；**maxRounds 默认 100**；进度文件续跑；`task` 参数 + 使用自述 |

#### 2. 拦截缝机械约束（模型不可绕过）

| 拦截缝 | 能力 |
|--------|------|
| `tools/pre-execute` | safe-mode bash deny / 治理文件保护 / 黑名单 / 路径逃逸 → deny |
| `ctx.tools.guard` | 终局 deny（顺序无关的终局不变式，只 deny 不可 allow） |
| `tools/restrict` | **safe-mode 时 bash 从模型工具列表消失**（DSH 原生机制，每 step 同步） |
| `agent/session-start` + `agent/pre-step` | **ACC 注入消息（v1.15.7）**：完整系统提示词（ACC 5 块 + CCC 顶层 skill 原文）+ safe-mode restrict 每步同步 |
| `systemPrompt.section`（全局，order -50） | **完整系统提示词注入（v1.15.6，对齐 osp system.transform）**：5 块——ACC 身份+工具清单 / CCE 5 行为约束+H_op / Constraints（Root+文件/shell/subagent/session-first）/ 该 CCC 顶层入口 skill 全文（按 `.serenity` 记号文件内容发现，任意 xx-serenity）/ Session（活跃会话+todowrite 首位约定） |
| `agent/turn-stopping` | 活动会话心跳自动落盘 |
| `session/event`（compact/end） | **压缩保留（v1.15.2）**：上下文压缩后重注入 ACC 身份（模型不丢失 CCC 约束） |
| `tools/post-execute` | **session-keeper DCP**：计分（write/edit=3、task=10、read/msm=1、+1 分/分钟），达阈值注入 `[SESSION-KEEPER-recorded-{code}]` 提醒（observe-and-enrich，绝不 veto） |
| `agent/status` | waitIdle（loop 轮次同步） |

#### 3. safe-mode 机制（v1.14.x 核心）

```
用户（WebUI）开关 .serenity-safe-on
  → pre-step 每步检测标记 → agent.ctx.tools.restrict({deny:['bash']})
    → 模型请求 tools = systemPrompt.assemble() → wireSchemas(scope) → view(scope).visible（应用 restrict）
      → bash 从模型工具列表【消失】（下一 step 生效）
  → 守卫兜底：即使 restrict 未生效，bash 调用也被 deny
```

- **bash 消失，不是报错**：模型看不到 bash 工具，自然不发起调用
- **用户能力**：开关仅限 WebUI（POST 需 `x-serenity-ui: 1` 头）；agent 不可见（身份/系统提示过滤 safe-mode 提及）、不可自开关（治理文件保护）
- **诊断**：`AGENT_SESSIONS/.restrict-diag.json` + status API 暴露 restrict 状态（lastSuccess/lastError/activeKeys）

#### 4. 激活门控（关键设计）

**所有能力只在 `.serenity` 标记的 CCC 目录内生效；其他目录对 DSH 原生行为零影响**：

| 能力 | 无 `.serenity` 时的行为 |
|------|------------------------|
| 守卫 / 上下文注入 / 回合落盘 / keeper | 直接放行，不计分、不注入、不落盘 |
| 工具 | 全局注册，但 CCC 外调用报错降级（"No CCC found"） |

#### 5. 配置读取（运行时）

`.dsh/serenity.json`（回退 `.opencode/serenity.json`）：

```jsonc
{
  "loop": { "defaultModel": "minimax-cn-coding-plan/MiniMax-M3" },  // loop 默认廉价模型
  "sessionKeeper": { "threshold": 100 },                            // keeper 提醒阈值
  "safeMode": { "blacklist": [".secrets/", "regex:\\.env$"] }       // 守卫黑名单
}
```

#### 6. 加载机制（免改 DSH 源码）

- `scripts/load-plugin.sh`（或 `dsh-develop deploy`）：构建（tsc + tsdown 双 bundle）→ **双锚定复制**（staging 根 + apps/cli node_modules）→ 7 项依赖 shim（cordis/schemastery/@deepseek-ai，升级免疫）→ profile patch（`~/.dsh/profiles/web/cordis.patch.yml` 幂等，**内容取自插件自带 bundle 层**）→ 预检导入 → 重启提示（支持 `--dry-run`）
- **官方安装路径（v1.15 起可用）**：`dsh plugin --profile web add link:<本仓>/hooks/dsh-serenity-hooks`（bundle 经 `dsh.bundle.patch` 自动入层；git 安装走 `prepare` 消费端构建）
- client half：`dshClient` 声明 + `exports["./client"]` + tsdown 双 bundle，SafeModePanel 挂 `conversation.session.header.actions` 槽

### 二、MSM 框架（Mech & Semi-Mech）

MSM 是**安全模式的正面通道**——白名单化的确定性操作，经 `acc_msm exec` 走受控执行。

- **Mech**：纯 TS 零 LLM 推理（确定性）
- **Semi-Mech**：TS 框架 + LLM 决策点（框架确定性，决策点显式标注）
- **注册**：`acc_msm register`（脚本 + 注册表 + 自动 git commit）
- **协议**：`--list` / `--schema` / `--format=json` 自描述
- **品质**：`acc_msm check` — DC-M1 有 .test.ts / M2 有 main() 守卫 / M3 脚本存在 / M4 path flag 标记
- **执行**：异步 execFile + 600s 超时 kill + path 逃逸校验（不阻塞事件循环）

### 三、dsh-develop MSM（safe-mode 开发通道）

safe-mode 下 bash 消失，但开发仍需进行——`dsh-develop` MSM 把常用操作封装为白名单通道：

```
typecheck | test [--filter] | build | status | commit <msg> | push |
version | bump <ver> | deploy | restart-web | api-status | sys | inspect-dsh | read-dsh
```

- 注册于 home-serenity（`acc_msm exec dsh-develop ...`）
- 构建/测试/git/部署全流程 safe-mode 可用（157/157 测试）
- `sys` 白名单命令（ps/ss/curl/lsof 等只读诊断，curl 强制 `--max-time 5`）

### 四、知识技能

| 技能 | 用途 |
|------|------|
| `acc-serenity` | 入口：身份 / 激活 / 工具与约束 / 协作纪律（EAP/Neat/会话/SSH 规范） |
| `acc-eap` | EAP 认知质量框架（E↑ / R↓ / S↑ + 自检清单） |
| `acc-neat` | Neat 设计协作协议（小步对齐 / 显式决策 / 文档驱动 / 不跳级） |
| `cce` | 认知连续性工程（身份 / 可达性 / 演化能力） |

> 顶层入口 skill（acc-serenity + home-serenity）原文经 `agent.ctx.systemPrompt.section`（order -50）注入系统提示词。

### 五、质量与验证

- **178 个测试**（27 files，vitest），typecheck 通过真实 DSH 类型契约（tsconfig paths → staging checkout）
- 关键回归：死锁根治（acc_msm 异步化）、restrict 挂载、safe-mode 语义、治理文件保护、loop 轮次
- `src/invariant.ts` 伴生：`dsh.plugin.json` contributes.tools 与代码注册工具一致性校验

---

## 快速开始

前置：Node ≥ 20（或 bun）、DSH（staging 2026-08-08+，含 agent/pre-step 事件）。

```bash
# 1.（一次性，需重启）加载 Native 插件到 DSH
bash scripts/load-plugin.sh && 重启 dsh web

# 2. 安装知识技能到当前 CCC（cwd 须带 .serenity）
dsh-serenity-plugin install --scope ccc

# 3. 检查激活状态
dsh-serenity-plugin status
```

插件加载后，进入 CCC 目录的 DSH 会话自动获得：9 个 ACC 工具 + 机械守卫（safe-mode/黑名单/路径隔离/治理文件保护）+ ACC 身份注入 + 入口 skill 系统提示 + session-keeper 提醒。

**开启安全模式**：WebUI 停靠栏 SafeModePanel 一键开关 → bash 从工具列表消失 → agent 走 MSM 白名单通道（`dsh-develop` 完成开发操作）。

## 开发

```bash
# 完整开发循环（safe-mode 下亦可用）：
acc_msm exec dsh-develop typecheck   # tsc --noEmit
acc_msm exec dsh-develop test         # vitest 全量
acc_msm exec dsh-develop build        # tsc + tsdown 双 bundle
acc_msm exec dsh-develop commit <msg> # git add -A + commit
acc_msm exec dsh-develop push         # push home GitLab
acc_msm exec dsh-develop deploy       # 双锚部署 + 预检
acc_msm exec dsh-develop restart-web  # 重启 dsh web（端口等待 + 健康检查）
```

开发方式仿照 opencode-serenity-plugin：skill 驱动 + 独立 git 仓 + AGENT_SESSIONS 会话追踪。

## 关联

| 资源 | 位置 |
|------|------|
| **DSH plugin 开发标准（合规基线）** | `docs/plugin-development-standard.md` |
| 插件设计（6 拦截缝方案） | `docs/dsh-serenity-hooks-design.md` |
| 部署运维指南 | `docs/DEPLOYMENT.md` |
| WebUI client half | `docs/WEBUI.md` |
| loop 工具设计 | `docs/LOOP-DESIGN.md` |
| 架构设计 / 契约 | `docs/architecture-v0.md` / `docs/contract-v0.md` |
| 项目会话 | `SESSION.md`（项目即会话） |
| 立项会话 | home-serenity `AGENT_SESSIONS/2026-08-06--S113--dsh-serenity-plugin-init/` |
| 标准源头 | `AI_LAB/opencode-serenity-plugin/` |

> **版本**: v1.15.8 &nbsp;|&nbsp; **许可**: MIT &nbsp;|&nbsp; **前置**: Node ≥ 20 / bun, DSH &nbsp;|&nbsp; **可见性**: 私有（dsh-external 组织）
