/**
 * SettingsSection.tsx — dsh 原生设置面板的 serenity-hooks 简单配置页（v1.21 分层）
 *
 * 分层决策：简单配置（三功能开关 + F2 阈值）→ dsh 原生设置面板；
 * 账号列表（复杂配置）→ 宁静号高级面板（SafeModePanel 扩展）。
 *
 * 数据通道：ctx.settingsScope.bind({ namespace: 'serenity-hooks' })——
 * host 侧 registerSettingsSection 注册的 namespace；写经 scope.set(field, value)
 * （settings.yaml 持久化 + revision fencing）。
 *
 * 降级守卫（版本鲁棒性）：snapshot.status === 'unavailable' 表示本客户端
 * 读不到该 namespace（旧 RC 白名单 / memory 模式）→ 显示降级提示
 * （引导去宁静号高级面板），不渲染表单。新 RC 自动获得完整表单。
 */

import type {} from '@deepseek-ai/dsh-client-ui-settings'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope, SettingsScopeSpec } from '@deepseek-ai/dsh-client-runtime/client'
import { useEffect, useMemo, useState } from 'react'
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
      <p className="ss-note">简单配置（开关/阈值）。账号列表等复杂配置请到会话头部 Serenity 徽章「高级设定」面板。</p>

      <label className="ss-row">
        <span className="ss-label">F1 双端口网关</span>
        <span className="ss-desc">额外监听端口 + 网页登录（外部访问）</span>
        <input type="checkbox" checked={gatewayOn} onChange={(e) => toggle('gatewayEnabled', e.target.checked)} />
      </label>

      <label className="ss-row">
        <span className="ss-label">F2 超限重建</span>
        <span className="ss-desc">上下文接近上限时提示 session_rebuild 清空重建</span>
        <input type="checkbox" checked={rebuildOn} onChange={(e) => toggle('rebuildEnabled', e.target.checked)} />
      </label>

      <label className="ss-row">
        <span className="ss-label">重建阈值</span>
        <span className="ss-desc">contextPressure 触发比例（0.01~1）</span>
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
      </label>

      <label className="ss-row">
        <span className="ss-label">F3 会话命名</span>
        <span className="ss-desc">dsh 会话创建时自动命名 S###-日期</span>
        <input type="checkbox" checked={namingOn} onChange={(e) => toggle('namingEnabled', e.target.checked)} />
      </label>
    </div>
  )
}
