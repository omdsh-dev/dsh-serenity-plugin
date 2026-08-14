/**
 * msm-ops.ts — acc_msm 纯操作层（零 DSH 依赖）
 *
 * MSM（Mech & Semi-Mech）框架：list / exec / admin(register|deregister|check)。
 * 复用 CCC 的 mech-registry.json（v1 或数组格式）。cwd 钉在 CCC 根。
 */

import {
  existsSync,
  statSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs'
import { execFileSync, spawnSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, dirname, relative, resolve } from 'node:path'
import { classifyPath } from './ccc.js'
import type { JsonValue } from './json.js'

const execFileAsync = promisify(execFile)

export const MSM_TIMEOUT_MS = 600_000

/**
 * Windows 兼容（审计观察点 A）：`.cmd` 不能直接被 CreateProcess 解析——
 * `execFile('npx')` / `spawnSync('npx')` 在 Windows 必 ENOENT（需 shell 或显式 .cmd）。
 * bun 无扩展名（bun.exe 可被 libuv 按 PATHEXT 解析），保持 'bun'。
 */
const NPX_BIN = process.platform === 'win32' ? 'npx.cmd' : 'npx'

export type MsmAction = 'list' | 'exec' | 'register' | 'deregister' | 'check' | 'guide'

export const MSM_ACTIONS: readonly MsmAction[] = ['list', 'exec', 'register', 'deregister', 'check', 'guide']

export const MSM_GUIDE = `MSM 开发手册（Mech & Semi-Mech 框架）

## 是什么
MSM = 可执行单元层。Mech 纯 TS 零 LLM 推理；Semi-Mech TS 框架 + LLM 决策点。

## 注册新 MSM（acc_msm register）
1. 在 <skill>/scripts/ 写脚本（tsx 可跑；必须带 main() CLI 守卫 import.meta.url 检查）
2. acc_msm register <name> --skill <s> --path <脚本相对根路径> --category <mech|semi-mech> --description <desc>
3. 自动写入 mech-registry.json + git commit

## 脚本约定
- 顶部文档：用途/用法/退出码
- 退出码：0 成功 / 1 user / 2 system / 3 operator
- flags 中 type:"path" 的参数会被逃逸校验（根内强制）
- 配对 .test.ts（vitest）

## 品质检查（acc_msm check）
DC-M1 有 .test.ts；DC-M2 有 main() 守卫；M3 脚本存在；M4 path flag 标记 type:"path"
`


export interface MsmFlag {
  name: string
  type?: string
  description?: string
  required?: boolean
  default?: unknown
}

export interface MsmEntry {
  name: string
  path: string
  skill?: string
  category?: string
  description?: string
  usage?: string
  flags?: MsmFlag[]
}

export interface MsmArgs {
  action: MsmAction
  name?: string
  args?: string[]
  skill?: string
  path?: string
  category?: string
  description?: string
}

export function parseRegistry(raw: string): MsmEntry[] {
  const data = JSON.parse(raw) as unknown
  if (Array.isArray(data)) return data as MsmEntry[]
  const entries = (data as { entries?: unknown }).entries
  if (!Array.isArray(entries)) throw new Error('invalid registry: missing entries[]')
  return entries as MsmEntry[]
}

export function findRegistries(root: string): string[] {
  const out: string[] = []
  const skillsDir = join(root, '.opencode', 'skills')
  if (existsSync(skillsDir)) {
    for (const skill of readdirSync(skillsDir)) {
      const p = join(skillsDir, skill, 'references', 'mech-registry.json')
      if (existsSync(p)) out.push(p)
    }
  }
  const rootRegistry = join(root, 'mech-registry.json')
  if (existsSync(rootRegistry)) out.push(rootRegistry)
  return out
}

export function loadMsmEntries(root: string): MsmEntry[] {
  const byName = new Map<string, MsmEntry>()
  for (const regPath of findRegistries(root)) {
    for (const entry of parseRegistry(readFileSync(regPath, 'utf-8'))) {
      if (!byName.has(entry.name)) byName.set(entry.name, entry)
    }
  }
  return [...byName.values()]
}

export function findEntry(root: string, name: string): MsmEntry | null {
  return loadMsmEntries(root).find((e) => e.name === name) ?? null
}

function registryPathFor(root: string, skill?: string): string {
  return skill
    ? join(root, '.opencode', 'skills', skill, 'references', 'mech-registry.json')
    : join(root, 'mech-registry.json')
}

function writeRegistry(path: string, entries: MsmEntry[]): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ version: 1, description: 'MSM registry (managed by acc-msm / dsh-serenity-hooks)', entries }, null, 2) + '\n', 'utf-8')
}

export function runMsm(root: string, args: MsmArgs): JsonValue {
  switch (args.action) {
    case 'list':
      return loadMsmEntries(root).map((e) => ({
        name: e.name,
        skill: e.skill ?? null,
        category: e.category ?? null,
        description: e.description ?? '',
      }))

    case 'guide':
      return { guide: MSM_GUIDE }

    case 'exec': {
      const { entry, businessArgs, fmtJson, protocol } = prepareExec(root, args)
      const p = protocolResult(protocol)
      if (p !== undefined) return p
      // bun 优先（可直跑 TS），npx tsx 回退
      let r = spawnSync('bun', [entry.path, ...businessArgs], { cwd: root, encoding: 'utf-8', timeout: MSM_TIMEOUT_MS, stdio: ['pipe', 'pipe', 'pipe'] })
      if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') {
        r = spawnSync(NPX_BIN, ['tsx', entry.path, ...businessArgs], { cwd: root, encoding: 'utf-8', timeout: MSM_TIMEOUT_MS, stdio: ['pipe', 'pipe', 'pipe'] })
      }
      return msmExecResult(entry.name, r.status ?? 2, r.stdout ?? '', r.stderr ?? '', fmtJson)
    }

    case 'register': {
      const name = args.name ?? ''
      const { skill, path, category, description } = args
      if (!path || !category || !description) throw new Error('register 需要 path/category/description')
      const regPath = registryPathFor(root, skill)
      const entries = existsSync(regPath) ? parseRegistry(readFileSync(regPath, 'utf-8')) : []
      if (entries.some((e) => e.name === name)) throw new Error(`MSM already registered: "${name}"`)
      entries.push({ name, path, skill, category, description, usage: `msm_exec ${name} [args...]`, flags: [] })
      writeRegistry(regPath, entries)
      try {
        execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'pipe' })
        execFileSync('git', ['commit', '-m', `msm: register ${name}`], { cwd: root, stdio: 'pipe' })
      } catch {
        /* 非 git 环境忽略 */
      }
      return { registered: name, registry: relative(root, regPath) }
    }

    case 'deregister': {
      const name = args.name ?? ''
      for (const regPath of findRegistries(root)) {
        const entries = parseRegistry(readFileSync(regPath, 'utf-8'))
        const idx = entries.findIndex((e) => e.name === name)
        if (idx >= 0) {
          entries.splice(idx, 1)
          writeRegistry(regPath, entries)
          try {
            execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'pipe' })
            execFileSync('git', ['commit', '-m', `msm: deregister ${name}`], { cwd: root, stdio: 'pipe' })
          } catch {
            /* 忽略 */
          }
          return { deregistered: name }
        }
      }
      throw new Error(`MSM not registered: "${name}"`)
    }

    case 'check': {
      const entries = loadMsmEntries(root)
      const issues: { name: string; check: string; detail: string }[] = []
      for (const e of entries) {
        const script = join(root, e.path)
        const scriptExists = existsSync(script)
        if (!scriptExists) issues.push({ name: e.name, check: 'M3', detail: `script missing (${e.path})` })
        const testFile = script.replace(/\.ts$/, '.test.ts')
        if (!existsSync(testFile)) issues.push({ name: e.name, check: 'M1', detail: 'no .test.ts' })
        if (scriptExists && !readFileSync(script, 'utf-8').includes('import.meta.url')) {
          issues.push({ name: e.name, check: 'M2', detail: 'no main() guard' })
        }
      }
      return { checked: entries.length, issues }
    }

    default:
      throw new Error(`未知 action: ${args.action as string}`)
  }
}

/** 解析并校验 exec 参数：返回可执行条目 + 业务参数（list/schema 协议 flag 已分流） */
export interface PreparedExec {
  entry: MsmEntry
  businessArgs: string[]
  fmtJson: boolean
  /** 协议结果（--list / --schema）；非协议执行时为 undefined */
  protocol?: { list: { name: string; category: string | null }[] } | { schema: { name: string; path: string; flags: { name: string; type: string | null; description: string | null }[] } }
}

export function prepareExec(root: string, args: MsmArgs): PreparedExec {
  const name = args.name ?? ''
  const entry = findEntry(root, name)
  if (!entry) throw new Error(`MSM not registered: "${name}"`)
  const business = args.args ?? []

  // 协议 flag：--list / --schema <name>（从业务参数前缀提取）
  if (business.includes('--list')) {
    return {
      entry,
      businessArgs: [],
      fmtJson: false,
      protocol: { list: loadMsmEntries(root).map((e) => ({ name: e.name, category: e.category ?? null })) },
    }
  }
  const schemaIdx = business.indexOf('--schema')
  if (schemaIdx >= 0) {
    const target = business[schemaIdx + 1]
    const found = target ? loadMsmEntries(root).find((e) => e.name === target) : null
    if (!found) throw new Error(`MSM not registered: "${target}"`)
    return {
      entry,
      businessArgs: [],
      fmtJson: false,
      protocol: { schema: { name: found.name, path: found.path, flags: (found.flags ?? []).map((f) => ({ name: f.name, type: f.type ?? null, description: f.description ?? null })) } },
    }
  }
  const fmtJson = business.includes('--format=json')
  const businessArgs = business.filter((a) => a !== '--format=json')

  // path-arg 逃逸校验（ACC 标准）：flags 中 type:"path" 的参数值必须根内
  for (const flag of entry.flags ?? []) {
    if (flag.type !== 'path') continue
    const eq = businessArgs.find((a) => a.startsWith(`--${flag.name}=`))
    if (eq) {
      const value = eq.slice(flag.name.length + 3)
      if (classifyPath(resolve(root, value), root) === 'outside') {
        throw new Error(`Path escape blocked: --${flag.name}=${value} 越出 CCC 根`)
      }
    } else {
      const idx = businessArgs.indexOf(`--${flag.name}`)
      if (idx >= 0 && businessArgs[idx + 1]) {
        const value = businessArgs[idx + 1]!
        if (classifyPath(resolve(root, value), root) === 'outside') {
          throw new Error(`Path escape blocked: --${flag.name} ${value} 越出 CCC 根`)
        }
      }
    }
  }

  const script = resolve(root, entry.path)
  if (classifyPath(script, root) === 'outside') throw new Error(`MSM script escapes CCC root: "${entry.path}"`)
  if (!existsSync(script)) throw new Error(`MSM script not found: "${entry.path}"`)
  return { entry: { ...entry, path: script }, businessArgs, fmtJson }
}

/** 协议结果扁平化：{list|schema} 包装 → 顶层值（兼容旧契约）；非协议返回 undefined */
function protocolResult(protocol: PreparedExec['protocol']): JsonValue | undefined {
  if (!protocol) return undefined
  if ('list' in protocol) return protocol.list as unknown as JsonValue
  if ('schema' in protocol) return protocol.schema as unknown as JsonValue
  return undefined
}

function msmExecResult(name: string, status: number, stdout: string, stderr: string, fmtJson: boolean): JsonValue {
  if (fmtJson) {
    return status === 0
      ? { name, exit: 0, ok: true, data: stdout.trim() }
      : { name, exit: status, ok: false, error: stderr.trim() || stdout.trim() }
  }
  return { name, exit: status, stdout, stderr }
}

/**
 * 异步执行 MSM（acc_msm 工具主路径）：
 * 用 execFile + promisify + timeout（超时自动 kill），**不阻塞 Node 事件循环**。
 * （同步 spawnSync 版会阻塞 web 事件循环 → MSM 脚本自请求 3080 时死锁，见 postmortem。）
 */
export async function runMsmAsync(root: string, args: MsmArgs): Promise<JsonValue> {
  if (args.action !== 'exec') return runMsm(root, args)
  const { entry, businessArgs, fmtJson, protocol } = prepareExec(root, args)
  const p = protocolResult(protocol)
  if (p !== undefined) return p
  // bun 优先（可直跑 TS），npx tsx 回退
  try {
    const r = await execFileAsync('bun', [entry.path, ...businessArgs], {
      cwd: root,
      encoding: 'utf-8',
      timeout: MSM_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    })
    return msmExecResult(entry.name, 0, r.stdout, r.stderr, fmtJson)
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean }
    if (err.code === 'ENOENT') {
      try {
        const r = await execFileAsync(NPX_BIN, ['tsx', entry.path, ...businessArgs], {
          cwd: root,
          encoding: 'utf-8',
          timeout: MSM_TIMEOUT_MS,
          maxBuffer: 64 * 1024 * 1024,
        })
        return msmExecResult(entry.name, 0, r.stdout, r.stderr, fmtJson)
      } catch (e2) {
        const err2 = e2 as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean }
        const status = err2.killed ? 124 : (typeof err2.code === 'number' ? err2.code : 2)
        const stdout = err2.stdout ?? ''
        const stderr = err2.killed ? `MSM timed out after ${MSM_TIMEOUT_MS}ms` : (err2.stderr ?? err2.message ?? '')
        return msmExecResult(entry.name, status, stdout, stderr, fmtJson)
      }
    }
    const status = err.killed ? 124 : (typeof err.code === 'number' ? err.code : 2)
    const stdout = err.stdout ?? ''
    const stderr = err.killed ? `MSM timed out after ${MSM_TIMEOUT_MS}ms` : (err.stderr ?? err.message ?? '')
    return msmExecResult(entry.name, status, stdout, stderr, fmtJson)
  }
}
