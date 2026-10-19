# Skiff 重做：skiff 是「带 `skiff.json` 的认知轨迹」

- 状态：施工中（owner 2026-10-19 执行令）
- 归属：ACC（机制）｜配置内容归 CCC（`skiff.json` 与 `serenity.json`）
- 前身文档：`skiff-design.md`／`skiff-trajectory-bound-mode-design.md`／`skiff-bound-trajectory-design.md`（均为**旧模型**，本文件取代其判定部分）

---

## 0. owner 原话（设计的唯一依据，逐字）

> 「在微信桥 skiff 这个事情上，为了贯彻**认知轨迹是一等公民**这个情况，我觉得需要**重做**；
> skiff 复杂的约束和提示词体系都干掉，改为这样的实现：
> **skiff 本身是认知轨迹的一个特殊情况，即目录下拥有 `skiff.json` 的认知轨迹自动是一个 skiff**
> （json 里配置上个版本就有的各种约束），**会话跑在认知轨迹上且发现 `skiff.json`，则运行时实现各类约束**；
> **微信桥的路由表修改为 user → 认知轨迹的映射**；
> **认知轨迹固定唯一标识规则，固定为目录中的固定位置编码**；
> 然后，**认知轨迹允许用户指定这个编码**（在约束范围内，不得包含中文）；
> 这个实现应当就彻底打通整个机制了，同时理解难度大幅下降」

> 「在这个玩法下，**微信桥要做的就是，新建认知轨迹，定义为 skiff，然后绑定到微信的某个 account 即可**」

A/B 案：owner 2026-10-19 追加执行令 → 按 **B 案** 做（编码即唯一标识、可指定；`TRAJECTORY-UID` 退役但**保留只读兼容**）。

---

## 1. 一条判据取代四条（本方案的全部目的）

| 项 | 旧模型 | 新模型 |
|---|---|---|
| skiff 是什么 | `serenity.json` 的 `skiff.roles.<name>` 里的一条配置 | **目录下有 `skiff.json` 的认知轨迹** |
| 怎么认出 skiff 会话 | dsh sessionId 前缀 `skiff-` | **该会话绑定的轨迹有 `skiff.json`** |
| 身份唯一标识 | `S###`（不可指定）＋ `TRAJECTORY-UID`（可选文件）**二元** | **编码 = 唯一标识**，住目录名固定位置，**可指定** |
| 工作台从哪来 | `ensureSkiffSession` **自动新建一个** SESSION（与角色分离） | **就是该轨迹自己的 SESSION.md**（无需新建） |
| 微信路由 | `user → role 名` | `user → 认知轨迹（编码）` |

**EAP 收益**：四条各自会漂的机制（roles 配置 / id 前缀 / UID 文件 / 工作台自动创建）收敛为 **一条判据**（「绑定轨迹有没有 `skiff.json`」）。这是「理解难度大幅下降」的实际内容。

---

## 2. 判据表（可机械复算）

| # | 判据 | 落点 | 复算方式 |
|---|---|---|---|
| **J1** | skiff 性 = **轨迹目录内有 `skiff.json`** | `role/skiff/config.ts` `readSkiffProfileAt()` | 删掉该文件 ⇒ 同一条轨迹立刻退化为普通轨迹（工具面、提示词、keeper 全部按普通轨迹） |
| **J2** | 会话是否 skiff = **其绑定轨迹有 `skiff.json`**，唯一入口 `skiffProfileForSession(root, sessionId)` | 同上 | 真机：给一条普通轨迹加 `skiff.json` ⇒ 该会话下一 step 起工具面收窄（`syncSkiffRoleToolVisibility` 每 step 幂等重算） |
| **J3** | 绑定尚未落盘时的窗口期由 **内存注册表** 兜（`sessionId → (root, dirName)`） | `role/skiff/registry.ts` | 冷启动后注册表为空 ⇒ 但绑定已持久化 ⇒ J2 仍成立（不依赖注册表存活） |
| **J4** | 编码 = 目录名 `YYYY-MM-DD--<code>[--<desc>]` 中 `<code>` 段 | `trajectory/core.ts` `parseTrajectoryCode()` | 对全部存量目录跑一遍，逐条对读 |
| **J5** | 编码形态 = `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` **且不含 `--`** | `isValidTrajectoryCode()` | `S142` ✓ ／ `某中文` ✗（中文） ／ `a--b` ✗（会打断目录名解析） |
| **J6** | 编码唯一性 = **写入侧**保证（跨全部活跃轨迹） | `createSession` | 重复即抛错，不静默 |
| **J7** | `TRAJECTORY-UID`：**读保留、写退役** | `readTrajectoryUid` 保留；`setTrajectoryUid` 删除 | 存量 `S142/TRAJECTORY-UID`（`serenity-acc-maintainer`）仍可 `show --name serenity-acc-maintainer` 解析；`uid --uid X` 抛「已退役」 |
| **J8** | 解析顺序 = 目录名精确 → **编码精确** → **UID 精确（遗留只读）** → 唯一模糊 | `findSession()` | ⚠️ 编码前置会让"以前靠 UID 命中、现在编码恰好同名"的输入改判 —— 本仓不存在该形态（唯一 UID 属 S142，编码 `S142`） |
| **J9** | 微信路由 = `(account, user) → (CCC, 轨迹)` | `im/route.ts`／`im/inbound.ts` | 路由命中但轨迹不存在 ⇒ **响亮报错 + 不投递**（沿用三档语义，不退化） |
| **J10** | skiff 的 dsh 会话 id **由轨迹决定**（不再是 user 哈希） | `skiffSessionIdFor(root, code)` | 同一轨迹换用户 ⇒ 同一条 dsh 会话（这正是"轨迹是一等公民"）；换轨迹 ⇒ 新会话 |
| **J11** | 「载体没了就该换身份」不再需要换代计数器 | 删 `.weixin-session-gen.json` | 轨迹被归档 ⇒ 路由解析不到 ⇒ 走 J9 的「目标不存在」档（响亮），而不是静默 resume 旧 log |

### 2.1 为什么 J10 可以丢掉 `.weixin-session-gen.json`

旧计数器存在的**唯一理由**：dsh sessionId 绑在「用户哈希」上，而工作台可能被归档 ⇒ 载体没了但身份还在 ⇒ 只能靠 `-g<n>` 换代续命。
新模型里 **身份 = 轨迹**：轨迹没了 ⇒ 没有身份 ⇒ 该报错就报错。⇒ 计数器**整件删除**（它是旧模型的补丁，不是通用机制）。

---

## 3. `skiff.json` 形态

位置：`AGENT_SESSIONS/<轨迹目录>/skiff.json`（固定名，与 `SESSION.md` 同级）。

```json
{
  "model": "minimax-cn/MiniMax-M3.1-Flash-Preview",
  "tools": ["read", "grep", "msm", "cognitive_trajectory"],
  "msms": ["memory-tool", "session-write"],
  "cognitiveTrajectory": { "session": true, "keeper": true, "rebuild": true },
  "systemPromptFile": ".opencode/skiff/zhaocai.md"
}
```

| 键 | 语义 | 缺省 |
|---|---|---|
| `model` | 该轨迹会话用的模型（`provider/model`） | 回退 `cheap-worker.defaultModel` |
| `tools` | 工具白名单（白名单外**从 schema 移除**，不是"看得见调不动"） | `[]` ⇒ 只有 `msm` 通道 |
| `msms` | MSM 白名单（`msm()` 单入口内再过滤） | `[]` |
| `cognitiveTrajectory.session/keeper/rebuild` | 轨迹纪律参与项 | **全 true**（见下） |
| `systemPrompt` ／ `systemPromptFile` | 角色人格；`File` 优先（相对 CCC 根，改文件即热生效） | 空 ⇒ 只有 `buildSkiffBasePrompt` |

### 3.1 一处**有意的语义翻转**（R↓）

`cognitiveTrajectory.*` 在旧模型里**缺省全 false**（「skiff 完全独立」），理由是**它的工作台是外挂的**（`ensureSkiffSession` 另建一个 SESSION）。
新模型里**工作台就是它自己的 SESSION.md** ⇒ false 会让它拿不到自己的身体 ⇒ **缺省翻成 true**。

⇒ 这不是"顺手改默认值"，是两个模型的结构差：**旧模型需要隔离，新模型的主体性来自轨迹本身。**

### 3.2 `kind`（temporary/persistent）**删除**

旧 `kind` 区分「有没有工作台」。新模型里 skiff 恒等于一条轨迹 ⇒ 恒有 SESSION.md ⇒ 该区分**没有指称对象**。旧配置里残留 `kind` ⇒ 静默忽略。

---

## 4. 施工分期（每期可独立验证）

| 期 | 内容 | 验证 |
|---|---|---|
| **P1** | 编码即身份：`create --id`、`parseTrajectoryCode`、`findSession` 顺序、UID 只读化 | `trajectory-ops` 全绿 ＋ 新测 `trajectory-code.test.ts` |
| **P2** | `skiff.json` 读取层 ＋ `skiffProfileForSession` 单一判据 ＋ 注册表扩为 `(root, dirName)` | 新测 `skiff-profile.test.ts` |
| **P3** | 约束接线换判据：guards ／ context ／ compact ／ system-prompt ／ bootstrap ／ keeper ／ lifecycle | 既有 skiff 套件改真配置（写 `skiff.json` 而非 `serenity.json`）后全绿 |
| **P4** | 微信桥：路由 `user→轨迹`；会话 id 由轨迹派生；**删 `ensureSkiffSession` / 换代计数器** | `weixin*` 套件全绿 ＋ 新测"轨迹缺失 ⇒ 不投递且响亮" |
| **P5** | 调试页 ＋ `container_admin role` 数据源改扫轨迹 | `skiff-debug*` / `skiff-admin` 全绿 |
| **P6** | `serenity.json` `skiff` 段退役（类型删除）＋ 机器级 `humanChannel.subscriptions` 增 `trajectory`（`role` 过渡读别名） | `ccc` / `human-channel-*` 全绿 |
| **P7** | CCC 侧迁移（新轨迹 ＋ `skiff.json` ＋ 路由改写） | 真机：微信发一条 ⇒ 该角色正常答；`dashboard health` 见 `skiff.json` |
| **P8** | 发布链：bump → 六项门禁 → 提交 → 双推 → publish → `npm-install web` → `restart-web` | 真机 `accVersion` 与横幅一致 |

---

## 5. 迁移（CCC 侧，幂等且可回滚）

> ⚠️ 下文示例一律用**通用占位**（`<role>` / `<code>`）—— 具体角色名与编码是某个 CCC 的数据，
> 不进本仓公开面（`privacy-scan` 的 `role-name-*` 规则；D145）。

### 5.1 步骤

1. **备份**：`_tmp/skiff-migration-backup-<ts>/` 存 `serenity.json` ＋ 旧绑定表快照。
2. `cognitive_trajectory create --id <code> --desc <desc> --summary …` ⇒ 新轨迹 `YYYY-MM-DD--<code>--<desc>`。
3. 把旧 `skiff.roles.<role>` 的 `model/tools/msms/cognitiveTrajectory/systemPromptFile` 原样写进该轨迹 `skiff.json`（`kind` 丢弃）。
4. **继承身体**：把该角色旧工作台的 `SESSION.md` 复制过来，并在 §日志 追加一行迁移记录（Ship of Theseus：**载体换了，身体延续**）。
5. `serenity.json`：删 `skiff` 段；`weixin.routes[0]` 的 `role: "<role>"` → `trajectory: "<code>"`。
6. 旧工作台目录**原样保留**（退化为普通轨迹，历史不丢）。

### 5.2 幂等与回滚判据

- **幂等**：`create --id <code>` 在已存在时**抛错**（J6）⇒ 重跑不会造第二个；迁移脚本据此判"已迁移"。
- **回滚三步**：① 把备份的 `serenity.json` 写回；② `container_fs mv` 把 `skiff.json` 移出轨迹目录（J1 ⇒ 立刻不再是 skiff）；③ 删新轨迹目录。
  ⚠️ 回滚后 dsh 会话 id 回到旧派生 ⇒ 旧 dsh 会话仍在磁盘 ⇒ 回到迁移前的对话。
- **回滚边界（如实）**：`TRAJECTORY-UID` 的**写入**能力不因回滚恢复（代码已删）；但既有 UID 文件仍被读取，指认能力不变。

---

## 6. 测试面

| 面 | 判据 |
|---|---|
| **编码即身份** | `create --id X` ⇒ 目录名第二段 = X；重复 X 抛错；中文/含 `--` 被拒；`findSession('X')` 精确命中 |
| **UID 只读兼容** | 存量 UID 文件仍可解析；`uid --uid Y` 抛「已退役」并给可行动指引；读路径不因退役而抛错 |
| **skiff 判据** | 无 `skiff.json` ⇒ `skiffProfileForSession` 返回 null 且工具面**零收窄**；有 ⇒ 收窄到白名单；删掉 ⇒ 立刻恢复（J1 正反控） |
| **会话身份** | 同一轨迹、两个微信用户 ⇒ **同一条** dsh sessionId；轨迹归档 ⇒ 路由响亮报错、不投递 |
| **路由** | `trajectory` 命中 ⇒ 投递；未命中 ⇒ 三档语义逐条验；旧 `role` 字段仍能读（过渡别名） |
| **负控**（必做） | 每条新判据都要有一个「实现改回旧行为 ⇒ 该用例必须红」的形态；否则该用例不承重 |

**门禁**：typecheck ／ typecheck-host ／ test ／ coverage ／ build ／ pack-check 六项 ＋ `container_admin msm check`（CCC 侧不动）。

---

## 7. 边界（明确不做）

| 不做 | 理由 |
|---|---|
| 编码**事后改名** | 本次只做「创建时指定」。事后改名要动目录名 + 全部绑定，自有其风险面 ⇒ 单列后续件 |
| `TRAJECTORY-UID` 文件**物理删除** | 只读兼容要求它还在（S142 的 `serenity-acc-maintainer` 仍要能解析） |
| 机器级 `humanChannel.subscriptions` 的 `role` 字段**移除** | 过渡读别名保留；移除条件 = 所有 CCC 的路由表都改写完成且真机跑过一轮 |
| skiff 的 `skiff-log`／`_skiff-logs/` 存储结构 | 与本方案正交（那是 CCC 的记录面） |
| 微信桥的「多账号」语义 | 不变 |

---

## 8. 熵账（本方案减掉的机制条目）

删：`skiff.roles` 配置段 ／ `SKIFF_SESSION_PREFIX` 判定 ／ `ensureSkiffSession` 自动建工作台 ／ `.weixin-session-gen.json` 换代计数器 ／ `weixinSessionIdFor` 用户哈希身份 ／ `TRAJECTORY-UID` 写入路径 ／ `kind: temporary|persistent` ／ `setTrajectoryUid`。

增：`skiff.json` 读取层（一个文件）＋ `skiffProfileForSession`（一个函数）＋ `create --id`（一个参数）＋ `parseTrajectoryCode`（一个纯函数）。

⇒ **净减**。这是"理解难度下降"可被数出来的形态。
