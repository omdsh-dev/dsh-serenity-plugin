/**
 * ports.ts — ACC 对外面的**集中端口表**（C4 块 B，S142 2026-09-15）
 *
 * 为什么存在（现状取证：`AGENT_SESSIONS/…/acc-c4c5-current-state.md` §③ 3.2-8）：
 * 端口此前**散在 4 处默认值**（`config-ops.defaultAdvancedSettings` / `settings-section` schema
 * 与 entry / `index.ts` 的 Config 与 `readWebPort` 回退），而 `output-guard.MECHANISM_PORTS`
 * 另抄了一份**词表**——两处真相互不相干、且那份词表**漏了 3082**（微信发送面，**默认开**），
 * 于是"禁止 agent 在用户可见输出里提及内部端口"的守卫对 3082 无效。
 *
 * 本模块是端口语义的**单一真相源**：
 *   · 每个面的端口 / 监听地址 / 默认开关 / 语义，只在这里写一次；
 *   · 默认值各处（config-ops / settings-section / index）由此派生；
 *   · `MECHANISM_PORTS`（output-guard 的"机制端口"词表）**由端口表机械派生**——
 *     新增一个面即自动进词表，不再存在"抄一份词表"的漂移面。
 *
 * 边界（不可混淆，见 §① 表 A）：**面 A（3080）不由本插件监听**——它是宿主 DSH 主 WebUI，
 * 插件只往上挂 `/serenity/*` 路由。它入表是为了"端口语义完整 + 进机制词表"，
 * **不是**本插件的 listener（`host` 为 `null` 即此意）。
 *
 * 本模块是**零依赖叶模块**（纯常量，无 import）——output-guard（守卫词表）、config-ops
 * （默认值）、settings-section（面板默认）、index（Config 默认）都可安全引用而不引入依赖环。
 */

/** 面标识（五个对外面；A 由宿主监听，B/C/D/E 由本插件监听） */
export type FaceId = 'main' | 'gateway' | 'weixinSend' | 'skiffDebug' | 'acpHttp'

/** 一个面的端口语义 */
export interface PortSpec {
  /** 端口号 */
  readonly port: number
  /** 监听地址；`null` = **不由本插件监听**（宿主 DSH 决定，插件只挂路由） */
  readonly host: string | null
  /** 默认开关状态（未配置时的值） */
  readonly defaultEnabled: boolean
  /** 语义：这个面是什么（给人看的一句话） */
  readonly meaning: string
}

/**
 * 集中端口表。
 * A=宿主主面（插件不监听）/ B=网关（可配，默认关）/ C=微信发送（默认开，仅 loopback）
 * / D=Skiff 调试（默认关）/ E=ACP+问答（默认关）。
 */
export const FACE_PORTS: Readonly<Record<FaceId, PortSpec>> = {
  main: {
    port: 3080,
    host: null,
    defaultEnabled: true,
    meaning: '宿主 DSH 主 WebUI + 插件 /serenity/* 路由面（**插件不起此 listener**，端口自宿主读）',
  },
  gateway: {
    port: 3081,
    host: '0.0.0.0',
    defaultEnabled: false,
    meaning: '双端口网关（外部登录 + 全量反代宿主主面；host/port 走 plugin 全局配置）',
  },
  weixinSend: {
    port: 3082,
    host: '127.0.0.1',
    defaultEnabled: true,
    meaning: '微信主动发送面（容器外进程 → POST /send；与 3080 显式解耦，不经网关）',
  },
  skiffDebug: {
    port: 3099,
    host: '127.0.0.1',
    defaultEnabled: false,
    meaning: 'Skiff 调试问答面（人工调试子角色；无认证，仅靠 loopback）',
  },
  acpHttp: {
    port: 3100,
    host: '127.0.0.1',
    defaultEnabled: false,
    meaning: 'ACP JSON-RPC + 对外问答面（外部程序 + key 认证的问答页共用一 listener）',
  },
}

/** 宿主主 WebUI 端口（面 A：插件**不监听**，只读取；`readWebPort` 的回退值） */
export const MAIN_WEB_PORT: number = FACE_PORTS.main.port
/** 网关端口默认值（面 B） */
export const GATEWAY_PORT: number = FACE_PORTS.gateway.port
/** 微信主动发送端口默认值（面 C） */
export const WEIXIN_SEND_PORT: number = FACE_PORTS.weixinSend.port
/** Skiff 调试页端口默认值（面 D） */
export const SKIFF_DEBUG_PORT: number = FACE_PORTS.skiffDebug.port
/** ACP / 对外问答端口默认值（面 E） */
export const ACP_HTTP_PORT: number = FACE_PORTS.acpHttp.port

/**
 * **机制端口**词表（output-guard 用：agent 在**用户可见输出**里提及内部端口即打回）。
 *
 * 由 {@link FACE_PORTS} 机械派生 ⇒ 与面清单**永不漂移**。
 * ⚠️ 修复记录（C4 块 B，2026-09-15）：旧常量硬写 `['3080','3081','3099','3100']`
 * ——**漏 3082**（微信发送面，默认开）⇒ 守卫拦不住"3082"这类提及。现由表派生，五面齐全。
 */
export const MECHANISM_PORTS: readonly string[] = (Object.keys(FACE_PORTS) as FaceId[])
  .map((id) => String(FACE_PORTS[id].port))
