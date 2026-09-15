# ACC 侧 autopilot 退场（整段删除）— 实施基线

- 版本: v1.0
- 日期: 2026-09-15
- 归属: S142（dsh-serenity-plugin 长期维护）
- 裁决: **所有者 2026-09-15 21:40 选 (a) 整段删除 + 批准「实施 + 发版一次到位」**
- 评估依据: S142 `SESSION.md` §12.34（现状实测 / 代码面 / 三宿主发现）

---

## 0. 范围界定（先把"autopilot"这个词钉死）

**本基线要删的 = ACC 提供的「周期自唤醒」机制**，即：插件内的 autopilot 时钟 + tick 判据 + 唤起执行（`performAutopilotWake`）+ `container_admin autopilot` 三动作域 + WebUI「Autopilot Trajectory」区块与「周期自唤醒」开关 + `/serenity/trajectory` 端点的 autopilot 半边 + bias 注入链路。

**明确不在范围内（保留）**：

| 保留项 | 理由 |
|---|---|
| `container_trajectory wake-later` + 唤醒注册表 + 中心调度器（`wake-scheduler.ts`） | **CCC 自管理链的基座**；与 autopilot 实测独立（其 import 无 autopilot 模块） |
| `wakeSchedulerEnabled` 闸（缺省**开**） | 唤醒调度器的闸，**不是** autopilot 的闸 |
| CCC 侧 `msm autopilot-round` + S151 §1b/§1c 自管理协议 | **CCC 自有**，已端到端验证（§12.32） |
| 配置段 `trajectory.autopilot` | ⚠️ **归 CCC**：`autopilot-round.ts` 读的就是它（enabled/intervalHours/session/biasProvider/avoidWakeHours） |
| `wake-registry.json` 与 `AGENT_SESSIONS/` 会话目录 | 与 autopilot 无关 |

---

## 1. 🔴 强制的二阶裁定：`acc-diag` 的存续

**(a) 未决定此点，但代码上无法回避**：`diag-ops.ts:29-30` 静态 import `autopilot-trajectory` / `autopilot-chain` ⇒ **删模块则 acc-diag 不编译**。故"整段删除"落到代码上必然要在两条路里选一条。

**本基线裁定：路 B —— 保留 `acc-diag` 工具，砍去失去主语的两段。**

| acc-diag 段 | 现状数据来源 | 本基线处置 |
|---|---|---|
| ① live 运行态 | `diagLive(ctx)`（`diag-ops.ts:94`） | **保留**，但只留 **live 会话清单**；"autopilot CCC 目标命中/agent 定位"（`:140-151`）随机制删 |
| ①b 时钟 | `containerClocks()`（`:96`） | **保留 wake 半边**；autopilot 时钟那半删（`:156`） |
| ② 面板解析 | `diagLive.panelResolved`（`:161`） | **删**（面板区块一并删，主语消失） |
| ③ 唤醒注册表 | `containerWakes`（`:97`） | **保留**——它服务的是**新链路**，与 autopilot 无关 |
| ④ 唤起条件链 | `buildWakeChain(root, autopilotRuntimeFacts(...))`（`:99`） | **删**（主语整个是 ACC autopilot 的唤起条件） |

**理由（R↓）**：
1. **所有者主用 acc-diag**（§12.8 C6 已记：面板显示两钟时钟态"所有者已答不需要——他直接看 acc-diag"）⇒ 删整个工具会拿走他的主诊断入口。
2. **③ + live 清单服务的是新链**：`wake-later` 链断没断、条目投没投，正是这两个面在回答。它们与 autopilot 无因果。
3. **删机制 ≠ 删诊断工具**：本裁决不保留 autopilot 的任何执行语义。

**🔴 已知缺口（登记，不静默丢弃）**：④「**为什么这轮没唤起**」的诊断在 **CCC 自管理链**上**归零**。
- 缺口的具体形态：新链的失败是"**S151 漏了自排下一轮**"或"调度器闸关/未 tick"，而删掉 ④ 后**这两种病因都不可见**。
- 按裁决**本次不补**；已登记进 S142 `SESSION.md` 未决段。将来一句话可补，代价 = **一条新条件链**（调度器 armed / 闸 / tick 在跑 / 条目到期 / 补跑窗口 / 目标可解析 / CCC 闸）。
- **不得**以"顺手保留 ④"的方式把它偷偷带回——那会违背 (a)。

**若所有者要"连 acc-diag 一起删"** ⇒ 把 §5 的 **S4 段**替换为"删除 `diag-ops.ts` + `tools/acc-diag.ts` + `exclusiveTools` 声明 + 相关测试"，其余分段不变。

---

## 2. 寄居者清单（必须**先搬走**，才能删宿主）

| 符号 | 现居 | 去向 | 约束 |
|---|---|---|---|
| `TICK_MS` | `autopilot-core.ts` | **内联进 `clock-runtime.ts`**（其唯一消费者是唤醒调度器时钟，`clock-runtime.ts:55`） | 值不变（回归钉：`clock-runtime.test.ts`） |
| `listLiveSessions` / `diagLive` 的 live 部分 | `autopilot-trajectory.ts:593/654` | 新模块 `src/live-sessions.ts`（或并入 `diag-ops.ts`——**取模块，便于单测**） | 对外形状不变（acc-diag ① 渲染不动） |
| `containerClocks().wake` | `container-status.ts:249` | 不动（`wakeSchedulerState()` 本就在 wake-scheduler） | — |
| `readAutopilotSettings` 的**配置读取语义** | `autopilot-core.ts:52` | ⚠️ **随模块删**——ACC 不再读该配置；（CCC 侧 `autopilot-round.ts` 自读，互不依赖） | 确认无其他消费者 |

---

## 3. 涟漪地图（逐文件处置）

### 3.1 删（整体）

| 文件 | 说明 |
|---|---|
| `src/autopilot-core.ts` | 34.3 KB→**12.1 KB**（判据层；`TICK_MS` 先搬） |
| `src/autopilot-chain.ts` | 11.4 KB（条件链；④ 删） |
| `src/autopilot-ops.ts` | 15.8 KB（`container_admin autopilot` 三动作） |
| `src/autopilot-trajectory.ts` | **34.3 KB**（时钟/tick/唤起/状态；寄居者先搬） |
| `tests/autopilot-core.test.ts`、`-chain`、`-ops`、`-trajectory` | 四份 |
| `experiments/autopilot-trajectory/SKILL.md`（9.7 KB） | 其主语已不存在；内容可从 git 历史取回 |
| `docs/*autopilot*` | 同批（specs 镜像见 S5） |

> 合计 **73.6 KB src** + 4 测试 + 9.7 KB 实验文档。

### 3.2 改（去 autopilot 半边）

| 文件 | 改动点 |
|---|---|
| `src/index.ts:50` | 去 `registerAutopilot` 调用与 import |
| `src/tools/container-admin.ts:28,60` | 去 `autopilot` 域（domain enum + 三动作 + 说明文案） |
| `src/settings-section.ts:67-91,105,126` | 去 `autopilotWakeEnabled` 键与旧键 `autopilotEnabled`（**保留** `wakeSchedulerEnabled`） |
| `src/client/SettingsSection.tsx` | 去「周期自唤醒」toggle（`:421`）、`AutopilotTrajectoryStatusBlock`（`:638`）、wire 接口（`:595-613`）、`autopilotOn`（`:236`） |
| `src/api.ts:448-517` | 去 `TRAJECTORY_PATH` 端点整体（含 POST `action:'wake'`）——面板区块删后其两个半边（`status`/`wakes`）皆无消费方 |
| `src/container-status.ts:43,231-249,268-277,322` | 去 `containerAutopilot` / `AutopilotStatusSnapshot` / `containerClocks().autopilot`；`ClockSnapshot` 收窄为 wake 一种 |
| `src/diag-ops.ts:29-31,94-99,140-161,176-177` | 按 §1 表：留 ①(live 会话)/①b(wake)/③；删 ②④ 与 autopilot CCC 渲染 |
| `src/clock-runtime.ts:55` | `TICK_MS` 内联；**ClockOptions 的 autopilot 专用项保守不动**（只去 import，不改语义） |
| `src/host/contract.ts:256` | `session/created` 的 site 去掉 `autopilot-trajectory.ts` |
| `src/wake-scheduler.ts:224` | 仅注释提及 ⇒ 改注释（**逻辑零改动**） |
| `tests/container-status.test.ts:12,23,325-327` | 去 `containerAutopilot` 用例 |

### 3.3 留（一行为不动）

`wake-scheduler.ts`（逻辑）｜`wake-registry.ts`｜`trajectory-ops.ts`｜`trajectory-bound.ts`｜`ccc-roots.ts`｜`clock-runtime.ts`（除 import）｜`container-status.ts` 的 wake/wakes 半边｜`tools/trajectory.ts`（`container_trajectory`）｜skiff/msm/praxis/handyman/localstore/im-bridge 全家

---

## 4. 硬约束（违反即退回）

1. **`wake-later` 链路一行为不动**——钉 = `wake-scheduler.test.ts` + `clock-runtime.test.ts` 原样全绿，**不得为迁就实现改断言**。
2. **`wakeSchedulerEnabled` 闸保留**（缺省开）；只删 `autopilotWakeEnabled`。两闸解耦语义不得回退。
3. **判据只写一份**：删 ④ 后**不得**留下"第二份条件链"或半死的手写版。
4. **配置段 `trajectory.autopilot` 保留**（CCC 在读）——不得连带删除，否则 CCC 巡航静默停摆。
5. **工具面数量不变（11）**：`container_admin` 仍在（少一个 domain）、`acc-diag` 仍在 ⇒ **skiff 白名单不需改**；但须 grep 确认无角色点名 autopilot 域。
6. **文档同批**：漏一处即静默失真（CCC skill ×3 + specs 镜像 + README + `package.json` 描述）。

---

## 5. 分段实施计划（每段独立门禁）

| 段 | 内容 | 判据（机械） |
|---|---|---|
| **S1** | 寄居者搬迁：`TICK_MS` → clock-runtime；`live-sessions.ts`（`listLiveSessions`/live 部分） | `typecheck` 绿；`moved` 符号在新址导出、旧址仍可用（本段不删） |
| **S2** | 删 4 个 src 模块 + 改 §3.2 全部改点 | `typecheck` 绿；`grep -rn 'autopilot' src/` 仅剩白名单（注释/文档字符串） |
| **S3** | 删 4 份测试；修受牵连用例（`container-status.test.ts` 等） | `test` **全绿**且**总例数只减不"假绿"**（逐条说明删了哪些例、为何） |
| **S4** | 面板与端点收口（已在 S2 内联者则本段只做人工核对） | `build` 绿；`pack-check` 文件数**逐项比对**（预期 js chunk 数下降 + d.ts 减少） |
| **S5** | 文档同批：CCC skill（`dsh-serenity-plugin-development` / `home-serenity` / `acc-ccc-boundary`）+ specs 镜像 + README + `package.json` 描述 + `dsh.plugin.json` | `grep -rn autopilot` 在文档面仅剩"已退场"说明 |
| **S6** | 门禁四项 + `CHANGELOG` + `version bump` | `typecheck` / `test` / `build` / `pack-check` 全绿；CHANGELOG 记**退场 + 缺口登记** |
| **S7** | 发布链 + 三推 + `deploy` + `restart-web` | 六道全绿；三 remote 同点 |
| **S8** | **运行态验收**（D14 后必做） | ACC 横幅版本；`container_admin` **无** `autopilot` 域；`acc-diag` **段数由四降为二（①/③）+①b wake**且不报错；`dashboard health` `hostContract` **checked 数下降但 issues []**；`container_trajectory wake-later` **实调一次成功**（链路基座未伤） |
| **S9** | CCC 三件套 + 本 doc 回填实测 | skiff 白名单核对（预期无需改）｜`.dsh/skills` 装机副本｜CCC 侧 §9 版本主线 |

---

## 6. 风险与回退

| 风险 | 判据 | 回退 |
|---|---|---|
| **误伤唤醒链路基座** | S8 实调 `wake-later` 失败 / `wake-scheduler.test.ts` 红 | 该版本**不得发布**；`git revert` 该提交 |
| **`hostContract` checked 数下降被误读为"坏了"** | S8 见 `checked` 变小 | **预期行为**（少了一个 site）；判据是 **`issues: []`**，不是数字 |
| **acc-diag 段数变化被误读为"坏了"** | 四段 → 二段 + ①b | **预期行为**（§1 裁定）；④ 缺口已登记 |
| **CCC 巡航静默停摆** | 硬约束 4 被违反 | `trajectory.autopilot` 段必须保留 |
| 已完成但未观察 | — | 本 doc §8 待 S8 回填 |

---

## 7. 与既有决策的关系

- **D59**（周期自唤醒独立单例）：**本轮整体废止**。
- **D58**（唤醒注册中心）：**保留**，且成为**唯一**的轨迹调度机制。
- **§12.8 裁决**（"拆两半、退掉独立脚本"）：当时把机制那半搬进插件进程；**本轮把这一半也退掉**——理由与当时同源：CCC 已能自管理，ACC 不再需要提供它。
- **§12.34-E 的 (b) 推荐**：所有者选 (a)；本基线**忠实执行 (a)**，仅在"代码上无法回避"处做二阶裁定（§1），并**显式登记缺口**。

---

## 8. 实施实测回填（待 S8 后写）

- 发布版本: （待填）
- 门禁四项: （待填）
- 运行态验收: （待填）
- `acc-diag` 段数: （待填）
- `wake-later` 实调: （待填）
