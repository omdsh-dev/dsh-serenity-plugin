/**
 * container-admin.ts — container_admin（v1.30：机务舱——容器管理面统一入口）
 *
 * ## 域结构（2026-10-19 owner 两条令后：**两域**）
 *
 * | 域 | 管什么 |
 * |---|---|
 * | `config` | **本 CCC 的全部配置面**：说明目录/按章详情 ＋ 轨迹约束（原 `role` 域，已并入） |
 * | `msm`    | MSM 注册表管理 ＋ 手册（register/deregister/check/guide/catalog/ccc-config） |
 *
 * 🔴 **`role` 域已并入 `config`**（owner 2026-10-19 裁「1 并入」）。为什么不是三个平行域：
 * `role` 管的本来就是"某条轨迹的约束面"——**一组配置**，与 `config` 是同一抽象层的两半。
 * 分着放的代价是：用户在 `config` 里看不到"轨迹怎么约束"，得先知道 `role` 这个词存在。
 * ⚠️ **旧 `role` 域仍被接受**（过渡别名，指向同一实现）——存量 CCC 的文档/脚本里到处是
 * `container_admin role validate`（实测本仓 30 处），硬切会让它们全部变成"未知域"。
 * 别名**只保留读取路径**：schema 的 `enum` 只列新名，文案只教新名。
 *
 * ## 三个动作名为什么是这三个（P3 的实现形态）
 * - `config docs`（无参）→ **使用说明目录**（第一层；只索引不复制）
 * - `config docs <chapter>` → **使用说明详情**（第二层；按章获得）
 * - `config view` → 配置**现值**（原来是唯一动作；现在是"看当前填了什么"）
 *
 * 归属（D23）：**机制在 ACC**（有哪几章、怎么路由、怎么校验），**内容在 CCC**（填什么）。
 * 语义（用户拍板"轨迹约束_admin 及系列 admin 合并成 container_admin"）：
 *   container = CCC（具体认知容器）；admin = 管理操作。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Context } from 'cordis'
import type { JsonValue } from '../kernel/json.js'
import { cccRootForExec, NO_CCC_FROM_AGENT_CWD } from '../kernel/ccc-roots.js'
import { runMsm, MSM_ACTIONS, CCC_CONFIG_REFERENCE } from './msm/service.js'
import { trajectoryConstraintMsmGate } from '../trajectory/session.js'
import { validateTrajectoryConstraint, applyTrajectoryConstraint, listTrajectoryConstraintSummary, TRAJECTORY_CONSTRAINT_GUIDE } from './trajectory-constraint-admin.js'
import { renderDocsIndex, findDocsChapter, type DocsChapter } from './config-docs.js'

function agentSessionId(exec: { agent?: { session?: { id?: string } } }): string {
  return exec.agent?.session?.id ?? ''
}

function renderText(value: unknown): ContentBlock[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

/** 管理域（container_admin 一级参数）。`role` 是**过渡别名**，不在 enum 里。 */
type AdminDomain = 'config' | 'msm'

/** 过渡别名表：旧域 → 新域（只读兼容；文案不教它） */
const DOMAIN_ALIASES: Record<string, AdminDomain> = {
  role: 'config',
}

const DOMAIN_INTRO: Record<AdminDomain, string> = {
  config:
    'CCC configuration: docs (usage-manual index) / docs <chapter> (one chapter in full) / view (current values) ' +
    '+ 轨迹约束 (guide/validate/apply/list — the old role domain, merged here)',
  msm: 'MSM registry management: register / deregister / check (DC-M1~M4 quality) / guide (dev manual) / catalog (ACC capability directory) / ccc-config (CCC config reference)',
}

/** 管理面动作映射：domain → 可执行 action（转发到底层 runMsm / 轨迹约束 逻辑） */
const ADMIN_ACTIONS: Record<AdminDomain, readonly string[]> = {
  // 轨迹约束 四动作（原 role 域）＋ 说明两层菜单 ＋ 现值
  config: ['docs', 'view', 'guide', 'validate', 'apply', 'list'],
  msm: ['register', 'deregister', 'check', 'guide', 'catalog', 'ccc-config'],
}

/** 合法 domain 名（拒绝文案与 schema enum 同源——不得各写一份） */
const DOMAIN_NAMES = Object.keys(ADMIN_ACTIONS) as AdminDomain[]

/**
 * 说明目录的章节（P3 两层菜单的**唯一注册处**）。
 *
 * 🔴 加一章 = 在这里加一项（`render` 惰性求值）。**正文不复制**：
 * 每章的真相源就在它自己的函数里（`CCC_CONFIG_REFERENCE` / `TRAJECTORY_CONSTRAINT_GUIDE`）——
 * 本表只做**切分与路由**，避免"同一段说明有第二份会漂的副本"。
 */
const DOCS_CHAPTERS: readonly DocsChapter[] = [
  {
    id: 'config',
    summary: 'CCC 配置全表——9 段各是什么、怎么填、填错会怎样（.opencode/serenity.json）',
    render: () => CCC_CONFIG_REFERENCE,
  },
  {
    id: 'trajectory-constraint',
    summary: '轨迹约束：一条轨迹怎么被约束（trajectory-constraint.json 的 schema ＋ 双白名单）',
    render: () => TRAJECTORY_CONSTRAINT_GUIDE,
  },
]

export function createContainerAdminTool(ctx: Context) {
  return defineTool({
    name: 'container_admin',
    description:
      'Container administration (the ship\'s maintenance bay — one entry for managing the CCC): ' +
      'config — CCC configuration: docs (usage-manual index) / docs <chapter> (one chapter in full) / view (current values) ' +
      '+ 轨迹约束 (guide/validate/apply/list); ' +
      'msm — MSM registry management (register/deregister/check quality DC-M1~M4) + manuals (guide dev manual / catalog ACC capability directory / ccc-config CCC configuration reference). ' +
      'Execution of registered MSMs belongs to the msm tool; this tool manages the container.',
    parameters: {
      domain: {
        type: 'string',
        enum: DOMAIN_NAMES,
        required: true,
        description: 'Management domain: config (CCC configuration + 轨迹约束) / msm (MSM registry + manuals)',
      },
      action: {
        type: 'string',
        description:
          'Domain subcommand. config: docs / view / guide / validate / apply / list; ' +
          'msm: register / deregister / check / guide / catalog / ccc-config',
      },
      /** 第二层菜单参数：`config docs <chapter>`（缺省 = 目录） */
      chapter: {
        type: 'string',
        description: 'config docs only: chapter id (omit for the index; e.g. config / trajectory-constraint)',
      },
      // register 参数（msm 域）
      name: { type: 'string', description: 'MSM name (register/deregister)' },
      path: { type: 'string', description: 'register: script relative path inside root' },
      category: { type: 'string', description: 'register: mech | semi-mech' },
      description: { type: 'string', description: 'register: one-line description' },
      skill: { type: 'string', description: 'register: owning skill' },
      flags: { type: 'string', description: 'register: flags JSON string (e.g. [{"name":"x","type":"string"}] — type:"path" enables escape guard)' },
      usage: { type: 'string', description: 'register: custom usage (auto-generated by default)' },
    },
    output: {
      schema: { type: 'json' },
      render: (args, value) => renderText(value),
    },
    async execute(args, exec): Promise<JsonValue> {
      const root = cccRootForExec(exec)
      if (!root) throw new Error(NO_CCC_FROM_AGENT_CWD)
      const sessionId = agentSessionId(exec)
      const rawDomain = String(args.domain ?? '')
      // 过渡别名：`role` → `config`（只读兼容，见文件头）
      const domain = (DOMAIN_ALIASES[rawDomain] ?? rawDomain) as AdminDomain
      const action = (args.action as string | undefined) ?? ''

      if (!DOMAIN_NAMES.includes(domain)) {
        // 拒绝文案只列新名：别名能用，但不教
        throw new Error(`container_admin requires domain: ${DOMAIN_NAMES.join(' | ')}`)
      }

      // 轨迹约束会话安全：config validate/apply/list/guide/docs/view 只读放行；
      // msm register/deregister 必拒
      if (domain === 'msm' && (action === 'register' || action === 'deregister')) {
        const gate = trajectoryConstraintMsmGate(root, sessionId, action, args.name as string | undefined)
        if (gate.reject) throw new Error(gate.reject)
      }

      // ── config 域 ──────────────────────────────────────────────────────
      if (domain === 'config') {
        switch (action) {
          // ── P3：两层菜单 ──
          case 'docs': {
            const chapter = (args.chapter as string | undefined)?.trim() ?? ''
            // 第一层：目录（**不触发任何正文**）
            if (chapter === '') return { docs: renderDocsIndex(DOCS_CHAPTERS), chapters: DOCS_CHAPTERS.map((c) => c.id) }
            // 第二层：按章详情
            const found = findDocsChapter(DOCS_CHAPTERS, chapter)
            if (found === null) {
              throw new Error(
                `container_admin config docs: unknown chapter "${chapter}". ` +
                  `Available: ${DOCS_CHAPTERS.map((c) => c.id).join(' | ')} (omit the chapter for the index)`,
              )
            }
            return { chapter: found.id, docs: found.render() }
          }
          // ── 现值（原 config 域的唯一动作） ──
          case 'view':
          case '': {
            const ref = runMsm(root, { action: 'ccc-config' })
            return { config: ref }
          }
          // ── P4：原 role 域四动作（并入本域） ──
          case 'guide': return { guide: TRAJECTORY_CONSTRAINT_GUIDE }
          case 'validate': return validateTrajectoryConstraint(root)
          case 'apply': return applyTrajectoryConstraint(root)
          case 'list': return listTrajectoryConstraintSummary(root)
          default:
            throw new Error(`container_admin config requires action: docs | view | guide | validate | apply | list`)
        }
      }

      // ── msm 域 → 原 acc_msm 管理 action（exec 不在此——exec 走 msm 工具） ──
      if (domain === 'msm') {
        const mgmtActions: string[] = ['register', 'deregister', 'check', 'guide', 'catalog', 'ccc-config']
        if (!mgmtActions.includes(action)) {
          throw new Error(`container_admin msm requires action: ${mgmtActions.join(' | ')} (execution goes through the msm tool)`)
        }
        // 同步执行（register/deregister 走 git 精提交；check/guide/catalog/ccc-config 纯读）
        const out = runMsm(root, {
          action: action as (typeof MSM_ACTIONS)[number],
          name: args.name as string | undefined,
          skill: args.skill as string | undefined,
          path: args.path as string | undefined,
          category: args.category as string | undefined,
          description: args.description as string | undefined,
          flags: args.flags as string | undefined,
          usage: args.usage as string | undefined,
        })
        // v1.34.1：原 SEP（Session Extension Protocol）章节已随 SEP 废除一并移除
        // （所有者裁决「能落 harness 已有原语，就不要自造协议 + 脚本管道」）——手册只留 MSM 通用内容。
        // 轨迹挂 skill 的扩展面见 docs/cognitive-trajectory-skill-injection.md（SESSION.md frontmatter + section）。
        return out
      }

      throw new Error(`container_admin requires domain: ${DOMAIN_NAMES.join(' | ')}`)
    },
  })
}
