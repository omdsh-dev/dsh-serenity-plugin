/**
 * WeixinBridgeEditor.tsx — 「微信桥」配置区块（F4c-3，v1.27.0 实验性）
 *
 * **CCC 级配置**（S142 用户拍板：dsh 一个进程含多个 CCC，每个 CCC 独立对接微信桥）：
 * - 顶部 **CCC 选择器**（数据源 /serenity/cccs——discoverCccs 复用）——显式选择配置目标，
 *   不隐式依赖"当前活跃会话"（WebUI 顶层全局，微信桥是配置写入必须显式）
 * - 选中 CCC 后：总开关 / 账号列表（扫码绑定）/ 路由表（user → role）
 * - 扫码绑定：POST login-start → qrcode-generator 生成二维码 SVG（复用 v1.24.6 TOTP 同款机制）
 *   → 轮询 /serenity/weixin/login → confirmed 自动写凭据 + 账号元信息
 *
 * 全部端点带显式 ccc 参数 + x-serenity-ui 头（服务端校验）。
 */

import { useEffect, useState } from 'react'
import qrcode from 'qrcode-generator'

/** CCC 选择器条目（/serenity/cccs wire：SkiffCccEntry 同款） */
interface CccEntry {
  root: string
  name: string
  roles: string[]
}

/** /serenity/weixin GET wire */
interface WeixinStatusWire {
  enabled: boolean
  botType?: string
  accounts: Array<{ accountId: string; name?: string; enabled: boolean; bound: boolean }>
  routes: Array<{ user: string; role: string }>
  bridge: Array<{ accountId: string; lastPollAt: number; lastError?: string }>
}

/** 扫码登录状态 */
type LoginPhase = 'idle' | 'waiting' | 'confirmed' | 'error' | 'expired'

/** 生成二维码 SVG（内容 = iLink qrcode_img_content URL——用户微信扫它打开 liteapp 确认页） */
function qrSvgFor(content: string): string {
  const qr = qrcode(0, 'M')
  qr.addData(content)
  qr.make()
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
}

/** 当前工作区 CCC（默认选择器初值：settings 面板无 workspace 参数——服务端 /serenity/weixin 显式 ccc；
 *  选择器默认选第一个；用户手选） */

export function WeixinBridgeEditor(): React.JSX.Element {
  const [cccs, setCccs] = useState<CccEntry[]>([])
  const [selectedRoot, setSelectedRoot] = useState<string>('')
  const [status, setStatus] = useState<WeixinStatusWire | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  // 扫码登录状态
  const [loginPhase, setLoginPhase] = useState<LoginPhase>('idle')
  const [loginQrSvg, setLoginQrSvg] = useState<string>('')
  const [loginKey, setLoginKey] = useState<string>('')
  const [loginError, setLoginError] = useState<string | null>(null)
  const [loginNotice, setLoginNotice] = useState<string | null>(null)

  // 路由编辑（草稿）
  const [routesDraft, setRoutesDraft] = useState<string>('')

  // 加载 CCC 列表（选择器数据源）
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
        /* 拉取失败静默 */
      }
    })()
    return () => { alive = false }
  }, [])

  // 选中 CCC 变化 → 拉取该 CCC 微信桥状态
  useEffect(() => {
    if (!selectedRoot) return
    let alive = true
    setStatus(null)
    setLoadError(null)
    setLoginPhase('idle')
    void (async () => {
      try {
        const res = await fetch(`/serenity/weixin?ccc=${encodeURIComponent(selectedRoot)}`, { headers: { accept: 'application/json', 'x-serenity-ui': '1' } })
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null
          if (alive) setLoadError(body?.error ?? `HTTP ${res.status}`)
          return
        }
        const body = (await res.json()) as WeixinStatusWire
        if (!alive) return
        setStatus(body)
        setRoutesDraft(JSON.stringify(body.routes ?? [], null, 2))
      } catch {
        /* 静默 */
      }
    })()
    return () => { alive = false }
  }, [selectedRoot])

  // 扫码轮询（loginKey 有效期间 1s 间隔）
  useEffect(() => {
    if (loginPhase !== 'waiting' || !loginKey) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        const res = await fetch(`/serenity/weixin/login?key=${encodeURIComponent(loginKey)}`, { headers: { accept: 'application/json', 'x-serenity-ui': '1' } })
        if (!alive) return
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null
          setLoginPhase('error')
          setLoginError(body?.error ?? `HTTP ${res.status}`)
          return
        }
        const body = (await res.json()) as { status?: string; accountId?: string; error?: string }
        if (body.status === 'confirmed') {
          setLoginPhase('confirmed')
          setLoginNotice(`账号 ${body.accountId} 已绑定 ✓（token 已写入 CCC localstore）`)
          // 刷新状态显示新账号
          if (selectedRoot) {
            const sres = await fetch(`/serenity/weixin?ccc=${encodeURIComponent(selectedRoot)}`, { headers: { accept: 'application/json', 'x-serenity-ui': '1' } })
            const sbody = (await sres.json().catch(() => null)) as WeixinStatusWire | null
            if (alive && sbody) setStatus(sbody)
          }
          return
        }
        if (body.status === 'expired' || body.status === 'error') {
          setLoginPhase('error')
          setLoginError(body.error ?? '二维码已过期，请重新获取')
          return
        }
        // wait/scaned → 继续轮询
        timer = setTimeout(() => void poll(), 1000)
      } catch {
        if (alive) timer = setTimeout(() => void poll(), 1000)
      }
    }
    void poll()
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [loginPhase, loginKey, selectedRoot])

  const startLogin = async (): Promise<void> => {
    if (!selectedRoot || loginPhase === 'waiting') return
    setLoginPhase('waiting')
    setLoginError(null)
    setLoginNotice(null)
    try {
      const res = await fetch('/serenity/weixin', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-serenity-ui': '1' },
        body: JSON.stringify({ action: 'login-start', ccc: selectedRoot }),
      })
      const body = (await res.json()) as { qrcode_img_content?: string; loginKey?: string; error?: string }
      if (!res.ok || !body.qrcode_img_content || !body.loginKey) {
        setLoginPhase('error')
        setLoginError(body.error ?? `HTTP ${res.status}`)
        return
      }
      setLoginQrSvg(qrSvgFor(body.qrcode_img_content))
      setLoginKey(body.loginKey)
    } catch (err) {
      setLoginPhase('error')
      setLoginError(err instanceof Error ? err.message : String(err))
    }
  }

  const removeAccount = async (accountId: string): Promise<void> => {
    if (!selectedRoot) return
    try {
      const res = await fetch('/serenity/weixin', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-serenity-ui': '1' },
        body: JSON.stringify({ action: 'remove-account', ccc: selectedRoot, accountId }),
      })
      if (!res.ok) return
      // 刷新状态
      const sres = await fetch(`/serenity/weixin?ccc=${encodeURIComponent(selectedRoot)}`, { headers: { accept: 'application/json', 'x-serenity-ui': '1' } })
      const sbody = (await sres.json().catch(() => null)) as WeixinStatusWire | null
      if (sbody) setStatus(sbody)
    } catch {
      /* 静默 */
    }
  }

  const saveRoutes = async (): Promise<void> => {
    if (!selectedRoot) return
    let routes: Array<{ user: string; role: string }>
    try {
      routes = JSON.parse(routesDraft) as Array<{ user: string; role: string }>
      if (!Array.isArray(routes) || routes.some((r) => typeof r?.user !== 'string' || typeof r?.role !== 'string')) throw new Error('bad')
    } catch {
      setLoadError('路由表 JSON 格式错误（期望 [{user, role}, ...]）')
      return
    }
    try {
      const res = await fetch('/serenity/weixin', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-serenity-ui': '1' },
        body: JSON.stringify({ action: 'save-routes', ccc: selectedRoot, routes }),
      })
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      if (!res.ok) {
        setLoadError(body?.error ?? `HTTP ${res.status}`)
        return
      }
      setLoadError(null)
      // 刷新
      const sres = await fetch(`/serenity/weixin?ccc=${encodeURIComponent(selectedRoot)}`, { headers: { accept: 'application/json', 'x-serenity-ui': '1' } })
      const sbody = (await sres.json().catch(() => null)) as WeixinStatusWire | null
      if (sbody) setStatus(sbody)
    } catch {
      /* 静默 */
    }
  }

  const toggleEnabled = async (on: boolean): Promise<void> => {
    if (!selectedRoot) return
    try {
      const res = await fetch('/serenity/weixin', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-serenity-ui': '1' },
        body: JSON.stringify({ action: 'set-enabled', ccc: selectedRoot, enabled: on }),
      })
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      if (!res.ok) {
        setLoadError(body?.error ?? `HTTP ${res.status}`)
        return
      }
      setLoadError(null)
      const sres = await fetch(`/serenity/weixin?ccc=${encodeURIComponent(selectedRoot)}`, { headers: { accept: 'application/json', 'x-serenity-ui': '1' } })
      const sbody = (await sres.json().catch(() => null)) as WeixinStatusWire | null
      if (sbody) setStatus(sbody)
    } catch {
      /* 静默 */
    }
  }

  const bridgeStateText = (accountId: string): string => {
    const b = status?.bridge.find((x) => x.accountId === accountId)
    if (!b) return '未运行'
    if (b.lastError) return `错误: ${b.lastError}`
    if (b.lastPollAt > 0) return `轮询中（${new Date(b.lastPollAt).toLocaleTimeString()}）`
    return '启动中'
  }

  return (
    <ul className="ss-rows">
      {/* CCC 选择器（显式配置目标——WebUI 顶层全局，微信桥配置写入必须显式） */}
      <li>
        <div className="ss-rowCard">
          <div className="ss-rowText">
            <span className="ss-rowName">目标 CCC</span>
            <span className="ss-rowDesc">选择要配置微信桥的认知容器（显式，非当前活跃会话）</span>
          </div>
          <div className="ss-rowControl">
            <select
              className="ss-select"
              value={selectedRoot}
              onChange={(e) => setSelectedRoot(e.target.value)}
            >
              {cccs.length === 0 && <option value="">加载中…</option>}
              {cccs.map((c) => (
                <option key={c.root} value={c.root}>{c.name}</option>
              ))}
            </select>
          </div>
        </div>
      </li>

      {loadError && (
        <li>
          <div className="ss-rowCard">
            <div className="ss-rowText">
              <span className="ss-rowName">提示</span>
              <span className="ss-rowDesc">{loadError}</span>
            </div>
            <div className="ss-rowControl" />
          </div>
        </li>
      )}

      {status && (
        <>
          {/* 总开关 */}
          <li>
            <div className="ss-rowCard">
              <div className="ss-rowText">
                <span className="ss-rowName">总开关</span>
                <span className="ss-rowDesc">启用后该 CCC 的微信桥开始轮询（需先扫码绑定至少一个账号）</span>
              </div>
              <div className="ss-rowControl">
                <label className="ss-switch">
                  <input
                    type="checkbox"
                    checked={status.enabled}
                    onChange={(e) => void toggleEnabled(e.target.checked)}
                  />
                  <span className="ss-switchTrack" />
                </label>
              </div>
            </div>
          </li>

          {/* 账号列表（多账号：每账号一行，独立移除按钮） */}
          <li>
            <div className="ss-rowCard">
              <div className="ss-rowText">
                <span className="ss-rowName">账号（{status.accounts.length}）</span>
                <span className="ss-rowDesc">
                  {status.accounts.length === 0
                    ? '未绑定任何微信账号——点击下方「扫码绑定微信」逐个添加'
                    : '每个账号独立轮询；可继续扫码添加更多'}
                </span>
              </div>
              <div className="ss-rowControl" />
            </div>
          </li>
          {status.accounts.map((a) => (
            <li key={a.accountId}>
              <div className="ss-rowCard">
                <div className="ss-rowText">
                  <span className="ss-rowName">{a.accountId}{a.name ? ` · ${a.name}` : ''}</span>
                  <span className="ss-rowDesc">
                    {a.bound ? '已绑定凭据' : '未绑定凭据'}（{bridgeStateText(a.accountId)}）
                  </span>
                </div>
                <div className="ss-rowControl">
                  <button
                    type="button"
                    className="ss-removeBtn"
                    onClick={() => void removeAccount(a.accountId)}
                  >
                    移除
                  </button>
                </div>
              </div>
            </li>
          ))}

          {/* 扫码绑定（可反复使用——每绑定一个即新增账号） */}
          <li>
            <div className="ss-rowCard">
              <div className="ss-rowText">
                <span className="ss-rowName">扫码绑定微信</span>
                <span className="ss-rowDesc">
                  {loginPhase === 'idle' && '用手机微信「扫一扫」扫描二维码并确认——每扫一次绑定一个新账号'}
                  {loginPhase === 'waiting' && '二维码已生成（5 分钟内有效）——微信扫一扫 → 手机上确认绑定'}
                  {loginPhase === 'confirmed' && (loginNotice ?? '绑定成功')}
                  {loginPhase === 'error' && (loginError ?? '绑定失败')}
                  {loginPhase === 'expired' && '二维码已过期，请重新获取'}
                </span>
              </div>
              <div className="ss-rowControl">
                <button
                  type="button"
                  className="ss-loginBtn"
                  disabled={loginPhase === 'waiting'}
                  onClick={() => void startLogin()}
                >
                  {loginPhase === 'waiting' ? '等待扫码…' : '扫码绑定'}
                </button>
              </div>
            </div>
          </li>

          {/* 二维码展示（等待扫码时） */}
          {loginPhase === 'waiting' && loginQrSvg !== '' && (
            <li>
              <div className="ss-rowCard ss-qrRow">
                <div
                  className="ss-qrSvg"
                  // qrcode-generator 生成的 SVG 是可信静态内容（本地生成，非用户输入）
                  dangerouslySetInnerHTML={{ __html: loginQrSvg }}
                />
                <div className="ss-rowText">
                  <span className="ss-rowDesc">1. 打开手机微信 → 扫一扫 2. 扫描此二维码 3. 在手机上确认绑定</span>
                </div>
              </div>
            </li>
          )}

          {/* 路由表（JSON 编辑） */}
          <li>
            <div className="ss-rowCard">
              <div className="ss-rowText">
                <span className="ss-rowName">路由表</span>
                <span className="ss-rowDesc">微信用户 → 该 CCC 的 skiff 角色（`*` = 通配兜底；role 必须已定义）</span>
              </div>
              <div className="ss-rowControl">
                <button type="button" className="ss-loginBtn" onClick={() => void saveRoutes()}>保存路由</button>
              </div>
            </div>
            <textarea
              className="ss-routesEditor"
              rows={5}
              value={routesDraft}
              onChange={(e) => setRoutesDraft(e.target.value)}
            />
          </li>
        </>
      )}

      {!status && !loadError && (
        <li>
          <div className="ss-rowCard">
            <div className="ss-rowText">
              <span className="ss-rowName">加载中…</span>
              <span className="ss-rowDesc">读取所选 CCC 的微信桥配置</span>
            </div>
            <div className="ss-rowControl" />
          </div>
        </li>
      )}
    </ul>
  )
}
