/**
 * im/log-scan.ts — 读聊天记录落盘，汇总出「与谁有过往来」（`contacts` 的数据源）
 *
 * ## 这个文件解决什么
 *
 * owner 2026-10-22：「配路由需要的是**账户到轨迹**，轨迹 CCC 知道，**账户 CCC 不知道**，
 * 需要有个能力让 CCC 查询用户配好的账户」。这里的"账户"= **通道用户**（对方是谁），
 * 不是 IM 账号（我们自己登录的身份，`status` 早就能查）。
 *
 * 那个 id（微信 `xxx@im.wechat` / 飞书 `ou_…`）不在任何配置文件里 ——
 * 它**只在聊天记录里出现过**。⇒ 本文件把记录读成联系人表。
 *
 * ## 🔴 两条硬边界
 *
 * 1. **只读**：本文件不写任何东西。真相源仍是那些 jsonl（append-only 事件流），
 *    本文件只是它的一次投影 —— ⛔ 不产生第二真相源。
 * 2. **不猜渠道**：事件的 `channel` 字段为准；缺它（存量事件）⇒ 按
 *    `accountId → im.accounts[].channel` 回填，仍取不到才落 `weixin`
 *    （那是该字段存在之前唯一的渠道）。⛔ **绝不按 userId 的形状猜**
 *    （`ou_` 前缀 / `@im.wechat` 后缀都是命名习惯，不是判据 —— D167 认族不认名）。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** 日志根目录族（**新旧两代并存**：`_im-logs/<channel>/` 与存量 `_weixin-logs/`） */
export const IM_LOG_DIR_NEW = '_im-logs'
export const IM_LOG_DIR_LEGACY = '_weixin-logs'

/** 一条原始事件里我们关心的那几个字段（其余忽略） */
interface RawImEvent {
  event?: string
  ts?: number
  channel?: string
  accountId?: string
  userId?: string
  role?: string
}

/** 汇总结果（可 JSON 化） */
export interface ScannedContact {
  channel: string
  userId: string
  accountIds: string[]
  /** 事件里记录的路由目标（`role` 字段；它是事件发生当时的轨迹编码，未必等于**当前**路由） */
  roleAtEvent: string | null
  firstSeen: number | null
  lastSeen: number | null
  messages: number
}

/** 扫描结果（含**扫描域**——否定性结论必须附它） */
export interface ScanResult {
  contacts: ScannedContact[]
  /** 实际读过的文件（相对 CCC 根） */
  sources: string[]
  /** 读失败的文件及其原因（不静默） */
  errors: string[]
}

/** 某 CCC 下**存在**的日志目录（相对根），新代在前 */
export function imLogRoots(root: string): string[] {
  const out: string[] = []
  const newBase = join(root, 'AGENT_SESSIONS', IM_LOG_DIR_NEW)
  const legacy = join(root, 'AGENT_SESSIONS', IM_LOG_DIR_LEGACY)
  if (existsSync(newBase)) {
    out.push(join('AGENT_SESSIONS', IM_LOG_DIR_NEW))
  }
  if (existsSync(legacy)) out.push(join('AGENT_SESSIONS', IM_LOG_DIR_LEGACY))
  return out
}

/** 收集某个日志根下所有 `*.jsonl`（含 `_im-logs/<channel>/` 一层；按文件名排序） */
function jsonlFilesIn(root: string, rel: string): string[] {
  const abs = join(root, rel)
  const out: string[] = []
  let entries: string[] = []
  try {
    entries = readdirSync(abs, { withFileTypes: true }).map((d) => d.name)
  } catch {
    return out
  }
  for (const name of entries.sort()) {
    if (name.startsWith('.')) continue
    if (name.endsWith('.jsonl')) {
      out.push(join(rel, name))
      continue
    }
    // `_im-logs/<channel>/YYYY-MM-DD.jsonl`：只下探一层（再深就不是日文件了）
    if (rel === join('AGENT_SESSIONS', IM_LOG_DIR_NEW)) {
      const sub = join(rel, name)
      try {
        for (const child of readdirSync(join(root, sub)).sort()) {
          if (child.endsWith('.jsonl')) out.push(join(sub, child))
        }
      } catch {
        /* 子目录读不了 ⇒ 跳过（不阻断其它目录） */
      }
    }
  }
  return out
}

/** 从文件名 / 所在目录猜渠道（**只作为回填的最后一级**，不是判据） */
function channelFromPath(rel: string): string | null {
  const parts = rel.split('/')
  // `AGENT_SESSIONS/_im-logs/<channel>/<day>.jsonl`
  const idx = parts.indexOf(IM_LOG_DIR_NEW)
  const candidate = idx >= 0 && parts.length > idx + 2 ? parts[idx + 1] : undefined
  return candidate !== undefined && candidate !== '' ? candidate : null
}

/**
 * 扫描本 CCC 的全部聊天记录，按 `(channel, userId)` 汇总。
 *
 * @param root CCC 根
 * @param accountChannel 存量事件缺 `channel` 时的回填表（`accountId → channel`）
 * @returns 汇总结果 ＋ **扫描域** ＋ 读取错误（三者都不可省）
 */
export function scanImContacts(
  root: string,
  accountChannel: Record<string, string> = {},
): ScanResult {
  const byKey = new Map<string, ScannedContact>()
  const sources: string[] = []
  const errors: string[] = []

  for (const rel of imLogRoots(root)) {
    for (const fileRel of jsonlFilesIn(root, rel)) {
      sources.push(fileRel)
      let text = ''
      try {
        text = readFileSync(join(root, fileRel), 'utf8')
      } catch (err) {
        errors.push(`${fileRel}: ${err instanceof Error ? err.message : String(err)}`)
        continue
      }
      const pathChannel = channelFromPath(fileRel)
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        let ev: RawImEvent
        try {
          ev = JSON.parse(trimmed) as RawImEvent
        } catch {
          // 单行损坏不该毁掉整档（这正是纯文本 jsonl 的好处）；记一行错误继续
          errors.push(`${fileRel}: 有 1 行不是合法 JSON（已跳过）`)
          continue
        }
        const userId = typeof ev.userId === 'string' ? ev.userId.trim() : ''
        if (userId === '') continue
        const accountId = typeof ev.accountId === 'string' ? ev.accountId.trim() : ''
        // 渠道优先级：事件自带 ⇢ 路径目录名 ⇢ accountId 回填表 ⇢ 存量默认 weixin
        const channel =
          (typeof ev.channel === 'string' && ev.channel.trim() !== '' ? ev.channel.trim() : null)
          ?? pathChannel
          ?? (accountId !== '' ? accountChannel[accountId] ?? null : null)
          ?? 'weixin'
        const key = `${channel}\u0000${userId}`
        let entry = byKey.get(key)
        if (!entry) {
          entry = {
            channel,
            userId,
            accountIds: [],
            roleAtEvent: null,
            firstSeen: null,
            lastSeen: null,
            messages: 0,
          }
          byKey.set(key, entry)
        }
        if (accountId !== '' && !entry.accountIds.includes(accountId)) entry.accountIds.push(accountId)
        if (typeof ev.role === 'string' && ev.role.trim() !== '') entry.roleAtEvent = ev.role.trim()
        const ts = typeof ev.ts === 'number' && Number.isFinite(ev.ts) ? ev.ts : null
        if (ts !== null) {
          if (entry.firstSeen === null || ts < entry.firstSeen) entry.firstSeen = ts
          if (entry.lastSeen === null || ts > entry.lastSeen) entry.lastSeen = ts
        }
        entry.messages += 1
      }
    }
  }

  const contacts = [...byKey.values()].sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0))
  return { contacts, sources, errors }
}
