/**
 * AccountsEditor.tsx — DSH 设置面板「外部访问」区块（v1.22 重构）
 *
 * 归属原则（v1.22 用户拍板）：账号密码/工作区白名单是 **plugin 级配置**，
 * 统一在 DSH 设置面板（plugin 层）设定——本组件即该设定面。
 * 数据：GET/PUT /serenity/config（accounts-api.ts；服务端 scrypt hash，
 * 存 ~/.dsh/serenity-hooks.json plugin 全局文件）。
 *
 * 内容：
 *  - 监听设置：gateway host/port
 *  - 登录账号：账号列表 CRUD（含密码）
 *  - 工作区白名单：允许外部访问的工作区路径前缀（空 = 全部允许）
 */

import { useEffect, useState } from 'react'
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
import './AccountsEditor.css'

export interface AccountsEditorProps {
  /** 双端口网关开关（显示提示用） */
  gatewayOn: boolean
}

export function AccountsEditor(props: AccountsEditorProps): React.JSX.Element {
  const { gatewayOn } = props
  const [config, setConfig] = useState<WireConfig | null>(null)
  const [drafts, setDrafts] = useState<AccountDraft[]>([])
  const [host, setHost] = useState('0.0.0.0')
  const [port, setPort] = useState(3081)
  const [workspaces, setWorkspaces] = useState<string[]>([])
  const [wsInput, setWsInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let alive = true
    void fetchConfig().then((cfg) => {
      if (!alive) return
      if (cfg) {
        setConfig(cfg)
        setHost(cfg.gateway.host)
        setPort(cfg.gateway.port)
        setDrafts(cfg.gateway.accounts.map(accountDraftFromWire))
        setWorkspaces(cfg.gateway.workspaces ?? [])
      }
      setLoaded(true)
    })
    return () => { alive = false }
  }, [])

  const updateDraft = (id: string, patch: Partial<AccountDraft>): void => {
    setDrafts((ds) => ds.map((d) => (d.id === id ? { ...d, ...patch } : d)))
  }

  const addRow = (): void => {
    setDrafts((ds) => [...ds, { id: newAccountId(), user: '', pass: '', isNew: true, hasPassword: false }])
  }

  const removeRow = (id: string): void => {
    setDrafts((ds) => ds.filter((d) => d.id !== id))
  }

  const addWorkspace = (): void => {
    const v = wsInput.trim()
    if (v === '') return
    if (!workspaces.includes(v)) setWorkspaces((ws) => [...ws, v])
    setWsInput('')
  }

  const removeWorkspace = (v: string): void => {
    setWorkspaces((ws) => ws.filter((w) => w !== v))
  }

  const save = async (): Promise<void> => {
    // 校验全部账号行
    for (const d of drafts) {
      const err = validateDraft(d)
      if (err) {
        setError(err)
        return
      }
    }
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const cfg = await saveConfig({
        gateway: {
          host,
          port,
          accounts: drafts.map(accountToWire),
          workspaces,
        },
      })
      if (cfg) {
        setConfig(cfg)
        setDrafts(cfg.gateway.accounts.map(accountDraftFromWire))
        setWorkspaces(cfg.gateway.workspaces ?? [])
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (!loaded) return <p className="ae-note">加载中…</p>

  return (
    <div className="ae-root">
      {!gatewayOn && (
        <p className="ae-warn">⚠️ 双端口网关当前关闭——先开启上方「双端口网关」开关，外部访问才生效。</p>
      )}

      {/* ── 监听设置 ── */}
      <div className="ae-block">
        <h4 className="ae-title">监听设置</h4>
        <div className="ae-row">
          <span className="ae-label">监听地址</span>
          <input className="ae-input" value={host} onChange={(e) => setHost(e.target.value)} placeholder="0.0.0.0" />
          <span className="ae-label">端口</span>
          <input className="ae-input ae-port" type="number" value={port} min={1} max={65535} onChange={(e) => setPort(Number(e.target.value) || 0)} />
        </div>
      </div>

      {/* ── 登录账号 ── */}
      <div className="ae-block">
        <h4 className="ae-title">登录账号</h4>
        <div className="ae-list">
          <div className="ae-head">
            <span className="ae-col ae-colUser">用户名</span>
            <span className="ae-col ae-colPass">密码</span>
            <span className="ae-col ae-colOp" />
          </div>
          {drafts.map((d) => (
            <div key={d.id} className="ae-item">
              <input
                className="ae-input ae-colUser"
                value={d.user}
                placeholder="用户名"
                onChange={(e) => updateDraft(d.id, { user: e.target.value })}
              />
              <input
                className="ae-input ae-colPass"
                type="password"
                value={d.pass}
                placeholder={d.isNew ? '必填' : d.hasPassword ? '留空保留原密码' : '未设置'}
                onChange={(e) => updateDraft(d.id, { pass: e.target.value })}
              />
              <button type="button" className="ae-del" onClick={() => removeRow(d.id)}>删除</button>
            </div>
          ))}
          <button type="button" className="ae-add" onClick={addRow}>+ 添加账号</button>
        </div>
      </div>

      {/* ── 工作区白名单 ── */}
      <div className="ae-block">
        <h4 className="ae-title">工作区白名单</h4>
        <p className="ae-desc">允许外部访问的工作区路径前缀；留空 = 全部允许。登录后仅白名单内的工作区可见/可用。</p>
        <div className="ae-wsList">
          {workspaces.length === 0 ? (
            <p className="ae-note">（全部允许）</p>
          ) : (
            workspaces.map((w) => (
              <span key={w} className="ae-wsChip">
                <code className="ae-wsPath">{w}</code>
                <button type="button" className="ae-wsDel" onClick={() => removeWorkspace(w)} aria-label={`移除 ${w}`}>×</button>
              </span>
            ))
          )}
        </div>
        <div className="ae-row">
          <input
            className="ae-input"
            value={wsInput}
            placeholder="例如 /home/yh/home/home-serenity"
            onChange={(e) => setWsInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addWorkspace() } }}
          />
          <button type="button" className="ae-add ae-wsAdd" onClick={addWorkspace}>添加</button>
        </div>
      </div>

      {error !== null && <p className="ae-error">{error}</p>}

      <div className="ae-actions">
        <button type="button" className="ae-save" disabled={busy} onClick={() => void save()}>
          {busy ? '保存中…' : saved ? '✓ 已保存' : '保存'}
        </button>
      </div>
    </div>
  )
}
