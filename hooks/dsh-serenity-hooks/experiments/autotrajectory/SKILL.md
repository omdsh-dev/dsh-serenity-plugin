---
name: autotrajectory-experiment
description: 自主轨迹实验（Self-Sustaining Trajectory Experiment）参与 skill。本 skill 让 CCC 完整理解实验的背景（人类 waiting 是 trajectory 速度瓶颈）、目的（验证"无人等待的 trajectory"能否加速认知推进）、方式（时钟唤起 + 先验偏见 + 轨迹焦点 + 前台运行），并提供一站式实验管理 MSM（autotrajectory-exp：无参全报告 / init 初始化 / random 验证偏见内容）。任何希望参与实验的 CCC 复制本目录到 .opencode/skills/ 即可开始。
---

# Skill: autotrajectory-experiment

> 本 skill 是自主轨迹实验的 **CCC 参与入口**——加载本 skill 即完整理解实验的**背景、目的、方式**。
> 实验管理：`acc_msm exec autotrajectory-exp <doc|check|status|guide>`
> 理论依据：serenity-acc-specs `docs/self-sustaining-trajectory-hypothesis.md`（v0.1 猜想）

## 触发条件/何时加载

- CCC 被选为自主轨迹实验对象时（用户指定）
- 需要理解"无人等待的 trajectory"实验的背景/目的/参与方式时
- 需要预检/查看实验配置时

---

## 1. 背景：为什么有这个实验

认知容器理论（specs §0）确立：**Trajectory 是主体**（Agent 可替换、Session 载体可重建、LLM 是认知介质）；认知容器 = 发生/存储/再发生的地方。

由此观察到**结构性瓶颈**：

> **人类 waiting 拖慢 trajectory**：当轨迹以"等待人类"为推进条件时，其事件序列时间被人类响应间隔（钟表时间）锚定。等待人类 = 轨迹空转——人类响应越慢，轨迹运转越慢。

**猜想**：设计"无人等待"的 trajectory——不依赖人类输入而自动唤起，唤起时携带先验偏见（自主动机）。若成立，轨迹运转速度提升，更快产生让人类满意的效果。

## 2. 实验目的（验证什么）

| 命题 | 内容 |
|------|------|
| P4 | 无人等待的 trajectory 可以时钟驱动自动唤起并携带先验偏见（自生+随机） |
| P5 | 轨迹运转速度提升 → 更快产生让人类满意的效果 |
| 反证 | 熵增失控 / 自我确认循环 / 随机噪音化 / 资源无界 / 反馈脱节——任一显著 → 猜想不成立 |

## 3. 参与方式（CCC 侧四步——第一步可一键 init）

### ① 初始化（一键）：`acc_msm exec autotrajectory-exp init`

自动完成：写配置（`.opencode/serenity.json` autotrajectory 段）+ 生成偏见提供者脚本模板（CCC 根 `autotrajectory-bias.ts`）。

```jsonc
// 写入的配置（init 后可在 .opencode/serenity.json 查看/调整）
{
  "autotrajectory": {
    "enabled": true,                  // 总开关（缺省 false，默认关零资源占用）
    "intervalHours": 12,              // 无人类活动 N 小时后唤起（缺省 12）
    "biasProvider": "autotrajectory-bias.ts", // 偏见内容提供者脚本（CCC 根下）
    "topPrompt": "本轨迹的核心焦点：<CCC 填写>", // 轨迹焦点（v1.26.17）：CCC 定义，每次唤起最先注入
    "avoidWakeHours": { "start": 8, "end": 18 }  // 可选：避开北京高峰（缺省 8~18 省钱）
  }
}
```

### ② 定义轨迹焦点（topPrompt——CCC 自己填写）

**CCC 定义 autotrajectory 时同时定义本轨迹的顶层提示词**（`topPrompt`）：核心目标/纪律/质量要求（示例："持续深化某领域认知，产出可重建的结论与决策记录"）。它会在**每次唤起时最先注入**（`[轨迹焦点]` 段，位于身份锚定之前，影响力最大），作为**稳定焦点锚定 trajectory**——**实验观察：无焦点锚定时，多轮自主唤起中轨迹腐化严重（焦点丢失）**。与偏见内容的分工：**焦点=稳定锚（每轮不变），偏见=随机探索方向（每轮不同），互补**。init 生成占位，CCC 按自己轨迹目标改写（勿留空——留空 = 唤起无焦点锚定，轨迹易漂移）。

### ③ 实现偏见内容提供者（`autotrajectory-bias.ts`）

CCC 根目录下一个脚本，**stdout 输出本轮唤起注入的偏见内容**（反事实问题/探索方向/任何让轨迹偏离既有路径的输入）。**偏见内容归 CCC**——用本 CCC 自己的反馈信息来源保证"足够随机"。`acc_msm exec autotrajectory-exp random` 可验证输出。

### ④ 标记目标会话（可选自生动机段）

- 目标会话目录名加 `--auto` 后缀：`AGENT_SESSIONS/<date>--<desc>--auto/`——**只有带标志的轨迹走自主形态**，同 CCC 其他会话不受影响
- 可选：该 SESSION.md 写「下一轮动机」段（上一轮预写 → 下一轮唤起的自生偏见）

## 4. 机制运行（dsp 侧，CCC 无需干预）

```
定时器（每 10min）→ 唤起条件全满足 →
  ① 读 topPrompt（CCC 定义的轨迹焦点）→ 唤起消息首段注入
  ② 运行 <biasProvider> 脚本 → stdout = 偏见内容（CCC 自定）
  ③ 读 SESSION.md「下一轮动机」段 → 自生动机
  ④ 定位活跃会话 agent → 注入唤起消息（前台运行——用户全程可见、随时可介入）
→ 模型自动继续：探索/反事实检验 → 产出落 SESSION.md「自主探索日志」+ 预写「下一轮动机」
```

**唤起条件**（全部满足）：① enabled ② 会话目录 `--auto` ③ SESSION.md mtime 距今 > intervalHours ④ 北京时间非高峰（缺省避开 8~18）⑤ 无运行中的唤起轮。**偏见提供者脚本缺失 → 唤起中止并报错要求实现**（不静默）。

**人类角色**：不触发、不中断；回复/评价天然并入（同一前台会话）；轨迹不等人类。

## 5. 实验管理（autotrajectory-exp MSM）——一站式

| 用法 | 功能 |
|------|------|
| `acc_msm exec autotrajectory-exp`（**推荐，无参**） | **一站式全报告**：背景摘要 + 就绪度检查 + 当前状态 + 下一步指引 + 步骤——CCC agent 看一次即完整理解并知道怎么开始 |
| `acc_msm exec autotrajectory-exp init` | **一键初始化**：写配置 + 生成偏见提供者脚本模板（CCC 根 autotrajectory-bias.ts） |
| `acc_msm exec autotrajectory-exp random` | 运行偏见提供者脚本，输出当前偏见内容（验证） |
| `acc_msm exec autotrajectory-exp doc` | 实验定义说明全文（本 SKILL.md） |
| `acc_msm exec autotrajectory-exp check` | 仅就绪度检查（配置/轨迹焦点 topPrompt/偏见提供者/--auto 标志/动机段） |
| `acc_msm exec autotrajectory-exp status` | 仅当前状态（配置快照/目标会话/距上次活动/唤起窗口/可唤起性） |
| `acc_msm exec autotrajectory-exp guide` | 仅步骤指引 |

## 6. 观察与验证

- **观察**：无人类活动满 intervalHours 且非高峰 → 前台会话自动出现 `[自主轨迹唤起]` 消息（可见可介入）
- **验证阶段**：A 机制可行性（3~5 轮）→ B 速度对比（72h 有/无等待）→ C 质量与熵（人类评审 + H_op）→ D 长期（数周，检验自我确认/熵增）
- **成功判据**：自主轮产出有意义的比例 ≥ 阈值，且 H_op 维持可运转

## 7. 边界

- 本实验**非标准条款**——不修改 Serenity-ACC 标准正文；验证成立后才评估进入标准演化议程
- 默认关闭；未配置 = 零资源占用；不触碰 CCC 其他会话/机制

## 相关

- 猜想全文：serenity-acc-specs `docs/self-sustaining-trajectory-hypothesis.md`
- 机制定义：dsh-serenity-plugin `docs/autotrajectory-experiment.md`
- 标准理论：serenity-acc-specs README §0
