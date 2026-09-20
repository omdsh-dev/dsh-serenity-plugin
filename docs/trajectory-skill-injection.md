# 轨迹 skill 声明与注入 —— 接口规格 v1.1

> **本文件的地位**：C1 的**接口真相源**（数据契约 + 注入契约 + 验收清单）。实现见 `src/seams/system-prompt.ts` / `src/trajectory-bound.ts` / `src/trajectory-skills.ts` / `src/skills-discovery.ts`；决策与理由见 SESSION S142 §12 与 `acc-component-relations-review.md` §5.1。
> **日期**：2026-09-15（v1.34.1 代码态，发布待 D14）
> **v1.1（2026-09-20）**：新增 **§2.3 CCC 级声明**（`trajectory.skills`）——owner 令「要求实现我的诉求……注入是**动态注入**就行；**create 先不触发**吧；**skiff 也支持**」。⇒ 声明来源由"轨迹自己"扩为**两条并集**；`create` 仍**不触发**（U6 不动）；**skiff 角色会话纳入**。
> **行号约定（2026-09-20 补充）**：正文引用的 `文件:行号` **只是写档时的就近指引，会随重构漂移**——**判定一律以符号名为准**，行号仅供查找。📌 2026-09-20 已按当前工作树核正一轮（五处：四处行号 + 一处"私有待导出"的过期状态描述）；**这本身是教训**：把行号当契约用，就会周期性地长出假陈述。

---

## 1. 目的与判据

**一句话**：让**轨迹自己声明它要挂哪些 skill**，ACC 在**绑定期间**把那些 skill 全文注入系统提示词。

**判据依据（全部为所有者裁决，勿再翻）**：

| # | 裁决 | 对本规格的作用 |
|---|---|---|
| **Q1** | **「能落 harness 已有原语，就不要自造协议 + 脚本管道」升为明面判据** | 本规格用 `systemPrompt.section`（宿主原语）+ SESSION.md（已有文件），**不新造协议** |
| **Q2** | **废除 SEP**（`session-tool` 脚本钩子） | 删除面见 §5 |
| **Q3** | 注入形态取 **a2：绑定期间 `systemPrompt.section`**（非 a1 一次性） | 见 §3 |
| **Q4** | 声明放 **(a) `SESSION.md` frontmatter** | 见 §2 |

**病灶对照（被替换掉的东西）**：`ACC 定义协议 → CCC 写脚本 → ACC 在生命周期点 spawn 它`。本规格把这条链**整条去掉**。

---

## 2. 数据契约：声明格式

**位置**：轨迹的 `SESSION.md` **最顶部**的 YAML frontmatter。**唯一真相源**——不在别处再声明一次。

```markdown
---
skills: [home-rhetoric, acc-eap]
---

# SESSION: …
```

### 2.1 解析规则（**最小实现，不引 YAML 依赖**）

| 规则 | 内容 |
|---|---|
| **位置** | 文件**第一行必须是 `---`**；到下一个 `---` 行为止是 frontmatter 区。否则视为**无 frontmatter** |
| **键** | 只认 `skills:`。**未知键一律忽略**（向前兼容，不报错） |
| **值形态** | ① 行内数组 `[a, b, c]`｜② 缩进列表（`skills:` 后各起一行 `  - a`）。两种都要支持 |
| **名字规范化** | 去首尾空白；空项丢弃；**保持书写顺序**（注入顺序 = 书写顺序） |
| **缺省** | frontmatter 缺失 / 无 `skills` 键 / 值为空 ⇒ **不注入任何东西**（零配置面，不报错） |
| **重复** | 同名去重（保留首次出现位置） |

### 2.2 边界

- **不解析**除 `skills` 以外任何键的语义（它们可以被 CCC 自由使用，ACC 视而不见）。
- **不改写** frontmatter（ACC 只读）。

### 2.3 CCC 级声明（v1.1 / 插件 v1.44.0）

**位置**：CCC 配置 `.opencode/serenity.json` 的 `trajectory.skills`
（候选路径同 `loadSerenityConfig`：`.opencode/serenity.json` → `.dsh/serenity.json`）。

```json
{ "trajectory": { "skills": ["acc-session", "cce"] } }
```

| 项 | 规格 |
|---|---|
| **语义** | **本 CCC 的每条轨迹都带这些 skill**——在该轨迹**被绑定期间**注入。⚠️ 与轨迹级**走同一条通路、同一套守卫**（`registerTrajectorySkillSection` + `buildTrajectorySkillsSection`），**不是第二套机制** |
| **与轨迹级的关系** | **并集**（`mergeSkillNames`）：**CCC 级在前，轨迹级追加**，同名去重取**首次位置**。**不是二选一**——C1 当初否决"纯 CCC 全局"的理由正是"会**丢掉 per-trajectory**"，并集把两侧都保住：容器给底座，单条轨迹仍可加自己的额外项 |
| **覆盖对象** | ✅ **含 skiff 角色会话**（判据：旁路掉的是 **ACC 身份与纪律**；skill 是**工作资料**，与人格无关 ⇒ 照给） |
| **取值形态** | JSON 数组；非字符串 / 空白项**丢弃**、保持书写顺序。⚠️ `readTrajectorySkills` **不做**安全过滤——那是装配层的职责（§3 🔒），**安全判定只有一个地方做** |
| **失败语义** | 未配置 / 字段缺失 / **配置损坏** ⇒ **空数组** = 无 CCC 级供给（**轨迹级声明照旧生效**）。配置损坏本身由 `loadSerenityConfig` **响亮告警**（不静默） |
| **动态性** | 🔴 **每请求重新读取（不缓存）** ⇒ 改配置或改 frontmatter **即时生效**，无需重新 `use`、无需重启 |
| **与 `create`** | **不触发**（U6：create 刻意不夺绑定）⇒ 注入的门始终是"**存在绑定**" |

**归属（D23）**：**机制在 ACC**（读取 + 合并 + 注入 + 守卫），**声明在 CCC**（本键）——
ACC 代码里不出现任何具体 CCC 或具体 skill 名。

---

## 3. 注入契约

| 项 | 规格 |
|---|---|
| **触发条件** | 该会话**存在轨迹绑定**时——**用 `readLastBound(session)`**（`src/trajectory-bound.ts:288`）。它返回 `SessionBoundRecord = { dirName, mdPath }` ⇒ **`mdPath` 即 `SESSION.md` 的路径，直接可用，不必自拼**。⚠️ `resolveSessionTrajectoryLabel` 只产出**显示用 label**，**不要**用它去拼路径（那是模糊匹配）。<br>**注册门（v1.1 放宽）= 绑定 ∧（CCC 级非空 ∨ 轨迹级非空）**——两条来源任一非空即注册；皆空 ⇒ 不注册（不产生空 section、不产生噪声） |
| **形态** | **per-agent** `ctx.systemPrompt.section({…})`——沿 `skiff-core.ts:329` 的既有先例 |
| **生命周期** | **绑定期间持续存在**（a2）。⇒ 不因对话压缩而消失（这正是 a1 被否的原因） |
| **内容** | **合并后**清单里各 skill 的 `SKILL.md` **全文**（合并顺序 = **CCC 级在前 → 轨迹级追加 → 同名去重**），每段带来源抬头（`=== skill: <name> ===`） |
| **读取来源** | 复用 `src/skills-discovery.ts` 的 **`findSkillMd(root, name)`**（`:60`，**已导出**）——查找顺序 **`.dsh/skills` 优先 → 其次 `.opencode/skills`**，解析为 `<root>/<base>/skills/<name>/SKILL.md`。**不新造发现逻辑**。 |
| **🔒 名字安全（必做）** | 名字来自 **CCC 数据**（frontmatter 或 CCC 配置）⇒ **必须过 `isSafeSkillName(name)`**（`:49`）**才可用于拼路径**，否则是**路径穿越**入口（`../../…`）。**不安全的名字 ⇒ 按"缺失"处理并响亮提示**，绝不拼路径。⚠️ 安全判定**只在装配层做一次**（配置读取层不做，见 §2.3） |
| **找不到某个 skill** | **响亮提示**（section 内写明 `[缺失] <name>（未找到该 skill）`），**不静默** |
| **长度守卫** | **复用已导出的 `truncateContent(content, maxChars)`**（`:116`）。**合并之后**统一设**总长上限**（缺省 **32 KB**，两条来源共享同一上限——不是各给 32 KB），超出截断并在 section 末尾写明"已截断"——防上下文爆炸 |
| **无绑定 / 无声明** | **完全不注册该 section**（不产生空 section，不产生噪声） |

---

## 4. keeper 护栏（Compaction 风险的对策）

**风险**：LOGBOOK COMPACTION 要求 agent **重写** `SESSION.md` ⇒ **frontmatter 可能被抹掉**（声明随之静默消失）。

**护栏**（与 `keeper.ts` 的两条提醒文案同批落地）：在两条 compaction 提醒文案里各加一句——

> **保留文件顶部的 YAML frontmatter 原样**（它承载该轨迹的 skill 声明）。

⇒ 把风险点从"纯纪律依赖"变为"**在唯一会发生重写的时刻提示**"。

**残余风险（诚实边界，记录在案）**：护栏仍是**文案级**（不是机械强制）。若将来出现"声明被抹"的实例，升级方向 = 让 ACC 在 compaction 后**校验 frontmatter 存在性**并对缺失响亮提示（本轮不做）。

---

## 5. 删除面（SEP 废除的连带）

| 对象 | 位置 | 处置 |
|---|---|---|
| `discoverCccHooks()` | `src/tools/trajectory.ts:~232` | **删** |
| `discoverCccSubcommands()` | 同文件 `:~240` | **删** |
| `buildExtHint()` | 同文件 `:~248` | **删** |
| `create-transform` 钩子调用块 | 同文件 `:~425-438` | **删** |
| `hasSessionTool` 检测（仅为 extHint 服务） | 同文件 `:~377-382` | **删**（若无其他消费者） |
| `buildSepGuide()` | 同文件 `:~268` | **删** |
| `container_admin msm guide` 的 SEP 注入分支 | `src/tools/container-admin.ts:~142-145` | **删**（`sessionExtension` 字段一并去） |

> **⚠️ 一处需要显式知悉的连带**：v1.33（§32.9⑤）所有者曾裁「**SEP 内容并进 `container_admin msm guide`**」。**废除 SEP 后该裁决的对象已不存在** ⇒ 并进手册的内容**随之作废**。这不是推翻那条裁决，而是**它的前提消失了**。

---

## 6. 验收清单（单测）

1. 解析：标准行内数组 / 缩进列表 / 无 frontmatter / 空 `skills` / 未知键 / 名字空白与重复
2. 注入：有绑定 + 有声明 ⇒ section 内容含各 skill 全文与抬头｜无绑定 ⇒ 不注册｜有绑定无声明 ⇒ 不注册
3. 缺 skill ⇒ 响亮提示（含 `[缺失]` 标记）
4. 长度守卫：超限 ⇒ 截断 + 明示（复用 `truncateContent`）
5. **🔒 安全**：声明 `skills: [../../etc/passwd]` 之类 ⇒ **被 `isSafeSkillName` 拒** ⇒ 按"缺失"处理 + 提示，且**不得发生任何以该名拼出的 fs 访问**（用桩断言 fs 未被以其名调用）
6. **绑定来源**：`readLastBound` 返回 null ⇒ 不注册；`mdPath` 指向不存在的文件 ⇒ **响亮提示**（不静默、不抛）
7. **回归钉**：SEP 相关符号**不得复活**（删掉的 `discoverCccHooks` / `buildExtHint` / `buildSepGuide` / `create-transform` 调用在 `src/**` 命中数 = **0**）
8. keeper：两条 compaction 提醒文案**均含** "frontmatter" 提示
9. **查找顺序**：同名 skill 同时存在于 `.dsh/skills` 与 `.opencode/skills` ⇒ 取 **`.dsh/skills`**（与 `findSkillMd` 既有语义一致）

**v1.1 追加（CCC 级 / skiff）**：

10. **CCC 级声明**：`trajectory.skills` 非空 + **有绑定** ⇒ **注册并注入**（**即使该轨迹 `SESSION.md` 无任何声明**——这是 v1.1 的新覆盖）
11. **并集与顺序**：CCC 级 + 轨迹级 ⇒ **CCC 在前、轨迹级追加**；同名**去重取首次位置**；两处都有同名 ⇒ 只出现一次
12. **配置失败面**：未配置 / 字段缺失 / **配置损坏** ⇒ 空数组，**不抛**；此时若轨迹级有声明 ⇒ 照旧注入（两条来源互不牵连）
13. **两者皆空**（CCC 无声明 ∧ 轨迹无声明）+ 有绑定 ⇒ **不注册**（零噪声，与 v1.0 行为一致）
14. **skiff**：CCC 级声明 ⇒ **skiff 角色会话同样注册该 section**（判据：旁路的是身份不是资料）

---

## 7. 与相邻构件的关系（防越界）

| 构件 | 关系 |
|---|---|
| `container_trajectory use` | **它只管绑定**（写绑定记录：**宿主存储域** `~/.dsh/storages/serenity_bindings.json` 权威 ＋ CCC `AGENT_SESSIONS/.bindings.json` 兜底）；注入由本规格的 section 承担，**不落 `use`**（a2 的实现选择） |
| 🔴 `container_trajectory create` | **不触发注入**——它**刻意不夺走当前绑定**（U6；防"长会话中途误 `create` 即被夺走"），只写一条 `'create'` 审计记录（note 逐字 `binding unchanged until explicit use`）⇒ **新建轨迹须后续显式 `use`** 才挂上 skill |
| `container_admin msm guide` | SEP 章节移除；MSM 手册其余内容不动 |
| `skiff` 角色提示词 | **同机制的另一消费者**（`skiff-core.ts:329`）；两者互不依赖，各自注册自己的 section。**v1.1**：CCC 级声明**也送达 skiff 会话**（复用同一 `registerTrajectorySkillSection`，不另写一套） |
| `SESSION.md` 体积上限（D48，200 KB） | 本规格**不改变**它；frontmatter 体积可忽略 |
