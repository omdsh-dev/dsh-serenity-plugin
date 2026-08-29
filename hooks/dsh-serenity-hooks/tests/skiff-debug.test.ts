import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { request } from 'node:http'

vi.mock('@deepseek-ai/dsh-llm', () => ({
  createUserMessage: (o: unknown) => o,
}))

import { skiffDebugPage, startSkiffDebugServer, stopSkiffDebugServer, skiffDebugActive, skiffDebugPort } from '../src/skiff-debug.js'

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

describe('skiff-debug: 问答页渲染（纯函数）', () => {
  it('含角色下拉 + WebUI 链接 + 轨迹区', () => {
    const roles = new Map([
      ['qa-readonly', { model: 'm/M3' }],
      ['review', {}],
    ])
    const html = skiffDebugPage(roles, 3080)
    expect(html).toContain('Skiff Debug')
    expect(html).toContain('qa-readonly')
    expect(html).toContain('review')
    expect(html).toContain('http://127.0.0.1:3080')
    expect(html).toContain('trajectory')
    expect(html).toContain('/ask')
  })

  it('无角色 → 提示选项', () => {
    const html = skiffDebugPage(new Map(), 3080)
    expect(html).toContain('(未配置角色)')
  })
})

describe('skiff-debug: 调试服务（ephemeral 端口）', () => {
  it('start → GET / 渲染问答页；stop → active 清除', async () => {
    const port = freePort()
    await startSkiffDebugServer({} as never, dir, port, 3080)
    expect(skiffDebugActive()).toBe(true)
    expect(skiffDebugPort()).toBe(port)
    const res = await httpGet(port, '/')
    expect(res.status).toBe(200)
    expect(res.body).toContain('Skiff Debug')
    stopSkiffDebugServer()
    expect(skiffDebugActive()).toBe(false)
  })

  it('POST /ask unknown role → 400（错误路径；不创建 agent）', async () => {
    const port = freePort()
    await startSkiffDebugServer({} as never, dir, port, 3080)
    const res = await httpPost(port, '/ask', { role: 'ghost', question: 'hi' })
    expect(res.status).toBe(400)
    expect(res.body).toContain('unknown role')
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
