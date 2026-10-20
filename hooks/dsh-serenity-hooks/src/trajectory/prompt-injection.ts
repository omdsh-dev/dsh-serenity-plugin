/**
 * trajectory/prompt-injection.ts — **轨迹提示词的注入模式**（owner 2026-10-20 令）
 *
 * ## owner 的原话与动机（本模块的全部设计依据）
 *
 * > 「某条角色轨迹目前工作起来，容易多做多想，主要原因我认为还是宁静号原本的提示词注入导致的，
 * >   所以我认为轨迹提示词的设定要容许更高的复杂度，轨迹自身的配置里要有提示词注入选项：
 * >   **默认追加**，可以设定为**替换宁静号系统提示词的约束部分**；同时要确认
 * >   对该提示词和设定的修改可以**热生效**。」
 *
 * ## 两个模式（判据只有这两个，别再开第三个）
 *
 * | 模式 | 行为 |
 * |---|---|
 * | `append`（**缺省**） | 容器与质量各块照常注入，轨迹提示词**追加**在第 ⑧ 位 —— 这是 2026-10-19 起的既有行为，**不变** |
 * | `replace` | 轨迹提示词**取代**指定的「约束块」，并站到它们原来的位置上（紧跟 ACC 身份） |
 *
 * ## 🔴 可替换的块 = 四个「约束块」，**身份块永不在列**
 *
 * `metaphor`（世界模型）／`principles`（信念与边界）／`cce`（连续性纪律）／`eap`（输出质量标准）。
 * **`identity`（`=== Serenity ACC ===`）刻意不可替换**：它回答的是"这条轨迹在哪里工作"，
 * 不是"按什么章法工作"；把它换掉会让同一个容器里的轨迹**彼此不再共享同一套边界**，
 * 而那正是 §5.9b 四层模型里"容器层永不可覆盖"那一条要保的东西。
 * ⚠️ 若以后确实要开放身份块，那是一次**标准级**决定（specs §5.9b），不是加个字符串。
 *
 * ## 三条失败语义（都**响亮**，不静默降级）
 *
 * 1. **未知块名** ⇒ 丢弃该项并指名（"教一个会静默不生效的写法"是最坏的一类文档债）。
 * 2. **`replace` 但没有轨迹提示词** ⇒ **不执行替换**，按 `append` 走并告警 ——
 *    「替换」需要一个替代物；没有替代物的替换 = **静默清空纪律**，那不是本选项的意思。
 * 3. **`append` 却写了 `replaces`** ⇒ `replaces` 不生效并告警（同上：不教空头写法）。
 *
 * 本模块是**纯函数**（不读盘、不打日志）：读盘在调用方（`seams/system-prompt.ts`），
 * 日志也由调用方按 `problems` 打 —— 这样判据可单测，且告警去重只在一个地方。
 */

/** 注入模式的闭集（**新增模式 = 改标准**，不是加一个字符串值） */
export const PROMPT_INJECTION_MODES = ['append', 'replace'] as const
export type PromptInjectionMode = (typeof PROMPT_INJECTION_MODES)[number]

/**
 * 可被轨迹提示词取代的块（**有意排除 `identity`**，见文件头）。
 *
 * ⚠️ 这些 id 必须与 `seams/system-prompt.ts` 里实际的块一一对应；
 * 改块名/加块时**同批改这里**，否则本选项会静默失配（D143 同族）。
 */
export const REPLACEABLE_PROMPT_BLOCKS = ['metaphor', 'principles', 'cce', 'eap'] as const
export type ReplaceablePromptBlock = (typeof REPLACEABLE_PROMPT_BLOCKS)[number]

/** `trajectory.json` 里 `prompt` 段的**原始**形态（校验在本模块做，profile 只管搬运） */
export interface RawPromptInjection {
  injection?: string
  replaces?: string[]
}

/** 一次装配要用的**判决**（纯数据；调用方据此决定注入哪些块、提示词放哪） */
export interface PromptInjectionPlan {
  /** 实际生效的模式（`replace` 的前提不成立时会被降级成 `append`） */
  mode: PromptInjectionMode
  /** `replace` 时**真正**被取代的块（`append` ⇒ 空集） */
  replaces: ReadonlySet<ReplaceablePromptBlock>
  /**
   * 轨迹提示词的位置：
   *  · `constraint` —— 站到被取代块的原位（紧跟身份）
   *  · `late`       —— 第 ⑧ 位（追加形态，既有行为）
   */
  promptPosition: 'constraint' | 'late'
  /** 需要**响亮**告警的原因（空数组 = 一切正常）。调用方负责按轨迹去重后打日志 */
  problems: string[]
}

const DEFAULT_PLAN: PromptInjectionPlan = {
  mode: 'append',
  replaces: new Set(),
  promptPosition: 'late',
  problems: [],
}

/**
 * 判决一次注入（纯函数）。
 *
 * @param raw `trajectory.json` 的 `prompt` 段（原样；`undefined` = 没写 = 缺省追加）
 * @param hasTrajectoryPrompt 该轨迹目录里**是否真有** `PROMPT.md`（调用方查，本函数不做 IO）
 */
export function planPromptInjection(
  raw: RawPromptInjection | undefined,
  hasTrajectoryPrompt: boolean,
): PromptInjectionPlan {
  if (raw === undefined) return DEFAULT_PLAN
  const problems: string[] = []
  const declared = typeof raw.injection === 'string' ? raw.injection.trim() : ''
  if (declared !== '' && !(PROMPT_INJECTION_MODES as readonly string[]).includes(declared)) {
    problems.push(
      `prompt.injection 的取值「${declared}」不是合法模式（只有 ${PROMPT_INJECTION_MODES.join(' / ')}）⇒ 按 append 处理`,
    )
    return { ...DEFAULT_PLAN, problems }
  }
  const mode: PromptInjectionMode = declared === 'replace' ? 'replace' : 'append'

  // ① append：不涉及替换。写了 `replaces` 要指名它不生效（不教空头写法）
  if (mode === 'append') {
    if (raw.replaces !== undefined) {
      problems.push('prompt.replaces 只在 injection="replace" 下生效（当前是 append）⇒ 已忽略')
    }
    return { ...DEFAULT_PLAN, problems }
  }

  // ② replace：必须有替代物，否则等于静默清空纪律
  if (!hasTrajectoryPrompt) {
    problems.push(
      'prompt.injection="replace" 但轨迹目录里没有 PROMPT.md ⇒ 不执行替换（按 append 处理）：'
      + '替换需要一个替代物，否则就是静默清空纪律',
    )
    return { ...DEFAULT_PLAN, problems }
  }

  // ③ 解析 `replaces`：缺省 = 全部四块；显式 `[]` = 一块都不换（用户的明确意图，不再告警）
  const wanted = raw.replaces
  let picked: ReplaceablePromptBlock[]
  if (wanted === undefined) {
    picked = [...REPLACEABLE_PROMPT_BLOCKS]
  } else {
    const invalid = wanted.filter(
      (n) => !(REPLACEABLE_PROMPT_BLOCKS as readonly string[]).includes(n),
    )
    if (invalid.length > 0) {
      problems.push(
        `prompt.replaces 含不可替换的块名：${invalid.join(' / ')}`
        + `（可替换的只有 ${REPLACEABLE_PROMPT_BLOCKS.join(' / ')}；身份块 identity 刻意不可替换）⇒ 已忽略这些项`,
      )
    }
    picked = wanted.filter((n): n is ReplaceablePromptBlock =>
      (REPLACEABLE_PROMPT_BLOCKS as readonly string[]).includes(n),
    )
  }
  const replaces = new Set(picked)
  // 显式 `[]` ⇒ 什么都没换 ⇒ 提示词仍站第 ⑧ 位（没有"被取代块的位置"可站）
  return {
    mode: 'replace',
    replaces,
    promptPosition: replaces.size === 0 ? 'late' : 'constraint',
    problems,
  }
}
