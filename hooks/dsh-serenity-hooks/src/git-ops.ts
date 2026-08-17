/**
 * git-ops.ts — cc_git 纯操作层（零 DSH 依赖）
 *
 * 行为对齐 osp（opencode-serenity-plugin/src/git/cc-git-tool.ts）——osp 是 ACC 工具 spec：
 *   - status：JSON {clean, files:[{status,file}], summary}
 *   - commit：git add -A + commit -m；clean 返回 '(nothing to commit — working tree clean)'
 *   - push：无 remote 报错；非快进 → [REJECTED] + 操作建议（绝不自动 force）
 *   - pull：git fetch + merge --ff-only；up-to-date / [REJECTED] 建议
 *   - log：--oneline [-n <count>]
 *   - diff：git diff [--cached] [<ref>] [-- <path>]
 * 保留 dsp 增强：localstore git 合规联动（S134：deny 且 .gitignore 未覆盖 → status 提示 / commit 拒绝）。
 */

import { execFileSync } from 'node:child_process'
import { checkLocalstoreGitCompliance } from './localstore-ops.js'
import type { JsonValue } from './json.js'

export type GitAction = 'status' | 'commit' | 'push' | 'log' | 'pull' | 'diff'

export const GIT_ACTIONS: readonly GitAction[] = ['status', 'commit', 'push', 'log', 'pull', 'diff']

export interface GitArgs {
  action: GitAction
  message?: string
  /** log 条数（对齐 osp 参数 n，默认 10，max 100） */
  count?: number
  /** diff: 显示暂存区变更（--cached） */
  staged?: boolean
  /** diff: 对比 ref（如 HEAD~1 / main / origin/main） */
  ref?: string
  /** diff: 限定路径 */
  path?: string
}

/** git 操作超时（ms）——网络路径（push/pull/fetch）可能挂起（GCM 弹认证框等），
 *  无 timeout 会冻结 Node 事件循环 / DSH 3080 server（Windows 审计问题 12） */
const GIT_TIMEOUT_MS = 30_000

function git(root: string, args: string[]): { stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024,
      timeout: GIT_TIMEOUT_MS,
    })
    return { stdout: stdout.trimEnd(), stderr: '' }
  } catch (err: any) {
    return {
      stdout: (err.stdout?.toString() ?? '').trimEnd(),
      // 超时（err.killed）无 stderr——显式提示（调用方误判成功）
      stderr: err.killed
        ? `git 操作超时（${GIT_TIMEOUT_MS / 1000}s）`
        : (err.stderr?.toString() ?? '').trimEnd(),
    }
  }
}

function getCurrentBranch(root: string): string {
  const { stdout } = git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!stdout) throw new Error('cc_git: cannot determine current branch')
  return stdout
}

function hasChanges(root: string): boolean {
  const { stdout } = git(root, ['status', '--porcelain'])
  return stdout.length > 0
}

function hasRemote(root: string): boolean {
  const { stdout } = git(root, ['remote'])
  return stdout.length > 0
}

export function runGit(root: string, args: GitArgs): JsonValue {
  switch (args.action) {
    case 'status': {
      // -c core.quotepath=false：中文/空格路径按原文输出
      const r = git(root, ['-c', 'core.quotepath=false', 'status', '--porcelain'])
      if (r.stderr) throw new Error(`status 失败：${r.stderr.trim()}`)
      const lines = r.stdout ? r.stdout.split('\n') : []
      const files = lines.map((line) => {
        const status = line.slice(0, 2).trim() || '??'
        const file = line.slice(3)
        return { status, file }
      })
      const out: Record<string, unknown> = {
        clean: files.length === 0,
        files,
        summary: files.length === 0 ? '(clean)' : `${files.length} file(s) with changes`,
      }
      // localstore git 联动（S134）：deny 且 .gitignore 未覆盖 → status 输出提示（不阻断）
      const ls = checkLocalstoreGitCompliance(root)
      if (!ls.ok) out.warning = ls.reason
      return out as JsonValue
    }
    case 'commit': {
      // localstore git 联动（S134 第二道防线）：文件存在 && deny && .gitignore 未覆盖 → 拒绝 commit
      const ls = checkLocalstoreGitCompliance(root)
      if (!ls.ok) throw new Error(ls.reason)
      if (!args.message || args.message.trim() === '') {
        throw new Error('cc_git commit: missing required arg "message"')
      }
      if (!hasChanges(root)) return '(nothing to commit — working tree clean)'
      const addResult = git(root, ['add', '-A'])
      if (addResult.stderr) {
        throw new Error(`cc_git commit: git add failed\n${addResult.stderr}`)
      }
      const commitResult = git(root, ['commit', '-m', args.message])
      if (commitResult.stderr && commitResult.stderr.includes('nothing to commit')) {
        return '(nothing to commit — working tree clean)'
      }
      if (commitResult.stderr && !commitResult.stdout) {
        throw new Error(`cc_git commit: git commit failed\n${commitResult.stderr}`)
      }
      const output = commitResult.stdout || commitResult.stderr || 'committed'
      return output.trimEnd()
    }
    case 'push': {
      if (!hasRemote(root)) {
        throw new Error(
          'cc_git push: no remote configured. Add one with:\n  git remote add origin <url>',
        )
      }
      const branch = getCurrentBranch(root)
      try {
        git(root, ['fetch', 'origin', branch])
      } catch {
        // fetch failure is not fatal — proceed with push
      }
      const { stdout, stderr } = git(root, ['push', 'origin', branch])
      // 先检查拒绝（v1.18.8）：git push 拒绝输出 `! [rejected] branch -> branch (non-fast-forward)`
      // 含 `->`——旧逻辑先判 `stderr.includes('->')` 成功会把拒绝当成功（osp 同病，用户实测
      // non-fast-forward exit 1 却返回 "Pushed to ..."，提交从未上远程）
      if (stderr.includes('non-fast-forward') || stderr.includes('rejected') || stderr.includes('[rejected]')) {
        return `[REJECTED] Push to origin/${branch} was rejected (non-fast-forward).\n\n远程有新的提交，本地落后。操作建议：\n  1. 先用 bash: git fetch origin ${branch}\n  2. 查看远程变更: git log HEAD..origin/${branch}\n  3. 合并或变基: git merge origin/${branch} 或 git rebase origin/${branch}\n  4. 有冲突则手动解决后: git add ... && git commit\n  5. 再次推送: cc_git push`
      }
      if (!stderr || stderr.includes('->') || stderr === '') {
        return stdout || `Pushed to origin/${branch}`
      }
      throw new Error(`cc_git push failed:\n${stderr}`)
    }
    case 'pull': {
      if (!hasRemote(root)) {
        throw new Error(
          'cc_git pull: no remote configured. Add one with:\n  git remote add origin <url>',
        )
      }
      const branch = getCurrentBranch(root)
      const fetchResult = git(root, ['fetch', 'origin', branch])
      if (fetchResult.stderr) return `[WARN] fetch had stderr:\n${fetchResult.stderr}`
      const revResult = git(root, ['rev-list', '--count', 'HEAD..FETCH_HEAD'])
      if (revResult.stderr) return `[WARN] cannot check ahead count:\n${revResult.stderr}`
      if (revResult.stdout === '0' || revResult.stdout === '') return 'Already up to date.'
      const mergeResult = git(root, ['merge', '--ff-only', 'FETCH_HEAD'])
      if (!mergeResult.stderr) {
        const msg = mergeResult.stdout || 'Pulled successfully.'
        return msg.endsWith('\n') ? msg.trimEnd() : msg
      }
      if (
        mergeResult.stderr.includes('non-fast-forward') ||
        mergeResult.stderr.includes('Not possible to fast-forward') ||
        mergeResult.stderr.includes('rejected') ||
        mergeResult.stderr.includes('could not be applied')
      ) {
        return `[REJECTED] Pull from origin/${branch} was rejected (non-fast-forward).\n\n远程有新的提交，本地的历史与远程产生了分歧（非快进）。操作建议：\n  1. 查看差异: cc_git log HEAD..origin/${branch}\n  2. 用 bash 手动合并: git merge origin/${branch}\n  3. 或用 rebase: git rebase origin/${branch}\n  4. 有冲突则手动解决后: git add <file> && git commit\n  5. 推送: cc_git push`
      }
      throw new Error(`cc_git pull failed:\n${mergeResult.stderr}`)
    }
    case 'log': {
      // 对齐 osp：-n 默认 10，max 100（运行时兜底 + schema minimum/maximum 双保险）
      const n = Math.min(Math.max(args.count ?? 10, 1), 100)
      const r = git(root, ['-c', 'core.quotepath=false', 'log', '--oneline', '-n', String(n)])
      if (r.stderr) throw new Error(`git log 失败：${r.stderr.trim()}`)
      if (!r.stdout) return '(no commits)'
      return r.stdout
    }
    case 'diff': {
      const diffArgs: string[] = ['diff']
      if (args.staged) diffArgs.push('--cached')
      if (args.ref) diffArgs.push(args.ref)
      if (args.path) diffArgs.push('--', args.path)
      const { stdout, stderr } = git(root, diffArgs)
      if (stderr) return `[WARN] git diff had stderr:\n${stderr}`
      if (!stdout) return '(no diff)'
      return stdout
    }
    default:
      throw new Error(`未知 action: ${args.action as string}`)
  }
}
