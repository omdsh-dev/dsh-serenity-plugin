import { describe, it, expect } from 'vitest'
import {
  FACE_PORTS,
  MECHANISM_PORTS,
  MAIN_WEB_PORT,
  GATEWAY_PORT,
  WEIXIN_SEND_PORT,
  SKIFF_DEBUG_PORT,
  ACP_HTTP_PORT,
  type FaceId,
} from '../src/ports.js'

/**
 * ports.test.ts — 集中端口表（C4 块 B，S142 2026-09-15）
 *
 * 起因（现状取证 §③ 3.2-8）：端口此前散在 4 处默认值，而 output-guard 另抄了一份
 * **机制端口词表**——那份词表**漏了 3082**（微信发送面，**默认开**）⇒ 守卫拦不住
 * agent 在用户可见输出里提及 3082。本文件钉住"表是唯一真相源 + 五面齐全"。
 */

/** §① 表 A：五个对外面的端口（取证文件 acc-c4c5-current-state.md） */
const EXPECTED: Record<FaceId, number> = {
  main: 3080,
  gateway: 3081,
  weixinSend: 3082,
  skiffDebug: 3099,
  acpHttp: 3100,
}

describe('ports: 集中端口表（五面语义）', () => {
  it('五个面齐全，端口号与取证表一致', () => {
    expect(Object.keys(FACE_PORTS).sort()).toEqual(Object.keys(EXPECTED).sort())
    for (const [id, port] of Object.entries(EXPECTED) as Array<[FaceId, number]>) {
      expect(FACE_PORTS[id].port, `${id} 端口`).toBe(port)
      expect(FACE_PORTS[id].meaning.length, `${id} 语义非空`).toBeGreaterThan(0)
    }
  })

  it('监听地址按现状钉住（不变量：C/D/E loopback、B 0.0.0.0、A 由宿主决定）', () => {
    expect(FACE_PORTS.main.host).toBeNull() // 面 A 插件**不监听**（只挂路由）
    expect(FACE_PORTS.gateway.host).toBe('0.0.0.0') // 面 B 需外部可达
    expect(FACE_PORTS.weixinSend.host).toBe('127.0.0.1')
    expect(FACE_PORTS.skiffDebug.host).toBe('127.0.0.1')
    expect(FACE_PORTS.acpHttp.host).toBe('127.0.0.1')
  })

  it('默认开关状态按现状钉住（不变量：C 默认开；B/D/E 默认关）', () => {
    expect(FACE_PORTS.main.defaultEnabled).toBe(true) // 随 DSH 常开
    expect(FACE_PORTS.gateway.defaultEnabled).toBe(false)
    expect(FACE_PORTS.weixinSend.defaultEnabled).toBe(true)
    expect(FACE_PORTS.skiffDebug.defaultEnabled).toBe(false)
    expect(FACE_PORTS.acpHttp.defaultEnabled).toBe(false)
  })

  it('派生常量与表一致（默认值不再散写：config-ops / settings-section / index / api 都取这里）', () => {
    expect(MAIN_WEB_PORT).toBe(FACE_PORTS.main.port)
    expect(GATEWAY_PORT).toBe(FACE_PORTS.gateway.port)
    expect(WEIXIN_SEND_PORT).toBe(FACE_PORTS.weixinSend.port)
    expect(SKIFF_DEBUG_PORT).toBe(FACE_PORTS.skiffDebug.port)
    expect(ACP_HTTP_PORT).toBe(FACE_PORTS.acpHttp.port)
  })
})

describe('ports: MECHANISM_PORTS 由表派生（🔴 3082 缺陷修复回归钉）', () => {
  it('等于端口表内全部端口的字符串集合（新增面即自动进词表）', () => {
    const fromTable = (Object.keys(FACE_PORTS) as FaceId[]).map((id) => String(FACE_PORTS[id].port))
    expect([...MECHANISM_PORTS].sort()).toEqual(fromTable.sort())
  })

  it('🔴 3082（微信发送面，默认开）在机制端口集合内——修复前缺它', () => {
    expect(MECHANISM_PORTS).toContain('3082')
  })

  it('旧的硬写四元组不再成立（回归钉：缺陷形态不得回来）', () => {
    const defective = ['3080', '3081', '3099', '3100']
    expect([...MECHANISM_PORTS].sort()).not.toEqual([...defective].sort())
    // 且五个面端口一个不少
    for (const p of ['3080', '3081', '3082', '3099', '3100']) {
      expect(MECHANISM_PORTS, `机制端口缺 ${p}`).toContain(p)
    }
  })
})
