# `trajectory` → `container_trajectory` 更名实施基线 v1.0

- **裁决**：2026-09-15（S142，用户逐条批准 M1~M6 + 三条更正）
- **性质**：**准确性调整**，非美学偏好
- **形态**：B（工具名 + 内部实现文件名清债）
- **兼容**：硬切无别名（D46 先例）+ toolsBlock 对照表教学
- **范围**：dsp（本仓）+ **specs（本 trajectory 内改）**；**osp 不动**（§1 边界 + 2026-09-11 裁决）

---

## 1. 裁决与理由（用户原话要点）

> 「要改就都改了；名称改称 `trajectory` 是**准确性调整**——它是我们 ACC 提供的**容器内** trajectory 机制，尽管是**一等公民**，但仍然是我们**容器内**的；**specs 也在本 trajectory 改**；**osp 不管**」

**这句更正了更名的语义**（R↓，避免后人误读）：

| 旧读法（我原先隐含的） | 正确读法（用户裁决） |
|---|---|
| trajectory 是一等概念 ⇒ 它的工具名应当**不带**容器前缀（暗示它"与容器平级"） | trajectory 机制**由 ACC 提供、运行在容器内** ⇒ 名前缀 `container_` 描述的是**作用域**，不是地位；**一等公民地位不变**（D58 仍然成立：trajectory 是本体，autopilot 是其周期特例） |

⇒ 由此得出**可复用命名判据**（本仓 + specs 共用）：

> **`container_<X>` = 掌管本容器自身之 X 的工具**（`container_fs` / `container_git` / `container_trajectory` / `container_admin`）。
> 前缀 `container` 表**作用域（在本容器内）**，**不表**"与容器平级"。
> 非容器族工具的主语不是容器结构（`msm` 执行技能 / `praxis` 注入知识 / `handyman` 编排 / `dashboard` 仪表 / `localstore` 凭据）。

**规则出处**（一手，早于本次）：`serenity-acc-specs/docs/acc-story.md:222`「命名继承背景：cc_xx → container_xx（工具命名继承 ACC/CCC 背景，甚至 metaphor）」；`dsh-serenity-plugin/docs/acc-tool-naming-rework.md:14` 引用户原话「背景已交代 ACC/CCC，工具命名继承背景」。

## 2. 三层名字：只改后两层

| 层 | 例子 | 本次 |
|---|------|------|
| **概念词** | trajectory（D58 一等概念）/ The Ship's Log / Ship of Theseus / keeper 英文散文 "the carrier of the trajectory" | ❌ **不动**（先例：工具 `container_fs` vs 隐喻 The Hull） |
| **工具名** | `trajectory` → **`container_trajectory`** | ✅ |
| **实现文件名** | 工具住在 `tools/session.ts`；数据层 `session-ops.ts` / `session-bound.ts` | ✅ 清债（B 形态） |

**为什么概念词不动**（被否方案 C 的理由）：波及隐喻域（system-prompt 的 8 块骨架）、keeper 两条强制提醒的英文散文、轨迹连续性理论、`home-research` 的 RSI 笔记——**收益低而风险高**；且"概念名 = 隐喻域 / 工具名 = 容器族"的分层本来是正确结构。

## 3. 形态 B：内部文件清单（**边界必须精确**）

| 文件 | 变更 | 判据 |
|------|------|------|
| `src/tools/session.ts` | → `src/tools/trajectory.ts` | 它就是工具本体（`createTrajectoryTool`） |
| `src/session-ops.ts` | → `src/trajectory-ops.ts` | 主语是 `AGENT_SESSIONS/` 的**轨迹**（findSession / sessionsRoot / summarize / ACTIONS / 激活表） |
| `src/session-bound.ts` | → `src/trajectory-bound.ts` | 主语是**载体↔轨迹绑定**（`.bindings.json` 反查） |
| `src/session-cleanup.ts` | **不动** | ⚠️ 它的主语是 **DSH 会话**（平台对话历史）的删除，**不是轨迹**——按名一刀切会把它误伤 |
| `src/wake-registry.ts` / `wake-scheduler.ts` | 不动 | 主语是"唤醒"这条线 |
| `src/autopilot-trajectory.ts` | 不动 | 主语是 autopilot 这条线（D58 后为 trajectory 的周期特例） |
| `src/rebuild.ts` | 不动 | 它的名字是"动作名"（rebuild 是 action），非主语 |

## 4. 硬约束（**同批，不可拆**）

1. 🔴 **`tools.restrict` 按工具名字符串** ⇒ skiff 角色白名单（`.opencode/serenity.json` 的 `skiff.roles.zhaocai.tools` + `.opencode/skiff/zhaocai.md`）**必须与 ACC 同批改**，否则**招财静默失去该工具**（v1.33 `logbook→trajectory` 已踩过同型坑）。
2. 🔴 **工具名的每一处"命令形态"提及都是可执行指令**（keeper 提醒里写 `trajectory rebuild`，LLM 照做会失败）⇒ 必须全量扫。
3. **specs 在**本 trajectory（S142）**内改**（用户裁决，取代原 M6"另开会话"）。
4. **osp 不动**（其工具面是 `logbook`，属另一运行时，遵循 §1 边界）。

## 5. 涟漪地图（实测计数，实施勾选表）

| 面 | 量 | 位置 |
|---|---|---|
| 插件源码 | 13 文件 / 27 处 | keeper ×2（超限强制提醒）｜`rebuild.ts` ×3（报错引导）｜`seams/system-prompt.ts`（toolsBlock）｜`invariant.ts`｜`dsh.plugin.json`｜`client/SettingsSection.tsx` ×4｜`skiff-core.ts` ×2｜`msm-ops.ts` ×3｜`wake-scheduler.ts`（诊断文案）｜`tools/skiff-admin.ts`（角色示例）｜`settings-section.ts`（注释）｜`tools/session.ts`（注册点） |
| 随包/文档 | 模板 ×3 ｜ README ×2 ｜ `docs/trajectory-scheduling.md` ｜ `docs/trajectory-wake-registry-design.md` | 历史记录（CHANGELOG / `docs/review/*` / `acc-tool-naming-rework.md`）**按纪律不改** |
| CCC 侧 | 4+ 文件 / 16 处 | `.opencode/serenity.json`（白名单）｜`.opencode/skiff/zhaocai.md` ×4｜`home-serenity/SKILL.md` ×3｜`acc-ccc-boundary.md` ×2｜`.dsh/skills/*` 装机副本 ×3｜维护 skill（大） |
| specs | §4 契约表 + §4.4 对照表 + story/README 命名节 | 名 + 判据一并写入 |

## 6. 实施分段（每段留绿）

| 段 | 内容 | 判据 |
|---|------|------|
| **P1 接口归一** | 工具注册名 / `invariant.ts` / `dsh.plugin.json` / toolsBlock / 三个文件改名 + 全量 import 修正 | `typecheck` 双面绿 |
| **P2 涟漪** | keeper ×2 / rebuild 引导 / skiff-core 提示词 / 面板 4 处 / msm-ops 手册 / wake-scheduler 文案 / skiff-admin 示例 | 命令形态 0 残留（grep 判据） |
| **P3 CCC 侧同批** | `serenity.json` 白名单 + `zhaocai.md` + `home-serenity/SKILL.md` + `acc-ccc-boundary.md` + `.dsh/skills` 副本 | 白名单与 ACC 一致（**同步判据 = 工具名逐字相等**） |
| **P4 文档** | 模板 ×3 / README ×2 / docs ×2 / 维护 skill（发布时改） | grep 判据 |
| **P5 specs** | §4 契约名 + 判据（`container_<X>` 作用域规则）| specs 内 grep |
| **P6 门禁** | `typecheck` 双面 / `test` / `build` / `pack-check` / `readme-sync` | 全绿 |
| **P7 dev 部署** | `deploy` → `restart-web` → `container_trajectory list/show` + `acc-diag` | 运行态可调 |
| **P8 发版** | 待 D14 显式下令（v1.34 同批） | — |

**grep 判据（机械可查）**：`trajectory (rebuild|use|create|list|show|wake-later)` 在"现行面"应为 **0**；`'trajectory'`（作为工具名）应为 **0**；**概念/隐喻用词不受此判据约束**。

## 7. 不做的（留档）

- 概念词统一（形态 C）——见 §2 理由。
- alias 兼容层——D46 先例：alias 使工具面膨胀，与"工具面越小越好"相悖；改由 toolsBlock 的"改名对照表"教学。
- 内部文件名全仓一刀切（如 `session-cleanup.ts`）——见 §3 边界。
