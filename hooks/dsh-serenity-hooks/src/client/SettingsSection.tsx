/**
 * SettingsSection.tsx — dsh 原生设置面板的 serenity-hooks 配置页（v1.22 重构）
 *
 * 归属原则（v1.22 用户拍板）：**plugin 是全局的，CCC 是具体的**——
 * 账号密码/开关/阈值/工作区白名单都是 **plugin 级配置**，统一在 DSH 设置面板
 * （plugin 层）设定；CCC 状态栏面板（SafeModePanel）只展示状态。
 *
 * 页面结构（官方 settings 设计语言：section > title + intro + 分组(groupTitle) + rowCard）：
 *  - 访问：双端口网关开关（展开 → 完整外部访问编辑器：监听/账号/白名单/TOTP）
 *  - 上下文：超限重建开关（展开 → 阈值 + 机制说明）
 *  - 外部能力：Skiff/ACP/问答页各开关（展开 → help 说明 + 各自编辑器）
 *  - 彩蛋模式 / 微信桥：独立配置块（无顶层 plugin 开关，保留折叠）
 * v1.29（需求② 开关与详设合一）：RowCard 可展开——整行点击 → 行内内联详设；
 *   原 hover「?」浮层 help 改行内 detail intro（常显可达）；重型编辑器挂所属开关行下。
 *
 * 数据通道（双层）：
 *  - 简单配置：ctx.settingsScope.bind({ namespace: 'serenity-hooks' })（settings.yaml）
 *  - 复杂配置（账号/白名单）：同源 HTTP /serenity/config（accounts-api.ts，服务端 scrypt hash）
 *
 * 降级守卫：snapshot.status === 'unavailable'（旧 RC 白名单）→ 降级提示。
 */

import type {} from '@deepseek-ai/dsh-client-ui-settings'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// v1.28.0 适配 0.1.2-rc.1（A1）：dsh-client-runtime 包已删 → SettingsScope/SettingsScopeSpec
// 改从 '@deepseek-ai/dsh-client-ui-settings/client'（官方再导出实证；dsp 用法 getSnapshot/
// subscribe/set 与 rc.1 SettingsScope 接口 getSnapshot/subscribe/mutate/set/unset 完全一致）
import type { SettingsScope, SettingsScopeSpec } from '@deepseek-ai/dsh-client-ui-settings/client'
import { useEffect, useState } from 'react'
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
  /** **唤醒调度器闸**（v1.34，原 trajectoryEnabled）：投递已登记的"未来时刻 + 一条 message"（缺省开） */
  wakeSchedulerEnabled?: boolean
}

/** 本 section 的注入面（apply 闭包提供 settingsScope） */
export interface SettingsSectionInjected {
  scope: SettingsScope<SerenitySimpleWire>
}

type SettingsSectionProps = PropsRuntime<'settings.section'> & SettingsSectionInjected

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
 *  help：可选——desc 下方渲染「?」帮助浮层（hover/焦点显示三行以上严谨说明）
 *  expandable：可选——整行点击展开 detail 内联详设（需求②：开关与详设合一）。
 *    点击行（标题/desc 区）toggle 展开态；detail 渲染在行内下方（含 help 内容 +
 *    该功能全部配置项/重型编辑器）。展开时行头右置 ▾ 指示。 */
function RowCard(props: {
  title: string
  desc: string
  control: React.ReactNode
  help?: string
  expandable?: boolean
  /** 受控展开态（外部持有 state 时）；缺省内部自管理 */
  open?: boolean
  onToggle?: (open: boolean) => void
  /** 展开后渲染的内联详设（需求②）——help 文本 + 配置编辑器 */
  detail?: React.ReactNode
  /** 展开态标题右置提示（如 "配置"/"详情"） */
  expandHint?: string
}): React.JSX.Element {
  const { title, desc, control, help, expandable, detail } = props
  const isControlled = props.open !== undefined
  const [selfOpen, setSelfOpen] = useState(false)
  const open = isControlled ? !!props.open : selfOpen

  const toggle = (): void => {
    if (!expandable) return
    if (isControlled) props.onToggle?.(!open)
    else setSelfOpen(!open)
  }

  return (
    <div className={`ss-rowCard${expandable ? ' ss-expandable' : ''}${expandable && open ? ' ss-expanded' : ''}`}>
      <div className="ss-rowText" role={expandable ? 'button' : undefined} tabIndex={expandable ? 0 : undefined}
        onClick={toggle}
        onKeyDown={(e) => { if (expandable && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle() } }}>
        <span className="ss-rowName">
          {title}
          {expandable && <span className="ss-expandMark" aria-hidden>{open ? '▾' : '▸'}</span>}
        </span>
        <span className="ss-rowDesc">{desc}</span>
        {help && !expandable && (
          <span className="ss-help">
            <button type="button" className="ss-helpMark" aria-label={`${title} 帮助`}>?</button>
            <span className="ss-helpTip">{help}</span>
          </span>
        )}
      </div>
      <div className="ss-rowControl">{control}</div>
      {expandable && open && detail !== undefined && (
        <div className="ss-rowDetail">{detail}</div>
      )}
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
  const wakeSchedOn = value?.wakeSchedulerEnabled ?? true // 缺省开（与 schema 一致）

  // 需求②：可展开行受控状态（默认网关/重建/问答页展开——首个详设可见引导用户理解）
  const [openGateway, setOpenGateway] = useState(false)
  const [openRebuild, setOpenRebuild] = useState(false)
  const [openSkiff, setOpenSkiff] = useState(false)
  const [openAcp, setOpenAcp] = useState(false)
  const [openPublicAsk, setOpenPublicAsk] = useState(false)
  const [openWakeSched, setOpenWakeSched] = useState(false)

  return (
    <div className="ss-section">
      <h2 className="ss-title">Serenity</h2>
      <p className="ss-intro">
        宁静号的 plugin 级配置（全局生效，不依赖具体 CCC）。点击任一行展开该功能的详细设定；改动即时保存。
      </p>

      <Group title="访问">
        <li>
          <RowCard
            title="双端口网关"
            desc="额外监听端口 3081，登录后可从外部访问 Web UI"
            expandable
            open={openGateway}
            onToggle={setOpenGateway}
            expandHint="配置"
            control={<Toggle checked={gatewayOn} onChange={(on) => toggle('gatewayEnabled', on)} />}
            detail={
              <div className="ss-detailStack">
                <p className="ss-detailIntro">{'双端口网关（端口 3081）让外网/局域网用户经登录页访问本 DSH Web UI：\n' +
                  '· 适用范围：跨网络访问（本机默认端口 3080 仅监听本机）\n' +
                  '· 安全：登录账号 + 可选 TOTP 第二因素\n' +
                  '· 工作区白名单：登录后仅白名单内工作区可见（可留空=全部）\n' +
                  '· 变更立即生效（热重建，无需重启）'}
                </p>
                <AccountsEditor gatewayOn={gatewayOn} />
              </div>
            }
          />
        </li>
      </Group>

      <Group title="上下文">
        <li>
          <RowCard
            title="超限重建"
            desc="上下文接近上限时提示调用 container_trajectory rebuild 清空重建"
            expandable
            open={openRebuild}
            onToggle={setOpenRebuild}
            expandHint="配置"
            control={<Toggle checked={rebuildOn} onChange={(on) => toggle('rebuildEnabled', on)} />}
            detail={
              <div className="ss-detailStack">
                <p className="ss-detailIntro">{'上下文超限自动重建（container_trajectory rebuild，v1.33 起 logbook 并入 trajectory）：\n' +
                  '· 机制：agent 上下文占用达到阈值时，由 LLM 主动调用重建\n' +
                  '· 语义：完全丢弃当前 dsh 会话 + 自动新建 + 注入「继续原 SESSION 的工作」\n' +
                  '· 效果：SESSION.md 原位不动，认知轨迹延续，上下文归零\n' +
                  '· 关闭后：上下文超限时不再提示，可能导致会话卡顿或丢失'}
                </p>
                <RowCard
                  title="重建阈值"
                  desc="上下文占用达到该 K 数值时提示（单位 K token，默认 400）"
                  help={'重建触发阈值（需求①：K 数值，默认 400K，范围 50~4000K）：\n' +
                    '· 含义：上下文 projected tokens 达到 thresholdK × 1000 时触发提醒\n' +
                    '· 纯绝对数值（不再依赖窗口比例）\n' +
                    '· 迁移：旧版 0~1 比例（settings.yaml rebuildThreshold）已废弃被忽略\n' +
                    '· 调低更早触发 / 调高更晚触发；仅「超限重建」开启时有意义'}
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
              </div>
            }
          />
        </li>
      </Group>

      {/* 外部能力开关组（v1.27.5 紧凑化；v1.29 需求②：每行可展开——help 入 detail intro） */}
      <Group title="外部能力">
        <li>
          <RowCard
            title="Skiff 调试"
            desc="Skiff 认知子集问答页（端口 3099，实验性，127.0.0.1）"
            expandable
            open={openSkiff}
            onToggle={setOpenSkiff}
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
            detail={
              <p className="ss-detailIntro">{'Skiff 认知子集角色调试服务（端口 3099）：\n' +
                '· 概念：Skiff = 完整宁静号 trajectory 的任意子集（认知子集角色）\n' +
                '· 服务：角色问答页（调试用），仅监听 127.0.0.1（本地）\n' +
                '· 使用：配置 CCC 的 skiff.roles 角色后，可经此页以角色身份问答\n' +
                '· 实验性：人工启停，默认关闭；对外问答请用「Skiff 问答页」'}
              </p>
            }
          />
        </li>
        <li>
          <RowCard
            title="ACP JSON-RPC"
            desc="程序化调用 Skiff 角色（端口 3100，实验性，127.0.0.1）"
            expandable
            open={openAcp}
            onToggle={setOpenAcp}
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
            detail={
              <p className="ss-detailIntro">{'ACP（Agent Client Protocol）HTTP JSON-RPC 端点（端口 3100）：\n' +
                '· 作用：程序化调用 Skiff 角色（指定 CCC + 角色 + 会话）\n' +
                '· 形态：HTTP JSON-RPC 服务，仅监听 127.0.0.1（本地）\n' +
                '· 场景：IM 桥（如微信桥）、脚本、自动化接线\n' +
                '· 实验性：人工启停，默认关闭；与「Skiff 问答页」共用端口'}
              </p>
            }
          />
        </li>
        <li>
          <RowCard
            title="Skiff 问答页"
            desc="按认知容器暴露问答页（端口 3100，需 key）"
            expandable
            open={openPublicAsk}
            onToggle={setOpenPublicAsk}
            control={<Toggle checked={publicAskOn} onChange={(on) => toggle('publicAskEnabled', on)} />}
            detail={
              <div className="ss-detailStack">
                <p className="ss-detailIntro">{'Skiff 问答页（对外问答，端口 3100，key 认证）：\n' +
                  '· 作用：让外部用户在浏览器中与指定 CCC 的 Skiff 角色对话\n' +
                  '· 认证：访问 key（首次开启自动生成）\n' +
                  '· 授权：开放容器白名单（未选 = 全部开放）\n' +
                  '· 外部接入：需经部署方自选方案暴露（隧道/反代/端口映射）\n' +
                  '· 安全：key 可轮换（旧 key 立即失效）'}
                </p>
                <PublicAskEditor publicAskOn={publicAskOn} />
              </div>
            }
          />
        </li>
        <li>
          <RowCard
            title="唤醒调度器（条目来源：send-later）"
            desc="投递已登记的“未来时刻 + 一条 message”（全局开关，默认开）"
            expandable
            open={openWakeSched}
            onToggle={setOpenWakeSched}
            control={<Toggle checked={wakeSchedOn} onChange={(on) => toggle('wakeSchedulerEnabled', on)} />}
            detail={
              <div className="ss-detailStack">
                <p className="ss-detailIntro">{'唤醒调度器全局闸（v1.34 独立开关）：\n' +
                  '· 作用：把 CCC 唤醒注册表（AGENT_SESSIONS/wake-registry.json）里到点的条目投递给目标轨迹\n' +
                  '· 条目来源：`container_trajectory send-later`（对自己或别的 trajectory 预约未来时刻 + 一条 message）\n' +
                  '· 默认开：条目全部由人类/agent 显式登记，无环境自主性 ⇒ 不需要“默认关”的实验保护\n' +
                  '· 唯一性：ACC 现存的**唯一**轨迹调度时钟（原并列的周期自唤醒闸已随 ACC 侧 autopilot 退场删除）\n' +
                  '· 精度：5min tick；补跑窗口 2h（超窗判 missed 留痕）；fire-and-forget 无回执'}
                </p>
              </div>
            }
          />
        </li>
      </Group>

      {/* 彩蛋 persona（无顶层 plugin 开关——独立配置块，保留折叠） */}
      <Collapse title="彩蛋模式" desc="persona 输出风格（默认关闭）">
        <PersonaEditor />
      </Collapse>

      {/* F4c-3 微信桥（v1.27.0 实验性）：CCC 级配置——无顶层 plugin 开关
          （CCC 级 enabled），保留独立折叠块；内部行已用可展开详设 */}
      <Collapse title="微信桥" desc="扫码绑定微信账号 · 路由到 skiff 角色（CCC 级配置）">
        <WeixinBridgeEditor />
      </Collapse>

      {/* 旧会话清理（v1.29 需求③）：DSH 平台会话（对话历史）手动清理——lastActive 基准 + 物理删 */}
      <Collapse title="会话清理" desc="删除指定天数前无活动的 DSH 会话（手动，物理删不可恢复）">
        <SessionCleanupBlock />
      </Collapse>
    </div>
  )
}

/** /serenity/session-cleanup 清理预览 wire（与 api.ts 对齐） */
interface CleanupPreview {
  root: string
  olderThanDays: number
  count: number
  candidates: Array<{ id: string; project: string; lastActive: string }>
}

/** 清理执行结果 wire */
interface CleanupDone {
  deleted: string[]
  errors: Array<{ id: string; reason: string }>
}

/** 「会话清理」块（v1.29 需求③，S142 用户拍板：lastActive + 手动按钮 + 直接物理删）：
 *  天数输入 → GET 预览（dryRun 列表）→ 确认 → POST 执行。live 会话由服务端保护跳过。 */
function SessionCleanupBlock(): React.JSX.Element {
  const [days, setDays] = useState(30)
  const [preview, setPreview] = useState<CleanupPreview | null>(null)
  const [done, setDone] = useState<CleanupDone | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const previewNow = async (): Promise<void> => {
    setBusy(true); setError(null); setDone(null)
    try {
      const res = await fetch(`/serenity/session-cleanup?olderThanDays=${days}`, { headers: { accept: 'application/json', 'x-serenity-ui': '1' } })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        setError(body?.error ?? `HTTP ${res.status}`)
        return
      }
      setPreview((await res.json()) as CleanupPreview)
      setConfirming(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const execute = async (): Promise<void> => {
    if (!confirming) { setConfirming(true); return } // 第一击 → 确认态
    setBusy(true); setError(null)
    try {
      const res = await fetch(`/serenity/session-cleanup?olderThanDays=${days}`, {
        method: 'POST',
        headers: { accept: 'application/json', 'x-serenity-ui': '1' },
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        setError(body?.error ?? `HTTP ${res.status}`)
        return
      }
      setDone((await res.json()) as CleanupDone)
      setPreview(null)
      setConfirming(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ss-detailStack">
      <RowCard
        title="删除前无活动天数"
        desc="删除最后活动早于该天数的 DSH 会话（默认 30）"
        help={'会话清理阈值（v1.29，S142 用户拍板 lastActive 基准）：\n' +
          '· 含义：删除「最后活动早于 N 天前」的 DSH 平台会话（对话历史）\n' +
          '· lastActive = 会话日志文件最后写入时间（日志只追加，mtime 可靠）\n' +
          '· live 保护：正在运行的会话绝不删除（服务端强制跳过）\n' +
          '· 物理删不可恢复——先「预览」确认列表再执行'}
        control={
          <input
            className="ss-portInput"
            type="number"
            min={1}
            max={3650}
            step={1}
            value={days}
            title="删除前无活动天数（默认 30）"
            onChange={(e) => { setDays(Math.min(3650, Math.max(1, Math.round(Number(e.target.value) || 30)))); setPreview(null); setDone(null); setConfirming(false) }}
          />
        }
      />
      {error && <p className="ss-error">{error}</p>}
      {preview && (
        <div className="ss-detailIntro">
          {preview.count === 0
            ? `无早于 ${preview.olderThanDays} 天前无活动的会话可清理（root: ${preview.root}）`
            : `将删除 ${preview.count} 个会话（root: ${preview.root}）：\n` + preview.candidates.map((c) => `  · ${c.id}（${c.project}，最后活动 ${new Date(c.lastActive).toLocaleDateString()}）`).join('\n')}
        </div>
      )}
      {done && (
        <div className="ss-detailIntro">
          {`已删除 ${done.deleted.length} 个会话${done.errors.length > 0 ? `；${done.errors.length} 个失败（${done.errors.map((e) => `${e.id}: ${e.reason}`).join('; ')}）` : ''}`}
        </div>
      )}
      <div className="ss-switchRow">
        <button type="button" className="ss-wakeBtn" disabled={busy} onClick={() => void previewNow()}>
          {busy ? '处理中…' : preview ? '刷新预览' : '预览将删会话'}
        </button>
        {preview && preview.count > 0 && (
          <button type="button" className="ss-removeBtn" disabled={busy} onClick={() => void execute()}>
            {confirming ? '确认物理删除（不可恢复）' : '执行删除'}
          </button>
        )}
        {done && <button type="button" className="ss-wakeBtn" onClick={() => { setPreview(null); setDone(null) }}>完成</button>}
      </div>
    </div>
  )
}
