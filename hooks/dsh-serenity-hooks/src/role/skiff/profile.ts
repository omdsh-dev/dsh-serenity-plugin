/**
 * role/skiff/profile.ts — **skiff 的唯一判据**：目录下有 `skiff.json` 的认知轨迹（零 DSH 依赖，可独立单测）
 *
 * ## 🔴 owner 2026-10-19 重做令（逐字，本文件存在的全部理由）
 *
 * > 「skiff 复杂的约束和提示词体系都干掉，改为这样的实现：
 * > **skiff 本身是认知轨迹的一个特殊情况，即目录下拥有 `skiff.json` 的认知轨迹自动是一个 skiff**
 * > （json 里配置上个版本就有的各种约束），**会话跑在认知轨迹上且发现 `skiff.json`，则运行时实现各类约束**」
 *
 * ## 旧模型 → 新模型（**一条判据取代四条**）
 *
 * | 项 | 旧 | 新 |
 * |---|---|---|
 * | skiff 是什么 | `serenity.json` 的 `skiff.roles.<name>` 一条配置 | **轨迹目录里有 `skiff.json`** |
 * | 怎么认出 skiff 会话 | dsh sessionId 前缀 `skiff-` | **它绑定的轨迹有 `skiff.json`** |
 * | 工作台从哪来 | `ensureSkiffSession` 另建一个 SESSION | **就是该轨迹自己的 SESSION.md** |
 * | 身份 | 角色名 | **轨迹编码**（`trajectory/core.ts` 的 `parseTrajectoryCode`） |
 *
 * ⇒ 收益（owner：「理解难度大幅下降」的实际内容）：四个各自会漂的机制收敛为**一条文件存在性判据**。
 * 删掉 `skiff.json` ⇒ 该轨迹**当场**退化为普通轨迹（工具面、提示词、keeper 全部恢复默认）。
 *
 * ## 归属（D23）
 * **机制在 ACC**（文件叫什么、怎么读、怎么判、缺省值、如何施加约束）；
 * **内容在 CCC**（`skiff.json` 里填什么：模型、白名单、提示词路径）。
 * ⇒ ACC 代码里**不出现任何具体角色名**，也不读 `serenity.json` 的 skiff 段（该段已退役）。
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readUtf8, resolveInside } from '../../kernel/ccc.js'
import { parseTrajectoryCode, sessionsRoot } from '../../trajectory/core.js'
import { skiffTrajectoryDirNameFor } from './registry.js'

/** `skiff.json` 的固定文件名（**判据就是它存在**——不是目录名前缀，也不是配置里的一行） */
export const SKIFF_PROFILE_FILENAME = 'skiff.json'

/**
 * 一个 skiff 轨迹的**完整约束面**（= 旧 `skiff.roles.<name>` 那套，整体搬进轨迹目录）。
 *
 * ⚠️ 与旧配置的**一处有意语义翻转**（R↓，别当成"顺手改默认值"）：
 * `cognitiveTrajectory.*` 在旧模型里**缺省全 false**（"skiff 完全独立"），理由是
 * **它的工作台是外挂的**（`ensureSkiffSession` 另建一个 SESSION，不由轨迹承载）。
 * 新模型里**工作台就是它自己的 SESSION.md** ⇒ 全 false 会让它拿不到自己的身体
 * ⇒ **缺省翻成 true**。这不是偏好问题，是两个模型的结构差。
 */
export interface SkiffProfile {
  /** 该约束面所属轨迹的目录名（`YYYY-MM-DD--<code>[--<desc>]`） */
  dirName: string
  /** 轨迹编码（= 唯一标识；见 `parseTrajectoryCode`） */
  code: string
  /** `skiff.json` 的绝对路径 */
  path: string
  /** 模型（`provider/model`）；缺省回退 `cheap-worker.defaultModel` */
  model?: string
  /** 非 MSM 工具白名单（白名单外**从 schema 移除**，不是"看得见调不动"） */
  tools: string[]
  /** MSM 白名单（`msm()` 单入口内再过滤） */
  msms: string[]
  /** 轨迹纪律参与项（**缺省全 true**，见上方 R↓） */
  cognitiveTrajectory: { session: boolean; keeper: boolean; rebuild: boolean }
  /** 内嵌提示词（`systemPromptFile` 为空时用） */
  systemPrompt?: string
  /** 提示词文件（相对 CCC 根；**优先于** `systemPrompt`） */
  systemPromptFile?: string
}

/**
 * 已告警过的坏 `skiff.json`（进程级去重：同一坏文件不刷屏，但**绝不静默**）。
 *
 * 🔴 为什么必须响亮（同源先例 = `loadSerenityConfig` 的 F-07）：一份坏 JSON 会让
 * **工具白名单静默失效**——而白名单正是 skiff 的权限边界 ⇒ 静默 = 权限面悄悄放开或收死，
 * 两种都查不到原因。
 */
const warnedBrokenProfiles = new Set<string>()

/** 活跃轨迹目录名（跳过 `_`/`.` 前缀 —— 归档区与日志区不是轨迹；判据同 `readAllSessions`） */
function activeTrajectoryDirNames(root: string): string[] {
  try {
    return readdirSync(sessionsRoot(root), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort()
  } catch {
    return [] // 没有 AGENT_SESSIONS/ = 没有轨迹（常态，不是错误）
  }
}

/**
 * 读一个目录下的 `skiff.json`（**纯读，不施加约束**）。
 *
 * @param trajectoryDir 轨迹目录绝对路径
 * @param root CCC 根（仅用于 `systemPromptFile` 的逃逸拒绝）
 * @returns 归一后的约束面；**无该文件 → `null`（= 这不是 skiff，常态，不是错误）**
 *
 * ⚠️ **形态容错**：数组元素非字符串 → 丢弃该项（不整份作废）；`cognitiveTrajectory`
 * 缺项 → 各自取 **true**（见 R↓）；`model` 空白 → undefined（回退缺省）。
 * 坏 JSON ⇒ 告警 + `null`（**按"不是 skiff"处理**：宁可让它退回普通轨迹，也不要带着
 * 半份读不懂的权限面运行）。
 */
export function readSkiffProfileAt(trajectoryDir: string, root: string): SkiffProfile | null {
  const dirName = trajectoryDir.split('/').filter(Boolean).pop() ?? ''
  const code = parseTrajectoryCode(dirName)
  if (code === null) return null
  const file = join(trajectoryDir, SKIFF_PROFILE_FILENAME)
  if (!existsSync(file)) return null
  let raw: unknown
  try {
    raw = JSON.parse(readUtf8(file))
  } catch (err) {
    if (!warnedBrokenProfiles.has(file)) {
      warnedBrokenProfiles.add(file)
      console.warn(
        `[serenity-hooks] ✗ ${SKIFF_PROFILE_FILENAME} 解析失败 ⇒ 该轨迹**按普通轨迹处理**（工具白名单与提示词约束全部不施加）。请修 JSON: ${file} — ${String((err as Error)?.message ?? err)}`,
      )
    }
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    if (!warnedBrokenProfiles.has(file)) {
      warnedBrokenProfiles.add(file)
      console.warn(`[serenity-hooks] ✗ ${SKIFF_PROFILE_FILENAME} 顶层不是对象 ⇒ 按普通轨迹处理: ${file}`)
    }
    return null
  }
  const obj = raw as Record<string, unknown>
  const strList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : []
  /** 布尔缺省 **true**（R↓ 见接口：工作台就是这条轨迹自己的身体） */
  const boolOrTrue = (v: unknown): boolean => (typeof v === 'boolean' ? v : true)
  const ct = (obj.cognitiveTrajectory && typeof obj.cognitiveTrajectory === 'object')
    ? obj.cognitiveTrajectory as Record<string, unknown>
    : {}
  const model = typeof obj.model === 'string' && obj.model.trim() !== '' ? obj.model.trim() : undefined
  const systemPrompt = typeof obj.systemPrompt === 'string' ? obj.systemPrompt : undefined
  const rawFile = typeof obj.systemPromptFile === 'string' ? obj.systemPromptFile.trim() : ''
  // `systemPromptFile` **只做逃逸拒绝**（不在这里读文件：读取有它自己的 mtime 缓存与热重载路径）。
  // 逃逸 ⇒ 当作没配（告警），而不是让一个越界路径把整个会话的提示词弄空。
  let systemPromptFile: string | undefined
  if (rawFile !== '') {
    try {
      resolveInside(root, rawFile) // 逃逸 → throw
      systemPromptFile = rawFile
    } catch (err) {
      console.warn(
        `[serenity-hooks] ✗ ${SKIFF_PROFILE_FILENAME} 的 systemPromptFile 越界，已忽略（其余约束仍生效）: ${file} — ${String((err as Error)?.message ?? err)}`,
      )
    }
  }
  return {
    dirName,
    code,
    path: file,
    ...(model !== undefined ? { model } : {}),
    tools: strList(obj.tools),
    msms: strList(obj.msms),
    cognitiveTrajectory: {
      session: boolOrTrue(ct.session),
      keeper: boolOrTrue(ct.keeper),
      rebuild: boolOrTrue(ct.rebuild),
    },
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(systemPromptFile !== undefined ? { systemPromptFile } : {}),
  }
}

/**
 * 按**轨迹编码**解析 skiff 约束面（`list`/`admin`/调试页/路由解析用）。
 *
 * @returns 约束面；轨迹不存在 ／ 无 `skiff.json` → `null`
 */
export function readSkiffProfileByCode(root: string, code: string): SkiffProfile | null {
  const dirName = findDirNameByCode(root, code)
  if (dirName === null) return null
  return readSkiffProfileAt(join(sessionsRoot(root), dirName), root)
}

/** 扫全部活跃轨迹，返回全部 skiff。**顺序按目录名**（确定性，便于对读）。 */
export function listSkiffProfiles(root: string): SkiffProfile[] {
  const out: SkiffProfile[] = []
  for (const name of activeTrajectoryDirNames(root)) {
    const p = readSkiffProfileAt(join(sessionsRoot(root), name), root)
    if (p) out.push(p)
  }
  return out
}

/**
 * 编码 → 轨迹目录名（活跃轨迹内）。找不到 → `null`。
 *
 * ⚠️ 与 `findSession` 的分工：这里**只按编码精确**匹配（不做模糊），
 * 因为它的调用方（路由 / 约束施加）要的是**确定性**，模糊匹配会把"手抖打错的名字"
 * 静默投到一条相近的轨迹上——那正是最难查的一类串味。
 */
export function findDirNameByCode(root: string, code: string): string | null {
  for (const name of activeTrajectoryDirNames(root)) {
    if (parseTrajectoryCode(name) === code) return name
  }
  return null
}

/**
 * **会话级**判据（J2）：这个 dsh 会话是不是 skiff 会话 —— 唯一入口。
 *
 * 判据 = **它绑定的轨迹有 `skiff.json`**（不是 sessionId 前缀，也不是配置里有没有角色）。
 *
 * ## 为什么"绑定的轨迹"从两个来源取（R↓，一个失败模式）
 * ① **持久绑定**（`readLastBound`，宿主存储域/`.bindings.json`）—— 权威，跨重启成立；
 * ② **内存注册表**（`skiff/registry`）—— 覆盖绑定的**窗口期**（轨迹刚定、bound 还没落盘）。
 * ⇒ 只取 ① 会在建会话的第一轮判成"不是 skiff"（工具面不收窄，模型看见不该有的工具）；
 *    只取 ② 会在进程重启后全判成"不是"（skiff 失去约束，**权限面静默放开**）。
 * ⇒ **两来源并取**，都不中才 `null`。
 *
 * @param root CCC 根
 * @param sessionId dsh 会话 id
 * @param boundDirName 调用方已解析的绑定目录名（可选；给了就省一次读绑定）
 * @returns 约束面；不是 skiff 会话 → `null`
 */
export function skiffProfileForSession(
  root: string,
  sessionId: string | undefined,
  boundDirName?: string | null,
): SkiffProfile | null {
  const dirName = boundDirName ?? registeredDirName(sessionId)
  if (dirName === null || dirName === '') return null
  return readSkiffProfileAt(join(sessionsRoot(root), dirName), root)
}

/** 内存登记的轨迹目录名（注册表单一真相源在 `./registry.ts`；此处只做一次转发） */
function registeredDirName(sessionId: string | undefined): string | null {
  if (typeof sessionId !== 'string' || sessionId === '') return null
  return skiffTrajectoryDirNameFor(sessionId)
}

/**
 * 该 dsh 会话**是不是** skiff 会话（布尔形态的 `skiffProfileForSession`）。
 *
 * 存在的理由：调用点很多只要一个"是/不是"（seams 的旁路判定），
 * 让它们各自写 `!== null` 会把判据散开；**判据只能有一个入口**。
 */
export function isSkiffSession(root: string, sessionId: string | undefined): boolean {
  return skiffProfileForSession(root, sessionId) !== null
}
