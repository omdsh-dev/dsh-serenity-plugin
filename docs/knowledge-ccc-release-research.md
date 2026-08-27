# 知识型 CCC 价值释放 — 调研与方案讨论（S142）

> 状态：调研完成，方案讨论中（用户 2026-08-27 提出需求）
> 性质：独立于远程访问（F1 双端口网关）的新需求线
> 关联会话：S142（dsh-serenity-plugin 长期维护）

## 0. 需求原文（用户）

对于一般宁静号 CCC，在积累了大量知识后，会产生这样的价值，即其在一个特定方面具有良好的智能表现，这就会催生两种需求：

1. **单独部署并单独设定好 Loop 约束充当问答助手**
2. **基于类似 ACP 的协议接入其它的 IM 充当知识提供机器人**

这个需求独立于远程访问需求，需要考虑如何满足。

## 1. 需求拆解（Neat 需求层）

| 场景 | 本质 | 与远程访问（F1）的区别 |
|------|------|----------------------|
| ① 问答助手 | 把知识 CCC 实例化为**独立问答服务**——单独部署（独立进程/实例）+ 单独设定约束（知识域、行为、工具面），像 Loop 一样自主循环到完成 | F1 是"人访问 Web UI"；这里是"程序/机器人访问知识"，面向自动化消费 |
| ② IM 知识机器人 | 通过**类 ACP 协议**把知识 CCC 暴露给 IM（微信/Telegram/飞书等），充当知识提供机器人 | F1 是 Web 界面人机交互；这里是消息渠道人机交互，且可编程 |

核心洞察：**两种需求共享同一条技术主线 = 把 CCC 的知识 + agent 能力通过标准协议暴露为可编程服务**。ACP（Agent Client Protocol）是这条主线的行业标准。

## 2. 调研发现：DSH 侧能力（官方）

### 2.1 官方 ACP server：`@deepseek-ai/dsh-acp`（packages/acp）

DSH 官方仓库（dsh-harness-public @ b150a551）**自带 ACP server 实现**：

- **形态**：automation-only ACP server over JSON-RPC stdio（stdout 只承载协议帧）
- **7 方法**：`initialize` / `authenticate`(no-op) / `session/new` / `session/prompt` / `session/cancel` / `session/update` / `session/request_permission`
- **核心语义**：
  - 每个 `session/new` 创建**一个 fresh agent**（cwd 绝对路径，persona 可定制——正是"单独设定约束"的落点）
  - `session/prompt` 支持文本+图片（durable store 挂载时），**committed 输出**（非流式，token 级延迟换干净结果）
  - `session/request_permission` 提供一次性 allow/reject 选择（bridge 可编程应答）
  - JSONL 持久化（`persistenceRoot` 配置，zstd 压缩）
- **已知限制**（官方声明）：fresh sessions only（无 load/resume/fork）、单 workspace、connection-owned lifetime（连接断开释放全部会话）、committed answers only（无实时进度/推理/工具活动上 wire）
- **官方示例**：`examples/acp-agent/`（61 个 cordis.yml 场景 + persona 定制 + sandbox 组合）——**可运行模板**

### 2.2 其它官方形态

| 形态 | 说明 | 适用 |
|------|------|------|
| `headless-agent` | `dsh --profile headless "task"`：单任务、fresh session、打印结果退出 | 一次性任务，非服务 |
| `jsonrpc-agent` | Python SDK 的 JSON-RPC 运行时，`DSH_SYSTEM_PROMPT` 部署级 persona | SDK 编程接入（无 IM 概念） |
| Web host | 现有 Web UI（已由 F1 网关覆盖） | 人机交互 |

### 2.3 本地运行时现状

- 本机 dsh 运行时 = npm 安装版（`~/.npm-global/lib/node_modules/@deepseek-ai/dsh`，rc.8），依赖清单**无 dsh-acp**（SESSION.md 已记录全依赖：dsh-settings/session-title 等）
- 官方 ACP 在源码仓（b150a551），npm 包是否已发布 `@deepseek-ai/dsh-acp` 需核验；若未发布 → 第三方或自研

## 3. 调研发现：第三方 DSH ACP 插件（npm 可装）

| 包 | 说明 |
|----|------|
| `@openma/deepseek-harness-acp`（openma-ai） | DSH 的 ACP server 实现（dsh-acp），npm 已发布 |
| `@dumbo-ai/dsh-acp`（dushaobindoudou/dsh-acp） | "drive dsh agents from Zed and any ACP v1 client"——ACP server 插件 |
| `dsh-acp-server` | 独立 ACP server 包 |
| `@anht3889/dsh-acp-zed` | Zed 集成用 ACP 适配 |

→ **DSH 生态 ACP server 已有多个可装实现**，说明"DSH 作为 ACP server"是成熟模式。

## 4. 调研发现：IM 桥接（需求②的直接参考）

### 4.1 微信桥（家庭实际 IM 最相关）

| 项目 | 说明 |
|------|------|
| **formulahendry/wechat-acp** | 微信消息 ↔ 任意 ACP 兼容 agent（Claude/Codex/Copilot/Qwen/Gemini/OpenCode/**OpenClaw**/Hermes/Kiro/Kimi/Pi）——最通用 |
| **gangtiser/wechat-acp-codex** | 微信私聊 → 本地 Codex/任意 ACP agent |
| **Supremesir/wechat-acp** | 微信 AI Agent 桥接框架（ACP 后端） |
| **wong2/weixin-agent-sdk** | 微信 Clawbot 接入任意 Agent（基于微信官方 OpenClaw 插件） |

### 4.2 多渠道桥

| 项目 | 说明 |
|------|------|
| **ominiverdi/opencode-chat-bridge** | ACP 兼容 agent → Matrix/Slack/Mattermost/WhatsApp/Discord/Telegram/Web，permission-based security |
| **yhlooo/dsh-bridges** | DSH → CodeBuddy/Codex/OpenCode/Claude Code 桥接（DSH 生态内） |
| AWS 博客 | ACP Bridge 让 Kiro/Claude Code 响应 IM 消息（异步 AI 工作流范式） |

→ **"微信/多渠道 → ACP 兼容 agent"已是成熟开源模式**，需求②不缺少 IM 侧实现。

## 5. 调研发现：家庭现有资产（OpenClaw）

**重大发现**：家庭 OpenClaw（招财，192.168.1.13）已具备 IM 接入面：

| 资产 | 状态 |
|------|------|
| **微信通道**（openclaw-weixin v2.1.9） | ✅ 已启用，2 个机器人账户，long-poll 模式 |
| **openclaw-acp 网关**（端口 18792） | ✅ 存在（ACP 插件网关，文件配置 `~/.openclaw/gateway.json`） |
| Feishu 通道 | ❌ 不可用（delivery queue 积压 "account not configured"） |
| Orbit 集成 | ✅ Guardian 任务调度 |

OpenClaw 官方支持 **ACP agents**（docs2.openclaw.ai/tools/acp-agents）：OpenClaw 可作为 **ACP client** 连接外部 ACP server（Claude Code/Codex 等），并**绑定到 IM 渠道**（微信/feishu/qqbot，PR #43170 扩展 persistent bindings）。

→ **家庭已有"微信通道 + ACP 网关"= IM 接入面现成**，需求②最短路线的关键拼图。

## 6. ACP 协议本体

- 官方站：agentclientprotocol.com（v1：initialize/session/new/session/prompt/session/update/session/cancel/session/request_permission；v2 draft 进行中）
- 生态：opencode（原生 ACP mode）、gemini-cli（ACP mode）、Cursor CLI（acp）、Zed、Claude Code 均支持
- **ACP 是 client-server 模式**：agent 侧起 ACP server（stdio 或 socket），工具/IDE/IM 桥作 client

## 7. 方案空间（Neat 范围层→方案层）

### 共同底座：知识 CCC → ACP server

无论①还是②，第一步是把知识 CCC 暴露为 **ACP server**。三条路线：

| 路线 | 做法 | 优点 | 缺点 |
|------|------|------|------|
| **A. 官方组合** | 复用 `examples/acp-agent` 模式：独立进程 + persona 定制（知识问答约束）+ 知识 CCC 目录作 cwd/workspace | 零开发、官方契约、sandbox 组合现成 | 本地 rc.8 无 dsh-acp 包（需等发布或源码构建）；fresh-session 语义需适配"知识问答"场景 |
| **B. 第三方插件** | npm 装 `@openma/deepseek-harness-acp` 或 `@dumbo-ai/dsh-acp` | 立即可用、适配 rc | 第三方维护；约束定制受其 API 限制 |
| **C. 自研（serenity-plugin 内）** | 在 dsh-serenity-plugin 增加知识问答 ACP server（复用 gateway 认证/安全 + 知识 CCC 路径解析 + persona 定制 + 工具面裁剪） | 完全贴合宁静号（安全体系复用、知识域约束内置、与 F1 网关同源管理） | 开发量大；需对齐 ACP v1 契约 + 测试 |

### 场景①：单独部署问答助手（带 Loop 约束）

"Loop 约束"解读：问答助手的**行为约束**——知识域限定、只读工具面（read/grep/知识查询）、输出风格、自主循环到完成（与 handyman 的 stop-token 语义同源）。

部署形态选项：
- **A1**：独立 dsh 进程 + 官方/第三方 ACP server（fresh agent per session，persona 定制知识问答）
- **A2**：headless/jsonrpc 模式封装（无 ACP，CLI/SDK 调用）——简单但无法被 IM 复用
- **A3**：复用现有 dsh web 实例多 profile（`dsh --profile qa-xxx`）——与 F1 网关并存

推荐方向：**ACP server 形态**（A1）——同一底座同时服务场景②，避免重复建设。

### 场景②：IM 知识机器人（类 ACP 协议）

两条 IM 接入路线：

| 路线 | 拓扑 | 优点 | 缺点 |
|------|------|------|------|
| **B1. 独立桥** | DSH ACP server ← wechat-acp/opencode-chat-bridge（client）→ 微信/多渠道 | 通用、不依赖 OpenClaw、可同时接多渠道 | 需部署/维护桥进程；多一层安全面 |
| **B2. 复用 OpenClaw** | DSH ACP server ← OpenClaw（ACP client，绑定微信通道） | 家庭资产最大化复用（微信通道已工作、acp 网关已有、统一管理面） | 依赖 OpenClaw ACP agents 功能的成熟度与版本；绑定配置需在 OpenClaw 侧做 |

推荐方向：**B2 优先**（家庭已有微信通道 + ACP 网关），B1 作 fallback（若 OpenClaw ACP 绑定不成熟）。

## 8. 待用户拍板的分叉点

1. **问答助手部署形态**：独立进程（推荐）vs 复用 web 实例多 profile？
2. **ACP server 来源**：官方组合（路线 A）/ 第三方插件（路线 B）/ 自研进 serenity-plugin（路线 C）？——涉及开发量 vs 贴合度权衡
3. **IM 通道优先级**：微信（家庭已有）优先？Telegram？飞书（已配但不可用，需修）？
4. **IM 接入路线**：B2 复用 OpenClaw（推荐）vs B1 独立桥？
5. **知识域范围**：问答助手是"全知识 CCC"还是"特定领域子集"？（用户原话"在一个特定方面具有良好的智能表现"——可能是领域 CCC 的独立实例）
6. **安全边界**：IM 机器人内网/公网？外部用户权限模型（白名单/群组限制）？
7. **与 serenity-plugin 关系**：自研路线 C 是否纳入 dsh-serenity-plugin（成为 F4 功能组）？还是独立仓库？

## 9. 参考链接

- DSH 官方 ACP：packages/acp + examples/acp-agent（dsh-harness-public @ b150a551）
- [ACP 协议官方](https://agentclientprotocol.com)
- [formulahendry/wechat-acp](https://github.com/formulahendry/wechat-acp)
- [gangtiser/wechat-acp-codex](https://github.com/gangtiser/wechat-acp-codex)
- [ominiverdi/opencode-chat-bridge](https://github.com/ominiverdi/opencode-chat-bridge)
- [OpenClaw ACP agents](https://docs2.openclaw.ai/tools/acp-agents)
- [@openma/deepseek-harness-acp](https://github.com/openma-ai/deepseek-harness-acp)
- [@dumbo-ai/dsh-acp](https://github.com/dushaobindoudou/dsh-acp)
- [yhlooo/dsh-bridges](https://github.com/yhlooo/dsh-bridges)
- [wong2/weixin-agent-sdk](https://github.com/wong2/weixin-agent-sdk)
