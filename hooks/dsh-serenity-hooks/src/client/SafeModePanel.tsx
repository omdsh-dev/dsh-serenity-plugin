/**
 * dsh-serenity-hooks — 浏览器端（client half）
 *
 * 会话头部 **CCC 状态栏面板**（v1.22 专业 UX 重构）：
 *  - 卡片形态：绿状态点 + 版本 + safe 徽标 + chevron；点击弹出
 *  - **官方 Modal**（ui-primitives：body portal 遮罩 + 居中 + Escape/遮罩关闭）
 * 面板只承载**状态展示**（v1.22 归属原则：账号密码等 plugin 配置在 DSH 设置面板
 * 「Serenity」页设定，本面板不再承载配置表单）：
 *  - 运行环境：CCC / Loop 模型 / 守卫
 *  - 安全模式：大开关（唯一可操作项，用户能力）
 *  - Loop 运行：运行列表 + 详情折叠
 * 数据经同源 HTTP /serenity/status + /serenity/loops（插件服务端路由）。
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

/** 会话头部：CCC 状态栏卡片（点击 → 官方 Modal 居中，纯状态展示） */
export function SafeModePanel(props: SafeModePanelProps): React.JSX.Element {
  const [status, setStatus] = useState<SerenityStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [loops, setLoops] = useState<LoopRunInfo[]>([])
  const [loopsOpen, setLoopsOpen] = useState(false)

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
  const runningLoops = loops.filter((l) => !l.done)
  // 点颜色编码：非 CCC=灰 / CCC+safe off=绿 / CCC+safe on=琥珀（safe 状态分离出卡片，不再胶囊套胶囊）
  const dotClass = !inCcc ? 'sp-dotOff' : status.safeModeOn ? 'sp-dotWarn' : 'sp-dotOn'

  return (
    <>
      {/* 状态卡片（可点击 → 弹出 Modal） */}
      <button
        type="button"
        className={cx('sp-card')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        title={
          inCcc
            ? `Serenity v${status.accVersion} — ${status.root}${status.safeModeOn ? '（safe-mode ON）' : '（safe-mode OFF）'}`
            : 'Serenity（未激活）'
        }
      >
        <span className={cx('sp-dot', dotClass)} />
        <span className={cx('sp-brand')}>Serenity v{status.accVersion}</span>
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
                    <span className={cx('sp-label')}>Loop 模型</span>
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

              {/* ── 分组：Loop 运行 ── */}
              <div className={cx('sp-group')}>
                <div className={cx('sp-groupHead')}>
                  <h3 className={cx('sp-groupTitle')}>Loop 运行</h3>
                  {loops.length > 0 && (
                    <button
                      type="button"
                      className={cx('sp-loopsToggle')}
                      onClick={() => setLoopsOpen((v) => !v)}
                    >
                      {loopsOpen ? '收起' : '详情'}
                    </button>
                  )}
                </div>
                <div className={cx('sp-rows')}>
                  <div className={cx('sp-row')}>
                    <span className={cx('sp-label')}>状态</span>
                    <span className={cx('sp-value')}>
                      {runningLoops.length > 0
                        ? `运行中 ${runningLoops.length}${loops.length > 0 ? ` / 共 ${loops.length}` : ''}`
                        : '无运行中 loop'}
                    </span>
                  </div>
                </div>
                {loopsOpen && (
                  <div className={cx('sp-loopsList')}>
                    {loops.slice(0, 3).map((l) => (
                      <div key={l.label} className={cx('sp-loopItem')}>
                        <div className={cx('sp-loopHead')}>
                          <span className={cx('sp-loopLabel')} title={l.label}>{l.label}</span>
                          <span className={cx('sp-loopRound')}>{l.done ? '✓ 完成' : `R${l.round}`}</span>
                          <span className={cx('sp-loopTime')}>{new Date(l.updated).toLocaleTimeString()}</span>
                        </div>
                        <div className={cx('sp-loopResp')} title={l.lastResponse}>
                          {l.lastResponse.slice(0, 80) || (l.done ? '已完成' : '（等待首轮响应）')}
                        </div>
                      </div>
                    ))}
                    {loops.length > 3 && (
                      <div className={cx('sp-loopsMore')}>… 共 {loops.length} 个 loop（其余见等待界面）</div>
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
