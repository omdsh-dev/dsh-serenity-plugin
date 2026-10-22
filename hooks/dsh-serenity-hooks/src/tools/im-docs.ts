/**
 * tools/im-docs.ts — 「IM 桥怎么用、怎么配路由」的**手册正文**（2026-10-22）
 *
 * ## 为什么需要这一章（owner 原话）
 *
 * 「我在测试飞书，发现 ACC 没提供 IM 桥使用说明和账户查询方法，**导致 CCC 没办法自己配路由**，
 *  这个要完善下」＋「配路由需要的是**账户到轨迹**，轨迹 CCC 知道，**账户 CCC 不知道**，
 *  需要有个能力让 CCC 查询用户配好的账户」。
 *
 * ⇒ 两件事被同时指出来：**没有说明面**（只能猜配置形状）＋ **没有查询面**（拿不到对方 id）。
 * 后者已由 `im-bridge action=contacts` 兑现；本章补前者。
 *
 * ## 🔴 写这一章时守的两条纪律
 *
 * 1. **只描述已经建成的东西**（D179）：本章出现的每个字段、每个动作，都必须在实现里存在。
 *    写"打算做"的功能进手册 = 教用户按图施工然后把自己锁死。
 * 2. **指针从读者真正打开的那个工具发出**（D178）：读这一章的人是 **CCC 的 agent**，
 *    它手边常用的入口是 `im-bridge`（工具描述已指向本章）。⛔ 不能只藏在 container_admin 里。
 */

export const IM_BRIDGE_GUIDE = `# IM 桥（im-bridge）—— 怎么用、怎么配、怎么查

## 一、它是什么

一个 CCC 通过 IM 渠道（微信 / 飞书）跟家人收发消息的能力。
**只作用于本容器**——没有"目标容器"参数（跨 CCC 发送不在能力面）。

工具在**未配置任何 IM 渠道时根本不可见**（不是"看得到但被拒"）。
⇒ 你看到这个工具，说明本 CCC 已配了至少一个渠道。

## 二、五个动作

| 动作 | 用途 | 关键参数 |
|---|---|---|
| \`send\` | 发一条文本 | \`user\`（对方）＋ \`text\` |
| \`send-file\` | 发本容器内的一个文件 | \`user\` ＋ \`file\`（**CCC 根相对路径**）＋ 可选 \`caption\` |
| \`users\` | 已配的**别名**表 | — |
| \`status\` | 渠道健康 ＋ **账号** ＋ **当前路由**（含每条路由的目标是否存在） | — |
| \`contacts\` | **跟本容器有过往来的人**（含对方 id）＋ 未配路由的 ／ 配了却没往来的 | — |

⚠️ 渠道不一定支持全部动作（例如飞书目前不支持 \`send-file\`，会如实返回 \`ACTION_UNSUPPORTED\`）。
**如实返回"不支持"比假装支持好**——后者会得到一条"发出去但对方收不到"的静默故障。

## 三、🔴 配路由：先 \`contacts\`，再写，再 \`status\` 自检

路由的形状（\`.opencode/serenity.json\` 的 \`im.routes\`）：

\`\`\`json
{
  "im": {
    "enabled": true,
    "accounts": [
      { "accountId": "wechat-1", "channel": "weixin", "enabled": true },
      { "accountId": "feishu-1", "channel": "feishu", "enabled": true }
    ],
    "routes": [
      { "user": "o9cq…@im.wechat", "trajectory": "zhaocai-xingzai" },
      { "user": "ou_xxxxxxxx",     "trajectory": "llm-intel" }
    ]
  }
}
\`\`\`

- \`user\` = **对方在该渠道内的 id**（不是我们的账号，也不是别名）
  · 微信：形如 \`xxx@im.wechat\`
  · 飞书：形如 \`ou_…\`（open_id）
- \`trajectory\` = **认知轨迹编码**（目录名里那一段，如 \`S142\` / \`llm-intel\`）
- \`*\` 可作为 \`user\` 的**通配兜底**（exact 优先）

### 那个 \`user\` id 从哪里来 —— 这是本节存在的原因

**你不知道对方 id，而它也不在任何配置文件里。** 它只出现在聊天记录中。
⇒ 用 \`im-bridge({channel:"weixin", action:"contacts"})\`，它会给出：

\`\`\`json
{
  "contacts": [
    { "channel": "weixin", "userId": "o9cq…@im.wechat", "accountIds": ["wechat-1"],
      "route": null, "firstSeen": "2026-09-04T…", "lastSeen": "2026-10-22T…", "messages": 1284 }
  ],
  "unrouted":     ["o9cq…@im.wechat"],
  "orphanRoutes": ["ou_typo_never_seen"],
  "sources":      ["AGENT_SESSIONS/_im-logs/weixin/2026-10-22.jsonl", "…"]
}
\`\`\`

三行输出**各有用途，缺一行这个动作就只剩"列名字"**：

| 字段 | 含义 | 你要做什么 |
|---|---|---|
| \`contacts[].userId\` | 对方 id | **复制它**填进 \`routes[].user\` |
| \`unrouted\` | ⚠️ 有往来、但**没配路由** | 这些人的消息现在**无处可去** ⇒ 这就是该配的 |
| \`orphanRoutes\` | ❓ 配了路由、但记录里**从没出现过** | 大概率 **id 写错**（或从未有人发过） |
| \`sources\` | 实际读过的文件 | **否定性结论的可信度上限** = 这个列表；它空着就别下"没人"的结论 |

### 写完怎么自检

\`im-bridge({channel:"weixin", action:"status"})\` 的 \`routes[]\` 每条都带 **\`targetExists\`**：

- \`true\` ⇒ 该轨迹目录真实存在，路由**有机会**生效
- \`false\` ⇒ **轨迹编码写错了**（或那条轨迹已被归档/删除）

🔴 这一格是"配了不生效"的**唯一机械信号**：写错一个编码**不会有任何报错**，
消息进来找不到目标就静默不投递，你只会看到"没回音"。

## 四、多账号 / 多渠道

一个 CCC 绑多个账号是常态（owner 2026-10-22：「一个 CCC 绑定多个账户很常见」）。

- **账号**在 \`im.accounts[]\`，每条自带 \`channel\`（缺省 \`weixin\`）
- **路由是通道无关的**（\`user → trajectory\`）；同一轨迹可以被多个渠道的对端指向
- \`contacts\` 的每条带 \`accountIds\`（该对端被哪些账号收过）——**多账号靠它区分**
- 发消息时可用 \`account\` 参数指定用哪个账号（缺省：第一个启用且已绑定的）

## 五、聊天记录落在哪

\`\`\`
AGENT_SESSIONS/_im-logs/<channel>/<YYYY-MM-DD>.jsonl
\`\`\`

- 按**渠道**分目录（\`weixin\` / \`feishu\`），按**本地自然天**分文件，逐行 JSON 追加
- 老路径 \`AGENT_SESSIONS/_weixin-logs/\` 是**同一族的前代**（2026-10-22 之前的微信记录）；
  读侧**两个都认**，⛔ 但**只往新路径写**
- 每条事件带 \`channel\` 字段 ⇒ 飞书事件不会再混进微信目录（此前会，目录名会说谎）
- 媒体的持久副本在 \`_im-logs/<channel>/media/<日期>/\`

⚠️ **记录归 CCC**（\`im.hook\` 指向本容器的脚本），ACC 不认识存储格式 —— 这层分离是有意的。

## 六、出错时

工具返回**稳定错误码 + 可行动提示**，常见的：

| 码 | 意思 | 怎么改 |
|---|---|---|
| \`CHANNEL_NOT_CONFIGURED\` | 本 CCC 没启用该渠道 | 看提示里的**那一半**（总开关 vs 缺账号，两者改法不同） |
| \`ALIAS_UNKNOWN\` | \`user\` 既不是已配别名、也不是合法的裸 id | 先 \`action=users\` 看别名，或用 \`contacts\` 拿裸 id |
| \`ACTION_UNSUPPORTED\` | 该渠道没实现这个动作 | 换动作；⛔ 不要重试 |
| \`FILE_ESCAPE\` | \`file\` 跑出了 CCC 根 | 用容器内相对路径 |

## 七、边界（明确不做）

- ⛔ 跨 CCC 发送（只作用于本容器）
- ⛔ 修改配置（\`contacts\` 只读；加路由要人/CCC 自己写 \`serenity.json\`）
- ⛔ 判断"对方读没读"——记录只证明**已发出**
`
