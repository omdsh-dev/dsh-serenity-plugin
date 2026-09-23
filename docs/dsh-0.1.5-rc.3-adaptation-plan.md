# DSH 0.1.5-rc.3 对 dsp（dsh-serenity-plugin）的适配评估

> 体裁对齐先例：`docs/dsh-0.1.5-rc-adaptation-plan.md`（rc.1 轮）。
> 本轮（S142，2026-09-23 20:4x）**只做取证与收口**，**不发布、不 deploy、不 restart-web、不安装**（owner 边界，照 rc.1 轮先例 ＋ D14）。

## 0. 摘要

| 项 | 结果 |
|---|---|
| **契约漂移** | 🟢 **零漂移** —— 19 服务 / 14 事件 / 2 工具缝在 rc.3 下与 rc.2 **同文件、同行号、同签名** |
| 类型面 | 🟢 `typecheck-host 0.1.5-rc.3` **两半 0 错**（node 载入 115 文件 / client 载入 103 文件） |
| 是否需改代码 | 🟢 **不需要** —— 适配工作收敛为**声明面与工具面三处收口**（§6） |
| 待 owner 裁 | 3 项（§6），**均非阻塞** |
| 🔴 **两条方法论发现** | 比上面的结论更重要：**解包不完整 ⇒「查不到」≠「被删除」**（§5-A）；**`skipLibCheck:true` ⇒ 绿 typecheck 比看上去弱**（§5-B） |

**一句话**：rc.3 对我们的契约面是**透明的**（没动我们依赖的任何东西）；本轮真正的产出不是"要改什么"，而是**"我们的取证方式有两处会骗人"**。

## 1. 需求与来源

- **owner 令**（2026-09-23 **20:32:37**，经微信由 zhaocai 转达）逐字：「**转S142 dsh发布了新的rc 开始进行适配工作**」。
  ⇒ 来源已回原始日志核实（`AGENT_SESSIONS/_weixin-logs/2026-09-23.jsonl` line 26 = incoming），**不是**跨轨迹猜测。
- **独立取证**（不采信转述）：dist-tags ⇒ **`latest = next = 0.1.5-rc.3`**、`alpha = 0.1.7-alpha.2`。
  ⇒ 所谓"新 rc" = **0.1.5-rc.3**，**仍是 0.1.5 线，不是大版本**。
- 本机安装仍 = **rc.2**（未装新版）；本仓 `REQUIRED_HOST_RANGE = '^0.1.5-rc.2'`（`src/host/contract.ts:293`）⇒ **rc.3 本来就在范围内**，`checkHostVersion('0.1.5-rc.3')` = **ok=true**（floor/ceiling 均过）。

## 2. 范围与边界

**做**：类型面 / 契约面 / 声明面 / 取证工具面（`host-fetch` 清单缺口）的取证与收口。

**不做**：发布 / deploy / `restart-web` / 本机安装 rc.3（**等 owner 令**）。

**未触发**：观察项 15（PTC / 前缀缓存破点）—— 其触发条件是"**下一个 DSH 大版本**"，而 rc.3 **与 rc.2 同线**。

## 3. 取证方法与正控

1. `msm dsh-develop host-fetch 0.1.5-rc.3` ⇒ 解包副本 `_tmp/host-0.1.5-rc.3/`（可 `read`/`grep`/`glob` 直读）。
2. `msm dsh-develop typecheck-host 0.1.5-rc.3` ⇒ 派生两份 tsconfig（node / client），**paths 36 / 14 条全部命中**、**实测载入解包宿主 115 / 103 个文件** ⇒ 两半 **0 类型错误**。
3. 对已解包宿主的**逐条契约对账**（rc.2 ↔ rc.3 双向）。

**正控（证明读数器不瞎）**：
- 工具侧：`paths 命中数` ＋ `实测载入文件数` 是 `typecheck-host` **自带的防假绿设计**（静默回落会被它挡下）。
- 对账侧：**同一棵树上的配对测量** —— 同一检索词在 rc.3 有命中（读数器工作），而包目录 glob 在该树 0 命中、在 rc.2 树 13 命中 ⇒ 才使"缺失"成为一个**测量**而非"我没找到"。另加**无意义符号对照 = 0 命中**。

## 4. 契约对账结果（rc.2 ↔ rc.3）

| 面 | 基数 | 结果 |
|---|---|---|
| `HOST_SERVICES`（`src/host/contract.ts` L49–235） | **19** | 🟢 **19/19 存活**，成员签名逐条同文件同行号 |
| `HOST_EVENT_NAMES`（L253–268，`satisfies readonly (keyof Events)[]`） | **14** | 🟢 **14/14 存活** |
| 工具缝 | **2** | 🟢 `tools/pre-execute`（`seams/guards.ts`，required）/ `tools/post-execute`（`seams/keeper.ts`）**payload 逐字相同** |
| 第二声明面 `src/host/type-contract.ts`（303 行，40+ 编译期 `Expect<Extends<…>>` 门 ＋ 17 处 `import type {}` 增强） | — | 🟢 rc.3 下同样通过 |

**依赖 pin 对账**：

| 规格 | 本仓声明 | rc.3 宿主 pin | 判定 |
|---|---|---|---|
| `@deepseek-ai/cordis` | `^4.0.2`（peer+dev） | **4.0.2** | ✓ 满足 |
| `@deepseek-ai/schemastery` | `^3.18.2`（peer+dev） | **3.18.2** | ✓ 满足 |
| 裸 `cordis` | `^4.0.0-rc.7`（peer） | 两版解包里**都无此包** | 🟢 **解释**：`tsconfig.json:73-74` 把 `"cordis"` 与 `"@deepseek-ai/cordis"` **映射到同一实体**（声明合并的前提）⇒ 非风险 |
| 宿主包范围 | 17 × `@deepseek-ai/dsh-*: ^0.1.5-rc.2` | 全 `0.1.5-rc.3` | 仅**标签**落后（§6-1） |

⚠️ **作用域限定**：以上结论**只覆盖"已解包的宿主包集合"**，见 §5-A。

## 5. 两条方法论发现（本轮真正的产出）

### 5-A 解包不完整 ⇒「查不到」不能读成「被删除」

- **事实**：rc.3 解包 **38 → 39 包**（本轮补抓后），rc.2 解包 **47 包**；rc.3 的包集合是 rc.2 的**真子集**。
  9 个 rc.2-only 包：`dsh`、`dsh-app-boot`、`dsh-client-store`、`dsh-client-ui-layout`、`dsh-client-ui-workspace`、`dsh-cordis-client-runner`、`dsh-plugin-package-inventory-deepseek`、`dsh-settings-file`、**`dsh-storage-domain`**。
- **`storageDomain` 一度"查不到"** —— 但 rc.3 **自己的消费者仍在用它**：
  `_tmp/host-0.1.5-rc.3/@deepseek-ai/dsh-workspace/lib/index.js:314` ⇒ `static inject = ["storageDomain", "sessionPersistence"];`
  同文件 `:337` ⇒ `const domain = await this.ctx.storageDomain.open(workspaceDomainSpec);`
  同包 `package.json:45` ⇒ `"@deepseek-ai/dsh-storage-domain": "^0.1.5-rc.3"`
  ⇒ 若按"查不到 = 被删"下结论，得到的是一条**假警报**。（且该服务我们注册为 `required:false`，真实后果最多是**降级**，不是中断。）
- ✅ **本轮已收口**：显式补抓 `@deepseek-ai/dsh-storage-domain@0.1.5-rc.3` ⇒ `解包 1 / 跳过 29 / 失败 0`，复读其 `lib/types/index.d.ts`：
  `L27` `storageDomain: DomainFacility;` ／ `L83` `open<S extends DomainSpec>(spec: S): Promise<Domain<S>>;` —— 与 rc.2 **同文件、同行号** ⇒ **19/19 服务全部确认**。
- 🔵 **可复用判据**：**在"解包副本"上做任何存在性结论之前，必须先证明该副本是全集**；证明不了，结论就必须**带上作用域**（本轮即如此书写）。

### 5-B `skipLibCheck: true` 让"绿 typecheck"比看上去弱

- **事实**：派生配置 `tsconfig.host-0.1.5-rc.3.local.json:14` = **`"skipLibCheck": true`** ⇒ **宿主 `.d.ts` 内部的错误被抑制**。
- **后果**：绿 typecheck **不证明解包完整、也不证明宿主类型全部可解析** —— 缺包那件事正是这样隐身的；且 `dsh-workspace` 的 rc.3 **类型面里根本没有 `storageDomain` 字符串**（该依赖只活在运行时 `.js` 的 `static inject`）。
- 🔵 **配套判据**：审**运行时型**契约时**不得按扩展名过滤**（本轮审计一度限定 `.d.ts`，把证据藏掉了，改无过滤后才显形）。
- **待裁**：是否对宿主适配面的 typecheck **关掉 `skipLibCheck`**（见 §6-2）。

## 6. 待裁三项（均非阻塞）

| # | 事项 | 它用来干什么（白话） | 倾向 |
|---|---|---|---|
| 1 | **声明面 pin 是否升到 `^0.1.5-rc.3`** | 现在写 rc.2 也能过门禁（rc.3 在范围内），只是**标签比实际旧**；升了才能"证明我们认证过 rc.3" | 升；与 `package.json` 的 17 处同批（三处一致纪律） |
| 2 | **是否关掉宿主适配面的 `skipLibCheck`** | 关掉后，"解包缺包/宿主类型坏掉"这类事**不会再静默通过** | 倾向关（代价 = 宿主 `.d.ts` 自身噪声会进门禁） |
| 3 | **`host-fetch` 清单缺口是否修** | 它的清单**只取 peerDependencies** ⇒ 漏 devDeps 包、漏非 `dsh-*` 前缀 peer ⇒ **每轮都要手工补包**（本轮又补了一次） | 修：并入 devDeps（同前缀过滤）＋ 非 `dsh-*` peer 用**宿主 manifest 的 pin 版本** |

## 7. 附带发现（低危，登记）

1. 🔴 **`contract.ts:336` 的预发布比较是字典序**（`ra < rb ? -1 : 1`）⇒ 对 rc.2↔rc.3 正确，但 **rc.9 vs rc.10 会判反**。**下一次 rc 跳号时咬人**，非本轮漂移。
2. **`host-fetch` 的自报计数与磁盘不一致**：它印「**30 个包**」，而磁盘实有 **39** 个 ⇒ 它的计数器**只反映自己的清单**，不反映实际解包（这正是缺口 3 的表征）。
3. rc.3 的 `dsh-workspace/package.json` 把 `dsh-storage-json` 从 peer 列表里去掉（rc.3 的 `dsh-subagent` / `dsh-api-session-controller` 仍有）—— 该包**不是我们消费的服务**，仅登记。

## 8. 未验证边界（诚实声明）

- **运行态行为未验**：只读了类型声明与调用点，**没有执行任何宿主**。⇒「签名相同」**≠**「行为相同」。
- **rc.3 是否"新增"了本插件应当消费的服务/事件，未审** —— 本轮是**漂移审计**，不是**机会审计**。
- **9 个 rc.2-only 包的 client 半漂移未审**；`dsh-client-ui-*` 只验了我们 tsconfig 映射到的那些。
- **解包仍非全集**：本轮只把**我们声明面用到的那一个**缺包补上（`dsh-storage-domain`），其余 8 个 rc.2-only 包在 rc.3 侧仍未解包。
- 🔴 **`AI_LAB/dsh-harness-public` 不能作为 rc.3 的证据**：它是 `@deepseek-ai/dsh-root` **v0.1.2-rc.1**（比 rc.2 / rc.3 **都旧**），且是**源码树**（`packages/<group>/<pkg>`）而非解包发行物。

## 9. 验收判据

| # | 判据 |
|---|---|
| V1 | `typecheck`（本机 rc.2 基线）通过 |
| V2 | `typecheck-host 0.1.5-rc.3` **两半 0 错**，且 paths 命中数 ＋ 载入文件数非零（防假绿） |
| V3 | 契约对账 **19/19 服务 ＋ 14/14 事件 ＋ 2/2 缝** |
| V4 | 若采纳 §6-1：**三处一致**（`contract.ts` / `package.json` / 文案面） |
| V5 | 本轮**不发布、不 deploy、不 restart-web、不安装** |
