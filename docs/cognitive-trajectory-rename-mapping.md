# 改名映射规范（唯一真相源 · 供并行 worker 共用）

> 本文件是 `trajectory` → `cognitive trajectory` 机械改名的**唯一定义**。
> **所有 worker 必须逐字照此执行**；任何"我觉得应该这样"的偏离都算错误。

## 0. 适用范围

- **目标目录**：`AI_LAB/dsh-serenity-plugin/hooks/dsh-serenity-hooks/{src,tests}`
- **禁止触碰**：`CHANGELOG.md`、`docs/_archive/**`、`node_modules/**`、`lib/**`（构建产物）
- **禁止触碰宿主概念**：`conversation.trajectory.*`、`dsh-client-ui-trajectory`（那是 DSH 的概念，不是我们的）

## 1. 规则（**按顺序执行，顺序有意义**）

### R1 — 工具名（全字面）

```
container_trajectory  →  cognitive_trajectory
```
⚠️ 已在部分文件手工改过 ⇒ 若已无 `container_trajectory` 则跳过，**不得改成 `cognitive_cognitive_trajectory`**。

### R2 — 文件名 / 模块路径（连字符形）

```
trajectory-bound.ts    →  cognitive-trajectory-bound.ts
trajectory-ops.ts      →  cognitive-trajectory-ops.ts
trajectory-skills.ts   →  cognitive-trajectory-skills.ts
trajectory-assistant.ts→  cognitive-trajectory-assistant.ts
tools/trajectory.ts    →  tools/cognitive-trajectory.ts
```
⇒ **所有 import/引用同步改**：`'../trajectory-bound.js'` → `'../cognitive-trajectory-bound.js'`

### R3 — PascalCase 类型/组件

```
Trajectory     →  CognitiveTrajectory
```
例：`SkiffTrajectorySubset` → `SkiffCognitiveTrajectorySubset`；
`createTrajectoryTool` → `createCognitiveTrajectoryTool`；
`TrajectoryStyle` / `TrajectoryAction` 同理。

### R4 — camelCase / snake 标识符

```
trajectory       →  cognitiveTrajectory
```
例：`resolveSessionTrajectoryLabel` → `resolveSessionCognitiveTrajectoryLabel`；
`trajectorySubset` → `cognitiveTrajectorySubset`；
`trajectoryLabel` → `cognitiveTrajectoryLabel`；
`readTrajectorySkills` → `readCognitiveTrajectorySkills`；
`registerTrajectorySkillSection` → `registerCognitiveTrajectorySkillSection`；
`trajectory.skills` → `cognitiveTrajectory.skills`（配置键，已在 ccc.ts 手工改）。

### R5 — 英文散文（注释／提示词／injected 文本）

```
单数：the trajectory        →  the cognitive trajectory
复数：trajectories          →  cognitive trajectories
      a trajectory          →  a cognitive trajectory
连用：session-trajectory    →  session–cognitive-trajectory（保持语义，可读优先）
```
🔴 **散文里绝不写 camelCase** —— `cognitiveTrajectory` 只出现在代码标识符里。

## 2. 🔴 绝对禁止的改写

| 情形 | 处置 |
|---|---|
| `autopilotTrajectory` / `autotrajectory` / `AutopilotTrajectorySettings` | **只删不改** —— 已被 owner 令整体退役，若仍存在请报告，**不要改名为 cognitive*** |
| `conversation.trajectory.*` | **不动**（宿主槽名） |
| 历史叙述句「v1.34 前工具名 `trajectory`」 | **不动** —— 那是历史事实 |
| `CHANGELOG.md` / `docs/_archive/**` | **不动** |
| `TRAJECTORY-ASSISTANT` | 改成 `COGNITIVE-TRAJECTORY-ASSISTANT`（**两端同批**；ACK 串 `[COGNITIVE-TRAJECTORY-ASSISTANT-recorded-{code}]`） |

## 3. 判据（改完自检，逐条）

1. **无残留**：`grep -c 'container_trajectory'` = 0
2. **无重复前缀**：`grep 'cognitive_cognitive\|CognitiveCognitive'` = 0
3. **散文不 camelCase**：注释里不出现 `the cognitiveTrajectory`
4. **import 不断链**：每个 `from '...cognitive-trajectory-*.js'` 都能对应到一个真文件
5. **不许出现半截词**：`cognitiveTrajectory-bound`（错）/ `trajectory-cognitive`（错）

## 4. 交付格式（worker 回执必须包含）

```
文件: <绝对或仓内相对路径>
改动处: <n>
遗留问题: <若有，逐条列出；没有就写"无">
```
⚠️ **不许声称"已完成"而不给清单**。主 agent 会用 `typecheck` 与 grep 复核。
