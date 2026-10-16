/**
 * acp-setcfg-check.mjs — 面 E 的**标准 ACP 流程**探针（临时诊断用，非判据）
 *
 * 问的问题：面 E 建的会话拿不到模型（真缺陷）时，**标准 ACP 客户端流程**（先说
 * `session/set_config_option` 选模型，再 prompt）能不能绕开它？
 * 这决定了那个缺陷的**严重度档位**：
 *   · 若能绕开 ⇒ "客户端必须先选模型"是**流程要求**，不是致命缺陷（但我们的面仍应给默认值）
 *   · 若绕不开 ⇒ 面 E **今天完全不能用**，手机端第一条消息必失败
 */
const { createRequire } = await import('node:module')
const req = createRequire('/root/.dsh/profiles/web/node_modules/@shgroup/dsh-serenity-hooks/lib/index.js')
const { WebSocket } = req('ws')

const PORT = process.env.ACP_PORT || 3200
const PHRASE = process.env.ACP_PHRASE || 'ACP-SETCFG-OK'
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`)
let step = 0
let buf = ''
let txt = ''
const pend = new Map()

function send(method, params) {
  return new Promise((res, rej) => {
    const id = ++step
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    pend.set(id, { res, rej })
    setTimeout(() => { if (pend.has(id)) { pend.delete(id); rej(new Error('timeout ' + method)) } }, 30000)
  })
}

ws.on('message', (d) => {
  buf += d.toString()
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (!l.trim()) continue
    let m
    try { m = JSON.parse(l) } catch { continue }
    if (m.id !== undefined && pend.has(m.id)) {
      const p = pend.get(m.id)
      pend.delete(m.id)
      if (m.error) p.rej(new Error(JSON.stringify(m.error)))
      else p.res(m.result)
      continue
    }
    const u = m.params && m.params.update
    if (u && u.sessionUpdate === 'agent_message_chunk' && u.content && u.content.type === 'text') {
      txt += u.content.text
    }
  }
})

ws.on('open', async () => {
  try {
    await send('initialize', { protocolVersion: 1, clientCapabilities: {} })
    const s = await send('session/new', { cwd: '/ccc', mcpServers: [] })
    console.log('SESSION=' + s.sessionId)
    const opts = s.configOptions || []
    console.log('CONFIG_OPTIONS=' + JSON.stringify(opts).slice(0, 800))

    // 标准 ACP 流程：客户端**先选模型**（宿主自己也是这么给用户选模型的）
    const modelOpt = (opts || []).find((o) => o.id === 'model' || o.category === 'model' || o.type === 'select')
    if (modelOpt) {
      const first = (modelOpt.options && modelOpt.options[0]) || null
      console.log('PICKING=' + JSON.stringify(first).slice(0, 300))
      const val = first ? first.value : undefined
      if (val !== undefined) {
        const r = await send('session/set_config_option', {
          sessionId: s.sessionId, configId: modelOpt.id, value: val,
        })
        console.log('SET_OK=' + JSON.stringify(r).slice(0, 400))
      }
    } else {
      console.log('NO_MODEL_OPTION')
    }

    const r = await send('session/prompt', {
      sessionId: s.sessionId,
      prompt: [{ type: 'text', text: `Reply with exactly: ${PHRASE}` }],
    })
    console.log('PROMPT=' + JSON.stringify(r).slice(0, 300))
  } catch (e) {
    console.log('ERR=' + e.message)
  }
  const stripped = txt.replace(/<think[\s\S]*?<\/think>/gi, '')
  console.log(`CONTENT_HIT=${stripped.includes(PHRASE)} len=${stripped.length}`)
  process.exit(0)
})

ws.on('error', (e) => { console.log('WS_ERR=' + e.message); process.exit(1) })
setTimeout(() => { console.log('GUARD_TIMEOUT'); process.exit(2) }, 90000)
