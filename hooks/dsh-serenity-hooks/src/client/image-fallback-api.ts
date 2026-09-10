/**
 * image-fallback-api.ts — 图片自动落盘兜底的浏览器操作面（S142）
 *
 * 三个操作，全部走官方 client 服务 + 同源 HTTP：
 *  - uploadImage(file)    → POST /serenity/image-upload（node half 写 _tmp/images_from_user/）
 *  - getDraftFiles(...)   → conversation.draftImages（取 rail 图片 File）
 *  - resendText(...)      → session.prompt（纯文本重发，绕过图片门禁）
 */

// v1.28.0 适配 0.1.2-rc.1（A1）：dsh-client-runtime 包已删 → ClientContext 用官方同款
// `Context as ClientContext` from '@deepseek-ai/cordis'（:70/:83 的 ctx.get/sessions 运行时面签名未变）
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { DraftAttachmentId } from '@deepseek-ai/dsh-client-ui-conversation'

/** 图片落盘接口路径（node half api.ts，client 专属 x-serenity-ui 头） */
const UPLOAD_PATH = '/serenity/image-upload'

/**
 * 判断是否触发图片落盘补救（纯函数，可单测）。
 *
 * ⚠️ v1.30.5 错误码契约修复（2026-09-08 用户实测"图片能进 rail 但发送被拒、无落盘"）：
 * DSH 0.1.1-rc.2 → 0.1.2-rc.1 升级后，host session-controller 把图片被拒错误码从
 * `attachment-error` 改为 `session/attachment-invalid`（主会话）/ `subagent/attachment-invalid`
 * （子代理），reason 仍为 `MODEL_DOES_NOT_SUPPORT_IMAGES`（rc.1 commands.ts:321 实证）。
 * 旧实现只匹配 `attachment-error` → rc.1 下补救永不触发。兼容三码 + reason 双条件判定。
 *
 * @param code - promptError.error.code（host 投影）
 * @param reason - promptError.error.details.reason
 * @returns true = 应触发自动落盘补救
 */
export function isImageFallbackTrigger(code: string | undefined, reason: string | undefined): boolean {
  if (code !== 'attachment-error' && code !== 'session/attachment-invalid' && code !== 'subagent/attachment-invalid') return false
  return reason === 'MODEL_DOES_NOT_SUPPORT_IMAGES'
}

/**
 * 图片提示消息模板（协议固有，S142 用户迭代）：
 *  - v1.20.5 目录级提示（无文件名）→ 用户反馈 agent 还要猜
 *  - v1.20.6 恢复具体路径（对话里一定写名图片路径，agent 直接可用，无需猜）
 * 单图：用户提供了一张图片（路径：...）；多图：每张一行路径
 */
export function imageNoteTemplate(paths: string[]): string {
  if (paths.length === 1) return `The user provided an image (path: ${paths[0]})`
  return `The user provided ${paths.length} images:\n${paths.map((p) => `- ${p}`).join('\n')}`
}

/** 浏览器 File → base64（与 ui-conversation serializeImages 等价的最小实现） */
function fileToBase64(file: File): Promise<string> {
  return file.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer)
    let binary = ''
    const chunk = 0x8000
    for (let offset = 0; offset < bytes.length; offset += chunk) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
    }
    return btoa(binary)
  })
}

/**
 * 上传一张图片到 CCC _tmp/images_from_user/，返回相对路径（如 _tmp/images_from_user/xxx.png）。
 * sessionId 必传：node half 经会话 header.cwd 解析 CCC 根（进程 cwd 不可靠）。
 */
export async function uploadImage(file: File, sessionId: string): Promise<string> {
  const data = await fileToBase64(file)
  const res = await fetch(UPLOAD_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-serenity-ui': '1' },
    body: JSON.stringify({ sessionId, mediaType: file.type, name: file.name, data }),
  })
  const body = (await res.json()) as { path?: string; error?: string }
  if (!res.ok || typeof body.path !== 'string') {
    throw new Error(`serenity image upload failed: ${body.error ?? res.status}`)
  }
  return body.path
}

/**
 * 取 rail 图片的浏览器 File。
 *
 * v1.31.6 适配 0.1.5-rc.1：`IConversation.draftImages(ids)` **已改名**
 * `resolveDraftAttachments(ids)`（同语义同返回：ordered draft descriptors）。
 * 这是**静默突破**——调用点用结构化断言隔离宿主（零宿主 import 策略），
 * 类型检查看不见旧名消失，只会运行时 `=== undefined` → 静默返回 `[]`（兜底悄悄失效）。
 *
 * conversation 是 root singleton 的公开方法（读 controller 的 draftAttachments Map，
 * 与调用 ctx 的作用域无关）——直接 ctx.get('conversation')。
 * ⚠️ 必须作为方法调用（conversation.resolveDraftAttachments(ids)）：解构取出再调会丢失 this
 * （内部读 this 的 draft registry → "Cannot read properties of undefined"）。
 */
export async function getDraftFiles(
  ctx: ClientContext,
  _sessionId: string,
  ids: readonly string[],
): Promise<File[]> {
  const conversation = (ctx as { get?: (name: string) => unknown }).get?.('conversation') as
    | { resolveDraftAttachments?: (imageIds: readonly unknown[]) => readonly { file: File }[] | undefined }
    | undefined
  if (conversation?.resolveDraftAttachments === undefined) return []
  return (conversation.resolveDraftAttachments(ids) ?? []).map((a) => a.file)
}

/**
 * 纯文本重发（绕过图片门禁——不含 image part，模型永不触发 MODEL_DOES_NOT_SUPPORT_IMAGES）。
 * ⚠️ 必须作为方法调用（session.prompt(...)）：解构取出再调会丢失 this
 * （prompt 内部读 this.promptError → "Cannot set properties of undefined (setting 'promptError')"）。
 */
export async function resendText(ctx: ClientContext, sessionId: string, text: string): Promise<void> {
  const binding = ctx.sessions.binding(sessionId as never) as { session?: { prompt?: (content: unknown[], mode: string) => Promise<{ ok: boolean; error?: { code?: string; message?: string } }> } } | undefined
  const session = binding?.session
  if (session?.prompt === undefined) throw new Error('serenity image fallback: session unavailable')
  const result = await session.prompt([{ type: 'text', text }], 'queue')
  if (!result.ok) throw new Error(`serenity image fallback resend failed: ${result.error?.code}: ${result.error?.message}`)
}
