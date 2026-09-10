# DSH 0.1.5-rc.1 对 dsp（dsh-serenity-plugin）的适配方案

> 状态：**方案已产出**（含实测证据；实现见 §6 落地清单）
> 日期：2026-09-10（S142）
> 宿主版本：DSH `0.1.5-rc.1`
> dsp 源码根：`AI_LAB/dsh-serenity-plugin/hooks/dsh-serenity-hooks/`（当前 v1.31.5，peerDeps `^0.1.2-rc.1`）
> 前置文档：`docs/dsh-0.1.2-rc1-adapt-plan.md`（上一轮适配，同体裁）
> 证据来源：`_tmp/host-0.1.5-rc.1/`（`dsh-develop host-fetch 0.1.5-rc.1` 解包，**不解包不装本机**）+ `dsh-develop typecheck-host 0.1.5-rc.1`

---

## 0. 摘要

| # | 适配点 | 严重度 | 结论 |
|---|--------|--------|------|
| A | **硬切 peer 范围** `^0.1.2-rc.1` → `^0.1.5-rc.1` | ⚠️ 声明面 | 用户裁决：**不做双基线**，只验新宿主（§3） |
| B | cordis / schemastery 版本 | 🔴 编译级 | `cordis`·`@deepseek-ai/cordis` `^4.0.0-rc.7` → **`^4.0.2`**；`schemastery` `^3.18.1` → **`^3.18.2`**（实测宿主依赖已升） |
| C1 | client 半 session 作用域 props `sessionId` | 🔴 编译级 | 声明源仍是 `@deepseek-ai/dsh-client-ui-session`（**非新包**），但 0.1.5-rc.1 起 `ui-conversation` **不再传递可达** → 3 文件红（§4.1） |
| C2 | client 半 `Context.sessions` | 🔴 编译级 | 同上：声明在 `@deepseek-ai/dsh-api-session-controller/client`，不再经 ui-conversation 传递 → 1 文件红（§4.1） |
| C3 | `conversation.draftImages()` 改名 | 🔴 **静默运行时** | → `resolveDraftAttachments()`（类型检查抓不到，靠人读源码发现）（§4.2） |
| C4 | `sessionPersistence.list()` 返回形状 | 🔴 **静默运行时** | `SessionHeader[]` → `SessionPersistenceSnapshot[]`（`cwd` 下移一层）（§4.2） |
| D | `host/contract.ts` 契约表 17 服务 + 10 事件 | ✅ 零改动 | 逐条核对全部存活；`satisfies readonly (keyof Events)[]` 编译期通过（§5） |
| E | tsconfig 路径处置 | ✅ 零改动（正式配置） | 正式 paths 继续指向本机安装 = **用户升级即自动切新宿主**；本轮验证走 `typecheck-host` 旁路（§2） |
| F | 任务 B：opencode zen 标识头 | ✅ **配置面可解** | `llm-pi-ai.providers.<route>.headers`；唯一保留名 `user-agent`（§7） |

**一句话**：真实突破点只有 **6 条**（4 条类型面 + 2 条静默运行时），全部集中在 **client 半与 CCC 自动发现路径**；node 半在新宿主下**零类型错误**（78 文件实测载入）。

---

## 1. 需求与范围

### 1.1 需求（用户 2026-09-10）

1. 让 dsp 在 DSH **0.1.5-rc.1** 上工作。
2. 裁决：**peer 改 `^0.1.5-rc.1`，硬切**——只验新宿主，不做 0.1.2-rc.1 双基线兼容。
3. 明确禁令：**不发布、不 deploy、不 restart-web、不本地安装**（用户回家后自行安装，届时做运行时验证）。

### 1.2 范围

**在范围内**
- `hooks/dsh-serenity-hooks/` 的宿主契约对账与代码改动（`src/`、`package.json`、`tsconfig*.json`、`README*.md`、`tests/`）
- `src/host/contract.ts` 的版本范围与 floor
- 适配轮验证工具（`scripts/dsh-develop.ts`，属内部运维脚本，在 `.gitignore` 内不进公开仓）

**不在范围内**
- 发布链（publish / push / deploy / restart-web）
- 本机 DSH 安装（用户自行执行）
- osp 侧（opencode 运行时）——归 S138
- specs 标准面（本次不涉协议变更）

### 1.3 验收标准

| # | 判据 | 本轮结果 |
|---|------|---------|
| V1 | `dsh-develop typecheck-host 0.1.5-rc.1` 两半全绿，且实测载入解包宿主文件数 > 0 | ✅ **node 78 文件 / client 103 文件**（paths 29+14 条全命中） |
| V2 | `dsh-develop test` 全绿 | ✅ **77 files / 1139 tests**（+6 新用例） |
| V3 | `dsh-develop typecheck`（本机 = 0.1.2-rc.1） | ✅ **意外通过**——类型面修复双向兼容（§4.1 末段）。**预测被实测推翻，已按实况修正**：硬切在类型面不产生代价，代价仅在 C3/C4 两条静默运行时契约 |
| V4 | 6 条突破逐条有对应改动 + 回归用例 | ✅ 见 §6 落地清单 |
| V5 | 未执行任何发布/部署/安装动作 | ✅ 全程只跑 host-fetch / typecheck-host / test（**未跑** publish · push · deploy · restart-web · `dsh plugin add`） |

---

## 2. 关键机制：tsconfig 路径处置（用户关注点）

### 2.1 现状与问题

两半 tsconfig 的 `paths` **硬编码指向本机 DSH 安装**：

- `tsconfig.json:18-48` → `../../../../../../.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/*`
- `client/tsconfig.json:20-31` → 同上，但 **`ui-slots` / `ui-primitives` 例外**，指向 `~/.dsh/source/current/packages/client/*/lib/types/index.d.ts`

用户要求"先不升级"→ 本机仍是 **0.1.2-rc.1** → 硬切后本地 typecheck 的**类型基线仍是旧宿主**，改完代码在本地会红。这是路径处置的核心矛盾。

### 2.2 三个候选方案

| 方案 | 做法 | 评价 |
|------|------|------|
| **P1 正式 paths 不动 + 旁路验证**（选中） | 正式 tsconfig 保持指向本机安装；新增 `dsh-develop typecheck-host <ver>` 生成**一次性派生 tsconfig**指向 `_tmp/host-<ver>/` 做对账 | 用户升级后正式 paths **自动**解析到新宿主，零维护；派生配置一次性、不进仓、不动本机 |
| P2 正式 paths 改指 `_tmp/host-0.1.5-rc.1` | 让本地立刻验新宿主 | ❌ `_tmp/` 是 gitignore 的临时物 → CI 与克隆即坏；且用户升级后又要改回 |
| P3 正式 paths 改指 vendored 宿主包（仓库内提交） | 类型基线自包含 | ❌ 仓库塞进 33 个宿主包（数百 MB），职责错位；宿主已由 peer 管理 |

**选 P1**。理由（R↓）：`paths` 的语义是"本机宿主在哪"，它本就该跟着本机安装走；"我想验某个未安装版本"是**开发期临时需求**，应由一次性旁路满足，而不是把临时需求固化进正式配置。

### 2.3 `typecheck-host` 实现要点（`scripts/dsh-develop.ts`）

```
dsh-develop typecheck-host <version>
  ① 前置：_tmp/host-<version>/ 必须存在（否则提示先跑 host-fetch）
  ② 派生：读基准 tsconfig（JSONC 解析，逐字继承编译选项）→ 仅覆写 paths
  ③ 路径改写：从基准值里取 `node_modules/` **之后**的段（包名 + 子路径）挂到 _tmp 宿主根
       ⚠️ 基准值有两个 node_modules（`…/dsh/node_modules/@deepseek-ai/dsh-tools`）→ 必须 lastIndexOf
  ④ 基线自证：改写过的 paths 逐条 existsSync；tsc --listFiles 统计命中解包宿主文件数，0 即 fail
  ⑤ 跑 tsc --noEmit（node 半 + client 半各一次）
```

**为什么要"基线自证"（④）**：`paths` 指向不存在的目录时 tsc **不报错**，而是静默回落到 `node_modules`（=旧宿主或未安装）。那样"新宿主下无类型错误"就是**假阳性**——本轮开发中真实踩到（首版用 `indexOf` 切错 `node_modules`，28 条 paths 全部指向不存在的目录，而 tsc 依然"绿"）。存在性检查 + `--listFiles` 命中数把假阳性变成可读事实。

### 2.4 `client/tsconfig.json` 的 `ui-slots`/`ui-primitives` 例外

现状指向 `~/.dsh/source/current/packages/client/*`（**本机 DSH 源码树**，非 npm 安装）。这是 S142 §7-8 记录的"client 依赖漂移"同源问题（两个 cordis 实例 → 声明合并失效）。

**本轮处置：不改**。理由：① 该例外与 0.1.5-rc.1 适配无因果关系（0.1.2 下同样存在）；② 改成 npm 安装路径属独立的依赖收敛工作（S142 §7-8 已立项），混进适配轮会扩大回归面；③ `typecheck-host` 的路径改写规则已能处理 `.dsh/source/current/packages/<group>/<name>` → `@deepseek-ai/dsh-<group>-<name>`，旁路验证不受该例外影响。

---

## 3. 声明面版本硬切（A + B）

### 3.1 三处必须一致（D3 纪律）

| 文件 | 现值 | 改为 |
|------|------|------|
| `hooks/package.json` `peerDependencies` | 15 项 `@deepseek-ai/dsh-*: ^0.1.2-rc.1` | `^0.1.5-rc.1` |
| 同上 | `cordis` `^4.0.0-rc.7` / `@deepseek-ai/cordis` `^4.0.0-rc.7` | `^4.0.2` |
| 同上 | `@deepseek-ai/schemastery` `^3.18.1` | `^3.18.2` |
| `hooks/dsh.plugin.json` `engines.dsh` | `>=0.1.2-rc.1` | `>=0.1.5-rc.1` |
| `src/host/contract.ts` `REQUIRED_HOST_RANGE` | `'^0.1.2-rc.1'` | `'^0.1.5-rc.1'` |

### 3.2 `checkHostVersion` 同步

`src/host/contract.ts:288-298` 的 floor 是**硬编码字面量** `'0.1.2-rc.1'`，与 `REQUIRED_HOST_RANGE` 分离——必须同改，否则出现"常量说 0.1.5、判定用 0.1.2"的双真相源。

`ceiling`（`'0.2.0'`）不变。

### 3.3 版本依据（实测，非推测）

| 包 | 0.1.2-rc.1 | 0.1.5-rc.1 | 来源 |
|----|-----------|-----------|------|
| `@deepseek-ai/cordis` | `^4.0.0-rc.7` | **`^4.0.2`** | `_tmp/host-0.1.5-rc.1/@deepseek-ai/dsh-tools/package.json:44` |
| `@deepseek-ai/schemastery` | `^3.18.1` | **`^3.18.2`** | 同上 `:57` |

> cordis 从 `4.0.0-rc.7` 到 `4.0.2` 是**正式版跃迁**（脱 rc）——这与本机 `pnpm-lock.yaml` 里已解析出 `@deepseek-ai/cordis@4.0.2` 一致（lock 由 peer 解析而来）。

### 3.4 文案面（不改会导致"文档说谎"）

- `hooks/package.json:4` description / `hooks/dsh.plugin.json:5` description 的"适配 DSH 0.1.2-rc.1"
- `hooks/README.md:6,35,363` / `README.en.md` 同款
- `src/host/contract.ts:48` 注释（"对照 …@ 0.1.2-rc.1 逐一核对"）
- `tests/host-contract.test.ts` 的版本字面量（多处）

**边界**：源码注释里大量"vX 适配 0.1.2-rc.1"是**历史记录**（R↓：记录当时踩的坑），**不改**——改了就是抹掉历史。

---

## 4. 代码改动（6 条）

### 4.1 类型面（4 条，client 半）

**根因（单一）**：dsp 此前**隐式依赖 ui-conversation 的类型传递可达性**，0.1.5-rc.1 断了这条链。

| 声明 | 声明源（0.1.2 与 0.1.5 相同） | 0.1.2-rc.1 可达路径 | 0.1.5-rc.1 可达路径 |
|------|------------------------------|--------------------|--------------------|
| `SessionStandardProps.sessionId`（slot props 的 session 标准套件） | `@deepseek-ai/dsh-client-ui-session` `lib/types/client/index.d.ts:41-56` | 经 `ui-conversation` 传递进入 dsp 的 client program | **仅当 program 直接/间接 import `ui-session` 时才进入** |
| `Context.sessions`（client 面 ISessions） | `@deepseek-ai/dsh-api-session-controller/client` `lib/types/client/index.d.ts:18-20` | 同上（ui-session import 了它） | 同上 |

**证据（R↓，避免把"新包"这种错判断写进方案）**：
- `ui-session` **不是 0.1.5-rc.1 的新包**——`AI_LAB/dsh-harness-public`（0.1.2-alpha.1）已有 `packages/client/ui-session/`，且被 20+ 个 client 包列为依赖。本机 0.1.2-rc.1 安装亦含 `@deepseek-ai/dsh-client-ui-session`（`sys ls` 实证）。
- 0.1.5-rc.1 的 `dsh-client-ui-conversation/lib/types/client/index.d.ts`（36 行全文读毕）**只有 `conversation` 与 `uiConversation` 两个 Context 合并，无任何 `SessionStandardProps` 合并**——传递链在此断掉。
- `dsh-client-ui-slots` 的 `SessionStandardProps` / `SessionMaybeStandardProps` / `GlobalStandardProps` 三个接口本体为**空**，注释明示"ui-session and domain UI adapters merge the concrete members"——即**声明权在 ui-session**。

**改法**

| 文件 | 改动 |
|------|------|
| `src/client/index.ts` | 新增 `import type {} from '@deepseek-ai/dsh-client-ui-session'`（与既有 `import type {} from '@deepseek-ai/dsh-client-ui-conversation'` 同款空导入，只为**显式化**声明可达性） |
| `tsconfig.json` | `paths` 新增 `@deepseek-ai/dsh-client-ui-session` |
| `client/tsconfig.json` | 新增 `@deepseek-ai/dsh-client-ui-session` + `@deepseek-ai/dsh-api-session-controller/client`（后者不映射则 `Context.sessions` 的合并进不了 program） |
| `src/client/FileFallbackDock.tsx:42` | **不改代码**（`props.sessionId` 在声明可见后即合法） |
| `src/client/ImageFallbackDock.tsx:60` | 同上 |
| `src/client/SafeModePanel.tsx:86` | 同上 |
| `src/client/image-fallback-api.ts:103` | **不改代码**（`ctx.sessions` 同上） |

**兼容性收益（实测，超出预期）**：修复**双向兼容**——`ui-session` 在 0.1.2 与 0.1.5-rc.1 两个安装里都存在，故 `dsh-develop typecheck`（本机 0.1.2-rc.1）与 `dsh-develop typecheck-host 0.1.5-rc.1` **同时通过**。这不是"硬切代价"，而是把隐式依赖改成显式依赖的净收益。

**为什么不改用运行时断言**（备选 B）：dsp 的 client 半已有 `import type {}` 惯例；用 `as unknown as {sessionId?: string}` 会把**真契约**换成**猜测**，下一次漂移继续静默。类型面能表达的就用类型表达。

**`dsh.client.inject` 是否要加 `@deepseek-ai/dsh-client-ui-session`？** 不加。宿主内注释明示 `dsh.client.inject edges are informational`（`dsh-client-ui-workspace/lib/client.js:2706`），且 dsp 运行时依赖的是 **cordis 服务名**（`slots`/`conversation`/`sessions`/`settingsScope`），不是包本身 → 类型 import 已足够。

**bundle 安全**：`import type {}` 在 transform 期擦除，不触 `client bundle purity` 插件（该插件只对**值 import** 抛错）→ `PLATFORM_MODULES` 无需改动。

### 4.2 静默运行时（2 条）

#### C3 `conversation.draftImages` → `resolveDraftAttachments`

- **位置**：`src/client/image-fallback-api.ts:90-94`（`getDraftFiles`）
- **0.1.2**：`IConversation.draftImages(ids): ComposerAttachment[] | undefined`
- **0.1.5-rc.1**：无 `draftImages`；等价能力 = `resolveDraftAttachments(ids): readonly ComposerAttachment[]`（`dsh-client-ui-conversation/lib/types/client/service.d.ts:143`），注释语义一致（"Resolve ordered input-state ids to runtime-owned draft attachments"）
- **为何类型检查抓不到**：调用点用结构化断言 `(ctx as {get?}).get('conversation') as { draftImages?: … }` → 类型自洽，只有运行时 `draftImages === undefined` → 静默 `return []`
- **后果**：图片粘贴落到 rail 后，模型不支持图片时的**自动落盘兜底**取不到 File → 兜底失效（用户面无报错，只是功能没了）
- **改法**：改断言形状 + 调用名；**保留"必须作为方法调用"的约束**（`this` 绑定，注释已警告）
  ```ts
  const conversation = (ctx as { get?: (name: string) => unknown }).get?.('conversation') as
    | { resolveDraftAttachments?: (ids: readonly unknown[]) => readonly { file: File }[] | undefined }
    | undefined
  if (conversation?.resolveDraftAttachments === undefined) return []
  return (conversation.resolveDraftAttachments(ids) ?? []).map((a) => a.file)
  ```
- **兼容性判断**：0.1.2 无 `resolveDraftAttachments` → 硬切后旧宿主下该兜底失效。这是硬切的可接受代价（用户裁决不做双基线）。

#### C4 `sessionPersistence.list()` 返回形状

- **位置**：`src/skiff-debug.ts:96-103`（`discoverCccs` 的通道 ②）
- **0.1.2**（`dsh-harness-public` `packages/session/session-persistence/src/index.ts:292`）：`list(signal?): Promise<SessionHeader[]>` → `h.cwd`
- **0.1.5-rc.1**：`list(options?): Promise<readonly SessionPersistenceSnapshot[]>`，`SessionPersistenceSnapshot = { header: SessionHeader; revision; eventCount?; sizeBytes? }` → **`h.header.cwd`**
- **为何类型检查抓不到**：形状由 dsp 自写的断言 `Promise<Array<{cwd?: string}>>` 决定，与宿主无关
- **后果**：`pushRoot(h?.cwd)` 恒收到 `undefined` → 通道 ② 静默失效 → Skiff 调试页 / autopilot 的 **CCC 自动发现**在"工作区注册表为空"时拿不到任何候选（该通道本就是为注册表拉空时的兜底而存在）
- **改法**：断言改 `Promise<Array<{ header?: { cwd?: string } }>>`，取值改 `h?.header?.cwd`
- **兼容性**：0.1.2 下 `h.header` 不存在 → 该兜底通道失效（同上，硬切代价）

### 4.3 明确不改的（避免过度适配）

| 宿主变更 | 判断 | 依据 |
|---------|------|------|
| ⑤ 面板 API `main` / `main.conversation` | **不改** | 是**新增**；dsp 用的 `conversation.session.header.actions`、`conversation.input.dock`、`ctx.get('conversation')` 全部存活（`contract/slots.d.ts:134,187`） |
| ⑥ persona 前缀/后缀 | **不改** | 指宿主 `dsh-persona` / `personaPrefix·personaSuffix`；dsp 的 `persona` 是 CCC 自有配置（同名不同物），且 section 名 `serenity-entry`/`serenity-skiff*` 与宿主 `deployment:persona-prefix·suffix` 无碰撞（碰撞会因重复注册抛错） |
| ⑧ 出站请求遵循代理 | **不改** | `HttpFetchProvider` 构造签名 `(limits, resolveAddresses?)` 与 `HttpFetchResolver` 契约**未变**（`dsh-web-fetch-http/lib/types/provider.d.ts:24,36`）→ dsp 的 fake-ip provider 接管（重写 resolver）仍成立。⚠️ 观察项：新宿主在**代理路由**下跳过地址校验（由代理解析源站），代理环境下 dsp 的 fake-ip 放行可能变成冗余 |
| ① Session 格式 V3 | **不改** | dsp 不读原始日志文件，只走 `snapshotEvents()` / 事件流 API |
| ② `agentLoop.create()` 变异步 / session 锁 | **不改** | dsp 不直接调 `agentLoop.create`（仅出现在 `inject` 列表与契约表）；`agents.create()` 返回 `Promise<AgentHandle>` 类型的既有用法已被 tsc 覆盖 |
| ③ 移除 `ctx.agent` | **不改** | dsp 用的是**事件 payload / `exec.agent`**（`ToolRunContext.agent?: Agent` 保留），非插件 `ctx.agent` |
| ④ Inbox 类型接口化 | **不改** | `Inbox.prepend(target,msg)` 保留；`hasPending`/`claim` 虽不再公开但 dsp 未用；`InboxTarget = 'next-turn' | 'next-step'` 未变 |
| ⑦ pi-ai 升 0.85.1 | **不改** | 与 §7 任务 B 一并处理（配置面，非代码） |

---

## 5. 契约表对账结果（`src/host/contract.ts`）

### 5.1 17 服务全部存活

逐一在 `_tmp/host-0.1.5-rc.1/` 找到 `Context` 声明与成员：

| 服务 | 0.1.5-rc.1 声明处 | 成员核对 |
|------|------------------|---------|
| `tools` | `dsh-tools/lib/types/index.d.ts:26` | `register:601` `guard:620` ✓ |
| `sessions` | `dsh-session/…:26` | `create:342` `get:419` `list:424` ✓ |
| `agents` | `dsh-agent/…:20` | `create:279` `get:341` ✓ |
| `webServer` | `dsh-host-webserver/…:17` | `register:90` `port:52` ✓ |
| `settings` | `dsh-settings/…:113` | `installSection:228` ✓ |
| `web` | `dsh-web/…:15` | `registerFetchProvider:69` ✓ |
| `systemPrompt` | `dsh-system-prompt/…:12` | （无成员）✓ |
| `sessionProjections` | `dsh-session-projection/…:25` | `snapshot:185`；`ProjectionSnapshot.values` 仍在 ✓ |
| `skills` | `dsh-skill/…:203` | （无成员）✓ |
| `shellEnv` | `dsh-shell-env/…:16` | （无成员）✓ |
| `agentLoop` | `dsh-agent-loop/…:28` | （无成员）✓ |
| `subagents` | `dsh-subagent/…:60` | `start:296`（签名 `(name, request)` 未变）✓ |
| `sessionTitle` | `dsh-session-title/…:33` | `rename:135` ✓ |
| `tokenMeter` | `dsh-token-meter/…:16` | `estimateMessage:57` ✓ |
| `workspaceRegistry` | `dsh-workspace/…:44` | `list:92` ✓ |
| `sessionPersistence` | `dsh-session-persistence/…:76` | `list:155`（**返回形状变了，见 §4.2 C4**）✓ |
| `connection` | `dsh-client-connection/…/rpc-host.d.ts:8` | `authenticatedUrl:33` `authorizeIndex:31` ✓ |

> `settings`/`workspaceRegistry`/`tokenMeter`/`sessionPersistence`/`connection` 不在 peerDeps（dsp 零宿主 import 策略下用结构化读取），本轮**补抓** `dsh-settings`/`dsh-workspace`/`dsh-token-meter`/`dsh-session-persistence`/`dsh-client-connection` 逐个核对——因为"不 import"意味着**编译期不保护**，只能人工对账。

### 5.2 10 个事件名全部存活

`HOST_EVENT_NAMES` 的 `satisfies readonly (keyof Events)[]` 在新宿主下**编译期通过** —— 这是 dsp 侧唯一自动化的契约断言（事件是字符串键，`ctx.on` 对未知名不报错，只能靠类型强制）。

`agent/status`·`agent/disposed`·`agent/inbox/inserted` 的 payload 形状（`{agent}` / `{agent,status}` / `{agent,message}`）逐一核对未变；`agent-idle.ts` 另订阅的 `session/disposed(session)` 未变。

### 5.3 补抓的包（证据完整性）

`host-fetch` 本轮新增 **`pkg@version` 逐包钉版本**（`cordis`/`schemastery` 不跟宿主版本号走），并按需补抓：`dsh-settings` / `dsh-workspace` / `dsh-token-meter` / `dsh-client-connection` / `dsh-session-persistence` / `dsh-client-ui-session` / `dsh-client-ui-layout` / `dsh-client-ui-workspace` / `dsh-client-store` / `dsh-api-session-controller` / `@earendil-works/pi-ai@0.85.1`。

---

## 6. 落地清单（实现顺序）

1. `.gitignore` 补 `_tmp/` 与 `tsconfig.host-*.local.json`（**前置**：`_tmp/` 此前未被忽略，`dsh-develop status` 显示 `?? _tmp/`）
2. 声明面：`peerDependencies` 17 项 + `dsh.plugin.json` engines + `contract.ts` `REQUIRED_HOST_RANGE` + `checkHostVersion` floor
3. 4.1 类型面：`src/client/index.ts` 空类型 import；两处 tsconfig `paths` 新增
4. 4.2 静默运行时：2 处断言形状与调用名
5. 测试：`tests/host-contract.test.ts` 版本字面量；新增/调整 2 条静默突破的回归用例
6. 文案：`package.json`/`dsh.plugin.json` description、`README.md`/`README.en.md`、`contract.ts:48` 注释
7. 验证：`typecheck-host 0.1.5-rc.1`（✅ 两半绿）→ `test`（✅ 77/1139）→ `typecheck`（✅ 本机 0.1.2-rc.1 亦绿，见 V3）
8. **不执行**：publish / push / deploy / restart-web / `dsh plugin add`

### 6.1 本轮实际落盘（全部完成）

| # | 改动 | 文件 |
|---|------|------|
| 1 | `.gitignore` 补 `_tmp/` + `tsconfig.host-*.local.json` | `.gitignore` |
| 2 | peer 17 项 → `^0.1.5-rc.1`；`cordis`·`@deepseek-ai/cordis` → `^4.0.2`；`schemastery` → `^3.18.2`；description 同步 | `hooks/package.json` |
| 3 | `engines.dsh` → `>=0.1.5-rc.1` + description 同步 | `hooks/dsh.plugin.json` |
| 4 | `REQUIRED_HOST_RANGE` → `^0.1.5-rc.1`；**floor 改为从常量派生**（消除双真相源）；ceiling 保留显式常量 + 注理由 | `src/host/contract.ts` |
| 5 | 新增 `import type {} from '@deepseek-ai/dsh-client-ui-session'`（一个空导入修好 4 条类型红） | `src/client/index.ts` |
| 6 | 两处 tsconfig `paths` 新增（node 1 条 / client 2 条） | `tsconfig.json` · `client/tsconfig.json` |
| 7 | C3：`draftImages` → `resolveDraftAttachments` | `src/client/image-fallback-api.ts` |
| 8 | C4：`h?.cwd` → `h?.header?.cwd` + 断言形状更新 | `src/skiff-debug.ts` |
| 9 | 测试同步 + 新增回归：compliance（+F6b cordis 双映射同版 / +F6c dsh-* 不得混版）、host-contract（版本字面量**改为从 `REQUIRED_HOST_RANGE` 派生** + 硬切判据 + floor 派生判据）、image-fallback（+旧名不采用反向用例）、skiff-debug（**原用例改新形状** + 0.1.2 旧形状不采用反向用例） | `tests/*.test.ts` |

---

## 7. 任务 B：opencode zen 标识头（独立结论）

### 7.1 结论

**配置面可解，不需要 ACC 代码改动。**

### 7.2 证据链

1. **注入点存在且是官方通道**：`dsh-llm-pi-ai/lib/index.js:1873`
   ```js
   snapshot.models.streamSimple(model, context, { …options, headers: requestHeaders(profile.headers) })
   ```
2. **`requestHeaders` 的合并语义**（同文件 `:1722-1730`）：`profile.headers` 去掉与 attribution **大小写不敏感**同名的键，再叠加 attribution。
3. **保留名只有一个**：`@deepseek-ai/dsh-llm` 的 `attributionHeaders()`（`lib/index.js:822-824`）当前只返回
   `{ 'user-agent': 'deepseek-harness/<ver> (+https://github.com/deepseek-ai/deepseek-harness)' }`。
   `APP_IDENTITY` 是模块常量、**无配置缝**（`attributionHeaders()` 在 pi-ai 适配器内以默认参数调用）。
   → **只有 `User-Agent` 不可覆盖**；`X-Title` / `HTTP-Referer` / `originator` 等**全部可注入**。
4. **配置路径**：`llm-pi-ai` 是插件注册的 settings 命名空间（`NS = "llm-pi-ai"`，`installSection` 于 `lib/index.js:2661`；条目地址 `settingsPath: ["providers", <route>]`）→ 用户在 `~/.dsh/settings.yaml` 写：
   ```yaml
   llm-pi-ai:
     providers:
       opencode-go:
         apiKeyEnv: OPENCODE_API_KEY
         headers:
           X-Title: opencode
           HTTP-Referer: https://opencode.ai/
   ```
5. **route 事实**：`opencode-go` 是 pi-ai **0.85.1 内置目录 provider**——`dist/providers/opencode-go.js`（id `opencode-go`，`envApiKeyAuth(["OPENCODE_API_KEY"])`，三种协议）＋ `dist/providers/data/opencode-go.json`（baseURL `https://opencode.ai/zen/go`，模型如 `minimax-m3` / `deepseek-v4-flash` / `deepseek-v4-pro`）。pi-ai **自身不发任何标识头**（全库 `grep X-Title|HTTP-Referer|originator` 零命中）。
6. **本机现状**：`dsh-develop dump-config pi-ai` → `llm-pi-ai` 已装载但 `config:` **为空**（未配置任何 provider route）。

### 7.3 ⚠️ 未决（阻塞项）

**zen 究竟要求哪一个头，源码层无法回答**（pi-ai 不设、opencode 归档只给出同类网关的多种形态）。需要：
- 用户提供实际报错原文（如 `401` 响应体），或
- 用户回家后做一次真实请求验证

**分支**：
- 若要求 `X-Title` / `HTTP-Referer` / `originator` 类 → **§7.2 配置即可收口**，dsp 零代码改动。
- 若要求 `User-Agent: opencode/<ver>` → **配置面不可解**（attribution 保留名 + `APP_IDENTITY` 无配置缝），需要另议（改宿主 / 上游 issue / 网关侧放行）。

---

## 8. 风险与回归面

| # | 风险 | 缓解 |
|---|------|------|
| R1 | 硬切后**0.1.2-rc.1 下**功能退化（C3/C4 两条兜底失效） | 用户裁决不做双基线；`contract.ts` 的 `checkHostVersion` 会在旧宿主上报 `versionOk:false`（`dashboard health` 可见）。**已实测确认代价边界**：类型面双向兼容（§4.1），只有 C3/C4 是单向 |
| R2 | ~~本机 `typecheck` 红被误读为"改坏了"~~ | **风险未发生**：`typecheck` 实测通过（V3）。原预测基于"ui-session 是新包"的错误判断，已修正 |
| R3 | `_tmp/host-*` 被误提交 | ✅ `.gitignore` 已补（落地清单 ①） |
| R4 | 静态断言（`hostService<…>`）继续掩盖下一次漂移 | 本轮 2 条静默突破即此类；已列回归用例（含**反向用例**：旧形状不得被采用）。**根治方向**（非本轮）：把高频结构化断言收敛为带版本断言的适配层 |
| R5 | client 半 `ui-slots`/`ui-primitives` 指向 `.dsh/source/current` 的漂移（S142 §7-8） | 本轮不碰，避免扩大回归面；`typecheck-host` 已验证不受影响 |

---

## 9. 附：本轮可复用资产

| 资产 | 位置 | 复用方式 |
|------|------|---------|
| `host-fetch <ver> [pkg[@ver]]` | `scripts/dsh-develop.ts` | 下一次宿主升级：一条命令把新宿主包解包进仓，供 read/grep/typecheck |
| `typecheck-host <ver>` | 同上 | 未安装新版时的类型对账；自带假阳性防护（存在性 + `--listFiles`） |
| `_tmp/host-0.1.5-rc.1/` | 仓库内（gitignore） | 33 个宿主包源码与 `.d.ts`，可直接 read/grep |
