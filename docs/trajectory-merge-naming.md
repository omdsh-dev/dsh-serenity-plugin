# trajectory 合并 · 子命令命名方案 v0.1（草案）

> ⚠️ **2026-09-14 用户裁决已取代本方案的 §2/§3/§7**（废除 `logbook` 一词、动作收敛为 9 个：list/show/create/use/rebuild/wake-later/all/random/diag）。
> 裁决全文与后果分析见 `home-serenity` CCC 的 `AGENT_SESSIONS/2026-08-24--S142--dsh-serenity-plugin 长期维护/SESSION.md` **§32.7**。
> 本文件保留为**推理沿革**（域划分思路 + 涟漪地图 + 剪枝分析仍有参考价值；§5 涟漪地图对实施依然有效）。

- **来源**：S142 §32（用户 2026-09-14「我觉得 logbook 应该和 trajectory 合并了」「合并后内部的子命令需要重新命名，给我方案」）
- **状态**：**草案，未动代码**。供裁决用；获准后再进实施（建议实施顺序见 SESSION.md §32.4 M9）
- **假定**：形态取 **A1（前缀式单枚举）**；若改选 A2（`domain` 参数）见 §7 备选
- **与权限正交**：本方案**不解决** M5（权限面）——`tools.restrict` 是**工具级** deny，改名不改变谁能调；权限模型须单独裁决

---

## 1. 命名语法（四条规则）

| # | 规则 | 理由（R↓） |
|---|------|-----------|
| **R1** | **一个工具 `trajectory` + `<域>-<动作>` 前缀式单枚举** | 合并后动作池是并集，"无前缀"必生歧义（§3 实证）；单枚举不引入第二个耦合参数 |
| **R2** | 动作层**小写动词、连字符分隔**，域内唯一 | 与既有习惯一致（`wake-add`/`wake-list`/`wake-rm` 已经长这样，**零改动**） |
| **R3** | **隐喻只出现在域层**（`logbook`/`wake`/`auto`），动作层一律平实动词 | 避免"隐喻的二次翻译"：模型只需理解三个域，不必逐动作猜隐喻 |
| **R4** | 新动作**先归域、再命名**；归不进任何域 ⇒ 说明该拆而不是硬塞 | 防止合并块变成杂物间（熵） |

## 2. 域划分（三分，按"主语"切）

| 域 | 管什么 | 主语 | 动作数 |
|----|--------|------|--------|
| **`logbook`** | 轨迹**载体/日志**：建档、激活、关闭、归档、重建、体检、核对 | SESSION.md（轨迹的**身体**） | 11 |
| **`wake`** | **一次性**唤醒：未来某时刻 + 一条 message（注册表） | 注册表条目 | 3 |
| **`auto`** | **周期自唤醒**（= autopilot，D59 独立单例）及其配置/诊断 | autopilot 周期项 | 9 |

**为什么三分而不是二分**：`wake` 与 `auto` 是**两条异质机制**（显式时刻 vs 周期），D59 已裁决二者分开。命名上分开后，将来加第三种时间机制（例如事件触发的 `event-*`）只是**加一个域**，不动既有名字。

## 3. 完整对照表（旧 → 新）

| # | 旧（工具.动作） | 新（`trajectory` 的 action） | 备注 |
|---|----------------|------------------------------|------|
| 1 | `logbook.list` | `logbook-list` | |
| 2 | `logbook.show` | `logbook-show` | |
| 3 | `logbook.create` | `logbook-create` | |
| 4 | `logbook.use` | `logbook-use` | 写 `.bindings.json`——**唤醒定位依赖它**（显式化的既有耦合） |
| 5 | `logbook.close` | `logbook-close` | |
| 6 | `logbook.archive` | `logbook-archive` | |
| 7 | `logbook.rebuild` | `logbook-rebuild` | 高频于提示词（keeper 两条提醒 / rebuild 报错引导）⇒ 已按"保留原短语"选域名字面 |
| 8 | `logbook.health` | `logbook-health` | 结构体检（stale/stalled/drift/ghost） |
| 9 | `logbook.qa` | `logbook-qa` | 事实核对（与 health 分工：结构 vs 事实） |
| 10 | `logbook.summary` | `logbook-summary` | |
| 11 | `logbook.hook-develop-guide` | `logbook-hook-guide` | **截短**（原名 24 字过长）；或按 §6 移出工具面 |
| 12 | `trajectory.wake-add` | `wake-add` | **不变**（已合规） |
| 13 | `trajectory.wake-list` | `wake-list` | **不变** |
| 14 | `trajectory.wake-rm` | `wake-rm` | **不变** |
| 15 | `trajectory.all` | `auto-report` | **动词化**（`all` 是形容词式命名，读不出"干什么"） |
| 16 | `trajectory.status` | `auto-status` | |
| 17 | `trajectory.check` | `auto-check` | |
| 18 | `trajectory.diag` | `auto-diag` | 唤起条件链诊断（脚本侧） |
| 19 | `trajectory.diag-live` | `auto-diag-live` | 进程内诊断 |
| 20 | `trajectory.random` | `auto-random` | 跑偏见脚本取随机方向 |
| 21 | `trajectory.init` | `auto-init` | 可选剪枝（§6） |
| 22 | `trajectory.doc` | `auto-doc` | 可选剪枝（§6） |
| 23 | `trajectory.guide` | `auto-guide` | 可选剪枝（§6） |

⇒ **改动 20 个名字、3 个保持不变**（`wake-*` 三兄弟本就合规）。

## 4. 冲突消解（"为什么必须有前缀"的实证）

| 冲突面 | 合并前的旧状 | 无前缀会怎样 | 新解 |
|--------|--------------|--------------|------|
| `list` | `logbook.list`（列会话） vs `trajectory.wake-list`（列唤醒） | 合并后 `list` **歧义**（列谁？） | `logbook-list` / `wake-list` |
| `status`/`check`/`health` | 三个"查状态"，分属两个工具 | 无法从名字判断查的是什么 | `auto-status`/`auto-check`/`logbook-health` |
| `summary` / `all` | `logbook.summary`（会话总览） vs `trajectory.all`（全报告） | 两个"给我总览" | `logbook-summary` / `auto-report` |
| `show`/`doc`/`guide` | 三个"给我看" | 同上 | `logbook-show` / `auto-doc` / `auto-guide`（或移出） |

## 5. 涟漪地图（改名必须同批动 vs 明确不动）

**ACC 侧（**要发版**）**：

| 文件 | 动什么 |
|------|--------|
| `hooks/dsh-serenity-hooks/src/tools/session.ts` + `tools/autopilot-trajectory.ts` | 合并为单一工具工厂；`SESSION_ACTIONS` / `AUTOPILOT_ACTIONS` → 新枚举（值改、常量名可留） |
| `src/invariant.ts` | `REGISTERED_TOOLS` 11 → **10**（去 `logbook`） |
| `src/seams/system-prompt.ts` | toolsBlock 工具清单行 + 隐喻域 §7「The Logbook」措辞 + Departure Inspection 行 |
| `src/seams/keeper.ts` | rebuild 两条提醒（`logbook rebuild` → `logbook-rebuild`）；compaction 提醒里作为**概念词**的 "logbook" **保留不动** |
| `src/skiff-core.ts` | 角色提示词（`no logbook use needed` → `no logbook-use needed`；`run logbook rebuild`） |
| `src/rebuild.ts` | 报错引导两处（`Run "logbook use …"`） |
| `src/wake-scheduler.ts` | 错误文案一处（"需先被 logbook use 激活过"） |
| `src/client/SettingsSection.tsx` | 面板文案两处（重建说明） |
| `src/msm-ops.ts` | 能力目录一行（"会话与轨迹 → logbook"） |
| `src/templates/acc-serenity/SKILL.md` / `acc-session/SKILL.md` / `acc-neat/SKILL.md` | 随包分发的技能模板（三处工具名 + 用法示例） |
| `README.md` / `hooks/dsh-serenity-hooks/README.md` | 工具表 |
| `tests/` | `register.test`（effect 数）/ `invariant`（工具名集合）/ 各工具名断言 + 新老名字对照用例 |

**CCC 侧（措辞，同批做，不需发版）**：
`.opencode/skiff/zhaocai.md`（4 处）｜`.opencode/skills/home-serenity/SKILL.md`（路由表）｜`.opencode/skills/home-serenity/references/acc-ccc-boundary.md`｜`.opencode/skills/dsh-serenity-plugin-development/SKILL.md`（维护文档）｜`.dsh/skills/acc-session/SKILL.md`（装机副本，重装即更新）

**明确不动**（沿 D46「内部文件名不改」）：`session-ops.ts` / `session.ts` / `rebuild.ts` / `wake-registry.ts` / `wake-scheduler.ts` 等**实现文件名**；`.bindings.json` / `wake-registry.json` **数据文件名**。

## 6. 可选剪枝（23 → 19；与命名正交，可单独裁决）

| 动作 | 建议 | 理由 |
|------|------|------|
| `auto-doc` / `auto-guide` / `logbook-hook-guide` | **移出工具面**（改由 ACC 文档 + skill 承载），或降为**布尔参数** `guide: true`（`handyman(guide=true)` 有先例） | 三者都是"给我看文档"，不是动作；留在 enum 里只增选择成本 |
| `auto-init` | 移出（低频；配置模板可进文档） | 一次性动作 |
| `logbook-health` 与 `logbook-qa` | **两者都留** | 判据不同：health = 结构异常（stale/drift/ghost）；qa = 事实核对 |
| `logbook-summary` 与 `logbook-list` | 保留（描述里写明分工：list = 清单+状态码；summary = 仪表盘） | 重叠但视角不同 |

收益：enum 条目 −17%，模型选错面更窄；代价：文档入口从"工具动作"改为"读 skill/--help"（需要 CCC 侧措辞配套）。

## 7. 备选与取舍

| 备选 | 内容 | 优 | 劣 |
|------|------|----|----|
| **A1 前缀式（本方案）** | 单枚举 `<域>-<动作>` | 无额外参数；自解释；已合规的 `wake-*` 零改动 | 动作名变长（最长 `logbook-hook-guide` 18 字符） |
| A2 双参数 | 参数 `domain: logbook\|wake\|auto` + 域内 `action` 短名 | enum 更短、结构更强 | 两个**耦合**参数；错误组合需运行时校验；模型多一次决策 |
| B 扁平无前缀 | 23 动作直拼 | 实现最省 | §4 的歧义**无解**，且 schema 最长（与"收敛工具面"初衷相悖） |
| 保留旧名做别名 | 新旧并存 | 零迁移 | enum 翻倍（≈46）⇒ 明确否决（沿 D46 硬切 + toolsBlock 对照表） |
| 顺带改回 `session-*` | — | — | `session` 在 ACC 词汇里指**可弃载体**（≠轨迹），与 D58 语义冲突 ⇒ 否决 |

**域名字面备选**：
- `logbook`（推荐）vs `log`：取 `logbook` 是为了**保住既有提示词短语**——keeper 里 "call the logbook rebuild action" 只需改成 "call the `logbook-rebuild` action"，涟漪最小；`log-` 更短但要重写更多暗示性文本。
- `auto` vs `cycle` / `timer` / `ap`：取 `auto`（与既有 `autopilot` 词根一致，且比 `cycle` 少歧义——"cycle" 容易被理解成循环体）。

## 8. 未决（待裁决）

1. **M2 形态**：A1（本方案）/ A2 / B
2. **M5 权限模型**：本方案不解决——是否接受 skiff 面放大 / 引入动作级白名单
3. **§6 剪枝**：做 / 不做
4. **域名字面**：`logbook` vs `log`；`auto` vs 其它
5. **M6 兼容**：硬切无别名（本方案默认）/ 过渡别名
