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
 * UX（截图反馈 v1.21.1 重构）：分组卡片布局——每组「标题 + 说明」一列、
 * 开关独立在右侧一行；滑块独立成行（值与文字留间距）；去掉 F1/F2/F3 代号
 * （用功能名直写）；顶部引导 + 底部帮助行（"这怎么用"问题）。
 *
 * 降级守卫（版本鲁棒性）：snapshot.status === 'unavailable' 表示本客户端
 * 读不到该 namespace（旧 RC 白名单 / memory 模式）→ 显示降级提示，
 * 不渲染表单。新 RC 自动获得完整表单。
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

/** 一个配置组（开关 + 说明） */
function ToggleGroup(props: {
  title: string
  desc: string
  checked: boolean
  disabled?: boolean
  onChange: (on: boolean) => void
}): React.JSX.Element {
  const { title, desc, checked, disabled, onChange } = props
  return (
    <div className="ss-group">
      <div className="ss-groupText">
        <span className="ss-groupTitle">{title}</span>
        <span className="ss-groupDesc">{desc}</span>
      </div>
      <label className="ss-switch">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="ss-switchTrack" />
      </label>
    </div>
  )
}

/** dsh 原生设置面板：serenity-hooks 简单配置页 */
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

  // 降级：namespace 未暴露（旧 RC 白名单 / memory 模式）
  if (!ready) {
    return (
      <div className="ss-degrade">
        <p>{DEGRADE_NOTE}</p>
      </div>
    )
  }

  const gatewayOn = value?.gatewayEnabled ?? false
  const rebuildOn = value?.rebuildEnabled ?? true
  const threshold = value?.rebuildThreshold ?? 0.9
  const namingOn = value?.namingEnabled ?? true

  return (
    <div className="ss-root">
      <p className="ss-note">
        这里管理宁静号的简单开关与阈值，保存后立即生效（DSH settings.yaml）。
        账号密码等复杂配置请到会话头部「Serenity」卡片 → 高级设定 → 账号。
      </p>

      <div className="ss-groups">
        <ToggleGroup
          title="双端口网关"
          desc="额外监听一个端口，登录后可从外部访问 Web UI"
          checked={gatewayOn}
          onChange={(on) => toggle('gatewayEnabled', on)}
        />
        <ToggleGroup
          title="超限重建"
          desc="上下文接近上限时提示调用 session_rebuild 清空重建"
          checked={rebuildOn}
          onChange={(on) => toggle('rebuildEnabled', on)}
        />
        <div className="ss-group">
          <div className="ss-groupText">
            <span className="ss-groupTitle">重建阈值</span>
            <span className="ss-groupDesc">上下文占用达到该比例时提示（0.10 ~ 1.00）</span>
          </div>
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
        </div>
        <ToggleGroup
          title="会话命名"
          desc="使用宁静号会话时，把当前会话命名为 SESSION 目录名"
          checked={namingOn}
          onChange={(on) => toggle('namingEnabled', on)}
        />
      </div>

      <p className="ss-help">💡 改动即时保存；双端口网关需先在「Serenity 卡片 → 账号」里添加账号并设置监听端口。</p>
    </div>
  )
}
