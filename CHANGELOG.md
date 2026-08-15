## v1.17.3 — 2026-08-15（MSM 开发指南补充"交互与确认规范"：禁止阻塞性确认，二次确认走两段式返回+重试）

**Scope:** 用户要求补充 MSM 开发规范——MSM 子进程无用户交互通道（spawn/execFile，600s 超时），阻塞性确认（readline/prompt/stdin 等待）会卡死至超时；需要二次确认时应直接返回确认信息，agent 确认后重新调用并带确认参数重试。

### 补充内容（acc_msm guide → MSM_GUIDE）
- **新增「交互与确认规范」节**：禁止 readline/prompt/process.stdin 阻塞等待；两段式确认模式（首次调用不带确认 flag → 输出确认请求 + exit 非 0 + 不执行变更；agent 重新调用带 --confirm/--yes/--force → 执行）
- 适用场景：删除/覆盖/推送/批量等不可逆或影响面大的操作
- 测试：acc-extras guide 断言补「交互与确认规范/禁止阻塞性确认/--confirm」

**测试：** 257/257

## v1.17.2 — 2026-08-15（Session 块平台适配：todowrite 首项移除 DSH 不支持的 priority 字段——修复 `todos[0].priority is not a declared property` 报错）

**Scope:** 用户报告更新 todo 偶尔报错 `Error: invalid arguments: "todos[0].priority" is not a declared property (additionalProperties: false)`。根因：Session 块（逐字节对齐 osp）指导 agent 调用 todowrite 时首项带 `priority: "low"`，但 osp 的 opencode todo 工具支持 priority 而 **DSH 平台 todowrite schema 无 priority（additionalProperties: false 拒绝）** → agent 照做即报错。提示词与平台工具 schema 不匹配。

### 修复
- `system-prompt.ts sessionBlock`：todowrite 首项约定 `{ content: "...", status: "completed", priority: "low" }` → `{ content: "...", status: "completed" }`（移除 priority；其余文本逐字对齐 osp）
- `osp-alignment.test.ts`：Session 块断言改为"除 DSH todowrite priority 差异外与 osp 一致"（DSH 适配版模板 + replace 还原证明唯一差异 = priority 字段）
- 平台差异本质：osp 对齐原则（D2）限"平台无关文本"；todowrite 参数 schema 是平台相关部分 → DSH 版适配

**测试：** 257/257（osp-alignment Session 断言更新为适配版）

## v1.17.1 — 2026-08-15（热修复：cc_git schema 移除公测 rc.6 不支持的 minimum/maximum 键——defineTool 阶段 DSL 拒绝导致插件 import 失败、web boot 崩溃）

**Scope:** 用户部署 v1.17.0 后 web boot 崩溃。根因：`tools/git.ts` 的 `count` 参数 schema 用了 `minimum: 1 / maximum: 100`，但公测 rc.6 的 dsh-tools value schema DSL 只支持 type/enum/const + description 等注释键，无数字边界键 → defineTool 阶段被 DSL 拒绝 → 插件 import 失败。用户已临时补丁（移除安装包中这两个键）使 web 恢复。

### 修复
- `tools/git.ts`：删除 `count` 的 `minimum/maximum` 键（保留 type + description）；边界校验（1-100）已在 `git-ops.ts` 运行时 clamp（`Math.min(Math.max(args.count ?? 10, 1), 100)`）——schema 边界移除后运行时校验完整保留
- 全包扫描确认：仅此一处违规（其他参数键 type/enum/required/items 均受支持；源码其余 minimum/maximum 出现均为注释/文本）

**测试：** 257/257（git-ops log clamp 运行时行为不变）

## v1.17.0 — 2026-08-15（工具实现全面对齐 osp spec：dsp/osp 无缝兼容）

**Scope:** 用户要求"dsp 和 osp 的工具实现应当逻辑一致（无缝兼容的强要求），工具设计应属于 specs，全面对照并修正"。以 osp（opencode-serenity-plugin）为 ACC 工具 spec，逐工具对照 dsp 全部 9+ 工具并修正行为差异。触发：session create `--issue` 静默降级建 `S080--untitled`（apaas-26116 事故根因）。

### session（对齐 osp session-tool/lib）
- **create**：`--desc <desc> [--goal]` 或 `--issue <工单号>` 二选一（缺省/互斥报错，不再静默 untitled）；issue 模式目录 `YYYY-MM-DD--<issue>`（无 S###）；dry-run 预览；长度限制（issue≤100/desc≤200）；goal 写入目标段
- **close**：需 `--name` + `--confirm`（防误关）；标记 [x] 已完成+已关闭 + 进度"关闭"
- **archive**：name 缺省批量归档（completed + ≥7 天 → 移动 `_archived/`）；单会话需 completed + grace
- **list/show/health/summary/qa**：文本输出对齐 osp（health 4 类 stale/stalled/ghost/drift；qa 5 类结构/一致性/新鲜度/决策质量/产出物）
- **hook-develop-guide** 子命令；extHint（session-tool MSM 注册提示）
- **CCC 扩展模型**：整命令委派 → osp 钩子后处理（create-transform）
- S134 内存化活跃会话保留（events 恢复）+ use 输出对齐 osp（todowrite 指令）

### cc-fs（对齐 osp file-system-tool）
- **rm 需 recursive 才删目录**（非空目录 [SKIP]）；cp 目录需 recursive；**.serenity 保护**
- mv dst 存在报错+建父目录；touch 更新 mtime+建父目录；append 建父目录+返回字节数
- list/tree/exists/info/find 输出结构对齐（元数据/嵌套树/glob+fuzzy/absolute/max-depth）
- 参数集补全：recursive/filesOnly/dirsOnly/absolute/maxDepth

### cc_git（对齐 osp cc-git-tool）
- **补 pull（--ff-only + [REJECTED] 建议）与 diff（staged/ref/path）**——6 子命令
- status 输出 {clean, files:[{status,file}], summary}；log 参数 n（默认 10 max 100）
- commit/push 文本输出对齐；localstore git 合规联动保留（S134）

### acc_kit（对齐 osp acc-kit）
- health 输出 `{ccc, root, version, status: healthy|degraded, principles: {P1_rooted, P2_git_managed, P3_binary_permissions}}`；CCC 缺失返回 degraded 不抛错
- time 输出 {now_iso, now_local, epoch_ms}；wait 缺省 1s（正整数），返回 'waited Ns'
- P3 平台适配：检查配置路径（DSH 无 opencode.json）

### acc_msm（对齐 osp msm 三件套）
- **path-arg symlink 防御**（realpath 指向根外拒绝）
- **register**：path 根内 + 脚本存在 + name 全局唯一校验；保留原注册表格式（v1/数组）；精提交（只 add 注册表文件）；flags/usage 入参
- **exec 注入 env**：SERENITY_ROOT / SERENITY_CCC / SERENITY_VERSION
- 协议 flag 缩小到参数首位（--list/--schema/--format=json），业务参数无损透传
- **check 补全 DC-M1~M4**：M1 补 .spec.ts；M2 判定放宽（function main( / isMain / require.main / import.meta.url）；M3 双向（脚本未注册 + 引用缺失）；**M4 新增**（路径型 flag 未标 type:"path"）
- list 加 header（plugin version + CCC + root）+ flags 展示；guide 补全（flag schema/守卫细化/env）
- **exec 失败追加 --help TIP**（对齐 osp v0.5.38：exit≠0 且未传 --help 时 stderr 追加 TIP）
- **新增 ccc-config action**（对齐 osp：CCC 配置参考——loop.defaultModel/sessionKeeper.threshold/localstore.gitTrack/hooks.autoRestoreSession/safeMode）

### loop（对齐 osp loop-runner 保险阀）
- **补对话轮次上限 LOOP_MAX_ROUNDS=100**（osp round≥100 强制 done）；续跑/重启/guide/model 覆盖保留（dsp 增强）
- **finishReason**（done/max_rounds/restart_exceeded）+ **writeFailedStatus** 失败状态落盘（status:failed + errorCode，对齐 osp）；task 标 required；label 长度约束；description/guide 措辞与实现一致（轮次上限 100）

### 保留的 dsp 增强（不冲突，文档化）
- cce 工具（osp 无）、eap/neat section 渐进披露（中文内容）、loop 续跑/agent 重启、reveal win32 spawn、localstore 联动、msm --schema 协议

**测试：** 257/257（fs-ops/session-ops/ops 断言重写为 osp spec 行为；osp-alignment 6 项逐字节仍过）

## v1.16.14 — 2026-08-15（SESSION 跟踪内存化：活跃会话不落盘（对齐 osp active-state），进程重启从当前会话 events 解析 [SESSION CONTEXT] 恢复——根治泄漏与并行串台）

**Scope:** 用户追问泄漏根因（"放内存里了？并行怎么办"）→ 仔细检查确认：落盘标记（`.dsh/active-sessions/<scope>` 文件）**无生命周期累积** + `restoreActiveSession` **全局 mtime 扫描**（无"谁在用"感知）→ 新会话继承旧 SESSION（apaas-26116 场景）+ 并行串台。用户指示：**不能落盘，必须内存，参考 osp 完整方案**。实施：活跃会话改内存 Map，进程重启从当前会话 events 解析 `[SESSION CONTEXT]` 标记恢复（只扫自己会话）。

### 泄漏根因链（仔细检查结论）

| 层 | 根因 | 修复 |
|---|---|---|
| ① 标记累积 | 落盘标记无生命周期（use 写新 scope；close 只删当前 scope；旧会话标记永久保留） | **不落盘**——内存 Map |
| ② 恢复全局扫描 | `restoreActiveSession` 扫**所有**标记取 mtime 最新，无活跃感知 → 任何会话捞起任意旧标记 | 恢复源 = **当前会话自己的 events**（`[SESSION CONTEXT]` 标记） |
| ③ 并行串台 | 恢复的"最近激活"在并行下无唯一性 → B 会话可能捞 A 的标记 | Map keyed by scope（并行隔离）；恢复只扫自己会话 |

### 实施（对齐 osp active-state）

- **session-ops.ts 内存化**：删除 `.dsh/active-sessions` 落盘机制（`ACTIVE_SESSIONS_DIR`/`sanitizeScope`/`activeSessionMarker`/`listActiveMarkers`/`restoreActiveSession`/legacy 清理）；新增内存 `activeStore` Map（scope → {sessionId, dirName, mdPath}）+ `lastActive` + `get/set/clearActiveSessionInfo` + `resetActiveSessionStore`（测试用）
- **useSession**：写内存 Map + 返回 `context` 含 `[SESSION CONTEXT] Activated: <dir>` + `SESSION.md path: <md>`（标记随工具结果进 events——进程重启恢复源）
- **closeSession**：删内存条目（+ lastActive 修正）——不落盘无文件残留
- **readActiveSessionMd**：读内存 Map
- **恢复**：`parseSessionContextFromEvents(events)`——从**当前会话 events** 递归收集字符串，取最后一条 `[SESSION CONTEXT]` 标记解析（目录名 YYYY-MM-DD-- 校验 + SESSION.md path 提取）；`context.ts seed` 用其替代 `restoreActiveSession`（进程重启 Map 空 + 会话有历史才恢复；`hooks.autoRestoreSession` 配置保留）
- **并行**：Map keyed by scope（dsh 会话 id）→ 多 conversation/subagent/loop 各自 key，互不干扰；恢复只扫自己会话 → 无跨会话串台
- **新会话不继承**：无历史 → events 无 `[SESSION CONTEXT]` → 不恢复（v1.16.13 泄漏修复成为内存方案固有属性）
- **测试**：session-ops.test.ts 重写（内存语义 / context 标记 / scope 隔离 / close / events 恢复解析 4 例 / 心跳内存读）；osp-alignment 两处 Session 测试改用 `useSession`（内存）——共 247 测试

**测试：** 247/247（落盘机制移除 + 内存语义重写）

## v1.16.13 — 2026-08-15（SESSION 泄漏修复：恢复只对续跑/恢复的会话（有对话历史）触发——全新会话不继承旧 SESSION）

**Scope:** 用户报告 SESSION 泄漏 bug——新建会话（apaas-26116，新任务）却注入了过去 S077 的 Session 上下文。根因：v1.16.6「会话重启恢复」的 `restoreActiveSession` 对**任何主会话**（含全新无历史会话）无条件恢复最近激活 → 新任务会话继承了旧 SESSION（跨任务污染）。

### 根因与修复

- **根因**：`context.ts seed` 里 `shouldAutoRestore(agent)` 只排除 subagent/loop——全新主会话（无对话历史）也触发 `restoreActiveSession`（回退 mtime 最近标记 → 复制为当前 scope 标记 → Session 块注入旧会话）
- **修复**：新增 `shouldRestoreActive(agent)` ——**根会话 + 已有对话历史**（`agent.session.events` 非空 = 续跑/恢复的会话）才触发恢复；全新会话（events 空）不恢复
  - 新任务新会话（apaas-26116 场景）→ 无历史 → 不注入旧 SESSION ✓
  - DSH web 重启后 resume 同一 conversation → 有历史 → 恢复上次激活 ✓（保留原「重启恢复」需求语义）
  - `hooks.autoRestoreSession` 配置保留（默认 true，受 events 门控）
- `seed` 改用 `shouldRestoreActive`；测试：+3（新会话不恢复 / 续跑恢复 / subagent+loop 不恢复）

**测试：** 253/253（原 250 + 3）

## v1.16.12 — 2026-08-15（运行时状态动态块：safe-mode 状态告知 + localstore git 策略行为提示——利用系统提示词约束 agent 行为）

**Scope:** 用户要求利用系统上下文注入（系统提示词层）约束 agent 行为：① safe-mode 开启后系统提示词告知已开启（行为约束）；② localstore 是否提交设定（gitTrack）决定敏感行为提示（deny=本地私有 / allow=进 git 但敏感数据只限该文件）。

### safe-mode 状态块（`=== Serenity Safe Mode ===`，英文）

- **ON 时注入**（OFF 不注入；`isSafeModeOn` 动态检测，开关切换每轮即时生效）
- **文案与实现逐项对应**（用户审核修正：原稿与 guards.ts 不符——safe-mode 实为**只禁用 bash**）：
  - `bash is disabled (hidden and blocked)` — `restrict({ deny: ['bash'] })` + `decideGuard` bash deny（guards.ts）
  - `blacklist rules apply to file paths` — `matchBlacklist` 路径拦截
  - `CCC governance files (.serenity, .serenity-safe-on) protected` — 治理文件写拒绝
  - `Other read/write tools remain available` — `SAFE_MODE_DENY_TOOLS` 只含 bash（write/edit 保留）
  - `do not attempt to bypass` — 行为约束
- **黑名单规则动态列出**（Active blacklist rules）
- **C5 修订**：safe-mode 状态对 agent 可见（行为约束），但开关权仍归用户（WebUI `x-serenity-ui` 头保护，agent 不可自开关）

### localstore git 策略块（`=== Serenity Localstore ===`，英文，localstore.json 存在时注入）

- **deny（缺省）**：`local private file (gitTrack=deny — not committed to git, .gitignore enforced)`——凭据仅存本机，不写入对话/日志，不尝试提交（cc_git 会拒绝）
- **allow**：`committed to git (gitTrack=allow — personal private repository)`——敏感数据可进入 git 但 **ONLY in this file**（只限 localstore.json 内，不外泄到其他文件/对话/日志）——用户审核确认语义
- 文件不存在不注入；`readGitTrack` 缺省 deny

### 结构

- 注入点：#1/#2 系统提示词层——`serenitySystemPrompt` 中 Constraints 块后、EAP 块前插入两个条件动态块（每轮装配按当前状态生成，即时生效）
- 不影响 osp-alignment 逐字节断言（独立新块）；SKILL 内容 HIDDEN_LINES 过滤保留
- 机制硬防线不变：guards 拦截 + cc_git 拒绝；提示是行为约束补充

**测试：** 250/250（原 245 + 5：safeMode ON/OFF/黑名单列出 / localstore 无文件/deny/allow / 装配顺序）

## v1.16.11 — 2026-08-15（上下文注入去重：系统提示词层已注入的完整身份，对话消息/压缩重注入渠道不再重复——只留简短身份锚点）

**Scope:** 用户发现上下文注入浪费——系统提示词层（systemPrompt.section，含 subagent）已成功注入 ACC+CCC 完整内容，对话消息（session-start inject / pre-step 前置）与压缩重注入（compaction/end）再注入同一完整全文 = 每轮 token 双倍浪费。修复：完整身份只走系统提示词层；对话流/压缩渠道只注入简短锚点。

### 注入方案梳理（5 个注入点 → 职责收敛）

| 注入点 | 修复前 | 修复后 |
|---|---|---|
| #1 systemPrompt.section 全局（每轮装配自动，含 subagent） | 完整身份（ACC/CCE/Constraints/EAP/SKILL/Session） | **保持（唯一完整身份通道）** |
| #2 agent 级 scoped section（抗 shadow） | 同上 | 保持（与 #1 shadow 关系） |
| #3 context.ts session-start `agent.inject` | 简短头 + **完整全文重复** | **只注入简短身份锚点**（[ACC] 已激活 + CCC 根 + 约束 + loop 模型 + Phase 2） |
| #4 context.ts pre-step 前置消息 | 同上完整全文重复 | 同上只注入锚点 |
| #5 compact.ts 压缩重注入 | 完整全文恢复 | **只注入锚点**（完整身份在系统提示词层，不随压缩折叠——压缩无需恢复全文；锚点保压缩后可追溯 R↓） |

- **激活 SESSION（Session 块）注入位置澄清**：由 `system-prompt.ts sessionBlock` 构建，经 #1/#2 系统提示词层注入（scope = agent.session.id 按会话隔离）——修复后对话流/压缩渠道不再携带（不再重复）
- `accMessage` 签名去 scope（简短头无 Session 块）；compact.ts 未用 scope 变量清理
- **测试**：context.test.ts 更新——accMessage 只含简短头（不含 5 块/SKILL/Session）；Session 块注入由 osp-alignment 的 sessionBlock 测试独立覆盖

**测试：** 245/245（typecheck 验证 accMessage 签名变化）

## v1.16.10 — 2026-08-15（loop 等待界面修复：loop agent 注册为子代理（origin:'subagent' + parentSession）→ WebUI 子代理活动卡实时可见）

**Scope:** 用户反馈"启动 loop 没有反馈"→ 深入调研（S134）：workflow 等待界面的真实机制 = 子 agent 活动可视化（client runtime 按 `origin:'subagent'` + `parentSessionId` 识别子代理，session 事件驱动实时显示）；而 loop agent 创建时 meta 缺这两个标记 → 不被 UI 识别 → 隐形。修复：loop agent 补标记 → 对齐 workflow 子代理可见性。

### 根因（调研结论）

- **workflow 机制**：workflow 子 agent（`agent()`）创建 session 带 `origin:'subagent'` + `parentSession` → client runtime（sessions/manager.ts:774 `frame.origin === 'subagent' && frame.parentSessionId`）归入子代理目录 → WebUI（ui-subagent/workspace 树）**session 事件驱动实时显示活跃子代理卡**
- **loop 缺陷**：`ctx.agents.create` meta 只有 `cwd` + `agentPreset`——无 `origin` / `parentSession` → client 不识别为子代理 → **UI 零可见**；v1.16.9 的 /serenity/loops 详情卡需手动展开 + 首轮响应才写盘 → 用户感知"启动无反馈"

### 修复

- **loop.ts spawnAgent**：meta 补 `origin: 'subagent'` + `parentSession`（父会话 id，`exec.agent.session.id`）→ loop agent 一创建即出现在父会话的**子代理活动卡**（对齐 workflow 机制，立即有反馈）
- **副作用正确性**：`shouldAutoRestore` 本就排除 subagent origin（loop 不恢复主会话激活）✓；subagent 路由（agent-lookup）接管普通会话消息——loop 用 `loopAgent.followup` 自主驱动（agent 对象方法，不经普通路由）不受影响
- 保留 v1.16.9 的 /serenity/loops 详情卡（轮次细节 / 并行任务可视化补充）

**测试：** 245/245（typecheck 验证 meta.origin/parentSession 类型）

## v1.16.9 — 2026-08-15（loop guide 说明命令（eap 设计方案要求/并行策略/提示词规范）+ EAP 化轮次提示词（阅读/文字类加载 eap）+ WebUI loop 等待界面（/serenity/loops + 进度卡））

**Scope:** 用户反馈 goal/workflow 不如 loop 好用 → loop 增强：① guide 说明命令（使用前先加载 eap 设计规模化方案；并行策略；提示词规范；阅读/文字类 loop 内部加载 eap）；② buildRoundPrompt EAP 化（固定详尽结构）；③ WebUI loop 等待界面（类似 workflow 进度展示：/serenity/loops 接口 + 会话头部详情卡轮询显示运行中 loop）。

### loop guide 说明命令

- **`loop guide`**（参数 `guide: boolean`）：不创建 agent，直接输出 `LOOP_GUIDE` 规模化使用指引：
  - **使用前必须先加载 eap**（acc-eap）设计规模化方案：任务拆解（E↑ 显式：目标/输入/边界/验收标准）、提示词设计（task 详尽固定符合 EAP，含正反例）、并行策略
  - **并行策略**：无依赖子任务各一个独立 loop（独立 label + task）；执行方式 = 后台 subagent / workflow parallel 阶段；并发安全已保证（sessionId 唯一 + 进度按 label 隔离）；汇总方式
  - **完成判定**：唯一 = 内部 agent 精确回显验证码；对话轮无上限；非正常停止重启 ≤100
  - **等待界面**：WebUI 详情卡显示运行中 loop 进度
- 工具 description 更新（含 guide 用法）

### EAP 化轮次提示词（buildRoundPrompt）

- **固定详尽结构**：工作规范（每轮固定）——自由工作 / **阅读整理或文字编写类工作先加载 eap（acc-eap）按 EAP 标准输出（E↑ 显式 / R↓ 可重建 / S↑ 稳定）** / 汇报具体可核验；每轮汇报固定格式（做了什么/下一步/是否完成→只输出验证码）

### WebUI loop 等待界面（类似 workflow 进度展示）

- **Node half**：`/serenity/loops` GET 接口（registerStatusApi 新增路由）——按 workspace 解析 CCC 根 → `listActiveLoops`（AGENT_SESSIONS/loop-*.json 全部进度，按 updated 倒序，坏文件跳过）；不依赖工具执行上下文（进度文件驱动，并行任务天然多行）
- **client half**：SafeModePanel 详情卡新增 **loops 区块**——展开时每 3s 轮询 /serenity/loops；显示运行中 loop（label / R轮次 / 更新时间 / 最近响应摘要，最多 5 条，done 显示 ✓）；并行任务各自一行
- CSS：`.sp-popSection / .sp-loopItem / .sp-loopHead / .sp-loopLabel / .sp-loopRound / .sp-loopTime / .sp-loopResp`（--dsw-alias-* token）

**测试：** 245/245（原 242 + 3：prompt EAP 化 / guide 内容 / listActiveLoops）

## v1.16.8 — 2026-08-14（serenity.json 规范位置修正：.opencode 优先（历史兼容，不依赖 dsh）+ 系统提示词相对路径提示行）

**Scope:** 用户指出 ACC 依赖的 CCC 文件必须兼容历史（历史在 .opencode）——serenity.json 规范位置应为 `.opencode/serenity.json`（.dsh 仅回退），localstore.gitTrack 等配置随之生效；另修复"注入绝对路径 vs 工具调用相对路径打架"——加一行提示。

### serenity.json 位置修正（历史兼容，不依赖 dsh）

- **根因**：`DEFAULT_SERENITY_CONFIG_PATHS` 原为 `['.dsh/serenity.json', '.opencode/serenity.json']`（.dsh 优先）——但 ACC 依赖的 CCC 文件历史在 `.opencode/`，.dsh 是 dsh 运行时特有目录，依赖它违背"不依赖 dsh"（本机配置实际就在 `.opencode/serenity.json`，.dsh 一直靠回退才读到）
- **修正**：`DEFAULT_SERENITY_CONFIG_PATHS = ['.opencode/serenity.json', '.dsh/serenity.json']`——**`.opencode` 规范位置（历史兼容、跨运行时一致），`.dsh` 仅作 dsh 运行时回退**
- **联动生效**：localstore.gitTrack（`localstore-ops.ts readGitTrack`）、loop.defaultModel、sessionKeeper.threshold、safeMode.blacklist 全部随路径序修正
- 全部测试/文案更新：ccc.test.ts（新增 .dsh 回退优先级用例）、context/status/ops/localstore 测试改 .opencode、keeper/loop/localstore/index/ccc 注释与工具描述同步

### 系统提示词相对路径提示（注入路径 vs 工具调用打架）

- **根因**：CCC 注入路径为绝对路径（Root / SESSION.md path），但 DSH 要求 CCC 内 read/write/edit 用相对路径——agent 混合使用易错
- **修正**：绝对路径注入**保留**（标识用），ACC 块工具清单后新增提示行：
  `CCC 内文件操作（read/write/edit/glob/grep 等）请使用相对 CCC 根的相对路径；Root / SESSION.md path 等绝对路径仅作标识，不作工具入参`
- **顺带**：accBlock 的 localstore 行描述从旧 `~/.serenity/` 更新为 `CCC 根 localstore.json + git 策略`

**测试：** 242/242（原 241 + 1：.dsh 回退优先级）

## v1.16.7 — 2026-08-14（localstore 重设计：CCC 根 localstore.json + git 提交策略 + cc_git 联动）

**Scope:** 用户反馈 localstore 设计不够好（存 ~/.serenity/ 主目录不可靠/不透明）→ 重设计：存储迁到 **CCC 根根目录 `localstore.json`**（JSON 格式，MSM 可直接读取）；新增 **git 提交策略**（可靠机制 × 用户自由）；**联动 cc_git 检查**防误提交。

### 存储位置与格式（S134 重设计）

- **位置**：`~/.serenity/credentials.yaml + settings.yaml`（主目录，YAML）→ **CCC 根根目录 `localstore.json`**（单文件，JSON）
- **格式**：JSON 顶层分节——`credentials` 保留节（凭据，key 大写蛇形）+ 其余节（config，path = section.key）：
  ```json
  { "credentials": { "HOME_GITLAB_TOKEN": "xxx" }, "loop": { "defaultModel": "..." } }
  ```
- **方便 MSM 读取**：JSON.parse 零解析依赖（弃 YAML 轻量自实现解析器）；doc 子命令更新为 JSON 规范
- **权限**：CCC 内普通文件（弃 0600/0644 chmod——git 不存权限位，安全由 git 策略承担；Windows 也更干净）
- 旧 `~/.serenity/` 数据不迁移（用户已确认清理）

### git 提交策略（可靠机制 × 用户自由）

- **配置**：`.dsh/serenity.json` `localstore.gitTrack`: `"allow"`（可提交）| `"deny"`（禁提交）
- **缺省 deny（没配就是不提交）**；且 deny 的保证**不依赖 dsh 运行**：
  - **物理保证**：`localstore` 写入时自动确保 `.gitignore` 含 `localstore.json`（`ensureLocalstoreGitignored`，写一次永久生效——即使 dsh 不在/用户手动 git commit 也不会误提交）
  - **第二道防线**：`cc_git` 联动——`checkLocalstoreGitCompliance`：文件存在 && deny && .gitignore 未覆盖 → **commit 拒绝**（throw 明确提示）+ **status 输出 warning**（不阻断）
- **allow**：放行（不写 .gitignore；文件可提交，用户自行管理）

### 其他

- `ccc.ts` SerenityConfig 新增 `localstore.gitTrack`
- `tools/localstore.ts`：execute 解析 CCC 根（findSerenityRoot），set 返回 `gitTrack/gitOk`
- 测试：`localstore.test.ts` 重写（路径/JSON 格式/双命名空间/gitignore 联动/合规检查）+ `ops.test.ts` +3（cc_git 联动：deny 拒绝 commit+warning / deny+gitignore 放行 / allow 放行）

**测试：** 246/246（原 237 + 9）

## v1.16.6 — 2026-08-14（Windows 兼容性修复（审计 4 问题 + 2 观察点）· S134 会话重启自动恢复 · loop 语义修正：移除 maxRounds，对话轮无上限，非正常停止重启 ≤100）

**Scope:** ① 落实 Windows 黑盒审计报告（S009，针对 v1.16.3）的 4 个真实问题 + 2 个观察点（跨盘路径逃逸 / reveal / wait sleep / inject 核对 / quotepath / npx.cmd）；② S134 新需求——DSH 会话重启后自动恢复最近激活的宁静号会话；③ loop 语义修正（用户反馈）——轮次不需要调用者指定，对话轮次无上限（不完成不返回），100 为非正常停止时重启 agent 的次数上限，当且仅当 agent 回显验证码才算正常结束。

### Windows 兼容性修复（审计报告落实）

- **问题 1 · cc_fs 跨盘符绝对路径逃逸（🔴 安全，P3 失效）**：`ccc.ts classifyPath` 从 `path.relative().startsWith('..')` 改为**前缀判定**（新增 `pathInside`）——跨盘时 relative 返回绝对路径原文不以 `..` 开头导致漏判；前缀 + sep 边界杜绝兄弟目录陷阱（`home` vs `home2`）；Windows 大小写不敏感由调用方按平台传 `caseInsensitive`。`resolveInside` 与 msm-ops 的 path 校验（均复用 classifyPath）一并修复。新增测试：跨盘 / 大小写 / 兄弟目录
- **问题 2 · cc_fs reveal Windows 不可用（🔴）**：win32 分支改为**目录 → `explorer <dir>`、文件 → `explorer /select,<abs>`**（原对目录用 `/select,` 语义错误）；explorer 是 GUI 子系统进程（成功也常返回非零）→ 弃 `execFileSync` 退出码判定，改 `spawn` 分离 + unref（fire-and-forget）+ error 监听静默。新增测试：win32 目录/文件分支（mock platform + spawn）
- **问题 3 · acc_kit wait 依赖外部 sleep（🟠）**：`kit-ops.ts` 弃 `execFileSync('sleep')`（Windows 无 GNU coreutils），`runKit` 改 async，wait 用纯 Node `setTimeout`——跨平台统一，无平台分支。`tools/kit.ts` 同步 await；ops 测试补 wait 用例（0 秒立即 / 1 秒耗时 / 负秒拒绝）
- **问题 4 · loop inject 缺 agents（🔴）**：**核对为已修复**——v1.16.4 已把 `'agents'` 加入 inject 列表（CHANGELOG v1.16.4 有据），本版无需改动，标注复核
- **观察点 B · cc_git status/log 中文路径转义（🟡）**：status 与 log 均加 `-c core.quotepath=false`——中文/空格路径按原文输出，避免 agent 拿八进制转义串做后续路径操作
- **观察点 A · acc_msm exec Windows 空输出（🟡）**：`.cmd` 不能被 CreateProcess 直接解析 → `execFile('npx')`/`spawnSync('npx')` 在 Windows 必 ENOENT → 新增 `NPX_BIN`（win32 → `npx.cmd`）用于两处 tsx 回退；bun 优先保留（bun.exe 可被 libuv 按 PATHEXT 解析）
- **accBlock 文案**：`wait: sleep N seconds` → `wait: wait N seconds`（不再依赖 sleep）

### S134 新需求：会话重启自动恢复

- **根因**：活跃会话标记按 scope（`agent.session.id`）隔离（v1.16.2）；DSH 重启/新开 conversation → 新 session id → 自身 scope 无标记 → Session 块不注入，需手动 `session use`
- **实现**：`session-ops.ts` 新增 `listActiveMarkers` + `restoreActiveSession`——当前 scope 无标记时，把 **mtime 最新**（最近激活）且根内有效的标记复制为当前 scope 标记（激活语义延续：use = 激活，重启自动恢复 = 重新激活）；`context.ts` session-start 播种时触发，`shouldAutoRestore` 根会话判定（subagent `origin='subagent'` / 派生 `parentSession` / loop 牛马 `loop-` 前缀 → 不恢复，维持 v1.16.2 scope 隔离）；`serenity.json hooks.autoRestoreSession` 可关（默认开）
- **测试**：+11（pathInside 3 / 恢复 6 / shouldAutoRestore 5 / wait 2 —— 计 16）

### loop 语义修正（用户反馈）

- **移除 `maxRounds` 参数**：轮次不需要调用者指定——参数 schema / description / usage 同步（原可传参导致"12 轮就返回未完成"）
- **对话轮次无上限（不完成不返回）**：`for (round ≤ roundCap)` 改为 `while(true)`——只有 stop token 命中或达重启保险阀才返回；续跑从进度 round+1 继续，不再有轮号绝对截断
- **100 = 非正常停止时重启 agent 的次数上限**：`LOOP_MAX_ROUNDS` → `LOOP_MAX_RESTARTS`——followup/waitIdle 抛错 → dispose 旧 agent + 重新 create（新 sessionId）→ 同一轮重试（不消耗对话轮号），重启计数 ≤100 防死循环
- **当且仅当验证码命中 = 正常结束**：`done` 仅在 `lastResponse.includes(stopToken)` 置 true；agent 自报完成但未回显验证码 → 继续下一轮；异常路径永不置 done
- **buildRoundPrompt**：移除 maxRounds 字段，标题 `round N/M` → `round N`（续跑时 M 误导）
- **返回**：新增 `restarts` 字段（本次调用重启次数）；usage.next 文案改"已达内部 100 次重启保险阀"
- **测试**：loop-ops 用例同步（去 maxRounds）

### 运维修复（deploy 脚本，内部不进公开仓库）

- **deploy 双挂载冲突（duplicate loader entry id: serenity-hooks）**：deploy 步骤 4 原逻辑把插件自带 `cordis.patch.yml` 的 insert 块原样追加进 profile——与 npm-install 写入的 `dsh.profile.bundles`（bundle 层挂载）对同一 loader entry 双挂载 → web 启动报 `duplicate loader entry id: serenity-hooks`。修复：`profileBundleMounted`（读 profile package.json `dsh.profile.bundles`）→ bundle 层存在则**跳过 insert 写入 + 幂等清理历史 insert**（`stripInsertBlock` 按块剥离）；无 bundle 层（纯 deploy 本地开发）才写 insert 作为唯一挂载。profile 的 cordis.patch.yml 保留 `- id: serenity-hooks` 的 config 定向覆盖（v-bundle 语义，不重复加载）——deploy 不再触碰该覆盖行

**测试：** 234/234（原 218 + 16）

## v1.16.5 — 2026-08-14（loop 修复：sessionId 唯一化 + maxRounds 降级保险阀；新增 localstore ACC 标准凭据/配置存储工具）

**Scope:** ① loop 工具修复——label 不能重复（sessionId 固定冲突）+ 语义对齐（调用者不关心轮数，硬性 while + stop token 随机码验证防提前结束）；② 新增 `localstore` 工具——ACC 标准本地凭据/配置存储（S133 设计，跨 opencode/dsh × win/mac/linux）。

**loop 修复（S134）：**

- **sessionId 唯一化**：`loop-<label>` → `loop-<label>-<uuid>`——同 label 多次调用不再冲突（session 是每次新建的临时执行载体）；label 仅用于进度文件/续跑（`AGENT_SESSIONS/loop-<label>.json`）
- **maxRounds 降级保险阀**：调用者不关心轮数——`startRound` 不再 min 截断（续跑从进度 round+1 直接继续）；maxRounds 仅作防死循环绝对上限；工具描述/参数/usage 文案同步
- **stop token 随机码验证保留（loop 本质）**：`newStopToken()` 每轮 prompt 要求精确回显 → `lastResponse.includes` 判定完成——防低智能 LLM 提前结束，零改动

**localstore 工具（S133，第 10 个工具）：**

- **ACC 标准**：一个工具管理 credential（凭据，0600）+ config（偏好，0644）两命名空间；存储 `~/.serenity/`（平台感知，win `%USERPROFILE%\.serenity\`），目录 0700，不在任何 git 仓库内
- **子命令**：`list / get / set / unset / show / doc`，`--scope credential|config`（默认 credential）
- **doc 说明子命令**：输出存储路径/格式/key 规范/权限/读写方法/安全边界——agent 可按说明直接用 fs 工具（read/write）操作
- **存储格式**：`credentials.yaml`（扁平 REF→value，key 大写蛇形）+ `settings.yaml`（命名空间分节，config path = section.key 小驼峰）
- **安全边界**：list/show 对凭据只返回 key 名不返回值；get 标记 source；权限不符报错提示 chmod
- **零依赖**：YAML 轻量自实现子集（扁平映射 + 注释），不引入 yaml 包
- **注册**：index.ts（10 工具）+ accBlock 工具清单 + dsh.plugin.json contributes.tools
- **测试**：`tests/localstore.test.ts`（16 例：路径/权限/格式/读写/doc/安全）；homedir 全程 mock 临时目录

**测试：** 218/218（原 202 + 16 localstore；register 断言 9→10）

## v1.16.4 — 2026-08-14（修复 loop ctx.agents 未 inject 运行时错误 + S131 ACC 增强：scoped 身份 section / Code Mode 适配 / EAP 块 / status 扩展 / 版本自省）

**Scope:** ① bug 修复——loop 工具与 compact 缝访问 `ctx.agents` 但插件 inject 未声明 `agents` → Cordis proxy 运行时抛 "cannot get property agents without inject"；② 实施 S131 CCE×EAP 增强研究中的插件侧可实现项（P0-1 scoped 身份 section / P0-2 Code Mode 适配 / P1-6 EAP 提示块 / P2-7 status 扩展 / P2-9 版本自省）。

**Bug 修复：**

- **inject 缺 `agents`**：`index.ts` inject 列表加 `'agents'`（AgentRegistry 服务）——loop.ts `ctx.agents.create` 与 compact.ts `ctx.agents.get` 均访问；typecheck 通过是因类型层存在，运行时 Cordis proxy 拒绝未 inject 属性

**S131 增强（CCE 存续 × EAP 表现）：**

- **P0-1 scoped 身份 section**：`registerEntrySkillSection` 升级为主动路径——session-start / pre-step 时在 agent.ctx 注册 `serenity-entry`（最近层），抗 preset/动态 Cordis 插件同名 shadow 覆盖 ACC 身份；全局 section 保留为冷恢复/未走 session-start 的 fallback
- **P0-2 Code Mode 适配**：新增 `codeModeAdaptationLine`——装配时按 `ctx.tools.get('run_code', scope)` 可见性（code|both）追加 `=== Serenity Code Mode ===` 引导块（工具须经 run_code 程序内 `await tools.*` 调用），消除 Code Mode 下按 native 语义直呼工具的 UNKNOWN_TOOL 误导；全局+scoped 两个 section 的 text 回调均接入
- **P1-6 EAP 提示块**：新增 `eapBlock`（`=== Serenity EAP ===`：E↑ 显式/R↓ 可重建/S↑ 稳定自检清单），独立块插入 Constraints 与 SKILL 之间——CCE/Constraints 受 osp-alignment 逐字节断言约束不可改，EAP 为 DSH 扩展
- **P2-7 status 扩展**：`getStatus` 增 `dshVersion`（npm 全局 dsh package.json）/`nodeVersion`（process.version）；`/serenity/status` API 增 `codeRuntime` 装配态（language/isolation，PTC/Code Mode 可用性可查）
- **P2-9 版本自省**：`acc_kit health` 增 `accVersion`/`dshVersion`（升级提示依据）

**测试：** 202/202（原 196 + 6：EAP 块 2 / Code Mode 适配行 3 / status 扩展 1）

## v1.16.3 — 2026-08-14（loop 牛马 agent 继承父会话 preset，修复 read/write 等 preset 层工具不可用）

**Scope:** loop 工具创建牛马 agent 时未 join 父会话的 agent preset → web profile 下（host 全局层 tool-fs 等被 preset 化禁用）loop agent 落在空工具层，read/write/edit 等 preset 层工具不可用。修复 = 对齐 subagent 先例：创建经 `ctx.agents.create` + setup 钩子 `agentPresets.composeFrom`，继承父 preset standing mount。

**主要变化：**

- **loop agent preset 继承**：`ctx.agentLoop.create(...)`（无 setup 钩子，裸 agent）→ `ctx.agents.create({ sessionId, meta: { cwd, agentPreset }, agentOptions, setup })`；setup 钩子在 agent 未发布前执行 `agentPresets.composeFrom(childCtx, parentCtx)`，使 loop agent 获得父会话 preset 的工具层（read/write/edit 等）
- **meta.agentPreset 落库**：子 session 记录父 preset id（对齐 subagent childSessionMeta），持久化重建可还原同一组合
- **可选服务退化**：`agentPresets` 经 `ctx.get` 可选读取——无 roster 部署/父未 join preset 时跳过，loop agent 落全局工具层（历史行为），不报错
- **owned handle 清理**：`ctx.agents.create` 返回 `AgentHandle`，循环结束 `finally` 中 `handle.dispose()`（停止 loop/注销 agent/移除 session/展开 scope），不再依赖插件 fiber 兜底
- **新增纯函数模块** `src/loop-preset-inherit.ts`（`loopPresetInheritance`：解析父 preset + 组装 setup 钩子，仅 type-only 依赖 cordis，可单测）+ 测试 `tests/loop-preset.test.ts`（4 例：已 join / 未 join / 无服务 / 无父）
- **package.json**：peerDependencies 增 `@deepseek-ai/dsh-agent-presets`（optional，类型引用）；tsconfig paths 增对应映射

**测试：** 196/196（原 192 + 4：loop preset 继承四路径）

## v1.16.2 — 2026-08-14（SESSION use 按 dsh 会话隔离修复 + 发包缺陷修复）

**Scope:** ① 系统提示词 Session 块泄露修复——活跃会话标记从 CCC 级全局单文件改为按 dsh 会话隔离；② 三个发包缺陷（tarball 缺 lib/client.js / schemastery peer 范围不可满足 / README 方式二失效）。

**SESSION use 隔离（主 bug）：**

- **泄露根因**：`.dsh/active-session` 是 CCC 级**全局单文件**；系统提示词注入（systemPrompt.section 全局注册，text 回调只按 agent cwd 解析 CCC）让**任何 DSH 会话**（多开 conversation / subagent / 后台 agent / loop 牛马）都注入同一个活跃会话 → A 会话 use 的 Session 块泄漏给 B 会话，B 被引导读写 A 的 SESSION.md
- **修复**：活跃会话标记改为 `.dsh/active-sessions/<scope>`（scope = dsh 会话 id `agent.session.id`，缺省 `default`）——`useSession/closeSession/readActiveSessionMd` 按 scope 读写；系统提示词/上下文注入/turn-stopping 心跳/压缩重注入全部按当前 agent 的会话 id 取 scope；多会话互不覆盖、互不注入
- **迁移**：旧全局标记 `.dsh/active-session` 不再读取；use 时删除（迁移清理），close 顺带清理；升级后各会话重新 use 一次即生效
- **安全**：scope 文件名白名单 `[A-Za-z0-9_-]`（`.` 排除，杜绝 `..` 路径段穿越）
- **测试**：+8（scope 隔离互不覆盖 / legacy 迁移删除 / close 只清自身 scope / scope 清洗 / 心跳按 scope 隔离 / accMessage 按 scope 注入互不泄露 / osp-alignment Session 块带 scope）

**发包缺陷修复（用户报告）：**

- **tarball 缺 lib/client.js**：根因 = `npm publish` 自动运行 `prepare`，而 `tsdown.prepare.config.ts` 只构建 Node 半且 `clean: true` → **发布时 client.js 被清掉**（files/exports 已声明但包内无文件）→ DSH web 激活抛 MissingClientBundleError。修复：prepare 配置改为**复用完整双 bundle**（`export { default } from './tsdown.config.js'`，单一真相源）；`dsh-develop publish` 新增 **`npm pack --dry-run --json` 机械核对**（缺 index.js/client.js/invariant.js 任一即中止）；compliance 新增 F5（prepare 复用断言）+ E4 端到端断言 client.js 产出
- **schemastery peer 范围不可满足**：`@deepseek-ai/schemastery: ^0.1.0-rc.5` → **`^3.18.1`**（npm 实际版本 3.18.x 系列；原范围无匹配版本 → `dsh plugin add` 报 ERR_PNPM_NO_MATCHING_VERSION）。cordis 4.0.0-rc.7 在 npm 存在（已核实），无需改
- **README 方式二已失效**：`dsh plugin add github:tellmewhattodo/dsh-serenity-plugin` 安装的是仓库根包（`@shgroup/dsh-serenity-plugin`，workspace 容器、无 dsh.bundle）不会激活 → README 中英双语方式二改为 **clone + `link:<repo>/hooks/dsh-serenity-hooks`**，并警告不要用 github: 根 URL

**测试：** 192/192（原 184 + 8：session 隔离 5 + context scope 注入 1 + compliance 2）

## v1.16.1 — 2026-08-13（npm 公开发布 1.16.0 + README 补丁）

**Scope:** 公开发布 @shgroup/dsh-serenity-hooks 到 npm registry（1.16.0 成功），补插件包 README（npm 包页面显示）+ files 字段 + publishConfig access public + repository。

**主要变化：**

- **hooks/README.md**（新增）：插件包 README（安装/工具/系统提示词/配置），随包发布
- **package.json**：files 加 `README.md`；补 `license` / `repository`（GitHub）/ `publishConfig.access: public`；去 `private`
- **npm 发布**：`@shgroup/dsh-serenity-hooks@1.16.0`（2026-08-13 23:24 UTC，maintainer shgroup）；1.16.1 补 README

**测试：** 184/184

## v1.16.0 — 2026-08-13（适配 DSH 公开测试版 deepseek-ai/deepseek-harness 0.1.0-rc + 系统提示词对齐 osp 收紧）

**Scope:** DSH 公开测试版（github.com/deepseek-ai/deepseek-harness，本地运行时 0.1.0-rc.6）发布后全量适配：包/服务/事件改名 + 类型基准切换 + 系统提示词对齐 osp 收紧（去 `---` 分隔线与包裹头，CCE/Constraints/Session 逐字节一致）+ 运行时加载修复。

**公开版改名（DSH 侧）：**

- `@deepseek-ai/dsh-compact` → **`@deepseek-ai/dsh-compaction`**（压缩事件 `compact/*` → **`compaction/*`**，载荷增加 compactionId/sourceCommandId）
- `@deepseek-ai/dsh-bash` → **`@deepseek-ai/dsh-shell`**、`@deepseek-ai/dsh-bash-env` → **`@deepseek-ai/dsh-shell-env`**（服务 `ctx.bashEnv` → **`ctx.shellEnv`**）
- `ctx.httpServer` → **`ctx.webServer`**（webserver 服务改名）
- `schemastery` → **`@deepseek-ai/schemastery`**、`cordis` 运行时为 **`@deepseek-ai/cordis@4.0.1`**
- 声明合并目标改为 `@deepseek-ai/dsh-session/types`（compaction 事件类型）

**主要变化：**

- **tsconfig.json / client/tsconfig.json**：路径映射从私有 staging（`~/.dsh/source/current`）切换为**公开版已安装包**（`~/.npm-global/.../@deepseek-ai/dsh/node_modules/@deepseek-ai/*`，0.1.0-rc.6）；类型检查全绿
- **seams/compact.ts**：监听事件 `compact/end` → **`compaction/end`**（语义不变：无 error 即成功重注入）
- **seams/env.ts / api.ts / index.ts**：`shellEnv` / `webServer` / `@deepseek-ai/schemastery` 适配；inject 列表更新
- **seams/system-prompt.ts**：① 块间拼接去掉 `---` 分隔线（对齐 osp 逐项 push 的换行拼接）；② SKILL 全文**原文直推**（去掉 `# CCC 入口技能` 包裹头，对齐 osp `output.system.push(state.skillContent)`）；③ 修复 `resolveActiveSessionInfo` 目录名解析 bug（basename(abs) → basename(dirname(abs))，Session 块正确显示会话目录名）
- **tests/osp-alignment.test.ts**（新增）：CCE/Constraints/Session 与 osp v0.8.5 参照文本**逐字节断言**（唯一例外 = Constraints 工具名 `msm_exec`→`acc_msm` 平台替换）；SKILL 原文直推 + 装配结构断言
- **package.json**：peerDeps 全部切到公开版包名（^0.1.0-rc.5）+ 新增 dsh-shell/shell-env/skill/system-prompt/agent-loop/compaction/schemastery；devDeps tsdown 0.7.5 → 0.22.14（rolldown 1.2.3 移除了 `transformPlugin`，0.7.5 无法构建）+ unrun
- **dsh.plugin.json**：engines dsh >=0.1.0-rc.5

**运行时加载修复（根因）：**

- profile 中 `~/.dsh/profiles/node_modules/@shgroup/dsh-serenity-hooks` 曾是**指向旧 staging 的符号链接**（@deepseek-ai 依赖解析到旧包名，宿主 rc.6 与插件依赖版本错配 → 工具不注册）——改为**真实目录**安装，依赖经 profile node_modules 解析到 rc.6；headless 验证：9 工具（cc_fs/session/acc_kit/cc_git/acc_msm/eap/neat/cce/loop）+ `serenity-entry` section（order -50）全部注册

**测试：** 184/184（原 178 基线 +6：osp 对齐 6 用例）

## v1.15.8 — 2026-08-09（EAP 优化：session use/close + Session 块激活 + 平台工具说明）

**Scope:** EAP 评估优化（#1 Session 块 + #2 工具清单）；用户确认 dsh session 缺 `use`（osp 有）。

**主要变化：**

- **session-ops.ts**：新增 `use`（写 `.dsh/active-session` 标记，内容 = 相对 CCC 根的 SESSION.md 路径 → **系统提示词 Session 块激活**）与 `close`（删标记）——9 子命令（list/show/create/use/close/health/qa/archive/summary）
- **tools/session.ts**：use/close 路由 + 描述更新（`ACTIVE_SESSION_MARKER` 导出）
- **system-prompt.ts**：ACC 块工具清单补**平台工具说明**（read/write/edit/glob/grep/web_search/ask_user_question/subagent/workflow/goal 等仍可用——ACC 工具是宁静号原生层，非全部工具）
- **tests**：session-ops +3（use 写标记/Session 块生效、use 未找到抛错、close 删标记）；system-prompt ACC 块断言补平台工具说明

**测试：** 178/178

## v1.15.7 — 2026-08-09（[ACC] 注入消息包含完整系统提示词 + CCC 顶层 skill 原文）

**Scope:** 用户要求：**在此处**（[ACC] 注入消息，agent.inject 通道）注入完整 ACC 系统提示词内容 + CCC 顶层 skill 原文——此前 accMessage 只有简短 4 行身份头。

**主要变化：**

- **context.ts**：`accMessage` 改为完整注入 = 简短身份头 + `serenitySystemPrompt(root)`（ACC 5 块 + CCC 顶层 skill 原文，对齐 osp system.transform）；导出供 compact.ts 复用
- **compact.ts**：复用 context.ts 的 `accMessage`（单一真相源，压缩重注入同样完整）
- **tests/context.test.ts**：+1 用例（accMessage 含简短头 + ACC/CCE/Constraints 块 + .serenity 记号发现的 tg-serenity 原文）

**测试：** 175/175

## v1.15.6 — 2026-08-09（系统提示词完整注入：5 块对齐 osp + .serenity 记号发现）

**Scope:** 用户指出：① 注入内容必须**完全参考 opencode-serenity-plugin**（不得有误差）；② CCC 的根提示词位置记录在 **`.serenity` 记号文件**中（内容 = 顶层入口 skill 名，如 tiangong-serenity 的 `.serenity` = `tg-serenity`）。

**根因：** findEntrySkills 硬编码 `home-serenity`/`acc-serenity` 名字，无法发现 tiangong-serenity 的 `tg-serenity`；且只注入 SKILL 全文，缺 ACC/CCE/Constraints/Session 块。

**主要变化：**

- **skills-discovery.ts**：入口发现改为——① **`.serenity` 记号文件内容 = 顶层入口 skill 名**（最高优先，权威语义）；② `.dsh/entry-skill` 指针兼容；③ 自动扫描 `.opencode/skills/*-serenity`；④ 自动扫描 `.dsh/skills/*-serenity`。任何 CCC（home-serenity/tg-serenity/pangu-serenity）自动发现
- **system-prompt.ts**：完整 **5 块注入，逐字对齐 osp compacting.ts system.transform**：
  1. `=== Serenity ACC ===`（ACC 身份 + CCC/Root + 9 工具清单）
  2. `=== Serenity CCE ===`（CCE 5 行为约束 + H_op，逐字）
  3. `=== Serenity Constraints ===`（Root + 文件/shell/subagent/session-first，逐字）
  4. SKILL.md 全文（该 CCC 顶层入口全量）
  5. `=== Serenity Session ===`（活跃会话 + todowrite 首位约定）
- **tests/system-prompt.test.ts**：重写覆盖 .serenity 记号发现 + 5 块注入内容断言（ACC 工具清单/CCE 5 约束/H_op/Constraints 四行）

**测试：** 174/174

## v1.15.5 — 2026-08-09（入口 skill 全文注入根因修复：inject 补 systemPrompt）

**Scope:** 用户反馈：v1.15.4 后系统提示词仍未注入。查明最终根因：**插件 `inject` 列表缺 `systemPrompt` 服务**——`ctx.systemPrompt` 在 apply 时未就绪（Cordis 依赖注入），`registerEntrySkillSectionGlobal` 的 try/catch 静默吞掉注册失败。官方对照：plan-mode `static inject = ['tools', 'systemPrompt']` 明确声明。

**主要变化：**

- **index.ts**：`inject` 加 `'systemPrompt'`（`['tools', 'httpServer', 'sessions', 'bashEnv', 'skills', 'agentLoop', 'systemPrompt']`）
- **system-prompt.ts**：注册失败改为**显式 console.error 告警**（不再静默吞错——系统提示词注入是关键能力）；成功打印确认
- **验证依据（DSH 源码）**：`assembleContextFor(agent)` 返回 `{ agent, scope: agent }`，assembly scope = agent；`systemPrompt.section` 经 ScopedLayers 全局+scoped 合并，全局 section 参与所有 assembly

**测试：** 169/169

## v1.15.4 — 2026-08-09（入口 skill 全文注入修复：agent 级 → 全局 section）

**Scope:** 用户反馈：ACC 插件必须在任何会话注入 CCC 顶层 skill（xx-serenity）全文，检查实现。查明根因：原 `registerEntrySkillSection` 用 **agent.ctx**（agent 级 scoped）注册 `systemPrompt.section`，scope 绑定脆弱，注入不可靠。

**根因（源码级）：** DSH `systemPrompt.section` 经 ScopedLayers 注册——官方惯例（plan-mode/tool-bash/goal）是**全局 ctx 注册 + text 回调按 `context.agent` 动态判断**；`AssembleContext` 被 agent 包扩展为含 `agent?: Agent`（agent/types.ts declare module 合并）。

**主要变化：**

- **system-prompt.ts**：新增 `registerEntrySkillSectionGlobal(ctx)` — **全局一次注册** `serenity-entry` section（order -50），text 回调按 `context.agent.session.header.cwd` 上溯 `.serenity` → 返回该 CCC 的顶层入口 skill **全量原文**（home-serenity + acc-serenity，sanitize 过滤治理内容）；非 CCC/无 agent 返回空。任何会话（主 agent/subagent/后台 agent）自动获得全文
- **context.ts**：移除 agent 级 `registerEntrySkillSection` 调用（全局已覆盖）与 `entrySkillSection` 配置项
- **index.ts**：apply 中调用 `registerEntrySkillSectionGlobal(ctx)`
- **tests/system-prompt.test.ts**：+2 全局注册用例（text 回调按 agent cwd 解析 CCC → 全文；非 CCC/无 agent → 空；重复注册不抛）
- **旧接口** `registerEntrySkillSection`（agent 级）保留导出兼容既有调用方

**测试：** 169/169

## v1.15.3 — 2026-08-09（safe-mode deny 提示不泄露机制：bash 直接提示不存在）

**Scope:** 用户反馈：safe-mode 下 bash 被 deny 时的错误提示泄露了 safe-mode 机制（"先关闭 .serenity-safe-on"），应直接提示 bash 不存在（与 restrict 隐藏 bash 后的模型视角一致）。

**主要变化：**

- **guards.ts**：bash deny 消息 `safe mode: "bash" 被禁用，先关闭 .serenity-safe-on` → `bash: 没有这个工具`（safe-mode 对 agent 不可见的一致性）
- **tests/guards.test.ts**：断言更新——deny 含 bash、不含 safe mode/serenity

**测试：** 167/167

## v1.15.2 — 2026-08-09（压缩保留 P2：compact/end 后重注入 ACC 身份）

**Scope:** osp/dsp 机械门控对比（第五轮）：osp 生态限制未做的 P2（压缩保留）在 DSH 有缝可做，用户同意实施；P8（GUI 审批策略）确认 DSH approval 原生已解决，关闭。

**主要变化：**

- **新增 `seams/compact.ts`** — `session/event` 监听 `compact/end`（成功，无 error）→ `ctx.agents.get(session.id)` 解析 agent → 若 cwd 在 CCC 内，`agent.inject` 重注入 ACC 身份消息（与 context.ts 共用 `accIdentityText`，恢复性注入不依赖计数）
  - 依据：DSH compact 事件语义（`compact/start` 持锁 / `compact/summary` / `compact/end` 带 error 记录失败）；压缩折叠早期注入的 `[ACC]` 消息 → 重注入防模型丢失 CCC 约束
- **index.ts**：新 Config 项 `compactRetention`（默认 true）+ 注册接入
- **tsconfig.json**：paths 加 `@deepseek-ai/dsh-compact`（staging packages/compact/compact）
- **compact.ts**：`import type {} from '@deepseek-ai/dsh-compact'` 拉入 SessionEventMap 的 declare module 合并（compact/* 事件类型化）
- **tests/compact.test.ts**：+4 用例（成功重注入 / error 跳过 / 非 compact 事件跳过 / 重复压缩每次都注入）
- **README**：拦截缝表加压缩保留行；版本/测试数同步

**测试：** 167/167

## v1.15.1 — 2026-08-09（cc_fs 补 reveal：OS 文件管理器打开路径）

**Scope:** 用户要求：cc_fs 应支持 reveal（opencode-serenity-plugin 已支持，本插件补齐）。

**主要变化：**

- **fs-ops.ts**：新增 `reveal` action（15 子命令）——Linux `xdg-open`（文件打开所在目录、目录打开自身）/ macOS `open -R`（Finder 选中）/ Windows `explorer /select,`；10s 超时；路径仍经 `resolveInside` 守卫（逃逸阻断）；返回 `{ ok, revealed }` 规范值
- **tools/cc-fs.ts**：工具描述 14 → 15 子命令
- **tests/fs-ops.test.ts**：+6 reveal 用例（打开文件→父目录、打开目录→自身、缺 path、不存在路径、逃逸阻断、CC_FS_ACTIONS 含 reveal；`vi.mock('node:child_process')` 避免真实弹窗）
- **模板 acc-fs/SKILL.md + README**：子命令清单同步 15

**测试：** 163/163

## v1.15.0 — 2026-08-09（DSH plugin 开发标准合规化）

**Scope:** 用户要求：研究 DSH 完整 plugin 开发标准（turtle-ui 参考 + 官方文档），标准成文入仓，并按标准改造插件到合规。

**标准文档：**

- **新增 `docs/plugin-development-standard.md`** — DSH plugin 开发标准成文（A 插件形态 / B bundle 清单 / C defineTool 契约 / D 拦截缝 / E 安装分发 / F 构建工程 / G 测试策略 + 本仓合规核对清单），权威来源 = DSH staging 官方文档 + turtle-ui / marisa 范例

**合规改造（B/E/F 项）：**

- **B1/B2/B3**：新增插件自带 `cordis.patch.yml`（bundle 层，`insert` 行 `name` 用包名）+ package.json 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` — 官方 bundle 形态（此前用自创 `dsh.plugin.json`，官方无此字段）
- **E4**：新增 `prepare` script + `tsdown.prepare.config.ts` + `tsconfig.prepare.json` — 消费端自包含构建（git 安装场景，不依赖 sibling staging checkout、不 typecheck）
- **F1**：package.json 补 `files`（lib/ + cordis.patch.yml + dsh.plugin.json）
- **F2**：补 `peerDependencies`（cordis + @deepseek-ai/dsh-tools/agent/session/llm/host-webserver，host-webserver optional）
- **F3**：build script 对齐标准（tsc + tsdown 双 bundle）
- **load-plugin.sh / dsh-develop deploy**：profile patch 内容改为读取插件自带 cordis.patch.yml（不再硬编码 INSERT_BLOCK）——与 `dsh plugin --profile web add` 官方路径一致
- **新增 `tests/compliance.test.ts`** — 机械合规门禁（B1/B2/B3/E4/F1/F2/F3 七项）

**测试：** 150/150（+compliance 7 项）

## v1.14.3 — 2026-08-08（loop 无超时：每轮等待可永续）

**Scope:** 用户要求：loop 本身不应有超时时间，可永续。

**主要变化：**

- **loop.ts**：`waitIdle` 移除 600s 硬超时——每轮等待 agent 空闲**无时限**（loop 永续：agent 工作多久等多久，不被超时打断）；删除 reject 路径（等待不再失败）
- maxRounds 默认 100 保留（轮数上限仍是用户可配置的终止条件；停止标记优先）

**测试：** 149/149（未部署，待下次发布）

## v1.14.2 — 2026-08-08（死锁根治：acc_msm exec 异步化 + restrict 挂载修复）

**Scope:** 用户诊断确认死锁：spawnSync 同步阻塞事件循环 → MSM 自请求 3080 永不响应（最长 10 分钟/次）。

**主要变化：**

- **msm-ops.ts**：`prepareExec`（校验/协议 flag 分流）+ `runMsmAsync`（execFile + promisify + timeout kill，**不阻塞事件循环**）；`runMsm` 同步版保留（session 委派）；协议 flag（--list/--schema）兼容
- **context.ts**：pre-step 每步无条件 `syncSafeModeRestriction`（原只在首次注入分支，safe-mode 切换后 restrict 永不同步）
- **guards.ts**：restrict 诊断（lastSuccess/lastError/activeKeys）→ status API + `AGENT_SESSIONS/.restrict-diag.json` 文件通道
- **dsh-develop**：api-status（node http）、sys（白名单命令，curl 强制 --max-time 5）、read-dsh 绝对路径、restart-web 端口轮询等待
- **机制确认（DSH 源码级）**：模型 tools = assemble().toolProviders → wireSchemas(scope) → view(scope).visible（restrict-aware）；preStep 顺序 = assemble 先于 pre-step → restrict 下一 step 生效

**测试：** 149/149

## v1.14.1 — 2026-08-08（safe-mode 语义修正：只隐藏 bash + 治理文件写保护 + 版本漂移修复）

**Scope:** 用户反馈修正（v1.14.0 后）：safe-mode 只隐藏 bash（write/edit 保留）；safe-mode 是**用户能力**——agent 不可见、不可自开关；loop 工具补 task 参数 + 使用自述。

**主要变化：**

- **guards.ts**：`SAFE_MODE_DENY_TOOLS = ['bash']`（v1.14.0 曾将 write/edit 一并 restrict，修正为标准语义）；新增 **CCC 治理文件写保护**——`.serenity` / `.serenity-safe-on` 对 agent 永远 deny（safe-mode 是用户能力，agent 不能篡改/自开关）
- **system-prompt.ts**：`sanitizeSkillContent` 过滤入口 skill 原文中的"安全模式/safe-mode/.serenity-safe-on"提及——safe-mode 对 agent 不可见
- **context.ts**：身份注入文本不再提及 safe mode（同步修正）
- **api.ts**：POST 开关要求 `x-serenity-ui: 1` 头（仅 WebUI 客户端可切换；agent 侧无此能力）
- **loop.ts**：`task` 参数（调用方显式任务目标）+ 结果返回 `usage` 使用自述（供调用 agent 理解循环协议）
- **客户端 SafeModePanel.tsx**：POST 携带 `x-serenity-ui: 1`；字号 14；loop 模型标签 `loop:<model>`

**测试：** 91/91（guards 新增治理文件 3 用例；修正 restrict 断言仅含 bash）

## v1.14.0 — 2026-08-08（loop task 参数 + 使用自述；safe-mode 隐藏 bash/write/edit）

**主要变化：**

- loop 工具：`task` 参数（必填语义：告诉 loop agent 做什么）+ 每轮 `usage` 使用自述返回（调用 agent 可理解循环协议与续跑方式）
- safe-mode：开启时 restrict deny bash/write/edit（后于 v1.14.1 修正为仅 bash）
- loop lastAssistantText 读取 `data.message.content`（新版事件结构；M3 冒烟实测通过）

**测试：** 88/88

## v1.13.0 — 2026-08-08（acc_loop 工具：廉价模型 M3 牛马循环）

**Scope:** 用户需求：廉价模型 M3（MiniMax-M3）牛马循环（老 loop 等效）。

**主要变化：**

- **`src/tools/loop.ts`**：`loop` 工具（label/maxRounds/model/task/session 参数），`agentLoop.create(id,{provider,model},{cwd})` + waitIdle（`agent/status` payload 判 idle）；每轮全新 agent、无对话种子、进度文件 `AGENT_SESSIONS/loop-<label>.md/.json` 续跑
- **`src/loop-ops.ts`**：轮次提示构建（`buildRoundPrompt`）、`splitModel`、`newStopToken`；M3 provider（OpenAI-compatible `api.minimaxi.com/v1/chat/completions`）
- **profile patch**：llm-pi-ai id-targeted override（`opencode-fixed`：`api: openai-completions` + `models: [MiniMax-M3, MiniMax-Text-01]` + baseURL + 字面 apiKey）
- **`src/seams/env.ts`**：bashEnv 注入 DSH_SERENITY_ROOT/CCC/VERSION
- LOOP-DESIGN.md 调研文档（老 loop 等效性、M3 验证）

**测试：** 81/81

## v1.12.1 — 2026-08-08（WebUI 面板细节）

- SafeModePanel 字号 14；loop 模型标签 `loop:<model>` 清晰化

## v1.12.0 — 2026-08-08（cce 工具补齐：eap/neat/cce 知识工具 ACC 级完整）

- **`src/tools/acc-extras.ts`**：`eap` / `neat` / `cce` 三个知识工具（渐进式披露：无 section 返回完整框架，指定 section 聚焦）；EAP 三变量/自检清单、Neat 四铁律/五层、CCE 容器/熵/生命周期
- 工具模板技能（acc-eap/acc-neat/cce 的 SKILL.md）降级为 fallback

**测试：** 78/78

## v1.11.1 — 2026-08-08（session 委派失败回退内置 + 版本同步）

- `session` 工具：`{delegated:true, exit:1}` 时回退内置实现（其他 CCC 的 legacy session-tool MSM 委派失败不再空输出）
- 版本统一 1.11.0 → 1.11.1

## v1.11.0 — 2026-08-08（顶层 xx-serenity 入口 skill 原文 → 系统提示词 section 加强版）

**Scope:** 用户要求："顶层 xx-serenity skill 原文必须作为系统提示词注入"。

- **`src/seams/system-prompt.ts`**：`entrySkillSectionText(root)` 拼接入口 skill 原文（acc-serenity + home-serenity，dedup）；`registerEntrySkillSection(agent, root)` 经 `agent.ctx.systemPrompt.section({name:'serenity-entry', order:-50})` 注入——agent 作用域、CCC 根闭包
- 与身份注入（session-start seed + pre-step）双轨并存

## v1.10.0 — 2026-08-08（opencode skill 标准兼容）

- **`src/seams/opencode-skills.ts`** + **`src/skills/opencode-scan.ts`**：`ctx.skills.registerProvider` 扫描 `.opencode/skills/*/SKILL.md`（frontmatter name/description/whenToUse），rank 250，resourceBase = skill 目录
- opencode skill 标准的 SKILL.md 直接可被 DSH agent 加载

## v1.9.0 — 2026-08-08（ACC 标准补齐：除 loop/resident 全实现 + 版本漂移修复）

**Scope:** 对照 ACC 标准（opencode-serenity-plugin）除 loop/resident 外全部实现。

- **acc_msm**：guide 子命令 + 协议 flags（--list/--schema/--format=json）+ path 参数 type:"path" 校验（逃逸阻断）
- **session**：委派 + 全周期（create/list/show/health/qa/archive/summary）
- **eap/neat** 知识工具；**Phase 2** 访谈（session-start seed）；**shell.env**（bashEnv 注入）
- **修复**：ACC_VERSION 自动从 package.json 派生（消除与 CHANGELOG 漂移）

## v1.8.0 — 2026-08-07（CCC 入口 skill 自动注入系统提示 + WebUI 完成）

**Scope:** 用户需求：ACC 自动发现 CCC 顶级入口 skill 并注入系统提示（对应 opencode system.transform 全量注入）。

**主要变化：**

- **`src/skills-discovery.ts`**（纯逻辑）：入口 skill 发现——`.dsh/entry-skill` 指针文件（内容=skill 名）优先，回退约定 `.dsh/skills/acc-serenity/SKILL.md` → `.opencode/skills/home-serenity/SKILL.md`；`truncateContent` 超限截断
- **context.ts**：身份注入消息并入入口 skill 全文（默认上限 30000 字符，Config `entrySkillMaxChars` 可调/0 关闭）
- **WebUI 完成**：SafeModePanel 改挂 `conversation.session.header.actions`（加性 list 槽，位置满意）；客户端按 `sessionId` 查询，服务端经 `ctx.sessions.get(id).header.cwd` 解析 workspace（修复"非 CCC"误判）
- home-serenity 已建 `.dsh/entry-skill` 指针（→ acc-serenity）

**测试：** 65/65（新增 skills-discovery 5 用例）

## v1.7.0 — 2026-08-07（DSH 升级适配 + WebUI client half）

**Scope:** 适配 DSH 升级（staging-20260807T001421Z）破坏性变更 + 完成 WebUI 阶段 2（client bundle）。

**DSH 升级适配（服务端）：**
- `agent/prompt-submit` **被移除** → 迁移到 `agent/pre-step`（step 级准入，payload 对象 + PreStepDecision `enter{messages}/reject`）；ACC 身份注入改为前置消息到 `messages`
- `agent/session-start` / `agent/turn-stopping` 签名改 **payload 对象**（`{agent, ...}`）
- `PromptDecision` → `PreStepDecision`（类型）
- guards/keeper/api/工具层经新版本 typecheck 无改动（事件缝兼容）

**WebUI 阶段 2（client half）：**
- package.json：`dshClient {platform:'web', inject:[runtime]}` + `exports["./client"]`
- `src/client/`：`SafeModePanel.tsx`（输入停靠栏：ACC 版本/CCC 状态/safe-mode 开关，经 `/api/serenity/status`）+ `client/index.ts`（注册 `conversation.input.dock` 槽）
- `tsdown.config.ts`：双 bundle（node + browser），平台模块 external，`__ModuleLoader__.load` 包装
- 构建：harness tsdown 0.22.2（本仓 0.7.5 与 rolldown 1.2.3 不兼容）；产物 `lib/client.js` 3.8kB + `lib/index.js`

**测试：** 60/60（服务端）；客户端 typecheck 过新版本类型契约

## v1.6.0 — 2026-08-06（WebUI 阶段 1：状态接口 + safe-mode 开关后端）

**Scope:** WebUI safe-mode 实时开关 + 插件实时状态显示（需求：直接 WebUI 操作，非斜杠命令）。

**主要变化：**

- **`src/status.ts`**（纯逻辑）：`getStatus(cwd)`（ACC 版本/CCC 根/safeModeOn/黑名单/keeper 阈值/loop 模型）、`setSafeMode(root, on)`（写/删 `.serenity-safe-on`，守卫实时读取→写即生效）
- **`src/api.ts`**：`ctx.httpServer` 路由 `/api/serenity/status`（GET 状态 / POST 切换），同源调用无信任围栏问题
- 插件 Config 新增 `api` 开关（缺省 true），`inject` 增 `httpServer`
- `ACC_VERSION` 抽到 `src/constants.ts`（纯模块）
- **`docs/WEBUI.md`**：架构 / 服务端阶段 1 ✅ / 客户端阶段 2 计划 / 部署 / 验证清单
- 测试：`tests/status.test.ts` 5 用例；全仓 60/60

## v1.5.1 — 2026-08-06（激活门控修复：keeper 只在 .serenity 目录生效） — 2026-08-06（激活门控修复：keeper 只在 .serenity 目录生效）

**Scope:** 用户核查"只在 .serenity 存在的目录激活"——发现 session-keeper 缺口并修复。

**主要变化：**

- **keeper 激活门控**：`tools/post-execute` 先查 `findSerenityRoot(agent cwd)`，无 `.serenity` 直接放行（不计分、不提醒）。此前 keeper 在任何目录都会计分触发提醒——与"CCC 外零干预"约定不符
- 新增 `tests/gate.test.ts`：非 CCC 目录原样放行（无提醒）/ CCC 目录达阈值注入提醒——2 个用例

**激活门控全景（.serenity 门控，其余零干预）**：守卫 ✅ / 上下文注入 ✅ / 回合落盘 ✅ / **keeper ✅（本次修复）** / 工具（全局注册，CCC 外调用报错降级）

**测试：** hooks 53/53 + 根层 54/54 = 107

## v1.5.0 — 2026-08-06（知识技能对齐 native 插件现实 + DEPLOYMENT.md 运维指南）

**主要变化：**

- `acc-serenity` 入口技能更新：工具与约束改由 Native 插件提供（5 个真实工具 + 拦截缝机械守卫），知识层只承载 EAP/Neat/纪律；已重装到 home-serenity `.dsh/skills/`
- `docs/DEPLOYMENT.md`：部署步骤 / 验证清单 / 回滚 / 升级 / 常见问题

## v1.4.0 — 2026-08-06（加载机制端到端预检通过）

**Scope:** 加载路径实证 + 部署脚本修正（复制而非 symlink + schemastery shim + 预检步骤）。

**主要变化：**

- **解析链源码实证**：`boot()` 设 `ctx.baseUrl = apps/cli/config/`；workspace 链接在 `apps/cli/node_modules`（含 cordis + 全部 @deepseek-ai/*），**根 node_modules 无 cordis/schemastery**
- **symlink 陷阱确认**：symlink 插件会让 Node 按 realpath（本仓）解析内部导入 → cordis/schemastery 不可达 → **必须复制**
- **schemastery shim**：apps/cli/node_modules 无 schemastery → 插件包自身 node_modules 补链接（vendor/schemastery）
- **load-plugin.sh 重写**：构建 → 复制（保留 package.json/lib）→ shim → 预检导入 → config.yaml insert → 重启提示
- **端到端预检通过**：/tmp 模拟真实部署结构（复制插件 + 顶层 cordis/@deepseek-ai + 包内 schemastery），从 config 目录动态导入 → `插件加载成功: dsh-serenity-hooks | inject: ["tools"]`

## v1.2.0 — 2026-08-06（ACC 上下文注入缝 + 加载脚本）

**Scope:** 补齐目标中的最后两个拦截缝（session-start / prompt-submit）+ 加载就绪。

**主要变化：**

- **`src/seams/context.ts`** — ACC 上下文注入：
  - `agent/session-start`（emit）：CCC 内新会话一次性播种 ACC 身份（`agent.inject`，含 CCC 根/版本/约束摘要/loop 模型/Phase 2 提示）
  - `agent/prompt-submit`（waterfall）：每 agent 首次进入 CCC 时附加身份到 additionalContexts（Set 去重防 token 膨胀；context-only 严格 `next()` 委托）
- **`scripts/load-plugin.sh`** — 加载脚本（dry-run 支持）：构建 → 包符号链接入 DSH node_modules（--no-save 不改 git）→ `~/.dsh/config.yaml` insert 行（自动备份）→ 重启提示。边界操作已就绪，待用户批准执行
- loop.ts turn-stopping 签名对齐（turn/signal 参数）

**测试：** 51/51 vitest + typecheck 过真实 DSH 类型契约

## v1.1.0 — 2026-08-06（全量工具 + session-keeper DCP）

**Scope:** M3 非侵入部分完成——5 个真实 DSH 工具 + 4 组拦截缝。

**主要变化：**

- **新增 3 个真实工具**：`acc_kit`（health/time/wait）、`cc_git`（status/commit/push/log + 非快进建议）、`acc_msm`（list/exec/register/deregister/check + mech-registry）
- **session-keeper DCP**（`src/seams/keeper.ts`）— 照 dsh-external/tool-failure-guard 的 observe-and-enrich 模式：`tools/post-execute` 计分（write/edit=3, task=10, read/msm=1, +1 分/分钟），达阈值向 additionalContexts 折叠 `[SESSION-KEEPER-recorded-{code}]` 提醒；阈值读 `.dsh/serenity.json sessionKeeper.threshold`（缺省 150）；纯跟踪器 `KeeperTracker` 可单测
- 插件现注册 5 工具 + 4 缝：pre-execute/guard（守卫）、turn-stopping（落盘）、post-execute（keeper）
- dsh.plugin.json contributes.tools 同步 5 工具；invariant REGISTERED_TOOLS 一致

**测试：** 48/48 vitest + typecheck 过真实 DSH 类型契约

## v1.0.0 — 2026-08-06（方向修正：Native Cordis Plugin）

**Scope:** 按用户要求把实现方向修正为 **native Cordis plugin**。新增 `hooks/dsh-serenity-hooks/` 独立包——真实 DSH 工具注册 + 拦截缝机械约束。参考 `dsh-external` 组织（用户授权）已写插件校准：dsh-tool-calculator（defineTool 金标准）、dsh-my-rsi（creating-a-plugin 规范：invariant.ts + dsh.plugin.json + exec.arguments + post-execute observe-and-enrich 模式）。

**主要变化：**

- **`hooks/dsh-serenity-hooks/`**（新主产物，独立 npm 包 `@shgroup/dsh-serenity-hooks`）：
  - 插件契约：`name` / `inject: ['tools']` / `Config`（schemastery）/ `apply`，无 default export
  - **真实 DSH 工具**（`ctx.tools.register(defineTool(...))`）：`cc_fs`（14 子命令，进程内，取代 bash spawn runner）、`session`（7 子命令，AGENT_SESSIONS 全周期）
  - **拦截缝机械约束**：`tools/pre-execute` + `ctx.tools.guard`（safe-mode 写工具禁用/黑名单/路径逃逸）、`agent/turn-stopping`（活动会话心跳落盘，`.dsh/active-session` 标记）
  - `src/invariant.ts` 伴生 + `dsh.plugin.json` 清单（contributes.tools 与代码一致校验）
  - 纯逻辑层（ccc/fs-ops/session-ops）零 DSH 依赖，可独立单测
  - **typecheck 通过真实 DSH 类型契约**（tsconfig paths → staging checkout lib/types）+ **37/37 vitest**
- 技能模板层（src/templates/*）标记为**知识层（legacy，M4 收敛）**：工具技能由插件工具取代，保留 eap/neat/入口
- 参考仓库本地副本：`AI_LAB/dsh-external-refs/`（gitignored，不提交）

## v0.3.0 — 2026-08-06（native 插件设计：改核心 loop）

**Scope:** 设计里程碑。回应需求"改动核心 dsh loop 的行为"——输出 `docs/dsh-serenity-hooks-design.md`：Native Cordis 插件方案（订阅 interception seams，把 ACC 约束从 advisory 升级为机械执行）。

**主要变化：**

- **`docs/dsh-serenity-hooks-design.md`** — 完整设计：
  - 插件形态（name/inject/Config/apply，无 default export）
  - 6 个拦截缝订阅 + listener 形状（取自 DSH interception.spec.ts 官方工作示例）：
    `agent/prompt-submit`（注入/准入）、`tools/pre-execute`（安全模式/黑名单 deny）、
    `ctx.tools.guard()`（终局 deny）、`tools/post-execute`（session-keeper DCP）、
    `agent/turn-stopping`（会话强制落盘）、`agent/session-start`（Phase 2 播种）
  - 决策类型契约（PromptDecision/PreToolDecision/GuardDecision/PostToolDecision）
  - 配置对齐 `.dsh/serenity.json`（hooks 开关组）
  - 集成路径（dsh-customize 流程 + config.yaml 可行性待验证）
- 里程碑：M1 设计 ✅ → M2 最小插件验证 → M3 全 seam → M4 staging 集成

## v0.2.0 — 2026-08-06（safe-mode 协议 + init Phase 2 + 守卫映射）

**Scope:** 补全守卫层（acc-safe-mode）+ init 向导两阶段化 + 架构文档新增"守卫映射"章节（Route 1：约束映射平台机制）。

**主要变化：**

- **acc-safe-mode** — `scripts/safe-mode.ts`：on/off/status/check 控制 `.serenity-safe-on` 标记；黑名单支持前缀匹配与 `regex:` 前缀（读 `.dsh/serenity.json` / `.opencode/serenity.json`）；check 命中黑名单或根外路径返回 2
- **init 两阶段（D1 对齐）** — `src/init/init-wizard.ts`：Phase 1 骨架（git init + .serenity + 目录 + 技能安装）+ Phase 2 生成 `.dsh/PHASE2-PROMPT.md`（EAP 5 Topic 访谈：目的/Git/工作项/约束/边界）
- **守卫映射文档** — `docs/architecture-v0.md` §4：P3=fs 沙箱、审批=approval、安全模式=会话权限降级+协议、loop/resident=goal/subagent
- 安装器默认技能新增 acc-safe-mode（9 个）

**测试：** 54/54 vitest 通过（新增 safe-mode 8 项 + init-wizard 3 项）

## v0.1.0 — 2026-08-06（全量工具技能）

**Scope:** 实现全部 7 个 acc-* 工具技能（模板 + 自包含 runner），安装支持 CCC 级 + 用户级双目标。

**主要变化：**

- **acc-fs** — `scripts/cc-fs.ts`：14 子命令（root/resolve/exists/list/tree/relative/mkdir/rm/mv/cp/touch/append/info/find），路径逃逸阻断 + symlink 防御 + 根保护，`regex:` find 支持
- **acc-git** — `scripts/cc-git.ts`：status/commit/push/log，非快进推送输出操作建议（绝不自动 force）
- **acc-msm** — `scripts/msm.ts`：list/exec/admin(register/deregister/check)，mech-registry.json v1+数组格式，type:"path" flag 逃逸校验，600s 超时，bun 优先/npx tsx 回退
- **acc-session** — `scripts/session-tool.ts`：list/show/create/health/qa/archive/summary，AGENT_SESSIONS/ 全周期，S### 自动分配
- **acc-kit** — `scripts/acc-kit.ts`：health（P1/P2/配置）/time/wait
- **acc-eap / acc-neat** — 知识技能（质量框架 + 协作协议）
- 安装器支持 `--scope ccc|user`（修复 user 路径 → `~/.dsh/skills`），`--force` 覆盖
- 实测：home-serenity 冒烟通过（acc-msm 读到真实 51 MSM；acc-session 读到 116 会话；路径逃逸被阻断）

**测试：** 43/43 vitest 通过（6 文件：activation/installer/cc-fs/cc-git/msm/session-tool/acc-kit）

## v0.0.1 — 2026-08-06（立项 + 骨架）

**Scope:** 仿照 opencode-serenity-plugin 开发方式，从零创建 DSH 运行时的宁静号 ACC harness。独立实现（不复用 opencode-serenity-plugin 源码），远程暂存家里私有 GitLab。

**主要变化：**

- 仓库骨架：package.json / tsconfig / vitest / bin / src / docs / tests
- CLI（`bin/dsh-serenity-plugin.js`，bun 或 node+tsx 执行）：`install` / `init` / `list` / `status`
- 激活层 `src/activation.ts`：CCC 三原则 P1（.serenity）/ P2（git）/ P3（路径二分，由 DSH fs 沙箱执行）
- 错误类 `src/errors.ts`：13 错误类（serenityCode + impact）
- 配置 schema `src/config-schema.ts`：`.dsh/serenity.json`（loop.defaultModel / sessionKeeper.threshold / safeMode.blacklist）
- 技能安装器 `src/skills/`：template-loader（{{prefix}}/{{ccc_name}}/{{date}} 占位符）+ install-skill（幂等）
- 入口技能模板 `src/templates/acc-serenity/SKILL.md`：身份/激活检测/工具映射/协作纪律

**测试：** 起步（activation + 安装器），后续随工具技能补齐。

**未决：**

- v0.1 工具集范围（acc-fs / acc-git / acc-msm / acc-session / acc-eap / acc-neat / acc-kit）— 待用户确认
- 安装目标策略（仅 CCC 级 vs 用户级全局）
