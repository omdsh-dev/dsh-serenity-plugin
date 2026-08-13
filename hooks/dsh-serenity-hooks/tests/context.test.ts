import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('@deepseek-ai/dsh-llm', () => ({
  createUserMessage: (o: unknown) => o,
}))

import { accIdentityText, accMessage } from '../src/seams/context.js'
import { ACC_VERSION } from '../src/constants.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hooks-ctx-'))
  writeFileSync(join(dir, '.serenity'), 'test')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('context: ACC 身份文本', () => {
  it('包含 CCC 根与版本', () => {
    const t = accIdentityText(dir)
    expect(t).toContain(dir)
    expect(t).toContain(ACC_VERSION)
    expect(t).toContain('宁静号认知容器已激活')
  })

  it('读取 loop 默认模型', () => {
    mkdirSync(join(dir, '.dsh'))
    writeFileSync(join(dir, '.dsh', 'serenity.json'), JSON.stringify({ loop: { defaultModel: 'mock-model' } }))
    expect(accIdentityText(dir)).toContain('mock-model')
  })

  it('存在 PHASE2-PROMPT.md 时提示访谈', () => {
    mkdirSync(join(dir, '.dsh'))
    writeFileSync(join(dir, '.dsh', 'PHASE2-PROMPT.md'), 'T1')
    expect(accIdentityText(dir)).toContain('Phase 2')
  })
})

describe('context: ACC 注入消息（完整系统提示词 + CCC 顶层 skill 原文）', () => {
  it('accMessage 含简短头 + ACC 5 块 + CCC 顶层 skill 原文', () => {
    // .serenity 记号 = 顶层入口 skill 名（对齐真实 CCC 约定）
    writeFileSync(join(dir, '.serenity'), 'tg-serenity')
    mkdirSync(join(dir, '.opencode', 'skills', 'tg-serenity'), { recursive: true })
    writeFileSync(join(dir, '.opencode', 'skills', 'tg-serenity', 'SKILL.md'), '---\nname: tg-serenity\n---\n顶层入口原文内容')

    const msg = accMessage(dir, ['.dsh/serenity.json'], 30000) as { content: Array<{ text: string }> }
    const text = msg.content[0].text
    // 简短头
    expect(text).toContain('[ACC] 宁静号认知容器已激活')
    // ACC 5 块
    expect(text).toContain('=== Serenity ACC ===')
    expect(text).toContain('=== Serenity CCE ===')
    expect(text).toContain('=== Serenity Constraints ===')
    // CCC 顶层 skill 原文（.serenity 记号发现；对齐 osp：原文直推，无包裹头）
    expect(text).not.toContain('# CCC 入口技能')
    expect(text).toContain('顶层入口原文内容')
    expect(text).toContain('---\nname: tg-serenity')
  })
})
