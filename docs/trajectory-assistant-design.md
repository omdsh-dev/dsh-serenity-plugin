# trajectory-assistant：过程中提示注入的关卡化设计（初版方案）

> 版本：v0.1（S142，2026-09-05）
> 状态：**初版方案——待用户审核**
> 定位：语言学实验——metaphor（星舰宇宙）= 背景层；trajectory-assistant = 过程中提示注入机制的统一命名 + 关卡化重构

---

## 0. 用户决策记录（拍板）

| # | 决策 | 裁决 |
|---|------|------|
| ① | trajectory-assistant 命名覆盖 | **全部动态提示层**（运行时注入 + 锚定 + compact + autopilot 等；词汇 + 代码都改） |
| ② | 语言学实验核心 | 关卡承载实验 + 隐喻为变量之一（**两者都要**） |
| ③ | 关卡粒度 | **SESSION = 关卡**（一个 SESSION/trajectory = 一个关卡流程） |
| ④ | 设计思想参照 | **《建筑视角下的游戏关卡设计》（An Architectural Approach to Level Design, Christopher W. Totten）**——建筑学视角的空间/动线/视线/边界/空间叙事 → 本设计的核心语言 |
| ⑤ | 词法原则（2026-09-05 追加） | **关卡设计思想用于结构（何时/何地注入），不用于提示词用词**。纯游戏黑话（BOSS/XP/level-up 等）禁止出现在提示词文本；跨领域自然通用词（CHECKPOINT/TUTORIAL）允许。关卡概念仅作内部设计简写（映射何时注入），绝不浮现在提示词文字 |

> 概念二分（用户明示）：
> - **metaphor（背景）** = ACC 系统提示词中的星舰宇宙——**静态、持续、环境性**（每轮装配都在，定义"我身在何境"）
> - **trajectory-assistant（过程注入）** = 轨迹推进过程中的**动态提示事件**——**时机性、事件性、引导性**（在正确的时刻注入正确的引导）

---

## 1. 建筑视角核心思想 → 本设计的转译（新设计语言）

Totten《建筑视角下的游戏关卡设计》的核心：**像建筑师设计空间一样设计关卡**——玩家在空间中的体验由空间本身（而非说明文字）引导。转译到认知注入：

| 建筑/关卡概念 | 定义（原书语境） | 认知注入转译 | 对应机制 |
|-------------|----------------|------------|---------|
| **空间（space）** | 玩家身处、移动的场域 | **工作空间** = 当前轨迹的认知上下文（SESSION 目标/阶段/已有产物） | SESSION=关卡 |
| **动线/流线（circulation）** | 空间如何引导玩家移动、下一站在哪可见 | **认知动线** = 引导 agent 推进方向的提示——"下一站在哪"由可见目标/下一步暗示引导，而非强推 | 目标注入/阶段提示 |
| **视线引导（sightline）** | 用视线内的标志物引导玩家下一步行动 | **注意力引导** = 在上下文"视线内"布置下一步线索（在正确时刻让正确信息可见） | 关卡提示的时机与位置 |
| **地标与定向（landmark & wayfinding）** | 玩家在空间中需要知道自己在哪、往哪走 | **轨迹定向** = SESSION.md 是"地图"，steward/checkpoint 是"当前坐标播报"——防迷路/漂移 | steward 记分 + SESSION 同步 |
| **边界（boundary）** | 空间边界定义游戏内外（短评洞见：边界/体验渗透） | **认知边界** = 何时提示"该收尾/该重建/超出范围"——边界即体验的一部分 | rebuild 压力 + 守卫 |
| **空间节奏（rhythm：开敞↔收束）** | 空间开敞（自由探索）与收束（窄径/聚焦）交替 | **提示节奏** = 自由推进期（少打扰）↔ 聚焦点（明确提示）交替——不全程唠叨 | 注入调度/节流 |
| **对比当符号（contrast as sign）** | 用空间对比（明暗/高低）暗示玩法（短评：干货） | **对比提示** = 用形态变化（如提示前缀/强度/语言风格突变）标记"重要时刻"（Boss/检查点） | 升级提醒（ESCALATED）即雏形 |
| **空间叙事（spatial storytelling）** | 空间布置本身讲故事，非旁白 | **轨迹叙事** = 提示是"环境的自然声音"（星舰广播/仪表读数）而非外部指令——隐喻背景与过程提示**连贯** | 语言学实验：风格档 |
| **场所精神（genius loci）** | 空间的氛围/身份感 | **身份信标** = [ACC] 锚定/compact 重注入——回到"这个轨迹"的氛围 | context/compact |

> **核心转译洞见（R↓）**：建筑视角下，好的引导不是"更响的指令"，而是**让正确的信息在正确的时刻出现在认知动线的视线内**，其余时间环境安静——这正好批判性地回答"为什么不能每轮都注入提醒"（噪音=失明）。trajectory-assistant 的价值 = **动线设计 + 视线管理 + 边界感知 + 节奏控制**。

## 2. 现状盘点：全部动态注入机制（源码实证）

| 机制 | 文件 | 时机 | 现状文本形态 |
|------|------|------|------------|
| **A. Trajectory Steward 计分提醒** | keeper.ts | 工具调用后计分达阈值 | `[TRAJECTORY-STEWARD] Score threshold... acknowledge [TRAJECTORY-STEWARD-recorded-{code}]` |
| **B. 上下文压力 rebuild 提醒** | keeper.ts | 每工具调用查 contextPressure 超 K | `[TRAJECTORY] Context usage at NNNK... call session_rebuild --summary` |
| **B'. 升级强制提醒** | keeper.ts | 连续 3 轮未 rebuild | `[TRAJECTORY-ESCALATED] ... mandatory: STOP... rebuild now` |
| **C. first-anchor 两轮锚定** | bootstrap.ts | 新会话首请求（0 工具阶段） | 轮① EAP/人称/先锚后行 轮② 协作协议 5 条（acknowledge） |
| **D. 工具晋升（bootstrap）** | bootstrap.ts | 锚定后 / compaction 后 | 阶段机：0/核心工具 → 完整工具（epoch 感知） |
| **E. [ACC] 身份播种** | context.ts | session-start / 首次 prompt | `[ACC] Serenity cognitive container active...` 简短头 |
| **F. compaction 重注入** | compact.ts | compaction/end 成功 | 重注入 [ACC] 简短锚点 |
| **G. autopilot 唤起消息** | autopilot-trajectory.ts | 时钟唤起 | 四段式：轨迹焦点 / 身份锚定 / 先验偏见 / 任务 |
| **H. 输出守卫打回** | output-guard | 外部面敏感输出 | steer 打回重生成（命中词 + 分类指引） |
| **I. sessionBlock 协议说明** | system-prompt.ts | 静态（Session 块） | TRAJECTORY-STEWARD 计分协议说明 |

## 3. 关卡设计 → 认知注入 概念映射

游戏关卡设计核心概念 → trajectory-assistant 的对应物：

| 关卡设计概念 | 认知注入对应 | 现有机制落位 |
|-------------|------------|------------|
| **教程关 / 上手引导（onboarding）** | 会话开场引导——教"怎么在这个轨迹工作" | C first-anchor（两轮递进）+ E [ACC] 播种 |
| **关卡目标（objective）** | 轨迹当前目标——来自 SESSION.md 目标/任务 | 需新机制：关卡目标注入 |
| **阶段/小节（segments）** | 工作阶段（探索→设计→实现→验证→收官） | 需新机制：阶段推进感知 |
| **难度曲线（difficulty curve）** | 引导强度/复杂度随轨迹推进变化 | 需新机制：注入强度调度 |
| **技能门（skill gate）** | 关键能力校验点（如必须完成 X 才解锁 Y） | D 工具晋升（bootstrap）雏形 |
| **检查点（checkpoint）** | 进度确认点——记入 SESSION.md / 同步 | A Trajectory Steward（记分提醒同步）雏形 |
| **Boss 战（climax）** | 收官/高难环节——上下文压力极限/收官决策 | B/B' rebuild 提醒 + 升级强制 |
| **评星/结算（rating）** | 轨迹复盘——完成度/质量评估 | 需新机制（可能入 close/archive） |
| **能力解锁（unlock）** | 新工具/技能开放 | D 工具晋升 |
| **节奏（pacing）** | 注入频率控制——不打扰 vs 引导 | 需新机制：注入节流/分层 |
| **隐喻环境（world theming）** | 星舰宇宙的关卡内表达 | metaphor（背景）→ 关卡文案借用星舰词 |

## 4. 统一命名：trajectory-assistant

### 4.1 概念定位
trajectory-assistant = **轨迹助航员**——在轨迹（SESSION）推进过程中，于正确时机注入正确引导提示的机制层总称。星舰隐喻：metaphor 是星舰本身（环境），trajectory-assistant 是**领航员/助航系统**（在航程关键点给指示）。

### 4.2 改名映射（词汇 + 代码）

| 现名 | trajectory-assistant 体系内新名 | 说明 |
|------|------------------------------|------|
| TRAJECTORY-STEWARD | **trajectory-assistant · steward 提醒**（保留代号可商量） | 计分同步提醒 |
| TRAJECTORY / TRAJECTORY-ESCALATED | **trajectory-assistant · rebuild 关卡提醒** | 压力/Boss 提醒 |
| SESSION-KEEPER（历史残留） | 全部并入 trajectory-assistant | 消灭历史名 |
| first-anchor | **trajectory-assistant · 开场教程（tutorial）** | 关卡开场 |
| [ACC] 身份播种 / compact 重注入 | **trajectory-assistant · 身份信标** | 关卡环境还原 |
| autopilot 唤起（轨迹焦点） | **trajectory-assistant · 自主关卡唤起** | 关卡自动开启 |
| output-guard 打回 | trajectory-assistant · 边界守卫（或保持独立——属安全面） | 建议保持独立命名（安全机制非引导机制） |

### 4.3 代码改名面
- keeper.ts：reminderText / rebuildReminderText 的 `[TRAJECTORY-STEWARD]` 前缀 → 统一标识
- system-prompt.ts sessionBlock：协议说明同步
- 注释/变量名：SESSION-KEEPER → TRAJECTORY-ASSISTANT
- **保留兼容**：ACK 协议前缀是 agent 已学习的机械 token——改名需同步测试断言 + 存量会话兼容（建议 token 前缀统一为 `[TRAJECTORY-ASSISTANT]`，recorded/skipped code 语义不变）

## 5. 关卡化设计核心（初版）

### 5.1 关卡 = SESSION 生命周期（对齐 SESSION.md 阶段）

```
SESSION 关卡流程（对齐 session 工具生命周期 + SESSION.md 结构）：
[教程关] 会话开场 → [目标注入] SESSION.md 目标 → 
[推进·阶段] 探索/设计/实现/验证（循环，难度曲线）→ 
[检查点] Trajectory Steward 记分同步 → 
[Boss 关] 上下文压力极限 / 收官 → [结算] close/archive 复盘
```

### 5.2 注入类型学（trajectory-assistant 的分层）

| 层 | 类型 | 用途 | 节奏 |
|----|------|------|------|
| L0 | **环境**（metaphor + 系统提示词） | 静态背景 | 每轮（不变） |
| L1 | **教程**（first-anchor） | 开场引导 | 会话一次 |
| L2 | **目标/方向** | 当前要做什么 | 阶段开始/方向漂移时 |
| L3 | **检查点**（steward 记分） | 进度同步提醒 | 周期性（计分阈值） |
| L4 | **压力/Boss**（rebuild 提醒） | 上下文极限/收官 | 达阈值（+升级） |
| L5 | **守卫**（output-guard） | 边界拦截 | 触发时 |
| L6 | **结算**（close 复盘） | 轨迹收官 | 会话关闭 |

### 5.3 语言学实验设计（核心——需审核）

**实验变量**：关卡提示的**语言形态**对 agent 轨迹质量的影响。

实验组设计（同一任务跑多轨迹，比较不同语言形态）：
1. **控制组**：现有关卡式提示（steward/rebuild 纯指令英文）
2. **实验组 A（星舰叙事）**：关卡提示借 metaphor 星舰词（"Deck check complete, helm reports stable — log to the voyage logbook"）——测试**隐喻连贯性**是否提升遵守/减少抵触
3. **实验组 B（关卡游戏语）**：关卡提示用游戏语（"Checkpoint reached +50 XP · 进度已存档 · 下一段：BOSS"）——测试**游戏化反馈**是否提升动力
4. **实验组 C（中性简洁）**：最小干预（"同步进度到 SESSION.md"）——基线

**测量指标**（可测）：
- SESSION.md 更新及时性/完整性（steward recorded 响应率）
- rebuild 触发延迟（超阈值后多久调 session_rebuild）
- 轨迹完成度（todo/目标达成）
- 用户主观评价（语言是否自然/有帮助）

**机制可配置**：注入文本 = **模板 + 语言风格档位**（metaphor-flavored / game-flavored / plain），CCC 或 plugin 级可选（实验需切换）。

## 6. 实施面（初版范围建议）

### 6.1 命名统一（先行，独立小步）
- keeper/system-prompt 文本 + 注释改名 → trajectory-assistant
- 测试断言同步；CHANGELOG 记录

### 6.2 关卡框架（核心新机制）
- 新模块 `src/trajectory-assistant.ts`：统一注入调度器
  - 监听各时机（tool/post-execute / session-start / compaction / 阶段事件）→ 生成关卡提示
  - 注入文本 = 模板引擎（风格档位可选）
- 概念模型落地：SESSION.md 目标解析 → L2 目标注入；阶段判定 → 难度曲线

### 6.3 实验开关
- 设置面板：trajectory-assistant 风格档位（plain/game/metaphor）+ 实验记录

### 6.4 现有机制归位（不破坏）
- steward/rebuild/锚定等作为 trajectory-assistant 的**具体关卡事件**保留行为，只换命名 + 可配风格

## 7. 待拍板（初版审核点）

1. **命名 token**：`[TRAJECTORY-STEWARD]` 是否保留原样（agent 已学习）还是统一 `[TRAJECTORY-ASSISTANT]`？ACK 协议前缀改动影响存量会话
2. **关卡粒度确认**：SESSION=关卡——但一个 SESSION 可能很长（本 S142 已跨多月），是否需"关卡内阶段"自动细分（按 SESSION.md 章节/目标数）
3. **实验形态**：对照组如何跑（需多轨迹对比）？是否先做**机制层**（命名+框架）再做**实验**？
4. **风格档位**：语言风格放 plugin 配置还是 CCC 配置（实验需要按 CCC 切换）？
5. **结算机制**：close/archive 时是否注入"关卡结算"（完成度/复盘提示）？
6. **output-guard 是否入 trajectory-assistant**：建议独立（安全守卫非引导），请确认

## 8. 参考
- 关卡设计：教程关/难度曲线/技能门/检查点/Boss/节奏（game design 通用框架）
- 现有实现：docs/metaphor-domain.md（背景层）、src/seams/keeper.ts（检查点+压力）、bootstrap.ts（教程+解锁）
