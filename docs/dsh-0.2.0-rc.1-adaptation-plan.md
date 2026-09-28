# DSH 0.2.0-rc.1 对 dsp（dsh-serenity-plugin）的适配方案

> 体例照 [`dsh-0.1.7-rc.1-adaptation-plan.md`](./dsh-0.1.7-rc.1-adaptation-plan.md)（上一轮的同名产物）。
> **本文件是"方案"**；**实施结果与发布细节的单一真相源仍是 `CHANGELOG.md`**（本文件在实施后另起"§12 收口"，不改写 §1~§11 的当时判断）。
> 会话侧指针：CCC `AGENT_SESSIONS/2026-08-24--S142--.../SESSION.md`（§决策 D97/D98、§日志 2026-09-28）。

---

## 0. 摘要

| 项 | 结论 |
|---|---|
| **目标版本** | **`0.2.0-rc.1`** —— 挂在 npm **`next`** 上（`latest` 仍是 `0.1.7-rc.2`）⇒ **D13 等待策略不变**；本机宿主仍是 `0.1.7-rc.2` |
| **准入判定** | ✅ **不阻断** —— **类型面与运行时绑定面「双零断裂」** |
| **本版工作量在哪** | 🔴 **在"声明面"，不在代码**。`src/**` 预计**零改动**（唯一可能的例外见 §7.4 的双档判定） |
| **顺带修一处缺陷** | 🔴 **声明面之间已经不一致**：`dsh.plugin.json` 仍在说"适配 DSH **0.1.5-rc.2**"，而 `package.json` 说 `0.1.7-rc.1`（§7.3） |
| **需 owner 拍板** | 三件（§11）：**发版令** ／ **范围取哪种写法**（A/B/C）／ `scripts/` 类型门禁 |

**一句话**：0.2.0-rc.1 对 dsp 1.50.0 **不是破坏性升级**；这一轮的真正内容是**把"我们相信自己跑在哪个宿主上"这件事写对**，外加用 docker bench 拿一次运行态证据。

---

## 1. 需求与来源

**owner 令（2026-09-27/28，逐字）**：

> 「**dsh 发布了 0.2.0-rc 开始进行适配工作，本次适配安装测试也要做，利用好 docker，顺手整合下这些 dsp 周边的基础设施到更紧凑，加载 eap 先整理下上下文再开工**」

⇒ 三件：① **适配 DSH 0.2.0-rc.1** ② **docker 安装测试** ③ **dsp 周边基础设施整合**。本文件只管 ①（②的用法见 §8 第 5 步；③另立）。

**前置澄清（本轮的起点）**：上一轮 `typecheck-host 0.2.0-rc.1` 失败于
「派生 paths 指向缺失目录（10 条）」，当时**存疑**"是否宿主真删了这些包"。本轮已证伪 ——
**那是 `host-fetch` 工具默认包集变小**（见 §3/§4），**并已修**（插件仓 `f7fa298`，开发面、不发版）。

---

## 2. 范围与边界

**管**：插件仓（`AI_LAB/dsh-serenity-plugin`）的 **声明面 ／ 闸门字面量 ／ `lockfile` ／ 适配文档 ／ bench 验证**。

**不管**：
- **osp 侧**（归 S156/S138）—— 但按既有跨实现义务，声明面若变**须同步**（先例：`79cb6b8`）。
- **不改 DSH**（D4）。
- **本机宿主升级** —— 那是 owner 的动作，且**会当场打断正在跑的会话（含本容器）**。⚠️ 本方案**不假定**本机已升级。

---

## 3. 取证方法与正控

按 skill §8.9「宿主版本差异对账法」的四步，**本轮加第五步**：

| 步 | 做法 | 本轮读数 |
|---|---|---|
| 1 | 版本面（npm dist-tags） | `latest=0.1.7-rc.2`｜**`next=0.2.0-rc.1`**｜`alpha=0.1.7-alpha.2` |
| 2 | 抓快照（`host-fetch <ver>`）＋ **补齐到两版包集对称** | **rc.2 = 38 包｜0.2.0-rc.1 = 38 包（对称）** |
| 3 | 对称 diff（rc.2 → 0.2.0-rc.1） | **94 文件 ／ +1428 −1001**，**无一条"删除文件"** |
| 4 | 读三类改动（`package.json` ／ `.d.ts` ／ 导出面） | 只有 **9 个包**有**实现级**改动；其余是版本齐步走 ＋ README/i18n |
| 🆕 5 | **把 import 面按「值 vs 类型」分类**（判据 48） | 全 dsp **只绑定 4 个符号**（§5.2） |

**正控（防"假绿"，这是 §8.9 反复强调的）**：
- `typecheck-host` 内置两条自证：**paths 逐条存在性** ＋ **`--listFiles` 命中数**。
  本轮实测 **node 36 条 / client 14 条全部命中**，载入解包宿主 **node 114 文件 ／ client 129 文件**（非 0）
  ⇒ **"无类型错误"不是 tsc 静默回落造成的**。
- 全量 diff 产物留档：`_tmp/diff-020rc1.stat`（摘要）／`_tmp/diff-020rc1.full`（329 KB）。

---

## 4. 准入判定：**不阻断**（三条独立读数）

| # | 读数 | 支撑 |
|---|---|---|
| 1 | **类型面零断裂** — `typecheck-host 0.2.0-rc.1` **双侧零类型错误** | node 114 ／ client 129 文件；paths 36 ＋ 14 全命中 |
| 2 | 🔴 **运行时绑定面零断裂** — 全 dsp 只绑定 **4 个符号 / 4 个包**；这 4 个包里**只有 `dsh-session` 的文件动了**，且动在 **repair 区 ＋ 导出表**，**`deriveEventMessage` 实现未动** | 见 §5.2 |
| 3 | **无删除** — 对称 diff 里没有一条 deleted file；且我们 peer 依赖的包在 0.2.0-rc.1 上**全部 `npm pack` 成功** | 补跑 9 包全成功 |

⚠️ **第 2 条是"类型检查结构上给不出"的证据**：`import type` 在编译期就被擦除（判据 48）。

---

## 5. 断裂清单

### 5.1 本版 = **空清单**

**"空"必须是"查过之后的空"**，所以把查过的东西列出来：

| 我们依赖的面 | 查法 | 结果 |
|---|---|---|
| **peer 的 18 项** | 分类抓取 | **15 项 `@deepseek-ai/dsh-*`** ⇒ 在 0.2.0-rc.1 上**全部 `npm pack` 成功**；**2 项 vendor**（`@deepseek-ai/cordis` ／ `@deepseek-ai/schemastery`）⇒ **不跟宿主版本号走**，按仓库内已装版本 **4.0.4 ／ 3.18.4** 钉版抓取成功；⚠️ **1 项裸 `cordis`** ⇒ **未抓取**（tsconfig 把 `cordis` 键映射到 `@deepseek-ai/cordis` **同一实体**，故与类型面无关）⇒ **登记为"未核"** |
| 类型面（两条 tsconfig 的 50 条 paths 键） | `typecheck-host 0.2.0-rc.1` | 零错误（paths 36 ＋ 14 全命中） |
| 契约表（服务 41 项 / 事件 10 项） | **运行时字符串契约**，`typecheck` 看不见 | ⚠️ **本版未取得运行态证据** ⇒ 交由 bench（§8 第 6 步）；见 §10 |
| client 半（面板） | 同上 | 同上 |

### 5.2 为什么运行时面也是零：**4 个绑定符号**

把 `src/**` 里对 `@deepseek-ai/*` 的 import 逐条分类（`grep '^import \{'` 抓值导入、`^import type` 抓类型导入）：

| 包 | 绑定符号 | 用在几处 | 该包在 0.2.0-rc.1 有实现级改动吗 |
|---|---|---|---|
| `@deepseek-ai/dsh-llm` | `createUserMessage` | 8 | ❌ 只有 `package.json` 变 ⇒ **实现未动** |
| `@deepseek-ai/dsh-tools` | `defineTool` | 12 | ❌ 同上 |
| `@deepseek-ai/dsh-session` | `deriveEventMessage` | 1 | ✅ **文件动了**，但改的是 **repair 区 ＋ 导出表**；`deriveEventMessage` **在导出表里逐字未变**、其实现不在改动区 |
| `@deepseek-ai/schemastery` | `z`（default） | 1 | ❌ 两版**逐字节相同**（不在 diff 里） |
| 其余全部宿主包 | **无**（全 `import type`） | 0 | — |

⇒ **结论**：运行时绑定面**结构上不可能**被本版改到。

### 5.3 有实现级改动的 9 个包（登记，非断裂）

`dsh-agent-loop` ／ `dsh-agent-preset-registry` ／ `dsh-api-session-controller` ／ `dsh-client-ui-conversation` ／
`dsh-client-ui-primitives` ／ `dsh-llm-deepseek` ／ **`dsh-session`** ／ `dsh-session-persistence-jsonl` ／ `dsh-subagent`

⇒ 其中 **8 个**我们**只用它们的类型**（编译期擦除）⇒ **不进风险清单**；第 9 个（`dsh-session`）见 §5.2。

---

## 6. 需复核的 API 形状变化（未定性为断裂，落地前逐条过）

| # | 变化 | 与我们相关吗 | 处置 |
|---|---|---|---|
| R1 | **`openTurnClosers` 重构为 `ToolCallRecovery` 类并新增导出**；`tool/result` 的消账收紧为「仅 `surfaceOp==='append'` ∧ `turn` ∧ `step` 三者都相符才 delete」 | **不用它**（dsp 不调 repair 面） | ✅ 登记即可。🔴 **但值得单独记一笔**：这正是 **S185 会话损坏**（空 `toolCallId`）那一块代码 —— 宿主在改它，**新实现仍不给 `block.id` 非空守卫** ⇒ **A25 的判断不变** |
| R2 | `dsh-session-persistence-jsonl/lib/worker.cjs`：`hasIntrinsicConstructor` 改为与**本引擎**的 `Function.prototype.toString` 对比（不再硬编码 `function X() { [native code] }`） | 我们直接读会话文件（`session-doctor`／`session-repair` 在开发面） | 🟡 **纯可移植性修**，不改容器格式 ⇒ 既有实现安全。**但 §8.11 的"拼接帧容器"知识须复核**（帧 header 规则是否变） |
| R3 | `dsh-client-ui-conversation` 的 client 面大改（+114 行）＋ `input/hub.d.ts` 等类型面变动 | 只用**类型**（`InputState`／`InputActions`／`DraftAttachmentId`） | ✅ `typecheck` 两侧已过 ⇒ 形状兼容 |
| R4 | `dsh-client-ui-primitives` 的 `lib/index.js` +193 ／ 多个 CSS Module | 只用**类型** | ✅ 同上 |
| R5 | `dsh-llm-deepseek` 的 `lib/index.js` 改动（file-store / request-files / upload-index） | **不 import 它**（但它是 `deepseek*` 路由的 provider） | 🟡 登记；若有深挖需求另立 |
| R6 | `dsh.plugin.json` 的 `engines.dsh` 语义 | 见 §7.3 | 🔴 **它早已过时，且这是本版要修的** |

---

## 7. 声明面与闸门字面量（**本版的核心工作量**）

### 7.1 三处声明面 —— 但**三者的强制力完全不同**（这是本节最要紧的发现）

| # | 落点 | 当前值 | 🔴 **不满足时的后果**（实测/取证） |
|---|---|---|---|
| S1 | `hooks/dsh-serenity-hooks/package.json` 的 `peerDependencies`（18）＋ `devDependencies`（32） | 全钉 `0.1.7-rc.1`（`cordis` / `schemastery` 不跟宿主号走） | **安装/装载期**：⚠️ **未取证**。skill §8.4 记「bundle 的版本不兼容是**静默**的（启动 `skip` ＋ 一行 stderr）；**plugin row 才是硬拒**」⇒ **风险最高的一面** |
| S2 | `hooks/dsh-serenity-hooks/dsh.plugin.json` 的 `engines.dsh` ＋ `description` | `>=0.1.5-rc.2` ／ 描述写 **0.1.5-rc.2** | **无强制** —— skill §8.4：「全树 `engines` 只在无关注释出现 → **无宿主强制**」。⇒ 它是**公告面**，不是门 |
| S3 | `src/host/contract.ts` 的 `REQUIRED_HOST_RANGE`（`'^0.1.7-rc.1'`）＋ `REQUIRED_HOST_CEILING`（`'0.2.0'`） | 同上 | 🟢 **仅警告级** —— 🔴 **实测**：`contract.ts` 把版本问题 push 成 **`required: false`**，而 `ok = issues.every(i => !i.required)` ⇒ **版本不符不会让 `ok=false`**，只体现为 `versionOk:false` ＋ 一条 issue（`dashboard health` 可见）。**不会禁用插件** |

🔴 **这条分档决定了落地顺序**：**S3 可以先动（只会多一条警告）**；**S1 必须先拿到 bench 证据再动**（它可能让插件在旧宿主上装不上/不加载）。

### 7.2 为什么 `0.2.0-rc.1` 现在"不报警"

`checkHostVersion` 用**自写的 `compareSemver`**（非 semver range 解析）：floor 由 `REQUIRED_HOST_RANGE` 剥前缀派生 = `0.1.7-rc.1`，ceiling = 显式 `0.2.0`。
- `0.2.0-rc.1` vs floor `0.1.7-rc.1` ⇒ **≥0** ✓
- `0.2.0-rc.1` vs ceiling `0.2.0` ⇒ **预发布 < 同版本正式版** ⇒ **-1 < 0** ✓
⇒ **字面上已落进范围** ⇒ 这就是 §权威锚点记的「**不报警的漂移**」：与 rc.1→rc.2 同款，**"不报警"不等于"已适配"**。

🔴 **同时暴露一个真缺口**：**`0.2.0` 正式版会被 ceiling 判成"范围外"**。⇒ 宿主一旦升到 0.2.0 正式版，插件会报 `versionOk:false`（仍只是警告，但公告面与现实不符）。

### 7.3 🔴 顺带发现的**既有缺陷**：声明面之间已经不一致

| 文件 | 现文 | 应为 |
|---|---|---|
| `hooks/dsh-serenity-hooks/package.json` | `"…适配 DSH 0.1.7-rc.1。"` | ✅ 与「上一轮适配」一致 |
| `hooks/dsh-serenity-hooks/dsh.plugin.json` | `"…适配 DSH **0.1.5-rc.2**（deepseek-ai/deepseek-harness）。"` ＋ `"engines": { "dsh": "**>=0.1.5-rc.2**" }` | ❌ **滞后两轮** |

⇒ **0.1.7-rc.1 那一轮（v1.47.0）漏改了 S2**。虽然 `engines` 无强制、后果只是"公告面在说假话"，但它是**发布物里的对外陈述** ⇒ 本版**同批修掉**（零风险，见 §7.1-S2）。

🔴 **但"修 0.1.5-rc.2"这件事必须先分诊，不能全局替换** —— 实测 `grep '0\.1\.5-rc\.2'` 在 `hooks/**` 命中 **68 处**，四类性质完全不同：

| 类 | 处数 | 例子 | 处置 |
|---|---|---|---|
| **① 真·过时声称** | **3** | `dsh.plugin.json` 的 `description` ＋ `engines.dsh`；`tsconfig.json:22` 的注释「（`0.1.5-rc.2`，**与本机运行宿主一致**）」 | ✅ **本版修**（注释那句现在是**假的**：本机是 `0.1.7-rc.2`） |
| **② 历史记录** | 2 | `src/host/contract.ts:101`（"实测（… 本机装机 = 0.1.5-rc.2）"）／`tests/host-contract.test.ts:181`（"**老宿主**（0.1.5-rc.2）的…"） | ❌ **不改** —— 它们**逐字是真的**（记录"当时"），改了反而毁证据 |
| **③ 有意白名单** | **63** | `pnpm-workspace.yaml` 的版本枚举（见 §7.6） | ❌ **不改**（那是**白名单**，不是"声称适配"） |
| **④ 计数合计** | 68 | ①＋②＋③ | — |

⇒ 🆕 **判据（可复用）**：**同一条字符串的两处出现，可能一处是"假陈述"、另一处是"真证据"** —— 批量替换前必须**逐条分诊"这句现在是否还成立"**（同族先例：判据 6「穷举描述面 ≠ 一律照改」，退役时要连"声明"一起查但**要分开注释与活代码**）。

### 7.4 范围怎么写：三个选项（**需 owner 拍板，或按先例取默认**）

**关键事实**：我们**确实验证过两档**（0.1.7-rc.2 是当前运行态基线；0.2.0-rc.1 本轮已验）。而 skill §8.4 硬纪律写的是「**peer 范围不得收窄**」。

| 选项 | 写法 | 优点 | 🔴 代价 |
|---|---|---|---|
| **A 不动** | 保持 `^0.1.7-rc.1` + ceiling `0.2.0` | 零风险，本地宿主不动 | **声明与现实不符**（没记"也验了 0.2.0-rc.1"）；**且 0.2.0 正式版会被判"范围外"** |
| **B 硬切**（上一轮先例） | `peerDependencies` / `REQUIRED_HOST_RANGE` → `^0.2.0-rc.1`，ceiling → `0.3.0` | 最干净，与"只验新宿主"一致 | 🔴 **收窄 peer ⇒ S1 风险**（旧宿主上可能装不上/不加载）；🔴 **本机宿主还是 0.1.7-rc.2** ⇒ **deploy 前必须先升宿主**（而升级会打断本容器）—— 上一轮 owner 正是用「我会在发布后再升级本地的dsh」+ 推迟 deploy 解的 |
| **C 双档**（本轮倾向） | 声明表达**两个已验证档**：peers 写 `^0.1.7-rc.1 \|\| ^0.2.0-rc.1`；`contract.ts` 新增 `VERIFIED_HOST_BANDS` 数组，`checkHostVersion` 逐档判（任一档内 ⇒ ok） | **声明诚实**（两档都记上）＋ **不收窄 peer**（守 §8.4 纪律）＋ **不排除 0.2.0 正式版**（`^0.2.0-rc.1` 含它） | 要改 `src/host/contract.ts`（本版唯一的 `src` 改动）＋ 两处闸门字面量改语义（§7.5） |

**倾向 C 的理由（R↓）**：我们有**证据**支持两档，而 A 会让公告面说假话、B 会把"已验证范围"缩到比证据更窄。C 是唯一"声明 = 证据"的写法。
**倾向的对立面（也要说）**：上一轮 owner 对同类问题裁的是**硬切＋不做双基线**（"只验新宿主"）⇒ 若 owner 认为"旧宿主已被淘汰、不必再背书"，**B 才对**。
⇒ **这是 §11 的第 2 件待裁。**

### 7.5 闸门字面量（2 处，**必须与 §7.4 的选择同批改**）

| # | 文件 | 现在 | 备注 |
|---|---|---|---|
| G1 | `tests/compliance.test.ts`（F6c，`:126`） | `expect(range, '…').toBe('^0.1.7-rc.1')` | 单一字面量断言 ⇒ 选 C 时须改成"每档都成立"的形态 |
| G2 | `tests/host-manifest.test.ts`（`:78-79`） | 全 peer 形状正则（`^0.1.7-rc.1` ／ `^3.18.4` ／ cordis `^4.0.4`） | 同上；**上一轮实测这两处是 `fail-loud`**（改基准忘改字面量 ⇒ 跑 `test` 就红） |

**另需同批改**：`hooks/dsh-serenity-hooks/tsconfig.json` 的**头注释**（第 17~26 行那条"宿主类型基准"说明里写着 `0.1.5-rc.2` 的来历；属**文档一致**，非机械 —— 且它现在**是假的**，见 §7.3-①）。

### 7.6 🆕 **第六处表面：`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`**（skill 的"五步清单"**没列它**）

`pnpm-workspace.yaml` 有两块设置：

- `allowBuilds: { esbuild: true }` —— 构建脚本批准表（**改动时勿丢**）
- **`minimumReleaseAgeExclude`：一份 63 项的版本枚举**，逐项形如
  `'@deepseek-ai/dsh-agent-loop@0.1.5-rc.1 || 0.1.5-rc.2 || 0.1.7-rc.1'`

**它解决什么**：pnpm 的"最小发布年龄"会把**新发布的版本**隔离一段时间（供应链保护），而 DSH 的 rc **都是刚发布的** ⇒ 必须逐个排除出隔离区，否则 `pnpm install` 解析不到该版本。

🔴 **本版的后果**：现表**只到 `0.1.7-rc.1`** ⇒ 一旦把 devDependencies 抬到 `0.2.0-rc.1`，**`pnpm install` 可能因隔离而失败或退化**。

🔵 **但它很可能是自维护的**：上一轮（v1.31.12）的实测副产物逐字记着「**pnpm 安装会追加** `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`（`allowBuilds: esbuild` 存活）」⇒ 预期下次 `pnpm install` **自动补** `0.2.0-rc.1`。
⇒ **处置 = "改完之后核实它有没有被追加"，而不是手工维护**（手维护 = 又一份会漂的清单，判据 50）。⚠️ 若 pnpm **不**追加，则须手工补，并**同批确认 `allowBuilds` 未被覆盖**。

🔴 **附带一条文档缺口**：skill §8.5 的「宿主升级的完整动作（五步清单）」**只列了 3 处声明面 ＋ 2 处闸门字面量 ＋ tsconfig 头注释**，**没有这一处** ⇒ 首次照该清单执行的人**不会预期到它**（本方案 §8 第 4 步已补）。**建议同批把这条补进 skill**（方法面，归 CCC）。

---

## 8. 落地顺序（建议）

0. ✅ **前置**：入口澄清（`host-fetch` 补跑 ＋ 分辨 (a)/(b)）—— **已完成**；工具面缺口已修 **`f7fa298`**。
1. 🟢 **低风险先做**：修 §7.3 的 S2（`dsh.plugin.json` 的 description ＋ `engines`）—— **零行为风险**，先把"公告面说假话"止住。
2. 🔴 **待裁**：§7.4 选 A / B / C。
3. 按选择改 **S1/S3 ＋ G1/G2 ＋ tsconfig 头注释**（同一提交内改完，避免基准半抬）。
4. `lockfile` 重算 ＋ frozen 自检 ／ 🆕 **核实 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 是否已自动追加 `0.2.0-rc.1`**（并确认 `allowBuilds: esbuild` 未被覆盖，见 §7.6）。
5. **七项门禁**：`typecheck`（node+client）／ `typecheck-cli` ／ `typecheck-host 0.2.0-rc.1` ／ `test` ／ `coverage` ／ `build` ／ `pack-check`。
6. 🔴 **bench（docker 安装测试）** —— `msm("bench-docker", …)`，用 **`--plugin-tarball`**（§8.14：「**验我这次的改动** ⇒ 这是发布之前拿到运行态证据的**唯一**通道」）：
   `probe` → `sync`/`build` → `up --plugin-tarball=…` → `wait`/`logs` → **`verify`（V0~V6c）** → `down`。
   **必须遵守四条硬纪律**（长任务后台脱离 ＋ 有界轮询 ／ 改判据后 `vpush` ／ 大文件分块＋sha256 ／ `--ignore-scripts` 打包）。
7. **（发版 ＋ 本机宿主升级）** —— 🔴 **须 owner 具名令（D14）**，且**顺序耦合**：本机宿主不升到 0.2.0-rc.1，则**不得 deploy 选 B 的产物**（见 §7.4）。

---

## 9. 验收判据（逐条可跑）

| # | 判据 | 跑法 |
|---|---|---|
| V1 | 类型面在新宿主下零错误 | `msm("dsh-develop", ["typecheck-host", "0.2.0-rc.1"])` ⇒ 双侧零错误 ＋ 文件命中数 > 0 |
| V2 | 包集两版对称（防假删除） | `_tmp/host-0.1.7-rc.2` 与 `_tmp/host-0.2.0-rc.1` 目录项数相同（各 38） |
| V3 | **声明面无过时声称** | `grep -rn "0\.1\.5-rc\.2" hooks/**` ⇒ 只应剩 **`pnpm-workspace.yaml` 的白名单**（63 项，**故意留着**）＋ **2 处历史记录注释**；`dsh.plugin.json`（2 处）与 `tsconfig.json:22` **必须 0 命中**。⚠️ **不许全局替换**（§7.3 四类分诊） |
| V3b | **新基准已进 pnpm 白名单** | `grep -c "0\.2\.0-rc\.1" hooks/dsh-serenity-hooks/pnpm-workspace.yaml` > 0，且 `allowBuilds` 段仍在（§7.6） |
| V4 | 基准一致 | 三处版本一致 ＋ `compliance.test.ts` F6c ＋ `host-manifest.test.ts` 全绿（`fail-loud`） |
| V5 | 装得上、起得来、功能可用、用 minimax 模型 | bench `verify` ⇒ 判据集全过（V9c `MISSING_CREDENTIAL` = 0） |
| V6 | 运行态自证（**发版后才有**） | `dashboard health` 报新 accVersion ＋ 宿主 hostContract 全过 |

---

## 10. 未验证边界（诚实声明）

1. 🔴 **没有做过真机安装** —— 本机宿主仍是 `0.1.7-rc.2`。⇒ 纯 `.js` 行为变更**只由对称 diff 兜住**，"非破坏性"这个结论的**最强证据是 bench**（§8 第 6 步），**尚未取得**。
2. 🔴 **`peerDependencies` 的强制面未取证** —— "不满足会怎样"是**读 skill 的记载**，不是本轮的实测。⇒ **正是交给 bench 回答的问题**（bench 走真实 npm 安装路径）。
3. **契约表（服务 41 ／ 事件 10）是运行时字符串契约，`typecheck` 结构上看不见** —— 本版**未取得**该面证据（先例 B1「只迁一半」就是在这里静默失效的）。
4. **扫描域上限**：本轮只核了**我们自己声明面**涉及的 38 个包。**宿主自身的依赖图没有枚举** ⇒ 若宿主在某个我们未声明的包上有断层，**本方案看不见**。
5. **bench 自身的已知边界**（§8.14）：V5（身份播种）需真实会话 ⇒ 容器里 **0 命中是预期**；无模型凭据 ⇒ 不跑真实对话轮；远端磁盘紧张 ⇒ 用完即 `down`。
6. **R2（`worker.cjs` 的帧容器）只做了代码级复核，未做端到端读一份 0.2.0-rc.1 写的会话**。

---

## 11. 待 owner 裁决（三件；**前两件不阻塞开工**）

| # | 事项 | 说明 |
|---|---|---|
| **1** | **发版令（D14）** | ⚠️ **不要当成已授权** —— owner 本轮说的是"开始进行适配工作 ＋ 做安装测试"，**没有具名到"发版"**。⇒ 适配完成后再问。 |
| **2** | 🔴 **§7.4 的范围写法取 A / B / C** | 影响：A = 公告面继续说假话且排除 0.2.0 正式版；**B = 收窄 peer（有装载风险）＋ 本机必须先升宿主**；C = 双档（要改一处 `src`）。**先例提示**：上一轮 owner 裁的是"硬切＋不做双基线"。 |
| **3** | **`scripts/` 类型门禁** | `scripts/` 不被任何 gate 类型检查（根 `tsconfig` `include: src`；`typecheck-cli` 只管根包 `src`；脚本由 `bun` 跑＝**只转译**）⇒ 118 KB 的 `dsh-develop.ts` 改动**无机械判据**。要不要补？⚠️ 补之前**须先探一遍存量错误**（它从未被类型检查过）。 |

---

## 12. 收口（实施后填；**本节之前的当时判断不改写**）

_待实施完成后补写，体例照上一轮同名文件 §11。_
