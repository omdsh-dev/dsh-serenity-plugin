# dsh-serenity-hooks 代码整体梳理（v1.22.7，S142 2026-08-27）

> 目的：把当前插件代码库的完整结构、模块职责、装配关系、数据流梳理成一份
> 可重建的权威地图（R↓）——供后续维护（本 SESSION 或未来 agent）快速定位、
> 判断改动落点、识别熵点。版本核对：v1.22.7（package.json + dsh.plugin.json + CHANGELOG 三处一致）。

## 1. 仓库形态

```
AI_LAB/dsh-serenity-plugin/            ← 独立 git 仓（GitHub tellmewhattodo/dsh-serenity-plugin）
├── hooks/dsh-serenity-hooks/          ← npm 包 @shgroup/dsh-serenity-hooks（唯一主产物）
│   ├── src/                           ← node half（host 插件逻辑）
│   ├── src/client/                    ← client half（浏览器 bundle：UI 面）
│   ├── tests/                         ← 40 files / 425 tests（vitest）
│   ├── lib/                           ← 构建产物（tsc + tsdown）
│   ├── dsh.plugin.json                ← 插件清单（版本/工具贡献）
│   ├── cordis.patch.yml               ← bundle 配置层（profile 挂载）
│   └── README.md                      ← npm 包 README（files 含）
├── scripts/dsh-develop.ts             ← 开发 MSM（safe-mode 白名单通道：typecheck/test/build/status/commit/push/version/bump/deploy/restart-web/publish/github-push）
├── scripts/dsh-crash-investigate.ts   ← 崩溃调查 MSM（只读）
├── CHANGELOG.md                       ← 132KB，v1.16 起全记录（每版 Scope/变更/测试）
├── docs/                              ← 设计文档（advanced-settings-design.md / codebase-overview-*）
└── mech-registry.json                 ← 注册表（dsh-develop / dsh-crash-investigate）
```

构建：`tsc --noEmit`（typecheck 双面 node+client）→ `vitest run`（tests）→
`tsc -p tsconfig.json && tsdown -c tsdown.config.ts`（lib bundle）。
发布：bump 三处 → commit → publish（npm，显式 registry）→ github-push → deploy → restart-web。

## 2. 分层架构

```
┌─ 装配层  src/index.ts ──────────────────────────────────────────────┐
│  name/inject/Config/apply（Cordis 函数插件契约，无 default export）  │
├─ 工具层  src/tools/*            src/cc-*.ts 业务实现（* -ops.ts）   │
│  11 工具：cc_fs/session/acc_kit/cc_git/acc_msm/eap/neat/cce/loop/   │
│           session_rebuild/localstore                                │
├─ 拦截缝  src/seams/*（机械约束，事件钩子）                          │
│  guards（安全模式/黑名单/路径守卫）/ bootstrap（Anchored 两阶段）/   │
│  keeper（DCP 提醒 + 轨迹跟踪器）/ context（ACC 注入）/ compact（压缩重注入）/ │
│  system-prompt（入口 skill section）/ env / opencode-skills          │
├─ 服务层  src/ccc.ts session-ops.ts config-ops.ts gateway.ts api.ts  │
│  settings-section.ts status.ts totp.ts constants.ts json.ts         │
├─ client  src/client/*（WebUI 面：SafeModePanel/SettingsSection/     │
│  AccountsEditor/ImageFallbackDock + api 助手）                       │
└──────────────────────────────────────────────────────────────────────┘
```

### 装配（apply 顺序，index.ts）

| 顺序 | 注册 | 作用 |
|------|------|------|
| 1 | tools.register ×11 | 真实 DSH 工具 |
| 2 | registerGuards | 安全模式/黑名单/路径守卫（pre-execute + guard） |
| 3 | registerKeeper | SESSION-KEEPER 计分提醒 + 轨迹跟踪器（tools/post-execute） |
| 4 | registerContext | ACC 身份注入（agent/session-start + agent/pre-step） |
| 5 | registerEntrySkillSectionGlobal | 全局入口 skill 系统提示词 section |
| 6 | registerCompactRetention | compaction/end 后 ACC 身份重注入 |
| 7 | registerStatusApi | /serenity/status|loops|image-upload|config |
| 8 | registerSettingsSection | DSH 原生设置面板简单配置（开关/阈值） |
| 9 | registerGateway | F1 双端口网关（第二监听器 + 登录 + 反代） |
| 10 | registerRebuildTurnHook | F2 session_rebuild turn-stopping 执行 |
| 11 | registerEnv / registerOpencodeSkills | 环境事实 / skill 扫描 |
| 12 | registerBootstrap | Anchored Standard 两阶段工具目录 |

## 3. 模块职责地图（node half）

### 3.1 核心服务
| 文件 | 职责 | 关键导出 |
|------|------|---------|
| `ccc.ts` | CCC 根发现（.serenity 向上查找）+ 配置加载（serenity.json/.dsh 回退） | `findSerenityRoot`/`loadSerenityConfig`/`DEFAULT_SERENITY_CONFIG_PATHS` |
| `constants.ts` | ACC_VERSION 常量 | `ACC_VERSION` |
| `json.ts` | JsonValue 类型 | — |
| `invariant.ts` | 运行时不变式断言 | — |

### 3.2 工具实现（tools/* 薄壳 + *-ops.ts 逻辑）
| 工具 | 薄壳 | 逻辑实现 | 说明 |
|------|------|---------|------|
| `cc_fs` | tools/cc-fs.ts | `fs-ops.ts`（17KB） | 15 子命令，路径守卫 |
| `session` | tools/session.ts | `session-ops.ts`（30KB） | 全周期 + F3 命名 rename |
| `acc_kit` | tools/kit.ts | `kit-ops.ts` | health/time/wait |
| `cc_git` | tools/git.ts | `git-ops.ts` | status/commit/push/log/pull/diff |
| `acc_msm` | tools/msm.ts | `msm-ops.ts`（24KB） | list/exec/register/deregister/check/guide/ccc-config |
| `eap/neat/cce` | tools/{eap,neat,cce}.ts | 内联 | 渐进式披露框架文本 |
| `loop` | tools/loop.ts | `loop-ops.ts` + `loop-preset-inherit.ts` | 牛马循环 |
| `session_rebuild` | tools/rebuild.ts | `rebuild.ts`（10KB） | 排队 + turn-stopping 清空 + 自动继续 |
| `localstore` | tools/localstore.ts | `localstore-ops.ts`（13KB） | 凭据/配置存储 |

### 3.3 拦截缝（seams/*）
| 文件 | 事件钩子 | 职责 |
|------|---------|------|
| `guards.ts` | tools/pre-execute + ctx.tools.guard | safe-mode 工具隐藏/黑名单/路径逃逸阻断 |
| `bootstrap.ts` | session/event + agent/inbox/inserted + system-prompt/assemble + agent/pre-step | Anchored 两阶段工具目录（零配置，first-anchor 协议固化） |
| `keeper.ts` | tools/post-execute | SESSION-KEEPER 计分 + 轨迹跟踪器 contextPressure 检测 |
| `context.ts` | agent/session-start + agent/pre-step | ACC 身份注入 + 激活会话恢复 |
| `compact.ts` | compaction/end | 压缩后身份重注入 |
| `system-prompt.ts` | system-prompt/section | 入口 skill 全文 section（26KB 最大模块） |
| `env.ts` | — | DSH_SERENITY_* 环境事实 |
| `opencode-skills.ts` | — | .opencode/skills 扫描注册 |

### 3.4 服务层
| 文件 | 职责 |
|------|------|
| `gateway.ts`（41KB 最大） | F1 双端口：第二监听器 + 登录页 + scrypt/TOTP 认证 + HttpOnly cookie + 反代（Host/Origin 改写）+ WS pipe + 白名单过滤 + 错误防崩溃 |
| `config-ops.ts`（16KB） | plugin 全局配置（~/.dsh/serenity-hooks.json，0600）+ 账号 CRUD + scrypt + migrateLegacyLocalstore |
| `settings-section.ts` | DSH settings 面板注册 + 运行时降级守卫 |
| `api.ts`（11.5KB） | /serenity/status|loops|image-upload|config |
| `status.ts` | 状态聚合 + safe-mode 切换 |
| `totp.ts` | RFC 6238 零依赖 TOTP（base32/验证/otpauth URI） |

### 3.5 client half（src/client/*）
| 文件 | 职责 |
|------|------|
| `index.ts` | 槽注册（header.actions 徽章 / input.dock 图片兜底 / settings.section） |
| `SafeModePanel.tsx/.css` | 会话头部状态徽章 + CCC 状态卡 |
| `SettingsSection.tsx/.css` | DSH 设置面板简单配置页 |
| `AccountsEditor.tsx/.css` | 「外部访问」区块（监听/账号 CRUD/TOTP/工作区白名单） |
| `accounts-api.ts` | 配置 wire 转换 + fetch（/serenity/config + workspace.list RPC） |
| `ImageFallbackDock.tsx` | 图片自动落盘兜底（MODEL_DOES_NOT_SUPPORT_IMAGES 补救） |
| `image-fallback-api.ts` | 图片上传/草稿/重发 API |

## 4. 数据流（关键路径）

### 4.1 first-anchor（bootstrap 锚定）
```
新会话第一条真实 user/message → agent/inbox/inserted
  → 根会话且无历史 user/message → 逆序 prepend 2 条锚定消息到 next-turn
  → 模型 0 工具逐条回 "acknowledge"（requiredSignals=2）
  → 晋升：完整工具目录开放
```
**rebuild 后不重锚**：surface replace 不改 events → 仍有历史 user/message → 判定"已有历史"跳过。

### 4.2 session_rebuild（F2 轨迹跟踪器）
```
keeper post-execute：contextPressure 投影 ≥ rebuildThreshold → 追加 [TRAJECTORY] 提示
  → LLM 主动调用 session_rebuild（不自动执行，防误清空）
  → queueRebuild：门控 + 构建锚点（first-anchor 正文去 ack + 继续指令）→ pending map
  → agent/turn-stopping：performRebuild（surface replace 全部节点 → 锚点 user/message）
  → agent.steer([TRAJECTORY-REBUILD] 自动继续) → next-step 非空 → turn 不 break
  → 模型同轮自动读 SESSION.md 继续
```

### 4.3 外部访问（F1 gateway）
```
3081 第二监听器 ← 外部浏览器
  → GET / → 登录页（用户名+密码+[TOTP]）
  → POST /serenity/login：scrypt 验证 + TOTP 验证 + CSRF → HttpOnly cookie（TTL 24h 滑动）
  → 反代 127.0.0.1:主端口：Host/Origin 改写成 loopback（过 isTrustedApiRequest 栅栏）
  → workspace.list 响应白名单过滤 / workspace.create 校验
  → WS upgrade 转发（101 回写 + error 监听防崩溃）
```

### 4.4 图片自动落盘（S142）
```
client 粘贴图片 → 发送 → host 判定模型不支持图片（MODEL_DOES_NOT_SUPPORT_IMAGES）
  → ImageFallbackDock 静默补救：POST /serenity/image-upload → _tmp/images_from_user/
  → 移除 rail → 注入「用户提供了一张图片（路径：…）」纯文本重发
  → agent 经 CCC vlm MSM（如 vlm-describe）自主识别
```

## 5. 配置分层（归属原则：plugin 全局 vs CCC 具体）

| 配置 | 位置 | 内容 |
|------|------|------|
| DSH settings 面板（settings.section） | settings.yaml（DSH 原生） | gatewayEnabled / rebuildEnabled / rebuildThreshold / namingEnabled（简单开关+阈值） |
| plugin 全局文件 | `~/.dsh/serenity-hooks.json`（0600，env SERENITY_HOOKS_CONFIG 覆盖） | gateway 账号（scrypt hash + TOTP secret）/ host / port / workspaces 白名单 / cookieSecure / allowWorkspaceCreate / totpEnabled |
| CCC 配置 | CCC `.opencode/serenity.json` | loop.defaultModel / sessionKeeper.threshold / safeMode.blacklist / hooks.autoRestoreSession |
| CCC 凭据 | CCC `localstore.json` | 凭据/配置命名空间（gitTrack 策略） |

## 6. 版本演进主线（v1.19 → v1.22.7）

| 版本 | 主题 |
|------|------|
| v1.19.0-4 | bootstrap 晋升机制演进（responses API 兜底 step/start） |
| v1.19.5 | first-anchor 零配置化（协议固化代码） |
| v1.19.6-9 | 系统提示词结构演进（Metaphor 10 条/Principles 合并/本体论/MSM 约束） |
| v1.20.x | 图片自动落盘兜底（/serenity/image-upload + ImageFallbackDock） |
| v1.21.0 | F1 双端口网关 + F2 session_rebuild + F3 会话命名 + 双层配置面板 |
| v1.22.0 | 归属重构（plugin 全局化）+ gateway 稳定性（信任栅栏/WS/防崩溃）+ 面板重构 |
| v1.22.1 | 移动端登录页 + 轨迹跟踪器命名 + 上下文回收修复 |
| v1.22.2 | rebuild 语义修正（原地重建） |
| v1.22.3 | gateway error 监听防崩溃（dsh-crash-investigate MSM） |
| v1.22.4 | 登录安全审计加固（TOTP/CSRF/锁定/登出）+ rebuild 语义根治（完全丢弃+新建→复用旧会话） |
| v1.22.5 | rebuild 自动继续（steer）+ 保留 first-anchor 协议正文 |
| v1.22.6 | 修复工作区白名单列表加载（RPC 信封 type/method） |
| v1.22.7 | 移除工作区手输兜底 |

## 7. 已知熵点 / 观察（维护提示）

1. **gateway.ts 41KB 过大**——单文件承载登录/反代/WS/白名单/配置签名，后续可考虑按职责拆（auth/ proxy/ ws/ policy）——但拆分需谨慎：当前测试 425 全绿且行为稳定，无拆分压力时不主动动。
2. **system-prompt.ts 26KB**——入口 skill 全文注入逻辑 + 8 块 spec，与 osp-alignment.test.ts 契约绑定，改动需双面同步。
3. **session-ops.ts 30KB**——session 工具 + 激活信息 + F3 命名混合，可考虑拆分激活跟踪与工具薄壳。
4. **msm-ops.ts 24KB**——MSM 注册/执行/检查三职责合一，可拆 exec/registry/check。
5. **测试覆盖**：40 files / 425 tests，纯函数优先（*-ops 可测设计）；gateway/rebuild/config-ops 测试最厚（安全/生命周期关键路径）。
6. **client 依赖漂移**：DSH rc 升级需复查 client typecheck（未解决问题 #3）。
7. **root 仓脏文件**：`.restrict-diag.json` 被跟踪（未解决问题 #4，等 bash 可用时 `git rm --cached`）。

## 8. 维护操作速查

| 操作 | 命令（acc_msm exec dsh-develop） |
|------|--------------------------------|
| 全流程检查 | `typecheck` → `test` → `build` |
| 发布 | `bump <x.y.z>` → 补 CHANGELOG → `commit` → `github-push` → `deploy` → `restart-web` |
| 版本核对 | `version` |
| 崩溃调查 | `dsh-crash-investigate status/logs/crash/collect` |
| 参考源码 | `AI_LAB/dsh-harness-public/`（deepseek-ai/deepseek-harness mirror，b150a551） |
