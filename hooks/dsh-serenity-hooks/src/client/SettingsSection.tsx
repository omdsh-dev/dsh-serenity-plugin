/**
 * SettingsSection.tsx — dsh 原生设置面板的 serenity-hooks 简单配置页（v1.21 分层）
 *
 * 分层决策：简单配置（三功能开关 + F2 阈值）→ dsh 原生设置面板；
 * 账号列表（复杂配置）→ 宁静号高级面板（SafeModePanel Modal）。
 *
 * 数据通道：ctx.settingsScope.bind({ namespace: 'serenity-hooks' })——
 * host 侧 registerSettingsSection 注册的 namespace；写经 scope.set(field, value)
 * （settings.yaml 持久化 + revision fencing）。
 *
 * UI（v1.21.1 看齐 dsh 自身）：官方 settings 设计语言——
 * `section > title(h2) + intro + 分组(groupTitle) + rowCard 行卡`，
 * 多级标题（页面标题 → 分组标题 → 行卡标题/说明），全部 --dsw-alias-* token，
 * 与 ui-settings-models 等官方页面同视觉词汇。
 *
 * 降级守卫（版本鲁棒性）：snapshot.status === 'unavailable' 表示本客户端
 * 读不到该 namespace（旧 RC 白名单 / memory 模式）→ 显示降级提示。
 */

import type {} from '@deepseek-ai/dsh-client-ui-settings'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope, SettingsScopeSpec } from '@deepseek-ai/dsh-client-runtime/client'
import { useEffect, useState } from 'react'
import './SettingsSection.css'

/** serenity-hooks 简单配置 wire 形态（与 host 侧 schema 对齐） */
export interface SerenitySimpleWire {
  gatewayEnabled?: boolean
  rebuildEnabled?: boolean
  rebuildThreshold?: number
  namingEnabled?: boolean
}

/** 本 section 的注入面（apply 闭包提供 settingsScope） */
export interface SettingsSectionInjected {
  scope: SettingsScope<SerenitySimpleWire>
}

export type SettingsSectionProps = PropsRuntime<'settings.section'> & SettingsSectionInjected

/** 降级提示文案（旧 RC 白名单时引导去宁静号面板） */
const DEGRADE_NOTE =
  '当前运行版本未暴露 serenity-hooks 配置（旧 RC 白名单）。请在会话头部 Serenity 徽章的「高级设定」面板中管理，或升级 DSH。'

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

/** dsh 原生设置面板：serenity-hooks 简单配置页（官方 settings 设计语言，多级标题） */
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
  const namingOn = value?.namingEnabled ?? true

  return (
    <div className="ss-section">
      <h2 className="ss-title">Serenity</h2>
      <p className="ss-intro">
        宁静号的开关与阈值，改动即时保存（DSH settings.yaml）。账号密码等复杂配置请到会话头部「Serenity」卡片 → 高级设定 → 账号。
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

      <Group title="会话">
        <li>
          <RowCard
            title="会话命名"
            desc="使用宁静号会话时，把当前会话命名为 SESSION 目录名"
            control={<Toggle checked={namingOn} onChange={(on) => toggle('namingEnabled', on)} />}
          />
        </li>
      </Group>

      <p className="ss-hint">💡 双端口网关需先在「Serenity 卡片 → 账号」里添加账号并设置监听端口。</p>
    </div>
  )
}
