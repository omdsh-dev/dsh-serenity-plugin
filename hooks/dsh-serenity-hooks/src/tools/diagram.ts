/**
 * diagram.ts — `diagram` 工具：**agent 直接给一段标签格式源码，自动出图**
 *
 * owner 2026-09-29 具名令（D104）：「做成一个 tool，**ACC 级别**的，配合一个开关（demo 功能嘛，
 * 默认关，开了才可用）；Agent 调用这个 tool **直接给代码**就行，然后 dsh 可以**自动渲染成图片**
 * （注意**不借助浏览器生成截图**）」。权威设计 = 插件仓 `docs/diagram-tool-feasibility.md`。
 *
 * 链路（全部进程内，**不起浏览器**）：标签源码 → `parseDsl` → `renderDsl`（SVG ＋ 四项体检）
 * → `rasterizeSvg`（resvg-wasm ＋ **内置字体**）→ PNG → 落 CCC `_tmp/diagram/` ＋ 图片块进对话。
 *
 * 🔴 **为什么 PNG 是必需的**：宿主的对话内图片通路**白名单只有光栅格式**
 * （`image/png|jpeg|webp|gif`，见 `dsh-attachment/types.d.ts`）⇒ **SVG 进不去**，
 * "产出 SVG 就自动显示"确定不成立。右侧栏走 SVG 是二期方案。
 *
 * 🔴 **开关**：由 `index.ts` 在 registration 处门控（**关时不注册** ⇒ 工具根本不进模型工具清单，
 * 不占 token、不会被误调）—— 同 `skiff`／`acp` 的"未开启零资源占用"口径。
 *
 * ## 🔴 两条**宿主契约**（2026-09-29 现场取证；第 ① 条是本文件第一版写错的地方）
 *
 * ① **`output.render` 是「同步投影」，宿主不 await 它**：`@deepseek-ai/dsh-tools` 的
 *    `createSuccessResult()` 直接 `rendered = tool.output.render(args, value)`，紧接着
 *    `snapshotJsonValue(rendered)` —— 返回一个 Promise 会被判「**非 lossless JSON**」⇒
 *    **整条工具调用失败**（图片与文字回执**一起**丢掉）。⚠️ 第一版把 async 实现 cast 成同步，
 *    于是"拿不到图片块仍返回文字回执"那段自兜底**根本走不到**（它以为的失败模式不是真失败模式）。
 * ② **图片块带的 `attachment` 必须是附件服务的 durable 引用**（`ImageAttachmentRef`），
 *    而存字节是 async ⇒ **只能分两段**：`execute` 里 `saveImage`（async，把引用拼进**纯 JSON** 的返回值），
 *    `render` 里**同步**装配 `{ type: 'image', attachment: … }`。
 *    这正是平台自家 `read_image` 的形态（本机 live 安装 `dsh-tool-fs` 取证：`imageRefFromValue` ＋
 *    `render: (_args, value) => imageReadContent(value)`），本文件照该形态实现。
 *
 * ⚠️ 因此 render 里那个 `as unknown as ContentBlock` 是**必要的**（本包不引 `@deepseek-ai/dsh-attachment`，
 * 它不是 peerDep ⇒ 拿不到 `AttachmentId` 的 brand），而它**同时让类型检查对字段名变瞎**（判据 ㉜）⇒
 * 字段名由 `tests/diagram-tool.test.ts` 逐字钉住。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Context } from 'cordis'
import { cccRootForExec } from '../ccc-roots.js'
import { parseDsl } from '../diagram/dsl.js'
import { renderDsl } from '../diagram/dsl-render.js'
import { rasterizeSvg } from '../diagram/rasterize.js'

/** 输出宽度缺省（矢量无损放大；高度按图自身比例推出） */
const DEFAULT_WIDTH = 1200

/**
 * 图片元信息 —— **纯 JSON**（要过宿主的 lossless-JSON 快照 ＋ `output.schema` 校验）。
 * 字段集**逐字对应** `ImageAttachmentRef`（本包不引 `dsh-attachment` ⇒ 结构性声明）。
 *
 * ⚠️ 必须是 **type 别名**（不是 interface）：interface 没有隐式索引签名，
 * `DiagramOut` 就**不满足宿主的 `JsonValue`**（`defineTool` 的 `execute` 返回值要求）——
 * 2026-09-29 实测：用 interface 直接 `TS2322`。且**所有字段都得是 JSON 标量**
 * （`name?: string` 那种可选会带出 `undefined` ⇒ 同样不满足 `JsonValue`）⇒ `name` 定死为 `string`。
 */
type DiagramImage = {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  name: string
}

interface DiagramOut {
  /** 索引签名：宿主工具返回值必须是 JsonValue（普通接口不满足） */
  [key: string]: string | number | string[] | DiagramImage | null
  name: string
  svgRel: string
  pngRel: string
  lint: string[]
  errors: string[]
  marks: number
  ms: number
  bytes: number
  /** 实际输出像素尺寸（回执里如实报——`fitTo width` 的结果） */
  pxW: number
  pxH: number
  /** 图块引用（`null` = 没能落成 durable attachment ⇒ 只给文字与路径） */
  image: DiagramImage | null
  /** 未附图的原因（`null` = 图块已附）——**如实说**，不静默 */
  imageSkip: string | null
}

/** 附件服务的**结构性**视图（只有本工具用到的两件：限额 ＋ saveImage） */
interface AttachmentsLike {
  imageLimits: { mediaTypes: readonly string[] }
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<Omit<DiagramImage, 'name'> & { name?: string }>
}

/** 模型路由解析服务（判"当前路由收不收图"——同 `read_image` 的门） */
interface LlmLike {
  resolveModelInfo(provider: string, model: string, signal?: unknown): Promise<{ inputModalities?: readonly string[] }>
}

/** 调用方 agent 的最小形状（`exec.agent`；同 `read_image` 的取法） */
interface CallerAgent {
  session?: { requestHeader?: () => { config?: { provider?: string; model?: string } } | undefined }
  options?: { provider?: string; model?: string }
}

/** 时间戳：ISO → `YYYYMMDD-HHMMSS`（本地时区不参与，仅用于文件名排序） */
function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
}

/**
 * 当前模型路由是否**明确声明**收图像输入（正判据 —— 与 `read_image` 同一道门）。
 *
 * 🔴 为什么这道门必须过（而不是"先附上试试"）：图片块进的是**工具结果内容**，
 * 若路由不收图，最坏情形是**整轮请求**被装配层拒掉 —— 比"没图"坏得多。
 * ⚠️ 与 `read_image` 唯一的差别：**这里不抛错**（图已落盘，改用文字给路径）。
 */
async function routeDeclaresImage(ctx: Context, exec: unknown): Promise<boolean> {
  const agent = (exec as { agent?: CallerAgent }).agent
  const routed = agent?.session?.requestHeader?.()?.config
  const provider = routed?.provider ?? agent?.options?.provider
  const model = routed?.model ?? agent?.options?.model
  const llm = (ctx as unknown as { get?: (name: string) => unknown }).get?.('llm') as LlmLike | undefined
  if (provider === undefined || model === undefined || llm?.resolveModelInfo === undefined) return false
  const signal = (exec as { signal?: unknown }).signal
  const info = await llm.resolveModelInfo(provider, model, signal)
  const modes = info?.inputModalities
  return Array.isArray(modes) && modes.includes('image')
}

/**
 * 落成**可进对话的图片块**所需的 durable 引用（async 段 —— 见文件头契约 ①）。
 *
 * 三条降级**都不抛错、只把原因带回**（图已落盘，文字回执里给路径：
 * 工具的价值不允许"附不上图"把整条回执一起带走）：
 *  ① 附件服务不在（未挂载） ② 部署不收 `image/png` ③ 当前路由未声明图像输入 ④ `saveImage` 自身报错。
 */
async function attachPng(
  ctx: Context,
  exec: unknown,
  png: Uint8Array,
  name: string,
): Promise<{ image: DiagramImage | null; imageSkip: string | null }> {
  const attachments = (ctx as unknown as { get?: (name: string) => unknown }).get?.('attachments') as AttachmentsLike | undefined
  if (attachments === undefined || typeof attachments.saveImage !== 'function') {
    return { image: null, imageSkip: '附件服务未挂载（ctx.attachments 不在）' }
  }
  if (!attachments.imageLimits.mediaTypes.includes('image/png')) {
    return { image: null, imageSkip: '本部署不收 image/png' }
  }
  try {
    if (!(await routeDeclaresImage(ctx, exec))) {
      return { image: null, imageSkip: '当前模型路由未声明图像输入（同 read_image 的门）' }
    }
  } catch (err) {
    return { image: null, imageSkip: `模型路由未能解析：${String((err as Error)?.message ?? err)}` }
  }
  try {
    const ref = await attachments.saveImage({ data: png, mediaType: 'image/png', name: `${name}.png` })
    return {
      image: {
        attachmentId: ref.attachmentId,
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        // 服务可能把 name 归一化／省略 ⇒ 省略时回落到**我们自己递进去的那个名字**（这是当时最准的事实）
        name: ref.name ?? `${name}.png`,
      },
      imageSkip: null,
    }
  } catch (err) {
    return { image: null, imageSkip: `附件服务拒收：${String((err as Error)?.message ?? err)}` }
  }
}

export function createDiagramTool(ctx: Context) {
  return defineTool({
    name: 'diagram',
    description:
      'Render a diagram from tag-format source into an image (in-process, no browser). '
      + 'Pass the source directly: a <diagram> root with <rect box="x0,y0,x1,y1" label fill/>, '
      + '<line>/<arrow from to> (endpoints may reference anchors like 德国.e or 波兰.n+3,0), '
      + '<text x y align>, <color name value/>, <legend>. '
      + 'Returns the image in the conversation plus any authoring errors and four layout warnings '
      + '(overlapping boxes / label overflow / dangling endpoints / a line crossing a label). '
      + 'A warning never blocks the image; an errored element is skipped and the rest still renders. '
      + 'Both the SVG and the PNG are written under _tmp/diagram/ in this container.',
    parameters: {
      source: { type: 'string', required: true, description: 'Tag-format diagram source' },
      width: { type: 'integer', description: `Output pixel width (default ${DEFAULT_WIDTH}; vector, so scaling is lossless)` },
      name: { type: 'string', description: 'Optional short name used in the output file name' },
    },
    output: {
      schema: { type: 'json' },
      // 🔴 **同步**投影（契约 ①）：async 只在 execute 里做（契约 ②）。
      render: (_args: unknown, value: unknown): ContentBlock[] => {
        const v = value as DiagramOut
        const lines: string[] = [`图已生成（${v.marks} 个图元 ／ ${v.pxW}×${v.pxH} px ／ ${v.bytes} B PNG ／ 光栅化 ${v.ms} ms）`]
        lines.push(`SVG: ${v.svgRel}`)
        lines.push(`PNG: ${v.pngRel}`)
        if (v.imageSkip !== null) lines.push(`⚠️ 未附图片块：${v.imageSkip}（PNG 已落盘，路径见上）`)
        if (v.errors.length > 0) {
          lines.push(`✗ 源码错误 ${v.errors.length} 条（图已尽力渲染；下列图元已跳过）`)
          for (const e of v.errors) lines.push(`  [err] ${e}`)
        }
        if (v.lint.length === 0) lines.push('[lint] 体检干净（0 告警）')
        else for (const w of v.lint) lines.push(`  [lint] ${w}`)
        const blocks: ContentBlock[] = [{ type: 'text', text: lines.join('\n') }]
        if (v.image !== null) {
          // 字段集 = `ImageAttachmentRef`（见文件头说明：这里的 cast 是必要的，名字由测试钉住）
          blocks.push({ type: 'image', attachment: { ...v.image } } as unknown as ContentBlock)
        }
        return blocks
      },
    },
    async execute(args, exec) {
      const root = cccRootForExec(exec)
      // 图只能落在 CCC 内（ACC 的路径围墙）⇒ 解析不到根时**响亮报错**，不静默写去别处
      if (root === null) {
        throw new Error('diagram: 找不到 CCC 根（本会话缺 header.cwd）—— 产物必须落在容器内')
      }
      const src = typeof args.source === 'string' ? args.source : ''
      const name = typeof args.name === 'string' && args.name.trim() !== '' ? args.name.trim() : 'diagram'
      const width = typeof args.width === 'number' && Number.isFinite(args.width) && args.width > 0
        ? Math.round(args.width)
        : DEFAULT_WIDTH

      const parsed = parseDsl(src)
      const rendered = renderDsl(parsed.model)
      const { png, ms, width: pxW, height: pxH } = await rasterizeSvg(rendered.svg, width)

      const rel = join('_tmp', 'diagram')
      const dir = join(root, rel)
      mkdirSync(dir, { recursive: true })
      const base = `${stamp()}-${name.replace(/[^\w\u4e00-\u9fa5-]/g, '_')}`
      writeFileSync(join(dir, `${base}.svg`), rendered.svg)
      writeFileSync(join(dir, `${base}.png`), png)

      // 图片块所需的 durable 引用（async）——render 只搬运它的结果（契约 ①②）
      const { image, imageSkip } = await attachPng(ctx, exec, png, base)

      const out: DiagramOut = {
        name: base,
        svgRel: join(rel, `${base}.svg`),
        pngRel: join(rel, `${base}.png`),
        lint: rendered.lint,
        // 🔴 两类**分档**：errors = 这一条没画成 ｜ lint = 画了但不好看（同 bench 的口径）
        errors: [...parsed.errors, ...rendered.errors],
        marks: rendered.marks,
        ms,
        bytes: png.length,
        pxW,
        pxH,
        image,
        imageSkip,
      }
      return out
    },
  })
}
