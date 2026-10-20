/**
 * trajectory-self-docs.test.ts — 「一条轨迹如何描述自己」手册的**内容判据**
 *
 * ## 为什么这份测试必须有（不只是为了过 coverage-gate）
 *
 * 这份手册是 owner 点名的「认知轨迹感知理解这些边界的重要手册」。
 * 它最坏的失效形态不是"写错"，而是**悄悄漏掉一节** —— 而漏掉的那一节
 * 恰恰可能是某个轨迹唯一能查到"我该怎么声明常驻"的地方。
 *
 * ⇒ 判据按**三种自我描述 + 验法**逐项钉住，缺任何一项都红。
 *
 * 🔵 与 `container-admin.test.ts` 的分工：
 *    那边钉「章在不在菜单里、能不能取到」；**本文件钉「取到的正文里有什么」**。
 */
import { describe, it, expect } from 'vitest'
import { TRAJECTORY_SELF_GUIDE } from '../src/tools/trajectory-self-docs.js'

describe('trajectory-self-docs：三种自我描述齐备', () => {
  it('① 三个载体全部点名 —— 想改哪件事，看得见该写哪个文件', () => {
    for (const f of ['SESSION.md', 'PROMPT.md', 'trajectory.json']) {
      expect(TRAJECTORY_SELF_GUIDE).toContain(f)
    }
  })

  it('② 章程（PROMPT.md）：必须讲清写什么、谁读、何时生效、没有会怎样', () => {
    const g = TRAJECTORY_SELF_GUIDE
    expect(g).toContain('PROMPT.md：我的章程')
    expect(g).toContain('写什么')
    expect(g).toContain('谁读它')
    expect(g).toContain('何时生效')
    // 🔴 「没有它会怎样」这一格最容易漏，而它决定轨迹敢不敢不写
    expect(g).toContain('没有它会怎样')
    // 与 SESSION.md 的分工（不写重，是本手册的核心价值之一）
    expect(g).toContain('别写重了')
  })

  it('🔴 ③ 常驻：字段名 + 语义 + **先排除"资源状态"这个误解**', () => {
    const g = TRAJECTORY_SELF_GUIDE
    expect(g).toContain('resident')
    expect(g).toContain('serves')
    // 这一句是 owner 亲口澄清的，必须在手册里逐字可辨
    expect(g).toContain('常驻不是资源状态')
    expect(g).toContain('欢迎别人来麻烦我')
    // 两个门槛（可被发现 / 可被判断）—— 只写半个比不写更坏
    expect(g).toContain('可被发现')
    expect(g).toContain('判断')
    // 不进提示词（省 token）是 owner 的裁决，写出去了才不会有人去加
    expect(g).toContain('不进系统提示词')
  })

  it('④ 限制面：只指路、不复制正文（一个内容一个正文入口）', () => {
    const g = TRAJECTORY_SELF_GUIDE
    expect(g).toContain('config docs trajectory-constraint')
    // 反向钉：白名单正文不该在这里出现
    expect(g).not.toContain('Two whitelists, both default-deny')
  })

  it('⑤ 写完怎么验：四种判据都要给（判据比描述重要）', () => {
    const g = TRAJECTORY_SELF_GUIDE
    for (const probe of ['config validate', 'config list']) expect(g).toContain(probe)
    // 「保存成功 ≠ 生效」这条纪律必须写在验法里
    expect(g).toContain('保存成功')
  })

  it('🔵 正控：正文非空且量级合理（防"扫了空串"式假绿）', () => {
    expect(TRAJECTORY_SELF_GUIDE.length).toBeGreaterThan(1200)
    expect(TRAJECTORY_SELF_GUIDE).toContain('如何描述自己')
  })
})
