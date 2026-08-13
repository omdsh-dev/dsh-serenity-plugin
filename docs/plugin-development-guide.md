# DSH Plugin 开发规范（turtle-ui 范本 · 完整实操版）

> 本规范以官方完备范例 [turtle-ui](https://github.com/dsh-external/turtle-ui) 为范本，给出 DSH 插件的**完整开发流程**：从仓库骨架、插件入口、工具/hook 编写，到构建、测试、安装分发。
> 配套文档：`plugin-development-standard.md`（A–G 标准清单，本规范为实操细则）。
> 权威来源：DSH staging `docs/user/develop/*`、`docs/cookbook/*`、`docs/testing.md`、`apps/cli/src/plugin.ts`。

---

## 0. 总则：扩展缝哲学（零源码修改）

**DSH 插件开发的第一原则：任何扩展都是「缝上的插件」，不是「源码里的修改」。**

```
❌ 禁止：修改 DSH 安装/checkout 内的任何源码、配置、依赖
   （packages/*、apps/*、vendor/*、node_modules/* 等一律只读）
✅ 允许：独立仓库开发 → 构建成 bundle → 经配置层挂载 → 运行时在拦截缝上生效
```

**为什么杜绝 patch 源代码：**

| 理由 | 说明 |
|------|------|
| 升级免疫 | DSH 每次升级都会整体替换 staging checkout——patch 源码 = 升级即丢，且无法追溯 |
| 多实例一致 | 源码 patch 是环境私有状态，换机器/换 profile 即失效；bundle 是声明式、可复现的 |
| 官方路径 | `dsh plugin add` 只认 bundle；源码 patch 不被任何官方工具管理 |
| 可审计 | 插件功能 = 仓库代码 + 测试，可 review；patch 散落在宿主里不可审计 |
| 冲突 | 多个插件各自 patch 源码必然冲突；配置层按序覆盖有明确语义 |

**红线清单（违反即不合规）：**

| 禁止 | 正确做法 |
|------|---------|
| 改 `packages/*/src` | `ctx.tools.register` / `ctx.on('...')` 在拦截缝上实现 |
| 改 `apps/cli/src` | 通过 `dsh plugin add` 挂 bundle；CLI 行为经插件缝扩展 |
| 改 `vendor/cordis`、`vendor/schemastery` | 声明为 peerDependency，宿主提供 |
| 改 `$DSH_HOME/config.yaml` 手工 insert 源码路径 | profile 层 `cordis.patch.yml`（bundle patch） |
| 复制编译产物进宿主 node_modules | `dsh plugin add link:/path`（pnpm 管理，卸载干净） |
| 在 DSH checkout 里加测试/文档 | 测试随插件仓库；DSH 源码树保持 pristine |

---

## 1. 仓库骨架（turtle-ui 范本）

```
my-plugin/
├── src/                    # 插件源码（TS）
│   ├── index.ts            # 入口：name / inject / Config / apply
│   ├── invariant.ts        # 可选：包级不变量伴生
│   └── ...                 # 工具、hook、内部模块
├── tests/                  # 测试（vitest）
│   ├── *.spec.ts / *.test.ts
│   └── snapshots/*.expected.txt   # 快照测试（UI/渲染类）
├── package.json            # dsh.bundle.patch 声明 + peerDeps + prepare
├── cordis.patch.yml        # 配置层（bundle 的「脸」）
├── tsconfig.json           # 开发/CI 类型检查（可解析 sibling checkout）
├── tsconfig.prepare.json   # 消费端自包含编译配置（无 sibling 依赖）
├── tsdown.config.ts        # 开发/CI 构建（tsc + tsdown）
├── tsdown.prepare.config.ts# 消费端 prepare 构建（git 安装用）
├── README.md               # 开发/运行/检查说明
└── AGENTS.md               # 面向 agent 的开发约定（可选）
```

**关键文件职责：**

| 文件 | 职责 | 缺失后果 |
|------|------|---------|
| `cordis.patch.yml` | 声明插件如何进入运行组合（insert/override 行） | 插件装了也不激活 |
| `package.json dsh.bundle.patch` | 让 `dsh plugin` 识别本包为 bundle | 变成纯依赖，警告不激活 |
| `prepare` script | git 安装时消费端构建 lib/ | git 安装后无 lib/，加载失败 |
| `peerDependencies` | 声明宿主提供的 seam 包（cordis/@deepseek-ai/*） | 解析不到宿主单例 |

---

## 2. 插件入口（A：Cordis 插件形态）

```ts
import type { Context } from 'cordis'

export const name = 'my-plugin'               // 插件唯一名（patch 行 id 用它）
export const inject = ['tools']               // 依赖服务；就绪后才 apply
export const Config = z.object({ ... })       // Schemastery schema（默认值放这）
export function apply(ctx: Context, config: Config) {
  // 注册能力；全部 ctx 注册自动清理
}
```

**规则：**

| # | 规则 |
|---|------|
| A1 | 三形态：函数式（够用即用）/ 对象式 / 类式（仅对外提供 service 时） |
| A2 | `inject` 声明所需服务；框架等依赖就绪后 `apply`，依赖消失自动卸载重载 |
| A3 | 所有 `ctx` 注册自动清理；自定义资源用 `ctx.effect(() => cleanup)` |
| A4 | 配置导出 `Config` 接口 + **同名** Schemastery schema，非法配置 fail loud |
| A5 | 任何两部署可能不同的值必须是配置字段（测试：`cordis.yml` 能否不改代码改掉） |
| A6 | 不导出 default；导出 `name`/`inject`/`Config`/`apply`（native hook 约定） |

---

## 3. 工具定义（C：defineTool 契约）

```ts
export const inject = ['tools']
ctx.tools.register(defineTool({
  name: 'my_tool',
  description: '对模型可见的一句话',           // 描述即文档
  parameters: {                                // 模型侧 schema，自动校验
    arg: { type: 'string', required: true, description: '...' },
  },
  output: {
    schema: { type: 'json' },                  // 规范 JSON 值（唯一返回）
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  },
  async execute(args, exec) {
    // args 已按 schema 校验、冻结；exec.signal 是取消通道
    return result
  },
}))
```

**契约要点：**

| # | 规则 |
|---|------|
| C1 | `execute` 的 args 已类型化 + 校验（类型/必填/字面量/oneOf/嵌套），仍手检 DSL 不表达约束 |
| C2 | 注册借用 readonly 定义；热替换 = dispose 旧 effect 再注册 |
| C3 | args 只读；callId/name/arguments/agent/token/signal 执行期不可变 |
| C4 | 返回**一个规范 JSON 值**（`output.schema` 声明）；不返回 content block，不让调用方解析 prose |
| C5 | 抛错/非法返回值 = isError；基础设施失败 throw，业务非理想态放规范值 |
| C6 | 尊重 `exec.signal` 取消在途工作 |
| C7 | 可选 `output.presentationMeta(args, value)`：持久化 UI 卡片的可回放 JSON |
| C8 | 异步通知用 `exec.agent.inject({ content, source: { kind: 'plugin', plugin: '<name>' } })` |
| C9 | UI 卡片 = 纯展示投影（presentCall/presentResult 返回 card 意图）；必须纯函数（回放也跑） |
| C10 | UI 专属格式（console 块/diff/相对路径）不得进规范值或 Native 内容 |
| C11 | 长任务：`run_in_background` 门控 + `ctx.tasks.start({ kind, label, owner, run })` |

---

## 4. Hook / 拦截缝（D：扩展缝用法）

**native hook = 普通 Cordis 插件监听拦截缝**，无外部协议：

```ts
export const name = 'permission-gate'
export function apply(ctx: Context) {
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (!(await isAllowed(exec))) return { kind: 'deny', reason: 'Denied by policy.' }
    return next()
  })
}
```

**策略缝选择（按需要选一个，别全上）：**

| 缝 | 用途 | 特点 |
|----|------|------|
| `tools/pre-execute` | allow/deny/ask 可扩展策略 | 可排序、可被后续监听撤销 |
| `ctx.tools.guard()` | 单调最终拒绝 | 后加监听不可撤销 |
| `tools/execute` | 包裹调度生命周期（超时/重试/指标） | 可替换 exec.signal |
| `tools/post-execute` | 结果变换 / 附加模型上下文 | 保留 value 程序访问 |
| `tools/result` | 观察不可变最终结果 | 只读，审计/指标用 |
| `agent/session-start` / `agent/pre-step` | 会话/每步注入 | 身份播种、状态同步 |
| `agent/turn-stopping` | 回合收尾 | 可引导下一步 |

**feature → mechanism 映射（官方表节选）：**

| 产品特性 | 插件机制 |
|---------|---------|
| hook 系统（用户/项目级） | `agent/session-start` + `pre-step` + `request` + `tools/pre-execute` + `post-execute` + `turn-stopping` |
| 权限系统 | `tools/pre-execute` 返回 `ask` + `ctx.approval` 应答 |
| 上下文压缩 | `ctx.compact` seam + `dsh-compact-basic` |
| 工具过滤（ToolSearch） | `ctx.tools.restrict()`（presentation/lookup/execution 三处一致） |
| UI（GUI） | 监听 `session/event` → 输入经 `agent.followup()` |
| 子代理 | `ctx.subagents` provider 注册表 |
| MCP | 每服务器一个插件：发现工具 → `ctx.tools.register()` |
| 定时任务 | 插件注册模型可调度的 scheduling 工具；timer 触发 → `followup(..., {source: {kind:'cron'}})` |
| 模型适配器 | `LlmAdapter` 子类 + `registerAdapter` |

> 任何产品特性都有对应拦截缝——**不存在需要改源码才能实现的特性**。这是"杜绝 patch 源码"的机制保障。

---

## 5. bundle 打包（B：包声明）

```jsonc
{
  "name": "@scope/my-plugin",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./lib/index.js",
  "types": "./lib/index.d.ts",
  "exports": { ".": { "types": "./lib/index.d.ts", "import": "./lib/index.js" } },
  "files": ["lib/", "cordis.patch.yml"],
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "build": "tsc -p tsconfig.json && tsdown -c tsdown.config.ts",
    "prepare": "tsdown --config tsdown.prepare.config.ts"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "peerDependencies": {
    "cordis": "^4.0.0-rc.7",
    "@deepseek-ai/dsh-tools": "^0.0.1"
  }
}
```

**cordis.patch.yml（bundle 的配置层）：**

```yaml
# 覆盖 base 行：整块覆盖 config（不深合并），必须重述全部所需 key
- id: system-prompt
  config:
    persona: |
      You are a coding agent powered by the {{model}} model.
# 插入新插件行：name 用包名，Loader 从 profile node_modules 解析
- insert:
    - id: my-plugin
      name: '@scope/my-plugin'
      config:
        someOption: true
```

**层序（后层覆盖前层）：** ① profile bundles（按序）→ ② profile 自身 patch → ③ `$DSH_HOME/cordis.patch.yml` → ④ `--patch` argv → ⑤ launcher flags。

---

## 6. 构建（F：工程标准）

**开发/CI 构建（tsdown.config.ts）：** `tsc -b`（类型门禁）+ tsdown 双 bundle（Node half + client half）。

**消费端构建（tsdown.prepare.config.ts + tsconfig.prepare.json）：** git 安装时 pnpm 跑 `prepare`——**自包含从 src 转译**，不依赖 sibling checkout、不 typecheck（类型门禁属于 dev/CI）：

```ts
// tsdown.prepare.config.ts
export default {
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: true,
  tsconfig: 'tsconfig.prepare.json',   // 无 paths → staging 的自包含配置
}
```

```jsonc
// tsconfig.prepare.json — 无 sibling 依赖、noEmit、bundler resolution
{ "compilerOptions": { "target": "ES2024", "module": "ESNext", "moduleResolution": "bundler",
  "skipLibCheck": true, "noEmit": true }, "include": ["src"] }
```

**工程规则：**

| # | 规则 |
|---|------|
| F1 | `type: module`；`main`/`types`/`exports` 指 `lib/`；`files` 含 `lib/` + `cordis.patch.yml` |
| F2 | `peerDependencies` = cordis + @deepseek-ai/* 能力包；可选用 `peerDependenciesMeta.optional` |
| F3 | scripts：typecheck / test / build / prepare 四件套齐全 |
| F4 | tsdown：esm + node + es2024 + dts:false + clean（消费端）；dev 双 bundle 额外含 client |
| F5 | 零三方运行时依赖（peer 由宿主提供；实现依赖按需最小化） |

---

## 7. 测试（G：testing.md 五层）

| 层 | 命令/方式 | 要求 |
|----|----------|------|
| Unit | `pnpm test`（vitest） | 测试跟代码同目录；edge/error/concurrency/契约回归 |
| Coverage | `pnpm run test:coverage` | 包 src 逐文件 100%（必要非充分） |
| Real-API e2e | `test:e2e` | 带 key；无 key 自跳过（keyless CI 保持绿） |
| Snapshot | `test:snapshot` | 无 key 期望输出；`*.expected.txt` 比较外部行为 |
| Web browser | `test:web` | Chromium 回放对比（Linux PR 门禁） |

**强制规则：**

- 偏好真实实现而非 mock（只 mock LLM/网络/时钟等非确定边界）
- 验证世界而非自报：e2e 断言重跑命令/重读文件
- 测试真实入口路径：产品可见插件需要 Loader + cordis.yml 真实组合测试；包 bin 跑构建产物
- 非平凡模型/协议/人可见变更，同 PR 加/更新无 key snapshot 场景

---

## 8. 安装与分发（E）

| 场景 | 命令 | 说明 |
|------|------|------|
| 本地开发循环 | `dsh plugin --profile demo add link:~/git/my-plugin` | link: 免重装热更（turtle-ui 开发循环） |
| 从 git 安装 | `dsh plugin --profile demo add github:you/my-plugin` | fetch 源码 → 跑 prepare 构建 lib/ |
| npm 分发 | `dsh plugin --profile demo add @scope/my-plugin` | `pnpm publish` 时已带 lib/ |
| tarball | `dsh plugin --profile demo add ./my-plugin-0.1.0.tgz` | `pnpm pack` 产物 |

**git 安装陷阱（E4/E5）：**

- pnpm ≥10 默认**阻止 git 依赖的 prepare**（构建脚本），首次 add 失败并打印 allowBuilds key
- 用户把 key 加入 profile 的 `pnpm-workspace.yaml`：
  ```yaml
  allowBuilds:
    '@scope/my-plugin': true
  ```
- allowBuilds = **允许安装时执行包代码**（agent 沙箱之外）——只允许信任源码；**pin commit** `github:you/my-plugin#<sha>`，防后续 push 静默改变

---

## 9. 开发工作流（turtle-ui 循环）

```sh
# 1. 独立仓库（sibling 布局，类型解析用）
~/git/deepseek-harness     # 宿主 checkout（只读，仅类型引用）
~/git/my-plugin            # 插件仓库

# 2. 开发三件套（每次改动后）
pnpm run typecheck   # 类型门禁（可解析 sibling checkout）
pnpm test            # vitest 全量
pnpm run build       # 双 bundle 产物

# 3. 本地挂载验证
dsh plugin --profile demo add link:~/git/my-plugin
dsh --profile demo

# 4. 发布
git push && (npm publish | pnpm pack | 提供 github: 引用)
```

---

## 10. 合规自检清单（发布前逐项打勾）

- [ ] **零源码 patch**：未修改 DSH checkout 任何文件（`git -C <staging> status` 应干净）
- [ ] B1: `package.json` 声明 `dsh.bundle.patch`
- [ ] B2: 插件自带 `cordis.patch.yml`（insert 行 id/name/config 齐全）
- [ ] B3: patch 行 `name` 用包名（Loader 从 profile node_modules 解析）
- [ ] E4: `prepare` script + tsdown.prepare.config.ts + tsconfig.prepare.json 齐全
- [ ] F1: `files` 含 `lib/` + `cordis.patch.yml`
- [ ] F2: `peerDependencies` 含 cordis + 用到的 @deepseek-ai/*（不用 devDependencies 冒充）
- [ ] F3: typecheck/test/build/prepare 四 script 齐全
- [ ] A4: Config 用 Schemastery schema（非 plain object）
- [ ] A6: 不导出 default
- [ ] C4: 工具返回规范 JSON 值 + render 投影分离
- [ ] C9: UI 卡片投影是纯函数
- [ ] G: 测试分层（至少 Unit + 真实组合 preflight；UI 类加 snapshot）
- [ ] README 含开发/运行/检查三节

---

## 参考

| 资源 | 位置 |
|------|------|
| 标准清单（A–G） | `plugin-development-standard.md` |
| turtle-ui 官方范例 | `github.com/dsh-external/turtle-ui`（本机 `~/dsh-external/turtle-ui/`） |
| marisa 范例（含 CLI bin） | `~/dsh-external/marisa/` |
| 官方教程 | DSH staging `docs/user/develop/basic/`、`docs/cookbook/` |
| 官方测试策略 | DSH staging `docs/testing.md` |
| 插件 CLI 实现 | DSH staging `apps/cli/src/plugin.ts` |
