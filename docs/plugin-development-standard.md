# DSH Plugin 开发标准（v1.0）

> 权威来源：DSH staging checkout `docs/user/develop/basic/*`、`docs/user/develop/framework/*`、`docs/cookbook/*`、`docs/testing.md`、`apps/cli/src/plugin.ts`，以及官方范例 [turtle-ui](https://github.com/deepseek-harness/turtle-ui)（`dsh plugin` git 安装被官方 publish.md 点名引用）与组织内 marisa。
> 本文档是 dsh-serenity-plugin 的合规基线：实现必须逐项对齐 A–G 各节；核对清单见文末。

---

## A. 插件本体（Cordis 插件形态）

```ts
import type { Context } from 'cordis'
export const name = 'my-plugin'
export function apply(ctx: Context) { /* 注册能力 */ }
```

| # | 标准 | 出处 |
|---|------|------|
| A1 | 三种形态：函数式（`name` + `apply`）/ 对象式（`{name, inject, apply}`）/ 类式（`Service` 子类） | basic/index.md |
| A2 | 函数式够用；**类式仅当对外提供 service** | basic/index.md |
| A3 | 依赖声明 `inject: ['tools', ...]` — Cordis 等依赖就绪后 `apply`；依赖消失自动卸载重载 | framework/index.md |
| A4 | `ctx` 注册自动清理（事件/工具/定时器）；自定义资源用 `ctx.effect(() => cleanup)` | framework/index.md |
| A5 | 配置 = 导出 `Config` 接口 + **同名 Schemastery schema**（默认值放 schema），加载时校验，非法 fail loud | basic/config.md |
| A6 | 两部署可能要不同的值必须是配置字段，禁止硬编码（测试：`cordis.yml` 能否不改代码改掉） | basic/config.md |
| A7 | Fiber 状态机：`PENDING → LOADING → ACTIVE / FAILED`，`ACTIVE → UNLOADING → DISPOSED` | framework/index.md |

## B. 包声明（bundle 清单）

| # | 标准 | 出处 |
|---|------|------|
| B1 | 插件即 bundle：`package.json` 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` | publish.md / turtle-ui / marisa |
| B2 | `cordis.patch.yml` 是配置层：`- id: xxx` 覆盖 base 行（整块覆盖 config，不深合并）+ `- insert:` 插入新行 | publish.md / turtle-ui |
| B3 | patch 行 `name` 用**包名**，Loader 从 profile node_modules 解析 | publish.md |
| B4 | 无 `dsh.bundle` 声明的包 = 纯依赖，`dsh plugin` 警告且不激活层 | plugin.ts / publish.md |
| B5 | profile（`$DSH_HOME/profiles/<name>`）= 运行组合物：`dsh.profile.bundles` 有序列表 + 用户 patch；`dsh plugin` 自动维护 | publish.md |
| B6 | 层序：① profile bundles（按序）→ ② profile 自身 patch → ③ 家级 `$DSH_HOME/cordis.patch.yml` → ④ `--patch` argv → ⑤ launcher flags；后层覆盖前层 | publish.md |

## C. 工具定义标准（defineTool）

```ts
export const inject = ['tools']
ctx.tools.register(defineTool({
  name: 'greet',
  description: '...',   // 模型看到的
  parameters: { name: { type: 'string', required: true } },
  output: {
    schema: { type: 'string' },                      // 规范 JSON 值
    render: (_args, value) => [{ type: 'text', text: value }],  // 模型可见内容
  },
  async execute(args) { return ... },                // args 已类型化+已校验
}))
```

| # | 标准 | 出处 |
|---|------|------|
| C1 | `defineTool` 自动校验参数（类型/必填/字面量/oneOf/嵌套），`execute` 里 args 已可信 | adding-a-tool.md |
| C2 | 注册借用 readonly 定义：注册后不可改 schema/callback；热替换 = dispose 旧 effect 再注册 | adding-a-tool.md |
| C3 | 执行身份保护：args 冻结、opaque `exec.token`、callId/name/arguments/agent/token/signal 不可变 | adding-a-tool.md |
| C4 | 返回一个规范 JSON 值（`output.schema` 声明）；不返回 content block、不让调用方解析 prose | adding-a-tool.md |
| C5 | 抛错或非法返回值 = `isError`；基础设施失败 throw，业务非理想态放规范值 | adding-a-tool.md |
| C6 | 尊重 `exec.signal` 取消在途工作 | adding-a-tool.md |
| C7 | 可选 `output.presentationMeta(args, value)` — 持久化 UI 卡片的可回放 JSON | adding-a-tool.md |
| C8 | 异步通知用 `exec.agent.inject({content, source:{kind:'plugin', plugin:'<name>'}})` — 追加到下一个模型请求 | adding-a-tool.md |
| C9 | UI 卡片 = 纯展示投影：`presentCall`/`presentResult` 返回 `card` 意图（generic/terminal/diff/search/web）；**必须纯函数**（无 I/O/时钟/随机），回放上也运行 | adding-a-tool.md |
| C10 | UI 专属格式（console 块/diff/相对路径）不得进规范值或 Native 内容 | adding-a-tool.md |
| C11 | 长任务：`run_in_background` 门控 + `ctx.tasks.start({kind, label, owner: exec.agent, run})` | adding-a-tool.md |

## D. Hook 插件（拦截缝）

| # | 标准 | 出处 |
|---|------|------|
| D1 | native hook = 普通 Cordis 插件监听拦截缝，无外部协议：`ctx.on('tools/pre-execute', async (exec, next) => PreToolDecision)` | extension-cookbook.md |
| D2 | 策略缝选择：`tools/pre-execute`（allow/deny/ask）→ `ctx.tools.guard()`（单调最终拒绝）→ `tools/execute`（调度生命周期）→ `tools/post-execute`（结果变换）→ `tools/result`（观察） | adding-a-tool.md |
| D3 | feature→mechanism 映射表：hook 系统 / goal / compaction / 权限 / MCP / UI / subagent 等各有明确缝 | extension-cookbook.md |

## E. 安装 / 分发标准

| # | 标准 | 出处 |
|---|------|------|
| E1 | `dsh plugin --profile <name> add <spec>` = 初始化 profile → pnpm 转发 → bundles 对账 | plugin.ts / publish.md |
| E2 | 本地开发循环：`dsh plugin --profile demo add link:~/git/turtle-ui`（link: 免重装热更） | turtle-ui README |
| E3 | 从 git 安装：`dsh plugin --profile demo add github:you/hello-plugin`（fetch 源码非构建产物） | publish.md |
| E4 | **git 安装必须配 `prepare` script** — 自包含从 src 转译（tsdown 专用配置，无 project references、不 typecheck）；turtle-ui 是官方点名范例 | publish.md / turtle-ui |
| E5 | pnpm ≥10 默认阻止 git 依赖 prepare → 首次 add 失败，用户需把 key 加入 profile `pnpm-workspace.yaml` `allowBuilds:`；dsh 会提示 | publish.md |
| E6 | allowBuilds = 允许安装时执行包代码（agent 沙箱之外）— 只允许信任源码，pin commit `#<sha>` | publish.md |
| E7 | 不想要构建许可：npm publish 带 `lib/` 或 `pnpm pack` tarball | publish.md |

## F. 构建 / 工程标准

| # | 标准 | 出处 |
|---|------|------|
| F1 | `type: module`，`main`/`types`/`exports` 指 `lib/`；`files` 含 `lib/` + `cordis.patch.yml` | turtle-ui / publish.md |
| F2 | `peerDependencies` = `cordis` + `@deepseek-ai/dsh-*` 能力包；可选用 `peerDependenciesMeta.optional` | turtle-ui / marisa |
| F3 | scripts：`build`（tsc -b && tsdown）、`test`（vitest）、`typecheck`（tsc -b）、`prepare`（消费端构建专用 tsdown 配置） | turtle-ui |
| F4 | tsdown：`format:['esm']`, `platform:'node'`, `target:'es2024'`, `dts:false`, `clean:false` | turtle-ui |
| F5 | 测试：vitest + snapshot 测试（`*.expected.txt` 快照） | turtle-ui tests/ |
| F6 | 零三方运行时依赖（marisa 明确零依赖；turtle-ui 仅 diff/saxes/schemastery/marked 等必需） | marisa / turtle-ui |

## G. 测试策略（官方 testing.md）

| # | 标准 |
|---|------|
| G1 | 分层：Unit → Coverage gate（src 逐文件 100%）→ Real-API e2e（带 key，无 key 自跳过）→ Snapshot → Web browser snapshot |
| G2 | 偏好真实实现而非 mock：只 mock 昂贵/非确定边界（LLM 适配器/网络/时钟） |
| G3 | 验证世界而非自报：e2e 断言重跑命令/重读文件；e2e 自管资源（afterEach dispose） |
| G4 | 测试真实入口路径：产品可见插件需要非单元真实组合测试（Loader + cordis.yml 启动）；包 bin 跑构建产物 |
| G5 | 每个非平凡模型/协议/人可见变更同 PR 加/更新无 key snapshot 场景 |

---

## 合规核对清单（dsh-serenity-plugin 使用）

| 项 | 标准 | 本仓实现 | 状态 |
|----|------|---------|------|
| A1–A7 | 插件形态/依赖/清理/配置 | `name`/`inject`/`Config`/`apply` + Schemastery Config + 全 effect 清理 | ✅ |
| B1 | `dsh.bundle.patch` 声明 | `hooks/dsh-serenity-hooks/package.json` | ✅ v1.15+ |
| B2/B3 | 插件自带 cordis.patch.yml，行 name 用包名 | `hooks/dsh-serenity-hooks/cordis.patch.yml` | ✅ v1.15+ |
| C1–C10 | defineTool 全契约 | 9 工具全部 `defineTool`（canonical value + render + signal） | ✅ |
| D1–D3 | 拦截缝 | `tools/pre-execute` + `ctx.tools.guard()` + `tools/restrict` + `agent/session-start` + `pre-step` + `turn-stopping` + `post-execute` | ✅ |
| E1–E4 | 官方安装 + prepare | `dsh plugin add` 路径 + `prepare` script | ✅ v1.15+ |
| F1–F4 | 包/构建标准 | type:module + exports + tsdown 双 bundle + prepare 配置 | ✅ v1.15+ |
| F6 | 零运行时依赖 | 无 dependencies（peer 由宿主提供） | ✅ |
| G1–G5 | 测试策略 | vitest 全绿 + 真实组合 preflight | 🟡 分层逐步加 |

> 版本注释：v1.15.0 完成 B/E/F 合规化（dsh.bundle + 自带 patch + prepare + peerDependencies）。
