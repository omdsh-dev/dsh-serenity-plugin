/**
 * session-cleanup.ts — DSH 平台旧会话自动清理（v1.29，S142 需求③）
 *
 * 背景（实证）：DSH 会话物理存储 = `$DSH_HOME/sessions/`（缺省 ~/.dsh/sessions；
 * base bundle cordis.patch.yml root: dshHomePath('sessions')）。磁盘布局：
 *   <root>/--<project-slug>--/<encoded-session-id>/session[.vN].jsonl(.zstd)
 * **世代（v1.31.13 补）**：宿主自 DSH 0.1.5 起按世代写文件，且迁移**保留源文件**
 * ⇒ 一个会话目录常见 v0 与 v3 两个文件并存。本模块用 `sessionLogArtifacts()` 统一枚举世代。
 * DSH **无删除会话 API**（PersistenceCoordinator 仅 create/append/load/inspect/borrow，
 * 无 delete/purge；workspace archiveSession 只加归档集不删文件）——物理删除只能直接
 * 删文件。删除后一致性（利好）：sessionPersistence.list() = readdir 扫描磁盘现存 →
 * 物理删后 list 不再返回；WorkspaceRegistry 下次启动重建 header index 自动消失。
 *
 * 方案（S142 用户拍板）：lastActive 基准 + 手动触发 + 不过滤不归档直接物理删；
 * 安全底线 = live 会话保护跳过（删正在运行的会话 = 灾难）。
 *
 * 本模块纯逻辑（零 ctx 依赖）：传入 sessionsRoot + liveIds，可单测。
 */

import { existsSync, readdirSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** DSH 会话 root：env DSH_HOME → ~/.dsh（config-ops globalConfigPath 同款推导） */
export function sessionsRootDir(): string {
  const dshHome = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
  return join(dshHome, 'sessions')
}

/** 一天的毫秒数 */
const DAY_MS = 24 * 60 * 60 * 1000

/** 一个候选会话（删除前预览信息） */
export interface CandidateSession {
  /** 会话 id（目录名） */
  id: string
  /** 项目目录（父目录名，如 --home-yh-home-home-serenity--） */
  project: string
  /** 会话日志文件绝对路径 */
  logPath: string
  /** 最后活动（mtime 退化——日志只追加，mtime ≈ 最后写） */
  lastActiveMs: number
}

/**
 * 扫描 sessions root，列出可清理候选：
 * - 递归 `<root>/<project>/<session-id>/session.jsonl(.zstd)`（任意深度下找 *session* 文件）
 * - 过滤 live（liveIds 集合）——安全底线
 * - 过滤 lastActive >= cutoffMs（最后活动未达阈值 → 保留）
 * root 不存在/为空 → 返回 []（非错误）。
 */
export function collectEligibleSessions(
  root: string,
  cutoffMs: number,
  liveIds: ReadonlySet<string> = new Set(),
): CandidateSession[] {
  if (!existsSync(root)) return []
  const out: CandidateSession[] = []
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const projectPath = join(root, project.name)
    for (const entry of readdirSync(projectPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dirPath = join(projectPath, entry.name)
      // 只认会话目录（含任意世代日志 session[.vN].jsonl[.zstd]）
      const artifacts = sessionLogArtifacts(dirPath)
      if (artifacts.length === 0) continue
      const log = findSessionLog(dirPath)
      if (log === null) continue
      if (liveIds.has(entry.name)) continue // live 保护
      // lastActive = **全部世代的最大 mtime**（保守：任一世代被写过就算"最近活动"，
      // 避免多世代并存时因只看当前世代而误删仍在写入的会话）
      let mtime = Number.NEGATIVE_INFINITY
      for (const artifact of artifacts) {
        try {
          mtime = Math.max(mtime, statSync(artifact.path).mtimeMs)
        } catch {
          /* 文件消失/不可读 → 跳过该世代（竞态） */
        }
      }
      if (!Number.isFinite(mtime)) continue
      if (mtime >= cutoffMs) continue // 最后活动未达阈值
      out.push({ id: entry.name, project: project.name, logPath: log, lastActiveMs: mtime })
    }
  }
  return out
}

/**
 * 会话日志文件名识别：`session.jsonl` / `session.jsonl.zstd`（= **v0 世代**）/
 * `session.v<N>.jsonl[.zstd]`（= 第 N 世代，DSH 0.1.5 起按世代写文件）。
 * 出处：`@deepseek-ai/dsh-session-persistence-jsonl` 的 `parseSessionFormatLogFilename` 同款形态。
 */
const SESSION_LOG_RE = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/

/**
 * 列出会话目录下的**全部日志世代**，按代递增排序（同代内 `.jsonl` 在前、`.zstd` 在后 = 后者更代表"当前书写格式"）。
 *
 * 为什么需要（R↓，v1.31.13 修复）：宿主自 0.1.5 起改成**按世代写文件**，且迁移**保留源文件**
 * ⇒ 同一会话常见 `session.jsonl.zstd`（v0）与 `session.v3.jsonl.zstd`（v3）**并存**。
 * 旧实现只认前两个名字 → 新格式会话对本模块**完全不可见**（静默 no-op：清理永远不生效、磁盘只涨）。
 */
export function sessionLogArtifacts(sessionDirPath: string): Array<{ name: string; generation: number; path: string }> {
  let names: string[]
  try {
    names = readdirSync(sessionDirPath)
  } catch {
    return [] // 目录不可读/消失 → 视为无日志（竞态）
  }
  const out: Array<{ name: string; generation: number; path: string }> = []
  for (const name of names) {
    const m = SESSION_LOG_RE.exec(name)
    if (m === null) continue
    out.push({ name, generation: m[1] === undefined ? 0 : Number(m[1]), path: join(sessionDirPath, name) })
  }
  return out.sort((a, b) => a.generation - b.generation
    || (a.name.endsWith('.zstd') ? 1 : 0) - (b.name.endsWith('.zstd') ? 1 : 0))
}

/**
 * 在会话目录下找 session 日志文件；无 → null。
 * 多世代并存时返回**最高世代**（= 宿主 `findLog` 选中的当前世代；旧行为对单文件目录完全一致）。
 */
export function findSessionLog(sessionDirPath: string): string | null {
  const artifacts = sessionLogArtifacts(sessionDirPath)
  const latest = artifacts[artifacts.length - 1]
  return latest === undefined ? null : latest.path
}

/** 删除执行结果 */
export interface CleanupResult {
  deleted: string[]
  /** 尝试删除但失败的会话目录（权限/竞态） */
  errors: Array<{ id: string; reason: string }>
}

/**
 * 执行清理（用户拍板：直接物理删，不过滤不归档；dryRun 预览不删）。
 * 删除 = rmSync 整个会话目录（recursive + force）。失败逐个记 errors 不中断。
 */
export function performCleanup(
  root: string,
  cutoffMs: number,
  liveIds: ReadonlySet<string> = new Set(),
  opts: { dryRun?: boolean } = {},
): { candidates: CandidateSession[]; result: CleanupResult | null } {
  const candidates = collectEligibleSessions(root, cutoffMs, liveIds)
  if (opts.dryRun) return { candidates, result: null }
  const result: CleanupResult = { deleted: [], errors: [] }
  for (const c of candidates) {
    const dir = dirOf(c.logPath)
    try {
      rmSync(dir, { recursive: true, force: true })
      result.deleted.push(c.id)
    } catch (e) {
      result.errors.push({ id: c.id, reason: (e as Error).message })
    }
  }
  return { candidates, result }
}

/** 从日志路径取会话目录（父目录） */
function dirOf(logPath: string): string {
  return logPath.slice(0, logPath.lastIndexOf('/')) || logPath
}

/** 便捷：默认 N 天前为 cutoff（供 API/调用方） */
export function cutoffDaysAgo(days: number, nowMs = Date.now()): number {
  return nowMs - days * DAY_MS
}
