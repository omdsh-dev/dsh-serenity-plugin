# 方案：IM 发送能力升为 ACC 工具 `im-bridge`——配置了 IM 通道才可见

- 状态：**v0.2 待开工确认**（2026-09-09，S142）
- v0.1 → v0.2 变更：按用户三决策重构——① 工具形态改为**家族式 `im-bridge`**（内含 `channel` 维度，为将来其他 IM 留空间）② 范围 = **P1 一次做完并删除 CCC MSM** ③ `ccc` 参数**取消**（工具**只能操作本会话 CCC**）
- 触发：用户原话——「既然微信桥是我们 ACC 提供的，那么 `weixin-send` 应该是我们 ACC 提供的能力，当用户配置了微信桥则可用，不配置则不可见」＋「能否设定一个复杂的多层工具，叫 `im-bridge`，里面有微信，然后保留后续可能兼容别的 IM 的空间」
- 关联：D23（ACC 管机制与数据，CCC 管措辞与纪律）｜D12/工具面评估｜v1.30.9（主动发送 A2）｜v1.30.16（闸门）｜v1.30.17（兜底）

---

## 1. 需求（E↑）

| # | 需求 | 判据 |
|---|------|------|
| R1 | **归属**：IM 发送是 ACC 能力 | 发送机制/协议/凭据/账号/别名/记录**只在 ACC**；CCC 不再持有发送实现 |
| R2 | **条件可见**：配置了 IM 通道 → 可用；没配 → **不可见**（不是"可见但报错"） | 未配置 CCC 的 agent 工具清单**没有**该工具（`tools.restrict` 移除，非 guard deny） |
| R3 | **家族式扩展**：一个工具承载多 IM 通道 | 工具含 `channel` 维度；新增通道**不新增工具**、不改工具名 |
| R4 | **本会话边界**：只能操作本会话所属 CCC | 工具无 `ccc` 参数；跨 CCC 发送不在能力面（防止误发） |
| R5 | **记录单一真相源** | 任何路径发送都经通道实现 → outgoing hook（`_weixin-logs` 有原文） |
| R6 | **零改 DSH / 零成本缺省** | 只用 `ctx.tools.register` + `agent.ctx.tools.restrict`；未配置 CCC 的 schema/token 成本零变化 |
| R7 | **能力不降级** | `send` / `send-file` / `users` / `status` / 别名解析 / 多账号 全部保留（send-file 一并迁入） |

---

## 2. 现状实证（读后写，全部源码/日志级）

| # | 事实 | 位置 |
|---|------|------|
| S1 | 发送机制已在 ACC：`sendProactiveText({root,toUserId,text,accountId?})` → iLink `sendmessage` → outgoing hook（`source:'proactive'`）；稳定失败码 `BRIDGE_DISABLED`/`NO_ACCOUNT`/`ACCOUNT_NOT_FOUND`/`ACCOUNT_NOT_BOUND`/`SEND_FAILED` | `src/weixin-bridge.ts:461-507` |
| S2 | ACC 已有 loopback-only HTTP 面（默认 3082，plugin 全局 `weixinApi.port`）+ `parseSendRequest`/`matchCcc`/`isLoopbackAddress` | `src/weixin-send-api.ts` |
| S3 | 入口地址经环境变量注入 MSM：`SERENITY_WEIXIN_API` | `src/msm-ops.ts` `buildMsmEnv` |
| S4 | **CCC 持有一份完整发送实现**：`weixin-send.ts`（689 行）——`send`/`test` 走 3082；`send-file` **直连 iLink**（`getuploadurl` + CDN AES-128-ECB 上传）并自补 hook；`users` 读 CCC localstore 别名 | CCC 仓 |
| S5 | 工具面 10 个，全局注册于 `apply()` | `src/index.ts:129-140` |
| S6 | **条件可见有现成缝 + 生产先例**：`agent.ctx.tools.restrict({deny})` 按 agent scope 隐藏全局工具；safe-mode 用它隐藏写工具，在 `agent/session-start` + `agent/pre-step` 每步同步（热切换 + disposer + 诊断落盘） | `src/seams/guards.ts:266-295`、`src/seams/context.ts:214/219/241` |
| S7 | 宿主契约：`tools.register(definition)` 全局/scoped；`tools.restrict({allow?,deny?})` **必须 scoped**、名字须已在全局层已知、可叠加、返回 disposer | `dsh-harness-public/packages/core/tools/src/index.ts:1022-1089` |
| S8 | 按 agent 解析 CCC 根：`findSerenityRoot(agent.session.header.cwd)`（guard 每个 exec 都做） | `src/seams/guards.ts:214-217, 336-337` |
| S9 | 标记与闸门**只认 MSM 形态**：标记 = `msm("weixin-send", …)`；闸门成功判定 = 工具名 `msm` + 首参 `weixin-send` | `src/weixin-bridge.ts:154-159`、`src/weixin-output-guard.ts:78-85` |
| S10 | skiff 角色白名单由 guard 强制（白名单外 deny；命中 `msms` 但直调 → 提示走 `msm()`） | `src/seams/guards.ts:138-158` |
| S11 | v1.30.9 当时决策为「ACC **不新增工具**，只多一个本机 HTTP 面」——本方案即其修订 | `src/weixin-send-api.ts:9` |
| S12 | 工具名**允许连字符**（既有 `autopilot-trajectory`），故 `im-bridge` 不违命名惯例 | `src/index.ts:140` |

---

## 3. 设计原则

1. **归属（R1/D23）**：协议、账号、凭据、别名、发送、记录、上传 → ACC；CCC 只保留「何时发 / 发什么 / 怎么写」。
2. **可见性 = 配置的函数（R2）**：本会话 CCC 有**任一** IM 通道启用 → 工具可见；否则从该 agent 的工具清单移除。
3. **家族而非单品（R3）**：工具面 = `channel` 维度 + 通道无关的 `action`；通道实现可插拔。
4. **本会话边界（R4）**：CCC 根由 agent cwd 解析（S8），**不可指定**其他 CCC。
5. **通道单一真相源（R5）**：通道实现 → 既有 hook 记录；HTTP 面仅服务**非 agent 调用者**。

---

## 4. 方案

### 4.1 工具面（接口层）

**名称**：`im-bridge`（家族式；连字符与 `autopilot-trajectory` 同例，S12）。

```jsonc
{
  "channel": "weixin",                        // 必填。当前唯一实现；未来 telegram / wecom / ...
  "action":  "send" | "send-file" | "users" | "status",   // 必填
  "user":    "<别名 yh|danica 或通道内用户 id>",  // send / send-file 必填
  "text":    "<纯文本 ≤4000 字>",                // send 必填
  "file":    "<CCC 内相对路径>",                 // send-file 必填
  "caption": "<可选说明>",                       // send-file 可选
  "account": "<通道账号 id，缺省=该 CCC 首个启用且已绑定账号>"  // 可选
}
```

- **无 `ccc` 参数**（R4）：本会话 CCC 由 agent cwd 解析；解析失败 → `CCC_UNRESOLVED`（附「本会话不在任何 CCC 根内」事实）。
- **返回**：成功 `{ ok: true, channel, accountId, userId, sessionId, role }`；失败 `{ ok: false, code, error, remediation? }`。
- **错误码**：通道层复用 S1 五个 + `CHANNEL_UNKNOWN`（未实现的通道）/ `CHANNEL_NOT_CONFIGURED`（该 CCC 未启用此通道）/ `CCC_UNRESOLVED`；参数层 `ALIAS_UNKNOWN` / `FILE_NOT_FOUND` / `FILE_TOO_LARGE` / `TEXT_TOO_LONG` / `ACTION_UNKNOWN`。
- **description（model-facing）**：一句话说清「给家人发消息（微信）；发出即记录；只作用于当前容器；未配置通道时此工具不存在」。

### 4.2 可见性机制（复用 safe-mode 同款缝）

```
apply()
 ├─ ctx.tools.register(createImBridgeTool(ctx))     // 全局注册（10 → 11）
 └─ seams/context.ts 同步点（agent/session-start + agent/pre-step）
      └─ syncImBridgeVisibility(agent, root)
           ├─ root  = findSerenityRoot(agent.session.header.cwd)          // S8
           ├─ shown = hasEnabledImChannel(root)                           // 见下
           └─ !shown → agent.ctx.tools.restrict({ deny: ['im-bridge'] })   // S6/S7
               （shown → 解除本会话 deny；Map<sessionId, disposer> + 会话销毁清理）
```

- `hasEnabledImChannel(root)` = 通道注册表中任一通道的 `isEnabled(root)` 为真；当前 = `readWeixinSettings(root).enabled === true`。
- **配置读取成本**：按 `(root, mtime, size)` 记忆化（复用 v1.30.15 角色提示词读取器做法），pre-step 命中零 IO。
- **失败策略**：`restrict` 抛错**不阻断装配**（沿用 safe-mode 写法：记诊断 + guard 兜底）。
- **热切换**：面板/配置文件改动 → 下一轮 pre-step 即生效，无需重启。

### 4.3 代码分层（能力层 + 工具面）

| 文件 | 职责 |
|------|------|
| `src/im-bridge.ts` | **通道注册表**：`registerImChannel({id, isEnabled(root), send, sendFile?, users?, status?})`、`resolveImChannel(root, id)`、`hasEnabledImChannel(root)`、`syncImBridgeVisibility(agent, root)` |
| `src/im-weixin.ts` | **微信通道实现**：`send`（→ `sendProactiveText`）、`send-file`（移植 S4 的 `getuploadurl` + CDN AES-128-ECB 上传）、`users`（读本 CCC localstore `WEIXIN_USER_*`）、`status`（桥/账号/凭据健康） |
| `src/tools/im-bridge.ts` | **工具面**：参数校验 → `resolveImChannel` → 分发 → 错误码翻译（model-facing 文案） |
| `src/weixin-bridge.ts` | 不动（`sendProactiveText` 仍是唯一发送实现，R5） |
| `src/weixin-output-guard.ts` | 成功判定扩展：`msm`+`weixin-send` **或** `im-bridge` 且 action ∈ {send, send-file} 且未报错 |
| `src/weixin-hook.ts` | outgoing 事件补 `file?: {name,size,caption?}`（send-file 记录，与 CCC hook 脚本既有容忍一致） |

### 4.4 CCC 侧连带改动（P1 一次做完）

| 项 | 处置 |
|----|------|
| `.opencode/skills/home-serenity/scripts/weixin-send.ts` | **删除**（689 行；能力已迁 ACC） |
| `mech-registry.json` 的 `weixin-send` 条目 | `container_admin msm deregister` |
| `.opencode/skills/home-serenity/scripts/weixin-doctor.ts` guide §7 | 改写：主动发送 = `im-bridge` 工具；非 agent 脚本走 loopback HTTP（见 Q1） |
| `.opencode/skiff/zhaocai.md` §0/§3/§4 | 调用示例改 `im-bridge({channel:"weixin", action:"send", …})`；白名单说明同步（**措辞仍归 CCC**） |
| `.opencode/serenity.json` | `skiff.roles.zhaocai.tools` 加 `im-bridge`、`msms` 移除 `weixin-send`；autopilot `topPrompt` 里的 `msm("weixin-send", …)` 改工具形态 |
| ACC 手动输出标记（S9） | 文本改为 `im-bridge({channel:"weixin", action:"send", user:"<id>", text:"<回复>"})` |

### 4.5 收益与风险

**收益**：① 归属正确（CCC 归零发送实现）② 可见性即配置 ③ 家族式扩展位 ④ 少一层 `msm` 间接——**假设**：直调工具可改善模型遵循度（实测依据：同模型在 `msm` 形态对寒暄消息 4 连败、任务类消息成功）；**不预设结论**，上线后一轮微信实测判定 ⑤ 记录路径不变。

**风险与对策**

| 风险 | 对策 |
|------|------|
| 工具面 10→11 | 仅对已配置通道的 CCC 生效；未配置 CCC 仍是 10（R6） |
| 删 MSM 破坏既有调用者 | 同一变更内更新：zhaocai.md / serenity.json topPrompt / weixin-doctor guide / registry；grep 全仓零残留为验收条件 |
| `restrict` 名字未知抛错（S7） | 注册在先、限制在后；失败不阻断装配 |
| send-file 迁移引入回归 | 保留原 MSM 的 AES/上传实现语义（逐行对照移植 + 真机实测一条文件） |
| 跨 CCC 发送能力消失（R4） | 明确不在能力面；确有需求时由 CCC 脚本走 loopback HTTP（Q1） |

---

## 5. 测试与验证

| 层 | 用例 |
|----|------|
| 纯函数 | `hasEnabledImChannel`（启用/未启用/无通道）；`resolveImChannel`（未知通道/未配置通道）；参数校验矩阵（text 超长、文件缺失、未知 action、别名未登记） |
| 装配 | 已配置 CCC 的 agent 工具清单**含** `im-bridge`；未配置**不含**；配置热切换生效；`restrict` 抛错不阻断；会话销毁释放 disposer |
| 工具执行 | `send` → `sendProactiveText` 调用与返回结构；`users` 列别名；`status` 健康；`send-file` 上传（mock iLink） |
| 记录 | 工具发送后 outgoing hook `source:'proactive'`；send-file 带 `file` 元数据 |
| 闸门 | `im-bridge` 成功发送计入"已发送"（不打回） |
| 端到端（真机） | ① 招财用工具发一条（`source:'proactive'`）② 不调用时 v1.30.17 兜底仍生效（`source:'reply-fallback'`）③ 真发一个文件 |
| 迁移验收 | `grep -r "weixin-send" ` 在 CCC 仓零残留（除历史 SESSION 记录） |

---

## 6. 交付顺序（P1 一次做完）

1. ACC：`im-bridge.ts`（注册表+可见性）+ `im-weixin.ts`（通道实现，含 send-file 移植）+ `tools/im-bridge.ts`
2. ACC：context.ts 同步点接入 + 闸门/标记/hook 适配
3. 测试全绿 + typecheck/build
4. CCC：删 MSM + deregister + zhaocai.md + serenity.json + weixin-doctor guide
5. 文档：README（工具表 10→11 + 条件可见说明）/ msm-ops / skill / CHANGELOG + bump **v1.31.0**
6. 发布链（publish + 三推 + deploy + restart-web）→ 真机验证
7. specs：工具最小公共集 10→11 + IM 家族语义（Q2）

---

## 7. 决策记录与遗留小决策

**已拍板（2026-09-09 用户）**

| # | 决策 | 依据 |
|---|------|------|
| D1 | 工具名 = **`im-bridge`**（家族式，`channel` 维度留扩展空间） | 用户："能否设定一个复杂的多层工具，叫 im-bridge，里面有微信，然后保留后续可能兼容别的 im 的空间" |
| D2 | 范围 = **P1 一次做完并删除 CCC MSM** | 用户选「P1 一次做完并删 MSM」 |
| D3 | `ccc` 参数**取消**，工具**只能操作本会话 CCC** | 用户选「只能本会话 CCC」 |

**遗留小决策（开工前确认，推荐值已给）**

| # | 问题 | 推荐 |
|---|------|------|
| Q1 | 3082 loopback HTTP 面去留（删 MSM 后其唯一调用者消失） | **保留**为"非 agent 调用者通道"（CCC 脚本/cron 可直连；loopback-only 无密钥）；若确认无此类调用者则一并删除 |
| Q2 | specs 更新时机 | **随 P1 一起**（标准与实现同源），osp 对齐列入 P6 |
| Q3 | 版本号 | **v1.31.0**（新增工具 = minor） |
