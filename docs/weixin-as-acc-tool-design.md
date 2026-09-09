# 方案：把「微信发送」升为 ACC 工具（`weixin`）——配置了微信桥才可见

- 状态：**v0.1 待拍板**（2026-09-09，S142）
- 触发：用户原话——「既然微信桥是我们 ACC 提供的，那么 `weixin-send` 应该是我们 ACC 提供的能力，当用户配置了微信桥则可用，不配置则不可见，按照这个思路出个方案」
- 关联：D23（内容归属判据：**ACC 管机制与数据，CCC 管措辞与纪律**）｜D12/工具面评估（维持 10 工具）｜v1.30.9（主动发送通道 A2）｜v1.30.16（机械闸门）｜v1.30.17（兜底）

---

## 1. 需求解构（E↑）

| # | 需求 | 判据（可验收） |
|---|------|--------------|
| R1 | **归属**：微信发送是 ACC 能力，不是 CCC 能力 | 发送机制/凭据/账号/记录**只在 ACC** 实现；CCC 不再持有发送协议代码 |
| R2 | **条件可见**：CCC 配了微信桥 → 该能力可用；没配 → **不可见**（不是"可见但报错"） | 未配置 CCC 的 agent 工具清单里**没有**该工具（`tools.restrict` 隐藏，非 guard deny） |
| R3 | **零改 DSH** | 只用文档化扩展点：`ctx.tools.register` / `agent.ctx.tools.restrict` / 既有事件 |
| R4 | **记录单一真相源** | 任何路径发送都经 `sendProactiveText` → outgoing hook（`_weixin-logs` 有原文） |
| R5 | **不牺牲现有能力** | `send` / `send-file` / `users` / 别名解析 / 多账号全部保留 |
| R6 | **不抬高未配置 CCC 的成本** | 未配置 CCC 的工具面与 token 成本**零变化**（无 schema 常驻） |

---

## 2. 现状实证（读后写；全部为源码/日志实证）

| # | 事实 | 位置 |
|---|------|------|
| S1 | 发送机制已在 ACC：`sendProactiveText({root,toUserId,text,accountId?})` → iLink `sendmessage` → outgoing hook（`source:'proactive'`）；失败返回稳定 code（`BRIDGE_DISABLED`/`NO_ACCOUNT`/`ACCOUNT_NOT_FOUND`/`ACCOUNT_NOT_BOUND`/`SEND_FAILED`） | `src/weixin-bridge.ts:461-507` |
| S2 | ACC 已有一个**只绑 loopback** 的 HTTP 面（默认 3082，plugin 全局 `weixinApi.port`）给 CCC MSM 调用；含 `parseSendRequest`/`matchCcc`/`isLoopbackAddress` | `src/weixin-send-api.ts` |
| S3 | 入口地址经环境变量注入 MSM：`SERENITY_WEIXIN_API` | `src/msm-ops.ts` `buildMsmEnv`、`src/weixin-send-endpoint.ts` |
| S4 | **CCC 侧持有一份发送实现**：`.opencode/skills/home-serenity/scripts/weixin-send.ts`（689 行）——`send`/`test` 走 3082；`send-file` **直连 iLink**（`getuploadurl` + CDN AES-128-ECB 上传）并自己补记 hook；`users` 读 CCC localstore 别名 | CCC 仓 |
| S5 | 工具面 10 个，**全局注册**在 `apply()` 里 | `src/index.ts:129-140` |
| S6 | **条件可见机制已存在且有先例**：`agent.ctx.tools.restrict({deny:[…]})` 按 agent scope 隐藏全局工具；safe-mode 用它隐藏写工具，并在 `agent/session-start` + `agent/pre-step` 每步同步（可热切换、有 disposer 与诊断落盘） | `src/seams/guards.ts:266-295`、`src/seams/context.ts:214/219/241` |
| S7 | 宿主契约：`tools.register(definition)` 全局或 scoped 注册；`tools.restrict({allow?,deny?})` **必须 scoped**、名字必须已在全局层已知、限制可叠加且有 disposer | `dsh-harness-public/packages/core/tools/src/index.ts:1022-1089` |
| S8 | **按 agent 解析 CCC 根的既有办法**：`findSerenityRoot(agent.session.header.cwd)`（guard 每个 exec 都这么做） | `src/seams/guards.ts:214-217, 336-337` |
| S9 | 手动输出标记与闸门目前**只认 MSM 形态**：标记文本 = `msm("weixin-send", …)`；闸门成功判定 = 工具名 `msm` 且首参 `weixin-send` | `src/weixin-bridge.ts:154-159`、`src/weixin-output-guard.ts:78-85` |
| S10 | skiff 角色白名单在 guard 层强制（不在 `restrict`）：白名单外 deny；命中 `msms` 清单但直接调用 → 明确提示走 `msm()` | `src/seams/guards.ts:138-158` |
| S11 | v1.30.9 的当时决策是「**ACC 不新增工具**，只多一个本机 HTTP 面」——本方案即对该决策的修订（用户新洞察） | `src/weixin-send-api.ts:9` |

---

## 3. 设计原则

1. **归属（R1/D23）**：协议、账号选择、凭据解析、别名解析、发送、记录 → ACC；CCC 只保留「什么时候发、发什么、用什么措辞」。
2. **可见性 = 配置的函数（R2）**：`weixin.enabled === true` 且 agent 的 ccc 根解析成功 → 可见；否则**从该 agent 的工具清单中移除**（`restrict` 隐藏，非 deny）。
3. **通道单一真相源（R4）**：工具 → `sendProactiveText`（进程内直调，**不经 3082 HTTP**）；3082 保留给**非 agent 调用者**（CCC 脚本/cron/跨 CCC）。
4. **零成本缺省（R6）**：未配置 CCC 不付任何 token/schema 成本。

---

## 4. 方案

### 4.1 推荐方案 A：全局注册 + 按 agent 条件隐藏（复用 safe-mode 同款机制）

```
apply()
 ├─ ctx.tools.register(weixinTool)          // 全局注册（10 → 11）
 └─ seams/context.ts 每个 agent 的同步点
      └─ syncWeixinToolVisibility(agent, root)
           ├─ root = findSerenityRoot(agent.session.header.cwd)     // S8
           ├─ visible = readWeixinSettings(root).enabled === true   // 配置即判据
           └─ !visible → agent.ctx.tools.restrict({ deny: ['weixin'] })   // S6/S7
              （可见 → 解除本会话的 deny；Map<sessionId, disposer> + 会话销毁清理）
```

- **同步时机**：与 `syncSafeModeRestriction` 同点（`agent/session-start` + `agent/pre-step`）→ 面板改配置后**下一轮即生效**，无需重启。
- **配置读取成本**：按 `(root, mtime, size)` 记忆化（复用 v1.30.15 角色提示词读取器的做法），pre-step 命中零 IO。
- **为什么不是 guard deny**：用户要「不可见」。deny 会让模型看到工具再被拒（还会诱发重试）；`restrict` 让它**不在 schema 里**。
- **为什么不是 scoped 注册**（备选 B，见 4.2）：scoped 注册需要为每个 agent 复制 schema、并随 agent 销毁逐 scope 拆卸；`restrict` 是宿主为「按 scope 收窄全局工具」提供的正是这条缝（S7），且 safe-mode 已有生产先例。

### 4.2 备选（记录理由，不采纳）

| 备选 | 形态 | 不采纳理由 |
|------|------|-----------|
| **B scoped 注册** | 在每个「已配置」agent 的 scope 里 `agent.ctx.tools.register(weixinTool)` | 语义最纯（能力只存在于存在处），但每 agent 一份注册 + 生命周期拆卸更复杂；HMR/会话销毁路径增多。**若未来要按「角色级」差异化 schema，再回来看这条** |
| **C 全局开关** | 只要**任一** CCC 配了桥就注册，全进程可见 | 不满足 R2（未配置 CCC 也会看到） |
| **D ACC 侧 MSM** | ACC 把发送脚本投放到 CCC 的 MSM 注册表 | 仍是间接调用（模型要先会 `msm()`），且把 ACC 机制降级成 CCC 资产；不解决 R1 |
| **E 维持现状** | 只有 CCC MSM | 与用户洞察相反（R1 不满足）；且模型在 `msm("weixin-send", …)` 形态上实测不遵循（见 §6） |

### 4.3 工具接口（接口层）

**名称**（待拍板 Q1）：

| 候选 | 优点 | 代价 |
|------|------|------|
| **`weixin`**（推荐） | 与 `container_fs`/`container_git`/`logbook` 家族一致；一个工具承载 send/send-file/users/status，后续吸收 `send-file` 不再加工具 | 名字偏泛（需靠 description 说清） |
| `weixin_send` | 单动作最直白，与现有 MSM 名一一对应 | 将来加 `send-file` 时要么再开工具、要么改名 |
| `weixin-send` | 与现有 MSM 名逐字一致（迁移零认知成本） | 与 ACC 现有 snake_case 命名不一致；PTC/Python 侧需引号访问（S7 注释提到 exotic 名） |

**参数（推荐形态）**：

```jsonc
{
  "action": "send" | "send-file" | "users" | "status",   // 必填
  "user":   "<别名 yh|danica 或 iLink from_user_id>",     // send/send-file 必填
  "text":   "<纯文本，≤4000 字>",                          // send 必填
  "file":   "<CCC 内相对路径>",                            // send-file 必填
  "caption":"<可选说明>",                                  // send-file 可选
  "account":"<账号 id，缺省=该 CCC 首个启用且已绑定账号>",   // 可选
  "ccc":    "<CCC 名称|绝对路径，缺省=本会话 CCC>"           // 可选（见 Q2）
}
```

**返回**：成功 `{ ok: true, accountId, userId, sessionId, role }`；失败 `{ ok: false, code, error, remediation? }`，code 复用 S1 的 5 个 + 新增 `ALIAS_UNKNOWN`（别名未登记）/ `FILE_NOT_FOUND` / `FILE_TOO_LARGE` / `TEXT_TOO_LONG` / `CCC_UNRESOLVED`。

**description 写法**（model-facing，来自模型视角）：一句话说明「给微信用户发消息（家人），发出即记录；未配置微信桥的容器看不到本工具」。

### 4.4 与现有件的关系（迁移）

| 现有件 | 处置 | 理由 |
|--------|------|------|
| `weixin-bridge.sendProactiveText` | **不动**，成为工具的唯一实现 | R4 单一真相源 |
| 3082 HTTP 入口（S2） | **保留** | 非 agent 调用者（CCC 脚本/cron/跨 CCC）仍需要；工具走进程内直调 |
| CCC MSM `weixin-send`（S4） | **阶段 1 保留**（兼容），`send`/`test`/`users` 变为可选通道；**阶段 2 吸收 `send-file` 到工具**；阶段 3 视使用情况退役 | 避免一刀切破坏现有脚本与 autopilot 提示词 |
| 手动输出标记（S9） | 文本改为**工具调用形态**（`weixin({action:"send", user:"<id>", text:"<回复>"})`）；闸门成功判定**同时认** MSM 与工具 | 标记是 ACC 机制+数据；工具在手动模式下必然可见（手动模式 ⇒ 桥已配置） |
| `weixin-output-guard.isSuccessfulWeixinSend`（S9） | 扩展为「`msm`+`weixin-send` **或** `weixin` 工具且 action ∈ {send, send-file} 且未报错」 | 迁移期两条通道都算送达 |
| skiff 角色白名单（S10） | zhaocai 的 `tools` 加 `weixin`；`msms` 里的 `weixin-send` 暂时保留 | 白名单仍由 guard 强制（工具可见性由 restrict 管，两者互补） |
| CCC 提示词 `.opencode/skiff/zhaocai.md` | §0/§3/§4 的调用示例改为工具形态（**措辞仍归 CCC**） | D23 边界不变 |
| specs（ACC 标准） | 工具最小公共集 10 → 11（附「条件可见」语义）；osp 侧对齐列入 P6 | 标准与实现同源 |

### 4.5 收益与风险

**收益**
1. 归属正确（R1）：CCC 不再持有 iLink 协议/AES 上传/凭据解析代码，`weixin-send.ts` 可缩到兼容壳。
2. 可见性即配置（R2）：未配置 CCC 的工具面与 token 成本零变化（R6）。
3. **模型遵循度假设（可测）**：直调工具比 `msm("weixin-send", […])` 少一层间接。实测证据：某模型在 `msm` 形态上对寒暄消息 4 连败（跨 3 版提示词），而**任务类消息**下能正确调用——换成直调工具后是否改善，**上线后一轮微信实测即可判定**（不预判为结论）。
4. 一条进程内路径（少一跳 HTTP），失败码/记录路径不变。

**风险**
1. 工具面 10 → 11：**仅对已配置 CCC 生效**；对未配置 CCC 仍是 10（R6 保证）。
2. 两条通道并存期（工具 + MSM）→ 文档必须写清「agent 用工具 / 非 agent 用 MSM」，否则认知冗余。
3. `restrict` 的失败路径：名字未知会抛错（S7）→ 必须在 `register` 之后、且失败**不阻断装配**（沿用 safe-mode 的「限制失败不阻断，guard 仍兜底」写法，S6）。
4. 跨 CCC 发送的 `ccc` 语义若隐式化，可能误发（见 Q2）。

---

## 5. 测试与验证计划

| 层 | 用例 |
|----|------|
| 纯函数 | `shouldExposeWeixinTool({enabled, rootResolved})` 四态矩阵；`resolveWeixinAlias`（别名命中/未命中/iLink 直传）；参数校验（text 超长/文件缺失/未知 action） |
| 装配 | 已配置 CCC 的 agent 工具清单**含** `weixin`；未配置 CCC **不含**；配置热切换（session-start/pre-step 同步后生效）；`restrict` 抛错不阻断装配；会话销毁后 disposer 释放 |
| 工具执行 | `send` → `sendProactiveText` 被调用（mock）+ 返回结构；失败码透传；`users` 列别名；`send-file`（阶段 2） |
| 记录 | 工具发送后 outgoing hook `source:'proactive'`（与现有 weixin 测试同源） |
| 闸门 | 工具形态的成功发送计入「已发送」（不打回）；MSM 形态仍计入 |
| 端到端 | 真实微信一条消息：① 招财用工具发出（`source:'proactive'`）② 不调用时 v1.30.17 兜底仍生效（`source:'reply-fallback'`） |

---

## 6. 阶段划分

| 阶段 | 内容 | 交付判据 |
|------|------|---------|
| **P1（本方案主体）** | 工具 `weixin`（send/users/status）+ 条件可见 + 闸门/标记适配 + CCC 提示词与白名单更新 + 文档 | 未配置 CCC 看不到工具；已配置 CCC 招财能直调发送；测试全绿 |
| **P2** | `send-file` 从 CCC MSM 迁入工具（CDN 上传逻辑移植 + 测试） | CCC 不再持有上传协议 |
| **P3（可选）** | MSM `weixin-send` 退役（保留 3082 供脚本） | 无调用者后删除，减少双通道 |

---

## 7. 待拍板问题

| # | 问题 | 选项（推荐在前） |
|---|------|-----------------|
| **Q1** | 工具名 | `weixin`（家族式，可容纳 send-file）／`weixin_send`（单动作）／`weixin-send`（与 MSM 同名） |
| **Q2** | `ccc` 参数 | 可选、缺省=本会话 CCC（agent 场景自然；跨 CCC 显式传）／必填（与 v1.30.9 的 MSM 纪律一致）／只允许本会话（禁跨 CCC） |
| **Q3** | 可见性判据 | `weixin.enabled === true`（推荐）／enabled **且** 至少一个账号已绑定凭据 |
| **Q4** | CCC MSM 去留 | P1 保留兼容 + P2 吸收 send-file + P3 退役（推荐）／P1 就删（破坏现有脚本与 autopilot 提示词）／永久并存 |
| **Q5** | 标记形态 | 改工具形态 + 闸门同时认两种（推荐）／保持 MSM 形态（工具仅作新通道） |
| **Q6** | skiff 白名单 | zhaocai `tools` 加工具、`msms` 暂时保留（推荐）／只留其一 |
| **Q7** | specs/osp | 立即更新标准（10→11 + 条件可见语义）并列入 osp 对齐（推荐）／dsp 先行、标准随后 |
| **Q8** | 版本 | **v1.31.0**（新增工具 = minor）／并入 v1.30.x patch |

---

## 8. 与既有决策的关系（R↓）

- **D23 延伸**：本方案把「机制与数据」的边界从「发送**实现**」推进到「发送**能力面**」——能力面（工具 + 可见性 + 记录）属 ACC；CCC 保留「何时发/发什么/怎么写」。
- **D12/工具面评估**：当时结论「10 工具近最优」建立在**全局常驻**假设上；条件可见改变了成本函数（未配置 CCC 不付成本），因此新增 1 个工具不再违背该结论。
- **v1.30.9 的 A2 决策**（S11）被本方案修订：HTTP 入口不再是「唯一对外面」，而是「非 agent 调用者的通道」；用户新洞察即修订依据。
- **不引入新机制**：`register` / `restrict` / `findSerenityRoot` / outgoing hook 全部是既有件（S6/S7/S8），本方案只做**组合**。
