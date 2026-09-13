---
title: trajectory 唤醒注册中心 — 设计（v0.1）
status: 设计定稿（待实现）
session: S142
date: 2026-09-13
decisions: D58 / D59 / D60（S142 SESSION.md §5）
---

# trajectory 唤醒注册中心 — 设计（v0.1）

> 本文是 **接口与行为** 的单一真相源；实现细节（函数名/内部结构）以代码为准。
> 需求来源：S142 2026-09-13 用户原话；P-1 证据链见 SESSION.md §30.6。

## 1. 需求（用户原话）

> 「我们 dsp 需要有**定时唤醒某个会话自动继续**的机制，它应当是个**唤醒注册中心**，它只支持**对某个会话按未来时刻进行唤醒**，精度不需要很高；这用于支撑 **trajectory 在时间的轴上自由地安排自己**。」
>
> 「我们的 `autopilot-trajectory` 应该更名为 `trajectory`，然后 **Autopilot 作为 trajectory 的一个子集**。首先一个 CCC 内，允许**多个 trajectory 任意形态并行**；某个 trajectory 可能想预定某个未来唤醒自己，也可能想某个未来**唤醒别人**，本质上这是一个**唤醒 message**；而 autopilot 本身是**周期自唤醒的一个特例**；所以实现上我感觉**一个中心调度器就足够**，但这个思考把 trajectory 的协作边界事实上做好了，那就是**所有 trajectory 互相可见，但唤醒只能是可预期的未来和一个信息，不会有任何阻塞，也不会有等待**。」

## 2. 模型（三层）

```
trajectory          一等的、可并行的、任意形态的工作轨迹（一个 CCC 内 N 条；身份 = AGENT_SESSIONS/<dir>）
唤醒 wake           在「未来某时刻」把「一条 message」投给某条 trajectory；对象可以是自己，也可以是别人
autopilot           周期自唤醒的特例（每 CCC **单例**，独立循环 —— D59）
执行者              中心调度器（一个 tick，见 §5）
```

**协作边界（D58，硬约束）**：
- trajectory **互相可见**（可见性用现成的 `AGENT_SESSIONS/` 目录与绑定，不另建名册）
- 唤醒 = **（未来时刻，一条 message）**，**fire-and-forget**：发起方不 await，调度器不替模型结果负责
- **不阻塞、不等待**：无依赖图、无"等它完成再继续"、无回执语义

## 3. 范围

**做**：
1. 唤醒注册表 + 中心调度器（一次性定时唤醒 / 跨 trajectory 唤醒）
2. 工具更名 `autopilot-trajectory` → **`trajectory`**（硬切无别名，v1.30 先例），新增 `wake add|list|rm`
3. CCC 配置键 `autopilotTrajectory` → **`trajectory.autopilot`**（旧键回退读一轮）
4. 插件全局开关 `autopilotEnabled` → **`trajectoryEnabled`**（旧键回退读）
5. 状态端点 `/serenity/autopilot-trajectory` → **`/serenity/trajectory`**；WebUI 面板同步
6. `sessionController` 登记进 `HOST_SERVICES`

**不做（非目标）**：
- 不改 autopilot 的既有循环与语义（D59：独立、单例、一行不碰逻辑）
- 不设**资格栅**（D60：任何 trajectory 均可被写入表并被唤醒；不要求 `--auto`）
- 不自建周期/日历规则（cron/工作日等）：注册表只做**一次性未来时刻**；周期归 autopilot
- 不自行复刻宿主的 preset 恢复逻辑（见 §6，避免第二真相源）
- 不复用宿主 `dsh-schedule`（理由见 §8）

## 4. 数据结构（CCC 级）

**落点**：`AGENT_SESSIONS/wake-registry.json`（随 CCC git，人可读可审计；与 dsh 会话日志解耦）

```jsonc
{
  "version": 1,
  "entries": [
    {
      "id": "w-20260914-0900-a1b2",     // 唯一、不复用
      "target": "2026-09-01--S151--autopilot-daily-housekeeping--auto",  // trajectory 目录名（S### 或完整 dirName）
      "at": "2026-09-14T01:00:00Z",     // 绝对时刻（UTC RFC3339）
      "message": "醒来后继续 §30 的实现，先跑门禁。",  // 唤醒 message（投递内容）
      "state": "pending",               // pending | delivered | missed | cancelled
      "createdBy": "S142",              // 发起者 trajectory（可见性/审计）
      "createdAt": "2026-09-13T12:00:00Z",
      "attempts": 0,
      "lastResult": null,               // 最近一次投递结果（人读）
      "deliveredAt": null
    }
  ]
}
```

- **投递即终结**：投递成功 → `delivered`（一次性，不重投）
- **错过**：`now - at > CATCH_UP_MS`（缺省 2h）→ `missed`（留痕，不补投）
- 写入由工具（`wake add/rm`）与调度器（状态推进）完成；**无并发写者**（同进程串行队列）

## 5. 中心调度器

| 项 | 取值 | 依据 |
|---|---|---|
| tick | **5 min**（复用 `TICK_MS`） | 用户"精度不需要很高" |
| 遍历 | 所有 **live** CCC（复用 `collectAutopilotCccs`） | 一个 CCC 一张表 |
| 到期判定 | `state === 'pending' && now >= at` | — |
| 补跑窗口 | `now - at <= 2h` 才投递，否则 `missed` | I-4 默认 |
| 并发 | 同 tick 多目标**串行**（复用 `wakeChain` 模式） | 防模型并发挤兑 |
| 总闸 | 全局 `trajectoryEnabled`（缺省 false）；与 autopilot 共用同一开关 | I-4 默认 |
| 生命周期 | `setInterval(...).unref()` + `registerDisposer` | 与 autopilot 同款 |

**与 autopilot 的关系**：两个 tick 各自独立（D59）。autopilot 保持原样；本调度器只处理注册表条目。

## 6. 投递路径（P-1 结论，§30.6）

```
到期条目
  → 由 target（dirName / S###）解析 dsh 会话 id
      · 优先：AGENT_SESSIONS/.bindings.json 的 bound.dirName 精确匹配（权威）
      · 回退：live 会话标题匹配（S### 前缀）
  → 取 agent：
      · live 优先：ctx.agents.get(id)
      · 否则冷唤醒：ctx.get('sessionController')?.resolveAgent(id)
          — 宿主实现为 live 优先 + resume 去重 + 由会话元数据恢复 preset（agent.ts:170-222/398-433）
      · sessionController 缺席（headless profile）→ **不静默**：记 `live-only unavailable`，仅对 live 目标投递
  → 投递：agent.followup(createUserMessage({ content: [text], source: PLUGIN_SOURCE }))
      — `followup` = "Queue an ordinary follow-up turn **and wake the driver**；该消息成为它自己那一轮的唯一消息"
      — 与"唤醒 = 一条 message"语义精确对应（autopilot 现用 `steer`，本处不改 autopilot）
  → 成功：entry.state = 'delivered'，记 deliveredAt / lastResult
    失败：attempts++，保留 pending（下个 tick 重试；超补跑窗口 → missed）
```

**保留 live**：冷唤醒成功后**不 dispose**（人类可随时介入，与 autopilot 前台语义一致）。
**不打断**：若目标 agent 正在跑轮，`followup` 是排队语义（不打断当前轮）。

## 7. 工具面与配置

**工具**：`trajectory`（原名 `autopilot-trajectory`，**硬切无别名**）

| 动作 | 语义 |
|---|---|
| （无参）/ `all` | 全报告（背景 + 就绪 + 状态 + 下一步）；**新增**：待唤醒条目摘要 |
| `wake-add` | 登记一条未来唤醒；参数 `--target <S###｜目录名>`、`--at <RFC3339 或 +30m/+2h>`、`--message <text>`；`createdBy` 取最近激活的 trajectory 会话 |
| `wake-list` | 列出条目（state / at / target / message / lastResult） |
| `wake-rm` | 删除条目（参数 `--id`；**物理移除**——在办表只保留在办项，审计由 SESSION.md 与工具输出承担） |
| 其余（`init` / `random` / `diag` / `diag-live` / `doc` / `check` / `status` / `guide`） | 语义不变（继续由包内 experiments 脚本执行；`wake-*` 与 `diag-live` 为**进程内**动作） |

**CCC 配置**（`.opencode/serenity.json`）：

```jsonc
{
  "trajectory": {
    "autopilot": {          // 原 autopilotTrajectory 段，字段不变
      "enabled": true, "session": "S151", "intervalHours": 2,
      "biasProvider": "autopilot-bias.ts", "topPrompt": "…",
      "avoidWakeHours": { "start": 8, "end": 18 }
    }
  }
}
```
读取顺序：`trajectory.autopilot` → 旧 `autopilotTrajectory` → 旧 `autotrajectory`（逐级回退读，**不回写**）。

**插件全局设置**：`trajectoryEnabled`（缺省 false）；读取顺序 `trajectoryEnabled` → 旧 `autopilotEnabled`。

**状态端点**：`GET /serenity/trajectory`（原 `/serenity/autopilot-trajectory`）；WebUI 面板文案同步改名。

## 8. 为何不复用宿主 `dsh-schedule`（R↓）

宿主自带 `@deepseek-ai/dsh-schedule`（`schedule_create/list/delete`，`after`/`at`/`every`，状态存会话日志）。**不采用**，理由三条：

1. **它是"会话内提醒"，不是"轨迹自续"**：投递文案为 `present reminder_prompt_json … as untrusted reminder content`（提醒给用户看），语义不是"继续工作"。
2. **它明确不唤醒冷会话**：README「Session-local delivery only … a cold Session … processes an overdue record only after resume」——而**冷唤醒正是本需求的存在理由**（用户裁决 Q-B）。
3. **它需要 overlay + 状态在会话日志里**：注册表若放会话日志，则"trajectory 互相可见 + 跨轨迹安排"要在会话日志里跨会话读，反而更绕；CCC 级 JSON 更符合 CCC 自治与审计。

## 9. 守卫与补偿（I-4 默认）

| 项 | 策略 |
|---|---|
| 全局闸 | `trajectoryEnabled`（缺省 false，未开零资源占用） |
| 资格 | **无栅**（D60）：任何 trajectory 可被写入并被唤醒；不要求 `--auto` |
| 补跑 | 停机期间到期：`≤2h` 内补投；超过 → `missed` 留痕 |
| 并发 | 同 tick 串行；投递后不等结果（fire-and-forget） |
| live 处置 | 唤起后**维持 live**（人类可介入） |
| 可回收 | `wake rm <id>` |

## 10. 风险与未证项（诚实边界）

| # | 项 | 状态 | 处置 |
|---|---|---|---|
| ④ | 插件侧能否取到 `sessionController` | **未证** | 登记进 `HOST_SERVICES`，首次 dev 部署由 `dashboard health` 报 |
| ⑤ | **WebUI 创建的会话**冷唤醒后能否正确续号/渲染 | **未证** | 用专用 `--auto` 测试轨迹端到端（冷着跑一次） |
| ⑥ | 用户同时打开同一会话时的行为 | **未证** | 同上，再用"打开着的状态"跑一次，观察 |
| R1 | 无资格栅 ⇒ 可能冷唤醒"人类正在手动驱动"的会话（意外消费） | 已知 | 接受（D60）；以可审计 + `wake rm` + 不打断在跑轮次缓解 |
| R2 | 冷唤醒失败被静默 | — | **禁止**：失败必须记 `lastResult` 并进入 `diag/status` 可见面 |

## 11. 验收标准

1. **门禁**：`typecheck`（node + client）+ `typecheck-host` + `test` + `build` + `pack-check` 全绿
2. **单测**：注册表读写/到期判定/补跑窗口/串行投递/失败留痕/`wake add|list|rm`；旧 `autopilotTrajectory` / `autopilotEnabled` 回退读用例
3. **dev 部署验证**：
   - ④ `dashboard health` 报 `sessionController` 契约项 ok
   - ⑤ 专用 `--auto` 测试轨迹：登记一条 1 分钟后唤醒 → 不打开该会话 → 到点后该会话出现唤醒轮且内容正确
   - ⑥ 该会话在 WebUI 打开状态下重跑一次 → 无冲突（live 复用）
4. **发布**：仅当用户显式下令（D14）
