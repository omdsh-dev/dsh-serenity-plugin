# DeepSeek 多模态临时 patch —— 设计

- 版本: v1.0（2026-09-19 · S142 §26 §0x-9）
- 授权: owner 2026-09-19 14:5x「**临时的我允许，还是要 patch**」
- 状态: **设计定案**（实现前文档；实现见 §7 分步）

---

## 0. 这东西用来干什么（**先用途、后机制** —— D70 纪律）

> **我们的插件（宁静号 ACC）希望：你在 DSH 里用任何 DeepSeek 模型时，都能直接发图给它。**
>
> **今天的问题**：DSH 里"某个模型能不能收图"**不是自动识别的**，而是靠一份**声明**。
> 目录里少数模型（如 `deepseek-v4-flash-vision-exp`）声明了能收图；
> **你现在正在用的这个模型（`deepseek-v4.1-flash`）不在目录里**，于是走默认值 **"只能收文字"** ⇒
> **图片会被丢掉 / 报错**，尽管这个模型本身其实支持。
>
> **本模块做的事**：插件启动时**检查一遍你的模型配置**，凡是**名字里带 `deepseek` 的模型**，
> 都**自动补上"支持图片"这一条声明**（`input: ["text","image"]`）。
> ⇒ **效果 = 你不需要每次手动配，DeepSeek 系模型开箱能收图。**
>
> **为什么叫"临时"**：这是**替上游补一个它还缺的声明**。等 DSH 自己做得更完善了，
> 我们这个功能**整体下掉**（所以设计上必须能"一键关掉"）。
>
> **它会不会乱改我的配置？** 不会：① 只**补缺失的那一项**（已有声明**一律不动**）；
> ② 只碰**名字带 deepseek 的**模型；③ 改动**只落在你自己的 settings 文件**里，**随时可删可改**；
> ④ 有一个**总开关**，关掉即不再补（详见 §5）。

---

## 1. 问题（范围层：我们到底在解决什么）

### 1.1 现象

模型能否接收图片，由 `llm-pi-ai` 在**解析期**决定：

```
input: declaredInput(entry.input) ?? base?.input ?? [...request.defaultInput]
```

出处：`dsh-llm-pi-ai/lib/index.js:682`（`resolveEntry` 内），三处辅助：
- `declaredInput()` — `:292`（`undefined` 或空数组 ⇒ 问下一级）
- `base` = 内置目录条目 — `:665`
- `request.defaultInput` — `:1069`（缺省 `[...DEFAULT_INPUT]`）
- `DEFAULT_INPUT = ["text"]` — `:906`
- 配置 schema — `modelFields.input` @ `:973`；`profile.defaultInput` @ `:993`

### 1.2 三条关键结论（**已取证，勿重查**）

| # | 结论 | 含义 |
|---|---|---|
| A | **目录内模型 ⇒ route 级 `defaultInput` 永不生效** | 三段的中间项 `base?.input` 先命中 ⇒ 想改只能**逐模型写 `input`**（无 route 级捷径） |
| B | **不在目录里的模型 ⇒ 走 `defaultInput` 兜底** | 而 `provider.defaultInput` **是 route 级**（`:993`）——**理论上**改一处可覆盖该 route 下所有"非目录"模型 |
| C | **`modelOverrides` 与 `models` 互斥** | `:643` — 「sets modelOverrides for "X" beside a models list」 ⇒ 同一 route 上二者**不能并存** |

### 1.3 今天的事实基线（§0x-7a 实测，勿重查）

| 模型 | 路由 | 解析出的 input | 说明 |
|---|---|---|---|
| `opencode-go/mimo-v2.5` | opencode-go | `["text","image"]` | 已在目录中声明 ⇒ **已能收图** |
| `deepseek-v4-flash-vision-exp` | （目录） | `["text","image"]` | 同上 |
| `deepseek-v4.1-flash` | `opencode-go-responses` | `["text"]` | 🔴 **不在目录里 ⇒ 兜底** ⇒ **正是要 patch 的对象** |
| `deepseek-flash` / `deepseek-v4-flash` / `deepseek-v4-pro` | `deepseek-official` | 目录里 **只声明了 `inputModalities`**（`dsh-llm-deepseek/lib/index.js:1841-1871`），**那是另一个插件自己的字段**，**不是** `llm-pi-ai` 的 `input` | ⚠️ **两条声明链是分开的**（见 §1.4） |

### 1.4 🔴 一处必须显式划清的边界（诚实标注）

**`llm-deepseek` 与 `llm-pi-ai` 是两套独立的模型声明面**：

- `dsh-llm-deepseek` 有自己的 `DEFAULT_MODELS`（`:1841`）+ `inputModalities` 字段（`:1879`）+ 自己的 `Config`（`:1884`）；
- `dsh-llm-pi-ai` 有 `models[].input`（`:973`）+ `defaultInput`（`:993`）。

🔴 **本设计只作用于 `llm-pi-ai` 面**（即 `settings.update('llm-pi-ai', …)`）。
**`dsh-llm-deepseek` 面不在范围内**——它的 `inputModalities` 是它自己的目录，
**且 `deepseek-flash` 已经声明了 `["text","image"]`**。
⇒ **若 owner 发现"某 deepseek 模型仍然收不了图"，第一步应判定它走的是哪条链**，
而不是假定本 patch 失效。（判据：该模型是否出现在 `llm-pi-ai.providers.<route>.models[]` 里。）

---

## 2. 方案（方案层：做什么、不做什么）

### 2.1 一句话方案

> **插件启动时读 `llm-pi-ai` 现状 → 找出所有"名字含 `deepseek`（大小写不敏感）且未声明支持图片"的模型 →
> 把这些模型的 `input` 补成 `["text","image"]` → 通过官方通道 `settings.update` 写回。**

### 2.2 判据（**每条都可机械执行**）

| # | 判据 | 取值 |
|---|---|---|
| J1 | **触发** | 模型 `id` 含 `deepseek`（**大小写不敏感**） |
| J2 | **范围** | **所有 provider / 所有 route**（owner：「任何 deepseek 模型」）——不限定 opencode 系 |
| J3 | **补什么** | `input` 补上 `"image"`；**若已含 `image` ⇒ 跳过**（幂等） |
| J4 | **不动什么** | 🔴 **已显式声明 `input` 且已含 image 的 ⇒ 一字不改**；非 deepseek 模型 ⇒ 一字不改 |
| J5 | **写哪** | `llm-pi-ai.providers.<route>.models[i].input` |
| J6 | **何时** | 启动时一次 + `settings/updated` 再评（热改自愈） |

### 2.3 🔴 核心实现约束：**深合并对数组是"整体替换"**（本设计最易错处）

**证据**（宿主 `dsh-settings` 原文，逐字）：

> "Layer `over` onto `under`: plain objects merge recursively,
> **every other value (arrays included) replaces the lower layer wholesale**."
> —— `dsh-settings/lib/index.js:203-216`（`mergeLayers`）

⇒ **若只发 `{ providers: { r: { models: [ {id:'x', input:[...]} ] } } }`，
宿主会把这一个元素当作整个 `models` 数组** ⇒ **冲掉该 route 上其它所有模型**。🔴

⇒ **正确做法（硬要求）**：

> **读出该 route 现有的 `models` 数组全量 → 在内存里改目标元素 → 把"改过的整个数组"回写。**

即 patch 形状必须是：
```jsonc
{ "providers": { "<route>": { "models": [ /* 完整的、改过的数组 */ ] } } }
```

⚠️ **两处相关陷阱**：
1. `models[]` 的元素是**完整对象**（含 `id` / `name` / `contextWindow` …），回写时必须**原样带上**
   —— 只回写 `{id, input}` 会丢字段（schema 上 `name`/`contextWindow`/`maxTokens` 虽非 `.required()`，
   但**丢失用户显式值 = 静默改配置**，不可接受）。
2. **`modelOverrides` 与 `models` 并存会被宿主拒绝**（§1.2 C）⇒
   **若某 route 用的是 `modelOverrides` 形态**，本模块**只发 `modelOverrides`**，
   **绝不可为了"补 models"而新建一个 `models` 数组**（那会让该 route 当场校验失败）。

### 2.4 route 级 `defaultInput` —— **候选捷径，明确不采用**（R↓）

**理论上**：对"不在目录里"的模型（如 `deepseek-v4.1-flash`），
把 `providers.<route>.defaultInput` 改成 `["text","image"]` **一行就能覆盖该 route 下所有非目录模型**。

**为什么仍不采用**：

| 理由 | 说明 |
|---|---|
| ① **作用面过宽** | `defaultInput` 是该 route **所有**未声明模型的兜底 ⇒ 会**连带**把该 route 下**非 deepseek** 的未知模型也标成能收图（违反 J2"只 deepseek"） |
| ② **对目录内模型无效** | §1.2 A ⇒ 中间项 `base?.input` 先命中 ⇒ 目录内 deepseek 模型**改 `defaultInput` 没用** |
| ③ **语义错位** | `defaultInput` 是"**该路由的默认**"，不是"我对某个模型的判断"——用它表达逐模型意图是**借用** |

⇒ **决定：统一走 `models[].input` 逐模型写**（判据 A 已定死"只能逐模型写"）。
`defaultInput` **仅在实测定性后**作为补充考虑（见 §6 待验项 V-2）。

### 2.5 明确不做（边界）

| 不做 | 为什么 |
|---|---|
| 动 `dsh-llm-deepseek` 面 | §1.4 —— 那是另一个插件的目录，且它已声明了 vision |
| 改宿主代码 | D4（owner 2026-09-19 重申） |
| 改 `cordis.patch.yml` | 宿主 patch 语义 = **整体替换 config**，会冲掉部署方在该条目上的其它 provider（`opencode-provider.ts:26-28` 已记） |
| 自动"回滚"已写入的值 | 见 §5.3（**待裁**，默认不自动回滚） |
| 建新 route / 建新模型 | 本模块**只补声明**，**不新增实体**（新增属于 `opencode-provider` L2 的职责） |

---

## 3. 结构（照 `opencode-provider.ts` 形态）

### 3.1 形态对齐（**同款三段式**）

| 段 | `opencode-provider.ts` | 本模块 |
|---|---|---|
| **纯函数出计划** | `planOpencodeAutoConfig({resolved, env})` → `{patch, actions}`（`:163-209`） | `planDeepseekVisionPatch({resolved})` → `{patch, actions}` |
| **执行层永不抛错** | `applyOpencodeAutoConfigOnce(ctx, env)`（`:237-270`，全 try/catch + 响亮 warn） | `applyDeepseekVisionPatchOnce(ctx)` |
| **装配 + 重试 + 热订阅** | `registerOpencodeAutoConfig(ctx)`（`:291-352`） | `registerDeepseekVisionPatch(ctx)` |

**为什么照抄**：① 纯函数 ⇒ **可穷举测试**（本仓 coverage-gate 要求镜像测试）；
② 执行层不抛 ⇒ **apply 抛错 = 整个 dsh 启动失败**（F-07/F-08 纪律）；③ 复用已验证的重试/热订阅模式。

### 3.2 模块与导出（拟）

**新文件**：`src/deepseek-vision-patch.ts`

```ts
/** 触发判据：模型 id 含 "deepseek"（大小写不敏感） */
export function isDeepseekModelId(id: string): boolean

/** 是否已声明支持图片（含 "image" 即算） */
export function declaresImage(input: unknown): boolean

/** 纯函数：出计划（不读文件、不碰 ctx） */
export function planDeepseekVisionPatch(input: { resolved: unknown; enabled?: boolean }): DeepseekVisionPatchPlan

/** 执行一次；永不抛错 */
export async function applyDeepseekVisionPatchOnce(
  ctx: Context,
  enabled?: boolean,
): Promise<{ wrote: boolean; registered: boolean; changed: readonly string[] }>

/** 装配：启动一次 + 退避重试 + settings/updated 复评 */
export function registerDeepseekVisionPatch(ctx: Context): void
```

**复用**：`LLM_PI_AI_NAMESPACE`（从 `opencode-provider.ts` **导入**，不复制字符串）；
`hostSettings`（`host/access.js`）；`registerDisposer`（`host/effect.js`）。

### 3.3 动作类型（日志 + 测试断言共用）

```ts
type Action =
  | { kind: 'patch-model'; route: string; model: string; from: readonly string[] }
  | { kind: 'skip-model'; route: string; model: string; reason: 'already-image' | 'override-entry' }
  | { kind: 'idle'; reason: 'namespace-unregistered' | 'disabled' | 'no-deepseek-model' }
```

⇒ 与先例同款：**每条分支恰好推入一条动作**（先例 `:206-207` 明写此不变量，曾因缺它产生死代码）。

---

## 4. patch 构造（**本设计的核心算法**）

### 4.1 逐 route 处理

```
对每个 route ∈ providers:
  ├─ models 是数组且非空 ?
  │    └─ 是 ⇒ 遍历整个数组：
  │            · 元素是对象 ∧ id 含 deepseek ∧ 未声明 image
  │              ⇒ 复制元素 → input = [..., 'image']（去重、保序）→ push 进新数组
  │            · 否则 ⇒ 原样 push 进新数组
  │          ⇒ 新数组 === 旧数组（无改动）? 跳过 : patchProviders[route] = { models: 新数组 }
  │
  └─ models 不是数组（未设 / 非法）⇒ 🔴 不动它
       （尤其：**绝不为 modelOverrides 形态新建 models** —— §2.3 陷阱 2）
```

### 4.2 `input` 的构造规则（**保序去重**）

| 现状 | 结果 | 说明 |
|---|---|---|
| 未设（`undefined`） | `["text","image"]` | 兜底现状是 `["text"]` ⇒ 补成明确的两模态 |
| `["text"]` | `["text","image"]` | 追加 |
| `[]` | `["text","image"]` | 🔴 `declaredInput([])` 返回 `undefined`（`:293`：空数组 ⇒ 问下一级）⇒ **空数组语义上等于未声明** ⇒ 按"未设"处理 |
| `["image"]` | `["image"]`（**不动**） | 已含 image ⇒ 跳过（J3/J4） |
| `["text","image"]` | **不动** | 幂等 |
| `["image","text"]` | **不动** | 保序：已含即不重排 |
| 非数组（脏数据） | `["text","image"]` | 按"未设"处理（不猜用户意图） |

### 4.3 回写完整性（**必须逐字保留原字段**）

回写元素的构造 = `{ ...原元素, input: 新input }` ⇒
**spread 原对象**（不是重建）⇒ `name` / `contextWindow` / `maxTokens` / `compat` / `reasoningEfforts` 等**全部原样带上**。

🔴 **测试必须钉住这条**（含 `name`/`contextWindow` 的模型 ⇒ 回写后仍在）。

---

## 5. 撤除与开关（**临时性 ⇒ 必须易撤**）

### 5.1 三层撤除手段（**从便宜到彻底**）

| 层 | 手段 | 效果 | 成本 |
|---|---|---|---|
| **① 关开关** | 配置项 `visionPatch.enabled = false` | **停止再补**；已写入的值**留在 settings 里** | 零（改配置，热生效） |
| **② 整体移除** | 删 `src/deepseek-vision-patch.ts` + `index.ts` 一行装配 | 功能彻底消失 | 一次发版 |
| **③ 清理已有值** | 手动编辑 `~/.dsh/settings.yaml` 删掉那些 `input: [text, image]` | 配置回到原样 | 手动 |

### 5.2 开关的落点与默认值

**落点**：`.opencode/serenity.json` 的 `visionPatch.enabled`（CCC 级，与既有 `trajectory.*` / `handyman.*` 同族）。

**默认值**：🔴 **待裁（§8-1）**。两个选项：
- **(默认开)**：owner「临时的我允许」⇒ 意图明确是"要它工作"；开箱即用；
- **(默认关)**：与 §4.2 既有纪律「**实验功能默认关**」一致；但需要 owner 多改一次配置。

**建议：默认开**（本次是**应 owner 请求而做**的功能，不是实验特性；且"临时"由"易撤"保证，不需要靠"默认关"来兜）。

### 5.3 要不要"回滚已写入的值"（**待裁**）

owner 说「以后 dsh 做得更完善了…**我们这个功能再下掉**」——
「下掉」= **停止再 patch**（①/②）还是 **连已写的值也还原**（③）？

| 选项 | 含义 | 风险 |
|---|---|---|
| **不回滚（建议）** | 关掉后已写的 `input` 留着 | 🟢 **无害**——那本来就是**事实**（模型确实支持图片）；且若我们回滚成 `["text"]`，反而**主动降级**了用户环境 |
| **回滚** | 记录"哪些是我们写的"→ 关掉时还原 | 🔴 要做**写入台账**（第二真相源，只增不清的同族病）；且**还原成错误值** |

**建议：不回滚**。理由：**我们写的是"模型支持图片"这个事实**，不是"我们的偏好" ⇒
停掉插件后它**依然是事实**。⇒ 移除只需 ①② 两层，**不需要台账**。
（若 owner 要求回滚 ⇒ 必须做台账，成本见左栏风险。）

---

## 6. 待实测定性的两点（**不实测不下结论**）

| # | 待验 | 怎么验 | 若否 |
|---|---|---|---|
| **V-1** | `settings.update` 写 `models[].input` **会被宿主的 `assertServiceable` 接受吗**？ | 探针：真跑一次 `update`，看是否被 `assertServiceable` / `validate` 拒 | 退 §2.4 的 `defaultInput` 路线；或退"只诊断不写"（§0x-9d (a)/(b)） |
| **V-2** | 改 `defaultInput` 对**非目录** deepseek 模型是否真的生效 | 同上探针，写 `defaultInput` 后读解析结果 | 不影响主路线（主路线是逐模型） |

⚠️ **V-1 是真风险**：`:1026-1028` 的 `assertServiceable` 会 `resolveProfiles(...)` 校验
**每个变更过的 route** ⇒ **我们的 patch 必须能通过它**（否则写入被拒）。
⇒ **实施第一步就是探针验 V-1**（低成本、零破坏；同 §0M 手法）。

### 6.1 ✅ V-1 探针结果（**2026-09-19 20:0x，三点全绿**）

**探针**：`tests/host/deepseek-vision-probe.test.ts`（**真实 `dsh-settings` 0.1.5-rc.1 + 真实 cordis**；全程无自造合并逻辑）。

| 点 | 判据 | 实测结果 |
|---|---|---|
| **W-0 正控** | 注册命名空间 + `update` 普通对象 patch 能写成功 | ✅ `true`（`headers` 补入成功） |
| **W-1 🔴 核心** | 发"只含一个元素"的 `models` 数组 ⇒ **原有全部模型被冲掉** | ✅ **`true`**（2 条 → 1 条，`deepseek-keep` 消失） |
| **W-2** | 同层 `headers` 在 models 整写后仍在 | ⚠️ 实测 `false` —— **是我的探针时序**（W-1 已把 `headers` 覆盖成只有 `x-added`，故 `x-user-kept` 早已不在）；**不代表深合并伤同层字段**，见下 |
| **W-3 读-改-整写** | 重置初始态后，整写 models 保住非目标模型 + 字段 | ✅ **`true`**（`other-model` 与 `contextWindow:262144` 均保留） |

**W-1 的实测原文**（这正是本设计 §2.3 的机械依据，**从文档断言升级为实测事实**）：
```jsonc
"W-1 写后 models 条数": 1,
"W-1 写后 models": "[{\"id\":\"only-one\",\"name\":\"Only One\",\"input\":[\"text\",\"image\"]}]",
"W-1 原两个模型是否被冲掉": true      // 🔴 证实数组整体替换
```

**W-3 的实测原文**（证明"读-改-整写"是正确做法）：
```jsonc
"W-3 整写后条数": 2,                  // ✅ 两条都在
"W-3 非 deepseek 模型保留": true,      // ✅ other-model 未受影响
"W-3 字段保留(contextWindow)": true    // ✅ spread 原对象 ⇒ 字段不丢
```

### 6.2 🔴 本轮**探针自身**的两处缺陷（**已记，方法论价值**）

**缺陷一（脚手架，三处）**：`SettingsProvider.register` 的真实签名与我的假设不符：
1. **三参** `register(ns, schema, options)`（不是单对象）——传错 ⇒ `namespace "[object Object]" must match /^[a-z][a-z0-9-]*$/`；
2. **`schema` 必须是函数**（`resolve()` 内 `schema(mergeLayers(base, section))`，`:510`）——传 `{parse, safeParse}` ⇒ `schema is not a function`；
3. **`writable` 由子类定义**（基类不设 ⇒ falsy ⇒ `write()` 抛 `read-only`，`:448`）——
   真机里恒 true 的是 `dsh-settings-file`（与 `opencode-provider.ts:24` 的记述一致）。

⇒ **三处**都属于 §0M-4 那条纪律的适用面：**探针报错时先分诊"被测对象失败"还是"脚手架失败"**。
**本轮三次都没有把脚手架问题误记成方案否决**（这正是该纪律的价值）。

**缺陷二（时序，更值钱）**：W-3 首跑**红**了，报"整写不保模型"——
🔴 **真因是 W-1 已把 models 冲成单元素，W-3 在残局上跑** ⇒ **状态污染**，不是方案缺陷。
⇒ **新判据（收进 §4.2 纪律候选）**：
> **同一探针内验证"正确做法"前，必须先把状态重置回初始态**——
> 否则"上一步的破坏性验证"会被误读成"下一步的做法不成立"。
> （与既有「**探针先做正控**」同族：正控保证"链路通"，本条保证"**验 A 时环境里没有 B 的残骸**"。）

### 6.3 ⚠️ V-1 的**边界**（诚实标注，不可外推）

**探针验的是 `dsh-settings` 的注册/合并/持久化链路**。
🔴 **不含 `llm-pi-ai` 自己的 `validate`**（其 zod schema + `assertServiceable`，`:1026-1028`）——
那需要装载真 pi-ai 包。
⇒ **通道通 ≠ 被 pi-ai 接受**。这一层**必须留给 P-6 的真机实测验收**
（判据 = §1.3 那个解析出 `["text"]` 的模型**真能收图**）。
**不得**据本探针宣称"V-1 已完全证实"。

---

## 7. 分步实施（**小步可验证**）

| 步 | 内容 | 验收 |
|---|---|---|
| **P-1** | **探针**：验 V-1（`settings.update` 写 `models[].input` 是否被接受）+ **正/负控** | 探针报告 + 分诊（**脚手架失败 ≠ 方案否决**，§0M-4 纪律） |
| **P-2** | 纯函数 `planDeepseekVisionPatch` + 镜像测试（穷举 §4.2 全表 + §4.3 字段保留 + §2.3 数组整写） | 单测全绿（coverage-gate） |
| **P-3** | 执行层 `applyDeepseekVisionPatchOnce`（永不抛错）+ 装配接线 `index.ts` | 单测 + typecheck |
| **P-4** | 全量门禁 | typecheck 双面 / test / build / pack-check |
| **P-5** | 发布（D14 已授权） | v1.40.x |
| **P-6** | **实测验收**（判据 = §1.3 那个 `["text"]` 模型真能收图） | 探针 v2 手法（§0x-7） |

🔴 **P-1 必须先做**：它是 V-1 的**唯一**取证方式，**"我读了源码"≠"我执行了那条链"**（§4.2 纪律）。

---

## 8. 待 owner 裁（**均非阻塞实现，可先按倾向做**）

| # | 事项 | 我的倾向 |
|---|---|---|
| 1 | 开关**默认开还是关** | **默认开**（本次是应他请求而做，非实验特性） |
| 2 | 关掉后**要不要回滚**已写入的值 | **不回滚**（写的是事实，不是偏好；不做台账） |
| 3 | **范围**确认：所有 provider `的 deepseek 模型（不限定 opencode 系） | **按他原话"任何"** 执行 |

---

## 9. 设计依据出处（**可追溯**）

| 事实 | 出处 |
|---|---|
| `input` 解析三段式 | `dsh-llm-pi-ai/lib/index.js:682` |
| `declaredInput` 空/缺语义 | 同上 `:292-294` |
| `DEFAULT_INPUT = ["text"]` | 同上 `:906` |
| `models[].input` schema | 同上 `:973` |
| `defaultInput` schema | 同上 `:993` |
| **`modelOverrides` 与 `models` 互斥** | 同上 `:643` |
| `assertServiceable` 拒绝不可服务变更 | 同上 `:1026-1028` |
| **深合并数组整体替换** | `dsh-settings/lib/index.js:203-216` |
| 官方写入面 + 三条依据 | `src/opencode-provider.ts:19-28` |
| 先例纯函数/执行/装配三段 | `src/opencode-provider.ts:163-352` |
| `dsh-llm-deepseek` 是**另一条链** | `dsh-llm-deepseek/lib/index.js:1835-1884` |
