/**
 * trajectory-constraint-admin.ts — 轨迹约束面逻辑层（公开入口 = `container_admin` 的 `role` 域）
 *
 * 三动作分工（用户拍板 2026-08-28，2026-10-19 重做后语义不变）：guide 定义教程 ／
 * validate 校验 ／ list 摘要 ／ apply 显式应用确认。
 *
 * ## 🔴 2026-10-19 重做后，本文件的**数据源变了**
 *
 * 旧：读 `.opencode/serenity.json` 的 `轨迹约束.roles`（容器级配置表）。
 * 新：读**轨迹目录里的 `trajectory-constraint.json`**（owner：「目录下拥有 `trajectory-constraint.json` 的认知轨迹自动是一个 轨迹约束」）。
 * ⇒ `constraintCount` 的语义 = **本 CCC 有几条 轨迹约束轨迹**；"角色名"这个概念没有了，只有**轨迹编码**。
 *
 * 归属（D23）不变：ACC 提供机制（教程 + 校验 + 列表），**约束内容归 CCC**（写进 `trajectory-constraint.json`）。
 */

import type { JsonValue } from '../kernel/json.js'
import { readCheapWorkerConfig } from '../kernel/ccc.js'
import { constraintSystemPromptSource, constraintCognitiveTrajectory, resolveConstraintSystemPrompt, TRAJECTORY_CONSTRAINT_HINT } from '../trajectory/policy/rules.js'
import { listTrajectoryConstraints, TRAJECTORY_CONSTRAINT_FILENAME } from '../trajectory/policy/profile.js'
import { TRAJECTORY_FILENAME, TRAJECTORY_LEGACY_FILENAMES } from '../trajectory/policy/files.js'
import { hasTrajectoryPrompt, TRAJECTORY_PROMPT_FILENAME } from '../trajectory/prompt.js'
import { loadMsmEntries } from './msm/service.js'

/**
 * 轨迹约束 定义教程：**只讲「限制面」**（约束面 / 双白名单 / 纪律参与项 / 路由）。
 *
 * 🔴 2026-10-20 拆分（owner 裁 Q2）：本章原先同时承载「描述自己」与「限制自己」。
 * 两者读者与前提不同 —— **描述自己是所有轨迹的常态，限制自己才是特例** ——
 * 故「章程 / 常驻 / 三个载体」已移入 `config docs trajectory-self`。
 * ⛔ **本文件不再重复那份内容**（一个内容一个正文入口，v1.75.0 指针纪律）。
 */
export const TRAJECTORY_CONSTRAINT_GUIDE = `═══ 轨迹约束 Guide（限制面；2026-10-20 split）═══

**A 轨迹约束 IS a cognitive trajectory — the one whose directory contains \`${TRAJECTORY_CONSTRAINT_FILENAME}\`.**
That is the whole rule. No role table, no name registry: put the file there and the trajectory
becomes a 轨迹约束; delete it and it goes back to being an ordinary trajectory (takes effect at once).

⚠️ **本章只讲"限制自己"。** 想写章程（PROMPT.md）或声明常驻（resident）?
   → \`container_admin config docs trajectory-self\`（那是**所有轨迹**都用得上的自述手册）。

  AGENT_SESSIONS/<YYYY-MM-DD--<code>--<desc>>/
    ├─ SESSION.md      ← its persistent body (this IS the workspace — nothing is auto-created)
    ├─ PROMPT.md       ← its charter (see trajectory-self; NOT copied here)
    ├─ ${TRAJECTORY_CONSTRAINT_FILENAME}          ← its declaration (this file is what makes it a 轨迹约束)
    └─ continuous-re-occurrence.ts  ← optional CRO program (spawned, never imported)

  The older names ${TRAJECTORY_LEGACY_FILENAMES.map((n) => `\`${n}\``).join(' / ')} are still READ
  (the family is checked in that order) — writing goes to \`${TRAJECTORY_FILENAME}\` only.

── ${TRAJECTORY_CONSTRAINT_FILENAME} schema（限制面部分）──
  {
    "model": "provider/model",          // optional; falls back to cheap-worker.defaultModel
    "tools": ["read","grep","msm",...], // non-MSM toolbar whitelist — anything not listed is REMOVED from the schema
    "msms":  ["msm-a","msm-b"],         // MSM whitelist — msm exec may only run these; register/deregister always refused
    "cognitiveTrajectory": { "session": true, "keeper": true, "rebuild": true },  // defaults TRUE (see below)
    "cro": { "host": "<machine name>" } // optional: which machine may run this trajectory's CRO program
  }

  ⚠️ 提示词**不在这里**（新形态）：写 \`PROMPT.md\` 即可，**所有轨迹**都适用。
     旧字段 \`systemPromptFile\` / \`systemPrompt\` 属**兼容期**形态，仍在读、但不再推荐；
     两者同时存在时 \`PROMPT.md\` 让位规则见 \`trajectory/prompt.ts\`（此处不重复）。

  ⚠️ **只想声明常驻、不想限制自己**：只写 \`"resident"\` 字段、**不写 tools/msms**。
     空白名单 = **不收窄任何工具面**（见下方"两个默认"）—— 但请注意你仍因此"成为轨迹约束"，
     只是没有实际限制。

── Two whitelists, both default-deny ──
  - \`tools: []\` + non-empty \`msms\` = pure-MSM 轨迹约束 (the usual knowledge-QA shape)
  - 空 \`tools\` + 空 \`msms\` = **无限制**（普通行为；常驻自述用的就是这一格）
  - non-empty \`msms\` ⇒ the \`msm\` tool is added automatically (the only entry point for MSMs)
  - anything outside both lists is invisible in the schema, not merely rejected at call time

── cognitiveTrajectory: why the defaults are TRUE ──
  The workspace of a 轨迹约束 is its own SESSION.md. Setting these to false would cut it off from
  its own body, so \`session\`/\`keeper\`/\`rebuild\` all default to true. Set false explicitly only
  when you deliberately want that participation off.

── IM routing: user → trajectory code（微信 / 飞书同一张表）──
  \`im.routes\`: \`[{ "user": "<channel user id or *>", "trajectory": "<code>" }]\`
  A route pointing at a code with no such trajectory is a hard error (the message is NOT delivered).
  A trajectory WITHOUT \`${TRAJECTORY_CONSTRAINT_FILENAME}\` is still a legal target — it is just an ordinary trajectory.

── Operating it ──
  Everything is read live: saving \`${TRAJECTORY_CONSTRAINT_FILENAME}\` takes effect on the next turn, no restart.
    (The prompt FILE hot-reloads by mtime; the JSON itself is re-read every turn.)
  After editing, run container_admin config apply for an explicit validation + confirmation pass.
  Skill loading is always available to 轨迹约束 sessions (skills are not whitelisted — they are read-only knowledge).

  写完之后怎么验 → container_admin config docs trajectory-self 的「写完之后怎么验」段（同一套判据，不复制）。`

/** 校验当前 CCC 的 轨迹约束面：msms 均已注册 ／ model ∈ cheap-worker.models ／ 提示词非空 */
export function validateTrajectoryConstraint(root: string): JsonValue {
  const profiles = listTrajectoryConstraints(root)
  const issues: string[] = []
  if (profiles.length === 0) {
    return {
      ok: true,
      issues: [],
      constraintCount: 0,
      note: `no 轨迹约束 trajectories in this CCC (no trajectory has ${TRAJECTORY_CONSTRAINT_FILENAME} — zero impact)`,
    }
  }
  const registered = new Set(loadMsmEntries(root).map((e) => e.name))
  const hc = readCheapWorkerConfig(root)
  const allowedModels = hc ? new Set(hc.models) : null
  for (const p of profiles) {
    // 提示词来源解析——**两条来源，任一非空即可**（v1.72.0 起）：
    //   ① 轨迹目录的 `PROMPT.md`（**新形态**：轨迹提示词，所有轨迹都适用）
    //   ② trajectory-constraint.json 的 `systemPromptFile` / `systemPrompt`（**兼容期**旧形态）
    //
    // 🔴 2026-10-19 修（T4）：旧判据只看② ⇒ 只写 `PROMPT.md` 的轨迹会被误报
    //    "system prompt is empty"。那是**读数器过时**，不是配置缺失。
    const hasTrajectoryPromptOrLegacy = hasTrajectoryPrompt(root, p.dirName) || (() => {
      try {
        return resolveConstraintSystemPrompt(root, p).trim() !== ''
      } catch (err) {
        issues.push(`trajectory "${p.code}": ${String((err as Error)?.message ?? err)}`)
        return true // 已在上面报过，不再叠一条"empty"
      }
    })()
    if (!hasTrajectoryPromptOrLegacy) {
      issues.push(`trajectory "${p.code}": no trajectory prompt (add ${TRAJECTORY_PROMPT_FILENAME} in the trajectory dir — recommended — or the legacy systemPromptFile/systemPrompt)`)
    }
    for (const m of p.msms) {
      if (!registered.has(m)) issues.push(`trajectory "${p.code}": msms "${m}" is not registered in mech-registry.json`)
    }
    if (p.model && allowedModels && !allowedModels.has(p.model)) {
      issues.push(`trajectory "${p.code}": model "${p.model}" not in cheap-worker.models (${[...allowedModels].join(', ') || '(none)'})`)
    }
  }
  return { ok: issues.length === 0, issues, constraintCount: profiles.length }
}

/** 列出当前 CCC 的轨迹约束（编码 ／ 模型 ／ msms ／ tools ／ 纪律摘要 ／ 提示词来源） */
export function listTrajectoryConstraintSummary(root: string): JsonValue {
  const profiles = listTrajectoryConstraints(root)
  if (profiles.length === 0) {
    return { roles: [], note: `no 轨迹约束 trajectories in this CCC (no trajectory has ${TRAJECTORY_CONSTRAINT_FILENAME})` }
  }
  const items = profiles.map((p) => ({
    // ⚠️ 键名沿用 `name`（面板/工具回执形状不变），值 = **轨迹编码**（新模型里的身份）
    name: p.code,
    dirName: p.dirName,
    model: p.model ?? '(cheap-worker default)',
    msms: p.msms,
    tools: p.tools,
    cognitiveTrajectory: constraintCognitiveTrajectory(p) satisfies Record<string, boolean>,
    // 🔴 两条来源都要报（v1.72.0 起 `PROMPT.md` 是新形态且优先）：只报旧形态会让
    //    "只写了 PROMPT.md 的轨迹"显示成 `none` —— 那是读数器过时，不是配置缺失。
    promptSource: constraintSystemPromptSource(p, hasTrajectoryPrompt(root, p.dirName)),
    ...(p.systemPromptFile ? { systemPromptFile: p.systemPromptFile } : {}),
  }))
  return { roles: items, count: items.length }
}

/**
 * 应用当前 轨迹约束 配置（S142 用户：改了 json 应该有个生效机制）。
 *
 * 语义：约束面是**每轮实时读取**的 ⇒ apply 不是"推送"，而是**显式校验 + 应用确认**：
 * ① 校验合法（复用 validate：msms 注册 / model 白名单 / 提示词非空）
 * ② 非法 → 报告问题清单，不应用（提示修复后重跑 apply）
 * ③ 合法 → 应用确认：绑定 CCC + 轨迹清单 + 说明（下一轮即生效）
 */
export function applyTrajectoryConstraint(root: string): JsonValue {
  const validation = validateTrajectoryConstraint(root) as { ok: boolean; issues: string[]; constraintCount: number }
  const profiles = listTrajectoryConstraints(root)
  if (!validation.ok) {
    return {
      applied: false,
      cccRoot: root,
      constraintCount: profiles.length,
      issues: validation.issues,
      hint: 'fix the issues above, then run container_admin config apply again',
    }
  }
  return {
    applied: true,
    cccRoot: root,
    constraintCount: profiles.length,
    roles: profiles.map((p) => p.code),
    note: `constraints are read live from each trajectory's ${TRAJECTORY_CONSTRAINT_FILENAME} — they take effect on the next turn (no restart); ${TRAJECTORY_CONSTRAINT_HINT}`,
  }
}
