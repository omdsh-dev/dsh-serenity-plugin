/**
 * ⑤ 第 13 件（语义深度：**文件发送三步链**，2026-09-25）：`weixin-api.ts` 的 `sendFileMessage`
 * 在覆盖率报告里整段 `fstat-no`（连它私有的 `padTo16` 也没执行过）—— 而它是 **`im-bridge send-file`
 * 的落地实现**（v1.31.0 从 CCC MSM 迁入 ACC），即"用户让招财发个文件"这条真实链路的最后一公里。
 *
 * 🔴 本组的判据（为什么不是"跑通就算"）：
 *   1. **真的验算法，不验"函数被调用"** —— CDN 上传体必须是 **AES-128-ECB（无 IV）** 密文；
 *      本组用**上传请求自己报出的 `aeskey`** 解密回去，与原文**逐字节比对**。若哪天有人把加密去掉/
 *      改模式/截断 padding，这条断言会红（"跑通"的 mock 断言不会）。
 *   2. **两个 `encrypt_query_param` 来源的优先级** —— 响应头 `x-encrypted-param` 优先，缺失时回退响应体
 *      JSON 的 `encrypted_query_param`（iLink 两种形态都出现过）。
 *   3. **iLink 业务码不算成功** —— HTTP 200 ＋ `{ret:1}` 必须抛（v1.30.9 修复的语义：否则"发送成功"
 *      是假的，回复路径会给一条**从未送达**的消息触发 outgoing 记录）。
 *   4. **凭据不外溢** —— 带 token 的两个业务请求须带 `Authorization: Bearer …`，而**CDN 上传请求不带**
 *      （上传走第三方 CDN，凭据不该出这个门）。
 *
 * 零网络：全程用模块自带的注入点 `__setWeixinFetchForTest`（生产零调用）。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createDecipheriv, createHash } from 'node:crypto'
import { sendFileMessage, __setWeixinFetchForTest } from '../src/weixin-api.js'

/** 一次被记录下来的 fetch 调用（url / method / body / headers 全留痕） */
interface Call {
  url: string
  method: string
  body: unknown
  headers: Record<string, string>
}

const HEADER_PARAM = 'eq-from-header'
const BODY_PARAM = 'eq-from-body'

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function record(input: RequestInfo | URL, init?: RequestInit): Call {
  return {
    url: typeof input === 'string' ? input : String(input),
    method: String(init?.method ?? 'GET'),
    body: init?.body,
    headers: (init?.headers ?? {}) as Record<string, string>,
  }
}

/** 三步链的通用替身：getuploadurl → CDN 上传 → sendmessage；各步响应可按用例定制。 */
function fakeChain(opts: {
  uploadUrlResp?: () => Response | Promise<Response>
  cdnResp?: () => Response | Promise<Response>
  sendResp?: () => Response | Promise<Response>
} = {}): Call[] {
  const calls: Call[] = []
  __setWeixinFetchForTest(async (input, init) => {
    const c = record(input, init)
    calls.push(c)
    if (c.url.includes('/ilink/bot/getuploadurl')) {
      return opts.uploadUrlResp?.() ?? jsonResponse(200, { ret: 0, upload_full_url: 'https://cdn.example.com/upload?x=1' })
    }
    if (c.url.includes('/upload?')) {
      return opts.cdnResp?.() ?? new Response('', { status: 200, headers: { 'x-encrypted-param': HEADER_PARAM } })
    }
    if (c.url.includes('/ilink/bot/sendmessage')) {
      return opts.sendResp?.() ?? jsonResponse(200, { ret: 0 })
    }
    throw new Error(`未预期的请求: ${c.url}`)
  })
  return calls
}

const params = (data: Buffer, fileName = 'note.txt') => ({
  baseUrl: 'https://ilink.example.com',
  token: 'tok-secret',
  toUserId: 'u@im.wechat',
  data,
  fileName,
})

afterEach(() => {
  __setWeixinFetchForTest(null)
})

describe('⑤ 第 13 件：sendFileMessage（文件发送三步链，真算法断言）', () => {
  it('①②③ 三步走通：getuploadurl → CDN（AES-128-ECB 真加密）→ sendmessage(FILE)；返回名与字节数', async () => {
    const data = Buffer.from('hello weixin file body!!', 'utf-8') // 27 B
    const calls = fakeChain()
    const r = await sendFileMessage(params(data))

    expect(r).toEqual({ fileName: 'note.txt', size: data.length })
    expect(calls).toHaveLength(3)
    expect(calls[0]!.url).toContain('/ilink/bot/getuploadurl')
    expect(calls[1]!.url).toBe('https://cdn.example.com/upload?x=1')
    expect(calls[2]!.url).toContain('/ilink/bot/sendmessage')

    // ── ① getuploadurl 请求体（协议字段逐条）──
    const up = JSON.parse(String(calls[0]!.body)) as Record<string, unknown>
    expect(up.media_type).toBe(3) // 3 = 文件
    expect(up.to_user_id).toBe('u@im.wechat')
    expect(up.rawsize).toBe(data.length)
    expect(up.rawfilemd5).toBe(createHash('md5').update(data).digest('hex'))
    expect(up.no_need_thumb).toBe(true)
    expect(String(up.filekey)).toMatch(/^dsp-[0-9a-f]{16}$/)
    const aesKeyHex = String(up.aeskey)
    expect(aesKeyHex).toMatch(/^[0-9a-f]{32}$/) // 16 字节密钥的 hex

    // ── ② CDN 上传体：用**它自己报出的 aeskey** 解密回去，与原文逐字节相同 ──
    //    （AES-128-ECB，无 IV；若实现改成不解密/别模式/丢 padding，这里必红）
    const uploadBody = calls[1]!.body
    expect(Buffer.isBuffer(uploadBody)).toBe(true)
    const decipher = createDecipheriv('aes-128-ecb', Buffer.from(aesKeyHex, 'hex'), null)
    const decrypted = Buffer.concat([decipher.update(uploadBody as Buffer), decipher.final()])
    expect(decrypted.equals(data)).toBe(true)
    // 密文长度 = 16 对齐（PKCS#7 补位后）
    expect((uploadBody as Buffer).length % 16).toBe(0)

    // ── ③ sendmessage：FILE item ＋ 加密参数来源（此处来自响应头）──
    const send = JSON.parse(String(calls[2]!.body)) as {
      msg: {
        from_user_id: string
        to_user_id: string
        client_id: string
        message_type: number
        message_state: number
        item_list: Array<{
          type: number
          file_item: {
            media: { encrypt_query_param: string; aes_key: string; encrypt_type: number }
            file_name: string
            md5: string
            len: string
          }
        }>
      }
    }
    expect(send.msg.message_type).toBe(2) // BOT
    expect(send.msg.message_state).toBe(2) // FINISH
    expect(send.msg.to_user_id).toBe('u@im.wechat')
    expect(send.msg.client_id).toMatch(/^dsp-weixin-[0-9a-f]{8}$/)
    const item = send.msg.item_list[0]!
    expect(item.type).toBe(4) // FILE
    expect(item.file_item.media.encrypt_query_param).toBe(HEADER_PARAM)
    expect(item.file_item.media.encrypt_type).toBe(1)
    expect(item.file_item.file_name).toBe('note.txt')
    expect(item.file_item.md5).toBe(up.rawfilemd5)
    expect(item.file_item.len).toBe(String(data.length))
    // 🔴 `aes_key` 的编码是 base64(**hex 串**)，不是 base64(原始字节) —— 解码回去应得到那串 hex
    expect(item.file_item.media.aes_key).toBe(Buffer.from(aesKeyHex, 'utf-8').toString('base64'))
    expect(Buffer.from(item.file_item.media.aes_key, 'base64').toString('utf-8')).toBe(aesKeyHex)
  })

  it('🔴 正控（证明上面那条解密断言"不瞎"）：拿同一把 key 去解**明文**必不相等/必抛', () => {
    // 若 AES-128-ECB 是恒等变换、或密钥没生效，上一条 `decrypted.equals(data)` 会"永远绿"。
    // 这里用同一把 key、同一段代码路径解一段**明文**，必须得到"不相等或抛错"。
    const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
    const plain = Buffer.alloc(32, 0x41) // 'AAAA…'（长度 16 对齐，避免"长度不对"这种廉价失败）
    let distinguished: boolean
    try {
      const d = createDecipheriv('aes-128-ecb', key, null)
      const out = Buffer.concat([d.update(plain), d.final()])
      distinguished = !out.equals(plain)
    } catch {
      distinguished = true
    }
    expect(distinguished).toBe(true)
  })

  it('🔴 凭据边界：两个业务请求带 Authorization，CDN 上传请求**不带**', async () => {
    const calls = fakeChain()
    await sendFileMessage(params(Buffer.from('x')))
    expect(calls[0]!.headers.Authorization).toBe('Bearer tok-secret')
    expect(calls[2]!.headers.Authorization).toBe('Bearer tok-secret')
    expect(calls[1]!.headers.Authorization).toBeUndefined()
    expect(calls[1]!.headers['Content-Type']).toBe('application/octet-stream')
    // token 绝不进请求体
    for (const c of calls) expect(String(c.body)).not.toContain('tok-secret')
  })

  it('filesize 按 16 对齐（padTo16 三态：5→16 ／ 16→16 ／ 17→32）', async () => {
    for (const [len, padded] of [[5, 16], [16, 16], [17, 32]] as const) {
      const calls = fakeChain()
      await sendFileMessage(params(Buffer.alloc(len, 1)))
      const up = JSON.parse(String(calls[0]!.body)) as { rawsize: number; filesize: number }
      expect(up.rawsize).toBe(len)
      expect(up.filesize).toBe(padded)
    }
  })

  it('encrypt_query_param 回退：响应头缺失 ⇒ 用响应体 JSON 的 encrypted_query_param', async () => {
    const calls = fakeChain({
      cdnResp: () => jsonResponse(200, { encrypted_query_param: BODY_PARAM }),
    })
    await sendFileMessage(params(Buffer.from('abc')))
    const send = JSON.parse(String(calls[2]!.body)) as { msg: { item_list: Array<{ file_item: { media: { encrypt_query_param: string } } }> } }
    expect(send.msg.item_list[0]!.file_item.media.encrypt_query_param).toBe(BODY_PARAM)
  })

  it('upload_full_url 缺失 ⇒ 用 CDN 基址 ＋ upload_param/filekey 组装（并 encode）', async () => {
    const calls = fakeChain({
      uploadUrlResp: () => jsonResponse(200, { ret: 0, upload_param: 'p ram/x', filekey: 'k/1' }),
    })
    await sendFileMessage(params(Buffer.from('abc')))
    const url = calls[1]!.url
    expect(url.startsWith('https://novac2c.cdn.weixin.qq.com/c2c/upload?')).toBe(true)
    expect(url).toContain(`encrypted_query_param=${encodeURIComponent('p ram/x')}`)
    expect(url).toContain(`filekey=${encodeURIComponent('k/1')}`)
  })

  it('🔴 HTTP 200 ＋ `{ret:1}` 不算成功：CDN 上传失败会抛（不产生"假成功"）', async () => {
    fakeChain({ cdnResp: () => jsonResponse(200, { ret: 1, errmsg: 'denied' }) })
    // 🔵 实测到的报文形状：`CDN 上传失败: ret=1 errcode=undefined: denied`
    //    （`errcode` 未给时也照打 ⇒ 此处只钉"是失败 ＋ 带上 ret 与 errmsg"，不钉那个 undefined 的措辞）
    await expect(sendFileMessage(params(Buffer.from('abc')))).rejects.toThrow(/CDN 上传失败: ret=1 .*: denied/)
  })

  it('🔴 sendmessage 的 iLink 业务码同样拦截：`{ret:1}` ⇒ 抛（而非返回 fileName/size）', async () => {
    fakeChain({ sendResp: () => jsonResponse(200, { ret: 1, errmsg: 'blocked' }) })
    await expect(sendFileMessage(params(Buffer.from('abc')))).rejects.toThrow(/ilink\/bot\/sendmessage ret=1: blocked/)
  })

  it('响应既无头也无 param（非 JSON 体）⇒ 抛错且带上 HTTP 状态', async () => {
    fakeChain({ cdnResp: () => new Response('oops-not-json', { status: 500 }) })
    await expect(sendFileMessage(params(Buffer.from('abc')))).rejects.toThrow(/缺 encrypt_query_param（HTTP 500）/)
  })

  it('getuploadurl 响应非 JSON ⇒ 抛（不把 HTML 错误页当成功）', async () => {
    fakeChain({ uploadUrlResp: () => new Response('<html>gateway error</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }) })
    await expect(sendFileMessage(params(Buffer.from('abc')))).rejects.toThrow(/getuploadurl 响应非 JSON/)
  })

  it('getuploadurl 响应缺 upload_full_url/upload_param ⇒ 抛', async () => {
    fakeChain({ uploadUrlResp: () => jsonResponse(200, { ret: 0, filekey: 'k' }) })
    await expect(sendFileMessage(params(Buffer.from('abc')))).rejects.toThrow(/缺 upload_full_url\/upload_param/)
  })

  it('HTTP 层失败（非 2xx）⇒ 抛错且带端点名与状态码', async () => {
    fakeChain({ uploadUrlResp: () => new Response('nope', { status: 404 }) })
    await expect(sendFileMessage(params(Buffer.from('abc')))).rejects.toThrow(/ilink\/bot\/getuploadurl 404: nope/)
  })
})
