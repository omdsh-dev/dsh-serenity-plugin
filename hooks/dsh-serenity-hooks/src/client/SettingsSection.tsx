/**
 * SettingsSection.tsx — dsh 原生设置面板的 serenity-hooks 配置页（v1.22 重构）
 *
 * 归属原则（v1.22 用户拍板）：**plugin 是全局的，CCC 是具体的**——
 * 账号密码/开关/阈值/工作区白名单都是 **plugin 级配置**，统一在 DSH 设置面板
 * （plugin 层）设定；CCC 状态栏面板（SafeModePanel）只展示状态。
 *
 * 页面结构（官方 settings 设计语言：section > title + intro + 分组(groupTitle) + rowCard）：
 *  - 访问：双端口网关开关
 *  - 上下文：超限重建开关 + 阈值
 *  - 会话：会话命名开关
 *  - 外部访问（复杂配置，经 /serenity/config plugin 全局文件）：账号 CRUD + 工作区白名单
 *
 * 数据通道（双层）：
 *  - 简单配置：ctx.settingsScope.bind({ namespace: 'serenity-hooks' })（settings.yaml）
 *  - 复杂配置（账号/白名单）：同源 HTTP /serenity/config（accounts-api.ts，服务端 scrypt hash）
 *
 * 降级守卫：snapshot.status === 'unavailable'（旧 RC 白名单）→ 降级提示。
 */

import type {} from '@deepseek-ai/dsh-client-ui-settings'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope, SettingsScopeSpec } from '@deepseek-ai/dsh-client-runtime/client'
import { useCallback, useEffect, useState } from 'react'
import { AccountsEditor } from './AccountsEditor.js'
import { PersonaEditor } from './PersonaEditor.js'
import { PublicAskEditor } from './PublicAskEditor.js'
import { WeixinBridgeEditor } from './WeixinBridgeEditor.js'
import './SettingsSection.css'

/** serenity-hooks 简单配置 wire 形态（与 host 侧 schema 对齐） */
export interface SerenitySimpleWire {
  gatewayEnabled?: boolean
  rebuildEnabled?: boolean
  rebuildThreshold?: number
  /** F4 Skiff（v1.25.0 实验性）：认知子集角色调试服务启停 + 端口 */
  skiffEnabled?: boolean
  skiffDebugPort?: number
  /** F4c ACP（v1.26.0 实验性）：HTTP JSON-RPC 端点启停 + 端口 */
  acpEnabled?: boolean
  acpHttpPort?: number
  /** F4d 建议问答页（v1.26.1 实验性）：按认知容器暴露问答页供他人验证（key 认证） */
  publicAskEnabled?: boolean
}

/** 本 section 的注入面（apply 闭包提供 settingsScope） */
export interface SettingsSectionInjected {
  scope: SettingsScope<SerenitySimpleWire>
}

export type SettingsSectionProps = PropsRuntime<'settings.section'> & SettingsSectionInjected

/** 降级提示文案（旧 RC 白名单时引导去宁静号面板） */
const DEGRADE_NOTE =
  '当前运行版本未暴露 serenity-hooks 配置（旧 RC 白名单）。请升级 DSH 或使用会话头部 Serenity 状态栏。'

/** 解码 wire section → 组件状态（缺失字段用默认值） */
function decodeSection(section: unknown): SerenitySimpleWire | undefined {
  if (section === null || typeof section !== 'object') return undefined
  return section as SerenitySimpleWire
}

const SPEC: SettingsScopeSpec<SerenitySimpleWire> = {
  namespace: 'serenity-hooks',
  decode: decodeSection,
}

/** 开关（官方 settings 语言：label 右置 toggle，--dsw-alias-* token） */
function Toggle(props: { checked: boolean; disabled?: boolean; onChange: (on: boolean) => void }): React.JSX.Element {
  const { checked, disabled, onChange } = props
  return (
    <label className="ss-switch">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="ss-switchTrack" />
    </label>
  )
}

/** 一个配置行卡（官方 rowCard：标题+说明 左列 / 控件右置） */
function RowCard(props: {
  title: string
  desc: string
  control: React.ReactNode
}): React.JSX.Element {
  const { title, desc, control } = props
  return (
    <div className="ss-rowCard">
      <div className="ss-rowText">
        <span className="ss-rowName">{title}</span>
        <span className="ss-rowDesc">{desc}</span>
      </div>
      <div className="ss-rowControl">{control}</div>
    </div>
  )
}

/** 分组（多级标题：分组标题 + 一组行卡） */
function Group(props: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  const { title, children } = props
  return (
    <div className="ss-group">
      <h3 className="ss-groupTitle">{title}</h3>
      <ul className="ss-rows">{children}</ul>
    </div>
  )
}

/** dsh 原生设置面板：serenity-hooks 配置页（官方 settings 设计语言，多级标题） */
export function SettingsSection(props: SettingsSectionProps): React.JSX.Element {
  const { scope } = props
  const [snapshot, setSnapshot] = useState(() => scope.getSnapshot())

  useEffect(() => {
    return scope.subscribe(() => setSnapshot(scope.getSnapshot()))
  }, [scope])

  const value = snapshot.value
  const ready = snapshot.status === 'ready'

  const toggle = (field: keyof SerenitySimpleWire, on: boolean): void => {
    void scope.set(field, on)
  }
  const setThreshold = (v: number): void => {
    void scope.set('rebuildThreshold', Math.min(1, Math.max(0.01, v)))
  }
  const setSkiffPort = (v: number): void => {
    void scope.set('skiffDebugPort', Math.min(65535, Math.max(1024, Math.round(v))))
  }
  const setAcpPort = (v: number): void => {
    void scope.set('acpHttpPort', Math.min(65535, Math.max(1024, Math.round(v))))
  }

  if (!ready) {
    return (
      <div className="ss-section">
        <p className="ss-degrade">{DEGRADE_NOTE}</p>
      </div>
    )
  }

  const gatewayOn = value?.gatewayEnabled ?? false
  const rebuildOn = value?.rebuildEnabled ?? true
  const threshold = value?.rebuildThreshold ?? 0.9
  const skiffOn = value?.skiffEnabled ?? false
  const skiffPort = value?.skiffDebugPort ?? 3099
  const acpOn = value?.acpEnabled ?? false
  const acpPort = value?.acpHttpPort ?? 3100
  const publicAskOn = value?.publicAskEnabled ?? false

  return (
    <div className="ss-section">
      <h2 className="ss-title">Serenity</h2>
      <p className="ss-intro">
        宁静号的 plugin 级配置（全局生效，不依赖具体 CCC）。改动即时保存。
      </p>

      <Group title="访问">
        <li>
          <RowCard
            title="双端口网关"
            desc="额外监听一个端口，登录后可从外部访问 Web UI"
            control={<Toggle checked={gatewayOn} onChange={(on) => toggle('gatewayEnabled', on)} />}
          />
        </li>
      </Group>

      <Group title="上下文">
        <li>
          <RowCard
            title="超限重建"
            desc="上下文接近上限时提示调用 session_rebuild 清空重建"
            control={<Toggle checked={rebuildOn} onChange={(on) => toggle('rebuildEnabled', on)} />}
          />
        </li>
        <li>
          <RowCard
            title="重建阈值"
            desc="上下文占用达到该比例时提示（0.10 ~ 1.00）"
            control={
              <div className="ss-threshold">
                <input
                  type="range"
                  min={0.1}
                  max={1}
                  step={0.05}
                  value={threshold}
                  disabled={!rebuildOn}
                  onChange={(e) => setThreshold(Number(e.target.value))}
                />
                <span className="ss-value">{threshold.toFixed(2)}</span>
              </div>
            }
          />
        </li>
      </Group>

      {/* F4 Skiff（v1.25.0 实验性）：认知子集角色调试服务（人工启停） */}
      <Group title="Skiff">
        <li>
          <RowCard
            title="认知子集调试服务"
            desc="Skiff 角色问答页（实验性；启停人工控制，仅监听 127.0.0.1）"
            control={<Toggle checked={skiffOn} onChange={(on) => toggle('skiffEnabled', on)} />}
          />
        </li>
        <li>
          <RowCard
            title="调试端口"
            desc="Skiff 问答页端口（1024 ~ 65535，默认 3099）"
            control={
              <div className="ss-threshold">
                <input
                  className="ss-portInput"
                  type="number"
                  min={1024}
                  max={65535}
                  value={skiffPort}
                  disabled={!skiffOn}
                  onChange={(e) => setSkiffPort(Number(e.target.value))}
                />
              </div>
            }
          />
        </li>
      </Group>

      {/* F4c ACP + F4d 建议问答页（v1.26.x 实验性）：HTTP JSON-RPC + 问答页（人工启停） */}
      <Group title="ACP / 建议问答">
        <li>
          <RowCard
            title="ACP JSON-RPC 端点"
            desc="程序化调用 Skiff 角色（指定 CCC+角色+会话；实验性，仅监听 127.0.0.1）"
            control={<Toggle checked={acpOn} onChange={(on) => toggle('acpEnabled', on)} />}
          />
        </li>
        <li>
          <RowCard
            title="建议问答页"
            desc="按认知容器暴露问答页供他人验证（需 key；首次开启自动生成固定 key，见 ~/.dsh/serenity-hooks.json）"
            control={<Toggle checked={publicAskOn} onChange={(on) => toggle('publicAskEnabled', on)} />}
          />
        </li>
        <li>
          <RowCard
            title="HTTP 端口"
            desc="ACP JSON-RPC + 问答页共用端口（1024 ~ 65535，默认 3100）"
            control={
              <div className="ss-threshold">
                <input
                  className="ss-portInput"
                  type="number"
                  min={1024}
                  max={65535}
                  value={acpPort}
                  disabled={!acpOn && !publicAskOn}
                  onChange={(e) => setAcpPort(Number(e.target.value))}
                />
              </div>
            }
          />
        </li>
      </Group>

      {/* v1.26.2：建议问答页配置（开放容器白名单 + key/地址展示；plugin 全局 /serenity/config + /serenity/cccs） */}
      <div className="ss-group">
        <h3 className="ss-groupTitle">建议问答</h3>
        <PublicAskEditor publicAskOn={publicAskOn} />
      </div>

      {/* 复杂配置（账号 + 工作区白名单）：plugin 全局文件 /serenity/config */}
      <div className="ss-group">
        <h3 className="ss-groupTitle">外部访问</h3>
        <AccountsEditor gatewayOn={gatewayOn} />
      </div>

      {/* v1.23.1 彩蛋：persona 模式（替换输出约束/指令遵循约束；plugin 全局文件） */}
      <div className="ss-group">
        <h3 className="ss-groupTitle">彩蛋模式</h3>
        <PersonaEditor />
      </div>

      {/* Autopilot Trajectory（v1.27.4 正式版；v1.26.14 起面板状态——用户"给CCC的面板加个状态来看情况"；
          数据源 GET /serenity/autopilot-trajectory：配置摘要 + 目标会话 + 窗口/预算/可唤起判定 + 审计） */}
      <div className="ss-group">
        <h3 className="ss-groupTitle">Autopilot Trajectory</h3>
        <AutopilotTrajectoryStatusBlock />
      </div>

      {/* F4c-3 微信桥（v1.27.0 实验性）：CCC 级配置——显式 CCC 选择器 + 扫码绑定 +
          账号/路由/开关（S142 用户拍板：配置归 CCC，管理面收敛到 CCC 面板） */}
      <div className="ss-group">
        <h3 className="ss-groupTitle">微信桥</h3>
        <WeixinBridgeEditor />
      </div>
    </div>
  )
}

/** /serenity/autopilot-trajectory 状态 wire（与 src/autopilot-trajectory.ts getAutopilotStatus 对齐） */
interface AutopilotTrajectoryStatus {
  configured: boolean
  enabled: boolean
  intervalHours: number
  maxDailyWakes: number
  biasProvider: string
  topPrompt: string | null
  session: string | null
  avoidWakeHours: { start: number; end: number }
  target: {
    dirName: string
    autoFlag: boolean
    idleHours: number
    wakeable: boolean
  } | null
  beijingHour: number
  windowAllowed: boolean
  recentWakes: Array<{ time: number; ok: boolean; detail: string }>
}

/** CCC 选择器条目（/serenity/cccs wire：SkiffCccEntry 同款——微信桥同源复用） */
interface AutopilotCccEntry {
  root: string
  name: string
  roles: string[]
}

/** 「Autopilot Trajectory」只读状态区块（v1.26.14；v1.27.4 多 CCC：显式 CCC 选择器——
 *   GET/POST 带 ?ccc=/body.ccc——用户"两个 CCC 都设定了，但手工唤起只能唤起一个"修复）：
 *   展示所选 CCC 的状态（配置摘要 + 目标会话 + 窗口/预算/可唤起判定 + 审计）；配置改走 CCC 配置文件 */
function AutopilotTrajectoryStatusBlock(): React.JSX.Element {
  const [cccs, setCccs] = useState<AutopilotCccEntry[]>([])
  const [selectedRoot, setSelectedRoot] = useState<string>('')
  const [status, setStatus] = useState<AutopilotTrajectoryStatus | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [waking, setWaking] = useState(false)
  const [wakeResult, setWakeResult] = useState<string | null>(null)

  // 加载 CCC 列表（选择器数据源——同微信桥 /serenity/cccs discoverCccs）
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const res = await fetch('/serenity/cccs', { headers: { accept: 'application/json' } })
        if (!res.ok) return
        const body = (await res.json()) as { cccs?: AutopilotCccEntry[] }
        if (!alive || !Array.isArray(body.cccs)) return
        setCccs(body.cccs)
        if (body.cccs.length > 0) setSelectedRoot((prev) => prev || body.cccs![0]!.root)
        else setUnavailable(true) // 无候选 CCC → 提示
      } catch {
        /* 拉取失败静默（面板非关键路径） */
      }
    })()
    return () => { alive = false }
  }, [])

  // 选中 CCC 变化 → 拉取该 CCC 状态（显式 ?ccc=——多 CCC 各自独立）
  const refresh = useCallback(async (): Promise<void> => {
    if (!selectedRoot) return
    try {
      const res = await fetch(`/serenity/autopilot-trajectory?ccc=${encodeURIComponent(selectedRoot)}`, { headers: { accept: 'application/json' } })
      if (!res.ok) return
      const body = (await res.json()) as { status?: AutopilotTrajectoryStatus | null }
      if (body.status) {
        setStatus(body.status)
        setUnavailable(false)
      } else {
        setStatus(null)
        setUnavailable(true) // 选中 CCC 无配置（未启用）→ 显示提示
      }
    } catch {
      /* 拉取失败静默（面板非关键路径） */
    }
  }, [selectedRoot])

  useEffect(() => {
    let alive = true
    void refresh()
    return () => { alive = false }
  }, [refresh])

  // 立即唤起（调试用，跳过窗口/间隔/预算；服务端 force=true 仍校验 enabled/目标/--auto/偏见脚本）
  const wakeNow = async (): Promise<void> => {
    if (waking || !selectedRoot) return
    setWaking(true)
    setWakeResult(null)
    try {
      const res = await fetch('/serenity/autopilot-trajectory', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-serenity-ui': '1' },
        body: JSON.stringify({ action: 'wake', ccc: selectedRoot }),
      })
      const body = (await res.json()) as { ok?: boolean; detail?: string; error?: string }
      setWakeResult(body.detail ?? body.error ?? `HTTP ${res.status}`)
      void refresh()
    } catch (err) {
      setWakeResult(err instanceof Error ? err.message : String(err))
    } finally {
      setWaking(false)
    }
  }

  if (unavailable && cccs.length === 0) {
    return (
      <ul className="ss-rows">
        <li>
          <RowCard
            title="未激活"
            desc="未发现候选 CCC（/serenity/cccs 为空）——先在工作区打开一个 CCC 会话"
            control={null}
          />
        </li>
      </ul>
    )
  }
  if (!status) {
    return (
      <ul className="ss-rows">
        <li>
          <RowCard title="加载中…" desc="读取 Autopilot Trajectory 状态" control={null} />
        </li>
      </ul>
    )
  }

  const target = status.target
  const stateText = !status.configured
    ? '未配置（机制未开始）'
    : !status.enabled
      ? '已配置，未启用（enabled=false，零资源占用）'
      : '已启用 — 时钟唤起等待中'
  const targetText = target
    ? `${target.dirName}${target.autoFlag ? '（--auto ✓）' : '（无 --auto 标志）'} · 空闲 ${target.idleHours.toFixed(1)}h / 阈值 ${status.intervalHours}h`
    : status.session
      ? `会话 ${status.session} 未命中（AGENT_SESSIONS 无匹配）`
      : '未配置目标会话（不唤起）'
  // 调试按钮可用条件：已启用 + 目标会话就绪（配置命中且带 --auto）；偏见脚本校验由服务端 force 兜底
  const wakeReady = status.enabled && !!target && target.autoFlag
  const lastWake = status.recentWakes[0]

  return (
    <ul className="ss-rows">
      <li>
        <RowCard
          title="目标 CCC"
          desc="多 CCC 各自独立——选中哪个就查看/唤起哪个"
          control={
            <select
              className="ss-select"
              value={selectedRoot}
              onChange={(e) => {
                setSelectedRoot(e.target.value)
                setStatus(null) // 切换 CCC → 回到加载态（refresh 随 selectedRoot 触发）
              }}
            >
              {cccs.length === 0 && <option value="">加载中…</option>}
              {cccs.map((c) => (
                <option key={c.root} value={c.root}>{c.name || c.root}</option>
              ))}
            </select>
          }
        />
      </li>
      <li>
        <RowCard
          title="运行状态"
          desc={stateText}
          control={<span className="ss-value">{status.enabled ? '● 运行中' : status.configured ? '○ 待启' : '—'}</span>}
        />
      </li>
      <li>
        <RowCard
          title="目标会话"
          desc={targetText}
          control={target?.wakeable ? <span className="ss-value">可唤起</span> : null}
        />
      </li>
      <li>
        <RowCard
          title="唤起窗口"
          desc={`当前北京 ${status.beijingHour} 点 — ${status.windowAllowed ? '允许唤起' : `高峰避开中（${status.avoidWakeHours.start}~${status.avoidWakeHours.end}）`}`}
          control={null}
        />
      </li>
      <li>
        <RowCard
          title="每日预算"
          desc={`${status.maxDailyWakes} 次/日上限（防失控 + 控成本）`}
          control={null}
        />
      </li>
      <li>
        <RowCard
          title="偏见提供者"
          desc={status.biasProvider}
          control={null}
        />
      </li>
      <li>
        <RowCard
          title="轨迹焦点 (topPrompt)"
          desc={status.topPrompt ? status.topPrompt : '未定义——CCC 定义 autopilotTrajectory 时应填写本轨迹核心焦点（防多轮唤起焦点丢失）'}
          control={null}
        />
      </li>
      <li>
        <RowCard
          title="最近唤起（审计）"
          desc={lastWake ? `${new Date(lastWake.time).toLocaleString()} — ${lastWake.ok ? '✓' : '✗'} ${lastWake.detail}` : '尚无唤起记录'}
          control={null}
        />
      </li>
      <li>
        <RowCard
          title="立即唤起"
          desc={wakeResult ?? '调试：手动触发一次唤起（跳过窗口/间隔/预算，仍校验配置与偏见脚本）'}
          control={
            <button
              type="button"
              className="ss-wakeBtn"
              disabled={!wakeReady || waking}
              onClick={() => void wakeNow()}
            >
              {waking ? '唤起中…' : '立即唤起'}
            </button>
          }
        />
      </li>
    </ul>
  )
}
