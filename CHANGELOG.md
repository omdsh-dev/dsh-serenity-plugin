## v1.24.1 — 2026-08-27（任意文件粘贴自动落盘 _tmp/files_from_user/，S142 用户需求）

**Scope:** 用户需求——"粘贴文件（非图片格式）自动也放 _tmp 去"。调研确认 DSH 输入框只认图片（`InputBar.onPaste` 把所有文件交给 `intakeImages` → 非图片被 `addImages` 拒绝 toast+丢弃，无 rail 无发送通道）→ 任意文件必须**主动拦截 paste + 落盘**。用户拍板：① 提示方式 = **draft 追加**（不自动发送，随用户消息进对话）；② 单文件上限 = **10MB**（与图片一致）；③ 版本号放缓（归 v1.24.1，不升 minor）。

### 变更
- **node half `/serenity/file-upload`**（api.ts）：`saveFileToTmp` 核心（可测）——文件名校验 + **可执行扩展名拒绝**（`BLOCKED_FILE_EXTS`：exe/dll/msi/bat/cmd/ps1/com/scr/lnk/sh/vbs/bin/app/deb/rpm/jar——安全边界，agent 不被诱导执行）+ base64 解码 + **10MB 上限** → 写 `_tmp/files_from_user/<ts>-<rand>-<safeName>`（与 `images_from_user` 并列）；`sanitizeFileName`（路径成分剥离/去前导点/非法字符替换/限长 100）；handler：POST + x-serenity-ui 头 + readBody 20MB + 按会话 cwd 解析 CCC 根
- **client half `FileFallbackDock`**（input.dock 槽，静默无 UI）：document 级 **capture 阶段 paste 监听**（先于 DSH textarea onPaste）——剪贴板含非图片文件时：① 纯文件粘贴（无图片无文本）→ preventDefault（阻止 DSH toast 拒绝）；混合粘贴（含图片/文本）→ 不拦截（图片正常进 rail / 文本正常插入，文件异步处理）② 逐个上传 ③ 成功 → **draft 末尾追加** `The user provided a file (path: ...)`（多文件每行；draft 快照 ref 防异步期间打字覆盖 + 连续粘贴串行队列）
- **`file-fallback-api.ts`**（client）：`collectNonImageFiles`（items 注入纯函数，可单测——图片留给 DSH）、`fileNoteTemplate`（单/多文件路径模板，模型可见英文对齐 v1.20.6 图片教训）、`uploadFile`
- **client/index.ts**：注册 `serenity-file-fallback` dock 条目（order 110，与图片兜底 order 100 并列）
- **测试 +14**：api-file-upload.test.ts（sanitizeFileName 3 + saveFileToTmp 6：合法 pdf/路径剥离/可执行拒绝/缺失拒绝/超限/唯一性）、file-fallback.test.ts（collectNonImageFiles 3 + fileNoteTemplate 2）——**42 files / 463 tests 全绿**
- typecheck ✓（node + client）→ build ✓（lib/client.js 78259 B）

## v1.24.0 — 2026-08-27（loop（牛马）→ handyman（杂工）重构，S142 用户拍板）

**Scope:** 用户对 loop 工具的四点重设计——① jobs 并行上限 10（便宜模型便宜）；② worker 工具面不含 handyman（编排归主 agent，递归只走 subagent）；③ 不兼容旧 loop 进度文件（仅 handyman- 前缀）；④ handyman.models 未配置 → 报错要求配置。语义对齐 osp loop：同步（非异步）+ 指定白名单模型 + 自主循环到完成（stop-token 唯一完成判据）+ 内部递归同样低能 subagent（DSH 原生模型继承）+ workflow jobs 编排能力。方案文档 `docs/handyman-design.md`（用户确认后落盘）。

### 变更
- **工具改名 `loop` → `handyman`（全新身份，非 alias）**：`src/tools/handyman.ts`（createHandymanTool：task/label/session/model/jobs/guide；白名单校验 `requireWhitelistedModel`；jobs 编排 Promise.all 并行 ≤ maxParallel；同步阻塞；worker session `handyman-<label>-<uuid>`；HANDYMAN_MAX_ROUNDS/RESTARTS=100）；`src/index.ts` `createLoopTool` → `createHandymanTool`；`src/invariant.ts` REGISTERED_TOOLS `loop` → `handyman`；`src/seams/system-prompt.ts` 工具清单行同步
- **纯逻辑层改名**：`loop-ops.ts` → `handyman-ops.ts`（进度文件 `handyman-<label>.md/.json`；stop token `SERENITY_HANDYMAN_DONE_`；`HANDYMAN_GUIDE` 含白名单/递归/jobs 并行/不兼容说明；`listActiveHandymen()` 扫 handyman-*.json）；`loop-preset-inherit.ts` → `handyman-preset-inherit.ts`（**工具面收窄**：setup 钩子 composeFrom 后 `tools.restrict({ deny: ['handyman'] })`——worker 看不到 handyman，防无限嵌套）
- **配置不兼容（用户拍板）**：`SerenityConfig.loop.defaultModel` → `handyman.{models, defaultModel, maxRounds, maxParallel}`；`readHandymanConfig()` models 未配返回 null（工具报错要求配置）；defaultModel 缺省 models[0]；maxRounds 缺省 100；maxParallel 缺省 10
- **拦截缝同步**：`seams/context.ts` shouldAutoRestore `loop-` 前缀 → `handyman-`；ACC 注入 `loop default model` → `handyman default model`（读 readHandymanConfig）；`seams/bootstrap.ts` `loop-` 恒 promoted/免锚定 2 处 → `handyman-`
- **API/UI 同步**：`/serenity/loops` → `/serenity/handymen`（LOOPS_PATH → HANDYMEN_PATH；`{handymen: listActiveHandymen(root)}`）；status `loopModel` 字段 → `handymanModel`（读 readHandymanConfig 默认值）；SafeModePanel.tsx/.css 全量改名（LoopRunInfo→HandymanRunInfo、runningLoops→runningHandymen、CSS 类 .sp-loops*→.sp-handymen*、「Loop 运行」→「Handyman 运行」）；ccc-config 参考/工具描述/localstore 示例 loop.defaultModel → handyman.models
- **旧文件删除**：`src/tools/loop.ts` / `src/loop-ops.ts` / `src/loop-preset-inherit.ts`；测试 `loop-ops.test.ts` → `handyman-ops.test.ts`（+白名单 requireWhitelistedModel 测试 + 旧 loop- 进度文件不列入断言）、`loop-preset.test.ts` → `handyman-preset.test.ts`（deny handyman 四路径断言）；context/ccc/status/invariant/register/system-prompt/osp-alignment/bootstrap/localstore 8 文件 loop 断言 → handyman
- **typecheck 修复**：jobs 参数 schema `required`/`additionalProperties` 与 ObjectValueSchemaSpec 契约对齐（items 内不支持 required → 运行时 `parseJobs` 校验）；args.jobs/args.session 类型收窄；jobs 结果 `as unknown as JsonValue`
- **README.md/.en.md/CHANGELOG**：工具表 loop → handyman（含 jobs 编排/白名单说明）、配置表 handyman.models、状态卡 handyman 模型；hooks 子包 README 同步
- typecheck ✓（node + client）→ test ✓（40 files / 449 tests，+3）→ build ✓（lib/client.js 72971 B）

## v1.23.8 — 2026-08-27（safe tag 实心化：红底白字大写 SAFE，无 icon，S142 用户反馈）

**Scope:** 用户反馈 v1.23.7 仍不满意——"换成实心 tag，不要 icon 试试看，大写 SAFE"。

### 变更
- **SafeModePanel 头部 safe tag 实心化**：`.sp-tagOn` 从透明红混底改为**实心红底**（`--dsw-alias-state-error-primary`）+ 反色文字（`--dsw-alias-label-primary-foreground`，实心底先例 ConnectionBanner 同款 token）——大写 **SAFE** / **OFF**（`text-transform: uppercase`，字重 700，letter-spacing 0.04em）；**移除 icon**（`.sp-tagIcon` 删）；OFF 灰底实心化（`--dsw-alias-label-secondary`）
- typecheck ✓（node + client）→ test ✓（40 files / 446 tests 不变）→ build ✓（lib/client.js 72803 B）

## v1.23.7 — 2026-08-27（safe tag 红色化，S142 用户反馈）

**Scope:** 用户反馈 v1.23.6 的橙色 tag 太丑——"safe 标亮起来用红色"。

### 变更
- **safe 状态语义色 warning（橙）→ error（红）**：`.sp-tagOn`（头部卡片 safe tag）与 `.sp-toggleOn`（弹层安全模式开关）统一改用 `--dsw-alias-state-error-primary`（明暗主题自适应，红 600/400）——背景 16%/14% 透明混合 + 边框 45%——"safe = 警惕/危险"的红色语义，不再橙色
- typecheck ✓（node + client）→ test ✓（40 files / 446 tests 不变）→ build ✓（lib/client.js 73039 B）

## v1.23.6 — 2026-08-27（safe 状态 tag 化：从外面一眼可见，非胶囊嵌套，S142 用户反馈）

**Scope:** 用户反馈 v1.23.5 的点颜色编码不够直观——"安全模式做成 tag 吧，从外面看方便知道，不像之前那么丑就行"。

### 变更
- **SafeModePanel 头部卡片 safe tag**：恢复卡片内 safe 状态标签，但**方形小标签**（border-radius 4px，非胶囊 9px——避免"胶囊套胶囊"）——ON=橙底 `safe`（含警告图标）/ OFF=灰底 `off`；绿点回归纯 CCC 活跃语义（on/off 由 tag 承担）；hover title 保留 safe-mode 说明
- CSS：`.sp-sm*` 胶囊样式 → `.sp-tag*` 方形标签（`sp-tagOn`/`sp-tagOff`/`sp-tagIcon`）；移除 `.sp-dotWarn`（点不再编码 safe）
- typecheck ✓（node + client）→ test ✓（40 files / 446 tests 不变）→ build ✓（lib/client.js 73001 B）

## v1.23.5 — 2026-08-27（双修复：rebuild shadow-price 协议合规 + 状态卡去嵌套，S142 用户反馈）

**Scope:** 用户两反馈——① 问询 rebuild 后上下文少了但历史保留、担心 dsh 会话爆炸（实测 UI 计量矛盾：总用量 15% 但「对话消息」~1M）；② 头部状态卡「胶囊套胶囊」不好看。双根因均实证修复。

### 变更
- **rebuild shadow-price 协议合规（根因实证）**：`performRebuild` 此前**裸 surface replace**——DSH token-meter 的 `foldSurfaceProjection` 对 `replace` 要求**紧邻其前的 metering 事件**（`compaction/summary` 或 `compaction/prune`）声明被替换范围 token 价；claim 缺失 → `deltaTokens=0` → `contextBreakdown.messageTokens` **永不扣减** → UI「对话消息」虚高累计（截图实证：总 15% 但对话消息 ~1M——两个计量源矛盾）。**修复**：replace 前先 `session.append('compaction/prune', { shadowedRange, shadowedSeqs, shadowedTokenCount })`——定价 = 逐被替换节点 `ctx.tokenMeter.estimateMessage(deriveEventMessage(event))` 累加（官方先例 `compaction-tool-result-pruner` 同款协议）；tokenMeter 经 `ctx.get('tokenMeter')` 动态取（可选，缺失退化无 claim 仅计量漂移，会话功能不受影响）。测试 +1（带 meter → 先 prune 定价 shadowedRange/Seqs/TokenCount + 后 replace 紧邻）——**40 files / 446 tests 全绿**。设计答复：log append-only 是 DSH 持久性契约（surface=模型投影 / log=不可变审计源，surface.ts:44-47 权威注释），上下文复位与磁盘增长一体两面；修复后 UI 计量正确回落，磁盘增长缓解（chunk 打包 ~56× + zstd），列表不随单会话大小退化
- **状态卡去嵌套（UI 反馈）**：头部卡片移除内部橙色 `safe` 胶囊（胶囊套胶囊）——safe 状态**分离**为状态点颜色编码：非 CCC=灰 / CCC+safe off=绿 / CCC+safe on=琥珀（`sp-dotWarn` + 光晕）；hover title 含 safe-mode 状态；弹层「安全模式」分组保留（唯一可操作项）。CSS 删 `.sp-sm*`（-2KB bundle）
- typecheck ✓（node + client）→ build ✓（lib/client.js 72053 B）

## v1.23.4 — 2026-08-27（TRAJECTORY-REBUILD 锚点 SESSION 定位修复：完整目录名 + 含空格路径解析，S142 用户反馈）

**Scope:** 用户实测反馈——rebuild 锚点"没写 SESSION 完整名称，导致定位困难"。实测锚点显示 `Persistent trajectory: AGENT_SESSIONS/2026-08-24--S142--dsh-serenity-plugin`（截断），而真实目录为 `…--S142--dsh-serenity-plugin 长期维护/`（含空格后缀）。根因 + 双修复。

### 变更
- **根因（events 恢复截断）**：`session-ops.ts` `parseSessionContextFromEvents` 用 `/SESSION\.md path:\s*(\S+)/` 提取 mdPath——`\S+` 遇空格即停，会话目录名含空格（如" 长期维护"）时解析出**残缺路径**（丢目录后缀 + 丢 `SESSION.md` 文件名）。修复：正则改为 `/SESSION\.md path:\s*([^\r\n]+)/`（匹配整行，路径可含空格）+ 结果 `.trim()` 防尾部空白；`sessionBlock`/`resolveActiveSessionInfo` 同源自动受益
- **锚点补完整目录名（用户需求）**：`buildRebuildAnchor` 新增 `- Serenity session: {sessionId} ({完整目录名})` 行（目录名 = SESSION.md 父目录 basename，从 mdPath 推导，可含空格）——重建后 agent 一眼定位 SESSION，不再靠残缺路径猜；无激活会话（fallback `AGENT_SESSIONS/SESSION.md`）时该行省略
- 测试 +2：session-ops 含空格目录名 mdPath 完整解析回归（`…--S142--dsh-serenity-plugin 长期维护` → mdPath 完整 + dirName 完整 + sessionId=S142）；rebuild 锚点含空格场景（完整目录名行 + 完整相对路径断言）——**40 files / 445 tests 全绿**
- typecheck ✓（node + client）

## v1.23.3 — 2026-08-27（重建提醒修复：行动指令化 + 不做节流 + 升级催促，S142 用户反馈）

**Scope:** 用户反馈"[TRAJECTORY] 一直在触发，为啥没执行 rebuild，这个词是不是有问题"——机制语义澄清 + 三处修正：① 旧文案是**状态播报式**（"[TRAJECTORY] Context usage at N%..."）模型当成系统状态而非行动请求可一直忽略；② 无节流每轮刷屏（用户阈值 0.4，44% 就每轮刷）；③ 用户拍板：**不做节流，催就行了** + **不向 LLM 植入阈值建议**（设定是用户自由）。

### 变更
- **rebuildReminderText 行动指令化（v1.23.3）**：新签名 `(ratio, threshold, escalated)`——普通语气 = **ACT NOW 行动指令**（"at the next natural pause call session_rebuild... Do not ignore this; rebuild is the expected action, not an option"），对齐 steward ACK 协议风格（模型知道该做什么、何时做、必须做）；**升级语气** `[TRAJECTORY-ESCALATED]`（连续 3 轮超阈值未 rebuild → "STOP and call session_rebuild immediately... persists until you call session_rebuild"）
- **不做节流（用户拍板）**：删除冷却机制——**每次超阈值都注入**（每轮都催，直到 rebuild 后压力自然回落）；保留**升级状态机**（per-session consecutive 累计，≥3 → 升级强制语气，此后持续升级催不重置）
- **不向 LLM 植入阈值建议（用户拍板）**：文案不含"0.75~0.9 是好主意"类引导——阈值设定是用户自由，提示只陈述当前占用与阈值
- **语义澄清（用户疑问）**：`[TRAJECTORY]` 是**提示**不是**执行**（v1.22.1 设计：不自动执行防误清空）——执行需要 agent 收到提示后主动调用 session_rebuild；新文案明确 "rebuild is the expected action" 消除歧义
- 测试 +3：行动文案断言（ACT NOW/not an option/不含阈值建议）/ 升级文案断言（mandatory/STOP/persists until）/ 升级状态机集成（每次注入 + 第 3 轮升级 + 升级后持续催不重置，rebuildReminderStateSnapshot 可见）——**40 files / 443 tests 全绿**
- typecheck ✓（node + client）→ build ✓（lib/client.js 72871 B）

## v1.23.2 — 2026-08-27（双修复：F3 会话命名 this 绑定 + 配置面板 CSS 唯一 marker，S142 用户反馈）

**Scope:** 用户两反馈——① 会话命名"还是不生效"；② 配置面板排版"像网页丢失资源"。双根因均实证修复。

### 变更
- **F3 会话命名修复（this 绑定，日志实证）**：根因 = 调用点 `const rename = titles.rename` **解构裸函数**后传入，`renameDshSessionOnUse` 内部 `rename(session,title)` 调用时 `this=undefined` → DSH 服务方法内部读 `this.assertServiceActive` 抛错（日志：`Cannot read properties of undefined (reading 'assertServiceActive')`；与 v1.20.2/1.20.3 图片落盘同款"解构丢 this"bug 第三次出现）。修复：第三参从裸函数改为**整个 sessionTitle 服务对象**，内部 `titles.rename(session,title)` **方法调用**（this=titles 服务实例）；调用点同步（传 titles 对象 + 服务缺失/无 rename 方法均有明确 reason）；测试 +2（this 绑定回归：方法内部读 this 服务态成功 / 服务无 rename 方法 reason）
- **配置面板 CSS 修复（唯一 marker，bundle 实证）**：根因 = tsdown CSS 内联插件所有 CSS 共用**同一幂等 marker** `style[data-sp-css]`——第一个 CSS（SafeModePanel）注入后创建该 style，后续 3 个（SettingsSection/AccountsEditor/PersonaEditor）的幂等判断 querySelector 非 null → **全部跳过注入** → 面板只剩一个 CSS 生效（"网页丢失资源"外观）。修复：按文件名生成**唯一 marker** `style[data-sp-css="<basename>"]`，每个 CSS 独立注入（bundle 验证 4 个 marker 各自存在）
- 测试：40 files / **440 tests 全绿**（+2）→ typecheck ✓（node + client）→ build ✓（lib/client.js 72871 B，4 独立 CSS marker 验证）

## v1.23.1 — 2026-08-27（彩蛋功能：persona 模式——替换输出约束/指令遵循约束，S142 用户需求）

**Scope:** 用户需求——用户常想改变 agent 的输出风格和指令遵循风格（如社区流行的「大肥鱼」模式）；为让用户开心且不影响正常工作，做彩蛋功能：在插件设定中可替换 ACC 系统提示词中**输出约束/指令遵循约束**部分（EAP 块 + MSM 原则段），配置后用户文本替代原本；未配置 → 完全默认行为，零影响。

### 变更
- **config-ops.ts**：新增 `PersonaSettings { mode, overrideText }`（plugin 全局文件 `~/.dsh/serenity-hooks.json`，v1.22 归属原则）——默认 mode=''（彩蛋关闭）；mergeWithDefaults/updateAdvancedSettings/toWire/applyWirePatch 全链路支持（部分 patch 语义：persona 未传保留现有）
- **system-prompt.ts**：
  - `personaBlock(mode, overrideText)`：mode 空/文本空 → 空串（装配回退默认）；否则 `=== Serenity Persona ===` 块（独立标记头，幂等检测兼容）
  - `principlesBlock(root, omitMsmPrinciples)`：persona 生效时剥离 MSM 原则段（指令遵循约束被 persona 承接）；本体论/关系段/操作边界（安全硬约束）永远保留
  - `serenitySystemPrompt` 装配：persona 生效 → EAP 块替换为 Persona 块（原位 CCE 之后）；未配置 → 与 v1.23.0 逐字节一致
- **api.ts**：/serenity/config 通用 applyWirePatch 自动支持 persona（GET wire 含 persona / PUT patch），零改动
- **client**：`PersonaEditor.tsx/.css`（新）——DSH 设置面板「彩蛋模式」区块：模式名输入 + 替换文本 textarea + 「填充大肥鱼 demo」/「清空」/「保存」（PUT /serenity/config → 热生效，新会话即时）；`SettingsSection.tsx` 挂载区块；`accounts-api.ts` WireConfig 补 persona + saveConfig 支持 persona patch
- **demo**：内置 `BIG_FAT_FISH_DEMO`（DeepSeek 社区娘化人格：大肥鱼/鲸鱼娘——输出风格鱼化但保留 EAP 精神 + 指令遵循风格诚实精确、容器规则神圣）
- **测试 +9**：config-ops persona（默认关闭/设置持久化/清空/部分 patch/merge 默认）+ system-prompt（personaBlock 门控/未配置逐字节一致/配置替换+安全边界保留/装配位置/principlesBlock 剥离纯函数）——**40 files / 438 tests 全绿**
- typecheck ✓（node + client）→ build ✓（lib/index.js + lib/client.js 72745 B）

## v1.23.0 — 2026-08-27（提示词全英化 + Trajectory Steward 定名 + Session=载体定义，S142）

**Scope:** specs v1.3.1 定义升级（用户拍板）——**Session = Trajectory 的可重建载体**（同义视角：宁静号 session 与 trajectory 指同一认知存在的两个面；载体视角：SESSION.md 是轨迹持久身体原位不动，工作会话是可丢弃重建的运行副本）。dsp 所有提示词全英化 + 维护机制定名 **Trajectory Steward**（用户从 Keeper/Warden/Curator/Custodian 中选定 Steward）。

### 变更
- **概念定义（Session = Trajectory 载体）**：
  - Session 块：`Active session: {id} — {dir} (this session is the rebuildable carrier of the trajectory)` + `SESSION.md path: {path} (the trajectory's persistent body — stays in place through rebuilds)`
  - Principles 块新增 **The session-trajectory relation** 段（本体论后：identity belongs to the trajectory, not to any session）
  - Metaphor 第 7 条载体化：`SESSION.md is the trajectory's logbook — the persistent body of the voyage; sessions are rebuildable carriers of the trajectory. Discard the carrier, keep the logbook.`
  - rebuild 锚点/steer/工具描述：`[TRAJECTORY-REBUILD] ... (Ship of Theseus: the carrier is replaced, the trajectory continues)` / `Continue the work of {SESSION name}` / `Persistent trajectory (SESSION.md, unmoved)`
  - keeper rebuildReminderText：`This session is the rebuildable carrier of the trajectory: SESSION.md is the persistent body, this conversation is only a temporary work copy`
- **机制定名 Trajectory Steward（用户拍板）**：计分提醒前缀 `[SESSION-KEEPER]` → **`[TRAJECTORY-STEWARD]`**，ACK 码 `[TRAJECTORY-STEWARD-recorded-{code}]` / `[TRAJECTORY-STEWARD-skipped-{code}]`；内部标识（registerKeeper/KeeperTracker）保留；`[TRAJECTORY]` 重建提示前缀保持（v1.22.1 已拍板）；改名兼容：ACK 码单次使用不跨会话，旧前缀零影响
- **机制预声明（specs §5.10 要求，用户指出缺口）**：Session 块新增 TRAJECTORY-STEWARD 预声明段——模型预先知道存在计分督促机制 + ACK 码协议（write/edit=3, task=10, read/grep/glob/msm=1, +1/min），机制先于提醒
- **提示词全英化（模型可见文本，7 处 + 工具面）**：
  - system-prompt.ts：EAP 块英化（E↑ Explicit / R↓ Reconstructable / S↑ Stable）、ACC 块工具清单行英化（11 工具含 session_rebuild/localstore）、ℹ️ 路径提示行英化、Code Mode 适配行英化
  - keeper.ts rebuildReminderText 英化；context.ts `[ACC]` 注入英化；env.ts DSH_SERENITY_* description 英化
  - rebuild.ts / tools/rebuild.ts 锚点/steer/instruction/错误消息英化
  - 11 工具 description + 参数 description（53 处）英化；eap/neat/cce 工具内容全文英化（EAP_CONTENT/NEAT_CONTENT/CCE_CONTENT + section 切分锚点同步英文）
  - 错误消息英化：guards deny（bash/path escape/governance/blacklist）、fs-ops/msm-ops/localstore-ops/git-ops/kit-ops/config-ops/session/loop 全部 throw、git REJECTED 建议文本、loop-ops buildRoundPrompt/LOOP_GUIDE、session SEP hook-guide、skills-discovery 截断提示、imageNoteTemplate（对话消息）
- **保留不动（向前兼容）**：SESSION.md 模板与中文章节名（qa/keeper 按中文章节解析）、mech-registry 描述（CCC 内容）、SKILL.md 全文、人类 UI（登录页/设置面板/状态卡/console 日志）、client 校验消息
- **测试同步**：osp-alignment（Session 块新结构/Principles 关系段/accBlock 11 工具）、keeper/gate（steward 前缀）、rebuild（英文锚点）、context（[ACC] 英文）、system-prompt（EAP 英文）、acc-extras（EAP/NEAT/CCE 内容）、guards/skills-discovery/loop-ops/config-ops/ops/fs-ops 断言——**40 files / 429 tests 全绿**
- **specs 同步**：serenity-acc-specs v1.3.1 已先行发布（§0.3.1 Session 载体定义 / §2 术语表 / I6 扩展 / §5.2 Metaphor 第 7 条 / §5.10 trajectory-steward + 预声明要求 / §5.8 Session 块）
- typecheck ✓（node + client）→ test ✓（429）→ build ✓（lib/index.js + lib/client.js 64053 B）

## v1.22.9 — 2026-08-27（F3 会话命名修复：可观测性 + S###-日期格式 + 测试真实链路，S142）

**Scope:** 用户实测"use 后名字没改" + 确认"use 交给 LLM 是核心设计"。诊断结论：rename 链路被静默吞错（无日志）、测试测假路径（mock sessionTitleAvailable=true）、命名格式不符需求（dirName 超长 + 中文 vs 用户拍板 S###-日期）。

### 变更
- **可观测性（不再静默）**：`tools/session.ts` use 分支——rename 成功 `console.log`（dsh 会话 id → 标题）、失败 `console.warn`（明确原因：naming 关/服务不可用/rename 抛错）、异常 `console.warn`——下次实测若仍不生效，日志直接定位断点
- **命名格式修正（S###-日期）**：新增 `namingTitleFor(active)` 纯函数——`S143` → `S143-2026-08-26`（从 sessionId + dirName 日期前缀派生，用户拍板格式）；issue 会话（无 S###）→ 回退目录名；无日期前缀 → 回退 sessionId
- **renameDshSessionOnUse 返回结果对象**（`{ok:true,title} | {ok:false,reason}` 而非 null 歧义）——门控失败/rename 抛错均有明确 reason，不再"失败=null"无法区分原因
- **测试真实链路**：session-title.test.ts 重写 +4——namingTitleFor 三种格式断言 / rename 成功断言标题为 S###-日期 / 门控失败断言 reason / rename 抛错断言 reason 捕获（不传播）；**429 tests 全绿**
- **peerDependencies 补 `@deepseek-ai/dsh-session-title`**（F3 调研"唯一小改动"——tsconfig paths 早有引用，peerDeps 此前缺失）
- typecheck ✓（node + client）

## v1.22.8 — 2026-08-27（熵点治理：gateway.ts 拆分三模块，S142）

**Scope:** 代码整体梳理（codebase-overview-v1.22）发现的熵点治理——gateway.ts 894 行单文件混三类职责，拆分为认证域/代理域/装配层三个模块（行为零变更）。

### 变更
- **`src/gateway-auth.ts`（新，认证域纯逻辑）**：`verifyGatewayLogin` / 会话（`SESSION_TTL_MS`/`issueToken`/`revokeToken`/`validateToken`）/ 失败锁定（`FAIL_LOCK_*`/`getFailState`/`resetFailState`/`isAccountLocked`/`recordLoginFailure`/`accountLockRemaining`）/ CSRF（`newCsrfToken`/`csrfFromRequest`/`safeEqual`/`originAllowed`）/ `cookieValue` / `loginPageHtml`
- **`src/gateway-proxy.ts`（新，代理辅助纯逻辑）**：`RANDOM_UUID_POLYFILL`/`injectPolyfillHtml`/`buildProxyHeaders`/`filterWorkspaceList`/`workspaceAllowed`/`workspaceDenyResponse`
- **`src/gateway.ts`（装配层，894→~620 行）**：只保留 HTTP 装配（`startGateway`/`registerGateway`/`readBody`）；从两新模块 import 并 **re-export 全部导出**（既有 import 面兼容——`tests/gateway.test.ts` 直接 import gateway.js 的 20+ 导出无需改动）；v1.22.3 回归测试的源码锚点（`const proxy =`/`server.on('upgrade'`/`'/serenity/login'`/`clientError`）全部保留原位
- 测试：40 files / 425 tests（**零改动全绿**——纯逻辑原样搬移 + re-export 兼容）→ typecheck ✓（node + client）

### 后续熵点（本次不动，理由见 codebase-overview §7）
- `session-ops.ts`（30KB）/ `msm-ops.ts`（24KB）：单一领域内聚实现，拆分收益低
- `system-prompt.ts`（26KB）：8 块 spec 文本 + 注册，osp-alignment.test.ts 契约绑定，不宜拆
- `.restrict-diag.json` 跟踪问题：需 bash `git rm --cached`（safe-mode 无通道）

## v1.22.7 — 2026-08-27（移除工作区手输兜底，S142）

**Scope:** 用户确认 v1.22.6 修复后工作区白名单列表正常加载——删除手输路径兜底 UI（工作正常后不再需要）。

### 变更
- `src/client/AccountsEditor.tsx`：删除 `wsInput` state / `addWorkspace()` / 手输输入框 + 添加按钮；加载失败文案改为「暂无可选工作区（workspace.list 未返回条目）」（不再引导手输）
- `src/client/AccountsEditor.css`：删除 `.ae-wsAdd`（不再使用）
- `src/client/accounts-api.ts`：注释同步（失败返回空数组 → 面板显示"暂无可选工作区"）
- 测试：40 files / 425 tests（无新增——纯 UI 删减）→ typecheck ✓（node + client）

## v1.22.6 — 2026-08-27（修复：工作区白名单列表加载失败，S142）

**Scope:** 用户报告设置面板工作区白名单显示"未能加载工作区列表（workspace.list 不可达）"——已有工作区下拉为空。

### 变更
- **根因**：`fetchWorkspaces` 的 POST body 只发 `{ rpcId, payload }`——DSH RPC 信封要求完整 **ClientRequest** `{ type: 'client-request', rpcId, method, payload }`（api/rpc.ts wire 契约）——缺 `type`/`method` → `clientRequestSchema.safeParse` 校验失败 → bad-request → `result.value.items` 缺失 → 面板回退"手输路径"兜底
- **修复**：`src/client/accounts-api.ts` `fetchWorkspaces` 补 `type: 'client-request'` + `method: 'workspace.list'`（payload 空对象）——与 DSH 官方 `fetch/client.ts` `callUnary` 信封一致
- 测试：accounts-api.test.ts +4（信封完整断言 type/method/payload + rpcId 前缀 / 非 200 空数组 / 缺 items 空数组 / 无 path item 过滤 + title 缺省回退）——**40 files / 425 tests** → typecheck ✓（node + client）

## v1.22.5 — 2026-08-27（session_rebuild 增强：自动继续 + 保留 first-anchor，S142）

**Scope:** 用户实测 rebuild 有效后提出两项改进：① rebuild 完成后自动继续（不让用户手工继续）；② rebuild 后保留 first-anchor 内容（或重新走一轮 first-anchor）。

### 变更
- **自动继续（turn-stopping steer）**：`performRebuild` 执行 surface replace 后 `agent.steer()` 注入 `[TRAJECTORY-REBUILD] 会话已清空重建。请立即按上方锚点指令读取持久轨迹（SESSION.md）并从上次进度自动继续工作。`——DSH 官方先例（hooks-claude-code Stop hook：turn-stopping 里 steer 强制再执行一步）：next-step 队列非空 → turn 循环不 break → 模型同轮自动消费指令读取 SESSION.md 继续，**无需用户手工输入**
- **保留 first-anchor 协议正文**：`buildRebuildAnchor` 并入 `DEFAULT_ANCHOR_MESSAGES` 两条正文（ACC 身份/EAP/协作协议）——**去掉 acknowledge 尾句**（`stripAckSuffix`：重建后直接干活，不重走确认轮）；系统提示词层身份未丢（每轮注入），bootstrap 晋升状态不受影响（surface replace 不改 events → promoted 保持完整工具目录；events 有历史 user/message → 不重复锚定；steer 消息 source=plugin → 不递归锚定）
- `src/rebuild.ts`：`buildRebuildAnchor` 增加 anchorMessages 参数（缺省 DEFAULT_ANCHOR_MESSAGES）；`stripAckSuffix` 导出（可测）；`registerRebuildTurnHook` 执行 replace 后 steer
- `src/tools/rebuild.ts`：description/instruction 同步（自动继续 + first-anchor 保留语义）
- 测试：rebuild.test.ts +3 断言（stripAckSuffix 去尾句/原样 / buildRebuildAnchor 含协议正文且无 acknowledge / turn-stopping 后 steer 被调用 source=plugin）——**40 files / 421 tests** → typecheck ✓（node + client）

**✅ 预期效果**：模型调用 session_rebuild → turn 结束清空 → 注入「协议正文 + 继续 S### 的工作」锚点 → 自动继续读取 SESSION.md 工作（无需用户再发消息）

## v1.22.4 — 2026-08-27（登录安全审计加固 + session_rebuild 语义根治：完全丢弃+新建，S142）

**Scope:** 两条主线——① 用户：外部监听将放公网，安全性必须可靠（登录机制安全审计 S1-S12）；② 用户实测 S141 崩溃：session_rebuild 原地 replace 方案有致命缺陷，语义再修正为**完全丢弃 + 新建**。

### 变更
- **登录安全审计（S1-S12）**：基础扎实（scrypt+timing-safe+256-bit token+HttpOnly/SameSite=Strict+0600+token 不落盘），但为内网设计；公网硬门槛 = S1 明文传输 / S2 无爆破防护 / S3 无 CSRF / S6 config 接口透传。**用户原则**：① 不影响体验的直接修正 ② 影响体验的改方案 ③ 不限制 IP
- **直接修正（不影响体验）**：S3 CSRF（登录双提交 token + config PUT Origin 校验）/ S5 token 滑动 TTL 24h + `POST /serenity/logout` 登出 / S7 `cookieSecure` 配置项 / S9 审计日志（登录成败 console.log/warn）
- **改方案（影响体验）**：S2 账号维度失败锁定（5 次 → 15min 指数退避，不按 IP）/ S1 TOTP 第二因素（RFC 6238 零依赖，Authenticator 兼容，可选绑定）
- **`src/totp.ts`（新）**：base32/RFC6238/otpauth URI，零依赖
- **config-ops 账号扩展**：`totpSecret` + wire `hasTotp` + `cookieSecure` 全链路
- **gateway 会话升级**：`Map(token→session TTL)` + `revokeToken`、失败锁定状态机、CSRF（`newCsrfToken`/`safeEqual`/`originAllowed`）、登录流 TOTP+锁定+CSRF+登出、cookieSecure 传递、登录页加 TOTP 输入框+CSRF 隐藏字段
- **session_rebuild 语义根治（v1.22.2 原地 replace 致命缺陷）**：S141 实测崩溃 `Messages with role 'tool' must be a response to a preceding message with 'tool_calls'`——rebuild 在 turn 中途执行 surface replace 把当前 turn 的 assistant tool-call 节点也 shadow 掉 → 孤儿 tool 消息 → LLM API 报错。**新实现**：① `workspaceRegistry.archiveSession(旧 id)` 丢弃（UI 隐藏 log 保留）② `ctx.agents.create({ sessionId: rebuild-<uuid>, meta.cwd=旧会话 header.cwd, agentOptions=当前 provider/model, preset 继承 })` 新建 ③ `handle.agent.followup({source:{kind:'user'}})` 注入「继续 S### 的工作」④ SESSION.md 原位
- **scope bug 修复**：session 工具 agentScope = 裸 dshSessionId（曾用 `session:${id}` 前缀 → 激活信息读不到）
- **cwd 继承修复**：新会话 meta.cwd 用旧会话 header.cwd（workspace 按 cwd 分组，保证同工作区）
- **client 自动切换**：订阅 sessions.list 检测 `rebuild-*` 新会话出现即 `sessions.open(id)`（零改 DSH）
- **测试重写**：rebuild.test.ts（buildRebuildPrompt / executeRebuild 建新会话+归档 / scope 激活信息 / cwd 继承 / 无 registry 降级）——**40 files / 419 tests** → typecheck ✓（node + client）

**✅ 实测通过**：prompt=「继续 S142 的工作。」、sessionMdPath 正确、oldSessionId 已归档、newSessionId rebuild-* 已创建、无 INVALID_REQUEST

## v1.22.3 — 2026-08-27（gateway 反代链路 error 监听防崩溃，S142）

**Scope:** 用户报告：外部（3081）正常使用中 dsh 崩溃——日志实证 `node:events:497 throw er; // Unhandled 'error' event` + `Error: read ECONNRESET` + `Emitted 'error' event on Socket instance` + `Node.js v22.22.1`。

### 变更
- **根因**：gateway 反代链路客户端侧 socket/req/res 缺 'error' 监听——外部客户端（经 3081 使用）连接中断（切网络/锁屏/关页/超时）→ socket ECONNRESET → 无监听器 → Node throw → **整个 dsh web 进程崩溃**
- **`src/gateway.ts` 修复**：① `proxy()`：客户端 req/res 挂 error（销毁对端）+ 透传路径 upstream error；② WS upgrade：客户端 socket + 上游 usock 双向挂 error（pipe 不传播 error）；③ 登录 POST 分支 req/res 挂 error；④ server 级 `clientError` 兜底（静默销毁）
- **新 MSM `dsh-crash-investigate`**（`scripts/dsh-crash-investigate.ts`，注册 mech）：status（进程/端口/版本/日志清单）/ logs [N] / crash（FATAL/未捕获/OOM/core/信号扫描）/ collect（全量报告落盘 /tmp/）；只读采集零副作用
- 测试 +4（源文件监听注册回归断言）——**39 files / 380 tests** → typecheck ✓

## v1.22.2 — 2026-08-27（轨迹跟踪器 rebuild 语义修正：原地重建，S142）

**Scope:** 用户纠正 F2 rebuild 语义——**归档丢掉的是 dsh 会话（对话历史工作副本），不是宁静号 SESSION.md**；SESSION.md 是持久轨迹永远原位；rebuild = dsh 会话**原地** surface replace 重建（同一会话 id，从 SESSION.md 自动延续身份）。

### 变更
- **rebuild.ts 重写为原地重建**：`executeRebuild` ① 定位当前 dsh 会话（`ctx.sessions.get`）② `surface.nodes` 全部节点 → `session.append('user/message', anchor, { surfaceOp:{op:'replace', start:nodes[0], end:nodes[last]}, sourceEventSeqs:nodes })` 原地替换整个 surface（同一会话 id 不变）③ SESSION.md **原位不动**（持久轨迹）；**删除** `archiveSessionNow`/建新宁静号会话/`ctx.agents.create` 逻辑
- **`buildRebuildAnchor` 语义对齐**：`[TRAJECTORY-REBUILD]` 前缀 + "持久轨迹（SESSION.md，未移动）"——不再引用 `_archived/`
- **`tools/rebuild.ts` 适配**：description 改轨迹跟踪器语义；execute 传 `dshSessionId`（当前会话原地重建）
- **测试重写**：fakeSession surface replace 断言（start/end/sourceEventSeqs 全覆盖 + 不建新会话/不归档 + 空 surface/会话缺失抛错）——39 files / 376 tests
- 撤销误操作：S142 目录已从 `_archived/` 恢复原位 + 状态改回进行中；误建的 S144 已删除

## v1.22.1 — 2026-08-27（移动端登录页 + 轨迹跟踪器 + 上下文回收修复，S142）

**Scope:** 用户三项需求：① 外部（3081）登录页移动端适配；② 上下文阈值回收不生效（修复）；③ 机制正式命名——**轨迹跟踪器（Trajectory Tracker）**：SESSION.md = 持久 agent（轨迹），自身会话 = 临时可重建（工作副本）。

### 变更
- **移动端登录页**：viewport meta（防移动浏览器 980px 缩放）+ `env(safe-area-inset-*)` 安全区（刘海屏/手势条）+ 触控目标 ≥50px（Apple HIG）+ 输入字号 16px（iOS 聚焦不自动放大）+ `autocapitalize="none"`/`autocorrect="off"`/`enterkeyhint`（移动输入优化）+ `prefers-color-scheme` 明暗自适应 + 响应式卡片 `min(340px, calc(100vw - 48px))` + `theme-color`
- **轨迹跟踪器（Trajectory Tracker）概念（用户拍板命名）**：F2 rebuild 机制语义正式化——**SESSION.md 是持久轨迹（agent 身份本体）；当前会话只是临时可重建的工作副本**；`rebuildReminderText` 文案改为 `[TRAJECTORY]` 前缀并显式阐述该语义
- **上下文阈值回收不生效修复（用户报告）**：两个根因——① `inject` 缺 `sessionProjections`（`ctx.get` 拿不到服务 → `readContextPressure` 恒返回 null → 永不触发）② contextPressure 检测**嵌套在计分提醒内**（KeeperTracker 计分不到阈值永不查上下文，与用户设定的 rebuildThreshold 无关）。修复：`index.ts` inject 补 `sessionProjections`；`keeper.ts` post-execute **重构为两个独立机制**——SESSION-KEEPER 计分提醒（DCP 确认码）+ 轨迹跟踪器压力检测（**每次工具调用后独立检查** contextPressure 投影，超 rebuildThreshold 追加 [TRAJECTORY] 提示）
- 测试：39 files / 376 tests（+4：登录页移动端断言 / rebuildReminderText 新文案 / readContextPressure 装配+未装配）→ typecheck ✓（node + client）

## v1.22.0 — 2026-08-27（归属重构 + 外部访问稳定性修复，S142）

**Scope:** 用户三轮实测驱动：① 架构原则升级（**plugin 是全局的，CCC 是具体的**——账号密码归 plugin，不挂 CCC localstore）；② 3081 外部访问完整可用（登录/工作区/会话/WS 事件流）；③ 设置面板 UI 专业重构（DSH 设置面板承载全部 plugin 配置，CCC 状态栏面板只展示状态）。

### 变更
- **归属重构（config-ops 全局化）**：`serenityAdvanced` 从 CCC localstore.json **迁移到 plugin 全局文件 `~/.dsh/serenity-hooks.json`**（env `SERENITY_HOOKS_CONFIG` 覆盖；0600 权限；`migrateLegacyLocalstore` 首次 session-start 一次性迁移）；所有读写函数去 root 参数
- **gateway 开关打通（3081 未启动根因修复）**：`registerGateway` 的 enabled 改读 **`readSimpleSettings().gatewayEnabled`**（DSH settings 面板开关，plugin 全局）——此前读 localstore `serenityAdvanced.gateway.enabled`（永远 false）与用户设置割裂 → 永不启动；host/port/accounts 读全局文件；**不依赖任何具体 CCC**（apply 即尝试 + session-start 兜底）
- **信任栅栏修复（HTTP 403 根因）**：DSH `isTrustedApiRequest` 要求 **Origin.host === Host.host**——反代除改写 Host（127.0.0.1:主端口）外 **Origin 同步改写**为 loopback（浏览器 POST/WS 握手必带 Origin，透传外部地址 → 403 → host.pickDirectory 等全挂）；`buildProxyHeaders` 纯函数（可测）
- **WS 稳定性修复（ERR_INVALID_HTTP_RESPONSE 根因）**：upgrade 转发①**回写 101 状态行+响应头**到客户端 socket（Node http upgrade 不自动回写——只 pipe 数据 → 无头响应 → handshake 失败）②监听 `response` 透传非 101（403/426）③head/uhead 方向修正（客户端数据→上游，上游数据→客户端）
- **WS 会话保持**：`dispose` **不再清空 token**（token 模块级，进程重启自然清空；热重建清 token → 已登录用户 WS 断 + 重连 cookie 无效）；settings 简单配置变化走 `serenity/settings-changed`（非强制 sync），仅 /serenity/config PUT 走 `serenity/config-updated`（强制重建）——拖动阈值不再打断 WS
- **gateway listen 防崩溃**：EADDRINUSE（旧进程未释放）→ **不抛 unhandled error 崩溃**，1s 重试 ×10；restart-web 双端口（3080+3081）等待释放 + 强杀覆盖
- **工作区白名单（用户需求）**：`gateway.workspaces` 路径前缀白名单（空=全部允许，向后兼容）——gateway 拦截 `POST /api/workspace.list` 响应过滤 items + `workspace.create` 校验（不在白名单 → 403 RPC error）；`filterWorkspaceList`/`workspaceAllowed`/`workspaceDenyResponse` 纯函数
- **crypto.randomUUID polyfill（非安全上下文修复）**：第二端口 http://LAN-IP:3081 是非安全上下文 → 浏览器 Web Crypto `randomUUID` 不可用 → provider 目录加载失败；gateway 反代 HTML 注入 polyfill（getRandomValues 实现，DSH 官方 random-uuid.ts 同算法，幂等 marker）
- **CCC 状态栏面板（SafeModePanel 重构）**：只展示状态（运行环境/安全模式/Loop 运行 + 配置入口引导提示）——账号等配置移出；分组标题 + 行卡 + 清晰换行 + 底部引导
- **DSH 设置面板承载全部 plugin 配置（SettingsSection + AccountsEditor）**：简单配置（开关/阈值）+ 「外部访问」区块（监听地址/端口 + 登录账号 CRUD + 工作区白名单 chips）——账号 CRUD 从 CCC 面板移到 plugin 层（用户拍板）
- **远程状态显示修复**：`resolveWorkspace` 无 sessionId 时**遍历 live sessions 找 CCC 会话**（回退 process.cwd()=$HOME 错误显示"未激活"）；`resolveWorkspaceCore` 纯函数
- 删除 `AccountsTab.tsx/.css`（被 AccountsEditor 取代）；`client/index.ts`/`SettingsSection.tsx` 同步

**测试：** 39 files / 372 tests（+24：workspaces patch / polyfill / workspace 白名单 / 信任栅栏 / workspace-resolve）→ typecheck ✓（node + client）



**Scope:** 用户三截图反馈 + 功能实测：
① UI 看齐 dsh 自身（层级标题/行卡/官方 token）；② F1 3081 端口未监听（功能 bug）修复。

### 变更
- **F1 gateway 功能修复（3081 未监听根因）**：`registerGateway` 原用 `findSerenityRoot(process.cwd())`——dsh web 进程 cwd 是 $HOME 非 CCC → **永远 null → 永不启动**。改为：**root 从 `agent/session-start` 的 header.cwd 发现**（首个会话出现即启动）；sync **幂等**（配置签名 diff 才重启）；**enabled=true 即监听**（无账号时登录页提示而非端口不通）；`/serenity/config` PUT 后 emit `serenity/config-updated` 事件 → 立即重建
- **SettingsSection UI 重构**：官方 settings 设计语言——`section/title/intro + rowCard 行卡`（标题+说明 左列 / 开关右置），开关用 `--dsw-alias-*` token 的自绘 toggle；多级标题（页面标题 → 行卡 → 说明）解决"怎么用"困惑；`Toggle`/`RowCard` 纯组件
- **SafeModePanel 状态卡**：卡片本体加 **safe-mode 徽标**（ON 琥珀 / OFF 灰，--dsw-alias-state-warning-*）——不进模态即可见状态；loop 详情默认折叠（计数 + 展开按钮）
- **模态内容溢出修复**：`sp-modalBody` 改 `overflow-y: auto`（内容超出滚动，不再截断）；loop 详情展开后最多 3 条 + 其余提示
- `SettingsSection.css` 重写：官方 token 词汇表（border-l2/r12 行卡、36px 胶囊按钮风格、32px 输入字段高度）

**测试：** 38 files / 348 tests（gateway 修复 + accounts-api 已覆盖）→ typecheck ✓（node + client）

## v1.21.0 — 2026-08-26（三功能 + 双层配置面板：F1 双端口网关 / F2 session_rebuild / F3 会话命名 / 高级面板，S142）

**Scope:** 用户 S142 需求组（细化+拍板）：零改 DSH 前提下——① F1 dsh web 额外监听一个端口（账号密码登录后即原生 Web UI，适应任何部署）；② F2 上下文超限 LLM 主动触发 `session_rebuild` 清空重建（SESSION.md 实时整理 → 压缩不再需要）；③ F3 dsh 会话命名受宁静号 SESSION 控制（use 激活时重命名为目录名）；④ 配置双层：**简单配置（开关/阈值）→ dsh 原生设置面板**（官方新 RC 已删 WEB_SETTINGS_NAMESPACES 白名单，第三方 ns 零改 DSH 可进），**复杂配置（账号列表）→ 宁静号高级面板**（双 tab 状态/账号）。

### 变更
- **F1 `src/gateway.ts`（新）**：第二 node:http 监听器（默认 0.0.0.0:3081）→ 内嵌极简登录页 → POST /serenity/login 验证（localstore accounts scrypt hash）→ HttpOnly cookie（重启失效）→ 反代 127.0.0.1:主端口（**Host 头改写**过信任栅栏）→ WS upgrade 转发 pipe；`registerGateway` 按 localstore 配置启停
- **F2 `src/rebuild.ts`（新）+ `src/tools/rebuild.ts`（新）**：`session_rebuild` tool——① 归档当前会话（SESSION.md 标记 completed + 立即移 _archived/）② createSession 新宁静号会话 + ctx.agents.create 新 dsh agent ③ 锚点注入（SESSION.md 路径 + 摘要 + 重建指令）；`src/seams/keeper.ts` 扩展 **contextPressure 投影检测**（超 rebuildThreshold → 提醒 LLM 主动触发，不自动执行）
- **F3 `src/tools/session.ts`**：`sessionTool` → **`createSessionTool(ctx)`** 工厂——use 激活宁静号会话后同步 rename 当前 dsh 会话为目录名（`sessionTitle.rename` user source pin 住；naming.enabled 门控；sessionTitle 可选服务守卫）
- **配置分层**：`src/settings-section.ts`（新）——`installSettingsSection(serenity-hooks, schema)` 注册简单配置（gatewayEnabled/rebuildEnabled/rebuildThreshold/namingEnabled）到 dsh 设置面板 + `readSimpleSettings()` 运行时读取 + **降级守卫**（旧 RC 白名单时 client 显示降级提示）；`src/config-ops.ts`（新）——localstore `serenityAdvanced` 节账号 CRUD + scrypt hash + wire 形态（hash 永不落 wire）
- **API `src/api.ts`**：+ `/serenity/config`（GET wire 形态 / PUT patch：新账号必带 pass、既有账号 pass 空保留原 hash）
- **面板 `src/client/SafeModePanel.tsx` 重构**：双 tab 大面板（460px 无滚动条）——状态（CCC/loop/守卫/safe-mode + loops 列表）+ 账号（`src/client/AccountsTab.tsx` 新：host/port + 账号 CRUD）；`src/client/accounts-api.ts`（新）纯转换 + fetch
- `src/index.ts`：Config 加 gateway/rebuild/naming 段 + apply 注册 settings-section/gateway/rebuild/session_rebuild；`src/session-ops.ts`：`sessionsRoot` 导出
- `tsconfig.json`/`client/tsconfig.json`：paths + dsh-settings/dsh-session-title/dsh-client-ui-settings
- 官方源码更新：repo-git 新增 pull 子命令（dsh-harness-public 47f9438→b150a551；5 API 面复核通过）

**测试：** 38 files / 349 tests（+56）→ typecheck ✓（node + client）

**Scope:** 用户两轮反馈迭代：
① 状态条（input.dock 常驻"图片已保存"）永久停留碍眼 → **删除 UI，补救静默化**（组件仅保留 effect 逻辑，return null）
② 对话消息必须写名具体图片路径（目录级提示让 agent 还要猜）→ **恢复路径**：单图「用户提供了一张图片（路径：_tmp/images_from_user/xxx）」；多图「用户提供了 N 张图片：\n- 路径1\n- 路径2…」

### 变更
- `client/ImageFallbackDock.tsx`：**移除全部状态条渲染**（idle/busy/done/error 均不渲染，return null；CSS 文件删除）——补救逻辑保留（上传 + 清 rail + 重发），失败仅 console.warn
- `client/image-fallback-api.ts`：`IMAGE_NOTE_TEMPLATE_SINGLE/MULTI` → **`imageNoteTemplate(paths)`**——单图/多图均写名具体路径
- `client/index.ts`：注册不变（input.dock 条目仍挂载以运行补救 effect）

**测试：** 32 files / 293 tests → typecheck ✓

## v1.20.5 — 2026-08-26（图片落盘：消息模板友好化——去掉突兀的原始文件路径，S142）

**Scope:** 用户 UI 反馈（截图标注）：对话里显示「用户提供了图片在 _tmp/images_from_user/2026-08-26T00-25-00-741Z-ajlq48.jpg」原始路径很突兀。修正：消息改为目录级自然提示，不展示具体文件名；agent 自行查 _tmp/images_from_user/ 目录找图片 → 调 CCC 的 vlm MSM 识别。

### 变更
- `client/image-fallback-api.ts`：`IMAGE_NOTE_PREFIX` → **`IMAGE_NOTE_TEMPLATE_SINGLE`**（"用户提供了一张图片（已保存到 _tmp/images_from_user/），请查看该目录下的图片并处理"）+ **`IMAGE_NOTE_TEMPLATE_MULTI(count)`**（多图）
- `client/ImageFallbackDock.tsx`：消息构造用新模板（不拼接具体路径）；补 import

**测试：** 32 files / 293 tests → typecheck ✓

## v1.20.4 — 2026-08-26（图片落盘：补救后自动清空输入框 rail 图片——用户实测需求，S142）

**Scope:** 用户要求：提供图片后自动删除输入框（rail）里的图片，免手动 ✕。技术：ui-conversation `sessions.provide({ props: ['inputActions'] })` 给所有 session-scope 组件提供 `inputActions`（setDraft/removeImage/submit）——input.dock 组件经 props 直达官方输入机器。

### 变更
- `client/ImageFallbackDock.tsx`：补救成功路径改为 **官方输入机器操作**——`inputActions.removeImage` 逐个清 rail 图片 → `inputActions.setDraft(原文+路径消息)` → `inputActions.submit()`（机器发送，draft 自动清空，无残留）；inputActions 不可用时 fallback 原 resendText（RPC 直发）

**测试：** 32 files / 293 tests → typecheck ✓

## v1.20.3 — 2026-08-24（图片落盘修复：resendText 同样解构丢 this——改为方法调用，S142）

**Scope:** 用户实测 v1.20.2 仍失败：`Cannot set properties of undefined (setting 'promptError')`。根因与 v1.20.2 同类：`resendText` 把 `binding.session.prompt` **解构取出后调用**——prompt 内部读 `this.promptError`（session.ts:191），解构后 `this` = undefined → 抛错。

### 修复
- `client/image-fallback-api.ts` `resendText`：**改为方法调用 `session.prompt(...)`**（this = Session 实例）；注释固化约束
- 全面检查 image-fallback-api：uploadImage（模块函数无 this）/ getDraftFiles（v1.20.2 已修）/ resendText（本次）——**无残留解构调用**

**测试：** 32 files / 293 tests → typecheck ✓

## v1.20.2 — 2026-08-24（图片落盘修复：draftImages this 丢失——解构调用改为方法调用，S142）

**Scope:** 用户实测 v1.20.1 仍失败：`Cannot read properties of undefined (reading 'draftAttachments')`。根因：`getDraftFiles` 把 `conversation.draftImages` **解构取出后调用**（`const draftImages = conversation.draftImages; draftImages(ids)`）——draftImages 内部读 `this.draftAttachments`，解构后 `this` = undefined → 抛错。

### 修复
- `client/image-fallback-api.ts` `getDraftFiles`：**改为方法调用 `conversation.draftImages(ids)`**（this = conversation 实例）；注释固化该约束（防回归）

**测试：** 32 files / 293 tests → typecheck ✓

## v1.20.1 — 2026-08-24（图片落盘修复：上传带 sessionId 解析 CCC 根 + conversation root get + 错误详情显示，S142）

**Scope:** 用户实测 v1.20.0 图片保存失败。根因排查：① 上传接口 workspace 解析——client 未带 sessionId → node half 回退进程 cwd（不可靠）→ 404；② getDraftFiles 经 scope() 寻址 conversation 存在不确定性；③ 失败原因不可见（状态条无详情）。

### 修复
- `client/image-fallback-api.ts`：
  - `uploadImage(file, sessionId)`：**必传 sessionId** → node half 经会话 header.cwd 解析 CCC 根（resolveWorkspace 的 sessionId 分支）
  - `getDraftFiles`：改为 **`ctx.get('conversation')` root singleton 直接取**（draftImages 读 controller 的 draftAttachments Map，与调用 ctx 作用域无关），避开 scope 寻址不确定性
- `client/ImageFallbackDock.tsx`：上传传 sessionId；**错误状态条显示具体失败原因**（err.message，诊断友好）
- `client/index.ts`：inject 签名同步

**测试：** 32 files / 293 tests → typecheck ✓

## v1.20.0 — 2026-08-24（图片自动落盘兜底——WebUI 图片粘贴 → 模型不支持时自动存 _tmp 供 CCC vlm MSM 处理，S142）

**Scope:** 用户需求：DSH 输入框粘贴图片，当且仅当当前模型不支持图片时，自动把图片存到 CCC 目录 `_tmp/images_from_user/`，并以「用户提供了图片在 {path}」文本消息交给 agent 自主处理（各 CCC 自己的 vlm MSM 识别，ACC 不约束 CCC 实现——职责分离）。零配置、完全自动：host 权威门禁（inputModalities）判定，失败即自动补救。

### 变更
- **node half**（`src/api.ts`）：
  - 新增 `POST /serenity/image-upload`（client 专属 x-serenity-ui 头）：类型白名单 png/jpeg/webp/gif + 10MB 上限 → 写 CCC 根 `_tmp/images_from_user/<ts>-<rand>.<ext>` → 返回相对路径
  - 抽取可测核心 `saveImageToTmp(root, mediaType, data)`（导出）
- **client half**：
  - `src/client/ImageFallbackDock.tsx/.css`：`conversation.input.dock` 条目（id serenity-image-fallback）——监听会话 promptError（attachment-error / MODEL_DOES_NOT_SUPPORT_IMAGES）→ 自动补救：rail 图片 File 上传 → 以「用户提供了图片在 {path}」+ 原 draft 纯文本重发（绕过图片门禁）→ 状态条展示已保存路径
  - `src/client/image-fallback-api.ts`：uploadImage（fetch node half）/ getDraftFiles（conversation.draftImages）/ resendText（session.prompt）——官方 client 服务面，零 core 改动
  - `src/client/index.ts`：注册 input.dock 条目（inject slots/conversation/sessions）
- **测试**：`tests/api-upload.test.ts`（+5：类型白名单/缺失数据/超限/目录幂等/路径格式）；全量 293 通过
- home-serenity CCC：零配置（无开关——完全自动）

**测试：** 32 files / 293 tests → typecheck ✓

## v1.19.9 — 2026-08-24（MSM 机制约束——原则 + 隐喻，S142）

**Scope:** 用户要求补充笔墨约束 MSM 机制（存在的原则 + 对应隐喻）。隐喻域 THE SHIP 层 +2 条（The Machinery → MSM 确定性分层 / The Manifest → Single Source of Truth）；Principles 块 +MSM 原则段（确定性优先/单一真相源/注册才能行动）。

### 变更
- `seams/system-prompt.ts`：
  - **metaphorBlock +2 条（重编号 10 条）**：`4. The Machinery → MSM (Mech & Semi-Mech)`（机械确定性 vs 舵手判断——Mech 零推理 / Semi-Mech 决策点；Verdict: 手搓已有机械 = 浪费船员）、`5. The Manifest → Single Source of Truth`（工具只有登记在 manifest 上才存在；唯一 manifest；MSM 自描述 --help/--schema；Verdict: 文档重复记载用法 = 两张矛盾海图）
  - **principlesBlock +MSM 原则段**（Operational boundaries 之前）：Determinism first / Single source of truth / Registered to act
- `docs/metaphor-domain.md`：隐喻表重编号 1-10 + 两条新映射；M-1 映射对象扩展至机制；变更历史
- `tests/osp-alignment.test.ts`：metaphor 断言 8→10 条（+Machinery/Manifest +MSM/Single Source of Truth 映射 +Verdict×10）
- `tests/system-prompt.test.ts`：Principles 断言 +MSM 原则段
- home-serenity CCC：零变动

**测试：** 全量通过（288 tests）→ typecheck ✓

## v1.19.8 — 2026-08-24（系统提示词结构精简——重建视角 R↓，S142）

**Scope:** 用户要求层次精简 + 内容归位（重建视角 EAP R↓）：Principles 与 Constraints 合并（同属容器约束体系）、CCE 与 EAP 保持独立（维度不同）、Metaphor 提前（世界模型前置）。新增认知容器本体论（无错误只有认知不足）与 safe-mode 无人值守语义（用户设计思路）。**Constraints 不再作为独立对齐块（spec 修订：同步 osp compacting.ts——内容并入 Principles）**。

### 变更
- `seams/system-prompt.ts`：
  - **Principles 块（v1.19.8 合并）**：`constraintsBlock()` 删除 → `principlesBlock(root)`（认知容器本体论 "all work is cognition / no errors — only insufficient cognition / not-knowing is a state to be repaired" + Operational boundaries 段 = 原 Constraints 内容）
  - **装配重排**：ACC → **Metaphor**（提前：世界模型前置）→ Principles → CCE → EAP → 状态块 → SKILL → Session
  - **Metaphor 块 World 层呼应句**：`The Sea has no mistakes — only waters you have not yet charted.`（本体论隐喻化）
  - **Safe Mode 块重排**：语义（why——无人值守自由 "the guards are not chains; they are the ballast"）→ 机制（Operational details：bash/blacklist/governance）→ 约束（Behavior constraints）
  - CCE 与 EAP 保持独立（决策：时间一致性 vs 产物质量维度不同，不合并）
- `tests/osp-alignment.test.ts`：OSP_CONSTRAINTS 参照删除；Constraints 对齐断言 → Principles 断言（本体论 + 边界）；块序断言重排；metaphor 断言加呼应句
- `tests/system-prompt.test.ts`：Constraints 断言 → Principles；块序/装配顺序断言重排；safeModeBlock 断言适配新结构
- home-serenity CCC：零变动

**测试：** 全量通过（288 tests）→ typecheck ✓

## v1.19.7 — 2026-08-24（Metaphor 块三层结构化——隐喻域构成 EAP 抽象结构，S142）

**Scope:** 用户要求隐喻本身构成 EAP 抽象结构（隐喻之间存在关系），供后续具体 CCC 按顶层隐喻约束做隐喻改造。方案 B：注入文本完整呈现三层骨架（THE SHIP / THE VOYAGE / THE CREW）+ 每条隐喻 `→ 约束名` 映射标注（M-1）+ Verdict 判据（M-2）。结构约束 M-1~M-4 文档化（docs/metaphor-domain.md）。

### 变更
- `seams/system-prompt.ts`：`metaphorBlock()` 文本重构——头部 3 行说明三层结构；8 条隐喻按 SHIP（Hull/Deck/Drawings）→ VOYAGE（Harbor/Logbook/Theseus）→ CREW（Rotation/Blueprint）分组；每条标题带 `→ 约束映射`（Bounded Space / Entropy (H_op) / EAP / First Anchor / Session Tracking / Continuity / Multi-Agent Cognition / Reconstruction > Preservation）
- `tests/osp-alignment.test.ts`：metaphor 断言升级——三层分组标题 + 8 条本体 + `→` ×8 + 约束名 ×8 + Verdict ×8 + 无中文
- 新增 `docs/metaphor-domain.md`：三层骨架 + 三种显式关系（containment/mapping/sequence）+ 结构约束 M-1~M-4（CCC 隐喻改造模板）
- home-serenity CCC：零变动

**测试：** 全量通过（288 tests）→ typecheck ✓

## v1.19.6 — 2026-08-24（系统提示词去冗余 + Metaphor 强化块——S142 用户设计）

**Scope:** 用户以 EAP 原则审查系统提示词注入：去除重复真相源（EAP 定义两处、Root 两处），新增"宁静号宇宙"隐喻块（全英文 8 条，隐喻 = 记忆钩子 + 行为判据）增强约束力与表达力。CCC 零变动；破坏 CCE 块与 osp 的逐字节对齐（D2）——**验证顺利后修订 specs（同步 osp compacting.ts）**。

### 变更
- `seams/system-prompt.ts`：
  - **去冗余 R1**：CCE 块删 `CCE AND EAP` 段（EAP 三变量定义唯一真相源 = EAP 块；CCE 块回归纯 CCE 主题）
  - **去冗余 R2**：ACC 块删 `Root:`（Root 边界语义唯一真相源 = Constraints 块；ACC 块只做身份标识）
  - **新增 `metaphorBlock()`**：`=== Serenity Metaphor ===` 全英文 8 条（Hull/Logbook/Ship of Theseus/Deck Order/Blueprint over Statue/Crew Rotation/Harbor Inspection/Engineering Drawings），每条隐喻 + Verdict 行为判据；装配于 EAP 之后、SKILL 之前；独立块可回退
- `tests/osp-alignment.test.ts`：OSP_CCE 参照同步删段（R1）；ACC 断言改为"不含 Root"（R2）；块序断言加 Metaphor；新增 metaphorBlock 内容断言（8 条 + Verdict×8 + 无中文）
- 备份：`docs/system-prompt-v1.19.5-baseline.ts`（v1.19.5 注入文本基线，回退参照）
- home-serenity CCC：零变动

**测试：** 全量通过（对齐断言按新基线修订）→ typecheck ✓

## v1.19.5 — 2026-08-24（first-anchor 零配置化——协议固有，S142 用户原则）

**Scope:** 用户原则：任何 CCC 在抽象层都是宁静号/ACC，first-anchor 属 ACC 协议层——机制与内容均不可配置（零配置面）。旧 `serenity.json` bootstrap 段（S137 调参入口）移除，锚定消息与机制参数全部代码固化，所有 CCC 行为与首轮话语一致。

### 变更
- `seams/bootstrap.ts`：`DEFAULT_ANCHOR_MESSAGE`（单条通用人设）→ **`DEFAULT_ANCHOR_MESSAGES`**（两条协议级锚定消息，文本 = 原 home-serenity CCC 配置：ACC 身份+EAP+we/us+先锚定后行动 / 协作协议 5 条+acknowledge 要求，S142 用户确认）
- `resolveBootstrapSettings()` 无参——返回唯一固化设置：`zeroTools=true`（首请求 0 工具，晋升信号仅 assistant/message）、`requiredSignals=2`（两轮锚定）、bootstrapTools/suppressedSources/compactionTools 用协议常量
- `readBootstrapConfig` + `settingsByRoot` 缓存删除——不再读取 CCC 配置；`SETTINGS` 单例全局一致
- `ccc.ts`：SerenityConfig 移除 `bootstrap` 段（配置面收缩；遗留字段静默忽略）
- `index.ts`：注释更新（协议固有、零配置面）
- 测试：bootstrap.test.ts 配置解析块重写为协议固有默认值断言（+锚定消息内容断言）；阶段机测试不变
- home-serenity CCC：`.opencode/serenity.json` 删除 bootstrap 段（行为不变——固化默认 = 原配置）

**测试：** 全量通过（阶段机 + 协议默认值）→ typecheck ✓

**Scope:** v1.19.3 的轮次兜底数 `assistant/message` 事件，但 responses API（opencode-go-responses/muse-spark）下该事件在 assemble 时可能延迟/缺失 → 兜底计数失效 → 首轮锚定后仍不晋升 → 工具仍被裁空（用户实测 tiangong-serenity 会话 turn 4 仍无 ACC 工具）。

### 修复
- `seams/bootstrap.ts` `createEpochPromotion` 兜底计数：`assistant/message` → **`step/start`**（平台稳定事件，responses/completions 都触发；JSONL 实证存在）
- 语义不变：首轮锚定（0 工具）→ 3 步后强制晋升（完整工具），对齐"首轮无工具，后续全面"设计
- 测试更新 +3（step/start 兜底 / scan 路径 / compaction 回落）；292/292 全过

## v1.19.3 — 2026-08-20（bootstrap 晋升轮次兜底——responses API 模型工具不可用修复）

**Scope:** 用户实测 opencode-go-responses（responses API）模型下整套 ACC 工具不可见（模型工具列表为空）。根因：CCC 配置 `bootstrap.zeroTools:true` + 2 条锚定消息 → `requiredSignals=2` 且晋升信号仅监听 `assistant/message`；responses API 模型的会话不产生标准 `assistant/message` 晋升信号（或信号延迟/缺失）→ 永不晋升 → bootstrap 阶段工具被裁成 `tools:[]`（首请求 0 工具），ACC 工具（cc_fs/acc_msm 等）永不可见。

### 修复
- `seams/bootstrap.ts` `createEpochPromotion()`：新增第 3 参 `maxRoundsFallback`（默认 3）——**轮次兜底**：无论晋升信号是否到达，观察到的模型回复轮数（`assistant/message` 事件计数，独立于 `promoteEvents`）达阈值即强制 promoted（开放完整工具）
- 正常模型不受影响：锚定轮数（requiredSignals ≤ 2）< 默认兜底 3，锚定完成后正常晋升
- 防御性、通用：任何不发晋升信号的模型/协议（responses API 等）3 轮后自动解锁完整工具，不再永久卡 0 工具
- compaction/end 后回落需重新计数（epoch 感知保持）
- 测试 +4（bootstrap.test.ts）：兜底强制晋升 / scan 路径生效 / compaction 回落重计数 / resume 场景；292/292 全过

## v1.19.2 — 2026-08-20（loop agent 完整继承 DCP/anchored-standard 层——S140 修复）

**Scope:** 用户实测 loop 子代理缺失 DCP/anchored-standard 层：无法调用 ACC 工具、无法继承循环协议与标准层约束。根因：loop agent 经 `ctx.agents.create` 直接创建（非 DSH delegation 路径），`delegationDepth` 为 0 且 `events` 为空，绕过 anchored 的 `delegationDepth>0 恒 promoted` 分支，落入 bootstrap 收窄路径；当前 CCC 配置 `zeroTools:true` → loop agent 拿到 `tools:[]`（0 工具）+ 2 条 whoami 锚定轮，实质瘫痪。

### 修复
- `seams/bootstrap.ts` `createEpochPromotion.status()`：新增 `session.id` 以 `loop-` 前缀 → 恒 `{boundary:-1, promoted:true}`（完整工具目录，无 anchor 轮）；沿用 `context.ts` `shouldAutoRestore` 既有的 `loop-` 前缀约定，保持一致性
- `seams/bootstrap.ts` `agent/inbox/inserted`：对 `loop-` 会话跳过锚定注入（autonomous worker 不需要 whoami 锚定轮，避免浪费 2 轮 + 0 工具轮）；loop agent 已通过全局 `systemPrompt.section` 获得 ACC 5 块
- 不改 `keeper.ts`：loop agent 工具复原后，`tools/post-execute` 自然按 CCC root 计分/提醒（DCP 生效）
- 测试 +2（bootstrap.test.ts）：`loop-` 前缀恒 promoted / 含 compaction 事件仍恒 promoted；289/289 全过

## v1.19.1 — 2026-08-16（cc_fs 只读子命令误拦黑名单修复——复合工具按 action 判定读写）

**Scope:** 用户实测 `cc_fs exists REPOSITORIES/arsenal`（只读）被 REPOSITORIES 只读参考源黑名单误拦。根因：`decideGuard` 的写类判定用**工具名**（cc_fs 整体 ∈ 写工具），但 cc_fs 是 15 子命令复合工具，只读子命令（root/resolve/exists/list/tree/relative/reveal/info/find）不该查黑名单。

### 修复
- `guards.ts`：新增 `WRITE_TOOLS` + `CC_FS_WRITE_ACTIONS` + `isWriteTool(toolName, action)`——普通工具按名判定；**cc_fs 按子命令 action**（mkdir/rm/mv/cp/touch/append 为写，其余 9 只读）
- `GuardInput` 增 `action` 字段；`extractAction` 从 exec.arguments 提取；`evaluate` 透传
- `extractPathArg` 扩展支持 cc_fs 的 src/dst/paths 数组字段（越界检查不漏主体路径）
- 语义对齐 v1.18.5：黑名单/治理文件只拦写操作；越界检查读写都拦（安全底线不变）
- 测试 +4：cc_fs 只读子命令放行 / 写子命令仍拦 / 无 action 保守 allow / 治理文件按 action 分流；287/287 全过

## v1.19.0 — 2026-08-16（heartbeat 机制彻底移除——无程序价值 + 产生 stray 文件）

**Scope:** 用户发现 turn-heartbeat 机制产生带换行符文件名的 stray 文件（D-1），经评估该机制本身无程序价值，用户决策彻底移除。

### 根因（D-1 stray 文件）
- turn-heartbeat 曾有版本把「路径 + 戳记内容」拼成完整文件路径传给 `writeFile`，文件系统按字面创建名为 `SESSION.md\n\n2026-08-19T…→ heartbeat` 的 stray 文件
- **机制无价值**：`appendHeartbeat()` 写 SESSION.md 文件，而 health 的 stale/stalled/排序全用**会话目录** mtime（`statSync(dirPath).mtime`）→ append 不刷新目录 mtime → 对活性判定零影响；heartbeat 行无任何代码解析消费 → 纯噪声

### 移除（不留死代码）
- `src/seams/loop.ts`（registerTurnFlush + resolveActiveSession）**文件删除**
- `session-ops.ts`：`appendHeartbeat` + `appendFileSync` import 删除
- `index.ts`：`turnFlush` Config 字段/import/注册/apply 调用删除（**破坏性：Config 移除 turnFlush**，故 minor bump）
- `ccc.ts`：`hooks.turnFlush` scheme 字段删除
- 测试：register.test.ts（turnFlush 配置 + turn-stopping 断言）、session-ops.test.ts（心跳块删除；`resolveActiveSession`→`readActiveSessionMd`）
- 文档：design.md（2.5 段标记已移除/表格/决策类型/里程碑）、PLUGIN-MANAGEMENT.md（turnFlush 行）
- 保留 `readActiveSessionMd`（system-prompt.ts Session 块仍用）

**测试：** 283/283（原 285，删 2 个心跳测试）→ typecheck ✓ / build ✓（lib 无 heartbeat 残留，seams/loop.js 产物消失）

## v1.18.8 — 2026-08-16（cc_git push 拒绝误报成功修复——non-fast-forward 被当成功）

**Scope:** 用户实测：`git push --dry-run` 真实拒绝（non-fast-forward，exit 1，本地 1 提交 vs 远程 17 提交分叉），但 cc_git push 返回 "Pushed to origin/serenity-18423"（声称成功无 [REJECTED]），提交从未上远程。

### 根因
`git-ops.ts push` 的成功判断 `stderr.includes('->')` 在拒绝检查**之前**——git push 拒绝输出 `! [rejected]  branch -> branch (non-fast-forward)` **含 `->`** → 拒绝被误判成功。该判断照抄 osp（osp 同病：cc-git-tool.ts 190 行同序）。

### 修复
- `git-ops.ts push`：**先检查拒绝**（non-fast-forward/rejected/[rejected]）→ 返回 [REJECTED] + 操作建议；再判成功（`->`）；其余抛错
- 测试 +1：本地模拟远程分叉（bare repo + 双工作树）→ push 拒绝断言 [REJECTED] 且不含 "Pushed to"；285/285 全过
- 附注：用户此前 cc_git log 看到本地提交是 remote-tracking ref 缓存旧值误导——fetch 前本地 refs/remotes 指向旧状态

## v1.18.7 — 2026-08-15（SESSION-KEEPER 提示词：英文 + 不中断工作语气）

**Scope:** 用户要求 SESSION-KEEPER 提醒文案：1) 使用英文；2) 要求"继续工作，无需中断，顺手回应即可"。

### 修复
- `keeper.ts reminderText`：中文 → 英文；语气改为不中断工作（"No need to interrupt your work — just acknowledge inline and keep going."），确认码 `[SESSION-KEEPER-recorded-{code}]` 保留
- 测试：keeper 断言依赖确认码（不依赖语言）；284/284 全过

## v1.18.6 — 2026-08-15（workflow subagent 宁静号上下文注入 + 锚定生效）

**Scope:** 用户报告 workflow 触发的 subagent 没有宁静号系统上下文注入，first anchor 也没生效。

### 修复
- **系统上下文注入**：`system-prompt.ts agentCwd` 加回退——有 agent 但无 `header.cwd`（workflow subagent 等）回退 `process.cwd()`（对齐 context.ts）；无 agent 仍返回 undefined（不注入，保持原语义）
- **锚定对子 agent 生效**：`bootstrap.ts` 锚定判定重构——根会话（delegationDepth 0）保持 fresh 判定（无历史 user/message，resume 不重锚）；**子 agent（workflow subagent 等）进程内只锚定一次**（`anchoredSessions` Set），不再因 delegationDepth > 0 排除
- 测试：284/284 全过（system-prompt 无 agent → 空 语义保留）

## v1.18.5 — 2026-08-15（黑名单/治理文件保护只拦写操作——读操作不误伤，对齐 osp）

**Scope:** 用户报告"读操作也被拦截了"——REPOSITORIES/ 下的 repo（天工开发流程只读参考源黑名单，对象条目自定义 message）连 **read** 都被拦。根因：dsp 的 `decideGuard` 对**所有带路径参数的工具**（含读）都检查黑名单/治理文件；而 osp 的 permission-guards 只在 `write/edit` 时查黑名单（读操作放行）。

### 修复（对齐 osp permission-guards）
- `guards.ts decideGuard`：**黑名单 + 治理文件保护仅在写类工具**（write/edit/str_replace_editor/cc_fs/bash/append/touch）时检查；**读操作**（read/glob/grep 等）只做路径越界检查（安全必需），不再被黑名单/治理文件误伤
- 路径越界检查保持对所有工具生效（读写都拦——跨根逃逸是安全底线）
- 测试：+2（读工具 + 黑名单路径 → allow；读工具 + 治理文件 → allow；写工具仍拦）；284/284 全过

## v1.18.4 — 2026-08-15（多轮递进锚定：两轮开头控——认知框架 + 工作协议，抽象→具体递进）

**Scope:** 用户验证首轮 0 tool + 约束提示词提高 LLM 整体表现，提出假设"上下文开头对后续产生很大约束，开头应当具备高抽象性"；首轮单条锚定信息量不足 → 设计**两轮递进**锚定问题（EAP 视角：第 1 轮身份/原则高抽象，第 2 轮工作协议中抽象）。

### 实现
- **`anchorMessages` 数组**：按序 prepend 到 next-turn 队列——每轮消费一条（0 工具纯文字回复），逆序插入保证消费顺序
- **阶段机 `requiredSignals`**（createEpochPromotion 扩展）：zeroTools 时 = 锚定轮数——每条锚定回复（assistant/message）计一次，**最后一条回复后晋升**；压缩后计数重置需重新累计
- 配置：`serenity.json bootstrap.anchorMessages: [第一轮, 第二轮]`（兼容单条 anchorMessage）
- CCC 配置：zeroTools + 两轮递进（第 1 轮 Serenity/EAP 认知框架，第 2 轮 5 条工作协议）

**测试：** 282/282（+4：anchorMessages 配置/多轮 requiredSignals/两轮晋升/压缩重置）

## v1.18.3 — 2026-08-15（首轮锚定消息改为 persona + we/us 人称设定）

**Scope:** 用户指定首轮锚定消息改为 "You are a helpful software engineer assistant.The personal pronoun is us/we."——首轮模型以 we/us 人称回答（对齐 anchored 实测的 "we" 轨迹特征）。

### 修复
- `bootstrap.ts DEFAULT_ANCHOR_MESSAGE`：'请介绍当前宁静号…' → 'You are a helpful software engineer assistant.The personal pronoun is us/we.'
- 测试：常量引用自动跟随（自定义 anchorMessage 覆盖不受影响）；278/278 全过

## v1.18.2 — 2026-08-15（Zero-Anchored 变体：0 工具首轮——严格按 zero-anchored-standard 实现）

**Scope:** 用户要求加 Zero-Anchored 变体（首轮 0 工具，纯文字锚定），**必须与 anchored-standard 实现原理一致**。提取 zero-anchored-standard/zero-tool-bootstrap.mjs + anchor-turn.mjs 源码逐行对照移植。

### 实现（对齐 zero-anchored-standard 原理）
- **晋升信号仅 `assistant/message`**（zero-tool-bootstrap.mjs 的 `createEpochPromotion(['assistant/message'])`——零工具首轮模型无法调工具，锚定回复即唯一晋升信号）
- **首请求 0 工具**：`system-prompt/assemble` 在 boundary < 0（未压缩过）时返回 `tools: []`
- **压缩后回落**：compaction/end 后受控阶段 = `compactionTools` 工作集（默认 [] → 0 工具，模型中途继续）
- **per-root tracker**：promoteEvents 按 CCC 配置（zeroTools → assistant/message only；anchored → either），session/event 按 session 所属 root 路由
- **锚定注入复用**：anchorMessage（"请介绍当前宁静号…"）prepend 到 next-turn——首轮模型无工具纯文字回答锚定问题，回复即晋升，第二轮完整工具 + 真实消息
- 配置：`serenity.json bootstrap.zeroTools: true` 切换变体（缺省 false = anchored 5 工具）

**测试：** 278/278（zeroTools 变体晋升信号断言 +1）

## v1.18.1 — 2026-08-15（bootstrap 直接默认开启：移除全部开关——用户明确"直接开启不能关"）

**Scope:** 用户验证 v1.18.0 bootstrap 无效（轨迹无锚定首轮）。根因：两级开关都没开（插件级 Config.bootstrap 默认 false + CCC serenity.json 无 bootstrap.enabled）。用户指示：**"这东西配什么，直接开启，不能关"**——bootstrap 直接默认生效，不做成可关闭的。

### 修复
- `index.ts`：移除 `Config.bootstrap` 开关，`registerBootstrap(ctx)` 无条件注册
- `bootstrap.ts readBootstrapConfig`：移除 `enabled` 门控——总是返回设置（CCC bootstrap 段仅调参数，缺省用默认）
- `ccc.ts`：`SerenityConfig.bootstrap` 移除 `enabled` 字段（文档注明直接默认开启不能关）
- 调用点适配（assemble/anchor/pre-step：非 CCC 跳过，CCC 内总是生效）
- 测试：register.test.ts 全关断言更新（bootstrap 恒注册）；277/277 全过

**用户开启（无需任何配置）：** 重启 dsh web 后新会话即生效——首轮工具目录窄化 + 锚定问题轮（"请介绍当前宁静号…"）

## v1.18.0 — 2026-08-15（Anchored Standard 整合：两阶段工具目录 bootstrap——移植 xiaobright/dsh-anchored-standard，验证能力提升）

**Scope:** 用户要求严格按 [xiaobright/dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard) 实现移植到 dsp，验证"首轮最小工具目录锚定轨迹 → 晋升开放完整工具"是否有实际能力提升（用户自行验证）。核心机制：V4 Pro 强依赖 API 可见工具目录选轨迹——首请求暴露最小工具集 + 剥离自动注入上下文，首次 tool/call 或 assistant/message 后晋升。

### 实现（独立模块 seams/bootstrap.ts，方便摘除）
- **阶段机**（移植 compaction-epoch.mjs）：epoch 感知晋升——tool/call + assistant/message 晋升信号（promoteOn: either/tool-call/assistant-message）；compaction/end 后回落受控阶段需新信号；从持久 session events 推导（resume/reload 不丢）；子 agent（delegationDepth>0）恒晋升
- **目录窄化**（移植 tool-bootstrap.mjs）：system-prompt/assemble 过滤器——bootstrap 阶段只留 bootstrapTools（缺省 read/write/edit/glob/grep，anchored 的 bash/str_replace_editor 适配为 dsp 核心）；compaction 后 + compactionTools；promoted 后开放完整目录；工具缺失降级完整目录 + 一次性告警
- **上下文剥离**：agent/pre-step 剥离 suppressedContextSources（缺省 skill-catalog + agent-instructions）；过滤器出错绝不吞上下文（降级保留全部）
- **首轮锚定**（移植 whoami-turn.mjs）：新会话第一条真实消息到达时把锚定问题 prepend 到 next-turn 队列——第一轮模型只回答锚定问题（最小工具），回复即晋升信号，真实消息第二轮处理。默认锚定问题 = **"请介绍当前宁静号，它是什么，为了什么，200字以内回答"**（用户指定，可配置）
- **配置**：插件级 `bootstrap: true`（Config，默认 false）+ CCC serenity.json `bootstrap.enabled: true` 二级开关（bootstrapTools/promoteOn/suppressedContextSources/compactionTools/anchorMessage 可配置）——零侵入，验证失败一行关摘除

**测试：** 277/277（bootstrap +12：阶段机晋升/epoch/子agent/resume/配置解析）

## v1.17.5 — 2026-08-15（Windows 兼容性全面修复：v1.17.x 深审计 17 项——bun EINVAL 回退/跨盘漏判/反斜杠绕过/CRLF/BOM 等）

**Scope:** Windows 用户提交 v1.17.x 深度审计报告（S009 会话，17 问题）。高优先级：问题 5（acc_msm bun 回退死代码）、问题 6（guards 跨盘漏判）、问题 7（reveal /select, 传参）、问题 8（mech-registry 反斜杠绕过）、问题 9（黑名单斜杠结尾+嵌套治理保护失效）；中优先级 10-17。全部修复。

### 高优先级（功能/安全）
- **问题5**：`msm-ops` bun 回退触发放宽 `ENOENT || EINVAL || EPERM`（新增 `isBunMissing`）——Windows 无 bun 时 execFile('bun') 抛 EINVAL 非 ENOENT → fallback 死代码；async + sync 双路径
- **问题6（安全）**：`guards.decideGuard` 跨盘漏判改用 `pathInside`（旧 `relative().startsWith('..')` 跨盘返回绝对路径原文漏判）
- **问题7**：`reveal` Windows 文件 case 合并参数 `/select,<abs>`（分开传 `/select,` + 路径被 explorer 当空路径）
- **问题8（安全）**：`mech-registry.json` 写保护用 `relative` 归一化反斜杠（Windows 反斜杠路径使正斜杠字面量永不匹配 → 保护失效）
- **问题9（安全）**：`guards.decideGuard` rel 反斜杠归一化（`.secrets/` 规则匹配 `.secrets\file`；嵌套治理路径 `.serenity\child` 拦截）

### 中优先级
- **问题10**：session create 目录名脱敏（`sanitizeDirName`：非法字符→'-'、去尾点/空格、保留名 CON/NUL 前缀）
- **问题11**：session close 读入 CRLF 归一化（`\r\n`→`\n`，防假完成）
- **问题12**：git 操作加 30s timeout（网络路径 GCM 弹框挂起冻结事件循环；超时显式 stderr 提示）
- **问题13**：`status.readDshVersion` 跨平台探测（npm_config_prefix / APPDATA\npm / ~/.npm-global）
- **问题14**：fs-ops `assertNotProtected` win32 大小写不敏感比较
- **问题15**：fs-ops `validateWritePath` 写路径 realpath symlink/junction 防御
- **问题16**：BOM 剥离（`ccc.readUtf8` helper + localstore JSON + msm parseRegistry + opencode-scan frontmatter）
- **问题17**：fs-ops rm 只读文件 win32 先 chmodSync(0o666)；loop label 脱敏（`sanitizeLabel`）

**测试：** 265/265（+5：sanitizeDirName/sanitizeLabel/反斜杠黑名单/嵌套治理/pathInside 跨盘）

## v1.17.4 — 2026-08-15（黑名单对象条目支持：修复 osp 风格 `{pattern, message}` 条目不生效——dsp 只解析 string 导致对象规则变 "[object Object]" 失效）

**Scope:** 用户报告"写黑名单不生效"；参考 osp 排查。osp 的 readBlacklist 支持两种条目格式（string + object `{pattern, message}`），dsp 的 readBlacklist 只 `rules.map(String)`——对象条目被转成 "[object Object]"，规则完全失效（写操作不被拦截）。实证：string 规则拦截正常（write 到黑名单路径被拒），对象形式是唯一失效场景。

### 修复（对齐 osp safe-mode.ts）
- `ccc.ts readBlacklist`：支持 string（`".secrets/"` / `"regex:..."`）与 object（`{pattern, message}`）混合条目；非法条目（数字/null/无 pattern 对象）跳过
- `ccc.ts matchBlacklist`：返回条目对象 `BlacklistRule {pattern, message?}`（原返回规则字符串）
- `guards.ts decideGuard`：命中对象条目时 deny 提示用自定义 `message`（缺省回退 `命中规则 "<pattern>"`）
- `system-prompt.ts safeModeBlock` / `status.ts`：黑名单展示/输出适配条目对象（message ?? pattern）
- 测试：+3（对象条目 deny 提示 message / string+object 混合解析 / 非法条目跳过）；ccc/status/guards 断言适配条目对象

**测试：** 260/260（原 257 + 3 新增）

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
