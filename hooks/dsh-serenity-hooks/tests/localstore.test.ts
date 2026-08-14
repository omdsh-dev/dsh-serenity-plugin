import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  serenityDir,
  storeFilePath,
  parseFlatYaml,
  renderFlatYaml,
  parseSectionedYaml,
  renderSectionedYaml,
  writeEntry,
  unsetEntry,
  getEntry,
  listKeys,
  docText,
  runLocalStore,
  CREDENTIAL_KEY_RE,
} from '../src/localstore-ops.js'

/**
 * localstore-ops 单元测试（S133 ACC 标准本地凭据/配置存储）。
 * 核心：双命名空间（credential 0600 / config 0644）+ ~/.serenity/ + doc 规范。
 *
 * homedir 全程 mock 到临时目录——绝不触碰真实 ~/.serenity（凭据是敏感数据）。
 */

const fakeHomeHolder = vi.hoisted(() => ({ value: '' as string }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => fakeHomeHolder.value }
})

let fakeHome: string

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'localstore-'))
  fakeHomeHolder.value = fakeHome
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(fakeHome, { recursive: true, force: true })
})

describe('localstore: 路径与权限', () => {
  it('serenityDir 指向 ~/.serenity', () => {
    expect(serenityDir()).toBe(join(fakeHome, '.serenity'))
  })

  it('storeFilePath 按命名空间区分文件', () => {
    expect(storeFilePath('credential')).toBe(join(fakeHome, '.serenity', 'credentials.yaml'))
    expect(storeFilePath('config')).toBe(join(fakeHome, '.serenity', 'settings.yaml'))
  })

  it('writeEntry 建目录 0700 + 凭据文件 0600 + 配置文件 0644', () => {
    writeEntry('credential', 'TEST_KEY', 'secret')
    writeEntry('config', 'loop.defaultModel', 'm3')
    expect(statSync(serenityDir()).mode & 0o777).toBe(0o700)
    expect(statSync(storeFilePath('credential')).mode & 0o777).toBe(0o600)
    expect(statSync(storeFilePath('config')).mode & 0o777).toBe(0o644)
  })
})

describe('localstore: YAML 轻量解析', () => {
  it('parseFlatYaml 解析扁平映射（注释/空行忽略；引号去除）', () => {
    const text = '# comment\nHOME_GITLAB_TOKEN: xxx\nSSH_PW: "a: b"\n\nEMPTY_VAL: ""\n'
    expect(parseFlatYaml(text)).toEqual({ HOME_GITLAB_TOKEN: 'xxx', SSH_PW: 'a: b', EMPTY_VAL: '' })
  })

  it('renderFlatYaml 序列化（特殊字符引号包裹）', () => {
    const yaml = renderFlatYaml({ A: 'plain', B: 'has: colon' })
    expect(yaml).toContain('A: plain')
    expect(yaml).toContain('B: "has: colon"')
  })

  it('parseSectionedYaml 解析分节 + renderSectionedYaml 往返', () => {
    const sections = { loop: { defaultModel: 'm3' }, ui: { theme: 'dark' } }
    const yaml = renderSectionedYaml(sections)
    expect(yaml).toContain('loop:')
    expect(yaml).toContain('  defaultModel: m3')
    expect(parseSectionedYaml(yaml)).toEqual(sections)
  })
})

describe('localstore: 读写条目', () => {
  it('credential set/get/unset/list 往返', () => {
    writeEntry('credential', 'HOME_GITLAB_TOKEN', 'tok123')
    expect(getEntry('credential', 'HOME_GITLAB_TOKEN')).toBe('tok123')
    expect(listKeys('credential')).toEqual(['HOME_GITLAB_TOKEN'])
    expect(unsetEntry('credential', 'HOME_GITLAB_TOKEN')).toBe(true)
    expect(getEntry('credential', 'HOME_GITLAB_TOKEN')).toBeNull()
    expect(listKeys('credential')).toEqual([])
  })

  it('credential 写入保留其他条目', () => {
    writeEntry('credential', 'A_KEY', 'a')
    writeEntry('credential', 'B_KEY', 'b')
    writeEntry('credential', 'A_KEY', 'a2')
    expect(getEntry('credential', 'A_KEY')).toBe('a2')
    expect(getEntry('credential', 'B_KEY')).toBe('b')
  })

  it('config section.key set/get/unset/list 往返', () => {
    writeEntry('config', 'loop.defaultModel', 'm3')
    writeEntry('config', 'ui.theme', 'dark')
    expect(getEntry('config', 'loop.defaultModel')).toBe('m3')
    expect(listKeys('config')).toEqual(['loop.defaultModel', 'ui.theme'])
    expect(unsetEntry('config', 'loop.defaultModel')).toBe(true)
    expect(getEntry('config', 'loop.defaultModel')).toBeNull()
  })

  it('credential key 校验：非大写蛇形拒绝', () => {
    expect(CREDENTIAL_KEY_RE.test('home-gitlab')).toBe(false)
    expect(CREDENTIAL_KEY_RE.test('HOME_GITLAB_TOKEN')).toBe(true)
    expect(() => writeEntry('credential', 'bad-key', 'x')).toThrow()
  })

  it('config path 校验：非 section.key 拒绝', () => {
    expect(() => writeEntry('config', 'badpath', 'x')).toThrow()
    expect(() => writeEntry('config', 'loop.BadKey', 'x')).toThrow()
  })
})

describe('localstore: runLocalStore 入口', () => {
  it('doc 返回规范文本（含路径/格式/key 规范/权限）', () => {
    const r = runLocalStore({ action: 'doc' }) as { doc: string }
    expect(r.doc).toContain('localstore')
    expect(r.doc).toContain('credentials.yaml')
    expect(r.doc).toContain('settings.yaml')
    expect(r.doc).toContain('0600')
    expect(r.doc).toContain('^[A-Z][A-Z0-9_]*$')
  })

  it('list 对 credential 只返回 key 名（不返回值）', () => {
    writeEntry('credential', 'SECRET_X', 'top-secret')
    const r = runLocalStore({ action: 'list' }) as { keys: string[] }
    expect(r.keys).toEqual(['SECRET_X'])
    expect(JSON.stringify(r)).not.toContain('top-secret')
  })

  it('get 返回值并标记 source', () => {
    writeEntry('credential', 'SECRET_X', 'v1')
    const r = runLocalStore({ action: 'get', name: 'SECRET_X' }) as { value: string; source: string }
    expect(r.value).toBe('v1')
    expect(r.source).toBe('credential')
  })

  it('show 对凭据只返回元数据（无值）', () => {
    writeEntry('credential', 'SECRET_X', 'v1')
    const r = runLocalStore({ action: 'show', name: 'SECRET_X' }) as { exists: boolean }
    expect(r.exists).toBe(true)
    expect(JSON.stringify(r)).not.toContain('v1')
  })

  it('docText 直接可读（agent 用 fs 工具按说明操作）', () => {
    const d = docText()
    expect(d).toContain(storeFilePath('credential'))
    expect(d).toContain('read')
    expect(d).toContain('write')
  })
})
