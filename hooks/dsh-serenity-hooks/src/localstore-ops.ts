/**
 * localstore-ops.ts — localstore 纯逻辑层（零 DSH 依赖，可独立单测）
 *
 * S134 重设计（v1.16.7）：存储从 ~/.serenity/ 迁到 **CCC 根根目录 localstore.json**
 * （JSON 格式——方便 MSM 直接 read + JSON.parse 读取，零解析依赖）。
 *
 * git 提交策略（可靠机制 × 用户自由）：
 *   - 配置：.opencode/serenity.json `localstore.gitTrack`: "allow"（可提交）| "deny"（禁提交）
 *   - **缺省 deny（没配就是不提交）**；且 deny 的保证**不依赖 dsh 运行**——
 *     写入时自动确保 .gitignore 含 localstore.json（物理保证：即使 dsh 不在、
 *     用户手动 git commit 也不会误提交），cc_git 检查为第二道防线（拒绝 + 提示）
 *   - allow：放行（文件可提交，用户自行管理 .gitignore）
 *
 * 存储结构（JSON 顶层分节）：
 *   { "credentials": { "HOME_GITLAB_TOKEN": "xxx" }, "<config节>": { "<key>": "v" } }
 *   credentials 为保留节（credential 命名空间，key 大写蛇形）；其余节归 config 命名空间
 *   （path = section.key，如 handyman.models）。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadSerenityConfig, DEFAULT_SERENITY_CONFIG_PATHS } from './ccc.js'
import type { JsonValue } from './json.js'

/** 命名空间：credential（凭据）| config（配置） */
export type LocalStoreScope = 'credential' | 'config'

export const LOCALSTORE_SCOPES: readonly LocalStoreScope[] = ['credential', 'config']

/** 存储文件名（CCC 根根目录） */
export const LOCALSTORE_FILENAME = 'localstore.json'

/** 凭据保留节名（JSON 顶层） */
export const CREDENTIALS_SECTION = 'credentials'

/** 凭据 key 规范：大写蛇形，如 HOME_GITLAB_TOKEN */
export const CREDENTIAL_KEY_RE = /^[A-Z][A-Z0-9_]*$/

/** 配置节名规范：小写字母数字连字符 */
export const CONFIG_SECTION_RE = /^[a-z][a-z0-9-]*$/

/** 配置 key 规范（节内）：小驼峰，如 defaultModel */
export const CONFIG_KEY_RE = /^[a-z][a-zA-Z0-9_]*$/

/** git 提交策略 */
export type GitTrack = 'allow' | 'deny'

// ── 路径与 git 策略 ──

/** 存储文件绝对路径（CCC 根根目录） */
export function localstorePath(root: string): string {
  return join(root, LOCALSTORE_FILENAME)
}

/** git 策略：serenity.json localstore.gitTrack，缺省 deny（不提交） */
export function readGitTrack(root: string, paths: string[] = DEFAULT_SERENITY_CONFIG_PATHS): GitTrack {
  const cfg = loadSerenityConfig(root, paths)
  return cfg.localstore?.gitTrack === 'allow' ? 'allow' : 'deny'
}

/** .gitignore 是否已覆盖 localstore 文件（非空非注释行含文件名即算） */
export function isLocalstoreGitignored(root: string): boolean {
  const gi = join(root, '.gitignore')
  if (!existsSync(gi)) return false
  return readFileSync(gi, 'utf-8')
    .split('\n')
    .some((l) => {
      const t = l.trim()
      return t !== '' && !t.startsWith('#') && t.includes(LOCALSTORE_FILENAME)
    })
}

/**
 * 确保 .gitignore 含 localstore 文件（deny 时的物理保证，不依赖 dsh 运行）：
 * 写入 localstore 时调用——deny（含缺省）且 .gitignore 未覆盖 → 自动追加一行。
 * allow → 不写入（放行，文件可提交）。
 */
export function ensureLocalstoreGitignored(root: string): { status: 'allow' | 'ignored' | 'appended' } {
  if (readGitTrack(root) === 'allow') return { status: 'allow' }
  if (isLocalstoreGitignored(root)) return { status: 'ignored' }
  const gi = join(root, '.gitignore')
  const existing = existsSync(gi) ? readFileSync(gi, 'utf-8') : ''
  const line = `${LOCALSTORE_FILENAME}  # ACC localstore (localstore.gitTrack defaults to deny — do not commit)`
  writeFileSync(gi, (existing.endsWith('\n') || existing === '' ? existing : existing + '\n') + line + '\n', 'utf-8')
  return { status: 'appended' }
}

/**
 * cc_git 联动检查（第二道防线）：文件存在 && deny && .gitignore 未覆盖 → 不通过。
 * 调用方（cc_git commit）据此拒绝提交；status 可输出 warning。
 */
export function checkLocalstoreGitCompliance(root: string): { ok: boolean; reason?: string } {
  if (!existsSync(localstorePath(root))) return { ok: true }
  if (readGitTrack(root) === 'allow') return { ok: true }
  if (isLocalstoreGitignored(root)) return { ok: true }
  return {
    ok: false,
    reason: `localstore.json must not be committed (localstore.gitTrack=deny default) but .gitignore does not cover it — add ${LOCALSTORE_FILENAME} to .gitignore (or set localstore.gitTrack=allow to explicitly permit)`,
  }
}

// ── JSON 读写（顶层分节）──

type StoreShape = Record<string, Record<string, string>>

/** 读取全文件（顶层分节）；文件不存在/坏 JSON 返回空 */
function readAll(root: string): StoreShape {
  const p = localstorePath(root)
  if (!existsSync(p)) return {}
  try {
    const v = JSON.parse(readFileSync(p, 'utf-8').replace(/^\uFEFF/, '')) as unknown
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as StoreShape
    return {}
  } catch {
    return {}
  }
}

/** 写回全文件（2 空格缩进 + 尾换行，方便 MSM 直接读取） */
function writeAll(root: string, data: StoreShape): void {
  writeFileSync(localstorePath(root), JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

/** 读取命名空间全部条目：credential → 扁平；config → 分节（剔除 credentials 保留节） */
export function readStore(root: string, scope: LocalStoreScope): Record<string, string> | Record<string, Record<string, string>> {
  const all = readAll(root)
  if (scope === 'credential') return all[CREDENTIALS_SECTION] ?? {}
  const { [CREDENTIALS_SECTION]: _cred, ...rest } = all
  return rest
}

/** 校验凭据 key 合法（大写蛇形）；不合法抛错 */
export function assertCredentialKey(key: string): void {
  if (!CREDENTIAL_KEY_RE.test(key)) {
    throw new Error(`credential key "${key}" must match UPPER_SNAKE ^[A-Z][A-Z0-9_]*$ (e.g. HOME_GITLAB_TOKEN)`)
  }
}

/** 校验 config 路径（节.key）；不合法抛错 */
export function assertConfigPath(path: string): { section: string; key: string } {
  const idx = path.indexOf('.')
  if (idx <= 0 || idx === path.length - 1) {
    throw new Error(`config path "${path}" must be section.key (e.g. handyman.models)`)
  }
  const section = path.slice(0, idx)
  const key = path.slice(idx + 1)
  if (!CONFIG_SECTION_RE.test(section)) {
    throw new Error(`config section "${section}" must match ^[a-z][a-z0-9-]*$`)
  }
  if (!CONFIG_KEY_RE.test(key)) {
    throw new Error(`config key "${key}" must match lowerCamel ^[a-z][a-zA-Z0-9_]*$ (e.g. defaultModel)`)
  }
  return { section, key }
}

/** 写入单个条目（自动建文件；deny 默认时同步确保 .gitignore 物理保证） */
export function writeEntry(root: string, scope: LocalStoreScope, name: string, value: string): void {
  const all = readAll(root)
  if (scope === 'credential') {
    assertCredentialKey(name)
    all[CREDENTIALS_SECTION] ??= {}
    all[CREDENTIALS_SECTION]![name] = value
  } else {
    const { section, key } = assertConfigPath(name)
    all[section] ??= {}
    all[section]![key] = value
  }
  writeAll(root, all)
  ensureLocalstoreGitignored(root)
}

/** 删除单个条目（不存在返回 false）；空节自动移除 */
export function unsetEntry(root: string, scope: LocalStoreScope, name: string): boolean {
  const all = readAll(root)
  if (scope === 'credential') {
    assertCredentialKey(name)
    const sec = all[CREDENTIALS_SECTION]
    if (!sec || !(name in sec)) return false
    delete sec[name]
    if (Object.keys(sec).length === 0) delete all[CREDENTIALS_SECTION]
  } else {
    const { section, key } = assertConfigPath(name)
    const sec = all[section]
    if (!sec || !(key in sec)) return false
    delete sec[key]
    if (Object.keys(sec).length === 0) delete all[section]
  }
  writeAll(root, all)
  return true
}

/** 读取单个条目值；不存在返回 null */
export function getEntry(root: string, scope: LocalStoreScope, name: string): string | null {
  const all = readAll(root)
  if (scope === 'credential') {
    assertCredentialKey(name)
    return all[CREDENTIALS_SECTION]?.[name] ?? null
  }
  const { section, key } = assertConfigPath(name)
  return all[section]?.[key] ?? null
}

/** 列出 key（凭据只返回 key 名，不返回值） */
export function listKeys(root: string, scope: LocalStoreScope): string[] {
  const data = readStore(root, scope)
  if (scope === 'credential') {
    return Object.keys(data as Record<string, string>)
  }
  const sections = data as Record<string, Record<string, string>>
  return Object.entries(sections).flatMap(([section, entries]) =>
    Object.keys(entries).map((key) => `${section}.${key}`),
  )
}

/**
 * doc 说明文本：输出存储位置/格式/key 规范/git 策略/读写方法。
 * agent 据此可直接用 fs 工具（read/write）自己读写凭据/配置。
 */
export function docText(root: string): string {
  const path = localstorePath(root)
  return [
    '# localstore — ACC local credential/config storage (standard, S134 redesign)',
    '',
    'One tool manages two namespaces: credential (credentials) + config (preferences).',
    `Stored at the CCC root in ${path} (JSON format; MSMs can read + JSON.parse directly).`,
    '',
    '## Git commit policy',
    '- Config: .opencode/serenity.json `localstore.gitTrack`: `"allow"` (may commit) | `"deny"` (must not commit; .dsh fallback)',
    '- **Default deny (unset = not committed)**; when deny, writes automatically ensure .gitignore contains localstore.json',
    '  (physical guarantee, independent of dsh runtime); cc_git commit checks and refuses',
    '- To commit: set `"localstore": { "gitTrack": "allow" }` and remove localstore.json from .gitignore',
    '',
    '## Format (JSON top-level sections)',
    '```json',
    '{',
    '  "credentials": {',
    '    "HOME_GITLAB_TOKEN": "xxx"',
    '  },',
    '  "handyman": {',
    '    "models": ["minimax-cn-coding-plan/MiniMax-M3"]',
    '  }',
    '}',
    '```',
    '- credentials is a reserved section (credentials, UPPER_SNAKE keys); other sections = config (path = section.key)',
    '',
    '## Key conventions',
    '- credential key: ^[A-Z][A-Z0-9_]*$ (e.g. HOME_GITLAB_TOKEN)',
    '- config path: section.key (section ^[a-z][a-z0-9-]*$, key lowerCamel ^[a-z][a-zA-Z0-9_]*$, e.g. handyman.models)',
    '',
    '## Reading (agents may use fs tools directly)',
    `- Read ${path} with the read tool → JSON.parse`,
    '- Or use localstore get <name> [--scope credential|config]',
    '',
    '## Writing',
    '- Recommended: localstore set <name> <value> [--scope ...] (auto-creates file / preserves other entries / syncs .gitignore)',
    '- Or modify the file directly with write/edit, keeping the JSON valid',
    '',
    '## Security boundary',
    '- list/show return only key names for credentials, never values',
    '- Credential values should be used internally by the agent; never write them into conversation or logs',
    '- Default deny: the file is not committed to git (.gitignore physical guarantee + cc_git check fallback)',
    '',
  ].join('\n')
}

/** 运行 localstore 操作（纯逻辑；返回 JSON 值供工具 render） */
export function runLocalStore(root: string, args: {
  action: string
  name?: string
  value?: string
  scope?: string
}): JsonValue {
  const scope: LocalStoreScope = args.scope === 'config' ? 'config' : 'credential'
  switch (args.action) {
    case 'list':
      return { scope, keys: listKeys(root, scope) }
    case 'get': {
      if (!args.name) throw new Error('get requires name')
      const value = getEntry(root, scope, args.name)
      if (value === null) throw new Error(`not found: ${args.name} (scope=${scope})`)
      return { scope, name: args.name, value, source: scope }
    }
    case 'set': {
      if (!args.name) throw new Error('set requires name')
      if (args.value === undefined) throw new Error('set requires value')
      writeEntry(root, scope, args.name, args.value)
      const git = checkLocalstoreGitCompliance(root)
      return {
        scope, name: args.name, set: true, path: localstorePath(root),
        gitTrack: readGitTrack(root), gitOk: git.ok,
        git: git.reason ? { warning: git.reason } : null,
      }
    }
    case 'unset': {
      if (!args.name) throw new Error('unset requires name')
      const removed = unsetEntry(root, scope, args.name)
      return { scope, name: args.name, removed }
    }
    case 'show': {
      if (!args.name) throw new Error('show requires name')
      const exists = getEntry(root, scope, args.name) !== null
      return { scope, name: args.name, exists, path: localstorePath(root) }
    }
    case 'doc':
      return { doc: docText(root) }
    default:
      throw new Error(`Unknown subcommand: ${args.action} (available: list/get/set/unset/show/doc)`)
  }
}
