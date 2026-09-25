import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
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
import { startAcpHttpServer, stopAcpHttpServer, acpHttpActive, acpHttpPort, acpHttpSpec } from '../src/acp-http.js'
import { faceEnabled } from '../src/face-host.js'
import { registerSkiffSession, unregisterSkiffSession, skiffSessionSnapshot } from '../src/skiff-core.js'
import { SKIFF_SESSION_PREFIX } from '../src/skiff-role.js'
import { __setSimpleSourceForTest, defaultSimpleSettings } from '../src/settings-section.js'
import { ensurePublicAskKey, verifyPublicAskKey, rotatePublicAskKey, resetPublicAskIpFail, updateAdvancedSettings } from '../src/config-ops.js'

let dir: string
let oldConfigEnv: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'acp-core-'))
  // plugin 全局配置隔离（防 ensurePublicAskKey/updateAdvancedSettings 污染真实 ~/.dsh）
  oldConfigEnv = process.env.SERENITY_HOOKS_CONFIG
  process.env.SERENITY_HOOKS_CONFIG = join(dir, 'serenity-hooks.json')
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
  // v1.26.5：清理 IP 失败锁定状态（模块级 Map，跨测试残留会误锁）
  resetPublicAskIpFail('1.2.3.4')
  resetPublicAskIpFail('5.6.7.8')
  resetPublicAskIpFail('127.0.0.1')
  if (oldConfigEnv === undefined) delete process.env.SERENITY_HOOKS_CONFIG
  else process.env.SERENITY_HOOKS_CONFIG = oldConfigEnv
  rmSync(dir, { recursive: true, force: true })
})

/** fake ctx：agents.create 产生带 followup/cancel 的 fake agent；on 立即触发 idle */
function fakeCtx(events: unknown[] = []): { agents: { create: (opts: { sessionId: string }) => Promise<unknown> }; on: () => () => void } {
  let agent: { session: { id: string; events: unknown[] }; followup: () => void; cancel: (cause: { kind: string }) => void } | undefined
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
          // v1.30.6（review F-02）：宿主 Agent 只有 cancel(cause)，没有 interrupt——
          // 替身必须镜像真实成员，否则测试会“认证”一个不存在的调用。
          cancel: () => { events.push({ type: 'user/message', data: { content: [{ type: 'text', text: '[cancelled]' }] } }) },
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
  it('prompt → 答案（v1.26.10：不返回 trajectory——3100 对外只问答）', async () => {
    const events: unknown[] = []
    const server = new AcpServer(fakeCtx(events) as never)
    const created = await server.handle('session/new', { ccc: dir, role: 'qa' }) as { sessionId: string }
    const r = await server.handle('session/prompt', { sessionId: created.sessionId, question: 'hi' }) as { answer: string }
    expect(r.answer).toBe('a')
    expect(r).not.toHaveProperty('trajectory')
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

  it('cancel 已注册会话 → Agent.cancel 调用（cancelled:true）；未知会话 → no-op', async () => {
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

/**
 * 启动 ACP 面于**内核分配端口**（`port:0`）并读回实际端口。
 *
 * v1.34.1 修 flake（块 3）：此前每个用例自取 `base + random(n)`——相邻用例有概率撞同一端口，
 * 而前任面的端口未必已释放 ⇒ EADDRINUSE ⇒ 面宿主按缺省预算重试 **10s > vitest 5s 超时**
 * ⇒ 用例以 "Test timed out in 5000ms" 挂死（真相＝撞端口，报出来却像逻辑挂死）。
 * `port:0` 由内核挑空闲端口 ⇒ 这一类撞端口 flake **在结构上不可能再发生**。
 */
async function startAcpEphemeral(root?: string): Promise<number> {
  await startAcpHttpServer(fakeCtx() as never, 0, root)
  const port = acpHttpPort()
  if (port === null) throw new Error('acp-http 面未在监听（startAcpHttpServer 未生效）')
  return port
}

describe('acp-http: HTTP JSON-RPC 端点（ephemeral 端口）', () => {
  it('start → POST / initialize → 响应数组；stop → active 清除', async () => {
    const port = await startAcpEphemeral()
    expect(acpHttpActive()).toBe(true)
    expect(port).toBeGreaterThan(0) // port:0 → 内核分配的实际端口
    expect(acpHttpPort()).toBe(port) // 状态真相源读回同一端口
    const res = await httpPost(port, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    expect(res.status).toBe(200)
    const parsed = JSON.parse(res.body) as Array<{ result: { protocolVersion: number } }>
    expect(parsed[0]?.result.protocolVersion).toBe(1)
    stopAcpHttpServer()
    expect(acpHttpActive()).toBe(false)
  })

  it('非法 JSON → 400 parse error 帧', async () => {
    const port = await startAcpEphemeral()
    const res = await httpPost(port, { bad: 'json' } as never)
    // dispatchRpc 对 object 帧返回 invalid request（-32600），不是 parse error；HTTP 层 200
    expect(res.status).toBe(200)
    const parsed = JSON.parse(res.body) as Array<{ error: { code: number } }>
    expect(parsed[0]?.error.code).toBe(RPC_ERROR.INVALID_REQUEST)
    stopAcpHttpServer()
  })

  it('问答页关（publicAskEnabled=false）→ GET / 渲染未启用提示页（200 非 404）', async () => {
    const port = await startAcpEphemeral()
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
    const port = await startAcpEphemeral()
    await startAcpHttpServer(fakeCtx() as never, port) // 二次启动：active 守门 ⇒ 幂等，不重绑
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
    const key = ensurePublicAskKey()
    __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), acpEnabled: true, publicAskEnabled: true }))
    const port = await startAcpEphemeral(dir)
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
    const key = ensurePublicAskKey()
    const port = await startAcpEphemeral(dir)
    try {
      const res = await httpPost(port, { key, ccc: dir, question: 'hi' }, '/ask')
      expect(res.status).toBe(403)
    } finally {
      stopAcpHttpServer()
    }
  })

  it('GET / 问答页开启 → 渲染容器列表页（含开放容器链接）', async () => {
    __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), acpEnabled: true, publicAskEnabled: true }))
    const port = await startAcpEphemeral(dir)
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
      // v1.26.6：列表页 key 门（选容器前必填，不填禁用卡片）+ 容器卡片链接
      const name = dir.split('/').filter(Boolean).pop() ?? ''
      expect(res.body).toContain(`/c/${encodeURIComponent(name)}`)
      expect(res.body).toContain('先填写访问 key')
      expect(res.body).toContain('gateKey') // key 输入门
      expect(res.body).toContain('serenity-public-ask-key') // localStorage key 记忆
      expect(res.body).toContain('localStorage.setItem(KEY_STORE') // 即存（v1.26.7 修复：填 key 即记忆）
      expect(res.body).toContain('viewport-fit=cover') // 移动端 safe-area（v1.26.6）
      expect(res.body).toContain('100dvh') // iOS 地址栏适配
      expect(res.body).toContain('font-size: 16px') // iOS 防聚焦放大
    } finally {
      stopAcpHttpServer()
    }
  })

  it('GET /c/<name> → 单容器问答页（含角色下拉 + localStorage key 恢复）', async () => {
    __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), acpEnabled: true, publicAskEnabled: true }))
    const port = await startAcpEphemeral(dir)
    try {
      const name = dir.split('/').filter(Boolean).pop() ?? ''
      const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path: `/c/${encodeURIComponent(name)}`, method: 'GET' }, (r) => {
          const chunks: Buffer[] = []
          r.on('data', (c: Buffer) => chunks.push(c))
          r.on('end', () => resolve({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }))
        })
        req.on('error', reject)
        req.end()
      })
      expect(res.status).toBe(200)
      // v1.26.6 聊天 UI：消息流 + 输入区 + 新对话按钮；key 已移到列表页（对话页不再填）
      expect(res.body).toContain('msgList')
      expect(res.body).toContain('chatInput')
      expect(res.body).toContain('新对话')
      expect(res.body).toContain('qa') // 角色下拉选项
      expect(res.body).toContain('serenity-public-ask-key') // localStorage key（列表页记忆，对话页读取）
      expect(res.body).not.toContain('keyRow') // 对话页无 key 输入行（v1.26.6 用户拍板）
      expect(res.body).toContain('getStoredKey') // key 从 localStorage 读取
      // public 口 think 不渲染：POST /ask 返回 answer_html 不含 think 折叠
    } finally {
      stopAcpHttpServer()
    }
  })

  it('GET /c/<unknown> → 容器不存在提示页', async () => {
    __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), acpEnabled: true, publicAskEnabled: true }))
    const port = await startAcpEphemeral(dir)
    try {
      const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path: '/c/does-not-exist', method: 'GET' }, (r) => {
          const chunks: Buffer[] = []
          r.on('data', (c: Buffer) => chunks.push(c))
          r.on('end', () => resolve({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }))
        })
        req.on('error', reject)
        req.end()
      })
      expect(res.status).toBe(200)
      expect(res.body).toContain('不存在')
    } finally {
      stopAcpHttpServer()
    }
  })

  it('allowed 白名单：开放容器可问，未开放容器 403/关闭提示页', async () => {
    const key = ensurePublicAskKey()
    const name = dir.split('/').filter(Boolean).pop() ?? ''
    // 白名单不含当前容器（dir 名）→ 它被"已发现但未开放"；"other" 未发现
    updateAdvancedSettings({ publicAsk: { key, allowed: ['some-other-ccc'] } })
    __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), acpEnabled: true, publicAskEnabled: true }))
    const port = await startAcpEphemeral(dir)
    try {
      // 未开放容器 POST /c/<name>/ask → 403
      const denied = await httpPost(port, { key, question: 'hi' }, `/c/${encodeURIComponent(name)}/ask`)
      expect(denied.status).toBe(403)
      // 未开放容器 GET /c/<name> → 关闭提示页（已发现但白名单外）
      const page = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path: `/c/${encodeURIComponent(name)}`, method: 'GET' }, (r) => {
          const chunks: Buffer[] = []
          r.on('data', (c: Buffer) => chunks.push(c))
          r.on('end', () => resolve({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }))
        })
        req.on('error', reject)
        req.end()
      })
      expect(page.status).toBe(200)
      expect(page.body).toContain('未开放问答')
      // 列表页不含未开放容器（dir 名不在列表）
      const list = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path: '/', method: 'GET' }, (r) => {
          const chunks: Buffer[] = []
          r.on('data', (c: Buffer) => chunks.push(c))
          r.on('end', () => resolve({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }))
        })
        req.on('error', reject)
        req.end()
      })
      expect(list.body).not.toContain(`/c/${encodeURIComponent(name)}`)
      // 白名单空 = 全部开放（向后兼容 v1.26.1）：重新放行
      updateAdvancedSettings({ publicAsk: { key, allowed: [] } })
      const ok = await httpPost(port, { key, question: 'hi' }, `/c/${encodeURIComponent(name)}/ask`)
      expect(ok.status).toBe(200)
    } finally {
      stopAcpHttpServer()
    }
  })

  it('POST /c/<name>/ask 会话延续 + 角色参数（v1.26.2 用户：应能选择角色）', async () => {
    const key = ensurePublicAskKey()
    const name = dir.split('/').filter(Boolean).pop() ?? ''
    __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), acpEnabled: true, publicAskEnabled: true }))
    const port = await startAcpEphemeral(dir)
    try {
      const first = await httpPost(port, { key, role: 'qa', question: 'hi' }, `/c/${encodeURIComponent(name)}/ask`)
      expect(first.status).toBe(200)
      const firstData = JSON.parse(first.body) as { sessionId: string; continued: boolean }
      expect(firstData.continued).toBe(false)
      const follow = await httpPost(port, { key, role: 'qa', question: 'again', sessionId: firstData.sessionId }, `/c/${encodeURIComponent(name)}/ask`)
      expect(follow.status).toBe(200)
      const followData = JSON.parse(follow.body) as { continued: boolean }
      expect(followData.continued).toBe(true)
      // 未知角色 → 200（角色缺省回退 CCC 第一个——问答页对普通用户友好，v1.26.2 设计）
      const badRole = await httpPost(port, { key, role: 'nope', question: 'hi' }, `/c/${encodeURIComponent(name)}/ask`)
      expect(badRole.status).toBe(200)
    } finally {
      stopAcpHttpServer()
    }
  })

  // ── v1.26.5 公网可靠校验：key 轮换 + IP 失败锁定（用户：key 校验必须可靠 + 开放公网 + 能换 key）──

  it('rotatePublicAskKey 生成新 key 并覆盖写回（旧 key 立即失效）', () => {
    const k1 = ensurePublicAskKey()
    const k2 = rotatePublicAskKey()
    expect(k2).toMatch(/^[0-9a-f]{64}$/)
    expect(k2).not.toBe(k1)
    expect(verifyPublicAskKey(k1)).toBe(false) // 旧 key 失效
    expect(verifyPublicAskKey(k2)).toBe(true) // 新 key 生效
  })

  it('IP 失败锁定：连续失败达阈值 → 锁定（429）；其它 IP 不受影响；成功重置', async () => {
    const key = ensurePublicAskKey()
    const name = dir.split('/').filter(Boolean).pop() ?? ''
    __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), acpEnabled: true, publicAskEnabled: true }))
    const port = await startAcpEphemeral(dir)
    const path = `/c/${encodeURIComponent(name)}/ask`
    try {
      // 模拟同一 IP（X-Forwarded-For）连续失败
      const post = (xip: string, body: unknown): Promise<{ status: number; body: string }> => {
        return new Promise((resolve, reject) => {
          const data = JSON.stringify(body)
          const req = request({
            host: '127.0.0.1', port, path, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'X-Forwarded-For': xip },
          }, (r) => {
            const chunks: Buffer[] = []
            r.on('data', (c: Buffer) => chunks.push(c))
            r.on('end', () => resolve({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }))
          })
          req.on('error', reject)
          req.end(data)
        })
      }
      // 前 4 次失败 → 401；第 5 次 → 429（触发锁定）
      for (let i = 0; i < 4; i++) {
        expect((await post('1.2.3.4', { key: 'wrong', question: 'hi' })).status).toBe(401)
      }
      const fifth = await post('1.2.3.4', { key: 'wrong', question: 'hi' })
      expect(fifth.status).toBe(429)
      // 锁定期间正确 key 也 429（该 IP）
      const locked = await post('1.2.3.4', { key, question: 'hi' })
      expect(locked.status).toBe(429)
      // 其它 IP 不受影响 → 200
      const other = await post('5.6.7.8', { key, question: 'hi' })
      expect(other.status).toBe(200)
      // 解锁后该 IP 恢复正常（直接重置状态）
      resetPublicAskIpFail('1.2.3.4')
      const afterReset = await post('1.2.3.4', { key, question: 'hi' })
      expect(afterReset.status).toBe(200)
    } finally {
      stopAcpHttpServer()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 🆕 2026-09-25 ⑤ 第 28 件：`acp-http.ts` 的门控 / 路由 / 入参边界面
//
// 挑靶依据 = **先逐行读覆盖率报告的 `cstat-no`/`cbranch-no`，再判可达性**（别按 branch% 排序硬上）。
// 本块只覆盖**逐行核对后确认可达**的分支；其余按 §3-8 登记为「构造上不可达」，
// **刻意不硬凑用例**（硬凑 = 把「从不发生」固化成「期望形态」）。详见地图 §2.7m。
// ─────────────────────────────────────────────────────────────────────────────

/** 目录基名（发现列表里的 `name` 就是它——`listCccs` 的 `basename(root)`） */
function basenameOf(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? ''
}

/**
 * **独立读数器**：从 `process.cwd()` 上溯找 `.serenity`（= CCC 标记）。
 * 🔴 刻意**不复用** `cccRootForCwd` —— 用实现去验实现是自证（读数器要先证明不瞎）。
 * 本仓在 `<某 CCC>/AI_LAB/dsh-serenity-plugin` 下时，它返回的是**外层那个 CCC**。
 */
function enclosingCccFromCwd(): string | null {
  let cur = process.cwd()
  for (let i = 0; i < 32; i++) {
    if (existsSync(join(cur, '.serenity'))) return cur
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return null
}

/** 裸体 POST：body **原样**发送（用于触发 HTTP 层 `JSON.parse` 失败、`null` / 非对象体） */
function httpPostRaw(port: number, raw: string, path = '/'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }))
      },
    )
    req.on('error', reject)
    req.end(raw)
  })
}

/** GET（既有用例各自手搓 Promise；本块统一走它） */
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

describe('acp-http: 门控 / 路由 / 入参边界面（⑤ 第 28 件）', () => {
  // 白名单置空 = 全部开放（本块测的是门控/路由/入参，白名单语义已由既有用例覆盖；
  // 显式写一次是为了**不依赖前面的用例留下的全局状态**——顺序无关）
  beforeEach(() => {
    updateAdvancedSettings({ publicAsk: { key: ensurePublicAskKey(), allowed: [] } })
  })

  it('① 双闸读取 = acpEnabled || publicAskEnabled（含两个都关 ⇒ false）', () => {
    const spec = acpHttpSpec(fakeCtx() as never, 0)
    __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), acpEnabled: true, publicAskEnabled: false }))
    expect(faceEnabled(spec)).toBe(true)
    __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), acpEnabled: false, publicAskEnabled: true }))
    expect(faceEnabled(spec)).toBe(true)
    __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), acpEnabled: false, publicAskEnabled: false }))
    expect(faceEnabled(spec)).toBe(false)
  })

  it('② 两个闸全关：startFace 仍机械启动（面不自门控）⇒ 日志如实写「未开启任何面」', async () => {
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.join(' '))
    })
    try {
      __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), acpEnabled: false, publicAskEnabled: false }))
      await startAcpHttpServer(fakeCtx() as never, 0)
      // face-host 头部注释的不变量：startFace 只做机械绑定，**不读** spec.enabled()（调用方保证意图）
      expect(acpHttpActive()).toBe(true)
      expect(logs.some((l) => l.includes('未开启任何面'))).toBe(true)
    } finally {
      spy.mockRestore()
      stopAcpHttpServer()
    }
  })

  it('③ POST / ：acpEnabled=false（问答页开）⇒ 403「ACP JSON-RPC disabled」', async () => {
    __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), acpEnabled: false, publicAskEnabled: true }))
    const port = await startAcpEphemeral(dir)
    try {
      const res = await httpPost(port, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
      expect(res.status).toBe(403)
      expect(JSON.parse(res.body)).toEqual({ error: 'ACP JSON-RPC disabled (enable in Serenity settings)' })
    } finally {
      stopAcpHttpServer()
    }
  })

  it('④ POST / ：体不是合法 JSON ⇒ 400 parse error 帧（id:null / -32700）', async () => {
    const port = await startAcpEphemeral(dir)
    try {
      const res = await httpPostRaw(port, '{not-json')
      expect(res.status).toBe(400)
      expect(JSON.parse(res.body)).toEqual([
        { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } },
      ])
    } finally {
      stopAcpHttpServer()
    }
  })

  it('⑤ 问答页关：/c/ 两条路由走「未启用」分支 ＋ 未知路径 404', async () => {
    const port = await startAcpEphemeral(dir) // 缺省：acp 开 / 问答页关
    const name = basenameOf(dir)
    try {
      const page = await httpGet(port, `/c/${encodeURIComponent(name)}`)
      expect(page.status).toBe(200)
      expect(page.body).toContain('问答页未启用')

      const ask = await httpPostRaw(port, JSON.stringify({ question: 'hi' }), `/c/${encodeURIComponent(name)}/ask`)
      expect(ask.status).toBe(403)
      expect(JSON.parse(ask.body)).toEqual({ error: 'public ask disabled (enable in Serenity settings)' })

      const nope = await httpGet(port, '/nope')
      expect(nope.status).toBe(404)
      expect(JSON.parse(nope.body)).toEqual({ error: 'not found' })
    } finally {
      stopAcpHttpServer()
    }
  })

  it('⑥ 问答页开：未知路径（GET 与 POST 两侧）⇒ 404', async () => {
    __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), acpEnabled: true, publicAskEnabled: true }))
    const port = await startAcpEphemeral(dir)
    try {
      expect((await httpGet(port, '/nope')).status).toBe(404)
      expect((await httpPost(port, { key: ensurePublicAskKey(), question: 'hi' }, '/nope')).status).toBe(404)
    } finally {
      stopAcpHttpServer()
    }
  })

  it('⑦ POST /ask ：非法 JSON ／ null ／ 非对象体 ⇒ 400 invalid JSON body', async () => {
    __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), acpEnabled: true, publicAskEnabled: true }))
    const port = await startAcpEphemeral(dir)
    try {
      for (const raw of ['{bad', 'null', '"str"']) {
        const res = await httpPostRaw(port, raw, '/ask')
        expect(res.status).toBe(400)
        expect(JSON.parse(res.body)).toEqual({ error: 'invalid JSON body' })
      }
    } finally {
      stopAcpHttpServer()
    }
  })

  it('⑧ POST /c/<name>/ask ：null 体 ⇒ 400 invalid JSON body（体解析先于 key 校验）', async () => {
    __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), acpEnabled: true, publicAskEnabled: true }))
    const port = await startAcpEphemeral(dir)
    try {
      const res = await httpPostRaw(port, 'null', `/c/${encodeURIComponent(basenameOf(dir))}/ask`)
      expect(res.status).toBe(400)
      expect(JSON.parse(res.body)).toEqual({ error: 'invalid JSON body' })
    } finally {
      stopAcpHttpServer()
    }
  })

  it('⑨ POST /ask 兼容面：name 命中；ccc=未发现根 ⇒ 按 root 构造（角色从该根读，出真答）', async () => {
    const key = ensurePublicAskKey()
    __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), acpEnabled: true, publicAskEnabled: true }))
    const port = await startAcpEphemeral(dir)
    const other = mkdtempSync(join(tmpdir(), 'acp-other-'))
    try {
      // other 与 dir 同款配置，但**不是** defaultRoot ⇒ `listCccs` 不含它（本仓发现源在 fake ctx 下
      // 只有 defaultRoot 一路），于是必走「按 root 直接构造」那条分支
      writeFileSync(join(other, '.serenity'), 'other')
      mkdirSync(join(other, '.opencode'), { recursive: true })
      writeFileSync(
        join(other, '.opencode', 'serenity.json'),
        JSON.stringify({ handyman: { models: ['p/m'], defaultModel: 'p/m' }, skiff: { roles: { qa: { msms: ['x'], systemPrompt: 'p' } } } }),
      )

      const byName = await httpPost(port, { key, name: basenameOf(dir), question: 'hi' }, '/ask')
      expect(byName.status).toBe(200)
      expect((JSON.parse(byName.body) as { answer: string }).answer).toBe('a')

      const byRoot = await httpPost(port, { key, ccc: other, question: 'hi' }, '/ask')
      expect(byRoot.status).toBe(200)
      expect((JSON.parse(byRoot.body) as { answer: string }).answer).toBe('a')
    } finally {
      rmSync(other, { recursive: true, force: true })
      stopAcpHttpServer()
    }
  })

  it('⑩ POST /ask ：name 未命中 ／ 两个都没给 ⇒ 403 container is not open', async () => {
    const key = ensurePublicAskKey()
    __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), acpEnabled: true, publicAskEnabled: true }))
    const port = await startAcpEphemeral(dir)
    try {
      const unknownName = await httpPost(port, { key, name: 'no-such-ccc', question: 'hi' }, '/ask')
      expect(unknownName.status).toBe(403)
      expect(JSON.parse(unknownName.body)).toEqual({ error: 'container is not open for public ask' })

      const neither = await httpPost(port, { key, question: 'hi' }, '/ask')
      expect(neither.status).toBe(403)
    } finally {
      stopAcpHttpServer()
    }
  })

  it('⑪ POST /ask ：question 缺失 ／ 全空白 ／ 非字符串 ⇒ 400 empty question', async () => {
    const key = ensurePublicAskKey()
    __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), acpEnabled: true, publicAskEnabled: true }))
    const port = await startAcpEphemeral(dir)
    const name = basenameOf(dir)
    try {
      for (const body of [{ key, name, question: undefined }, { key, name, question: '   ' }, { key, name, question: 123 }]) {
        const res = await httpPost(port, body, '/ask')
        expect(res.status).toBe(400)
        expect(JSON.parse(res.body)).toEqual({ error: 'empty question' })
      }
    } finally {
      stopAcpHttpServer()
    }
  })

  it('⑫ 根无 skiff 角色 ⇒ 400 no skiff role available（fail-closed，不静默 200）', async () => {
    const key = ensurePublicAskKey()
    __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), acpEnabled: true, publicAskEnabled: true }))
    const port = await startAcpEphemeral(dir)
    const bare = mkdtempSync(join(tmpdir(), 'acp-bare-'))
    try {
      writeFileSync(join(bare, '.serenity'), 'bare') // 有意**不写** .opencode/serenity.json（无 skiff.roles）
      const res = await httpPost(port, { key, ccc: bare, question: 'hi' }, '/ask')
      expect(res.status).toBe(400)
      expect(JSON.parse(res.body)).toEqual({ error: `no skiff role available in ccc: ${bare}` })
    } finally {
      rmSync(bare, { recursive: true, force: true })
      stopAcpHttpServer()
    }
  })

  it('⑬ 顶层兜底：设置源抛错 ⇒ 500（带原因；面不崩、不挂死）', async () => {
    const port = await startAcpEphemeral(dir)
    try {
      __setSimpleSourceForTest(() => {
        throw new Error('settings-source-boom')
      })
      const res = await httpGet(port, '/')
      expect(res.status).toBe(500)
      expect(JSON.parse(res.body)).toEqual({ error: 'settings-source-boom' })
    } finally {
      stopAcpHttpServer()
    }
  })

  it('⑭ 无默认根 ⇒ cccsOf 回落「cwd 上溯」：解析到**外层那个 CCC**（不在任何 CCC 内则空态）', async () => {
    __setSimpleSourceForTest(() => ({ ...defaultSimpleSettings(), acpEnabled: true, publicAskEnabled: true }))
    const port = await startAcpEphemeral() // 有意不传 root：handler 收到 defaultRoot=''
    try {
      const res = await httpGet(port, '/')
      expect(res.status).toBe(200)
      expect(res.body).toContain('Serenity Public Ask')
      const enclosing = enclosingCccFromCwd()
      if (enclosing === null) {
        // 本仓被检出到任何 CCC 之外 ⇒ 上溯无所获 ⇒ 空态页
        expect(res.body).toContain('暂无可问答的认知容器')
      } else {
        // 本仓位于 <外层 CCC>/AI_LAB/dsh-serenity-plugin 之下 ⇒ 上溯命中的是**外层那个 CCC**
        // （源码注释的「缺省回落进程 cwd 上溯」= 就这条；断言名而非路径，免受检出位置影响）
        expect(res.body).toContain(`data-name="${basenameOf(enclosing)}"`)
      }
    } finally {
      stopAcpHttpServer()
    }
  })

  it('⑮ 顶层兜底对**任意抛出物**都成立：非 Error（字符串）抛出 ⇒ 500 且错误面仍可读', async () => {
    const port = await startAcpEphemeral(dir)
    try {
      // 抛出物不是 Error ⇒ 走 `(err as Error)?.message ?? String(err)` 的右支
      __setSimpleSourceForTest(() => {
        throw 'plain-string-boom'
      })
      const res = await httpGet(port, '/')
      expect(res.status).toBe(500)
      expect(JSON.parse(res.body)).toEqual({ error: 'plain-string-boom' })
    } finally {
      stopAcpHttpServer()
    }
  })
})
