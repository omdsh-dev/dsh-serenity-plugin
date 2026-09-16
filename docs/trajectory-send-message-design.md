# 设计：`container_trajectory send-message` —— 即时投递（real-time delivery）

> **状态**：**设计稿（v0.1），未动一行实现代码**。等所有者裁决下方 §7 的三个决策点后再进入接口层/实现层。
> **来源**：所有者原话（2026-09-16 S142）：「trajectory 除了 wake later，**还要支持一个 send message 用于实时使用提示词注入来回应**，如果会话不活跃，则**等效于直接 wake**。设计下」
> **作者**：S142（ACC 维护轨迹）

---

## 1. 需求层（原话 → 显式化）

| # | 原话片段 | 我的读法（可证伪，见 §7-Q1） |
|---|---|---|
| 1 | 「还要支持一个 send message」 | 在 **`container_trajectory`** 上加**第 7 个动作** `send-message`（不新开工具——轨迹概念下已有 6 动作，见 §2.3） |
| 2 | 「**实时**使用提示词注入」 | **投递机制** = 提示词注入（`agent.followup(createUserMessage(...))`，与唤醒同一原语）；**实时** = 调用即投，**不等**调度器的 5min tick |
| 3 | 「来**回应**」 | ⚠️ **有歧义**：① 让目标**能够**实时行动（单向投递）② 发送方要拿到目标的**答复**（请求-响应）。**本稿按 ① 设计，②列为显式未决**（§7-Q1） |
| 4 | 「如果会话**不活跃**，则**等效于直接 wake**」 | 目标非 live ⇒ 走**与唤醒同一条**冷载入通路（`sessionController.resolveAgent`），效果等同于对它的直接唤醒 |

### 1.1 与既有裁决的关系（重要）

- 🔴 **本需求正好解决 §12.B 登记的那条悬案**。§12.B 曾提：「给 `wake-later` 加**投递后的轻量确认**」——当时标注「⚠️ 触及 D58 的 fire-and-forget 定案 ⇒ 须所有者裁」。
  **本稿的处置 = 加一条独立原语，而不是给 wake 打补丁**：
  | | `wake-later`（现有） | `send-message`（新） |
  |---|---|---|
  | 时刻 | **未来**（`addWake` 硬拒 `at ≤ now`） | **现在** |
  | 语义 | 预约（fire-and-forget） | 投递（**同步回执**） |
  | 回执 | **无**（D58 明示接受） | **有**（这是本原语存在的理由） |
  ⇒ **D58 一个字不改**：预约仍然"无回执、不可回收、无面板"；需要回执的人改用 `send-message`。**两条路各自语义干净**，比"给 wake 加回执"更好（后者会让同一个动作有两种语义）。
- **D60（唤醒不设资格栅）**：本稿**沿用**，但**新增风险**见 §5.2（即时投递会**立刻起轮**，而预约至少还有"未来"这层缓冲）。

---

## 2. 范围层

### 2.1 做

1. `container_trajectory` 新增动作 **`send-message`**，参数 `target` + `message`，**同步返回回执**。
2. 复用既有取用通路：**live 优先 → 冷载入**（与调度器**同一实现**，不复制）。
3. 冷路径**即时化**：不走 5min tick（否则"实时"对最需要它的场景失效）。

### 2.2 不做（显式）

- ❌ **不改 `wake-later` 的任何行为**（v1.35.0 硬约束①「`wake-later` 链路**一行为不动**」仍然有效）。
- ❌ **不改 `addWake` 的"时刻必须在未来"不变量**（见 §3.3 的 (c)，理由 = 它正是"预约"与"投递"的语义分界）。
- ❌ **不做请求-响应**（默认；§7-Q1 若裁"要回执答复"则另立设计）。
- ❌ **不打断目标正在跑的轮次**（沿用既有性质，见 §4.3）。
- ❌ **不做面板**（`send-message` 是调用即返回的同步动作，没有"待办"需要面板；面板仍属 `wake-later` 的注册表）。

### 2.3 为什么挂在 `container_trajectory` 而不是新工具

- 「**一条轨迹**」的语义里，**"给它递一句话"**与 `wake-later`（"给它约一个未来时刻"）是同一族——都是**跨轨迹的单向消息投递**，只是**时刻**不同（现在 vs 未来）。⇒ 同一工具、并列动作，用户心智一致。
- 工具面已刻意收敛（13→10→11，D46），**不新增工具**符合既定方向。
- 两者**共享全部取用逻辑**（`resolveWakeTarget` + `acquireWakeAgent`）⇒ 分家会制造第二份"怎么找到目标 agent"的真相。

---

## 3. 方案层（机制）

### 3.1 🔴 取证：为什么"等效于 wake"**不能**靠塞一条 `at=now` 的注册表条目

回代码取证（`wake-registry.ts:176-178`）：

```js
const parsed = parseWakeAt(input.at, input.nowMs)
if (!parsed.ok) return { ok: false, error: parsed.error }
if (parsed.ms <= input.nowMs) return { ok: false, error: '时刻必须在未来（唤醒只允许可预期的未来）' }
```

⇒ **`addWake` 显式拒绝过去/现在**。这条不变量是**有意**的（D58：唤醒 =「可预期的未来时刻」+ 一条 message）。**结论：即时投递必须走另一条通路。**

### 3.2 选定的形态（推荐）

```
send-message(target, message)
  │
  ├─ ① 定位目标     resolveWakeTarget(root, target)      ← 复用（S### / 目录名 → dirName + SESSION.md）
  │      未命中 ⇒ 回执 ok:false（不静默）
  │
  ├─ ② 取用 agent   acquireWakeAgent(ctx, root, dirName) ← 复用（与调度器同一实现）
  │      ├─ live     → { agent, how: "live(bound <id>)" }
  │      └─ 非 live   → sessionController.resolveAgent(id) → { agent, how: "cold-resume(<id>)" }
  │            （即"等效于直接 wake"：**同一条冷载入通路**，只是**不等 tick**）
  │
  ├─ ③ 投递         agent.followup(createUserMessage({ text: buildSendText(...) }))
  │
  └─ ④ 同步回执     { ok, output: "✓ 已即时投递 …（how / 耗时）" }
```

**逐条理由（R↓）**

| 决策 | 选择 | 理由 / 被否方案 |
|---|---|---|
| 取用通路 | **复用 `acquireWakeAgent`** | 它是"怎么找到目标 agent"的**唯一实现**（live 优先 → 冷载入 → 报错原因）。复制一份 = 第二真相源，且冷热判定会漂 |
| 冷路径 | **内联调用**（不等 tick） | 见 §3.3 |
| 注入原语 | `followup(createUserMessage(...))` | 与 `deliverWake` 同一原语（`wake-scheduler.ts:208`），宿主契约已知、无新依赖 |
| 回执时机 | **`followup` 入队后即返回** | 与 `deliverWake` 一致：`followup` 是"入队 + 唤起驱动"。**不等模型产出**（那是请求-响应，见 §7-Q1） |
| 消息文本 | **新写 `buildSendText()`**，不复用 `buildWakeText()` | 唤醒文本以「**到点**（登记于…）」开头，对即时投递是**错的事实**。新文本需含：谁发的、这是**即时消息**（不是到点）、身份锚定、任务 |

### 3.3 冷路径的三个候选（**这是本设计唯一真正的技术选择**）

| 方案 | 做法 | 实时性 | 代价 | 裁定 |
|---|---|---|---|---|
| **(a) 内联冷载入** ★ | 直接在 `send-message` 里 `await resolveAgent(id)` → `followup` | **无 tick 延迟**；冷载入本身 ~秒级 | 调用方**阻塞**到"载入完成"（有界）；`send-message` 需能 `await`（工具处理函数是 async，**可行**） | ✅ **推荐** |
| (b) 注册表 `at = now + ε`（如 +1m） | 复用 `addWake`（ε 满足"未来"） | ❌ **最坏 ~5min**（tick 粒度）⇒ 对"实时"是**失效**的 | 最小改动 | ❌ 否 |
| (c) 放宽 `addWake` 允许 `at ≤ now` | 改核心不变量 | 好 | 破坏"预约 vs 投递"的语义分界；**动到 v1.35.0 明文冻结的链路**；调度器还得加工"即时条目永不重试"的特例 | ❌ 否 |

> **诚实标注**：方案 (a) 的"实时"**不等于"立即执行"** —— 冷会话要先载入（§12.B 实测投递后 **6.2s~31s** 才真正起轮）；live 会话若**正在跑轮**，消息**排在轮次边界**（§12.B：会话在跑时**不打断当前轮**）。这两条**必须写进工具描述**，否则调用方会误以为"发出去就已经发生"。

---

## 4. 接口层

### 4.1 工具面变更（`tools/trajectory.ts`）

| 项 | 变更 |
|---|---|
| `TRAJECTORY_ACTIONS` | 6 → **7**（`trajectory-ops.ts:36/38`）：追加 `'send-message'` |
| `action` enum 描述 | 追加：`send-message (deliver ONE message to a trajectory RIGHT NOW — live: injected immediately; not live: cold-resumed like a direct wake; returns a synchronous delivery receipt)` |
| 新增参数 | `target`（复用现有定义，描述改为 `wake-later/send-message: target trajectory`）、`message`（同上）。**不新增 `at`**（send 没有时刻参数） |
| 工具 description | 由「Lifecycle + **one-shot scheduling**」扩为「Lifecycle + **message delivery**」：wake-later = 未来一次性；send-message = **即时** |

### 4.2 回执形态（**这是本原语的核心价值；必须把"承诺到哪一层"写死**）

```
✓ 已即时投递 → S151
  · 取用方式：live(bound session-db4c1b76…)   ← 或 cold-resume(session-…)
  · 耗时：42 ms（live）/ 3.1 s（cold-resume）
  · 语义：消息**已进入目标队列**；不打断其正在跑的轮次；**不表示**目标已执行或已答复。
```

**承诺边界（照抄 §12.B 的教训）**：§12.B 记的「🔴 `delivered` ≠ "跑了一轮"」同样适用于本原语：
- 回执**只到"入队成功"**（`followup` 未抛错），**不到"目标真的产出"**。
- ⇒ **判据纪律**：调用方若要确证"目标真的动了"，**必须用文件级判据**（如它自己的 SESSION.md），**不得凭回执结案**。

### 4.3 继承的既有性质（要写进描述，避免误期）

1. **不打断在跑轮次**：目标忙 ⇒ 消息在轮次边界生效（"到点了没反应"≠投递失败）。
2. **冷载入有延迟**：投递 → 起轮 ≈ 6~31s（§12.B 实测）。
3. **skiff 会话**：`skiff-*` 会话同样是 trajectory 的载体 ⇒ 技术上可投；**是否允许**见 §7-Q3。

### 4.4 失败与错误码（不静默）

| 情形 | 回执 |
|---|---|
| target 未命中（无此目录/SESSION.md） | `ok:false` + `目标 trajectory 未命中（<target>）` |
| 无绑定会话记录（从未被 `use` 激活） | `ok:false` + 既有文案（指向"需先 use 激活过"） |
| `sessionController` 不可用（headless profile） | `ok:false` + 既有文案（**不静默降级**） |
| 冷载入失败 / `followup` 抛错 | `ok:false` + 原因（含 `how`，便于归因） |
| `target` / `message` 为空 | 抛参数错误（与 `wake-later` 同款前置校验） |

---

## 5. 风险与护栏

### 5.1 复核「唤醒链路一行为不动」（v1.35.0 硬约束①）

- 唯一需要的改动 = **把 `acquireWakeAgent` 从模块私有改为 `export`**（`wake-scheduler.ts:152`），使 `trajectory.ts` 能复用。
- **这是"导出"，不是"改行为"**：函数体一字不动。**验证判据 = `wake-scheduler.test.ts` 原样全绿**（**不得为迁就实现改断言**）。
- 备选（若评审认为连导出都不该碰）：在 `wake-scheduler.ts` 内新增一个薄封装 `export async function sendToTrajectory(ctx, root, dirName, message)`，把 `acquireWakeAgent` + `followup` 封在里面 ⇒ **`trajectory.ts` 完全不碰调度器内部**。⚠️ 我更倾向**这个备选**（封装在调度器侧，职责归属更正确：**"怎么把一句话送到一条轨迹"是调度器的知识，不是工具的知识**）。

### 5.2 新增风险（相对 `wake-later`）——**必须显式处理**

| # | 风险 | 为什么 wake 没有 | 建议护栏 |
|---|---|---|---|
| R1 | **无节流 ⇒ 乒乓**：A 发 B、B 的轮次里又发 A，无限往复 | wake 天然限速（必须未来 + 5min tick 粒度） | **同 sender→target 冷却**（如 10s 内重复 ⇒ 拒绝并留痕）；**建议默认开**，成本极低（§7-Q2） |
| R2 | **立刻起轮 = 立刻消耗目标的上下文/额度** | 预约至少隔了一层时间 | 不设硬闸（沿 D60），但**回执必须报 `how`**（live/cold），让发送方知道它落在了活会话上 |
| R3 | 目标可能是**人类正在盯着的会话** | 同上，且 D60 已接受此风险 | 消息文本**自称身份 + 标明"即时消息"**，让人一眼知道它从哪来（`buildSendText` 里落） |
| R4 | 调用方阻塞（冷载入 ~秒级） | wake 立即返回 | 回执里给**耗时**；工具描述里写明"冷路径会等载入" |

### 5.3 审计（**建议 v1 不写注册表**，见 §7-Q2）

| 方案 | 做法 | 代价 |
|---|---|---|
| **(A) 不写** ★ | 回执同步给调用方；调用方把它记进自己的 SESSION.md | 无 schema 变更；**唤醒注册表保持"未来时刻表"的单一语义** |
| (B) 写终态条目 | `WakeEntry` 加 `kind?: 'wake' \| 'send'`；send 条目**一经写入即终态**（`delivered`/`missed`，**永不 `pending`**） | ⚠️ **必须加"永不 pending"的特例**，否则 `pending` 条目会被调度器**每 tick 重试**（对一次性即时投递是错的）；且要动 `asEntry` 校验 |

---

## 6. 实现层（落点与同批必改清单）

> 🔴 **纪律**：**doc 清单不是闭集**（§12.36 教训：基线列 12 处，实际涟漪 387 处/20 文件）⇒ **实施第一步必须是 `grep -rn` 穷举**，下表只是**已实测**的锚点。

### 6.1 `src/`（已 grep 实测 7 文件命中）

| 文件 | 改动 |
|---|---|
| `src/tools/trajectory.ts` | 动作分支 + 参数 + description（`:7` 注释的"6 个"→7） |
| `src/trajectory-ops.ts` | `TrajectoryAction` 联合类型 + `TRAJECTORY_ACTIONS`（`:36/38`）+ 文件头注释 |
| `src/wake-scheduler.ts` | ★ 新增 `sendToTrajectory()` 导出（§5.1 备选）；`acquireWakeAgent` 维持私有 |
| `src/msm-ops.ts` | 能力目录文案两处（`:116` / `:126`） |
| `src/seams/system-prompt.ts` | `toolsBlock` 那行（`:105`）：补 send-message |
| `src/client/SettingsSection.tsx` | 唤醒调度器说明（`:394/:404`）：补一句"即时投递不走本表" |
| `src/index.ts` | 注册注释（`:155`） |

### 6.2 包内模板 / 文档 / 测试

- `src/templates/acc-serenity/SKILL.md`（`:55` / `:101`）、`src/templates/acc-session/SKILL.md`（`:3` 描述 / `:10` / `:30` / `:51`）——**这些会随包分发并被注入 agent 上下文**，属**契约面**。
- `README.md` / `README.en.md` / `hooks/dsh-serenity-hooks/README.md`（三份，`:271`/`:283`）。
- `CHANGELOG.md`；设计文档群（`trajectory-wake-registry-design.md` / `trajectory-scheduling.md` / `container-trajectory-rename.md` 的判据行 / `acc-component-relations-current-state.md`）。
- **测试（coverage-gate：新/改 src 模块必须同批带镜像测试）**：
  1. live 路径（mock `agents.get` 命中）⇒ `how=live(...)`；
  2. 冷路径（mock `sessionController.resolveAgent`）⇒ `how=cold-resume(...)`；
  3. 未命中 / 无绑定 / `sessionController` 缺席 / `followup` 抛错 ⇒ 四种 `ok:false` 文案；
  4. 参数校验（空 target / 空 message）；
  5. 🔴 **回归钉**：`wake-later` 仍**拒绝** `at ≤ now`（防有人为了 send 顺手把它放宽）。

### 6.3 specs（**"标准"面，必带一次修订**）

`AI_LAB/serenity-acc-specs` 的工具契约表要加第 7 个动作（§12.36 先例：退场要带 specs 修订，**新增能力同样要**）。版本口径待定（v1.7.0 未做 ⇒ 可**并入 v1.7.0**，或独立 v1.8.0）。

### 6.4 CCC 侧（不发版，但同批）

- `home-serenity/SKILL.md` 任务路由表「定时唤醒某条轨迹」那行 ⇒ 补"或 `send-message` 即时投递（有回执）"。

### 6.5 验证（**发布前**）

- 四门禁（typecheck / test / build / pack-check）。
- 🔴 **实调验收（不能只靠单测）**：对**一个 live 目标**（如本机另一条在跑轨迹）与**一个冷目标**各发一次，判据取**文件级证据**（§12.B 的教训：**不得凭一次早期采样判"起没起轮"**）。
- **回归**：`wake-scheduler.test.ts` / `wake-registry.test.ts` **原样**全绿（证明冻结约束守住）。

---

## 7. 待所有者裁决（**三个决策点，未定不进实现**）

| # | 问题 | 备选 | 我的倾向 |
|---|---|---|---|
| **Q1** | 「用来**回应**」= **单向投递**，还是**请求-响应**（发送方要拿到目标的答复）？ | (a) 单向 + 投递回执（本稿）｜(b) 请求-响应：发送方**阻塞等目标跑完并取回其答复** | **(a)**。理由：① D58 已**明文否掉**"唤醒做成请求-响应"；② (b) 会让发送方阻塞数分钟，且需要"等轮次结束 + 取输出"的宿主能力，**现在没有**；③ (a) 已覆盖"实时递话"这一层，且**不排除**将来在其上加 (b)。⚠️ **若你要的是 (b)，请直说——那是另一份设计** |
| **Q2** | 防乒乓节流 + 审计落点 | 节流：开/不开（多少秒）｜审计：(A) 不写注册表 / (B) 写终态条目 | **节流开**（默认 10s，极低成本）｜**审计取 (A)**（注册表语义保持干净；同步回执已足够留痕） |
| **Q3** | 是否允许投给**外部面 / skiff 会话** | 允许 / 禁止 | **允许**（技术上同构；`skiff-*` 也是 trajectory 载体）——除非你认为会污染对外面（D7「对外面纯净」） |

---

## 8. 一句话总结（供快速判断）

> **`send-message` = `wake-later` 的"立刻这一版"**：同样复用"live 优先 → 冷载入"这一条通路，区别只在**时刻**（现在 vs 未来）与**回执**（有 vs 无）。
> 它**不改 D58**（预约仍无回执），**不改任何冻结链路**（唯一触碰 = 在调度器侧加一个薄封装），并把 §12.B 那条悬案**用"新原语"而不是"打补丁"**的方式结掉。
> **代价（必须先说清）**：它把"实时"做到**投递**这一层，**做不到**"立刻执行"（冷会话仍要载入；忙会话仍排在轮次边界）—— 这条边界必须写进工具描述，否则会被误当成"发出去就已经发生"。
