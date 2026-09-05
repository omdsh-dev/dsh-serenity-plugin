# CHANGELOG v1.28.0 草稿（五项需求，待 review 确认后并入 CHANGELOG.md）

## v1.28.0 — 2026-09-04（五项需求实现：系统提示词工具块移尾 + 会话命名概括 + rebuild 阈值 K 数值 + MSM 注册表单级化与写保护 + acc_msm catalog 目录，S142 用户回家拍板）

**Scope:** 用户 09-04 晚回家对五项调研需求（`docs/three-feature-requests-research.md` v0.2）逐项拍板后开工实现——① rebuild 阈值百分比→K 数值 ② 会话命名加 ≤20 字概括 ③ 系统提示词 MSM 调用示例 + 工具列表独立块移末尾 ④ 目录式 ACC 使用指南（并入 acc_msm）⑤ MSM 注册表单级化 + 写保护 + ACC 层完整性检查。5 个 commit + review + 发布。

### ① rebuild 阈值：百分比 → K 数值（用户拍板：新键 rebuildThresholdK 默认 400K，纯绝对无窗口比例保护）
- `settings-section.ts`：`rebuildThreshold`（0~1 比例默认 0.9）→ **`rebuildThresholdK`**（z.number min 50 max 4000 默认 400）；SimpleConfigFragment.rebuild.thresholdRatio → thresholdK；entryDefaults/defaultSimpleSettings 同步
- `seams/keeper.ts`：判定从 `ratio = projectedTokens/contextWindow; ratio >= threshold` 改 **`projectedTokens >= thresholdK*1000`**（不再依赖 contextWindow，缺失也照常触发）；文案 K 化 `Context usage at NNNK (threshold NNNK)`
- `config-ops.ts` RebuildSettings.thresholdRatio → thresholdK（默认 400；merge/update 校验 50~4000）；`client/accounts-api.ts` wire 同步；`index.ts` Config schema 同步
- `client/SettingsSection.tsx`：面板滑块（0.10~1.00）→ **K 数字输入**（50~4000 step 50）；help 文案 K 化
- 注：settings.yaml 旧键 `rebuildThreshold` 残留被 schema 忽略（非 strict z.object），新键默认 400K 生效——用户需在面板改回所需值

### ② 会话命名加 ≤20 字概括（用户拍板：summary 必填，编号日期服务端固定派生）
- `tools/session.ts`：`sanitizeSessionSummary`（去控制符/斜杠 + trim + ≤20 码点截断）；`namingTitleFor(active, summary?)` → **`S###-YYYY-MM-DD-<概括>`**；session **use/create 的 summary 参数必填**（缺省报错引导）；renameDshSessionOnUse/ForActive 透传
- `tools/rebuild.ts` + `rebuild.ts`：session_rebuild **summary 必填** → PendingRebuild 存 summary+mdPath → **renameAfterRebuild** 重建后重命名标题（S### 日期从持久轨迹目录派生，概括来自参数）
- 向后兼容：无 summary 时 namingTitleFor 回退 S###-日期（旧调用不破坏）；autopilot `startsWith(sid-)` 匹配天然兼容

### ③ 系统提示词：MSM 调用示例 + 工具列表独立块移末尾（用户拍板：SKILL 后 Session 前）
- `seams/system-prompt.ts`：`accBlock` 拆分 **`identityBlock`**（ACC 身份/CCC/平台工具说明——身份先行，不再内嵌 13 行工具清单）+ **`toolsBlock`**（13 工具含 autopilot-trajectory——修原清单滞后缺行 + skiff_admin 补 apply + **MSM 调用 3 步协议示例**：acc_msm list 发现 / `--schema 1` 查用法 / exec 执行 + mech-registry 不可直写声明）
- 装配序：ACC(身份)→Metaphor→Principles→CCE→EAP→状态→SKILL→**Tools**→Session
- tests/osp-alignment + system-prompt 同步（块序含 Tools + 工具断言改指 toolsBlock）

### ④ 目录式 ACC 使用指南（用户拍板：并入 acc_msm，不新建 acc_guide 工具）
- `msm-ops.ts`：新 action **`catalog`** + `ACC_CATALOG` 常量——ACC 能力目录 **7 分区**（会话与轨迹/认知质量/工具执行/角色对外/自主接入/CCC 配置/注册表安全），每区一句话定位 + 详细 guide 入口；**目录在前、详情各归各（单一真相源——不复制详情）**
- tools/msm 描述 + system-prompt toolsBlock/identity 指引同步（"First-time in a CCC? Run acc_msm catalog"）

### ⑤ MSM 注册表单级化 + 写保护 + ACC 层完整性检查（用户拍板：注册表只有一级对齐 osp；检查入 acc_kit health 只给指引；写保护）
- **⑤a 单级化**：`msm-ops.ts` findRegistries/registryPathFor **只读写 `.opencode/skills/<cccName>/references/mech-registry.json`**（cccName=.serenity 首行），skill 只进 entry 字段；废弃历史分散 skill 注册表（register --skill 曾写各自目录）+ root 级兜底
- **⑤b 写保护**：`seams/guards.ts` `isProtectedRegistryRel`（**写 deny 读 allow**——R6 与 localstore 读 deny 语义区分：注册表是结构核心不是秘密，需被 output-guard/skiff-admin 读取建 MSM 词表）；`fs-ops.ts` validateWritePath 保护改指 cccName 聚合档 + root 级（分散残留放行可删迁移）；acc_msm register/deregister 内部 writeRegistry 天然豁免
- **⑤c 健康检查**：`kit-ops.ts` `checkRegistryHealth` 入 **acc_kit health 的 registry 段**——parse（剥 BOM）/顶层 wrapper 结构/每 entry 字段类型/name 唯一/path 根内+脚本存在；**坏不抛错**（坏表 → ok:false + issues + git 恢复指引——register/deregister 精提交历史可 `git checkout -- <registry>` 恢复）；用户拍板：只输出指引不内置 --restore
- CCC 数据：home-serenity 聚合档并入 6 分散 entry（mail-tool/memory-tool/movie-search/home-diag/session-log-tool/h3-pipeline → 67 entries 总）；分散文件保留（用户拍板——新代码不读，无害残留）；其他 CCC（pangu/tiangong/sh）单级化后各自需手工并入自身 cccName 聚合档（待办）

### 测试
- **54 files / 790 tests 全绿**（768 + 22 净增：③+2 / ②+6 / ⑤b guards+6 / ⑤c checkRegistryHealth+7 / ④ catalog+1）；typecheck ✓（node + client）；build ✓

### review 修复批（P1 已修 + P2-2~P2-5 + P3 五项，独立 review 复验通过后并入）
- **P2-2 祖先目录写保护**：受保护范围从"聚合档精确文件"扩为 **references/ 目录级**——`cc_fs rm -r references/` / `mv references/` 不再能绕过文件级保护删掉注册表（guards.ts isProtectedRegistryRel + fs-ops.ts protectedRegistryTargets 双实现一致；共享父目录 .opencode/skills/<cccName> 不纳入防误伤其他 skill 子目录）
- **P2-3 高级 rebuild 死双胞胎删除**：config-ops AdvancedSettings.rebuild / RebuildSettings / wire.rebuild / applyWirePatch rebuild 段全删——rebuild 归简单配置（settings.yaml）单源，/serenity/config 不再回显死配置；旧文件残留 rebuild 键被 mergeWithDefaults 幂等忽略；accounts-api WireConfig 同步
- **P2-4 迁移提示**：重建阈值面板 help 注明"旧版 0~1 比例（settings.yaml rebuildThreshold）已废弃被忽略——按 K 数值重设"
- **P2-5 跨平台路径判定**：checkRegistryHealth 脚本路径 escape 判断改 `pathInside`（替代 startsWith(root+'/')——Windows 全量误报）
- **P3-①**：session create **dry-run / issue 会话豁免 summary 必填**（未真实创建/无概括语义）；issue rename 以 issue 号作概括回退
- **P3-②**：queueRebuild 报错文案提示 `session use <S###> --summary <概括>`
- **P3-③**：register **首建统一 v1 wrapper**（旧裸数组与 v1 wrapper 并存分裂消除；既有裸数组保留格式承诺不破坏）
- **P3-④**：checkRegistryHealth 无 cccName 时 **issues 空 + ok:true**（path:null 已表达无注册表可查，不再 ok:true 与 issues 并存矛盾）
- **P3-⑤**：toolsBlock acc_kit 行补 "+ MSM registry integrity report"
- **测试同步 + 新增**：guards root 级改 allow（P1 语义）+ references deny ×3 / fs-ops rm -r references [SKIP] + mv 拒 + 普通目录不误伤 / config-ops legacy rebuild 忽略 —— **54 files / 792 tests 全绿 + typecheck/build 双面 ✓**
