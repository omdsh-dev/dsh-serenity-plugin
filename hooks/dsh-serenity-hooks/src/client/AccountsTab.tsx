/**
 * AccountsTab.tsx — 高级面板「账号」tab（v1.21 复杂配置层）
 *
 * 承载复杂配置：gateway 监听 host/port + 账号列表 CRUD（含密码）。
 * 简单配置（开关/阈值）在 dsh 原生设置面板（SettingsSection）——本 tab 仅提示引导。
 * 数据：GET/PUT /serenity/config（accounts-api.ts）；无滚动条约束（紧凑布局）。
 */

import { useEffect, useMemo, useState } from 'react'
import {
  AccountDraft,
  WireConfig,
  WireAccount,
  accountDraftFromWire,
  accountToWire,
  fetchConfig,
  newAccountId,
  saveConfig,
  validateDraft,
} from './accounts-api.js'
import './AccountsTab.css'

export interface AccountsTabProps {
  sessionId: string
}

export function AccountsTab(props: AccountsTabProps): React.JSX.Element {
  const { sessionId } = props
  const [config, setConfig] = useState<WireConfig | null>(null)
  const [drafts, setDrafts] = useState<AccountDraft[]>([])
  const [host, setHost] = useState('0.0.0.0')
  const [port, setPort] = useState(3081)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let alive = true
    void fetchConfig(sessionId).then((cfg) => {
      if (!alive) return
      if (cfg) {
        setConfig(cfg)
        setHost(cfg.gateway.host)
        setPort(cfg.gateway.port)
        setDrafts(cfg.gateway.accounts.map(accountDraftFromWire))
      }
      setLoaded(true)
    })
    return () => { alive = false }
  }, [sessionId])

  const updateDraft = (id: string, patch: Partial<AccountDraft>): void => {
    setDrafts((ds) => ds.map((d) => (d.id === id ? { ...d, ...patch } : d)))
  }

  const addRow = (): void => {
    setDrafts((ds) => [...ds, { id: newAccountId(), user: '', pass: '', isNew: true, hasPassword: false }])
  }

  const removeRow = (id: string): void => {
    setDrafts((ds) => ds.filter((d) => d.id !== id))
  }

  const save = async (): Promise<void> => {
    // 校验全部行
    for (const d of drafts) {
      const err = validateDraft(d)
      if (err) {
        setError(err)
        return
      }
    }
    setBusy(true)
    setError(null)
    try {
      const cfg = await saveConfig(sessionId, {
        gateway: {
          host,
          port,
          accounts: drafts.map(accountToWire),
        },
      })
      if (cfg) {
        setConfig(cfg)
        setDrafts(cfg.gateway.accounts.map(accountDraftFromWire))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (!loaded) return <div className="at-root"><p className="at-note">加载中…</p></div>

  return (
    <div className="at-root">
      <p className="at-note">
        复杂配置（账号密码）。开关/阈值等简单配置请到 dsh 设置面板「Serenity」页。
      </p>

      <div className="at-row">
        <span className="at-label">监听地址</span>
        <input className="at-input" value={host} onChange={(e) => setHost(e.target.value)} placeholder="0.0.0.0" />
        <span className="at-label">端口</span>
        <input className="at-input at-port" type="number" value={port} min={1} max={65535} onChange={(e) => setPort(Number(e.target.value) || 0)} />
      </div>

      <div className="at-list">
        <div className="at-head">
          <span className="at-col at-colUser">用户名</span>
          <span className="at-col at-colPass">密码</span>
          <span className="at-col at-colOp" />
        </div>
        {drafts.map((d) => (
          <div key={d.id} className="at-item">
            <input
              className="at-input at-colUser"
              value={d.user}
              placeholder="用户名"
              onChange={(e) => updateDraft(d.id, { user: e.target.value })}
            />
            <input
              className="at-input at-colPass"
              type="password"
              value={d.pass}
              placeholder={d.isNew ? '必填' : d.hasPassword ? '留空保留原密码' : '未设置'}
              onChange={(e) => updateDraft(d.id, { pass: e.target.value })}
            />
            <button type="button" className="at-del" onClick={() => removeRow(d.id)}>删除</button>
          </div>
        ))}
        <button type="button" className="at-add" onClick={addRow}>+ 添加账号</button>
      </div>

      {error !== null && <p className="at-error">{error}</p>}

      <div className="at-actions">
        <button type="button" className="at-save" disabled={busy} onClick={() => void save()}>
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  )
}
