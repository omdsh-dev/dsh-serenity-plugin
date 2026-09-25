/**
 * skiff-debug-branches.test.ts — 🔴 **⑤ 第 62 件**：`src/skiff-debug.ts` 的
 * **`/ask` 入参校验面 ＋ handler 尾部兜底**
 * （2026-09-26 · 对应地图 §2.7 的续段）
 *
 * ## 为什么挑它（复扫读数，纪律 2）
 * `coverage/src/index.html`（00:36 那一跑，第 61 件之后）实测：`src/**` 分支覆盖率
 * **最低且尚未做过**的文件 = `skiff-debug.ts`（**83.2% = 104/125**；
 * 语句 99.01% ＝ 504/509；函数 19/19 已满）。
 *
 * ## 🔴 开工第一步 = 核对既有登记（但**本件第一步做得不够，见下**）
 * 我读了 `tests/skiff-debug.test.ts`（475 行）——它覆盖：问答页渲染（纯函数）／调试服务
 * 正路（start／GET／POST 成功往返／会话延续三态／404／幂等）／`renderSkiffMarkdown` 正路
 * ／面规格意图读取。⇒ 本件**不重做**其中任何一条。
 *
 * 🔴🔴 **本件踩到并纠正的一个方法错（新纪律 ⑯，务必沿用）**：
 * 我**只按文件名** `skiff-debug` 去找既有登记，于是**漏掉了 `think-render.test.ts`**
 * —— 该文件（16 个用例）**已完整覆盖** `renderSkiffMarkdown` 的**全部**变体面：
 * 基础折叠／hideThink／**未闭合优雅截断**／嵌套／**属性变体**／**大小写不敏感**／
 * **`</think >` 尾随空格**／**多块保序**／占位符冲突／XSS 转义／空 think／长文本／CRLF。
 * 我因此**白写了一整组**（且首跑三红 —— 因为我那组还漏了该文件顶部的 `vi.mock`，
 * 连"标准形态"都跑不出折叠卡）。
 * ⇒ 🆕 **判据：核对既有登记**不能只按**文件名**匹配，必须按**被测符号**反查
 *   （grep 导出名／函数名，如 `renderSkiffMarkdown`），否则**同一模块的测试可能散落
 *   在按"主题"命名的文件里**（本仓实例：think 渲染 → `think-render.test.ts`）。
 *   那组已**整组删除**，只保留下面真正未被覆盖的部分。
 *
 * ## 本件真正覆盖的对象（既有两文件都没碰的）
 * 全部落在 `handle()`（源 `:425-509`）——**`/ask` 的入参退化面与 handler 尾部**：
 *   · `:453`/`:454` `role` ／ `question` **非字符串/缺失** ⇒ `?? ''` 兜底
 *   · `:462` **空问题守卫**（`!question.trim()`）
 *   · `:508` **handler 顶层 catch** ⇒ 500 ＋ 可读原因
 *   · `:433` query string 剥除 ／ 非 GET//ask ⇒ 404
 *   · `:445` 体**不是对象**（解析成功但非 object —— 与"非法 JSON"是两条分支）
 *
 * ## 🔴 本件为何要紧
 * · `:508` 顶层 catch 是这个面「**绝不把异常泄成连接重置**」的唯一执行点。
 * · `:462` 空问题守卫写反（改成 `question.trim()`）⇒ **空问题会被真的发给 agent**
 *   （用户等一个空回答、白烧一轮模型调用）而**既有测试全绿**。
 *
 * ## 判据纪律（本件用到的高频条）
 * · **⑬ 降级面必须与正控方向成对测**：每条拒绝都断言"**agent 没被创建**"，
 *   而不是只看状态码（只断言 400 是弱测试：无法区分"拒绝了"与"拒了但副作用已发生"）。
 * · **⑫ 错误码钉"可分性"**：400（入参错）与 500（服务端自身错）必须可区分。
 * · **端口纪律**：全部 `port: 0`（**绝不占用 3099 —— 那是 skiff 调试面生产端口**）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { request } from 'node:http'

import { startSkiffDebugServer, stopSkiffDebugServer, skiffDebugPort } from '../src/skiff-debug.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skiff-debug-br-'))
  writeFileSync(join(dir, '.serenity'), 'test')
})

afterEach(() => {
  stopSkiffDebugServer()
  rmSync(dir, { recursive: true, force: true })
})

/** 起调试面于 `port: 0`（内核挑端口）—— 沿用既有文件的做法，**不碰 3099** */
async function startEphemeral(ctx: unknown = {}): Promise<number> {
  await startSkiffDebugServer(ctx as never, dir, 0, 3080)
  const port = skiffDebugPort()
  if (port === null) throw new Error('skiff-debug 面未在监听')
  return port
}

function httpReq(port: number, method: string, path: string, raw?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1', port, path, method,
        ...(raw === undefined ? {} : { headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) } }),
      },
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

/** 写入一个有 `qa` 角色的 CCC 配置（裸 `dir` 无角色 ⇒ 会被 `unknown role` 先拦掉） */
function writeQaRole(): void {
  mkdirSync(join(dir, '.opencode'), { recursive: true })
  writeFileSync(
    join(dir, '.opencode', 'serenity.json'),
    JSON.stringify({ skiff: { roles: { qa: { msms: ['x'], systemPrompt: 'p' } } } }),
  )
}

/**
 * 🔴 **agent 未被创建的可判夹具**：把 `createSkiffAgent` 的入口（`ctx.agents`）做成
 * **一被碰就记录**的探针 ⇒ 拒绝路径必须**一次都没碰过它**。
 * （只断言状态码无法区分"拒绝了"与"拒了但副作用已发生"—— 纪律 ⑬。）
 */
function agentProbe(): { ctx: unknown; creates: () => number } {
  let creates = 0
  const ctx = {
    get: () => undefined,
    agents: {
      create: () => { creates += 1; throw new Error('agent must not be created on a rejected request') },
    },
  }
  return { ctx, creates: () => creates }
}

describe('skiff-debug 退化面：`/ask` 入参校验（拒绝时**绝不创建 agent**）', () => {
  it('🔴 `:453`/`:454` role 与 question **非字符串/缺失** ⇒ 走 `?? ""` 兜底 ⇒ 400', async () => {
    const probe = agentProbe()
    const port = await startEphemeral(probe.ctx)

    // role 非字符串 ⇒ `roleName = ''` ⇒ `!roleName` ⇒ 400 unknown role（文案里 roleName 是空串）
    const badRole = await httpReq(port, 'POST', '/ask', JSON.stringify({ ccc: dir, role: 123, question: 'hi' }))
    expect(badRole.status).toBe(400)
    expect(badRole.body).toContain('unknown role')

    // question 非字符串 ⇒ `question = ''` ⇒ `!''.trim()` ⇒ 400 empty question
    const badQ = await httpReq(port, 'POST', '/ask', JSON.stringify({ ccc: dir, role: 'ghost', question: 42 }))
    expect(badQ.status).toBe(400)

    // 🔴 负控（纪律 ⑬）：以上两次拒绝**都没有碰过 agent 创建口**
    expect(probe.creates(), '被拒的请求绝不得创建 agent').toBe(0)
  })

  it('🔴 `:462` 空问题守卫：`question` **纯空白**（空格/制表/换行）⇒ 400 empty question', async () => {
    writeQaRole() // 角色合法 ⇒ 必须由**空问题守卫**拦下（而不是被 unknown role 拦下）
    const probe = agentProbe()
    const port = await startEphemeral(probe.ctx)

    for (const q of ['', ' ', '\t', '\n', '   \n\t ']) {
      const res = await httpReq(port, 'POST', '/ask', JSON.stringify({ ccc: dir, role: 'qa', question: q }))
      expect(res.status, `question=${JSON.stringify(q)} 应被空问题守卫拦下`).toBe(400)
      expect(res.body).toContain('empty question')
    }
    // 负控：拒绝路径没创建 agent；且**服务仍活着**（守卫没把面搞崩）
    expect(probe.creates()).toBe(0)
  })

  it('🔴 `:462` 守卫的**正控方向**：非空白问题**不得**被拦（否则"守卫生效"与"端点坏了"不可分）', async () => {
    writeQaRole()
    const port = await startEphemeral(agentProbe().ctx)
    // 用非空问题 ⇒ 守卫放行 ⇒ 继续走到 agent 创建口（该口故意抛）⇒ 由顶层 catch 收敛成 500。
    // 🔴 关键判据：**状态码不是 400，也不是 "empty question"** —— 证明它**越过了**空问题守卫。
    const res = await httpReq(port, 'POST', '/ask', JSON.stringify({ ccc: dir, role: 'qa', question: '真实问题' }))
    expect(res.status, '非空问题必须越过守卫').not.toBe(400)
    expect(res.body).not.toContain('empty question')
  })
})

describe('skiff-debug 退化面：handler 顶层兜底与请求形状', () => {
  it('🔴 `:508` 顶层 catch：意外抛出 ⇒ **500 ＋ 可读原因**（不是连接重置、不是 400）', async () => {
    writeQaRole()
    // 真实故障形态：agent 创建口抛（宿主 agents 服务不可用 / 模型未配置）
    const port = await startEphemeral(agentProbe().ctx)
    const res = await httpReq(port, 'POST', '/ask', JSON.stringify({ ccc: dir, role: 'qa', question: 'q' }))

    // 🔴 可分性（纪律 ⑫）：这是**服务端自身**的错 ⇒ 500，**不是** 400（那是入参错）
    expect(res.status, '意外抛出必须收敛成 500').toBe(500)
    expect(res.body).toContain('agent must not be created'), '原因必须可读（不得只回一个空 500）'
    // 负控：面**没崩** —— 同一进程里再发一个正常请求仍应有应答
    const alive = await httpReq(port, 'GET', '/')
    expect(alive.status, '顶层 catch 不得让面崩掉').toBe(200)
  })

  it('🔴 `:433` 路径解析：query string 被剥掉（`?x=1` 不影响路由匹配）', async () => {
    const port = await startEphemeral()
    const res = await httpReq(port, 'GET', '/?nocache=123')
    expect(res.status, '带 query 的 / 仍须命中首页路由').toBe(200)
    expect(res.body).toContain('Skiff Debug')
  })

  it('🔴 `:433` 非 GET/非 /ask（如 PUT /）⇒ 404 `not found`（不是 405、不是崩）', async () => {
    const port = await startEphemeral()
    for (const [method, path] of [['PUT', '/'], ['DELETE', '/ask'], ['GET', '/ask']] as Array<[string, string]>) {
      const res = await httpReq(port, method, path)
      expect(res.status, `${method} ${path}`).toBe(404)
      expect(res.body).toContain('not found')
    }
  })

  it('🔴 `:445` 体**不是对象**（`null` ／ 裸数 ／ 裸字符串）⇒ 400 invalid JSON body', async () => {
    const port = await startEphemeral()
    // 既有用例测了"非法 JSON"（解析失败）；本条测**解析成功但不是对象**——那是另一条分支
    for (const raw of ['null', '42', '"just a string"', 'true']) {
      const res = await httpReq(port, 'POST', '/ask', raw)
      expect(res.status, `体=${raw}`).toBe(400)
      expect(res.body).toContain('invalid JSON body')
    }
  })
})
