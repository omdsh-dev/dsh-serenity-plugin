/**
 * tools-execute-face.test.ts — ⑤ 第 33 件：**工具面的 `execute` 通路**（同 §2.7q 的姊妹件）
 *
 * 挑靶依据 = §3-9b 全量 `fstat-no` 复扫的**残余 A 类**：**6 处 / 6 文件** ——
 *   5 个 `execute`（`container_fs` ／ `container_git` ／ `dashboard` ／ `localstore` ／ `im-bridge`）
 *   ＋ `handyman` 的 `parseJobs`（只在 `jobs` 多任务编排路径被调用）。
 *
 * 🔴 **为什么与 §2.7q（render 面）必须分开做**：`execute` 要吃各自的 `ctx`/`exec` 夹具，
 *   而那正是 **§3-9 #7 的 fake ctx 盲区**所在（真宿主 `Context` 是 Proxy：访问未 `inject`
 *   的服务名**会抛**，而普通对象 ctx 只返回 `undefined` ⇒ "全部 fake ctx 单测都是绿的"有真实先例）。
 *   ⇒ 本件的夹具纪律：**只用"真值形态"的 `exec`（`agent.session.header.cwd` 指向临时 CCC）**，
 *   不造"看着像 ctx 的假 ctx"去做本可用真路径做的断言。
 *
 * 🔴 **与 render 面的关键差别（已探明）**：`defineTool` 的 `execute` **包装会先做参数校验**
 *   （`validate(args)` → 不合 schema 即抛 `ToolArgsError`）⇒ 参数**必须 schema 合法**才进得到函数体。
 *   ⚠️ 本件仍**刻意不用 `vi.mock('@deepseek-ai/dsh-tools')`**（identity 桩）—— 走**真的 `defineTool`**，
 *   于是测到的是产线那个包装；这也让下面第 ⑫ 条**能机械证明**一条不可达边界。
 *
 * 🔴 **本件的核心产出 = "无 CCC"时三种不同政策**（此前从未被执行过 ⇒ 从未被钉住）：
 *   `container_fs`／`container_git`／`localstore` ⇒ **抛 `NO_CCC_FROM_AGENT_CWD`**；
 *   `dashboard` ⇒ **不抛**，返回 `status: degraded`（对齐 osp 未激活语义）；
 *   `im-bridge` ⇒ **不抛**，返回**结构化** `{ok:false, code:'CCC_UNRESOLVED'}`。
 *   ⇒ 三者是**同一个问题的三种设计选择**，本件把它们并排钉住（任一处被改成另一种，本组先红）。
 *
 * 🔵 **本件的边界（不是遗漏）**：`handyman` 的 `runHandymanJob`／前台委派链路**不在本件**
 *   （那要起真子代理）；本件只补"**编排前的参数与上限校验**"这一段——它此前零执行。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ToolArgsError } from '@deepseek-ai/dsh-tools'

import { NO_CCC_FROM_AGENT_CWD } from '../src/ccc-roots.js'
import { ccFsTool } from '../src/tools/cc-fs.js'
import { gitTool } from '../src/tools/git.js'
import { localstoreTool } from '../src/tools/localstore.js'
import { createKitTool } from '../src/tools/kit.js'
import { createImBridgeTool } from '../src/tools/im-bridge.js'
import { createHandymanTool } from '../src/tools/handyman.js'

/** 工厂形工具的 ctx 形参类型（不额外 import `cordis` 的类型） */
type Ctx = Parameters<typeof createKitTool>[0]
/**
 * 🔴 **空壳 ctx 的正当性**：本件驱动的每个 `execute` 都在**进入委派之前**就返回或抛错
 * （见文件头的"边界"）⇒ 没有任何一条用例走到会解引用 `ctx` 服务的那行。
 * ⚠️ 若哪天某用例走到那里，**它必须响亮失败**（而不是"假绿"）—— 这正是下面要钉的。
 */
const ctx = {} as Ctx

/** `execute` 的最小结构视图 */
type ExecutableTool = {
  name: string
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

function execOf(tool: unknown, label: string): ExecutableTool {
  const t = tool as { execute?: unknown }
  if (typeof t.execute !== 'function') {
    throw new Error(`不可达：${label} 没有暴露 execute（defineTool 的返回形状变了？）`)
  }
  return tool as ExecutableTool
}

/** 真值形态的 `exec`：`cccRootForExec` 读 `agent.session.header.cwd`（见 `agentCwdFor`） */
function execIn(cwd: string): unknown {
  return { agent: { session: { header: { cwd } } } }
}

let ccc = ''      // 有 `.serenity` ＋ `.opencode/serenity.json`（含 handyman 配置）
let outside = ''  // 无 `.serenity` ⇒ cccRootForExec 解析不到
let gitCcc = ''   // 有 `.serenity` ＋ 真 `git init`（`container_git status` 要真仓库）

beforeEach(() => {
  ccc = mkdtempSync(join(tmpdir(), 'tools-exec-ccc-'))
  writeFileSync(join(ccc, '.serenity'), 'home-serenity\n', 'utf-8')
  mkdirSync(join(ccc, '.opencode'), { recursive: true })
  writeFileSync(
    join(ccc, '.opencode', 'serenity.json'),
    // `maxParallel: 1` 是**刻意调小的**：让"超上限"成为一条**不需要起任何子代理**就能走到的校验路径
    JSON.stringify({ handyman: { models: ['probe/Model'], defaultModel: 'probe/Model', maxParallel: 1 } }),
    'utf-8',
  )

  outside = mkdtempSync(join(tmpdir(), 'tools-exec-out-'))

  gitCcc = mkdtempSync(join(tmpdir(), 'tools-exec-git-'))
  writeFileSync(join(gitCcc, '.serenity'), 'home-serenity\n', 'utf-8')
  // `keep.txt` 是**第二个**未跟踪文件：让 `status` 的断言有两个具名条目可比（单条目容易被"空数组也绿"混淆）
  writeFileSync(join(gitCcc, 'keep.txt'), 'probe\n', 'utf-8')
  execFileSync('git', ['init', '-q'], { cwd: gitCcc })
})

afterEach(() => {
  rmSync(ccc, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
  rmSync(gitCcc, { recursive: true, force: true })
})

/** 6 个靶（含 3 个工厂形 —— 见文件头） */
const ALL: Array<{ label: string; make: () => unknown }> = [
  { label: 'container_fs', make: () => ccFsTool },
  { label: 'container_git', make: () => gitTool },
  { label: 'localstore', make: () => localstoreTool },
  { label: 'dashboard', make: () => createKitTool(ctx) },
  { label: 'im-bridge', make: () => createImBridgeTool() },
  { label: 'handyman', make: () => createHandymanTool(ctx) },
]

describe('tools/*：`execute` 通路（⑤ 第 33 件）', () => {
  it('🔴 可达性自证：6 个工具对象都真的暴露 execute（本件全部断言的前提）', () => {
    // ⚠️ 扫描域自证：先钉"靶确实是 6 个"，否则"零个不合格"会永远绿（同 §3-9 #7）
    expect(ALL).toHaveLength(6)
    const unreachable = ALL.filter((t) => {
      try {
        execOf(t.make(), t.label)
        return false
      } catch {
        return true
      }
    })
    expect(unreachable.map((t) => t.label)).toEqual([])
  })

  // ───────────────────────────────────────────────────────────────────────────
  // A. 「无 CCC」的**三种政策**（本件核心：同题三设计，此前从未被钉住）
  // ───────────────────────────────────────────────────────────────────────────

  describe('A · 无 CCC 时的政策（三者并排钉住）', () => {
    const THROWING: Array<{ label: string; make: () => unknown; args: Record<string, unknown> }> = [
      { label: 'container_fs', make: () => ccFsTool, args: { action: 'root' } },
      { label: 'container_git', make: () => gitTool, args: { action: 'status' } },
      { label: 'localstore', make: () => localstoreTool, args: { action: 'list' } },
    ]

    it('政策①：container_fs ／ container_git ／ localstore ⇒ **抛** NO_CCC_FROM_AGENT_CWD', async () => {
      expect(THROWING).toHaveLength(3)
      for (const { label, make, args } of THROWING) {
        // 🔴 期望值取自**真常量**（不硬编码文案）—— 文案改了对齐点仍成立
        await expect(execOf(make(), label).execute(args, execIn(outside)), label).rejects.toThrow(NO_CCC_FROM_AGENT_CWD)
      }
    })

    it('政策②：dashboard（`health`）⇒ **不抛**，返回 degraded 报告（对齐 osp 未激活语义）', async () => {
      const res = (await execOf(createKitTool(ctx), 'dashboard').execute({ action: 'health' }, execIn(outside))) as {
        status: string
        principles: Record<string, { pass: boolean }>
      }
      expect(res.status).toBe('degraded')
      // 判别性：**不能**只断言 status——否则"任何原因导致的 degraded"都会让它绿
      expect(res.principles.P1_rooted!.pass, '根不存在 ⇒ P1 必须为假').toBe(false)
    })

    it('政策③：im-bridge ⇒ **不抛**，返回结构化 `{ok:false, code:CCC_UNRESOLVED}`', async () => {
      const res = (await execOf(createImBridgeTool(), 'im-bridge').execute(
        { channel: 'weixin', action: 'status' },
        execIn(outside),
      )) as { ok: boolean; code: string }
      expect(res.ok).toBe(false)
      expect(res.code).toBe('CCC_UNRESOLVED')
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // B. 在临时 CCC 内的正常面（真根解析 → 真委派 → 真返回值）
  // ───────────────────────────────────────────────────────────────────────────

  describe('B · CCC 内：根解析真的落到那个 CCC，并且真的委派下去', () => {
    it('container_fs `root` ⇒ 返回**解析出的 CCC 根本身**（逐字等于夹具目录）', async () => {
      const res = await execOf(ccFsTool, 'container_fs').execute({ action: 'root' }, execIn(ccc))
      // 🔴 最强形态的断言：不是"有个 root 字段"，而是**根解析结果 = 我造的那个目录**
      expect(res).toBe(ccc)
    })

    it('container_git `status` ⇒ 走真仓库，如实报告未跟踪文件（真 git ＋ 真解析）', async () => {
      const res = (await execOf(gitTool, 'container_git').execute({ action: 'status' }, execIn(gitCcc))) as {
        clean: boolean
        files: Array<{ status: string; file: string }>
        summary: string
      }
      // 🔴 **本件首跑红一条，而红的是我的期望**（同 §2.7m／§2.7o／§2.7q 的家族）：
      //    我原以为"刚 `git init` 的目录 = clean"。**真因是夹具**：本夹具为了让根解析成立，
      //    必须在目录里放 `.serenity` —— 而**那个文件自己就是未跟踪文件** ⇒ 该仓库**永远不会干净**。
      //    ⇒ 改法不是把断言放宽成"有个 clean 字段"，而是**改成钉住它真正报告的东西**：
      //    未跟踪文件恰好是两个，且逐条对上（这比 `clean:true` 更能证明"真跑了 git 且真解析了输出"）。
      const listed = res.files.map((f) => `${f.status} ${f.file}`).sort()
      expect(listed).toEqual(['?? .serenity', '?? keep.txt'])
      expect(res.clean).toBe(false)
      expect(res.summary).toBe('2 file(s) with changes')
    })

    it('dashboard `time` ⇒ 三个时间读数，且 epoch_ms 就是**现在**', async () => {
      const before = Date.now()
      const res = (await execOf(createKitTool(ctx), 'dashboard').execute({ action: 'time' }, execIn(ccc))) as {
        now_iso: string
        now_local: string
        epoch_ms: number
      }
      // 正控式断言：一个**常量**返回值也能让"字段存在"变绿 ⇒ 这里钉"它真的是当下"
      expect(typeof res.epoch_ms).toBe('number')
      expect(res.epoch_ms).toBeGreaterThanOrEqual(before)
      expect(Math.abs(Date.now() - res.epoch_ms)).toBeLessThan(5_000)
      expect(res.now_iso.length).toBeGreaterThan(0)
      expect(res.now_local.length).toBeGreaterThan(0)
    })

    it('localstore `list` ⇒ 缺省 scope=credential、空库返回空键表', async () => {
      const res = await execOf(localstoreTool, 'localstore').execute({ action: 'list' }, execIn(ccc))
      // 空库是**真实初态**（临时 CCC 里没有 localstore.json）
      expect(res).toEqual({ scope: 'credential', keys: [] })
    })

    it('im-bridge ⇒ 通道未知：稳定错误码 ＋ 提示里列出已注册通道', async () => {
      const res = (await execOf(createImBridgeTool(), 'im-bridge').execute(
        { channel: 'no-such-channel', action: 'status' },
        execIn(ccc),
      )) as { ok: boolean; code: string; error: string }
      expect(res.ok).toBe(false)
      expect(res.code).toBe('CHANNEL_UNKNOWN')
      expect(res.error).toContain('no-such-channel')
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // C. wrapper 的参数校验**先于**函数体（工具面契约）
  // ───────────────────────────────────────────────────────────────────────────

  describe('C · 参数校验先于执行（`defineTool` 包装的契约）', () => {
    it('非法 enum ⇒ 抛 ToolArgsError（正控：同工具合法 action 在 B 组真的进到了体内）', async () => {
      // 这条同时是"本件用真 wrapper 而非 identity 桩"的**回报**：桩掉 defineTool 就没有这层校验
      await expect(
        execOf(ccFsTool, 'container_fs').execute({ action: 'not-an-action' }, execIn(ccc)),
      ).rejects.toBeInstanceOf(ToolArgsError)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // D. handyman：`jobs` 编排前的解析与上限校验（parseJobs —— 此前零执行）
  // ───────────────────────────────────────────────────────────────────────────

  describe('D · handyman 的 `parseJobs` 与上限校验', () => {
    const handyman = () => execOf(createHandymanTool(ctx), 'handyman')

    it('数组项缺 label ⇒ parseJobs 返回 null ⇒ **响亮抛错**（且没有任何子代理被起）', async () => {
      await expect(
        handyman().execute({ mode: 'background', jobs: [{ task: 't' }] }, execIn(ccc)),
      ).rejects.toThrow('jobs must be [{task, label, model?}, ...]')
    })

    it('合法 jobs 但**超过 maxParallel** ⇒ 抛上限错误（夹具把 maxParallel 调成 1）', async () => {
      await expect(
        handyman().execute(
          { mode: 'background', jobs: [{ task: 'a', label: 'a' }, { task: 'b', label: 'b' }] },
          execIn(ccc),
        ),
      ).rejects.toThrow('2 jobs exceed maxParallel 1')
    })

    it('🔴 登记一条**不可达边界**：非数组 `jobs` 到不了 parseJobs —— wrapper 先以 ToolArgsError 拒绝', async () => {
      // parseJobs 的首行是 `if (!Array.isArray(raw) || raw.length === 0) return null`。
      // 但工具面声明 `jobs: { type: 'array' }` ⇒ 真 wrapper 在执行前就按 schema 拒掉非数组。
      // ⇒ 该支线**经工具面不可达**（它只在"有人绕过工具面直接调 parseJobs"时才可能命中，
      //    而 parseJobs 未导出、唯一调用点就在本 execute 内）。
      // 🔵 本用例把这条"不可达"**变成机械读数**，而不是写在散文里（house rule：别把"从不发生"固化成期望形态）。
      await expect(
        handyman().execute({ mode: 'background', jobs: 'nope' }, execIn(ccc)),
      ).rejects.toBeInstanceOf(ToolArgsError)
    })
  })
})
