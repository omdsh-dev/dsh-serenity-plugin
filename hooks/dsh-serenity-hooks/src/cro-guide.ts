/**
 * cro-guide.ts — CRO 编写指南（**ACC 内置**，S142 §7.8，2026-09-19）
 *
 * ## 为什么指南在 ACC 而不在 CCC（所有者令）
 *
 * 所有者 2026-09-19：「**ACC 内置，整个机制属于 ACC，CCC 是用户**」。
 * ⇒ 契约 / 调度 / 执行 / 状态暴露 / 容错 / **编写指南** 全在 ACC；
 *   CCC（用户）只负责**写那段程序**。
 *
 * ## 🔴 单真相源纪律（本文件的核心约束）
 *
 * 指南**不复制**契约条款，且**样例快照是"派生"而非"手抄"**：
 * {@link CRO_SAMPLE_SNAPSHOT} 由 {@link buildCroSnapshot} **真正装配**出来 ⇒
 * **schema 一变，样例自动跟着变**，不存在"文档里的样例过期"这一失效模式。
 * （本容器栽过多次"第二真相源"，此处用代码结构而不是纪律去防它。）
 *
 * ## 所有者对本指南的两条明示要求（2026-09-19）
 *
 * 1. 🔴 **必须备注：CRO 程序是可自测的；测试通过再把文件名改成正式名**；
 * 2. 🔴 **要一并给出测试用的参数**。
 */

import { buildCroSnapshot, type CroSnapshotInput } from './cro.js'

/**
 * 样例快照输入 —— **代表性数据**（不是真实某条轨迹的现状）。
 *
 * 取值刻意让它能演示所有者举的 S185 场景（天亮/有人/非高峰 + 已在干活 + 日志过大）。
 */
export const CRO_SAMPLE_SNAPSHOT_INPUT: CroSnapshotInput = {
  dirName: '2026-09-13--S185--desk-camera',
  cccRoot: '/home/yh/home/home-serenity',
  nowMs: 1_789_800_000_000,
  sessionMdPath: '/home/yh/home/home-serenity/AGENT_SESSIONS/2026-09-13--S185--desk-camera/SESSION.md',
  sessionMdBytes: 182_000,
  sessionMdMtimeMs: 1_789_799_000_000,
  references: [
    { name: 'campaign-100.md', bytes: 41_200, mtimeMs: 1_789_790_000_000 },
    { name: 'auto-exposure.md', bytes: 8_400, mtimeMs: 1_789_700_000_000 },
  ],
  boundSessionIds: ['session-adccc461-9f32-4d9a-a688-9da81fa1ca35'],
  liveSessionIds: ['session-adccc461-9f32-4d9a-a688-9da81fa1ca35'],
  runningSessionIds: [],
  pendingWakes: [{ id: 'w-20260919-0900-aaaa', at: '2026-09-19T09:30:00+08:00', createdAt: '2026-09-19T07:00:00+08:00', createdBy: 'S185' }],
  scheduler: { armed: true, enabled: true, ticks: 128, lastSkipReason: null },
}

/**
 * 🔴 **样例快照（测试参数）** —— **由真实装配器生成**，故**永不与 schema 漂移**。
 *
 * 用途：写 CRO 程序时把它喂给你的程序做自测（见指南 §8「自测」）。
 * @returns 缩进过的快照 JSON 文本
 */
export function renderCroSampleSnapshot(): string {
  return JSON.stringify(buildCroSnapshot(CRO_SAMPLE_SNAPSHOT_INPUT), null, 2)
}

/** 正式入口文件名（写死于此，供指南与实现共用同一常量来源） */
export { CRO_FILENAME, CRO_TIMEOUT_MS } from './cro.js'

/**
 * CRO 编写指南正文（ACC 内置手册；由工具的 guide 动作输出）。
 *
 * 结构照既有 guide 惯例（`MSM_GUIDE` / `handyman(guide=true)`）：
 * 用途 → 位置 → 我给什么 → 你给我什么 → 骨架 → 常见模式 → 坑 → **自测**。
 */
export const CRO_GUIDE = `CRO（Continuous Re-Occurrence · 持续再发生）编写指南

## 0. 这是什么（一句话）
让一条轨迹**自己带一段程序**，由 ACC 在每次检查时跑它，
**由这段程序决定「现在该不该叫我、叫我的时候说什么」**。

今天的唤醒只认时间（"3 点叫我"）；CRO 让它认**情况**（"天亮且家里有人才叫我"）。

## 1. 它在系统里的位置
· **机制属 ACC**（本指南、契约、调度、执行、容错都在 ACC）
· **程序属 CCC**（你写的那段 TS，放在**你自己轨迹的目录**里）
· **执行者** = ACC 的唤醒调度器（每 5 分钟一次 tick）

## 2. 文件放哪、叫什么
  <CCC 根>/AGENT_SESSIONS/<轨迹目录>/continuous-re-occurrence.ts

🔴 **文件名必须全写**（不许用缩写）。
🔴 **程序只有一个**：**文件在 = 启用；文件不在 = 禁用**。
   —— 没有开关、没有注册表、没有 enabled 字段。

## 3. 我给你什么（输入）
ACC 把这条轨迹的状态做成一个 **JSON 快照**，从 **stdin** 喂给你的程序。
字段分四组：identity（身份）/ time（时间）/ body（轨迹身体）/ binding + scheduling（绑定与调度）。

⚠️ **给的是"快照"，不是"无限能力"**：ACC 看不见的东西（比如"你上次判了什么"）
   **物理上给不了**（那是你进程里的内存）。那类状态**归你自己**——
   写在你自己的轨迹目录里（例如一个 state.json），自己读自己写。

## 4. 你给我什么（输出）
向 **stdout** 写 **一行 JSON**：

  { "wake": true,  "prompt": "唤起时的提示词", "reason": "判定理由（可选）" }
  { "wake": false }                                  // 不唤起

· \`wake\` 缺省 / false ⇒ **不唤起**（**这是常态**，缺省是"不打扰"）
· \`wake: true\` 时 \`prompt\` **必须非空**（否则视为非法，本轮跳过、不投递空消息）
· 🔴 \`reason\` **强烈建议填**：见 §7 坑 3

## 5. 骨架

  // continuous-re-occurrence.ts
  let raw = ''
  process.stdin.on('data', (d) => { raw += d })
  process.stdin.on('end', () => {
    const s = JSON.parse(raw)                 // 轨迹状态快照
    // ... 在这里写你的判定 ...
    process.stdout.write(JSON.stringify({ wake: false }))
  })

例（所有者举的 S185 那类情形，仅示意）：

  const tooBig = (s.body.sessionMdBytes ?? 0) > 150_000
  const busy   = s.binding.runningSessionIds.length > 0
  if (busy) return out({ wake: false, reason: '已在干活' })
  if (tooBig) return out({ wake: true, prompt: '你的 SESSION.md 已很大，请先压缩再继续。', reason: '日志超限' })

## 6. 常见模式
· **环境谓词**（天亮/有人/非高峰）：ACC 给不了这些 —— **你自己去拿**（查设备、读传感器、
  查你自己的程序）。这就是"程序和程序可以互相访问"的用法。快照里的 \`time\` 只是给你一个时间锚。
· **已在工作就别叫**：看 \`binding.runningSessionIds\`（非空 = 有载体正在跑轮次）。
  ⚠️ 注意它和 \`liveSessionIds\` 不同：**会话活着 ≠ 在干活**。
· **要求它先自整理**：不需要新机制 —— **就是 \`prompt\` 的一种写法**
  （如"你的 SESSION.md 已 180 KB，请先压缩再继续"）。
· **次数上限 / 连续 N 次才叫**：ACC 不给你计数器（**给不了**）⇒ **自己目录里写状态文件**。

## 7. 坑
1. **不许阻塞等输入**：你只从 stdin 拿一次快照，不要在程序里 readline / prompt 等用户输入。
2. **硬超时 60 秒**：超时会被 SIGKILL、本轮跳过。外部查询请自己设更短的超时。
3. 🔴 **一定要填 \`reason\`**：改成程序判定之后，"当时为什么叫了"**不再能从时间表重建**——
   原因在**你的程序肚子里**（可能有随机、可能看了外部数据）。不写 reason，
   以后出事**无法复现**。这条不是形式主义，是**可重建性**的要求。
4. **失败只影响你自己**：程序报错/超时/输出非法 ⇒ 记一行 + **跳过本轮**，
   **绝不会影响** \`send-later\` / \`send-now\` 等既有机制。所以你可以放心试。
5. 🔴 **不要提前用正式文件名**：见 §8。

## 8. 🔴 自测（**测试通过再把文件名改成正式的**）
CRO 程序**是可以自测的** —— 因为它只做一件事：**吃一份快照 JSON，吐一行决策 JSON**。
（纯函数式的边界 ⇒ 不需要真机、不需要等 5 分钟 tick、不需要调度器。）

### 8.1 推荐流程：**用开发名写，绿了再改名**
因为「**文件在 = 启用**」没有开关，**改名这个动作本身就是上线动作**：

  1. 先用**开发名**写（如 \`continuous-re-occurrence.dev.ts\`）
     —— 开发名**不会**被 ACC 启用（启用只认正式名 exact match），可以放心留一半
  2. 配一个自测（如 \`continuous-re-occurrence.dev.test.ts\`），喂几份快照断言输出
  3. **全部绿了** ⇒ 改名为 \`continuous-re-occurrence.ts\` ⇒ **这一刻才生效**

⚠️ 若你跳过自测直接上正式名：半成品会被当成生效程序，**报错并跳过本轮**（不会搞坏系统，
  但那条轨迹的 CRO 就是空转的）。**报错是安全网，不是工作流。**

### 8.2 手工试跑（最快的一条路）
把样例快照喂给你的程序，看它吐什么：

  # 用开发名试跑（推荐 bun；node 需能跑 TS）
  bun continuous-re-occurrence.dev.ts < sample-snapshot.json

  # 或直接管道
  echo '<一行快照 JSON>' | bun continuous-re-occurrence.dev.ts

### 8.3 测试用的参数
**样例快照 = 由 ACC 的装配器实时生成**（故**永不与 schema 漂移**，schema 一变它跟着变）。
取法：**运行本指南所在工具的 guide 动作**，或用同一机制导出；内容是：

${'```json'}
${renderCroSampleSnapshot()}
${'```'}

该样例刻意覆盖了：
· \`body.sessionMdBytes\` = 182000（**日志过大**那一档）
· \`binding.runningSessionIds\` = []（**空闲**；把它填成一个 id 就能测"已在干活"分支）
· \`scheduling.pendingWakes\` 非空（**已有待办唤醒**）
· 无 S 前缀格式的情形请自己造 \`dirName\`（\`identity.code\` 会是空串——那是**正常**的，
  编号不是固定格式，硬锚永远是 \`dirName\`）

### 8.4 自测该断言什么（建议清单）
· 快照缺字段（\`null\` 体积）时不崩 —— 用 \`?? 0\` 之类兜底
· \`wake:true\` 时 \`prompt\` **确实非空**
· "已在干活"分支：\`runningSessionIds\` 非空 ⇒ \`wake:false\`
· 同一个程序**连跑两次**给同样输入 ⇒ 同样输出（除非你刻意用了随机/外部状态，
  那就必须写进 \`reason\`）

## 9. 一句话
**吃一份快照，吐一行决策。先自测，绿了再改名。**
`

/** 供工具动作取用（与 `MSM_GUIDE` 同款出口） */
export function croGuidePayload(): { guide: string } {
  return { guide: CRO_GUIDE }
}
