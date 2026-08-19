# dsh-serenity-hooks — Native Cordis 插件设计（修改 DSH 核心 loop 行为）

> 状态：**实现完成 v1.2.0**（2026-08-06）。对应需求：**"我希望改动核心 dsh loop 的行为"** + **"形态和工程成本更低，可以完全 native cordis plugin 实现吗"**。
> 目标：把 ACC 从"技能协议（advisory）+ 模板安装器"收敛为**一个 Native Cordis 插件**（真实 DSH 工具 + 拦截缝机械约束）。
> 依据：DSH 源码 interception-seams Agent Note + interception.spec.ts 工作示例 + plugin-include 补丁语义（已验证 config.yaml 可新增插件行）+ dsh-external 参考插件（tool-calculator 金标准 / my-rsi 规范）。

## 实现状态（v1.2.0）

| 缝 | 实现 | 版本 |
|----|------|------|
| `tools/pre-execute` + `ctx.tools.guard` | 安全模式/黑名单/路径逃逸（src/seams/guards.ts） | v1.0.0 |
| `tools/post-execute` | session-keeper DCP（src/seams/keeper.ts，observe-and-enrich） | v1.1.0 |
| `agent/session-start` | ACC 身份播种（src/seams/context.ts） | v1.2.0 |
| `agent/prompt-submit` | 首次进入 CCC 附加身份（src/seams/context.ts） | v1.2.0 |
| 真实工具 ×5 | cc_fs/session/acc_kit/cc_git/acc_msm（src/tools/） | v1.0.0-v1.1.0 |

质量：51/51 vitest + typecheck 过真实 DSH 类型契约 + `dsh.plugin.json`（与 plugin-registry 清单协议格式一致）+ invariant 伴生。

**加载**：`scripts/load-plugin.sh`（构建→链接 node_modules→config.yaml insert→重启提示）。待用户批准执行实测。

---

## 0. 为什么收敛为纯 native 插件（成本对比）

| 维度 | 现状（v0.1-v0.3 技能形态） | 纯 native 插件形态 |
|------|---------------------------|-------------------|
| 工具 | 技能文档 + bash spawn runner（自包含 TS） | **ctx.tools.register 真实 DSH 工具**（zod schema，进程内，无 spawn） |
| 约束 | 技能协议（advisory）+ 平台沙箱 | 拦截缝机械执行（deny/guard/steer） |
| 分发 | 安装器 CLI + 模板拷贝 + CCC/用户双目标 | **~/.dsh/config.yaml insert 行**（免改源码） |
| 同步 | 已安装副本需 --force 重装 | 无副本概念（插件即源码） |
| 测试 | vitest + spawn 集成 | interception.spec.ts 同款 harness |
| 知识 | 9 个 SKILL.md | 保留 eap/neat/入口（知识不进系统提示，最省 token） |

**净结论**：工程成本**更低**——去掉分发/安装/同步/自包含纪律四层，换一个插件包。

## 0.1 加载可行性（已验证 ✅）

`@cordisjs/plugin-include` 的 `applyEntryPatches` 源码（vendor/cordis）：

```ts
if (insert) {
  if (id) { /* 向 group 追加 */ }
  else { data.push(...insert) }   // ← 无 id：直接追加顶层 entry
}
```

→ `~/.dsh/config.yaml` 新增插件行（**无需修改 DSH 源码/cordis.yml/staging**）：

```yaml
- insert:
    - id: serenity-hooks
      name: '@shgroup/dsh-serenity-hooks'
      config:
        serenityConfigPaths: ['.dsh/serenity.json', '.opencode/serenity.json']
```

插件包需能被进程模块解析（`pnpm add --no-save` 或 file: 链接装入 DSH node_modules）。Web 的 personal-config HMR watcher 存在；首次加载新包稳妥起见重启一次 `dsh web`。

**解析路径（已源码验证）**：`boot()` 设 `ctx.baseUrl = <config 文件目录> = apps/cli/config/`；plugin-loader `new URL(name, baseUrl)` 解析 → node_modules 沿 `apps/cli/config → apps/cli → <staging 根>` 上溯。**链接到 staging 根 `node_modules/@shgroup/dsh-serenity-hooks` 即可被解析**（load-plugin.sh 已按此实现）。

## 0.2 插件包放置（决策点）

| 选项 | 加载 | 成本 |
|------|------|------|
| **A. 独立包 `@shgroup/dsh-serenity-hooks`**（本仓即包源码，file: 链接进 DSH node_modules） | config.yaml insert + 本地链接 | 低；无 staging 维护；升级 DSH 零合并 |
| B. DSH checkout `packages/hooks/` | 需 dsh-customize 流程（task worktree + staging merge.lock） | 高；每次 DSH 升级合并 |

**推荐 A**（满足"成本更低"）。

## 1. 插件身份与形态

```ts
// packages/hooks/dsh-serenity-hooks/src/index.ts（将放入 DSH checkout 的 packages/hooks/）
import type { Context } from 'cordis'
import z from 'schemastery'

export const name = 'dsh-serenity-hooks'
export const inject = [] // 全部通过 ctx.on/ctx.get 按需访问（参考 hooks-claude 只 inject bash 的谨慎）
export interface Config { /* 见 §4 */ }
export const Config: z<Config> = z.object({ /* schemastery 声明 */ })

export function apply(ctx: Context, config: Config) {
  // §2 各拦截缝订阅
}
```

**硬约束（来自 DSH 后见之明 postmortem 0001）**：`name`/`inject`/`Config`/`apply` 命名导出，**无 default export**（default export 会丢 inject）。

## 2. 订阅的拦截缝（interception seams）

> listener 形状取自 `packages/core/agent-loop/tests/interception.spec.ts`（官方工作示例）。

### 2.1 `agent/prompt-submit`（waterfall）→ 准入/注入

```ts
ctx.on('agent/prompt-submit', async (agent, message, signal, next): Promise<PromptDecision> => {
  // 1) session-keeper 提醒：若会话积分超阈值，向 additionalContexts 注入 DCP 提醒
  // 2) ACC 上下文注入：agent.inject() 或 additionalContexts（CCC 名称/root/版本/纪律摘要）
  return next() // 必须委托；context-only 不得短路（会跳过后续策略监听器）
})
```

对应 opencode 插件的 `system.transform` + `messages.transform`。**这是"系统提示注入"的机械版**——每个 prompt 必经。

### 2.2 `tools/pre-execute`（waterfall）→ 权限 gate

```ts
ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
  const root = findSerenityRoot(exec.agent.session.header.cwd)
  if (!root) return next() // 非 CCC，不干预
  // 1) 安全模式：.serenity-safe-on 存在且 exec.name 是 bash/写类工具 → deny
  // 2) 黑名单：exec.name === 'write'|'edit' 且目标路径命中 blacklist → deny（reason 可解释）
  // 3) P3 兜底：目标路径越出 root → deny
  return next()
})
```

对应 opencode 插件的 `tool.execute.before` 路径守卫 + bash 开关。**这是"安全模式/bash 开关"的机械版**。

### 2.3 `ctx.tools.guard()`（同步终局）→ 不可绕过的 deny

```ts
ctx.tools.guard((exec) => {
  const root = findSerenityRoot(exec.agent.session.header.cwd)
  if (root && isSafeModeOn(root) && isWriteTool(exec.name)) {
    return { kind: 'deny', reason: 'safe mode: write blocked' } // guard 只能 deny，不能 allow
  }
  return { kind: 'abstain' }
})
```

guard 在 pre-execute 瀑布之后、执行之前；监听器顺序无法复活被终局不变式否决的操作。**P3 的最终防线**。

### 2.4 `tools/post-execute`（waterfall）→ DCP 反馈通道

```ts
ctx.on('tools/post-execute', async (exec, result): Promise<PostToolDecision> => {
  // session-keeper 计分：write/edit=3, task=10, read/grep/glob/msm=1, 1分/分钟
  // 达阈值 → { kind: 'feedback', feedback: '[SESSION-KEEPER-recorded-S101] ...' } 注入结果
  return { kind: 'accept' }
})
```

对应 opencode 插件的 session-keeper DCP 注入（tool.execute.after 提醒）。

### 2.5 `agent/turn-stopping`（serial）→ 已移除（v1.19.0）

> 原"会话收尾机械落盘 heartbeat"机制经评估无程序价值（写 SESSION.md 不刷新 health 使用的目录 mtime，且无解析消费者）且产生 stray 文件，已整体移除（`seams/loop.ts` 删除、`appendHeartbeat`/`turnFlush` 配置删除）。会话活性改由真实进度记录驱动。

### 2.6 `agent/session-start`（emit）→ Phase 2 访谈 / 上下文播种

```ts
ctx.on('agent/session-start', (agent, source) => {
  if (source === 'startup') agent.inject(/* Phase 2 提示或 ACC 身份摘要 */)
})
```

## 3. 决策类型（DSH 官方契约）

| 缝 | 决策类型 | 值 |
|----|---------|-----|
| prompt-submit | `PromptDecision` | `allow`（可改写 content / 附加 additionalContexts）/ `block` |
| pre-execute | `PreToolDecision` | `allow` / `deny`（跳过执行）/ `ask`（走 approval 缝） |
| guard | `GuardDecision` | `deny` / `abstain`（**不能 allow**） |
| post-execute | `PostToolDecision` | `accept` / `block`+feedback / 替换 content / 附加 context |

**关键语义**：
- context-only 监听器必须 `next()` 委托，否则短路后续策略（interception-seams 笔记明确警告）
- `additionalContexts` 是独立 source 的 `user/message`，按 FIFO 在批次收敛后追加
- `ask` 通过可选 approval 缝解析；无审批服务时 fail-closed 为 deny

## 4. 配置

插件 Config 与现有 `.dsh/serenity.json` 对齐（运行时从 CCC 根读取，保持单真源）：

```jsonc
// .dsh/serenity.json
{
  "loop": { "defaultModel": "..." },          // 现有
  "sessionKeeper": { "threshold": 150 },      // 现有 → 2.1/2.4 使用
  "safeMode": { "blacklist": [".secrets/", "regex:\\.env$"] }, // 现有 → 2.2/2.3 使用
  "hooks": {                                   // 新增：native 插件开关
    "enabled": true,
    "injectAccContext": true,                  // 2.1
    "enforceSafeMode": true,                   // 2.2/2.3
    "sessionKeeper": true                      // 2.1/2.4
  }
}
```

插件顶层 Config（cordis.yml 提供）只需：`serenityConfigPaths: ['.dsh/serenity.json', '.opencode/serenity.json']`（进程级默认）+ 可选默认值。

## 5. 与技能层分工

| 能力 | 技能层（已有） | 拦截缝层（本设计） |
|------|---------------|-------------------|
| 文件系统/会话/MSM 操作协议 | acc-fs/session/msm runners | —（工具语义不重复） |
| 系统提示/身份注入 | acc-serenity（advisory） | prompt-submit 机械注入 |
| 安全模式 | acc-safe-mode 协议 | pre-execute + guard 机械 enforce |
| session-keeper | acc-session 纪律 | post-execute DCP 提醒 |
| 会话落盘 | 模型自觉 | （真实进度记录；heartbeat 已移除） |

## 6. 集成路径（首选：免改源码）

**路线 A（已验证可行，推荐）**：
1. 本仓实现 `@shgroup/dsh-serenity-hooks`（独立包，src/hooks/）
2. `pnpm add --no-save @shgroup/dsh-serenity-hooks@file:../AI_LAB/dsh-serenity-plugin`（装入 DSH node_modules，不改 git）
3. `~/.dsh/config.yaml` 追加 insert 行（见 §0.1）
4. 重启 `dsh web` 验证

**路线 B（备选，需 dsh-customize）**：
- 插件放入 DSH checkout `packages/hooks/dsh-serenity-hooks`，`apps/cli/config/base.cordis.yml` 增行，走 task worktree + staging merge.lock 流程。

**Web production 模式注意**：集成后需重建 web 产物并刷新验证；无 `--dev` 时 HMR 仅覆盖 personal config（insert 行变更会触发 loader 层重载，但新包模块解析稳妥起见重启一次）。

## 7. 测试策略

- 单测：interception.spec.ts 同款 harness（MockAdapter + ctx.plugin(...) 组合 AgentLoop），覆盖每个 seam 的 Decision
- 契约测试：deny 后模型看到 isError 结果；context-only 不短路后续监听器
- 集成：真实 DSH Web 会话验证安全模式开关 + session-keeper 提醒

## 8. 里程碑

- M1（本次）：设计文档 + 加载可行性验证（config.yaml insert）✅
- M2：独立包 `@shgroup/dsh-serenity-hooks` 骨架 + 最小实现（cc-fs/session 2 工具 + pre-execute 安全模式 + turn-stopping 落盘〔heartbeat 已于 v1.19.0 移除〕），config.yaml insert 加载实测
- M3：全量工具（cc-git/msm/acc-kit 转真实工具）+ 全 seams + interception harness 测试
- M4：技能层瘦身（保留 eap/neat/入口，工具技能模板退役）+ SQC 接入

## 9. 风险

| 风险 | 缓解 |
|------|------|
| DSH 升级合并成本 | M2 先验证合并路径；插件保持薄（只订阅事件） |
| config.yaml 不能新增行 | 退回到 base.cordis.yml 加行（需 dsh-customize） |
| guard/pre-execute 顺序语义 | 严格按官方契约：guard 只 deny；pre 只 allow/deny/ask |
| 上下文注入膨胀 token | prompt-submit 注入内容限长 + 阈值触发 |
