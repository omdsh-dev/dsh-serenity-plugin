# Autopilot Trajectory（自动巡航轨迹）— 正式版设计 v0.1

> 状态：**设计 v0.1（2026-09-01，用户拍板记录；晚上开工实现）** — 由实验功能 autotrajectory 晋升为正式能力。
> 前置：`docs/self-sustaining-trajectory-hypothesis.md`（specs 仓 v0.1 猜想）、`docs/autotrajectory-experiment.md`（实验参与定义）。
> 需求来源：用户 "auto-trajectory被证明很有价值，要推开；autotrajectory这个命名不行；重新讨论下设计和优化方向"。

---

## 1. 拍板结论（2026-09-01）

| # | 决策 | 内容 |
|---|------|------|
| N1 | **命名定案：Autopilot Trajectory**（自动巡航轨迹） | "autotrajectory" 是技术代号——"auto" 弱前缀 + "trajectory" 内部术语；Autopilot 契合宁静号 Ship 隐喻（设定目标→自主巡航→驾驶舱可见→人类可接管），加 Trajectory 明确对象 |
| N2 | **正式版首轮范围 = A 层**（可靠性 + 多 CCC 独立） | 不做质量反馈环（B 层后置） |
| N3 | **不做告警联动** | "没那么正式"——微信桥告警闭环后置 |
| N4 | **独立版本轮**（不与 1.27.3 微信桥混） | 1.27.3（语音/typing/媒体）验证发布后，Autopilot 正式化独立一轮 |
| N5 | **成熟度分级锚定演进** | L1 时钟唤起 ✅ → L2 焦点+偏见 ✅ → **L3 质量反馈环 ⬜（下一轮）** → L4 跨轨迹编排 ⬜ → L5 完全自主（specs 猜想）⬜ |

## 2. A 层范围（本轮实现）

### 2.1 多 CCC 各自独立唤起（用户："4个CCC能各自有autotrajectory吗"）
- 现状：`resolveAutoTrajectoryCcc` 单目标（enabled[0]）——配置独立但运行时只唤起 1 个 CCC
- 改：`collectAutoTrajectoryCccs`（所有 live+enabled）→ tick 遍历各 CCC 各自 `shouldWake` + 各自唤起
- `running` 守卫 **per-CCC**；**全局串行化**（同 tick 多 CCC 到点 → 依次唤起，防模型并发挤兑）
- 面板 GET/POST 显式 `root` 参数（复用微信桥 `requireCcc` 模式；CCC 选择器已有）
- 各 CCC 的 interval/session/biasProvider/topPrompt/窗口本就独立——**配置层零改动**

### 2.2 可靠性层（实验版最缺）
1. **唤起失败退避重试**：agent 不可得 / 模型限流 / 偏见脚本失败 → 指数退避重试，不静默丢轮
2. **唤起审计日志**：每轮唤起记录（时间/CCC/结果/注入内容摘要/产出）→ 可回看、可分析
3. **轮次预算**：interval 下限 + 每日轮次上限（防失控 + 控成本）
4. **偏见脚本沙箱**：执行超时 + 输出大小上限（现在是裸 exec）

## 3. 不做（明确边界）

- 质量反馈环（L3，下一轮）——唤起后评估是否推进轨迹、自适应频率/方向
- 告警联动（微信桥推送）——"没那么正式"
- 全局仪表盘（C 层）——面板逐 CCC 状态先用
- 偏见来源升级（轨迹历史分析偏见）——B 层

## 4. 命名迁移方向（晚上实现时细化）

| 现名 | 目标 | 注意 |
|------|------|------|
| 机制名 autotrajectory | **Autopilot Trajectory** | 全链路（代码/文档/面板/工具） |
| 配置键 `.opencode/serenity.json autotrajectory` 段 | `autopilotTrajectory`（或兼容双读） | **pangu-serenity 已配置实验**——迁移需兼容旧键或一次性迁移 |
| 工具 `autotrajectory-exp`（第 13 工具） | 新名（实验工具升级为正式工具） | 实验包随 npm 分发过——向后兼容 |
| 会话标志 `--auto` 目录后缀 | 评估保留/改名（`--auto` 简短，可能保留） | S060--auto 已有历史会话 |
| specs 仓 `self-sustaining-trajectory-hypothesis.md` | 命名同步 | 理论文档跨仓一致 |
| 面板「自主轨迹」区块 | 「Autopilot Trajectory」 | client SettingsSection |

## 5. 实施顺序（晚上开工，Neat 小步）

1. 命名迁移（代码内概念 + 面板文案 + 配置键兼容）→ 测试
2. 多 CCC 独立（collect + per-CCC running + 串行化 + 面板 root 参数）→ 测试
3. 可靠性（退避重试 / 审计日志 / 轮次预算 / 脚本沙箱）→ 测试
4. CHANGELOG + bump（独立版本，1.27.4 或按节奏）→ publish → 双推 → deploy → 用户验证
