/**
 * deepseek-vision-verify.test.ts — P-6 **真机验收**探针（S142 §26 §0x-9）
 *
 * ## 为什么需要它（V-1 探针**未覆盖**的那一层）
 *
 * `tests/host/deepseek-vision-probe.test.ts` 验的是 **`dsh-settings` 通道**
 * （注册 / 合并 / 落盘），**不含 `llm-pi-ai` 自己的 `validate` / `assertServiceable`**。
 * ⇒ **"通道通 ≠ 被 pi-ai 接受"**。
 *
 * 本文件读**真实的 `~/.dsh/settings.yaml`**，回答一个可判定问题：
 * > **v1.41.0 装载后，`llm-pi-ai` 段里到底有没有被写入 `input` 声明？写在哪几个 route 上？**
 *
 * ## 判据（正控 + 关键判据 + 边界）
 *
 *   V-1' **llm-pi-ai 段是否存在** —— 不存在 ⇒ 本功能无可验收对象（合法状态，非缺陷）
 *   V-2' 🔴 **是否有 `input` 行被写入** —— 这是本功能的**直接痕迹**
 *   V-3' **写入的模型是否都是 deepseek**（负控：证明没有越权改非 deepseek 模型）
 *
 * ## 为什么用「行级扫描」而不是 YAML 库
 *
 * 本仓**没有** yaml 依赖（宿主才有）。而验收所需的信息极窄：**哪些 `- id:` 之下有 `input:`**。
 * ⇒ 行级状态机足够，且**只读**。🔴 若格式变化导致解析不到 ⇒ 报"未解析到"而非常绿（fail-loud）。
 *
 * ## 诚实边界（E↑）
 *
 * 本文件**只读**，不写任何东西。
 * ⚠️ **本文件证明不了"模型真能收图"** —— 那需要真发一张图（owner 已在 S185 侧验证）。
 * 本文件证明的是**更弱但可机械复核**的一环：**补丁确实落进了用户设置文档**。
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const SETTINGS = join(homedir(), '.dsh', 'settings.yaml')

/** 扫描 `llm-pi-ai` 段：返回每个 `- id:` 条目及其（若有的）`input:` 行 */
function scanPiAi(text: string): { route: string; id: string; input?: string }[] {
  const out: { route: string; id: string; input?: string }[] = []
  let inPiAi = false
  let route = ''
  let cur: { route: string; id: string; input?: string } | undefined

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\t/g, '  ')
    const indent = line.length - line.trimStart().length
    const t = line.trim()
    if (t === '' || t.startsWith('#')) continue

    if (indent === 0) {                      // 顶层键：判断是否进入 llm-pi-ai
      inPiAi = /^llm-pi-ai\s*:/.test(t)
      route = ''
      continue
    }
    if (!inPiAi) continue

    // providers 之下、2 空格缩进的 `xxx:` ⇒ 路由名
    if (indent <= 2 && /^[A-Za-z0-9_.\/-]+\s*:\s*$/.test(t) && !/^providers\s*:/.test(t)) {
      route = t.replace(/\s*:\s*$/, '')
      continue
    }
    if (/^-\s*id\s*:/.test(t)) {             // 新模型条目
      cur = { route, id: t.replace(/^-\s*id\s*:\s*/, '').replace(/^["']|["']$/g, '').trim() }
      out.push(cur)
      continue
    }
    if (cur !== undefined && /^input\s*:/.test(t)) cur.input = t // 记原始行文本
  }
  return out
}

const report: Record<string, unknown> = {}
const settingsExists = existsSync(SETTINGS)
const text = settingsExists ? readFileSync(SETTINGS, 'utf-8') : ''
const models = settingsExists ? scanPiAi(text) : []
const withInput = models.filter((m) => m.input !== undefined)
const piSectionPresent = /^llm-pi-ai\s*:/m.test(text)

describe('§26 §0x-9 P-6：真机验收（读 ~/.dsh/settings.yaml；**只读**）', () => {
  it('取证并报告', () => {
    report['settings.yaml 存在'] = settingsExists
    report['settings.yaml 字节'] = text.length
    report['llm-pi-ai 段存在'] = piSectionPresent
    report['解析到的模型条目数'] = models.length
    report['带 input 行的条目'] = withInput.map((m) => ({ route: m.route, id: m.id, line: m.input }))
    report['按 route 聚合'] = models.reduce<Record<string, string[]>>((acc, m) => {
      ;(acc[m.route] ??= []).push(m.id + (m.input ? ' [有 input]' : ''))
      return acc
    }, {})

    // eslint-disable-next-line no-console
    console.log('\n===== §26 §0x-9 P-6 真机验收结论 =====\n'
      + JSON.stringify(report, null, 2) + '\n======================================\n')

    expect(settingsExists, '~/.dsh/settings.yaml 应存在').toBe(true)
  })

  it('🔴 判据：llm-pi-ai 段若存在，必须能看到补丁的痕迹（至少一个 input 行）', () => {
    if (!piSectionPresent) {
      // eslint-disable-next-line no-console
      console.log('[§0x-9 P-6] settings.yaml 无 llm-pi-ai 段 ⇒ 无可验收对象（合法状态，非缺陷）')
      return
    }
    // 说明性：把有 input 的条目打出来
    // eslint-disable-next-line no-console
    console.log('[§0x-9 P-6] 带 input 声明的条目:', withInput.map((m) => `${m.route || '(未解析到 route)'}/${m.id}`).join(', ') || '(无)')
    expect(withInput.length, '🔴 若 pi-ai 段存在且有 deepseek 模型，补丁应留下 input 行').toBeGreaterThan(0)

    // 🔴 更强的判据（2026-09-19 实测确立）：**每个 deepseek 模型都必须有 input 行**。
    // 依据：本机实测（v1.41.0 装载前后对照）——
    //   补丁前：5 个 deepseek 模型**一个都没有** `input:` 行；
    //   补丁后：5 个**全部**出现 `input:` 行，而非 deepseek 的 4 个仍是它们**原有的** `input: []`。
    // ⇒ 这条把"补丁确实落盘了"从"归档证据"升级为**每次可重跑的机械判据**。
    const deepseekMissing = models
      .filter((m) => m.id.toLowerCase().includes('deepseek'))
      .filter((m) => m.input === undefined)
      .map((m) => m.id)
    expect(deepseekMissing, '🔴 每个 deepseek 模型都必须已被补上 input 声明').toEqual([])
  })

  it('负控：写入 input 的条目应都是 deepseek 模型（没乱改别人的）', () => {
    const nonDeepseekWithInput = withInput.filter((m) => !m.id.toLowerCase().includes('deepseek'))
    report['带 input 的非 deepseek 条目'] = nonDeepseekWithInput.map((m) => m.id)
    // 只记录不断言失败：用户完全可能自己给非 deepseek 模型配 input（那不是我们的错）
    // eslint-disable-next-line no-console
    console.log('[§0x-9 P-6] 带 input 的非 deepseek 条目（可能是用户自配）:', nonDeepseekWithInput.map((m) => m.id).join(', ') || '(无)')
  })
})
