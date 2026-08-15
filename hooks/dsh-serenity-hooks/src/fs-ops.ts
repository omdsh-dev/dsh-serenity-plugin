/**
 * fs-ops.ts — cc_fs 纯操作层（零 DSH 依赖，可独立单测）
 *
 * 行为对齐 osp（opencode-serenity-plugin/src/fs/file-system-tool.ts）——osp 是 ACC 工具 spec：
 *   - rm：目录需 recursive 才删除；非空目录无 recursive → [SKIP]；保护 .serenity 与 CCC 根；dry-run 预览
 *   - cp：目录需 recursive；dst 已存在报错；自动建父目录
 *   - mv：dst 已存在报错；自动建父目录
 *   - list/tree/exists/info/find：输出结构与 osp 一致（JSON 元数据 / 嵌套树 / glob+fuzzy 搜索）
 *   - touch：存在更新 mtime、不存在创建（自动建父目录）；append：自动建父目录 + 返回字节数
 * 保留 dsp 增强：win32 reveal 用 spawn+unref（explorer GUI 进程退出码不可靠，fire-and-forget）。
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
  unlinkSync,
  rmdirSync,
  utimesSync,
  type Stats,
} from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { join, relative, dirname, resolve } from 'node:path'
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
  /** 对齐 osp：rm 删目录 / cp 复制目录需 recursive */
  recursive?: boolean
  /** 对齐 osp：tree files-only / dirs-only（互斥） */
  filesOnly?: boolean
  dirsOnly?: boolean
  /** 对齐 osp：find 返回绝对路径 */
  absolute?: boolean
  /** 对齐 osp：find 最大递归深度（缺省不限） */
  maxDepth?: number
}

export type CcFsResult = JsonValue

// ── 文件元数据（对齐 osp FileInfo）──

interface FileInfo {
  name: string
  type: 'file' | 'dir' | 'symlink' | 'other'
  size: number
  sizeHuman: string
  mtime: string
}

function detectFileType(stat: Stats): FileInfo['type'] {
  if (stat.isDirectory()) return 'dir'
  if (stat.isFile()) return 'file'
  if (stat.isSymbolicLink()) return 'symlink'
  return 'other'
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function getFileInfo(absPath: string, name: string): FileInfo {
  try {
    const stat = statSync(absPath)
    return {
      name,
      type: detectFileType(stat),
      size: stat.size,
      sizeHuman: humanSize(stat.size),
      mtime: stat.mtime.toISOString(),
    }
  } catch {
    return { name, type: 'other', size: 0, sizeHuman: '?', mtime: '?' }
  }
}

function safeRel(root: string, abs: string): string {
  return relative(root, abs) || '.'
}

// ── 写操作路径校验（对齐 osp validateWritePath/assertNotProtected）──

function validateWritePath(root: string, target: string): string {
  const absPath = target.startsWith('/') ? resolve(target) : resolveInside(root, target)
  // resolveInside 已保证根内；绝对路径需显式校验
  if (target.startsWith('/') && !absPath.startsWith(root)) {
    throw new Error(`cc-fs: path "${target}" resolves to "${absPath}" which is outside serenity root "${root}"`)
  }
  // 保护 mech-registry.json — 只能通过 acc_msm register/deregister 注册/注销
  if (absPath.endsWith('/mech-registry.json') && absPath.includes('/.opencode/skills/')) {
    throw new Error(
      `cc-fs: refusing to directly modify mech-registry.json — use acc_msm register/deregister instead`,
    )
  }
  return absPath
}

function assertNotProtected(root: string, absPath: string, targetLabel: string): void {
  const serenityMarker = resolve(root, '.serenity')
  if (absPath === serenityMarker) {
    throw new Error(`cc-fs: refusing to delete protected path: ${targetLabel} (.serenity is the CCC marker)`)
  }
  if (absPath === root) {
    throw new Error(`cc-fs: refusing to delete the CCC root directory: ${targetLabel}`)
  }
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
      const absPath = args.path.startsWith('/') ? resolve(args.path) : resolveInside(root, args.path)
      return existsSync(absPath) ? 'true' : 'false'
    }
    case 'list': {
      const relPath = args.path || '.'
      const absPath = relPath.startsWith('/') ? resolve(relPath) : resolveInside(root, relPath)
      if (!existsSync(absPath)) throw new Error(`list: path "${absPath}" does not exist`)
      const names = readdirSync(absPath)
      const entries = names.sort().map((name) => getFileInfo(join(absPath, name), name))
      return { path: absPath, entries, count: entries.length } as unknown as JsonValue
    }
    case 'tree': {
      const relPath = args.path || '.'
      const absPath = relPath.startsWith('/') ? resolve(relPath) : resolveInside(root, relPath)
      if (!existsSync(absPath)) throw new Error(`tree: path "${absPath}" does not exist`)
      const maxDepth = args.depth ?? 3
      const filesOnly = args.filesOnly ?? false
      const dirsOnly = args.dirsOnly ?? false
      if (filesOnly && dirsOnly) {
        throw new Error('tree: files-only and dirs-only are mutually exclusive')
      }
      const filterTree = (entries: TreeEntry[], keepType: string): TreeEntry[] =>
        entries.filter((e) => {
          if (e.type === keepType) {
            if (e.children) e.children = filterTree(e.children, keepType)
            return true
          }
          return false
        })
      const walk = (dir: string, currentDepth: number): TreeEntry[] => {
        if (currentDepth > maxDepth) return []
        const names = readdirSync(dir).sort()
        return names.map((name) => {
          const full = join(dir, name)
          const stat = statSync(full)
          const entry: TreeEntry = {
            name,
            type: detectFileType(stat),
            size: stat.size,
            sizeHuman: humanSize(stat.size),
          }
          if (stat.isDirectory()) entry.children = walk(full, currentDepth + 1)
          return entry
        })
      }
      let entries = walk(absPath, 1)
      if (filesOnly) entries = filterTree(entries, 'file')
      if (dirsOnly) entries = filterTree(entries, 'dir')
      return { path: absPath, entries, maxDepth } as unknown as JsonValue
    }
    case 'relative': {
      if (!args.path) throw new Error('relative 需要 path')
      const absPath = args.path.startsWith('/') ? resolve(args.path) : resolveInside(root, args.path)
      if (!absPath.startsWith(root)) {
        throw new Error(`relative: path "${args.path}" resolves to "${absPath}" which is outside serenity root "${root}"`)
      }
      return safeRel(root, absPath)
    }
    case 'mkdir': {
      if (!args.path) throw new Error('mkdir 需要 path')
      const absPath = validateWritePath(root, args.path)
      if (existsSync(absPath)) {
        const stat = statSync(absPath)
        if (stat.isDirectory()) return `directory already exists: ${args.path}`
        throw new Error(`mkdir: path "${args.path}" exists but is not a directory`)
      }
      mkdirSync(absPath, { recursive: true })
      return `created directory: ${args.path}`
    }
    case 'rm': {
      // 合并单路径和多路径参数（对齐 osp）
      const targets: string[] = [...(args.paths ?? [])]
      if (args.path) targets.push(args.path)
      if (targets.length === 0) throw new Error('rm 需要至少一个 path 参数（path 或 paths）')
      const dryRun = args.dryRun ?? false
      const recursive = args.recursive ?? false
      const results: string[] = []
      for (const target of targets) {
        const absPath = validateWritePath(root, target)
        if (!existsSync(absPath)) {
          results.push(`[SKIP] not found: ${target}`)
          continue
        }
        const stat = statSync(absPath)
        const isDir = stat.isDirectory()
        try {
          assertNotProtected(root, absPath, target)
        } catch (e) {
          results.push(`[SKIP] ${(e as Error).message}`)
          continue
        }
        const relLabel = safeRel(root, absPath)
        if (dryRun) {
          const extra = isDir ? (recursive ? ' (recursive)' : '') : ''
          results.push(`[DRY-RUN] ${isDir ? 'directory' : 'file'}: ${relLabel}${extra}`)
          continue
        }
        if (isDir && !recursive) {
          const entries = readdirSync(absPath)
          if (entries.length > 0) {
            results.push(`[SKIP] directory not empty (${entries.length} items), use recursive: ${relLabel}`)
            continue
          }
          rmdirSync(absPath)
        } else if (isDir) {
          rmSync(absPath, { recursive: true, force: false })
        } else {
          unlinkSync(absPath)
        }
        results.push(`[OK] deleted: ${relLabel}`)
      }
      return results.join('\n')
    }
    case 'mv': {
      if (!args.src || !args.dst) throw new Error('mv 需要 src + dst')
      const srcAbs = validateWritePath(root, args.src)
      const dstAbs = validateWritePath(root, args.dst)
      if (!existsSync(srcAbs)) throw new Error(`mv: source not found: ${args.src}`)
      if (existsSync(dstAbs)) throw new Error(`mv: destination already exists: ${args.dst}`)
      const parentDir = dirname(dstAbs)
      if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true })
      renameSync(srcAbs, dstAbs)
      return `moved: ${args.src} → ${args.dst}`
    }
    case 'cp': {
      if (!args.src || !args.dst) throw new Error('cp 需要 src + dst')
      const srcAbs = validateWritePath(root, args.src)
      const dstAbs = validateWritePath(root, args.dst)
      if (!existsSync(srcAbs)) throw new Error(`cp: source not found: ${args.src}`)
      if (existsSync(dstAbs)) throw new Error(`cp: destination already exists: ${args.dst}`)
      const stat = statSync(srcAbs)
      if (stat.isDirectory() && !(args.recursive ?? false)) {
        throw new Error(`cp: source is a directory, use recursive to copy: ${args.src}`)
      }
      const parentDir = dirname(dstAbs)
      if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true })
      cpSync(srcAbs, dstAbs, { recursive: args.recursive ?? false })
      return `copied: ${args.src} → ${args.dst}`
    }
    case 'touch': {
      if (!args.path) throw new Error('touch 需要 path')
      const absPath = validateWritePath(root, args.path)
      if (existsSync(absPath)) {
        const now = new Date()
        utimesSync(absPath, now, now)
        return `updated timestamp: ${args.path}`
      }
      const parentDir = dirname(absPath)
      if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true })
      writeFileSync(absPath, '', 'utf-8')
      return `created empty file: ${args.path}`
    }
    case 'append': {
      if (!args.path || args.content === undefined) throw new Error('append 需要 path + content')
      const absPath = validateWritePath(root, args.path)
      const parentDir = dirname(absPath)
      if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true })
      const content = args.content
      appendFileSync(absPath, content, 'utf-8')
      return `appended ${Buffer.byteLength(content, 'utf8')} bytes to ${args.path}`
    }
    case 'reveal': {
      if (!args.path) throw new Error('reveal 需要 path')
      const absPath = resolveInside(root, args.path)
      if (!existsSync(absPath)) throw new Error(`no such path: ${absPath}`)
      const os = platform()
      try {
        if (os === 'darwin') {
          execFileSync('open', ['-R', absPath], { timeout: 10000 })
        } else if (os === 'linux') {
          const revealPath = statSync(absPath).isDirectory() ? absPath : dirname(absPath)
          execFileSync('xdg-open', [revealPath], { timeout: 10000 })
        } else if (os === 'win32') {
          // explorer.exe 是 GUI 子系统进程——即便成功也常返回非零退出码，
          // 经 execFileSync 捕获会被误判 failure。改为 spawn 分离 + unref（fire-and-forget）。
          const winArgs = statSync(absPath).isDirectory() ? [absPath] : ['/select,', absPath]
          const child = spawn('explorer', winArgs, { detached: true, stdio: 'ignore', windowsHide: false })
          child.on('error', () => {
            /* explorer 缺失/启动失败：GUI 打开尽力而为，不抛错 */
          })
          child.unref()
        } else {
          throw new Error(`unsupported platform: ${os}`)
        }
        return `revealed in file manager: ${args.path}`
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(`reveal failed to open "${args.path}": ${msg}`)
      }
    }
    case 'info': {
      if (!args.path) throw new Error('info 需要 path')
      const absPath = args.path.startsWith('/') ? resolve(args.path) : resolveInside(root, args.path)
      if (!existsSync(absPath)) throw new Error(`info: path "${absPath}" does not exist`)
      const stat = statSync(absPath)
      const fileType = detectFileType(stat)
      const modeStr = stat.mode.toString(8).slice(-4)
      return [
        `path: ${safeRel(root, absPath)}`,
        `type: ${fileType}`,
        `size: ${stat.size} (${humanSize(stat.size)})`,
        `mtime: ${stat.mtime.toISOString()}`,
        `mode: ${modeStr}`,
        `uid: ${stat.uid}`,
        `gid: ${stat.gid}`,
      ].join('\n')
    }
    case 'find': {
      if (!args.pattern) throw new Error('find 需要 pattern')
      const relPath = args.path || '.'
      const absPath = relPath.startsWith('/') ? resolve(relPath) : resolveInside(root, relPath)
      if (!existsSync(absPath)) throw new Error(`find: path "${absPath}" does not exist`)
      const pattern = args.pattern
      const absolutePaths = args.absolute ?? false
      const maxDepth = args.maxDepth ?? -1
      const hasGlobChars = /[*?]/.test(pattern)
      const matchFilename = (name: string): boolean => {
        if (hasGlobChars) {
          const regexStr = '^' + pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.') + '$'
          try {
            return new RegExp(regexStr).test(name)
          } catch {
            return name.includes(pattern)
          }
        }
        return name.toLowerCase().includes(pattern.toLowerCase())
      }
      const matches: string[] = []
      const walkFind = (dir: string, depth: number): void => {
        if (maxDepth >= 0 && depth > maxDepth) return
        let names: string[]
        try {
          names = readdirSync(dir)
        } catch {
          return
        }
        for (const name of names.sort()) {
          const full = join(dir, name)
          let stat: Stats
          try {
            stat = statSync(full)
          } catch {
            continue
          }
          if (matchFilename(name)) {
            matches.push(absolutePaths ? full : safeRel(root, full))
          }
          if (stat.isDirectory()) walkFind(full, depth + 1)
        }
      }
      walkFind(absPath, 1)
      matches.sort()
      return { path: absPath, pattern, matches, count: matches.length }
    }
    default:
      throw new Error(`未知 action: ${a as string}`)
  }
}

interface TreeEntry {
  name: string
  type: FileInfo['type']
  size: number
  sizeHuman: string
  children?: TreeEntry[]
}
