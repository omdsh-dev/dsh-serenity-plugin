/**
 * dsh-serenity-hooks — 浏览器端（client half）
 *
 * 会话头部 Serenity 状态徽章：绿状态点 + 版本 + safe-mode 开关；
 * 点击徽章展开详情卡（CCC/loop/守卫 + 大开关），再点或点外部关闭。
 * 数据经同源 HTTP /serenity/status（插件服务端路由）。
 * 样式遵循 web-styling.md：--dsw-alias-* 语义 token（明暗自适应）+ 官方图标。
 *
 * 槽：conversation.session.header.actions（官方既有槽，list）
 */

import type {} from '@deepseek-ai/dsh-client-ui-conversation'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconChevronDownOutline14,
  IconChevronUpOutline14,
  IconWarningOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState, useCallback, useRef } from 'react'
import './SafeModePanel.css'

/** 会话头部操作区（list 槽）props */
export type SafeModePanelProps = PropsRuntime<'conversation.session.header.actions'>

export interface SerenityStatus {
  root: string | null
  accVersion: string
  safeModeOn: boolean
  blacklist: string[]
  threshold: number | null
  loopModel: string | null
}

/** loop 运行状态（/serenity/loops 数据源；WebUI 等待界面） */
export interface LoopRunInfo {
  label: string
  round: number
  done: boolean
  model: string
  updated: string
  lastResponse: string
}

const API = '/serenity/status'
const LOOPS_API = '/serenity/loops'

/** 拼接类名（等价 clsx 最小子集，避免额外依赖） */
function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

/** 会话头部：可点击徽章 + safe-mode 开关；点击徽章展开状态详情卡 */
export function SafeModePanel(props: SafeModePanelProps): React.JSX.Element {
  const [status, setStatus] = useState<SerenityStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [loops, setLoops] = useState<LoopRunInfo[]>([])
  const rootRef = useRef<HTMLSpanElement>(null)

  const sessionId = props.sessionId

  const refresh = useCallback(async () => {
    const qs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
    try {
      const r = await fetch(`${API}${qs}`, { headers: { accept: 'application/json' } })
      setStatus((await r.json()) as SerenityStatus)
    } catch {
      setStatus(null)
    }
  }, [sessionId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 展开时轮询 loop 运行状态（约 3s 刷新——类似 workflow 等待界面；进度文件驱动，并行任务各自一行）
  useEffect(() => {
    if (!open) return
    let alive = true
    const qs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
    const tick = async (): Promise<void> => {
      try {
        const r = await fetch(`${LOOPS_API}${qs}`, { headers: { accept: 'application/json' } })
        const data = (await r.json()) as { loops?: LoopRunInfo[] }
        if (alive) setLoops(data.loops ?? [])
      } catch {
        if (alive) setLoops([])
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), 3000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [open, sessionId])

  // 展开时点击外部关闭（弹层相对徽章定位，不阻断其他 header 控件）
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  const toggle = async (on: boolean): Promise<void> => {
    setBusy(true)
    try {
      await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-serenity-ui': '1' },
        body: JSON.stringify({ sessionId, on }),
      })
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  if (!status) return <span className={cx('sp-root')}>⏳ Serenity…</span>

  const inCcc = status.root !== null
  return (
    <span ref={rootRef} className={cx('sp-root')} title={status.root ?? undefined}>
      <button
        type="button"
        className={cx('sp-badge')}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={open ? '收起详情' : '查看 Serenity 状态'}
      >
        <span className={cx('sp-dot', inCcc ? 'sp-dotOn' : 'sp-dotOff')} />
        <span className={cx('sp-brand')}>Serenity v{status.accVersion}</span>
        {open ? <IconChevronUpOutline14 size={12} /> : <IconChevronDownOutline14 size={12} />}
      </button>
      {inCcc && (
        <button
          type="button"
          className={cx('sp-toggle', status.safeModeOn ? 'sp-toggleOn' : 'sp-toggleOff')}
          disabled={busy}
          onClick={() => void toggle(!status.safeModeOn)}
          title={status.safeModeOn ? '关闭 safe-mode（解除 bash 限制）' : '开启 safe-mode（隐藏写工具）'}
        >
          {status.safeModeOn && <IconWarningOutline16 size={12} className={cx('sp-toggleIcon')} />}
          safe-mode {status.safeModeOn ? 'ON' : 'OFF'}
        </button>
      )}
      {open && (
        <div className={cx('sp-pop')} role="dialog" aria-label="Serenity 状态详情">
          {inCcc ? (
            <>
              <div className={cx('sp-popRow')}>
                <span className={cx('sp-popLabel')}>CCC</span>
                <span className={cx('sp-popValue')} title={status.root ?? undefined}>{status.root}</span>
              </div>
              <div className={cx('sp-popRow')}>
                <span className={cx('sp-popLabel')}>loop</span>
                <span className={cx('sp-popValue')} title={status.loopModel ? `loop.defaultModel: ${status.loopModel}` : undefined}>
                  {status.loopModel ?? '未配置'}
                </span>
              </div>
              <div className={cx('sp-popRow')}>
                <span className={cx('sp-popLabel')}>守卫</span>
                <span className={cx('sp-popValue')}>
                  blacklist {status.blacklist.length} 条{status.threshold !== null ? ` · keeper 阈值 ${status.threshold}` : ''}
                </span>
              </div>
              <div className={cx('sp-popActions')}>
                <button
                  type="button"
                  className={cx('sp-toggle', status.safeModeOn ? 'sp-toggleOn' : 'sp-toggleOff', 'sp-toggleLg')}
                  disabled={busy}
                  onClick={() => void toggle(!status.safeModeOn)}
                >
                  {status.safeModeOn && <IconWarningOutline16 size={14} className={cx('sp-toggleIcon')} />}
                  safe-mode {status.safeModeOn ? 'ON' : 'OFF'}
                </button>
              </div>
              <div className={cx('sp-popSection')}>
                <div className={cx('sp-popRow')}>
                  <span className={cx('sp-popLabel')}>loops</span>
                  <span className={cx('sp-popValue')}>
                    {loops.filter((l) => !l.done).length > 0
                      ? `运行中 ${loops.filter((l) => !l.done).length}${loops.length > 0 ? ` / 共 ${loops.length}` : ''}`
                      : '无运行中 loop'}
                  </span>
                </div>
                {loops.slice(0, 5).map((l) => (
                  <div key={l.label} className={cx('sp-loopItem')}>
                    <div className={cx('sp-loopHead')}>
                      <span className={cx('sp-loopLabel')} title={l.label}>{l.label}</span>
                      <span className={cx('sp-loopRound')}>{l.done ? '✓' : `R${l.round}`}</span>
                      <span className={cx('sp-loopTime')}>{new Date(l.updated).toLocaleTimeString()}</span>
                    </div>
                    <div className={cx('sp-loopResp')} title={l.lastResponse}>
                      {l.lastResponse.slice(0, 80) || (l.done ? '已完成' : '（等待首轮响应）')}
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className={cx('sp-popRow')}>
              <span className={cx('sp-popLabel')}>状态</span>
              <span className={cx('sp-popValue')}>ACC 未激活（工作区不在 CCC 内）</span>
            </div>
          )}
        </div>
      )}
    </span>
  )
}
