/**
 * AccountsEditor.tsx — DSH 设置面板「外部访问」区块（v1.22 重构 + v1.22.4 完善）
 *
 * 归属原则（v1.22 用户拍板）：账号密码/工作区白名单是 **plugin 级配置**，
 * 统一在 DSH 设置面板（plugin 层）设定——本组件即该设定面。
 * 数据：GET/PUT /serenity/config（accounts-api.ts；服务端 scrypt hash，
 * 存 ~/.dsh/serenity-hooks.json plugin 全局文件）。
 *
 * 内容：
 *  - 监听设置：gateway host/port + Secure Cookie（HTTPS 反代时）
 *  - 外部能力：允许新建工作区 / 启用 Authenticator 第二因素
 *  - 登录账号：账号列表 CRUD（含密码 + TOTP 绑定/解绑）
 *  - 工作区白名单：**从已有工作区选择**（v1.22.4 需求 1；非手输）
 */

import { useEffect, useState } from 'react'
import {
  AccountDraft,
  WireConfig,
  WireAccount,
  accountDraftFromWire,
  accountToWire,
  fetchConfig,
  fetchWorkspaces,
  newAccountId,
  newTotpSecret,
  otpauthUriClient,
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
  const [cookieSecure, setCookieSecure] = useState(false)
  const [allowWorkspaceCreate, setAllowWorkspaceCreate] = useState(true)
  const [totpEnabled, setTotpEnabled] = useState(false)
  // 需求 1：已有工作区列表（workspace.list 拉取；v1.22.6 修复信封后正常加载，无手输兜底）
  const [knownWorkspaces, setKnownWorkspaces] = useState<{ path: string; title: string }[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let alive = true
    void Promise.all([fetchConfig(), fetchWorkspaces()]).then(([cfg, wss]) => {
      if (!alive) return
      setKnownWorkspaces(wss)
      if (cfg) {
        setConfig(cfg)
        setHost(cfg.gateway.host)
        setPort(cfg.gateway.port)
        setDrafts(cfg.gateway.accounts.map(accountDraftFromWire))
        setWorkspaces(cfg.gateway.workspaces ?? [])
        setCookieSecure(cfg.gateway.cookieSecure === true)
        setAllowWorkspaceCreate(cfg.gateway.allowWorkspaceCreate !== false)
        setTotpEnabled(cfg.gateway.totpEnabled === true)
      }
      setLoaded(true)
    })
    return () => { alive = false }
  }, [])

  const updateDraft = (id: string, patch: Partial<AccountDraft>): void => {
    setDrafts((ds) => ds.map((d) => (d.id === id ? { ...d, ...patch } : d)))
  }

  const addRow = (): void => {
    setDrafts((ds) => [...ds, { id: newAccountId(), user: '', pass: '', isNew: true, hasPassword: false, hasTotp: false, totpState: 'none' }])
  }

  const removeRow = (id: string): void => {
    setDrafts((ds) => ds.filter((d) => d.id !== id))
  }

  // v1.22.4 TOTP：生成新 secret 进入待确认态
  const startTotpBind = (d: AccountDraft): void => {
    const secret = newTotpSecret()
    updateDraft(d.id, { totpState: 'pending', totpSecret: secret, totpConfirm: '' })
  }

  // 取消 TOTP 绑定（回到无操作态）
  const cancelTotpBind = (d: AccountDraft): void => {
    updateDraft(d.id, { totpState: d.hasTotp ? 'none' : 'none', totpSecret: undefined, totpConfirm: '' })
  }

  // 标记解绑（保存时提交 totpReset）
  const markTotpClear = (d: AccountDraft): void => {
    updateDraft(d.id, { totpState: 'clear', totpSecret: undefined, totpConfirm: '' })
  }

  // 需求 1：从已有工作区添加（下拉选择）
  const toggleWorkspace = (path: string): void => {
    setWorkspaces((ws) => (ws.includes(path) ? ws.filter((w) => w !== path) : [...ws, path]))
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
          cookieSecure,
          allowWorkspaceCreate,
          totpEnabled,
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
        {/* v1.22.4 S7：cookieSecure——反代 TLS（HTTPS）时开启；明文 HTTP 下必须关闭 */}
        <label className="ae-check">
          <input type="checkbox" checked={cookieSecure} onChange={(e) => setCookieSecure(e.target.checked)} />
          <span>Secure Cookie（仅 HTTPS 反代时开启；明文 HTTP 下关闭，否则登录态不生效）</span>
        </label>
      </div>

      {/* ── 外部能力（v1.22.4 完善需求）── */}
      <div className="ae-block">
        <h4 className="ae-title">外部能力</h4>
        <label className="ae-check">
          <input type="checkbox" checked={allowWorkspaceCreate} onChange={(e) => setAllowWorkspaceCreate(e.target.checked)} />
          <span>允许外部新建工作区（关闭后经外部网关的 workspace.create 一律拒绝；仅使用已有工作区）</span>
        </label>
        <label className="ae-check">
          <input type="checkbox" checked={totpEnabled} onChange={(e) => setTotpEnabled(e.target.checked)} />
          <span>启用 Authenticator 第二因素（关闭时 TOTP 完全禁用；开启后可对账号绑定验证器，登录需输入 6 位码）</span>
        </label>
      </div>

      {/* ── 登录账号 ── */}
      <div className="ae-block">
        <h4 className="ae-title">登录账号</h4>
        <div className="ae-list">
          <div className="ae-head">
            <span className="ae-col ae-colUser">用户名</span>
            <span className="ae-col ae-colPass">密码</span>
            {totpEnabled && <span className="ae-col ae-colTotp">第二因素</span>}
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
              {/* v1.22.4 TOTP 列（totpEnabled 关闭时隐藏——需求 3 可配置） */}
              {totpEnabled && (
                <span className="ae-col ae-colTotp">
                  {d.totpState === 'pending' ? (
                    <span className="ae-totpPending">
                      <code className="ae-totpSecret" title="录入到 Authenticator（Google Authenticator / 1Password / Aegis）">{d.totpSecret}</code>
                      <a className="ae-totpUri" href={d.totpSecret ? otpauthUriClient(d.totpSecret, `${d.user.trim() || 'user'}@serenity`) : '#'} target="_blank" rel="noreferrer">otpauth://</a>
                      <input
                        className="ae-input ae-totpConfirm"
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]{6}"
                        maxLength={6}
                        value={d.totpConfirm ?? ''}
                        placeholder="输入验证码确认"
                        onChange={(e) => updateDraft(d.id, { totpConfirm: e.target.value })}
                      />
                      <button type="button" className="ae-del" onClick={() => cancelTotpBind(d)}>取消</button>
                    </span>
                  ) : d.totpState === 'clear' ? (
                    <span className="ae-totpClear">
                      <span className="ae-totpBadge">将解绑</span>
                      <button type="button" className="ae-del" onClick={() => updateDraft(d.id, { totpState: 'none' })}>撤销</button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="ae-totpBtn"
                      onClick={() => (d.hasTotp ? markTotpClear(d) : startTotpBind(d))}
                      title={d.hasTotp ? '已绑定验证器——点击解绑' : '绑定 Authenticator 第二因素'}
                    >
                      {d.hasTotp ? '✓ 已绑定' : '绑定验证器'}
                    </button>
                  )}
                </span>
              )}
              <button type="button" className="ae-del" onClick={() => removeRow(d.id)}>删除</button>
            </div>
          ))}
          <button type="button" className="ae-add" onClick={addRow}>+ 添加账号</button>
        </div>
      </div>

      {/* ── 工作区白名单（需求 1：从已有工作区选择）── */}
      <div className="ae-block">
        <h4 className="ae-title">工作区白名单</h4>
        <p className="ae-desc">允许外部访问的已有工作区；未选择 = 全部允许。登录后仅白名单内的工作区可见/可用。</p>
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
        {knownWorkspaces.length === 0 ? (
          <p className="ae-note">暂无可选工作区（workspace.list 未返回条目）</p>
        ) : (
          <select
            className="ae-input ae-wsSelect"
            value=""
            onChange={(e) => { if (e.target.value !== '') toggleWorkspace(e.target.value) }}
          >
            <option value="" disabled>选择已有工作区…</option>
            {knownWorkspaces.map((w) => (
              <option key={w.path} value={w.path}>{w.title}</option>
            ))}
          </select>
        )}
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
