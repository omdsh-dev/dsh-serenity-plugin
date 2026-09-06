# ACC 工具面重构命名方案 v4（FINAL——用户逐项裁决）

**状态**: v1.0 FINAL（用户多轮裁决全部收敛，2026-09-06）
**会话**: S142
**基线**: v1.29.2（60 files / 879 tests）

---

## 1. 用户裁决记录（R↓——每项决策的理由与演进）

| 轮 | 决策点 | 用户裁决 | 理由/演进 |
|----|--------|---------|----------|
| 1 | msm 单入口 | acc_msm → **msm**（name 自由文本默认执行） | "改名 msm 同意" |
| 1 | 命名继承背景 | cc_xx → **container_xx** 方向 | "背景已交代 ACC/CCC，工具命名继承背景，甚至 metaphor" |
| 1 | 知识工具合并 | 合并但名要好（knowledge 不够） | "是**可实践理论注入**，想个好名字" |
| 2 | kit | 不属 container 组（普适随时用） | "kit 里是任何时候都可以使用的工具" |
| 2 | 知识工具 | **praxis**（实践法则） | 从 drawing/blueprint/doctrine/lenses/canon/tenets/praxis 中选 |
| 2 | admin 合并方向 | skiff_admin 及系列 → **container_admin** | "能否合并成 container_admin" |
| 2 | session | **logbook** | session_rebuild 并入其 rebuild 子命令 |
| 3 | admin 范围 | **全含（机务舱）** | skiff 角色 + MSM 注册管理 + 配置 + 手册 |
| 3 | kit 候选 | gauges 可接受但继续找 | bridge 否（"本身也是桥，不合适"——隐喻冲突） |
| 4 | kit 定名 | **dashboard** | "dashboard 呢，你这些词都太容易误会了"——直白不误会的仪表盘 |

---

## 2. 最终工具命名表（13 → 9）

| # | 新工具 | 旧名 | 覆盖 | 隐喻/背景 |
|---|--------|------|------|----------|
| 1 | `container_fs` | cc_fs | 文件系统 15 子命令 | The Hull（容器内操作） |
| 2 | `container_git` | cc_git | git 操作 | The Hull |
| 3 | `container_admin` | skiff_admin + acc_msm 管理面 | Skiff 角色 + MSM 注册/注销/check + CCC 配置读改 + guide/catalog/ccc-config 手册 | The Manifest + Crew（机务舱） |
| 4 | `msm` | acc_msm 执行面 | MSM **单入口执行 + 发现**（name 自由文本） | The Machinery |
| 5 | `praxis` | eap + neat + cce | 可实践理论注入（section: eap/neat/cce） | Engineering Drawings |
| 6 | `logbook` | session + session_rebuild | 会话全周期 + rebuild | The Logbook / Theseus |
| 7 | `dashboard` | acc_kit | health/time/wait（普适观测） | 舰桥仪表盘（随时可看） |
| 8 | `handyman` | handyman | 杂工编排 | Crew Rotation |
| 9 | `localstore` | localstore | 凭据/配置存储 | 保留（敏感清晰） |
| 10 | `autopilot-trajectory` | 同 | 自主巡航 | 保留（产品名） |

> 注：10 个（原 13）——skiff_admin 并入 container_admin 后不再是独立工具；eap/neat/cce 三合一为 praxis；session_rebuild 并入 logbook。工具头从 13 降 10，再加 description 瘦身。

---

## 3. 工具语义分工（E↑ 边界）

```
容器操作层（SHIP）     container_fs（货舱/文件） · container_git（版本/图纸库）
管理面（机务舱）       container_admin（角色/注册表/配置/手册——改什么归它）
执行面（Machinery）    msm（跑机器——注册好的 MSM 直接执行）
观测面（仪表）         dashboard（health/time/wait——随时看，无副作用）
理论面（Drawings）     praxis（eap/neat/cce——注入认知法则）
轨迹面（Voyage）       logbook（会话/重建/归档）
协作面（Crew）         handyman（杂工） · skiff_admin 已入 container_admin
存储面                localstore（凭据）
自主面                autopilot-trajectory
```

---

## 4. msm 单入口设计（本次核心重构）

```
msm(name: string, args: string[], inspect?: boolean)
```

| 场景 | 调用 | 行为 |
|------|------|------|
| 执行已注册 MSM | `msm("ssh-connect", ["status"])` | 直接执行（bun/node 600s 超时 + env + path 守卫） |
| 想用但忘了名 | `msm("ssh", [])` | 未命中 → 返回 top-K 模糊候选（name/description 匹配），LLM 下轮选对 |
| 查用法 | `msm("ssh-connect", [], inspect: true)` | 返回 usage/flags/schema |
| 新到 CCC | `msm()` | 返回精简分类目录（替代全量 list） |
| 失败 | `msm("ssh-connect", ["bad"])` | exit≠0 → 错误 + --help TIP（保留现机制） |

**实现**：tools/msm.ts 参数从 action enum → {name, args, inspect}；execute 内：name 空 → catalog；name 未命中 → 模糊候选；inspect → prepareExec schema；否则 exec。runMsmAsync/prepareExec 全复用。管理 action（register/deregister/check/guide/ccc-config/catalog）移交 container_admin。

---

## 5. container_admin 内容（全含）

| 面 | 子命令 | 来源 |
|----|--------|------|
| Skiff 角色 | guide/validate/apply/list | skiff_admin 原样 |
| MSM 注册表 | register/deregister/check | acc_msm 管理面 |
| CCC 配置 | config 读/写（serenity.json 各段） | 新（原无工具，直接改文件） |
| 手册 | guide/catalog/ccc-config | acc_msm 文档面 |

---

## 6. 实施影响面（改名+合并波及全仓）

| 面 | 影响 |
|----|------|
| src/tools/*.ts | 新工具文件 + 旧合并/删除 |
| index.ts 注册 | 10 工具 |
| system-prompt toolsBlock/identity/operational boundaries | "use acc_msm"→"use msm" 等引用改 |
| guards/keeper/skiff 白名单/session 引用 | 工具名匹配 |
| 测试 | 大量断言工具名同步 |
| home-serenity serenity.json skiff.roles.msms | 白名单名改 |
| mech-registry 注册 MSM usage 内 acc_msm 引用 | 文档同步 |
| README/SKILL/CHANGELOG | 同步 |
| osp 对齐 | 跨仓（dsp 改后 osp 按 spec 同步——P6 待办） |

---

## 7. 兼容策略（重要）

改名是破坏性变更——**已运行的 CCC 的 skill 文档/会话/SESSION.md 里大量引用旧工具名**（cc_fs/session/acc_msm/acc_kit/eap...）。选项：
- **A 硬切**：直接改名，文档同步全做，旧名失效（干净但过渡期 LLM 在旧会话会调错）
- **B 双名过渡**：新旧名都注册（alias），v1 版本双名共存，文档/白名单渐进迁移后择机弃旧
- 倾向 **B**（alias 层：旧名工具注册为转发到新名；成本=注册 3-4 个薄转发工具，但工具面不减反增——违背目标！）

**修正倾向**：命名重构**硬切** + 系统提示词 toolsBlock 明示"工具已改名"对照表（旧→新），LLM 每轮看到即学。文档同步靠本 CCC 维护。旧会话的历史引用会因工具不存在而报错 → LLM 看 toolsBlock 即知新名。**硬切（选项 A）更符合"工具面越小越好"目标**——alias 会使工具面膨胀。

---

## 8. 待最终确认

1. 工具命名表（§2）是否照此实施
2. 兼容策略 A（硬切）还是 B（双名过渡）
3. 版本节奏：全量一次改（v1.30.0 大版）？涉及所有 CCC 的 skill 引用同步（pangu/tiangong 等也有 ACC）
