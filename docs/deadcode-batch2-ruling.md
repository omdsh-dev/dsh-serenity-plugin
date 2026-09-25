# ② 第 2 批死代码 —— **逐条裁决清单**（待 owner 勾选）

> **用途**：owner 一次拍完，我照着执行。**每条都带可重跑的判据**（不是"我读过源码"）。
> **判据来源**：约束文档 §6.2（先问"谁依赖它"）＋ §6.3（"删前必问三句"）。
> **锚定**：2026-09-26 S142（插件仓 `6893d10` 之后）。
> 🔴 **本清单每一条都经我本轮 grep 复核** —— 地图 §3-7 是**快照**，**已有 3 条与现状不符**（见 §0），
> 另有 **6 个被地图列为"零引用"的类型实为活契约**（见 §4）⇒ **整档照搬会误删**。

---

## 0. 🔴 先说三条「地图陈旧」的更正（否则会照错的裁）

| 地图原记 | 实测 | 处置 |
|---|---|---|
| §3-7 a) 列 `trajectory-skills.ts:SKILL_MISSING_MARK` 为"导出但零引用" | **它已不是导出的** —— 第 1 批已把它**降为模块内 `const`**（`trajectory-skills.ts:27`，注释自述此事） | ✅ **已由第 1 批处理完**，本轮**不再是候选** |
| §3-7 a) 列 `trajectory-assistant.ts:onSettlement` 为"空实现，无调用者" | **它已被删除** —— 该文件 `:19` 的文件头自述「原先那个 `onSettlement(cb)` 空 seam 已删」 | ✅ **已由第 1 批处理完**，本轮**不再是候选** |
| §3-7 a) 列 `trajectory-bound.ts:ensureBindingsMigrated` 为"导出但零引用" | 🔴 **两处都错**：① 它**根本没导出**（`function`，无 `export`）② 它**有活调用点** —— `trajectory-bound.ts:230` 真调它（`index.ts:226` 的注释还解释了它为何惰性触发） | ❌ **不是死代码，撤回候选** |

🔵 **这三条的教训**：**地图 §3-7 也是快照**。⇒ 规矩：**凡引用"零引用"结论，必须先 grep 一次**（本轮已做）。

---

## 1. A 档 = **确证死代码**（建议删，风险最低）

> 判据 = **仓内零调用 ∧ 零读取 ∧ 非公开面**（无导出 / 或导出但无任何消费者且非契约类型）。

| # | 对象 | 判据（可重跑） | 删了会怎样 |
|---|---|---|---|
| **A1** | `trajectory-ops.ts:today` **私有函数** | `grep today` 全仓**唯一命中 = 它自己的定义**；零调用点。它只是一行转发（`return localDate()`）——推测某次重构后调用点被改写、函数忘删（同文件别处已直调 `localDate(...)`） | **无影响**（私有 ∧ 零调用） |
| **A2** | `skiff-core.ts:isResumeFallbackError` **私有函数** | 全仓**唯一命中 = 它自己的定义**；零调用点。🔴 **另有价值**：它的函数头注释描述的策略**已被 v1.27.2 用户拍板推翻**（现语义 = "resume 失败一律降级新建"）⇒ **注释与实现已分叉** | **无影响**，且**顺带消掉一条矛盾注释** |
| **A3** | `clock-runtime.ts:Clock` **接口** | 导出但 `src/**` 仅本文件内用（`createClock` 的返回类型 ＋ 内部 `const api: Clock`）；`tests/**` 零显式引用 | ⚠️ 它是 `createClock` 的**返回类型** ⇒ **删它要改签名写法**；**与 C3 的 `Clock` 是同一条**（此处不重复计） |

---

## 2. B 档 = **"构造上不可达"的防御性兜底**（建议**保留但加注**，不删）

> 判据 = 代码在**类型上合法**，但**本模块的运行期永不产生**该取值 ⇒ 兜底分支恒不成立。
> 🔴 **为什么建议不删**：它们不是"忘了删的垃圾"，而是**类型守门**（`??` 只为满足 `string | null`）——
> 删掉会让类型层失守；**但现状的问题是"没人知道它们不可达"** ⇒ 处置 = **加一行注释说明它为何不可达**。

| # | 对象 | 不可达的结构性理由（族） |
|---|---|---|
| **B1** | `api.ts:resolveWorkspace` 的 `catch { /* 遍历失败 → 空列表 */ }` | **三层吞异常族**：`hostSessions → hostInjected → hostService` 三层契约均"不抛错" |
| **B2** | `msm-ops.ts:protocolResult` 末尾 `return undefined` | **联合类型穷尽族**：入参联合只有两形态，前两个 `if` 已全覆盖 |
| **B3** | `msm-ops.ts:assertPathInsideRoot` 内层 catch 的"realpath 失败 ⇒ 放行" | **前置守卫支配族**：进得来已过 `existsSync`，而会让 `realpathSync` 抛的成因会让 `existsSync` 同样为假 |
| **B4** | `fs-ops.ts:detectFileType` 的 `symlink` 档 | **调用点一律传 `statSync`**（跟随链接）⇒ `isSymbolicLink()` 恒假 |
| **B5** | `acp-http.ts` 四处防御性默认值（`split('?')[0] ?? '/'` 后半 ／ `cMatch[1] ?? ''` ／ `aMatch[1] ?? ''` ／ `filter(Boolean).pop() ?? cccValue`） | **恒有值族**（`split` 恒 ≥1 元素 ／ 正则组命中即有值） |
| **B6** | `wake-registry.ts` 四处（两处 `?? err` 右支 ／ `saved.error ?? '写入失败'` ／ `removed ?? null`） | **非 Error 抛出族**（`JSON.parse`/fs 只抛 `Error`）＋ **恒有值族**（`splice` 恒返 1 元素） |
| **B7** | `unattended-seam.ts` 七处（3 条构造不可达 ＋ 4 条需"宿主抛非 Error"） | 同上两族 |
| **B8** | `git-ops.ts` 两处（`push` 的 `catch {}` ／ `commit` 第二条 `'nothing to commit'` 守卫） | **自身全吞异常族**（`git()` 永不抛）＋ **前置过滤支配族** |
| **B9** | `acp-http.ts` 常量门／平台门／环境门各一处 | 常量字面量 ／ Node HTTP 解析器保证 ／ 本机 cwd 在 CCC 内 |

---

## 3. C 档 = **公开面／语义档**（**必须你拍板**，我不自行改）

> 判据 = 改动会**动到公开面**（导出签名／工具名／模型可见文本）或**需要"以哪个为准"的语义裁决**。

| # | 对象 | 需要你答的那个问题 |
|---|---|---|
| **C1** | `clock-runtime.ts:ClockOptions.bodyCountsTick` **公开选项** | 唯一理由是 **autopilot 记账语义**，而 `autopilot-trajectory.ts` 已随 v1.35.0 整段退场 ⇒ **产线已是死选项**，但 `tests/**` 有 6 处显式传 `true`。**删（连测试一起改）还是留（当"历史语义"记录）？** |
| **C2** | `skiff-core.ts:liveReuseRef` 返回对象里的 `dispose: async () => {}` **空操作** | 它是 **`AgentHandle` 的必填成员**，而 `SkiffAgentRef` **不转发**它 ⇒ 全仓零调用。**删要动 `AgentHandle` 的类型必填性**（接口级裁决）。**降为可选（`dispose?`）还是保留？** |
| **C3** | **一批导出类型** —— 但**必须逐符号分档**（本会话在 ④ I2 上连续三次栽在"按文件整档划"，故此处逐条给证据）：<br>· 🔴 **真零引用（仅定义点）**：`cro-turns.ts:CroAgent`（grep 全仓**唯一命中 = 定义**）／ `clock-runtime.ts:Clock`（见 A3）<br>· ⚠️ **仍是活契约（不要动）**：`ccc.ts:AutopilotTrajectorySettings`（**被 `ccc.ts` 三处字段类型引用**）／ `ccc-roots.ts:ExecOrAgent`（`agentCwdFor`/`cccRootForExec` 的**入参类型**）／ `ListCccsOptions`（`listCccs` 的**入参类型**）／ `cro.ts` 的 `CroDeps`/`CroParseResult`/`CroRunResult`/`CroOutcome`（**全是导出函数的签名组成**）／ `wake-scheduler.ts:WakeSchedulerRuntime`（`wakeSchedulerState()` 的**返回类型**）<br>· ⇒ 🔵 **C3 其实只剩 2 个真候选**（`CroAgent` ／ `Clock`），其余**本就在 D 档（不是死代码）** | 🔵 **只需答这一句**：这 2 个导出类型**要不要收紧为模块内（不导出）**？<br>⚠️ **我不能确定仓外有没有消费者**（其它 CCC 的 CRO 程序 ／ 外部集成）—— grep 不到**不等于**没有。**若你有疑虑 ⇒ 我建议原样保留**（一个未导出的类型零成本） |
| **C4** | `FaceSpec.enabled` —— **四个面都声明，全仓只有一个读者**（`faceEnabled`，其唯一调用点 = `weixin-send-api.ts`） | 性质 = **迁移只做了一面**（另三面的装配层仍直接读设置）。**补齐迁移还是撤回该字段？**（删它要动类型必填性） |
| **C5** | `gateway.ts` 的 `enabled` **内联字面量**（无 spec 构造函数 ⇒ 对象从不外泄） | 与 C4 同族，但**硬性不可达**（连测试都取不到该对象）⇒ **单独处置：加注说明还是补一个 spec 构造函数让它可达？** |

---

## 4. D 档 = **退出候选**（**别再提**，已判"不是死代码"）

| 对象 | 为何不是 |
|---|---|
| `msm-ops.ts:MsmEntry` | **契约类型** —— 出现在两个**导出函数**的公开签名里（`loadMsmEntries` / `findEntry`）⇒ "仓内零消费者"只说明没人直接写这个名字 |
| `skiff-registry.ts` | **活代码** —— `skiff-core.ts` 显式 import 其 5 个函数，`seams/guards.ts` 直连 `skiffRoleFor` |
| `ccc-roots.ts` / `live-sessions.ts` 的 `Context` import | **真被用到**（已由 ④ I2 收敛逐符号查证） |
| `trajectory-bound.ts:ensureBindingsMigrated` | 见 §0 —— **有活调用点 ∧ 本就没导出** |
| 🆕 `ccc.ts:AutopilotTrajectorySettings` | **活契约** —— 被 `ccc.ts` **三处**用作字段类型（`:149`／`:151`／`:160`）⇒ 地图把它列进"零引用"是**只看名字没看位置** |
| 🆕 `ccc-roots.ts:ExecOrAgent` / `ListCccsOptions` | **活契约** —— 分别是 `agentCwdFor`/`cccRootForExec` 与 `listCccs` 的**入参类型** |
| 🆕 `cro.ts:CroDeps` / `CroParseResult` / `CroRunResult` / `CroOutcome` | **活契约** —— 全是**导出函数的签名组成**（`evaluateCro` ／ `parseCroOutput` ／ `renderCroOutcome`） |
| 🆕 `wake-scheduler.ts:WakeSchedulerRuntime` | **活契约** —— `wakeSchedulerState()` 的**返回类型**（⚠️ 它**未导出**，`container-status.ts:225` 的注释正是在说明这一点 ⇒ **该注释是准确的，不是过期**） |
| `invariant.ts` / `host/type-contract.ts` | 佐证齐全（tsdown 第二入口 ＋ `files` 含 `lib/invariant.js` ＋ `compliance.test.ts` 断言 ／ 靠 `tsconfig include` 参与 `tsc`） |

---

## 5. ⚠️ 一条**不属于本批**但相关的登记（顺带提醒）

**`SKILL_MISSING_MARK` 的导出面已被第 1 批收回** ⇒ 说明**第 1 批的判据（零引用 ∧ 非公开面）是有效的**。
🔵 因此本批**可以只用两个字回我**（"A 全删"之类），C 档再单独逐条答 —— 不必一次答完 20+ 条。

---

## 6. 执行方式（你拍完我怎么做）

1. A 档：**一批删 ＋ 一次门禁 ＋ 一笔提交**（D85 小步）；删完**跑全量**（`typecheck` ＋ `coverage` ＋ `build` ＋ `pack-check`，因碰 `src/**`）。
2. B 档：**只加注释**（不改行为）⇒ 同样一批一门禁。
3. C 档：**每条一个独立小提交**（改公开面 ⇒ 要能单独回滚）。
4. 全程**同批更新** `dsp-module-map.md` §3-7／§3-8（§6.2-4 要求）。
5. 🔴 **本批不发版**（D14：只有你具名才走发布链）。
