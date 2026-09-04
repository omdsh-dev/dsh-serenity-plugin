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
  rebuildThresholdK?: number
  /** F4 Skiff（v1.25.0 实验性）：认知子集角色调试服务启停 + 端口 */
  skiffEnabled?: boolean
  skiffDebugPort?: number
  /** F4c ACP（v1.26.0 实验性）：HTTP JSON-RPC 端点启停 + 端口 */
  acpEnabled?: boolean
  acpHttpPort?: number
  /** F4d 建议问答页（v1.26.1 实验性）：按认知容器暴露问答页供他人验证（key 认证） */
  publicAskEnabled?: boolean
  /** Autopilot Trajectory 全局总开关（v1.27.9，默认关——只在指定电脑开启） */
  autopilotEnabled?: boolean
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

/** 一个配置行卡（官方 rowCard：标题+说明 左列 / 控件右置）
 *  help：可选——desc 下方渲染「?」帮助浮层（hover/焦点显示三行以上严谨说明） */
function RowCard(props: {
  title: string
  desc: string
  control: React.ReactNode
  help?: string
}): React.JSX.Element {
  const { title, desc, control, help } = props
  return (
    <div className="ss-rowCard">
      <div className="ss-rowText">
        <span className="ss-rowName">{title}</span>
        <span className="ss-rowDesc">{desc}</span>
        {help && (
          <span className="ss-help">
            <button type="button" className="ss-helpMark" aria-label={`${title} 帮助`}>?</button>
            <span className="ss-helpTip">{help}</span>
          </span>
        )}
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

/** 折叠组（details/summary：默认收起，点开展开——v1.27.5 紧凑化） */
function Collapse(props: {
  title: string
  desc?: string
  open?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const { title, desc, open, children } = props
  return (
    <details className="ss-collapse" open={open}>
      <summary className="ss-collapseHead">
        <span className="ss-collapseTitle">{title}</span>
        {desc && <span className="ss-collapseDesc">{desc}</span>}
      </summary>
      <div className="ss-collapseBody">{children}</div>
    </details>
  )
}

/** 只读定义列表（dl/dt/dd 网格——v1.27.5 紧凑化：只读状态不再各占一行卡） */
function DefList(props: { items: Array<{ term: string; value: React.ReactNode }> }): React.JSX.Element {
  const { items } = props
  return (
    <dl className="ss-defList">
      {items.map((it) => (
        <div className="ss-defItem" key={it.term}>
          <dt className="ss-defTerm">{it.term}</dt>
          <dd className="ss-defValue">{it.value}</dd>
        </div>
      ))}
    </dl>
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
    // 需求①：K 数值（默认 400K；范围 50~4000，纯绝对无窗口比例保护）
    void scope.set('rebuildThresholdK', Math.min(4000, Math.max(50, Math.round(v))))
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
  const thresholdK = value?.rebuildThresholdK ?? 400
  const skiffOn = value?.skiffEnabled ?? false
  const skiffPort = value?.skiffDebugPort ?? 3099
  const acpOn = value?.acpEnabled ?? false
  const acpPort = value?.acpHttpPort ?? 3100
  const publicAskOn = value?.publicAskEnabled ?? false
  const autopilotOn = value?.autopilotEnabled ?? false

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
            desc="额外监听端口 3081，登录后可从外部访问 Web UI"
            help={'双端口网关（端口 3081）让外网/局域网用户经登录页访问本 DSH Web UI：\n' +
              '· 适用范围：跨网络访问（本机默认端口 3080 仅监听本机）\n' +
              '· 安全：登录账号 + 可选 TOTP 第二因素（见「外部访问」）\n' +
              '· 工作区白名单：登录后仅白名单内工作区可见（可留空=全部）\n' +
              '· 变更立即生效（热重建，无需重启）'}
            control={<Toggle checked={gatewayOn} onChange={(on) => toggle('gatewayEnabled', on)} />}
          />
        </li>
      </Group>

      <Group title="上下文">
        <li>
          <RowCard
            title="超限重建"
            desc="上下文接近上限时提示调用 session_rebuild 清空重建"
            help={'上下文超限自动重建（session_rebuild）：\n' +
              '· 机制：agent 上下文占用达到阈值时，由 LLM 主动调用重建工具\n' +
              '· 语义：完全丢弃当前 dsh 会话 + 自动新建 + 注入「继续原 SESSION 的工作」\n' +
              '· 效果：SESSION.md 原位不动，认知轨迹延续，上下文归零\n' +
              '· 关闭后：上下文超限时不再提示，可能导致会话卡顿或丢失'}
            control={<Toggle checked={rebuildOn} onChange={(on) => toggle('rebuildEnabled', on)} />}
          />
        </li>
        <li>
          <RowCard
            title="重建阈值"
            desc="上下文占用达到该 K 数值时提示（单位 K token，默认 400）"
            help={'重建触发阈值（需求①：K 数值，默认 400K，范围 50~4000K）：\n' +
              '· 含义：上下文 projected tokens 达到 thresholdK × 1000 时，轨迹跟踪器开始提醒重建\n' +
              '· 纯绝对数值（不再依赖窗口比例）——配多大就多大，无窗口上限保护\n' +
              '· 调低：更早触发（适合长任务，避免上下文耗尽前措手不及）\n' +
              '· 调高：更晚触发（适合短对话，减少不必要的重建提示）\n' +
              '· 仅「超限重建」开启时有意义'}
            control={
              <input
                className="ss-portInput"
                type="number"
                min={50}
                max={4000}
                step={50}
                value={thresholdK}
                disabled={!rebuildOn}
                title="重建阈值（K token，默认 400）"
                onChange={(e) => setThreshold(Number(e.target.value))}
              />
            }
          />
        </li>
      </Group>

      {/* 外部能力开关组（v1.27.5 紧凑化：Skiff/ACP/建议问答合并为一行一个开关，端口内联） */}
      <Group title="外部能力">
        <li>
          <RowCard
            title="Skiff 调试"
            desc="Skiff 认知子集问答页（端口 3099，实验性，127.0.0.1）"
            help={'Skiff 认知子集角色调试服务（端口 3099）：\n' +
              '· 概念：Skiff = 完整宁静号 trajectory 的任意子集（认知子集角色）\n' +
              '· 服务：角色问答页（调试用），仅监听 127.0.0.1（本地）\n' +
              '· 使用：配置 CCC 的 skiff.roles 角色后，可经此页以角色身份问答\n' +
              '· 实验性：人工启停，默认关闭；对外问答请用「Skiff 问答页」'}
            control={
              <span className="ss-switchRow">
                <Toggle checked={skiffOn} onChange={(on) => toggle('skiffEnabled', on)} />
                <input
                  className="ss-portInput"
                  type="number"
                  min={1024}
                  max={65535}
                  value={skiffPort}
                  disabled={!skiffOn}
                  title="Skiff 调试端口（默认 3099）"
                  onChange={(e) => setSkiffPort(Number(e.target.value))}
                />
              </span>
            }
          />
        </li>
        <li>
          <RowCard
            title="ACP JSON-RPC"
            desc="程序化调用 Skiff 角色（端口 3100，实验性，127.0.0.1）"
            help={'ACP（Agent Client Protocol）HTTP JSON-RPC 端点（端口 3100）：\n' +
              '· 作用：程序化调用 Skiff 角色（指定 CCC + 角色 + 会话）\n' +
              '· 形态：HTTP JSON-RPC 服务，仅监听 127.0.0.1（本地）\n' +
              '· 场景：IM 桥（如微信桥）、脚本、自动化接线\n' +
              '· 实验性：人工启停，默认关闭；与「Skiff 问答页」共用端口'}
            control={
              <span className="ss-switchRow">
                <Toggle checked={acpOn} onChange={(on) => toggle('acpEnabled', on)} />
                <input
                  className="ss-portInput"
                  type="number"
                  min={1024}
                  max={65535}
                  value={acpPort}
                  disabled={!acpOn && !publicAskOn}
                  title="ACP + Skiff 问答共用端口（默认 3100）"
                  onChange={(e) => setAcpPort(Number(e.target.value))}
                />
              </span>
            }
          />
        </li>
        <li>
          <RowCard
            title="Skiff 问答页"
            desc="按认知容器暴露问答页（端口 3100，需 key）"
            help={'Skiff 问答页（对外问答，端口 3100，key 认证）：\n' +
              '· 作用：让外部用户在浏览器中与指定 CCC 的 Skiff 角色对话\n' +
              '· 认证：访问 key（首次开启自动生成，见 ~/.dsh/serenity-hooks.json）\n' +
              '· 授权：开放容器白名单（未选 = 全部开放；见「Skiff 问答页配置」）\n' +
              '· 外部接入：需经部署方自选方案暴露（隧道/反代/端口映射）\n' +
              '· 安全：key 可轮换（旧 key 立即失效）'}
            control={<Toggle checked={publicAskOn} onChange={(on) => toggle('publicAskEnabled', on)} />}
          />
        </li>
        <li>
          <RowCard
            title="Autopilot Trajectory"
            desc="自动巡航轨迹（全局开关，默认关——只在指定电脑开启）"
            help={'Autopilot Trajectory 全局总开关（v1.27.9）：\n' +
              '· 作用：控制本机（本 dsh 实例）是否运行自动巡航轨迹\n' +
              '· 默认关：未开启即使 CCC 配置 enabled=true 也不启动定时器\n' +
              '· 定位：多台电脑装 dsp 时，只在指定电脑开启（其余默认关）\n' +
              '· 双重门控：全局开关 AND CCC 级 enabled 都满足才运行\n' +
              '· CCC 级配置（interval/session/偏见脚本/焦点）不受影响'}
            control={<Toggle checked={autopilotOn} onChange={(on) => toggle('autopilotEnabled', on)} />}
          />
        </li>
      </Group>

      {/* 建议问答（v1.26.2 配置：开放容器白名单 + key/地址展示；v1.27.5 折叠默认收起） */}
      <Collapse title="Skiff 问答页配置" desc="开放容器白名单 · 访问 key 与地址">
        <PublicAskEditor publicAskOn={publicAskOn} />
      </Collapse>

      {/* 复杂配置（账号 + 工作区白名单）：plugin 全局文件 /serenity/config；v1.27.5 折叠 */}
      <Collapse title="外部访问" desc="网关监听（端口 3081）· 登录账号 · 工作区白名单（plugin 全局）">
        <AccountsEditor gatewayOn={gatewayOn} />
      </Collapse>

      {/* v1.23.1 彩蛋：persona 模式（替换输出约束/指令遵循约束；plugin 全局文件）；v1.27.5 折叠 */}
      <Collapse title="彩蛋模式" desc="persona 输出风格（默认关闭）">
        <PersonaEditor />
      </Collapse>

      {/* Autopilot Trajectory（v1.27.4 正式版；v1.26.14 起面板状态——用户"给CCC的面板加个状态来看情况"；
          数据源 GET /serenity/autopilot-trajectory：配置摘要 + 目标会话 + 窗口/可唤起判定 + 审计；
          v1.27.5 语义：折叠默认收起——用户"微信桥和 Autopilot trajectory 能否也收起来"；
          v1.27.9 全局开关 autopilotEnabled 在「外部能力」组——此处 desc 显示全局门控状态） */}
      <Collapse title="Autopilot Trajectory" desc={autopilotOn ? '全局已开启' : '全局关闭（外部能力组开启）'} >
        <AutopilotTrajectoryStatusBlock />
      </Collapse>

      {/* F4c-3 微信桥（v1.27.0 实验性）：CCC 级配置——显式 CCC 选择器 + 扫码绑定 +
          账号/路由/开关（S142 用户拍板：配置归 CCC，管理面收敛到 CCC 面板）；
          v1.27.5 语义：折叠默认收起 */}
      <Collapse title="微信桥" desc="扫码绑定微信账号 · 路由到 skiff 角色">
        <WeixinBridgeEditor />
      </Collapse>
    </div>
  )
}

/** /serenity/autopilot-trajectory 状态 wire（与 src/autopilot-trajectory.ts getAutopilotStatus 对齐） */
interface AutopilotTrajectoryStatus {
  configured: boolean
  enabled: boolean
  intervalHours: number
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
 *   展示所选 CCC 的状态（配置摘要 + 目标会话 + 窗口/可唤起判定 + 审计）；配置改走 CCC 配置文件 */
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

  // 立即唤起（调试用，跳过窗口/间隔；服务端 force=true 仍校验 enabled/目标/--auto/偏见脚本）
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
          help={'Autopilot Trajectory 目标认知容器：\n' +
            '· 机制：dsh 一个进程可挂载多个 CCC，每个 CCC 的 autopilot 独立配置\n' +
            '· 选择：下拉切换要查看/唤起的目标 CCC（各 CCC 时钟独立）\n' +
            '· 配置：各 CCC 在自身 .opencode/serenity.json 定义 autopilotTrajectory\n' +
            '· 唤起：仅对选中 CCC 生效，互不干扰'}
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
          help={'Autopilot Trajectory 运行状态含义：\n' +
            '· 未配置：该 CCC 未定义 autopilotTrajectory（机制不开始）\n' +
            '· 已配置未启用：enabled=false，零资源占用（不唤起不消耗）\n' +
            '· 已启用：时钟驱动周期性自动唤起——无人类活动满间隔小时数后\n' +
            '  启动一次前台 agent 轮（用户全程可见可介入）'}
          control={<span className="ss-value">{status.enabled ? '● 运行中' : status.configured ? '○ 待启' : '—'}</span>}
        />
      </li>
      <li>
        <div className="ss-rowCard">
          {/* v1.27.5 紧凑化：只读状态并入一个定义列表（2 列网格），不再各占一行卡 */}
          <DefList
            items={[
              { term: '目标会话', value: targetText },
              { term: '唤起窗口', value: `北京 ${status.beijingHour} 点 — ${status.windowAllowed ? '允许' : `避开 ${status.avoidWakeHours.start}~${status.avoidWakeHours.end}`}` },
              { term: '偏见提供者', value: status.biasProvider },
              { term: '轨迹焦点', value: status.topPrompt ?? '未定义（CCC 应填写，防焦点丢失）' },
              { term: '最近唤起', value: lastWake ? `${new Date(lastWake.time).toLocaleString()} — ${lastWake.ok ? '✓' : '✗'} ${lastWake.detail}` : '尚无' },
            ]}
          />
        </div>
      </li>
      <li>
        <RowCard
          title="立即唤起"
          desc={wakeResult ?? '调试：手动触发一次（跳过窗口/间隔，仍校验配置与偏见脚本）'}
          help={'立即唤起（调试语义）：\n' +
            '· 用途：手动触发一次该 CCC 的自动唤起（不等时钟）\n' +
            '· 跳过：唤起窗口（北京 8~18 点避开）/ 间隔\n' +
            '· 保留校验：enabled、目标会话（--auto）、偏见脚本可运行\n' +
            '· 场景：验证配置/偏见脚本是否就绪，或想立刻跑一轮'}
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
