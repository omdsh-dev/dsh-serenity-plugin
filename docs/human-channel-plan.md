# human-channel（人机信道）实现方案 —— 完整版 · 待审

> **状态**：🟡 **待 owner 审核**（owner 2026-09-26：「我觉得较 human-channel 吧，这个合适，按照这个命名给出完整的实现方案，包括配置侧的，会话侧的，我会仔细审核」）
> **取代**：`weixin-acc-layer-design.md`（讨论稿）／`im-bridge-redesign.md`（im-bridge 级）—— 两份都留档为**推理过程**，**冲突以本件为准**。
> **本件的读法**：§2 配置侧 ／ §3 会话侧 是你要审的两大块；§5 是逐处改动；§7 是验收判据；**§10 是待你拍的点**。

---

## 0. 命名与派生（已定）

```
human-channel（人机信道）—— 机制名，机器级，归 ACC
├─ 渠道实现（可替换）：微信桥 ／ 飞书桥 ／ 邮件桥 …
├─ 端点：人（容器外的黑盒 trajectory，无读通道）
└─ 中转：ACC(dsp) —— 一账号一 poller ／ 订阅表 ／ 主控指定 都在这一层
```

| 判据 | 核验 |
|---|---|
| 不含渠道名 | ✅（"微信"只出现在**实现**名里） |
| 不过宽 | ✅（"信道"收窄到通信面，不是"协作"） |
| 能派生 `<渠道>桥` | ✅（微信桥 ／ 飞书桥 ／ 邮件桥） |
| 不用 `container_` 前缀 | ✅（它管**边界**，不是容器自身 —— D61 判据） |

🔵 **与 `container_trajectory` 的分工**：`container_trajectory` 管**容器内**；`human-channel` 管**容器外**（人 ＋ 别的 CCC）。

---

## 1. 术语表（本件统一口径）

| 词 | 指 |
|---|---|
| **human-channel** | 本机制整体（机器级） |
| **渠道 / 桥** | 一种实现（微信桥…），提供"发出"与"收到"两个方向 |
| **端点** | 消息的对面：`user`（人）／ `ccc`（别的 CCC 的轨迹） |
| **订阅** | 机器级表里的一行：`(账号, 用户) → (CCC, 角色)` —— **收到**谁的消息 |
| **主控（relay）** | 被指定**唯一**可做跨 CCC 动作的 CCC |
| **skiff 会话** | 人侧消息落到的会话（属某 CCC 的某角色） |

---

## 2. 配置侧（**机器级**）

### 2.1 落点

**插件 Config（宿主 `serenity-hooks` 命名空间）** —— 它**本身就是机器级的**（不是每 CCC 一份），不必新造文件。

### 2.2 schema（拟）

```ts
humanChannel: {
  accounts: [
    { id: 'wechat-1',            // 账号 id（订阅表引用它）
      channel: 'weixin',         // 渠道实现名（注册表里的 id）
      enabled: true,
      token: '…',                // 🔴 凭据（§2.5 待确认落点）
      userId: '…' }
  ],
  subscriptions: [
    { account: 'wechat-1', user: 'yh', ccc: 'home-serenity', role: 'zhaocai' }
  ],
  relay: { ccc: 'home-serenity' },   // 🔴 唯一；人设；CCC 不得自声明
  sending: { allow: ['*'] }          // 哪些 CCC 可以"发给人"（§3.4 待确认）
}
```

### 2.3 面板

`WeixinBridgeEditor.tsx` → **`HumanChannelEditor.tsx`**（机器级）：
- **账号区**（今天已有）：增删账号 ／ 启停 ／ 扫码
- **订阅表**（🆕）：逐行 `账号 × 用户 → CCC × 角色`；CCC 与角色从 `listCccs({withRoles:true})` 下拉选
- **主控选择器**（🆕）：单选一个 CCC
- 🔴 **去掉"顶部 CCC 选择器"** —— 那是"选配置目标"的旧心智（配置不再按 CCC 分）

### 2.4 迁移（旧 CCC 侧 `weixin.*`）

| 项 | 处置 |
|---|---|
| CCC `serenity.json` 里的 `weixin.*` | **不生效**；🔴 **但启动时打一条警告**（不是静默忽略） |
| 为什么这次**不**静默 | 前几次砍键是"键没了"；**这次是"家搬了"** —— 残留配置**看起来仍然有意义**（用户会以为还生效）⇒ **必须出声** |
| 自动迁移 | 🔵 **可选**（见 Q6）：把第一个 CCC 的 `weixin.accounts` 读出来，**生成**机器级配置的建议值（不自动写，打印给你确认） |

### 2.5 凭据落点（Q3）

| 选项 | 说明 |
|---|---|
| **A（倾向）** | 插件 Config（机器级，面板可编辑）—— 与"凭据非密（私有内网）"一致 |
| B | 新建机器级 localstore —— 形态一致，但**多一个真相源** |

### 2.6 账号互斥（一账号一 poller）

- 今天：桥按 CCC 起（`for entry of listCccs ⇒ syncCccBridge`）⇒ **同账号可能被两处轮询**
- 改后：**poller 按账号起（机器级）**，与 CCC 数量无关
- 判据：**同一账号在同一时刻只有一个 poller**（可机械观测）

---

## 3. 会话侧（**你要重点审的一块**）

### 3.1 入站：人 → CCC（**收到**）

```
微信用户 U 发一条 → poller 收到（机器级，唯一）
   → 查订阅表 (账号, U) → 命中 (CCC_X, 角色 R)
   → 在 CCC_X 里 ensureSkiffSession(channel, account, U, R)   ← 稳定 id，resume-or-create
   → 把消息作为一条 prompt 投进该 skiff 会话
   → skiff 应答 → 经渠道实现回发（沿用今天的 autoReply / fallback 开关）
```

| 点 | 说明 |
|---|---|
| **会话 id** | 沿用今天的形态 `skiff-<channel>-<hash(account,user)>` ⇒ **按 (渠道, 账号, 用户) 天然隔离** |
| **未命中订阅表** | 🔴 **不投递**（不是"投给默认角色"）＋ 记一条**可查的痕迹**（谁发的、为什么没投） |
| **命中但角色/CCC 不存在** | 🔴 **响亮报错**（W5'），不静默丢弃 |
| **一个用户多行** | 允许（同一人可同时落到多个 CCC 的角色）⇒ 各自独立的 skiff 会话 |

### 3.2 出站：CCC → 人（**发出**）

```
任意 CCC 的 agent 调 im-bridge send(user, text)
   → 能力层按机器级配置找账号 → 渠道实现发送
   → 成功即写容器日志（沿用今天）
```

🔵 **关键变化**：**"每个 CCC 都能给人发消息"**（= 你最初说的"给每个 CCC 都接上微信"）。
今天这件事由"本 CCC 是否配了 weixin"决定；改后由**机器级**决定（§3.4 待确认是否设白名单）。

### 3.3 跨 CCC：主控 → 别的 CCC（**投递/唤起**）

```
主控 CCC 的 agent 调 im-bridge dispatch(target='tiangong-serenity/S185', text, at?)
   → 主控闸校验（本 CCC == relay？）
   → 目标 CCC 的**唤醒表**写一条（wake entry）
   → 目标 CCC 的调度器（每 5min tick）投递
   → 目标轨迹冷会话 ⇒ **自动载入**（沿用既有路径）
```

🔴 **三点必须说清**：
1. **目标不是 skiff 会话，是"目标 CCC 的一条轨迹"**（`S###`）—— 两套会话模型，别混
2. **语义 = fire-and-forget**（无回执、不可回收）—— 与 `send-later` **同一原语**
3. 🔴 **它是"派活 + 事后查"，不是"实时对话"**：目标 CCC 的产出**不会自动回到人这边**；
   主控要**事后 `peek`**（T1）才知道进展，再决定是否回话给 owner。**这条限制要写进自述**，否则预期会错

### 3.4 谁能发给人（Q7）

| 选项 | 说明 |
|---|---|
| **A（倾向）** | **所有 CCC 都能发**（对上"给每个 CCC 都接上微信"）＋ 机器级可选白名单 `sending.allow` |
| B | 只有主控能发 —— 与"每个 CCC 都接上微信"矛盾，**不推荐** |

⚠️ **风险（诚实登记）**：A 意味着**任何 CCC 都可能给 owner 发消息** ⇒ 噪音面变大。缓解：`sending.allow` 白名单 ＋ 日志留痕。

### 3.5 会话的持久与恢复

| 事 | 今天 | 改后 |
|---|---|---|
| skiff 会话绑定 | skiff registry ＋ trajectory-bound | **不变** |
| 重启恢复 | 按绑定恢复 | **不变** |
| 主控 CCC 冷掉 | — | 🔴 **明确信号**（W4'）：跨 CCC 调用返回稳定码，不静默超时 |
| 人侧会话冷掉 | resume-or-create | **不变** |

### 3.6 审计（Q4）

| 事件 | 留痕 |
|---|---|
| 入站（人 → CCC） | 沿用 `_weixin-logs/`（落在**被路由到的那个 CCC**） |
| 出站（CCC → 人） | 容器日志（沿用今天） |
| **跨 CCC（主控 → 别 CCC）** | 🆕 **机器级审计**（目标 CCC 看不到调用者是谁 ⇒ 不能只落目标侧） |

✅ **顺带解决**：一账号一 poller ⇒ 一条消息**只被投递一次** ⇒ **不再有重复落盘**（今天多 CCC 各轮询才会重复）。

---

## 4. 工具面：`im-bridge`

### 4.1 动作（4 → 7）

| action | 域 | 门控 | 状态 |
|---|---|---|---|
| `send` / `send-file` / `users` / `status` | user | 机器级有该渠道 | 不变 |
| **`peers`** | ccc | 🔴 主控 | 🆕 T0（列 CCC ＋ 轨迹 ＋ 活跃态） |
| **`peek`** | ccc | 🔴 主控 | 🆕 T1（目标**结构化状态**） |
| **`dispatch`** | ccc | 🔴 主控 | 🆕 T3（投消息／排期） |

**参数新增**：`target`（`<ccc 别名>` 或 `<ccc 别名>/<S###>`）／ `at`（同 `send-later` 语法）。

### 4.2 门控形态（Q2）

- 倾向：**运行期拒绝**（单工具）＋ 稳定码 `NOT_RELAY` ＋ **自述明写前置条件**
- 备选：拆成两个工具（`ccc` 域那个只对主控**可见**）—— 代价：工具面 11→12

### 4.3 可见性

| 域 | 可见条件 |
|---|---|
| user 域 | 机器级**配了任一渠道** ⇒ 对所有 CCC 可见（今天：本 CCC 配了才可见） |
| ccc 域 | 同上 ＋ **运行期主控闸** |

### 4.4 自述（加两句，不加散文）

> Deliver one message to a **person — the peer endpoint of this channel**. Treat them as a peer, not a notification target: their state is a **black box** (we have no read channel to a person), they act on their own schedule, and delivery is **fire-and-forget** (no receipt, no recall).
>
> The `ccc` domain addresses **other containers** and is available only to the designated relay container; calls from any other container are refused. Cross-container dispatch is **fire-and-forget and not a live conversation** — check back with `peek`.

**禁止**：`notify/report/alert` 服务生语态 ／ "the user is just another trajectory" ／ 暗示能读人的状态 ／ 把 `ccc` 域说成任意读。

---

## 5. 逐处改动清单（符号锚，不写行号）

| # | 文件 | 改什么 |
|---|---|---|
| 1 | `src/index.ts` | Config schema：**＋ `humanChannel`**；`weixin` 相关键标废弃（保留只读兼容位或直接删，见 Q5） |
| 2 | `src/settings-section.ts` | `SerenitySimpleSettings` ＋ `humanChannel` 投影；`weixin.*` 读取面退役 |
| 3 | `src/client/HumanChannelEditor.tsx`（🆕，由 `WeixinBridgeEditor.tsx` 演进） | 账号区 ＋ **订阅表** ＋ 主控选择器；去掉"顶部 CCC 选择器" |
| 4 | `src/weixin-bridge.ts` | `syncCccBridge` 语义改：**按账号起 poller**（不再按 CCC）；订阅表来自机器级 |
| 5 | `src/weixin-route.ts` | 路由来源改为机器级订阅表；**未命中 ⇒ 不投递 ＋ 留痕**；**目标不存在 ⇒ 响亮报错** |
| 6 | `src/im-bridge.ts`（能力层） | ＋ `ccc` 域三个动作的实现（复用 `listCccs` ／ SESSION 解析 ／ `deliverWake`） |
| 7 | `src/tools/im-bridge.ts` | ＋ 3 个 action ＋ `target`/`at` 参数 ＋ **主控闸** ＋ 自述两句 |
| 8 | `src/seams/context.ts` | 可见性判据改为**机器级**（配了渠道即对全 CCC 可见） |
| 9 | `src/wake-scheduler.ts` | **不改**（投递原语被 im-bridge 复用，不新增机制） |
| 10 | `src/ccc-roots.ts` | **不改**（`listCccs` 已是 T0 的数据源） |
| 11 | 🆕 机器级审计 | 跨 CCC 动作留痕（落点见 Q4） |
| 12 | `src/human-channel.ts`（🆕，可选） | 把"机制"从"渠道实现"里分出来（今天 `weixin-bridge.ts` 混着两者） |

---

## 6. 分期

| 期 | 内容 | 为什么这个顺序 |
|---|---|---|
| **P0** | ① 账号互斥（一账号一 poller）② 配置上移（机器级 schema ＋ 面板）③ 订阅表 ＋ 迁移警告 | **不动工具面** ⇒ 风险最低；且是 P1 的前置 |
| **P1** | ④ 主控指定 ＋ 主控闸 ⑤ `ccc` 域三动作 ⑥ 自述 ＋ 审计 | 工具面改动，与 P0 的门控同批 |
| **P2** | ⑦ 第二个渠道实现（飞书桥／邮件桥）验证"可替换"是真的 | **验证抽象是否成立** —— 只有第二个实现才能证明第一个不是特例 |

---

## 7. 验收判据（配置侧 ＋ 会话侧 ＋ 工具面）

**配置侧**
1. 机器级配置生效：改订阅表 ⇒ **无需重启**即改变路由（或明确"需重启"并给信号 —— 见 Q8）
2. 旧 CCC `weixin.*` ⇒ **不生效 ＋ 启动警告**（不静默）
3. **一账号一 poller**（机械可观测：同账号不出现两个轮询者）
4. 订阅表里**目标不存在**（CCC ／ 角色 ／ 账号三种）⇒ **响亮报错**

**会话侧**
5. 入站命中 ⇒ 落到 `(CCC, 角色)` 的 skiff 会话；**未命中 ⇒ 不投递 ＋ 留痕**
6. **订阅不推断**：建了 skiff 但不在表里的 CCC ⇒ **收不到**（＋正控：加进表就收得到）
7. 同一用户多行 ⇒ **多个独立会话**，互不串
8. 跨 CCC dispatch ⇒ 目标 CCC 的**唤醒表**出现条目 ⇒ 到点投递（＋冷会话自动载入）
9. 冷主控 ⇒ **稳定错误码**，不是静默超时
10. 一条消息**只落一份**日志（不再重复）

**工具面**
11. 非主控调 `dispatch` ⇒ 拒绝 ＋ 目标**未被投递**（＋正控：主控调则真投递）
12. `peek` **只能**返回结构化字段；**无"取正文"入口**（T2 结构上不存在）
13. 自述含两句定位，且**不含**四类禁止措辞
14. `container_trajectory` **仍无跨根**（回归钉）

---

## 8. 风险与回退

| 风险 | 缓解 |
|---|---|
| 配置上移期间**微信中断** | 过渡期允许并存（Q5）：机器级为空时退回按 CCC 起桥 ⇒ **不打断你现在正在用的微信** |
| 任何 CCC 都能给 owner 发消息（噪音） | `sending.allow` 白名单 ＋ 留痕 |
| 主控是单点 | 明确信号 ＋ （可选）备用主控？**倾向不做**（单点是你要的形态） |
| 旧配置残留造成"以为生效" | **启动警告**（§2.4） |

---

## 9. 不做项

- ❌ 不给 `container_trajectory` 加跨根（特权只从 im-bridge 出去）
- ❌ 不做 T2（任意读）—— **结构上没有入口**
- ❌ 不按 CCC 各起 poller
- ❌ 不做"多 CCC 各自应答"（每 CCC 一个会话房间）
- ❌ 不把"跨 CCC 派活"做成实时对话（它是 fire-and-forget ＋ 事后 peek）
- ❌ 不改 `im-bridge` 这个工具名（工具 vs 机制的关系，改名是 D61 类硬切，另议）

---

## 10. 🔴 待你拍（Q1~Q8，可一次答完）

| # | 事项 | 我的倾向 |
|---|---|---|
| **Q1** | 跨 CCC 能力**只从 im-bridge 出去** | **是** |
| **Q2** | 主控闸：**运行期拒绝**（单工具）vs **域级不可见**（拆两个工具） | **运行期拒绝** |
| **Q3** | 凭据落点 | **插件 Config（机器级）** |
| **Q4** | 跨 CCC 审计落点 | **机器级** |
| **Q5** | 过渡期：机器级为空 ⇒ **退回按 CCC 起桥** | **允许**（不打断在用的微信） |
| **Q6** | 是否提供**自动迁移建议**（读旧配置 → 打印建议值，不自动写） | **提供** |
| **Q7** | 谁能"发给人"：所有 CCC vs 仅主控 | **所有 CCC**（＋可选白名单） |
| **Q8** | 订阅表改动是否**热生效** | 倾向**热生效**（沿用 `fiber.update()` 的既有语义）；做不到就**明确要求重启并给信号** |

---

## 11. 🔴 定案（owner 2026-09-26「有道理，我都同意，开工吧」）—— 本节**取代** §4.1／§4.2 与 §10 的 Q2

### 11.1 工具面：**拆两个工具**（原"运行期拒绝"被否）

| 工具 | 中文 | 谁有 | 动作 | 判据 |
|---|---|---|---|---|
| **`human-channel-pager`** | 传呼机 | **所有 CCC** | `send` ／ `send-file` ／ `users` ／ `status` | 传呼机的语义**天然就是**"单向、发出去、没有回音" —— 而人正是**唯一没有读通道的端点** |
| **`human-channel-console`** | 控制台 | 🔴 **仅主控** | `peers` ／ `peek` ／ `dispatch` | 保住"控制器"的**设备感**；不叫 `controller` 是因为**它已有主**（宿主 `sessionController`／agent loop 一族），会被读成"控制本会话" |

🔵 **拆两个的额外收益**（原 Q2 没解决的问题）：**主控闸从"运行期拒绝"升级为"不可见"** ——
`console` 对非主控**根本不注册**（沿用既有 `ctx.tools.restrict` 通道）⇒ **看不见 > 会被拒**（与既有可见性纪律一致）。

**工具面计数**：`im-bridge` 退役 ⇒ **11 − 1 ＋ 2 = 12**（净 +1）。

### 11.2 🔴 硬切与迁移（owner 同意取 D61 先例：**硬切无别名**）

| # | 处 | 后果 ／ 动作 |
|---|---|---|
| 1 | `skiff.roles.<role>.tools` 白名单里的 `im-bridge` | 🔴 **名字匹配** ⇒ 旧名留在里面 = **该角色看不到新工具**。**fail-closed ⇒ 坏了立刻看见**（不是静默失效）⇒ 同批更新 CCC 侧白名单 |
| 2 | skill 文档 ／ 面板文案 ／ 本方案 | 措辞同步 |
| 3 | 任何引用 `im-bridge` 的 CCC 侧位置 | 同 1 |
| 4 | 🔴 **回归钉** | **旧名不再被注册**（`im-bridge` 在工具清单里 **零命中**）—— 退役必须留钉 |

### 11.3 Q1~Q8 全部裁决

| # | 裁决 |
|---|---|
| **Q1** | ✅ 跨 CCC 能力**只从 `human-channel-console` 出去**（`container_trajectory` 不加跨根） |
| **Q2** | ✅ **改判：拆两个工具**（见 §11.1）—— 原"运行期拒绝"作废 |
| **Q3** | ✅ 凭据落 **插件 Config（机器级）** |
| **Q4** | ✅ 跨 CCC 审计落 **机器级** |
| **Q5** | ✅ 过渡期**允许**"机器级为空 ⇒ 退回按 CCC 起桥"（不打断在用的微信） |
| **Q6** | ✅ 提供**自动迁移建议**（读旧配置 → 只打印，不自动写） |
| **Q7** | ✅ **所有 CCC 都能发给人**（`pager` 对全体可见）＋ 可选 `sending.allow` 白名单 |
| **Q8** | ✅ 订阅表改动**热生效**（沿用 `fiber.update()`）；做不到则明确要求重启并给信号 |

### 11.4 开工顺序（按 §6 分期，逐件一门禁一提交）

**P0（不动工具面，风险最低）**
1. 机器级 schema `humanChannel` ＋ 投影（`settings-section`）＋ 单测（缺省／优先级／旧键忽略）
2. poller 按账号起（一账号一 poller）＋ 判据
3. 订阅表 ＋ 路由改造（未命中不投递 ＋ 留痕；目标不存在 ⇒ 响亮报错）
4. 迁移警告 ＋ 迁移建议打印
5. 面板演进为 `HumanChannelEditor`

**P1（工具面）**
6. 拆两个工具 ＋ 注册／可见性 ＋ **旧名回归钉**
7. `console` 三动作（`peers` ／ `peek` ／ `dispatch`）＋ 主控指定 ＋ 机器级审计
8. 自述两句 ＋ 四类禁止措辞的文本断言
9. CCC 侧白名单与文档同步

**P2**
10. 第二个渠道实现（飞书桥或邮件桥）—— 验证"可替换"不是空话

