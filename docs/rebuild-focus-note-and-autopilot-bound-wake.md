# 两项修正方案：rebuild 焦点传递 + autopilot 绑定会话唤起（v1.29.x 后续，S142 用户 2026-09-06 提出）

**状态**: v1.0 已实现（typecheck ✓ + 60 files / 879 tests 全绿 + build ✓；deploy/发版待 D14）
**日期**: 2026-09-06
**会话**: S142（dsh-serenity-plugin 长期维护）
**基线**: v1.29.1（60 files / 871 tests）→ 实现后 60 files / 879 tests（+8）

---

## 1. 需求（用户原话拆解）

> "下面做两个修正：
> 1. session rebuild 应当能够传递简短的文字，传递到重建后的会话，让重建后的会话理解当前的任务焦点（无需包含历史，历史已经完整的在 SESSION.md 中了）
> 2. autopilot-trajectory 的会话绑定应当更稳固，看下当前的实现，判断如何能加强（唤起的时候能唤起最新的，绑定 autopilot SESSION 的会话）"

| # | 需求（E↑ 转译） | 用户意图 |
|---|----------------|---------|
| R1 | session_rebuild 增加「任务焦点」短文本参数 → 传入重建后会话（锚点内），让重建后会话理解当前任务焦点；**不含历史**（历史在 SESSION.md） | 重建后模型立即知道"现在在做什么"，不必从 SESSION.md 庞杂历史中重新推断——降低重建后冷启动认知成本 |
| R2 | autopilot-trajectory 唤起时定位**绑定了 autopilot SESSION 的最新 dsh 会话**（而非仅靠标题猜测）——会话绑定应更稳固 | autopilot 目标 SESSION（`--auto` 目录，如 S151）经 `session use` 激活后，dsh 会话日志有 `serenity/bound` 事件；唤起应优先命中**绑定该目录的最新会话**，标题匹配只是回退 |

---

## 2. 现状（源码实证，read-before-write）

### R1 现状：rebuild 锚点已结构化，note 参数存在但被丢弃

- `src/tools/rebuild.ts`：工具参数已有 `note`（"Optional: one-sentence rebuild background note (for the rebuilt self)"）→ 传入 `queueRebuild`；参数描述**已暗示用途**（给重建后的自己）
- `src/rebuild.ts`：
  - `queueRebuild` L242 解构 `note`，**L271 `void note` 显式丢弃**——半成品接线（曾设计但未接入锚点）
  - `buildRebuildAnchor`（L82-108）当前输出固定五段：`[TRAJECTORY-ASSISTANT · REBUILD] 头` + first-anchor 协议正文 + `Continue the work of {S###}` + `- Serenity session:` + `- Persistent trajectory — SESSION.md path:` + `- Read that SESSION.md first...`
  - `PendingRebuild` 接口无 note 字段（只有 anchor/summary/mdPath/queuedAt）
  - `performRebuild` 直接用 `pending.anchor` 整段注入——只要把 note 编进 anchor 文本即可
- **结论**：R1 改动面小——`buildRebuildAnchor` 加 note 段 + queueRebuild 透传 + 工具 description 微调 + 测试。

### R2 现状：autopilot 目标 agent 靠「标题匹配 + cwd 归属」，未用 bound 事件

- `src/autopilot-trajectory.ts`：
  - `resolveTargetMd`（L98-104）：从配置 `cfg.session`（S###/目录名）→ AGENT_SESSIONS 找目标 SESSION.md（需 `--auto` 标志）
  - `resolveTargetAgent`（L399-426）：遍历 `sessions.list()` → cwd 归属校验（同 CCC）→ `readSessionTitle`（events 的 session/title latest-wins）→ 标题 `=== sid` 或 `startsWith(sid-)` 匹配 → `ctx.agents.get(s.id)` 取 agent
  - `performAutopilotWake`（L285）：`resolveTargetAgent` 不可得 → 报错 `diagnoseTargetUnavailable`（区分无 live/标题不匹配/agent 未加载）
- `src/session-bound.ts`（v1.29.1）：`serenity/bound` 事件已持久化——`readLastBound(session)` 返回最新绑定（dirName = 完整 AGENT_SESSIONS 目录名，**编码无关**）。`session use S151` 后，该 dsh 会话的 events 里有 `{action:'activate', dirName:'2026-09-0x--S151--autopilot...--auto', mdPath, sessionId:'S151'}`
- **gap**：`resolveTargetAgent` 完全不看 bound 事件——只按标题 `S143-...` 猜。若 autopilot 目标会话（目录 `...--S151--xxx--auto`）被 use 绑定到某个 live dsh 会话，但该会话标题恰好**不是** `S151-...` 开头（比如绑定后标题被 LLM 改过/rebuild 后重命名异常），则唤起失败——绑定明明在，却因标题不匹配而找不到。
- **加强方向**：唤起定位改为 **bound 优先**——目标 SESSION 目录名 → 在目标 CCC 的 live 会话中找 `readLastBound(session).dirName === 目标目录名` 的最新会话 → 命中即取 agent；标题匹配降级为回退（旧会话无 bound / 标题兼容）。

---

## 3. 方案（R1 + R2，代码级）

### R1：rebuild 锚点加「任务焦点」段

**改动**：

| 文件 | 改动 |
|------|------|
| `src/rebuild.ts` `buildRebuildAnchor` | 加第 6 参 `focus?: string \| null`——非空时在 `Continue the work of ...` 后插入段：`- Task focus: {focus}`（用户原语 focus；单行、不换行消毒） |
| `src/rebuild.ts` `PendingRebuild` | 加 `note?: string` 字段 |
| `src/rebuild.ts` `queueRebuild` | 去 `void note` → 透传 `note` 进 pending + buildRebuildAnchor |
| `src/tools/rebuild.ts` | `note` 参数 description 升级（"the rebuilt self's task focus — short, no history needed; SESSION.md has it"）；execute 传 note |
| `src/rebuild.ts` 头部注释 | 补 v1.30 语义 |

**锚点结构（改造后）**：
```
[TRAJECTORY-ASSISTANT · REBUILD] The conversation has been cleared and rebuilt ...
(协议正文...)
Continue the work of S142.
- Serenity session: S142 (...)
- Task focus: 完成 R1/R2 修正并发布 v1.30   ← 新增（仅当 note 非空）
- Persistent trajectory — SESSION.md path: ...
```

**注意**：note 是给重建后自己的**任务焦点**，不是历史——用户已明确"无需包含历史"。锚点已有 SESSION.md 路径，模型会去读；note 只是让它在读之前/读之后知道本轮焦点。单行化处理防注入多行伪造结构。

### R2：autopilot 唤起定位改 bound 优先

**目标定位函数重写**（`resolveTargetAgent` 内部加 bound 通道，保持对外签名不变）：

```
resolveTargetAgent(ctx, mdPath):
  dirName = basename(dirname(mdPath))          // 目标 autopilot SESSION 完整目录名（如 2026-09-05--S151--autopilot--auto）
  targetRoot = findSerenityRoot(mdPath)
  candidates = []
  for s in sessions.list():
    if !sameCcc(s, targetRoot): continue        // 归属校验保留
    bound = readLastBound(s)                    // v1.29.1 权威绑定
    title = readSessionTitle(s)
    if bound && bound.dirName === dirName:      // ① bound 精确匹配（稳固）
      candidates.push({ s, score: 3 })
    elif title 匹配 sid (===sid 或 startsWith(sid-)):  // ② 标题匹配（回退）
      candidates.push({ s, score: 2 })
    elif bound && bound.sessionId === sid:      // ③ bound 派生码匹配（目录改名场景？不——编码无关；保守不加）
      ...                                        // （不加——dirName 才是硬身份）
  # 多候选 → 取最新（mtime / 最后活动）；agent 可取则返回
```

**为什么 score/bound 优先**：
- bound.dirName 是**磁盘唯一硬身份**（编码无关 U4），标题可能被 LLM 改/重建后 rename 成别的 → bound 才是"绑定 autopilot SESSION 的会话"的权威证据
- 标题匹配保留为回退（**存量会话**在 v1.29.1 前没有 bound 事件；reconcile 会在 use 时自动补 bound，但未 use 过的旧 live 会话仍只有标题）
- 多命中 → 取最新活动（用户"唤起最新的，绑定 autopilot SESSION 的会话"——同一 SESSION 被多个 live 会话绑定时（罕见），取最新）

**改动文件**：

| 文件 | 改动 |
|------|------|
| `src/autopilot-trajectory.ts` | `resolveTargetAgent` bound 优先 + 多候选取最新；`diagnoseTargetUnavailable` 同步（bound 存在但 agent 未加载也提示）；import `readLastBound` |
| 测试 `tests/autopilot-trajectory.test.ts` | mock sessions 形状加 `events` 含 `serenity/bound` 的用例：bound.dirName 匹配命中（即使标题不匹配）/ bound 不匹配但标题匹配回退 / 多候选取最新 / bound 命中但 agent 未加载诊断 |

**测试 mock 注意**：现有 mock `events` 数组直接是事件对象数组（`{type:'session/title',...}`）——`sessionEvents` helper 读 `.events`（兜底形态）能工作；bound 事件直接加进 mock events 数组即可（`{type:'serenity/bound', data:{dirName, mdPath, ...}}`）。需确认 `readLastBound` 用 `sessionEvents` 兼容 mock 的 `.events` 数组形态（v1.28.1 sessionEvents helper snapshotEvents 优先 + events 兜底——mock 无 snapshotEvents → 走 events 兜底 ✓）。

---

## 4. 测试矩阵

| # | 场景 | 断言 |
|---|------|------|
| R1-1 | queueRebuild 带 note → anchor 含 `- Task focus: ...` | anchor 文本包含 focus 行 |
| R1-2 | queueRebuild 无 note → anchor 无 focus 行（向后兼容） | anchor 不含 `Task focus` |
| R1-3 | note 含换行/多行 → 消毒单行（防结构注入） | 锚点只一行 focus |
| R1-4 | 工具 description 含 note 语义（可选） | — |
| R2-1 | live 会话 events 含 `serenity/bound` dirName=目标目录 → 命中 agent（即使标题不匹配） | steer 注入成功 |
| R2-2 | 无 bound + 标题 `S151-...` 匹配 → 回退标题命中（存量兼容） | steer 注入成功 |
| R2-3 | bound 匹配多会话 → 取最新（最后 bound.at / sessions 序） | 选最新 agent |
| R2-4 | bound 命中但 agent 未加载 → 诊断提示 | detail 含引导 |
| R2-5 | 无 bound 无标题匹配 → 原拒绝路径 | detail 不变 |
| R2-6 | 其他 CCC 会话 bound 不匹配（归属校验） | 拒绝 |

---

## 5. 待拍板（用户确认）

1. **R1 note 参数名/语义**：保留现参数名 `note` 还是改 `focus`？（现 description 已写 "rebuild background note"——语义升级为 task focus 即可，参数名可留 note 向后兼容 LLM 已学会的调用；工具是 LLM 调用的，改名要同步 description。倾向：**保留 note 名，description 升级为 task-focus 语义**）
2. **R1 note 长度上限**：建议 ≤200 字（短焦点非历史）；超长截断或报错？（倾向：**200 字截断**，不报错——LLM 参数宽松处理）
3. **R2 多候选「最新」判据**：取 `readLastBound(session).at` 最大（权威绑定时间）？还是 dsh 会话 lastActive？（倾向：**bound.at 最大**——绑定最新 = 用户最近 use 过 = 最可能当前在用的会话；无 bound 的标题候选排后）
4. 版本号：两个修正合并一个版本（v1.30.0 或 v1.29.2？用户"版本号不要跑太快"（D14）→ 倾向 **v1.29.2** patch 级）

---

## 6. 实施顺序

1. R1（改动小、独立）：rebuild.ts + tools/rebuild.ts + 测试 → typecheck/test
2. R2（核心）：autopilot-trajectory.ts resolveTargetAgent/diagnose + 测试
3. 全量 test + typecheck 双面 + build
4. 用户验证 → CHANGELOG/bump（D14 显式发版）

---

## 7. 不做（边界）

- 不做 rebuild note 的历史快照/自动摘要（用户明确不需要历史）
- 不做 autopilot 自动切换/创建绑定（唤起仍要求目标 live；绑定由 session use 建立）
- 不改标题匹配兼容路径（存量无 bound 会话继续工作）
