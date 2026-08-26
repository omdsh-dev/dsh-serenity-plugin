/**
 * ImageFallbackDock.tsx — 图片自动落盘兜底（S142，静默版 v1.20.6）
 *
 * 挂在 conversation.input.dock（不渲染任何 UI——用户反馈状态条永久停留碍眼）：
 * 当前模型不支持图片时，发送失败（attachment-error / MODEL_DOES_NOT_SUPPORT_IMAGES）
 * 自动补救（无感）：
 *   ① rail 图片 File → /serenity/image-upload → _tmp/images_from_user/<ts>.<ext>
 *   ② 清空输入框 rail 图片 + 以「用户提供了一张图片（已保存到 _tmp/images_from_user/）」+
 *      用户原 draft 纯文本重发（对话流消息，agent 自行查目录 → 调 CCC vlm MSM 识别）
 * 失败仅 console.warn（不打断用户）。
 */

import type {} from '@deepseek-ai/dsh-client-ui-conversation'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useRef } from 'react'
import { imageNoteTemplate } from './image-fallback-api.js'

/** inject 面：apply 闭包提供的图片操作回调 */
export interface ImageFallbackInjected {
  uploadImage: (file: File, sessionId: string) => Promise<string>
  getDraftFiles: (sessionId: string, ids: readonly string[]) => Promise<File[]>
  resendText: (sessionId: string, text: string) => Promise<void>
}

export type ImageFallbackDockProps = PropsRuntime<'conversation.input.dock'> & ImageFallbackInjected

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

/** input.dock 条目（静默）：图片发送失败自动落盘 + 文本重发，无 UI */
export function ImageFallbackDock(props: ImageFallbackDockProps): null {
  const zone = props as unknown as { session: SessionLike; input?: InputLike }
  const session = zone.session
  const input = zone.input
  const sessionId = props.sessionId
  const { uploadImage, getDraftFiles, resendText } = props
  // provide channel：session-scope 组件经 props 拿 inputActions（清 rail/setDraft/submit）
  const inputActions = (props as unknown as { inputActions?: InputActionsLike }).inputActions

  const handlingRef = useRef(false)

  const promptError = session?.promptError?.error
  const imageIds = input?.imageIds ?? []

  useEffect(() => {
    if (promptError?.code !== 'attachment-error') return
    if (promptError.details?.reason !== 'MODEL_DOES_NOT_SUPPORT_IMAGES') return
    if (handlingRef.current || imageIds.length === 0) return
    handlingRef.current = true
    void (async () => {
      try {
        const files = await getDraftFiles(String(sessionId), imageIds)
        if (files.length === 0) throw new Error('no draft image files')
        const saved: string[] = []
        for (const file of files) {
          saved.push(await uploadImage(file, String(sessionId)))
        }
        // 对话流消息：写名具体图片路径（v1.20.6——agent 直接可用，无需猜目录）
        const note = imageNoteTemplate(saved)
        const draft = input?.draft ?? ''
        const text = draft === '' ? note : `${draft}\n${note}`
        if (inputActions?.removeImage !== undefined && inputActions.setDraft !== undefined && inputActions.submit !== undefined) {
          // 官方输入机器路径：清 rail 图片 → draft 更新为原文+提示 → 机器发送（draft 自动清空，无残留）
          for (const id of imageIds) inputActions.removeImage(String(id))
          inputActions.setDraft(text)
          inputActions.submit()
        } else {
          // fallback：直接 RPC 重发（rail 残留由用户手动移除）
          await resendText(String(sessionId), text)
        }
      } catch (err) {
        console.warn(`[serenity] image fallback failed: ${String((err as Error)?.message ?? err)}`)
      } finally {
        handlingRef.current = false
      }
    })()
  }, [promptError, imageIds, sessionId, uploadImage, getDraftFiles, resendText, input?.draft, inputActions])

  return null
}
