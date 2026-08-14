import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  localstorePath,
  LOCALSTORE_FILENAME,
  readGitTrack,
  isLocalstoreGitignored,
  ensureLocalstoreGitignored,
  checkLocalstoreGitCompliance,
  writeEntry,
  unsetEntry,
  getEntry,
  listKeys,
  docText,
  runLocalStore,
  CREDENTIAL_KEY_RE,
} from '../src/localstore-ops.js'

/**
 * localstore-ops 单元测试（S134 重设计：CCC 根 localstore.json + git 策略）。
 * 核心：JSON 单文件 / 双命名空间（credentials 节 + config 节）/ deny 缺省
 * gitignore 物理保证 / cc_git 联动检查。
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'localstore-'))
  writeFileSync(join(dir, '.serenity'), 'test')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('localstore: 路径与 git 策略', () => {
  it('存储路径 = CCC 根根目录 localstore.json', () => {
    expect(localstorePath(dir)).toBe(join(dir, LOCALSTORE_FILENAME))
    expect(LOCALSTORE_FILENAME).toBe('localstore.json')
  })

  it('gitTrack 缺省 deny（没配就是不提交）；allow 需显式配置', () => {
    expect(readGitTrack(dir)).toBe('deny')
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({ localstore: { gitTrack: 'allow' } }))
    expect(readGitTrack(dir)).toBe('allow')
  })

  it('isLocalstoreGitignored 按 .gitignore 内容判断（注释/空行不算）', () => {
    expect(isLocalstoreGitignored(dir)).toBe(false)
    writeFileSync(join(dir, '.gitignore'), '# localstore.json\nnode_modules/\n')
    expect(isLocalstoreGitignored(dir)).toBe(false) // 仅注释行
    writeFileSync(join(dir, '.gitignore'), 'localstore.json\n')
    expect(isLocalstoreGitignored(dir)).toBe(true)
  })

  it('ensureLocalstoreGitignored：deny 缺省自动追加；allow 跳过', () => {
    expect(ensureLocalstoreGitignored(dir).status).toBe('appended')
    expect(isLocalstoreGitignored(dir)).toBe(true)
    expect(ensureLocalstoreGitignored(dir).status).toBe('ignored') // 幂等

    const allowDir = join(dir, 'allow-ccc')
    mkdirSync(join(allowDir, '.opencode'), { recursive: true })
    writeFileSync(join(allowDir, '.serenity'), 'test')
    writeFileSync(join(allowDir, '.opencode', 'serenity.json'), JSON.stringify({ localstore: { gitTrack: 'allow' } }))
    expect(ensureLocalstoreGitignored(allowDir).status).toBe('allow')
    expect(isLocalstoreGitignored(allowDir)).toBe(false)
  })

  it('checkLocalstoreGitCompliance：无文件/allow/gitignore 覆盖 → ok；deny 未覆盖 → 拒绝', () => {
    expect(checkLocalstoreGitCompliance(dir).ok).toBe(true) // 无文件
    writeEntry(dir, 'credential', 'TEST_KEY', 'v') // 自动 gitignore
    expect(checkLocalstoreGitCompliance(dir).ok).toBe(true) // gitignore 已覆盖

    // 用户手删 .gitignore 行 → 不通过
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n')
    const r = checkLocalstoreGitCompliance(dir)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('localstore.json')

    // allow → 通过
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({ localstore: { gitTrack: 'allow' } }))
    expect(checkLocalstoreGitCompliance(dir).ok).toBe(true)
  })
})

describe('localstore: JSON 格式（顶层分节）', () => {
  it('writeEntry 产出合法 JSON：credentials 节 + config 节', () => {
    writeEntry(dir, 'credential', 'HOME_GITLAB_TOKEN', 'tok')
    writeEntry(dir, 'config', 'loop.defaultModel', 'm3')
    const raw = readFileSync(localstorePath(dir), 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, Record<string, string>>
    expect(parsed.credentials).toEqual({ HOME_GITLAB_TOKEN: 'tok' })
    expect(parsed.loop).toEqual({ defaultModel: 'm3' })
    // 无 YAML 痕迹
    expect(raw).not.toContain('credentials.yaml')
  })

  it('坏 JSON 视为空（宽松，不崩）', () => {
    writeFileSync(localstorePath(dir), '{ broken', 'utf-8')
    expect(listKeys(dir, 'credential')).toEqual([])
    writeEntry(dir, 'config', 'a.b', 'v') // 覆盖重写
    expect(getEntry(dir, 'config', 'a.b')).toBe('v')
  })
})

describe('localstore: 读写条目', () => {
  it('credential set/get/unset/list 往返', () => {
    writeEntry(dir, 'credential', 'HOME_GITLAB_TOKEN', 'tok123')
    expect(getEntry(dir, 'credential', 'HOME_GITLAB_TOKEN')).toBe('tok123')
    expect(listKeys(dir, 'credential')).toEqual(['HOME_GITLAB_TOKEN'])
    expect(unsetEntry(dir, 'credential', 'HOME_GITLAB_TOKEN')).toBe(true)
    expect(getEntry(dir, 'credential', 'HOME_GITLAB_TOKEN')).toBeNull()
    expect(listKeys(dir, 'credential')).toEqual([])
  })

  it('credential 写入保留其他条目', () => {
    writeEntry(dir, 'credential', 'A_KEY', 'a')
    writeEntry(dir, 'credential', 'B_KEY', 'b')
    writeEntry(dir, 'credential', 'A_KEY', 'a2')
    expect(getEntry(dir, 'credential', 'A_KEY')).toBe('a2')
    expect(getEntry(dir, 'credential', 'B_KEY')).toBe('b')
  })

  it('config section.key set/get/unset/list 往返（与凭据节共存）', () => {
    writeEntry(dir, 'credential', 'TOKEN', 't')
    writeEntry(dir, 'config', 'loop.defaultModel', 'm3')
    writeEntry(dir, 'config', 'ui.theme', 'dark')
    expect(getEntry(dir, 'config', 'loop.defaultModel')).toBe('m3')
    expect(listKeys(dir, 'config')).toEqual(['loop.defaultModel', 'ui.theme'])
    expect(listKeys(dir, 'credential')).toEqual(['TOKEN']) // 互不干扰
    expect(unsetEntry(dir, 'config', 'loop.defaultModel')).toBe(true)
    expect(getEntry(dir, 'config', 'loop.defaultModel')).toBeNull()
  })

  it('credential key 校验：非大写蛇形拒绝', () => {
    expect(CREDENTIAL_KEY_RE.test('home-gitlab')).toBe(false)
    expect(CREDENTIAL_KEY_RE.test('HOME_GITLAB_TOKEN')).toBe(true)
    expect(() => writeEntry(dir, 'credential', 'bad-key', 'x')).toThrow()
  })

  it('config path 校验：非 section.key 拒绝', () => {
    expect(() => writeEntry(dir, 'config', 'badpath', 'x')).toThrow()
    expect(() => writeEntry(dir, 'config', 'loop.BadKey', 'x')).toThrow()
  })
})

describe('localstore: runLocalStore 入口', () => {
  it('doc 返回规范文本（JSON 路径/格式/git 策略/key 规范）', () => {
    const r = runLocalStore(dir, { action: 'doc' }) as { doc: string }
    expect(r.doc).toContain('localstore.json')
    expect(r.doc).toContain('gitTrack')
    expect(r.doc).toContain('^[A-Z][A-Z0-9_]*$')
    expect(r.doc).toContain('credentials')
  })

  it('list 对 credential 只返回 key 名（不返回值）', () => {
    writeEntry(dir, 'credential', 'SECRET_X', 'top-secret')
    const r = runLocalStore(dir, { action: 'list' }) as { keys: string[] }
    expect(r.keys).toEqual(['SECRET_X'])
    expect(JSON.stringify(r)).not.toContain('top-secret')
  })

  it('get 返回值并标记 source', () => {
    writeEntry(dir, 'credential', 'SECRET_X', 'v1')
    const r = runLocalStore(dir, { action: 'get', name: 'SECRET_X' }) as { value: string; source: string }
    expect(r.value).toBe('v1')
    expect(r.source).toBe('credential')
  })

  it('set 返回 gitTrack/gitOk（deny 缺省时自动 gitignore）', () => {
    const r = runLocalStore(dir, { action: 'set', name: 'NEW_KEY', value: 'v' }) as { gitTrack: string; gitOk: boolean }
    expect(r.gitTrack).toBe('deny')
    expect(r.gitOk).toBe(true)
    expect(isLocalstoreGitignored(dir)).toBe(true)
  })

  it('show 对凭据只返回元数据（无值）', () => {
    writeEntry(dir, 'credential', 'SECRET_X', 'v1')
    const r = runLocalStore(dir, { action: 'show', name: 'SECRET_X' }) as { exists: boolean }
    expect(r.exists).toBe(true)
    expect(JSON.stringify(r)).not.toContain('v1')
  })
})
