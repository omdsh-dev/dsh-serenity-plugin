/**
 * msm.ts — msm 工具（v1.30 重构：单入口执行，list/exec 合一）
 *
 * 设计（S142 用户拍板"msm 单入口同意 + 参数简易高效"）：
 *   acc_msm（8 action enum）→ msm（3 参数：name + args + inspect）——
 *   最高频工具参数极简：无 action 选择、无协议 flag 前置学习。
 *
 * LLM 直觉用法：
 *   msm("ssh-connect", ["status"])        — 执行已注册 MSM
 *   msm("ssh-connect")                    — 无参执行
 *   msm("ssh-connect", [], inspect=true)  — 查该 MSM 用法/参数（不执行）
 *   msm("ssh")                            — 未精确命中 → 返回模糊候选（LLM 下轮选对）
 *   msm()                                 — 返回精简分类目录（替代旧全量 list）
 *
 * 管理面（register/deregister/check/guide/catalog/ccc-config）已移入 container_admin。
 * 底层 runMsmAsync/prepareExec 全复用；未命中候选为新增 findSuggestions。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { findSerenityRoot } from '../ccc.js'
import { runMsmAsync, loadMsmEntries, findEntry } from '../msm-ops.js'
import { skiffMsmGate } from '../skiff-core.js'

function agentCwd(exec: { agent?: { session?: { header?: { cwd?: string } } } }): string {
  return exec.agent?.session?.header?.cwd ?? process.cwd()
}

function agentSessionId(exec: { agent?: { session?: { id?: string } } }): string {
  return exec.agent?.session?.id ?? ''
}

function renderText(value: unknown): ContentBlock[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

/** 精简目录（无参调用返回；替代全量 list 的巨输出）——按 skill 分组统计 + 顶部指引 */
export function buildMsmIndex(root: string): string {
  const entries = loadMsmEntries(root)
  if (entries.length === 0) return '(no MSM registered — call container_admin register to add one)'
  const bySkill = new Map<string, number>()
  for (const e of entries) {
    const k = e.skill ?? 'uncategorized'
    bySkill.set(k, (bySkill.get(k) ?? 0) + 1)
  }
  const groups = [...bySkill.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([skill, count]) => `  ${skill}: ${count} MSM`)
    .join('\n')
  return (
    `${entries.length} MSMs registered (by skill):\n${groups}\n\n` +
    `Execute: msm("<name>", ["<args>"]) — e.g. msm("ssh-connect", ["status"])\n` +
    `Inspect: msm("<name>", [], inspect=true) — view usage/flags\n` +
    `Partial name returns matching candidates.\n` +
    `Full listing: use container_admin (register/deregister/check).`
  )
}

/** 模糊候选：name/description 子串匹配（未精确命中时返回 top-K，供 LLM 下轮选对） */
export function suggestMsm(root: string, query: string, limit = 5): string {
  const q = query.toLowerCase()
  const entries = loadMsmEntries(root)
  const hits = entries
    .filter((e) => e.name.toLowerCase().includes(q) || (e.description ?? '').toLowerCase().includes(q))
    .slice(0, limit)
  if (hits.length === 0) {
    return `No MSM matches "${query}". Registered: ${buildMsmIndex(root)}`
  }
  const lines = hits.map((e) => {
    const base = `${e.name} | ${e.skill ?? '-'} | ${e.category ?? '-'} | ${e.description ?? ''}`
    const flags = (e.flags ?? []).map((f) => `--${f.name} <${f.type ?? 'string'}>`).join(', ')
    return flags ? `${base} [flags: ${flags}]` : base
  })
  return `No exact MSM "${query}" — did you mean one of these?\n` + lines.join('\n')
}

export const msmTool = defineTool({
  name: 'msm',
  description:
    'Execute a registered CCC MSM (Mech & Semi-Mech). ' +
    'msm(name, args) runs it directly; name not found returns matching candidates; ' +
    'inspect=true shows usage/flags without running; no args returns a summary index. ' +
    'The full CCC MSM list is discoverable via partial-name matching or the index.',
  parameters: {
    name: {
      type: 'string',
      description: 'MSM name to execute (or a partial fragment — not found returns matching candidates)',
    },
    args: {
      type: 'array',
      items: { type: 'string' },
      description: 'Arguments passed to the MSM (optional; defaults to none). Pass "--help" as first arg to see an MSM\'s own usage.',
    },
    inspect: {
      type: 'boolean',
      description: 'true = print the MSM\'s usage/flags/params WITHOUT executing (default false)',
    },
  },
  output: {
    schema: { type: 'json' },
    render: (args, value) => renderText(value),
  },
  async execute(args, exec) {
    const root = findSerenityRoot(agentCwd(exec))
    if (!root) throw new Error('No CCC found: no .serenity file from agent cwd')
    // Skiff 白名单门控（exec 校验；skiff 角色限定的 MSM 面）
    const sessionId = agentSessionId(exec)
    const name = args.name as string | undefined
    const gate = skiffMsmGate(root, sessionId, name ? 'exec' : 'list', name)
    if (gate.reject) throw new Error(gate.reject)

    // 无 name → 精简目录
    if (!name || name.trim() === '') {
      return gate.whitelist
        ? 'MSMs allowed in this role:\n' + [...gate.whitelist].join('\n')
        : buildMsmIndex(root)
    }
    const clean = name.trim()
    // Skiff 白名单过滤：name 不在白名单 → 拒绝（角色限定）
    if (gate.whitelist && !gate.whitelist.has(clean)) {
      return `MSM "${clean}" is not in this role's whitelist. Allowed: ${[...gate.whitelist].join(', ')}`
    }

    // 精确查找：未命中 → 返回候选（list/exec 合一的发现路径）
    if (!findEntry(root, clean)) {
      const suggest = suggestMsm(root, clean)
      // 非 skiff 正常返回候选；skiff 白名单时候选也过滤
      return gate.whitelist ? `(whitelisted role — candidates filtered)\n${suggest}` : suggest
    }

    // inspect → 协议 schema（复用 prepareExec 的 --schema 协议路径）
    if (args.inspect === true) {
      return runMsmAsync(root, { action: 'exec', name: clean, args: ['--schema', clean] })
    }

    // 执行（默认即 exec；异步 execFile 不阻塞事件循环）
    return runMsmAsync(root, {
      action: 'exec',
      name: clean,
      args: (args.args as string[] | undefined) ?? [],
    })
  },
})
