/**
 * diagram-toolview.test.ts — `diagram` 客户端工具视图（v1.51.2）
 *
 * 两段，各自守一类东西：
 *
 * ① **纯派生逻辑**（`src/client/diagram-result.ts`）——真值测试。
 *    本仓 client 单测跑在 node 环境（`vitest.config.ts` 的 `environment: 'node'`，无 DOM）
 *    ⇒ 不能渲染 React 行；能测、也该测的是"从结果里挑什么"这条规则。
 *
 * ② **注册形态守卫**（读源码，同 `client-popover-clip-guard.test.ts` 的形态）——
 *    🔴 其中一条是**硬约束**：**不得**声明子槽 `tool.call.images`。
 *    宿主的槽契约原话（`dsh-client-ui-tool/lib/types/client/contract/slots.d.ts`）：
 *    "A child slot is declared by exactly one entry: registering a second toolview that
 *    declares the same child **throws at load**"。宿主内建 `read_image` 已占了它 ⇒
 *    我们再声明一次 = **插件加载即抛**（整个 client half 起不来）。这条不是风格，是回归闸。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DIAGRAM_IMAGE_MEDIA_TYPES,
  diagramResultModel,
  renderableImage,
} from '../src/client/diagram-result.js'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-conversation/client'

const clientDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client')
const viewSource = readFileSync(join(clientDir, 'DiagramToolView.tsx'), 'utf-8')
const entrySource = readFileSync(join(clientDir, 'index.ts'), 'utf-8')
const modelSource = readFileSync(join(clientDir, 'diagram-result.ts'), 'utf-8')

/**
 * 剥掉注释后的**代码正文**。
 * 为什么必须剥：本仓注释**刻意**引用了被禁的槽名（解释"为什么不能声明它"）——
 * 直接在原文上找 `tool.call.images` 会把"说明禁区的文档"误判成"触犯禁区的代码"。
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** 一份形状合法的 durable 图片引用（字段 = `ImageAttachmentRef`；品牌只在类型层，运行期就是普通对象） */
function attachment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    attachmentId: 'sha256-deadbeef',
    mediaType: 'image/png',
    bytes: 4096,
    width: 1000,
    height: 600,
    ...overrides,
  }
}

/** 造一个已结算的工具结果（只填本模型读的字段） */
function settled(content: readonly unknown[], isError = false, error?: unknown): ToolResultNode {
  return {
    kind: 'tool-result',
    seq: 7,
    time: 1_700_000_000_000,
    callId: 'call-diagram-1',
    call: { name: 'diagram', argsRaw: '{"source":"<diagram/>"}' },
    callTime: 1_700_000_000_000,
    content,
    isError,
    ...(error === undefined ? {} : { error }),
    subCalls: [],
  } as unknown as ToolResultNode
}

/** `diagram` 正常路径的信封文字（`src/tools/diagram.ts` 的 `output.render` 逐字） */
const ENVELOPE = '图已生成（3 个图元 ／ 1000×600 px ／ 4096 B PNG ／ 光栅化 12 ms）\n[lint] 体检干净（0 告警）'

describe('diagram-result: 正常路径（信封文字 + 图块）', () => {
  const view = diagramResultModel(settled([{ type: 'text', text: ENVELOPE }, { type: 'image', attachment: attachment() }]))

  it('title = 信封首行；text = 全文（换行保留）', () => {
    expect(view.title).toBe('图已生成（3 个图元 ／ 1000×600 px ／ 4096 B PNG ／ 光栅化 12 ms）')
    expect(view.text).toBe(ENVELOPE)
  })

  it('image = 结果里**那个对象本身**（不重建 ⇒ 品牌 id 与后续 loader 调用都保持真身）', () => {
    const ref = attachment()
    const one = diagramResultModel(settled([{ type: 'image', attachment: ref }]))
    expect(one.image).toBe(ref)
  })

  it('isError=false', () => {
    expect(view.isError).toBe(false)
  })

  it('🔴 防 flatten 回归：text **不得**混进图块被 JSON 化的痕迹', () => {
    // 换代做法（把 content 整体 JSON.stringify）会让图片下面印出原始 attachment 对象
    expect(view.text).not.toContain('attachmentId')
    expect(view.text).not.toContain('mediaType')
    expect(view.text).toBe(ENVELOPE)
  })
})

describe('diagram-result: 降级与畸形输入（一律不抛）', () => {
  it('只有文字块（图没贴成）⇒ image=null，原因留在 text 里', () => {
    const text = '图已生成（…）\n⚠️ 未能把图贴进对话：附件服务未挂载（ctx.attachments 不在）'
    const view = diagramResultModel(settled([{ type: 'text', text }]))
    expect(view.image).toBeNull()
    expect(view.text).toContain('未能把图贴进对话')
  })

  it('text 块在前、图块在后（宿主顺序）——取得到；图块在前也取得到', () => {
    expect(diagramResultModel(settled([{ type: 'image', attachment: attachment() }, { type: 'text', text: 'x' }])).image).not.toBeNull()
  })

  it('多张图只取第一张（宿主按结果顺序只放一张；多出的一律忽略）', () => {
    const first = attachment({ attachmentId: 'a' })
    const second = attachment({ attachmentId: 'b' })
    const view = diagramResultModel(settled([{ type: 'image', attachment: first }, { type: 'image', attachment: second }]))
    expect(view.image).toBe(first)
  })

  it('空 content ⇒ 空视图（title/text 皆空串，image=null）', () => {
    expect(diagramResultModel(settled([]))).toEqual({ title: '', text: '', image: null, isError: false })
  })

  it('content 不是数组（坏快照）⇒ 空视图，不抛', () => {
    expect(diagramResultModel(settled('trimmed-by-window' as unknown as readonly unknown[])).image).toBeNull()
  })

  it('title 只切**首个**换行（多行信封不塌成一行）', () => {
    const view = diagramResultModel(settled([{ type: 'text', text: 'a\nb\nc' }]))
    expect(view.title).toBe('a')
    expect(view.text).toBe('a\nb\nc')
  })

  it('多个文字块按出现顺序以 \\n 相连', () => {
    const view = diagramResultModel(settled([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]))
    expect(view.text).toBe('a\nb')
  })

  it('未知块类型（reasoning / file / 扩展块）被忽略，不参与文字也不参与图', () => {
    const view = diagramResultModel(settled([
      { type: 'reasoning', text: '不应出现' },
      { type: 'file', attachment: { name: 'x' } },
      { type: 'text', text: 'a' },
    ]))
    expect(view.text).toBe('a')
    expect(view.image).toBeNull()
  })

  it('isError 透传（失败的结果照样把文字给出去——原因就在文字里）', () => {
    expect(diagramResultModel(settled([{ type: 'text', text: 'boom' }], true)).isError).toBe(true)
  })

  it('非对象 / null 块不抛', () => {
    expect(diagramResultModel(settled([null, 42, 'str'])).text).toBe('')
  })

  it('🔴 失败且无文字块（execute 抛了）⇒ 兜底 `name: code`，**不给空卡片**', () => {
    // 宿主 resultText 的文档原话："Empty content on a failed call falls back to the
    // structured error's `name: code` line" —— 本行照抄该兜底，不自造文案
    const view = diagramResultModel(settled([], true, { name: 'Error', code: 'RASTERIZE_FAILED' }))
    expect(view.isError).toBe(true)
    expect(view.text).toBe('Error: RASTERIZE_FAILED')
    expect(view.title).toBe('Error: RASTERIZE_FAILED')
  })

  it('成功后无文字块 ⇒ **不**兜底（不把空结果伪装成错误）', () => {
    expect(diagramResultModel(settled([], false, { name: 'Error', code: 'X' })).text).toBe('')
  })

  it('有文字块时错误信息不覆盖文字（文字是真相源）', () => {
    const view = diagramResultModel(settled([{ type: 'text', text: 'boom' }], true, { name: 'Error', code: 'X' }))
    expect(view.text).toBe('boom')
  })

  it('error 形状残缺（缺 code / 非对象）⇒ 不抛，退回空文字', () => {
    expect(diagramResultModel(settled([], true, { name: 'Error' })).text).toBe('')
    expect(diagramResultModel(settled([], true, 'boom')).text).toBe('')
  })
})

describe('diagram-result: 图块形状校验（声明不是运行期保证）', () => {
  it('合法引用原样通过', () => {
    const ref = attachment()
    expect(renderableImage(ref as never)).toBe(ref)
  })

  it('缺 attachmentId / 空串 / 非串 ⇒ null', () => {
    expect(renderableImage(attachment({ attachmentId: undefined }) as never)).toBeNull()
    expect(renderableImage(attachment({ attachmentId: '   ' }) as never)).toBeNull()
    expect(renderableImage(attachment({ attachmentId: 7 }) as never)).toBeNull()
  })

  it('非栅格媒体类型（如 SVG）⇒ null（本工具只产 PNG）', () => {
    expect(renderableImage(attachment({ mediaType: 'image/svg+xml' }) as never)).toBeNull()
    expect(DIAGRAM_IMAGE_MEDIA_TYPES).toEqual(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
  })

  it('尺寸/字节非正或非有限 ⇒ null', () => {
    expect(renderableImage(attachment({ bytes: 0 }) as never)).toBeNull()
    expect(renderableImage(attachment({ width: 0 }) as never)).toBeNull()
    expect(renderableImage(attachment({ height: -1 }) as never)).toBeNull()
    expect(renderableImage(attachment({ width: Number.NaN }) as never)).toBeNull()
  })

  it('校验不过时 image=null，但文字照给（图片坏了不该吞掉信封）', () => {
    const view = diagramResultModel(settled([
      { type: 'text', text: 'a' },
      { type: 'image', attachment: { attachmentId: 'x' } },
    ]))
    expect(view.image).toBeNull()
    expect(view.text).toBe('a')
  })

  it('第一张非法、第二张合法 ⇒ 取第二张（逐个试，不因一张坏就整条放弃）', () => {
    const good = attachment({ attachmentId: 'good' })
    const view = diagramResultModel(settled([
      { type: 'image', attachment: { attachmentId: '' } },
      { type: 'image', attachment: good },
    ]))
    expect(view.image).toBe(good)
  })
})

describe('diagram 工具视图：注册形态守卫（防"加载即抛"与静默丢图）', () => {
  it('🔴 不声明任何子槽 —— 尤其不得出现 `tool.call.images`（第二个声明者会让加载直接抛）', () => {
    for (const [name, source] of [['DiagramToolView.tsx', viewSource], ['index.ts', entrySource], ['diagram-result.ts', modelSource]] as const) {
      const body = code(source)
      expect(body, `${name} 不应引用被 read_image 独占的子槽`).not.toContain('tool.call.images')
      expect(body, `${name} 的注册不应带 children 子槽声明`).not.toMatch(/children\s*:/)
    }
    // 正控：证明 `code()` 只剥注释、没连正文一起剥掉（否则上面两条会永远假绿）
    // 钉的是**只在正文出现**的串：`PropsRuntime<'tool.call.toolview'>` 仅此一处；
    // 注释里那句"注册进 keyed 槽 `tool.call.toolview`"不带 `PropsRuntime<'` 前缀 ⇒ 不怕被注释蒙中
    expect(code(viewSource)).toContain("PropsRuntime<'tool.call.toolview'>")
    // 正控：证明 `children:` 判据本身能咬人
    expect(code('/* c */ const o = { children: {} }')).toMatch(/children\s*:/)
    // 正控：证明被禁槽名在**代码位置**确实会被抓到（注释位置则被剥掉）
    expect(code("const x = 'tool.call.images'")).toContain('tool.call.images')
    expect(code('/* tool.call.images */ const x = 1')).not.toContain('tool.call.images')
  })

  it('注册进 keyed 槽 tool.call.toolview，key = diagram（拼错则永不派发）', () => {
    expect(entrySource).toMatch(/slots\.inject\(\s*'tool\.call\.toolview'/)
    expect(entrySource).toMatch(/name:\s*'tool\.call\.toolview',\s*key:\s*'diagram'/)
    expect(viewSource).toMatch(/DIAGRAM_TOOL_NAME = 'diagram'/)
  })

  it('row 真的消费 owner 交来的 loadImage（自渲染图片的唯一合法通路）', () => {
    expect(viewSource).toMatch(/loadImage:\s*MessageImageLoader/)
    expect(viewSource).toMatch(/loadImage\.peek\?\.\(/)
    expect(viewSource).toMatch(/loadImage\(image\)/)
  })

  it('三阶段分流：非 result 走极简行，result 才取图（preparing 阶段没有已派发实参）', () => {
    expect(viewSource).toMatch(/if \(props\.phase !== 'result'\) return <DiagramRunningRow/)
    expect(viewSource).toMatch(/<DiagramResultRow block=\{props\.block\} loadImage=\{props\.loadImage\} \/>/)
  })

  it('加载失败落错误态（不抛上 React 树）', () => {
    expect(viewSource).toMatch(/sp-dgError/)
    expect(viewSource).toMatch(/setFailed\(true\)/)
  })

  it('🔴 槽类型只从**真包**来：本地 `declare module` 一份也不许留，真契约由一行空 import 接上', () => {
    // 旧版在 viewSource 里 `declare module '@deepseek-ai/dsh-client-ui-slots'` **抄**一份槽形状 ——
    // 那让"拿不到真契约"时照样编译通过（= F7 要防的假绿，且把 Host 契约漂移变成我们不知道）。
    // v1.51.2 接真包时一并删除 ⇒ 这条钉"不许写回来"（注释里的说明不算，故先剥注释）。
    expect(code(viewSource), 'DiagramToolView.tsx 不得再自带一份槽声明').not.toMatch(/declare module/)
    expect(code(modelSource), 'diagram-result.ts 不得再自带一份槽声明').not.toMatch(/declare module/)
    // 真契约的接法：一行**空类型 import** 把宿主包的模块增强拉进本程序。
    // 🔴 只加 devDependency ＋ `paths` 条目不够：`paths` 只是映射表，没有 import 时
    //    那个 `.d.ts` **根本不进 program** ⇒ 槽名被判"不在 SlotMap"（TS2344/TS2769 实测）。
    expect(code(entrySource)).toMatch(/import type \{\} from '@deepseek-ai\/dsh-client-ui-tool\/client'/)
    // slot 选项上不得出现 as any / as never 之类的逃逸
    expect(entrySource).not.toMatch(/as any/)
    expect(viewSource).not.toMatch(/as any/)
  })
})
