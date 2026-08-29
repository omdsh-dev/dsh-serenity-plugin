/**
 * PublicAskEditor.tsx — 建议问答页配置（v1.26.2，S142 用户需求）
 *
 * 功能：
 *  - **开放容器白名单**：从 /serenity/cccs 拉取候选容器，chips 选择哪些开放；
 *    空白名单 = 全部容器开放（向后兼容 v1.26.1 全局开放语义）。
 *  - **key + 地址展示**：经 /serenity/public-ask 获取访问 key 与各开放容器 URL
 *    （用户：配置处需能获取 key 和地址——管理员复制分享给使用者）。
 *
 * 数据通道（plugin 全局）：
 *  - GET /serenity/cccs       候选容器（node half discoverCccs）
 *  - GET /serenity/public-ask key + 地址（x-serenity-ui 头）
 *  - PUT /serenity/config     publicAsk.allowed 白名单保存（accounts-api saveConfig）
 */
import { useEffect, useState } from 'react'
import { fetchConfig, saveConfig } from './accounts-api.js'

interface CccEntry {
  root: string
  name: string
  roles: string[]
}

interface PublicAskInfo {
  enabled: boolean
  port: number
  key: string
  allowed: string[]
  urls: { name: string; url: string }[]
  listUrl: string
}

export function PublicAskEditor(props: { publicAskOn: boolean }): React.JSX.Element {
  const { publicAskOn } = props
  const [candidates, setCandidates] = useState<CccEntry[]>([])
  const [allowed, setAllowed] = useState<string[] | null>(null) // null = 未加载
  const [info, setInfo] = useState<PublicAskInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [rotating, setRotating] = useState(false)

  // v1.26.5 轮换 key（用户：不好说要换 key 呢——生成新 key，旧 key 立即失效）
  const rotateKey = async (): Promise<void> => {
    if (!window.confirm('重新生成访问 Key？旧 Key 将立即失效，需要重新分享给使用者。')) return
    setRotating(true)
    setError(null)
    try {
      const res = await fetch('/serenity/public-ask', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-serenity-ui': '1' },
        body: JSON.stringify({ action: 'rotate' }),
      })
      if (!res.ok) throw new Error(`轮换失败（${res.status}）`)
      const body = (await res.json()) as { key: string }
      setInfo((cur) => (cur ? { ...cur, key: body.key } : cur))
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRotating(false)
    }
  }

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const cfg = await fetchConfig()
        if (!alive) return
        setAllowed(cfg?.publicAsk?.allowed ?? [])
      } catch {
        /* 配置加载失败保持 null */
      }
    })()
    return () => { alive = false }
  }, [])

  // 候选容器（面板打开时拉取；与开关状态无关——白名单可在关闭时预配置）
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const res = await fetch('/serenity/cccs', { headers: { accept: 'application/json' } })
        if (!res.ok) return
        const body = (await res.json()) as { cccs?: CccEntry[] }
        if (alive) setCandidates(body?.cccs ?? [])
      } catch {
        /* 候选拉取失败静默（手输不可行——白名单按容器名匹配，候选是唯一来源） */
      }
    })()
    return () => { alive = false }
  }, [])

  // key + 地址（开关打开时拉取展示；用户需求：配置处获取 key 和地址）
  useEffect(() => {
    if (!publicAskOn) return
    let alive = true
    void (async () => {
      try {
        const res = await fetch('/serenity/public-ask', { headers: { accept: 'application/json', 'x-serenity-ui': '1' } })
        if (!res.ok) return
        const body = (await res.json()) as PublicAskInfo
        if (alive) setInfo(body)
      } catch {
        /* 信息拉取失败静默 */
      }
    })()
    return () => { alive = false }
  }, [publicAskOn])

  const toggleAllowed = (name: string): void => {
    setAllowed((cur) => {
      const base = cur ?? []
      return base.includes(name) ? base.filter((n) => n !== name) : [...base, name]
    })
  }

  const save = async (): Promise<void> => {
    if (allowed === null) return
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const cfg = await saveConfig({ publicAsk: { allowed } })
      if (cfg) {
        setAllowed(cfg.publicAsk.allowed ?? [])
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const allOpen = (allowed ?? []).length === 0

  return (
    <div className="ae-root">
      {!publicAskOn && (
        <p className="ae-warn">⚠️ 建议问答页当前关闭——先开启上方「建议问答页」开关，外部访问才生效。</p>
      )}

      {/* ── 开放容器白名单（v1.26.2 用户：按容器权限控制）── */}
      <div className="ae-block">
        <h4 className="ae-title">开放容器</h4>
        <p className="ae-desc">
          允许外部问答的认知容器（URL：/c/&lt;容器名&gt;）。<strong>未选择 = 全部容器开放</strong>；
          选择后仅白名单内容器可访问。
        </p>
        {candidates.length === 0 ? (
          <p className="ae-note">暂无可选容器（/serenity/cccs 未返回条目——先在工作区打开一个 CCC）</p>
        ) : (
          <div className="ae-chips">
            {candidates.map((c) => {
              const on = (allowed ?? []).includes(c.name)
              return (
                <button
                  key={c.name}
                  type="button"
                  className={`ae-chip${on ? ' ae-chipOn' : ''}`}
                  onClick={() => toggleAllowed(c.name)}
                  title={`${c.root}（${c.roles.length} 角色）`}
                >
                  {c.name}{on ? ' ✓' : ''}
                </button>
              )
            })}
          </div>
        )}
        <div className="ae-actions">
          <button type="button" className="ae-save" disabled={busy || allowed === null} onClick={() => void save()}>
            {busy ? '保存中…' : '保存白名单'}
          </button>
          {saved && <span className="ae-saved">✓ 已保存</span>}
          {error && <span className="ae-err">{error}</span>}
        </div>
        {allOpen && allowed !== null && (
          <p className="ae-note">当前为「全部开放」——所有发现到的认知容器都可问答。</p>
        )}
      </div>

      {/* ── key + 地址（v1.26.2 用户：配置处需能获取 key 和地址）── */}
      {publicAskOn && (
        <div className="ae-block">
          <h4 className="ae-title">访问 Key 与地址</h4>
          {info ? (
            <>
              <p className="ae-desc">把下面的 key 与地址分享给使用者；key 已自动保存在其浏览器（localStorage）。</p>
              <div className="ae-row">
                <span className="ae-label">访问 Key</span>
                <code className="ae-key">{info.key}</code>
                <button
                  type="button"
                  className="ae-copy"
                  onClick={() => { void navigator.clipboard?.writeText(info.key) }}
                >
                  复制
                </button>
                <button type="button" className="ae-copy ae-rotate" disabled={rotating} onClick={() => void rotateKey()}>
                  {rotating ? '生成中…' : '重新生成'}
                </button>
              </div>
              <div className="ae-row">
                <span className="ae-label">容器列表页</span>
                <code className="ae-key">{info.listUrl}</code>
                <button type="button" className="ae-copy" onClick={() => { void navigator.clipboard?.writeText(info.listUrl) }}>复制</button>
              </div>
              {info.urls.length > 0 && (
                <div className="ae-rows">
                  <span className="ae-label">各容器地址</span>
                  {info.urls.map((u) => (
                    <div key={u.name} className="ae-row">
                      <span className="ae-label ae-labelDim">{u.name}</span>
                      <code className="ae-key">{u.url}</code>
                      <button type="button" className="ae-copy" onClick={() => { void navigator.clipboard?.writeText(u.url) }}>复制</button>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <p className="ae-note">开启后此处显示访问 key 与地址…</p>
          )}
        </div>
      )}
    </div>
  )
}
