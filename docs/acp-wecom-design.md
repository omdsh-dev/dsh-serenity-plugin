# ACP 能力 + 企业微信机器人对接 — 初版方案（F4c，S142）

> 状态：**方案定稿（2026-08-29，S142 用户拍板）**
> 性质：dsh-serenity-plugin Skiff（F4）第三期——ACP 协议层 + IM 对接
> 前置调研：`docs/knowledge-ccc-release-research.md`（ACP 生态/IM 桥/OpenClaw 资产）、`docs/skiff-design.md`（F4 总设计，F4c 规划）
> 关联：`docs/skiff-followup-design.md`（会话追问延续，v1.25.10）

---

## 0. 需求（用户 2026-08-29）

1. **提供 ACP 能力**：指定 **认知容器 + 角色 + 会话（可选）** 进行对话——程序化/机器人调用，非 Web UI
2. **以企业微信机器人为对接例子**：先出初版方案审核；用户提示「企业微信机器人是回调设计」

## 0.1 用户拍板（2026-08-29）

1. **机器人范围：先支持个人（私聊），先不支持群聊**——会话映射仅 FromUserName，ChatId 群聊留待后续
2. **测试条件具备**：用户有企业微信管理员权限可测试
3. **公网暴露先不关心**：到时走 **cloudflare tunnel**（home-tunnel 既有资产）——本机实现先监听本地，联调时隧道暴露

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

- 回调 URL 需**公网可达**（或经 F1 网关/Tunnel 暴露）——家庭已有 home-tunnel / Cloudflare Tunnel 资产
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

### 3.3 传输

- **stdio（主）**：JSON-RPC over stdio（对齐官方 acp 与 ACP 生态）——OpenClaw ACP client / 企业微信桥（spawn 模式）
- **调试页 /ask 既有**：HTTP 面保留（人工测试），ACP 为程序化面（同会话核心，双面不返工）

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
    "callbackPath": "/wecom/callback"  // 回调路径（联调时经 home-tunnel / Cloudflare Tunnel 暴露）
  }
}
```

### 4.6 部署面（联调时）

- 企业微信后台：创建自建应用 → 配置**可信域名/回调 URL**（`https://<tunnel-domain>/wecom/callback`）→ 获取 corpid/secret/agentid/token/EncodingAESKey
- 本机：`home-tunnel`（Cloudflare Tunnel MSM）暴露回调 URL（用户拍板：到时走 cloudflare tunnel）
- 测试：企业微信后台「接收消息」测试工具（模拟消息 → 回调验证）

---

## 5. 安全面（复用 F1 网关经验 + 用户原则）

| 面 | 措施 |
|----|------|
| 回调鉴权 | 企业微信签名验证（token+timestamp+nonce+密文 SHA1）——企业微信自身机制，天然防伪造 |
| 加解密 | AES-256-CBC（EncodingAESKey）——企业微信标准方案 |
| 凭据存储 | corpid/secret/encodingAESKey **不入配置文件**（用户既定原则：plugin 配置归 plugin，但**密钥归 localstore/.env**——参考 F1 账号密码审计经验） |
| 公网暴露 | 经 F1 双端口网关（已有登录）或 home-tunnel（Cloudflare Tunnel）暴露回调 URL——**不裸开端口** |
| 权限 | G9 白名单即授权（恒 allow）；企业微信侧可限制「谁可@机器人」（可见范围/群成员） |
| 审计 | 回调消息日志（登录成败日志模式复用） |

---

## 6. 分期（F4c）

| 阶段 | 版本 | 内容 | 估量 |
|------|------|------|------|
| **F4c-1** | v1.26.0 | **ACP server**（stdio JSON-RPC：initialize/session/new(ccc+role+sessionId)/prompt/cancel/list/close/request_permission；复用 skiff 核心 + 会话延续）+ 测试 + skiff_admin guide 增 ACP 节 | 中（~500 行 + 测试） |
| **F4c-2** | v1.26.1 | **企业微信桥**（回调端点 GET 验 URL + POST 解密 + 主动推送 message/send + **个人会话映射**（群聊留待后续）+ 配置段 + localstore 凭据引用）+ 测试 | 中（~600 行 + 测试） |
| **F4c-3** | 实测 | 企业微信真实应用联调（配应用 → 回调 URL 经 home-tunnel → 私聊消息 → 机器人回复） | 联调轮 |

---

## 7. 决策记录（2026-08-29 用户拍板，R↓）

| # | 决策 | 裁决 |
|---|------|------|
| 1 | 机器人范围 | **先支持个人（私聊），先不支持群聊**——ChatId 映射留待后续 |
| 2 | 测试条件 | 用户有企业微信管理员权限，可真实测试 |
| 3 | 公网暴露 | 先不关心；到时走 **cloudflare tunnel**（home-tunnel 既有资产） |
| 4 | ACP 传输 | **stdio 单形态**（推荐默认采纳）——对齐 ACP 生态（OpenClaw/桥）；企业微信桥同进程内直调 ACP 函数（不经 stdio） |
| 5 | session/update | **首版 committed answer + trajectory 结构化**（推荐默认采纳）——update 流式留待后续 |
| 6 | 会话映射粒度 | **按发送者自动绑定**（推荐默认采纳）——个人 `skiff-<role>-<userid>`；显式「新对话」指令 |
| 7 | resume 纳入 | **首版仅进程内延续**（推荐默认采纳，与 v1.25.10 一致）——跨进程 resume 留待后续 |
| 8 | 凭据存放 | **localstore（家庭惯例）**（推荐默认采纳）——corpid/secret/encodingAESKey 归 localstore，配置只存引用 |

> 未单独拍板的项按方案推荐值默认采纳（标注"推荐默认采纳"）；如后续有异议可随时调整。

---

## 8. 参考

- [ACP 协议官方](https://agentclientprotocol.com)（v1 标准 + v2 draft）
- DSH 官方 `@deepseek-ai/dsh-acp`（packages/acp + examples/acp-agent，dsh-harness-public @ cd5ef81481）——协议面参考
- 企业微信官方文档：[接收消息](https://developer.work.weixin.qq.com/document/path/100719)、[回调和回复的加解密方案](https://developer.work.weixin.qq.com/document/path/101033)、[被动回复消息](https://developer.work.weixin.qq.com/document/path/101031)、[发送应用消息](https://developer.work.weixin.qq.com/document/path/90236)、[企业微信的群聊机器人支持消息回调吗（社区确认不支持）](https://developer.work.weixin.qq.com/community/question/detail?content_id=16709787612948516025)
- 社区参考：[picoclaw wecom-app-configuration](https://github.com/sipeed/picoclaw/blob/c57a9c14e7ae6e1119c6b35a5a8e639be08ffbb4/docs/wecom-app-configuration.md)、[@sunnoy/wecom](https://socket.dev/npm/package/%40sunnoy%2Fwecom)、[花骨朵：企业微信外部群机器人接入 AI 实战](https://cloud.tencent.cn/developer/article/2706699)
- 既有资产：`docs/knowledge-ccc-release-research.md`（ACP 生态/OpenClaw 微信通道/openclaw-acp 网关）、F1 网关（双端口+登录+CSRF 加固）、home-tunnel（Cloudflare Tunnel MSM）
