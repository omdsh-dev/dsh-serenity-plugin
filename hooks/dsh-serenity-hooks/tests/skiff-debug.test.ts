import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { request } from 'node:http'

vi.mock('@deepseek-ai/dsh-llm', () => ({
  createUserMessage: (o: unknown) => o,
}))

import { skiffDebugPage, startSkiffDebugServer, stopSkiffDebugServer, skiffDebugActive, skiffDebugPort, discoverCccs, renderSkiffMarkdown, type SkiffCccEntry } from '../src/skiff-debug.js'

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
    // 内嵌候选数据（JSON 合法转义：仅 `<` → `\u003c`，引号保留——v1.25.7 修复 escapeHtml 破坏 JSON.parse）
    expect(html).toContain('"root":"/ccc/home-serenity"')
    expect(html).toContain('"roles":["qa-readonly","review"]')
    // 防 `</script>` 注入：数据内 `<` 转义为 \u003c
    const evil = skiffDebugPage([{ root: '/a<b', name: 'x', roles: ['r'] }], '/a<b', 3080)
    expect(evil).toContain('\\u003c')
    expect(evil).not.toContain('</script>{"')
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

describe('skiff-debug: discoverCccs 候选发现（v1.25.6 三层：workspace → sessionPersistence → live）', () => {
  it('workspaceRegistry 持久化工作区优先（无 live 会话也能列出）', async () => {
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
    const cccs = await discoverCccs(fakeCtx as never, cccA)
    expect(cccs).toHaveLength(2)
    expect(cccs[0]!.root).toBe(cccA)
    expect(cccs[0]!.roles).toEqual(['qa'])
    expect(cccs[1]!.root).toBe(cccB)
    expect(cccs[1]!.roles).toEqual([])
    rmSync(cccA, { recursive: true, force: true })
    rmSync(cccB, { recursive: true, force: true })
    rmSync(plain, { recursive: true, force: true })
  })

  it('workspace 缺失 → sessionPersistence 持久化会话兜底（历史会话工作目录）', async () => {
    const cccA = mkdtempSync(join(tmpdir(), 'skiff-ccc-a-'))
    writeFileSync(join(cccA, '.serenity'), 'test')
    const cccB = mkdtempSync(join(tmpdir(), 'skiff-ccc-b-'))
    writeFileSync(join(cccB, '.serenity'), 'test')
    mkdirSync(join(cccA, '.opencode'), { recursive: true })
    writeFileSync(join(cccA, '.opencode', 'serenity.json'), JSON.stringify({ skiff: { roles: { qa: { msms: ['x'] } } } }))
    const fakeCtx = {
      get: (name: string) =>
        name === 'sessionPersistence'
          ? { list: async () => [{ cwd: join(cccA, 'sub') }, { cwd: join(cccB, 'sub') }, { cwd: '' }, {}] }
          : undefined,
      sessions: { list: () => [] },
    }
    const cccs = await discoverCccs(fakeCtx as never, cccA)
    expect(cccs).toHaveLength(2)
    expect(cccs[0]!.root).toBe(cccA)
    expect(cccs[0]!.roles).toEqual(['qa'])
    expect(cccs[1]!.root).toBe(cccB)
    rmSync(cccA, { recursive: true, force: true })
    rmSync(cccB, { recursive: true, force: true })
  })

  it('live 会话 cwd 去重发现 CCC + 默认 root 兜底（持久化缺失兜底路径）', async () => {
    const cccA = mkdtempSync(join(tmpdir(), 'skiff-ccc-a-'))
    writeFileSync(join(cccA, '.serenity'), 'test')
    const cccB = mkdtempSync(join(tmpdir(), 'skiff-ccc-b-'))
    writeFileSync(join(cccB, '.serenity'), 'test')
    // A 有角色，B 无
    mkdirSync(join(cccA, '.opencode'), { recursive: true })
    writeFileSync(join(cccA, '.opencode', 'serenity.json'), JSON.stringify({ skiff: { roles: { qa: { msms: ['x'] } } } }))
    const fakeCtx = {
      get: () => undefined, // 无 workspaceRegistry / sessionPersistence
      sessions: {
        list: () => [
          { header: { cwd: join(cccA, 'sub') } },
          { header: { cwd: join(cccA, 'sub2') } }, // 同 root 去重
          { header: { cwd: join(cccB, 'sub') } },
          { header: {} },
        ],
      },
    }
    const cccs = await discoverCccs(fakeCtx as never, cccA)
    expect(cccs).toHaveLength(2)
    expect(cccs[0]!.root).toBe(cccA)
    expect(cccs[0]!.roles).toEqual(['qa'])
    expect(cccs[0]!.name.startsWith('skiff-ccc-a-')).toBe(true)
    expect(cccs[1]!.root).toBe(cccB)
    expect(cccs[1]!.roles).toEqual([])
    rmSync(cccA, { recursive: true, force: true })
    rmSync(cccB, { recursive: true, force: true })
  })

  it('默认 root 不在工作区/会话 → 放首位兜底', async () => {
    const fakeCtx = { get: () => ({ list: () => [] }), sessions: { list: () => [] } }
    const cccs = await discoverCccs(fakeCtx as never, dir)
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
    expect(after.body).toContain('"roles":["qa"]')
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

  it('POST /ask 会话延续：新建（continued:false）→ 同会话追问（continued:true）→ 全量轨迹（v1.25.10）', async () => {
    const port = freePort()
    // 角色配置（handyman.defaultModel 供 createSkiffAgent）
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(
      join(dir, '.opencode', 'serenity.json'),
      JSON.stringify({ handyman: { models: ['p/m'], defaultModel: 'p/m' }, skiff: { roles: { qa: { msms: ['x'], systemPrompt: 'p' } } } }),
    )
    // fake ctx：agents.create 产生带 followup 的 fake agent（events 可累积）；
    // on 注册时立即触发 idle（waitIdle 同步 resolve，skiff-core 测试同款）
    const created: Array<{ sessionId: string; session: { id: string; events: unknown[] } }> = []
    let currentAgent: unknown = null
    const fakeCtx = {
      agents: {
        create: async (opts: { sessionId: string; setup?: (c: unknown) => Promise<void> }) => {
          const agentCtx = { get: () => undefined, systemPrompt: { section: () => {} } }
          const agent = {
            ctx: agentCtx,
            session: { id: opts.sessionId, events: [] as unknown[] },
            followup: () => {
              agent.session.events.push(
                { type: 'user/message', data: { content: [{ type: 'text', text: 'q' }] } },
                { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a' }] } } },
              )
            },
          }
          await opts.setup?.(agentCtx)
          currentAgent = agent
          created.push(agent as never)
          return { agent }
        },
      },
      on: (_ev: string, cb: (p: { agent: unknown; status: string }) => void) => {
        cb({ agent: currentAgent, status: 'idle' })
        return () => {}
      },
    }
    await startSkiffDebugServer(fakeCtx as never, dir, port, 3080)
    // 首次提问 → 新建会话
    const first = await httpPost(port, '/ask', { ccc: dir, role: 'qa', question: 'hello' })
    expect(first.status).toBe(200)
    const firstData = JSON.parse(first.body) as { sessionId: string; continued: boolean; trajectory: unknown[] }
    expect(firstData.continued).toBe(false)
    expect(firstData.sessionId.startsWith('skiff-qa-')).toBe(true)
    expect(created).toHaveLength(1)
    expect(firstData.trajectory.length).toBeGreaterThan(0)
    // 追问（带 sessionId）→ 复用同一 agent（created 不增加）+ continued:true + 全量轨迹
    const second = await httpPost(port, '/ask', { ccc: dir, role: 'qa', question: 'follow up', sessionId: firstData.sessionId })
    expect(second.status).toBe(200)
    const secondData = JSON.parse(second.body) as { sessionId: string; continued: boolean; trajectory: unknown[] }
    expect(secondData.continued).toBe(true)
    expect(secondData.sessionId).toBe(firstData.sessionId)
    expect(created).toHaveLength(1)
    // 全量轨迹：两轮 events（每轮 user+assistant = 4 条）
    expect(secondData.trajectory.length).toBeGreaterThan(firstData.trajectory.length)
    stopSkiffDebugServer()
  })

  it('POST /ask 会话延续：未注册 sessionId → 400 不可恢复（重启后/不存在）', async () => {
    const port = freePort()
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({ skiff: { roles: { qa: { msms: ['x'], systemPrompt: 'p' } } } }))
    await startSkiffDebugServer({} as never, dir, port, 3080)
    const res = await httpPost(port, '/ask', { ccc: dir, role: 'qa', question: 'hi', sessionId: 'skiff-qa-ghost' })
    expect(res.status).toBe(400)
    expect(res.body).toContain('not recoverable')
  })

  it('POST /ask 会话延续：sessionId 绑定角色/CCC 不匹配 → 400（切换残留）', async () => {
    const port = freePort()
    mkdirSync(join(dir, '.opencode'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'serenity.json'), JSON.stringify({ skiff: { roles: { qa: { msms: ['x'], systemPrompt: 'p' } } } }))
    // 直接注册一个绑定 role=qa 的会话（fake agent）
    const { registerSkiffSession, unregisterSkiffSession } = await import('../src/skiff-core.js')
    const sid = 'skiff-qa-bound'
    const fake = { session: { id: sid, events: [] }, followup: () => {} }
    registerSkiffSession(sid, 'qa', dir, fake as never)
    await startSkiffDebugServer({} as never, dir, port, 3080)
    try {
      // 角色不匹配（请求 review——CCC 无该角色会先 400 unknown role？不：readSkiffRoles 无 review → 400 unknown role）
      // 所以用真实存在的第二个角色验证 role 不匹配
      const other = mkdtempSync(join(tmpdir(), 'skiff-other-ccc-'))
      writeFileSync(join(other, '.serenity'), 'test')
      mkdirSync(join(other, '.opencode'), { recursive: true })
      writeFileSync(join(other, '.opencode', 'serenity.json'), JSON.stringify({ skiff: { roles: { qa: { msms: ['y'], systemPrompt: 'p' } } } }))
      // CCC 不匹配：请求 other（qa 角色存在，但 session 绑定 dir）→ 400 belongs to role
      const resCcc = await httpPost(port, '/ask', { ccc: other, role: 'qa', question: 'hi', sessionId: sid })
      expect(resCcc.status).toBe(400)
      expect(resCcc.body).toContain('belongs to role')
      rmSync(other, { recursive: true, force: true })
    } finally {
      unregisterSkiffSession(sid)
      stopSkiffDebugServer()
    }
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

describe('skiff-debug: renderSkiffMarkdown 服务端渲染（v1.25.9 marked）', () => {
  it('markdown 语法渲染（标题/粗体/代码块/列表/链接）', () => {
    const html = renderSkiffMarkdown('# 标题\n\n**加粗** 与 `代码`\n\n- 甲\n- 乙\n\n```js\nconst a = 1\n```')
    expect(html).toContain('<h1>标题</h1>')
    expect(html).toContain('<strong>加粗</strong>')
    expect(html).toContain('<code>代码</code>')
    expect(html).toContain('<ul>')
    expect(html).toContain('<pre><code class="language-js">')
    expect(html).toContain('const a = 1')
  })

  it('<think> 块提取为折叠卡（🧠 思考过程，默认收起）', () => {
    const html = renderSkiffMarkdown('答案正文\n\n<think>我先分析再回答</think>\n\n后续内容')
    expect(html).toContain('<details class="think">')
    expect(html).toContain('<summary>🧠 思考过程</summary>')
    expect(html).toContain('我先分析再回答')
    expect(html).toContain('答案正文')
    expect(html).toContain('后续内容')
    // 折叠卡不直接裸露 think 标记
    expect(html).not.toContain('<think>')
  })

  it('hideThink=true（v1.26.4 public 口）→ <think> 内容完全不渲染，正文保留', () => {
    const html = renderSkiffMarkdown('答案正文\n\n<think>我先分析再回答</think>\n\n后续内容', true)
    expect(html).not.toContain('<details class="think">')
    expect(html).not.toContain('我先分析再回答') // 思考过程对普通用户不展示
    expect(html).toContain('答案正文')
    expect(html).toContain('后续内容')
    expect(html).not.toContain('<think>')
  })

  it('原始 HTML 注入被转义（escapeHtml 前置，安全）', () => {
    const html = renderSkiffMarkdown('正常内容 <script>alert(1)</script>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})
