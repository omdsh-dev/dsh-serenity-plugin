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
  realpathSync,
} from 'node:fs'
import { execFileSync, spawnSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, dirname, relative, resolve } from 'node:path'
import { classifyPath } from './ccc.js'
import { ACC_VERSION } from './constants.js'
import type { JsonValue } from './json.js'

const execFileAsync = promisify(execFile)

export const MSM_TIMEOUT_MS = 600_000

/** CCC 名：从 .serenity 首行解析（对齐 osp readSerenityCccName） */
export function readCccName(root: string): string | null {
  try {
    const content = readFileSync(resolve(root, '.serenity'), 'utf-8').trim()
    return content.split('\n')[0]?.trim() || null
  } catch {
    return null
  }
}

/**
 * path-arg 逃逸校验：根内 + symlink 防御（对齐 osp validatePathArgsFromTokens）。
 * symlink 指向根外 → 拒绝（realpath 解析后与根前缀比对）。
 */
function assertPathInsideRoot(root: string, value: string, flagName: string): void {
  const abs = resolve(root, value)
  if (classifyPath(abs, root) === 'outside') {
    throw new Error(`Path escape blocked: --${flagName}=${value} 越出 CCC 根`)
  }
  if (existsSync(abs)) {
    try {
      const real = realpathSync(abs)
      if (classifyPath(real, root) === 'outside') {
        throw new Error(`Path escape blocked: --${flagName}=${value} 经 symlink 指向根外 (${real})`)
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes('symlink')) throw e
      /* realpath 失败（权限等）放行——后续执行会报错 */
    }
  }
}

/** 业务子进程 env：注入 SERENITY_ROOT / SERENITY_CCC / SERENITY_VERSION（对齐 osp） */
function buildMsmEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SERENITY_ROOT: root,
    SERENITY_CCC: readCccName(root) ?? '',
    SERENITY_VERSION: ACC_VERSION,
  }
}

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
MSM 是 ACC 的确定性可执行单元层——所有 shell/exec 操作走 MSM，不可绕过。

## 注册新 MSM（acc_msm register）
1. 在 <skill>/scripts/ 写脚本（tsx 可跑；必须带 main() CLI 守卫 import.meta.url 检查）
2. acc_msm register <name> --skill <s> --path <脚本相对根路径> --category <mech|semi-mech> --description <desc>
3. 自动写入 mech-registry.json（保留原格式）+ git commit（只提交注册表文件）
4. 校验：path 必须根内、脚本必须存在、name 全局唯一

## flag schema（v1）
flags 是 new-style 对象数组，用于参数校验与 path 逃逸守卫：
  [{"name":"output","type":"string","description":"输出路径"},
   {"name":"target","type":"path","description":"操作目标（type:path 启用根内校验 + symlink 防御）"},
   {"name":"force","type":"boolean","description":"强制模式","default":false}]
- {name, type} 格式 — new style，type:"path" 启用 path-escape 守卫
- {flag, description} 格式 — old style，CLI flag 描述字符串
- 注册时 flags 经 acc_msm register --flags '<json>' 传入（工具当前解析 name 风格）

## 脚本约定
- 顶部文档：用途/用法/退出码
- 退出码：0 成功 / 1 user / 2 system / 3 operator（对齐 ACC 协议分类）
- main() CLI 守卫（DC-M2）：脚本顶部必须有
    if (import.meta.url === \`file://\${process.argv[1]}\`) { main() }
  或等价 isMain / require.main === 判断——vitest import 时不触发顶层代码
- 配对 .test.ts 或 .spec.ts（DC-M1，vitest）
- 业务子进程环境：注入 SERENITY_ROOT / SERENITY_CCC / SERENITY_VERSION

## 品质检查（acc_msm check，DC-M1~M4）
DC-M1 有 .test.ts/.spec.ts；DC-M2 有 main() 守卫（function main( / isMain / require.main === / import.meta.url）；
DC-M3 双向：脚本未注册 + 注册表引用脚本缺失；DC-M4 路径型 flag 标记 type:"path"

## 自描述（协议 flag，仅限参数首位）
acc_msm exec <name> --list        — 列出全部 MSM
acc_msm exec <name> --schema <n>   — 查看某 MSM 的参数 schema
acc_msm exec <name> --format=json  — JSON 输出模式（其余参数无损透传）
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
  /** register: flags JSON 字符串（对齐 osp --flags 入参；如 '[{"name":"hook","type":"string",...}]'） */
  flags?: string
  /** register: 自定义 usage（缺省 'acc_msm exec <name> [args...]'） */
  usage?: string
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

/** 扫描各 skill scripts/ 下的非测试脚本（DC-M3 正向基准，对齐 osp） */
export function scanSkillScripts(root: string): string[] {
  const out: string[] = []
  const skillsDir = join(root, '.opencode', 'skills')
  if (!existsSync(skillsDir)) return out
  for (const skill of readdirSync(skillsDir)) {
    const scriptsDir = join(skillsDir, skill, 'scripts')
    if (!existsSync(scriptsDir)) continue
    for (const f of readdirSync(scriptsDir)) {
      if (/\.(ts|js|mjs)$/.test(f) && !/\.(test|spec)\./.test(f)) {
        out.push(join('.opencode', 'skills', skill, 'scripts', f))
      }
    }
  }
  return out.sort()
}

function registryPathFor(root: string, skill?: string): string {
  return skill
    ? join(root, '.opencode', 'skills', skill, 'references', 'mech-registry.json')
    : join(root, 'mech-registry.json')
}

function writeRegistry(path: string, entries: MsmEntry[], isV1Wrapped = true): void {
  mkdirSync(dirname(path), { recursive: true })
  const payload = isV1Wrapped
    ? JSON.stringify({ version: 1, description: 'MSM registry (managed by acc-msm / dsh-serenity-hooks)', entries }, null, 2) + '\n'
    : JSON.stringify(entries, null, 2) + '\n'
  writeFileSync(path, payload, 'utf-8')
}

export function runMsm(root: string, args: MsmArgs): JsonValue {
  switch (args.action) {
    case 'list': {
      const entries = loadMsmEntries(root)
      const cccName = readCccName(root) ?? 'unknown'
      const header = `(serenity-plugin v${ACC_VERSION}) CCC:${cccName} Root:${root}`
      if (entries.length === 0) return `${header}\n(no MSM registered)`
      const lines = entries.map((e) => {
        const base = `${e.name} | ${e.skill ?? '-'} | ${e.category ?? '-'} | ${e.description ?? ''}`
        if (e.flags && e.flags.length > 0) {
          const flags = e.flags.map((f) => `--${f.name} <${f.type ?? 'string'}>`).join(', ')
          return `${base} [flags: ${flags}]`
        }
        return base
      })
      return `${header}\n` + lines.join('\n')
    }

    case 'guide':
      return { guide: MSM_GUIDE }

    case 'exec': {
      const { entry, businessArgs, fmtJson, protocol } = prepareExec(root, args)
      const p = protocolResult(protocol)
      if (p !== undefined) return p
      // bun 优先（可直跑 TS），npx tsx 回退；注入 SERENITY_* env（对齐 osp）
      let r = spawnSync('bun', [entry.path, ...businessArgs], { cwd: root, encoding: 'utf-8', timeout: MSM_TIMEOUT_MS, stdio: ['pipe', 'pipe', 'pipe'], env: buildMsmEnv(root) })
      if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') {
        r = spawnSync(NPX_BIN, ['tsx', entry.path, ...businessArgs], { cwd: root, encoding: 'utf-8', timeout: MSM_TIMEOUT_MS, stdio: ['pipe', 'pipe', 'pipe'], env: buildMsmEnv(root) })
      }
      return msmExecResult(entry.name, r.status ?? 2, r.stdout ?? '', r.stderr ?? '', fmtJson)
    }

    case 'register': {
      const name = args.name ?? ''
      const { skill, path, category, description } = args
      if (!name) throw new Error('register 需要 name')
      if (!path || !category || !description) throw new Error('register 需要 path/category/description')
      // 对齐 osp：path 必须根内 + 脚本必须存在
      const scriptAbs = resolve(root, path)
      if (classifyPath(scriptAbs, root) === 'outside') {
        throw new Error(`MSM register: path "${path}" escapes CCC root "${root}"`)
      }
      if (!existsSync(scriptAbs)) {
        throw new Error(`MSM script not found: "${path}"`)
      }
      // 对齐 osp：name 全局唯一（聚合所有注册表判重，与 loadMsmEntries 一致）
      if (loadMsmEntries(root).some((e) => e.name === name)) {
        throw new Error(`MSM already registered: "${name}"`)
      }
      const regPath = registryPathFor(root, skill)
      // 对齐 osp：保留原注册表格式（数组 vs v1 wrapper）
      const isV1Wrapped = existsSync(regPath) && !Array.isArray(JSON.parse(readFileSync(regPath, 'utf-8')))
      const entries = existsSync(regPath) ? parseRegistry(readFileSync(regPath, 'utf-8')) : []
      // flags/usage 入参（对齐 osp：可选，缺省空数组 / 自描述 usage）
      let flags: MsmFlag[] | undefined
      if (args.flags) {
        try {
          const parsed = JSON.parse(args.flags) as unknown
          if (!Array.isArray(parsed)) throw new Error('flags must be a JSON array')
          flags = parsed as MsmFlag[]
        } catch (e) {
          throw new Error(`register flags 解析失败：${e instanceof Error ? e.message : String(e)}`)
        }
      }
      entries.push({
        name, path, skill, category, description,
        usage: args.usage ?? `acc_msm exec ${name} [args...]`,
        flags: flags ?? [],
      })
      writeRegistry(regPath, entries, isV1Wrapped)
      try {
        // 对齐 osp：精提交（只 add 注册表文件，非 add -A）
        const relRegistry = relative(root, regPath)
        execFileSync('git', ['add', '--', relRegistry], { cwd: root, stdio: 'pipe' })
        execFileSync('git', ['commit', '-m', `chore(msm): register ${name}`], { cwd: root, stdio: 'pipe' })
      } catch {
        /* 非 git 环境忽略 */
      }
      return { registered: name, registry: relative(root, regPath) }
    }

    case 'deregister': {
      const name = args.name ?? ''
      for (const regPath of findRegistries(root)) {
        const isV1Wrapped = !Array.isArray(JSON.parse(readFileSync(regPath, 'utf-8')))
        const entries = parseRegistry(readFileSync(regPath, 'utf-8'))
        const idx = entries.findIndex((e) => e.name === name)
        if (idx >= 0) {
          entries.splice(idx, 1)
          writeRegistry(regPath, entries, isV1Wrapped)
          try {
            const relRegistry = relative(root, regPath)
            execFileSync('git', ['add', '--', relRegistry], { cwd: root, stdio: 'pipe' })
            execFileSync('git', ['commit', '-m', `chore(msm): deregister ${name}`], { cwd: root, stdio: 'pipe' })
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
      // DC-M3 正向：扫描 skills scripts/ 下未注册的脚本（对齐 osp 脚本驱动）
      const registeredPaths = new Set(entries.map((e) => e.path))
      for (const scriptPath of scanSkillScripts(root)) {
        if (!registeredPaths.has(scriptPath)) {
          issues.push({ name: scriptPath, check: 'M3', detail: 'script not registered in mech-registry' })
        }
      }
      for (const e of entries) {
        const script = join(root, e.path)
        const scriptExists = existsSync(script)
        // DC-M3 反向：注册表引用但脚本缺失
        if (!scriptExists) issues.push({ name: e.name, check: 'M3', detail: `script missing (${e.path})` })
        // DC-M1：有 .test.ts 或 .spec.ts（对齐 osp）
        const testFileTs = script.replace(/\.ts$/, '.test.ts')
        const testFileSpec = script.replace(/\.ts$/, '.spec.ts')
        if (!existsSync(testFileTs) && !existsSync(testFileSpec)) {
          issues.push({ name: e.name, check: 'M1', detail: 'no .test.ts / .spec.ts' })
        }
        // DC-M2：main() 守卫（function main( / isMain / require.main === / import.meta.url，对齐 osp 判定）
        if (scriptExists) {
          const src = readFileSync(script, 'utf-8')
          const hasGuard =
            /function main\(/.test(src) ||
            /\bisMain\b/.test(src) ||
            /require\.main\s*===/.test(src) ||
            /import\.meta\.url/.test(src)
          if (!hasGuard) issues.push({ name: e.name, check: 'M2', detail: 'no main() guard' })
        }
        // DC-M4：路径型 flag 必须标记 type:"path"（对齐 osp）
        for (const f of e.flags ?? []) {
          if ('name' in f && /path|file|dir/i.test(f.name) && f.type !== 'path') {
            issues.push({ name: e.name, check: 'M4', detail: `flag --${f.name} should be type:"path"` })
          }
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

  // 协议 flag：仅在业务参数**首位**识别（--list / --schema <name> / --format=json）——
  // 业务参数中后置的同名 flag 一律无损透传（对齐 osp 无损透传承诺，避免误拦截）
  if (business[0] === '--list') {
    return {
      entry,
      businessArgs: [],
      fmtJson: false,
      protocol: { list: loadMsmEntries(root).map((e) => ({ name: e.name, category: e.category ?? null })) },
    }
  }
  if (business[0] === '--schema') {
    const target = business[1]
    const found = target ? loadMsmEntries(root).find((e) => e.name === target) : null
    if (!found) throw new Error(`MSM not registered: "${target}"`)
    return {
      entry,
      businessArgs: [],
      fmtJson: false,
      protocol: { schema: { name: found.name, path: found.path, flags: (found.flags ?? []).map((f) => ({ name: f.name, type: f.type ?? null, description: f.description ?? null })) } },
    }
  }
  const fmtJson = business[0] === '--format=json'
  const businessArgs = fmtJson ? business.slice(1) : business

  // path-arg 逃逸校验（ACC 标准，对齐 osp）：flags 中 type:"path" 的参数值必须根内 + symlink 防御
  for (const flag of entry.flags ?? []) {
    if (flag.type !== 'path') continue
    const eq = businessArgs.find((a) => a.startsWith(`--${flag.name}=`))
    if (eq) {
      assertPathInsideRoot(root, eq.slice(flag.name.length + 3), flag.name)
    } else {
      const idx = businessArgs.indexOf(`--${flag.name}`)
      if (idx >= 0 && businessArgs[idx + 1]) {
        assertPathInsideRoot(root, businessArgs[idx + 1]!, flag.name)
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
  // bun 优先（可直跑 TS），npx tsx 回退；注入 SERENITY_* env（对齐 osp）
  try {
    const r = await execFileAsync('bun', [entry.path, ...businessArgs], {
      cwd: root,
      encoding: 'utf-8',
      timeout: MSM_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      env: buildMsmEnv(root),
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
          env: buildMsmEnv(root),
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
