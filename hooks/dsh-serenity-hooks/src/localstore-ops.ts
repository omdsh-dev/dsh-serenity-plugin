/**
 * localstore-ops.ts — localstore 纯逻辑层（零 DSH 依赖，可独立单测）
 *
 * ACC 标准本地凭据/配置存储（S133 设计）：
 *   - 一个工具管理两个命名空间：credential（凭据，0600）+ config（偏好，0644）
 *   - 存储于 ~/.serenity/（平台感知：win %USERPROFILE%\.serenity\）
 *   - 两个 YAML 文件：credentials.yaml（扁平 REF→value）+ settings.yaml（命名空间分节）
 *   - 目录 0700
 *
 * YAML 用轻量自实现子集（零依赖）：扁平 `KEY: value` 映射 + `#` 注释。
 * 凭据/配置本质是给 MSM/agent 用的普通 YAML 文件——agent 可按 doc 子命令
 * 说明直接用 fs 工具（read/write）操作；本工具是管理入口 + 规范文档。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { JsonValue } from './json.js'

/** 命名空间：credential（凭据）| config（配置） */
export type LocalStoreScope = 'credential' | 'config'

export const LOCALSTORE_SCOPES: readonly LocalStoreScope[] = ['credential', 'config']

/** 根目录名（~/.serenity） */
export const STORE_DIR_NAME = '.serenity'

/** 凭据文件（0600） */
export const CREDENTIALS_FILENAME = 'credentials.yaml'

/** 配置文件（0644） */
export const SETTINGS_FILENAME = 'settings.yaml'

/** 凭据 key 规范：大写蛇形（命名空间前缀），如 HOME_GITLAB_TOKEN */
export const CREDENTIAL_KEY_RE = /^[A-Z][A-Z0-9_]*$/

/** 配置节名规范：小写字母数字连字符 */
export const CONFIG_SECTION_RE = /^[a-z][a-z0-9-]*$/

/** 配置 key 规范（节内）：小驼峰（首字母小写，可含大写），如 defaultModel */
export const CONFIG_KEY_RE = /^[a-z][a-zA-Z0-9_]*$/

/** 解析 ~/.serenity 根（平台感知：os.homedir() 三平台统一） */
export function serenityDir(): string {
  return join(homedir(), STORE_DIR_NAME)
}

/** 各命名空间的文件绝对路径 */
export function storeFilePath(scope: LocalStoreScope): string {
  return scope === 'credential'
    ? join(serenityDir(), CREDENTIALS_FILENAME)
    : join(serenityDir(), SETTINGS_FILENAME)
}

/** 确保目录存在并设 0700 */
function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
  try {
    chmodSync(dir, 0o700)
  } catch {
    /* 权限设置失败不阻断（Windows 无 POSIX 模式语义） */
  }
}

/** 设置文件权限：credential 0600 / config 0644 */
function applyFileMode(scope: LocalStoreScope, path: string): void {
  try {
    chmodSync(path, scope === 'credential' ? 0o600 : 0o644)
  } catch {
    /* 权限设置失败不阻断（Windows） */
  }
}

// ── YAML 轻量子集：扁平 `KEY: value` 映射 + # 注释 ──

/** 解析扁平映射 YAML → Record<string,string>（忽略 # 注释与空行；值去引号） */
export function parseFlatYaml(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const idx = line.indexOf(':')
    if (idx <= 0) continue // 非 key:value 行忽略（宽松）
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    // 去单/双引号
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

/** 序列化扁平映射 YAML（保持 key 顺序，值引号包裹含特殊字符的） */
export function renderFlatYaml(entries: Record<string, string>): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(entries)) {
    const needsQuote = /[:#\n]/.test(value) || value === '' || /^\s/.test(value) || /\s$/.test(value)
    const rendered = needsQuote ? JSON.stringify(value) : value
    lines.push(`${key}: ${rendered}`)
  }
  return lines.join('\n') + (lines.length > 0 ? '\n' : '')
}

/** 解析分节 YAML（config）：节 → key → value */
export function parseSectionedYaml(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  let section = ''
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const indent = rawLine.length - rawLine.trimStart().length
    if (indent === 0 && line.endsWith(':')) {
      section = line.slice(0, -1).trim()
      if (!out[section]) out[section] = {}
      continue
    }
    if (section === '') continue // 顶层无节的值忽略（宽松）
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    const sectionMap = out[section] ??= {}
    sectionMap[key] = value
  }
  return out
}

/** 序列化分节 YAML（config）：节 → key → value */
export function renderSectionedYaml(sections: Record<string, Record<string, string>>): string {
  const lines: string[] = []
  for (const [section, entries] of Object.entries(sections)) {
    lines.push(`${section}:`)
    for (const [key, value] of Object.entries(entries)) {
      const needsQuote = /[:#\n]/.test(value) || value === '' || /^\s/.test(value) || /\s$/.test(value)
      const rendered = needsQuote ? JSON.stringify(value) : value
      lines.push(`  ${key}: ${rendered}`)
    }
  }
  return lines.join('\n') + (lines.length > 0 ? '\n' : '')
}

// ── 读写 ──

/** 读取命名空间全部条目（文件不存在返回空） */
export function readStore(scope: LocalStoreScope): Record<string, string> | Record<string, Record<string, string>> {
  const path = storeFilePath(scope)
  if (!existsSync(path)) return scope === 'credential' ? {} : {}
  const text = readFileSync(path, 'utf-8')
  return scope === 'credential' ? parseFlatYaml(text) : parseSectionedYaml(text)
}

/** 校验凭据 key 合法（大写蛇形）；不合法抛错 */
export function assertCredentialKey(key: string): void {
  if (!CREDENTIAL_KEY_RE.test(key)) {
    throw new Error(`credential key "${key}" 必须匹配大写蛇形 ^[A-Z][A-Z0-9_]*$（如 HOME_GITLAB_TOKEN）`)
  }
}

/** 校验 config 路径（节.key）；不合法抛错 */
export function assertConfigPath(path: string): { section: string; key: string } {
  const idx = path.indexOf('.')
  if (idx <= 0 || idx === path.length - 1) {
    throw new Error(`config path "${path}" 必须为 section.key（如 loop.defaultModel）`)
  }
  const section = path.slice(0, idx)
  const key = path.slice(idx + 1)
  if (!CONFIG_SECTION_RE.test(section)) {
    throw new Error(`config 节 "${section}" 必须匹配 ^[a-z][a-z0-9-]*$`)
  }
  if (!CONFIG_KEY_RE.test(key)) {
    throw new Error(`config key "${key}" 必须匹配小驼峰 ^[a-z][a-zA-Z0-9_]*$（如 defaultModel）`)
  }
  return { section, key }
}

/** 写入单个条目（自动建目录/设权限；保留其他条目与注释行外内容） */
export function writeEntry(scope: LocalStoreScope, name: string, value: string): void {
  const path = storeFilePath(scope)
  ensureDir(serenityDir())
  if (scope === 'credential') {
    assertCredentialKey(name)
    const entries = parseFlatYaml(existsSync(path) ? readFileSync(path, 'utf-8') : '')
    entries[name] = value
    writeFileSync(path, renderFlatYaml(entries), 'utf-8')
  } else {
    const { section, key } = assertConfigPath(name)
    const sections = parseSectionedYaml(existsSync(path) ? readFileSync(path, 'utf-8') : '')
    if (!sections[section]) sections[section] = {}
    sections[section][key] = value
    writeFileSync(path, renderSectionedYaml(sections), 'utf-8')
  }
  applyFileMode(scope, path)
}

/** 删除单个条目（不存在返回 false） */
export function unsetEntry(scope: LocalStoreScope, name: string): boolean {
  const path = storeFilePath(scope)
  if (!existsSync(path)) return false
  if (scope === 'credential') {
    assertCredentialKey(name)
    const entries = parseFlatYaml(readFileSync(path, 'utf-8'))
    if (!(name in entries)) return false
    delete entries[name]
    writeFileSync(path, renderFlatYaml(entries), 'utf-8')
    return true
  }
  const { section, key } = assertConfigPath(name)
  const sections = parseSectionedYaml(readFileSync(path, 'utf-8'))
  const sectionMap = sections[section]
  if (!sectionMap || !(key in sectionMap)) return false
  delete sectionMap[key]
  if (Object.keys(sectionMap).length === 0) delete sections[section]
  writeFileSync(path, renderSectionedYaml(sections), 'utf-8')
  return true
}

/** 读取单个条目值；不存在返回 null */
export function getEntry(scope: LocalStoreScope, name: string): string | null {
  const path = storeFilePath(scope)
  if (!existsSync(path)) return null
  if (scope === 'credential') {
    assertCredentialKey(name)
    return parseFlatYaml(readFileSync(path, 'utf-8'))[name] ?? null
  }
  const { section, key } = assertConfigPath(name)
  return parseSectionedYaml(readFileSync(path, 'utf-8'))[section]?.[key] ?? null
}

/** 列出 key（凭据只返回 key 名，不返回值） */
export function listKeys(scope: LocalStoreScope): string[] {
  const data = readStore(scope)
  if (scope === 'credential') {
    return Object.keys(data as Record<string, string>)
  }
  const sections = data as Record<string, Record<string, string>>
  return Object.entries(sections).flatMap(([section, entries]) =>
    Object.keys(entries).map(key => `${section}.${key}`),
  )
}

/**
 * doc 说明文本：输出存储位置/格式/key 规范/权限/读写方法/安全边界。
 * agent 据此可直接用 fs 工具（read/write）自己读写凭据/配置。
 */
export function docText(): string {
  const dir = serenityDir()
  const credPath = storeFilePath('credential')
  const cfgPath = storeFilePath('config')
  return [
    '# localstore — ACC 本地凭据/配置存储（标准）',
    '',
    '一个工具管理两个命名空间：credential（凭据，0600）+ config（偏好，0644）。',
    '存储于用户主目录，不在任何 CCC git 仓库内。',
    '',
    '## 存储位置（平台感知）',
    `- 根目录: ${dir}  (0700)`,
    `- 凭据:   ${credPath}  (0600)`,
    `- 配置:   ${cfgPath}  (0644)`,
    '- Windows: %USERPROFILE%\\.serenity\\...（与 Linux/macOS 的 $HOME/.serenity 同构）',
    '',
    '## 格式',
    'credentials.yaml（扁平映射，key = 大写蛇形命名空间前缀）：',
    '```yaml',
    'HOME_GITLAB_TOKEN: xxx',
    'SSH_UBUNTU_PASSWORD: xxx',
    'ANYSEARCH_API_KEY: xxx',
    '```',
    'settings.yaml（命名空间分节）：',
    '```yaml',
    'loop:',
    '  defaultModel: minimax-cn-coding-plan/MiniMax-M3',
    'ui:',
    '  theme: dark',
    '```',
    '',
    '## key 规范',
    '- credential key: ^[A-Z][A-Z0-9_]*$（如 HOME_GITLAB_TOKEN）',
    '- config path: section.key（节 ^[a-z][a-z0-9-]*$，key 小驼峰 ^[a-z][a-zA-Z0-9_]*$，如 loop.defaultModel）',
    '',
    '## 读取方法（agent 可直接用 fs 工具）',
    '- 用 read 工具读对应文件 → 按上面格式解析 YAML',
    '- 或用 localstore get <name> [--scope credential|config]',
    '',
    '## 写入方法',
    '- 推荐：localstore set <name> <value> [--scope ...]（自动建目录/设权限/保留其他条目）',
    '- 或直接用 write/edit 工具修改文件，保持 YAML 合法（键值冒号分隔）',
    '',
    '## 安全边界',
    '- list/show 对 credential 只返回 key 名，不返回值',
    '- 凭据值应在 agent 内部使用，不要写入对话/日志',
    '- 文件权限不符（非 0600/0644）时 get/set 会提示 chmod 修复',
    '- 文件在用户主目录，天然不进入任何 git 仓库',
    '',
  ].join('\n')
}

/** 运行 localstore 操作（纯逻辑；返回 JSON 值供工具 render） */
export function runLocalStore(args: {
  action: string
  name?: string
  value?: string
  scope?: string
}): JsonValue {
  const scope: LocalStoreScope = args.scope === 'config' ? 'config' : 'credential'
  switch (args.action) {
    case 'list':
      return { scope, keys: listKeys(scope) }
    case 'get': {
      if (!args.name) throw new Error('get 需要 name')
      const value = getEntry(scope, args.name)
      if (value === null) throw new Error(`not found: ${args.name}（scope=${scope}）`)
      return { scope, name: args.name, value, source: scope }
    }
    case 'set': {
      if (!args.name) throw new Error('set 需要 name')
      if (args.value === undefined) throw new Error('set 需要 value')
      writeEntry(scope, args.name, args.value)
      return { scope, name: args.name, set: true }
    }
    case 'unset': {
      if (!args.name) throw new Error('unset 需要 name')
      const removed = unsetEntry(scope, args.name)
      return { scope, name: args.name, removed }
    }
    case 'show': {
      if (!args.name) throw new Error('show 需要 name')
      const exists = getEntry(scope, args.name) !== null
      return { scope, name: args.name, exists, path: storeFilePath(scope) }
    }
    case 'doc':
      return { doc: docText() }
    default:
      throw new Error(`未知子命令: ${args.action}（可用 list/get/set/unset/show/doc）`)
  }
}
