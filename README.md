# dsh-serenity-plugin — Serenity ACC for DeepSeek Harness

> **给 DeepSeek Harness（DSH）装上认知容器基础设施。** 任意带 `.serenity` 标记的目录（CCC, Concrete Cognitive Container）自动获得：13 个 ACC 工具、机械安全约束、会话轨迹追踪、外部访问与问答能力、微信接入与自主巡航——**一个插件，一套认知工作区**。
>
> 面向 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 0.1.0-rc 及以上。
> 理论叙述（什么是认知容器）见 [docs/cognitive-container-theory.md](docs/cognitive-container-theory.md)——本文只讲能力与使用。

---

## 快速开始（2 分钟）

前置：Node ≥ 20（或 bun）、DSH 0.1.0-rc 及以上。

```bash
# 1. 从 npm registry 安装插件（自动加入 DSH profile 的 bundles 层）
dsh plugin --profile web add @shgroup/dsh-serenity-hooks

# 2. 重启 dsh web（插件与 WebUI client 生效）
dsh web

# 3. 验证：进入带 .serenity 标记的 CCC 目录开会话
#    · 会话自动注入 ACC 身份 + 入口 skill 系统提示
#    · WebUI 会话头部出现 Serenity 状态胶囊（绿点恒亮 + SAFE 盾牌滑块）
#    · 输入 acc_kit health → CCC 三原则健康检查通过
```

卸载：`dsh plugin --profile web remove @shgroup/dsh-serenity-hooks`

> **本地开发安装**（从源码）：`git clone https://github.com/tellmewhattodo/dsh-serenity-plugin.git && cd dsh-serenity-plugin && dsh plugin --profile web add link:$(pwd)/hooks/dsh-serenity-hooks`
> ⚠️ git URL 安装（`github:...`）指向仓库根包（workspace 容器，非 bundle 层插件），不会激活——请用 link 或 npm。

**开启安全模式**：点击 WebUI 胶囊中的 SAFE 滑块 → **bash 从模型的工具列表消失**（不是报错，是模型根本看不到）→ agent 只能走注册的、测试过的 MSM 通道。开关是用户能力，agent 不可见、不可自开关。

---

## 安装后你得到什么（能力地图）

### 13 个 ACC 工具

| 工具 | 能力 | 典型用法 |
|------|------|---------|
| `cc_fs` | 文件系统 15 子命令（root/resolve/list/tree/mkdir/rm/mv/cp/touch/append/reveal/info/find…） | 路径全部限定 CCC 根内，逃逸自动阻断 |
| `session` | 会话全生命周期（list/show/create/use/close/health/qa/archive/summary） | 多步工作先 `session create`，中断后 `use` 恢复 |
| `acc_kit` | 健康检查（CCC 三原则 P1/P2/配置）/ 时间 / 等待 | 进入 CCC 前的例行自检 |
| `cc_git` | Git 操作（status/commit/push/log/pull） | 非快进推送输出建议，绝不自动 force |
| `acc_msm` | MSM 框架（list/exec/register/deregister/check/guide/ccc-config） | 可执行单元注册表 + 600s 超时安全执行 |
| `eap` / `neat` / `cce` | 认知质量框架 / 设计协作协议 / 连续性工程（渐进披露） | 输出自检、设计对齐、工程评估 |
| `handyman` | 杂工循环：指定白名单模型 worker 同步循环到完成 + jobs 并行编排 | 大批量任务（如 SQC 扫描）委派 |
| `session_rebuild` | 上下文超限时轨迹重建（Ship of Theseus） | 超阈值后自动提示，LLM 触发重建接续 |
| `localstore` | 凭据/配置存储（credential/config 两命名空间） | API keys/密码集中管理，git 策略可配 |
| `skiff_admin` | Skiff 角色管理（guide/validate/apply/list） | 定义/校验/应用认知子集角色 |
| `autopilot-trajectory` | 自动巡航轨迹一站式管理（无参=全报告 / init / random / diag / diag-live / check / status / guide） | 时钟驱动自主唤起 + 先验偏见注入 + 多 CCC 独立（S151 自主管家） |

### 机械约束（模型不可绕过）

| 约束 | 机制 |
|------|------|
| **安全模式** | bash 从工具列表消失（tools.restrict，每 step 同步）+ 守卫兜底 deny |
| **路径边界** | P3 权限二分：CCC 根内完整权限，根外零权限（路径逃逸阻断） |
| **黑名单/治理文件** | 可配黑名单 + `.serenity` 治理文件写入保护 |
| **凭据文件守卫** | `localstore.json` 对任何工具 deny（含 read/grep/glob）——凭据值结构性不可出 |
| **输出守卫** | 外部面（skiff/acp/rebuild 会话）最终输出检测敏感词 → 打回重生成（告知命中词+分类指引） |
| **轨迹提醒** | Trajectory Steward 计分 + 上下文压力检测，督促进度落回 SESSION.md |

### 外部面（对外服务）

| 面 | 端口 | 用途 |
|----|------|------|
| **双端口网关** | 3081（默认 0.0.0.0） | 登录后访问完整 WebUI（密码 或 TOTP 二选一 + 工作区白名单） |
| **Skiff 调试问答页** | 3099（默认 127.0.0.1） | 认知子集角色调试（多 CCC 切换 + 轨迹渲染） |
| **ACP + Skiff 问答页** | 3100（默认 127.0.0.1） | ACP JSON-RPC 程序化接入 + 对外问答页（key 认证 + 容器白名单，只问答不返回内部轨迹） |
| **微信桥（F4c-3）** | iLink 长轮询（出站） | 微信扫码接入 → skiff 角色对话（文本/语音/图片/文件），多账号，会话延续 |

---

## 使用场景（真实能力）

> 以真实部署「宁静号」为范例（所有地址/账号/路径/密钥均已泛化）。一个带 `.serenity` 标记的目录 = 一个 CCC。

### 一个 CCC 的目录解剖

```
home-serenity/                    ← CCC 根（.serenity 记号文件标记）
├── .serenity                     ← 记号：本目录是一个认知容器
├── .opencode/
│   ├── serenity.json             ← CCC 级配置：handyman 模型白名单 / 会话阈值 / skiff 角色
│   └── skills/                   ← 领域技能（每个 = 一个领域知识的 EAP 封装）
│       ├── home-media/           ←   媒体：获取 / 字幕 / 分发
│       ├── home-wealth/          ←   财务：资产 / 负债 / 收支 / 预算
│       ├── family-profiles/      ←   成员档案（唯一真相源）
│       └── …（每个 skill 可持有 MSM 脚本）
├── AGENT_SESSIONS/               ← 会话库房：每目录一个 SESSION.md（持久轨迹）
│   └── 2026-08-29--S142--xxx/
│       └── SESSION.md            ← 轨迹身体：目标 / 决策 / 进度（永远原位）
└── _tmp/                         ← 运行时落盘（图片 / 用户粘贴文件）
    ├── images_from_user/
    └── files_from_user/
```

### 日常能做什么（10 个真实用例，含操作链）

| # | 场景 | 操作链（工具 → 子命令 → 效果） |
|---|------|--------------------------------|
| 1 | **长期项目维护** | `session create --desc xxx` → 自动建 SESSION.md → 多步工作逐段落进度 → 中断后 `session use` 恢复 → 上下文超限 `session_rebuild` 自动接续 |
| 2 | **批量代码同步** | 根仓 `cc_git commit/push`；多个子仓库一键 `resources-management sync`（自动 commit + push 全部） |
| 3 | **媒体字幕生产** | 搜索片源（BT）→ 下载 → Whisper 转写 → 翻译 → 双语 SRT → 机械 QC（7 项检查）→ 分发（RSS/邮件） |
| 4 | **服务器巡检** | `server-tool health` → CPU/内存/GPU/容器/服务一键报告；`server-tool container` 查看/重启容器——全部经 ssh-connect 白名单通道 |
| 5 | **内网服务定位** | `landscape-tool` 仓库全景（20+ 仓库分类/技术栈/关联）；`network-tool` 设备/端口扫描 |
| 6 | **财务数据管理** | 本地结构化记录资产/负债/收入/支出/预算 → 查询/汇总；房贷利率对比等宏观跟踪 |
| 7 | **成员档案** | `profile list/show/create/update`——成员资料统一维护，CCC 是唯一真相源 |
| 8 | **想法随手记** | 有想法随时开聊 → AI 访谈式理清 → 结构化归档 → 定期回顾思考模式 |
| 9 | **外部访问（手机/出差）** | 浏览器开 `http://内网地址:3081` → 登录页：用户名 + 密码 **或** Authenticator 6 位码 → 手机直接操作 WebUI |
| 10 | **粘贴资料自动处理** | **图片**：粘贴 → 自动落盘 → 视觉模型识别（快递单/截图/图表）；**任意文件**：粘贴 PDF/压缩包 → 自动落盘 → agent 提取（PDF/解压/表格，均有专用 MSM） |
| 11 | **微信接入（角色对话）** | 面板微信桥扫二维码绑定 → 微信发消息（文本/语音/图片/文件）→ 路由到 skiff 角色（如招财）回复回微信 → 多账号并行 + 同用户会话延续 |
| 12 | **自主巡航（Autopilot）** | CCC 配置 autopilotTrajectory（interval/session/偏见脚本/topPrompt）→ 时钟到点自动唤起注入前台 → 全局开关 + 多 CCC 各自独立巡航（S151 自主管家） |

### 典型一天

```
早上：内网服务巡检（server-tool health）→ 一切正常
上午：同步昨日代码（resources-management sync）→ 子仓库全部推送
午间：收到 PDF 账单 → 粘贴到对话 → 自动落盘 + 表格提取 → 记入财务
下午：制作一期视频字幕（Whisper → 翻译 → 双语 SRT → QC）→ 推送订阅
晚间：外部设备访问家庭服务（3081 登录页：TOTP 码验证）→ 处理运维问题
全程：每段工作落 SESSION.md → 轨迹连续，随时可换人/换模型/换宿主接续
```

---

## 外部访问与安全

### 双端口网关（3081）

```
外部浏览器 → http://LAN-IP:3081（插件自起第二监听器）
  → 未登录 → 极简登录页（用户名 + 密码 或 6 位验证码，二选一；移动端适配）
  → POST /serenity/login：scrypt 验证 / TOTP 校验 + CSRF token 集合 + 失败锁定（5 次→15min 指数退避）
  → HttpOnly cookie（SameSite=Strict，滑动 24h）→ 302 反代
  → 已登录 → 反代 127.0.0.1:主端口（Host/Origin 改写过信任栅栏）
  → /api/workspace.list 白名单过滤 + workspace.create 校验
  → WS upgrade 转发（101 回写 + 双向 error 监听防崩溃）
```

### Skiff 认知子集角色（3099 + skiff_admin）

CCC 从全知全能 trajectory 切出**任意子集角色**（`.opencode/serenity.json skiff.roles`）——不限于问答，可有操作能力：

```jsonc
{
  "skiff": {
    "roles": {
      "qa": {
        "model": "provider/model",              // per-role 模型
        "msms": ["web-search", "vlm-describe"], // MSM 独立白名单
        "tools": ["read", "grep", "glob"],      // 非 MSM 工具独立白名单
        "systemPromptFile": "roles/qa.md"       // 或 systemPrompt 内联
      }
    }
  }
}
```

- **双白名单**：MSM 与非 MSM 工具独立配置，白名单外全隐藏；skill 加载恒可用
- 调试问答页（3099）多 CCC 手工切换，回答 marked 渲染 + think 折叠
- `skiff_admin validate` 校验配置 → `apply` 显式生效（绑定 CCC + 角色清单）

### Skiff 问答页（3100 + 公网）

- **key 认证**（timing-safe + 失败 IP 锁定 + 可轮换）+ 容器白名单（空 = 全部开放）
- **对外只问答**：响应仅 answer/answer_html/sessionId——**不返回内部轨迹**
- **公网暴露由部署方自选方案**（隧道 / 反向代理 / 端口映射等）——插件不绑定任何特定暴露方式；默认仅监听 127.0.0.1，暴露属部署决策

### 微信桥（F4c-3：iLink 接入）

CCC 级配置（`.opencode/serenity.json weixin`），凭据归 CCC localstore（credential scope）——**dsh 一进程多 CCC，每个 CCC 独立对接微信桥**：

- **扫码绑定**：面板「微信桥」→ 选 CCC → 扫码（手机微信确认 liteapp）→ bot_token 自动写凭据
- **多账号**：每账号独立扫码绑定 + 独立移除；`nextWeixinAccountId` 最小未占用自增
- **消息能力**：文本 / 语音（服务端自带转写 `voice_item.text`）/ 图片 / 文件（CDN 下载 + AES-128-ECB 解密 → 落盘 `_tmp/weixin-inbound/` → 注入对话）
- **正在输入**：处理前 sendtyping 1 → 处理后 0（微信侧显示"正在输入..."，失败静默）
- **回复纯净**：`stripThink` 剥离思考块，微信只收到最终正文
- **会话延续**：固定可重建 sessionId（`skiff-weixin-<sha256(userid)>`）+ **resume-or-create**——重启后历史恢复，不丢记忆；live 会话优先复用
- **路由**：用户 → 角色（exact → 通配 `*` 兜底）；ACC 不绑定具体 role（如招财 zhaocai）
- **诊断**：`weixin-doctor` MSM（status/diag/verify 五链）

### Autopilot Trajectory（自动巡航轨迹）

时钟驱动的**自主认知巡航**——CCC 定义轨迹焦点与偏见，插件负责到点唤起（前台注入，用户全程可见可介入）：

- **唤起条件**：enabled + 全局开关（settings `autopilotEnabled`，默认关——只在指定机器跑）+ 目标会话（`--auto` 后缀）+ 间隔（支持小数，最密 0.01h≈36s）+ 避开高峰窗口（默认北京 8~18 点）+ 偏见脚本就绪
- **焦点锚定**：`topPrompt`（CCC 定义、每次唤起最先注入）+ 偏见内容（CCC 自定义脚本，随机探索）——稳定锚 + 随机方向互补
- **多 CCC 独立**：每 CCC 各自 interval/session/bias/topPrompt/窗口；per-CCC running 守卫 + 全局串行化；面板 CCC 选择器 + 立即唤起
- **审计**：每次唤起记录（recentWakes ring，面板展示）；唤起失败指数退避重试
- **v1.27.12 移除每日预算**：唤起频率只受 interval + 窗口约束（高频实验不受限）

### 安全模型

| 层 | 机制 |
|----|------|
| 登录 | scrypt 密码哈希 + 常量时间比较 + 256-bit token + 滑动 24h TTL + 审计日志 |
| 双因素 | TOTP（RFC 6238，Authenticator 兼容）二维码扫码绑定；密码 或 验证码二选一 |
| 防爆破 | 账号维度失败锁定（5 次 → 15min 指数退避） |
| 防 CSRF | 登录双提交 + config PUT Origin 校验 + 服务端 token 集合（多标签不冲突） |
| 凭据 | `localstore.json` 集中管理（git 默认拒绝提交）；数据面守卫结构性隔离 |
| 输出 | 外部面输出守卫：敏感词检测 → 打回重生成（告知命中词 + 分类指引） |

---

## 配置（4 层）

| 层 | 位置 | 内容 |
|----|------|------|
| DSH 设置面板 | settings.yaml（DSH 原生） | 三功能开关（gateway/rebuild/naming）+ rebuild 阈值 + skiffEnabled/skiffDebugPort + acpEnabled/acpHttpPort + publicAskEnabled + **autopilotEnabled（全局开关，默认关）** |
| plugin 全局文件 | `~/.dsh/serenity-hooks.json`（0600） | 网关账号（scrypt + TOTP）/ host / port / 工作区白名单 / cookieSecure / publicAsk key |
| CCC 配置 | `.opencode/serenity.json` | handyman.models（白名单+缺省模型）/ sessionKeeper.threshold / safeMode.blacklist / skiff.roles / **autopilotTrajectory（interval/session/bias/topPrompt/窗口）** / **weixin（账号/路由/开关）** |
| CCC 凭据 | `localstore.json` | 凭据/配置命名空间（git 策略可配）；微信 bot_token 存 credential scope |

> 原则：**plugin 是全局的，CCC 是具体的**——账号密码/开关/阈值归 plugin 层；角色/凭据/本地偏好归 CCC。

---

## 上下文与轨迹管理

| 机制 | 说明 |
|------|------|
| **SESSION.md** | 轨迹的持久身体，永远原位；多步工作的目标/决策/进度都落这里 |
| **session_rebuild** | 上下文超阈值 → `[TRAJECTORY]` 提示 LLM 主动触发 → 同会话 surface 清空重建（锚点保留协议正文 + 「继续 S###」）→ 自动继续；shadow-price 协议合规（token 计量正确回落） |
| **Trajectory Steward** | 计分提醒（`[TRAJECTORY-STEWARD]` + ACK 协议）督促进度落回；机制预声明在系统提示词中 |
| **认知沉淀纪律** | 重建前若产生有价值认知 → 修订相关 skill（EAP 结构化）；新建 skill 写提案到 SESSION.md 供用户审阅，不自行创建 |

---

## 理论（索引）

- **浓缩叙述**：[docs/cognitive-container-theory.md](docs/cognitive-container-theory.md)——认知容器定义 / 认知 Loop（动作=反馈）/ Trajectory 主体 / Session=可重建载体 / 认知闭环
- **权威标准**：[serenity-acc-specs](https://github.com/tellmewhattodo/serenity-acc-specs)（§0 理论根基 + 注入规范 + 不变量）

---

## 开发与扩展（插件作者向）

```bash
# 完整开发循环（safe-mode 下经 acc_msm exec dsh-develop 亦可）
pnpm typecheck          # hooks/dsh-serenity-hooks（node + client 双面）
pnpm test               # vitest 全量（52 files / 752 tests）
pnpm build              # tsc + tsdown 双 bundle（lib/index.js + client.js）
```

- **开发 MSM**：`scripts/dsh-develop.ts`（typecheck/test/build/status/commit/push/version/bump/deploy/restart-web/publish/**pack-check**/github-push/npm-install-dev）+ `scripts/dsh-crash-investigate.ts`（崩溃调查，只读）——`pack-check` 发布前校验 tarball 完整性（动态核对 lib/ 全部 JS 产物 + .d.ts，防 chunk 漏发）
- **架构**：Native Cordis 插件（真实 DSH 工具 `ctx.tools.register` + 拦截缝 `systemPrompt.section`/`tools/pre-execute`/`agent/turn-stopping`…）；**零改 DSH harness**——所有能力走插件 seam/事件/注入服务
- **代码地图**：`docs/codebase-overview-v1.22.md`（分层架构/模块职责/数据流/配置分层）
- **设计决策**：D1~D30+ 见 CHANGELOG.md 与维护 skill（`dsh-serenity-plugin-development`）
- **发布**：npm `@shgroup/dsh-serenity-hooks` + GitHub 双 remote（tellmewhattodo + omdsh-dev 双推）

## 与 opencode-serenity-plugin 的关系 / CCC 可互换

| | opencode-serenity-plugin | dsh-serenity-plugin（本仓） |
|---|------|------|
| 宿主 | OpenCode | DeepSeek Harness |
| 实现 | 独立 | **独立**（不复用源码，同一 ACC 标准） |
| 系统提示词 | `system.transform` | `systemPrompt.section`，平台无关文本逐字节对齐 |
| 工具 | msm_list/exec/cc-fs/session 等 | cc_fs/session/acc_msm/cc_git/eap/neat/cce/handyman/session_rebuild/localstore/skiff_admin/autopilot-trajectory |

**同一 CCC 可任意换用 osp / dsh 运行时**：`.serenity` 记号、`.opencode/skills/`、配置、`AGENT_SESSIONS/` 跨运行时文件格式一致；差异仅在平台层（工具命名/注入通道），切换后 Agent 收到的认知约束完全一致。

## FAQ

**Q：安装后没反应？** 确认进入的是带 `.serenity` 标记的目录（CCC）；非 CCC 目录插件零干预。`acc_kit health` 验证三原则。

**Q：bash 怎么不见了？** 安全模式开启后 bash 从工具列表消失——这是设计：走注册的、测试过的 MSM 通道更可靠。WebUI 胶囊滑块关闭即可恢复。

**Q：外部访问（3081）登录失败锁定？** 5 次失败锁 15 分钟（指数退避）——等锁定过期，或检查账号 TOTP 绑定状态。

**Q：上下文快满了？** 把进度落回 SESSION.md，然后按 `[TRAJECTORY]` 提示调用 `session_rebuild`——轨迹自动接续，不用手动开新会话。

**Q：对外问答页（3100）返回什么？** 只返回回答（answer/answer_html/sessionId）——内部轨迹、工具结果、机制信息都不出对外面。

## 许可

MIT（见 [LICENSE](LICENSE)）

> **版本**: v1.27.12 &nbsp;|&nbsp; **前置**: DSH 0.1.0-rc+ / Node ≥ 20 / bun &nbsp;|&nbsp; **测试**: 52 files / 752 tests
