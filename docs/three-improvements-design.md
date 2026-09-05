# dsp 三项完善方案（代码级设计）

> 版本：v0.1（S142，2026-09-05）
> 状态：**方案待拍板——只做方案到代码级，未实现**
> 定位：① Metaphor 星舰意象升级 ② Serenity 配置开关+详设合一 ③ DSH 旧会话自动物理删除

---

## 0. 决策摘要（用户拍板）

| # | 需求 | 用户裁决 |
|---|------|---------|
| ① | ACC 核心提示词 metaphor 调整 | **海船→星舰意象升级**（三层 SHIP/VOYAGE/CREW + 约束映射 M-1~M-4 不变） |
| ② | Serenity 配置开关与详设合一 | 现状已是单一面板但详情藏 hover 浮层/折叠 → 改**行内展开详设**（点击开关行展开） |
| ③ | 可开关自动删除指定日期前 dsh 会话 | 目标 = **DSH 平台会话（对话历史）**；语义 = **物理删除**（+ 归档过渡可选） |

---

## 1. 需求① Metaphor 星舰意象升级

### 1.1 现状（实证）

- **唯一核心源**：`hooks/dsh-serenity-hooks/src/seams/system-prompt.ts` `metaphorBlock()`（L264-335）——10 条隐喻注入文本，全英文
- **结构文档**：`docs/metaphor-domain.md`（三层骨架 + 关系 + M-1~M-4 约束）
- **测试断言**：`tests/osp-alignment.test.ts` L269-285（THE SHIP/VOYAGE/CREW 头 + 10 隐喻标题）
- **术语引用**（Ship of Theseus 等散见，不属 metaphorBlock 本体）：README、docs/cognitive-container-theory.md、rebuild.ts L94、tools/rebuild.ts L42
- **关键性质**：metaphorBlock **无 osp 对应**（注释实证："无 osp 对应（dsp 扩展，不进对齐断言参照）"）→ 改造**不破坏** osp-alignment 除 metaphorBlock 自身断言外的一切

### 1.2 现隐喻 → 星舰映射（方案：意象替换，结构不变）

| 现（海船） | 星舰版 | 映射约束（不变） |
|-----------|--------|----------------|
| The Serenity Universe — one ship, one sea | The Serenity Universe — one starship, one voyage | 世界设定 |
| THE SHIP | THE SHIP（星舰本体） | 容器 |
| 1. The Hull（船体/货舱） | 1. The Hull（舰体/气密壳） | Bounded Space |
| 2. Deck Order（甲板秩序） | 2. Deck Order（甲板/舱室秩序） | Entropy H_op |
| 3. Engineering Drawings（工程图纸） | 3. Engineering Drawings（工程蓝图） | EAP |
| 4. The Machinery（轮机） | 4. The Machinery（舰载机械/引擎） | MSM |
| 5. The Manifest（货单/海图） | 5. The Manifest（星图/舰载清单） | Single Source of Truth |
| 6. Harbor Inspection（出港检查） | 6. Departure Inspection / Pre-Launch Check（启航检查/发射前检查） | First Anchor |
| 7. The Logbook（航海日志） | 7. The Logbook（航行日志） | Session Tracking |
| 8. Ship of Theseus | 8. Ship of Theseus（忒修斯之舰——保留，星舰同样适用） | Continuity |
| 9. Crew Rotation | 9. Crew Rotation（船员轮换） | Multi-Agent |
| 10. Blueprint over Statue | 10. Blueprint over Statue | Reconstruction |

**意象词替换表**（星舰语境）：sea→deep space / waters→void / set sail→launch / anchor→docking clamp / sailing→cruising / stones on deck→debris in the hold / afloat→flight-worthy / unassemblable→not spaceworthy / charted→mapped / harbor→drydock / ballast→counterweight。保留词：Hull/Deck/Drawings/Machinery/Manifest/Logbook/Crew/Blueprint（通用工程意象，星舰海舰皆可）。

### 1.3 改动清单（代码级）

| 文件 | 改动 |
|------|------|
| `src/seams/system-prompt.ts` `metaphorBlock()` | 文本改写（星舰意象）；**函数签名不变**；三层头 + 10 条编号 + Verdict 结构不变 |
| `docs/metaphor-domain.md` | 世界层行 + 结构注释同步星舰词；M-4 说明更新（one starship, one voyage） |
| `tests/osp-alignment.test.ts` | 三层头断言不变（THE SHIP/VOYAGE/CREW 保留）；隐喻标题断言**若改名**（如 Harbor→Departure）需同步；新增「无中文」「10 条」「每条含 Verdict」断言保持 |
| 其余（README/rebuild.ts Ship of Theseus） | **不改**——Ship of Theseus 是跨载体隐喻，星舰版仍成立（忒修斯之舰） |

### 1.4 待拍板
- 星舰意象的**具体词表**（上表为推荐，可微调）
- Harbor Inspection → Departure Inspection / Pre-Launch Check 用哪个
- 是否同步 specs 仓（serenity-acc-specs 的隐喻文本若含 sea 意象）

---

## 2. 需求② Serenity 配置开关 + 详设合一

### 2.1 现状诊断（实证）

- **单一面板**（无双面板分裂）：`SettingsSection.tsx` 挂官方 settings 页，含全部配置
- **呈现痛点**：每个 RowCard 右侧是开关，详情在 **help「?」hover 浮层**（SettingsSection.css L381-410：opacity 0→1 + absolute，不 hover 完全不可见）；复杂配置（外部访问账号/微信桥/Autopilot 状态）在**折叠区块**（Collapse 默认收起）
- **用户困惑**：看到开关不知道它具体管什么/怎么配；开关与其详细设定（端口/白名单/账号）被折叠/浮层隔开 → "开关和详细设定分开"

### 2.2 方案：点击行 → 行内展开详设（Accordion RowCard）

**核心交互变更**：RowCard 从「开关 + desc + hover?」改为**可展开行**：
- 行头 = 标题 + 一句话 desc + 右侧开关（保留）
- 点击行（或点「配置」小按钮）→ **行内展开**详细设定面板（当前 help 内容 + 该功能的全部配置项）
- 替代 hover 浮层（详情常显可达，非悬停才见）；折叠区块改为「展开行内含复杂编辑器」

**代码级改动**：

| 文件 | 改动 |
|------|------|
| `src/client/SettingsSection.tsx` | RowCard 组件扩展：`expandable` + `detail` ReactNode props；点击行 toggle 展开态；help 浮层内容移入 detail 面板顶部；Group 内行支持受控展开 |
| `src/client/SettingsSection.css` | 新增展开态样式（.ss-rowDetail：行内下滑展开、padding/border）；保留 help 浮层 CSS（兼容未迁移项）或删除 |
| `src/client/AccountsEditor.tsx` | 外部访问折叠 → 挂在「双端口网关」行展开 detail 内（开关行展开即见账号/白名单） |
| `src/client/WeixinBridgeEditor.tsx` | 微信桥块保持（已是独立 CCC 级配置区，其内部 RowCard 同步改展开式） |
| `src/client/AutopilotTrajectoryStatusBlock` / `PublicAskEditor` | 对应开关行 detail 内联 |

**关键原则**（E↑）：开关与其全部详设**同屏可达**——开一个开关，正下方立即出现该功能的配置区；关闭时收起（灰显已配值，重开保留）。

### 2.3 待拍板
- 展开触发：整行点击 vs 行尾「▸ 配置」按钮
- 详情内容：现 help 文本 + 配置项合并为一区 vs help 保留浮层、仅配置项内联
- 微信桥/外部访问等**重型编辑器**是否也完全内联（行内滚动）vs 保留大折叠区但挂在开关行下

---

## 3. 需求③ 可开关自动删除指定日期前 DSH 会话

### 3.1 现状（实证，决定性）

- **会话物理位置**：`$DSH_HOME/sessions/`（缺省 `~/.dsh/sessions`；base bundle cordis.patch.yml L110-113 `root: dshHomePath('sessions')`）
- **磁盘布局**（format.ts）：`<root>/--<project-slug>--/<encoded-session-id>/session.jsonl(.zstd)`（projectKey/sessionDir/logPath）
- **DSH 无删除会话 API**（决定性）：PersistenceCoordinator 公开方法仅 create/ensureMaterialized/append/prepare/load/inspect/borrow/retire——**无 delete/purge**；workspace delete 明确"retaining directory and every session log"；archiveSession 只加 registry 归档集（UI 隐藏，不删）
- **删除后一致性（利好）**：`sessionPersistence.list()` = readdir 扫描磁盘现存（listArtifacts L507-544）→ **物理删文件后 list 不再返回**；WorkspaceRegistry 下次启动 init 重建 header index 自动消失（workspace-registry L119-140）——**无 registry 幽灵需手工清**
- **CCC 侧已有参考模式**：session-ops archiveSessions（completed + ≥7 天 → _archived/）

### 3.2 方案：可开关定时清理 + 面板配置

**配置（进 simple settings 还是 plugin 全局？）**：属 plugin 级自动运维 → 建议 **advanced settings（~/.dsh/serenity-hooks.json）** `sessionCleanup` 节（含日期阈值），简单开关进 **simple settings**（settings.yaml `sessionCleanupEnabled` + `sessionCleanupOlderThanDays`），面板合一呈现（联动需求②）。

**核心逻辑**（新 `src/session-cleanup.ts`）：
```
接口 SessionCleanupSettings { enabled: boolean; olderThanDays: number }
函数 collectEligibleSessions(sessionsRoot, cutoffMs):
  递归扫描 <root>/--*/--*/session.jsonl(.zstd)
  读首行 header → createdAt / lastActive（header 时间）
  过滤：createdAt < cutoffMs 且 非 live 会话
函数 performCleanup(sessionsRoot, liveIds, cutoffMs, {dryRun}):
  对每个 eligible：rm -rf <session-dir>
  返回 { deleted: [ids], skipped_live: [ids], errors: [] }
```
- **live 会话保护**（关键安全）：删除前取 `ctx.get('sessions').list()` 的 live id 集合，**跳过 live**（删正在运行的会话 = 灾难）
- **运行中即时 UI 消失**：物理删后调 `workspaceRegistry.archiveSession(id)` 归档（UI 立即隐藏）；重启后彻底一致
- **驱动**：注册定时器（如每天一次，或复用 autopilot tick）；也可提供一次性 `dsh-develop cleanup` 子命令手动触发

**测试清单**：
- `session-cleanup.test.ts`：collectEligible 扫描过滤 / live 跳过 / performCleanup 删目录 / dryRun 不删 / zstd+plain 双格式 / 空 root / 权限错误容错

### 3.3 待拍板
- 阈值基准：**createdAt（创建）** vs **lastActive（最后活动）** vs mtime——"指定日期之前"建议 = 最后活动早于 N 天（更符合"没在用的旧会话"）
- 触发：定时器（每天/每周）vs 仅手动（面板按钮 + MSM）
- 删除前是否先 archiveSession 隐藏（避免运行中 UI 残留）+ 二次确认保护（物理删不可恢复）
- 是否加"回收站"（移到 `<root>/_trash/` 而非 rm，可恢复，N 天后清空）——用户选物理删除，但可两级稳妥

---

## 4. 实施顺序建议（拍板后）

1. **② 配置合一 UI**（纯 client 改造，独立可验证）
2. **① 隐喻星舰意象**（纯文本 + 测试断言同步，独立）
3. **③ 会话清理**（新模块 + 配置 + 定时器——最大，独立）
4. 各自 bump 合成一版发布（D14 等用户显式要求）

## 5. 关联
- 本文档配套：无（三独立功能）
- SESSION.md §8「dsp 三项完善调研」条目为本任务的会话级追踪
