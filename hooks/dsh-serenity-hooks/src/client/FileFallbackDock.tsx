/**
 * FileFallbackDock.tsx — 任意文件粘贴自动落盘（v1.24.1，静默版）
 *
 * 挂在 conversation.input.dock（不渲染任何 UI）：
 * document 级 capture 阶段监听 paste（先于 DSH textarea onPaste）——
 * 剪贴板含**非图片文件**时：
 *  ① 纯文件粘贴（无图片无文本）→ preventDefault（阻止 DSH intakeImages 的
 *     toast 拒绝）；混合粘贴（含图片/文本）→ 不拦截，DSH 正常处理
 *  ② 逐个文件 → /serenity/file-upload → _tmp/files_from_user/<ts>-<rand>-<name>
 *  ③ 上传成功 → 输入框 draft 末尾追加 fileNoteTemplate（具体路径，随发送进消息，
 *     agent 直接可用——用户拍板：不自动发送，用户写完一起发）
 * 失败仅 console.warn（不打断用户）。
 *
 * 可执行扩展名（exe/dll/msi/...）在 node half 拒绝（安全边界，agent 不被诱导执行）。
 */

import type {} from '@deepseek-ai/dsh-client-ui-conversation'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useRef } from 'react'
import { collectNonImageFiles, fileNoteTemplate } from './file-fallback-api.js'

/** inject 面：apply 闭包提供的文件上传回调 */
export interface FileFallbackInjected {
  uploadFile: (file: File, sessionId: string) => Promise<string>
}

export type FileFallbackDockProps = PropsRuntime<'conversation.input.dock'> & FileFallbackInjected

/** 输入快照（InputZone.input）读取面 */
interface InputLike {
  draft?: string
}

/** session-scope 标准 provide channel 的 inputActions（ui-conversation sessions.provide：setDraft/submit） */
interface InputActionsLike {
  setDraft: (text: string) => void
}

/** input.dock 条目（静默）：非图片文件粘贴自动落盘 + draft 追加，无 UI */
export function FileFallbackDock(props: FileFallbackDockProps): null {
  const zone = props as unknown as { input?: InputLike }
  const sessionId = props.sessionId
  const { uploadFile } = props
  const inputActions = (props as unknown as { inputActions?: InputActionsLike }).inputActions

  // draft 快照 ref：异步上传期间用户可能继续打字——每次渲染同步最新 draft，
  // 上传完成后以最新值追加（避免闭包过期覆盖）
  const inputRef = useRef<InputLike | undefined>(zone.input)
  inputRef.current = zone.input
  // 连续粘贴的串行追加队列（两次 paste 的上传并发时，第二次基于第一次 setDraft 后的 draft）
  const pendingRef = useRef<string[]>([])

  useEffect(() => {
    const handler = (e: ClipboardEvent): void => {
      const data = e.clipboardData
      if (!data) return
      const items = Array.from(data.items)
      const files = collectNonImageFiles(items)
      if (files.length === 0) return

      // 混合粘贴（含图片/文本）→ 不 preventDefault（DSH 正常处理图片 rail / 文本插入）；
      // 纯非图片文件粘贴 → preventDefault（阻止 DSH intakeImages 的 toast 拒绝）
      const hasImage = items.some((item) => item.kind === 'file' && typeof item.type === 'string' && item.type.startsWith('image/'))
      const hasText = data.getData('text/plain') !== ''
      if (!hasImage && !hasText) e.preventDefault()

      void (async () => {
        try {
          const saved: string[] = []
          for (const file of files) {
            saved.push(await uploadFile(file, String(sessionId)))
          }
          const note = fileNoteTemplate(saved)
          const base = inputRef.current?.draft ?? ''
          pendingRef.current.push(note)
          const text = [base, ...pendingRef.current].filter(Boolean).join('\n')
          pendingRef.current = []
          // 不自动发送（用户拍板）：draft 追加提示行，用户写完消息一起发
          if (inputActions?.setDraft !== undefined) {
            inputActions.setDraft(text)
          } else {
            console.warn('[serenity] file fallback: inputActions.setDraft unavailable — file saved but draft not annotated')
          }
        } catch (err) {
          console.warn(`[serenity] file fallback failed: ${String((err as Error)?.message ?? err)}`)
        }
      })()
    }
    document.addEventListener('paste', handler, true)
    return () => document.removeEventListener('paste', handler, true)
  }, [sessionId, uploadFile, inputActions])

  return null
}
