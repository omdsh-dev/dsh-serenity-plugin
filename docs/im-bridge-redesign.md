# im-bridge 改进设计（实现级 · 待确认）

> **状态**：🟡 **待 owner 逐条确认**（owner 2026-09-26："细化具体的 im-bridge 改进设计，我需要完整的理解你的修改，确认其准确的实现我的意图"）
> **前置件**：`docs/weixin-acc-layer-design.md`（§8 单主控 ＋ 配置收归 ／ §8.6 订阅表 ／ §9 接口层对等）
> **本件的用途**：把那条设计落到**可逐条核对**的粒度 —— ① 你的每句意图 → 对应哪个设计元素 ② 逐处改动 ③ 参数面 ④ 安全闸 ⑤ 迁移 ⑥ 验收判据。

---

## 1. 基线：im-bridge **今天**长什么样（逐字取证）

| 面 | 现状 |
|---|---|
| 工具名 | `im-bridge`（ACC 工具，v1.31.0） |
| 动作 | **4 个**：`send` ／ `send-file` ／ `users` ／ `status` |
| 参数 | `channel`（必填）／ `action`（必填）／ `user` ／ `text` ／ `file` ／ `caption` ／ `account` |
| **自述里的关键句** | 🔴 *"this tool only acts on **the current container** (**no target container parameter**)"* |
| 可见性 | **不在工具文件里** —— `seams/context.ts` 在会话就绪时对**未配置通道**的 CCC 调 `agent.ctx.tools.restrict({ deny: ['im-bridge'] })` ⇒ **模型看不到**（而非"看得到但被拒"） |
| 能力层 | `src/im-bridge.ts`（`runImBridge(root, args)`；通道经 `imChannelIds()` 注册） |
| 微信侧 | `weixin-bridge.ts` 桥按 CCC 起（`for entry of listCccs ⇒ syncCccBridge`）；配置读**各 CCC** 的 `.opencode/serenity.json` → `weixin.*`；凭据在**各 CCC** 的 `localstore.json` |

---

## 2. 🔴 意图映射（**请重点核对这张表** —— 这是"是否准确实现你的意图"的判据）

| # | 你的原话（要点） | 落到哪个设计元素 | 在哪一节 |
|---|---|---|---|
| I1 | "微信桥升级到 ACC 层，给每个 CCC 都接上微信" | L1 通道收归 ACC：**一账号一 poller**（机器级） | §4.1 |
| I2 | "会话要绑定某个具体 CCC 的 skiff" | **订阅表**：`(账号, 用户) → (CCC, 角色)`，机器级显式 | §4.2 |
| I3 | "这个 skiff 天然充当我的传话员" | 该 skiff 所在 CCC = **主控**；主控是**表外的一个单独指定** | §4.3 |
| I4 | "这个唤醒只开放给单个 CCC 使用" | **主控闸**：跨 CCC 动作**只对主控开放**（运行期拒绝 ＋ 自述写明） | §5.1 |
| I5 | "扩展 im-bridge 支持跨 CCC 唤醒" | im-bridge 新增 **`ccc` 端点域**（`peers` / `peek` / `dispatch`） | §3 |
| I6 | "微信桥配置收归 ACC 变成机械的东西" | CCC 侧 `weixin.*` **整块消失**；配置住进**插件 Config（机器级）** | §4.1 |
| I7 | "订阅要机器设定（skiff 用途很多）" | 订阅**不得由"有没有 skiff 角色"推断**；表里逐行指定 | §4.2 |
| I8 | "CCC 知道的范围要仔细设计" | **四档 T0/T1/T2/T3**：给 T0+T1+T3，**T2 不给** | §5.2 |
| I9 | "人也是容器之外的独立 trajectory／黑盒" | 自述加**一句** peer-endpoint 定位；反向判据禁服务生语态 | §6 |
| I10 | "用户一旦动作，生态系统多一丝涟漪" | 投递语义 = **fire-and-forget**（无回执、不可回收），与 `send-later` 一致 | §3.3 |
| I11 | "im-bridge 合理的设计就成了关键" | 跨 CCC 能力**只从 im-bridge 出去**（`container_trajectory` **不**加跨根） | §3.1 |

🔴 **若上表任一行与你的意图不符，请直接指出行号** —— 那是本件唯一需要你逐条过的地方。

---

## 3. 能力面：im-bridge 从"对外的嘴"变成"**本容器对外的唯一窗口**"

### 3.1 🔴 一条边界规则（本件的骨架）

> **`container_trajectory` 管「容器内」；`im-bridge` 管「容器外」。**

"容器外"有两个域：

| 域 | 端点 | 有没有读通道 | 谁是主控 |
|---|---|---|---|
| **user 域**（今天就有） | **人**（黑盒 trajectory） | 🔴 **没有** | 不需要主控 |
| **ccc 域**（🆕） | **别的 CCC 的轨迹** | 有（受限，见 T0/T1） | 🔴 **只有主控** |

🔵 **为什么跨 CCC 能力不放进 `container_trajectory`**（与你"扩展 im-bridge"一致）：若两个工具都能跨根，
① 会**两个入口**（多一个真相源）② `container_trajectory` 是**通用**轨迹管理面，给它跨根 = 把特权塞进最常用的工具。
⇒ **特权只从 im-bridge 出去**，`container_trajectory` **保持"只管本容器"**（这条性质本身也是安全资产）。

### 3.2 动作面（新旧对照）

| action | 域 | 参数 | 门控 | 状态 |
|---|---|---|---|---|
| `send` | user | `user` `text` `channel` `account` | 本 CCC 有通道 | 不变 |
| `send-file` | user | `file` `caption` `user` `channel` | 同上 | 不变 |
| `users` | user | `channel` | 同上 | 不变 |
| `status` | — | `channel` | 同上 | 不变 |
| **`peers`** | ccc | — | 🔴 **主控** | 🆕 列本机全部 CCC（名字 ／ 轨迹数 ／ 活跃态）＝ **T0** |
| **`peek`** | ccc | `target` | 🔴 **主控** | 🆕 读目标**结构化状态**＝ **T1**（§5.2） |
| **`dispatch`** | ccc | `target` `text` `at?` | 🔴 **主控** | 🆕 投一条消息＝ **T3**；`at` 给了 ⇒ 排期（同 `send-later` 语义） |

**`target` 语法**：`<ccc 别名>`（整容器）或 `<ccc 别名>/<S###>`（指定轨迹）。别名来自 `listCccs`。
**`at` 语法**：与 `send-later` 同（RFC3339 或 `+30m` 这类相对量）—— **同一套解析，不另造**。

### 3.3 底层：**不新增机制**

| 新动作 | 复用什么（已有） |
|---|---|
| `peers` | `ccc-roots.listCccs`（今天唤醒调度器每 tick 都在用它） |
| `peek` | 目标 CCC 的 SESSION.md 解析（`parseSessionMd` 一族）—— **只取结构化字段**，不返回正文 |
| `dispatch` | **`wake-scheduler` 的投递原语**（`deliverWake` ／ 唤醒表条目）—— 与 `send-now`/`send-later` **同一段代码** |

⇒ 🔴 **投递语义自动继承**：fire-and-forget、无回执、不可回收、冷会话自动载入。
**"涟漪"那条（I10）不是新写的，是本来就这样。**

---

## 4. 配置与数据：全部上移到**机器级**

### 4.1 落点（关键选择）

**插件 Config（宿主 `serenity-hooks` 命名空间）本身就是机器级的** —— 这是现成的家，不必新造文件。

| 面 | 今天 | 改后 |
|---|---|---|
| 账号列表 ／ 启用位 | 各 CCC `serenity.json` → `weixin.accounts` | **插件 Config（机器级）** |
| 凭据（token ／ userId） | 各 CCC `localstore.json` | **插件 Config（机器级）**（§4.4 待确认） |
| 轮询 | 按 CCC 各起一份 | **一账号一 poller（机器级互斥）** |
| 路由 ／ 订阅 | 各 CCC `weixin.routes` | **机器级显式表**（§4.2） |
| 主控指定 | — | **机器级（人设）** |
| **skiff 角色定义** | CCC `.opencode/skiff/*.md` | 🔴 **仍归 CCC**（措辞归 CCC —— D23） |
| 消息落盘 | 各 CCC `_weixin-logs/` | **仍落"被路由到的那个 CCC"**（见 §4.5） |

### 4.2 订阅表（机器级显式）

```
(账号, 用户) → (CCC, 角色)
   wechat-1, yh      → home-serenity / zhaocai
   wechat-1, danica  → home-serenity / zhaocai
   wechat-1, <某人>   → tiangong-serenity / <某角色>      ← 一个账号可落到不同 CCC
```

- 🔴 **不得推断**（owner 更正）：**"有没有 skiff 角色" ≠ "订阅"** —— skiff 用途很多，不能因为建了个 skiff 就被接上微信
- 一个 CCC **可以有多行**（多个角色参与）—— 对上"skiff 用途很多"
- 🔴 **目标不存在（CCC ／ 角色 ／ 账号）⇒ 响亮报错**，不静默丢弃（"我明明配了却没人答"必须能查）

### 4.3 主控指定（机器级）

- **一行**：`relay: <ccc 别名>`（＋ 可选 `relayRole`）
- 🔴 **只能在机器级设，CCC 不得自声明**（自声明 = 自己给自己发通行证）
- 🔴 **冷主控要有明确信号**：主控无 live 会话时，跨 CCC 调用返回**稳定错误码**（不是静默超时）

### 4.4 待确认：凭据放哪

| 选项 | 利 | 弊 |
|---|---|---|
| **A. 插件 Config（推荐）** | 现成的机器级位 ／ 面板可编辑 ／ 与"凭据非密（私有内网）"一致 | token 会出现在 `~/.dsh/profiles/**/cordis.patch.yml`（机器级文件） |
| B. 新建机器级 localstore | 与 CCC 的 `localstore.json` 形态一致 | **新造一个真相源**（多一个要维护的东西） |

### 4.5 落盘与审计（两条已解／待确认）

- ✅ **重复落盘问题自动消失**：一账号一 poller ⇒ 一条消息**只被投递一次** ⇒ 只落一份（落在**被路由到的那个 CCC**，`_weixin-logs/` 的既有语义不变）
- 🆕 **审计（待确认落点）**：跨 CCC 动作**必须留痕**（谁在何时触达了哪个 CCC 的哪条轨迹）—— 建议落**机器级**（目标 CCC 看不到调用者是谁）

---

## 5. 安全闸（两层，都不依赖"自觉"）

### 5.1 第一层：主控闸

- 位置：**im-bridge 的 `ccc` 域入口**（唯一入口，见 §3.1）
- 判据：本会话所在 CCC **是**机器级指定的 `relay`
- 失败形态：**运行期拒绝** ＋ 稳定错误码（如 `NOT_RELAY`）＋ 自述**明写**该前置条件
- 🔴 **为何用"拒绝"而非"不可见"**（待你定，见 Q2）：im-bridge 对主控**也必须可见**（它还要给人发消息）⇒ 整工具不能隐藏；**域级隐藏**在现有机制里做不到（工具描述是静态的）

### 5.2 第二层：能力分档（T0~T3）

| 档 | 内容 | 给不给 | 落点 |
|---|---|---|---|
| **T0 存在与身份** | CCC 列表、别名、轨迹清单、活跃态 | ✅ | `peers` |
| **T1 状态摘要** | 目标的**结构化状态**（§当前状态 ／ 待裁清单） | ✅ | `peek` |
| **T2 任意读** | 目标 CCC 内**任意文件正文**（SESSION 全文 ／ 代码 ／ **凭据**） | 🔴 **不给** | **无此动作**（结构上没有入口） |
| **T3 动作** | 投一条消息 ／ 排期投递 | ✅ | `dispatch` |

🔴 **T2 是"不给"，不是"给了但限制"** —— **结构上没有这个动作**，所以不存在"绕过去"的问题。

---

## 6. 自述（唯一"哲学落地"的地方，压成一句）

**在现有功能描述之外加这一句**（其余保持功能口径，不加散文）：

> Deliver one message to a **person — the peer endpoint of this channel**. Treat them as a peer, not a notification target: their state is a **black box** (we have no read channel to a person), they act on their own schedule, and delivery is **fire-and-forget** (no receipt, no recall).

**另加一句说明 `ccc` 域的性质**（因为它是新面且受门控）：

> The `ccc` domain addresses **other containers** (peers outside this one) and is available only to the designated relay container; calls from any other container are refused.

**反向判据（自述里不得出现）**：
- ❌ `notify the user` ／ `report to the user` ／ `alert the owner`（**服务生语态**）
- ❌ "the user is just another trajectory"（**过度延伸**：权限轴上不成立）
- ❌ 任何暗示"我们能读人的状态"的措辞
- ❌ 把 `ccc` 域说成"任意读"（**它是 T0/T1/T3，没有 T2**）

---

## 7. 兼容与迁移

| 项 | 处置 |
|---|---|
| CCC 侧 `weixin.*` 旧键 | **静默忽略**（同 `wakeSchedulerEnabled` ／ `rebuildEnabled` 的处置先例）；**不报错**（旧配置不会让容器起不来） |
| 今天的 per-CCC 桥 | 过渡期**允许并存**（机器级表为空时，退回按 CCC 起桥）⇒ **不打断你现在正在用的微信** |
| `container_trajectory` | **不改**（不加跨根 —— §3.1） |
| 工具可见性 | 沿用今天的判据（本 CCC 有通道 ⇒ 可见）；**`ccc` 域额外受主控闸** |

---

## 8. 不做（明确）**

- ❌ 不给 `container_trajectory` 加跨根（特权只从 im-bridge 出去）
- ❌ 不做 T2（任意读）
- ❌ 不按 CCC 各起一个 poller（要消掉的就是这个）
- ❌ 不做"多 CCC 各自应答"（每个 CCC 一个会话房间）—— 你要的是**一个传话员**
- ❌ 不新建机器级文件（配置住进现成的插件 Config；除非 §4.4 选 B）

---

## 9. 验收判据（预登记，实现后逐条承重）

1. **一账号一 poller**：同一账号在两个 CCC 都"想接"时，**只有一个 poller**（另一处不重复收）
2. **主控闸**：非主控 CCC 调 `dispatch` ⇒ **稳定错误码**且**目标未被投递**（＋正控：主控调则真投递）
3. **T2 不存在**：`peek` **只能**返回结构化字段；任何"取正文"的入参形态 ⇒ 参数错误（**结构上没有该入口**）
4. **订阅不推断**：一个建了 skiff 但**不在表里**的 CCC ⇒ **收不到**微信消息（＋正控：表里加了才收得到）
5. **目标不存在 ⇒ 响亮报错**（CCC ／ 角色 ／ 账号三种缺失各一条）
6. **冷主控有信号**（不是静默超时）
7. **旧配置静默忽略**：`weixin.*` 残留在 CCC 配置里 ⇒ 不报错、不生效
8. **自述含定位句**且**不含**四类反向措辞（文本断言）
9. **`container_trajectory` 无跨根**（回归钉：它的 target 解析仍只在本容器）
10. **落盘不重复**：一条消息只在该消息**被路由到**的那个 CCC 的 `_weixin-logs/` 出现一次

---

## 10. 🔴 待你确认（Q1~Q5，可一次拍完）

| # | 事项 | 我的倾向 |
|---|---|---|
| **Q1** | 跨 CCC 能力**只从 im-bridge 出去**（`container_trajectory` 不加跨根） | **是**（单入口、通用工具不背特权） |
| **Q2** | 主控闸用**运行期拒绝**（单工具）还是**域级不可见**（拆成两个工具，`ccc` 域那个只对主控可见） | **运行期拒绝**（工具面不增；拒绝响亮且有稳定码） |
| **Q3** | 凭据落点 | **插件 Config（机器级）**（§4.4 A） |
| **Q4** | 审计留痕落点 | **机器级**（目标 CCC 看不到调用者） |
| **Q5** | 过渡期是否允许"机器级表为空 ⇒ 退回按 CCC 起桥" | **允许**（不打断你现在正在用的微信） |
