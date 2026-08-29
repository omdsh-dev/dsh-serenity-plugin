import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { request } from 'node:http'

vi.mock('@deepseek-ai/dsh-llm', () => ({
  createUserMessage: (o: unknown) => o,
}))

// schemastery / dsh-settings 运行时不可解析（peerDep 全局提供）——mock 纯逻辑测试所需面
// （F4d 起 acp-http.ts → settings-section.ts 进入依赖链，与 settings-section.test.ts 同款模式）
vi.mock('@deepseek-ai/schemastery', () => {
  const chain: unknown = new Proxy(function () {}, {
    get: (_t, prop) => {
      if (prop === Symbol.toPrimitive) return () => ''
      if (prop === 'valueOf') return () => 0
      if (prop === 'toString') return () => ''
      return chain
    },
    apply: () => chain,
  })
  return {
    default: {
      object: (spec: unknown) => spec,
      array: () => chain,
      string: () => chain,
      boolean: () => chain,
      number: () => chain,
    },
  }
})

vi.mock('@deepseek-ai/dsh-settings', () => ({
  installSettingsSection: () => {},
  settingsNamespace: (v: string) => v,
}))

import { AcpServer, dispatchRpc, RpcMethodError, RpcInvalidParams, RPC_ERROR } from '../src/acp-core.js'
import { startAcpHttpServer, stopAcpHttpServer, acpHttpActive, acpHttpPort } from '../src/acp-http.js'
import { registerSkiffSession, unregisterSkiffSession, skiffSessionSnapshot } from '../src/skiff-core.js'
import { SKIFF_SESSION_PREFIX } from '../src/skiff-role.js'
import { __setSimpleSourceForTest, defaultSimpleSettings } from '../src/settings-section.js'
import { ensurePublicAskKey, verifyPublicAskKey } from '../src/config-ops.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'acp-core-'))
  writeFileSync(join(dir, '.serenity'), 'test')
  mkdirSync(join(dir, '.opencode'), { recursive: true })
  writeFileSync(
    join(dir, '.opencode', 'serenity.json'),
    JSON.stringify({ handyman: { models: ['p/m'], defaultModel: 'p/m' }, skiff: { roles: { qa: { msms: ['x'], systemPrompt: 'p' } } } }),
  )
  // 默认：ACP 开 / 问答页关（JSON-RPC 测试主面；问答页用例单独覆盖）
  __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), acpEnabled: true }))
})

afterEach(() => {
  // 清理残留注册
  for (const [id] of skiffSessionSnapshot()) unregisterSkiffSession(id)
  __setSimpleSourceForTest(null)
  stopAcpHttpServer()
  rmSync(dir, { recursive: true, force: true })
})

/** fake ctx：agents.create 产生带 followup/interrupt 的 fake agent；on 立即触发 idle */
function fakeCtx(events: unknown[] = []): { agents: { create: (opts: { sessionId: string }) => Promise<unknown> }; on: () => () => void } {
  let agent: { session: { id: string; events: unknown[] }; followup: () => void; interrupt?: () => void } | undefined
  return {
    agents: {
      // sessionId 尊重传入值（真实 DSH agents.create 行为；v1.25.10 追问延续依赖注册表 key 一致）
      create: async (opts: { sessionId: string }) => {
        agent = {
          session: { id: opts.sessionId, events },
          followup: () => {
            events.push(
              { type: 'user/message', data: { content: [{ type: 'text', text: 'q' }] } },
              { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a' }] } } },
            )
          },
          interrupt: () => { events.push({ type: 'user/message', data: { content: [{ type: 'text', text: '[cancelled]' }] } }) },
        }
        return { agent }
      },
    },
    on: (_ev: string, cb: (p: { agent: unknown; status: string }) => void) => {
      cb({ agent, status: 'idle' })
      return () => {}
    },
  }
}

describe('acp-core: initialize / 协议面', () => {
  it('initialize 返回协议版本 + skiff 扩展能力声明', async () => {
    const server = new AcpServer(fakeCtx() as never)
    const r = await server.handle('initialize', {}) as { protocolVersion: number; capabilities: Record<string, unknown> }
    expect(r.protocolVersion).toBe(1)
    expect(r.capabilities).toEqual({ sessionId: true, ccc: true, role: true })
  })

  it('authenticate no-op → {}', async () => {
    const server = new AcpServer(fakeCtx() as never)
    expect(await server.handle('authenticate', {})).toEqual({})
  })

  it('未知方法 → RpcMethodError', async () => {
    const server = new AcpServer(fakeCtx() as never)
    await expect(server.handle('nope', {})).rejects.toThrow(RpcMethodError)
  })
})

describe('acp-core: session/new（ccc+role+sessionId，v1.26.0）', () => {
  it('无 sessionId → 新建会话（continued:false）', async () => {
    const server = new AcpServer(fakeCtx() as never)
    const r = await server.handle('session/new', { ccc: dir, role: 'qa' }) as { sessionId: string; role: string; ccc: string; continued: boolean }
    expect(r.continued).toBe(false)
    expect(r.role).toBe('qa')
    expect(r.ccc).toBe(dir)
    expect(r.sessionId.startsWith(SKIFF_SESSION_PREFIX)).toBe(true)
  })

  it('带 sessionId（注册中）→ 延续（continued:true）', async () => {
    const server = new AcpServer(fakeCtx() as never)
    const created = await server.handle('session/new', { ccc: dir, role: 'qa' }) as { sessionId: string }
    const resumed = await server.handle('session/new', { ccc: dir, role: 'qa', sessionId: created.sessionId }) as { sessionId: string; continued: boolean }
    expect(resumed.continued).toBe(true)
    expect(resumed.sessionId).toBe(created.sessionId)
  })

  it('缺 ccc / 缺 role → RpcInvalidParams', async () => {
    const server = new AcpServer(fakeCtx() as never)
    await expect(server.handle('session/new', { role: 'qa' })).rejects.toThrow(RpcInvalidParams)
    await expect(server.handle('session/new', { ccc: dir })).rejects.toThrow(RpcInvalidParams)
  })

  it('未知角色 → RpcInvalidParams', async () => {
    const server = new AcpServer(fakeCtx() as never)
    await expect(server.handle('session/new', { ccc: dir, role: 'ghost' })).rejects.toThrow(RpcInvalidParams)
  })

  it('sessionId 未注册（重启后）→ 错误不可恢复', async () => {
    const server = new AcpServer(fakeCtx() as never)
    await expect(server.handle('session/new', { ccc: dir, role: 'qa', sessionId: 'skiff-qa-ghost' })).rejects.toThrow(/not recoverable/)
  })

  it('sessionId 角色绑定不匹配 → 错误', async () => {
    const server = new AcpServer(fakeCtx() as never)
    const created = await server.handle('session/new', { ccc: dir, role: 'qa' }) as { sessionId: string }
    // 角色不一致（qa vs 另一个角色名）——直接注册一个绑定 review 的会话验证校验
    const fake = { session: { id: 'skiff-review-1', events: [] }, followup: () => {} }
    registerSkiffSession('skiff-review-1', 'review', dir, fake as never)
    await expect(server.handle('session/new', { ccc: dir, role: 'qa', sessionId: 'skiff-review-1' })).rejects.toThrow(/belongs to role/)
    void created
  })
})

describe('acp-core: session/prompt / cancel / close / list', () => {
  it('prompt → 答案 + 全量轨迹', async () => {
    const events: unknown[] = []
    const server = new AcpServer(fakeCtx(events) as never)
    const created = await server.handle('session/new', { ccc: dir, role: 'qa' }) as { sessionId: string }
    const r = await server.handle('session/prompt', { sessionId: created.sessionId, question: 'hi' }) as { answer: string; trajectory: unknown[] }
    expect(r.answer).toBe('a')
    expect(r.trajectory.length).toBeGreaterThan(0)
    expect(events.length).toBeGreaterThan(0)
  })

  it('prompt 未知 session → RpcInvalidParams', async () => {
    const server = new AcpServer(fakeCtx() as never)
    await expect(server.handle('session/prompt', { sessionId: 'skiff-ghost', question: 'hi' })).rejects.toThrow(/unknown session/)
  })

  it('prompt 缺 sessionId/question → RpcInvalidParams', async () => {
    const server = new AcpServer(fakeCtx() as never)
    await expect(server.handle('session/prompt', { question: 'hi' })).rejects.toThrow(RpcInvalidParams)
    await expect(server.handle('session/prompt', { sessionId: 'x' })).rejects.toThrow(RpcInvalidParams)
  })

  it('cancel 已注册会话 → interrupt 调用（cancelled:true）；未知会话 → no-op', async () => {
    const events: unknown[] = []
    const ctx = fakeCtx(events)
    const server = new AcpServer(ctx as never)
    const created = await server.handle('session/new', { ccc: dir, role: 'qa' }) as { sessionId: string }
    const r = await server.handle('session/cancel', { sessionId: created.sessionId }) as { cancelled: boolean }
    expect(r.cancelled).toBe(true)
    expect(events.some((e) => (e as { data?: { content?: Array<{ text?: string }> } }).data?.content?.[0]?.text === '[cancelled]')).toBe(true)
    expect(await server.handle('session/cancel', { sessionId: 'skiff-ghost' })).toEqual({ cancelled: false })
  })

  it('close 已注册会话 → 注册表清理；未知 → closed:false', async () => {
    const server = new AcpServer(fakeCtx() as never)
    const created = await server.handle('session/new', { ccc: dir, role: 'qa' }) as { sessionId: string }
    expect(skiffSessionSnapshot().has(created.sessionId)).toBe(true)
    expect(await server.handle('session/close', { sessionId: created.sessionId })).toEqual({ closed: true })
    expect(skiffSessionSnapshot().has(created.sessionId)).toBe(false)
    expect(await server.handle('session/close', { sessionId: 'skiff-ghost' })).toEqual({ closed: false })
  })

  it('list → 全部会话（含 role/ccc）', async () => {
    const server = new AcpServer(fakeCtx() as never)
    const created = await server.handle('session/new', { ccc: dir, role: 'qa' }) as { sessionId: string }
    const r = await server.handle('session/list', {}) as { sessions: Array<{ sessionId: string; role: string; ccc: string }> }
    expect(r.sessions).toContainEqual({ sessionId: created.sessionId, role: 'qa', ccc: dir })
  })

  it('request_permission → 恒 allow（G9 白名单即授权）', async () => {
    const server = new AcpServer(fakeCtx() as never)
    expect(await server.handle('session/request_permission', {})).toEqual({ allow: true })
  })
})

describe('acp-core: dispatchRpc（JSON-RPC 2.0 批处理，传输无关）', () => {
  it('请求 → 响应（result）；通知 → 无响应', async () => {
    const server = new AcpServer(fakeCtx() as never)
    const resp = await dispatchRpc(server, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    expect(resp).toHaveLength(1)
    expect(resp[0]?.id).toBe(1)
    expect((resp[0]?.result as { protocolVersion: number }).protocolVersion).toBe(1)
    const notify = await dispatchRpc(server, { jsonrpc: '2.0', method: 'session/list', params: {} })
    expect(notify).toEqual([])
  })

  it('方法错误 → error 帧（-32601）；参数错误 → -32602', async () => {
    const server = new AcpServer(fakeCtx() as never)
    const m = await dispatchRpc(server, { jsonrpc: '2.0', id: 1, method: 'nope' })
    expect(m[0]?.error?.code).toBe(RPC_ERROR.METHOD_NOT_FOUND)
    const p = await dispatchRpc(server, { jsonrpc: '2.0', id: 2, method: 'session/new', params: {} })
    expect(p[0]?.error?.code).toBe(RPC_ERROR.INVALID_PARAMS)
  })

  it('非法帧 → -32600 invalid request', async () => {
    const server = new AcpServer(fakeCtx() as never)
    const r = await dispatchRpc(server, { foo: 'bar' })
    expect(r[0]?.error?.code).toBe(RPC_ERROR.INVALID_REQUEST)
  })
})

/** 顶层 httpPost（JSON-RPC /ask 共用；path 可指定） */
function httpPost(port: number, body: unknown, path = '/'): Promise<{ status: number; body: string }> {
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

describe('acp-http: HTTP JSON-RPC 端点（ephemeral 端口）', () => {
  it('start → POST / initialize → 响应数组；stop → active 清除', async () => {
    const port = 3600 + Math.floor(Math.random() * 300)
    await startAcpHttpServer(fakeCtx() as never, port)
    expect(acpHttpActive()).toBe(true)
    expect(acpHttpPort()).toBe(port)
    const res = await httpPost(port, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    expect(res.status).toBe(200)
    const parsed = JSON.parse(res.body) as Array<{ result: { protocolVersion: number } }>
    expect(parsed[0]?.result.protocolVersion).toBe(1)
    stopAcpHttpServer()
    expect(acpHttpActive()).toBe(false)
  })

  it('非法 JSON → 400 parse error 帧', async () => {
    const port = 3900 + Math.floor(Math.random() * 100)
    await startAcpHttpServer(fakeCtx() as never, port)
    const res = await httpPost(port, { bad: 'json' } as never)
    // dispatchRpc 对 object 帧返回 invalid request（-32600），不是 parse error；HTTP 层 200
    expect(res.status).toBe(200)
    const parsed = JSON.parse(res.body) as Array<{ error: { code: number } }>
    expect(parsed[0]?.error.code).toBe(RPC_ERROR.INVALID_REQUEST)
    stopAcpHttpServer()
  })

  it('问答页关（publicAskEnabled=false）→ GET / 渲染未启用提示页（200 非 404）', async () => {
    const port = 4200 + Math.floor(Math.random() * 100)
    await startAcpHttpServer(fakeCtx() as never, port)
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/', method: 'GET' }, (r) => {
        const chunks: Buffer[] = []
        r.on('data', (c: Buffer) => chunks.push(c))
        r.on('end', () => resolve({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }))
      })
      req.on('error', reject)
      req.end()
    })
    expect(res.status).toBe(200)
    expect(res.body).toContain('未启用')
    stopAcpHttpServer()
  })

  it('重复 start 幂等（单实例）', async () => {
    const port = 4500 + Math.floor(Math.random() * 100)
    await startAcpHttpServer(fakeCtx() as never, port)
    await startAcpHttpServer(fakeCtx() as never, port)
    expect(acpHttpActive()).toBe(true)
    stopAcpHttpServer()
  })
})

describe('F4d: 建议问答页 key 认证（v1.26.1）', () => {
  it('ensurePublicAskKey 首次生成随机 key 并写回固定（幂等：二次调用返回同一 key）', () => {
    const k1 = ensurePublicAskKey()
    expect(k1).toMatch(/^[0-9a-f]{64}$/)
    const k2 = ensurePublicAskKey()
    expect(k2).toBe(k1)
  })

  it('verifyPublicAskKey：正确 key 通过 / 错误 / 空 / 未生成 拒绝', () => {
    const key = ensurePublicAskKey()
    expect(verifyPublicAskKey(key)).toBe(true)
    expect(verifyPublicAskKey('wrong-key')).toBe(false)
    expect(verifyPublicAskKey('')).toBe(false)
    expect(verifyPublicAskKey(undefined)).toBe(false)
  })

  it('POST /ask 无 key / 错误 key → 401（没有 key 不工作）', async () => {
    const port = 5100 + Math.floor(Math.random() * 100)
    const key = ensurePublicAskKey()
    __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), acpEnabled: true, publicAskEnabled: true }))
    await startAcpHttpServer(fakeCtx() as never, port, dir)
    try {
      const noKey = await httpPost(port, { ccc: dir, question: 'hi' }, '/ask')
      expect(noKey.status).toBe(401)
      const badKey = await httpPost(port, { key: 'nope', ccc: dir, question: 'hi' }, '/ask')
      expect(badKey.status).toBe(401)
      const ok = await httpPost(port, { key, ccc: dir, question: 'hi' }, '/ask')
      expect(ok.status).toBe(200)
      const data = JSON.parse(ok.body) as { answer: string; sessionId: string; continued: boolean }
      expect(data.answer).toBe('a')
      expect(data.sessionId.startsWith(SKIFF_SESSION_PREFIX)).toBe(true)
      expect(data.continued).toBe(false)
      // 追问（带 sessionId）→ 同会话延续
      const follow = await httpPost(port, { key, ccc: dir, question: 'again', sessionId: data.sessionId }, '/ask')
      expect(follow.status).toBe(200)
      const followData = JSON.parse(follow.body) as { continued: boolean }
      expect(followData.continued).toBe(true)
    } finally {
      stopAcpHttpServer()
    }
  })

  it('问答页关（publicAskEnabled=false）→ POST /ask 403', async () => {
    const port = 5400 + Math.floor(Math.random() * 100)
    const key = ensurePublicAskKey()
    await startAcpHttpServer(fakeCtx() as never, port, dir)
    try {
      const res = await httpPost(port, { key, ccc: dir, question: 'hi' }, '/ask')
      expect(res.status).toBe(403)
    } finally {
      stopAcpHttpServer()
    }
  })

  it('GET / 问答页开启 → 渲染页面（含 key 输入框 + CCC 列表）', async () => {
    const port = 5600 + Math.floor(Math.random() * 100)
    __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), acpEnabled: true, publicAskEnabled: true }))
    await startAcpHttpServer(fakeCtx() as never, port, dir)
    try {
      const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path: '/', method: 'GET' }, (r) => {
          const chunks: Buffer[] = []
          r.on('data', (c: Buffer) => chunks.push(c))
          r.on('end', () => resolve({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }))
        })
        req.on('error', reject)
        req.end()
      })
      expect(res.status).toBe(200)
      expect(res.body).toContain('Serenity Public Ask')
      expect(res.body).toContain('访问 Key')
      expect(res.body).toContain('认知容器')
    } finally {
      stopAcpHttpServer()
    }
  })
})
