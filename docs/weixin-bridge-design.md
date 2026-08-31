# dsp 微信桥（weixin-bridge）— 方案设计（F4c-3，S142）

> 状态：**方案草案 v0.1（2026-08-31，待用户审核）** — Neat 协议：需求层 → 范围层 → 方案层 → 接口层 → 实现层，未对齐不进实现。
> 前置：`docs/weixin-bot-api.md`（iLink 协议全解 + 裸调实证）、`docs/acp-wecom-design.md`（F4c 企微路线）。
> 需求来源：用户 "dsp 能否接入微信的扫码协议，考虑多用户接入招财 role"——skiff 强化后支持微信扫码接入 → **代替 openclaw（招财平台）**。

---

## 1. 需求层

| # | 需求 | 用户原话/来源 | 状态 |
|---|------|--------------|------|
| R1 | dsp 支持微信扫码接入（个人微信 iLink Bot API） | "dsp 能否接入微信的扫码协议" | 协议已验证可行 |
| R2 | 多用户支持（多个微信用户与 bot 对话，各自独立会话） | "考虑多用户接入招财 role" | 协议天然支持（from_user_id 区分） |
| R3 | 接入 skiff 角色体系（zhaocai role 已配置） | S149 决策：Skiff 替代 OpenClaw | zhaocai role 已生效 |
| R4 | 远期：代替 openclaw 平台 | S149 战略目标 | 本方案是其中一块 |

**边界（不在本方案）**：
- 不做群聊（首版仅私聊；群聊 context/语义另议）
- 不做媒体收发首版（文本优先，图片/语音/文件后置——见 §5 分期）
- 不做企微智能机器人（F4c-2 调研记录保留，合并评估见 §8）

## 2. 范围层

**做**：dsp 新增 `weixin-bridge` 服务——多账号 iLink 轮询 + 消息路由到 acp-core 直调 → skiff role 会话。
**不做**：不新增 HTTP 端点（微信是出站长轮询，不需要公网入口——相对企微回调路线的关键优势）；不新建协议。

**组件划分**（对齐现有 services 模块风格）：

| 模块 | 职责 | 类比 |
|------|------|------|
| `src/weixin-api.ts` | iLink 纯 fetch 客户端（qrcode/status/getupdates/sendmessage/sendtyping/getconfig/getuploadurl/CDN） | 传输层，零 LLM |
| `src/weixin-bridge.ts` | 多账号轮询循环 + 消息分发（from_user_id → sessionId 映射）+ 回复回写 | 类比 gateway 装配 |
| `src/weixin-route.ts` | 会话映射（微信用户 ↔ skiff 会话）+ 配置读取（plugin 全局） | 类比 skiff-registry |
| `src/tools/weixin-admin.ts` | 管理工具（第 14 工具？）：login（出码+轮询状态）/ accounts / send（测试）/ status | 类比 skiff-admin |

**配置归属（D5 归属二分）**：账号/token/baseUrl/userId = **plugin 全局** `~/.dsh/serenity-hooks.json`（`weixin.accounts[]`，0600）；路由映射（微信用户 → (ccc, role)）= **CCC 侧** `.opencode/serenity.json`（`weixin.routes`）。与 skiff 角色配置分层一致。

## 3. 方案层

### 3.1 架构总览

```
微信 App ──(用户扫码)──▶ 腾讯 iLink API (ilinkai.weixin.qq.com)
                              ▲                    │
                   getupdates │ (35s 长轮询)       │ sendmessage (回带 context_token)
                              │                    ▼
                        dsp weixin-bridge (插件进程内)
                              │  多账号循环（每账号独立轮询 + 独立游标）
                              ▼
                    from_user_id → sessionId 映射（weixin-route）
                              │
                              ▼
              AcpServer.handle('session/new' + 'session/prompt')  ← 同进程直调
                              │
                              ▼
                    skiff-core → zhaocai role agent
```

**关键设计决策（候选，待用户拍板）**：

| # | 决策 | 方案 | 备选 |
|---|------|------|------|
| W1 | 传输形态 | **出站长轮询**（bot 主动 GET getupdates，35s hold）——无需公网入口/域名/回调 | 企微回调（需公网 + 可信域名，用户已碰壁） |
| W2 | 会话延续 | 微信用户 → 固定 sessionId `skiff-weixin-<md5(userid)>`——同一用户长期同一会话（记忆延续），多用户天然隔离 | 每消息新会话（无记忆，否决） |
| W3 | 对话状态 | message_state: NEW → 收到 → prompt → GENERATING（正在输入）→ FINISH 回写 | 直接 FINISH（无打字提示，体验差） |
| W4 | 路由目标 | 微信用户 → (ccc, role) 映射；默认 `zhaocai` role（用户已配） | 每用户可配不同 role |
| W5 | 启停 | 设置面板开关（默认关，零资源占用——实验功能默认关原则）+ 扫码登录动作 | 随插件自动启动（否决） |
| W6 | 回复格式 | markdown → 纯文本转换（微信不支持 md） | 直接发 md（微信端乱码，否决） |

### 3.2 多账号模型

- 账号 id 自增：`wechat-1, wechat-2, ...`（对齐 openclaw-weixin auth.ts `generateAccountId`）
- 每账号：`{ token, baseUrl, userId, enabled, name? }` + 独立轮询循环 + 独立 `get_updates_buf` 游标
- 登录流：`weixin-admin login --account wechat-2` → 输出二维码（URL/ASCII/图片落盘）→ 轮询 status → confirmed 后 token 存 plugin 全局 → 启动该账号轮询

### 3.3 会话映射（多用户核心）

```
微信消息 { from_user_id: "userA@im.wechat", context_token } 
  → sessionId = "skiff-weixin-" + sha256(from_user_id).slice(0,16)   // 固定、可重建
  → AcpServer.handle('session/new', { ccc, role, sessionId })        // 首次创建 / 进程内延续
  → AcpServer.handle('session/prompt', { sessionId, question: text })
  → sendmessage(to_user_id: from_user_id, context_token, answer)
```

- **进程重启恢复**：skiff 会话是内存态——重启后 `session/prompt` 报 "not recoverable" → 捕获后**自动重建**（session/new 无 sessionId 新建）+ 通知用户"新对话开始"（对齐 3100 问答页行为）
- **隔离**：不同 from_user_id → 不同 sessionId → 互不可见；同一用户多 bot 账号 → (accountId, userid) 联合键

### 3.4 外部面纯净（D9/D11 延续）

- weixin 桥会话 = 外部面（非维护会话）——**输出守卫生效**（敏感词打回）
- `session/prompt` 走 `includeTrajectory: false`（3100 同款，对外不返回轨迹）
- skiff 角色白名单即授权（G9 恒 allow）——zhaocai role 已配置 MSM/tools 白名单

## 4. 接口层

### 4.1 weixin-api.ts（Mech，纯确定性）

```ts
// 对齐 openclaw-weixin api.ts 语义（协议见 weixin-bot-api.md）
export interface WeixinAccount { token: string; accountId: string; baseUrl: string; userId?: string }

export async function fetchQRCode(baseUrl, botType='3'): Promise<{qrcode, qrcode_img_content}>
export async function pollQRStatus(baseUrl, qrcode): Promise<{status, bot_token?, ilink_bot_id?, baseurl?, ilink_user_id?}>
export async function getUpdates(baseUrl, token, getUpdatesBuf, timeoutMs=35_000): Promise<{ret, msgs, get_updates_buf}>
export async function sendTextMessage(baseUrl, token, {to, text, contextToken}): Promise<void>   // md→plain 内置
export async function sendTyping(baseUrl, token, {ilinkUserId, typingTicket, status}): Promise<void>
```

### 4.2 weixin-bridge.ts（装配）

```ts
export function registerWeixinBridge(ctx: Context): void
// 读取 plugin 全局 weixin.accounts[]（enabled）→ 每账号启动轮询循环
// 消息回调: handleIncoming(accountId, msg) → route → AcpServer.handle
// settings 开关 weixinEnabled=false 时零副作用（不启动任何轮询）
export function stopWeixinBridge(): void
```

### 4.3 配置 schema

```jsonc
// plugin 全局 ~/.dsh/serenity-hooks.json（v1.27.0 migrate 扩展）
{
  "weixin": {
    "enabled": false,
    "accounts": [
      { "accountId": "wechat-1", "token": "…", "baseUrl": "https://ilinkai.weixin.qq.com", "userId": "…", "enabled": true }
    ]
  }
}

// CCC 侧 .opencode/serenity.json
{
  "weixin": {
    "routes": [
      { "user": "userA@im.wechat", "ccc": "/home/yh/home/home-serenity", "role": "zhaocai" },
      { "user": "*", "ccc": "/home/yh/home/home-serenity", "role": "zhaocai" }   // 通配兜底
    ]
  }
}
```

### 4.4 weixin-admin 工具（第 14 工具，可选）

```
weixin-admin login [--account wechat-N]     # 出码 → 轮询 → 存 token（--json 输出 qrcode_img_content）
weixin-admin accounts                        # 列表（token 脱敏）
weixin-admin status                          # 每账号轮询健康/最近消息/游标
weixin-admin send --account wechat-1 --to <userid> --text "…"   # 测试发送
weixin-admin test --account wechat-1 --to <userid>              # 自测（发一条回显消息）
```

## 5. 实现分期

| 期 | 内容 | 规模估计 | 依赖 |
|----|------|---------|------|
| **P1（首版）** | weixin-api（qrcode/status/getupdates/sendmessage/sendtyping）+ bridge 单账号轮询 + 会话映射 + 设置开关 + weixin-admin login/status + 文本收发 | ~700 行 + 测试 | 无（crypto/fetch 内置） |
| P2 | 多账号 + accounts/send 子命令 + 路由表（CCC 侧配置） | ~300 行 | P1 |
| P3 | 媒体（图片/文件接收→落盘 + vlm 识别；发送） | ~400 行（AES/CDN） | P1 |
| P4 | 语音（SILK 转写）| ~300 行 | P3 |

**首版 P1 交付验证**：真实扫码（用户手机）→ 微信发 "你好" → zhaocai role 回复。

## 6. 测试策略

- **单元**：weixin-api 各函数（mock fetch）；route 映射（user→sessionId 确定性/隔离）；md→plain 转换（7 类）
- **集成**：fake iLink server（node:http mock getupdates/sendmessage）→ bridge 轮询 → 断言 skiff agent 收到 question / 回复回写（对齐 acp-http 测试模式）
- **联调**：真实账号扫码轮（用户动作）——不进 CI

## 7. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| 腾讯条款（仅管道，可随时限速/终止） | 接入可能失效 | 协议封装在 weixin-api 单模块，失效时替换通道（企微/飞书）成本低 |
| bot_type=3 语义未文档化 | 未知行为 | 实证可用；留配置项 botType 可调 |
| token 泄露 | 账号被接管 | plugin 全局 0600 + 输出守卫不泄露 + 不打印 |
| 长轮询断线 | 消息丢失/延迟 | 游标续传（get_updates_buf）+ 断线重连指数退避（对齐 orbit/ws 模式） |
| skiff 会话内存态 | 重启丢会话 | 自动重建 + "新对话开始"通知（对齐 3100） |

## 8. F4c 合并评估（个人微信 iLink vs 企微智能机器人）

| 维度 | 个人微信 iLink（本方案） | 企微智能机器人（F4c-2 调研） |
|------|------------------------|---------------------------|
| 接入门槛 | 扫码即用，无需审核 | 需企业主体/管理员 + 自建应用 |
| 公网依赖 | **无**（出站长轮询） | 回调需公网+可信域名（用户已碰壁）；长连接模式免域名 |
| 多用户 | 天然（from_user_id） | 需映射配置；社区反馈"只收创建人消息"待实测 |
| 体验 | 微信个人号（家庭实际使用） | 企微 App（家庭不使用） |
| 风险 | 腾讯可限速/终止 | 官方智能机器人通道，相对稳定 |
| 结论 | **首推（家庭场景实际）** | 调研保留，不做首版 |

**决策建议**：个人微信 iLink 为家庭实际通道（招财替代 openclaw 的微信接入面）；企微路线冻结（调研文档保留，触发条件 = iLink 被腾讯终止且家庭转向企微）。

## 9. 待用户拍板项

1. W1 出站长轮询形态确认（无公网入口）✓ 预计通过（F4c 企微碰壁前鉴）
2. W2 固定 sessionId 会话延续（用户 ↔ 长期会话）
3. W4 默认路由 zhaocai role + 通配兜底
4. 第 14 工具命名（weixin-admin）与工具数量（D12 曾讨论精简，但这是新能力面）
5. P1 范围（文本首版）确认
6. 版本号：v1.27.0（新能力面）或 v1.26.18（patch 级迭代——D14 版本放缓策略）
