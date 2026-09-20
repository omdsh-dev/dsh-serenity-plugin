---
name: acc-session
description: 轨迹追踪知识映射（v1.34：v1.33 logbook 并入 trajectory，v1.34 工具名改 container_trajectory）。list/show/create/use/rebuild + send-now（即时投递）/ send-later（未来唤醒）/ cro-guide（CRO 编写指南：让轨迹自己判断何时该被叫醒）操作 AGENT_SESSIONS/ 目录；rebuild = Ship of Theseus 原地清空重建。多步骤工作必须先创建轨迹。
---

# Skill: acc-session — 轨迹追踪（trajectory 知识映射）

> **v1.33/v1.34 工具面重构**：`logbook` **并入 `trajectory`**（v1.33，用户裁决「废除 logbook 这个词」——一条轨迹 = 持久身体 SESSION.md + 时间轴），**v1.34 工具名硬切为 `container_trajectory`**（准确性调整：前缀 `container` 表作用域=本容器内，不表地位）。本技能是知识映射——真实工具由 Native Cordis 插件进程内注册（`container_trajectory`），scripts/ 已退役为空目录。
>
> 动作收敛（原两工具 23 动作 → **6**；**2026-09-16 增第 7 个 `send-message`**；🔴 **2026-09-17 两个投递动作更名（命名 A 案，硬切无别名）：`wake-later` → `send-later`、`send-message` → `send-now`**——判据：两者本是**同一条投递通路**、只差**时刻**，而「唤醒」是**共有**属性不配做区分 ⇒ 族名 `send-`、轴 `-now`/`-later`）：`close` / `archive` 删（归档走 `container_fs mv → _archived/`）｜`health` / `qa` 并入 `use`（内联完整性检查，通过静默、不通过**提示**）｜`summary` 并入 `list`｜`hook-develop-guide` 并进 `container_admin msm guide`｜`wake-add`/`wake-list`/`wake-rm` → **`send-later`**（原 `wake-later`）。**2026-09-20 增第 8 个 `cro-guide`**（CRO 编写指南；判别据=它是**逐轨迹**的知识，故挂在管轨迹的工具上，不新增域）。

## 用途

管理 CCC 根目录下 `AGENT_SESSIONS/` 的轨迹（与 home-session 约定一致）：
每条轨迹 = 一个工作上下文，`SESSION.md` 是它的持久身体（唯一必需文件）。**多步骤工作（3 步以上）必须先创建轨迹**。

## 调用

```json
container_trajectory { action: "<subcommand>", name: "<S###|目录名|关键词>", summary: "<≤20字>", confirm: true }
```

| 动作 | 说明 |
|--------|------|
| `list` | 清单 + 统计：所有轨迹（目录名 / 状态 / 最后修改）+ 总数 / 进行中 / 已完成 / 最近活动 |
| `show` | 读**单条**轨迹的 SESSION.md 正文（模糊匹配：编号 / 目录名 / 关键词） |
| `create` | 新建轨迹（`--desc <desc>` 或 `--issue <ticket>` 二选一 + `--summary`；目录 `YYYY-MM-DD--S###--<desc>/`） |
| `use` | 激活轨迹（当前 dsh 会话绑定该 SESSION + 重命名为 `S###-YYYY-MM-DD-<summary>`）；**内联完整性检查**（目标存在？SESSION.md 在？长期无活动？——通过静默、不通过只提示）；**硬守卫 G1**（已绑定 + 目标≠当前 → 拒绝需 `--force`） |
| `rebuild` | **原地清空重建（Ship of Theseus）**：完全丢弃当前 dsh 会话 → 新建载体 → 注入「继续 S### 的工作」；需 `--summary`（必填）+ 可选 `--note`（任务焦点 ≤200 字）。**keeper 超限提醒依赖它** |
| `send-later` | **定时唤醒**（原 `wake-later`）：未来时刻（RFC3339 或 `+30m`/`+2h`）+ 一条 message，可唤醒任一轨迹（含自己）；落点 `AGENT_SESSIONS/wake-registry.json`，中心调度器到点投递；**fire-and-forget——无回执、无回收** |
| `send-now` | **即时投递**（2026-09-16 增；**2026-09-17 由 `send-message` 更名**）：**现在**就把一条 message 递给目标。live 目标 → **不排队**：在跑则 `steer` **当场注入当前轮**、空闲则立即起一轮；非 live → 走 `sessionController` **冷载入**（**等效于直接 wake**，但**不等 5min tick**）。**同步回执**；**不落注册表**（注册表保持"未来时刻表"单一语义）。⚠️ 回执只到「**已注入 / 已起轮**」——**不表示**目标已执行/已答复；要确证"目标真的动了"必须看它自己的 `SESSION.md`（**不得凭回执结案**）。⚠️ 若 `steer` 不可用会**退回排队**（fail-safe：宁可排队，不可静默丢消息），此时回执文案会写明 |

| `cro-guide` | **CRO 编写指南**（2026-09-20）：读一下"怎么给**这条轨迹**配一段自己的程序、由它决定**该不该叫我**"。现行唤醒只认**时间**（"3 点叫我"）；CRO 让它认**情况**（"天亮且家里有人才叫我"）。**无参数**（纯读，吐指南正文 + 一份可直接用的样例快照）。程序放 `<轨迹目录>/continuous-re-occurrence.ts`（**文件在 = 启用**），由 ACC 的唤醒调度器每 tick 跑它。⚠️ **「文件在」≠「一定会跑」**：另有一个**全局总闸** `croEnabled`（设置面板「CRO（轨迹自编程唤起）」，缺省**开**）——关掉**只停 CRO 阶段**，`send-later` / `send-now` / 唤醒表投递**照常工作**，而你的程序**根本不会被调用** |

> 周期自唤醒（autopilot）**已不存在**：ACC 侧那套于 **v1.35.0 整段退场**（`container_admin` 的 `autopilot` 域已删）。现行自管理巡航 = **CCC 自管理链路**（`msm autopilot-round` + `container_trajectory send-later`），见各 CCC 自己的 SESSION.md 协议段。
> ⚠️ **CRO 不是 autopilot 的回归**（`docs/cro-design.md` §6.4）：退场删的是**判据内容**（周期节拍 + 提示词），留下的是**调度能力**；CRO 补的是"**在没人醒着时判断该不该醒**"——那正是 CCC 自己做不到的那件（CCC 的自排是"被唤起时才跑"）。

## 轨迹命名规范

- 目录：`YYYY-MM-DD--S###--<short-description>`（小写英文连词符，≤5 词）
- S###：自动分配（当前最大 + 1，3 位补零）
- dsh 会话标题：`S###-YYYY-MM-DD-<summary>`（summary ≤20 字，use/create/rebuild 必填）
- **SESSION 绑定持久化**：绑定记录落**宿主存储域** `~/.dsh/storages/serenity_bindings.json`（v1.40.x 起**权威**）；CCC 内 `AGENT_SESSIONS/.bindings.json` **仍双写**作兜底；更早的 `serenity/bound` 会话事件（v1.30.5 及更早）只作存量回落。锚 = **完整目录名**（编码无关）——用途之一是唤起时定位目标的 **dsh 会话 id**（而**目录名本身**的解析走 `AGENT_SESSIONS/` 扫描）。use 硬守卫防 LLM 静默换 SESSION

## 轨迹的 skill 供给（两种写法，**取并集**）

**它解决什么**：把**某个领域的做事方法**直接挂在轨迹身上——不必每轮在提示词里重复交代"这次按哪套规矩做"。

**写法 A —— CCC 级（写一次，本 CCC 的每条轨迹都带）**：在 `.opencode/serenity.json` 里声明：

```json
{ "trajectory": { "skills": ["acc-session", "cce"] } }
```

⇒ **本 CCC 每条被绑定的轨迹**都注入这些 skill 的全文——**含 skiff 角色会话**（skiff 旁路掉的是 ACC 身份与纪律，skill 是"工作资料"，照给）。

**写法 B —— 轨迹级（这条轨迹额外要的）**：在该轨迹 `SESSION.md` 的**最顶部**声明：

```markdown
---
skills: [home-rhetoric, acc-eap]
---

# SESSION: …
```

**两者是并集（不是二选一）**：**CCC 级在前**（容器给的底座）＋ **轨迹级追加**（这条轨迹额外的），同名去重。⇒ 容器给底座，单条轨迹仍可加自己的。

**生效语义**（逐条有代码判据）：

| 面 | 语义 |
|---|---|
| **内容** | 所列 skill 的 `SKILL.md` **全文**，按**声明顺序**拼接，每段带抬头 `=== skill: <名字> ===` |
| 🔴 **生效时机** | **不是"`use` 时灌一次"，而是"绑定期间一直供着"**——注入点是 per-agent `systemPrompt.section`，**每次请求装配重新求值** ⇒ ① **不随对话压缩消失**；② **改了 frontmatter 立即生效，不必重新 `use`**；③ 换绑定自动跟上（绑定消失 ⇒ 该段自动消失，不留空段） |
| **门（何时开始有）** | 该会话**存在轨迹绑定** ∧（**CCC 级声明非空 ∨ 该轨迹声明非空**）。`use` 是主要开关；⚠️ **`create` 不触发注入**——新建轨迹**刻意不夺走当前绑定**（防"长会话中途误 create 被夺走"）⇒ 新轨迹须**后续显式 `use`** 才挂上 |
| **两条来源的关系** | **并集**：CCC 级在前、轨迹级追加、同名去重；配置损坏 ⇒ CCC 级当空（**轨迹级照旧生效**），不牵连 |
| **找不到某个 skill** | 段内**响亮**写 `[缺失] <名字>`，**不静默跳过** |
| **守卫** | 总长 **32 KB** 截断并明示（防上下文膨胀）；skill 名来自工作区数据 ⇒ **先过安全校验才用于拼路径**（防路径穿越） |

⚠️ **重写 `SESSION.md` 时必须原样保留顶部 frontmatter**：compaction / rebuild 会要求重写该文件，抹掉 frontmatter 等于**静默撤销**这条轨迹的全部 skill 声明。keeper 两条重写提醒里各有一句提示，但那是**文案级护栏**（**非机械强制**）。

> 接口真相源：插件仓 `docs/trajectory-skill-injection.md`

## 纪律（强制）

1. **多步骤工作（3 步以上）必须先 `container_trajectory create` 轨迹**，再开始干活
2. 进度记录随时追加（时间戳 + 做了什么）；SESSION.md 体积有上限（缺省 200 KB，超限触发 rebuild 提醒）
3. 收尾时：把未解决问题写进 SESSION.md，并在状态行体现完成（**不再有 close 动作**——完成与否由 SESSION.md 自身表达）

## 何时使用

- 任何多步探索/分析/设计/实施工作
- 被 rebuild 提醒（[TRAJECTORY-ASSISTANT · LIMIT]）要求重建时 → `container_trajectory rebuild`
- 需要"未来某一刻自动继续/提醒另一条轨迹"时 → `container_trajectory send-later`
- 需要"**现在就**把一件事告诉另一条轨迹（或叫醒一条冷轨迹）并拿到投递回执"时 → `container_trajectory send-now`
- 需要让**这条轨迹自己判断"什么时候该被叫醒"**（而不是写死一个时刻）时 → 先 `container_trajectory cro-guide`，照指南写那段程序

## 参考

- 轨迹模板细节：`home-session` 技能（.opencode/skills）
- 身份与工具映射总览：`acc-serenity` 技能
- 调度总览（唤醒时间轴语义 / 五条硬约束）：插件仓 `docs/trajectory-scheduling.md`
