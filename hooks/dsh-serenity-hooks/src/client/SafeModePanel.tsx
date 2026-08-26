/**
 * dsh-serenity-hooks — 浏览器端（client half）
 *
 * 会话头部 **Serenity 状态卡片**（v1.21 UX 重构）：
 *  - 卡片形态：绿状态点 + 版本 + chevron；点击弹出
 *  - **官方 Modal**（ui-primitives：body portal 遮罩 + 居中 + Escape/遮罩关闭——
 *    大面板不被 header 容器/视口裁剪）
 * 模态内双 tab：
 *  - 状态 tab：CCC/loop/守卫 + safe-mode 大开关 + loops 运行列表
 *  - 账号 tab：gateway 监听地址/端口 + 账号列表 CRUD（复杂配置，localstore）
 * 简单配置（开关/阈值）在 dsh 原生设置面板（SettingsSection）。
 * 数据经同源 HTTP /serenity/status + /serenity/config（插件服务端路由）。
 *
 * 槽：conversation.session.header.actions（官方既有槽，list）
 */

import type {} from '@deepseek-ai/dsh-client-ui-conversation'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconChevronDownOutline14,
  IconWarningOutline16,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState, useCallback } from 'react'
import { AccountsTab } from './AccountsTab.js'
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

/** 会话头部：Serenity 状态卡片（点击 → 全屏遮罩居中模态，双 tab） */
export function SafeModePanel(props: SafeModePanelProps): React.JSX.Element {
  const [status, setStatus] = useState<SerenityStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'status' | 'accounts'>('status')
  const [loops, setLoops] = useState<LoopRunInfo[]>([])

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

  // 模态打开时轮询 loop 运行状态（约 3s 刷新；进度文件驱动）
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

  if (!status) {
    return (
      <button type="button" className={cx('sp-card')} disabled>
        <span className={cx('sp-dot', 'sp-dotOff')} />
        <span className={cx('sp-brand')}>Serenity…</span>
      </button>
    )
  }

  const inCcc = status.root !== null

  return (
    <>
      {/* 状态卡片（可点击 → 弹出 Modal） */}
      <button
        type="button"
        className={cx('sp-card')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        title={inCcc ? `Serenity v${status.accVersion} — ${status.root}` : 'Serenity（未激活）'}
      >
        <span className={cx('sp-dot', inCcc ? 'sp-dotOn' : 'sp-dotOff')} />
        <span className={cx('sp-brand')}>Serenity v{status.accVersion}</span>
        <IconChevronDownOutline14 size={12} className={cx('sp-chev')} />
      </button>

      {/* 官方 Modal：body portal 遮罩 + 居中 + Escape/遮罩关闭 */}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Serenity 高级设定"
        closeLabel="关闭"
        className={cx('sp-modal')}
      >
        <div className={cx('sp-tabs')}>
          <button
            type="button"
            className={cx('sp-tab', tab === 'status' && 'sp-tabOn')}
            onClick={() => setTab('status')}
          >
            状态
          </button>
          <button
            type="button"
            className={cx('sp-tab', tab === 'accounts' && 'sp-tabOn')}
            onClick={() => setTab('accounts')}
          >
            账号
          </button>
        </div>

        <div className={cx('sp-modalBody')}>
          {tab === 'accounts' ? (
            <AccountsTab sessionId={String(sessionId ?? '')} />
          ) : inCcc ? (
            <>
              <div className={cx('sp-row')}>
                <span className={cx('sp-label')}>CCC</span>
                <span className={cx('sp-value')} title={status.root ?? undefined}>{status.root}</span>
              </div>
              <div className={cx('sp-row')}>
                <span className={cx('sp-label')}>loop</span>
                <span className={cx('sp-value')} title={status.loopModel ? `loop.defaultModel: ${status.loopModel}` : undefined}>
                  {status.loopModel ?? '未配置'}
                </span>
              </div>
              <div className={cx('sp-row')}>
                <span className={cx('sp-label')}>守卫</span>
                <span className={cx('sp-value')}>
                  blacklist {status.blacklist.length} 条{status.threshold !== null ? ` · keeper 阈值 ${status.threshold}` : ''}
                </span>
              </div>
              <div className={cx('sp-actions')}>
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
              <div className={cx('sp-section')}>
                <div className={cx('sp-row')}>
                  <span className={cx('sp-label')}>loops</span>
                  <span className={cx('sp-value')}>
                    {loops.filter((l) => !l.done).length > 0
                      ? `运行中 ${loops.filter((l) => !l.done).length}${loops.length > 0 ? ` / 共 ${loops.length}` : ''}`
                      : '无运行中 loop'}
                  </span>
                </div>
                {loops.slice(0, 4).map((l) => (
                  <div key={l.label} className={cx('sp-loopItem')}>
                    <div className={cx('sp-loopHead')}>
                      <span className={cx('sp-loopLabel')} title={l.label}>{l.label}</span>
                      <span className={cx('sp-loopRound')}>{l.done ? '✓' : `R${l.round}`}</span>
                      <span className={cx('sp-loopTime')}>{new Date(l.updated).toLocaleTimeString()}</span>
                    </div>
                    <div className={cx('sp-loopResp')} title={l.lastResponse}>
                      {l.lastResponse.slice(0, 60) || (l.done ? '已完成' : '（等待首轮响应）')}
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className={cx('sp-row')}>
              <span className={cx('sp-label')}>状态</span>
              <span className={cx('sp-value')}>ACC 未激活（工作区不在 CCC 内）</span>
            </div>
          )}
        </div>
      </Modal>
    </>
  )
}
