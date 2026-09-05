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
  realpathSync,
  chmodSync,
  type Stats,
} from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { join, relative, dirname, resolve } from 'node:path'
import { platform } from 'node:os'
import { resolveInside, pathInside, readCccName } from './ccc.js'
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

/**
 * 受保护注册表聚合档的路径集合（review P2-2：精确文件保护可被 `rm -r 父目录` / `mv 父目录`
 * 绕过——删掉 references/ 目录等于删掉注册表。保护对象 = 聚合档文件 + 其全部祖先目录）。
 * @returns null = 无 cccName（无法定位 → 不保护）；否则 { fileRel, ancestorDirs } 相对根的正斜杠 rel
 */
function protectedRegistryTargets(root: string): { fileRel: string; ancestorDirs: string[] } | null {
  const cccName = readCccName(root) // review P2-2：统一 ccc.ts readCccName（跳 # 注释/空行首非空行）
  if (!cccName) return null
  const fileRel = `.opencode/skills/${cccName}/references/mech-registry.json`
  const segs = fileRel.split('/') // ['.opencode','skills',cccName,'references','mech-registry.json']
  const ancestorDirs: string[] = []
  // 只含 references/ 目录本身（segs 末位是文件名，倒数第二位是 references）——
  // rm -r references/ / mv references/ 即毁注册表，必须拦。
  // 不含 .opencode/skills/<cccName>（共享父目录，误伤同 CCC 其他 skill 子目录删除；整删场景罕见 + git 可恢复）
  if (segs.length >= 3) {
    ancestorDirs.push(segs.slice(0, segs.length - 1).join('/')) // …/references
  }
  return { fileRel, ancestorDirs }
}

function isProtectedRegistryTarget(root: string, relCi: string): { hit: 'file' | 'ancestor' } | null {
  const protectedTargets = protectedRegistryTargets(root)
  if (!protectedTargets) return null
  const lower = (s: string): string => (process.platform === 'win32' ? s.toLowerCase() : s)
  const fileRelCi = lower(protectedTargets.fileRel)
  if (relCi === fileRelCi) return { hit: 'file' }
  for (const ancestor of protectedTargets.ancestorDirs) {
    const aCi = lower(ancestor)
    // 目录命中 = **目录节点本身**（rm -r references/ / mv references/ 即毁注册表）。
    // review P1-1（复验收窄）：**不含子树前缀**——references/ 内与注册表并置的
    // 合法知识文档（msm-writing-standards.md 等）必须可正常写/编辑/删（防绕过语义
    // = 删目录，目录节点相等已足够；前缀放大成子树任何写 = 过保护）。
    if (relCi === aCi) return { hit: 'ancestor' }
  }
  return null
}

function assertNotProtectedRegistry(root: string, absPath: string, targetLabel: string): void {
  const rel = relative(root, absPath).split('\\').join('/')
  const lower = (s: string): string => (process.platform === 'win32' ? s.toLowerCase() : s)
  const hit = isProtectedRegistryTarget(root, lower(rel))
  if (hit === null) return
  if (hit.hit === 'file') {
    throw new Error(
      `cc-fs: refusing to directly modify mech-registry.json — use acc_msm register/deregister instead`,
    )
  }
  throw new Error(
    `cc-fs: refusing to ${/rm|delete|remove/i.test(targetLabel) ? 'remove' : 'move'} "${rel}" — it is an ancestor of the ACC-managed mech-registry.json (${protectedRegistryTargets(root)?.fileRel}); the registry is managed by acc_msm register/deregister`,
  )
}

function validateWritePath(root: string, target: string): string {
  const absPath = target.startsWith('/') ? resolve(target) : resolveInside(root, target)
  // resolveInside 已保证根内；绝对路径需显式校验（pathInside 跨盘安全，Windows 审计问题 6）
  if (!pathInside(resolve(root), absPath)) {
    throw new Error(`cc-fs: path "${target}" resolves to "${absPath}" which is outside serenity root "${root}"`)
  }
  // 保护 mech-registry.json — 只能通过 acc_msm register/deregister 注册/注销。
  // 需求⑤a（S142 用户拍板：注册表单级化）：**唯一合法注册表 = cccName 聚合档**
  // （.opencode/skills/<cccName>/references/mech-registry.json——cccName = .serenity 首行）。
  // 历史 root 级 + 各 skill 分散注册表已废弃：不再保护（review P1——保护永不被读的文件 = 死锁，
  // MSM 既不可见又不可删/迁移；废弃形态必须可删以迁移到聚合档）。
  // review P2-2：保护范围 = 聚合档文件 + 祖先目录（rm -r references/ / mv references/ 同样 deny）。
  // relative 归一化反斜杠（Windows：resolveInside 返回反斜杠路径，正斜杠字面量永不匹配 → 保护失效，见问题 8）
  assertNotProtectedRegistry(root, absPath, `modify ${target}`)
  // symlink/junction 防御（Windows 审计问题 15）：存在的路径 realpath 后必须仍在根内
  if (existsSync(absPath)) {
    try {
      const real = realpathSync(absPath)
      if (!pathInside(resolve(root), real)) {
        throw new Error(`cc-fs: path "${target}" resolves via symlink to "${real}" outside serenity root "${root}"`)
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes('symlink')) throw e
      /* realpath 失败（权限等）放行——后续执行会报错 */
    }
  }
  return absPath
}

function assertNotProtected(root: string, absPath: string, targetLabel: string): void {
  // Windows 文件系统大小写不敏感（审计问题 14）：比较前归一化大小写
  const ci = process.platform === 'win32'
  const eq = (a: string, b: string): boolean => (ci ? a.toLowerCase() === b.toLowerCase() : a === b)
  const serenityMarker = resolve(root, '.serenity')
  if (eq(absPath, serenityMarker)) {
    throw new Error(`cc-fs: refusing to delete protected path: ${targetLabel} (.serenity is the CCC marker)`)
  }
  if (eq(absPath, root)) {
    throw new Error(`cc-fs: refusing to delete the CCC root directory: ${targetLabel}`)
  }
}

export function runCcFs(root: string, args: CcFsArgs): CcFsResult {
  const a = args.action
  switch (a) {
    case 'root':
      return root
    case 'resolve': {
      if (!args.path) throw new Error('resolve requires path')
      return resolveInside(root, args.path)
    }
    case 'exists': {
      if (!args.path) throw new Error('exists requires path')
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
      if (!args.path) throw new Error('relative requires path')
      const absPath = args.path.startsWith('/') ? resolve(args.path) : resolveInside(root, args.path)
      if (!absPath.startsWith(root)) {
        throw new Error(`relative: path "${args.path}" resolves to "${absPath}" which is outside serenity root "${root}"`)
      }
      return safeRel(root, absPath)
    }
    case 'mkdir': {
      if (!args.path) throw new Error('mkdir requires path')
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
      if (targets.length === 0) throw new Error('rm requires at least one path argument (path or paths)')
      const dryRun = args.dryRun ?? false
      const recursive = args.recursive ?? false
      const results: string[] = []
      for (const target of targets) {
        let absPath: string
        try {
          // validateWritePath 内含注册表保护（文件 + 祖先目录）——受保护目标 rm 报 [SKIP] 不中断整批
          absPath = validateWritePath(root, target)
        } catch (e) {
          results.push(`[SKIP] ${(e as Error).message}`)
          continue
        }
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
          // Windows：只读属性文件 unlink 抛 EPERM（Unix unlink 不受只读模式阻挡）——先清只读位（审计问题 17）
          if (process.platform === 'win32') {
            try {
              chmodSync(absPath, 0o666)
            } catch {
              /* chmod 失败继续尝试删除 */
            }
          }
          unlinkSync(absPath)
        }
        results.push(`[OK] deleted: ${relLabel}`)
      }
      return results.join('\n')
    }
    case 'mv': {
      if (!args.src || !args.dst) throw new Error('mv requires src + dst')
      const srcAbs = validateWritePath(root, args.src)
      const dstAbs = validateWritePath(root, args.dst)
      assertNotProtected(root, srcAbs, `mv src ${args.src}`)
      assertNotProtected(root, dstAbs, `mv dst ${args.dst}`)
      if (!existsSync(srcAbs)) throw new Error(`mv: source not found: ${args.src}`)
      if (existsSync(dstAbs)) throw new Error(`mv: destination already exists: ${args.dst}`)
      const parentDir = dirname(dstAbs)
      if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true })
      renameSync(srcAbs, dstAbs)
      return `moved: ${args.src} → ${args.dst}`
    }
    case 'cp': {
      if (!args.src || !args.dst) throw new Error('cp requires src + dst')
      const srcAbs = validateWritePath(root, args.src)
      const dstAbs = validateWritePath(root, args.dst)
      assertNotProtected(root, srcAbs, `cp src ${args.src}`)
      assertNotProtected(root, dstAbs, `cp dst ${args.dst}`)
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
      if (!args.path) throw new Error('touch requires path')
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
      if (!args.path || args.content === undefined) throw new Error('append requires path + content')
      const absPath = validateWritePath(root, args.path)
      const parentDir = dirname(absPath)
      if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true })
      const content = args.content
      appendFileSync(absPath, content, 'utf-8')
      return `appended ${Buffer.byteLength(content, 'utf8')} bytes to ${args.path}`
    }
    case 'reveal': {
      if (!args.path) throw new Error('reveal requires path')
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
          // 文件 case：/select 需**单个合并参数** `/select,<abs>`（分开传 `/select,` + 路径会
          // 把 /select, 当空路径、文件当目录打开——Windows 审计问题 7）。
          // explorer `/select,` 对含空格/逗号路径按词拆分（Win10/11 长期缺陷，引号也无效）——
          // 含空格/逗号路径退化到打开所在目录（对齐 linux 分支，审计问题 7 补充）。
          const stat = statSync(absPath)
          const winPath = stat.isDirectory()
            ? absPath
            : /[\s,]/.test(absPath)
              ? dirname(absPath)
              : `/select,${absPath}`
          const child = spawn('explorer', [winPath], { detached: true, stdio: 'ignore', windowsHide: false })
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
      if (!args.path) throw new Error('info requires path')
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
      if (!args.pattern) throw new Error('find requires pattern')
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
            // win32 大小写不敏感 glob：`*.PNG` 应匹配 assistant.png
            return new RegExp(regexStr, platform() === 'win32' ? 'i' : undefined).test(name)
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
      throw new Error(`Unknown action: ${a as string}`)
  }
}

interface TreeEntry {
  name: string
  type: FileInfo['type']
  size: number
  sizeHuman: string
  children?: TreeEntry[]
}
