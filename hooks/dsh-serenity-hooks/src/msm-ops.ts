/**
 * msm-ops.ts — acc_msm 纯操作层（零 DSH 依赖）
 *
 * MSM（Mech & Semi-Mech）框架：list / exec / admin(register|deregister|check)。
 * 复用 CCC 的 mech-registry.json（v1 或数组格式）。cwd 钉在 CCC 根。
 */

import {
  existsSync,
  statSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  realpathSync,
} from 'node:fs'
import { execFileSync, spawnSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, dirname, relative, resolve } from 'node:path'
import { platform } from 'node:process'
import { classifyPath, readCccName as readCccNameFromCcc } from './ccc.js'
import { ACC_VERSION } from './constants.js'
import type { JsonValue } from './json.js'

const execFileAsync = promisify(execFile)

export const MSM_TIMEOUT_MS = 600_000

// ── Windows bun 真路径探测：裸 'bun'/'.cmd' 在 CreateProcess 下不可 spawn（EINVAL/ENOENT）──
// 优先定位真 bun.exe（PE）绝对路径 → 零 shell、argv 保真；命中失败返回 null → 走 npx shell 兜底。
const BUN_EXE_CANDIDATES: ReadonlyArray<() => string> = [
  // 官方安装器：~\.bun\bin\bun.exe
  () => join(process.env['USERPROFILE'] ?? process.env['HOME'] ?? '', '.bun', 'bin', 'bun.exe'),
  // npm 包装包：%APPDATA% 或 %LOCALAPPDATA% 下 node_modules\bun\bin\bun.exe
  () => join(process.env['APPDATA'] ?? '', 'npm', 'node_modules', 'bun', 'bin', 'bun.exe'),
  () => join(process.env['LOCALAPPDATA'] ?? '', 'npm', 'node_modules', 'bun', 'bin', 'bun.exe'),
]
let bunExeCache: string | null | undefined
function bunExecutablePath(): string | null {
  if (bunExeCache !== undefined) return bunExeCache
  if (platform !== 'win32') { bunExeCache = 'bun'; return bunExeCache }
  for (const cand of BUN_EXE_CANDIDATES) {
    try {
      if (existsSync(cand())) { bunExeCache = cand(); return bunExeCache }
    } catch { /* 单个候选失败继续 */ }
  }
  bunExeCache = null
  return null
}

/** CCC 名：从 .serenity 解析（review P2-2 统一收口到 ccc.ts readCccName——跳 # 注释/空行首非空行；此处保留导出名兼容内部调用） */
export function readCccName(root: string): string | null {
  return readCccNameFromCcc(root)
}

/**
 * path-arg 逃逸校验：根内 + symlink 防御（对齐 osp validatePathArgsFromTokens）。
 * symlink 指向根外 → 拒绝（realpath 解析后与根前缀比对）。
 */
function assertPathInsideRoot(root: string, value: string, flagName: string): void {
  const abs = resolve(root, value)
  if (classifyPath(abs, root) === 'outside') {
    throw new Error(`Path escape blocked: --${flagName}=${value} escapes the CCC root`)
  }
  if (existsSync(abs)) {
    try {
      const real = realpathSync(abs)
      if (classifyPath(real, root) === 'outside') {
        throw new Error(`Path escape blocked: --${flagName}=${value} resolves via symlink outside the root (${real})`)
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes('symlink')) throw e
      /* realpath 失败（权限等）放行——后续执行会报错 */
    }
  }
}

/** 业务子进程 env：注入 SERENITY_ROOT / SERENITY_CCC / SERENITY_VERSION（对齐 osp） */
function buildMsmEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SERENITY_ROOT: root,
    SERENITY_CCC: readCccName(root) ?? '',
    SERENITY_VERSION: ACC_VERSION,
  }
}

/**
 * Windows 兼容（审计观察点 A）：`.cmd` 不能直接被 CreateProcess 解析——
 * `execFile('npx')` / `spawnSync('npx')` 在 Windows 必 ENOENT（需 shell 或显式 .cmd）。
 * bun 无扩展名（bun.exe 可被 libuv 按 PATHEXT 解析），保持 'bun'。
 */
const NPX_BIN = process.platform === 'win32' ? 'npx.cmd' : 'npx'

export type MsmAction = 'list' | 'exec' | 'register' | 'deregister' | 'check' | 'guide' | 'ccc-config' | 'catalog'

export const MSM_ACTIONS: readonly MsmAction[] = ['list', 'exec', 'register', 'deregister', 'check', 'guide', 'ccc-config', 'catalog']

/**
 * ACC 能力目录（需求④ S142 用户拍板："acc 配置各自做 guide 越来越多，整合成目录式使用指南"）。
 * 目录在前、详情各归各——**单一真相源**：本目录只索引"去哪个工具/子命令看详情"，不复制详情
 * （避免 skiff_admin/weixin-doctor 等 guide 全文重复 → 多真相源 → 失同步）。
 * 后续新增功能只需在此加一行（低熵可演进）。
 */
export const ACC_CATALOG = `═══ ACC Usage Catalog ═══
Directory of ACC capabilities — each area lists where to go for details (guides live with their feature; this catalog only points).

  ① 会话与轨迹        → session tool（list/show/create/use/close/health/qa/archive/summary/hook-develop-guide）
                         session_rebuild（超限重建；阈值 K 见 ccc-config / 设置面板重建阈值K）
  ② 认知质量框架      → eap（E↑/R↓/S↑）/ neat（Neat 协议）/ cce（认知连续性工程）——渐进披露，无参即全文
  ③ 工具与执行        → cc_fs（文件系统 15 子命令）/ cc_git（git）/ acc_kit（health 含注册表检查/time/wait）
                         acc_msm（MSM 框架：本工具 list/exec/register/deregister/check/guide/ccc-config/catalog）
                         handyman（杂工 agent 编排——guide 子命令：acc_msm exec handyman guide）
  ④ 角色与对外面      → skiff_admin（Skiff 认知子集角色：guide/validate/apply/list——acc_msm exec skiff_admin guide）
                         ACP（程序化 JSON-RPC 3100）/ Skiff 问答页（公网 ask）——面板「外部能力」组
  ⑤ 自主与接入        → autopilot-trajectory（Autopilot 一站式：all/init/random/diag/doc/check/status/guide）
                         weixin 微信桥（配置/扫码/路由/消息 hook——CCC 侧 weixin-doctor MSM：acc_msm exec weixin-doctor guide）
  ⑥ CCC 配置总览      → acc_msm ccc-config（8 段：handyman/sessionKeeper/localstore/hooks/safeMode/skiff/autopilotTrajectory/weixin）
  ⑦ 注册表与安全      → mech-registry.json 由 acc_msm register/deregister 管理（写保护——不可直接编辑）
                         acc_kit health 输出 registry 完整性检查；损坏恢复指引见 health registry.issues

每区：一句话定位 + 详细入口（工具名 / guide 子命令）。详情永远以对应工具的 guide/ccc-config 为单一真相源。
`

export const MSM_GUIDE = `MSM Development Manual (Mech & Semi-Mech framework)

## What it is
MSM = the executable-unit layer. Mech is pure TS with zero LLM reasoning; Semi-Mech is a TS framework + LLM decision points.
MSM is ACC's deterministic executable-unit layer — all shell/exec operations go through MSM and cannot be bypassed.

## Registering a new MSM (acc_msm register)
1. Write the script under <skill>/scripts/ (runnable via tsx; must include a main() CLI guard with an import.meta.url check)
2. acc_msm register <name> --skill <s> --path <script path relative to root> --category <mech|semi-mech> --description <desc>
3. Auto-writes mech-registry.json (preserving the original format) + git commit (commits only the registry file)
4. Validation: path must be inside root, script must exist, name must be globally unique

## flag schema (v1)
flags is a new-style object array for parameter validation and path-escape guarding:
  [{"name":"output","type":"string","description":"output path"},
   {"name":"target","type":"path","description":"operation target (type:path enables in-root validation + symlink defense)"},
   {"name":"force","type":"boolean","description":"force mode","default":false}]
- {name, type} format — new style, type:"path" enables the path-escape guard
- {flag, description} format — old style, CLI flag description string
- On registration, flags are passed via acc_msm register --flags '<json>' (the tool currently parses the name style)

## Script conventions
- Top-of-file documentation: purpose / usage / exit codes
- Exit codes: 0 success / 1 user / 2 system / 3 operator (per ACC protocol classification)
- main() CLI guard (DC-M2): the script must start with
    if (import.meta.url === \`file://\${process.argv[1]}\`) { main() }
  or an equivalent isMain / require.main === check — so vitest imports never trigger top-level code
- A paired .test.ts or .spec.ts (DC-M1, vitest)
- Business subprocess environment: SERENITY_ROOT / SERENITY_CCC / SERENITY_VERSION injected

## Interaction & confirmation conventions (no blocking confirmation)
- MSMs run in **user-less subprocesses** (spawn/execFile, 600s timeout) — **never** use
  readline / prompt / process.stdin etc. to block waiting for user input (it would hang until killed by the timeout)
- When a second confirmation is needed: **directly return the confirmation request** (list the operation to perform and its impact + how to retry with the confirmation flag),
  returning a non-zero exit code (or an explicit hint)
- After the agent confirms, **re-invoke the MSM with the confirmation flag** (e.g. --confirm / --yes / --force) to retry
- Standard mode (two-phase):
  1. First call: destructive/confirmation-requiring operation detected and no confirmation flag present → output the confirmation request (list operation/impact/rollback),
     exit non-zero (e.g. 1 user), **perform no changes**
  2. After the agent evaluates, re-invoke: with the confirmation flag → execute and output the result
- Applies to: delete/overwrite/push/batch operations and other irreversible or wide-impact operations
- Anti-example (forbidden): readline waiting for user input, process.stdin.on('data') blocking waits
  (MSMs have no stdin interaction channel — they hang until the 600s timeout)

## Quality checks (acc_msm check, DC-M1~M4)
DC-M1 has .test.ts/.spec.ts; DC-M2 has a main() guard (function main( / isMain / require.main === / import.meta.url);
DC-M3 bidirectional: scripts unregistered + registry references missing scripts; DC-M4 path-type flags marked type:"path"

## Self-description (protocol flags, first argument only)
acc_msm exec <name> --list        — list all MSMs
acc_msm exec <name> --schema <n>   — view a specific MSM's parameter schema
acc_msm exec <name> --format=json  — JSON output mode (remaining args passed through losslessly)
`

/** CCC 配置参考（对齐 osp ccc-config action） */
export const CCC_CONFIG_REFERENCE = `═══ CCC Configuration Reference ═══

CCC-level features are configured in .opencode/serenity.json.
Below are all available configuration sections.

── 1. handyman.models ──
handyman（杂工）工具可用模型白名单（provider/model 列表）；未配置时 handyman 报错要求配置。
缺省模型 = models[0]（可用 handyman.defaultModel 指定，必须 ∈ models）。

  Config:
    { "handyman": { "models": ["provider/model-name"] } }

  Example:
    { "handyman": { "models": ["minimax-cn-coding-plan/MiniMax-M3"], "defaultModel": "minimax-cn-coding-plan/MiniMax-M3", "maxRounds": 100, "maxParallel": 10 } }

── 2. sessionKeeper.threshold ──
SESSION-KEEPER 提醒机制的积分阈值（非 headless 主 agent）。
按工具调用加权 + 耗时计分；达到阈值注入提醒，要求模型回复 ACK 码。

  Config:
    { "sessionKeeper": { "threshold": 150 } }

  计分：write/edit = 3，task = 10，read/grep/glob/msm 等 = 1，时间 = 1/分钟
  默认：150

── 3. localstore.gitTrack ──
localstore.json 的 git 策略：allow 可提交 / deny 禁提交（默认 deny）。
deny 时写入自动确保 .gitignore 含该文件（物理保证），cc_git commit 会检查拒绝。

  Config:
    { "localstore": { "gitTrack": "allow" } }

── 4. hooks.autoRestoreSession ──
会话自动恢复（默认 true；受 events 门控——仅根会话 + 已有对话历史才恢复）。

  Config:
    { "hooks": { "autoRestoreSession": false } }

── 5. safeMode / blacklist ──
safe-mode 由 WebUI 开关控制（写 .serenity-safe-on 标记）；黑名单路径受 guards seam 拦截。

  Config:
    { "safeMode": { "blacklist": [".secrets/"] } }

── 6. skiff.roles（F4 认知子集角色）──
Skiff 角色 = 全知全能 trajectory 的任意子集（CCC 定义）。每角色独立模型 + 双白名单
（MSM 白名单 msms[] 与非 MSM 工具白名单 tools[]，白名单外全隐藏；skill 加载恒可用）。
trajectory 纪律子集（session/keeper/rebuild 参与项）默认全关 = 完全独立。
systemPrompt 内联 或 systemPromptFile（.md 引用，推荐）——角色会话的完整人格/边界提示词。
validate 校验 / apply 生效 / list 查看：acc_msm exec skiff_admin <guide|validate|apply|list>。

  Config:
    { "skiff": { "roles": {
        "qa": {
          "model": "provider/model",
          "msms": ["web-search", "vlm-describe"],
          "tools": ["read", "grep", "glob"],
          "systemPromptFile": ".opencode/skiff/qa.md"
        } } } }

── 7. autopilotTrajectory（自动巡航轨迹）──
CCC 定义的一条自主 trajectory——时钟到点自动唤起（前台注入，用户可见可介入）。
未配置或 enabled=false → 完全不启动（零资源占用）。多 CCC 独立：每 CCC 自己的配置。
唤起消息四段式：轨迹焦点 topPrompt（最先注入，稳定锚）→ 身份锚定 → 先验偏见
（CCC 根脚本 biasProvider 输出）→ 任务。目标会话 session 必填（目录须带 --auto 后缀）。
诊断/状态/立即唤起：acc_msm exec autopilot-trajectory <all|check|status|diag>。

  Config:
    { "autopilotTrajectory": {
        "enabled": true,
        "intervalHours": 2,
        "session": "S151",
        "biasProvider": "autopilot-bias.ts",
        "topPrompt": "本轨迹核心目标/纪律/质量要求（CCC 自填，防漂移）",
        "avoidWakeHours": { "start": 8, "end": 18 }
      } }

── 8. weixin（微信桥 F4c-3，含消息记录 hook）──
CCC 级微信个人号接入（iLink 协议）：dsh 一进程多 CCC，每 CCC 独立对接微信桥。
账号/路由/开关在此文件；**bot_token 凭据在 CCC localstore credential scope**
（扫码绑定后自动写入，永不进 git 明文面）。
路由 user → role：exact 优先，* 通配兜底；role 必须 ∈ 该 CCC skiff.roles。
面板（WebUI 设置 → 微信桥）可扫码绑定/移除账号/编辑路由；acc_msm exec weixin-doctor
<status|diag|verify> 排查。凭据主动查看：localstore get WEIXIN_<ACCOUNT>_TOKEN。

  Config:
    { "weixin": {
        "enabled": true,
        "hook": "scripts/weixin-message-hook.ts",
        "accounts": [{ "accountId": "wechat-1", "name": "家庭助手", "enabled": true }],
        "routes": [{ "user": "*", "role": "zhaocai" }]
      } }

  ▸ weixin.hook（消息记录 hook，v1.27.13）：
  微信桥每收/发一条消息触发一次 CCC 自写脚本，由 CCC 自行持久化保存（存哪/存成什么
  /是否入库全归 CCC——ACC 不绑定存储）。未配置 hook → 零变化（不触发）。

  触发（双向）：
    incoming  = 用户 → bot：路由命中后、媒体落盘后触发（文本含语音转写；媒体带落盘 relPath）
    outgoing  = bot → 用户：回复发送成功后触发（reply = 用户实际收到的纯文本，已剥离 think）

  脚本约定（事件 JSON 单行经 stdin 传入；bun 优先 node 兜底）：
    #!/usr/bin/env bun  或  node script.js —— 读 process.stdin 整段 JSON.parse
    const ev = JSON.parse(await new Response(process.stdin).text())
    ev.event === 'incoming' | 'outgoing'

  事件 schema（**不含任何会话凭据**——context_token/bot_token/token/aes_key 均不出现）：
    { "event": "incoming", "ts": 1788359941488, "cccRoot": "/path/ccc",
      "accountId": "wechat-1", "userId": "u1@im.wechat",
      "sessionId": "skiff-weixin-xxx", "role": "zhaocai",
      "message": { "text": "你好", "media": [{ "kind": "image", "relPath": "_tmp/weixin-inbound/<hash>/img_x.jpg" }] } }
    { "event": "outgoing", "ts": ..., "cccRoot": ..., "accountId": ...,
      "userId": ..., "sessionId": ..., "role": ...,
      "reply": "已记录（纯文本）" }

  示例脚本（追加到按日文件——持久化归 CCC 自选：文件/DB/远端均可）：
    const fs = require('node:fs'); const p = '/path/ccc/AGENT_SESSIONS/_weixin-log.jsonl';
    fs.appendFileSync(p, JSON.stringify(ev) + '\\n');

  执行语义（旁路容忍）：异步 fire-and-forget + 15s 超时 kill + 失败仅日志——
  微信桥消息处理/回复不受 hook 影响；脚本须在 CCC 根内（路径逃逸拒绝）。
  媒体 relPath 指向 _tmp/weixin-inbound/（临时目录）——需持久保存媒体文件请自行 copy。
`


export interface MsmFlag {
  name: string
  type?: string
  description?: string
  required?: boolean
  default?: unknown
}

export interface MsmEntry {
  name: string
  path: string
  skill?: string
  category?: string
  description?: string
  usage?: string
  flags?: MsmFlag[]
}

export interface MsmArgs {
  action: MsmAction
  name?: string
  args?: string[]
  skill?: string
  path?: string
  category?: string
  description?: string
  /** register: flags JSON 字符串（对齐 osp --flags 入参；如 '[{"name":"hook","type":"string",...}]'） */
  flags?: string
  /** register: 自定义 usage（缺省 'acc_msm exec <name> [args...]'） */
  usage?: string
}

export function parseRegistry(raw: string): MsmEntry[] {
  // BOM 剥离（Windows 审计问题 16）：带 \uFEFF 的注册表 JSON 解析失败
  const data = JSON.parse(raw.replace(/^\uFEFF/, '')) as unknown
  if (Array.isArray(data)) return data as MsmEntry[]
  const entries = (data as { entries?: unknown }).entries
  if (!Array.isArray(entries)) throw new Error('invalid registry: missing entries[]')
  return entries as MsmEntry[]
}

/**
 * 注册表单级化（需求⑤a S142 用户拍板：注册表只有一级——对齐 osp cccName 单聚合档）：
 * 所有 entry 集中写入 `.opencode/skills/<cccName>/references/mech-registry.json`
 * （cccName = .serenity 首行，即顶层入口 skill 目录），skill 只作 entry 字段。
 * 不再扫描/写入各 skill 目录的分散注册表（历史形态 v1.14~v1.27，register --skill
 * 曾写入各自 skill 目录 —— 多真相源，废弃）。
 */
export function findRegistries(root: string): string[] {
  const cccName = readCccName(root)
  if (!cccName) return []
  const aggregate = join(root, '.opencode', 'skills', cccName, 'references', 'mech-registry.json')
  return existsSync(aggregate) ? [aggregate] : []
}

export function loadMsmEntries(root: string): MsmEntry[] {
  const byName = new Map<string, MsmEntry>()
  for (const regPath of findRegistries(root)) {
    for (const entry of parseRegistry(readFileSync(regPath, 'utf-8'))) {
      if (!byName.has(entry.name)) byName.set(entry.name, entry)
    }
  }
  return [...byName.values()]
}

export function findEntry(root: string, name: string): MsmEntry | null {
  return loadMsmEntries(root).find((e) => e.name === name) ?? null
}

/** 扫描各 skill scripts/ 下的非测试脚本（DC-M3 正向基准，对齐 osp） */
export function scanSkillScripts(root: string): string[] {
  const out: string[] = []
  const skillsDir = join(root, '.opencode', 'skills')
  if (!existsSync(skillsDir)) return out
  for (const skill of readdirSync(skillsDir)) {
    const scriptsDir = join(skillsDir, skill, 'scripts')
    if (!existsSync(scriptsDir)) continue
    for (const f of readdirSync(scriptsDir)) {
      if (/\.(ts|js|mjs)$/.test(f) && !/\.(test|spec)\./.test(f)) {
        out.push(join('.opencode', 'skills', skill, 'scripts', f))
      }
    }
  }
  return out.sort()
}

/**
 * 注册表写入路径（需求⑤a 单级化）：永远返回 cccName 聚合档。
 * skill 参数保留签名（兼容调用方）但只进 entry 字段，不决定写入位置。
 */
function registryPathFor(root: string, _skill?: string): string {
  const cccName = readCccName(root) ?? 'unknown'
  return join(root, '.opencode', 'skills', cccName, 'references', 'mech-registry.json')
}

function writeRegistry(path: string, entries: MsmEntry[], isV1Wrapped = true): void {
  mkdirSync(dirname(path), { recursive: true })
  const payload = isV1Wrapped
    ? JSON.stringify({ version: 1, description: 'MSM registry (managed by acc-msm / dsh-serenity-hooks)', entries }, null, 2) + '\n'
    : JSON.stringify(entries, null, 2) + '\n'
  writeFileSync(path, payload, 'utf-8')
}

export function runMsm(root: string, args: MsmArgs): JsonValue {
  switch (args.action) {
    case 'list': {
      const entries = loadMsmEntries(root)
      const cccName = readCccName(root) ?? 'unknown'
      const header = `(serenity-plugin v${ACC_VERSION}) CCC:${cccName} Root:${root}`
      if (entries.length === 0) return `${header}\n(no MSM registered)`
      const lines = entries.map((e) => {
        const base = `${e.name} | ${e.skill ?? '-'} | ${e.category ?? '-'} | ${e.description ?? ''}`
        if (e.flags && e.flags.length > 0) {
          const flags = e.flags.map((f) => `--${f.name} <${f.type ?? 'string'}>`).join(', ')
          return `${base} [flags: ${flags}]`
        }
        return base
      })
      return `${header}\n` + lines.join('\n')
    }

    case 'guide':
      return { guide: MSM_GUIDE }

    case 'catalog':
      return { catalog: ACC_CATALOG }

    case 'exec': {
      const { entry, businessArgs, fmtJson, hasHelp, protocol } = prepareExec(root, args)
      const p = protocolResult(protocol)
      if (p !== undefined) return p
      // bun 优先（可直跑 TS），npx shell 兜底；注入 SERENITY_* env（对齐 osp）。
      // Windows 修复：裸 'bun'/npx.cmd 不可被 CreateProcess spawn（ENOENT/EINVAL）——
      // 先探测真 bun.exe 绝对路径（零 shell、argv 保真），命中失败才走 npx via shell。
      const baseOpts: import('node:child_process').SpawnSyncOptionsWithStringEncoding = { cwd: root, encoding: 'utf-8', timeout: MSM_TIMEOUT_MS, stdio: ['pipe', 'pipe', 'pipe'], env: buildMsmEnv(root) }
      const bunBin = bunExecutablePath()
      let r = bunBin
        ? spawnSync(bunBin, [entry.path, ...businessArgs], baseOpts)
        : { error: { code: 'ENOENT' } as NodeJS.ErrnoException, status: null, stdout: '', stderr: '', pid: 0, signal: null }
      if (r.error && isBunMissing(r.error as NodeJS.ErrnoException)) {
        r = spawnSync(NPX_BIN, ['tsx', entry.path, ...businessArgs], { ...baseOpts, shell: platform === 'win32' })
      }
      return msmExecResult(entry.name, r.status ?? 2, r.stdout ?? '', r.stderr ?? '', fmtJson, hasHelp)
    }

    case 'register': {
      const name = args.name ?? ''
      const { skill, path, category, description } = args
      if (!name) throw new Error('register requires name')
      if (!path || !category || !description) throw new Error('register requires path/category/description')
      // 对齐 osp：path 必须根内 + 脚本必须存在
      const scriptAbs = resolve(root, path)
      if (classifyPath(scriptAbs, root) === 'outside') {
        throw new Error(`MSM register: path "${path}" escapes CCC root "${root}"`)
      }
      if (!existsSync(scriptAbs)) {
        throw new Error(`MSM script not found: "${path}"`)
      }
      // 对齐 osp：name 全局唯一（聚合所有注册表判重，与 loadMsmEntries 一致）
      if (loadMsmEntries(root).some((e) => e.name === name)) {
        throw new Error(`MSM already registered: "${name}"`)
      }
      const regPath = registryPathFor(root, skill)
      // 对齐 osp：保留原注册表格式（数组 vs v1 wrapper）；剥 BOM 防 Windows 编辑器 \uFEFF（审计#13）
      // P3-③ review：**首建统一 v1 wrapper**——文件不存在（raw===''）时旧逻辑 isV1Wrapped=false
      // → 裸数组，与 writeRegistry 默认 v1 wrapper 并存（格式分裂）。首建一律 v1 wrapper。
      const raw = existsSync(regPath) ? readFileSync(regPath, 'utf-8').replace(/^\uFEFF/, '') : ''
      const isV1Wrapped = raw === '' ? true : !Array.isArray(JSON.parse(raw))
      const entries = existsSync(regPath) ? parseRegistry(readFileSync(regPath, 'utf-8')) : []
      // flags/usage 入参（对齐 osp：可选，缺省空数组 / 自描述 usage）
      let flags: MsmFlag[] | undefined
      if (args.flags) {
        try {
          const parsed = JSON.parse(args.flags) as unknown
          if (!Array.isArray(parsed)) throw new Error('flags must be a JSON array')
          flags = parsed as MsmFlag[]
        } catch (e) {
          throw new Error(`register flags parse failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      entries.push({
        name, path, skill, category, description,
        usage: args.usage ?? `acc_msm exec ${name} [args...]`,
        flags: flags ?? [],
      })
      writeRegistry(regPath, entries, isV1Wrapped)
      try {
        // 对齐 osp：精提交（只 add 注册表文件，非 add -A）
        const relRegistry = relative(root, regPath)
        execFileSync('git', ['add', '--', relRegistry], { cwd: root, stdio: 'pipe' })
        execFileSync('git', ['commit', '-m', `chore(msm): register ${name}`], { cwd: root, stdio: 'pipe' })
      } catch {
        /* 非 git 环境忽略 */
      }
      return { registered: name, registry: relative(root, regPath) }
    }

    case 'deregister': {
      const name = args.name ?? ''
      for (const regPath of findRegistries(root)) {
        // 剥 BOM 防 Windows 编辑器 \uFEFF（审计#13，与 parseRegistry 一致）
        const dRaw = readFileSync(regPath, 'utf-8').replace(/^\uFEFF/, '')
        const isV1Wrapped = !Array.isArray(JSON.parse(dRaw))
        const entries = parseRegistry(readFileSync(regPath, 'utf-8'))
        const idx = entries.findIndex((e) => e.name === name)
        if (idx >= 0) {
          entries.splice(idx, 1)
          writeRegistry(regPath, entries, isV1Wrapped)
          try {
            const relRegistry = relative(root, regPath)
            execFileSync('git', ['add', '--', relRegistry], { cwd: root, stdio: 'pipe' })
            execFileSync('git', ['commit', '-m', `chore(msm): deregister ${name}`], { cwd: root, stdio: 'pipe' })
          } catch {
            /* 忽略 */
          }
          return { deregistered: name }
        }
      }
      throw new Error(`MSM not registered: "${name}"`)
    }

    case 'ccc-config':
      return CCC_CONFIG_REFERENCE

    case 'check': {
      const entries = loadMsmEntries(root)
      const issues: { name: string; check: string; detail: string }[] = []
      // DC-M3 正向：扫描 skills scripts/ 下未注册的脚本（对齐 osp 脚本驱动）
      // win32 路径形式统一（正斜杠 + 大小写）避免误报（审计问题 15）
      const norm = (p: string): string => p.split('\\').join('/').toLowerCase()
      const registeredPaths = new Set(entries.map((e) => norm(e.path)))
      for (const scriptPath of scanSkillScripts(root)) {
        if (!registeredPaths.has(norm(scriptPath))) {
          issues.push({ name: scriptPath, check: 'M3', detail: 'script not registered in mech-registry' })
        }
      }
      for (const e of entries) {
        const script = join(root, e.path)
        const scriptExists = existsSync(script)
        // DC-M3 反向：注册表引用但脚本缺失
        if (!scriptExists) issues.push({ name: e.name, check: 'M3', detail: `script missing (${e.path})` })
        // DC-M1：有 .test.ts 或 .spec.ts（对齐 osp）
        const testFileTs = script.replace(/\.ts$/, '.test.ts')
        const testFileSpec = script.replace(/\.ts$/, '.spec.ts')
        if (!existsSync(testFileTs) && !existsSync(testFileSpec)) {
          issues.push({ name: e.name, check: 'M1', detail: 'no .test.ts / .spec.ts' })
        }
        // DC-M2：main() 守卫（function main( / isMain / require.main === / import.meta.url，对齐 osp 判定）
        if (scriptExists) {
          const src = readFileSync(script, 'utf-8')
          const hasGuard =
            /function main\(/.test(src) ||
            /\bisMain\b/.test(src) ||
            /require\.main\s*===/.test(src) ||
            /import\.meta\.url/.test(src)
          if (!hasGuard) issues.push({ name: e.name, check: 'M2', detail: 'no main() guard' })
        }
        // DC-M4：路径型 flag 必须标记 type:"path"（对齐 osp）
        for (const f of e.flags ?? []) {
          if ('name' in f && /path|file|dir/i.test(f.name) && f.type !== 'path') {
            issues.push({ name: e.name, check: 'M4', detail: `flag --${f.name} should be type:"path"` })
          }
        }
      }
      return { checked: entries.length, issues }
    }

    default:
      throw new Error(`Unknown action: ${args.action as string}`)
  }
}

/** 解析并校验 exec 参数：返回可执行条目 + 业务参数（list/schema 协议 flag 已分流） */
export interface PreparedExec {
  entry: MsmEntry
  businessArgs: string[]
  fmtJson: boolean
  /** 业务参数是否含 --help/-h（exit≠0 时不追加 TIP，对齐 osp） */
  hasHelp: boolean
  /** 协议结果（--list / --schema）；非协议执行时为 undefined */
  protocol?: { list: { name: string; category: string | null }[] } | { schema: { name: string; path: string; flags: { name: string; type: string | null; description: string | null }[] } }
}

export function prepareExec(root: string, args: MsmArgs): PreparedExec {
  const name = args.name ?? ''
  const entry = findEntry(root, name)
  if (!entry) throw new Error(`MSM not registered: "${name}"`)
  const business = args.args ?? []

  // 协议 flag：仅在业务参数**首位**识别（--list / --schema <name> / --format=json）——
  // 业务参数中后置的同名 flag 一律无损透传（对齐 osp 无损透传承诺，避免误拦截）
  if (business[0] === '--list') {
    return {
      entry,
      businessArgs: [],
      fmtJson: false,
      hasHelp: false,
      protocol: { list: loadMsmEntries(root).map((e) => ({ name: e.name, category: e.category ?? null })) },
    }
  }
  if (business[0] === '--schema') {
    const target = business[1]
    const found = target ? loadMsmEntries(root).find((e) => e.name === target) : null
    if (!found) throw new Error(`MSM not registered: "${target}"`)
    return {
      entry,
      businessArgs: [],
      fmtJson: false,
      hasHelp: false,
      protocol: { schema: { name: found.name, path: found.path, flags: (found.flags ?? []).map((f) => ({ name: f.name, type: f.type ?? null, description: f.description ?? null })) } },
    }
  }
  const fmtJson = business[0] === '--format=json'
  const businessArgs = fmtJson ? business.slice(1) : business
  const hasHelp = businessArgs.includes('--help') || businessArgs.includes('-h')

  // path-arg 逃逸校验（ACC 标准，对齐 osp）：flags 中 type:"path" 的参数值必须根内 + symlink 防御
  for (const flag of entry.flags ?? []) {
    if (flag.type !== 'path') continue
    const eq = businessArgs.find((a) => a.startsWith(`--${flag.name}=`))
    if (eq) {
      assertPathInsideRoot(root, eq.slice(flag.name.length + 3), flag.name)
    } else {
      const idx = businessArgs.indexOf(`--${flag.name}`)
      if (idx >= 0 && businessArgs[idx + 1]) {
        assertPathInsideRoot(root, businessArgs[idx + 1]!, flag.name)
      }
    }
  }

  const script = resolve(root, entry.path)
  if (classifyPath(script, root) === 'outside') throw new Error(`MSM script escapes CCC root: "${entry.path}"`)
  if (!existsSync(script)) throw new Error(`MSM script not found: "${entry.path}"`)
  return { entry: { ...entry, path: script }, businessArgs, fmtJson, hasHelp }
}

/** 协议结果扁平化：{list|schema} 包装 → 顶层值（兼容旧契约）；非协议返回 undefined */
function protocolResult(protocol: PreparedExec['protocol']): JsonValue | undefined {
  if (!protocol) return undefined
  if ('list' in protocol) return protocol.list as unknown as JsonValue
  if ('schema' in protocol) return protocol.schema as unknown as JsonValue
  return undefined
}

/** 失败 TIP（对齐 osp：业务 exit≠0 且未传 --help 时追加提示） */
function helpTip(): string {
  return '\n[TIP] Pass "--help" as the first arg to see this MSM\'s usage and required flags.'
}

function msmExecResult(name: string, status: number, stdout: string, stderr: string, fmtJson: boolean, hasHelp = false): JsonValue {
  const tip = status !== 0 && !hasHelp ? helpTip() : ''
  if (fmtJson) {
    return status === 0
      ? { name, exit: 0, ok: true, data: stdout.trim() }
      : { name, exit: status, ok: false, error: (stderr.trim() || stdout.trim()) + tip }
  }
  return { name, exit: status, stdout, stderr: stderr + tip }
}

/**
 * 异步执行 MSM（acc_msm 工具主路径）：
 * 用 execFile + promisify + timeout（超时自动 kill），**不阻塞 Node 事件循环**。
 * （同步 spawnSync 版会阻塞 web 事件循环 → MSM 脚本自请求 3080 时死锁，见 postmortem。）
 */

/** bun 缺失的错误码集（Windows 兼容：无 bun 时 execFile('bun') 抛 EINVAL 而非 ENOENT，见 Windows 审计问题 5） */
const BUN_MISSING_CODES = new Set(['ENOENT', 'EINVAL', 'EPERM'])

function isBunMissing(err: NodeJS.ErrnoException): boolean {
  return typeof err.code === 'string' && BUN_MISSING_CODES.has(err.code)
}

export async function runMsmAsync(root: string, args: MsmArgs): Promise<JsonValue> {
  if (args.action !== 'exec') return runMsm(root, args)
  const { entry, businessArgs, fmtJson, hasHelp, protocol } = prepareExec(root, args)
  const p = protocolResult(protocol)
  if (p !== undefined) return p
  // bun 优先（可直跑 TS），npx shell 兜底；注入 SERENITY_* env（对齐 osp）。
  // Windows 修复（审计问题 5）：探测真 bun.exe 绝对路径（零 shell），避免裸 'bun' ENOENT 与 npx.cmd EINVAL。
  const bunBin = bunExecutablePath()
  const baseOpts = {
    cwd: root,
    encoding: 'utf-8' as const,
    timeout: MSM_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    env: buildMsmEnv(root),
  }
  try {
    if (bunBin) {
      const r = await execFileAsync(bunBin, [entry.path, ...businessArgs], baseOpts)
      return msmExecResult(entry.name, 0, r.stdout, r.stderr, fmtJson, hasHelp)
    }
    // 无 bun：直接走 npx shell 兜底
    throw { code: 'ENOENT' } as NodeJS.ErrnoException
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean }
    if (isBunMissing(err)) {
      try {
        const r = await execFileAsync(NPX_BIN, ['tsx', entry.path, ...businessArgs], { ...baseOpts, shell: platform === 'win32' })
        return msmExecResult(entry.name, 0, r.stdout, r.stderr, fmtJson, hasHelp)
      } catch (e2) {
        const err2 = e2 as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean }
        const status = err2.killed ? 124 : (typeof err2.code === 'number' ? err2.code : 2)
        const stdout = err2.stdout ?? ''
        const stderr = err2.killed ? `MSM timed out after ${MSM_TIMEOUT_MS}ms` : (err2.stderr ?? err2.message ?? '')
        return msmExecResult(entry.name, status, stdout, stderr, fmtJson, hasHelp)
      }
    }
    const status = err.killed ? 124 : (typeof err.code === 'number' ? err.code : 2)
    const stdout = err.stdout ?? ''
    const stderr = err.killed ? `MSM timed out after ${MSM_TIMEOUT_MS}ms` : (err.stderr ?? err.message ?? '')
    return msmExecResult(entry.name, status, stdout, stderr, fmtJson, hasHelp)
  }
}
