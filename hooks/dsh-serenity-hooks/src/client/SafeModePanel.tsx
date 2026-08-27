/**
 * dsh-serenity-hooks — 浏览器端（client half）
 *
 * 会话头部 **CCC 状态栏面板**（v1.22 专业 UX 重构）：
 *  - 卡片形态：绿状态点 + 版本 + safe 徽标 + chevron；点击弹出
 *  - **官方 Modal**（ui-primitives：body portal 遮罩 + 居中 + Escape/遮罩关闭）
 * 面板只承载**状态展示**（v1.22 归属原则：账号密码等 plugin 配置在 DSH 设置面板
 * 「Serenity」页设定，本面板不再承载配置表单）：
 *  - 运行环境：CCC / Handyman 模型 / 守卫
 *  - 安全模式：大开关（唯一可操作项，用户能力）
 *  - Handyman 运行：运行列表 + 详情折叠
 * 数据经同源 HTTP /serenity/status + /serenity/handymen（插件服务端路由）。
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
import './SafeModePanel.css'

/** 会话头部操作区（list 槽）props */
export type SafeModePanelProps = PropsRuntime<'conversation.session.header.actions'>

export interface SerenityStatus {
  root: string | null
  accVersion: string
  safeModeOn: boolean
  blacklist: string[]
  threshold: number | null
  handymanModel: string | null
}

/** handyman 运行状态（/serenity/handymen 数据源；WebUI 等待界面） */
export interface HandymanRunInfo {
  label: string
  round: number
  done: boolean
  model: string
  updated: string
  lastResponse: string
}

const API = '/serenity/status'
const HANDYMEN_API = '/serenity/handymen'

/** 盾牌 SVG（方案 O 盾牌版 v1.24.2；stroke currentColor——琥珀=OFF 提醒 / 绿=ON 安心由状态类控制） */
const SHIELD_SVG = (
  <svg viewBox="0 0 16 16" fill="none" width={16} height={16} aria-hidden="true">
    <path
      d="M8 1.5L13.5 3.5V7.2C13.5 10.6 11.2 13.6 8 14.8C4.8 13.6 2.5 10.6 2.5 7.2V3.5L8 1.5Z"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinejoin="round"
    />
    <path
      d="M5.8 8L7.3 9.5L10.2 6.6"
      stroke="currentColor"
      strokeWidth={1.2}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

/** 拼接类名（等价 clsx 最小子集，避免额外依赖） */
function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

/** 会话头部：CCC 状态栏卡片（点击 → 官方 Modal 居中，纯状态展示） */
export function SafeModePanel(props: SafeModePanelProps): React.JSX.Element {
  const [status, setStatus] = useState<SerenityStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [handymen, setHandymen] = useState<HandymanRunInfo[]>([])
  const [handymenOpen, setHandymenOpen] = useState(false)

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

  // 模态打开时轮询 handyman 运行状态（约 3s 刷新；进度文件驱动）
  useEffect(() => {
    if (!open) return
    let alive = true
    const qs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
    const tick = async (): Promise<void> => {
      try {
        const r = await fetch(`${HANDYMEN_API}${qs}`, { headers: { accept: 'application/json' } })
        const data = (await r.json()) as { handymen?: HandymanRunInfo[] }
        if (alive) setHandymen(data.handymen ?? [])
      } catch {
        if (alive) setHandymen([])
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
  const runningHandymen = handymen.filter((l) => !l.done)

  return (
    <>
      {/* 状态卡片（方案 O 盾牌版 v1.24.2：绿点=Serenity 生效恒绿；盾牌=SAFE 状态——琥珀=OFF 提醒 / 绿=ON 安心） */}
      <button
        type="button"
        className={cx(
          'sp-card',
          inCcc ? (status.safeModeOn ? 'sp-cardProtected' : 'sp-cardUnprotected') : 'sp-cardInactive',
        )}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        title={
          inCcc
            ? `Serenity v${status.accVersion} — ${status.root}（${status.safeModeOn ? 'SAFE ON — 写工具已隐藏' : 'SAFE OFF — 写工具全开，无保护'}）`
            : 'Serenity（未激活）'
        }
      >
        <span className={cx('sp-dot', inCcc ? undefined : 'sp-dotOff')} />
        <span className={cx('sp-brand')}>Serenity</span>
        <span className={cx('sp-ver')}>v{status.accVersion}</span>
        {inCcc && (
          <>
            <span className={cx('sp-sep')} />
            <span className={cx('sp-shield')}>{SHIELD_SVG}</span>
            <span className={cx('sp-statusWord')}>{status.safeModeOn ? 'SAFE ON' : 'SAFE OFF'}</span>
          </>
        )}
        <IconChevronDownOutline14 size={12} className={cx('sp-chev')} />
      </button>

      {/* 官方 Modal：纯状态展示 */}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="CCC 状态栏"
        closeLabel="关闭"
        className={cx('sp-modal')}
      >
        <div className={cx('sp-modalBody')}>
          {inCcc ? (
            <>
              {/* ── 分组：运行环境 ── */}
              <div className={cx('sp-group')}>
                <h3 className={cx('sp-groupTitle')}>运行环境</h3>
                <div className={cx('sp-rows')}>
                  <div className={cx('sp-row')}>
                    <span className={cx('sp-label')}>CCC</span>
                    <span className={cx('sp-value')} title={status.root ?? undefined}>{status.root}</span>
                  </div>
                  <div className={cx('sp-row')}>
                    <span className={cx('sp-label')}>Handyman 模型</span>
                    <span className={cx('sp-value')} title={status.handymanModel ? `handyman.models: ${status.handymanModel}` : undefined}>
                      {status.handymanModel ?? '未配置'}
                    </span>
                  </div>
                  <div className={cx('sp-row')}>
                    <span className={cx('sp-label')}>守卫</span>
                    <span className={cx('sp-value')}>
                      blacklist {status.blacklist.length} 条{status.threshold !== null ? ` · keeper 阈值 ${status.threshold}` : ''}
                    </span>
                  </div>
                </div>
              </div>

              {/* ── 分组：安全模式 ── */}
              <div className={cx('sp-group')}>
                <h3 className={cx('sp-groupTitle')}>安全模式</h3>
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
                  <span className={cx('sp-toggleDesc')}>
                    {status.safeModeOn ? '写工具已隐藏，无人值守安全航行' : '写工具可用（点击开启）'}
                  </span>
                </div>
              </div>

              {/* ── 分组：Handyman 运行 ── */}
              <div className={cx('sp-group')}>
                <div className={cx('sp-groupHead')}>
                  <h3 className={cx('sp-groupTitle')}>Handyman 运行</h3>
                  {handymen.length > 0 && (
                    <button
                      type="button"
                      className={cx('sp-handymenToggle')}
                      onClick={() => setHandymenOpen((v) => !v)}
                    >
                      {handymenOpen ? '收起' : '详情'}
                    </button>
                  )}
                </div>
                <div className={cx('sp-rows')}>
                  <div className={cx('sp-row')}>
                    <span className={cx('sp-label')}>状态</span>
                    <span className={cx('sp-value')}>
                      {runningHandymen.length > 0
                        ? `运行中 ${runningHandymen.length}${handymen.length > 0 ? ` / 共 ${handymen.length}` : ''}`
                        : '无运行中 handyman'}
                    </span>
                  </div>
                </div>
                {handymenOpen && (
                  <div className={cx('sp-handymenList')}>
                    {handymen.slice(0, 3).map((l) => (
                      <div key={l.label} className={cx('sp-handymanItem')}>
                        <div className={cx('sp-handymanHead')}>
                          <span className={cx('sp-handymanLabel')} title={l.label}>{l.label}</span>
                          <span className={cx('sp-handymanRound')}>{l.done ? '✓ 完成' : `R${l.round}`}</span>
                          <span className={cx('sp-handymanTime')}>{new Date(l.updated).toLocaleTimeString()}</span>
                        </div>
                        <div className={cx('sp-handymanResp')} title={l.lastResponse}>
                          {l.lastResponse.slice(0, 80) || (l.done ? '已完成' : '（等待首轮响应）')}
                        </div>
                      </div>
                    ))}
                    {handymen.length > 3 && (
                      <div className={cx('sp-handymenMore')}>… 共 {handymen.length} 个 handyman（其余见等待界面）</div>
                    )}
                  </div>
                )}
              </div>

              {/* ── 提示：配置在 DSH 设置面板 ── */}
              <p className={cx('sp-hint')}>
                💡 开关/阈值/账号/工作区白名单请在 <strong>设置 → Serenity</strong> 中配置。
              </p>
            </>
          ) : (
            <div className={cx('sp-group')}>
              <h3 className={cx('sp-groupTitle')}>状态</h3>
              <div className={cx('sp-rows')}>
                <div className={cx('sp-row')}>
                  <span className={cx('sp-label')}>ACC</span>
                  <span className={cx('sp-value')}>未激活（工作区不在 CCC 内）</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </Modal>
    </>
  )
}
