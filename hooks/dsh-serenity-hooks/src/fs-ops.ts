/**
 * fs-ops.ts — cc_fs 纯操作层（零 DSH 依赖，可独立单测）
 *
 * 移植自 dsh-serenity-plugin v0.1 acc-fs runner（本项目自有代码）。
 * 每个操作返回规范 JSON 值（由工具层 render 成模型可见文本）。
 */

import {
  existsSync,
  statSync,
  mkdirSync,
  rmSync,
  renameSync,
  cpSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
} from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { join, relative, dirname } from 'node:path'
import { platform } from 'node:os'
import { resolveInside } from './ccc.js'
import type { JsonValue } from './json.js'

export type CcFsAction =
  | 'root'
  | 'resolve'
  | 'exists'
  | 'list'
  | 'tree'
  | 'relative'
  | 'mkdir'
  | 'rm'
  | 'mv'
  | 'cp'
  | 'touch'
  | 'append'
  | 'reveal'
  | 'info'
  | 'find'

export const CC_FS_ACTIONS: readonly CcFsAction[] = [
  'root', 'resolve', 'exists', 'list', 'tree', 'relative',
  'mkdir', 'rm', 'mv', 'cp', 'touch', 'append', 'reveal', 'info', 'find',
]

export interface CcFsArgs {
  action: CcFsAction
  path?: string
  paths?: string[]
  src?: string
  dst?: string
  content?: string
  pattern?: string
  depth?: number
  dryRun?: boolean
}

export type CcFsResult = JsonValue

function safeRel(root: string, abs: string): string {
  return relative(root, abs) || '.'
}

export function runCcFs(root: string, args: CcFsArgs): CcFsResult {
  const a = args.action
  switch (a) {
    case 'root':
      return root
    case 'resolve': {
      if (!args.path) throw new Error('resolve 需要 path')
      return resolveInside(root, args.path)
    }
    case 'exists': {
      if (!args.path) throw new Error('exists 需要 path')
      return existsSync(resolveInside(root, args.path))
    }
    case 'list': {
      const dir = args.path ? resolveInside(root, args.path) : root
      if (!existsSync(dir)) throw new Error(`no such dir: ${dir}`)
      return readdirSync(dir, { withFileTypes: true }).map((e) => ({
        name: e.name,
        type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other',
      }))
    }
    case 'tree': {
      const dir = args.path ? resolveInside(root, args.path) : root
      const maxDepth = args.depth ?? Infinity
      if (!existsSync(dir)) throw new Error(`no such dir: ${dir}`)
      const out: { path: string; type: string }[] = []
      const walk = (cur: string, depth: number): void => {
        if (depth > maxDepth) return
        for (const e of readdirSync(cur, { withFileTypes: true })) {
          const full = join(cur, e.name)
          out.push({ path: safeRel(root, full), type: e.isDirectory() ? 'dir' : 'file' })
          if (e.isDirectory()) walk(full, depth + 1)
        }
      }
      walk(dir, 0)
      return out
    }
    case 'relative': {
      if (!args.path) throw new Error('relative 需要 path')
      const abs = resolveInside(root, args.path)
      return safeRel(root, abs)
    }
    case 'mkdir': {
      const targets = args.paths?.length ? args.paths : args.path ? [args.path] : []
      if (targets.length === 0) throw new Error('mkdir 需要 path(s)')
      for (const t of targets) mkdirSync(resolveInside(root, t), { recursive: true })
      return { ok: true, created: targets }
    }
    case 'rm': {
      const targets = args.paths?.length ? args.paths : args.path ? [args.path] : []
      if (targets.length === 0) throw new Error('rm 需要 path(s)')
      const removed: string[] = []
      for (const t of targets) {
        const abs = resolveInside(root, t)
        if (abs === root) throw new Error('拒绝删除 CCC 根本身')
        if (!existsSync(abs)) continue
        if (args.dryRun) {
          removed.push(`${t} [dry-run]`)
          continue
        }
        rmSync(abs, { recursive: true, force: true })
        removed.push(t)
      }
      return { ok: true, removed }
    }
    case 'mv': {
      if (!args.src || !args.dst) throw new Error('mv 需要 src + dst')
      renameSync(resolveInside(root, args.src), resolveInside(root, args.dst))
      return { ok: true, from: args.src, to: args.dst }
    }
    case 'cp': {
      if (!args.src || !args.dst) throw new Error('cp 需要 src + dst')
      cpSync(resolveInside(root, args.src), resolveInside(root, args.dst), { recursive: true })
      return { ok: true, from: args.src, to: args.dst }
    }
    case 'touch': {
      if (!args.path) throw new Error('touch 需要 path')
      const abs = resolveInside(root, args.path)
      if (!existsSync(abs)) writeFileSync(abs, '', 'utf-8')
      return { ok: true, path: safeRel(root, abs) }
    }
    case 'append': {
      if (!args.path || args.content === undefined) throw new Error('append 需要 path + content')
      const abs = resolveInside(root, args.path)
      appendFileSync(abs, args.content, 'utf-8')
      return { ok: true, path: safeRel(root, abs) }
    }
    case 'reveal': {
      if (!args.path) throw new Error('reveal 需要 path')
      const abs = resolveInside(root, args.path)
      if (!existsSync(abs)) throw new Error(`no such path: ${abs}`)
      const os = platform()
      try {
        if (os === 'darwin') {
          // macOS: Finder 打开并选中该项
          execFileSync('open', ['-R', abs], { timeout: 10000 })
        } else if (os === 'linux') {
          // Linux: 文件 → 打开所在目录；目录 → 打开目录本身
          const revealPath = statSync(abs).isDirectory() ? abs : dirname(abs)
          execFileSync('xdg-open', [revealPath], { timeout: 10000 })
        } else if (os === 'win32') {
          // Windows：目录 → 打开目录本身；文件 → Explorer 选中（explorer /select,<path>）。
          // explorer.exe 是 GUI 子系统进程——即便成功也常返回非零退出码，
          // 经 execFileSync 捕获会被误判 failure（Windows 兼容审计问题 2）。
          // 改为 spawn 分离 + unref（fire-and-forget），忽略退出码。
          const args = statSync(abs).isDirectory() ? [abs] : ['/select,', abs]
          const child = spawn('explorer', args, { detached: true, stdio: 'ignore', windowsHide: false })
          child.on('error', () => {
            /* explorer 缺失/启动失败：GUI 打开尽力而为，不抛错 */
          })
          child.unref()
        } else {
          throw new Error(`unsupported platform: ${os}`)
        }
        return { ok: true, revealed: safeRel(root, abs) }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(`reveal failed to open "${safeRel(root, abs)}": ${msg}`)
      }
    }
    case 'info': {
      if (!args.path) throw new Error('info 需要 path')
      const abs = resolveInside(root, args.path)
      if (!existsSync(abs)) return { exists: false, path: safeRel(root, abs) }
      const st = statSync(abs)
      return {
        exists: true,
        path: safeRel(root, abs),
        type: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other',
        size: st.size,
        mtime: st.mtime.toISOString(),
      }
    }
    case 'find': {
      if (!args.pattern) throw new Error('find 需要 pattern')
      const pattern = args.pattern
      const isRegex = pattern.startsWith('regex:')
      const re = isRegex ? new RegExp(pattern.slice(6)) : null
      const out: string[] = []
      const walk = (cur: string): void => {
        for (const e of readdirSync(cur, { withFileTypes: true })) {
          const full = join(cur, e.name)
          const hit = isRegex ? re!.test(e.name) : e.name.includes(pattern)
          if (hit) out.push(safeRel(root, full))
          if (e.isDirectory()) walk(full)
        }
      }
      walk(root)
      return out
    }
    default:
      throw new Error(`未知 action: ${a as string}`)
  }
}
