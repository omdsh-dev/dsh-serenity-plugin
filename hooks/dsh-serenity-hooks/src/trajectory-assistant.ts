/**
 * trajectory-assistant.ts — 关卡化注入的统一命名与风格门面（v0.3，S142）
 *
 * 概念（用户拍板 2026-09-05）：dsp 全部"过程中动态提示注入"统一命名为
 * trajectory-assistant（轨迹助航员）。关卡设计思想塑造**结构与时机**
 * （何时/何地注入），**不用于提示词用词**（D8 词法原则）——纯游戏黑话
 * （BOSS/XP/level-up）禁止出现在提示词文本；CHECKPOINT/LIMIT/TUTORIAL 等
 * 跨领域自然通用词允许。
 *
 * 本模块 = token 常量 + level-event 词汇表的**单一真相源**（避免前缀散落
 * 各文件字符串字面量）+ 风格门面（plain 默认 / metaphor 星舰变体）。
 * 仅当 style=metaphor 时前缀包装措辞变化；可行动正文不变 → 零行为漂移。
 *
 * 设计简写（L0 环境 / L1 教程 / L2 目标 / L3 检查点 / L4 极限 / L5 守卫 /
 * L6 结算）仅在本模块注释与内部文档出现，永不浮现在提示词文本。
 *
 * 结算（settlement）挂点：D6 用户拍板——若 CCC 有标准 SESSION 复盘仪式，
 * 结算视图归 trajectory-assistant。当前 close/archive 无复盘摘要 ⇒ 机制延后。
 * 🔴 2026-09-25（S142 分批清死代码·第 1 批）：原先那个 `onSettlement(cb)` **空 seam 已删**
 * （零调用者、无触发器、空实现）——仪式真落地时按当时的信号重新设计，**不再靠空占位**。
 */

// ── level-event 词汇表（内部设计简写 → 可见前缀用词）──

/** 可见提示词前缀用词（跨领域自然词，D8：无游戏黑话） */
export const EVENT_LABEL = {
  /** 计分同步提醒（原 TRAJECTORY-STEWARD） */
  checkpoint: 'CHECKPOINT',
  /** 上下文极限重建提醒（原 TRAJECTORY；LIMIT 替代被否的 BOSS——自然词） */
  limit: 'LIMIT',
  /** 极限强制升级（原 TRAJECTORY-ESCALATED） */
  limitMandatory: 'LIMIT · MANDATORY',
  /** 重建锚点头部（原 TRAJECTORY-REBUILD） */
  rebuild: 'REBUILD',
  /** 敏感输出边界守卫（原 SERENITY OUTPUT GUARD） */
  guard: 'BOUNDARY GUARD',
  /** SESSION.md 体积超限重写提醒（v1.31.1，S142 用户需求） */
  compaction: 'LOGBOOK COMPACTION',
  /** **交界便签（REBUILD-TODO.md）体积超限清理提醒**（v1.49.0，owner 2026-09-26 需求）。
   *
   *  🔴 **刻意与 `compaction` 分开**：那条要求"**重写 SESSION.md 并保留 EAP 骨架**"，
   *  本条只要求"**清理便签**"——共用一个 token 会让模型误以为要动 SESSION.md。 */
  scratchPrune: 'SCRATCH PRUNE',
} as const

/** 家族标识（所有动态注入统一前缀） */
export const ASSISTANT_PREFIX = 'TRAJECTORY-ASSISTANT'

/** 完整 token：`[TRAJECTORY-ASSISTANT · <LABEL>]` */
export function eventToken(event: keyof typeof EVENT_LABEL): string {
  return `[${ASSISTANT_PREFIX} · ${EVENT_LABEL[event]}]`
}

/** ACK 确认码前缀（recorded/skipped 语义不变，仅家族名更新） */
export const ACK_PREFIX = `${ASSISTANT_PREFIX}-recorded`
export const ACK_SKIP_PREFIX = `${ASSISTANT_PREFIX}-skipped`

/**
 * rebuild 交界便签的**文件名**（v1.49.0；owner 2026-09-26 需求）。
 *
 * ## 它取代了什么（owner 原话：*"砍掉 in-flight，这正是目的"*）
 * v1.31.1 的交界协议要求把手头事项写进 **SESSION.md 末尾**的 `## In-flight (rebuild handover)` 段。
 * 实测的代价（S142 自身取证）：In-flight 段曾积 **12 块**（含多份**已被取代**的交接），
 * 而 SESSION.md 是**有格式义务**的持久文件（7 段固定 ＋ 粒度受 EAP 约束）⇒
 * ① 持久文件被临时物污染 ② 每次整理都要付"压缩＋归档＋保真"三件套（该文件曾达 292 KB）。
 *
 * ⇒ 分家：**只用一次的交界材料**写进这份**临时便签**（无格式义务、无留档义务、可随时丢弃）。
 *
 * ## 🔴 三处引用同一常量（单一真相源）
 * **写侧** = `seams/keeper.ts` 的 `rebuildReminderText()`｜**读侧** = `rebuild.ts` 的重建锚点｜
 * **体积提醒** = `seams/keeper.ts` 的 `rebuildTodoReminderText()`。
 * 文件名一旦漂移，写侧写的东西读侧就找不到 —— **且没有任何机械信号会报警**。
 *
 * 🔴 **不得改名**（owner 已具名）。形态 = **固定文件名**（人读友好；比照旧 IN_FLIGHT_HEADING 的取舍）。
 */
export const REBUILD_TODO_FILENAME = 'REBUILD-TODO.md'

// ── 风格门面（D8：仅 plain 与 metaphor；无 game 档）──

/** 风格档位：plain（默认，精确文本）/ metaphor（借星舰词——产品隐喻非游戏词） */
type TrajectoryStyle = 'plain' | 'metaphor'

/** 星舰词变体（仅在 style=metaphor 时替换可见前缀；正文不动） */
const METAPHOR_PREFIX: Record<keyof typeof EVENT_LABEL, string> = {
  checkpoint: 'CHECKPOINT',
  limit: 'CONTEXT LIMIT',
  limitMandatory: 'CONTEXT LIMIT · MANDATORY',
  rebuild: 'REBUILD',
  guard: 'BOUNDARY GUARD',
  compaction: 'LOGBOOK COMPACTION',
  scratchPrune: 'SCRATCH PRUNE',
}

/**
 * 按风格生成前缀 token。plain = eventToken()（原样）；metaphor 仅当有
 * 星舰化变体时替换用词（当前等价保留——星舰词库隐喻域的既有措辞即
 * "context limit/deck check" 类，不强制替换；扩展点留给未来实验）。
 */
export function styledToken(event: keyof typeof EVENT_LABEL, style: TrajectoryStyle = 'plain'): string {
  if (style === 'metaphor' && METAPHOR_PREFIX[event]) {
    return `[${ASSISTANT_PREFIX} · ${METAPHOR_PREFIX[event]}]`
  }
  return eventToken(event)
}

