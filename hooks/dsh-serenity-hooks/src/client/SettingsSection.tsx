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
import { useEffect, useState } from 'react'
import { AccountsEditor } from './AccountsEditor.js'
import { PersonaEditor } from './PersonaEditor.js'
import './SettingsSection.css'

/** serenity-hooks 简单配置 wire 形态（与 host 侧 schema 对齐） */
export interface SerenitySimpleWire {
  gatewayEnabled?: boolean
  rebuildEnabled?: boolean
  rebuildThreshold?: number
  namingEnabled?: boolean
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
  const namingOn = value?.namingEnabled ?? true
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

      <Group title="会话">
        <li>
          <RowCard
            title="会话命名"
            desc="使用宁静号会话时，把当前会话命名为 SESSION 目录名"
            control={<Toggle checked={namingOn} onChange={(on) => toggle('namingEnabled', on)} />}
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
    </div>
  )
}
