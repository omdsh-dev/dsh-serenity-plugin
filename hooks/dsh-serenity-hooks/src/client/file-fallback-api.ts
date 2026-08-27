/**
 * file-fallback-api.ts — 任意文件粘贴自动落盘的浏览器操作面（v1.24.1）
 *
 * 图片链路（v1.20）是「发送失败补救」被动式；任意文件 DSH 原生发不了
 * （InputBar.onPaste 把所有文件交给 intakeImages → 非图片被 addImages 拒绝），
 * 因此本模块提供**主动拦截**面：
 *  - collectNonImageFiles(data) → 剪贴板中非图片 File（纯函数，可单测）
 *  - uploadFile(file, sessionId) → POST /serenity/file-upload（node half 写 _tmp/files_from_user/）
 *  - fileNoteTemplate(paths)     → 消息模板（draft 追加，随发送进消息——用户拍板）
 */

/** 文件落盘接口路径（node half api.ts，client 专属 x-serenity-ui 头） */
const FILE_UPLOAD_PATH = '/serenity/file-upload'

/**
 * 从剪贴板收集非图片文件（图片交给 DSH 原生 rail 链路；仅非图片需要落盘）。
 * 纯函数（items 可注入）——jsdom 环境下 DataTransfer 不可用，测试注入 items 数组。
 */
export function collectNonImageFiles(items: readonly { kind?: string; type?: string; getAsFile?: () => File | null }[]): File[] {
  const out: File[] = []
  for (const item of items) {
    if (item?.kind !== 'file') continue
    if (typeof item.type === 'string' && item.type.startsWith('image/')) continue // 图片留给 DSH
    const file = typeof item.getAsFile === 'function' ? item.getAsFile() : null
    if (file !== null) out.push(file)
  }
  return out
}

/**
 * 文件提示消息模板（协议固有，用户拍板：draft 追加 + 对话里写名具体路径，agent 直接可用）：
 * 单文件：The user provided a file (path: ...)；多文件：每行一条路径
 */
export function fileNoteTemplate(paths: string[]): string {
  if (paths.length === 1) return `The user provided a file (path: ${paths[0]})`
  return `The user provided ${paths.length} files:\n${paths.map((p) => `- ${p}`).join('\n')}`
}

/** 浏览器 File → base64（与 image-fallback-api fileToBase64 等价的最小实现，保持模块独立） */
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
 * 上传一个文件到 CCC _tmp/files_from_user/，返回相对路径（如 _tmp/files_from_user/<ts>-<rand>-x.pdf）。
 * sessionId 必传：node half 经会话 header.cwd 解析 CCC 根（进程 cwd 不可靠）。
 */
export async function uploadFile(file: File, sessionId: string): Promise<string> {
  const data = await fileToBase64(file)
  const res = await fetch(FILE_UPLOAD_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-serenity-ui': '1' },
    body: JSON.stringify({ sessionId, name: file.name, data }),
  })
  const body = (await res.json()) as { path?: string; error?: string }
  if (!res.ok || typeof body.path !== 'string') {
    throw new Error(`serenity file upload failed: ${body.error ?? res.status}`)
  }
  return body.path
}
