/**
 * git-ops.ts — cc_git 纯操作层（零 DSH 依赖）
 *
 * status / commit / push / log；push 非快进时输出操作建议（绝不自动 force）。
 */

import { execFileSync } from 'node:child_process'
import { checkLocalstoreGitCompliance } from './localstore-ops.js'
import type { JsonValue } from './json.js'

export type GitAction = 'status' | 'commit' | 'push' | 'log'

export const GIT_ACTIONS: readonly GitAction[] = ['status', 'commit', 'push', 'log']

export interface GitArgs {
  action: GitAction
  message?: string
  count?: number
}

function git(root: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('git', args, { cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
    return { ok: true, stdout, stderr: '' }
  } catch (err: any) {
    return { ok: false, stdout: err.stdout?.toString() ?? '', stderr: err.stderr?.toString() ?? '' }
  }
}

export function runGit(root: string, args: GitArgs): JsonValue {
  switch (args.action) {
    case 'status': {
      // -c core.quotepath=false：中文/空格路径按原文输出（默认 C 风格八进制转义，
      //   agent 拿转义串做后续路径操作会踩坑，见 Windows 兼容审计观察点 B）
      const r = git(root, ['-c', 'core.quotepath=false', 'status', '--porcelain'])
      if (!r.ok) throw new Error(`status 失败：${r.stderr.trim()}`)
      const out: Record<string, unknown> = {
        clean: r.stdout.trim() === '',
        entries: r.stdout.trim() ? r.stdout.trim().split('\n') : [],
      }
      // localstore git 联动（S134）：deny 且 .gitignore 未覆盖 → status 输出 warning（不阻断）
      const ls = checkLocalstoreGitCompliance(root)
      if (!ls.ok) out.warning = ls.reason
      return out as JsonValue
    }
    case 'commit': {
      // localstore git 联动（S134 第二道防线）：文件存在 && deny && .gitignore 未覆盖
      // → 拒绝 commit（第一道 = localstore 写入时自动写 .gitignore 物理保证）
      const ls = checkLocalstoreGitCompliance(root)
      if (!ls.ok) throw new Error(ls.reason)
      if (!args.message) throw new Error('commit 需要 message')
      const add = git(root, ['add', '-A'])
      if (!add.ok) throw new Error(`git add 失败：${add.stderr.trim()}`)
      const commit = git(root, ['commit', '-m', args.message])
      if (!commit.ok) {
        if (commit.stderr.includes('nothing to commit')) return { committed: false, reason: 'nothing to commit' }
        throw new Error(`git commit 失败：${commit.stderr.trim()}`)
      }
      return { committed: true, message: args.message }
    }
    case 'push': {
      const r = git(root, ['push', 'origin', 'HEAD'])
      if (r.ok) return { pushed: true }
      const isNonFF = /non-fast-forward|rejected|fetch first|被拒绝/i.test(r.stderr)
      const out: Record<string, unknown> = {
        pushed: false,
        nonFastForward: isNonFF,
        stderr: r.stderr.trim(),
      }
      if (isNonFF) {
        out.suggestion =
          '1. git pull --rebase  # 先合并远程变更\n2. 重新 push\n3. 若确需覆盖远程：git push --force-with-lease（人工确认后）'
      }
      return out as JsonValue
    }
    case 'log': {
      const n = args.count ?? 10
      const r = git(root, ['-c', 'core.quotepath=false', 'log', '--oneline', '-n', String(n)])
      if (!r.ok) throw new Error(`git log 失败：${r.stderr.trim()}`)
      return { entries: r.stdout.trim() ? r.stdout.trim().split('\n') : [] }
    }
    default:
      throw new Error(`未知 action: ${args.action as string}`)
  }
}
