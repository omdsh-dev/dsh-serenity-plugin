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
import { useEffect, useLayoutEffect, useState, useCallback, useRef } from 'react'
import './SafeModePanel.css'

/** 会话头部操作区（list 槽）props */
type SafeModePanelProps = PropsRuntime<'conversation.session.header.actions'>

/** popover 与锚点胶囊之间的间距（= 旧 CSS `top: calc(100% + 8px)` 的 8） */
const POP_GAP_PX = 8
/** popover 与视口边缘的最小留白（夹取用，防卡片贴边或被视口切掉） */
const POP_VIEW_PAD_PX = 8
/** 尚未落位时的屏外坐标（`useLayoutEffect` 在绘制前就会覆写，肉眼看不到） */
const POP_OFFSCREEN = -9999

/** 自绘 popover 的视口坐标（v1.39.1：fixed 定位后由 JS 计算） */
interface PopPlacement {
  left: number
  top: number
}

interface SerenityStatus {
  root: string | null
  accVersion: string
  safeModeOn: boolean
  blacklist: string[]
  threshold: number | null
  handymanModel: string | null
}

/** handyman 运行状态（/serenity/handymen 数据源；WebUI 等待界面） */
interface HandymanRunInfo {
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
  const popRef = useRef<HTMLDivElement>(null)
  // v1.39.1：popover 改 `position:fixed` 后的视口坐标（null = 尚未测量，此时渲染在屏外）
  const [popPos, setPopPos] = useState<PopPlacement | null>(null)

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

  // 自绘 popover 定位（v1.39.1）——`position:fixed` + 视口夹取
  // 为什么不是纯 CSS 定位：卡片锚在会话头右端的胶囊上，而会话中列是 `overflow:hidden`
  //   （真机实测 `pI_x6G_centerCol` / `wSkVaW_root` 左边界 = 280，卡片左边界 274.2）
  //   ⇒ 绝对定位的卡片向左长出去会被祖先**裁掉**（左边框与圆角消失）。
  //   `position:fixed` 的子元素不受祖先 `overflow` 裁切（且已实测本应用无祖先会捕获 fixed）。
  // 为什么是 useLayoutEffect：要在**浏览器绘制前**量到真实尺寸并落位，否则会闪一帧在屏外。
  // 为什么点"外部关闭"不受影响：`rootRef.current.contains()` 走 **DOM 树**，与定位方式无关。
  useLayoutEffect(() => {
    if (!open) {
      setPopPos(null)
      return
    }
    const place = (): void => {
      const anchor = rootRef.current
      const pop = popRef.current
      if (!anchor || !pop) return
      const a = anchor.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      const w = pop.offsetWidth
      const h = pop.offsetHeight
      // 右端对齐胶囊右端（等价旧的 `right:0`），再夹取进视口 —— 窄视口时退化为"左留白对齐"
      const left = Math.max(POP_VIEW_PAD_PX, Math.min(a.right - w, vw - w - POP_VIEW_PAD_PX))
      // 卡片从胶囊下方展开；顶边同样夹取（高度另有 CSS `max-height: calc(100vh - 120px)` 兜底）
      const top = Math.max(POP_VIEW_PAD_PX, Math.min(a.bottom + POP_GAP_PX, vh - h - POP_VIEW_PAD_PX))
      setPopPos({ left, top })
    }
    place()
    // 锚点会随窗口尺寸变化 / 侧栏开合 / 内部滚动容器滚动而移动 ⇒ 重算
    // （capture=true：会话区滚动发生在内层滚动容器上，冒泡阶段接不到）
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
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

      {/* 自绘 popover（v1.36.1：加宽为两栏——左=信息 / 右=航行动画；外点/Escape 关闭）
          v1.39.1：`position:fixed` + 坐标由上面的 useLayoutEffect 计算（避免被祖先 overflow 裁切）。
          落位前渲染在屏外（POP_OFFSCREEN）——布局仍在，故 `offsetWidth/Height` 可量。 */}
      {open && (
        <div
          ref={popRef}
          className={cx('sp-pop', 'sp-popVoyage')}
          role="dialog"
          aria-label="CCC 状态栏"
          style={
            popPos ? { left: popPos.left, top: popPos.top } : { left: POP_OFFSCREEN, top: POP_OFFSCREEN }
          }
        >
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
          {/* 右栏：宁静号航行动画（ACC 层资产 /serenity/voyage，S142 §12.44 → v1.36.1 改右栏）。
              · 用 iframe：作品是自包含单文件（830 KB，85% 是 three.js），内联会灌进
                client bundle 并与卡片样式互相污染；iframe 隔离干净、**惰性加载**
                （只在展开时请求一次）、关闭即卸载 ⇒ WebGL 上下文随之释放。
              · ?card=1 → 卡片模式（作品自带的大标题/航速/事实面板/铭牌层全部让位）
              · ?v=版本 → 资产随包变、URL 稳定 ⇒ 用 ACC 版本号打点，升级即失效重取
              · aria-hidden + 无 tabindex：纯装饰，不进无障碍树、不可聚焦
              · DOM 顺序放正文之后 ⇒ 单栏（窄屏）时动画自然落在信息**下方** */}
          <div className={cx('sp-voyage')} aria-hidden="true">
            <iframe
              key={status.accVersion}
              src={`/serenity/voyage?card=1&v=${encodeURIComponent(status.accVersion)}`}
              title=""
              loading="lazy"
              tabIndex={-1}
            />
          </div>
        </div>
      )}
    </div>
  )
}
