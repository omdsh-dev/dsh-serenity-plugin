/**
 * trajectory.ts — `cognitive_trajectory` 真实 DSH 工具定义（defineTool）
 *
 * v1.33（S142 §32 用户裁决）：由 `logbook` **更名并收敛为 `trajectory`**（v1.34：工具名再硬切为
 * `container_trajectory`，无别名）——cognitive trajectory 是一等概念
 * （SESSION.md 是它的持久身体），本工具管它的**载体生命周期 + 一次性时间安排**。
 * 动作面现行 **8 个**：list / show / create / use / rebuild / **`send-now`** / **`send-later`** / **`cro-guide`**。
 * 🔴 2026-09-16（所有者裁决）：**第 7 个动作 `send-message`（即时投递）**
 *    ——与 `wake-later` 共用取用通路，差别只在**时刻**（现在 vs 未来）与**回执**（有 vs 无）；
 *    实现落在 `wake/scheduler.ts` 的 `sendToTrajectory()`（"怎么把一句话送到一条轨迹"是调度器的知识）。
 *    设计稿 = `docs/cognitive-trajectory-send-message-design.md`（v0.2 定稿）。
 * 🔴 2026-09-17（所有者裁决 · **命名 A 案**）：**两个投递动作更名** —— `wake-later` → **`send-later`**、
 *    `send-message` → **`send-now`**。判据（R↓）：两者本是**同一条投递通路**（同取用机制 / 同载荷 /
 *    同落点语义），只差**时刻**；而「唤醒（冷载入）」是**两条路径共有**的属性，不配做区分
 *    ⇒ 族名取共享词干 **`send-`**、轴取 **`-now` / `-later`**（同构）。**硬切无别名**（D46/D61 先例）；
 *    机制层词汇（`wake-registry.json` / `w-*` id / `WakeEntry` / 调度器名 / 配置键 `wakeSchedulerEnabled`）
 *    **一律不动** —— 接受"机制叫 wake、动作叫 send-later"的**分层命名**（二者本是两层）。
 *    🔴 **2026-09-21 补注（不改写历史，只标失效时点）**：上句里那个**配置键 `wakeSchedulerEnabled`
 *    已随后续所有者令被砍**（唤醒调度器无闸、恒武装）⇒ 该词从"机制层词汇"里**自然减员**；
 *    现行总闸键是 CRO 阶段的 **`croEnabled`**。
 *
 * 与旧面（logbook 11 动作 + trajectory 12 动作）的对应（用户逐条裁决，R↓）：
 *   · `summary` → 并入 `list`（全库统计随清单一起给）
 *   · `health`/`qa` → **淘汰**：其判据是"旧六节模板合规"，而 ACC 层的编写标准已升级为 EAP
 *     ⇒ 只把**不依赖模板**的两项并入 `use`：空壳 / 长期无活动（**提示，不阻断**）
 *   · `close`/`archive` → 删：`completed` 本就由 SESSION.md 的 `[x]` 推导（不靠 close 写）；
 *     归档能力由 `container_fs mv → _archived/` 承担
 *   · `hook-develop-guide` → **淘汰**（v1.34.1：SEP 整体废除——「能落 harness 已有原语，
 *     就不要自造协议 + 脚本管道」；轨迹挂哪些 skill 改由 SESSION.md frontmatter 声明 +
 *     `systemPrompt.section` 注入，见 `docs/cognitive-trajectory-skill-injection.md`）
 *   · autopilot 面（all/init/random/diag/doc/check/status/guide）→ `container_admin` 的 autopilot 域
 *   · `wake-add`/`wake-list`/`wake-rm` → **`wake-later`**（v1.33 收敛；**2026-09-17 更名 `send-later`**）
 *   · 2026-09-20（CRO 落地）：新增 **`cro-guide`** —— CRO 编写指南的出口（纯读）。
 *     判据（R↓，为何在此而不新增域）：CRO 程序放在**轨迹自己的目录**里 ⇒ "怎么写它"是
 *     **逐轨迹**的知识，而管轨迹的人正是用本工具的人（设计 §9-5「既有 guide 位置，不新增域」）。
 *
 * 保留 osp 对齐语义的部分：create 的 `--desc`/`--issue` 二选一、use 激活即重命名 dsh 会话标题（F3）。
 * 活跃会话跟踪：内存 Map（按 dsh 会话 id 隔离）+ 从 events 恢复（S134）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from 'cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { hostService } from '../host/access.js'
import type { JsonValue } from '../kernel/json.js'
import { join } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { findSerenityRoot } from '../kernel/ccc.js'
import { agentCwdFor, cccRootForExec, NO_CCC_FROM_AGENT_CWD } from '../kernel/ccc-roots.js'
import { appendBound, pruneMissingBindings, readLastBound, resolveSessionCognitiveTrajectoryLabel, supersedeOtherBindings } from '../trajectory/bound.js'
import { hasSessionLogById, sessionsRootDir } from '../trajectory/cleanup.js'
import { addWake, WAKE_CATCH_UP_MS, type WakeEntry } from '../wake/registry.js'
import { sendToCognitiveTrajectory } from '../wake/scheduler.js'
import { CRO_GUIDE } from '../wake/cro-guide.js'
import {
  listSessions,
  showSession,
  createSession,
  useSession,
  findSession,
  archiveSession,
  parseTrajectoryCode,
  readTrajectoryUid,
  UID_FILENAME,
  COGNITIVE_TRAJECTORY_ACTIONS,
  DEFAULT_SESSION_SCOPE,
  getActiveSessionInfo,
  namingTitleFor,
  summarize,
  type ActiveSessionInfo,
  type CreateSessionResult,
} from '../trajectory/core.js'

/** 当前 dsh 会话 id（use/close 按会话隔离的 scope） */
function agentScope(exec: { agent?: { session?: { id?: string } } }): string {
  return exec.agent?.session?.id ?? DEFAULT_SESSION_SCOPE
}

/**
 * 当前 dsh 会话对象（绑定的读写都要用它）；无 `append` → null。
 *
 * 🔴 **2026-09-21 修 F3（原实现是 F1 的上游成因）**：本函数原先把会话**削成只带 `append` 的包装对象**。
 * 但 `appendBound` / `readLastBound` 定位"这是哪条会话、哪个 CCC 根"靠的是
 * `session.header.id` 与 `session.header.cwd`（见 `trajectory-bound.ts` 的 `sessionHeader`）——
 * **包装对象没有 header** ⇒ ① `appendBound` **在读 id 处直接 `return false`**（静默 no-op）
 * ⇒ **`use` 这条路从来不写当前载体的绑定**（实证吻合：S142 §7.4 记录"当前载体的绑定**直到
 * 17:05 那次 rebuild 才写入**"）② `readLastBound` 同样恒 null ⇒ G1 切换守卫只能靠内存回退。
 * ⇒ 改为**返回原会话对象**（只增字段、不削字段）：只用 `append` 的调用点行为不变，
 *   而绑定读写从此拿得到 header。
 */
function agentDshSession(
  exec: { agent?: { session?: unknown } },
): { append: (type: unknown, data: unknown) => unknown; header?: unknown } | null {
  const s = exec.agent?.session as { append?: unknown } | undefined
  return s && typeof s.append === 'function'
    ? (s as { append: (type: unknown, data: unknown) => unknown })
    : null
}

/**
 * 当前绑定的权威 dirName（优先持久化 bound——防内存被误 use 污染；无 bound 回退内存 active）。
 * 供 G1 守卫对比目标会话是否切换。
 */
function currentBoundDirName(exec: { agent?: { session?: unknown } }, scope: string): string | null {
  const dsh = agentDshSession(exec)
  const bound = dsh ? readLastBound(dsh) : null
  if (bound) return bound.dirName
  return getActiveSessionInfo(scope)?.dirName ?? null
}

// ── v1.21 F3：use 后重命名当前 dsh 会话（纯逻辑，可单测）──
// v1.27.1：**永远开启**（S142 用户拍板"开关下掉，永远开启"）——命名是固定行为，
// 移除 naming.enabled 简单配置开关；仅剩 sessionTitle 服务可用性守卫。

interface RenameOnUseDeps {
  /** sessionTitle 服务可用性 */
  sessionTitleAvailable: boolean
}

// 🔴 2026-09-25（S142 工程化程序第 ④ 项·第 1 步）：`sanitizeSessionSummary` 与 `namingTitleFor`
// **已下沉到 L1 的 `trajectory-ops.ts`** —— 解 L1→L3 上行边 ＋ `trajectory/rebuild.ts` ⇄ 本文件的依赖环
// （证据＝模块图 §3-6）。此处只保留**用**它们的门面（`renameDshSessionOnUse` 等）。

/**
 * use 激活宁静号会话后，把当前 dsh 会话重命名为命名标题（`S###-日期[-概括]`）。
 * v1.27.1：**永远开启**（不再有 naming.enabled 门控）——仅 sessionTitle 服务
 * 存在性守卫；失败不静默——返回结果对象而非 null（v1.22.9），调用方决定可见性。
 *
 * 需求②（S142 用户拍板）：summary 参数（≤20 字概括）→ 标题带概括；编号日期固定派生。
 *
 * v1.23.2 修复（this 绑定）：第三参从**解构的裸 rename 函数**改为**整个
 * sessionTitle 服务对象**——内部以 `titles.rename(session, title)` **方法调用**
 * （this = titles 服务实例）。旧实现调用点 `const rename = titles.rename` 解构
 * 后传入，方法内部读 `this.assertServiceActive` → this=undefined 抛错
 * （日志实证：`Cannot read properties of undefined (reading 'assertServiceActive')`；
 * 与 v1.20.2/1.20.3 图片落盘同款解构丢 this bug）。
 * @returns { title, ok } 或 { ok:false, reason }（未执行/失败均返回对象）
 */
export function renameDshSessionOnUse(
  deps: RenameOnUseDeps,
  session: unknown,
  titles: { rename: (session: unknown, title: string) => unknown } | undefined,
  active: ActiveSessionInfo,
  summary?: string,
): { ok: true; title: string } | { ok: false; reason: string } {
  if (!deps.sessionTitleAvailable) return { ok: false, reason: 'sessionTitle service unavailable' }
  if (!titles || typeof titles.rename !== 'function') return { ok: false, reason: 'sessionTitle service unavailable' }
  const title = namingTitleFor(active, summary)
  try {
    titles.rename(session, title)
    return { ok: true, title }
  } catch (error) {
    return { ok: false, reason: `rename threw: ${String((error as Error)?.message ?? error)}` }
  }
}

/**
 * 从 create 结果构造命名用 ActiveSessionInfo（v1.25.11，S142 用户：create 也要命名）：
 * createSession 返回的 result 已含 sessionId（S###/issue）与 dirName——无需等待 use 激活，
 * 直接构造（mdPath = sessionPath/SESSION.md，与 use 时一致）即可驱动 renameDshSessionOnUse。
 */
export function activeInfoFromCreate(result: CreateSessionResult): ActiveSessionInfo {
  return {
    sessionId: result.sessionId,
    dirName: result.dirName,
    mdPath: join(result.sessionPath, 'SESSION.md'),
  }
}

/**
 * 把当前 dsh 会话重命名为指定 SESSION 的命名标题（use/create 共用；v1.25.11）。
 * 需求②：summary 参数（≤20 字概括）透传——标题带概括（编号日期固定派生）。
 * 门控/失败可见性与 renameDshSessionOnUse 一致（不静默：成功 log / 失败 warn）。
 * 调用点（use 分支原内联逻辑提取，create 分支复用）：
 *   - use：激活后从 activeStore 取 info
 *   - create：createSession 结果经 activeInfoFromCreate 构造 info
 */
export function renameDshSessionForActive(
  ctx: Context,
  exec: { agent?: { session?: unknown } },
  info: ActiveSessionInfo,
  summary?: string,
): void {
  try {
    // v1.23.2：传整个 sessionTitle 服务对象（不解构 rename 函数）——
    // 旧实现 `titles.rename` 解构后传裸函数，方法内部 this=undefined 抛错
    const titles = hostService(ctx, 'sessionTitle')
    const dshSession = exec.agent?.session
    if (!dshSession) {
      console.warn(`[serenity-hooks] dsh 会话重命名未执行: 缺少 agent session（info: ${info.sessionId}）`)
      return
    }
    const result = renameDshSessionOnUse(
      { sessionTitleAvailable: true },
      dshSession,
      titles as { rename: (session: unknown, title: string) => unknown } | undefined,
      info,
      summary,
    )
    if (result.ok) {
      console.log(`[serenity-hooks] dsh 会话已重命名: ${String((dshSession as { id?: string }).id ?? '?')} → ${result.title}`)
    } else {
      console.warn(`[serenity-hooks] dsh 会话重命名未执行: ${result.reason}`)
    }
  } catch (err) {
    // 主流程仍完成（create/use 已执行）；仅重命名失败需要可见
    console.warn(`[serenity-hooks] dsh 会话重命名异常: ${String((err as Error)?.message ?? err)}`)
  }
}

function renderText(value: unknown): ContentBlock[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

// ── v1.34.1：SEP（Session Extension Protocol）整体废除 ──
// 原「CCC 注册 session-tool MSM → ACC 在生命周期点 spawn 它」的协议 + 脚本管道已删除
// （所有者裁决「能落 harness 已有原语，就不要自造协议 + 脚本管道」）。扩展面改为：
//   · 轨迹挂哪些 skill → SESSION.md frontmatter 声明 + systemPrompt.section（docs/cognitive-trajectory-skill-injection.md）
//   · 其余扩展 → harness 已有原语（工具/section/配置），不再经 ACC 的钩子通道。

/**
 * 创建 cognitive trajectory 工具（原 logbook；v1.33 S142 §32 更名 + 动作收敛）。
 * 闭包捕获插件 ctx → use 后可调 ctx.sessionTitle.rename。
 */
export function createCognitiveTrajectoryTool(ctx: Context): ReturnType<typeof defineTool> {
  return defineTool({
  name: 'cognitive_trajectory',
  // 🔴 本描述按 **EAP 五层**组织（owner 令 2026-10-16：「这个 tool 的 description 也用 eap 修订一遍」）。
  //    为什么用**数组 join** 而不是一长串 `+`：每个元素 = **一个层**，层的边界在源码里可见；
  //    旧写法把身份/动作/参数平铺成一条流水，读的人必须自己重建结构（低 E）。
  //    ⚠️ 相邻字符串字面量在 JS 里**不会**自动拼接（那不是 JS 语法）——必须显式 join 或 `+`。
  description: [
    // ── Tier 1 · 公理与边界：这是什么、**什么不是** ──
    'cognitive_trajectory — one cognitive trajectory: its persistent body (SESSION.md) + its timeline.',
    'A cognitive trajectory is NOT the conversation: SESSION.md is the durable body and never moves;',
    'the dsh conversation is only its rebuildable carrier (Ship of Theseus — the carrier is replaced, the cognitive trajectory continues).',
    'IDENTITY: every trajectory has a CODE — the fixed-position segment of its directory name (YYYY-MM-DD--<code>[--<desc>]).',
    'The code IS the trajectory\'s unique identifier, and you can choose it at creation time with create --id.',
    'A COGNITIVE TRAJECTORY HAS NO LIFECYCLE — it does not complete, close, or expire, and age never counts against it;',
    'it PERMANENTLY EXISTS. The only thing that ever changes is WHERE it is stored: archive moves it out of the active list',
    'without touching a single byte of its directory or SESSION.md. There is no reverse action — to restore one, use container_fs mv.',
    // ── Tier 2 · 本体：动作按**效果**分三组（分组本身就是契约：一眼看出"这个动作改不改我的绑定"）──
    'ACTIONS, grouped by EFFECT (read the grouping before picking one):',
    '(A) LIFECYCLE — changes which cognitive trajectory THIS conversation is bound to:',
    'list (inventory + stats + anomaly marks) / show (read one SESSION.md) / create (make a NEW cognitive trajectory) /',
    'use (bind THIS conversation to an existing cognitive trajectory; inline integrity check — silent when fine, problems reported as hints, never errors) /',
    'rebuild (clear-and-rebuild THIS conversation in place) /',
    'archive (move a trajectory into the archived area so it leaves the active list; one-way, never overwrites, and its content is left byte-identical).',
    '(B) DELIVERY — sends ONE message to ANOTHER cognitive trajectory; your own binding is unchanged:',
    'send-now (deliver RIGHT NOW) / send-later (deliver at ONE future instant).',
    '(C) REFERENCE — cro-guide (how to give THIS cognitive trajectory its own program that decides when it should be woken).',
    // ── Tier 3 · 拓扑：动作之间的关系 = 选择规则（旧文案只列了"做什么"，没说"该选哪个"）──
    'HOW TO CHOOSE (a rule, not a guess):',
    'not yet bound + starting new work ⇒ create — with no prior binding it activates immediately, so the new cognitive trajectory has a carrier at once.',
    'already bound + recording a separate future line ⇒ create — it does NOT steal your binding (you stay on the current cognitive trajectory);',
    'activate the new one when you want it by sending it a message.',
    'want THIS conversation to move to another cognitive trajectory ⇒ use (refuses when it would orphan the current binding; --force overrides).',
    'want to poke another cognitive trajectory ⇒ send-now. Its target needs NO prior setup:',
    'if the target has no live dsh session, one is created and bound automatically, and your message is injected into it.',
    // ── Tier 4 · 动力学与语义边界：回执**证明了什么、没证明什么** ──
    'RECEIPTS (read no more than is written): send-now returns a synchronous receipt meaning exactly "injected / turn started" —',
    'NEVER "the target ran or replied"; to prove the target actually moved, read its SESSION.md.',
    'It never queues behind the current turn: a busy target is steered mid-turn (read in the CURRENT turn), an idle target starts a turn at once.',
    'send-later is fire-and-forget by design: no receipt, no recall, no panel.',
    'ASYMMETRY (deliberate — the two differ in whether a missing target is normal): send-now creates a target on demand,',
    'because sending to a never-used cognitive trajectory is a legitimate intent; send-later does NOT,',
    'because scheduling for a cognitive trajectory that has never existed is almost always a mistyped name — auto-creating would hide that error behind an empty cognitive trajectory.',
    // ── Tier 5 · 表面：逐参数前置条件 ──
    'PARAMETERS: create requires --desc <desc> [--id <code>] [--goal] or --issue <ticket> (exactly one) plus --summary (≤20 chars).',
    'use requires --summary (≤20 chars) and may pass --force to switch away from the currently-bound cognitive trajectory.',
    'rebuild requires --summary (next-phase summary ≤20 chars) + optional --note (task focus for the rebuilt self).',
    'send-later requires target (a code or AGENT_SESSIONS dir name) + at (RFC3339 or +30m/+2h) + message.',
    'send-now requires target + message.',
    'uid: READS a legacy TRAJECTORY-UID only — setting one is retired (codes replaced it). Use create --id instead.',
    'The summary is appended to the dsh session title (S###-YYYY-MM-DD-<summary>); the code and date stay server-derived unless you pass --id.',
  ].join(' '),
  parameters: {
    action: {
      type: 'string',
      enum: [...COGNITIVE_TRAJECTORY_ACTIONS],
      required: true,
      description: [
        'Subcommand — grouped by effect.',
        'LIFECYCLE (changes THIS conversation\'s binding):',
        'list (inventory + stats + anomaly marks) / show (a code, dir name, or fuzzy keyword) /',
        'create (new cognitive trajectory; --id sets its code. Activates itself when you have no binding, otherwise leaves your binding untouched and tells you how to activate it) /',
        'use (activate context for THIS conversation; inline integrity check — pass silent, problems reported as hints, not errors) /',
        'rebuild (clear-and-rebuild current conversation — requires --summary + optional --note) /',
        'archive (move a trajectory to the archived area; one-way, refuses to overwrite, content untouched — --dryRun previews).',
        'DELIVERY (sends one message to ANOTHER cognitive trajectory; your binding is unchanged):',
        'send-now (deliver RIGHT NOW; the target needs no prior setup — if it has no live session, one is created and bound automatically) /',
        'send-later (one future instant + one message; fire-and-forget, and it does NOT auto-create a target).',
        'REFERENCE: cro-guide (no parameters: prints the CRO programming guide, including a ready-to-use sample snapshot)',
      ].join(' '),
    },
    name: { type: 'string', description: 'show/use/archive/uid identifier — a trajectory code (S### or a custom code) / dir name / legacy UID / fuzzy keyword' },
    uid: { type: 'string', description: `uid: READ-ONLY legacy field. Omit to read a trajectory's legacy ${UID_FILENAME}. Passing any value is REJECTED — setting a UID is retired (2026-10-19); a trajectory's code is its unique identity now, and you choose it at creation with create --id <code>.` },
    note: { type: 'string', description: 'rebuild: task focus ≤200 chars for the rebuilt self — what to work on next (short, no history; SESSION.md holds the full history). Injected as "- Task focus: …" into the rebuild anchor.' },
    desc: { type: 'string', description: 'create: short description (any language, ≤5 words; mutually exclusive with issue)' },
    id: { type: 'string', description: 'create: the trajectory CODE to assign (its stable unique identity — this is what you later pass as name/target). Omit to auto-assign S###. Allowed [A-Za-z0-9._-], starts alphanumeric, ≤64, must NOT contain Chinese or "--" (that is the dir-name separator); must not collide with an active trajectory code.' },
    issue: { type: 'string', description: 'create: ticket number (e.g. apaas-26116; dir named YYYY-MM-DD--<issue>; mutually exclusive with desc)' },
    goal: { type: 'string', description: 'create: one-sentence goal (optional)' },
    summary: { type: 'string', description: 'content summary ≤20 chars (REQUIRED for use and create — create exempts --dry-run preview and --issue sessions) — appended to the dsh session title as S###-YYYY-MM-DD-<summary>; the S### id and date stay server-derived; sanitized/truncated server-side' },
    force: { type: 'boolean', description: 'use: allow switching away from the currently-bound cognitive trajectory (binding guard override)' },
    dryRun: { type: 'boolean', description: 'create: preview mode (no actual changes)' },
    target: { type: 'string', description: 'send-later/send-now: target cognitive trajectory (S### or AGENT_SESSIONS directory name)' },
    at: { type: 'string', description: 'send-later: future instant (RFC3339 with timezone, or relative +30m / +2h)' },
    message: { type: 'string', description: 'send-later/send-now: the single message delivered to the target cognitive trajectory' },
  },
  output: {
    schema: { type: 'json' },
    render: (args, value) => renderText(value),
  },
  async execute(args, exec) {
    const root = cccRootForExec(exec)
    if (!root) throw new Error(NO_CCC_FROM_AGENT_CWD)

    switch (args.action) {
      case 'list': {
        // v1.33：原 `summary` 动作并入 list（用户裁决）——清单 + 全库统计一次给全
        return listSessions(root) + '\n' + summarize(root)
      }
      case 'show': {
        if (!args.name) throw new Error('show requires name (S### or directory name)')
        return showSession(root, args.name)
      }
      case 'create': {
        // 需求②：create 也加 summary（用户拍板"create 也带概括"）——必填（编号日期固定派生，概括由调用方显式给）
        // P3-① review：dry-run 豁免（未真实创建无命名对象）+ issue 会话豁免（issue 无概括语义，标题回退目录名）
        const isDryRun = args.dryRun ?? false
        const isIssueSession = typeof args.issue === 'string' && args.issue !== ''
        if (!isDryRun && !isIssueSession && (!args.summary || args.summary.trim() === '')) {
          throw new Error('create requires --summary <content summary ≤20 chars> (appended to the dsh session title; the S### id and date stay server-derived)')
        }
        // 对齐 osp：desc/issue 二选一（缺省/互斥均在 createSession 内报错）
        const result = createSession({
          root,
          desc: args.desc,
          issue: args.issue,
          id: args.id,
          goal: args.goal,
          dryRun: isDryRun,
        })
        const message = result.message
        if (isDryRun) return message

        // 🆕 2026-10-16（owner 令，S142）：**create 的分支语义由"有无绑定"决定**。
        //
        // 🔴 **为什么必须分开**（这是两条不同的意图，此前被同一个动作混在一起）：
        //   · **无绑定** ⇒ 调用方开着一条尚未归属任何轨迹的会话，`create` 的意图**就是**"从这里开始"。
        //     若仍只建不绑，调用方**必须再敲一次 `use`**，否则新轨迹没有任何载体
        //     ⇒ 后续 `send-now`/唤醒全部报"无绑定会话记录"（本仓已实测过同族形态）。
        //   · **已有绑定** ⇒ 调用方**正在**某条轨迹上工作，`create` 多半是"顺手记一件将来的事"。
        //     此时若夺走绑定，**当前轨迹被静默抛弃**（v1.25.11 旧行为正是如此，故 U6 收回）。
        //
        // ⇒ 判据 = `currentBoundDirName`（**持久化 bound 优先**，无则回落内存 active）。
        const scope = agentScope(exec)
        const priorBound = currentBoundDirName(exec, scope)

        if (priorBound === null) {
          // ── 路径①：无绑定 ⇒ 直接激活（等价于紧接着调了一次 `use`）──
          // 复用 `useSession` 而非自己写绑定：它同时做三件必须一起做的事
          //   （写内存激活态 / 产出 SESSION CONTEXT 文本 / 给出 dirName+mdPath），
          // 自己拼一遍就是**第二份会漂的实现**（单真相源纪律）。
          const active = useSession(root, result.dirName, scope)
          const info = getActiveSessionInfo(scope)
          if (info) renameDshSessionForActive(ctx, exec, info, args.summary)
          const dsh = agentDshSession(exec)
          if (dsh && info) {
            appendBound(dsh, 'activate', {
              dirName: info.dirName,
              mdPath: info.mdPath,
              sessionId: info.sessionId,
              note: 'auto-activated on create (no prior binding)',
            })
          }
          return [
            message,
            `✓ 已自动激活（此前**无绑定**）：${active.dir} —— 后续工作写回该轨迹的 SESSION.md。`,
            `  （判据：create 前无任何绑定 ⇒ 激活；有绑定则只建不夺，见下。）`,
          ].join('\n')
        }

        // ── 路径②：已有绑定 ⇒ 只建不夺 ＋ 显式告知"怎么激活它"──
        return [
          message,
          `⚠ 本轨迹【未】被激活 —— 当前已绑定 ${priorBound}，保绑定优先（不夺走你正在用的轨迹）。`,
          `  要激活它（并在它名下开一条会话）：用 cognitive_trajectory send-now 向 ${result.dirName} 投一条消息 ——`,
          `  目标若没有活跃 dsh 会话，会自动创建一条并把「使用提示词 ＋ 你的消息」一并注入。`,
        ].join('\n')
      }
      case 'use': {
        if (!args.name) throw new Error('use requires name (S### or directory name)')
        // 需求②：use 加 summary 必填（用户拍板"做成必填，但只影响那个概括，编号和日期还是固定的"）
        if (!args.summary || args.summary.trim() === '') {
          throw new Error('use requires --summary <content summary ≤20 chars> (appended to the dsh session title as S###-YYYY-MM-DD-<summary>; id and date stay server-derived)')
        }
        const scope = agentScope(exec)
        // 目标目录名：findSession 定位（精确/编码/模糊——编码无关）
        const targetEntry = findSession(join(root, 'AGENT_SESSIONS'), args.name)
        if (!targetEntry) throw new Error(`Session not found: "${args.name}". Use "list" to see available sessions.`)
        const targetDirName = targetEntry.dirName
        // G1 硬守卫（U5）：目标 ≠ 当前绑定 → 拒绝（除非 --force 显式切换）
        const currentDir = currentBoundDirName(exec, scope)
        const switching = currentDir !== null && targetDirName !== currentDir
        const force = args.force === true
        if (switching && !force) {
          throw new Error(
            `Session is bound to ${currentDir}. Switching to ${targetDirName} would orphan the current cognitive trajectory. ` +
            `Re-run with --force to switch (or close the current session first).`,
          )
        }
        const active = useSession(root, args.name, scope)
        // v1.21 F3：激活后重命名 dsh 会话标题（S###-日期-概括）
        const info = getActiveSessionInfo(scope)
        if (info) renameDshSessionForActive(ctx, exec, info, args.summary)
        // 持久化绑定（U1）：无先前绑定 → activate；经 force 切换 → switch
        const dsh = agentDshSession(exec)
        if (dsh && info) {
          const prevBound = readLastBound(dsh)
          appendBound(dsh, switching && prevBound ? 'switch' : 'activate', {
            dirName: info.dirName,
            mdPath: info.mdPath,
            sessionId: info.sessionId,
            ...(switching ? { note: 'forced switch' } : {}),
          })
        }
        // 内联完整性检查（v1.33）：原 health/qa 因"判据＝旧模板"被淘汰，这里只留不依赖模板的两项
        // —— **提示，不阻断**（用户裁决原话："通过就静默，不通过就提示，注意不是报错"）
        const advisory = advisoryHint(targetEntry.dirName, join(targetEntry.path, 'SESSION.md'))
        const out: Record<string, JsonValue> = { dir: active.dir, mdPath: active.mdPath, context: active.context }
        if (advisory) out.advisory = advisory
        // (b) 多 live 会话守卫（S142 §0y，所有者 2026-09-18 裁「b 做」）：
        //   🔴 **2026-09-21 起退休动作由 `appendBound` 单一入口负责**（上一步那次写入时，
        //      **同一次 RMW** 里就把同轨迹的其它条标 superseded）。**此处不再自己算 selfId**——
        //      那正是 F1 的成因：`agentDshSession(exec)` 返回的是**只带 `append` 的包装对象**，
        //      读 `.header?.id` **恒得 `''`** ⇒ 保留集为空 ⇒ 把**刚写进去的自己那条**也标掉
        //      ⇒ 该轨迹瞬间**零可用绑定** ⇒ 唤醒 / `send-now` / `send-later` 全部报
        //      「无绑定会话记录」（且症状与"到点没人接"不可区分）。
        //      收进入口后，`create`/`activate`/`switch`/`rebuild` **全部路径一致生效**（F2 同解）。
        if (dsh) {
          // (c) 兜底：清掉指向**已不存在**的 dsh 会话的悬空绑定（判据 fail-closed，
          //     见 hasSessionLogById —— sessions root 读不到时一律保留）。
          const pruned = pruneMissingBindings(root, (id) => !hasSessionLogById(sessionsRootDir(), id))
          if (pruned.length > 0) out.prunedBindings = pruned
        }
        return out
      }
      case 'rebuild': {
        // v1.30：rebuild 并入 logbook（原独立 session_rebuild 工具）——超限重建：
        // 复用旧 dsh 会话原地清空重来（Ship of Theseus），turn-stopping 时执行真正 replace
        if (!args.summary || args.summary.trim() === '') {
          throw new Error('rebuild requires --summary <content summary ≤20 chars> (the dsh session title is renamed to S###-YYYY-MM-DD-<summary> after rebuild)')
        }
        const dshSessionId = (exec as { agent?: { session?: { id?: string } } }).agent?.session?.id ?? ''
        if (!dshSessionId) throw new Error('Unable to determine the current dsh session id')
        const { queueRebuild } = await import('../trajectory/rebuild.js')
        const result = await queueRebuild(ctx, {
          root,
          note: args.note as string | undefined,
          summary: args.summary as string,
          agentCwd: agentCwdFor(exec),
          dshSessionId,
        })
        return {
          ok: true,
          queued: result.queued,
          anchor: result.anchor,
          sessionMdPath: result.sessionMdPath,
          instruction: 'Queued clear-and-rebuild: when this turn ends, the same conversation will be cleared and injected with the "continue the work" anchor (fake-initial-turns protocol body included), then auto-continue — no manual input needed; resume from SESSION.md at that point.',
        }
      }
      case 'archive': {
        // 🔴 2026-10-18（owner 令）：**认知轨迹没有生命周期**，唯一的"变化"就是归档。
        // 单向（owner 裁决 A2）：不设 unarchive；恢复 = 手工 container_fs mv 移回。
        // 判据：不覆盖既有、纯 rename（目录与 SESSION.md 逐字节不动）——见 archiveSession 的注释。
        if (!args.name) throw new Error('archive requires name (S### or directory name)')
        const res = archiveSession(root, args.name, args.dryRun ?? false)
        return {
          ok: true,
          dirName: res.dirName,
          from: res.from,
          to: res.to,
          message: res.message,
          note: res.dryRun
            ? '预览：未落盘。'
            : '已从活跃清单移出（目录与 SESSION.md 逐字节未改）。恢复方式：container_fs mv 移回 AGENT_SESSIONS/。',
        }
      }
      case 'uid': {
        // 🔴 2026-10-19（owner 追加令裁 B 案）：**UID 写入已退役，读取保留**。
        //
        // 为什么退役（R↓）：UID 当初存在的唯一理由是「命名很可能由于变化而变化」——
        // 而现在的**编码本身就稳定且可指定**（`create --id <code>`）⇒ 二元性取消
        // （owner：「取消 `S###` 与 UID 的二元性 —— 编码就是唯一标识，用户可指定」）。
        //
        // 为什么**读取**仍留着：存量文件里已有设定（本仓 = S142 的 `serenity-acc-maintainer`），
        // 删掉读取侧就等于把一个仍在用的指认通道作废（能力倒退，且没有任何收益）。
        // ⇒ 本动作用来**查看**现状并指引新路径；**任何写入尝试都响亮报错**。
        if (!args.name) throw new Error('uid requires name (code / S### / dir name / existing UID)')
        const entry = findSession(join(root, 'AGENT_SESSIONS'), args.name)
        if (!entry) throw new Error(`Trajectory not found: "${args.name}"`)
        const cur = readTrajectoryUid(entry.path)
        if (args.uid !== undefined) {
          throw new Error(
            'Setting a trajectory UID has been retired (2026-10-19). ' +
            'A trajectory\'s code IS its unique identity now, and you can choose it at creation time: ' +
            'cognitive_trajectory create --id <code> --desc <desc> --summary <summary>. ' +
            'Existing TRAJECTORY-UID files are still READ (so old handles keep resolving) — they are just never written.',
          )
        }
        return {
          ok: true,
          dirName: entry.dirName,
          code: parseTrajectoryCode(entry.dirName),
          uid: cur,
          retired: true,
          note: cur === null
            ? `未设定遗留 UID ⇒ 用编码指认（${parseTrajectoryCode(entry.dirName) ?? '无编码'}）。` +
              `UID 写入已退役；要一条可指定的标识，请用 create --id 起新轨迹。`
            : `遗留 UID = ${cur}（文件 ${UID_FILENAME}，只读兼容）——仍可用它指认本条轨迹。` +
              `⚠️ 写入已退役：新轨迹用 create --id 指定编码。`,
        }
      }
      case 'send-later': {
        // v1.33：原 `wake-add` 并入本工具；**2026-09-17 由 `wake-later` 更名 `send-later`**（命名 A 案）。
        // 语义 = 一条「未来时刻 + 一条 message」；fire-and-forget：**无回执、不可回收、无面板**（用户明示接受）。
        if (!args.target || !args.at || !args.message) {
          throw new Error('send-later requires target (S### or dir name) + at (RFC3339 or +30m/+2h) + message')
        }
        const wakeScope = agentScope(exec)
        const res = addWake(root, {
          target: args.target,
          at: args.at,
          message: args.message,
          // 发起者 = **调用方自身**所属 cognitive trajectory（`resolveSessionCognitiveTrajectoryLabel` 的三级归属）
          createdBy: resolveSessionCognitiveTrajectoryLabel(exec.agent?.session, wakeScope === DEFAULT_SESSION_SCOPE ? '' : wakeScope),
          nowMs: Date.now(),
        })
        if (!res.ok) return { ok: false, error: res.error }
        return { ok: true, output: `✓ 已登记唤醒\n${renderWakeEntry(res.entry)}` }
      }
      case 'send-now': {
        // 即时投递（2026-09-16 所有者裁决；**2026-09-17 由 `send-message` 更名 `send-now`**，命名 A 案）。
        // 与 send-later **共用取用通路**（live 优先 → 冷载入），区别只在：
        //   · 时刻：**现在**（不是未来；`addWake` 硬拒 at ≤ now ⇒ 本动作**不落注册表**）
        //   · 回执：**有**（同步返回；send-later 是 fire-and-forget）
        if (!args.target || !args.message) {
          throw new Error('send-now requires target (S### or dir name) + message')
        }
        const sendScope = agentScope(exec)
        const res = await sendToCognitiveTrajectory(
          ctx,
          root,
          args.target,
          args.message,
          resolveSessionCognitiveTrajectoryLabel(exec.agent?.session, sendScope === DEFAULT_SESSION_SCOPE ? '' : sendScope),
        )
        if (!res.ok) return { ok: false, error: res.detail }
        return {
          ok: true,
          output: [
            '✓ 已即时投递',
            `  · ${res.detail}`,
            '  · 语义：**不排队** —— 目标正在跑轮次则**当场注入当前轮**（steer），空闲则立即起一轮（followup）。',
            '  · ⚠️ 回执只到「已注入 / 已起轮」——**不表示**目标已执行或已答复。判"目标真的动了"须看它自己的 SESSION.md（文件级判据）。',
          ].join('\n'),
        }
      }
      case 'cro-guide': {
        // CRO 编写指南（2026-09-20；owner 令「机制属 ACC / 程序属 CCC」+「指南 ACC 内置，guide 老套路」）。
        // 纯读：只是把 `wake/cro-guide.ts` 的正文吐出来（正文含**由装配器实时生成**的样例快照，
        // 故**永不与 schema 漂移** —— 见该文件头的单真相源纪律）。
        // 为什么挂在本工具：CRO 程序放在**轨迹自己的目录**里 ⇒ 这是"逐轨迹"的知识，
        // 而管轨迹的人正是用本工具的人（设计 §9-5：既有 guide 位置，不新增域）。
        return CRO_GUIDE
      }
      default:
        throw new Error(`Unknown action: ${args.action as string}`)
    }
  },
  })
}

/**
 * 渲染一条唤醒条目（人读；`send-later` 的登记回执）。
 * 显式写明"不可回收"，因为这是用户明示接受的语义（D60 调整后：无 list/rm、无面板）。
 * @param e 刚登记的条目
 */
function renderWakeEntry(e: WakeEntry): string {
  return [
    '═══ cognitive trajectory 唤醒（1 条）═══',
    `  · ${e.id}  [${e.state}]  at=${e.at}  target=${e.target}  by=${e.createdBy || '?'}`,
    `      message: ${e.message.length > 120 ? `${e.message.slice(0, 120)}…` : e.message}`,
    '',
    `补跑窗口 ${WAKE_CATCH_UP_MS / 3_600_000}h：停机期间到期且迟到未超窗 → 补投；超窗 → missed 留痕。`,
    '⚠ fire-and-forget：无回执、不可回收、无面板。',
  ].join('\n')
}

/**
 * `use` 的内联检查（v1.33；🔴 **2026-10-18 起只剩一条**）。
 *
 * 为什么只剩"空壳"这一条（R↓）：另一条是「SESSION.md 已 N 天未更新」的老化告警，
 * 而 **owner 2026-10-18 裁决「认知轨迹没有生命周期」** ⇒ "旧轨迹该退休了"这个前提消失：
 * **旧不是问题**，激活一条 300 天前的轨迹与激活昨天的是同一件事。
 * ⇒ 老化告警不是在提示风险，它是在**暗示一个已不存在的规矩**，故删除。
 *
 * 剩下的这条**与模板、与年龄都无关**，它是纯粹的**事实缺失**：
 * 目录在但没有 SESSION.md ⇒ 激活必然失败（`useSession` 会阻断），提前说清比让人撞墙好。
 *
 * @param dirName 目标轨迹目录名
 * @param mdPath 目标 SESSION.md 绝对路径
 * @returns 提示文本；无异常 → null（**通过就静默**）
 */
function advisoryHint(dirName: string, mdPath: string): string | null {
  if (!existsSync(mdPath)) return `⚠ ${dirName}: 目录存在但没有 SESSION.md（空壳）——本次激活会失败，先补正文或改用 create`
  return null
}
