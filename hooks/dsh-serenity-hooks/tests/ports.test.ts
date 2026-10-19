import { describe, it, expect } from 'vitest'
import {
  FACE_PORTS,
  MECHANISM_PORTS,
  MAIN_WEB_PORT,
  GATEWAY_PORT,
  WEIXIN_SEND_PORT,
  SKIFF_DEBUG_PORT,
  type FaceId,
} from '../src/kernel/ports.js'

/**
 * ports.test.ts — 集中端口表（C4 块 B，S142 2026-09-15）
 *
 * 起因（现状取证 §③ 3.2-8）：端口此前散在 4 处默认值，而 output-guard 另抄了一份
 * **机制端口词表**——那份词表**漏了 3082**（微信发送面，**默认开**）⇒ 守卫拦不住
 * agent 在用户可见输出里提及 3082。本文件钉住"表是唯一真相源 + 各面齐全"。
 *
 * 🔴 **面数变更（2026-10-15）**：**旧面 E（3100 自造 ACP/问答）已整体退役**（owner 裁「砍掉外部问答」）
 * ⇒ 五面 → **四面**。本文件由「五面」改为「四面」，并**保留** 3082 那条缺陷回归钉。
 * ⚠️ 注意：退役后词表**又变回 4 项**，但**那不是旧缺陷形态**（旧缺陷 = 4 项里**缺 3082 却含 3100**）
 * —— 故下面的回归钉改为**逐项判据**而非"项数不等于 4"，否则会红一个语义完全正确的状态。
 *
 * 🔴🔴 **面数变更（2026-10-19）**：**新面 E（3200 官方 ACP）整面删除**（owner 裁「完整删除整个
 * ACP 的实现」）⇒ 五面 → **四面**（3100 那套自造面已于 10-15 退场，3200 这套两版之后也退场）。
 * 理由实测：`dsh-acp` 无 `session/load`，且 `session/resume` 不回放历史 ⇒ 客户端每次连上只能
 * 新建会话、看不到既有对话 ⇒ 对长期轨迹系统不可接受。
 * ⚠️ **三条同时成立且都必须钉**：① 表中**不含 3200**（新面真的删了）② 表中**不含 3100**
 * （旧面没被"改个号复活"）③ 词表**仍含 3082**（那条真缺陷的回归钉不能随面数变化而失效）。
 *
 * 🔴🔴 **面数变更（2026-10-19 同日后半）：Skiff 调试面（3099，面 D）整条退役**
 * （owner 令「面板里 Skiff 的内容不要了，下掉吧，功能也检查下，应该下掉了」）⇒ 四面 → **三面**。
 * ⇒ 插件**自起 listener 只剩 2 个**（B 网关 / C 微信发送；A 由宿主监听）。
 * ⚠️ **本条与 3082 那条回归钉的关系**：3082 是**在役**面，判据不变；
 *    3099 退役后必须**从词表消失**（否则守卫仍会打回"提及 3099"——那是无对象的拦截）。
 *    🔴 注意区分：退役的是**端口面**，不是 `skiff.json` 轨迹约束面机制（那个仍在用）。
 */

/** §① 表 A：各对外面的端口（取证文件 acc-c4c5-current-state.md；三个面均已退役） */
const EXPECTED: Record<FaceId, number> = {
  main: 3080,
  gateway: 3081,
  weixinSend: 3082,
}

describe('ports: 集中端口表（三面语义）', () => {
  it('三个面齐全，端口号与取证表一致', () => {
    expect(Object.keys(FACE_PORTS).sort()).toEqual(Object.keys(EXPECTED).sort())
    for (const [id, port] of Object.entries(EXPECTED) as Array<[FaceId, number]>) {
      expect(FACE_PORTS[id].port, `${id} 端口`).toBe(port)
      expect(FACE_PORTS[id].meaning.length, `${id} 语义非空`).toBeGreaterThan(0)
    }
  })

  it('监听地址按现状钉住（不变量：C loopback、B 外部可达、A 由宿主决定）', () => {
    expect(FACE_PORTS.main.host).toBeNull() // 面 A 插件**不监听**（只挂路由）
    expect(FACE_PORTS.gateway.host).toBe('0.0.0.0') // 面 B 需外部可达
    expect(FACE_PORTS.weixinSend.host).toBe('127.0.0.1')
  })

  it('默认开关状态按现状钉住（不变量：A/C 默认开；B 默认关）', () => {
    expect(FACE_PORTS.main.defaultEnabled).toBe(true) // 随 DSH 常开
    expect(FACE_PORTS.gateway.defaultEnabled).toBe(false)
    expect(FACE_PORTS.weixinSend.defaultEnabled).toBe(true)
  })

  it('派生常量与表一致（默认值不再散写：config / settings / index 都取这里）', () => {
    expect(MAIN_WEB_PORT).toBe(FACE_PORTS.main.port)
    expect(GATEWAY_PORT).toBe(FACE_PORTS.gateway.port)
    expect(WEIXIN_SEND_PORT).toBe(FACE_PORTS.weixinSend.port)
  })

  it('🔴 三个已退役的面都不得回来：3100（旧自造面）／3200（官方 ACP）／3099（Skiff 调试）', () => {
    const ports = (Object.values(FACE_PORTS) as Array<{ port: number }>).map((s) => s.port)
    expect(ports, '3100 仍留在端口表里').not.toContain(3100)
    expect(ports, '3200 仍留在端口表里 —— ACP 整面删除只做了一半').not.toContain(3200)
    expect(ports, '3099 仍留在端口表里 —— Skiff 调试面退役只做了一半').not.toContain(3099)
    // FaceId 联合类型也要同步：留一个 `skiffDebug` 成员会让下一个人以为面还在（类型层看不见的谎）
    expect(Object.keys(FACE_PORTS)).not.toContain('skiffDebug')
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

  it('🔴 旧缺陷形态不得回来：**缺 3082 的那份硬写词表**（含 3100）与现值不同', () => {
    // 旧缺陷形态逐字 = 当年硬写的四元组：3080/3081/3099/3100（**缺 3082**）。
    const defective = ['3080', '3081', '3099', '3100']
    expect([...MECHANISM_PORTS].sort()).not.toEqual([...defective].sort())
    // 逐项判据：现值必须含 3082（缺陷的判别点），且不得含两个已退役的面
    expect(MECHANISM_PORTS).toContain('3082')
    expect(MECHANISM_PORTS).not.toContain('3100')
    expect(MECHANISM_PORTS).not.toContain('3200')
  })
})
