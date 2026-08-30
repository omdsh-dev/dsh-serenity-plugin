# 认知容器理论（Cognitive Container Theory）

> 本文是 dsh-serenity-plugin 的理论叙述独立文档——**README 能力为主，理论在此展开**。
> 权威标准源头：[serenity-acc-specs](https://github.com/tellmewhattodo/serenity-acc-specs)（认知容器标准，v1.3.1 起含 §0 理论根基）。
> 本文为 §0 的浓缩叙述，供快速理解；完整论证、不变量与术语表见 specs。

## 1. 认知容器：定义

> **认知容器 = 认知发生、存储、再发生的地方。**

这是顶层定义，也是本插件的存在理由。任意带 `.serenity` 标记的目录（CCC, Concrete Cognitive Container）经本插件成为这样一个容器：

| 认知环节 | 机制 |
|---------|------|
| **发生** | 认知以 Loop 形式进行——agent 的每一轮 turn 都是认知 Loop 的一次迭代 |
| **存储** | 轨迹（trajectory）持久化——`SESSION.md` 是轨迹的**持久身体**（永远原位），`AGENT_SESSIONS/` 是轨迹的库房 |
| **再发生** | 轨迹被新的 agent 重新推动——`session_rebuild`（Ship of Theseus）：载体可重建，本体不变 |

## 2. 认知 Loop：动作与反馈同质

认知不是"读入 → 思考 → 输出"的流水线，而是 **Loop**：

- 每一轮 turn 中，模型发起动作（思考/调用工具/等待用户/接收系统事件），世界给出反馈
- **动作与反馈同质**——一切外部交互（tool 调用、等待用户、系统事件）都是反馈，是 Loop 在采样世界以验证**内生预测**
- Loop 通过反复的动作-反馈循环**丰富自身**：预测被验证则巩固，被推翻则修正

这一方向与 Andy Clark 的预测加工（predictive processing）理论一致：认知主体不是被动接收信息，而是主动生成预测并通过行动验证。

## 3. Trajectory 主体：谁在认知

**主体反转**是理论的关键一步：

- **人类视角**：看到的是一个个开环事件（agent 来、agent 走、会话开、会话关）
- **trajectory 视角**：看到的是**闭环**——自己的事件序列在时间中持续流动；agent、会话、模型都是这个流动中的过客

**时间相对性**：trajectory 感受的是自己事件序列的相对时间（第 N 次迭代、第 M 次重建），而非日历时间。只要轨迹连续，参与的 agent、模型、宿主都可替换——**协作规模不受单个 agent 生命周期限制，而受轨迹连续性限制**。

## 4. Session = Trajectory 的可重建载体

Session 与 trajectory 是同一认知存在的**两个面**：

- **同义视角**：宁静号 session 与 trajectory 指同一个持续存在的认知实体
- **载体视角**：`SESSION.md` 是轨迹的**持久身体**（原位不动）；工作会话（dsh conversation）是轨迹的**可重建运行副本**——可丢弃、可重建（Ship of Theseus：木板可换，船仍是同一艘）

```
Trajectory（主体，跨越时间的存在）
    ↑ 由某个 Agent 推动
Session（载体，可重建——轨迹此刻的承载实例）
LLM / Runtime / Tools（认知介质，可替换）
```

- **Agent 是可替换的，Trajectory 才是连续的**——LLM 是认知介质不是大脑；agent 是过程中的角色
- **认知闭环**：人类介入 = trajectory 的反馈输入之一（与 tool 调用同质）——在轨迹主体 + 相对时间视角下，宁静号已实现**人类-LLM 协作闭环**

## 5. 工程化落地（预测加工展望）

理论为工程提供了方向性约束（非强制机制）：

- **持久身体优先**：任何多步工作的进度/决策/理由必须落回 SESSION.md（轨迹身体），而非只存在于临时会话
- **载体可重建纪律**：上下文超限时重建载体（session_rebuild），轨迹从 SESSION.md 接续——重建是常态而非事故
- **反馈显式化**：工具结果、用户输入、系统事件都是 Loop 的反馈，应被记录与利用，而非当作"外部干扰"

## 6. 标准与术语

| 术语 | 定义 |
|------|------|
| 认知容器 | 认知发生、存储、再发生的地方 |
| 认知 Loop | 动作-反馈循环；动作与反馈同质 |
| 轨迹（trajectory） | 跨越时间的认知主体；持久身体 = SESSION.md |
| 会话（session） | 轨迹的可重建载体（运行副本） |
| 认知介质 | LLM / 运行时 / 工具（可替换） |

完整术语表与理论不变量（I6 轨迹主体等）见 [serenity-acc-specs](https://github.com/tellmewhattodo/serenity-acc-specs) §1-§2。
