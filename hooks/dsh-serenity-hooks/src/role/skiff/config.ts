/**
 * role/skiff/config.ts — skiff 约束面的**纯逻辑助手**（零 DSH 依赖，可独立单测）
 *
 * ## 2026-10-19 重做后的职责边界（R↓，别再混起来）
 *
 * | 模块 | 管什么 |
 * |---|---|
 * | `./profile.ts` | **判据 + 读盘**（"这是不是 skiff"、"约束面是什么"） |
 * | `./config.ts`（本文件） | **从约束面派生出的纯函数**（白名单集合、提示词读取器、基础提示词文本） |
 * | `./core.ts` | 会话创建/复用、提问、守门查询 |
 *
 * ⇒ 本文件**不再读 `serenity.json`**：`skiff.roles` 整段已退役（owner 2026-10-19 重做）。
 * 它只接收一个已解析好的 `SkiffProfile`，因此**不涉及任何 IO**（除提示词文件，那是刻意懒读的）。
 */

import { existsSync, statSync } from 'node:fs'
import { resolveInside, readUtf8 } from '../../kernel/ccc.js'
import type { SkiffProfile } from './profile.js'

/** 白名单推导 ────────────────────────────────────────────────────────────── */

/** 提示词来源提示串（`apply` 回执与面板共用；避免两处措辞漂） */
export const SKIFF_PROFILE_HINT =
  'systemPromptFile hot-reloads by mtime; the rest of skiff.json is re-read every turn'

/**
 * 该 skiff 会话**可见**的工具面（tools ∪ `msm`）。
 *
 * 🔴 `msm` 为什么自动加入：`msms` 非空意味着这个 skiff **有 MSM 通道**，
 * 而 MSM 的唯一合法调用入口是 `msm` 工具（单入口纪律）——不给它 `msm` 就等于
 * 声明了一堆调不动的能力。⚠️ 这是**并集**，不是覆盖：`tools` 里显式写的照旧生效。
 */
export function profileToolWhitelist(profile: SkiffProfile | null | undefined): Set<string> {
  const out = new Set<string>()
  for (const t of profile?.tools ?? []) out.add(t)
  if ((profile?.msms?.length ?? 0) > 0) out.add('msm')
  return out
}

/** 该 skiff 会话可 exec 的 MSM 白名单（`msm` 工具内部再过滤；独立于工具白名单） */
export function profileMsmWhitelist(profile: SkiffProfile | null | undefined): Set<string> {
  return new Set(profile?.msms ?? [])
}

/** 轨迹纪律参与项（`profile` 缺省已在 `readSkiffProfileAt` 归一为全 true） */
export function profileCognitiveTrajectory(
  profile: SkiffProfile | null | undefined,
): { session: boolean; keeper: boolean; rebuild: boolean } {
  return {
    session: profile?.cognitiveTrajectory.session === true,
    keeper: profile?.cognitiveTrajectory.keeper === true,
    rebuild: profile?.cognitiveTrajectory.rebuild === true,
  }
}

// ── 系统提示词 ──────────────────────────────────────────────────────────────

/**
 * 解析约束面声明的**系统提示词全文**（一次性读取；`create` / `validate` / `list` 用）。
 *
 * 顺序：`systemPromptFile`（**推荐**：超长提示词在 JSON 里内嵌不可读）→ 内嵌 `systemPrompt` → 空串。
 * 文件缺失/逃逸 ⇒ **抛错**（调用方 catch 降级；`validate` 据此报 issue）。
 *
 * ⚠️ 热路径**不用**它（那会用每次工具调用去读盘）——热路径用 `createProfilePromptReader`。
 */
export function resolveProfileSystemPrompt(root: string, profile: SkiffProfile | null | undefined): string {
  if (!profile) return ''
  const file = profile.systemPromptFile?.trim()
  if (file) {
    const abs = resolveInside(root, file) // 逃逸 → throw
    if (!existsSync(abs)) {
      throw new Error(`skiff "${profile.code}": systemPromptFile "${file}" not found (resolved: ${abs})`)
    }
    return readUtf8(abs).trim()
  }
  return profile.systemPrompt ?? ''
}

/** 提示词来源（`list`/`validate` 展示用） */
export function profileSystemPromptSource(profile: SkiffProfile | null | undefined): 'file' | 'inline' | 'none' {
  if (profile?.systemPromptFile?.trim()) return 'file'
  if (profile?.systemPrompt?.trim()) return 'inline'
  return 'none'
}

/**
 * 提示词**读取器**（长期热更新；改文件即生效，无需重启）。
 *
 * 为什么返回函数而不是字符串（R↓，实证代价）：旧实现在创建时把提示词**快照**进系统提示词段闭包
 * ⇒ CCC 改了提示词文件必须重启 dsh web 才生效（实测：改完 18KB 提示词，live agent 仍用旧文本）。
 * 现形态由系统提示词段的 `text()` **每轮调用**本读取器：
 *   - `systemPromptFile`：按 **mtime + size** 缓存重读（命中缓存零 IO；未变不解析）
 *   - 内嵌 `systemPrompt`：静态（改 JSON 仍需重载配置，这与文件热更的差别是**必然**的 —— 文件有 mtime，JSON 没有）
 *   - 读取失败：返回**上次成功内容**（⛔ 绝不返回空——空提示词会让角色失去人格与纪律），并按标签去重告警一次
 *
 * @param root CCC 根
 * @param profile 约束面
 */
export function createProfilePromptReader(root: string, profile: SkiffProfile | null | undefined): () => string {
  const file = profile?.systemPromptFile?.trim()
  if (!file) {
    const inline = profile?.systemPrompt ?? ''
    return () => inline
  }
  let abs: string | null = null
  try {
    abs = resolveInside(root, file) // 逃逸 → 抛错（此处降级为空读取器 + 告警）
  } catch (err) {
    console.warn(`[serenity-hooks] ✗ skiff 提示词路径非法（${file}）: ${String((err as Error)?.message ?? err)}`)
  }
  if (abs === null) return () => ''
  const absPath: string = abs
  let cachedMtime = -1
  let cachedSize = -1
  let cachedText = ''
  let warned = false
  return () => {
    try {
      const st = statSync(absPath)
      if (st.mtimeMs === cachedMtime && st.size === cachedSize) return cachedText
      const text = readUtf8(absPath).trim()
      const isReload = cachedMtime !== -1
      cachedMtime = st.mtimeMs
      cachedSize = st.size
      cachedText = text
      warned = false
      if (isReload) {
        console.info(`[serenity-hooks] ↻ skiff 提示词已热重载（${file}，${text.length} 字符）`)
      }
      return text
    } catch (err) {
      if (!warned) {
        warned = true
        console.warn(
          `[serenity-hooks] ✗ skiff 提示词读取失败（${file}）——沿用上次成功内容: ${String((err as Error)?.message ?? err)}`,
        )
      }
      return cachedText
    }
  }
}

/**
 * skiff 基础提示词（dsp 只给这部分；CCC 的 `systemPrompt` 段由调用方拼接）。
 *
 * ## 🔴 为什么**不再枚举**清单（owner 2026-10-19 令）
 *
 * 旧版在这里抄了两份清单（`MSMs: a, b, c` / `Tools: read, grep, …`）。那是**第二真相源**，
 * 而真相源本来就在模型自己手里：
 *   · **工具清单** = 这一轮实际注册给它的 tool schema —— 模型已经看得见，抄一遍只会漂
 *   · **MSM 清单** = `msm()` 无参调用返回的目录 —— 已按白名单过滤，且**每次实时读配置**
 *
 * ⚠️ **漂移不是理论风险，是已发生的缺陷**（2026-10-19）：角色配置早就长到 8 个工具，
 * 而这个函数是从**创建时冻结的快照**求值的 ⇒ 提示词里一直写着旧的 4 个
 * ⇒ 模型照着提示词办事，**它自己以为没有的能力就不去调** ⇒ 症状是"工具用不了"，
 * 而守卫那边（每调用实时读配置）其实是放行的。两个真相源打架，输的总是提示词。
 *
 * ⇒ 现在只声明**边界与发现路径**，不抄内容：清单在哪，怎么取，越界会怎样。
 *
 * @param code 轨迹编码（skiff 的身份 —— 不是"角色名"，那个概念已退役）
 */
export function buildSkiffBasePrompt(code: string): string {
  return [
    '=== Serenity Skiff ===',
    `Cognitive trajectory: ${code} (this is the trajectory you ARE, not a role you play)`,
    'Your capability boundary is enforced mechanically by this CCC — anything outside it is rejected at the call site, not by your judgment.',
    'Discover your surface, do not memorize it (both are generated from the live config on every turn):',
    '  · Your tools are exactly the tool schemas you see in this session — if a tool is not in your schema, it is not available.',
    '  · Your MSMs are listed by calling msm() with no arguments — that directory is already filtered to this trajectory.',
    '  · Usage for any MSM: msm("<name>", [], inspect=true) or pass "--help" as the first argument.',
    'Do not infer unavailability from anything you remember or from an earlier list: this surface changes when the CCC configuration changes, and it takes effect without restarting.',
    '',
    '---',
    '',
  ].join('\n')
}
