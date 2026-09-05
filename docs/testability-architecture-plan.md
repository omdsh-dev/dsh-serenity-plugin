# dsp 可测试可验证 + 架构清晰化规划（2026-09-05，S142 用户新方向）

> 用户方向："让我们 dsp 所有功能可测试可验证、符合预期、符合对 ACC 层的定位、可以做什么"→ 澄清为**更清晰的架构 + 体系化的单元测试**。
> 依据：独立审计 subagent（59351db3）src↔测试覆盖矩阵 + 一手源码核查。

## 1. 意图解构（E↑）

| 用户表述 | 工程含义 | 落地形态 |
|---------|---------|---------|
| 可测试可验证 | 每功能有验证手段 + 可度量 | 测试覆盖矩阵 + coverage 配置 + E2E 清单 |
| 符合预期 | description/文档 与 实际行为一致 | 描述↔行为契约守卫（rebuild bug 教训机制化） |
| 符合 ACC 层定位 | 机制层不做内容判断 | 架构分层清晰（services 目录化）+ tools/seams/services 边界 |
| 可以做什么 | 能力边界权威说明 | catalog/ccc-config 已有雏形，随 v1.28.0 完备 |

## 2. 现状基线（审计实证）

- **测试**：45 测试文件 / 54 files / 794 tests 全绿；src 45 业务模块**基本全绿**（services/seams/tools 大多有直接测试）
- **亮点**：src↔tests 目录镜像、双文件互证、回归门禁文化、真实临时目录夹具
- **缺口**：见 §3

## 3. 缺口清单与修复方案

### P0（回归风险，立即）
- **[P0-1] keeper.test 补 rebuildReminderText "--summary" 断言**：v1.28.0 新增文案（rebuild bug 修复核心指令）零守护——keeper.test.ts L70-101 只查 [TRAJECTORY]/412K/ACT NOW 等，无一条查 `--summary`/`≤20 chars`/`renamed to S###`。补 3 断言（普通版 + 升级版）。

### P1（高价值补测）
- **[P1-1] seams/opencode-skills.ts 独立测试**：唯一完全裸奔 seam（registerOpencodeSkills 扫描→注册）。复用 skills/opencode-scan.test 的 temp CCC + fake skills 模式。
- **[P1-2] client/image-fallback-api.ts 测试**：与 file-fallback-api 对称（后者有 file-fallback.test）。
- **[P1-3] gateway-auth/proxy 独立测试**：从 452 行 gateway.test 拆出 auth（verify/issue/validate/revoke/CSRF/锁定）与 proxy（buildProxyHeaders/filterWorkspace/workspaceAllowed）。

### P2（结构性）
- **[P2-1] vitest coverage 配置**：vitest.config.ts 加 coverage（provider v8 / reports-dir / 分支+函数+语句阈值起步宽松 60% 防倒退、逐步收紧）。**可度量 = 可验证的前提**。
- **[P2-2] src↔tests 镜像一致性门禁**：仿 compliance.test 加机械测试——扫描 src/ 业务模块（排除 index/constants/json/css），断言每个均有 tests/ 同名文件或出现在某测试 import 白名单 → 新模块无测试立即暴露。
- **[P2-3] client tsx 冒烟/可编译门禁**：esbuild 试编全部 .tsx（零依赖断言可编译）；未来可引 @testing-library 做组件逻辑测试（成本高，分期）。
- **[P2-4] 共享测试 helper**：抽取重复的 schemastery 链式 mock（≥5 文件）+ mkActiveSession/mkdtemp 夹具 → tests/helpers/。
- **[P2-5] 巨型测试拆分**：weixin.test.ts（898 行横跨 4 模块）→ weixin-api/route/bridge 分文件；gateway.test.ts 同前（与 P1-3 协同）。
- **[P2-6] services 目录化（架构清晰）**：src/ 根级 32 平铺服务文件 → 按域归组 `src/services/`（gateway*/api/config-ops/settings-section）`src/external/`（acp*/skiff*/weixin*）`src/domain/`（ccc/fs-ops/git-ops/msm-ops/kit-ops/session-ops/totp/output-guard）——**纯目录移动 + import 路径更新 + 测试路径更新**，零行为变更；SKILL.md Layer 5 描述与实际文件结构对齐（R↓：架构文档不虚标）。

## 4. ACC 定位核对（每项改动自问）

- 是**机制层**（工具/守卫/服务/协议）→ ACC 该做，测试补
- 是**内容/配置/决策**（CCC 具体）→ 不做，留给 CCC
- 是**平台**（DSH harness）→ 零改，走 seam/服务

本规划全部落在机制层（测试/结构），不越界。

## 5. 执行顺序（依赖排序）

1. **P0-1**（5 分钟，立即消除回归风险）
2. **P2-6 目录化**（结构性前提——先移目录再补测试，避免测试路径改两次）→ 全量 typecheck/test 验证零行为变更
3. **P2-1 coverage**（度量基线，随目录化后跑首份报告）
4. **P1-1/2/3**（补裸奔模块测试）
5. **P2-2 门禁**（防再裸奔；覆盖报告纳入门禁阈值）
6. **P2-3/4/5**（client 门禁 + helper 抽取 + 大文件拆分，可分轮）
7. 每步 typecheck/test 全绿；版本策略 D14（patch 迭代 / 等用户显式发版）

## 6. 验收标准

- [ ] vitest coverage 报告可生成，src 覆盖率有基线数字
- [ ] src↔tests 镜像门禁：新增 src 模块无测试 → 测试失败
- [ ] rebuildReminderText "--summary" 文案有断言守护
- [ ] 无裸奔模块（opencode-skills/image-fallback-api 补齐）
- [ ] src 目录分层（services/external/domain）与 SKILL.md 描述一致
- [ ] 794 tests 全绿保持 + 新增无回归
