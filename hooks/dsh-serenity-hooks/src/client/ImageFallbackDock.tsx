/**
 * ImageFallbackDock.tsx — 图片自动落盘兜底（S142）
 *
 * 挂在 conversation.input.dock：当前模型不支持图片时，发送失败
 * （attachment-error / MODEL_DOES_NOT_SUPPORT_IMAGES）自动补救：
 *   ① rail 图片 File → /serenity/image-upload → _tmp/images_from_user/<ts>.<ext>
 *   ② 以「用户提供了图片在 {path}」+ 用户原 draft 纯文本重发（绕过图片门禁）
 *   ③ 状态条展示已保存路径
 * agent 收到路径消息后经本 CCC 自己的 vlm MSM 自主识别（ACC 不约束 CCC 实现）。
 *
 * 样式：--dsw-alias-* 语义 token（明暗自适应）。
 */

import type {} from '@deepseek-ai/dsh-client-ui-conversation'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useRef, useState } from 'react'
import { IMAGE_NOTE_TEMPLATE_SINGLE, IMAGE_NOTE_TEMPLATE_MULTI } from './image-fallback-api.js'
import './ImageFallbackDock.css'

/** inject 面：apply 闭包提供的图片操作回调 */
export interface ImageFallbackInjected {
  uploadImage: (file: File, sessionId: string) => Promise<string>
  getDraftFiles: (sessionId: string, ids: readonly string[]) => Promise<File[]>
  resendText: (sessionId: string, text: string) => Promise<void>
}

export type ImageFallbackDockProps = PropsRuntime<'conversation.input.dock'> & ImageFallbackInjected

type FallbackState = 'idle' | 'uploading' | 'done' | 'error'

/** 输入区快照中携带的提示错误（host 准入拒绝：MODEL_DOES_NOT_SUPPORT_IMAGES） */
interface PromptErrorLike {
  code?: string
  details?: { reason?: string }
}

/** 会话快照（InputZone.session）的 promptError 读取面 */
interface SessionLike {
  promptError?: { error?: PromptErrorLike } | null
}

/** 输入快照（InputZone.input）读取面 */
interface InputLike {
  draft?: string
  imageIds?: readonly string[]
}

/** session-scope 标准 provide channel 的 inputActions（ui-conversation sessions.provide：setDraft/removeImage/submit） */
interface InputActionsLike {
  removeImage: (id: string) => void
  setDraft: (text: string) => void
  submit: () => void
}

/** input.dock 条目：图片发送失败自动落盘 + 文本重发（补救后自动清空输入框 rail 图片） */
export function ImageFallbackDock(props: ImageFallbackDockProps): React.JSX.Element {
  const zone = props as unknown as { session: SessionLike; input?: InputLike }
  const session = zone.session
  const input = zone.input
  const sessionId = props.sessionId
  const { uploadImage, getDraftFiles, resendText } = props
  // provide channel：session-scope 组件经 props 拿 inputActions（清 rail/setDraft/submit）
  const inputActions = (props as unknown as { inputActions?: InputActionsLike }).inputActions

  const [state, setState] = useState<FallbackState>('idle')
  const [paths, setPaths] = useState<string[]>([])
  const [errorText, setErrorText] = useState<string | null>(null)
  const handlingRef = useRef(false)

  const promptError = session?.promptError?.error
  const imageIds = input?.imageIds ?? []

  useEffect(() => {
    if (promptError?.code !== 'attachment-error') return
    if (promptError.details?.reason !== 'MODEL_DOES_NOT_SUPPORT_IMAGES') return
    if (handlingRef.current || imageIds.length === 0) return
    handlingRef.current = true
    setState('uploading')
    void (async () => {
      try {
        const files = await getDraftFiles(String(sessionId), imageIds)
        if (files.length === 0) throw new Error('no draft image files')
        const saved: string[] = []
        for (const file of files) {
          saved.push(await uploadImage(file, String(sessionId)))
        }
        // 友好提示（v1.20.5：不展示具体文件路径——用户反馈突兀；agent 自行查目录找图片）
        const note = saved.length === 1 ? IMAGE_NOTE_TEMPLATE_SINGLE : IMAGE_NOTE_TEMPLATE_MULTI(saved.length)
        const draft = input?.draft ?? ''
        const text = draft === '' ? note : `${draft}\n${note}`
        if (inputActions?.removeImage !== undefined && inputActions.setDraft !== undefined && inputActions.submit !== undefined) {
          // 官方输入机器路径：清 rail 图片 → draft 更新为原文+路径 → 机器发送（draft 自动清空，无残留）
          for (const id of imageIds) inputActions.removeImage(String(id))
          inputActions.setDraft(text)
          inputActions.submit()
        } else {
          // fallback：直接 RPC 重发（rail 残留由用户手动移除）
          await resendText(String(sessionId), text)
        }
        setPaths(saved)
        setState('done')
      } catch (err) {
        const message = String((err as Error)?.message ?? err)
        console.warn(`[serenity] image fallback failed: ${message}`)
        setErrorText(message)
        setState('error')
      } finally {
        handlingRef.current = false
      }
    })()
  }, [promptError, imageIds, sessionId, uploadImage, getDraftFiles, resendText, input?.draft, inputActions])

  if (state === 'idle') return <span className="serenity-image-fallback" data-state="idle" />
  if (state === 'uploading') {
    return <span className="serenity-image-fallback" data-state="busy">图片已保存中…</span>
  }
  if (state === 'done') {
    return (
      <span className="serenity-image-fallback" data-state="done">
        {paths.map((p) => <code key={p}>{p}</code>)}
      </span>
    )
  }
  return (
    <span className="serenity-image-fallback" data-state="error">
      图片保存失败：{errorText ?? '未知错误'}
    </span>
  )
}
