# Skiff — 宁静号 trajectory 子集角色机制（F4 设计文档）

> 状态：设计定稿（2026-08-28，S142 用户逐轮拍板；命名 **Skiff（舢板）**——用户从隐喻候选选中）
> 性质：dsh-serenity-plugin F4 功能组——把 CCC 的认知能力通过 ACP 协议暴露为**可配置子集角色**
> 前置调研：`docs/knowledge-ccc-release-research.md`（ACP 生态/IM 桥/OpenClaw 资产）
> 关联：F1 双端口网关（传输面参考）、handyman（agent 创建参考）、guards（工具面机制参考）

---

## 0. 概念地基（用户拍板）

**完整宁静号 trajectory = 在宁静号内全知全能**：

| 维度 | 全知全能（完整轨迹） |
|------|---------------------|
| 能力面 | 全部平台工具 + 全部 ACC 工具 + 全部注册 MSM |
| 认知范围 | 全部认知（读全部知识 + 写知识/技能/配置） |
| 轨迹纪律 | SESSION.md 载体 / keeper 计分 / rebuild / tracking 全参与 |

**Skiff = 宁静号放出的小艇**——CCC 从全知全能空间切出的任意子集（用户 2026-08-28 修正：不限于问答/只读）：

- 例 A `qa-readonly`：{ MSM 白名单: [cognitive-qa]，无直接工具，无轨迹纪律 } —— 认知问答
- 例 B `code-review`：{ MSM 白名单: [review-scan, review-fix] + 直接工具白名单: [read,grep,glob,write,edit]，轨迹纪律部分参与 } —— **有操作能力**（可写修复）
- 子集表达二维：**① 能力面**（MSM 白名单 + 工具白名单）**② 轨迹纪律面**（session/keeper/rebuild/tracking 参与项）——边界全由 CCC 角色配置决定

**隐喻映射（The Ship 域）**：

| 概念 | 隐喻 |
|------|------|
| 完整 trajectory（全知全能） | 宁静号本体 |
| Skiff 角色 | 宁静号放出的小艇（按任务装配、载量有限、自带航行指令、可独立可归队） |
| tools/msms 白名单 | 小艇的**载货清单**（Manifest——与既有 "The Manifest → 单一真相源" 隐喻同源） |
| ACP server | 码头（小艇停靠与外界交易） |
| 调试问答页 | 舷窗/瞭望窗 |
| sessionId 前缀 | `skiff-<role>-<uuid>` |

**术语**：认知（cognition，非 knowledge）——Skiff = CCC 认知子集角色；对齐 specs v1.3.0 认知容器理论（认知发生/存储/再发生；Loop；trajectory 主体）。

---

## 1. 需求（Neat 需求层）

1. 把知识型 CCC 的认知能力通过 **ACP 协议**暴露为可编程服务（问答助手 / IM 机器人 / 内部工具调用）
2. ACP 进 **dsh-serenity-plugin**（F4，用户拍板纳入 dsp）
3. **角色机制 Skiff**：CCC 定义角色，每个角色 = 全知全能轨迹的一个子集（不限于问答/只读，可有操作能力）
4. **全按白名单暴露**（用户拍板）：MSM 独立白名单 + 非 MSM 工具独立白名单；白名单外一律隐藏（全量隐藏为默认）
5. 系统提示词：dsp 只给**基础部分**（可用 MSM/工具清单 + 调用协议），**CCC 完整定义**角色人格/边界/风格
6. Skiff 默认不使用 trajectory 机制（不建 SESSION.md、无 keeper、无 rebuild）——**相当独立**；轨迹纪律按角色配置选择性开启（子集边界 CCC 定）
7. 记录（tracking）由 CCC 决定：不记录 / 会话记录 / 访问日志
8. 模型按角色配置（不同 Skiff 可不同模型）
9. 调试便利：暴露**调试端口渲染问答页面**（测试用，走同一 ACP 逻辑）

---

## 2. 总体架构

```
                     ┌─────────────────────────────────────────────┐
                     │             dsh-serenity-plugin (dsp)        │
                     │                                             │
  ACP client         │  ┌─ F4a: ACP v1 server ─────────────────┐   │
 (OpenClaw / IM桥 /  │  │ JSON-RPC stdio（主传输）               │   │
  调试页/内部工具) ────┼─▶│ 7 方法: initialize/authenticate(no-op)/│   │
                     │  │ session/new|prompt|cancel|update|      │   │
                     │  │ request_permission                    │   │
                     │  └───────────────┬───────────────────────┘   │
                     │                  │ sessionId → role 映射      │
                     │                  ▼                           │
                     │  ┌─ F4b: Skiff 装配层 ────────────────────┐   │
                     │  │ ctx.agents.create（per ACP session）   │   │
                     │  │ ① 双白名单暴露（tools + msms）          │   │
                     │  │ ② 基础提示词 + CCC 完整定义拼接          │   │
                     │  │ ③ 拦截缝旁路（按轨迹纪律子集选择性开启）  │   │
                     │  │ ④ 角色模型（per-role model）            │   │
                     │  └───────────────┬───────────────────────┘   │
                     │                  ▼                           │
                     │  ┌─ 拦截缝（既有，按角色旁路）──────────────┐ │
                     │  │ guards（角色白名单规则）                │ │
                     │  │ acc_msm（msms 白名单校验）              │ │
                     │  │ msm_list（白名单过滤显示）              │ │
                     │  │ keeper/bootstrap/context/compact（旁路）│ │
                     │  └───────────────────────────────────────┘ │
                     └─────────────────────────────────────────────┘
                                     │
                                     ▼
                    CCC 认知（.opencode/skills/**、docs、references）
                    经白名单 MSM 脚本访问（脚本层不受 agent 工具面约束）
```

---

## 3. Skiff 会话核心（v1.25.0 首版范围）

> **首版范围（用户拍板 2026-08-28）**：v1.25.0 **只提供调试页**作为客户端面——ACP stdio 协议层推迟到后续版本（F4c，OpenClaw/IM 集成时再上）。调试页驱动与 ACP 同一会话核心，协议层后加不返工。

### 3.1 会话核心（v1.25.0）

- 每个问答会话 → `ctx.agents.create({ sessionId: 'skiff-<role>-<uuid>', agentOptions: { provider, model: role.model }, cwd: CCC root })`——**标准 DSH agent**，跑 DSH agent-loop（模型自主循环调用工具直到 turn 结束）
- 驱动：`agent.followup(createUserMessage(...))` → 等 idle → 读 `session.events` 取 committed 答案（handyman 同款已验证模式）
- **轨迹可读**：`session.events` 是 append-only 完整日志（user/assistant/tool 消息 + 工具调用 + 工具结果）——调试页直接渲染，与 dsh WebUI 同源数据
- cancel → interrupt；连接/页面关闭释放会话

### 3.2 调试页（v1.25.0 唯一客户端面）

- `skiff.debugPort`（如 3099）node:http，默认关，**仅监听 127.0.0.1**；**启停 = 人工**（设置面板「Serenity」页 Skiff 区块开关，不随插件加载自动启动）
- **GET /** → 问答 HTML 页（角色选择 + 输入框 + 回答区 + **轨迹区** + 「在 dsh WebUI 查看完整轨迹」链接）
- **POST /ask** `{role, question}` → 走会话核心 → 返回 `{ answer, sessionId, trajectory }`
- **轨迹 = 直接渲染（用户拍板 2026-08-28）**：`session.events` 结构化返回（user/assistant/tool + 工具调用名/参数 + 结果）→ 页面 JS 渲染成对话时间线（与 dsh WebUI 同源数据，简化版）；同时保留原生 WebUI 会话链接（`http://127.0.0.1:3080/<session 路由>`，路由实施时核对；兜底提示"会话列表查找 <sessionId>"）——原生视图有完整交互，两全
- 调试便利优先，非产品形态；产品客户端面 = 后续 ACP（§3.3）

### 3.3 ACP v1 server（后续 F4c，契约保留）

| 方法 | 语义 |
|------|------|
| `initialize` | 协议握手（协议版本 v1；capabilities 声明） |
| `authenticate` | no-op（ACP v1 无认证；Skiff 部署面处理见 §8） |
| `session/new` | 创建 Skiff agent（fresh）+ 持久化 + 返回 sessionId |
| `session/prompt` | 提交问题（文本+图片），返回 **committed 答案**（非流式） |
| `session/cancel` | 中断当前 prompt（DSH interrupt） |
| `session/update` | 更新会话参数（可选：persona/model 热更） |
| `session/request_permission` | v1 忽略（G9：白名单即授权，不逐次确认）→ 恒 allow |

- **stdio（主）**：JSON-RPC over stdio（帧格式对齐官方 packages/acp；stdout 只承载协议帧）——OpenClaw ACP client spawn 模式
- 与调试页共用同一会话核心（§3.1），只换客户端面

---

## 4. Skiff 装配层（F4b）——机制 4 件套

### 4.1 双白名单暴露（用户拍板：全按白名单）

**默认全隐藏**；两个独立白名单逐角色配置：

```jsonc
// CCC 配置（.opencode/serenity.json 新增 skiff 段）——角色归 CCC
{
  "skiff": {
    "debugPort": 3099,                     // 调试问答页端口（v1.25.0 唯一客户端面；默认关，仅 127.0.0.1）
    "roles": {
      "code-review": {
        "model": "minimax-cn-coding-plan/MiniMax-M3",   // 角色模型（G6）
        "msms": ["review-scan", "review-fix"],          // MSM 白名单（独立）
        "tools": ["read", "grep", "glob", "write", "edit"], // 非 MSM 工具白名单（独立；缺省空=仅 MSM）
        "trajectory": {                                  // 轨迹纪律子集（G4，CCC 定）
          "session": false,
          "keeper": false,
          "rebuild": false
        },
        "tracking": "none",                // G3：none | session | log（CCC 定）
        "systemPrompt": "…CCC 完整定义…"   // 角色人格/边界/风格
      }
    }
  }
}
// transport（ACP stdio）为后续 F4c 字段，v1.25.0 不启用
```

| 白名单 | 管什么 | 强制点 |
|--------|--------|--------|
| `tools` | 非 MSM 工具（平台 read/write/edit/glob/grep/... + ACC cc_fs/session/cc_git/acc_kit/eap/neat/cce/handyman/session_rebuild/localstore） | **guard 角色白名单规则**（§4.3）：角色 agent 的工具不在 `tools` → deny |
| `msms` | 注册 MSM 的执行面 | **acc_msm 内校验**（§4.4）：exec 非白名单 MSM → 拒绝；register/deregister 必拒；msm_list 白名单过滤显示 |

**通道规则**：
- `msms` 非空 → acc_msm 工具自动可用（MSM 通道）；`msms` 空 → acc_msm 不可见（除非 tools 显式列出——不建议）
- `tools` 空 + `msms` 非空 = 纯 MSM 角色（认知问答典型形态）
- 白名单外的工具即使 DSH 未来新增也自动被挡（guard 按角色判定，不枚举工具名——完备性）

### 4.2 基础提示词 + CCC 完整定义拼接

```
=== Serenity Skiff ===
Role: <role>（由本 CCC 定义）
You interact with this CCC ONLY through the exposed surface below:
  MSMs: <msms 白名单>（acc_msm exec <name> [args...]；首参 --help 查看用法）
  Tools: <tools 白名单>
No other tools are available. Your capability boundary is this surface.
---
<CCC 定义段（systemPrompt 全文）拼接>
```

- dsp 基础段：身份 + 可用 MSM/工具清单 + 调用协议 + 边界声明（5 行内）
- CCC 段：完整角色设定（人格/认知边界/回答风格/任务流程）——**全替换 ACC 默认注入**
- 基础段内容随角色白名单动态生成（清单来自配置）

### 4.3 工具白名单强制（guard 角色规则）

- guards.ts 瀑布新增规则（终局 guard 同款模式）：`isSkiffSession(sessionId)` → 查 sessionId→role 映射 → 工具名 ∈ role.tools ∪ {'acc_msm'(若 msms 非空)} 否则 deny（拒绝信息泛化，不泄漏白名单外工具名）
- 注册点：ACP server 维护 `Map<sessionId, role>`；角色 agent 创建时注册，连接释放时清理

### 4.4 MSM 白名单强制（acc_msm 内校验）

- `acc_msm exec <name>`：查 agent 角色 → name ∈ role.msms 否则拒绝（"MSM not allowed"，不列名单）
- `acc_msm list`：只显示 role.msms 内条目（协议 flag `--format=json` 同步过滤）
- `acc_msm register/deregister`：Skiff agent 必拒
- `check/guide/ccc-config`：只读，可留白名单内（默认放行，CCC 可配）
- protocol flags（`--list/--schema`）对白名单内 MSM 放行（自描述仍可用）

### 4.5 拦截缝旁路（G1，按轨迹纪律子集选择性开启）

| 拦截缝 | 默认（轨迹纪律全关） | trajectory.session=true | trajectory.keeper=true |
|--------|---------------------|------------------------|------------------------|
| session-start 播种（accMessage + entry skill section） | **旁路** | 旁路（Skiff 用 CCC 提示词，不注入 ACC 身份） | 旁路 |
| pre-step 注入 | **旁路** | 旁路 | 旁路 |
| keeper 计分 + [TRAJECTORY-STEWARD] | **旁路** | 旁路 | 开启（计分提醒按角色生效） |
| bootstrap first-anchor 锚定 | **旁路** | 旁路 | 旁路 |
| compaction/end 重注入 | **旁路** | 旁路 | 旁路 |
| rebuild 压力检测 | **旁路** | 旁路 | 开启 |
| session 工具 | 不可见（不在 tools） | 角色配置可暴露 | — |

- 实现：`isSkiffSession(sessionId)` 共享判定（仿 `handyman-` 前缀排除模式）+ 角色轨迹配置查询；seams 各自检查

### 4.6 角色模型（G6）

- per-role `model`（provider/model）；缺省回退 CCC handyman.defaultModel
- 白名单校验：复用 `handyman.models` 白名单（模型归属 CCC 配置，与 handyman 一致）——CCC 一处配模型白名单，Skiff 从中选

### 4.7 skiff_admin 工具（教 CCC 如何定义 skiff，用户拍板 2026-08-28）

新增 ACC 工具 **`skiff_admin`**（第 12 个工具；仿 session 工具 `hook-develop-guide` 的 SEP 教学模式）：

| 子命令 | 内容 |
|--------|------|
| `guide` | **定义教程**（核心）：skiff 概念（全知全能轨迹子集）/ 角色配置 schema / 认知 MSM 写法（读知识/操作能力示例）/ 双白名单语义（tools+msms）/ 轨迹纪律子集 / tracking / 基础提示词 + CCC 定义段拼接 / 示例角色（qa-readonly、code-review） |
| `validate` | 校验当前 CCC 的 `skiff` 配置：roles schema 合法 / msms 均已注册 / model ∈ handyman.models / systemPrompt 非空——输出问题清单 |
| `list` | 列出当前 CCC 已定义角色（名 / 模型 / msms / tools / 轨迹纪律摘要） |

- 注册：invariant REGISTERED_TOOLS 11 → 12；系统提示词 accBlock 工具清单 + 1 行；README/skill 文档同步
- 归属：ACC 机制工具（教会 + 校验），角色内容仍归 CCC 配置

### 4.8 skiff 启动 = 人工（CCC 配置面板，用户拍板 2026-08-28）

- **启停不随插件加载自动执行**——人工在设置面板「Serenity」页的 **Skiff 区块**开关（同 gateway 开关模式：enable + debugPort；角色列表只读摘要）
- 角色定义（roles）仍在 CCC 配置（`.opencode/serenity.json`）；面板只控制**运行时启停**
- 未开启时 skiff 服务零资源占用（无监听、无 agent 创建）

---

## 5. 记录（G3，CCC 决定）

| tracking | 行为 |
|----------|------|
| `none` | 不额外留痕（dsh ACP 会话 JSONL 为技术审计，天然存在） |
| `session` | ACP session/new 时自动 `session create --desc "skiff-<role>"` → SESSION.md 建立（轨迹纪律子集含 session 时的默认） |
| `log` | append 访问日志（时间/role/问题摘要/答案摘要 → `AGENT_SESSIONS/skiff-access.log` 或配置路径） |

---

## 6. 责任边界（G8）与安全（G5/G9）

- **G8 责任边界**：MSM 在脚本层执行（bun + SERENITY_ROOT env），文件访问**不受 agent 工具面约束**——角色能力上限 = 白名单 MSM/工具的实际行为；"只读"语义靠 CCC 自写 MSM 自觉，dsp 不做静态分析（文档明示）
- **G9**：`request_permission` v1 恒 allow（白名单即授权）
- **G5 安全**：stdio 先行零认证问题（连接方 = 启动进程者）；TCP 若未来开放 → 复用 F1 网关反代认证或简单 token——后议
- 调试端口默认关；开启时仅监听 127.0.0.1（测试便利优先，不引入公网面）

---

## 7. F4 分期（v1.25.0 首版 = 调试页 + Skiff 机制；ACP 协议后续）

| 阶段 | 版本 | 内容 | 估量 |
|------|------|------|------|
| F4a' | v1.25.0 | 会话核心 + 调试页：agents.create/followup/events 答案读取 + 调试端口问答页（轨迹复用原生 WebUI 会话视图）+ **skiff_admin 工具**（guide/validate/list）+ **设置面板 Skiff 区块**（人工启停）+ 测试 | 中（~600 行 + 测试） |
| F4b | v1.25.0 | Skiff 机制：角色配置 schema（config-ops）+ 双白名单强制（guard 角色规则 + acc_msm/msm_list 白名单）+ 拦截缝旁路 + 基础提示词拼接 + per-role model + tracking + 测试 | 中（~500 行 + 测试） |
| F4c | 后续 | ACP v1 server（stdio 7 方法，复用会话核心）+ OpenClaw B2 实测 + README/skill 文档 | 中 |

## 8. 测试计划

- 会话核心：followup 往返 committed 答案 / cancel / 会话释放
- 调试页：GET 渲染 / POST ask 返回 {answer, sessionId, trajectory} / trajectory 含工具调用+结果 / 未开启时端口拒绝
- **skiff_admin**：guide 含 schema+MSM 写法 / validate 合法配置通过 + 非法配置报问题（msms 未注册/model 不在白名单/systemPrompt 空）/ list 角色摘要
- **设置面板 Skiff 区块**：开关持久化 / 开启后端口监听 / 关闭后释放
- 双白名单：tools 白名单外工具 deny（guard）/ msms 白名单外 MSM exec 拒绝 / msm_list 过滤 / register-deregister 必拒 / 拒绝信息不泄漏名单
- 拦截缝旁路：keeper 不提醒 / bootstrap 不锚定 / session-start 不注入 ACC 身份
- 基础提示词：动态清单正确 / CCC 段拼接
- tracking：none/session/log 三态

## 9. 开放问题（已收敛）

1. OpenClaw ACP client 连接方式（stdio spawn vs socket）——F4c 实测确认，决定 TCP 是否需要
2. `tools` 白名单暴露 session_rebuild 的依赖（需 trajectory.session=true，否则 resolveSessionMdPath 报错）——文档标注，CCC 自负责
3. 认证（TCP 场景）——后议，非 F4a/F4b 阻塞

## 10. 参考

- `docs/knowledge-ccc-release-research.md`（前置调研：ACP 生态 / IM 桥 / OpenClaw 资产）
- DSH 官方 ACP：packages/acp + examples/acp-agent（dsh-harness-public @ b150a551）
- [ACP v1 协议](https://agentclientprotocol.com)
- guards.ts（工具面瀑布 + 终局 guard 模式）/ tools/handyman.ts（agents.create + followup 模式）/ handyman-preset-inherit.ts（工具面收窄模式）
