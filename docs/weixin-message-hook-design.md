# 微信桥消息记录 hook（F4c-3 扩展）— 设计 v0.1

> 状态: 设计定稿（2026-09-02，S142）｜实现: P1 待做
> 决策来源: 用户需求「微信桥发生的所有消息记录，需要支持 hook，允许 CCC 通过自行编写 hook 进行持久性保存」+ 三项拍板（见 §5）

---

## 1. 需求

微信桥（F4c-3，v1.27.0）当前**不自动持久化消息记录**——对话只存在于 dsh skiff 会话（重启后 resume 可恢复），CCC 侧无结构化消息流出口。用户需要：

**微信桥收发的每一条消息都触发一个 CCC 自写的 hook，由 CCC 的 hook 脚本负责持久化保存**（存哪、存成什么格式、是否入库/推远端，全部归 CCC 决定——ACC 不绑定任何存储实现）。

## 2. 范围

### 2.1 触发事件（用户拍板 ①：入站 + 出站双向）

| 事件 | 时机 | 载荷要点 |
|------|------|---------|
| `incoming` | 用户消息路由命中后、进入 skiff 处理前 | 发送者 / 文本 / 媒体（kind + 落盘相对路径）/ 目标 role / 会话 id |
| `outgoing` | bot 回复**发送成功后** | 回复文本（已 stripThink）/ 关联入站会话 / 目标用户 |

### 2.2 配置

`serenity.json` 的 `weixin` 段扩展一个可选字段：

```jsonc
{
  "weixin": {
    "enabled": true,
    "hook": "scripts/weixin-message-hook.ts", // 可选；相对 CCC 根的 hook 脚本
    "accounts": [...],
    "routes": [...]
  }
}
```

- 未配置 `hook` → 零变化（现有行为完全不变）
- 脚本缺失 → 仅日志警告，不阻断微信桥（同 §2.4 失败语义）

### 2.3 hook 执行形态（用户拍板 ②：脚本 + stdin JSON 事件）

- 每次消息事件 spawn 一次脚本进程（消息频率为人际对话量级，进程开销可忽略）
- **事件 JSON 经 stdin 传入**（单行 JSON；脚本 `readFileSync(0,'utf8')` 读取）
- 执行器复用 biasProvider 先例：**bun 优先、node 兜底**；路径逃逸校验（`resolveInside`，脚本必须在 CCC 根内）

### 2.4 失败语义（用户拍板 ③：旁路容忍，不阻断微信桥）

- hook 执行**异步 fire-and-forget**（不 await 在消息处理主链上）
- 超时上限 + 失败仅 console 日志——**微信桥消息处理/回复照常，可靠性不受 hook 影响**
- 脚本退出码非 0 / stderr 有输出 → 日志记录（含前 N 字符，防日志洪泛）

## 3. 事件 JSON schema（stdin 载荷）

```jsonc
// incoming（用户 → bot）
{
  "event": "incoming",
  "ts": 1788359941488,            // 事件时间（epoch ms）
  "cccRoot": "/path/to/ccc",      // 触发 CCC 根（多 CCC 一进程可区分）
  "accountId": "wechat-1",        // 接收账号
  "userId": "userA@im.wechat",    // 发送者（from_user_id）
  "sessionId": "skiff-weixin-xxx",// 固定会话 id（同用户长期同一）
  "role": "zhaocai",              // 路由命中的 skiff role
  "message": {
    "text": "你好",               // 文本（含语音服务端转写）；无文本 → null
    "media": [                    // 媒体（图片/文件）；无 → []
      { "kind": "image", "relPath": "_tmp/weixin-inbound/<hash>/img_xxx.jpg" }
    ]
  }
}

// outgoing（bot → 用户）
{
  "event": "outgoing",
  "ts": 1788359942488,
  "cccRoot": "/path/to/ccc",
  "accountId": "wechat-1",
  "userId": "userA@im.wechat",
  "sessionId": "skiff-weixin-xxx",
  "role": "zhaocai",
  "reply": "（已记录，回复文本，已剥离 think）"
}
```

> 设计说明：
> - **不含 context_token / bot_token 等会话凭据**——hook 用途是记录，不是代发消息；最小暴露面
> - 媒体带 `relPath`（相对 CCC 根，已落盘 `_tmp/weixin-inbound/`）——hook 若要持久保存媒体文件，自行 copy 到持久位置（`_tmp` 是临时目录）；不 copy 则媒体随临时清理丢失（记录文本已够审计，媒体归 CCC 取舍）
> - outgoing 在**发送成功后**触发——发送失败不触发（避免记录从未送达的回复）；若需记录失败，CCC 可从日志侧补充

## 4. 实现计划（P1）

| 文件 | 变更 |
|------|------|
| `src/ccc.ts` | `WeixinSettings` + `hook?: string`（注释定位 CCC 自写消息 hook） |
| `src/weixin-route.ts` | `readWeixinSettings` 归一化补 `hook` 透传 |
| `src/weixin-hook.ts`（新） | 纯逻辑：`buildHookEvent`（incoming/outgoing 事件对象构造）+ `runWeixinHook`（spawn 执行：resolveInside + bun/node + 超时 + 失败日志）+ 测试辅助 |
| `src/weixin-bridge.ts` | `handleIncoming`：路由命中后 fire incoming hook（异步不阻塞）；`sendTextMessage` 成功后 fire outgoing hook |
| `tests/weixin-hook.test.ts`（新） | 事件构造（双向 schema 断言，不含凭据）/ 执行（脚本收到 stdin JSON / 缺失静默 / 超时 kill / 路径逃逸拒绝 / 退出码非 0 日志）/ bridge 集成（入站+出站各触发一次） |

### 关键实现细节

- **入站 hook 时机**：在 §handleIncoming 路由命中、role 校验通过**之后**触发（事件含 role——必须先知道路由目标）；在媒体下载落盘**之后**触发（事件含 relPath——媒体须已落盘）。即：媒体处理完成 → fire incoming hook → askSkiff → sendTextMessage → fire outgoing hook。incoming hook 不阻塞 askSkiff（fire-and-forget）
- **超时**：`HOOK_TIMEOUT_MS = 15_000`（旁路记录足够；超时 kill 防挂死脚本）
- **stdout/stderr**：捕获前 500 字符进日志（防脚本刷屏）
- 出站 hook 需要把发送结果带回 handleIncoming 作用域（sendTextMessage resolve 后 fire）

### 测试基线预期

52 files / 752 tests + ~8-10 新用例 → 52 files / ~760-762 tests

## 5. 决策记录（R↓）

| # | 决策 | 理由 / 备选 |
|---|------|------------|
| H1 | 双向触发（incoming + outgoing） | 用户拍板①——完整对话记录可审计；仅单向会丢一半上下文 |
| H2 | 脚本 + stdin JSON 事件 | 用户拍板②——参考 biasProvider 成熟先例（CCC 根脚本 + 路径逃逸 + bun/node 兜底）；备选固定文件名（零配置但欠灵活）/ 内嵌代码（不可维护）均弃 |
| H3 | 旁路容忍（fire-and-forget + 超时 + 仅日志） | 用户拍板③——微信桥可靠性优先；记录是增值非关键路径 |
| H4 | 配置可选（未配置零变化） | 微信桥既有原则：实验功能默认关、零资源占用；存量 CCC 无迁移成本 |
| H5 | 事件不含会话凭据（context_token/bot_token） | 最小暴露面——hook 职责是记录不是代发；CCC 若要代发已有 weixin-send MSM 通道 |
| H6 | 媒体带 relPath 不 copy | `_tmp` 已落盘即已达 ACC 层可达性目标（v0.2 用户拍板精神延续）；持久化取舍归 CCC hook 自己 |

## 6. 不做（边界）

- 不做 hook 链/多 hook 编排（单脚本够；CCC 脚本内部可自由串多动作）
- 不做 hook 的 UI 面板（配置在 serenity.json，人工编辑；与 weixin 段其余配置一致）
- 不做内置持久化实现（写文件/入库/推远端全是 CCC hook 的职责——这是本功能的核心语义：存储归 CCC）
- 不做回复失败事件（发送失败不记录；日志侧可查）

## 7. 发布节奏

实现 → test 全绿 → deploy 本机生效 → 用户实测（配置 hook 脚本 → 微信发消息 → 观察 hook 收到事件）→ 用户要求后再 bump/publish（D14 纪律：发布等显式指令）。
