# 宁静号隐喻域（Metaphor Domain）— 顶层结构定义

> 版本：v1.19.9 + v1.29 星舰意象（S142，2026-08-24 / 2026-09-05）
> 状态：协议级结构 —— 插件注入 `=== Serenity Metaphor ===` 块的权威说明 + CCC 隐喻改造的模板

## 1. 定位

隐喻不是修辞装饰，而是**约束体系的同构映射**（isomorphism）：

- 每个隐喻故事 ↔ 一个协议约束或机制（一一对应）
- 隐喻之间的关系（层级/时序）反映约束/机制之间的关系
- 顶层隐喻域（本文档）= ACC 注入层的抽象结构（EAP 蓝图），**任何 CCC 抽象层都是宁静号/ACC，隐喻域统一**

> **v1.29 星舰意象升级（2026-09-05 用户拍板）**：世界设定从海船（one ship, one sea）升级为**星舰**（one starship, one voyage）——sea→deep space / set sail→launch / anchor→docking clamp / charts→star charts / afloat→flight-worthy / stones on deck→debris in the hold / Harbor Inspection→Departure Inspection。**三层骨架 + 10 条隐喻 + 约束映射 + M-1~M-4 全部不变**（Ship of Theseus 保留——忒修斯之舰跨意象成立）。

## 2. 三层骨架

```
世界层  The World — one starship, one voyage（宇宙设定：容器=星舰，认知=航程）
  ├─ 主体层 THE SHIP（容器本体）
  │    ├─ 1. The Hull            → Bounded Space（CCE 2）
  │    ├─ 2. Deck Order          → Entropy / H_op（CCE 3）
  │    ├─ 3. Engineering Drawings → EAP（E↑ R↓ S↑）
  │    ├─ 4. The Machinery       → MSM（Mech & Semi-Mech 确定性分层）★v1.19.9
  │    └─ 5. The Manifest        → Single Source of Truth（mech-registry，DC-7）★v1.19.9
  ├─ 运行层 THE VOYAGE（认知生命周期，时序：启航→记录→延续）
  │    ├─ 6. Departure Inspection → First Anchor（启动锚定）★v1.29 改名
  │    ├─ 7. The Logbook         → Session Tracking（持续记录）
  │    └─ 8. The Ship of Theseus → Continuity（CCE 1，跨时间身份）
  └─ 协作层 THE CREW（多 agent）
       ├─ 9. Crew Rotation       → Multi-Agent Cognition（CCE 5）
       └─ 10. Blueprint over Statue → Reconstruction > Preservation（CCE 4）
```

## 3. 三种显式关系

| 关系 | 定义 | 实例 |
|------|------|------|
| **部分-整体**（containment） | 上层宇宙包含下层实体 | World ⊃ Ship ⊃ {Hull, Deck, Drawings, Machinery, Manifest}；Voyage ⊃ {Inspection, Logbook, Theseus}；Crew ⊃ {Rotation, Blueprint} |
| **映射**（mapping） | 隐喻 ↔ 协议约束/机制一一对应 | Hull ↔ Bounded Space；Deck Order ↔ Entropy；Drawings ↔ EAP；Machinery ↔ MSM；Manifest ↔ Single Source of Truth；Departure Inspection ↔ First Anchor；Logbook ↔ Session；Theseus ↔ Continuity；Rotation ↔ Multi-Agent；Blueprint ↔ Reconstruction |
| **时序**（sequence） | 运行层内认知生命周期的先后 | Departure Inspection（启航检查）→ Logbook（航行中持续记录）→ Theseus（跨时间身份不变量）→ 船员交接（轮换） |

## 4. 结构约束（M-1 ~ M-4）— CCC 隐喻改造模板

任何隐喻改造（未来 CCC 层若做隐喻化表达）必须满足：

| # | 约束 | 判据 |
|---|------|------|
| **M-1** | 每条隐喻必须映射一个协议约束或机制 | 无映射的隐喻 = 修辞装饰 = 不允许（v1.19.9：扩展至 MSM 等机制） |
| **M-2** | 每条隐喻必须带 Verdict 行为判据 | 隐喻是行为编码器，不是文学；判据 = 什么算违反 |
| **M-3** | 隐喻必须落位单一层级（SHIP/VOYAGE/CREW） | 层间关系显式（containment/sequence） |
| **M-4** | 隐喻域必须单一（one starship, one voyage） | CCC 改造可选自己的宇宙（如灯塔/花园/城市），但结构保持：世界设定 + 主体 + 生命周期 + 协作 |

## 5. 变更历史

- v1.29（2026-09-05，S142）：**星舰意象升级**（用户拍板）——one ship, one sea → one starship, one voyage；sea→deep space / set sail→launch / charts→star charts / afloat→flight-worthy / stones on deck→debris in the hold；Harbor Inspection → Departure Inspection。三层骨架 + 映射 + M-1~M-4 不变
- v1.19.9（2026-08-24）：+2 条 MSM 隐喻（The Machinery → MSM / The Manifest → Single Source of Truth），重编号 1-10；M-1 映射对象扩展至机制；MSM 原则入 Principles 块
- v1.19.8（2026-08-24）：Metaphor 提前（世界模型前置）；World 层呼应句（The Sea has no mistakes）
- v1.19.7（2026-08-24）：三层结构化 + 映射标注（方案 B）——本文档同步
- v1.19.6（2026-08-24）：初版注入块（8 条并列，无结构）——用户设计
