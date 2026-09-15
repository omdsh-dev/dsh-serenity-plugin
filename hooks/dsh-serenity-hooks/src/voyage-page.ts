/**
 * voyage-page.ts — `/serenity/voyage`：宁静号航行动画（**ACC 层静态资产**）
 *
 * 作用：把「宁静号航行动画」作为 **ACC 的一部分**随包分发，并用一条 HTTP 路由把它
 * 交给 WebUI。当前唯一消费者 = 会话头部状态胶囊展开卡片（`SafeModePanel` 的 `sp-pop`）
 * 的**背景层**——即所有者定的定位：「宁静号的心智模型」。
 *
 * 资产本体：`assets/serenity-voyage.html`（单文件自包含，three.js r180 内联）。
 * 同一份文件两种用法，靠 query 切换：
 *   - 无参数    → **全屏构图版**（标题/品牌语/航速/容器事实面板齐备），可独立打开
 *   - `?card=1` → **卡片模式**：隐藏自带 UI 层、镜头拉远、星野调暗、铭牌层关闭
 *
 * 为什么用「独立路由 + iframe」而不是内联进 client bundle：
 *   ① 作品自包含 830 KB（其中 704 KB 是 three.js）——内联会把整包灌进 client chunk；
 *   ② 作品自带全局 CSS/画布，内联会与卡片样式互相污染；
 *   ③ 独立路由 ⇒ **惰性加载**（只在卡片展开时请求一次）+ 可长缓存，关闭 iframe 即卸载，
 *      WebGL 上下文随之释放。
 *
 * 来历（R↓）：作品由 **tiangong-serenity**（另一个 Serenity CCC）赠予；**本仓库只携带
 * 构建产物**，源与构建脚本住在 CCC 侧 `AGENT_SESSIONS/…S142…/serenity-voyage-animation/`
 * （详见 `assets/README.md`）。内容已于 S142 重播为宁静号自己的技能/公理/MSM/本体词元
 * 与实测容器规模数字。
 */

import type { Context } from 'cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
// 类型引用：拉入 webserver 的 cordis 声明增强（ctx.webServer）；运行时擦除
import type {} from '@deepseek-ai/dsh-host-webserver'

export const VOYAGE_PATH = '/serenity/voyage'

/**
 * 资产相对包根的路径。
 * 🔒 它**必须**同时出现在 `package.json` 的 `files` 白名单里——否则发布包缺文件，
 * 路由会在运行时报「资产不可用」（同 v1.26.15 那次 `files` 漏 chunk 的事故形态）。
 * `dsh-develop pack-check` 的 `required` 已把它列为发布前硬断言。
 */
export const VOYAGE_ASSET = 'assets/serenity-voyage.html'

/** 包根 = 本模块所在目录的上一级（构建产物在 `lib/`，与 `assets/` 同级；同 constants.ts 定位法） */
function packageRootPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..')
}

/** 资产绝对路径（导出以便测试与 pack-check 共用同一判据来源） */
export function voyageAssetPath(): string {
  return join(packageRootPath(), VOYAGE_ASSET)
}

/** 缓存（830 KB，避免每次展开卡片都读盘；进程内只读一次） */
let cachedHtml: string | null = null

/** 读取资产全文。读不到即抛错（由 handler 转 500，绝不静默发空页）。 */
export function loadVoyageHtml(assetPath: string = voyageAssetPath()): string {
  if (assetPath === voyageAssetPath()) {
    if (cachedHtml === null) cachedHtml = readFileSync(assetPath, 'utf-8')
    return cachedHtml
  }
  return readFileSync(assetPath, 'utf-8')
}

/** 清缓存（测试用） */
export function resetVoyageCache(): void {
  cachedHtml = null
}

/** 发 JSON（错误分支用；与 api.ts 的 sendJson 同形，但本模块不依赖它，保持零耦合） */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

/**
 * 注册 `/serenity/voyage`（GET）。
 * @param opts.assetPath 覆盖资产路径（测试用；生产不传）
 */
export function registerVoyageApi(ctx: Context, opts: { assetPath?: string } = {}): void {
  ctx.webServer.register({
    kind: 'exact',
    path: VOYAGE_PATH,
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      let html: string
      try {
        html = loadVoyageHtml(opts.assetPath ?? voyageAssetPath())
      } catch (err: any) {
        sendJson(res, 500, { error: `voyage asset unavailable: ${err?.message ?? String(err)}` })
        return
      }
      res.statusCode = 200
      res.setHeader('content-type', 'text/html; charset=utf-8')
      // 资产随**包版本**变，而 URL 稳定 ⇒ 由 client 用 `?v=<accVersion>` 打版本号；
      // 同版本可长缓存（830 KB 只拉一次），升级即换 URL 自动失效。
      res.setHeader('cache-control', 'private, max-age=86400')
      res.setHeader('content-length', String(Buffer.byteLength(html)))
      res.end(html)
    },
  })
}
