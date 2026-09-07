# Skiff 专属 trajectory（自动创建/按用户）——设计 v0.3 FINAL

> 状态：**已拍板，实现中**（2026-09-07，S142）
> v0.2 → v0.3：粒度确认 per skiff 会话（微信按用户各自 SESSION）+ 命名拍板（只编号）
> 用户拍板全录：① zhaocai +write/edit ② keeper 开（机制的一部分）③ 新建专属 SESSION（不延续 S159）④ 多微信用户 = 各自 SESSION ⑤ 命名只编号

---

## 0. 概念（用户定调）

**SESSION = 工作台**。主舱/skiff/任何 agent 同一套机制（logbook create/use/rebuild + SESSION.md 读写）——**不因 skiff 调整**。

- 普通 skiff = 权限受限的 agent（tools/msms 白名单），无工作台（现状零变化）
- 配了 session 能力的 skiff = **同一**受限 agent，但**自动拥有专属工作台**——SESSION 是谁系统自动定（懒创建），不打印激活噪音，重启恢复记得

## 1. 需求

1. skiff 角色配 `trajectory.session=true` → 该角色 skiff 会话自动获得专属 SESSION（自动创建/自动管理，用户不关心编号）
2. **按 skiff 会话（= 微信用户）各自建**——yh/Danica 同路由 zhaocai 但各自 SESSION，scope 天然隔离，永不并行写同一份
3. 绑定的 skiff 完整使用 SESSION 机制：SESSION.md 读写（write/edit 白名单）、logbook use/show/rebuild/close、keeper（按 trajectory 门控）——与主舱同语义
4. 绑定随会话持久化（重启恢复记得）；无 session 能力 skiff 现状不变

## 2. 机制

### 2.1 自动获得专属 SESSION（懒绑定，per skiff 会话）

**文件**：`src/skiff-core.ts` createSkiffAgent（create/resume/live 三路径统一调用）

```ts
/**
 * 确保启用 session 能力的 skiff 会话拥有专属 SESSION（懒绑定，幂等）：
 * ① 会话日志已有本角色专属 bound → 恢复（重启/续接记得）
 * ② 无 → 自动创建专属 SESSION（createSession desc=`${roleName} skiff`，编号自动递增）
 * ③ setActiveSessionInfo(scope) + appendBound 持久化
 * scope = skiff 会话 id（微信 = 用户 hash id）——per 用户各自绑定，天然隔离
 */
export async function ensureSkiffSession(
  root: string,
  agent: Agent,
  roleName: string,
  role: SkiffRoleConfig,
): Promise<string | null> {   // 返回 SESSION.md 路径（供提示词注入）；未启用/失败 → null
  if (!trajectorySubset(role).session) return null
  const session = agent.session as Session | null | undefined
  const lastBound = session ? readLastBound(session) : null
  // ① 已有本角色专属 bound（dirName 含 `<role> skiff` 标记或经 createSession desc 重建可辨）→ 恢复
  if (lastBound?.mdPath && existsSync(lastBound.mdPath)) {
    setActiveSessionInfo(String(agent.id), {
      sessionId: lastBound.sessionId ?? '',
      dirName: lastBound.dirName,
      mdPath: lastBound.mdPath,
    })
    return lastBound.mdPath
  }
  // ② 无 bound → 自动创建（desc = `<role> skiff`——编号自动，用户不关心是谁）
  const created = createSession({ root, desc: `${roleName} skiff`, dryRun: false })
  const mdPath = join(created.sessionPath, 'SESSION.md')
  setActiveSessionInfo(String(agent.id), {
    sessionId: created.sessionId,
    dirName: created.dirName,
    mdPath,
  })
  appendBound(agent.session, 'create', {
    dirName: created.dirName,
    mdPath,
    sessionId: created.sessionId,
    note: `auto-created for skiff role ${roleName}`,
  })
  return mdPath
}
```

- **复用**：`readLastBound`/`appendBound`（session-bound.ts）、`createSession`（session-ops 标准创建+自动编号）、`setActiveSessionInfo`（scope 隔离）、`trajectorySubset`（skiff-role）
- **createSession 的 summary 限制**：工具层 create 要求 summary（标题用），但这里自动创建走 createSession 底层（无标题重命名需求——skiff 会话标题不强制）。验证 createSession 签名（dryRun/desc 必填，summary 在工具层）——**底层 createSession 无需 summary** ✓（工具层才强制）

### 2.2 SESSION 机制零特调（全量可用）

| 能力 | 通道 | 说明 |
|------|------|------|
| SESSION.md 读写 | `write`/`edit`（白名单授权） | skiff 自己写工作台；**无任何"只限 AGENT_SESSIONS/"特调守卫** |
| logbook | use/show/rebuild/close（白名单授权） | resolveSessionMdPath 首候选 getActiveSessionInfo(scope) 已命中自己 SESSION → rebuild 落自己工作台 |
| keeper | trajectory.keeper=true | 计分提醒 + rebuild 压力检测（既有 skiffTrajectoryEnabled 门控） |
| close | logbook close | 关自己绑定 SESSION（U7 语义） |

### 2.3 工作台告知（systemPrompt 静默注入）

createSkiffAgent 的 serenity-skiff section 构建处，绑定后追加：
```
Your trajectory workspace SESSION.md: <mdPath>
（你的工作台——用 write/edit 记录进度决策；logbook rebuild 从此续接）
```
- 注入 agent 上下文（systemPrompt），**不进用户可见对话**（微信面干净）
- 模型知道路径 → read/写/rebuild 自然工作

## 3. 权限扩展（zhaocai CCC 配置）

```jsonc
"zhaocai": {
  "trajectory": { "session": true, "keeper": true, "rebuild": true },
  "tools": [
    "read", "grep", "glob", "web_search",
    "write", "edit",       // 新增：SESSION.md 读写
    "logbook", "msm"
  ]
  // msms 19 项不变
}
```
- keeper 开 = 计分提醒/rebuild 压力检测注入上下文（机制的一部分）
- zhaocai.md 提示词更新：专属 SESSION 自动创建说明 + 工作台纪律（SESSION.md 归自己维护）+ logbook rebuild 用法

## 4. 改动文件清单

| 文件 | 改动 |
|------|------|
| `src/skiff-core.ts` | `ensureSkiffSession` + createSkiffAgent 调用 + systemPrompt 注入工作台路径 |
| `src/skiff-role.ts` | （如需要）SESSION.md 路径定位辅助 |
| tests | skiff-core：启 session 首建/有 bound 恢复/未启零变化/幂等/两用户隔离 |
| `.opencode/serenity.json`（CCC） | zhaocai tools +write/edit + keeper:true |
| `.opencode/skiff/zhaocai.md`（CCC） | 工作台纪律段更新 |
| CHANGELOG.md | v1.30.3 段 |

**零改动**：session-ops/rebuild.ts（resolveSessionMdPath 已走 getActiveSessionInfo）/guards.ts/context/bootstrap/compact

## 5. 测试计划

| 用例 | 断言 |
|------|------|
| trajectory.session=true + 无 bound → createSkiffAgent 自动建 | AGENT_SESSIONS/ 新增 `<date>--S###--zhaocai skiff/` 含 SESSION.md + getActiveSessionInfo 命中 + appendBound create |
| 有 bound（重启 resume）→ 恢复 | 复用既有 mdPath 不新建 |
| session=false → 零变化 | 无创建/无 bound/无激活 |
| 幂等（同 agent 多轮） | 只建一次 |
| 两 skiff 会话（模拟两微信用户）| 各自独立 SESSION（dirName 不同）+ 互不覆盖 bound |
| 绑定后 logbook rebuild | resolveSessionMdPath → 自己 mdPath（不劫持 findLatestActiveSessionMd） |
| systemPrompt 含工作台路径 | serenity-skiff section 文本含 SESSION.md 路径 |

## 6. 迁移（S159 处置）

用户拍板：**新建专属 SESSION，不延续 S159**。zhaocai 微信会话旧 bound 指向 S159——新机制首次运行时：
- readLastBound 读到 S159（旧手工 use 的）→ **不恢复**（S159 是 workaround 产物，退役）
- 判定"已有专属 bound"不能只看 readLastBound 非空——需识别**是否本机制自动建的**（note='auto-created' 标记）

```ts
// 修正 2.1 ①：只恢复本机制自动创建的 bound（note=auto-created）；旧手工 bound（S159）不认 → 新建
const lastBound = session ? readLastBound(session) : null
if (lastBound?.note?.startsWith('auto-created') && existsSync(lastBound.mdPath)) {
  // 恢复
} else {
  // 新建（createSession + appendBound note='auto-created for skiff role …'）
}
```

S159 目录保留（历史参考），不再被 zhaocai 自动使用。

## 7. 参考

- v0.1/v0.2（方向修正过程归档）
- session-bound.ts（appendBound note 字段——auto-created 标记复用）/ session-ops.ts（createSession/setActiveSessionInfo）/ skiff-core.ts / weixin-route.ts（weixinSessionIdFor per-user）
