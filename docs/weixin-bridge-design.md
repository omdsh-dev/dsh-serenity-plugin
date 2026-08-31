# dsp 微信桥（weixin-bridge）— 方案设计（F4c-3，S142）

> 状态：**方案 v0.2（2026-08-31，用户六项裁决已收）** — Neat 协议：需求层 → 范围层 → 方案层 → 接口层 → 实现层，未对齐不进实现。
> 前置：`docs/weixin-bot-api.md`（iLink 协议全解 + 裸调实证）、`docs/acp-wecom-design.md`（F4c 企微路线）。
> 需求来源：用户 "dsp 能否接入微信的扫码协议，考虑多用户接入招财 role"——skiff 强化后支持微信扫码接入 → **代替 openclaw（招财平台）**。

---

## 1. 需求层

| # | 需求 | 用户原话/来源 | 状态 |
|---|------|--------------|------|
| R1 | dsp 支持微信扫码接入（个人微信 iLink Bot API） | "dsp 能否接入微信的扫码协议" | 协议已验证可行 |
| R2 | 多用户支持（多个微信用户与 bot 对话，各自独立会话） | "考虑多用户接入招财 role" | 协议天然支持（from_user_id 区分） |
| R3 | 接入 skiff 角色体系（不绑定具体 role，用户可配） | 用户裁决 3："ACC 层开发不能绑定具体 role，允许用户选择" | 路由可配置 |
| R4 | 远期：代替 openclaw 平台 | S149 战略目标 | 本方案是其中一块 |

**边界（不在本方案）**：
- 不做群聊（首版仅私聊；群聊 context/语义另议）
- 不做媒体收发首版（文本优先，图片/语音/文件后置——见 §5 分期）
- 不做企微智能机器人（F4c-2 调研记录保留，合并评估见 §8）
- **不做 weixin-admin 工具**（用户裁决：管理面收敛到 CCC 面板）

## 2. 范围层

**做**：dsp 新增 `weixin-bridge` 能力——**CCC 级**配置 + 多账号 iLink 轮询 + 消息路由到 acp-core 直调 → skiff role 会话。
**不做**：不新增 HTTP 端点（微信是出站长轮询，不需要公网入口）；不新建协议；不做 agent 侧管理工具。

**架构决策（用户拍板 2026-08-31）**：dsh 一个进程含多个 CCC，**每个 CCC 独立对接微信桥**——
- **配置归属 CCC**（不是 plugin 全局）：结构/路由/开关进 `.opencode/serenity.json`（git 管可重建）；**token 凭据进 CCC localstore**（安全纪律，扫码后自动写入，面板只显示"已绑定"）
- **每 CCC 独立桥实例**：账号 + 路由表 + 轮询循环都是 CCC 级，互不干扰
- **手工配置**：面板扫码绑定 + 账号/路由编辑，无自动发现
- **管理面 = 面板「微信桥」区块，显式 CCC 选择器**（S142 用户修正 2026-08-31：WebUI 是顶层全局单例，不能隐式依赖"当前活跃会话"的 workspace——微信桥是配置写入，必须显式回答"配的是哪个 CCC"）：
  - 区块顶部 = **CCC 选择器**（数据源 = 现成 `discoverCccs`，复用 skiff 调试页切换器/开放容器白名单同款；零新机制）
  - 选中 CCC → 显示/编辑该 CCC 的微信桥配置；切换 → 整块切换
  - **API 全部显式带 `ccc` 参数**：`GET/POST /serenity/weixin?ccc=<root>`——无参返回 400「请选择 CCC」，不做隐式解析

**组件划分**（对齐现有 services 模块风格）：

| 模块 | 职责 | 类比 |
|------|------|------|
| `src/weixin-api.ts` | iLink 纯 fetch 客户端（qrcode/status/getupdates/sendmessage/sendtyping/getconfig） | 传输层，零 LLM |
| `src/weixin-bridge.ts` | CCC 级多账号轮询循环 + 消息分发（from_user_id → sessionId 映射）+ 回复回写 | 类比 gateway 装配 |
| `src/weixin-route.ts` | 会话映射（微信用户 ↔ skiff 会话）+ CCC 配置读取（serenity.json + localstore） | 类比 skiff-registry |
| `src/api.ts` 扩展 | `/serenity/weixin` 端点：GET 状态 / POST 扫码登录（出码+轮询）/ POST 移除账号 | 类比 autotrajectory 端点 |
| `src/client/SettingsSection.tsx` | 「微信桥」区块（扫码绑定 + 账号列表 + 路由编辑 + 开关） | 类比「自主轨迹」区块 |

**配置 schema（CCC 级）**：

```jsonc
// .opencode/serenity.json（git 管，可重建）
{
  "weixin": {
    "enabled": false,
    "accounts": [
      { "accountId": "wechat-1", "name": "家庭招财", "enabled": true }
      // token/baseUrl/userId 不在 git 文件——扫码后写 localstore
    ],
    "routes": [
      { "user": "userA@im.wechat", "role": "zhaocai" },
      { "user": "*", "role": "zhaocai" }        // 通配兜底
    ]
  }
}

// localstore.json（凭据——扫码后自动写入，面板只显示"已绑定"；credential scope UPPER_SNAKE）
// WEIXIN_WECHAT_1_TOKEN   = "<bot_token>"
// WEIXIN_WECHAT_1_BASEURL = "https://ilinkai.weixin.qq.com"
// WEIXIN_WECHAT_1_USERID  = "<ilink_user_id>"
```

## 3. 方案层

### 3.1 架构总览

```
微信 App ──(用户扫码)──▶ 腾讯 iLink API (ilinkai.weixin.qq.com)
                              ▲                    │
                   getupdates │ (35s 长轮询)       │ sendmessage (回带 context_token)
                              │                    ▼
                    CCC 级 weixin-bridge（插件进程内，每 CCC 独立实例）
                              │  多账号循环（每账号独立轮询 + 独立游标）
                              ▼
                    from_user_id → sessionId 映射（weixin-route：CCC 配置 + localstore 凭据）
                              │
                              ▼
              AcpServer.handle('session/new' + 'session/prompt')  ← 同进程直调
                              │
                              ▼
                    skiff-core → CCC 配置的 role agent（用户自选，不绑定）
```

**关键设计决策（用户裁决后定稿）**：

| # | 决策 | 方案 | 用户裁决 |
|---|------|------|---------|
| W1 | 传输形态 | **出站长轮询**（bot 主动 GET getupdates，35s hold）——无需公网入口/域名/回调 | ✅ 同意 |
| W2 | 会话延续 | 微信用户 → 固定 sessionId `skiff-weixin-<sha256(userid)>`——同一用户长期同一会话（记忆延续），多用户天然隔离 | ✅ 同意 |
| W3 | 对话状态 | message_state: NEW → 收到 → prompt → GENERATING（正在输入）→ FINISH 回写 | 待 P1 简化（文本直发） |
| W4 | 路由目标 | **不绑定 role**——CCC 配置 user → role 映射 + 通配兜底 | ✅ 用户裁决 3 |
| W5 | 配置归属 | **CCC 级**：serenity.json（结构/路由/开关）+ localstore（token 凭据） | ✅ 用户裁决（架构修正） |
| W6 | 管理面 | **CCC 面板**「微信桥」区块（扫码 + 账号 + 路由 + 开关），手工配置 | ✅ 用户裁决 |
| W7 | 回复格式 | markdown → 纯文本转换（微信不支持 md） | ✅ 默认 |
| W8 | 工具面 | **不做 weixin-admin 工具**（管理收敛面板） | ✅ 用户裁决 |

### 3.2 多账号模型（CCC 级）

- 每个 CCC 自己的账号表：`wechat-1, wechat-2, ...`（对齐 openclaw-weixin auth.ts `generateAccountId`）
- 每账号：`{ accountId, name, enabled }`（serenity.json）+ `{ token, baseUrl, userId }`（localstore）
- 登录流（面板）：点「扫码登录」→ 插件进程内 fetchQRCode → 面板显示二维码 → 轮询 status → confirmed → **token 写 localstore + 账号元信息写 serenity.json** → 启动该 CCC 该账号轮询

### 3.3 会话映射（多用户核心）

```
微信消息 { from_user_id: "userA@im.wechat", context_token }
  → sessionId = "skiff-weixin-" + sha256(from_user_id).slice(0,16)   // 固定、可重建
  → 路由：routes 匹配（exact user → 通配 *）→ (role)
  → AcpServer.handle('session/new', { ccc: <本 CCC 根>, role, sessionId })   // 首次创建 / 进程内延续
  → AcpServer.handle('session/prompt', { sessionId, question: text })
  → sendmessage(to_user_id: from_user_id, context_token, answer)
```

- **进程重启恢复**：skiff 会话是内存态——重启后 `session/prompt` 报 "not recoverable" → 捕获后**自动重建**（session/new 无 sessionId 新建）+ 通知用户"新对话开始"（对齐 3100 问答页行为）
- **隔离**：不同 from_user_id → 不同 sessionId → 互不可见；同一用户多 bot 账号 → (accountId, userid) 联合键

### 3.4 外部面纯净（D9/D11 延续）

- weixin 桥会话 = 外部面（非维护会话）——**输出守卫生效**（敏感词打回）
- `session/prompt` 走 `includeTrajectory: false`（3100 同款，对外不返回轨迹）
- skiff 角色白名单即授权（G9 恒 allow）——CCC 自选 role 的白名单生效

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

### 4.2 weixin-bridge.ts（CCC 级装配）

```ts
export function registerWeixinBridge(ctx: Context): void
// 扫描 live CCC（resolveAutoTrajectoryCcc 同款）→ 每 CCC 读 weixin 配置（enabled + accounts）
// → 启动该 CCC 该账号轮询循环；消息回调 → weixin-route 路由 → AcpServer.handle
// 配置变化（面板 PUT）→ 热重建受影响 CCC 的桥（对齐 gateway 热重建模式）
export function stopWeixinBridge(): void
```

### 4.3 CCC 配置 schema（上文 §2）

### 4.4 API 端点（扩展 api.ts；**全部显式 ccc 参数，无参 400**）

```
GET  /serenity/weixin?ccc=<CCC根> → { enabled, accounts[]（脱敏）, routes[], bridgeStatus[] }
POST /serenity/weixin { action: 'login-start', ccc }   → { qrcode, qrcode_img_content, loginKey }   // x-serenity-ui 头
GET  /serenity/weixin/login?key=<loginKey>             → { status, accountId?, tokenSaved? }           // 扫码轮询
POST /serenity/weixin { action: 'remove-account', ccc, accountId } → 移除账号（serenity.json + localstore + 停轮询）
POST /serenity/weixin { action: 'save-routes', ccc, routes }      → 保存路由表
GET  /serenity/weixin/cccs → 候选 CCC 列表（discoverCccs 复用——选择器数据源）
```

### 4.5 扫码 UX（用户视角；复用 v1.24.6 TOTP 绑定同款机制 + 显式 CCC 选择器）

```
WebUI 设置面板 → 微信桥区块：
0. 顶部「目标 CCC」选择器（discoverCccs 数据源）——选中要配置的 CCC（默认当前活跃会话对应 CCC 作初值）
1. 点 [+ 扫码绑定微信] → 插件进程内调 get_bot_qrcode → 返回 qrcode_img_content
2. 面板用 qrcode-generator 把 qrcode_img_content（https://liteapp.weixin.qq.com/q/...?bot_type=3）
   编码成二维码 SVG 展示（复用 totpQrSvg 同款；零新依赖）
3. 用户手机微信「扫一扫」扫面板二维码 → 微信打开 liteapp 确认页 → 手机上确认绑定
4. 面板轮询 get_qrcode_status（1s 间隔，5min 有效）→ confirmed
   → 插件写 bot_token 进 **所选 CCC 的** localstore（凭据）+ 账号元信息进该 CCC 的 serenity.json（结构）
   → 区块变「已绑定」→ 该 CCC 的桥启动轮询
```

- 扫码人 = 管理员（yh），动作 = 面板出码 + 微信扫 + 手机确认——与 TOTP 绑定（Authenticator 扫面板二维码）完全同构，用户已熟悉
- 家人使用 = 直接私聊已绑定 bot（无需扫码流程，from_user_id 天然区分多用户）
- 多账号 = 反复「+ 扫码绑定」，每账号独立二维码轮询 + 独立 localstore 凭据键

## 5. 实现分期

| 期 | 内容 | 规模估计 | 依赖 |
|----|------|---------|------|
| **P1（首版，v1.27.0）** | weixin-api（qrcode/status/getupdates/sendmessage/sendtyping）+ CCC 级配置（serenity.json + localstore）+ bridge 轮询 + 会话映射 + 面板「微信桥」区块（扫码/账号/路由/开关）+ /serenity/weixin 端点 + 文本收发 | ~900 行 + 测试 | 无（crypto/fetch 内置） |
| P2 | 多 CCC 热重建 + ~~sendtyping（正在输入）~~ + 断线重连退避 | ~300 行 | P1 |
| P3 | 媒体（图片/文件接收→落盘 + vlm 识别；发送） | ~400 行（AES/CDN） | P1 |
| P4 | ~~语音（SILK 转写）~~ → **语音支持（v1.27.3 已做）** | ~300 行 | P3 |

**分期状态更新（2026-09-01 完善轮）**：
- **sendtyping（正在输入）已完成**（P2 项提前）：`getconfig` 取 typing_ticket（每用户缓存）→ 处理前 `sendtyping 1` → 处理后 `0`（对齐参考实现 typingCallbacks）；typing 失败静默不阻断
- **语音支持已完成（P4 简化为服务端转写路线）**：微信语音消息自带 `voice_item.text`（服务端 ASR 转写，官方插件直接读）→ 与文本同路径进 skiff 对话，**无需 SILK 解码/下载/本地 ASR**；语音无转写 → 降级提示"暂时无法解析"。原 P4 的 SILK 下载+ASR 链路仅当腾讯停止转写时作为备选

**首版 P1 交付验证**：真实扫码（用户手机）→ 微信发 "你好" → CCC 配置的 role 回复。

## 6. 测试策略

- **单元**：weixin-api 各函数（mock fetch）；route 映射（user→sessionId 确定性/隔离）；md→plain 转换（7 类）；CCC 配置读取（serenity.json + localstore 分离）
- **集成**：fake iLink server（node:http mock getupdates/sendmessage）→ bridge 轮询 → 断言 skiff agent 收到 question / 回复回写（对齐 acp-http 测试模式）
- **联调**：真实账号扫码轮（用户动作）——不进 CI

## 7. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| 腾讯条款（仅管道，可随时限速/终止） | 接入可能失效 | 协议封装在 weixin-api 单模块，失效时替换通道（企微/飞书）成本低 |
| bot_type=3 语义未文档化 | 未知行为 | 实证可用；留配置项 botType 可调 |
| token 泄露 | 账号被接管 | token 只在 CCC localstore（凭据纪律）+ 输出守卫不泄露 + 不打印 |
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

## 9. 用户裁决记录（2026-08-31）

| # | 裁决 | 内容 |
|---|------|------|
| 1 | ✅ | 出站长轮询形态同意 |
| 2 | ✅ | 固定 sessionId 会话延续同意 |
| 3 | ✅ | **ACC 不绑定 role**——路由 user → (ccc, role) 由 CCC 配置，用户自选 |
| 4 | ✅ | **不做 weixin-admin 工具**；管理面收敛到 CCC 面板 |
| 5 | ✅ | 先做文本（媒体后置） |
| 6 | ✅ | 版本 v1.27.0 |
| 7 | ✅ | **配置归属 CCC**（架构修正）：dsh 多 CCC 各自独立对接微信桥；serenity.json 结构/路由 + localstore 凭据；手工配置；CCC 面板管理面 |

## 10. 实现清单（P1，v1.27.0）

- [ ] `src/weixin-api.ts` — iLink 客户端（纯 fetch，零依赖）✅ 已建
- [ ] `src/weixin-route.ts` — CCC 配置读取（serenity.json weixin 段 + localstore 凭据）+ 会话映射 ✅ 已建
- [ ] `src/weixin-bridge.ts` — CCC 级轮询循环 + 消息分发 + AcpServer 直调 + 回复回写
- [ ] `src/api.ts` — /serenity/weixin 端点（**显式 ccc 参数**：状态/扫码/移除/路由保存/ccc 列表）
- [ ] `src/settings-section.ts` — 无新增开关（weixin.enabled 在 CCC 配置，非 plugin 级）——确认
- [ ] `src/client/SettingsSection.tsx` — 「微信桥」区块（**CCC 选择器** + 扫码绑定/账号/路由/开关）
- [ ] `src/index.ts` — registerWeixinBridge 装配
- [ ] tests：weixin-api（mock fetch）/ weixin-route / weixin-bridge 集成 / config 分离
- [ ] bump v1.27.0 + CHANGELOG + publish + 双推 + deploy + restart
