/**
 * dsh-serenity-hooks — 浏览器端（client half）
 *
 * 会话头部 **Serenity 状态胶囊**（v1.24.10 胶囊改版，对齐 OcgoDockEntry pill 风格）：
 *  - 胶囊形态：全圆 999px + padding 4px 9px（无固定高度）+ 半透明 bg-layer-2
 *  - 绿点（恒亮 = Serenity 在线，不随 SAFE 变）+ Serenity vX.Y.Z + 分隔线 + 🛡 SAFE 滑块 + chevron
 *  - SAFE = 盾牌 + 文字：ON 绿（emerald 渐变）/ OFF 灰；滑块 Mac 风格（24×13 轨道 + 11px 灰白 thumb 无图标）
 *  - 点击 → **自绘 popover**（340px 右上角卡片，外点 / Escape 关闭）——替代官方 Modal
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

/** 盾牌 SVG（v1.24.5 校准：fill=none 纯描边；ON=绿 emerald / OFF=灰 label-secondary 由状态类控制） */
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

/** 会话头部：Serenity 状态胶囊（点击 → 自绘 popover，纯状态展示） */
export function SafeModePanel(props: SafeModePanelProps): React.JSX.Element {
  const [status, setStatus] = useState<SerenityStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [handymen, setHandymen] = useState<HandymanRunInfo[]>([])
  const [handymenOpen, setHandymenOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

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

  // 弹层打开时轮询 handyman 运行状态（约 3s 刷新；进度文件驱动）
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

  // 自绘 popover：外点 / Escape 关闭
  useEffect(() => {
    if (!open) return
    const onDocMouseDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKey)
    }
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
    <div className={cx('sp-root')} ref={rootRef}>
      {/* 状态胶囊（v1.24.10：999px 全圆 + 绿点恒亮 + SAFE 盾牌滑块 + chevron） */}
      <button
        type="button"
        className={cx(
          'sp-card',
          inCcc ? (status.safeModeOn ? 'sp-cardProtected' : 'sp-cardUnprotected') : 'sp-cardInactive',
        )}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
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
            <span className={cx('sp-statusWord')}>SAFE</span>
            {/* Mac 风格滑块快速开关（v1.24.10）：thumb 无图标；左=OFF 灰 / 右=ON 绿；stopPropagation 不触发弹层 */}
            <span
              className={cx('sp-switch', status.safeModeOn ? 'sp-switchOn' : 'sp-switchOff', busy ? 'sp-switchBusy' : undefined)}
              role="switch"
              aria-checked={status.safeModeOn}
              title={status.safeModeOn ? 'safe-mode ON（点击关闭）' : 'safe-mode OFF（点击开启）'}
              onClick={(e) => {
                e.stopPropagation()
                if (busy) return
                void toggle(!status.safeModeOn)
              }}
            >
              <span className={cx('sp-switchThumb')} />
            </span>
          </>
        )}
        <IconChevronDownOutline14 size={12} className={cx('sp-chev')} />
      </button>

      {/* 自绘 popover（340px 右上角卡片；外点/Escape 关闭） */}
      {open && (
        <div className={cx('sp-pop')} role="dialog" aria-label="CCC 状态栏">
          <div className={cx('sp-popBody')}>
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
        </div>
      )}
    </div>
  )
}
