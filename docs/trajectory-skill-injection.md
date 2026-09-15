# 轨迹 skill 声明与注入 —— 接口规格 v1.0

> **本文件的地位**：C1 的**接口真相源**（数据契约 + 注入契约 + 验收清单）。实现见 `src/seams/system-prompt.ts` / `src/trajectory-bound.ts` / `src/skills-discovery.ts`；决策与理由见 SESSION S142 §12 与 `acc-component-relations-review.md` §5.1。
> **日期**：2026-09-15（v1.34.1 代码态，发布待 D14）

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

---

## 3. 注入契约

| 项 | 规格 |
|---|---|
| **触发条件** | 该会话**存在轨迹绑定**时——**用 `readLastBound(session)`**（`src/trajectory-bound.ts:115`）。它返回 `SessionBoundRecord = { dirName, mdPath }` ⇒ **`mdPath` 即 `SESSION.md` 的路径，直接可用，不必自拼**。⚠️ `resolveSessionTrajectoryLabel` 只产出**显示用 label**，**不要**用它去拼路径（那是模糊匹配）。 |
| **形态** | **per-agent** `ctx.systemPrompt.section({…})`——沿 `skiff-core.ts:329` 的既有先例 |
| **生命周期** | **绑定期间持续存在**（a2）。⇒ 不因对话压缩而消失（这正是 a1 被否的原因） |
| **内容** | 所列 skill 的 `SKILL.md` **全文**，按声明顺序拼接，每段带来源抬头（`=== skill: <name> ===`） |
| **读取来源** | 复用 `src/skills-discovery.ts` 的 **`findSkillMd(root, name)`**（`:52`）——查找顺序 **`.dsh/skills` 优先 → 其次 `.opencode/skills`**，解析为 `<root>/<base>/skills/<name>/SKILL.md`。⚠️ 它**目前是私有的**⇒ 需**导出**（或加一个同语义的导出包装）。**不新造发现逻辑**。 |
| **🔒 名字安全（必做）** | 名字来自 **CCC 数据**（frontmatter）⇒ **必须过 `isSafeSkillName(name)`**（`:45`）**才可用于拼路径**，否则是**路径穿越**入口（`../../…`）。**不安全的名字 ⇒ 按"缺失"处理并响亮提示**，绝不拼路径。 |
| **找不到某个 skill** | **响亮提示**（section 内写明 `[缺失] <name>（未找到该 skill）`），**不静默** |
| **长度守卫** | **复用已导出的 `truncateContent(content, maxChars)`**（`:108`）。全文注入设**总长上限**（缺省 **32 KB**），超出截断并在 section 末尾写明"已截断"——防上下文爆炸 |
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

---

## 7. 与相邻构件的关系（防越界）

| 构件 | 关系 |
|---|---|
| `container_trajectory use` | **它只管绑定**（写 `.bindings.json`）；注入由本规格的 section 承担，**不落 `use`**（a2 的实现选择） |
| `container_admin msm guide` | SEP 章节移除；MSM 手册其余内容不动 |
| `skiff` 角色提示词 | **同机制的另一消费者**（`skiff-core.ts:329`）；两者互不依赖，各自注册自己的 section |
| `SESSION.md` 体积上限（D48，200 KB） | 本规格**不改变**它；frontmatter 体积可忽略 |
