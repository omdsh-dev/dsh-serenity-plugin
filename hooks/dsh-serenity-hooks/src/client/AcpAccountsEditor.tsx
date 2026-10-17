/**
 * AcpAccountsEditor.tsx — 「ACP 账户台账」配置区块（v1.59.2，owner 2026-10-17 令）
 *
 * ## 为什么要有它
 * owner 原话：「**面板里只放个开关不放具体的条目吗？**」
 * 面 E 那个总开关只管"端口开不开"，而**谁能连进来**在 CCC 的 `im.acp.accounts[]` 里。
 * 没有本区块时，加一台设备＝找人改 JSON ＋ 找 token —— 两件都不该由 owner 操心。
 *
 * ## 形状（照 `WeixinBridgeEditor`，不发明新范式）
 * - 顶部 **CCC 选择器**（数据源 `/serenity/cccs`）—— ACP 账户是 **CCC 级**数据，
 *   必须显式选目标，不靠"当前活跃会话"（面板是全局的，猜错就是改到别人家）
 * - 选中后：该 CCC 的通道状态 ＋ 账户表（可用性 ／ 角色 ／ token 指纹）
 * - 每条可：改（角色/开关）／删 ／**轮换 token**（唯一会让在用客户端断线的那一下）
 * - 新增：填 accountId ＋ 角色 ＋ 名字 ⇒ **保存即生成 token**，当场显示一次供抄走
 *
 * ## 🔴 两条安全纪律（写在这里，因为 UI 最容易违反）
 * ① **token 明文只在"刚生成"与"刚轮换"两处出现** —— 其余一律只显示指纹
 *    （服务端 `acpChannelStatus` 本来就不回明文；这里的 state 也只是短暂持有）
 * ② **删账户会同时删掉它的 token**（服务端做），所以删除是不可逆的：UI 必须二次确认
 */

import { useEffect, useState } from 'react'

/** CCC 选择器条目（`/serenity/cccs` wire） */
interface CccEntry {
  root: string
  name: string
  roles: string[]
}

/** 单个账户的可见形态（`acpChannelStatus().accounts[]` 同款） */
interface AcpAccountStatus {
  accountId: string
  name: string | null
  role: string | null
  enabled: boolean
  hasToken: boolean
  tokenFingerprint: string | null
  usable: boolean
  blockedBy: string | null
}

/** `/serenity/acp` GET wire */
interface AcpStatusWire {
  channel: 'weixin' | 'acp'
  enabled: boolean
  accounts: AcpAccountStatus[]
  roots: string[]
}

/** 新建账户的草稿 */
interface DraftAccount {
  accountId: string
  role: string
  name: string
}

const emptyDraft = (): DraftAccount => ({ accountId: '', role: '', name: '' })

export function AcpAccountsEditor(): React.JSX.Element {
  const [cccs, setCccs] = useState<CccEntry[]>([])
  const [selectedRoot, setSelectedRoot] = useState<string>('')
  const [status, setStatus] = useState<AcpStatusWire | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [draft, setDraft] = useState<DraftAccount>(emptyDraft())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 刚生成 ／ 刚轮换出来的明文 token（**只在这两种时机出现**；刷新即消失） */
  const [freshToken, setFreshToken] = useState<{ accountId: string; token: string } | null>(null)
  /** 待确认删除的 accountId（二次确认；删会连带删 token，不可逆） */
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)

  // ① 拉 CCC 列表（选择器数据源）
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const res = await fetch('/serenity/cccs', { headers: { accept: 'application/json' } })
        if (!res.ok) return
        const body = (await res.json()) as { cccs?: CccEntry[] }
        if (!alive || !Array.isArray(body.cccs)) return
        setCccs(body.cccs)
        if (body.cccs.length > 0) setSelectedRoot((prev) => prev || body.cccs![0]!.root)
      } catch {
        /* 拉取失败静默（选择器空着，用户能看到） */
      }
    })()
    return () => { alive = false }
  }, [])

  /** 读一次该 CCC 的 ACP 台账（供初次加载与每次写操作后刷新） */
  const reload = async (root: string): Promise<void> => {
    setLoadError(null)
    try {
      const res = await fetch(`/serenity/acp?ccc=${encodeURIComponent(root)}`, {
        headers: { accept: 'application/json', 'x-serenity-ui': '1' },
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        setLoadError(body?.error ?? `HTTP ${res.status}`)
        return
      }
      setStatus((await res.json()) as AcpStatusWire)
    } catch {
      /* 静默 */
    }
  }

  // ② 选中 CCC 变化 → 拉台账
  useEffect(() => {
    if (!selectedRoot) return
    let alive = true
    setStatus(null)
    void (async () => {
      if (alive) await reload(selectedRoot)
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRoot])

  /** 发一条写动作（三个 action 共用一条通道） */
  const post = async (payload: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/serenity/acp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-serenity-ui': '1' },
        body: JSON.stringify({ ccc: selectedRoot, ...payload }),
      })
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
      if (!res.ok) {
        setError(typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`)
        return null
      }
      await reload(selectedRoot)
      return body
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return null
    } finally {
      setBusy(false)
    }
  }

  const addAccount = async (): Promise<void> => {
    const accountId = draft.accountId.trim()
    if (accountId === '') { setError('账户 ID 必填（它同时是 token 的键名，如 agmente-phone）'); return }
    if (draft.role.trim() === '') { setError('角色必填（必须是本 CCC 已有的 skiff 角色）'); return }
    const body = await post({ action: 'upsert', account: { accountId, role: draft.role.trim(), name: draft.name.trim() || undefined } })
    if (body) {
      // 服务端只在**首次生成**时回明文；已存在的账户不回 ⇒ 那时不显示（因为用户手上已有）
      if (typeof body.token === 'string' && body.token !== '') setFreshToken({ accountId, token: body.token })
      setDraft(emptyDraft())
    }
  }

  const rotate = async (accountId: string): Promise<void> => {
    const body = await post({ action: 'rotate', accountId })
    if (body && typeof body.token === 'string') setFreshToken({ accountId, token: body.token })
  }

  const remove = async (accountId: string): Promise<void> => {
    await post({ action: 'remove', accountId })
    setConfirmRemove(null)
  }

  /** 该 CCC 已有的角色（新增账户时作为候选；避免手打出静默失败的角色名） */
  const rolesForSelected = cccs.find((c) => c.root === selectedRoot)?.roles ?? []

  return (
    <div className="ss-detailStack">
      <div className="ss-detailIntro">
        {'ACP 账户台账（每台客户端一条：一枚 token ↔ 一个角色）\n' +
          '· 连接归属哪个 CCC 由 **token** 决定（服务端权威），不看客户端填什么\n' +
          '· 加一台设备 = 这里加一条 ⇒ **token 随即自动生成**，保存后当场显示一次，抄进客户端即可\n' +
          '· 客户端地址：ws://<本机IP>:3200  ＋ Authorization: Bearer <token>（或用 ?token=<token>）\n' +
          '  working directory 也可以只填目录名 —— ACC 会按 token 归属自动归到该 CCC 根\n' +
          '· 「轮换」会让**在用的那台立刻断线** ⇒ 只在怀疑泄露时按；「删除」连带删 token，不可逆'}
      </div>

      {/* ── CCC 选择器（ACP 账户是 CCC 级数据；显式选，不猜）── */}
      <div className="ss-switchRow">
        <span>目标 CCC</span>
        <select value={selectedRoot} onChange={(e) => setSelectedRoot(e.target.value)}>
          {cccs.length === 0 && <option value="">（未发现 CCC）</option>}
          {cccs.map((c) => (
            <option key={c.root} value={c.root}>{c.name}</option>
          ))}
        </select>
      </div>

      {loadError && <p className="ss-detailIntro">{`读取失败：${loadError}`}</p>}

      {status && (
        <p className="ss-detailIntro">
          {`通道：${status.channel}${status.channel === 'acp' ? '' : '（未选 ACP ⇒ 账户不生效）'} ／ 面开关：${status.enabled ? '开' : '关'}` +
            `\n可用账户：${status.accounts.filter((a) => a.usable).length} / ${status.accounts.length}`}
        </p>
      )}

      {/* ── 账户表 ── */}
      {status && status.accounts.length > 0 && (
        <table className="ss-table">
          <thead>
            <tr>
              <th>账户</th>
              <th>角色</th>
              <th>状态</th>
              <th>token</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {status.accounts.map((a) => (
              <tr key={a.accountId}>
                <td>
                  <code>{a.accountId}</code>
                  {a.name ? ` · ${a.name}` : ''}
                </td>
                <td>{a.role ?? '—'}</td>
                <td>{a.usable ? '✅ 可用' : `⚠️ ${a.blockedBy ?? '不可用'}`}</td>
                <td>{a.hasToken ? `…${a.tokenFingerprint ?? ''}` : '（无）'}</td>
                <td>
                  <button type="button" disabled={busy} onClick={() => void rotate(a.accountId)}>轮换</button>
                  {confirmRemove === a.accountId ? (
                    <>
                      <button type="button" disabled={busy} onClick={() => void remove(a.accountId)}>确认删除</button>
                      <button type="button" onClick={() => setConfirmRemove(null)}>取消</button>
                    </>
                  ) : (
                    <button type="button" disabled={busy} onClick={() => setConfirmRemove(a.accountId)}>删除</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {status && status.accounts.length === 0 && (
        <p className="ss-detailIntro">{'该 CCC 还没有声明任何 ACP 账户 ⇒ 客户端一律连不上（fail-closed）。在下面加一条。'}</p>
      )}

      {/* ── 新增账户 ── */}
      <div className="ss-switchRow">
        <span>新增账户</span>
        <input
          placeholder="账户 ID（如 agmente-phone）"
          value={draft.accountId}
          onChange={(e) => setDraft({ ...draft, accountId: e.target.value })}
        />
        <input
          placeholder="角色（必须是本 CCC 已有的）"
          value={draft.role}
          onChange={(e) => setDraft({ ...draft, role: e.target.value })}
          list={`acp-roles-${selectedRoot}`}
        />
        <datalist id={`acp-roles-${selectedRoot}`}>
          {rolesForSelected.map((r) => <option key={r} value={r} />)}
        </datalist>
        <input
          placeholder="显示名（可选）"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
        <button type="button" disabled={busy || !selectedRoot} onClick={() => void addAccount()}>保存并生成 token</button>
      </div>

      {error && <p className="ss-detailIntro">{`⚠️ ${error}`}</p>}

      {/* ── 刚生成 ／ 刚轮换的明文 token（唯一出现明文的地方）── */}
      {freshToken && (
        <div className="ss-detailStack">
          <p className="ss-detailIntro">
            {`🔑 ${freshToken.accountId} 的 token（**只显示这一次**，复制进客户端）\n记得随客户端配置一起保存。`}
          </p>
          <code style={{ wordBreak: 'break-all', userSelect: 'all' }}>{freshToken.token}</code>
          <button type="button" onClick={() => setFreshToken(null)}>我已抄走，隐藏</button>
        </div>
      )}
    </div>
  )
}
