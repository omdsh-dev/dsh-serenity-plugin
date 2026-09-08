# dsp 实现 Review — 架构缺失与 DSH 升级契约漂移

> 会话：S142（dsp 长期维护）｜日期：2026-09-08｜范围拍板：用户"针对整个 dsp 的实现进行 review，关注架构缺失和 dsh 版本升级带来的这类问题"（全量四维 + 子代理并行 + 落盘报告）
> 版本基线：dsp `@shgroup/dsh-serenity-hooks` **v1.30.5**｜宿主权威源码 `AI_LAB/dsh-harness-public` @ **0.1.2-rc.1**（= 生产运行版本）｜标准 `AI_LAB/serenity-acc-specs` v1.5.0
> 本报告只做诊断，**未改任何源码/测试**。修复待用户拍板（见 §6）。

---

## 1. 结论摘要

**dsp 今天能正常工作，但与宿主的契约是"约定"而非"保证"。** 六个分片独立核对 rc.1 源码后：宿主事件名 10/10 存续、宿主服务 38/38 形状匹配、客户端错误码修复与 rc.1 一致——**没有一处"今天就静默错"的大面积失效**；但发现 **3 个 P0 级已坏/高危点**、**11 类 P1 结构缺口**，以及一条贯穿全局的系统性缺陷：

> **dsp 把宿主契约写成散落在 37 个文件里的 80 处类型断言与硬编码字面量；测试套件 0/54 文件 import 过任何真实宿主包。**

于是 v1.30.5 修复的那类 bug（宿主改错误码 → dsp 静默失效）不是偶然，而是**结构的必然**：类型检查被断言抹掉、运行时没有校验、测试镜像的是 dsp 自己的假设。三个分片各自独立命中了同一个 P0（`serenity/bound`），三片独立收敛即最高置信度。

**最危险的三条**：

| 编号 | 级别 | 一句话 | 状态 |
|---|---|---|---|
| F-01 | **P0** | dsp 向会话日志写入自定义事件 `serenity/bound`，但该事件既不在宿主的生成白名单里、`Session.append` 又无法写 `ignorable` 标记 → **含绑定事件的会话在冷加载/恢复时可能被宿主拒绝加载** | 机制已由主线程复核确认；运行时可达性待实测 |
| F-02 | **P0** | `acp-core.ts:187` 调 `agent.interrupt()`，rc.1 的 Agent **没有** 该成员（只有 `cancel(cause)`）→ **ACP `session/cancel` 永远 no-op，却返回 `{cancelled:true}`** | 已坏；测试替身提供了 `interrupt`，所以测试"通过" |
| F-03 | **P0** | 工作区白名单/禁建校验匹配 `/api/workspace.create`，rc.1 已是 `POST /api/workspace/create` + `{type,rpcId,method,payload:{args}}` 信封 → **外部用户的工作区白名单与"禁止创建"从未生效** | 静默失效（安全相关，公网 3081 面） |

---

## 2. 方法

| 维度 | 内容 | 承担 |
|---|---|---|
| ① 宿主契约面 | 事件 10 个、服务 15 个（38 处访问）、会话 append/surfaceOp/持久化、workspace RPC、settings API、客户端槽位与错误码、硬编码宿主字面量 | 分片 A / B / C |
| ② 类型断言旁路 | 全部 `as unknown as` / 结构断言站点，逐点判定"漂移后是响亮失败还是静默错误" | 分片 D |
| ③ 测试保真度 | 替身是否镜像 rc.1 真实类型、契约覆盖矩阵、防漂移守卫设计 | 分片 E |
| ④ 架构缺失 | specs v1.5.0 合规、宿主适配边界、失败/降级策略、可观测性、版本兼容策略 | 分片 F |
| ⑤ 声明面（主线程） | manifest/config/README 与现实的偏差 | 分片 G |
| ⑥ 横切（主线程） | `apply()` 失败语义、版本读取、CI、服务访问风格 | 分片 H |

证据规则：每个结论必须同时给出 **dsp `file:line`** 与 **宿主 `file:line`**；无法静态确认的显式标注"待实测"，不写成结论。分片报告见 §8。

**量化基线**：dsp src 71 文件 / 测试 54 文件 / 913 测试；宿主 import 面 82 处（~15 个 `@deepseek-ai/dsh-*` 包）；断言旁路 **80 处**；`catch {}` **121 处**；测试中 import 真实宿主包 **0 个**。

---

## 3. Findings 总表（跨片去重）

### 3.1 P0（立即处理）

| ID | 维度 | 结论 | 证据（dsp ↔ 宿主） | 失败模式 | 修复 |
|---|---|---|---|---|---|
| **F-01** | 持久化 | 自定义会话事件 `serenity/bound` **没有** 落 `ignorable` 标记；宿主读路径只认"生成白名单 ∨ ignorable" | dsp 写入：`session-bound.ts:106-127`（6 处生产调用点：`tools/session.ts:399,457,491`、`seams/context.ts:193`、`skiff-core.ts:131`、`rebuild.ts:297`）；**dsp 自己的设计文档已写明要带 `ignorable: true`**：`docs/session-binding-hardening-research.md:53`——但类型声明只声明了 payload（`session-bound.ts:27-48`），envelope 标记从未写入。宿主：`core/session/src/known-event-types.ts:9-22`（注释明示 out-of-repo 插件事件**不在**集合内）、`session-persistence/src/coordinator.ts:1248-1252`（读路径拒绝，调用点 `:1027,:1057,:1074,:1509` 含 HMR/恢复路径）、`core/session/src/index.ts:668-697`（append 只写 type/seq/time/data/surface 元数据，**无 ignorable 通道**）；宿主自己的决策记录 `.agents/notes/implemented/architecture/2026-08-30-retain-ignorable-external-session-events.md:9-17` 正是为"某个第三方插件依赖该字段"而保留它，并写明"没有它，first-party 读端会拒绝含该插件事件的已存会话" | **写入时静默、下次冷加载响亮抛错**：`SessionFormatUnsupportedError`；即 v1.29.1 为"绑定更坚固"而做的持久化，可能反过来让会话不可加载（首次冷加载 = 恢复/WebUI 打开历史/`sessionPersistence.inspect`）。当前部署尚未观察到该错误 → **运行时可达性待一次实测**（§7） | 绑定状态迁出会话日志（`AGENT_SESSIONS/.bindings.json`，推荐）；**先停止 append** + 写"写入→flush→冷加载"回归测试。不要用 cast 掩盖 |
| **F-02** | 事件/客户端 | `agent.interrupt?.()` 在 rc.1 不存在 → ACP cancel 永久 no-op 且报成功 | `acp-core.ts:187` ↔ `packages/core/agent/src/runtime-types.ts:91`（`cancel(cause)`） | 静默（且 `?.` 让类型检查放行；测试替身 `tests/acp-core.test.ts:80,93` 提供 `interrupt` 从而"认证"了这个 no-op） | 改 `agent.cancel({kind:'user'})`；删除测试替身中的 `interrupt` |
| **F-03** | 线格/安全 | 工作区创建校验匹配旧端点/旧信封 → 白名单与禁建从未生效 | `gateway.ts:277,301-303` ↔ `typert/registry/src/service.ts:63-68`、`client/connection/src/client/rpc.ts:36-51` | 静默：`allowWorkspaceCreate=false` 与白名单对公网用户形同虚设 | 改匹配 `POST /api/workspace/create` + 解析 `payload.args.path`；用 rc.1 信封写测试 |

### 3.2 P1（下一轮）

| ID | 维度 | 结论 | 证据 | 修复 |
|---|---|---|---|---|
| F-04 | 测试保真 | **0/54 测试文件 import 任何真实宿主包**；80/80 断言站点无测试能捕获漂移；11 个替身仍暴露已删除的 `.events`；7 个文件 mock 已被 rc.1 删除的 `installSettingsSection`/`settingsNamespace`；`image-fallback.test.ts` 断言的是 dsp 自己复制的宿主错误码 | 分片 E（E-01/02/03/04/05、A-1、A-2） | vitest alias 到 tsconfig 已有 paths + 5 个契约测试；删除 `.events` 回落与替身；断言对宿主类型 |
| F-05 | 契约校验 | 无运行时宿主契约校验；`readDshVersion()` 读了版本但**从不比对**；`engines.dsh` 宿主不执行 | 分片 F R-01、H-2、G-1 | `src/seams/host-contract.ts`：声明式契约表 + `probeHostContract()` → `dashboard health`（degraded）+ 启动一次性告警 |
| F-06 | 架构边界 | 无宿主适配边界：37/68 文件 import 宿主、80 处断言、17 处纯属多余（宿主已导出类型） | 分片 F、D、B-3 | 抽 `src/host/` 统一拥有宿主访问（required/optional + 各自降级策略），`inject` 由声明派生 |
| F-07 | 失败策略 | 121 处 `catch {}` 无策略；守卫**fail-open**：`serenity.json` 损坏 → `{}` 静默清空黑名单（`ccc.ts:292-296`）；凭据硬名单只比对 `rel === 'localstore.json'`（`guards.ts:179`，无 realpath → 符号链接可绕过；非 safe-mode 下 bash 亦可读） | 分片 F R-03/R-04/R-07 | 写失败策略（守卫输入失败必须响亮并记录）；`realpath` 归一 + bash 命令路径 deny |
| F-08 | 生命周期 | 未订阅 `agent/disposed`/`session/disposed`：约 10 处 per-session map 无界增长，`waitIdle` 在 agent 先 dispose 时永久挂住；HTTP 服务/定时器/轮询器无 `ctx.effect` 拆卸 → HMR/重载后端口冲突、重复轮询 | 分片 A A-04/A-05 | 订阅两个 dispose 事件；`waitIdle` 与 dispose 竞速；每个资源包 `ctx.effect(() => () => teardown)` |
| F-09 | 事件 | `agent/pre-step` 回落 `[acc, ...messages, ...downstream.messages]`，而宿主 `next()` 已含 claimed 消息 → 用户消息重复入日志与请求 | 分片 A A-02 ↔ `agent-loop/src/agent.ts:245-248` | 去掉 `...messages` + 消息计数断言 |
| F-10 | 线格 | `workspace.list` 在 rc.1 已被 `remote.workspace.follow` 流替代 → 外部用户看到全部工作区，白名单只剩 create 校验 | 分片 C C-3 | mux 代理侧过滤 upsert 帧，或撤销该设置并文档化 |
| F-11 | 路径 | `DSH_HOME` 解析未遵循宿主优先级（配置路径 > `$DSH_HOME` > `~/.dsh`，空串视为未设）→ 空 `DSH_HOME` 得到 CWD 相对路径 | 分片 C C-4 ↔ `util/home-paths/src/index.ts:79-88` | 用 `resolveDshHome`/`dshHomePath`（加 peer 依赖） |
| F-12 | 可观测性 | `dashboard health` 检查的是 CCC，不是 dsp；诊断只有两个事后补的临时文件；9 个 seam / gateway / 微信 / Skiff / ACP 无健康路径 | 分片 F R-08/R-09、H | 统一诊断面 `host/diagnostics.ts` → `AGENT_SESSIONS/.acc-diag.json`；health 增 host/seams/faces/config 段 |
| F-13 | 标准合规 | spec §10 错误契约（13 类 + `serenityCode`）**全仓 0 实现**（dsp 与 CCC MSM 均无 `E-*` 码）；阈值默认 150 vs spec 100；ACK 码 `K<n>` 顺序 vs spec"3 位随机"；persona 开启时**置换** EAP 块（违反 I5）；toolsBlock 只列 container_git 的 4/6 动作 | 分片 F ↔ `specs/README.md:735-753`（§10）、`:661`（ACK 码） | 逐项裁决（§6 D-3）：实现 or 从标准删除 |
| F-14 | 过程 | **无 CI**；`dsh-develop publish` 只跑 typecheck+build+pack-check，**不跑 test** → 绿着发布可能带着红测试 | 分片 H H-3（v1.30.5 publish 实测输出） | 加 GitHub Actions（typecheck+test）；publish 前拒红 |

### 3.3 P2（清理，摘要）

- **F-15 声明面漂移**（分片 G，10 条）：`engines.dsh` 陈旧、`@deepseek-ai/dsh-settings` 未列入 peerDeps、npm 描述/README 停在 v1.30.0 与旧工具名、`cp -r` 非幂等的 templates 构建、双包版本线（0.2.0 vs 1.30.5）无关系说明、`version` 守卫只查 3 个文件。
- **F-16 重复实现**：3 份 `sessionEvents` 读取器（`session-ops.ts:52` 权威 + `skiff-core.ts:385` + `tools/handyman.ts:77`，其中一份注释自称是副本）、`filterWorkspaceList` 死代码但测试仍绿、4 个配置存储无归属表。
- 其他：`as never` 239 处（测试）、非声明错误码 `forbidden`/`bad-request`、ImageFallbackDock 注释仍写 `attachment-error`、`DraftAttachmentId` 从根入口导入但根不导出。

---

## 4. 三条系统性根因（为什么这些会反复发生）

1. **契约没有单一拥有者。** 宿主契约以"内联断言 + 硬编码字面量"分散表达（80 处断言 / 37 文件 / 82 import 点）。改一处不等于改对全部——`.events` 就有 3 份副本，`session/title` 扫描在 2 处。→ 漂移**不可检、不可报、不可一处修**。
2. **验证镜像的是自己的假设，不是宿主。** 0/54 测试文件 import 真实宿主包；替身保留已删除成员（`.events`）、mock 已删除的导出（`installSettingsSection`）；`image-fallback.test.ts` 断言的正是 dsp 复制的宿主错误码。→ **绿测试与契约成立无关**，这正是 v1.30.5 与 `.events` 两次 bug 都"全绿发布"的原因。
3. **失败与降级无策略。** 121 处静默 `catch {}`、守卫 fail-open、无逐子系统隔离（宿主对 `apply` 抛错 = 整机启动失败，`app-boot/src/index.ts:674-677` 实证）。→ 故障要么静默（功能悄悄不工作），要么灾难（整个 dsh 起不来），中间没有"降级但可见"。

---

## 5. 修复路线（建议顺序与依赖）

**第一轮（P0，约 1~2 天）**
1. **F-01 绑定持久化迁出会话日志** —— 停 append + 迁 `bindings.json` + "写入→重载"回归测试。**先于一切**（它关系到 v1.29.1 机制的存亡）。
2. **F-02 ACP cancel** —— 一行修复 + 清理测试替身。
3. **F-03 工作区端点/信封** —— 修匹配 + rc.1 信封测试（安全面）。

**第二轮（P1 骨架，约 3~5 天）**
4. **F-05 + F-06 宿主契约层**：`src/host/` 统一访问 + 声明式契约表 + `probeHostContract()`；顺带删掉 17 处多余断言（F-06）。
5. **F-04 测试契约化**：vitest alias + 5 个契约测试（host-contract / session / agent / settings / error-codes）。
6. **F-07 失败策略** + **F-08 生命周期** + **F-14 CI**。
7. **F-09/F-10/F-11/F-12** 逐项修。

**第三轮（P2 + 标准裁决）**
8. F-13 spec 缺口逐项裁决；F-15 声明面守卫扩展；F-16 重复实现收敛。

---

## 6. 待用户拍板的决策点

| ID | 决策 | 选项 |
|---|---|---|
| **D-1** | F-01 绑定持久化落在哪 | ① `$DSH_HOME/serenity/bindings.json`（宿主 home 内、跨 CCC 隔离差）② `AGENT_SESSIONS/.bindings.json`（CCC 内、随轨迹走，**推荐**）③ 等宿主开放 ignorable 写入通道（阻塞风险） |
| **D-2** | F-03/F-10 工作区白名单形态 | ① 在 mux 代理侧过滤 follow 帧（完整但重）② 撤销列表过滤、只保 create 校验并文档化（**推荐**，rc.1 无 list） |
| **D-3** | F-13 spec 缺口 | §10 错误契约：实现 13 类 vs 从标准删除；ACK 码改 3 位随机；阈值 150 → 100（跟 spec）；persona 是否允许置换 EAP 块（I5 例外还是禁用） |
| **D-4** | 是否引入 CI | GitHub Actions 跑 typecheck+test（推荐）；或维持本地 `dsh-develop test` |
| **D-5** | 重构时机 | 宿主契约层（F-05/F-06）是否并入下一个版本一次做完（推荐），还是先出 P0 补丁版 |

---

## 7. 验证清单（每个 P0 如何证明修好了）

- **F-01**：
  - **实测（待做，1 分钟）**：在 WebUI 打开一个曾经执行过 `logbook use/create/rebuild` 的旧会话（或重启 web 后重新打开当前会话）→ 若抛出 `SessionFormatUnsupportedError`，P0 即刻坐实；若不抛，记录原因（说明读路径未覆盖该日志）。
  - **修复后回归**：造一个含绑定事件的会话 → 冷加载（重开历史 / 重启 web）→ 断言不再抛错；反向：迁出后会话日志中不再出现 `serenity/bound` 类型。
- **F-02**：ACP `session/cancel` 后断言 agent 状态实际终止（而非仅返回 `cancelled:true`）；测试替身不再提供 `interrupt`。
- **F-03**：用 rc.1 信封（`POST /api/workspace/create` + `payload.args`）打外部 3081 面 → 白名单外路径被拒、`allowWorkspaceCreate=false` 时被拒。
- **横切**：`probeHostContract()` 在 0.1.2-rc.1 上 `ok:true`；人为改一个宿主成员名 → health 报 degraded（负向测试）。

---

## 8. 分片报告索引

| 分片 | 文件 | 内容 | 计数 |
|---|---|---|---|
| A | `docs/review/slice-A-host-events.md` | 宿主事件契约 + 未覆盖扩展点 | 16 OK / 2 漂移 / 1 断言隐藏 / 3 P2 |
| B | `docs/review/slice-B-host-services.md` | 宿主服务契约 | 38/38 OK / 0 P0 / 14 静默风险 |
| C | `docs/review/slice-C-wire-persistence-client.md` | 持久化/RPC/设置/客户端 | 27 OK / 2 P0 / 2 P1 / 4 P2 |
| D | `docs/review/slice-D-assertion-audit.md` | 类型断言旁路审计 | 80 站点 / 80 静默 / 0 测试守卫 / 17 多余 |
| E | `docs/review/slice-E-test-fidelity.md` | 测试保真度 + 守卫方案 | 8 P0 / 9 P1 / 5 P2；0/54 真实宿主 import |
| F | `docs/review/slice-F-architecture-gaps.md` | 架构缺失 + R-01~R-20 路线 | 5 大结构缺口 |
| G | `docs/review/slice-G-declaration-surface.md` | 声明面一致性 | 5 OK / 8 不一致 / 6 无守卫 |
| H | `docs/review/slice-H-cross-cutting.md` | 横切（apply 失败语义/版本/CI/访问风格） | 5 项 |

**局限（诚实声明）**：全部为静态核对——safe mode 下 bash 禁用，未跑 typecheck/test，未对运行中的 npm 宿主（`~/.npm-global` 在 CCC 之外，P3 边界）取字节；A-01/C-1/E-06 与 C-1 的运行时可达性、以及"生产 profile 是否挂载 session-persistence"未实测，已在 §7 给出决定性验证步骤。

---

## 9. 修复进展（2026-09-08 更新）

### 9.1 用户实测反馈（负向结果，R↓ 如实记录）

用户对 §7 的 F-01 实测步骤给出**实测答案**："4 其实没有，我们自己会话 rebuild 过多次了"——即多次 rebuild / 重启均未出现 `SessionFormatUnsupportedError`。

**据此修正 F-01 的严重度表述**：机制层面**已确认**是契约违规（宿主读路径拒绝未知且非 ignorable 的事件，`append` 无该通道），但**在本部署中未观测到触发**。可能原因（未逐一验证）：① 本部署的会话在重启后走的是活跃恢复/采用路径，未对含该事件的日志做冷读；② 相关会话被 rebuild 归档后未再打开；③ 绑定事件实际未成功写入（`appendBound` 静默失败）。

**结论**：F-01 从"P0 已坏"降级为 **"P0 契约违规 / 运行时未触发（潜在风险）"**；修复照做（成本低、消除潜在风险），且修复后由 §7 回归断言覆盖。

### 9.2 已修复（v1.30.6，用户拍板 D-1~D-5 全部按建议执行）

| 编号 | 修复 | 验证 |
|---|---|---|
| F-01 | 绑定持久化迁出会话日志 → `AGENT_SESSIONS/.bindings.json`（原子写 + 旧事件只读回落 + 停止 append 自定义事件） | session-bound 重写 16 用例（写入/latest-wins/会话隔离/损坏容忍/旧形态回落/编码无关/子目录 cwd）；rebuild + skiff-core 断言同步 |
| F-02 | `agent.interrupt?.()` → `agent.cancel({ kind:'user' })`；测试替身改为 `cancel` | acp-core 用例更新（替身不再供应宿主不存在的成员） |
| F-03 | 新增 `isWorkspaceCreatePath` + `parseWorkspaceCreateBody`（rc.1 端点/信封 + 旧形态兼容） | gateway +3 用例（端点判定 / `payload.args.path` / 旧信封与坏 JSON） |

**测试基线**：913 → **920**（62 files）全绿 + typecheck 双面 ✓ + build ✓。版本 = **v1.30.6（代码态，未发布）**。

### 9.3 后续轮次（待办）

- 轮 2（P1 骨架）：F-05/F-06 宿主契约层 + probeHostContract → dashboard health；F-04 测试契约化（vitest alias + 5 契约测试）；F-07 失败策略；F-08 生命周期；F-14 CI。
- 轮 3：F-09~F-13 逐项 + F-15 声明面守卫扩展 + F-16 重复实现收敛。
