# SESSION 绑定坚固化：调研与方案（session binding hardening）

> SESSION: S142（2026-09-05）
> 状态：调研完成 + 方案待拍板
> 目标：让「dsh 会话（载体）↔ SESSION（宁静号轨迹）」的绑定更坚固——避免 LLM 在过程中或 session_rebuild 后因智力因素（幻觉/理解偏差）自行更换 SESSION。

---

## 1. 用户需求（原话转述）

「希望会话和 SESSION 的绑定可以更坚固，避免 LLM 在过程中或者在 session_rebuild 后因为智力因素自行更换 SESSION。」 + 「我在想如果能持久化的确会可靠些。」

## 2. 当前绑定机制（源码实证）

| 层 | 机制 | 位置 |
|----|------|------|
| **激活** | `session use S142`（LLM 主动调用）→ 写**内存 Map**（key=scope=dsh 会话 id）→ dsh 会话重命名 S142 标题 → events 注入 `[SESSION CONTEXT]` 文本标记 | `session-ops.ts` useSession / `tools/session.ts` use 分支 |
| **每轮** | 系统提示词 Session 块注入 active sessionId/dirName/mdPath + 载体语义 + todowrite 首位约定 | `system-prompt.ts` sessionBlock |
| **rebuild** | 锚点带 `Serenity session: S142 (dir)` + `SESSION.md path: <rel>` | `rebuild.ts` buildRebuildAnchor |
| **重启恢复** | events **尾到头**扫 `SESSION.md path:` 文本 → 绝对化 + existsSync → 恢复内存 active | `context.ts` seed + `session-ops.ts` parseSessionContextFromEvents |
| **兜底** | 全缺 → findLatestActiveSessionMd（最新未完成） | `session-ops.ts` |

**本质**：绑定 = **内存 Map**（易失）+ events 里**文本标记**（被动解析）。无落盘的权威绑定记录。

## 3. 漂移风险点（LLM 如何换 SESSION）

- **R1（主）**：`session use` 无任何一致性守卫——LLM 幻觉/误判随时可 use 别的 S### → 内存立即切换 + 标题重命名 + events 尾部污染。机械层零防线。
- **R2**：rebuild 锚点记录调用时刻 active；若此前被误 use 污染，锚点即错。
- **R3**：`create` 成功后自动切换绑定（v1.25.11）——长会话中途误 create 即夺绑定。
- **R4**：Session 块是建议性非锁定性。
- **R5**：无"绑定一致性自检"（标题 S142 vs active 实际 S143 无警报）。

## 4. DSH 是否提供额外绑定存储？（用户关切——决定性调研）

**结论：提供。** 实证（dsh-harness-public `packages/core/session` + `compaction/compaction`）：

1. **`SessionEventMap` 是 merge-extensible**：任何插件可 `declare module '@deepseek-ai/dsh-session/types'` 添加自定义会话事件类型。官方先例：compaction 包加了 `compaction/start|summary|end|prune` 四个事件；dsp 自己的 `rebuild.ts` 已在 append `compaction/prune` + `user/message`。
2. **`Session.append(type, data)` 接受任意已声明类型** → 事件进入**会话 append-only 日志**，随 session.jsonl **持久化落盘**，进程重启后 `snapshotEvents()` 可完整读取。事件日志 = 会话的持久真相源（"Model-visible ⟺ logged"：一切模型可见输入均从日志重建）。
3. **`ignorable` 标记**：未知/插件事件带 `ignorable: true` 时，不认识该事件的 read path 不拒绝——插件自定义事件的安全信封。
4. **`SessionHeader` 封闭**（version/id/createdAt/cwd/parentSession/isSeeded/origin/delegationDepth/agentPreset——严格校验、不可扩展）→ **不能**塞自定义绑定字段；但事件日志是等价甚至更优的持久化面（append-only、可审计、与消息历史同源同序）。

**启示**：绑定可从「内存 Map + 文本标记」升级为「**持久化绑定事件**」——use/rebuild/create 时 append 一条 `serenity/bound` 事件（含 SESSION id + dirName + mdPath + 时间戳 + 绑定方），权威绑定**随会话日志落盘**。重启/rebuild 从日志读权威绑定，不再靠扫文本猜。

## 5. 加固方案（分层，可组合）

### 方案 A：`session use` 切换守卫（软/硬）
use 目标 ≠ 当前 active 时：
- **软守卫**：返回警告「当前已绑定 S142（标题 S142-…），你正要 use S143——确认是任务切换吗？」仍放行（需模型确认重呼）
- **硬守卫**：拒绝 + 需显式 `--force`（用户裁决要真正切换时才可）
- 机制：execute 内 `getActiveSessionInfo(scope)` vs `findSession(...)` 比较，工具层即可做，零 DSH 改动

### 方案 B：持久化绑定事件（核心——回答用户"持久化可靠"）
- 新自定义事件 `serenity/bound`（declare module 扩展 SessionEventMap，`ignorable: true`）：
  ```ts
  'serenity/bound': {
    sessionId: string      // S142
    dirName: string        // 完整目录名
    mdPath: string         // SESSION.md 绝对路径
    scope: string          // dsh 会话 id
    action: 'activate' | 'rebuild' | 'create' | 'switch'
    at: number             // epoch ms
  }
  ```
- **写入点**：`use` 成功 / `create` 成功 / `rebuild` 排队（锚点）时 append
- **读取恢复**：context.ts seed 从 `snapshotEvents()` 过滤 `serenity/bound` 取**最后一条**（权威绑定）→ 直接恢复——替代现在"扫任意文本里的 SESSION.md path"（脆弱：可能命中用户消息里的历史路径）
- **审计**：每次 switch 都有事件记录（何时、为何 action），可排查 LLM 误切
- 与现有 `[SESSION CONTEXT]` 文本标记兼容（bound 事件是权威源，文本标记退为展示）

### 方案 C：rebuild 锚点绑定优先
buildRebuildAnchor 的 sessionName/mdPath 来源改为「日志中最后一条 `serenity/bound`」而非调用时内存值——防"误 use 已污染内存，rebuild 锚点跟着错"。（与 B 同源，B 落地后 C 自然成立）

### 方案 D：绑定一致性自检（标题 vs active 比对）
每轮或 use 时校验「dsh 会话标题前缀 S###」vs「active SESSION id」：不一致 → 告警/自动纠正回标题对应 SESSION（标题是 rebuild 后 rename 的产物，更不易被模型改）。

## 6. 决策点（待拍板）

1. **use 守卫形态**：软守卫（警告仍放行）/ 硬守卫（拒绝需 --force）/ 不做守卫只做记录？——考虑 S142 维护 + S151 autopilot 并行场景
2. **持久化事件 B 是否采纳**（我的推荐：是——直接回答你的可靠性关切，且 DSH 原生支持零侵入）
3. **create 是否纳入**：create 成功后是否还自动切换绑定？（或保留当前绑定，create 只是新建不夺位）
4. **加固范围**：是否含 autopilot（S151）/微信桥（zhaocai 固定会话）——它们各自固定 SESSION，是否禁止被主会话 use 干扰
5. 是否顺带把恢复逻辑从「扫文本」全面切到「读 bound 事件」（旧会话无 bound 事件时回退现有文本扫描）

## 7. 风险与边界

- 零改 DSH（全插件侧：declare module + append + 读取过滤）
- 旧会话（无 serenity/bound 事件）兼容：读取时 bound 缺失 → 回退现有 parseSessionContextFromEvents
- rebuild 语义不变（Ship of Theseus 载体丢弃轨迹接续）——bound 事件随旧 dsh 会话日志存续，rebuild 后同一会话 id 日志保留 → 权威绑定仍在
- 测试面：新事件声明 + 写入点 + 恢复读取 + 守卫（纯逻辑可单测）
