/**
 * host/contract.ts — 宿主契约声明 + 运行时探针（S142 review F-05/F-06）
 *
 * 为什么存在（R↓）：dsp 与宿主（DeepSeek Harness）的契约此前以**散落的类型断言**
 * 表达——37 个文件里 80 处 `as unknown as`，类型检查被断言抹掉、运行时无校验，
 * 于是宿主改名/移除成员时 dsp **静默失效**：v1.30.5 的错误码漂移
 * （`attachment-error` → `session/attachment-invalid`）与更早的 `Session.events`
 * → `snapshotEvents()` 都是这一类。
 *
 * 本模块把契约集中声明为**数据**（单一真相源），并提供纯函数探针
 * `probeHostContract(ctx)`：在插件装载时与 `dashboard health` 中核对
 * "运行中的宿主是否仍满足 dsp 依赖的服务与成员"。
 *
 * 设计约束：
 *  - **零宿主 import**：只用结构化读取（`ctx.get` / 属性），因此 peer-only 打包
 *    （宿主依赖不进 dsp 的 node_modules）下也成立。
 *  - **事件名不在运行时探**：宿主事件是字符串键，`ctx.on` 对未知名不报错——
 *    事件名的正确性由**编译期契约测试**保证（tests/host-contract.test.ts 用真实
 *    宿主类型断言），此处只登记清单供文档/测试共用。
 *  - **缺失分级**：`required` = 缺失即 ACC 核心能力失效；否则为可降级能力。
 */

import type { Events } from 'cordis'

export type HostAccess = 'injected' | 'lazy'

export interface HostMember {
  name: string
  kind: 'function' | 'value'
}

export interface HostServiceContract {
  /** 稳定标识（报告用） */
  id: string
  /** 服务名（`ctx.get(name)` 或 `ctx.<name>`） */
  name: string
  /** injected = cordis inject 保证存在；lazy = 运行期按需取（可能 undefined） */
  access: HostAccess
  /** 依赖的成员（空 = 只要求服务存在） */
  members: readonly HostMember[]
  /** 缺失时的后果（人读，进 health 报告） */
  impact: string
  /** 缺失是否致命 */
  required: boolean
}

/** dsp 依赖的宿主服务与成员（对照 AI_LAB/dsh-harness-public @ 0.1.2-rc.1 逐一核对） */
export const HOST_SERVICES: readonly HostServiceContract[] = [
  {
    id: 'tools',
    name: 'tools',
    access: 'injected',
    members: [{ name: 'register', kind: 'function' }, { name: 'guard', kind: 'function' }],
    impact: '10 个 ACC 工具无法注册 / 机械守卫失效',
    required: true,
  },
  {
    id: 'sessions',
    name: 'sessions',
    access: 'injected',
    members: [
      { name: 'list', kind: 'function' },
      { name: 'get', kind: 'function' },
      { name: 'create', kind: 'function' },
    ],
    impact: '会话定位/rebuild/CCC 解析失效',
    required: true,
  },
  {
    id: 'agents',
    name: 'agents',
    access: 'injected',
    members: [{ name: 'create', kind: 'function' }, { name: 'get', kind: 'function' }],
    impact: 'skiff/handyman 无法创建或复用 agent',
    required: true,
  },
  {
    id: 'webServer',
    name: 'webServer',
    access: 'injected',
    members: [{ name: 'register', kind: 'function' }, { name: 'port', kind: 'value' }],
    impact: '状态接口/网关端口发现失效',
    required: true,
  },
  {
    id: 'settings',
    name: 'settings',
    access: 'injected',
    members: [{ name: 'installSection', kind: 'function' }],
    impact: '设置面板不安装 → 所有开关静默 no-op',
    required: true,
  },
  {
    id: 'systemPrompt',
    name: 'systemPrompt',
    access: 'injected',
    members: [],
    impact: 'Induction（入口 skill 段）注入失效',
    required: true,
  },
  {
    id: 'sessionProjections',
    name: 'sessionProjections',
    access: 'injected',
    members: [{ name: 'snapshot', kind: 'function' }],
    impact: '上下文压力读数失效 → rebuild 提醒不再触发',
    required: false,
  },
  {
    id: 'skills',
    name: 'skills',
    access: 'injected',
    members: [],
    impact: 'opencode skill 兼容层（.opencode/skills 注册）失效',
    required: false,
  },
  {
    id: 'shellEnv',
    name: 'shellEnv',
    access: 'injected',
    members: [],
    impact: 'DSH_SERENITY_* 环境事实注入失效',
    required: false,
  },
  {
    id: 'agentLoop',
    name: 'agentLoop',
    access: 'injected',
    members: [],
    impact: 'handyman worker agent 无法装配 preset',
    required: false,
  },
  {
    id: 'sessionTitle',
    name: 'sessionTitle',
    access: 'lazy',
    members: [{ name: 'rename', kind: 'function' }],
    impact: '会话命名 / rebuild 后重命名跳过（仅告警）',
    required: false,
  },
  {
    id: 'tokenMeter',
    name: 'tokenMeter',
    access: 'lazy',
    members: [{ name: 'estimateMessage', kind: 'function' }],
    impact: 'rebuild shadow-price 定价失效（计量不准）',
    required: false,
  },
  {
    id: 'workspaceRegistry',
    name: 'workspaceRegistry',
    access: 'lazy',
    members: [{ name: 'list', kind: 'function' }],
    impact: '工作区白名单下拉为空（外部访问配置受限）',
    required: false,
  },
  {
    id: 'sessionPersistence',
    name: 'sessionPersistence',
    access: 'lazy',
    members: [{ name: 'list', kind: 'function' }],
    impact: 'CCC 自动发现回落失效（诊断面受限）',
    required: false,
  },
  {
    id: 'connection',
    name: 'connection',
    access: 'lazy',
    members: [
      { name: 'authenticatedUrl', kind: 'function' },
      { name: 'authorizeIndex', kind: 'function' },
    ],
    impact: '双端口网关无法换取 dsh cookie → 外部反代 401',
    required: false,
  },
] as const

export interface HostEventContract {
  name: HostEventName
  /** 订阅方（文件） */
  site: string
  impact: string
  required: boolean
}

/**
 * **编译期契约**：事件名必须存在于宿主合并后的 `Events` 映射。
 *
 * 这是运行时无法验证的那一半——宿主事件是字符串键，`ctx.on('typo')` 不会报错，
 * 只会静默不订阅。`satisfies readonly (keyof Events)[]` 让 `dsh-develop typecheck`
 * 在名字写错/宿主改名时**编译失败**（v1.30.7，review F-04/F-05）。
 * 该 import 为 type-only，编译期擦除，不产生运行时依赖。
 */
export const HOST_EVENT_NAMES = [
  'agent/session-start',
  'agent/pre-step',
  'agent/turn-stopping',
  'agent/status',
  'agent/inbox/inserted',
  'session/event',
  'session/created',
  'tools/pre-execute',
  'tools/post-execute',
  'system-prompt/assemble',
] as const satisfies readonly (keyof Events)[]

export type HostEventName = (typeof HOST_EVENT_NAMES)[number]

/**
 * dsp 订阅的宿主事件清单（与 HOST_EVENT_NAMES 同源；impact/site 供 health 报告与文档）。
 */
export const HOST_EVENTS: readonly HostEventContract[] = [
  { name: 'agent/session-start', site: 'seams/context.ts, gateway.ts', impact: 'ACC 身份播种失效', required: true },
  { name: 'agent/pre-step', site: 'seams/context.ts, seams/bootstrap.ts', impact: '上下文注入/首轮锚定失效', required: true },
  { name: 'agent/turn-stopping', site: 'rebuild.ts, output-guard-seam.ts', impact: 'rebuild 不执行 / 输出守卫失效', required: true },
  { name: 'agent/status', site: 'skiff-core.ts, tools/handyman.ts', impact: '等待空闲逻辑失效', required: false },
  { name: 'agent/inbox/inserted', site: 'seams/bootstrap.ts', impact: 'first-anchor 锚定失效', required: false },
  { name: 'session/event', site: 'seams/compact.ts, seams/bootstrap.ts', impact: '压缩后重注入/晋升状态失效', required: false },
  { name: 'session/created', site: 'weixin-bridge.ts, autopilot-trajectory.ts', impact: '定时器/桥同步失效', required: false },
  { name: 'tools/pre-execute', site: 'seams/guards.ts', impact: '机械守卫（safe-mode/路径/白名单）失效', required: true },
  { name: 'tools/post-execute', site: 'seams/keeper.ts', impact: 'trajectory-assistant 计分失效', required: false },
  { name: 'system-prompt/assemble', site: 'seams/bootstrap.ts', impact: '工具目录两阶段装配失效', required: false },
] as const

/** dsp 被验证过的宿主版本范围（与 package.json peerDependencies 同源，单一真相源） */
export const REQUIRED_HOST_RANGE = '^0.1.2-rc.1'

export interface HostContractIssue {
  id: string
  kind: 'service' | 'member' | 'version'
  detail: string
  impact: string
  required: boolean
}

export interface HostContractReport {
  ok: boolean
  checked: number
  hostVersion: string | null
  versionOk: boolean
  issues: HostContractIssue[]
}

/** 最小 semver 比较（无依赖）：返回 -1 / 0 / 1；解析失败返回 null */
export function compareSemver(a: string, b: string): number | null {
  const parse = (v: string): [number, number, number, string] | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.*))?$/.exec(v.trim())
    if (!m) return null
    return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? '']
  }
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) return null
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return (pa[i] as number) < (pb[i] as number) ? -1 : 1
  }
  // 预发布版本低于同版本正式版
  const ra = pa[3]
  const rb = pb[3]
  if (ra === rb) return 0
  if (ra === '') return 1
  if (rb === '') return -1
  return ra < rb ? -1 : 1
}

/**
 * 宿主版本是否落在 dsp 被验证的范围（`^0.1.2-rc.1`）。
 * 无版本信息 → 视为未知（ok=false，detail 说明），不猜测。
 */
export function checkHostVersion(version: string | null): { ok: boolean; detail: string } {
  if (version === null) return { ok: false, detail: `host version unknown (required ${REQUIRED_HOST_RANGE})` }
  const floor = compareSemver(version, '0.1.2-rc.1')
  const ceiling = compareSemver(version, '0.2.0')
  if (floor === null || ceiling === null) {
    return { ok: false, detail: `host version "${version}" not parseable (required ${REQUIRED_HOST_RANGE})` }
  }
  if (floor < 0) return { ok: false, detail: `host ${version} is below the verified floor (required ${REQUIRED_HOST_RANGE})` }
  if (ceiling >= 0) return { ok: false, detail: `host ${version} is outside the verified range (required ${REQUIRED_HOST_RANGE})` }
  return { ok: true, detail: `host ${version} within ${REQUIRED_HOST_RANGE}` }
}

/** 结构化读取宿主服务（lazy → ctx.get；injected → 直接属性，属性缺失再试 ctx.get） */
function readService(ctx: unknown, name: string, access: HostAccess): unknown {
  const c = ctx as { get?: (n: string) => unknown } & Record<string, unknown>
  if (access === 'lazy') {
    return typeof c?.get === 'function' ? c.get(name) : undefined
  }
  const direct = c?.[name]
  if (direct !== undefined) return direct
  return typeof c?.get === 'function' ? c.get(name) : undefined
}

/**
 * 探针：核对运行中的宿主是否仍满足 dsp 依赖的服务与成员。
 *
 * @param ctx 宿主插件上下文（真实 cordis Context；测试可传结构化替身）
 * @param hostVersion 运行中宿主版本（`readDshVersion()` 结果；null = 未知）
 * @returns 报告（`ok:false` 时 `issues` 逐条给出缺失项与后果）
 */
export function probeHostContract(ctx: unknown, hostVersion: string | null = null): HostContractReport {
  const issues: HostContractIssue[] = []
  let checked = 0
  for (const svc of HOST_SERVICES) {
    checked += 1
    let value: unknown
    try {
      value = readService(ctx, svc.name, svc.access)
    } catch {
      value = undefined
    }
    if (value === undefined || value === null) {
      issues.push({
        id: svc.id,
        kind: 'service',
        detail: `service "${svc.name}" not available (${svc.access})`,
        impact: svc.impact,
        required: svc.required,
      })
      continue
    }
    for (const member of svc.members) {
      checked += 1
      const actual = (value as Record<string, unknown>)[member.name]
      const ok = member.kind === 'function' ? typeof actual === 'function' : actual !== undefined
      if (!ok) {
        issues.push({
          id: `${svc.id}.${member.name}`,
          kind: 'member',
          detail: `service "${svc.name}" is missing ${member.kind} "${member.name}"`,
          impact: svc.impact,
          required: svc.required,
        })
      }
    }
  }
  const version = checkHostVersion(hostVersion)
  if (!version.ok) {
    issues.push({ id: 'host.version', kind: 'version', detail: version.detail, impact: '契约未经该宿主版本验证（漂移风险）', required: false })
  }
  const ok = issues.every((i) => !i.required)
  return { ok, checked, hostVersion, versionOk: version.ok, issues }
}

/** 单行摘要（启动告警用） */
export function summarizeHostContract(report: HostContractReport): string {
  if (report.ok && report.issues.length === 0) {
    return `host contract ok (${report.checked} checks, host ${report.hostVersion ?? 'unknown'})`
  }
  const required = report.issues.filter((i) => i.required)
  const optional = report.issues.filter((i) => !i.required)
  const head = required.length > 0 ? `host contract BROKEN (${required.length} required)` : `host contract degraded (${optional.length} optional)`
  return `${head}: ${report.issues.map((i) => i.detail).join('; ')}`
}
