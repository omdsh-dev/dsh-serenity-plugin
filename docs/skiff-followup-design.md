# Skiff 增强设计：md 提示词引用 + 会话追问延续（F4 演进）

> 状态：**设计定稿（2026-08-29，S142 用户拍板）**
> 性质：dsh-serenity-plugin Skiff（F4）两项增强
> 关联：`docs/skiff-design.md`（F4 总设计）、`src/skiff-{role,core,registry,debug}.ts`、`src/tools/skiff-admin.ts`

---

## 1. 需求（Neat 需求层，用户 2026-08-29 提出）

1. **R1 md 文件提示词**：CCC 倾向定义超长提示词，在 `.opencode/serenity.json` 内嵌 JSON 字符串很难阅读——希望修正配置方式，**支持引用一个 md 文件**，并**作为推荐配置方法**。
2. **R2 dsh 会话追问**：希望 dsh 会话概念在 skiff 能绑定——**允许用户使用同一个 qa 会话进行追问**（多轮对话，上下文延续），而非当前每次提问新建会话。

---

## 2. 现状（Read-before-write 核验）

| 面 | 现状 | 限制 |
|----|------|------|
| 角色提示词 | `SkiffRoleConfig.systemPrompt: string`（JSON 内嵌） | 超长不可读、无语法高亮、易错转义 |
| 会话创建 | 每次 `POST /ask` → `createSkiffAgent`（新 sessionId `skiff-<role>-<uuid>`） | 无延续，追问即新会话无上下文 |
| 会话注册表 | `skiffAgents: Map<sessionId, Agent>`（skiff-core）+ `skiff-registry: Map<sessionId, role>` | 进程内存态，查询只按 sessionId |
| 恢复路径 | `ctx.agents.resume({resumeSessionId, setup})`（官方，agent-loop） | 未使用；需 sessionPersistence 服务装配 |
| 轨迹读取 | `askSkiff(ctx, agent, question, eventsStart)` eventsStart=0 全量 | 增量能力已具备 |
| 配置读取频率 | `readSkiffRoles` 被 guards/seams **每次工具调用**查询 | md 文件内容不可在 readSkiffRoles 内同步读（IO 热路径） |

---

## 3. R1 方案：systemPromptFile（md 文件引用）

### 3.1 配置 schema（`.opencode/serenity.json`）

```jsonc
{
  "skiff": {
    "roles": {
      "qa": {
        "model": "minimax-cn-coding-plan/MiniMax-M3",
        "msms": ["web-search", "vlm-describe"],
        "tools": ["read", "grep", "glob", "web_search"],
        "trajectory": {},
        // 推荐：引用 md 文件（相对 CCC 根；本 CCC 内文件，git 管理、可读、可高亮）
        "systemPromptFile": ".opencode/skiff/qa.md"
        // 兼容：内嵌字符串仍可用（旧配置不破坏）；两者都设时 systemPromptFile 优先
        // "systemPrompt": "..."
      }
    }
  }
}
```

### 3.2 机制

- `SkiffRoleConfig` 增加 `systemPromptFile?: string`（ccc.ts）
- `readSkiffRoles` **只透传字段不读文件**（保持热路径零 IO）
- 新增纯函数 `resolveRoleSystemPrompt(root, role): string`（skiff-role.ts）：
  - `systemPromptFile` 存在 → `resolveInside(root, file)`（复用 ccc.ts 路径守卫，防逃逸）+ `existsSync` + `readUtf8`（去 BOM，Windows 审计既有函数）→ 返回内容
  - 否则 → `systemPrompt ?? ''`
  - 文件缺失/逃逸 → 抛错（装配层 catch → console.warn + 回退空，validate 报 issue）
- 消费点改用 resolveRoleSystemPrompt：
  - `createSkiffAgent`（skiff-core.ts:99）拼接处
  - `validateSkiffConfig`（skiff-admin.ts:84）非空检查 + **新增文件存在性检查**（缺失 → issue「systemPromptFile not found」）
  - `listSkiffRoles`（skiff-admin.ts:113）`hasSystemPrompt` 改为 resolve 后判断 + 显示来源（file/inline）

### 3.3 推荐配置方法（文档同步）

- `skiff_admin guide`：schema 示例改为 `systemPromptFile` 首选，内嵌标注兼容
- README 双语 + SKILL.md：配置示例同步

---

## 4. R2 方案：会话追问延续（同会话多轮）

### 4.1 核心决策（2026-08-29 用户拍板）

| 决策点 | 拍板结论 |
|--------|---------|
| 会话粒度 | **方案 A：页面级会话**——调试页持有当前 sessionId，追问复用，显式「新对话」开启新会话 |
| 进程内延续 | `skiffAgents` 命中 → 复用 agent.followup（同事件流，上下文天然延续） |
| 跨进程恢复 | **仅进程内延续**（首版不做 resume）——重启后旧会话不可续（会话在 WebUI 仍可见）；resume 留待后续（官方 `ctx.agents.resume` 路径已调研确认可行） |
| 轨迹返回 | **全量重绘**（eventsStart=0，页面每次渲染完整时间线） |
| 版本 | v1.25.10（patch 级，延续 v1.25.x 放缓策略） |

### 4.2 协议（POST /ask 扩展）

```jsonc
// 请求：追问时携带 sessionId（首次不带 → 新建）
{ "ccc": "...", "role": "qa", "question": "...", "sessionId": "skiff-qa-<uuid>" }
// 响应：增加续接信息
{
  "answer": "...", "answer_html": "...",
  "sessionId": "skiff-qa-<uuid>",
  "continued": true,          // 本轮是续接（false = 新建会话）
  "trajectory": [ ... ]        // 全量轨迹（含历史轮）
}
```

### 4.3 服务端逻辑（skiff-debug.ts handle /ask 分支）

```
POST /ask:
  ① 解析 ccc/role/question/sessionId
  ② 无 sessionId → createSkiffAgent（新建，continued:false）
  ③ 有 sessionId：
     a. skiffAgents 命中（进程内）→ 校验 (role, ccc) 与请求一致 → 复用（continued:true）
     b. 未命中（重启后/不存在）→ 400「会话不可恢复，请新对话」（首版不做 resume）
     c. (role, ccc) 不匹配注册记录 → 400「会话属于不同角色/容器」
  ④ askSkiff(agent, question, eventsStart=0) → 全量轨迹返回
```

### 4.4 注册表扩展（skiff-registry.ts）

- 值 `string`（role）→ `{ role: string; ccc: string }`（ccc 用于追问时绑定校验）
- `skiffRoleFor(sessionId)` 返回 role 不变（guards/seams 依赖，向后兼容）
- 新增 `skiffSessionInfo(sessionId): { role, ccc } | null`
- `registerSkiffSession(sessionId, role, ccc)` 签名扩展（skiff-core 调用点同步）
- 注意：**skiffAgents（skiff-core 内存 Map）进程重启清空**，但 DSH JSONL 持久化在——resume 是重启后唯一恢复通道；registry 内存态同样清空 → resume 后重新注册

### 4.5 UI（调试页）

- 顶部状态行：当前会话徽标（sessionId 短显 `skiff-qa-…`）+ 「新对话」按钮
- 追问：输入框直接继续提问（隐含复用当前 sessionId）
- 「新对话」：清空 sessionId + 答案/轨迹区，下次提问新建
- 轨迹区：完整时间线（每轮渲染全量），标注会话 id
- WebUI 链接：沿用（会话列表可见 skiff-* 会话）

### 4.6 生命周期与边界

- 不做 TTL 清理（实验性，简单优先）；进程重启 → skiffAgents 清空，旧会话不可续（WebUI 仍可见历史）
- 「新对话」不 dispose 旧 agent（保留进程内 resume 能力），agent 数随对话数增长（可接受）
- 角色/CCC 切换（页面下拉）→ 自动视为新对话（sessionId 与旧角色不匹配 → 服务端 400，前端清空 sessionId 重建）
- 首版不做跨进程 resume（用户拍板）；官方 `ctx.agents.resume` 路径已调研确认，后续版本可加

---

## 5. 测试计划

- **skiff-role**：`resolveRoleSystemPrompt`（file 优先 / 内嵌回退 / 文件缺失抛错 / 路径逃逸拒绝 / BOM 剥除）
- **skiff-core**：`registerSkiffSession` 三参签名 / `skiffSessionInfo` / 会话复用查询（getSkiffAgent）
- **skiff-debug**：POST /ask 带 sessionId 复用（命中 continued:true / 未命中 400 / 角色不匹配 400 / ccc 不匹配 400）/ 新建 continued:false / 全量轨迹
- **skiff-admin**：validate systemPromptFile 存在性（缺失 → issue）；list 显示来源
- 回归：既有 skiff 测试（guards/keeper/context/compact/bootstrap 的 `skiff-` 前缀断言不受注册表值结构影响）

---

## 6. 版本与发布

- **v1.25.10**（用户拍板：patch 级，延续 v1.25.x 放缓策略）
- 发布链路照旧：typecheck → test → build → bump 三处 → CHANGELOG → commit → publish npm → github-push 双推 → deploy → restart-web
- README 双语 + SKILL.md（D31）+ SESSION.md 同步

---

## 7. 决策记录（2026-08-29 用户拍板，R↓）

1. 会话粒度：**页面级会话 + 新对话按钮**（方案 A）——最符合「同一个 qa 会话追问」语义，UI 改动小
2. 跨进程恢复：**仅进程内延续**（首版不做 resume）——resume 留待后续（官方路径已调研可行）
3. 轨迹返回：**全量重绘**——简单可靠，调试页流量可忽略
4. 版本号：**v1.25.10**——功能 minor 但用户选择 patch 放缓
5. md 推荐目录：`.opencode/skiff/`（跟随 CCC 认知基础设施，git 管理）
