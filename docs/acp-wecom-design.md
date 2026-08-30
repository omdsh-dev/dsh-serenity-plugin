# ACP 能力 + 企业微信机器人对接 — 初版方案（F4c，S142）

> 状态：**方案修订中（2026-08-29，S142 用户碰壁——自建应用需可信域名核对 IP；转向智能机器人长连接调研）**
> 性质：dsh-serenity-plugin Skiff（F4）第三期——ACP 协议层 + IM 对接
> 前置调研：`docs/knowledge-ccc-release-research.md`（ACP 生态/IM 桥/OpenClaw 资产）、`docs/skiff-design.md`（F4 总设计，F4c 规划）
> 关联：`docs/skiff-followup-design.md`（会话追问延续，v1.25.10）

---

## 0. 需求（用户 2026-08-29）

1. **提供 ACP 能力**：指定 **认知容器 + 角色 + 会话（可选）** 进行对话——程序化/机器人调用，非 Web UI
2. **以企业微信机器人为对接例子**：先出初版方案审核；用户提示「企业微信机器人是回调设计」

## 0.1 用户拍板（2026-08-29 第一轮）

1. **机器人范围：先支持个人（私聊），先不支持群聊**——会话映射仅 FromUserName，ChatId 群聊留待后续
2. **测试条件具备**：用户有企业微信管理员权限可测试
3. **公网暴露先不关心**：到时走隧道暴露（暴露方案部署方自选）——本机实现先监听本地，联调时隧道暴露

## 0.2 方案转向（2026-08-29 第二轮，用户碰壁）

**用户碰壁**：自建应用需要**可信域名核对 IP**（回调域名验证），暂时搞不定（未来可）；**群机器人可以建** → 要求调研群机器人/智能机器人路线。

**调研结论（转向）**：自建应用回调路线搁置；**智能机器人长连接模式**是答案——
- **智能机器人长连接 = WebSocket 主动连接**（我们的服务器连企微，非企微回调我们）→ **无需公网域名/可信 IP**（社区实证「无域名版」全配置：[华为云博客](https://bbs.huaweicloud.com/blogs/476466)）
- **企微官方 SDK**：`WecomTeam/wecom-aibot-python-sdk`（[GitHub](https://github.com/WecomTeam/wecom-aibot-python-sdk)，WebSocket 长连接：消息收发/流式回复/模板卡片/事件回调/文件下载解密）
- **OpenClaw 官方帮助**：「[OpenClaw接入企业微信智能机器人](https://open.work.weixin.qq.com/help2/pc/cat?doc_id=21657)」+ 社区插件 `@dingxiang-me/openclaw-wechat`（「启用企业微信智能机器人长连接」）——**成熟先例**
- **用户可建**：群机器人/智能机器人创建无需可信域名（与自建应用门槛不同）
- **注意限制**：智能机器人社区反馈「URL 回调模式只能收到创建人消息」「@机器人才回调」（[1](https://developer.work.weixin.qq.com/community/question/detail?content_id=16844395806067284329)、[2](https://developer.work.weixin.qq.com/community/question/detail?content_id=16848595695307557830)）——**长连接模式是否同限需实测确认**

**待用户确认**：智能机器人长连接模式的个人/群聊支持范围 + 创建人限制（实测轮确认）；dsp 侧接入用 **WebSocket 客户端**（node:ws，零依赖可选）连接企微长连接通道。

---

## 1. 调研结论（企业微信）

### 1.1 两种机器人形态（关键区分）

| 形态 | 接收消息 | 主动推送 | 说明 |
|------|---------|---------|------|
| **自建应用 / 智能机器人** | ✅ **回调设计**（GET 验 URL + POST 加密消息） | ✅ message/send API | 用户所指形态 |
| **群机器人 webhook** | ❌ **不支持**（官方社区确认"群聊机器人不支持消息回调"） | ✅ webhook 仅推送 | 只能发不能收 |

→ **选自建应用（回调设计）**。

### 1.2 回调机制（自建应用）

```
企业微信服务器 ──▶ 我们的回调 URL
  ① GET  验 URL：msg_signature/timestamp/nonce/echostr → 解密 echostr 原样返回（URL 验证通过）
  ② POST 收消息：加密 XML（AES-256-CBC，EncodingAESKey，msg_signature 验签）→ 解密得明文消息
                （MsgType: text/image/event 等）
  ③ 回复：
     - 被动回复：5 秒内返回加密 XML（同步；agent 通常超时 → 不适用）
     - 主动推送：access_token（corpid+secret）→ POST /cgi-bin/message/send（text/markdown/...）
```

### 1.3 关键事实

- 回调 URL 需**公网可达**（或经 F1 网关/隧道暴露）——暴露方案由部署方自选（隧道/反向代理等），需有现成通道
- 消息加解密：企业微信专用方案（AES + 签名），有官方 SDK 与社区实现（如 `@sunnoy/wecom`、picoclaw wecom-app-configuration 文档）
- 官方文档：[接收消息](https://developer.work.weixin.qq.com/document/path/100719)、[回调和回复的加解密方案](https://developer.work.weixin.qq.com/document/path/101033)、[被动回复消息](https://developer.work.weixin.qq.com/document/path/101031)、[发送应用消息](https://developer.work.weixin.qq.com/document/path/90236)

---

## 2. 架构总览

```
┌────────────────────────────────────────────────────────────────┐
│                    dsh-serenity-plugin (dsp)                     │
│                                                                  │
│  ┌─ F4c-1: ACP server（stdio JSON-RPC，新增）─────────────────┐  │
│  │  initialize / session/new / prompt / cancel / list /        │  │
│  │  resume / close / set_config_option / request_permission    │  │
│  │  session/new 扩展：{ ccc, role, sessionId? }                │  │
│  └──────────────┬──────────────────────────────────────────────┘  │
│                 │ 复用                                          │
│  ┌─ skiff 会话核心（既有）────────────────────────────────────┐  │
│  │  createSkiffAgent(root, role) / askSkiff / getSkiffAgent   │  │
│  │  （双白名单 + 角色提示词 + 会话延续）                        │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌─ F4c-2: 企业微信桥（HTTP 回调端点，新增）──────────────────┐  │
│  │  GET/POST 回调（验签 + AES 解密）→ ACP 调用 → 主动推送回复  │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
        ▲ 回调（验 URL/收消息）                 ▲ 主动推送（message/send）
        │                                      │
  企业微信服务器 ◀─────── 企业微信（自建应用）
```

---

## 3. F4c-1：ACP server（dsp 内，复用 skiff 会话核心）

### 3.1 与官方 dsh-acp 的关系

| 面 | 官方 `@deepseek-ai/dsh-acp`（--profile acp） | 本方案（dsp 内） |
|----|--------------------------------------------|-----------------|
| 会话 | fresh agent + MCP，**不绑定 skiff 角色机制** | 复用 **skiff**（CCC 定义角色：双白名单/角色提示词/会话延续） |
| ccc/role | 无此概念（单 workspace） | **原生支持**：session/new 指定 ccc + role + sessionId |
| 协议面 | ACP v1 标准（含 list/resume/close/set_config_option） | 对齐 ACP v1 标准（参考官方演进） |

→ **自研进 dsp**（用户 2026-08-28 已拍板 ACP 纳入 F4）；官方 dsh-acp 的协议面作为参考（对齐方法集），实现复用 skiff 核心。

### 3.2 方法面（对齐 ACP v1 + 官方演进）

| 方法 | 语义 | Skiff 映射 |
|------|------|-----------|
| `initialize` | 协议握手（v1；capabilities 声明） | 声明支持 ccc/role/sessionId 扩展 |
| `authenticate` | no-op（ACP v1 无认证；部署面见 §5） | — |
| `session/new` | **{ ccc, role, sessionId? }** → 创建/延续 skiff 会话 | 无 sessionId → createSkiffAgent；有 → getSkiffAgent 复用（进程内；跨进程 resume 留待后续） |
| `session/list` | 列出可恢复会话（参考官方：newest-first + cwd 过滤） | skiffAgents/registry 快照 |
| `session/resume` | 恢复持久会话（官方：persistence.prepare） | 首版不做（对齐 v1.25.10 决策：仅进程内延续） |
| `session/prompt` | 文本 → 答案（committed，非流式） | askSkiff(agent, question, 0)（全量轨迹可选返回） |
| `session/cancel` | 中断当前 prompt | agent.interrupt（DSH 能力） |
| `session/close` | 关闭会话（释放 agent + 注册表清理） | unregisterSkiffSession |
| `session/set_config_option` | 热更 model（官方演进） | 首版可选（角色 model 固定，更新走 CCC 配置） |
| `session/update` | committed 消息/thoughts/tool 生命周期（官方演进） | 首版简化：prompt 返回 answer + trajectory（结构化），update 流式留待后续 |
| `session/request_permission` | 一次性 allow/reject（G9：白名单即授权 → 恒 allow） | 恒 allow（复用既有决策） |

### 3.3 传输（实现修正，R↓）

- **协议处理器与传输解耦**：`acp-core`（会话管理层 + 方法处理器，传输无关）——企业微信桥同进程**直调处理器函数**（不经网络）；`acp-http`（HTTP JSON-RPC 端点）作为可测/外部程序化面
- **首版 = HTTP JSON-RPC**（插件自有端口，settings acpEnabled+acpPort 默认关，仿 skiff 调试服务）——技术约束：dsp 是 dsh web 进程内插件，**stdio server 需独占进程 stdout**（污染 dsh 主进程日志）→ stdio 形态需独立进程装配（官方 `--profile acp` 模式），留待后续
- **stdio（后续）**：独立进程部署时复用同一 acp-core 处理器（官方 NDJSON JSON-RPC over stdio 帧格式已确认：每行一帧 JSON，stdout 只承载协议帧）
- **调试页 /ask 既有**：HTTP 面保留（人工测试）；ACP 为程序化面（同会话核心，双面不返工）

### 3.4 会话延续

- 复用 v1.25.10 机制：`session/new` 带 `sessionId` → `getSkiffAgent` 命中 → 续问（同角色+同 ccc 校验）；未命中 → 错误提示（进程内延续，与调试页一致）
- 跨进程 resume：留待后续（官方 `ctx.agents.resume` 路径已调研可行）

---

## 4. F4c-2：企业微信桥（回调端点）

### 4.1 端点

| 端点 | 方法 | 用途 |
|------|------|------|
| `/wecom/callback` | GET | 验 URL（echostr 解密返回；企业微信后台保存回调地址时触发） |
| `/wecom/callback` | POST | 收消息（验签 + AES 解密 → 明文）→ 驱动 ACP 会话 → 主动推送回复 |

### 4.2 消息流

```
POST 回调（加密 XML）
  → 验签（msg_signature = SHA1(token, timestamp, nonce, 密文)）
  → AES 解密（EncodingAESKey, corpid）→ 明文 XML
  → 解析：MsgType=text → Content；FromUserName（发送者）/ ChatId（群聊）
  → 路由：ccc + role（配置映射：企业微信发送者/群 → (ccc, role)）+
          sessionId（发送者/群 → skiff 会话绑定，可选）
  → ACP session/prompt（内部直调，不经 stdio 也可）
  → 答案 → access_token → POST message/send（text；长答案分片/摘要）
```

### 4.3 回复策略（5 秒窗口）

- **被动回复不适用**（agent 回答通常 >5s）→ **一律主动推送**（message/send API）
- 回调 POST 先返回 200 空（或「收到，思考中」占位），agent 完成后主动推送
- 需要 access_token（corpid+secret+agentid，缓存 token 有效期 7200s）

### 4.4 会话映射（企业微信 ↔ skiff 会话）

| 企业微信侧 | skiff 侧 | 说明 |
|-----------|---------|------|
| FromUserName（个人） | `skiff-<role>-<userid>`（进程内） | **首版支持**——每人一个会话，追问延续 |
| ChatId（群聊） | `skiff-<role>-<chatid>` | **留待后续**（用户拍板：先不支持群聊） |
| 可选：用户显式指令 | 新会话（如「新对话」命令） | 复用调试页「新对话」语义 |

### 4.5 配置（plugin 级，dsp 全局文件；凭据归 localstore）

```jsonc
// ~/.dsh/serenity-hooks.json 新增 wecom 段（plugin 级配置，归 plugin——用户既定原则）
{
  "wecom": {
    "enabled": false,                  // 默认关（实验性，人工开启）
    "corpidRef": "WECOM_CORPID",       // localstore 凭据引用（corpid 不入配置）
    "secretRef": "WECOM_SECRET",       // localstore 凭据引用（应用 secret）
    "agentid": 1000002,
    "tokenRef": "WECOM_TOKEN",         // localstore 凭据引用（回调 token 验签）
    "aesKeyRef": "WECOM_AES_KEY",      // localstore 凭据引用（43 字符 EncodingAESKey）
    "route": {                         // 发送者 → (ccc, role) 映射（首版仅个人）
      "user:zhangsan": { "ccc": "/home/yh/home/home-serenity", "role": "qa" }
      // "chat:GROUPID1": ...  ← 群聊留待后续（用户拍板：先不支持群聊）
    },
    "callbackPath": "/wecom/callback"  // 回调路径（联调时经隧道/反向代理暴露）
  }
}
```

### 4.6 部署面（联调时）

- 企业微信后台：创建自建应用 → 配置**可信域名/回调 URL**（`https://<tunnel-domain>/wecom/callback`）→ 获取 corpid/secret/agentid/token/EncodingAESKey
- 本机：经隧道/反向代理暴露回调 URL（暴露方案自选；用户拍板：到时走隧道）
- 测试：企业微信后台「接收消息」测试工具（模拟消息 → 回调验证）

### 4.7 企微配置踩坑（社区高频，调研实证 2026-08-29）

| # | 坑 | 解法 |
|---|----|------|
| 1 | **「用户发送的普通消息」选项灰色无法勾选**（社区大量提问） | **先配置好回调 URL 并验证通过**后选项才解锁；仍灰色检查应用状态/类型 |
| 2 | **可见范围**：成员打开应用发消息的前提 | 应用设置「可见范围」包含测试成员；管理员把自己加进范围即可 |
| 3 | **智能机器人形态 ≠ 自建应用**：智能机器人（URL 回调）只能收到创建人消息、可见范围外成员无法聊天 | **用自建应用**（本方案已选），不受此限制 |
| 4 | **主动推送可信 IP**：message/send 若企业配了可信 IP 白名单，服务器出口 IP 需在名单内 | 走 cloudflare tunnel 时确认出站 IP（隧道节点）；或企业侧不配可信 IP |
| 5 | **回调 URL 需公网可达**：后台保存回调地址时 GET 验证 URL | tunnel 暴露 `/wecom/callback` 后配置 |
| 6 | 被动回复 5s 窗口对 agent 不适用 | 一律主动推送（message/send），回调先回 200 占位（§4.3 已定） |

---

## 5. 安全面（复用 F1 网关经验 + 用户原则）

| 面 | 措施 |
|----|------|
| 回调鉴权 | 企业微信签名验证（token+timestamp+nonce+密文 SHA1）——企业微信自身机制，天然防伪造 |
| 加解密 | AES-256-CBC（EncodingAESKey）——企业微信标准方案 |
| 凭据存储 | corpid/secret/encodingAESKey **不入配置文件**（用户既定原则：plugin 配置归 plugin，但**密钥归 localstore/.env**——参考 F1 账号密码审计经验） |
| 公网暴露 | 经 F1 双端口网关（已有登录）或隧道/反向代理暴露回调 URL——**不裸开端口** |
| 权限 | G9 白名单即授权（恒 allow）；企业微信侧可限制「谁可@机器人」（可见范围/群成员） |
| 审计 | 回调消息日志（登录成败日志模式复用） |

---

## 6. 分期（F4c）

> 注：F4c-2 原「自建应用回调」路线因**可信域名核对 IP** 碰壁（用户暂时搞不定）→ **转向智能机器人长连接**（WebSocket 主动连接，无需公网域名）。F4c-2 修订为长连接客户端；自建应用回调留待未来（用户：未来可以）。

| 阶段 | 版本 | 内容 | 估量 |
|------|------|------|------|
| **F4c-1** | v1.26.0 | **ACP server**（`acp-core` 会话管理层 + 方法处理器传输无关 + `acp-http` HTTP JSON-RPC 端点（settings acpEnabled/acpPort 默认关）：initialize/session/new(ccc+role+sessionId)/prompt/cancel/list/close/request_permission；复用 skiff 核心 + 会话延续）+ 测试 + skiff_admin guide 增 ACP 节 | 中（~500 行 + 测试） |
| **F4c-2** | v1.26.1 | **企业微信智能机器人长连接桥**（WebSocket 客户端连接企微长连接通道：收发消息/流式回复/事件；个人会话映射；配置段 + localstore 凭据引用；同进程直调 acp-core 处理器）+ 测试 | 中（~600 行 + 测试） |
| **F4c-3** | 实测 | 企业微信智能机器人真实联调（建机器人 → 长连接 → 私聊消息 → 机器人回复；实测创建人限制） | 联调轮 |

---

## 7. 决策记录（2026-08-29 用户拍板，R↓）

| # | 决策 | 裁决 |
|---|------|------|
| 1 | 机器人范围 | **先支持个人（私聊），先不支持群聊**——ChatId 映射留待后续 |
| 2 | 测试条件 | 用户有企业微信管理员权限，可真实测试 |
| 3 | 公网暴露 | 先不关心；到时走隧道暴露（暴露方案部署方自选） |
| 4 | ACP 传输 | **stdio 单形态**（推荐默认采纳）——对齐 ACP 生态（OpenClaw/桥）；企业微信桥同进程内直调 ACP 函数（不经 stdio） |
| 5 | session/update | **首版 committed answer + trajectory 结构化**（推荐默认采纳）——update 流式留待后续 |
| 6 | 会话映射粒度 | **按发送者自动绑定**（推荐默认采纳）——个人 `skiff-<role>-<userid>`；显式「新对话」指令 |
| 7 | resume 纳入 | **首版仅进程内延续**（推荐默认采纳，与 v1.25.10 一致）——跨进程 resume 留待后续 |
| 8 | 凭据存放 | **localstore（家庭惯例）**（推荐默认采纳）——corpid/secret/encodingAESKey 归 localstore，配置只存引用 |
| 9 | **企微形态（第二轮碰壁转向）** | 自建应用（回调）需**可信域名核对 IP**，用户暂时搞不定 → **转向智能机器人长连接**（WebSocket 主动连接，无需公网域名/可信 IP）；自建应用路线留待未来 |

> 未单独拍板的项按方案推荐值默认采纳（标注"推荐默认采纳"）；如后续有异议可随时调整。

---

## 8. 参考

- [ACP 协议官方](https://agentclientprotocol.com)（v1 标准 + v2 draft）
- DSH 官方 `@deepseek-ai/dsh-acp`（packages/acp + examples/acp-agent，dsh-harness-public @ cd5ef81481）——协议面参考
- 企业微信官方文档：[接收消息](https://developer.work.weixin.qq.com/document/path/100719)、[回调和回复的加解密方案](https://developer.work.weixin.qq.com/document/path/101033)、[被动回复消息](https://developer.work.weixin.qq.com/document/path/101031)、[发送应用消息](https://developer.work.weixin.qq.com/document/path/90236)、[智能机器人长连接（官方文档 path/101463）](https://developer.work.weixin.qq.com/document/path/101463)、[OpenClaw接入企业微信智能机器人（企微官方帮助）](https://open.work.weixin.qq.com/help2/pc/cat?doc_id=21657)、[群聊机器人不支持消息回调（社区确认）](https://developer.work.weixin.qq.com/community/question/detail?content_id=16709787612948516025)
- **智能机器人长连接资产**：[企微官方智能机器人 Python SDK（WecomTeam/wecom-aibot-python-sdk）](https://github.com/WecomTeam/wecom-aibot-python-sdk)、[企业微信长连接+LangBot+Dify 全配置（无域名版，华为云博客）](https://bbs.huaweicloud.com/blogs/476466)、[@dingxiang-me/openclaw-wechat（企业微信智能机器人长连接）](https://www.npmjs.com/package/@dingxiang-me/openclaw-wechat)、[openclaw-wecom-websocket](https://www.npmjs.com/package/openclaw-wecom-websocket)、[LangBot 企业微信智能机器人接入](https://docs.langbot.app/zh/usage/platforms/wecom/wecombot)
- 社区参考：[picoclaw wecom-app-configuration](https://github.com/sipeed/picoclaw/blob/c57a9c14e7ae6e1119c6b35a5a8e639be08ffbb4/docs/wecom-app-configuration.md)、[@sunnoy/wecom](https://socket.dev/npm/package/%40sunnoy%2Fwecom)、[花骨朵：企业微信外部群机器人接入 AI 实战](https://cloud.tencent.cn/developer/article/2706699)
- 既有资产：`docs/knowledge-ccc-release-research.md`（ACP 生态/OpenClaw 微信通道/openclaw-acp 网关）、F1 网关（双端口+登录+CSRF 加固）、隧道暴露通道
