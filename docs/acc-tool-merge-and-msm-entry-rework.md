# ACC 工具面合并 + MSM 入口重构方案（S142，2026-09-06 用户提出）

**状态**: v0.1 方案（代码级，待用户拍板）
**会话**: S142
**基线**: v1.29.2（60 files / 879 tests）

---

## 1. 需求（用户原话 + E↑ 转译）

> "下一步我要做 acc 提供的 tool 的合并，这个很重要，因为工具面越小，执行会越好，同时对于 msm 的执行，要重构更优雅符合 LLM 直觉的入口，看现在的情况，给我方案，至少 msm list 和 msm exec 要合并"

| # | 需求 | 意图（E↑） |
|---|------|-----------|
| R1 | **ACC 工具面合并** | 工具数越少 → LLM 选择成本越低 → 执行越好。工具面 = 每轮注入 LLM 的工具清单（defineTool 头 + schema）——13 个工具头 + 每个工具的参数 schema 都是每轮固定 token 开销 |
| R2 | **MSM 入口重构为 LLM 直觉入口** | 现 acc_msm 是"8 子命令 + 协议 flag"（list/exec/register/...），LLM 需要先 list 再 exec <name> --schema 再 exec <name> <args> **三步**才完成一次 MSM 调用——不符合直觉。**至少 list 和 exec 合并**：LLM 想执行某个 MSM 时，一次调用就知道"有哪些可执行 + 怎么执行 + 执行" |

---

## 2. 现状全景（源码实证）

### 2.1 工具面 13 个（index.ts L112-126 注册）

| 工具 | 功能 | schema 头规模 | 语义域 | 调用特征 |
|------|------|-------------|--------|---------|
| `cc_fs` | 文件系统 15 子命令 | 大（15 action） | 基础操作 | 高频 |
| `session` | 会话 9 子命令 | 大 | 会话轨迹 | 高频 |
| `acc_kit` | health/time/wait | 小 | 自检工具 | 中 |
| `cc_git` | git 4 子命令 | 小-中 | 基础操作 | 中 |
| `acc_msm` | MSM 8 action | 大（8 action+8 参数） | MSM 框架 | 高频 |
| `eap` | EAP 框架 | 极小 | 知识 | 低 |
| `neat` | Neat 协议 | 极小 | 知识 | 低 |
| `cce` | CCE 框架 | 极小 | 知识 | 低 |
| `handyman` | 杂工 agent | 大 | agent 编排 | 低 |
| `session_rebuild` | 超限重建 | 小（2 参） | 会话轨迹 | 低（关键路径） |
| `localstore` | 凭据/配置 | 小 | 配置 | 低 |
| `skiff_admin` | Skiff 角色 | 小 | 对外角色 | 低 |
| `autopilot-trajectory` | Autopilot 一站式 | 小-中 | 自主 | 低 |

### 2.2 MSM 入口现状（tools/msm.ts + msm-ops.ts）

- `acc_msm` 工具：action enum 8 项（list/exec/register/deregister/check/guide/ccc-config/catalog）+ name/skill/path/category/description/flags/usage 参数——**多 action 一个工具**
- **调用协议（system-prompt toolsBlock L112-116 硬编码）**：
  ```
  1. Discover:       acc_msm list
  2. Inspect usage:  acc_msm exec <name> --schema 1
  3. Execute:        acc_msm exec <name> <args...>
  ```
  → **三步才完成一次执行**！每次都是独立 tool-call round-trip → LLM 上下文膨胀 + 延迟。
- 实际 CCC 注册 MSM 规模：home-serenity ~75 个 + pangu ~90 个（每家 CCC 各自注册）——list 输出巨长，每次发现成本高

### 2.3 历史决策 D12（SESSION.md §5，2026-08-27 工具精简作罢）

> D12 工具数量精简**作罢**（维持 12 工具）：合并收益≈消灭小工具头（~200 tok/轮），大工具 schema 不缩；破坏 osp D11 对齐、迁移成本高；未来先看描述瘦身

**当时结论**：合并收益 ~200 tok/轮（小工具头），但大工具 schema 不缩水 → 净收益有限 → 作罢。**今天差异**：
- 用户明确要求（当时是 agent 自发调研）
- 若**合并 + 入口重构**同时做：不只是省小工具头，而是**消灭多步协议**（MSM 3 步 → 1 步）——收益质变
- 工具描述可瘦身（description 精简）与合并互补

### 2.4 跨仓对照（osp 侧实证，2026-09-06 新发现）

**opencode 运行时（osp）的 MSM 工具面与 dsp 不同**：
- osp = **`msm_list` + `msm_exec` 两个独立工具**（非 acc_msm 单工具多 action）
  - `msm_exec` 纯执行（注释明确"不再写 ALWAYS call msm_list first——LLM 已知"）
  - 协议元命令（--version 等）在 msm_exec 内
- osp 已收敛到 **4 tool slot：bash (override) + msm_list + msm_exec + ccc_admin**（src/msm.ts L792）
- dsp = **acc_msm 单工具 8 action**（list/exec/register/deregister/check/guide/ccc-config/catalog）

**对照启示**：
1. dsp 单工具已比 osp 双工具少 1 个头——但 action enum 强制 LLM 每次显式选 action，"默认 exec"语义缺失
2. osp 方向也是**精简工具面**（4 slot）——两仓方向一致，无冲突
3. 若 dsp 做 name 自由文本单入口，需**跨仓记入 specs/osp 待同步**（P6）——osp 的 msm_exec 纯执行形态其实已接近"直觉入口"，其 msm_list 可并入 msm_exec（name 未命中 → 返回候选 = 合并 list）

---

## 3. 方案设计

### 3.1 R2（先做，核心）：MSM 入口重构——单一入口 + 自描述执行

**核心洞察（LLM 直觉）**：LLM 不该"先 list 再 schema 再 exec"——它应该**直接说想干嘛**。MSM 是"可执行单元"，理想入口 = 一个工具，参数 = `{"name": "...", "args": [...]}`，工具内部：找不到 → 返回候选列表（代替 list）；找到 → 直接执行（代替 exec）。

**方案 A（推荐）：`acc_msm` 行为重构——list/exec 合并为 `msm` 单入口**

```
msm(<name: string>, <args: string[]>, <inspect?: boolean>)
```

| 调用 | LLM 视角 | 行为 |
|------|---------|------|
| `msm(name: "ssh-connect", args: ["status"])` | 我想执行 ssh-connect status | 直接执行，返回结果 |
| `msm(name: "不存在", args: [])` | 我想找一个能做 X 的 MSM | 返回模糊匹配候选列表（含 name+description，等价原 list 的过滤版） |
| `msm(name: "ssh-connect", inspect: true)` | 我想知道它怎么用 | 返回 usage/flags（等价原 exec --schema 1） |
| `msm(name: "ssh-connect", args: ["--help"])` | 我想看它帮助 | 透传（MSM 自身 --help） |
| `msm()` | 我在新 CCC 想了解有什么 | 返回**精简目录**（分类分组，替代全量 list 巨输出） |

**关键设计点**：
1. **name 是自由文本不是 enum**——LLM 不需要先知道有哪些 name 才能调（enum 会强制先 list！这是"不符合直觉"的根源）。name 不存在 → 返回 top-K 模糊候选（名称/描述子串匹配）
2. **args 是 string[]**——与 shell 直觉一致（exec 现有形态保留）
3. **inspect: true** = 原 `--schema` 协议 flag 语义化
4. **默认错误恢复**：执行失败（MSM 退出非 0）→ 返回错误 + usage 提示（现已有 --help TIP 机制，保留）
5. **内部仍走 msm-ops 的 runMsmAsync**（exec 异步 + 白名单门控不变）
6. register/deregister/check/guide/ccc-config/catalog → **移出主入口为管理子命令**（低频管理操作，不占主路径认知）——可保留在 acc_msm action 里或独立 `acc_admin` 工具

**为什么这符合 LLM 直觉**：
- 现有痛点：LLM 看 toolsBlock 学"三步协议"→ 实际调用时经常第一步就 list（输出 75 个 MSM 巨大）→ 再挑 name → 忘了 --schema 直接 exec 传错参 → 失败 → 重试。**认知负担 = 协议学习 + 每一步输出处理**
- 新形态：LLM 只需"我要 X"→ 工具自己兜底发现/提示/执行。name 自由文本 = 无需预知清单

### 3.2 R1：工具面合并

**候选合并（按语义域 + 收益）：**

| 合并 | 新工具 | 收益 | 风险 |
|------|--------|------|------|
| eap + neat + cce → `acc_knowledge`（或并入 acc_kit） | 1 知识工具（section: eap/neat/cce） | 消灭 2 个工具头 | 低（都是渐进披露知识，极少同时用） |
| acc_kit 并入？ | — | — | acc_kit 高频自检，保留独立 |
| session + session_rebuild → session 内加 rebuild action | session 9+1 子命令 | 消灭 1 工具头 | 中（session_rebuild 是关键路径，独立工具名更醒目；合并后 description 要保证 rebuild 可发现） |
| cc_fs + cc_git → `cc_fs` 加 git？ | — | — | 语义域不同（文件 vs git），不建议 |
| handyman/skiff_admin/autopilot 独立保留 | — | — | 低频但大 schema，合并收益小破坏大 |

**收益估算**：eap/neat/cce 三个小头 ≈ 3×~50 tok 描述 + 参数 = ~150-200 tok/轮 → 与 D12 判断一致的"小头"。真正大头是 **acc_msm 的 8 action enum + 8 参数 + description**（~300-400 tok）——R2 入口重构顺带瘦身（主入口变 3 参数）反而省更多。

**另一个大头：toolsBlock（system-prompt L90-119）**——13 行工具清单 + MSM 3 步协议 = ~600 tok 固定注入。合并后 toolsBlock 同步精简（工具数变少 + 协议段落改 1 行"msm 直接调"）。

### 3.3 合并后的理想形态（估算）

| 层 | 现在 | 合并后 |
|----|------|--------|
| 工具数 | 13 | ~10-11（或按用户裁决） |
| toolsBlock | 13 行 + 3 步协议 ~600 tok | ~10 行 + 1 行说明 ~350 tok |
| MSM 调用 | 3 步（list→schema→exec） | 1 步（msm name args） |
| 每轮工具头开销 | 13 工具 schema | 减少 ~250-400 tok/轮 |

---

## 4. 待拍板决策点

| # | 决策点 | 选项 | 倾向 |
|---|--------|------|------|
| P1 | **MSM 入口形态** | A) acc_msm 改名 msm + list/exec 合并为 name 自由文本单入口（管理 action 保留/移出） | A（最直觉） |
| P1a | 管理子命令（register/deregister/check/guide/ccc-config/catalog）去向 | a1) 留在 acc_msm action（主入口 action enum 仍 8 项但只 list 管理项） / a2) 独立 `acc_admin` 工具 | a1（少一个工具，管理低频不占认知） |
| P2 | eap/neat/cce 合并 | a) 并成 `acc_knowledge`（section） / b) 并入 acc_kit / c) 保留独立 | 待用户（知识工具调用少，但 cce 语义独立） |
| P3 | session_rebuild 是否并入 session | a) 并入（+rebuild action）/ b) 保留独立 | 待用户（重建关键路径独立性） |
| P4 | 工具描述瘦身 | 是否顺带精简各工具 description（LLM 看到的是 description，不是代码） | 做（与合并互补） |
| P5 | 版本/落地节奏 | 一次性大改 vs 分步（先 R2 MSM 入口，验证后再 R1 合并） | 分步（R2 先——风险隔离 + 快速见效） |
| P6 | osp 对齐 | dsp 是 ACC 工具 spec 参照（osp 按 dsp 对齐）——合并后 osp 侧需同步（跨仓，S138 协作） | 方案定稿后记入 specs/osp 待同步 |

---

## 5. 实施顺序建议

1. **R2-a**：acc_msm 行为重构（name 自由文本 + 缺失→候选 + inspect flag + 管理 action 收缩）——tools/msm.ts + msm-ops.ts + system-prompt toolsBlock 协议段改 1 行 + 测试重写
2. **R2-b**：toolsBlock 精简（工具清单 13→实际数 + 协议说明 1 行）
3. **R1-a**：eap/neat/cce 合并（若拍板）
4. **R1-b**：session_rebuild 并入/保留（若拍板）
5. 全量 test + typecheck + 面板/功能回归 → 用户验证 → 版本发布（D14）

---

## 6. 不做（边界）

- 不做工具名破坏性全改（cc_fs/cc_git/session 等语义清晰的保留——LLM 已学会）
- 不做 MSM 全量内联进 schema enum（CCC 注册 MSM 是动态的，enum 无法静态列出）
- 不做 skiff/acp/weixin 等外部面工具化改造（它们不是 ACC 工具层）
- 工具合并不破坏外部调用面（API/面板/skiff role 白名单按名引用——改名需同步映射）
