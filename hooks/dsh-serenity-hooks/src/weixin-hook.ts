/**
 * weixin-hook.ts — 微信桥消息记录 hook（F4c-3 扩展，v1.27.13 用户需求）
 *
 * 需求：微信桥发生的所有消息记录，支持 hook——允许 CCC 通过自行编写 hook
 * 脚本进行**持久性保存**（存哪/存成什么/是否入库，全归 CCC 决定——ACC 不绑定存储）。
 *
 * 设计（docs/weixin-message-hook-design.md v0.1，三项拍板 H1~H6）：
 * - **双向触发**（H1）：incoming（用户→bot，媒体落盘后）+ outgoing（bot→用户，发送成功后）
 * - **脚本 + stdin JSON**（H2）：serenity.json weixin.hook = CCC 根相对脚本路径；
 *   每次消息事件 spawn 一次，事件 JSON 单行经 stdin 传入（bun 优先 / node 兜底，biasProvider 先例）
 * - **旁路容忍**（H3）：异步 fire-and-forget + 超时 kill + 失败仅日志——微信桥可靠性不受影响
 * - **不含会话凭据**（H5）：事件只有记录所需字段（无 context_token / bot_token——最小暴露面）
 *
 * 定位：Mech 纯逻辑（事件构造纯函数 + 执行器确定性），可独立单测。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolveInside } from './ccc.js'

/** hook 执行超时（旁路记录足够；超时 kill 防挂死脚本） */
export const WEIXIN_HOOK_TIMEOUT_MS = 15_000

/** hook stderr/stdout 日志截断（防脚本刷屏） */
const HOOK_LOG_MAX = 500

/** 媒体引用（hook 事件载荷：kind + 相对 CCC 根路径——CCC 可自行决定是否持久保存媒体） */
export interface WeixinHookMediaRef {
  kind: 'image' | 'file'
  /** 相对 CCC 根的落盘路径（_tmp/weixin-inbound/...）；null = 未落盘 */
  relPath: string | null
}

/** hook 事件公共字段（incoming/outgoing 共享） */
interface WeixinHookEventBase {
  /** 事件类型：incoming（用户→bot）/ outgoing（bot→用户） */
  event: 'incoming' | 'outgoing'
  /** 事件时间（epoch ms） */
  ts: number
  /** 触发 CCC 根（多 CCC 一进程可区分） */
  cccRoot: string
  /** 接收账号（incoming）/ 发送账号（outgoing） */
  accountId: string
  /** 对端用户（from_user_id，形如 userA@im.wechat） */
  userId: string
  /** 固定会话 id（同用户长期同一：skiff-weixin-xxx） */
  sessionId: string
  /** 路由命中的 skiff role */
  role: string
}

/** incoming 事件（用户 → bot）：文本（含语音转写）+ 媒体（已落盘 relPath） */
export interface WeixinHookIncomingEvent extends WeixinHookEventBase {
  event: 'incoming'
  message: {
    /** 文本（含语音服务端转写）；无文本 → null */
    text: string | null
    /** 媒体（图片/文件）；无 → [] */
    media: WeixinHookMediaRef[]
  }
}

/** outgoing 事件（bot → 用户）：回复文本（已剥离 think） */
export interface WeixinHookOutgoingEvent extends WeixinHookEventBase {
  event: 'outgoing'
  reply: string
}

/** 全部 hook 事件（判别联合） */
export type WeixinHookEvent = WeixinHookIncomingEvent | WeixinHookOutgoingEvent

/** 事件载荷（JSON 序列化：不含任何会话凭据——H5） */
export type WeixinHookEventJson = WeixinHookEvent

/** incoming 事件构造输入（bridge 提供实参） */
export interface IncomingHookInput {
  cccRoot: string
  accountId: string
  userId: string
  sessionId: string
  role: string
  text: string | null
  media: WeixinHookMediaRef[]
}

/** outgoing 事件构造输入（bridge 提供实参） */
export interface OutgoingHookInput {
  cccRoot: string
  accountId: string
  userId: string
  sessionId: string
  role: string
  reply: string
}

/** 构造 incoming 事件对象（纯函数，可测） */
export function buildIncomingHookEvent(input: IncomingHookInput): WeixinHookIncomingEvent {
  return {
    event: 'incoming',
    ts: Date.now(),
    cccRoot: input.cccRoot,
    accountId: input.accountId,
    userId: input.userId,
    sessionId: input.sessionId,
    role: input.role,
    message: {
      text: input.text,
      media: input.media,
    },
  }
}

/** 构造 outgoing 事件对象（纯函数，可测） */
export function buildOutgoingHookEvent(input: OutgoingHookInput): WeixinHookOutgoingEvent {
  return {
    event: 'outgoing',
    ts: Date.now(),
    cccRoot: input.cccRoot,
    accountId: input.accountId,
    userId: input.userId,
    sessionId: input.sessionId,
    role: input.role,
    reply: input.reply,
  }
}

/** hook 执行结果（测试/日志用；调用方只关心无异常） */
export interface WeixinHookRunResult {
  ok: boolean
  detail?: string
}

/**
 * 执行一次 hook：spawn CCC 根脚本，事件 JSON 单行经 stdin 传入。
 * 旁路容忍（H3）：超时 kill / 非 0 退出 / spawn 失败 → 仅日志返回 {ok:false}，绝不抛（不阻断微信桥）。
 * 路径逃逸校验：脚本必须解析在 CCC 根内（resolveInside——resolveInside 抛错也吞为 {ok:false}）。
 * 脚本缺失 → {ok:false}（配置了但未实现——日志提示；不视为异常）。
 */
export async function runWeixinHook(root: string, hookRel: string, event: WeixinHookEvent, timeoutMs: number = WEIXIN_HOOK_TIMEOUT_MS): Promise<WeixinHookRunResult> {
  let scriptAbs: string
  try {
    scriptAbs = resolveInside(root, hookRel)
  } catch {
    return { ok: false, detail: `weixin hook 路径逃逸（须在 CCC 根内）: ${hookRel}` }
  }
  if (!existsSync(scriptAbs)) {
    console.log(`[serenity-hooks] weixin hook 脚本缺失（配置了 weixin.hook 但文件不存在）: ${hookRel}`)
    return { ok: false, detail: `hook 脚本不存在: ${hookRel}` }
  }

  const json = JSON.stringify(event)
  // bun 优先 / node 兜底（biasProvider 同款——脚本是 TS/JS 双兼容）
  const runners: Array<[string, string[]]> = [
    ['bun', [scriptAbs]],
    [process.execPath, [scriptAbs]],
  ]

  for (const [cmd, args] of runners) {
    try {
      const res = await runOnce(cmd, args, json, timeoutMs)
      // bun 缺失（ENOENT）→ 试 node；否则视为最终结果
      if (!res.ok && res.code === 'ENOENT') continue
      return res
    } catch {
      // spawn 自身异常（罕见）→ 试下一个 runner
      continue
    }
  }
  return { ok: false, detail: 'hook 执行失败（bun 与 node 均不可用）' }
}

/** 单次 spawn 执行（Promise 化 + 超时 kill + 输出截断） */
function runOnce(cmd: string, args: string[], json: string, timeoutMs: number): Promise<WeixinHookRunResult & { code?: string }> {
  return new Promise((resolvePromise) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    let child: ReturnType<typeof spawn> | null = null
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (err) {
      return resolvePromise({ ok: false, code: 'SPAWN_ERR', detail: String(err) })
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child?.kill('SIGKILL')
      resolvePromise({ ok: false, detail: `hook 执行超时（>${Math.round(timeoutMs / 1000)}s，已 kill）` })
    }, timeoutMs)

    child.stdin?.on('error', () => { /* stdin 关闭竞态忽略 */ })
    child.stdin?.write(json)
    child.stdin?.end()
    child.stdout?.on('data', (d: Buffer) => {
      stdout = (stdout + d.toString()).slice(0, HOOK_LOG_MAX)
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(0, HOOK_LOG_MAX)
    })
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ ok: false, code: err.code, detail: String(err.message ?? err) })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) {
        if (stderr.trim() !== '') {
          console.log(`[serenity-hooks] weixin hook stderr: ${stderr.trim()}`)
        }
        resolvePromise({ ok: true })
      } else {
        console.log(`[serenity-hooks] weixin hook exit=${code}${stderr ? ` stderr: ${stderr.trim()}` : ''}`)
        resolvePromise({ ok: false, detail: `hook exit=${code}` })
      }
    })
  })
}

/** 测试辅助：把 WeixinHookEvent 转单行 JSON（脚本侧读取约定） */
export function hookEventToStdinLine(event: WeixinHookEvent): string {
  return JSON.stringify(event)
}

/** hook runner 签名（可注入——bridge 集成测试捕获事件防真实 spawn flake） */
export type WeixinHookRunner = (root: string, hookRel: string, event: WeixinHookEvent) => Promise<WeixinHookRunResult>

let activeRunner: WeixinHookRunner = runWeixinHook

/** 测试辅助：替换 runner（null → 还原真实 spawn 执行）；生产零调用 */
export function setWeixinHookRunnerForTest(runner: WeixinHookRunner | null): void {
  activeRunner = runner ?? runWeixinHook
}

/** bridge 调用入口（转发 activeRunner——默认真实 spawn；测试可注入捕获） */
export function invokeWeixinHook(root: string, hookRel: string, event: WeixinHookEvent): Promise<WeixinHookRunResult> {
  return activeRunner(root, hookRel, event)
}
