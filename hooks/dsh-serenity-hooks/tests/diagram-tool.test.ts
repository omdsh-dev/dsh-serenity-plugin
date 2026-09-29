/**
 * diagram **工具面**用例（2026-09-29，S142 D104）
 *
 * ## 本文件钉住的四条"静默失效家族"（每条都对应一个真实踩过的坑）
 *  ① 🔴 **`output.render` 必须是同步的**：宿主 `createSuccessResult()` **不 await** 它，直接
 *     `snapshotJsonValue(render(...))` ⇒ 返回 Promise 会被判「非 lossless JSON」，
 *     结果是**整条工具调用失败**（图片与文字回执一起丢）。第一版正是这么写的 ——
 *     所以这里有一条**形状断言**（返回数组、没有 then），它红就代表那条 bug 回来了。
 *  ② 图块靠 `attachment`（`ImageAttachmentRef`）—— 而工具里那个 `as unknown as ContentBlock`
 *     **让类型检查对字段名变瞎**（判据 ㉜）⇒ 字段名在这里**逐字钉住**。
 *  ③ **附不上图不得吞掉文字回执**（四条降级路径各有一条用例：服务不在 ／ 部署不收 ／
 *     路由不收图 ／ 存字节失败）。
 *  ④ 产物必须落在**调用会话的 CCC 根**内，解析不到根时**响亮报错**（不静默写去别处）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('@deepseek-ai/dsh-tools', () => ({ defineTool: (opts: unknown) => opts }))

import { createDiagramTool } from '../src/tools/diagram.js'

const SRC = [
  '<diagram width="400" height="300" domain="0,0,100,100">',
  '  <rect id="A" box="10,10,40,40" label="德国" fill="#3366cc"/>',
  '  <rect id="B" box="60,60,90,90" label="波兰" fill="#cc3366"/>',
  '  <arrow from="A.e" to="B.w"/>',
  '  <text x="50" y="95" align="center">中文标注</text>',
  '</diagram>',
].join('\n')

/** 工具返回值的形状（本文件只声明用到的字段；真正的形状由 `DiagramOut` 定义） */
interface DiagramValue {
  name: string
  svgRel: string
  pngRel: string
  lint: string[]
  errors: string[]
  marks: number
  ms: number
  bytes: number
  pxW: number
  pxH: number
  image: { attachmentId: string; mediaType: string; bytes: number; width: number; height: number; name?: string } | null
  imageSkip: string | null
}

interface ContentBlockLike {
  type: string
  text?: string
  attachment?: Record<string, unknown>
}

/** 假 ctx：只提供 `get()`（服务查找）——本工具在 ctx 上只用这一件事 */
function ctxWith(services: Record<string, unknown>) {
  return { get: (name: string) => services[name] }
}

/** 假附件服务：记下每次 saveImage 的入参，并回一个真形状的引用 */
function attachmentsStub(opts: { mediaTypes?: string[]; fail?: Error } = {}) {
  const calls: Array<{ data: Uint8Array; mediaType: string; name?: string }> = []
  return {
    calls,
    store: {
      imageLimits: { mediaTypes: opts.mediaTypes ?? ['image/png'] },
      saveImage: async (input: { data: Uint8Array; mediaType: string; name?: string }) => {
        if (opts.fail !== undefined) throw opts.fail
        calls.push(input)
        return {
          attachmentId: 'att-diagram-1',
          mediaType: 'image/png',
          bytes: input.data.length,
          width: input.data.length + 1, // 假尺寸：只为断言"搬运的是服务给出的值"
          height: 42,
          ...input.name === undefined ? {} : { name: input.name },
        }
      },
    },
  }
}

/** 假模型路由：`image=true` ⇒ 声明收图（同 read_image 的那道门） */
function llmStub(image: boolean) {
  return { resolveModelInfo: async () => ({ inputModalities: image ? ['text', 'image'] : ['text'] }) }
}

/** 假 exec：`header.cwd` 决定 CCC 根，`requestHeader()` 决定当前路由 */
function execFor(cwd: string | undefined) {
  return {
    agent: {
      session: {
        ...cwd === undefined ? {} : { header: { cwd } },
        requestHeader: () => ({ config: { provider: 'fake', model: 'fake-model' } }),
      },
      options: {},
    },
  }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'diagram-tool-'))
  writeFileSync(join(dir, '.serenity'), 'test') // CCC 标记（同 acc-diag.test.ts 的做法）
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('diagram 工具面：执行 → 返回值 → 渲染', () => {
  it('① 正常路径：返回值带图元数/尺寸/字节，两份产物落在本会话 CCC 的 _tmp/diagram/', async () => {
    const att = attachmentsStub()
    const tool = createDiagramTool(ctxWith({ attachments: att.store, llm: llmStub(true) }) as never)
    const value = await tool.execute({ source: SRC, name: '欧洲' }, execFor(dir)) as unknown as DiagramValue

    expect(value.errors).toEqual([])
    expect(value.marks).toBeGreaterThan(0)
    expect(value.pxW).toBe(1200) // 缺省宽
    expect(value.pngRel).toBe(join('_tmp', 'diagram', `${value.name}.png`))
    expect(value.svgRel).toBe(join('_tmp', 'diagram', `${value.name}.svg`))
    // 文件真的落盘了（不是"返回值里写着路径"就算数）
    const svgPath = join(dir, value.svgRel)
    const pngPath = join(dir, value.pngRel)
    expect(existsSync(svgPath)).toBe(true)
    expect(existsSync(pngPath)).toBe(true)
    expect(readFileSync(svgPath, 'utf-8')).toContain('中文标注') // 落的是这条链画出的那份
    expect(readFileSync(pngPath).length).toBe(value.bytes)
    // 图片引用来自附件服务（搬运而非自造）
    expect(value.imageSkip).toBeNull()
    expect(value.image).toMatchObject({ attachmentId: 'att-diagram-1', mediaType: 'image/png', height: 42 })
    expect(att.calls).toHaveLength(1)
    expect(att.calls[0]!.mediaType).toBe('image/png')
    expect(att.calls[0]!.data.length).toBe(value.bytes)
  })

  it('② 🔴 `output.render` 是**同步**投影（返回 Promise 会让宿主判「非 lossless JSON」⇒ 整条调用失败）', async () => {
    const tool = createDiagramTool(ctxWith({ attachments: attachmentsStub().store, llm: llmStub(true) }) as never)
    const value = await tool.execute({ source: SRC }, execFor(dir))
    const rendered = tool.output.render({}, value) as unknown as ContentBlockLike[]
    expect(Array.isArray(rendered)).toBe(true)
    expect((rendered as unknown as { then?: unknown }).then).toBeUndefined()
  })

  it('③ 图块的 `attachment` 字段**逐字**等于平台 `ImageAttachmentRef`（那个 cast 让类型检查变瞎）', async () => {
    const tool = createDiagramTool(ctxWith({ attachments: attachmentsStub().store, llm: llmStub(true) }) as never)
    const value = await tool.execute({ source: SRC }, execFor(dir))
    const blocks = tool.output.render({}, value) as unknown as ContentBlockLike[]
    expect(blocks[0]!.type).toBe('text')
    expect(blocks[0]!.text).toContain('图已生成')
    const img = blocks[1]!
    expect(img.type).toBe('image')
    expect(Object.keys(img.attachment ?? {}).sort()).toEqual(['attachmentId', 'bytes', 'height', 'mediaType', 'name', 'width'])
    expect(img.attachment).toEqual({
      attachmentId: 'att-diagram-1',
      mediaType: 'image/png',
      bytes: expect.any(Number),
      width: expect.any(Number),
      height: 42,
      name: expect.stringMatching(/\.png$/),
    })
  })

  it('④ 降级（附件服务不在）：不抛错、image=null、**文字回执照给**并说明原因', async () => {
    const tool = createDiagramTool(ctxWith({ llm: llmStub(true) }) as never)
    const value = await tool.execute({ source: SRC }, execFor(dir)) as unknown as DiagramValue
    expect(value.image).toBeNull()
    expect(value.imageSkip).toContain('附件服务未挂载')
    const blocks = tool.output.render({}, value) as unknown as ContentBlockLike[]
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.type).toBe('text')
    expect(blocks[0]!.text).toContain('未附图片块')
    expect(blocks[0]!.text).toContain(value.pngRel) // 路径仍给得到
  })

  it('⑤ 降级（本部署不收 image/png）：**连 saveImage 都不调用**（不白花一次写盘）', async () => {
    const att = attachmentsStub({ mediaTypes: ['image/jpeg'] })
    const tool = createDiagramTool(ctxWith({ attachments: att.store, llm: llmStub(true) }) as never)
    const value = await tool.execute({ source: SRC }, execFor(dir)) as unknown as DiagramValue
    expect(value.image).toBeNull()
    expect(value.imageSkip).toContain('不收 image/png')
    expect(att.calls).toHaveLength(0)
  })

  it('⑥ 降级（当前路由未声明图像输入）：跳过图片块并如实说明（同 read_image 的门）', async () => {
    const att = attachmentsStub()
    const tool = createDiagramTool(ctxWith({ attachments: att.store, llm: llmStub(false) }) as never)
    const value = await tool.execute({ source: SRC }, execFor(dir)) as unknown as DiagramValue
    expect(value.imageSkip).toContain('未声明图像输入')
    expect(att.calls).toHaveLength(0)
    // 图仍落盘：降级只影响"贴不贴进对话"，不影响产物
    expect(existsSync(join(dir, value.pngRel))).toBe(true)
  })

  it('⑦ 降级（saveImage 自身报错）：**吞不掉文字回执**，原因进 imageSkip', async () => {
    const att = attachmentsStub({ fail: new Error('IMAGE_TOO_LARGE') })
    const tool = createDiagramTool(ctxWith({ attachments: att.store, llm: llmStub(true) }) as never)
    const value = await tool.execute({ source: SRC }, execFor(dir)) as unknown as DiagramValue
    expect(value.image).toBeNull()
    expect(value.imageSkip).toContain('附件服务拒收')
    expect(value.imageSkip).toContain('IMAGE_TOO_LARGE')
    const blocks = tool.output.render({}, value) as unknown as ContentBlockLike[]
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.text).toContain(value.svgRel)
  })

  it('⑧ 解析不到 CCC 根 ⇒ 响亮报错（产物必须落在容器内，不静默写去别处）', async () => {
    const tool = createDiagramTool(ctxWith({}) as never)
    const bare = mkdtempSync(join(tmpdir(), 'diagram-noccc-')) // 无 .serenity 标记
    await expect(tool.execute({ source: SRC }, execFor(bare))).rejects.toThrow(/CCC 根/)
    rmSync(bare, { recursive: true, force: true })
  })

  it('⑨ 源码错误不拦图：错误逐条带出，其余图元照画（两类分档）', async () => {
    const tool = createDiagramTool(ctxWith({ attachments: attachmentsStub().store, llm: llmStub(true) }) as never)
    const bad = '<diagram width="400" height="300" domain="0,0,100,100">\n<rect box="oops" label="甲"/>\n<rect box="60,60,90,90" label="乙"/>\n</diagram>'
    const value = await tool.execute({ source: bad }, execFor(dir)) as unknown as DiagramValue
    expect(value.errors.length).toBeGreaterThan(0)
    expect(value.marks).toBeGreaterThan(0) // 好图元仍然画了
    const blocks = tool.output.render({}, value) as unknown as ContentBlockLike[]
    expect(blocks[0]!.text).toContain('[err]')
    expect(blocks[1]!.type).toBe('image') // 有错也有图
  })
})
