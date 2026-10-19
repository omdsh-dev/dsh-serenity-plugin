import { describe, it, expect } from 'vitest'

/**
 * 飞书 SDK 可用性探针（P3 第 0 格，2026-10-19 S142）
 *
 * ## 为什么这条必须先跑（调研 §5 第 1 格，逐字）
 *
 * 「**SDK 真能装进宿主**：确认无原生编译、无 peer 冲突」。
 *
 * 🔴 **判据分层**：
 *   - `pnpm add` 退出 0 ⇒ 只证明**包被下载**；
 *   - **本文件** ⇒ 才证明**它能被加载并构造出长连接客户端**。
 * 安装当时 pnpm 报 `ERR_PNPM_IGNORED_BUILDS`（protobufjs 的 postinstall 被拦），
 * 而那是**安装器的策略提示、不是运行时判据** ⇒ 只有真 import + 真构造才能分开这两件事。
 *
 * ## 本文件证明什么 / 不证明什么（边界写清，别把绿读成"能收消息"）
 *
 * ✅ 证明：模块可加载、`WSClient`/`EventDispatcher` 可构造、`im.v1.message.create` 在客户面上。
 * ⛔ **不证明**：长连接能建起来（要真 appId/appSecret 与公网）；
 *           能收到消息（要订阅事件并真发一条）；能发出去（要真凭据）。
 * ⇒ 那三格是**分开的三格**（调研 §5.2 原话：建立连接 ≠ 能收消息）。
 *
 * ⛔ 测试**不建连、不发请求**：本文件零网络副作用。
 */
describe('飞书 SDK 可安装性（P3 第 0 格）', () => {
  it('模块可加载，且长连接与消息 API 都在客户端面上', async () => {
    const Lark = await import('@larksuiteoapi/node-sdk')

    // ① 长连接客户端与事件分发器 —— 飞书收消息的两个必备件
    expect(typeof Lark.WSClient).toBe('function')
    expect(typeof Lark.EventDispatcher).toBe('function')

    // ② 有长连接能力的 SDK 版本下限（官方文档逐字：Node SDK ≥ 1.24.0）
    //    读真实 package.json，不读记忆 —— 版本漂了这条会红
    const pkg = await import('@larksuiteoapi/node-sdk/package.json', { with: { type: 'json' } })
    const [major, minor] = (pkg.default as { version: string }).version.split('.').map(Number)
    expect(major! > 1 || (major === 1 && minor! >= 24)).toBe(true)

    // ③ 发消息的 API 面（`client.im.v1.message.create`）
    const client = new Lark.Client({ appId: 'probe-app-id', appSecret: 'probe-app-secret' })
    expect(typeof client.im?.v1?.message?.create).toBe('function')

    // ④ WSClient 可构造（**不 start**：start 会真连，本文件零网络）
    const ws = new Lark.WSClient({ appId: 'probe-app-id', appSecret: 'probe-app-secret' })
    expect(ws).toBeTruthy()
    expect(typeof (ws as unknown as { start: unknown }).start).toBe('function')
  })
})
