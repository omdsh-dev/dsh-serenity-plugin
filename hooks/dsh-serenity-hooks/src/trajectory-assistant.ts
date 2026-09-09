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
 * 结算视图归 trajectory-assistant。当前 close/archive 无复盘摘要 → 机制
 * 延后，仅留 onSettlement 导出 seam（OP-1，无调用者）。
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
 * rebuild 交接区块标题（v1.31.1，S142 用户需求）。
 *
 * 用途：rebuild 提醒要求模型把**当前手头事项**写到 SESSION.md **末尾**的这个小标题之下；
 * rebuild 锚点随后要求重建后的自己去读这一段并处理。两侧引用**同一个常量**——
 * 标题一旦漂移，读侧就找不到写侧写的东西（单一真相源）。
 *
 * 形态（用户拍板 Q2）：**固定英文标题行**（不是 HTML 注释锚）——人读友好；ACC 写死英文，
 * 因为 SESSION.md 的正文语言归 CCC，但两侧的**机械锚点**必须逐字一致。
 */
export const IN_FLIGHT_HEADING = '## In-flight (rebuild handover)'

// ── 风格门面（D8：仅 plain 与 metaphor；无 game 档）──

/** 风格档位：plain（默认，精确文本）/ metaphor（借星舰词——产品隐喻非游戏词） */
export type TrajectoryStyle = 'plain' | 'metaphor'

/** 星舰词变体（仅在 style=metaphor 时替换可见前缀；正文不动） */
const METAPHOR_PREFIX: Record<keyof typeof EVENT_LABEL, string> = {
  checkpoint: 'CHECKPOINT',
  limit: 'CONTEXT LIMIT',
  limitMandatory: 'CONTEXT LIMIT · MANDATORY',
  rebuild: 'REBUILD',
  guard: 'BOUNDARY GUARD',
  compaction: 'LOGBOOK COMPACTION',
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

/**
 * 结算 seam（OP-1/D6）：未来标准 SESSION 复盘仪式接入点。当前无调用者，
 * 仅导出契约：onSettlement(cb) 在"工作完成且被用户认可"时触发——该信号
 * 尚无可靠自动检测（D2 用户拍板记录为未解问题），实现留待仪式落地。
 */
export function onSettlement(_cb: (sessionId: string) => void): void {
  /* 预留：结算触发器尚未实现（OP-1） */
}
