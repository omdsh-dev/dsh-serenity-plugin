import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { imageNoteTemplate, uploadImage, getDraftFiles, resendText } from '../src/client/image-fallback-api.js'

describe('image-fallback-api: imageNoteTemplate（图片路径提示模板，P1-2 补测）', () => {
  it('单图：The user provided an image (path: ...)', () => {
    expect(imageNoteTemplate(['_tmp/images_from_user/a.png'])).toBe(
      'The user provided an image (path: _tmp/images_from_user/a.png)',
    )
  })

  it('多图：每行一条路径', () => {
    const note = imageNoteTemplate(['_tmp/images_from_user/a.png', '_tmp/images_from_user/b.jpg'])
    expect(note).toBe('The user provided 2 images:\n- _tmp/images_from_user/a.png\n- _tmp/images_from_user/b.jpg')
  })
})

describe('image-fallback-api: uploadImage（POST /serenity/image-upload）', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('btoa', (s: string) => Buffer.from(s, 'binary').toString('base64'))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    fetchMock.mockReset()
  })

  function file(name: string, type: string, bytes: Uint8Array): File {
    return new File([bytes], name, { type })
  }

  it('成功：返回 path', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ path: '_tmp/images_from_user/x.png' }) })
    const p = await uploadImage(file('x.png', 'image/png', new Uint8Array([1, 2, 3])), 'sess-1')
    expect(p).toBe('_tmp/images_from_user/x.png')
    // 校验请求形态：路径/方法/头/body 结构
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; headers: Record<string, string>; body: string }]
    expect(url).toBe('/serenity/image-upload')
    expect(init.method).toBe('POST')
    expect(init.headers['content-type']).toBe('application/json')
    expect(init.headers['x-serenity-ui']).toBe('1')
    const body = JSON.parse(init.body)
    expect(body.sessionId).toBe('sess-1')
    expect(body.mediaType).toBe('image/png')
    expect(body.name).toBe('x.png')
    expect(typeof body.data).toBe('string') // base64
  })

  it('失败（非 ok）→ 抛错带状态码', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'boom' }) })
    await expect(uploadImage(file('a.png', 'image/png', new Uint8Array([1])), 's1')).rejects.toThrow(/serenity image upload failed: boom/)
  })

  it('ok 但无 path 字段 → 抛错', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) })
    await expect(uploadImage(file('a.png', 'image/png', new Uint8Array([1])), 's1')).rejects.toThrow(/serenity image upload failed/)
  })
})

describe('image-fallback-api: getDraftFiles（conversation.draftImages 读 File）', () => {
  it('conversation 装配 → 返回 draft File 列表（方法调用保 this）', async () => {
    const f1 = new File(['a'], 'a.png', { type: 'image/png' })
    const draftImages = vi.fn().mockReturnValue([{ file: f1 }])
    const ctx = { get: (name: string) => (name === 'conversation' ? { draftImages } : undefined) }
    const files = await getDraftFiles(ctx as never, 's1', ['img-1'])
    expect(files).toEqual([f1])
    // 方法调用形态：draftImages 作为 conversation 方法被调（this 绑定）
    expect(draftImages.mock.instances[0]).toEqual({ draftImages })
  })

  it('conversation 未装配 / 无 draftImages → 空数组', async () => {
    expect(await getDraftFiles({ get: () => undefined } as never, 's1', [])).toEqual([])
    expect(await getDraftFiles({ get: (n: string) => (n === 'conversation' ? {} : undefined) } as never, 's1', [])).toEqual([])
  })

  it('draftImages 返回 undefined → 空数组', async () => {
    const ctx = { get: () => ({ draftImages: () => undefined }) }
    expect(await getDraftFiles(ctx as never, 's1', ['x'])).toEqual([])
  })
})

describe('image-fallback-api: resendText（session.prompt 纯文本重发）', () => {
  it('成功：prompt ok → resolve', async () => {
    const prompt = vi.fn().mockResolvedValue({ ok: true })
    const ctx = {
      sessions: { binding: (id: string) => ({ session: { prompt } }) },
    }
    await resendText(ctx as never, 'sess-1', 'hello')
    expect(prompt).toHaveBeenCalledWith([{ type: 'text', text: 'hello' }], 'queue')
  })

  it('session 不可用（无 binding/session/prompt）→ 抛错', async () => {
    await expect(resendText({ sessions: { binding: () => undefined } } as never, 's1', 'x')).rejects.toThrow(/session unavailable/)
    await expect(resendText({ sessions: { binding: () => ({}) } } as never, 's1', 'x')).rejects.toThrow(/session unavailable/)
  })

  it('prompt 失败 → 抛错带 code/message', async () => {
    const prompt = vi.fn().mockResolvedValue({ ok: false, error: { code: 'ERR_X', message: 'denied' } })
    const ctx = { sessions: { binding: () => ({ session: { prompt } }) } }
    await expect(resendText(ctx as never, 's1', 'x')).rejects.toThrow(/resend failed: ERR_X: denied/)
  })
})
