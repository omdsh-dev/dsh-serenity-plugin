/**
 * skiff-admin.ts — Skiff 约束面逻辑层（公开入口 = `container_admin` 的 `role` 域）
 *
 * 三动作分工（用户拍板 2026-08-28，2026-10-19 重做后语义不变）：guide 定义教程 ／
 * validate 校验 ／ list 摘要 ／ apply 显式应用确认。
 *
 * ## 🔴 2026-10-19 重做后，本文件的**数据源变了**
 *
 * 旧：读 `.opencode/serenity.json` 的 `skiff.roles`（容器级配置表）。
 * 新：读**轨迹目录里的 `skiff.json`**（owner：「目录下拥有 `skiff.json` 的认知轨迹自动是一个 skiff」）。
 * ⇒ `roleCount` 的语义 = **本 CCC 有几条 skiff 轨迹**；"角色名"这个概念没有了，只有**轨迹编码**。
 *
 * 归属（D23）不变：ACC 提供机制（教程 + 校验 + 列表），**约束内容归 CCC**（写进 `skiff.json`）。
 */

import type { JsonValue } from '../kernel/json.js'
import { readCheapWorkerConfig } from '../kernel/ccc.js'
import { profileSystemPromptSource, profileCognitiveTrajectory, resolveProfileSystemPrompt, SKIFF_PROFILE_HINT } from '../role/skiff/config.js'
import { listSkiffProfiles, SKIFF_PROFILE_FILENAME } from '../role/skiff/profile.js'
import { loadMsmEntries } from './msm/service.js'

/** Skiff 定义教程：概念 ／ `skiff.json` schema ／ 双白名单 ／ 轨迹纪律 ／ 微信路由 */
export const SKIFF_GUIDE = `═══ Skiff Guide (2026-10-19 redesigned) ═══

**A skiff IS a cognitive trajectory — the one whose directory contains \`${SKIFF_PROFILE_FILENAME}\`.**
That is the whole rule. No role table, no name registry: put the file there and the trajectory
becomes a skiff; delete it and it goes back to being an ordinary trajectory (takes effect at once).

  AGENT_SESSIONS/<YYYY-MM-DD--<code>--<desc>>/
    ├─ SESSION.md      ← its persistent body (this IS the workspace — nothing is auto-created)
    ├─ ${SKIFF_PROFILE_FILENAME}          ← its constraints (this file is what makes it a skiff)
    └─ TRAJECTORY-UID  ← legacy, read-only (superseded by the code)

── ${SKIFF_PROFILE_FILENAME} schema ──
  {
    "model": "provider/model",          // optional; falls back to cheap-worker.defaultModel
    "tools": ["read","grep","msm",...], // non-MSM toolbar whitelist — anything not listed is REMOVED from the schema
    "msms":  ["msm-a","msm-b"],         // MSM whitelist — msm exec may only run these; register/deregister always refused
    "cognitiveTrajectory": { "session": true, "keeper": true, "rebuild": true },  // defaults TRUE (see below)
    "systemPromptFile": ".opencode/skiff/<role>.md",  // recommended: relative to CCC root, hot-reloads on save
    "systemPrompt": "..."                             // inline fallback; systemPromptFile wins when both are set
  }

── Two whitelists, both default-deny ──
  - \`tools: []\` + non-empty \`msms\` = pure-MSM skiff (the usual knowledge-QA shape)
  - non-empty \`msms\` ⇒ the \`msm\` tool is added automatically (the only entry point for MSMs)
  - anything outside both lists is invisible in the schema, not merely rejected at call time

── cognitiveTrajectory: why the defaults are TRUE ──
  The workspace of a skiff is its own SESSION.md. Setting these to false would cut it off from
  its own body, so \`session\`/\`keeper\`/\`rebuild\` all default to true. Set false explicitly only
  when you deliberately want that participation off.

── WeChat routing: user → trajectory code ──
  \`weixin.routes\`: \`[{ "user": "<wx id or *>", "trajectory": "<code>" }]\`
  A route pointing at a code with no such trajectory is a hard error (the message is NOT delivered).
  A trajectory WITHOUT \`${SKIFF_PROFILE_FILENAME}\` is still a legal target — it is just an ordinary trajectory.

── Operating it ──
  Debug page: Settings → Serenity → enable the Skiff block → http://127.0.0.1:<debugPort>
  Everything is read live: saving \`${SKIFF_PROFILE_FILENAME}\` takes effect on the next turn, no restart.
    (The prompt FILE hot-reloads by mtime; the JSON itself is re-read every turn.)
  After editing, run container_admin role apply for an explicit validation + confirmation pass.
  Skill loading is always available to skiff sessions (skills are not whitelisted — they are read-only knowledge).`

/** 校验当前 CCC 的 skiff 约束面：msms 均已注册 ／ model ∈ cheap-worker.models ／ 提示词非空 */
export function validateSkiffConfig(root: string): JsonValue {
  const profiles = listSkiffProfiles(root)
  const issues: string[] = []
  if (profiles.length === 0) {
    return {
      ok: true,
      issues: [],
      roleCount: 0,
      note: `no skiff trajectories in this CCC (no trajectory has ${SKIFF_PROFILE_FILENAME} — zero impact)`,
    }
  }
  const registered = new Set(loadMsmEntries(root).map((e) => e.name))
  const hc = readCheapWorkerConfig(root)
  const allowedModels = hc ? new Set(hc.models) : null
  for (const p of profiles) {
    // 提示词来源解析——systemPromptFile（推荐）缺失/逃逸 → issue；
    // 两者都无 → issue（CCC 应完整定义人格；否则模型只有基础段）
    try {
      if (!resolveProfileSystemPrompt(root, p).trim()) {
        issues.push(`trajectory "${p.code}": system prompt is empty (define systemPromptFile (recommended) or systemPrompt)`)
      }
    } catch (err) {
      issues.push(`trajectory "${p.code}": ${String((err as Error)?.message ?? err)}`)
    }
    for (const m of p.msms) {
      if (!registered.has(m)) issues.push(`trajectory "${p.code}": msms "${m}" is not registered in mech-registry.json`)
    }
    if (p.model && allowedModels && !allowedModels.has(p.model)) {
      issues.push(`trajectory "${p.code}": model "${p.model}" not in cheap-worker.models (${[...allowedModels].join(', ') || '(none)'})`)
    }
  }
  return { ok: issues.length === 0, issues, roleCount: profiles.length }
}

/** 列出当前 CCC 的 skiff 轨迹（编码 ／ 模型 ／ msms ／ tools ／ 纪律摘要 ／ 提示词来源） */
export function listSkiffRoles(root: string): JsonValue {
  const profiles = listSkiffProfiles(root)
  if (profiles.length === 0) {
    return { roles: [], note: `no skiff trajectories in this CCC (no trajectory has ${SKIFF_PROFILE_FILENAME})` }
  }
  const items = profiles.map((p) => ({
    // ⚠️ 键名沿用 `name`（面板/工具回执形状不变），值 = **轨迹编码**（新模型里的身份）
    name: p.code,
    dirName: p.dirName,
    model: p.model ?? '(cheap-worker default)',
    msms: p.msms,
    tools: p.tools,
    cognitiveTrajectory: profileCognitiveTrajectory(p) satisfies Record<string, boolean>,
    promptSource: profileSystemPromptSource(p),
    ...(p.systemPromptFile ? { systemPromptFile: p.systemPromptFile } : {}),
  }))
  return { roles: items, count: items.length }
}

/**
 * 应用当前 skiff 配置（S142 用户：改了 json 应该有个生效机制）。
 *
 * 语义：约束面是**每轮实时读取**的 ⇒ apply 不是"推送"，而是**显式校验 + 应用确认**：
 * ① 校验合法（复用 validate：msms 注册 / model 白名单 / 提示词非空）
 * ② 非法 → 报告问题清单，不应用（提示修复后重跑 apply）
 * ③ 合法 → 应用确认：绑定 CCC + 轨迹清单 + 说明（下一轮即生效）
 */
export function applySkiffConfig(root: string): JsonValue {
  const validation = validateSkiffConfig(root) as { ok: boolean; issues: string[]; roleCount: number }
  const profiles = listSkiffProfiles(root)
  if (!validation.ok) {
    return {
      applied: false,
      cccRoot: root,
      roleCount: profiles.length,
      issues: validation.issues,
      hint: 'fix the issues above, then run container_admin role apply again',
    }
  }
  return {
    applied: true,
    cccRoot: root,
    roleCount: profiles.length,
    roles: profiles.map((p) => p.code),
    note: `constraints are read live from each trajectory's ${SKIFF_PROFILE_FILENAME} — they take effect on the next turn (no restart); ${SKIFF_PROFILE_HINT}`,
  }
}
