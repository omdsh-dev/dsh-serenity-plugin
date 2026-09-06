# Skiff 绑定 Trajectory 模式设计（v0.1 方案草案，待用户审核）

**状态**: v0.1 调研 + 方案草案（2026-09-06，S142 用户发现设计遗漏）
**会话**: S142
**基线**: dsp v1.30.1（62 files / 895 tests）
**关联**: `docs/skiff-design.md`（F4 总设计）/ `docs/skiff-followup-design.md` / `docs/weixin-bridge-design.md` / `docs/session-binding-hardening-research.md` / `docs/session-binding-persist-plan.md`

---

## 1. 问题陈述（用户发现的设计遗漏）

### 1.1 用户洞察

> skiff 本身是临时会话机制，而 skiff 绑定微信桥就会变成永久性。这就需要 skiff 支持另一种模式——绑定 trajectory，从而支持完整的 trajectory 功能，例如 rebuild。这里之前考虑不周。

**E↑ 解构**：

| 观察 | 证据 |
|------|------|
| skiff 原设计 = **临时会话机制** | skiff-design.md §4.5 默认轨迹纪律全关（不建 SESSION.md、无 keeper、无 rebuild）；sessionId `skiff-<role>-<uuid>` 随机；调试页每次提问即新会话（v1.25.0 首版语义） |
| 微信桥把 skiff 变成 **永久性** | weixin-route.ts `weixinSessionIdFor` = 固定可重建 `skiff-weixin-<sha256>`——同用户长期同一会话（v1.27.0 起）；resume-or-create 磁盘持久化（v1.27.2）+ live 复用（v1.27.3）→ **真正长期延续** |
| 长期延续的会话**缺 trajectory 支撑** | 无绑定 SESSION.md → rebuild 无法定位正确轨迹（会劫持主舱最新会话）；无持久轨迹身体 → 认知不落盘，只活在 dsh 会话 JSONL 里 |

### 1.2 现状（用户已手工 workaround）

S158 §B + S159（2026-09-07 用户拍板）已手工开 rebuild：

```jsonc
// .opencode/serenity.json skiff.roles.zhaocai（当前态）
"zhaocai": {
  "tools": ["read", "grep", "glob", "web_search", "logbook", "msm"],
  "trajectory": { "session": true, "keeper": false, "rebuild": true },
  ...
}
// + 专属 SESSION：AGENT_SESSIONS/2026-09-06--S159--zhaocai 独立轨迹/SESSION.md
```

**workaround 痛点**：
1. **每次 rebuild 前需先 `logbook use S159` 激活**（无持久绑定 → 每次靠 LLM 自觉先 use；忘记则 rebuild 定位回退 `findLatestActiveSessionMd` → 劫持主舱最新会话如 S142）
2. **手工维护专属 SESSION**：S159 目录手工建、手工维护"归属招财"约定；skiff 创建/延续时无机制保证绑定
3. **主舱 agent 可误用 S159**：S159 在 AGENT_SESSIONS/ 里对所有 agent 可见，无"归属"机械约束
4. **机制与语义分裂**：`trajectory.session/keeper/rebuild` 只是"纪律参与开关"，不含"绑定哪个 trajectory"——绑定关系无载体

### 1.3 原设计为何漏（R↓）

skiff-design.md §9 Q2 已承认缺口：
> "`tools` 白名单暴露 session_rebuild 的依赖（需 trajectory.session=true，否则 resolveSessionMdPath 报错）——**文档标注，CCC 自负责**"

设计期判断"skiff = 子集问答/调试"→ 轨迹纪律面（session/keeper/rebuild）只是**布尔开关**，未考虑"子集角色长期化后需要绑定的持久轨迹本体"。微信桥引入固定会话后，布尔开关不足以表达"这个角色属于哪条轨迹"。

---

## 2. 调研实证：相关机制现状

### 2.1 skiff 会话生命周期（skiff-core.ts）

| 面 | 机制 |
|----|------|
| 会话创建 | `createSkiffAgent(ctx, root, roleName, role, defaultModel, sessionId?)`——固定 sessionId（微信桥/ACP）→ resume-or-create；无 → 随机 `skiff-<role>-<uuid>` |
| 会话延续 | 进程内 `getSkiffAgent(sessionId)` 命中 → 复用 agent.followup；重启后 resume（磁盘 JSONL）或 live 复用 |
| 会话注册表 | skiff-registry：sessionId → { role, ccc }（**无 SESSION.md 绑定字段**） |
| 轨迹纪律 | `skiffTrajectoryEnabled(root, sessionId, key)`——按 role.trajectory.{session,keeper,rebuild} 决定 seams 是否参与；**纯布尔，无绑定对象** |
| 工具白名单 | guards：skiff 会话工具 ∈ role.tools ∪ msm 通道（logbook 需显式进 tools） |
| 系统提示词 | scoped 'serenity-skiff' section（order -60，**全替换 ACC 默认注入**）——基础段 + CCC 角色提示词；不注入 ACC 的 Session 块/身份块 |
| 外部面 | output-guard / context / bootstrap / compact 对 skiff-* 前缀旁路 |

### 2.2 微信桥（weixin-bridge.ts + weixin-route.ts）

- 固定 id `skiff-weixin-<sha256(userid).slice(1,17)>` → **同用户长期同一会话**
- 路由 user → role；消息 → `createSkiffAgent(固定 id)`（resume-or-create）→ askSkiff（includeTrajectory:false）
- 新对话通知仅真正首次（create）；resume 静默（用户记得历史）
- **结论：微信桥的角色会话已是"永久轨迹"，只是没有 SESSION.md 身体**

### 2.3 rebuild 前置（rebuild.ts + session-ops.ts）

- `queueRebuild` 需 `resolveSessionMdPath(root, scope, session)` 定位 SESSION.md——**4 层候选**：
  ① 内存活跃会话（显式 use）→ ② events 恢复（use 标记/锚点路径行）→ ③ surface 锚点 → ④ `findLatestActiveSessionMd`（**AGENT_SESSIONS 最新未完成**——skiff 无绑定时的危险回退）
- rebuild 执行：turn-stopping 时 surface replace + steer 自动继续 + 标题重命名 `S###-YYYY-MM-DD-<summary>`
- **结论：rebuild 强依赖"会话 ↔ SESSION.md"的绑定关系**；skiff 会话无此绑定 → 定位只能靠显式 use 或危险回退

### 2.4 SESSION 绑定持久化（session-bound.ts，v1.29.1）

- `serenity/bound` 会话事件（merge-extensible）：dirName + mdPath + sessionId + action(activate/switch/create/rebuild/reconcile/release) + at + note
- **权威绑定 = 会话日志最后一条 bound**（latest-wins，随 JSONL 落盘，重启可恢复）
- use/create/rebuild 排队时 append；context seed 三层恢复链读取
- **结论：绑定机制已存在且通用（编码无关）——skiff 会话同样可 append bound，只是当前无代码调用**

### 2.5 skiff 角色配置面（skiff-role.ts）

```jsonc
// SkiffRoleConfig 当前字段
{ model, msms, tools, trajectory: {session, keeper, rebuild}, systemPrompt, systemPromptFile }
```

**无任何"轨迹绑定"字段**（如 trajectoryDir / boundSession / homeTrajectory）。

---

## 3. 设计目标与原则

| # | 原则 | 含义 |
|---|------|------|
| G1 | **模式二元显式** | skiff 角色 = 临时模式（默认，现状不变）或 trajectory-bound 模式（新）——配置显式声明，默认零行为变化 |
| G2 | **绑定有载体** | bound 角色必须指向一条真实轨迹（AGENT_SESSIONS/ 目录 + SESSION.md），绑定关系持久化（serenity/bound 事件） |
| G3 | **归属机械约束** | trajectory-bound 角色的会话自动绑定其专属 SESSION；其他会话/agent 不误用（bound 事件 + 会话内提示声明） |
| G4 | **零改 DSH** | 复用现有机制：session-bound 事件 / resume-or-create / skiff 会话核心 |
| G5 | **向后兼容** | 未配 bound 的角色完全走现状（临时问答）；S159 workaround 可被新机制取代或平滑迁移 |
| G6 | **保持子集安全边界** | trajectory-bound 只解决"轨迹身体 + rebuild 定位"，不扩大工具面/能力面（写删改仍受白名单约束） |

---

## 4. 方案候选

### 方案 A：角色级 boundTrajectory 配置（最小机制面）

**在角色配置加一个绑定声明字段**，skiff 会话创建时自动绑定。

```jsonc
// .opencode/serenity.json skiff.roles.zhaocai（扩展后）
"zhaocai": {
  "model": "minimax-cn-coding-plan/MiniMax-M3",
  "msms": [...],
  "tools": ["read", "grep", "glob", "web_search", "logbook", "msm"],
  "trajectory": {
    "session": true,
    "keeper": false,
    "rebuild": true,
    "boundDir": "2026-09-06--S159--zhaocai 独立轨迹"   // ← 新增：绑定的轨迹目录
  },
  "systemPromptFile": ".opencode/skiff/zhaocai.md"
}
```

**机制改动**：
1. **skiff-role.ts**：`SkiffTrajectorySubset` 加 `boundDir?: string`（编码无关——完整目录名，复用 v1.29.1 编码无关原则）；`readSkiffRoles` 解析
2. **skiff-core.ts `createSkiffAgent`**：角色 boundDir 存在时——
   - 校验该目录存在且含 SESSION.md（不存在 → console.warn + 不绑定 + 角色仍可工作，仅 rebuild 提示"请先建轨迹"）
   - **appendBound(session, 'activate'/'reconcile', {dirName, mdPath})**——会话日志持久化绑定
   - 系统提示词 Session 块（scoped）注入该轨迹上下文（简化版：sessionId + SESSION.md path + 归属声明"你属于轨迹 X"）
3. **rebuild.ts `resolveSessionMdPath`**：skiff 会话**优先读 bound 事件**（readLastBound）——绑定即定位，不再需要手工 use；候选 0 = 会话日志 bound（在 ① 内存活跃之前）
4. **session.ts（logbook use）**：bound 角色的会话 use 别的不属于它的 SESSION 时拒绝/警告（硬守卫可选，对齐 v1.29.1 use 守卫）
5. **keeper 压力提醒**：bound 角色的 rebuild 提醒文案带其专属 SESSION 名（"[TRAJECTORY-ASSISTANT · LIMIT] 你的轨迹是 S159 — call logbook rebuild"）

**优点**：最小改动（~150-250 行 + 测试）；机制面清晰；微信桥/ACP/调试页全部自动受益（会话创建统一入口）；向后兼容
**缺点**：角色绑定单轨迹（一个角色一个轨迹）——若未来需要"一角色多用户各自轨迹"需再扩展

### 方案 B：会话级显式绑定（微信路由带 trajectory 参数）

**绑定关系在会话创建时由调用方显式指定**，不藏在角色配置里：

```jsonc
// weixin route 扩展
"routes": [{ "user": "*", "role": "zhaocai", "trajectory": "2026-09-06--S159--zhaocai 独立轨迹" }]
// 或 ACP session/new 带 trajectory 参数
{ ccc, role, trajectory?: "S159", sessionId? }
```

**机制改动**：weixin-route / acp-core 透传 trajectory 到 createSkiffAgent；session-bound append；其余同 A

**优点**：灵活（同角色不同入口可绑不同轨迹——如微信用户 A 绑 S1、用户 B 绑 S2）；路由级声明直观
**缺点**：调用面改动多（微信路由 + ACP + 问答页都要透传）；配置分散（角色 trajectory 语义与路由 trajectory 语义并存易混）；CCC 配置复杂度上升

### 方案 C：完整轨迹一等角色（重建 skiff 为"轨迹子集会话"）

**把 trajectory-bound 提升为 skiff 的一等模式**（不是补丁）：角色配置引入 `mode: "temporary" | "bound"`，bound 模式角色 = 完整轨迹参与（Session 块注入 + keeper 按角色阈值 + rebuild 自动定位 + bound 持久化），临时模式 = 现状。trajectory 布尔子集字段废弃为派生（bound 模式强制全开可配收窄）。

**机制改动**：skiff-role schema 加 mode + 校验（bound 必须配 trajectoryDir）；skiff-core 按 mode 分支装配（bound → 走完整 context/session 注入路径的子集版）；seams 判定改查 mode

**优点**：语义最清晰（设计文档级修正而非补丁）；为未来"角色轨迹"演进打地基
**缺点**：改动最大（模式分支贯穿 skiff-core + seams 判定 + 系统提示词装配）；风险高（bound 模式动了 skiff 的"全替换 ACC 注入"设计——需谨慎定义注入内容）

---

## 5. 推荐与理由

**推荐 A（最小机制面）**，理由：
1. **贴合用户当下需求**：微信桥 zhaocai 绑定专属轨迹（S159），让 rebuild 可靠——A 恰好解决，不引入未验证的复杂
2. **复用成熟机制**：session-bound 事件（v1.29.1）本就是为此设计的——"权威绑定 = 会话日志最后一条 bound"，只是 skiff 从未 append。A 是**补上缺失的接线**
3. **一处改动全入口受益**：createSkiffAgent 是微信桥/ACP/调试页统一入口——绑定逻辑放这里，三个入口全自动
4. **保持子集哲学**：A 不改变"skiff = 能力子集"——只加"子集有家（轨迹）"。能力面（tools/msms）仍 CCC 控
5. **C 可作为 A 的后续演进**：A 落地验证后，若需"模式一等化"再升 C（mode 字段 = boundDir 的泛化）

**A 的取舍**：角色单轨迹绑定（一角色一轨迹）——对家庭场景（zhaocai 一个助手一条轨迹）完全够用；多用户各自轨迹需求出现时升 B 的路由级或 C 的 mode。

---

## 6. 方案 A 详细设计

### 6.1 配置扩展（CCC 侧）

```jsonc
// skiff.roles.<name>.trajectory 扩展（向后兼容：无 boundDir = 临时模式现状）
"trajectory": {
  "session": true,     // 既有：会话纪律参与（use/list 可见）
  "keeper": false,     // 既有：计分提醒
  "rebuild": true,     // 既有：压力检测
  "boundDir": "2026-09-06--S159--zhaocai 独立轨迹"  // 新：绑定轨迹目录（编码无关，完整目录名）
}
```

语义：
- `boundDir` 配了 → **trajectory-bound 模式**：会话创建/延续时自动 appendBound 到该轨迹；rebuild 定位优先 bound
- `boundDir` 未配 → 临时模式（现状）；即便 trajectory.session/rebuild=true 也需手工 use（S158 workaround 兼容）
- validate 子命令：boundDir 引用的目录不存在 / 无 SESSION.md → issue 警告

### 6.2 skiff-role.ts

```ts
// SkiffTrajectorySubset 扩展
export interface SkiffTrajectorySubset {
  session: boolean
  keeper: boolean
  rebuild: boolean
  boundDir?: string   // 绑定轨迹目录（AGENT_SESSIONS/ 下完整目录名）
}
// readSkiffRoles：role.trajectory.boundDir 解析（string 校验）
// 新纯函数 resolveBoundSession(root, subset): { dirName, mdPath } | null ——
//   boundDir 存在 + AGENT_SESSIONS/<boundDir>/SESSION.md 存在 → 返回；否则 null
```

### 6.3 skiff-core.ts

`createSkiffAgent`（agent 创建/延续成功后）：

```ts
// bound 轨迹解析（角色配置 boundDir → 磁盘存在性校验）
const bound = resolveBoundSession(root, role)
if (bound) {
  // ① 持久化绑定：serenity/bound 事件（action: 'reconcile'——会话延续时的自动绑定）
  appendBound(agent.session, hasBound ? 'reconcile' : 'activate', {
    dirName: bound.dirName, mdPath: bound.mdPath,
    sessionId: extractSid(bound.dirName), note: 'skiff role bound trajectory',
  })
  // ② 绑定错误容忍：目录缺失 → warn + 不 append（角色仍工作，rebuild 提示先建轨迹）
}
```

- resume 路径（重启恢复）：agent.session 已有 bound 事件 → readLastBound 对比角色 boundDir → 不一致时 re-append（reconcile）
- 系统提示词：bound 角色的 scoped section 尾部注入轨迹上下文段（简化版 Session 块）

### 6.4 rebuild.ts（定位优先 bound）

```ts
// resolveSessionMdPath 候选顺序调整（skiff 会话优先 bound）：
// 候选 0（新）：readLastBound(session)?.mdPath（存在性校验）——skiff bound 会话免手工 use
// 候选 1-4：既有（内存活跃 → events → surface → 最新回退）
```

- 对 skiff bound 会话：bound 直接命中 → rebuild 定位正确（不再劫持主舱）
- 非 bound skiff（临时模式）：无 bound → 走既有路径（手工 use 或报错引导）

### 6.5 归属保护（防误用）

- **logbook use 守卫**（session.ts）：当前 dsh 会话已 bound（readLastBound 命中）且目标 SESSION ≠ bound → 拒绝并提示（"此 skiff 会话绑定 S159，不能 use 其他会话"）——对齐 v1.29.1 use 硬守卫（需 --force 切换）
- **keeper 提醒文案**：bound 会话的 rebuild 提醒带其轨迹名（"[TRAJECTORY-ASSISTANT · LIMIT] Your bound trajectory is S159 — call logbook rebuild when appropriate"）
- bound 事件随 JSONL 持久化 → 重启恢复后 context seed 自动恢复绑定（Session 块显示正确的 SESSION）

### 6.6 S159 workaround 迁移

新机制落地后：
- S159 目录**保留**（轨迹身体不动，Ship of Theseus）
- zhaocai 角色配置：trajectory 加 `boundDir: "2026-09-06--S159--zhaocai 独立轨迹"`
- 既有 skiff-weixin-* 会话：下次 resume 时自动 reconcile 绑定（6.3 ②）
- zhaocai.md 提示词段简化（不再需要"先 use S159 再 rebuild"的手工纪律——机制自动绑定）

### 6.7 测试

| 模块 | 用例 |
|------|------|
| skiff-role | boundDir 解析 / resolveBoundSession 命中与缺失（目录不存在/无 SESSION.md） |
| skiff-core | bound 角色 create → appendBound（activate）；resume 已有不同 bound → reconcile 覆盖；缺失目录 → warn 不 append |
| rebuild | bound 会话 queueRebuild 定位 bound 的 SESSION.md（不需 use）；非 bound skiff 行为不变 |
| session.ts | bound 会话 use 其他 SESSION → 拒绝；--force 可切换 |
| keeper | bound 会话 rebuild 提醒带轨迹名 |
| guards/skiff | 回归（tools 白名单不变） |

---

## 7. 边界与不做

| 不做 | 理由 |
|------|------|
| 不自动创建 SESSION.md | 轨迹身体是 CCC/用户产物（logbook create）——dsp 只绑定既有轨迹；缺失给指引 |
| 不改 skiff 系统提示词为 ACC 全量注入 | bound 模式仍是子集——只加 Session 块轨迹上下文，不注入身份/工具全量（保持外部面纯净） |
| 不做多轨迹/多用户各自轨迹（一角色一轨迹） | 家庭场景单助手单轨迹；未来需要时路由级（B）或 mode 一等化（C） |
| 不扩大能力面 | bound 只解决"轨迹身体 + rebuild 定位"，不自动加写权限（tools/msms 仍 CCC 控） |
| 不做 keeper 默认开启 | 保持现状（zhaocai keeper:false 不被计分打扰）；bound 会话的 keeper 参与仍按 role.trajectory.keeper |
| 不改 osp | dsp 侧设计；specs 待验证后决定是否升标准 |

---

## 8. 待用户拍板

1. **方案选型**：A（最小机制面，推荐）/ B（会话级显式绑定）/ C（完整轨迹一等角色）？
2. **配置字段名**：boundDir（完整目录名，编码无关）？还是 boundSessionId（S159）？还是两者（dir 权威 + id 展示）？
3. **use 守卫强度**：bound 会话 use 其他 SESSION → 拒绝需 --force（对齐 v1.29.1）？还是仅警告？
4. **绑定时机**：仅在 createSkiffAgent（统一入口）？还是微信路由也可覆盖（路由级 override 轨迹）？
5. **迁移**：S159 workaround 是否立即迁移到新机制？（建议：方案落地后迁移，S159 保留）
6. **版本**：改动独立版本 v1.31.0？还是并入下个小版本（D14 用户控制节奏）？

---

## 9. 参考

- `docs/skiff-design.md`（F4 总设计，§9 Q2 承认缺口）
- `docs/weixin-bridge-design.md`（W2 固定会话延续）
- `docs/session-binding-hardening-research.md` + `docs/session-binding-persist-plan.md`（v1.29.1 bound 机制）
- `AGENT_SESSIONS/2026-09-06--S158--招财权限扩展研究/SESSION.md`（§B 手工 workaround 全记录）
- `AGENT_SESSIONS/2026-09-06--S159--zhaocai 独立轨迹/SESSION.md`（现有专属轨迹）
