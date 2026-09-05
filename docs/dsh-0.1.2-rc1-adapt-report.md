# DSH 0.1.2-rc.1 适配点核查报告（efd03598 subagent，只读审计）

- 日期: 2026-09-05（S142 适配轮）
- 核查对象: `AI_LAB/dsh-harness-public` @ dsh-v0.1.2-rc.1（a66e470204，250+ 包 version=0.1.2-rc.1）vs `AI_LAB/dsh-serenity-plugin/hooks/dsh-serenity-hooks/src`（dsp v1.28.0，peerDeps ^0.1.0-rc.5）
- 方法: 真实源码 read/grep 实证，未运行构建/测试（只读审计）
- 前置: `docs/dsh-0.1.2-alpha-impact-assessment.md`（alpha 评估，D13 等待策略）

## 结论摘要

| 适配点 | alpha 结论 | rc.1 实测 | 动作 |
|--------|-----------|-----------|------|
| A1 client import 面 | 破坏（dsh-client-runtime 包删） | **仍成立** + 补充 3 声明文件 | 改 4 src + 3 声明 |
| A2 workspace RPC | 改名 Typert workspace/* | **更重：list unary 整个移除 → follow 流** | 架构决策（HTTP 层无法按帧过滤 WS mux） |
| A3 session surfaceOp | dsp 已合规 | **合规确认（零改动）** | 无 |
| B4 dsh-settings | 未评估 | **漏判！installSettingsSection/settingsNamespace 消失 → installSection 方法** | settings-section.ts 编译级必改 + index inject 加 'settings' |
| B5 事件/服务名 | 兼容 | **全存续** | 无 |
| B6 peerDeps | ^0.1.0-rc.5 → 0.1.2-rc.1 系 | 全部 dsh-* 包 = 0.1.2-rc.1 | 版本范围 + cordis 改名 |

## A1 client import 面（编译级，改动面扩大）

- `packages/client/runtime/` 在 rc.1 已删除（client 目录仅 ui-*/store/hmr/connection/modules/locale/web）；`@deepseek-ai/dsh-client-runtime` 全仓零 package.json
- rc.1 官方 client 插件统一 `import type { Context as ClientContext } from '@deepseek-ai/cordis'`（139 处命中，无独立 ClientContext 类型）；`SettingsScope/SettingsScopeSpec/SettingsScopeSnapshot` 落 `@deepseek-ai/dsh-client-ui-settings/client`（settings-contract.ts:8/37/54；ui-settings client/index.ts:32 导出）
- **需改 src**：`src/client/index.ts:19-20` / `src/client/image-fallback-api.ts:10` / `src/client/SettingsSection.tsx:23`（file-fallback-api.ts 无 runtime import，仅类型检查）
- 兼容性实证：SettingsScope 服务名 settingsScope + bind/getSnapshot/subscribe/set/unset 签名与 dsp SettingsSection.tsx:158-178 用法完全一致
- **额外声明文件**：`package.json:49`（dsh.client.inject 含已删包）/ `tsdown.config.ts:24-25`（PLATFORM_MODULES 含已删包）/ `tsconfig.json:32-33` + `client/tsconfig.json:15-16`（paths 指已删包）全清

## A2 workspace RPC（⚠️ 比 alpha 更重：list unary 整个移除）

- rc.1 `packages/api/workspace-controller` Remote 方法仅 create/rename/delete/insertBefore/insertSessionBefore/archiveSession/**follow（stream）**——**无任何 list unary**；工作区列表改 **follow 流**（baseline + upsert/remove/order/archived 增量；client 端 ClientWorkspaceModel + createWorkspaceStateStream）
- **dsp 三处受影响**：
  1. `src/client/accounts-api.ts:169-191` `fetchWorkspaces()` 直调 `POST /api/workspace.list` —— rc.1 该 endpoint 不存在 → gateway 返回 `gateway/invocation-unavailable` RPC error → 返回空数组 → **AccountsEditor 白名单下拉恒空**
  2. `src/gateway.ts:203` `method==='workspace.list'` 过滤永不命中 → 白名单失效
  3. `src/gateway.ts:258` `/api/workspace.create` 校验——**create unary 仍存在**（@Remote('create')），拦截仍有效；unary RPC 信封保留（POST /api/<ns.method> + client-request）
- **替代数据源候选**：① gateway 自有 `/serenity/config` 扩展「已知工作区列表」端点（读 host 端 workspace registry/服务）② 降级手输路径
- **白名单过滤架构难点**：follow 是 WebSocket mux（/api/remote.mux upgrade）非 HTTP JSON 响应 → HTTP 反代层无法按帧改写 → 需在 gateway 代理层终结 WS 或接受「外部端口仅暴露白名单路径对应工作区内容，工作区导航本身不过滤」降级（**需用户拍板**）

## B4 dsh-settings API 消失（🔴 新发现，alpha 漏判——编译级）

- rc.1 `packages/settings/settings/src/index.ts` 全仓 grep `installSettingsSection`/`settingsNamespace` 零命中
- rc.1 替代：`ctx.settings.installSection(owner, ns, schema, entry, hooks)`（SettingsProvider 方法，index.ts:472-496）——owner Context 第一参数（consumer 插件 ctx），功能等同旧用法（base=entry + setSource/onChange hooks + fallback）
- **需改**：`src/settings-section.ts:20`（import 删）+ :131-135（改 `(ctx.settings as SettingsProvider).installSection(ctx, 'serenity-hooks', simpleSettingsSchema, entryDefaults(config), hooks)`——namespace 直接字符串）；**index.ts inject 数组（:54）不含 'settings' → 需加**（settings 服务由 provider 插件加载后才有）；降级守卫逻辑（:10-16）不变

## B5 事件名/服务名抽查（全兼容）

dsp 监听事件全存续：agent/session-start / agent/pre-step / agent/turn-stopping / agent/inbox/inserted / agent/status / tools/pre-execute / tools/post-execute / session/event / session/created / system-prompt/assemble。scoped dispatch 语义下 dsp 全局 ctx.on 仍收到（scope 过滤非隔离，与 0.1.1-rc.2 行为一致）。cordis 模块名：dsp 裸 `cordis` 与官方 `@deepseek-ai/cordis` 在 tsconfig 已映射同一物理路径 → 类型合并互通，不构成破坏。

抽查包导出存续（表）：dsh-tools（defineTool/guard/restrict/register/get）、dsh-agent（AgentRegistry.create/resume/get + AgentHandle/AgentFactory + agent/* 事件）、dsh-session（deriveEventMessage/foldSurface/SessionStore）、dsh-llm（createUserMessage/ContentBlock）、dsh-skill（registerProvider + SkillProvider + SkillCandidate）、dsh-system-prompt（section order -50 兼容）、dsh-host-webserver（register WebRoute）、dsh-shell-env（shellEnv + BashEnvContributor）、dsh-compaction（compaction/* 事件）、dsh-session-title（rename）、dsh-agent-presets（mount/composeFrom/composedPreset）、dsh-agent-loop（agentLoop + setFactory）、sessionProjections（contextPressure）

## B6 peerDependencies 版本范围

- rc.1 全部 @deepseek-ai/dsh-* 包 version = 0.1.2-rc.1 → peerDeps `^0.1.0-rc.5` → **`^0.1.2-rc.1`**（semver 含 0.1.2-rc.x 及后续 stable，<0.2.0），涉全部运行时 peer
- `cordis: ^4.0.0-rc.7` → 官方 rescope 名 `@deepseek-ai/cordis`（rc.1 全 workspace 用此名）；tsconfig 双映射保留兼容过渡
- client 类型依赖随 npm 安装的 dsh 传递提供，无需显式 peer

## 需改文件汇总（10 处）

1. `src/settings-section.ts`（:20 import + :131-135 调用）→ **编译级必改（B4 新发现）**
2. `src/client/index.ts`（:19-20 import）
3. `src/client/SettingsSection.tsx`（:23 import）
4. `src/client/image-fallback-api.ts`（:10 import）
5. `src/client/accounts-api.ts`（:169-191 fetchWorkspaces 数据源消失——换实现或弃下拉）
6. `src/client/AccountsEditor.tsx`（:58/287 依赖 fetchWorkspaces）
7. `src/gateway.ts`（:203 list 过滤失效 + :258 create 校验核对）
8. `src/gateway-proxy.ts`（filterWorkspaceList/workspaceDenyResponse 信封核对）
9. `package.json`（peerDeps 版本 + dsh.client.inject:49）+ `tsdown.config.ts`（:24-25 PLATFORM_MODULES）+ `tsconfig.json`（:32-33 paths）+ `client/tsconfig.json`（:15-16 paths）
10. `index.ts`（inject 数组 :54 加 'settings'）

## alpha vs rc 差异结论

- alpha A1（client import）/A3（surfaceOp）/run_code 结论全部仍成立；A1 破坏面补充 package.json/tsdown/tsconfig 三处声明文件
- alpha A2 低估：workspace 不是改名而是 list unary 删除 + follow 流化——gateway HTTP 层按响应过滤的架构不再成立（WS mux 帧无法在 HTTP 反代过滤），需架构决策
- alpha 完全漏判 B4：installSettingsSection/settingsNamespace 在 rc.1 消失（settings 便捷函数 → SettingsProvider.installSection 方法）——node half 唯一编译级破坏
- 无其他新破坏（B4/B5 全兼容面已核实）

## 待用户拍板决策点

1. **A2 workspace 白名单方案**：① gateway 自有端点列工作区（读 host 端 registry）② 降级「外部端口仅暴露白名单路径对应工作区内容，导航不过滤」③ 终结 WS 在 gateway 代理层（重）
2. **升级时机**：本地运行时 0.1.1-rc.2 → 0.1.2-rc.1（npm dist-tags latest），升级后 dsp 代码须同步适配才能 typecheck/deploy
3. **peerDeps 范围**：^0.1.0-rc.5 → ^0.1.2-rc.1 + cordis 改名（与升级联动）
