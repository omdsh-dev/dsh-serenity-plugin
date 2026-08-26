/**
 * image-fallback-api.ts — 图片自动落盘兜底的浏览器操作面（S142）
 *
 * 三个操作，全部走官方 client 服务 + 同源 HTTP：
 *  - uploadImage(file)    → POST /serenity/image-upload（node half 写 _tmp/images_from_user/）
 *  - getDraftFiles(...)   → conversation.draftImages（取 rail 图片 File）
 *  - resendText(...)      → session.prompt（纯文本重发，绕过图片门禁）
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { DraftAttachmentId } from '@deepseek-ai/dsh-client-ui-conversation'

/** 图片落盘接口路径（node half api.ts，client 专属 x-serenity-ui 头） */
const UPLOAD_PATH = '/serenity/image-upload'
/** 识别结果消息模板（协议固有，S142 用户定稿：ACC 只提供路径，识别由 CCC vlm MSM 承担） */
export const IMAGE_NOTE_PREFIX = '用户提供了图片在 '

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
 * conversation.draftImages 是 root singleton 的公开方法（读 controller 的 draftAttachments Map，
 * 与调用 ctx 的作用域无关）——直接 ctx.get('conversation')，避开 scope 寻址不确定性。
 */
export async function getDraftFiles(
  ctx: ClientContext,
  _sessionId: string,
  ids: readonly string[],
): Promise<File[]> {
  const conversation = (ctx as { get?: (name: string) => unknown }).get?.('conversation') as
    | { draftImages?: (imageIds: readonly unknown[]) => readonly { file: File }[] | undefined }
    | undefined
  const draftImages = conversation?.draftImages
  if (draftImages === undefined) return []
  return (draftImages(ids) ?? []).map((a) => a.file)
}

/** 纯文本重发（绕过图片门禁——不含 image part，模型永不触发 MODEL_DOES_NOT_SUPPORT_IMAGES） */
export async function resendText(ctx: ClientContext, sessionId: string, text: string): Promise<void> {
  const binding = ctx.sessions.binding(sessionId as never) as { session?: { prompt?: (content: unknown[], mode: string) => Promise<{ ok: boolean; error?: { code?: string; message?: string } }> } } | undefined
  const prompt = binding?.session?.prompt
  if (prompt === undefined) throw new Error('serenity image fallback: session unavailable')
  const result = await prompt([{ type: 'text', text }], 'queue')
  if (!result.ok) throw new Error(`serenity image fallback resend failed: ${result.error?.code}: ${result.error?.message}`)
}
