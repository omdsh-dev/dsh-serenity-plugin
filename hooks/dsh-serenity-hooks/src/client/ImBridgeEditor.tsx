/**
 * ImBridgeEditor.tsx — 「IM 桥」配置区块（原 `WeixinBridgeEditor`，2026-10-19 泛化）
 *
 * ## 为什么改名 + 泛化（R↓，这不是"改个标题"）
 *
 * P2 起「微信」与「飞书」是**并列的账号实现**：装配处只认 `account.channel`
 * （`im/accounts.ts` 的派发表），而账号、路由、会话**全部与渠道无关**。
 * ⇒ 面板属于"设定账号"这一层，标题若仍叫「微信桥」，第二家 IM 一接上就开始说谎
 * （**正是 D151 记过的那类失效：引用与口径随别的功能演进失效，且零机械信号**）。
 *
 * ⚠️ **扫码绑定是微信独有形态**；飞书走**凭据表单**（appId/appSecret）。
 * 二者在同一个「IM 桥」块里按账号行的 `channel` 分列。
 * 判据：**面板不是判据**（施工图 P4 原文），它只负责把统一配置显示出来并可写。
 *
 * **CCC 级配置**（S142 用户拍板：dsh 一个进程含多个 CCC，每个 CCC 独立对接 IM 桥）：
 * - 顶部 **CCC 选择器**（数据源 /serenity/cccs——listCccs 复用）——显式选择配置目标，
 *   不隐式依赖"当前活跃会话"（WebUI 顶层全局，IM 桥是配置写入必须显式）
 * - 选中 CCC 后：总开关 / 账号列表 / 路由表（user → 轨迹编码）
 * - 扫码绑定（**微信专用**）：POST login-start → qrcode-generator 生成二维码 SVG
 *
 * 全部端点带显式 ccc 参数 + x-serenity-ui 头（服务端校验）。
 */

import { useEffect, useState } from 'react'
import qrcode from 'qrcode-generator'

/** CCC 选择器条目（/serenity/cccs wire：CccEntry 同款） */
interface CccEntry {
  root: string
  name: string
  roles: string[]
}

/**
 * /serenity/weixin GET wire。
 *
 * ⚠️ **端点名仍是 `weixin`**（路径不是本次改的对象）：它是"IM 桥配置"这个端点的历史名，
 * 改路径会砸掉正在用的前端与真机验证。（判据：改名类改动要么全链同批，要么不改——
 * 半改会制造 D151 那种"引用失效且无信号"。本批只改**界面语言**，端点保持。）
 */
interface ImStatusWire {
  enabled: boolean
  botType?: string
  /** `channel` 是账号实现名（`weixin` / `feishu` …）；缺省 ⇒ 后端按 `weixin` 归一 */
  accounts: Array<{ accountId: string; name?: string; enabled: boolean; bound: boolean; channel?: string }>
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

/** 账号渠道的显示名（未登记的新渠道原样显示，不猜） */
function channelLabel(channel: string | undefined): string {
  const c = (channel ?? 'weixin').trim() || 'weixin'
  if (c === 'weixin') return '微信'
  if (c === 'feishu') return '飞书'
  return c
}

/** 当前工作区 CCC（默认选择器初值：settings 面板无 workspace 参数——服务端 /serenity/weixin 显式 ccc；
 *  选择器默认选第一个；用户手选） */

export function ImBridgeEditor(): React.JSX.Element {
  const [cccs, setCccs] = useState<CccEntry[]>([])
  const [selectedRoot, setSelectedRoot] = useState<string>('')
  const [status, setStatus] = useState<ImStatusWire | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  // 扫码登录状态
  const [loginPhase, setLoginPhase] = useState<LoginPhase>('idle')
  const [loginQrSvg, setLoginQrSvg] = useState<string>('')
  const [loginKey, setLoginKey] = useState<string>('')
  const [loginError, setLoginError] = useState<string | null>(null)
  const [loginNotice, setLoginNotice] = useState<string | null>(null)

  // 路由编辑（草稿）
  const [routesDraft, setRoutesDraft] = useState<string>('')

  // 飞书凭据表单（P4；owner：「页面上没办法添加飞书 account，要能支持」）
  const [feishuAppId, setFeishuAppId] = useState<string>('')
  const [feishuAppSecret, setFeishuAppSecret] = useState<string>('')
  const [feishuName, setFeishuName] = useState<string>('')
  const [feishuBusy, setFeishuBusy] = useState<boolean>(false)
  const [feishuNotice, setFeishuNotice] = useState<string | null>(null)

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

  // 选中 CCC 变化 → 拉取该 CCC 的 IM 桥状态
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
        const body = (await res.json()) as ImStatusWire
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
            const sbody = (await sres.json().catch(() => null)) as ImStatusWire | null
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
      const sbody = (await sres.json().catch(() => null)) as ImStatusWire | null
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
      const sbody = (await sres.json().catch(() => null)) as ImStatusWire | null
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
      const sbody = (await sres.json().catch(() => null)) as ImStatusWire | null
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

  /**
   * 添加飞书账号（P4）。
   *
   * 🔴 为什么飞书是表单而微信用二维码：**扫码是微信独有形态**。飞书的身份是
   * 「企业自建应用」的 appId + appSecret ⇒ 只能由人从飞书开放平台后台抄过来。
   * 在此之前面板没有任何入口 ⇒ owner 只能手写 localstore，那不算"能配"。
   *
   * 成功后**清空表单**：这是"可反复添加"的判据（同一份凭据连点两次会建出两个账号）。
   */
  const addFeishuAccount = async (): Promise<void> => {
    if (!selectedRoot || feishuBusy) return
    setFeishuBusy(true)
    setFeishuNotice(null)
    try {
      const res = await fetch('/serenity/weixin', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-serenity-ui': '1' },
        body: JSON.stringify({
          action: 'add-feishu-account',
          ccc: selectedRoot,
          appId: feishuAppId.trim(),
          appSecret: feishuAppSecret.trim(),
          name: feishuName.trim(),
        }),
      })
      const body = (await res.json().catch(() => null)) as { accountId?: string; error?: string } | null
      if (!res.ok) {
        setFeishuNotice(body?.error ?? `HTTP ${res.status}`)
        return
      }
      setFeishuNotice(`账号 ${body?.accountId ?? ''} 已添加 ✓（凭据已写入 localstore）`)
      setFeishuAppId('')
      setFeishuAppSecret('')
      setFeishuName('')
      // 刷新状态显示新账号
      const sres = await fetch(`/serenity/weixin?ccc=${encodeURIComponent(selectedRoot)}`, { headers: { accept: 'application/json', 'x-serenity-ui': '1' } })
      const sbody = (await sres.json().catch(() => null)) as ImStatusWire | null
      if (sbody) setStatus(sbody)
    } catch (err) {
      setFeishuNotice(err instanceof Error ? err.message : String(err))
    } finally {
      setFeishuBusy(false)
    }
  }

  return (
    <ul className="ss-rows">
      {/* CCC 选择器（显式配置目标——WebUI 顶层全局，IM 桥配置写入必须显式） */}
      <li>
        <div className="ss-rowCard">
          <div className="ss-rowText">
            <span className="ss-rowName">目标 CCC</span>
            <span className="ss-rowDesc">选择要配置 IM 桥的认知容器</span>
            <span className="ss-help">
              <button type="button" className="ss-helpMark" aria-label="目标 CCC 帮助">?</button>
              <span className="ss-helpTip">{'IM 桥是 CCC 级配置。\n' +
                '· 一个 dsh 进程可挂多个 CCC，各自独立对接 IM\n' +
                '· 在这里显式选择目标，不跟随当前会话\n' +
                '· 各 CCC 的账号、路由、开关互不影响\n' +
                '· 切换后自动加载该 CCC 的配置'}
              </span>
            </span>
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
          {/* 总开关 + 账号列表（v1.27.5 紧凑化：并成一行） */}
          <li>
            <div className="ss-rowCard">
              <div className="ss-rowText">
                <span className="ss-rowName">总开关 · 账号（{status.accounts.length}）</span>
                <span className="ss-rowDesc">
                  {status.accounts.length === 0
                    ? '未绑定账号——微信可扫码绑定，飞书填凭据'
                    : status.accounts.map((a) => `${channelLabel(a.channel)}·${a.accountId}${a.bound ? '✓' : '✗'}`).join('  ')}
                </span>
                <span className="ss-help">
                  <button type="button" className="ss-helpMark" aria-label="IM 桥总开关帮助">?</button>
                  <span className="ss-helpTip">{'IM 桥总开关。\n' +
                    '· 开启后该 CCC 开始收消息（每个账号各自一条连接）\n' +
                    '· 前置：至少一个已绑定凭据的账号\n' +
                    '· 每账号独立连接；✓ = 已绑定凭据，✗ = 未绑定\n' +
                    '· 关闭 = 停止全部连接，零资源占用'}
                  </span>
                </span>
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
          {status.accounts.map((a) => (
            <li key={a.accountId}>
              <div className="ss-rowCard">
                <div className="ss-rowText">
                  <span className="ss-rowName">
                    <span className="ss-channelTag">{channelLabel(a.channel)}</span>
                    {a.accountId}{a.name ? ` · ${a.name}` : ''}
                  </span>
                  <span className="ss-rowDesc">{a.bound ? '已绑定凭据' : '未绑定凭据'}（{bridgeStateText(a.accountId)}）</span>
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

          {/* 扫码绑定（**微信独有形态**——飞书走上面的凭据表单） */}
          <li>
            <div className="ss-rowCard">
              <div className="ss-rowText">
                <span className="ss-rowName">扫码绑定微信</span>
                <span className="ss-rowDesc">
                  {loginPhase === 'idle' && '微信「扫一扫」确认——每扫一次绑定一个新账号'}
                  {loginPhase === 'waiting' && '二维码已生成（5 分钟有效）——微信扫一扫 → 手机确认'}
                  {loginPhase === 'confirmed' && (loginNotice ?? '绑定成功')}
                  {loginPhase === 'error' && (loginError ?? '绑定失败')}
                  {loginPhase === 'expired' && '二维码已过期，请重新获取'}
                </span>
                <span className="ss-help">
                  <button type="button" className="ss-helpMark" aria-label="扫码绑定帮助">?</button>
                  <span className="ss-helpTip">{'扫码绑定微信账号。\n' +
                    '· 走腾讯 iLink 开放协议（个人微信 Bot API）\n' +
                    '· 步骤：生成二维码 → 手机微信「扫一扫」→ 手机上确认\n' +
                    '· 每扫一次绑定一个新账号，可多账号，各自独立轮询\n' +
                    '· 二维码 5 分钟有效；不需要平台审核'}
                  </span>
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

          {/* 二维码展示（等待扫码时；v1.27.5 紧凑化：更小 + 步骤横排） */}
          {loginPhase === 'waiting' && loginQrSvg !== '' && (
            <li>
              <div className="ss-rowCard ss-qrRow">
                <div
                  className="ss-qrSvg"
                  // qrcode-generator 生成的 SVG 是可信静态内容（本地生成，非用户输入）
                  dangerouslySetInnerHTML={{ __html: loginQrSvg }}
                />
                <div className="ss-rowText">
                  <span className="ss-rowDesc">微信扫一扫 → 手机上确认绑定</span>
                </div>
              </div>
            </li>
          )}

          {/* 飞书凭据表单（可反复添加——每提交一次即新增一个账号） */}
          <li>
            <div className="ss-rowCard">
              <div className="ss-rowText">
                <span className="ss-rowName">添加飞书账号</span>
                <span className="ss-rowDesc">
                  {feishuNotice ?? '填企业自建应用的 App ID 与 App Secret——每提交一次新增一个账号'}
                </span>
                <span className="ss-help">
                  <button type="button" className="ss-helpMark" aria-label="飞书绑定帮助">?</button>
                  <span className="ss-helpTip">{'添加飞书账号（企业自建应用）。\n' +
                    '· 飞书开放平台 → 开发者后台 → 你的应用 → 「凭证与基础信息」\n' +
                    '· 复制 App ID 与 App Secret 填在下面\n' +
                    '· 事件订阅选「长连接」并订阅 im.message.receive_v1\n' +
                    '· 每提交一次新增一个账号，各自独立连接\n' +
                    '· 与微信并列：账号、路由、开关互不影响'}
                  </span>
                </span>
              </div>
              <div className="ss-rowControl">
                <button
                  type="button"
                  className="ss-loginBtn"
                  disabled={feishuBusy || feishuAppId.trim() === '' || feishuAppSecret.trim() === ''}
                  onClick={() => void addFeishuAccount()}
                >
                  {feishuBusy ? '添加中…' : '添加飞书账号'}
                </button>
              </div>
            </div>
            <div className="ss-feishuForm">
              <input
                className="ss-input"
                type="text"
                placeholder="App ID（cli_xxx）"
                value={feishuAppId}
                onChange={(e) => setFeishuAppId(e.target.value)}
              />
              <input
                className="ss-input"
                type="password"
                placeholder="App Secret"
                value={feishuAppSecret}
                onChange={(e) => setFeishuAppSecret(e.target.value)}
              />
              <input
                className="ss-input"
                type="text"
                placeholder="账号名（可选，如「家庭群机器人」）"
                value={feishuName}
                onChange={(e) => setFeishuName(e.target.value)}
              />
            </div>
          </li>

          {/* 路由表（JSON 编辑；v1.27.5 紧凑化：textarea 默认 3 行） */}
          <li>
            <div className="ss-rowCard">
              <div className="ss-rowText">
                <span className="ss-rowName">路由表</span>
                <span className="ss-rowDesc">IM 用户 → 认知轨迹编码（`*` 通配兜底）</span>
                <span className="ss-help">
                  <button type="button" className="ss-helpMark" aria-label="路由表帮助">?</button>
                  <span className="ss-helpTip">{'路由表：IM 用户 → 认知轨迹编码映射。\n' +
                    '· 格式：[{"user": "xxx@im.wechat", "trajectory": "my-code"}, ...]\n' +
                    '· user = 该渠道的用户 ID（微信 from_user_id ／ 飞书 open_id）；`*` = 通配兜底\n' +
                    '· trajectory = 该 CCC 里某条认知轨迹的**编码**（目录名里 `YYYY-MM-DD--<编码>` 那一段）\n' +
                    '· 未命中路由的用户不回复（不暴露机器人）'}
                  </span>
                </span>
              </div>
              <div className="ss-rowControl">
                <button type="button" className="ss-loginBtn" onClick={() => void saveRoutes()}>保存路由</button>
              </div>
            </div>
            <textarea
              className="ss-routesEditor"
              rows={3}
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
              <span className="ss-rowDesc">读取所选 CCC 的 IM 桥配置</span>
            </div>
            <div className="ss-rowControl" />
          </div>
        </li>
      )}
    </ul>
  )
}
