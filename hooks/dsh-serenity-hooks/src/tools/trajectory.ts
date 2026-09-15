/**
 * trajectory.ts — `container_trajectory` 真实 DSH 工具定义（defineTool）
 *
 * v1.33（S142 §32 用户裁决）：由 `logbook` **更名并收敛为 `trajectory`**（v1.34：工具名再硬切为
 * `container_trajectory`，无别名）——trajectory 是一等概念
 * （SESSION.md 是它的持久身体），本工具管它的**载体生命周期 + 一次性时间安排**。
 * 动作收敛为 **6 个**：list / show / create / use / rebuild / wake-later。
 *
 * 与旧面（logbook 11 动作 + trajectory 12 动作）的对应（用户逐条裁决，R↓）：
 *   · `summary` → 并入 `list`（全库统计随清单一起给）
 *   · `health`/`qa` → **淘汰**：其判据是"旧六节模板合规"，而 ACC 层的编写标准已升级为 EAP
 *     ⇒ 只把**不依赖模板**的两项并入 `use`：空壳 / 长期无活动（**提示，不阻断**）
 *   · `close`/`archive` → 删：`completed` 本就由 SESSION.md 的 `[x]` 推导（不靠 close 写）；
 *     归档能力由 `container_fs mv → _archived/` 承担
 *   · `hook-develop-guide` → **淘汰**（v1.34.1：SEP 整体废除——「能落 harness 已有原语，
 *     就不要自造协议 + 脚本管道」；轨迹挂哪些 skill 改由 SESSION.md frontmatter 声明 +
 *     `systemPrompt.section` 注入，见 `docs/trajectory-skill-injection.md`）
 *   · autopilot 面（all/init/random/diag/doc/check/status/guide）→ `container_admin` 的 autopilot 域
 *   · `wake-add`/`wake-list`/`wake-rm` → **`wake-later`**（一次登记；**不可回收、无面板**——用户明示接受）
 *
 * 保留 osp 对齐语义的部分：create 的 `--desc`/`--issue` 二选一、use 激活即重命名 dsh 会话标题（F3）。
 * 活跃会话跟踪：内存 Map（按 dsh 会话 id 隔离）+ 从 events 恢复（S134）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from 'cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { hostService } from '../host/access.js'
import type { JsonValue } from '../json.js'
import { join } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { findSerenityRoot } from '../ccc.js'
import { agentCwdFor, cccRootForExec, NO_CCC_FROM_AGENT_CWD } from '../ccc-roots.js'
import { appendBound, readLastBound, resolveSessionTrajectoryLabel } from '../trajectory-bound.js'
import { addWake, WAKE_CATCH_UP_MS, type WakeEntry } from '../wake-registry.js'
import {
  listSessions,
  showSession,
  createSession,
  useSession,
  findSession,
  TRAJECTORY_ACTIONS,
  DEFAULT_SESSION_SCOPE,
  getActiveSessionInfo,
  summarize,
  type ActiveSessionInfo,
  type CreateSessionResult,
} from '../trajectory-ops.js'

/** 当前 dsh 会话 id（use/close 按会话隔离的 scope） */
function agentScope(exec: { agent?: { session?: { id?: string } } }): string {
  return exec.agent?.session?.id ?? DEFAULT_SESSION_SCOPE
}

/** 当前 dsh 会话对象（append bound 用）；无 → null */
function agentDshSession(exec: { agent?: { session?: unknown } }): { append: (type: unknown, data: unknown) => unknown } | null {
  const s = exec.agent?.session as { append?: unknown } | undefined
  return s && typeof s.append === 'function'
    ? { append: s.append as (type: unknown, data: unknown) => unknown }
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

/**
 * 清洗 + 截断会话概括（需求② S142 用户拍板：编号日期后加 ≤20 字内容概括）。
 * 规则（服务端统一，不信任 LLM 输入）：
 *   - 去控制字符/换行/回车/制表（防标题注入/多行污染）
 *   - trim（去首尾空白）
 *   - 截断 ≤20 字符（按 Unicode 码点——中英混排统一；emoji 等代理对按码点保留）
 *   - 去 `/`（防标题被误读为路径分隔）
 * @returns 清洗后的概括（空输入 → 空串；调用方决定是否允许空）
 */
export function sanitizeSessionSummary(summary: string): string {
  const cleaned = summary
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\//g, '')
    .trim()
  return [...cleaned].slice(0, 20).join('')
}

/**
 * 从激活会话派生命名标题（v1.22.9 格式修正 + 需求② 概括）：
 * F3 原始需求是 **`S###-日期`**（如 `S143-2026-08-26`）——从 `sessionId` 派生，
 * 而非完整目录名（`2026-08-24--S142--...` 超长 + 中文，不符合用户拍板格式）。
 * 需求②（S142 用户拍板）：编号日期后加 ≤20 字内容概括 → `S###-YYYY-MM-DD-<概括>`
 * ——概括来自显式 summary 参数（服务端截断/清洗，可靠不靠猜）；编号日期仍固定派生。
 * 无 S### 编号（issue 会话等）→ 回退目录名。
 * @param active 激活会话信息（sessionId + dirName）
 * @param summary 内容概括（≤20 字，服务端清洗截断；空 → 不带概括的 `S###-日期`）
 * @returns `S143-2026-08-26-概括` / `S143-2026-08-26` / 原目录名
 */
export function namingTitleFor(active: ActiveSessionInfo, summary?: string): string {
  const sid = active.sessionId
  if (typeof sid === 'string' && /^S\d+$/.test(sid)) {
    const date = active.dirName.match(/^(\d{4}-\d{2}-\d{2})--/)?.[1] ?? ''
    const cleaned = summary ? sanitizeSessionSummary(summary) : ''
    const base = date ? `${sid}-${date}` : sid
    return cleaned ? `${base}-${cleaned}` : base
  }
  return active.dirName
}

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
//   · 轨迹挂哪些 skill → SESSION.md frontmatter 声明 + systemPrompt.section（docs/trajectory-skill-injection.md）
//   · 其余扩展 → harness 已有原语（工具/section/配置），不再经 ACC 的钩子通道。

/**
 * 创建 trajectory 工具（原 logbook；v1.33 S142 §32 更名 + 动作收敛）。
 * 闭包捕获插件 ctx → use 后可调 ctx.sessionTitle.rename。
 */
export function createTrajectoryTool(ctx: Context): ReturnType<typeof defineTool> {
  return defineTool({
  name: 'container_trajectory',
  description:
    'Trajectory (AGENT_SESSIONS/ — the persistent body of a trajectory; the dsh conversation is only its rebuildable carrier). ' +
    'Lifecycle + one-shot scheduling: list (inventory with stats and anomaly marks) / show (read one SESSION.md) / create / use (activate for this conversation, with inline integrity check) / rebuild (clear-and-rebuild the current conversation in place, Ship of Theseus) / wake-later (schedule ONE message to any trajectory at a future instant — fire-and-forget: no receipt, no recall, no panel). ' +
    'create requires --desc <desc> [--goal] or --issue <ticket> (exactly one) plus --summary (≤20 chars). ' +
    'use requires --summary (≤20 chars) and may pass --force to switch away from the currently-bound trajectory. ' +
    'rebuild requires --summary (next-phase summary ≤20 chars) + optional --note (task focus for the rebuilt self). ' +
    'wake-later requires target (S### or AGENT_SESSIONS dir name) + at (RFC3339 or +30m/+2h) + message. ' +
    'The summary is appended to the dsh session title (S###-YYYY-MM-DD-<summary>); the S### id and date stay server-derived.',
  parameters: {
    action: {
      type: 'string',
      enum: [...TRAJECTORY_ACTIONS],
      required: true,
      description:
        'Subcommand: list (inventory + stats + anomaly marks) / show (S### or dir name or fuzzy keyword) / create (--desc or --issue) / ' +
        'use (activate context; inline integrity check — pass silent, problems reported as hints, not errors) / ' +
        'rebuild (clear-and-rebuild current conversation — requires --summary + optional --note) / ' +
        'wake-later (one future instant + one message, delivered to target trajectory)',
    },
    name: { type: 'string', description: 'show/use session identifier (S### or dir name or keyword)' },
    note: { type: 'string', description: 'rebuild: task focus ≤200 chars for the rebuilt self — what to work on next (short, no history; SESSION.md holds the full history). Injected as "- Task focus: …" into the rebuild anchor.' },
    desc: { type: 'string', description: 'create short description (any language, ≤5 words; mutually exclusive with issue)' },
    issue: { type: 'string', description: 'create ticket number (e.g. apaas-26116; dir named YYYY-MM-DD--<issue>; mutually exclusive with desc)' },
    goal: { type: 'string', description: 'create one-sentence goal (optional)' },
    summary: { type: 'string', description: 'content summary ≤20 chars (REQUIRED for use and create — create exempts --dry-run preview and --issue sessions) — appended to the dsh session title as S###-YYYY-MM-DD-<summary>; the S### id and date stay server-derived; sanitized/truncated server-side' },
    force: { type: 'boolean', description: 'use: allow switching away from the currently-bound trajectory (binding guard override)' },
    dryRun: { type: 'boolean', description: 'create preview mode (no actual changes)' },
    target: { type: 'string', description: 'wake-later: target trajectory (S### or AGENT_SESSIONS directory name)' },
    at: { type: 'string', description: 'wake-later: future instant (RFC3339 with timezone, or relative +30m / +2h)' },
    message: { type: 'string', description: 'wake-later: the single message delivered to the target trajectory' },
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
          goal: args.goal,
          dryRun: isDryRun,
        })
        const message = result.message
        // U6（方案 v1.0）：create 保留当前绑定——不再 rename 当前 dsh 会话为新目录
        // （v1.25.11 旧行为：create 后立即改名夺绑定——长会话中途误 create 即被夺走）。
        // 新会话仅在后续显式 `session use` 时才绑定；此处只 append create bound 审计记录。
        if (!isDryRun) {
          appendBound(
            agentDshSession(exec),
            'create',
            {
              dirName: result.dirName,
              mdPath: join(result.sessionPath, 'SESSION.md'),
              sessionId: result.sessionId,
              note: 'created (binding unchanged until explicit use)',
            },
          )
        }
        return message
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
            `Session is bound to ${currentDir}. Switching to ${targetDirName} would orphan the current trajectory. ` +
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
        const { queueRebuild } = await import('../rebuild.js')
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
          instruction: 'Queued clear-and-rebuild: when this turn ends, the same conversation will be cleared and injected with the "continue the work" anchor (first-anchor protocol body included), then auto-continue — no manual input needed; resume from SESSION.md at that point.',
        }
      }
      case 'wake-later': {
        // v1.33：原 `wake-add` 并入本工具并更名（用户裁决「wake 系列只保留 wake-later，原功能即可，只是改名」）。
        // 语义 = 一条「未来时刻 + 一条 message」；fire-and-forget：**无回执、不可回收、无面板**（用户明示接受）。
        if (!args.target || !args.at || !args.message) {
          throw new Error('wake-later requires target (S### or dir name) + at (RFC3339 or +30m/+2h) + message')
        }
        const wakeScope = agentScope(exec)
        const res = addWake(root, {
          target: args.target,
          at: args.at,
          message: args.message,
          // 发起者 = **调用方自身**所属 trajectory（`resolveSessionTrajectoryLabel` 的三级归属）
          createdBy: resolveSessionTrajectoryLabel(exec.agent?.session, wakeScope === DEFAULT_SESSION_SCOPE ? '' : wakeScope),
          nowMs: Date.now(),
        })
        if (!res.ok) return { ok: false, error: res.error }
        return { ok: true, output: `✓ 已登记唤醒\n${renderWakeEntry(res.entry)}` }
      }
      default:
        throw new Error(`Unknown action: ${args.action as string}`)
    }
  },
  })
}

/**
 * 渲染一条唤醒条目（人读；`wake-later` 的登记回执）。
 * 显式写明"不可回收"，因为这是用户明示接受的语义（D60 调整后：无 list/rm、无面板）。
 * @param e 刚登记的条目
 */
function renderWakeEntry(e: WakeEntry): string {
  return [
    '═══ trajectory 唤醒（1 条）═══',
    `  · ${e.id}  [${e.state}]  at=${e.at}  target=${e.target}  by=${e.createdBy || '?'}`,
    `      message: ${e.message.length > 120 ? `${e.message.slice(0, 120)}…` : e.message}`,
    '',
    `补跑窗口 ${WAKE_CATCH_UP_MS / 3_600_000}h：停机期间到期且迟到未超窗 → 补投；超窗 → missed 留痕。`,
    '⚠ fire-and-forget：无回执、不可回收、无面板。',
  ].join('\n')
}

/**
 * `use` 的内联检查（v1.33）：**只报不依赖 SESSION.md 模板的两类可观测事实**，且**只提示不阻断**。
 *
 * 为什么只有两条（R↓）：原 `qa` 的六节名检查与 `health` 的 stalled/drift 都建立在"旧模板合规"假设上，
 * 而 ACC 层的编写标准已升级为 **EAP**（用户裁决：「这说明 qa 应该淘汰了」）⇒ 那类判据淘汰；
 * 剩下与模板无关、且"用到时才发现最划算"的只有：
 *   ① **空壳**：目录在但没有 SESSION.md（无正文可载 ⇒ 由 useSession 阻断，此处只是提前说清）
 *   ② **长期无活动**：SESSION.md 的 mtime 过旧（按 HEALTH_STALE_DAYS 同口径）
 * @param dirName 目标轨迹目录名
 * @param mdPath 目标 SESSION.md 绝对路径
 * @returns 提示文本；无异常 → null（**通过就静默**）
 */
function advisoryHint(dirName: string, mdPath: string): string | null {
  if (!existsSync(mdPath)) return `⚠ ${dirName}: 目录存在但没有 SESSION.md（空壳）——本次激活会失败，先补正文或改用 create`
  let ageDays = 0
  try {
    ageDays = (Date.now() - statSync(mdPath).mtimeMs) / 86_400_000
  } catch {
    return null
  }
  if (ageDays >= 7) return `⚠ ${dirName}: SESSION.md 已 ${Math.floor(ageDays)} 天未更新——激活的是旧轨迹，确认是否接续的是它`
  return null
}
