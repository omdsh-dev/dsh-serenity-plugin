/**
 * diagram.ts — `diagram` 工具：**agent 直接给一段标签格式源码，自动出图**
 *
 * owner 2026-09-29 具名令（D104）：「做成一个 tool，**ACC 级别**的，配合一个开关（demo 功能嘛，
 * 默认关，开了才可用）；Agent 调用这个 tool **直接给代码**就行，然后 dsh 可以**自动渲染成图片**
 * （注意**不借助浏览器生成截图**）」。权威设计 = 插件仓 `docs/diagram-tool-feasibility.md`。
 *
 * 链路（全部进程内，**不起浏览器**）：标签源码 → `parseDsl` → `renderDsl`（SVG ＋ 四项体检）
 * → `rasterizeSvg`（resvg-wasm ＋ **内置字型**）→ PNG → **图片块进对话**。
 *
 * 🔴 **不落文件**（owner 2026-09-29 明确）：「这个 diagram 生成文件干啥，没有任何意义啊，
 * 直接生成给用户看就好了」⇒ 正常路径**一份文件都不写**（图走附件的 durable 引用直进对话记录，
 * 可回看、可被后续轮次引用、可转微信 —— 这才是"给人看"的落点）。
 * ⚠️ **唯一的例外**：图**贴不进对话**时（附件服务不在／部署不收 png／当前路由不声明图像输入／
 * 存字节失败），才把 PNG 落到 `<CCC>/_tmp/diagram/` 并**在回执里给出路径与原因** ——
 * 否则那一次就真的什么都没有了（"降级不吞回执"同一条纪律）。
 *
 * 🔴 **为什么 PNG 是必需的**：宿主的对话内图片通路**白名单只有光栅格式**
 * （`image/png|jpeg|webp|gif`，见 `dsh-attachment/types.d.ts`）⇒ **SVG 进不去**。
 *
 * 🔴 **开关**：由 `index.ts` 门控（**关时不注册** ⇒ 工具根本不进模型工具清单），同 skiff／acp 口径。
 *
 * ## 🔴 两条**宿主契约**（2026-09-29 现场取证；第 ① 条是本文件第一版写错的地方）
 *
 * ① **`output.render` 是「同步投影」，宿主不 await 它**：`@deepseek-ai/dsh-tools` 的
 *    `createSuccessResult()` 直接 `rendered = tool.output.render(args, value)`，紧接着
 *    `snapshotJsonValue(rendered)` —— 返回一个 Promise 会被判「**非 lossless JSON**」⇒
 *    **整条工具调用失败**（图片与文字回执**一起**丢掉）。
 * ② **图片块带的 `attachment` 必须是附件服务的 durable 引用**（`ImageAttachmentRef`），
 *    而存字节是 async ⇒ **只能分两段**：`execute` 里 `saveImage`（async，把引用拼进**纯 JSON** 的返回值），
 *    `render` 里**同步**装配 `{ type: 'image', attachment: … }`。
 *    这正是平台自家 `read_image` 的形态（本机 live 安装 `dsh-tool-fs` 取证），本文件照该形态实现。
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
  /** **降级时**才有的落盘路径（相对 CCC 根；正常路径恒为 `null` —— 见文件头"不落文件"） */
  fallbackRel: string | null
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

/** 时间戳：ISO → `YYYYMMDD-HHMMSS`（仅降级落盘的文件名用） */
function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
}

/**
 * 当前模型路由是否**明确声明**收图像输入（正判据 —— 与 `read_image` 同一道门）。
 *
 * 🔴 为什么这道门必须过（而不是"先附上试试"）：图片块进的是**工具结果内容**，
 * 若路由不收图，最坏情形是**整轮请求**被装配层拒掉 —— 比"没图"坏得多。
 * ⚠️ 与 `read_image` 唯一的差别：**这里不抛错**（改走"降级落盘 ＋ 如实说明"）。
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

/** 降级落盘（**只在"贴不进对话"时走**）：PNG 落 `<CCC>/_tmp/diagram/`，返回相对路径或 `null` */
function saveFallbackPng(exec: unknown, png: Uint8Array, base: string): string | null {
  const root = cccRootForExec(exec as never)
  if (root === null) return null
  try {
    const rel = join('_tmp', 'diagram')
    const dir = join(root, rel)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${base}.png`), png)
    return join(rel, `${base}.png`)
  } catch {
    return null
  }
}

/**
 * 把 PNG 落成**可进对话的图片块**所需的 durable 引用（async 段 —— 见文件头契约 ①）。
 *
 * 四条降级**都不抛错**（图的价值不允许"附不上图"把整条回执一起带走），且都**如实带回原因**；
 * 降级时顺手把 PNG 落盘一次（见文件头"唯一的例外"）：
 *  ① 附件服务不在（未挂载） ② 部署不收 `image/png` ③ 当前路由未声明图像输入 ④ `saveImage` 自身报错。
 */
async function resolveImage(
  ctx: Context,
  exec: unknown,
  png: Uint8Array,
  base: string,
): Promise<{ image: DiagramImage | null; imageSkip: string | null; fallbackRel: string | null }> {
  const skip = (reason: string) => ({ image: null, imageSkip: reason, fallbackRel: saveFallbackPng(exec, png, base) })
  const attachments = (ctx as unknown as { get?: (name: string) => unknown }).get?.('attachments') as AttachmentsLike | undefined
  if (attachments === undefined || typeof attachments.saveImage !== 'function') {
    return skip('附件服务未挂载（ctx.attachments 不在）')
  }
  if (!attachments.imageLimits.mediaTypes.includes('image/png')) {
    return skip('本部署不收 image/png')
  }
  try {
    if (!(await routeDeclaresImage(ctx, exec))) {
      return skip('当前模型路由未声明图像输入（同 read_image 的门）')
    }
  } catch (err) {
    return skip(`模型路由未能解析：${String((err as Error)?.message ?? err)}`)
  }
  try {
    const ref = await attachments.saveImage({ data: png, mediaType: 'image/png', name: `${base}.png` })
    return {
      image: {
        attachmentId: ref.attachmentId,
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        // 服务可能把 name 归一化／省略 ⇒ 省略时回落到**我们自己递进去的那个名字**（当时最准的事实）
        name: ref.name ?? `${base}.png`,
      },
      imageSkip: null,
      fallbackRel: null,
    }
  } catch (err) {
    return skip(`附件服务拒收：${String((err as Error)?.message ?? err)}`)
  }
}

export function createDiagramTool(ctx: Context) {
  return defineTool({
    name: 'diagram',
    description:
      'Draw a diagram and show it to the user IN THE CONVERSATION (in-process, no browser, no files written). '
      + 'Pass the source directly as tag format. Geometry: coordinates are canvas pixels with y growing DOWNWARD; '
      + 'the drawing window defaults to the canvas (0,0 to width,height) — only pass domain="x0,y0,x1,y1" if you '
      + 'want your own window. Tags: <rect id="A" box="x0,y0,x1,y1" label="..." fill="#hex|colorName"/> '
      + '(name= works as an alias of id), <arrow from="A.e" to="B.w"/> or <line>, endpoints use anchors '
      + 'n/s/e/w/ne/nw/se/sw/c and may be offset like A.n+3,0, or a raw "x,y" pair; <text x=".." y=".." align="left|center|right">text</text>, '
      + '<color name="x" value="#hex"/>, <legend x=".." y=".."/>, <title>/<subtitle>. '
      + 'Returns the image itself plus any authoring errors and four layout warnings (overlapping boxes / label '
      + 'overflow / dangling endpoints / a line crossing a label). Elements whose coordinates fall outside the '
      + 'drawing window are reported as errors and skipped; the rest still render. '
      + 'Example:\n'
      + '<diagram width="1000" height="600" title="三层">\n'
      + '  <rect id="a" box="100,60,400,140" label="接入层" fill="#dbe7f6"/>\n'
      + '  <rect id="b" box="100,200,400,280" label="服务层" fill="#dbe7f6"/>\n'
      + '  <arrow from="a.s" to="b.n"/>\n'
      + '</diagram>',
    parameters: {
      source: { type: 'string', required: true, description: 'Tag-format diagram source' },
      width: { type: 'integer', description: `Output pixel width (default ${DEFAULT_WIDTH}; vector, so scaling is lossless)` },
      name: { type: 'string', description: 'Optional short name (attachment label; also used if a degraded fallback file is written)' },
    },
    output: {
      schema: { type: 'json' },
      // 🔴 **同步**投影（契约 ①）：async 只在 execute 里做（契约 ②）。
      render: (_args: unknown, value: unknown): ContentBlock[] => {
        const v = value as DiagramOut
        const lines: string[] = [`图已生成（${v.marks} 个图元 ／ ${v.pxW}×${v.pxH} px ／ ${v.bytes} B PNG ／ 光栅化 ${v.ms} ms）`]
        if (v.imageSkip !== null) {
          lines.push(`⚠️ 未能把图贴进对话：${v.imageSkip}`)
          lines.push(v.fallbackRel === null
            ? '（本会话解析不到 CCC 根，连降级落盘也没做 ⇒ 这一次没有可看的东西）'
            : `已降级落盘：${v.fallbackRel}（可直接打开，或用 read_image 读它）`)
        }
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
      const src = typeof args.source === 'string' ? args.source : ''
      const name = typeof args.name === 'string' && args.name.trim() !== '' ? args.name.trim() : 'diagram'
      const width = typeof args.width === 'number' && Number.isFinite(args.width) && args.width > 0
        ? Math.round(args.width)
        : DEFAULT_WIDTH

      const parsed = parseDsl(src)
      const rendered = renderDsl(parsed.model)
      const { png, ms, width: pxW, height: pxH } = await rasterizeSvg(rendered.svg, width)

      // 正常路径**不写任何文件**（见文件头）；只有贴不进对话时才降级落盘
      const base = `${stamp()}-${name.replace(/[^\w\u4e00-\u9fa5-]/g, '_')}`
      const { image, imageSkip, fallbackRel } = await resolveImage(ctx, exec, png, base)

      const out: DiagramOut = {
        name: base,
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
        fallbackRel,
      }
      return out
    },
  })
}
