import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { request } from 'node:http'

vi.mock('@deepseek-ai/dsh-llm', () => ({
  createUserMessage: (o: unknown) => o,
}))

import { skiffDebugPage, startSkiffDebugServer, stopSkiffDebugServer, skiffDebugActive, skiffDebugPort, discoverCccs, type SkiffCccEntry } from '../src/skiff-debug.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skiff-debug-'))
  writeFileSync(join(dir, '.serenity'), 'test')
})

afterEach(async () => {
  stopSkiffDebugServer()
  rmSync(dir, { recursive: true, force: true })
})

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }))
    })
    req.on('error', reject)
    req.end()
  })
}

function httpPost(port: number, path: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }))
    })
    req.on('error', reject)
    req.end(data)
  })
}

/** 空闲端口：3099 + 偏移（CI 并行安全） */
function freePort(): number {
  return 3300 + Math.floor(Math.random() * 500)
}

describe('skiff-debug: 问答页渲染（纯函数，v1.25.4 多 CCC 切换）', () => {
  const cccs: SkiffCccEntry[] = [
    { root: '/ccc/home-serenity', name: 'home-serenity', roles: ['qa-readonly', 'review'] },
    { root: '/ccc/other-ccc', name: 'other-ccc', roles: ['helper'] },
  ]

  it('含 CCC 切换器（内嵌数据）+ 角色 + WebUI 链接 + 轨迹区', () => {
    const html = skiffDebugPage(cccs, '/ccc/home-serenity', 3080)
    expect(html).toContain('Skiff Debug')
    expect(html).toContain('qa-readonly')
    expect(html).toContain('home-serenity')
    expect(html).toContain('other-ccc')
    // 内嵌候选数据（CCC 切换器数据源；JSON 经 escapeHtml 转义为 &quot;）
    expect(html).toContain('&quot;root&quot;:&quot;/ccc/home-serenity&quot;')
    expect(html).toContain('&quot;roles&quot;:[&quot;qa-readonly&quot;,&quot;review&quot;]')
    // 默认选中
    expect(html).toContain('data-default="/ccc/home-serenity"')
    expect(html).toContain('http://127.0.0.1:3080')
    expect(html).toContain('trajectory')
    expect(html).toContain('/ask')
  })

  it('无候选 CCC → 提示选项', () => {
    const html = skiffDebugPage([], '/ccc/x', 3080)
    expect(html).toContain('(未发现 CCC)')
  })
})

describe('skiff-debug: discoverCccs 候选发现（v1.25.4）', () => {
  it('workspaceRegistry 持久化工作区优先（无 live 会话也能列出，v1.25.5）', () => {
    const cccA = mkdtempSync(join(tmpdir(), 'skiff-ccc-a-'))
    writeFileSync(join(cccA, '.serenity'), 'test')
    const cccB = mkdtempSync(join(tmpdir(), 'skiff-ccc-b-'))
    writeFileSync(join(cccB, '.serenity'), 'test')
    mkdirSync(join(cccA, '.opencode'), { recursive: true })
    writeFileSync(join(cccA, '.opencode', 'serenity.json'), JSON.stringify({ skiff: { roles: { qa: { msms: ['x'] } } } }))
    // 非 CCC 工作区（无 .serenity）应被跳过
    const plain = mkdtempSync(join(tmpdir(), 'plain-ws-'))
    const fakeCtx = {
      get: (name: string) =>
        name === 'workspaceRegistry'
          ? { list: () => [{ path: cccA }, { path: plain }, { path: join(cccB, 'sub') }] }
          : undefined,
      sessions: { list: () => [] },
    }
    const cccs = discoverCccs(fakeCtx as never, cccA)
    expect(cccs).toHaveLength(2)
    expect(cccs[0]!.root).toBe(cccA)
    expect(cccs[0]!.roles).toEqual(['qa'])
    expect(cccs[1]!.root).toBe(cccB)
    expect(cccs[1]!.roles).toEqual([])
    rmSync(cccA, { recursive: true, force: true })
    rmSync(cccB, { recursive: true, force: true })
    rmSync(plain, { recursive: true, force: true })
  })

  it('live 会话 cwd 去重发现 CCC + 默认 root 兜底（workspace 缺失兜底路径）', () => {
    const cccA = mkdtempSync(join(tmpdir(), 'skiff-ccc-a-'))
    writeFileSync(join(cccA, '.serenity'), 'test')
    const cccB = mkdtempSync(join(tmpdir(), 'skiff-ccc-b-'))
    writeFileSync(join(cccB, '.serenity'), 'test')
    // A 有角色，B 无
    mkdirSync(join(cccA, '.opencode'), { recursive: true })
    writeFileSync(join(cccA, '.opencode', 'serenity.json'), JSON.stringify({ skiff: { roles: { qa: { msms: ['x'] } } } }))
    const fakeCtx = {
      get: () => undefined, // 无 workspaceRegistry
      sessions: {
        list: () => [
          { header: { cwd: join(cccA, 'sub') } },
          { header: { cwd: join(cccA, 'sub2') } }, // 同 root 去重
          { header: { cwd: join(cccB, 'sub') } },
          { header: {} },
        ],
      },
    }
    const cccs = discoverCccs(fakeCtx as never, cccA)
    expect(cccs).toHaveLength(2)
    expect(cccs[0]!.root).toBe(cccA)
    expect(cccs[0]!.roles).toEqual(['qa'])
    expect(cccs[0]!.name.startsWith('skiff-ccc-a-')).toBe(true)
    expect(cccs[1]!.root).toBe(cccB)
    expect(cccs[1]!.roles).toEqual([])
    rmSync(cccA, { recursive: true, force: true })
    rmSync(cccB, { recursive: true, force: true })
  })

  it('默认 root 不在工作区/会话 → 放首位兜底', () => {
    const fakeCtx = { get: () => ({ list: () => [] }), sessions: { list: () => [] } }
    const cccs = discoverCccs(fakeCtx as never, dir)
    expect(cccs).toHaveLength(1)
    expect(cccs[0]!.root).toBe(dir)
  })
})

describe('skiff-debug: 调试服务（ephemeral 端口）', () => {
  it('start → GET / 渲染问答页（含默认 CCC）；stop → active 清除', async () => {
    const port = freePort()
    await startSkiffDebugServer({} as never, dir, port, 3080)
    expect(skiffDebugActive()).toBe(true)
    expect(skiffDebugPort()).toBe(port)
    const res = await httpGet(port, '/')
    expect(res.status).toBe(200)
    expect(res.body).toContain('Skiff Debug')
    expect(res.body).toContain(`data-default="${dir}"`)
    stopSkiffDebugServer()
    expect(skiffDebugActive()).toBe(false)
  })

  it('角色配置实时读取：写配置后 GET / 立即可见（不缓存快照，v1.25.2）', async () => {
    const port = freePort()
    await startSkiffDebugServer({} as never, dir, port, 3080)
    const empty = await httpGet(port, '/')
    expect(empty.body).toContain('(未发现 CCC)')
    // 写入 skiff.roles 后刷新页面即生效（无需重启服务）
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(
      join(dir, '.opencode', 'serenity.json'),
      JSON.stringify({ skiff: { roles: { qa: { msms: ['x'], systemPrompt: 'p' } } } }),
    )
    const after = await httpGet(port, '/')
    expect(after.body).toContain('&quot;roles&quot;:[&quot;qa&quot;]')
  })

  it('POST /ask unknown role → 400（错误路径；不创建 agent）', async () => {
    const port = freePort()
    await startSkiffDebugServer({} as never, dir, port, 3080)
    const res = await httpPost(port, '/ask', { role: 'ghost', question: 'hi' })
    expect(res.status).toBe(400)
    expect(res.body).toContain('unknown role')
  })

  it('POST /ask 切换 CCC（ccc 字段）→ 目标 CCC 无该角色 → 400（v1.25.4）', async () => {
    const port = freePort()
    const other = mkdtempSync(join(tmpdir(), 'skiff-other-'))
    writeFileSync(join(other, '.serenity'), 'test')
    mkdirSync(join(other, '.opencode'), { recursive: true })
    writeFileSync(join(other, '.opencode', 'serenity.json'), JSON.stringify({ skiff: { roles: { 'other-role': { msms: ['y'] } } } }))
    await startSkiffDebugServer({} as never, dir, port, 3080)
    // 默认 CCC（dir）无 qa 角色
    const res = await httpPost(port, '/ask', { ccc: dir, role: 'qa', question: 'hi' })
    expect(res.status).toBe(400)
    expect(res.body).toContain('unknown role')
    // 切换的 CCC（other）有 other-role——角色校验按目标 CCC
    const res2 = await httpPost(port, '/ask', { ccc: other, role: 'qa', question: 'hi' })
    expect(res2.status).toBe(400)
    expect(res2.body).toContain('unknown role')
    rmSync(other, { recursive: true, force: true })
  })

  it('POST /ask 非法 JSON → 400', async () => {
    const port = freePort()
    await startSkiffDebugServer({} as never, dir, port, 3080)
    const res = await httpPost(port, '/ask', null as never)
    expect(res.status).toBe(400)
    expect(res.body).toContain('invalid JSON')
  })

  it('未知路径 → 404', async () => {
    const port = freePort()
    await startSkiffDebugServer({} as never, dir, port, 3080)
    const res = await httpGet(port, '/nope')
    expect(res.status).toBe(404)
  })

  it('重复 start 幂等（单实例）', async () => {
    const port = freePort()
    await startSkiffDebugServer({} as never, dir, port, 3080)
    await startSkiffDebugServer({} as never, dir, port, 3080)
    expect(skiffDebugActive()).toBe(true)
  })
})
