# `trajectory` → `cognitive_trajectory` 更名实施基线

- **裁决**：2026-10-18（S142，owner 逐条回复 R1/R2/R3/R4/R6 + 工具名选定）
- **性质**：**概念更名**（不只是工具名）——"认知轨迹"是 ACC 的一等概念
- **形态**：**全量**（概念词 ＋ 工具名 ＋ 内部标识符 ＋ 文件名 ＋ 文档），**一次做完**
- **兼容**：硬切无别名（D46/D61 先例）＋ **本次无落盘数据要迁**（见 §3）
- **范围**：dsp（本仓）；**CCC 侧由 CCC 自行处理**（owner 令）；**osp 不动**（§1 边界）

---

## 1. owner 裁决（2026-10-18，逐条）

| # | 事项 | 裁决 |
|---|---|---|
| R1 | 工具名硬切 × skiff 白名单静默失工具 | **接受**；CCC 自行处理同批 |
| R2 | 落盘配置键兼容 | **autopilot 本次清空并退役**（已被 CRO 取代）⇒ **无需迁移** |
| R3 | `TRAJECTORY-ASSISTANT` 契约串 | 无问题；新名一眼看得出与旧名的关系 |
| R4 | 名字变长带来的每请求 token 成本 | **承担**；清晰良好的名称收益更好 |
| R6 | 文档文件名与引用断链 | CCC 自行改 |
| 名 | 工具名用哪个 | **`cognitive_trajectory`** |

**工具名的判据（owner 原话）**：「我们已经工作在宁静号**认知容器内**，容器前缀可以省略。」

⇒ 🔴 **这条推翻了 D61 的一半**。D61 曾定「`container_<X>` = 掌管本容器自身之 X 的**工具**」，
且把「`trajectory` 不带容器前缀」列为**已被否**的方案。
现裁决：**认知容器**本身已是语境 ⇒ 前缀冗余 ⇒ 去掉。
⚠️ **与 D61 不矛盾的部分**：`container_fs` / `container_git` / `container_admin` **不动**——
它们的主语是**容器的构成物**（文件系统／版本库／机务舱）；
而「认知轨迹」是**容器里被管理的认知单位**，与容器不是整体-部分关系。**新判据见 §2。**

---

## 2. 命名判据（本次确立，可复用）

> **`cognitive_trajectory` = 容器中流转的认知单位**；`container_<X>` = **容器自身的构成物**。
> 前者主语是"内容／认知"，后者主语是"容器结构"。

| 形 | 例子 | 为何 |
|---|---|---|
| `container_<X>` | `container_fs` / `container_git` / `container_admin` | 掌管**容器结构**的某个面 |
| 无前缀 | `cognitive_trajectory` / `msm` / `praxis` / `dashboard` / `localstore` | 主语不是容器结构（轨迹/技能执行/知识注入/仪表/凭据） |

---

## 3. 🔴 兼容面核查（**本次的关键发现**）

### 3.1 好消息：**没有落盘数据要迁**

实测三处，全部**不含 `trajectory` 作为标识符**：

| 落盘件 | 内容 | 结论 |
|---|---|---|
| `AGENT_SESSIONS/.bindings.json` | 键是 `dirName` / `sessionId` / `action` / `at` | ✅ 无 `trajectory` 串 |
| `AGENT_SESSIONS/wake-registry.json` | 36 B（空壳） | ✅ 无 |
| `AGENT_SESSIONS/.restrict-diag.json` | 无 `trajectory` | ✅ 无 |

⇒ **`cognitive_trajectory` 是纯代码/文档改名，零数据迁移。** 这是"一次做干净"可行的前提。

### 3.2 但配置面有两处**活键**，不能一刀切

| 配置键 | 位置 | 状态 | 处置 |
|---|---|---|---|
| `trajectory.autopilot{...}` | `serenity.json:9` | 🔴 **死的**（实现已于 v1.35.0 整段退场，无人读） | **本次删除**（owner R2） |
| `trajectory.skills[]` | `ccc.ts:197`（v1.44.0） | 🟢 **活的**（CCC 级 skill 供给，每请求求值） | 🔴 **必须迁移**到新键，**不能随父键删掉** |
| `skiff.roles[].trajectory{session,keeper,rebuild}` | `ccc.ts:418`、`serenity.json:94` | 🟢 **活的**（轨迹纪律子集） | 改名 `cognitiveTrajectory`？**否** —— 见下 |

🔴 **`skiff.roles[].trajectory` 的判断**：它的语义是「该角色参与**轨迹纪律**的哪几项」，
主语确实是轨迹 ⇒ **应随更名**。但它是 **CCC 已落盘配置**（`serenity.json:94` 已经在用）。
⇒ 与 owner 的「一次做干净」一致的做法 = **ACC 读新键、暂时兼容旧键一个版本**，
或 **ACC 与 CCC 同批改**（CCC 在自己的仓里改，owner 已令 CCC 自行处理）。

**本次取后者**：`cognitiveTrajectory` 为唯一新键，**不留回退**（干净），
但**必须在 CCC 侧同批改 `serenity.json` 里该角色的键**，否则该角色的轨迹纪律静默变全 false。

### 3.3 `TRAJECTORY-ASSISTANT` 契约串

出现在每轮注入（`[TRAJECTORY-ASSISTANT · CHECKPOINT]`）与 ACK 格式
（`[TRAJECTORY-ASSISTANT-recorded-{code}]`）。我们同时写两端 ⇒ **同批改安全**。
owner 已明确 R3 无问题。

---

## 4. 涟漪地图（实测计数，勾选表）

| 面 | 量 | 最重的位置 |
|---|---|---|
| `src/` | **282 行 / 42 文件** | `tools/trajectory.ts` 37｜`seams/system-prompt.ts` 22｜`seams/keeper.ts` 22｜`wake-scheduler.ts` 22｜`ccc.ts` 20 |
| `tests/` | **240 行 / 40 文件** | `trajectory-skills.test.ts` 23｜`trajectory-bound.test.ts` 19｜`trajectory-tool.test.ts` 18 |
| `docs/` | **40+ 份**（含**文件名**） | `trajectory-*.md` 一整套设计档 |
| CHANGELOG | 175 行 | 🔴 **不改**（历史） |
| `docs/_archive/` | 若干 | 🔴 **不改**（归档） |
| CCC 侧 | 31 处 / 12 文件 | `serenity.json:90`（白名单）｜`skiff/zhaocai.md` ×5｜`home-serenity/SKILL.md` ×4｜`autopilot-round.ts` ×2 |

---

## 5. 硬约束（**同批，不可拆**）

1. 🔴 **`tools.restrict` 按工具名字符串**：ACC 改名后，CCC 的 `skiff.roles[].tools` 白名单
   （`serenity.json`）与 `skiff/<role>.md` **必须同批改**，否则**该角色静默失去工具**。
2. 🔴 **不留别名**：D46/D61 先例 —— alias 让工具面膨胀，且"旧名还能用"会让漏改永久潜伏。
3. 🔴 **宿主的 `conversation.trajectory.*` 槽名绝不能碰**（那是宿主概念，我们用的是
   `conversation.chat.turnTail`，本来就不冲突）。
4. 🔴 **CHANGELOG / `docs/_archive/` 一个字不改**（历史是历史）。
5. 🔴 **`trajectory.skills[]` 必须保住**（活键，见 §3.2）。

---

## 6. 实施分段（每段留绿）

| 段 | 内容 | 判据 |
|---|---|---|
| **P1 接口归一** | 工具注册名 `container_trajectory` → `cognitive_trajectory`；`invariant.ts`；`dsh.plugin.json`；toolsBlock；三个文件名 | `typecheck` 双面绿 |
| **P2 概念词** | 概念层标识符 / 注释 / 英文散文（keeper 提醒、system-prompt 骨架） | `test` 绿 |
| **P3 内部标识符** | `trajectory-bound.ts` → `cognitive-trajectory-bound.ts` 等；全量 import 修正 | `typecheck` 绿 |
| **P4 配置面** | 删 `trajectory.autopilot`（死键）；`trajectory.skills` → `cognitiveTrajectory.skills`；skiff `trajectory{}` → `cognitiveTrajectory{}` | 配置读取单测绿 |
| **P5 测试** | 40 文件全量 | `test` 绿 |
| **P6 文档** | 40+ 份（含文件名改） | grep 判据 |
| **P7 门禁** | 六项全跑 | 全绿 |
| **P8 CCC 侧**（owner 令：CCC 自行） | `serenity.json` / `zhaocai.md` / SKILL.md / `autopilot-round.ts` | **白名单工具名逐字相等** |

**grep 判据（机械可查）**：现行面（排除 CHANGELOG/`_archive`）里
`container_trajectory` = **0**；`\btrajectory\b` 作为**工具名/标识符** = **0**；
概念/隐喻用词（Ship of Theseus 等）不受此判据约束，但**本次一并改**。

---

## 7. 风险与处置

| 风险 | 处置 |
|---|---|
| 工具名硬切致 skiff 静默失工具（R1） | ACC+CCC 同批；**判据 = 白名单工具名逐字相等** |
| `trajectory.skills` 随父键被误删 | §3.2 单列；改完**必须有单测钉住 CCC 级 skill 仍注入** |
| 名字变长使每请求 token ↑（R4） | owner 已承担；实测 `container_trajectory`=5 est tokens ⇒ `cognitive_trajectory` 预计 5~6，可接受 |
| 文档文件名改了引用没改（R6） | CCC 自行；**但 dsp 内部对 docs 的引用由本轨同批改** |
| 40+ 文档一次性改错 | 分批执行，**每批后 grep 判据 + 门禁** |

---

## 8. 不做的

- **别名兼容层** —— D46 先例；且本次零落盘数据，没有"旧名还能用"的必要。
- **改 CHANGELOG / `_archive`** —— 历史不改写。
- **动宿主 `conversation.trajectory.*`** —— 那是宿主概念。
- **osp 同步** —— §1 边界（另一运行时，工具面是 `logbook`）。
