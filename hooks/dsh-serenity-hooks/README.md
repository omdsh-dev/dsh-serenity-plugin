# 宁静号 ACC —— 给 DeepSeek Harness 装一个「AI 工作区」

> **一句话**：本插件为 AI 指定一个普通目录作为其工作区，
> AI 在其中工作时即获得**记忆、纪律、工具和边界**——中途更换模型、重启电脑、次日再来，均可继续。
>
> 适配 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（下称 DSH）的**三条发布线**：
> `0.1.7-rc.1` ／ `0.2.0-rc.1` ／ `0.2.1-rc.1`（声明为 `^0.1.7-rc.1 || ^0.2.0-rc.1 || ^0.2.1-rc.1`，三档并行支持）。
> 设计动机（为何称"认知容器"）见 [docs/cognitive-container-theory.md](https://github.com/tellmewhattodo/dsh-serenity-plugin/blob/master/docs/cognitive-container-theory.md)；本 README 只述**能做什么、怎么用**。

**术语定义**（后文沿用下列术语，不再重复解释）：

| 术语 | 释义 |
|---|---|
| **工作区 / CCC** | 一个目录，内含一个空的 `.serenity` 标记文件。DSH 在其它目录运行时，本插件不介入；进入此类目录后自动生效 |
| **插件 / ACC** | ＝ 本仓库（npm 包 `@shgroup/dsh-serenity-hooks`）。为 DSH 增加工具、约束与记忆 |
| **MSM** | 编写在工作区内的可执行小工具（一个脚本 + 一行注册）。AI 通过 `msm("名字", ["参数"])` 调用它们 |
| **SESSION.md** | 工作区内的"工作日志"。AI 将目标、决定、进度写入其中；中断后再启动即从此处继续 |

---

## 1. 它解决什么问题

直接给出四个日常场景的对照：

| 场景 | 未安装 | 安装后 |
|---|---|---|
| **AI 中途遗忘自身目标** | 上下文一满，先前的目标与决定全部丢失，须重新交代一遍 | 每个工作区有一本工作日志，AI 每推进一段即写入；上下文满则"更换载体"重来，日志留在原地，工作继续 |
| **AI 越界读取与修改文件** | 它可读取整台机器的文件，包括密钥 | 工作区有围墙：墙内可用，墙外一律拒绝；密钥文件连"读"都不可达 |
| **外出使用** | 只能坐在那台电脑前 | 自带带登录的网页入口（密码或手机验证码二选一），手机可用 |
| **家人经微信提问** | 须教他们安装软件、开启电脑 | 扫一次码接入微信后，家人在微信中发言，AI 以配置的人格回话 |

---

## 2. 快速开始（2 分钟）

需要 Node ≥ 20（或 bun），以及 DSH 0.1.7 或 0.2.0 任一发布线。

```bash
# 1. 装插件（自动加入 DSH 的 web profile）
dsh plugin --profile web add @shgroup/dsh-serenity-hooks

# 2. 重启 dsh web（插件和网页端界面一起生效）
dsh web

# 3. 验证：进到带 .serenity 标记的目录里开一个会话
#    · 会话开头会自动带上这个插件的身份说明和技能目录
#    · 网页端会话标题旁出现一个状态胶囊（绿点常亮 + SAFE 滑块）
#    · 输入 dashboard health，看到工作区三项检查全通过
```

卸载：`dsh plugin --profile web remove @shgroup/dsh-serenity-hooks`

从源码安装（改代码时使用）：

```bash
git clone https://github.com/tellmewhattodo/dsh-serenity-plugin.git
cd dsh-serenity-plugin
dsh plugin --profile web add link:$(pwd)/hooks/dsh-serenity-hooks
```

> ⚠️ 不得使用 `dsh plugin add github:...`：该地址指向仓库根目录，非插件包本身，安装后不生效。**改用 npm 或上面的 `link:` 方式。**

**安全模式**：拨动网页端胶囊中的 SAFE 滑块后，`bash` 即从 AI 的工具清单中**移除**——AI 看不到该工具，也无法调用。开关归使用者：AI 看不见、也打不开。（机制细节见 [§3.2](#32-机械约束ai-绕不过去)。）

---

## 3. 安装后新增的能力

### 3.1 十四个工具（其中三个按条件出现）

| 工具 | 功能 | 使用场景 |
|---|---|---|
| `container_fs` | 在工作区内管理文件：列目录、查找、复制、移动、新建、追加、在文件管理器中打开 | 需要查看或整理工作区内文件时 |
| `container_trajectory` | **一条轨迹**：其身体（SESSION.md）+ 其时间轴。除建/看/切换/原地重建外，还可登记**未来唤醒**与**即时递话** | 任何多步骤工作，第一步即调用它；需要 AI 在未来某刻自动继续时也用它 |
| `dashboard` | 仪表盘：工作区健康检查（三项）、当前时间、等待 | 进入工作区后先行自查；等待外部服务时使用 |
| `container_git` | git 操作：status / commit / push / log / pull / diff | 提交与推送代码；它绝不自动强推 |
| `msm` | 小工具执行入口：`msm("名字", ["参数"])`；名字记不全时返回候选；`inspect=true` 查看用法 | 调用工作区内已注册的任何小工具 |
| `praxis` | 按需向 AI 注入四套"做事方法"：输出自检（eap）、设计对齐（neat）、认知连续性（cce）、本体工程（ontology） | 需要它把话说清楚 / 先对齐再动手 / 动手前先把领域结构显式化时 |
| `ontology` | 本体工程**引擎**（可执行者）：读取 `.ttl` 本体文件，执行结构校验、生成摘要、检查"声明与实况是否一致"、输出语义审查提示词、输出合规清单，并可写入一份新本体模板 | 需要为某个领域建立或校验本体时。⚠️ 与 `praxis ontology` 是**同一领域的两个面**：前者提供**方法文本**（如何建模），后者**实际执行检查**。路径必须在工作区内 |
| `serenity-skill-creator` | 增强型技能标准（serenity-skill）的创建器：`guide` 编写方法 / `create` 生成骨架（基础链路径由它算）/ `check` 结构检查（三态可分辨：已建模通过 · 普通技能 · 建模了但检查未执行）/ `review` 逐条合规问题清单 / `index` 预览**模型实际会看到**的参考件清单 / `status` 全容器一览 | 新建或改造技能、为技能建本体、需要确认"模型究竟能否看到指定参考件"时 |
| `cheap-worker` | 杂工：委派一个低成本模型的助手执行任务，取回其最终文本。一次调用一个串行子代理；`jobs` 可一次扇出多个并行（上限 10）。**不循环、不校验完成码、不写进度文件** | 大批量、重复性的工作（扫描数十个技能、逐用例回归） |
| `localstore` | 存储密钥与配置（凭据、偏好两个命名空间） | API key、密码集中放一处，不进 git |
| `container_admin` | 机务舱：管理子角色、管理小工具注册表、查看全部配置 | 定义"子角色"、注册新小工具、修改配置时 |
| `im-bridge` | 向 IM 联系人发消息（目前为微信）：发文本、发文件、查已配置联系人、查通道状态。每次成功发送自动写入工作区的消息记录 | 需要 AI 主动给家人/同事发消息时（见 §6.2）。**条件出现**：仅在工作区配置了微信桥时可见 |
| `acc-diag` | ACC 运行态诊断：一次调用输出全报告——当前活跃会话数、各自所属工作区、唤醒时钟的武装态与 tick 次数、唤醒登记表的每一条 | **ACC 维护者专用**。**条件出现**：默认对所有工作区隐藏，仅在工作区配置中点名（`exclusiveTools`）时出现 |
| `diagram` | 绘图：AI 给出一段**标签式源码**，插件**在进程内**将其绘制为 PNG 并**贴入对话**——不启动浏览器、不截图、正常路径不落文件。坐标 = 画布像素、y 向下；写错的图元逐条报错并跳过，其余照常绘制；自带四项检查（块重叠 / 标签溢出 / 悬空端点 / 线压字），**只告警不拦图** | 需要把关系图/示意图直接放进对话时。**条件出现**：实验性 demo，**默认关**（关闭时该工具**根本不注册**，AI 看不到它、不占上下文）；开关在设置面板「工具」组，拨动即时生效。中英文与常用符号均可绘制，因字体随插件内置（约 5 MB） |

> **更名记录**（旧名已彻底停用，无兼容别名；旧会话中出现旧名时，**一律取所在那一组的末项**）：
> `cc_fs` → `container_fs` · `cc_git` → `container_git` · `session`+`session_rebuild` → `logbook` → `trajectory` → **`container_trajectory`**（今名） ·
> `acc_kit` → `dashboard` · `acc_msm` → `msm`（执行）+ `container_admin`（管理） · `eap`/`neat`/`cce` → `praxis` ·
> `skiff_admin` → `container_admin role` · `autopilot-trajectory` → `trajectory` → **`container_trajectory`**（今名）。

### 3.2 机械约束（AI 绕不过去）

这些不依赖提示词劝阻，而是**机制上无法执行**：

| 约束 | 可观察到的效果 | 设计理由 |
|---|---|---|
| **安全模式** | bash 从工具列表里消失（每一步都同步一次），即使调用也会被兜底拦下 | 走已注册的小工具，比让 AI 自行拼接 shell 命令可靠 |
| **工作区围墙** | 墙内可用，墙外一律拒绝（路径无法解析） | AI 不应接触工作区之外的内容 |
| **黑名单 / 治理文件** | 黑名单可配置；`.serenity` 等治理文件禁止 AI 写入 | 防止 AI 破坏自身所在的"地基" |
| **密钥文件守卫** | `localstore.json` 对**所有**工具拒绝（包括 read/grep/glob） | 密钥值在结构上无法外流 |
| **对外输出守卫** | 对外向会话（子角色 / 重建会话）若答出敏感词，会被打回重答，并告知命中的词与修改方向 | 外部使用者不应看到内部机制 |
| **轨迹提醒** | 持续一段时间后会提醒 AI"把进度写回工作日志"，并要求它回一个确认码 | 提醒是机制，不依赖自觉 |
| **工作日志体积提醒** | 工作日志（SESSION.md）超过 200KB 时提醒 AI"停下重写"，并附四条重写原则（保留骨架 / 细节移至附件文件 / 可合并的合并 / 其余自行判断） | 日志持续增厚则无人读得完；重写成本低于堆积。阈值按工作区可调（`sessionKeeper.sessionMdMaxKB`，0 = 关） |
| **重建前交接** | 重建上下文前，要求 AI 先把"手头做到哪了 / 还差什么 / 下一步做什么"写入**本轨迹目录下的 `REBUILD-TODO.md`**（固定文件名）；重建后的 AI 首先读取该文件并继续 | 上下文被清空，但在办的事不能丢。该便签是**只用一次的交界材料**：无格式义务、随时可丢；超过 10 KB 会提醒清理（`SCRATCH PRUNE`，整份删除亦可） |

### 3.3 对外的入口

| 入口 | 默认端口 | 使用者 |
|---|---|---|
| DSH 主界面 | 3080 | 本机自用（插件不碰这个端口，也不起这个监听器） |
| **网页登录入口** | 3081 | 外部/手机访问完整界面：登录后反向代理到 3080，可配工作区白名单 |
| **微信主动发送入口** | 3082（只绑 127.0.0.1） | 工作区外的脚本/集成用它给微信发消息（公网不可达，所以不需要密钥）。工作区内的 AI 不走这个端口，直接使用 `im-bridge` 工具 |
| **子角色调试页** | 3099（只绑 127.0.0.1） | 调试"子角色"时使用，可切换工作区、查看对话轨迹 |
| **微信桥** | 无需端口（出站长轮询） | 家人在微信里直接和 AI 说话 |

> 3081 / 3099 **默认关**（须自行开启）；3082 **默认开**（微信桥启用时才有意义）。默认只监听 127.0.0.1 的入口，如需暴露到公网，由使用者自行决定方式（隧道 / 反代 / 端口映射都行），插件不绑定任何特定做法。

> 🔴 **已退役：原「ACP + 对外问答页」（3100）**。该面是本插件早期自造的一套私有 HTTP＋HTML 协议外壳
> （无客户端生态），已于 2026-10-15 **整体移除**（连同 `acp-core` / `acp-http` 与相关开关、问答页 key）。
> **要程序化或从手机/远程接入，走宿主自带的官方 ACP server**：`dsh --profile acp` 起一个纯 stdio、
> 零认证的 ACP 服务，再由任一现成 ACP 客户端（编辑器如 Zed；手机端如 Agmente、ACP UI）连接。
> 认证落在**接入层**（隧道 / 反代 / Cloudflare Access），不再由本插件发放 key。

### 3.4 自动配置：用 opencode 的模型

要在 DSH 里用 opencode 的网关（`opencode.ai/zen`），本来除了配路由还得手抄一串请求头——
这些头是 opencode 用来做**会话亲和路由**的，少写一个 `x-opencode-session`，`/zen/go` 面就直接 400 拒绝。
**插件装好就自动配**，无需手工操作：

| 使用情况 | 插件行为 |
|---|---|
| 已经配了 opencode 路由，但缺头 | 只补缺的那几个；**手写过的值一律不动**（头名不分大小写，`X-Title` 和 `x-title` 一样算数） |
| 一个 opencode 路由都没有，但环境里有 `OPENCODE_API_KEY` | 自动建 `opencode-go` 路由并带全头（没有 key 的人不受影响，不会平白多出一组模型） |

- **只管"会话族"的头**：`x-opencode-session` / `X-Session-ID` / `x-opencode-client` / `x-opencode-project`。
  前两个名字是**同一个值的两个别名**——写了其中一个，即以**该值**补上另一个，不会出现两个互相冲突的会话 id
- **注入范围以接口要求为界**：`/zen/go` 缺会话族头即返回 400，故补齐；
  `X-Title` / `HTTP-Referer` 属客户端身份头，不在接口要求之内，故不注入。
  `User-Agent` 是 DSH 的保留名，想注也注不了
- **会话标识是固定的**（`dsh-serenity`）：DSH 的请求头在路由解析时一次算好，只能给静态值。
  优势是同一台机器的请求稳定落同一个上游（对缓存友好）；代价是无法做到"按会话分区"
- **写入的是使用者自己的文件**：写入 DSH 的 settings（`llm-pi-ai.providers.<路由>.headers`），随时可改可删。
  不需要这个自动配置时，关闭本插件的 `opencodeProvider.autoConfigure`（关闭后一切回到手抄）
- **不接触密钥**：插件只补路由和头，`OPENCODE_API_KEY` 放环境变量即可

---

## 4. 一个工作区长什么样

工作区是一个普通目录，外加一个标记文件：

```
my-workspace/                     ← 工作区根目录（放一个 .serenity 就成）
├── .serenity                     ← 标记：这个目录是一个工作区
├── .opencode/
│   ├── serenity.json             ← 工作区级配置：助手模型白名单 / 日志阈值 / 子角色
│   └── skills/                   ← 领域技能（每个技能 = 一个领域的知识 + 可能有小工具）
│       ├── home-media/           ←   例如：媒体（找片源 / 做字幕 / 推送）
│       ├── home-wealth/          ←   例如：家庭财务
│       └── …（每个技能可以自带脚本）
├── AGENT_SESSIONS/               ← 工作日志库：每个目录一本 SESSION.md
│   └── 2026-09-08--S142--xxx/
│       ├── SESSION.md            ← 目标 / 决定 / 进度（永远留在这里，不会被搬走）
│       └── REBUILD-TODO.md       ← 重建前的交接便签（只在需要时存在，可随时丢）
└── _tmp/                         ← 运行时落盘：你粘贴的图片和文件
    ├── images_from_user/
    └── files_from_user/
```

> 🔴 **技能的两层披露**：助手看到的 skill 目录**那一行即带参考件文件名**（插件按文件树即时生成 ⇒ 新增一个文件它自己就更新，**不用手写**）；
> 真要用时它才去 `read` 打开正文 —— **正文不进上下文，除非助手自己去取**。

---

## 5. 12 个真实用例

> 以下用例都在真实部署里运行。地址、账号、路径均作了泛化。

| # | 目标 | 实际路径 |
|---|---|---|
| 1 | **长期项目不断线** | `container_trajectory create` 建轨迹 → 每推进一段写进去 → 中断后 `container_trajectory use` 接上 → 上下文满了 `container_trajectory rebuild` 原地重建并自动继续 |
| 2 | **批量同步代码** | 当前仓库 `container_git commit/push`；多个子仓库一条命令全同步（自动提交 + 推送） |
| 3 | **做一集字幕** | 搜片源 → 下载 → Whisper 转写 → 翻译 → 双语 SRT → 机械质检（7 项）→ 推送订阅/邮件 |
| 4 | **服务器巡检** | 一条命令输出 CPU/内存/GPU/容器/服务报告；重启容器也在同一条白名单通道里 |
| 5 | **内网服务定位** | 仓库全景（分类/技术栈/关联）+ 设备端口扫描 |
| 6 | **家庭财务** | 结构化记录资产/负债/收支/预算，随时查询汇总；房贷利率对比这类宏观跟踪 |
| 7 | **家人档案** | 成员资料统一维护，工作区是唯一真相源 |
| 8 | **想法随手记** | 想到什么就聊，AI 访谈式问清 → 结构化归档 → 定期回顾思考模式 |
| 9 | **手机/外出使用** | 浏览器打开 `http://内网地址:3081` → 输密码或 6 位验证码 → 直接用完整界面 |
| 10 | **粘贴资料自动处理** | 粘图片 → 自动落盘 → 视觉模型识别（快递单/截图/图表）；粘 PDF/压缩包 → 自动落盘 → 提取文本/解压/读表格 |
| 11 | **微信里用 AI** | 面板扫一次码 → 家人在微信发消息（文字/语音/图片/文件）→ 路由到指定子角色 → 回复回到微信 |
| 12 | **定时自动工作** | 给某条轨迹放一段 `continuous-re-occurrence.ts`（CRO，见 §6.5）→ 调度器每 5 分钟问它一次"现在该不该醒、醒了说什么"→ 由**程序**决定何时接着干。也可以让轨迹在每轮结束时自己排下一轮 |

**典型一天**：

```
早上  服务器巡检（一条命令）→ 一切正常
上午  同步昨天的代码 → 子仓库全部推送
午间  收到 PDF 账单 → 粘进对话 → 自动落盘 + 表格提取 → 记进财务
下午  做一集视频字幕（转写 → 翻译 → 双语 SRT → 质检）→ 推送订阅
晚间  手机登录 3081 处理运维（验证码验证）
全程  每段工作都落在 SESSION.md 里 → 轨迹连续，随时换人/换模型/换机器接着干
```

---

## 6. 对外入口详解

### 6.1 网页登录入口（3081）

插件自行启动第二个监听器，请求流程如下：

```
外部浏览器 → http://内网IP:3081
  → 没登录 → 极简登录页（用户名 + 密码，或 6 位动态验证码，二选一；手机端适配）
  → 提交 → scrypt 校验 / TOTP 校验 + CSRF 校验 + 账号失败锁定
  → 通过 → 下发 HttpOnly cookie（SameSite=Strict，24 小时滑动续期）→ 302 跳转
  → 已登录 → 反向代理到 127.0.0.1:3080（改写过 Host/Origin，作为信任栅栏）
  → 工作区列表按白名单过滤 + 新建工作区做校验
  → WebSocket 升级也转发（101 回写 + 双向错误监听，防止连接被压垮）
```

### 6.2 微信桥

工作区级配置（`.opencode/serenity.json` 的 `weixin` 段），**凭据放在工作区的 `localstore.json`**（不以明文进入 git）。
一个 DSH 进程可以同时承载多个工作区，每个工作区各自对接自己的微信。

- **扫码绑定**：设置面板 → 微信桥 → 选工作区 → 扫码（手机微信确认）→ 机器人 token 自动写入凭据
- **多账号**：每个账号独立扫码、独立移除
- **接收内容**：文字、语音（微信服务端自带转写，无需额外识别）、图片、文件
  （图片和文件会从微信 CDN 下载并解密，落到 `_tmp/weixin-inbound/`，随后把路径告知 AI）
- **正在输入**：处理期间微信会显示"正在输入…"
- **回复精简**：自动剥掉思考过程，微信只看到正文
- **会话保持**：同一个微信号对应固定会话，重启后恢复历史，不会"失忆"
- **路由**：微信号 → 子角色（精确匹配优先，`*` 兜底）
- **主动发消息**（v1.31.0）：用 `im-bridge` 工具，AI 自己就能发——
  `im-bridge({channel:"weixin", action:"send", user:"yh", text:"内容"})`
  （发文件：`action:"send-file"` + `file:"<工作区内的路径>"`，可加 `caption`）。
  没有"目标工作区"参数，因此它**发不错容器**；发出的消息会自动被记录（可见性见 §3.1）。
- **由 AI 自行决定回复方式**（v1.30.10）：配置 `"weixin": { "autoReplyWithLastMessage": false }`
  后，插件不再自动把 AI 最后那段话转给用户，而是每轮告知它"你必须自己发"，并附上一条可直接照抄的 `im-bridge` 调用。
  适用于需要过程汇报、想分多条发、或者该安静就安静的角色。默认 `true`（保持原行为）。
  该发却没发时，插件会**打回提醒**（最多 2 次）；还是不发送，可以再开
  `"fallbackOnNoSend": true` 让插件兜底把那轮的话转给用户（记录为 `source: "reply-fallback"`），
  保证"消息不丢"。
- **消息记录**：配一个 `weixin.hook` 脚本，每收/发一条消息就把事件（JSON）交给它，存储位置自行决定。
  记录里 `source: "reply"` 表示"回复用户"，`source: "proactive"` 表示"AI 主动发起"，
  `source: "reply-fallback"` 表示"AI 没发、插件兜底发的"。
- **排障**：`msm("weixin-doctor", ["status"|"diag"|"verify"|"guide"])`

### 6.3 子角色（Skiff）

可以从一个"什么都能干"的助手身上，切出一个**能力受限的小角色**——不只是问答，也可以带操作能力：

```jsonc
{
  "skiff": {
    "roles": {
      "qa": {
        "model": "provider/model",              // 该角色单独用哪个模型
        "msms": ["web-search", "vlm-describe"], // 它能调哪些小工具
        "tools": ["read", "grep", "glob"],      // 它能用哪些平台工具
        "systemPromptFile": "roles/qa.md"       // 它的人格与边界（也可以直接内联）
      }
    }
  }
}
```

- 两份白名单分开配（小工具 / 平台工具），没列出来的一律隐藏
- 调试页（3099）可以切工作区、看轨迹；回答用 markdown 渲染，思考过程折叠
- `container_admin role validate` 校验配置，`apply` 才真正生效

### 6.4 对外接入（官方 ACP）

本插件**不自造** ACP 面。要程序化或远程使用，用宿主自带的官方 ACP server：

| 步 | 做什么 |
|---|---|
| 1 | `dsh --profile acp` —— 起官方 ACP 服务（**纯 stdio、零认证**；首次运行自动建 profile） |
| 2 | 用任一 ACP 客户端连它（编辑器内直接起子进程；手机/远程经桥 + 隧道） |
| 3 | **认证放在接入层**（隧道 / 反代 / Cloudflare Access）——官方 server 自身不做认证 |

> **为什么不再自造**：原 3100 面是一个**没有客户端生态**的私有外壳，而官方件已发布并随宿主同版本演进。
> 详细接法与手机端配置见宁静号 CCC 的接入指南。

### 6.5 轨迹与定时唤醒（trajectory）

`trajectory`（轨迹）是一等概念：一个工作区里可以有任意多条轨迹并行。

**定时唤醒**：用 `container_trajectory send-later` 登记一条"唤醒" = 未来某时刻 + 一条消息——可以给自己预约，也可以唤醒别的轨迹；落在工作区内的 `AGENT_SESSIONS/wake-registry.json`（可读可审计），到点由中心调度器投递，**不阻塞、不等待、也不回执**。

**即时投递**：用 `container_trajectory send-now` 把一条消息**现在**就递过去，并且**不排队**——目标在内存里且**正在跑轮次**，就 `steer` **当场注入当前轮**；目标空闲就**立即起一轮**；目标不在内存里就**冷载入后投递**（**等效于直接唤醒**，但**不等调度器的 5 分钟节拍**）。它**有同步回执**（告知走了 live 还是冷载入），**不落注册表**（那张表专管"未来时刻"）。

- 两者只差两处：**时刻**（现在 / 未来）与**回执**（有 / 无）——"预约"天生是 fire-and-forget（不可回收、不回执），"递话"则是一次调用一次答复。各自语义干净，不把两种语义塞进同一个动作（🔴 更名：原名 `wake-later` / `send-message`，现名 **`send-later` / `send-now`**——族名取共享词干 `send-`，轴取 `-later`/`-now`）
- ⚠️ **回执只到"已注入 / 已起轮"**：它**不表示**目标已经执行或答复。要确证"目标真的动了"，须查看它自己的 `SESSION.md`（**不得凭回执结案**）
- ⚠️ **唯一的例外路径**：`steer` 不可用时**退回排队**（fail-safe：**宁可排队，不可静默丢消息**）——此时回执文案写明"steer 不可用 ⇒ 退回 followup"。**`send-later` 不受影响**：预约的本职是"到点唤起"，在跑时排队不打断当前轮，这一行为已经过实证验收
- **目标没打开也能唤醒**：冷载入不了则条目留在登记表里并记下原因，**不静默丢弃**
- **"周期"归工作区自己**：要一轮接一轮，就由**收到唤醒的那条轨迹**在每轮结束时再排一次下一轮——ACC 只提供"到点投递一条消息"这个原语，不替工作区决定节拍（焦点、节拍、偏见都由工作区自定；任意条轨迹并行、互不干扰）
- **轨迹可以带上 skill**（两种写法，**取并集**：容器级在前、轨迹级追加、同名去重）：① **一处声明、全容器生效**——在 `.opencode/serenity.json` 写 `trajectory.skills: [名字, …]`（底座），**本工作区的每条轨迹**被绑定期间都注入这些 skill 的全文（**连子角色会话也算**）；② **只给这一条**——在它的 `SESSION.md` 顶部 frontmatter 写 `skills: [名字, …]`（这条额外的）。⚠️ 是"**绑定期间一直供给**"而非"`use` 时注入一次"——改了配置或 frontmatter **立即生效**（每请求重新求值，不缓存），也不随对话压缩消失；而 `create` 只新建、**不夺走当前绑定** ⇒ 新轨迹要**显式 `use`** 才挂上。skill 名来自工作区数据，**先过安全校验才会用于拼路径**，找不到会在提示里明说"缺失"而**不静默跳过**；⚠️ **重写 `SESSION.md` 时务必原样保留顶部 frontmatter**（抹掉 = 静默撤销该轨迹的声明）

#### CRO —— 由轨迹**自行判断何时该被叫醒**

**问题**：上面那两条都要求**先算好一个时刻**（"3 点叫我"）。但**该不该醒往往不由时间决定**：某条轨迹应该在"天亮 + 家里有人 + 非高峰"才醒；已经在工作就不该再叫一次；日志快满了，下次叫它时该**要求它先整理**。

**做法**：**让一条轨迹自己带一段程序**，由 ACC 在每次检查时运行它，**由这段程序决定"现在该不该叫我、叫我的时候说什么"**。

| | 内容 |
|---|---|
| **程序放哪** | `<工作区根>/AGENT_SESSIONS/<轨迹目录>/continuous-re-occurrence.ts`（放**轨迹自己目录**里 ⇒ 跟随轨迹跨载体存活、天然进 git） |
| **开关** | ① **逐轨迹**：**文件在 = 启用，文件不在 = 禁用**（无 enabled 字段、无注册表）② 🔴 **总闸**：设置面板「**CRO（轨迹自编程唤起）**」（`croEnabled`，缺省**开**）——关掉只停 CRO，不影响 `send-later` / `send-now` / 唤醒表投递 |
| **谁跑它** | ACC 的唤醒调度器（既有 **5 分钟** tick） |
| **给它什么** | 一条 stdin 进来的 **JSON 快照**：身份 / 时间 / 轨迹身体（SESSION.md 体积与 mtime、`references/` 清单）/ 绑定与载体（绑定的、live 的、🔴 **正在跑轮次的**）/ 调度面（本轨迹在办唤醒、调度器状态） |
| **它给我什么** | stdout **一行 JSON**：`{"wake":true,"prompt":"…","reason":"…"}` 或 `{"wake":false}`（**缺省 = 不打扰**） |
| **写程序前先读** | `container_trajectory cro-guide` —— **指南 + 一份可直接拿去自测的样例快照** |

**几条设计上的硬约束**（都不是随便定的）：

- 🔴 **ACC 只"起进程"，从不 import 用户程序**——进程边界同时挡掉两件事：ACC 不必依赖工作区的**源码路径**（装机版在别处，两条路径 = 两个真相源），以及**一个用户程序的语法错会放倒整个容器**
- 🔴 **半成品报错就行**：程序报错 / 超时（60 秒硬超时，超了 kill）/ 输出非法 ⇒ **记一行 + 跳过本轮**——任何失败都不影响既有机制（这条由实测用例钉住，不是口头承诺）
- 🔴 **`reason` 强烈建议填**：改成程序判定之后，"当时为什么叫了"**不再能从时间表重建**（原因在程序内部）；不写，以后出事无法复现
- **程序想要记住"上次判了什么"，得自己记**——写在**自己轨迹目录**里的状态文件（那是它自己的进程状态，ACC 物理上拿不到）。所以**防抖也归程序**：想"不要叫太频繁"就自己记时间戳
- ⚠️ **不自带自测**：流程为**先用开发名编写**（如 `continuous-re-occurrence.dev.ts`，不会被启用）→ 自测通过 → **改为正式名**（"文件在即启用"，**改名即上线动作**）

> ⚠️ **历史**：ACC 曾自带一套"周期自唤醒 autopilot"，**v1.35.0 起整段退场**（机制、时钟、`container_admin autopilot` 域、面板开关一并删除）。
> 旧会话 / 旧文档里看到 `container_admin autopilot`、`autopilot-trajectory`、`--auto` 目录后缀、`[Autopilot Trajectory · 唤起]` 等字样，均为**已删除的机制**。
> CRO 不是它的回归：退场删掉的是**判据内容**（周期节拍 + 提示词），留下的是**调度能力**；CRO 补的是"**在没人醒着的时候判断该不该醒**"。

### 6.6 安全模型

| 层面 | 做了什么 |
|---|---|
| 登录 | scrypt 密码哈希 + 常量时间比较 + 256-bit token + 24 小时滑动有效期 + 审计日志 |
| 双因素 | TOTP（兼容 Authenticator），扫码绑定；密码和验证码二选一 |
| 防爆破 | 按账号锁定：连续失败 5 次 → 锁 15 分钟，且指数退避 |
| 防 CSRF | 登录双提交 + 配置写入校验 Origin + 服务端 token 集合（多标签页不冲突） |
| 凭据 | 集中放 `localstore.json`（默认禁止提交到 git）；密钥文件对工具结构性隔离 |
| 对外输出 | 敏感词检测 → 打回重答，并告知命中词和规避方向 |

---

## 7. 配置分四层

| 层 | 位置 | 放什么 |
|---|---|---|
| DSH 原生设置 | DSH 的 settings.yaml（即设置面板那几项） | 开关与阈值：网关总开关、重建阈值、子角色开关与调试端口、**CRO 总闸（`croEnabled`，默认为开）**、**无人值守代理回复（`unattendedEnabled`，默认为关）**、**图工具总闸（默认关）** |
| 插件全局文件 | `~/.dsh/serenity-hooks.json`（权限 0600） | 网关账号（scrypt + TOTP）、监听地址与端口、工作区白名单、cookie 安全开关 |
| 工作区配置 | `.opencode/serenity.json` | 助手模型白名单、日志阈值、安全模式黑名单、子角色、**轨迹级 skill 供给（`trajectory.skills`）**、微信（账号/路由/开关） |
| 工作区凭据 | `localstore.json` | 密钥与本地偏好；微信机器人 token 也在这一层 |

> 原则：**插件是全局的，工作区是具体的**——账号、开关、阈值归插件层；角色、凭据、本地偏好归工作区层。
> 「重建总开关」与「周期自唤醒」这两个旧开关**已砍掉**（超限重建恒开；周期节拍改由工作区/ CRO 自己决定），旧配置里若还留着它们，会被**静默忽略**。

---

## 8. 上下文将满时的处理

AI 一次能"记住"的内容有上限。满了不用手动开新会话：

| 机制 | 说明 |
|---|---|
| **工作日志（SESSION.md）** | AI 的"笔记本"，永远留在原地。目标、决定、进度都写这儿 |
| **原地重建（container_trajectory rebuild）** | 快满时它会提示 AI 主动重建：把这一轮对话清空，但重新注入"你是谁 + 继续 S### 的工作"——**载体换了，活儿接着干**。重建前它会把"手头做到哪了"写进同目录的 `REBUILD-TODO.md`，重建后的它先去读那张便签 |
| **进度提醒** | 做久了会按计分提醒 AI 把进度写回日志，并要求它回确认码 |
| **沉淀纪律** | 重建前如果产生了有价值的认知，先把它写进相关技能（而不是丢掉） |

---

## 9. 面向插件开发者

```bash
pnpm typecheck          # 类型检查（node + 浏览器端两套）
pnpm test               # 全量测试（vitest；文件数与用例数看运行时输出，本文不写死）
pnpm build              # 打包（lib/index.js + client.js）
```

- **开发用小工具**：`scripts/dsh-develop.ts`——typecheck / test / build / status / commit / push / version / bump / deploy / **lockfile** / **host-upgrade** / restart-web / publish / pack-check / github-push 一条龙。
  `lockfile` = 重生成锁文件 + 用 `--frozen-lockfile` 自检（CI 的 `Install (hooks)` 同款判定）；
  `pack-check` 会在发布前核对打包产物是否完整（曾出现"发到 npm 少了文件"的情形）；`scripts/dsh-crash-investigate.ts` 用来查崩溃（只读）。
  ⚠️ **改完 `package.json` 依赖后必须跑 `lockfile` 并提交锁文件** —— 曾漏过这一步，CI 从此一直红（红在"测试根本没跑"，见 CHANGELOG）
- **宿主类型基准 = devDependencies**：`tsconfig.json` / `client/tsconfig.json` 的 `paths` 指向**仓库内** `node_modules/@deepseek-ai/*`，由精确钉版的 devDependencies 提供 → **新增 paths 条目必须同时加 devDependency**（否则 tsc 静默回落 node_modules = 假绿，CI 的 typecheck 也就形同虚设）。机械闸门见 `tests/compliance.test.ts`；升级宿主时只改 `package.json` 一处 + 重跑 `lockfile`
- **升级宿主**：`dsh-develop host-upgrade <版本|dist-tag>` 全局升级 DSH CLI（包名硬编码 `@deepseek-ai/dsh`、默认官方源、`--dry-run` 预览）→ 把 `package.json` 的 peer/devDeps 基准抬到同一版本 + 重跑 `lockfile`（`compliance.test.ts` 与 `host-manifest.test.ts` 会强制各声明面同步，漏一处必红）→ `restart-web` → `dashboard health` 看 `dshVersion`
- **诊断会话打不开**：`dsh-develop session-doctor` —— 会话日志体检（**只读**）。
  `--probe` 走宿主**真实读取路径**判定（`msm("dsh-develop", ["session-doctor","--probe","--summary"])` 可全量跑）。
  ⚠️ 两个易误读点：① 存储层读**不走格式迁移** ⇒ 它对历史世代报 "no upgrade path" 属**正常现象**，不是损坏证据；判断"用户能不能打开"要看应用面 ② 本工具修的两个真实缺陷见 CHANGELOG（`rebuild` 写的事件缺字段 ⇒ 会话**永久打不开**；会话文件清理不认某些后缀 ⇒ 静默失效）
- **架构**：Cordis 原生插件，用 DSH 的正式接口注册工具和拦截点——**从不修改 DSH 本体**
- **代码地图**：[docs/codebase-overview-v1.22.md](https://github.com/tellmewhattodo/dsh-serenity-plugin/blob/master/docs/codebase-overview-v1.22.md)
- **设计决策**：见 [CHANGELOG.md](https://github.com/tellmewhattodo/dsh-serenity-plugin/blob/master/CHANGELOG.md) 和维护技能 `dsh-serenity-plugin-development`
- **发布**：npm `@shgroup/dsh-serenity-hooks` + GitHub 双仓库同步推送

---

## 10. 和 opencode 版是什么关系

| | opencode-serenity-plugin | dsh-serenity-plugin（本仓库） |
|---|---|---|
| 跑在 | OpenCode | DeepSeek Harness |
| 实现 | 独立 | **独立**（不复用源码，但遵循同一套标准） |
| 系统提示词 | `system.transform` | `systemPrompt.section`，平台无关的部分逐字对齐 |
| 工具 | msm / container_fs / logbook 等 | container_fs / container_trajectory / dashboard / container_git / msm / praxis / ontology / serenity-skill-creator / cheap-worker / localstore / container_admin ＋ 三个条件出现的（`im-bridge` / `acc-diag` / `diagram`） |

**同一个工作区可以随时换运行时**：`.serenity` 标记、`.opencode/skills/`、配置、`AGENT_SESSIONS/` 的文件格式都一致；
差别只在平台层（工具名、注入方式），换过去以后 AI 收到的约束是一样的。

---

## 11. 常见问题

**Q：装完没反应？**
先确认进入的是带 `.serenity` 标记的目录。不是工作区的话，插件完全不介入。进去后输入 `dashboard health` 看三项检查。

**Q：bash 怎么不见了？**
安全模式开着——这是设计，不是 bug。关掉胶囊里的 SAFE 滑块就回来了（机制见 §3.2）。

**Q：3081 登录被锁了？**
连续失败 5 次锁 15 分钟起（指数退避，上限 4 小时）。等锁过期，或检查账号的验证码绑定状态。

**Q：上下文快满了怎么办？**
先让 AI 把进度写回 SESSION.md，然后按提示调用 `container_trajectory rebuild`。轨迹会自动接续，不用手动开新会话。

**Q：对外问答页会返回内部信息吗？**
该面已于 2026-10-15 移除（改用官方 ACP，见 §6.4）。走官方 ACP 时，**认证与暴露范围由接入层决定**——
官方 server 只跑在 stdio 上、不认识网络，把它接到哪里、谁能连，取决于你怎么架隧道。

**Q：微信桥里，AI 的回复是怎么发出去的？**
默认由插件自动把它的最后一段话转发给用户。如果配了 `autoReplyWithLastMessage: false`，插件就不转了，改由 AI 自己发——所以这时候它如果没发，用户就收不到消息（除非另外开了 `fallbackOnNoSend` 让插件兜底）。

**Q：主动发的微信消息会被记录吗？**
会。和工作区里配的 `weixin.hook` 记录脚本走同一条路，事件里标 `source: "proactive"`；自动回复标 `source: "reply"`。

---

## 12. 延伸阅读

- **理论来源**：[docs/cognitive-container-theory.md](https://github.com/tellmewhattodo/dsh-serenity-plugin/blob/master/docs/cognitive-container-theory.md)——认知容器是什么、认知的"发生/存储/再发生"、轨迹与载体
- **权威标准**：[serenity-acc-specs](https://github.com/tellmewhattodo/serenity-acc-specs)——理论根基、注入规范、不变量
- **改了什么**：[CHANGELOG.md](https://github.com/tellmewhattodo/dsh-serenity-plugin/blob/master/CHANGELOG.md)——每个版本做了什么、为什么这么做，**当前版本号也看这里**

---

## 许可

MIT（见 [LICENSE](https://github.com/tellmewhattodo/dsh-serenity-plugin/blob/master/LICENSE)）

> **前置**：DSH `^0.1.7-rc.1 || ^0.2.0-rc.1 || ^0.2.1-rc.1`（三档）｜ Node ≥ 20 或 bun。
> **当前版本 / 工具数 / 测试规模**均不写死在此 —— 版本看 [CHANGELOG.md](https://github.com/tellmewhattodo/dsh-serenity-plugin/blob/master/CHANGELOG.md)，运行态看设置面板与 `dashboard health`。
