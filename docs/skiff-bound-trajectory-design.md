# Skiff 绑定 trajectory 模式（boundSession）——设计 v0.1

> 状态：**方案待审核**（2026-09-07，S142）
> 需求来源：用户发现 skiff 绑定微信桥后变成**永久性会话**（同用户固定 skiff-weixin-<hash> 长期延续），但 skiff 原设计是**临时会话机制**（问答子集随用随建）——机制错配：临时会话设计承载永久轨迹。
> 关联：`docs/skiff-design.md`（原设计，§9 Q2 承认 rebuild 依赖缺口用"文档标注"绕过）+ SESSION.md §8「skiff 绑定 trajectory 调研」条目（2026-09-06 起）

---

## 0. 用户拍板（2026-09-07，SESSION.md L195-198 记录）

1. **二元模式**（不要 A/B/C 三选一）：① 现状无 trajectory 模式 ② 有 trajectory 模式
2. **字段名**：`boundSession: "S159"`——S### id 记法；实现内部解析为 dirName/mdPath 权威锚，复用 logbook use 同款 findSession 解析
3. trajectory 现有子集字段（session/keeper/rebuild）保持不变

---

## 1. 需求（Neat 需求层）

### 1.1 问题陈述（机制错配实证）

| 维度 | skiff 原设计（临时会话） | skiff 绑定微信桥后（永久会话） |
|------|------------------------|------------------------------|
| 会话 id | 随机 `skiff-<role>-<uuid>` | 固定 `skiff-weixin-<sha256(userid)>`（长期延续） |
| 生命周期 | 随用随建，连接/页面关闭清理 | 永久（用户↔角色长期绑定） |
| 轨迹 | **无 SESSION.md**（独立小艇，不参与轨迹） | 需要长期认知沉淀（决策/状态/未决） |
| rebuild | 不适用 | 需要（长上下文终会超限） |

**核心差距**：skiff 会话（`skiff-*` 前缀）在 context/bootstrap/compact/system-prompt **全旁路 ACC 注入**；会话定位靠**显式 use + 内存 active**（skiff 无 SESSION 绑定概念）；rebuild 的 `resolveSessionMdPath` 靠 4 层候选定位 SESSION.md——其中第 4 层 `findLatestActiveSessionMd`（最新未完成活动目录）会**回退劫持主舱会话**（S159 workaround 的根因，SESSION.md L192）。

### 1.2 现状 workaround（笨重）

用户已手工配置（S158 §B + S159）：
- zhaocai role: `tools:[logbook]` + `trajectory:{session:true, rebuild:true}` + **专属 SESSION S159**
- 每次 rebuild 需 `logbook use S159` 先激活（无持久绑定）
- 主舱 agent 可能误用/误关 S159
- rebuild 的 4 层候选若 use 丢失 → 回退劫持主舱最新会话

### 1.3 需求定义

skiff 角色需支持**另一种模式 = 绑定 trajectory**：
- 角色配置显式声明 `boundSession`（归属哪个真实 AGENT_SESSIONS/S### + SESSION.md）
- 该角色创建的 skiff 会话**自动绑定**该 SESSION（免手工 use、防回退劫持、防误用）
- 支持完整 trajectory 功能（rebuild/logbook/会话延续持久化）

---

## 2. 范围（方案层）

### 2.1 二元模式形态

```
① 无 trajectory（现状，缺省）        ② 有 trajectory（boundSession）
   ────────────────                    ─────────────────────────
   skiff.roles.zhaocai:                skiff.roles.zhaocai:
     trajectory: {                       trajectory: {
       session: false                      session: true
       keeper: false                       keeper: false
       rebuild: false                      rebuild: true
     }                                     },
     (无 boundSession)                     boundSession: "S159"
```

| 维度 | ① 无 trajectory | ② boundSession |
|------|----------------|----------------|
| SESSION.md | 不建（独立小艇） | 绑定既有 AGENT_SESSIONS/S### 目录 |
| ACC 注入 | 全旁路 | **选择性开启**（对齐 trajectory 子集——session/keeper/rebuild） |
| rebuild 定位 | 不可用（或经 tools 暴露但需自管） | **权威锚 = boundSession**（第 0 候选，优先于 4 层回退） |
| logbook use | 手工（现状 workaround） | **自动**（创建 agent 时绑定） |

### 2.2 boundSession 配置 schema

```jsonc
// .opencode/serenity.json skiff.roles.<name>
{
  "model": "…",
  "msms": ["…"],
  "tools": ["…"],
  "trajectory": { "session": true, "keeper": false, "rebuild": true },
  "boundSession": "S159",          // ← 新增：S### id 记法（编码无关——CCC 可自定义编码）
  "systemPromptFile": "…"
}
```

### 2.3 不做（边界）

- **不自动创建 SESSION**：boundSession 必须指向已存在的会话目录（findSession 定位失败 → 角色启动报错/validate issue）——SESSION 的创建/内容归 CCC（与现状一致：S159 由用户/agent 手工建）
- **不改 ① 无 trajectory 模式行为**：boundSession 缺失 = 现状完全不变（零回归）
- **不做多 SESSION 绑定**：一角色一 boundSession（微信 zhaocai 绑定 S159 单会话足够）
- **不自动轮转**：SESSION 生命周期（归档/关闭）仍归 logbook 纪律

---

## 3. 机制设计（接口层）

### 3.1 角色 schema 扩展

**文件**：`src/ccc.ts` SkiffRoleConfig + `src/skiff-role.ts` readSkiffRoles

```ts
export interface SkiffRoleConfig {
  // …既有字段…
  trajectory?: { session?: boolean; keeper?: boolean; rebuild?: boolean };
  /** v1.30.3：绑定 trajectory 会话（S### id 记法；权威 SESSION 锚——防 rebuild 回退劫持） */
  boundSession?: string;
}
```

readSkiffRoles 解析：`boundSession: typeof role.boundSession === 'string' && role.boundSession.trim() !== '' ? role.boundSession.trim() : undefined`

### 3.2 boundSession → dirName/mdPath 权威锚解析

**新纯函数**（`src/skiff-role.ts` 或 session-ops）——复用 logbook use 同款 findSession：

```ts
/** 解析角色的 boundSession 为会话权威锚（dirName + mdPath）；未配置/定位失败 → null */
export function resolveRoleBoundSession(root: string, role: SkiffRoleConfig | undefined): {
  sessionId: string; dirName: string; mdPath: string
} | null {
  if (!role?.boundSession) return null
  const sessionsDir = join(root, 'AGENT_SESSIONS')
  const entry = findSession(sessionsDir, role.boundSession)  // 复用 logbook use 同款
  if (!entry) return null
  const mdPath = join(entry.path, SESSION_MD)
  if (!existsSync(mdPath)) return null
  const sessionId = extractSessionId(entry.dirName) || basename(entry.dirName)
  return { sessionId, dirName: entry.dirName, mdPath }
}
```

**复用点**：`session-ops.ts` `findSession`（L155）+ `extractSessionId`——精确目录名 → S### ID → 唯一模糊。编码无关（U4 原则：不假设 S### 格式，支持完整目录名/自定义编码）。

### 3.3 自动绑定（创建 agent 时）

**文件**：`src/skiff-core.ts` createSkiffAgent

现状（L134-143）：注册 skiff session registry + systemPrompt.section。新增：

```ts
// 角色配了 boundSession + trajectory.session → 自动激活该 SESSION（scope = skiff 会话 id）
const bound = resolveRoleBoundSession(root, role)
if (bound) {
  setActiveSessionInfo(String(id), { sessionId: bound.sessionId, dirName: bound.dirName, mdPath: bound.mdPath })
  // 注入 [SESSION CONTEXT] 到 events（复用 useSession 的 context 文本）——进程重启后可恢复
  appendBound(agent.session, 'activate', { dirName: bound.dirName, mdPath: bound.mdPath, sessionId: bound.sessionId })
}
```

**关键语义**：
- `setActiveSessionInfo(scope, …)` 的 scope = **skiff dsh 会话 id**（如 skiff-weixin-74b2a…）——与主舱会话隔离（各 scope 独立 Map key）
- 自动绑定免手工 `logbook use`——微信 zhaocai 每次会话（resume/create）自动落在 S159
- bound 持久化（appendBound）→ 进程重启后 context.ts seed 三层恢复链从 events 恢复

### 3.4 rebuild 权威锚（防回退劫持）

**文件**：`src/rebuild.ts` resolveSessionMdPath

**问题**：skiff 会话 rebuild 时 4 层候选——第 1 层 getActiveSessionInfo(scope)（若自动绑定已生效 → 命中 S159 ✓）但若**进程重启后 activeStore 空 + events 恢复链断** → 掉到第 4 层 findLatestActiveSessionMd → **劫持主舱最新会话**（S159 workaround 要防的正是这个）。

**修复**：resolveSessionMdPath 增加**第 0 候选**——skiff 会话查角色 boundSession：

```ts
export function resolveSessionMdPath(root: string, scope: string, session: Session): string | null {
  const candidates: Array<string | null> = []
  // ① v1.30.3：skiff 会话的角色 boundSession 权威锚（防回退劫持主舱——优先级最高）
  if (isSkiffSessionId(scope)) {
    const roleName = skiffRoleFor(scope)
    const role = roleName ? readSkiffRoles(root).get(roleName) : undefined
    candidates.push(resolveRoleBoundSession(root, role)?.mdPath ?? null)
  }
  candidates.push(getActiveSessionInfo(scope)?.mdPath ?? null)   // ② 原第 1 层
  // …其余层不变…
}
```

**保障**：
- boundSession 存在 → **永远指向 S159**，不劫持主舱
- boundSession 目录被归档/删除 → resolve 返回 null → 掉回原 4 层（兼容现状）
- 非 skiff 会话（主舱）→ isSkiffSessionId false → 零影响

### 3.5 keeper 计分（若 trajectory.keeper=true）

**现状**：keeper.ts L179-180 已查 `skiffTrajectoryEnabled(root, sessionId, 'keeper')`——角色 trajectory.keeper=true 时计分提醒对 skiff 会话生效。绑定 trajectory 后 keeper 提醒读 SESSION.md（keeper.ts 已 resolveSessionMdPath 定位）→ 经 3.4 修复后自然指向 boundSession。**无需额外代码**（验证 keeper.ts 定位走 resolveSessionMdPath 即可）。

### 3.6 拦截缝旁路（选择性开启）

**现状**：skiff 会话（skiff-* 前缀）在 context/bootstrap/compact/system-prompt **全旁路**（skiff-design.md §4.5）——这是"独立小艇"设计。

**boundSession 模式是否需要改旁路？**——**不需要全开**。对齐 trajectory 子集哲学（CCC 定参与项）：
- `trajectory.session=true`（zhaocai 现状）→ session 工具（logbook use/rebuild）可用 + boundSession 自动激活——**已完成（3.3/3.4）**
- `trajectory.keeper=true` → keeper 计分提醒（已支持，3.5）
- **ACC 身份注入仍旁路**（skiff 用 CCC 提示词，不注入 ACC 身份——保持角色纯净；SESSION 绑定 ≠ 身份注入）
- rebuild 压力检测（keeper.ts L180 rebuild 分支）→ 已支持

### 3.7 validate/list 同步

**文件**：`container_admin role validate`（skiff-admin.ts）

validate 新增检查：
- boundSession 配置了 → findSession 能否定位（定位失败 = issue：`boundSession "S159" not found in AGENT_SESSIONS/`）
- boundSession 配置但 trajectory.session != true → issue 提示（session 需开启才能自动绑定生效）
- boundSession 定位的目录无 SESSION.md → issue

list 输出补 boundSession 列。

### 3.8 zhaocai.md 提示词同步（CCC 侧）

`.opencode/skiff/zhaocai.md` 文末「专属轨迹 S159」段更新：不再需要手工 `logbook use S159`（自动绑定）——rebuild 直接可用。

---

## 4. 改动文件清单（实现层）

| 文件 | 改动 |
|------|------|
| `src/ccc.ts` | SkiffRoleConfig + `boundSession?: string` 字段 |
| `src/skiff-role.ts` | readSkiffRoles 解析 boundSession + `resolveRoleBoundSession` 新纯函数 |
| `src/skiff-core.ts` | createSkiffAgent：boundSession 自动激活（setActiveSessionInfo + appendBound + context 注入） |
| `src/rebuild.ts` | resolveSessionMdPath 第 0 候选（skiff 会话角色 boundSession） |
| `src/skiff-admin.ts`（或 role validate 所在） | validate/list 补 boundSession 检查/展示 |
| tests | skiff-role + rebuild + skiff-core + validate 补用例 |
| CHANGELOG.md | v1.30.3 段 |

**零改动**：guards.ts（工具白名单不含 boundSession 逻辑）、context/bootstrap/compact（保持旁路）、keeper（已支持）。

---

## 5. 测试计划

| 模块 | 用例 |
|------|------|
| skiff-role `resolveRoleBoundSession` | boundSession "S159" → 精确定位 dirName/mdPath / "S31" → padStart 定位 / 完整目录名 / 定位失败（不存在/无 SESSION.md）→ null / 未配置 → null |
| skiff-core createSkiffAgent | role 配 boundSession → 激活该 SESSION（getActiveSessionInfo(scope) 命中）/ 未配 → 不激活（现状零回归）/ resume 路径同样激活 |
| rebuild resolveSessionMdPath | skiff 会话 + boundSession → 返回 bound 的 mdPath（即使 findLatestActiveSessionMd 指向别的目录）/ bound 目录删除 → 掉回原 4 层 / 非 skiff 会话 → 零影响 |
| validate | boundSession 定位成功 pass / 定位失败 issue / session!=true 提示 issue |
| 全量 | 62 files / ~905+ tests 全绿 |

---

## 6. 开放问题（待审核拍板）

| # | 问题 | 候选 | 建议 |
|---|------|------|------|
| Q1 | boundSession 激活时机：create 时激活是否够？resume（进程重启恢复 live）路径是否需要同样激活？ | A 仅 create B create+resume 都激活（重挂 setup 时） | **B**——微信 zhaocai 重启后 resume live，若只 create 激活则重启后第一次对话 bound 丢失 |
| Q2 | 自动激活是否向用户显示 [SESSION CONTEXT] 标记（噪音）？ | A 完整 use context B 静默 setActive（只写内存+bound，不注入长文本） | **B**——skiff 对话面应纯净；SESSION 绑定是内部机制，不需要用户看到 use 输出 |
| Q3 | 若角色的 boundSession 在重建后指向已归档会话（findSession 仍能找到）→ 自动续用旧轨迹？ | A 续用（归档的 SESSION 仍可 rebuild 续写）B 报错引导新建 | **A**——归档 ≠ 不可续（logbook use 可 reopen）；与 logbook 语义一致 |
| Q4 | 多实例同 CCC（并行 skiff 会话同角色）共享 boundSession → 冲突？ | A 允许（同 SESSION 并行——与主舱多会话同 SESSION 语义一致）B 互斥锁 | **A**——logbook 本就允许 scope 各自激活；写入 SESSION.md 的串行由 agent 纪律保证 |

---

## 7. 参考

- `docs/skiff-design.md`（F4 原设计；§4.5 拦截缝旁路表；§9 Q2 rebuild 依赖缺口）
- `src/rebuild.ts`（resolveSessionMdPath 4 层候选 + queueRebuild + registerRebuildTurnHook）
- `src/session-ops.ts`（findSession/useSession/setActiveSessionInfo + activeStore）
- `src/session-bound.ts`（serenity/bound 事件持久化）
- `src/skiff-core.ts`（createSkiffAgent/liveReuseRef）
- SESSION.md §8「skiff 绑定 trajectory」调研条目（2026-09-06 起完整调研记录）
