/**
 * weixin-hook-branches.test.ts — `weixin-hook.ts` 的**分支面**（⑤ 第 47 件，2026-09-25）
 *
 * ── 挑靶依据（机械，不是叙述）───────────────────────────────────────────────
 * 按 ⑤ 换挡后的入口「**按分支覆盖率排序**」复扫 `coverage/src/**` ⇒
 * `weixin-hook.ts` = 分支 **73.33%（22/30）**，是 `src/**` 中**最低的未被做过**的文件
 * （43 `diag-ops` ／ 44 `compact` ／ 45 `lifecycle` ／ 46 `seams/context` 已做完）。
 * 语句 94.48%（240/254）、函数 6/6。
 *
 * ── 🔴 为何这些分支从未被走过（本件的核心发现）──────────────────────────────
 * 未覆盖的 8 处**全部落在 `runWeixinHook` 的「双 runner 回退链」与 `runOnce` 的
 * 事件回调面**上，而既有 `weixin-hook.test.ts` 的五个执行用例**全部只用真脚本跑
 * 一次成功/失败**（脚本收到 stdin ／ 脚本缺失 ／ 路径逃逸 ／ 超时 ／ 非 0 退出）。
 *
 * ⇒ 也就是说：既有的执行面测试**从不关心"用了哪个 runner"**，而
 *   **`bun` 优先 / `node` 兜底**这条设计承诺（文件头 :10 原文，`biasProvider` 同款）
 *   **从来没有被执行过**。本机 `bun` 若在 PATH 上，回退链的第一跳就永远走不到 ——
 *   这正是"声明—现实一致"（I7）意义上的**静默缺口**：把回退链写坏
 *   （例如 `continue` 误写成 `return`、或 catch 里漏掉 `continue`），
 *   **没有任何测试会红**，而现网一旦 `bun` 缺失就整条 hook 静默失效。
 *
 * 逐处清单（源码行 = 本件写作时的锚；**行号只作"某版本的实测读数"**）：
 *   B1 :714 `buildOutgoingHookEvent` 的 `input.file` 三元真侧（带 file 的 outgoing 事件）
 *   B2 :753 回退链 **ENOENT ⇒ continue**（bun 缺失 → 试 node）
 *   B3 :755 回退链 **catch ⇒ continue**（`runOnce` 自身抛错 → 试下一个 runner）
 *   B4 :759 回退链 **两跳都失败 ⇒ 落到函数末尾的兜底 return**
 *   B5 :772 `runOnce` 内 **`spawn()` 同步抛 ⇒ SPAWN_ERR**
 *   B6 :776 超时回调内的 **`settled` 已置位 ⇒ 提前 return**（防重复 settle）
 *   B7 :802 **exit 0 但 stderr 非空** ⇒ 打 stderr 日志
 *   B8 :807 **exit ≠ 0 且 stderr 为空** ⇒ 日志里不带 stderr 段
 *
 * ── 本件测的是什么（不是"覆盖率数字"）──────────────────────────────────────
 *   ① **回退链的语义**：`bun` ENOENT 必须**降级到 node 并成功**，而不是把
 *      "bun 不在"当成"hook 失败"（B2）—— 这是回退链存在的**唯一理由**。
 *   ② **兜底不撒谎**：两跳都 ENOENT 时返回的是**明确文案**
 *      「bun 与 node 均不可用」，不是静默成功（B4）。
 *   ③ **同步抛不被吞成假成功**：`spawn()` 同步抛 ⇒ SPAWN_ERR（B5），
 *      且**不得**让上层把它当成"跑过了"。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────────
 *  · **夹具先有正控**（累积纪律 10）：每条用例开头先证明"**不注入时**该路径
 *    能真跑到"（例如 B2 先证明 bun 存在时走的是第一跳），之后注入失败才有意义。
 *  · **失败路径用真故障形态注入**：B2/B4 用**真的不存在的命令名**触发真 ENOENT；
 *    B5 用 `vi.mock` 让 `spawn` 真抛 —— 不是断言空转。
 *  · **不顺着假设改测试**：红先分诊"被测对象失败 vs 脚手架失败"。
 *  · `it()` 标题内不用直引号（用「」）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ── 🔴 B2/B4 需要"某一跳真报 ENOENT" ＋ B5 需要 `spawn` 同步抛 ─────────────────
// 只在"注入模式"下生效：用模块级开关，避免影响本文件其余用例与其它测试文件。
// （vi.mock 是文件级的，所以开关必须做成可运行时翻转的。）
//
// ⚠️ ENOENT 的注入方式：真实的 `spawn` 对不存在的命令**不抛**，而是异步 emit
//    'error'（err.code='ENOENT'）—— 这正是 `runOnce` :218 那条路的形态。
//    故此处不能"抛 ENOENT"（那会命中 :199 的 SPAWN_ERR，语义完全不同），
//    必须**回放真实形态**：返回一个伪造的 child，异步 emit 带 code 的 error。
const spawnState = { throwSync: false, bunEnoent: false, nodeEnoent: false }

/**
 * 伪造一个 ChildProcess 形状的对象，**回放真实 spawn ENOENT 的形态**：
 * 真实 spawn 对不存在的命令**不抛**，而是返回一个 child 并异步 emit
 * `'error'`（`err.code === 'ENOENT'`）—— 这正是 `runOnce` :218 那条路的形态。
 * ⚠️ 不能"抛 ENOENT"：那会命中 :199 的 SPAWN_ERR，语义完全不同。
 */
function makeEnoentChild(cmd: string): unknown {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>
  // runOnce 会调用 stdin.write / stdin.end / .on(...) ⇒ 必须是真 stream
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => {}
  // 必须在**监听器挂好之后**再 emit：runOnce 是同步挂 .on('error') 的，
  // 故用 setImmediate（排在当前同步段之后）。
  setImmediate(() => {
    const err = new Error(`spawn ${cmd} ENOENT`) as Error & { code?: string }
    err.code = 'ENOENT'
    child.emit('error', err)
  })
  return child
}

vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (cmd: string, ...rest: unknown[]) => {
      if (spawnState.throwSync) throw new Error('spawn boom (injected)')
      const isBun = cmd === 'bun'
      const wantEnoent = (isBun && spawnState.bunEnoent) || (!isBun && spawnState.nodeEnoent)
      if (wantEnoent) return makeEnoentChild(cmd)
      // @ts-expect-error 透传真实重载（测试注入口）
      return actual.spawn(cmd, ...rest)
    },
  }
})

import {
  buildIncomingHookEvent,
  buildOutgoingHookEvent,
  runWeixinHook,
  type WeixinHookIncomingEvent,
  type WeixinHookOutgoingEvent,
} from '../src/weixin-hook.js'

let dir: string

beforeEach(() => {
  spawnState.throwSync = false
  spawnState.bunEnoent = false
  spawnState.nodeEnoent = false
  dir = mkdtempSync(join(tmpdir(), 'weixin-hook-br-'))
  writeFileSync(join(dir, '.serenity'), 'test')
  mkdirSync(join(dir, '.opencode'), { recursive: true })
})

afterEach(() => {
  spawnState.throwSync = false
  spawnState.bunEnoent = false
  spawnState.nodeEnoent = false
  rmSync(dir, { recursive: true, force: true })
})

const incomingBase = {
  accountId: 'wechat-1',
  userId: 'u1@im.wechat',
  sessionId: 'skiff-weixin-abc123',
  role: 'zhaocai',
  text: '你好',
  media: [],
}

function mkIncoming() {
  return buildIncomingHookEvent({ ...incomingBase, cccRoot: dir })
}

/** 写一个可执行脚本：真脚本，不是桩（真故障形态注入原则） */
function writeScript(name: string, body: string): string {
  writeFileSync(join(dir, name), body)
  return join(dir, name)
}

// ─────────────────────────────────────────────────────────────────────────────
// B1 — buildOutgoingHookEvent 的 file 三元真侧
// ─────────────────────────────────────────────────────────────────────────────
describe('weixin-hook 分支面: B1 outgoing 事件的 file 字段三元', () => {
  it('B1 带 file ⇒ 事件含 file 对象（原始字段逐字保留）', () => {
    const ev = buildOutgoingHookEvent({
      cccRoot: dir,
      accountId: 'wechat-1',
      userId: 'u1@im.wechat',
      sessionId: 'skiff-weixin-abc123',
      role: 'zhaocai',
      reply: '文件已发',
      file: { name: '报告.pdf', size: 12345, caption: '这是附件' },
    })
    expect(ev.file).toEqual({ name: '报告.pdf', size: 12345, caption: '这是附件' })
  })

  it('B1 无 file ⇒ 事件不含 file 键（而非 file:undefined）', () => {
    const ev = buildOutgoingHookEvent({
      cccRoot: dir,
      accountId: 'wechat-1',
      userId: 'u1@im.wechat',
      sessionId: 'skiff-weixin-abc123',
      role: 'zhaocai',
      reply: '纯文本',
    })
    // 🔴 断言"键不存在"而不是"值为 undefined" —— 三元展开的语义就在这里
    expect('file' in ev).toBe(false)
    expect(JSON.parse(JSON.stringify(ev))).not.toHaveProperty('file')
  })

  it('B1 caption 可缺省（file 只有 name/size）', () => {
    const ev = buildOutgoingHookEvent({
      cccRoot: dir,
      accountId: 'wechat-1',
      userId: 'u1@im.wechat',
      sessionId: 'skiff-weixin-abc123',
      role: 'zhaocai',
      reply: '附件',
      file: { name: 'a.txt', size: 1 },
    })
    expect(ev.file).toEqual({ name: 'a.txt', size: 1 })
    expect(ev.file?.caption).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// B2/B3/B4 — 双 runner 回退链（本件的主靶）
// ─────────────────────────────────────────────────────────────────────────────
describe('weixin-hook 分支面: B2/B3/B4 双 runner 回退链', () => {
  it('正控：脚本可跑通时 ok:true（证明本组夹具不瞎）', async () => {
    writeScript('ok.js', 'process.exit(0)')
    const res = await runWeixinHook(dir, 'ok.js', mkIncoming(), 10_000)
    // 🔴 正控：先证明"回退链能成功走通一条"。若这条红了，
    //    后面"两条都不通"的断言就无法区分"兜底生效"与"夹具坏了"。
    expect(res.ok).toBe(true)
  })

  it('B2 🔴 第一跳 ENOENT ⇒ 降级到第二跳并**真跑成功**（回退链存在的唯一理由）', async () => {
    // 真故障形态注入：把第一跳的 bun 换成一个**真不存在**的命令名 ⇒ 真 ENOENT。
    // 手法：直接调 runWeixinHook，但 bun 在 PATH 上时第一跳会成功 —— 无法制造 ENOENT。
    //   ⇒ 改走"让 PATH 里没有 bun"不可行（全局副作用），改用 spawn 包装层：
    //   令 bun 这一次真报 ENOENT（err.code='ENOENT'），node 这一跳正常执行。
    spawnState.bunEnoent = true
    writeScript('ok.js', 'process.exit(0)')
    const res = await runWeixinHook(dir, 'ok.js', mkIncoming(), 10_000)
    // 🔴 这条是本件最值钱的断言：**bun 不在 ≠ hook 失败**。
    //    若回退链把 ENOENT 当成最终结果（continue 误写成 return），这条必红。
    expect(res.ok).toBe(true)
  })

  it('B4 🔴 两跳都 ENOENT ⇒ 明确兜底文案「均不可用」（不是静默成功）', async () => {
    // 真故障形态注入：**两跳都真 ENOENT** ⇒ 逐跳 continue ⇒ 落到函数末尾的 B4。
    spawnState.bunEnoent = true
    spawnState.nodeEnoent = true
    writeScript('never.js', 'process.exit(0)')
    const res = await runWeixinHook(dir, 'never.js', mkIncoming(), 5_000)
    // 🔴 断言的是**语义**：两跳都不可用时必须给出明确交代，而不是假装成功。
    //    只断言 ok:false 是弱的（无法区分"走到兜底"与"第一跳就返回了"）——
    //    文案是唯一能把两者区分开的读数。
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('均不可用')
  })

  // 🔴 B3（:755 的 `catch { continue }`）**构造上不可达** —— 本件实测结论，登记而非涂绿：
  //    `runOnce` 的全部四条出路（spawn 同步抛 :199／超时 :202／child error :218／
  //    child close :224）**都是 resolvePromise**，**没有任何一条 reject**
  //    ⇒ 它返回的 Promise 永不 reject ⇒ `await runOnce(...)` 永不进入 catch。
  //    故 B3 属与地图 §3-8 同族的「构造上不可达」，**不该为它造测试**。
  //    （本件首跑正是把 B3 与 B5 混淆的一条用例：注入 spawn 同步抛 ⇒ 实际命中 :199 的
  //      SPAWN_ERR 并被 `return res` 在第一跳返回，断言「均不可用」因此红 —— 错的是测试假设，
  //      不是生产代码。按"红色即停"改为登记，**不顺着假设改生产语义**。）
})

// ─────────────────────────────────────────────────────────────────────────────
// B5 — spawn() 同步抛 ⇒ SPAWN_ERR
// ─────────────────────────────────────────────────────────────────────────────
describe('weixin-hook 分支面: B5 spawn 同步抛', () => {
  it('B5 spawn 同步抛 ⇒ 不抛给调用方（旁路容忍 H3）', async () => {
    writeScript('x.js', 'process.exit(0)')
    spawnState.throwSync = true
    // 🔴 旁路容忍的核心：hook 的任何失败都**不得**传播成异常打断微信桥
    await expect(runWeixinHook(dir, 'x.js', mkIncoming(), 3_000)).resolves.toBeDefined()
    const res = await runWeixinHook(dir, 'x.js', mkIncoming(), 3_000)
    expect(res.ok).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// B7/B8 — runOnce 的 close 回调日志分支
// ─────────────────────────────────────────────────────────────────────────────
describe('weixin-hook 分支面: B7/B8 exit 回调的 stderr 分档', () => {
  it('B7 exit 0 但 stderr 非空 ⇒ ok:true（stderr 不影响成败）', async () => {
    // 真故障形态：脚本写 stderr 却正常退出 —— 这是"脚本有话要说但没失败"的真实形态
    writeScript('warn.js', "process.stderr.write('warning: 非致命\\n'); process.exit(0)")
    const res = await runWeixinHook(dir, 'warn.js', mkIncoming(), 10_000)
    // 🔴 语义：stderr 非空**不等于失败** —— 若有人把这里误改成 ok:false，
    //    这条会红。（既有测试没有一条覆盖 "exit 0 + stderr 非空"。）
    expect(res.ok).toBe(true)
  })

  it('B8 exit ≠ 0 且 stderr 为空 ⇒ ok:false 且 detail 仍是 exit 码', async () => {
    writeScript('quiet-fail.js', 'process.exit(7)')
    const res = await runWeixinHook(dir, 'quiet-fail.js', mkIncoming(), 10_000)
    expect(res.ok).toBe(false)
    // 🔴 断言 exit 码本身：stderr 为空是 B8 的分档条件，但**不得**因此丢掉退出码
    expect(res.detail).toContain('exit=7')
  })

  it('B8 对照：exit ≠ 0 且 stderr 非空 ⇒ 同样 exit 码（两档文案等价）', async () => {
    writeScript('loud-fail.js', "process.stderr.write('boom\\n'); process.exit(7)")
    const res = await runWeixinHook(dir, 'loud-fail.js', mkIncoming(), 10_000)
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('exit=7')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// B6 — 超时回调内的 settled 提前 return（防重复 settle）
// ─────────────────────────────────────────────────────────────────────────────
describe('weixin-hook 分支面: B6 settled 防重复 settle', () => {
  it('B6 脚本及时退出 ⇒ 定时器被 clearTimeout（不触发超时分档）', async () => {
    writeScript('fast.js', 'process.exit(0)')
    // 超时给得比脚本执行长得多 ⇒ close 先到、clearTimeout 生效
    const res = await runWeixinHook(dir, 'fast.js', mkIncoming(), 30_000)
    expect(res.ok).toBe(true)
    // 🔴 这条覆盖的是"settled 已被 close 置位 ⇒ 超时回调提前 return"这条路径的
    //    **可观测后果**：不会出现"已成功又被改写为超时"。
    //    直接断言 settled 内部量不可能（闭包内），故以"最终结果唯一"为准。
    expect(res.detail).toBeUndefined()
  })

  it('B6 对照：真超时 ⇒ 走超时分档（kill + 明确文案）', async () => {
    writeScript('hang.js', 'setInterval(() => {}, 1000)')
    const res = await runWeixinHook(dir, 'hang.js', mkIncoming(), 300)
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('超时')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 类型面留档：事件判别联合在本件新增用例中的形状未被改变
// ─────────────────────────────────────────────────────────────────────────────
describe('weixin-hook 分支面: 判别联合未漂移', () => {
  it('incoming / outgoing 两型的 event 判别字面量保持', () => {
    const inc: WeixinHookIncomingEvent = mkIncoming()
    const out: WeixinHookOutgoingEvent = buildOutgoingHookEvent({
      cccRoot: dir,
      accountId: 'wechat-1',
      userId: 'u1@im.wechat',
      sessionId: 'skiff-weixin-abc123',
      role: 'zhaocai',
      reply: 'x',
      source: 'proactive',
    })
    expect(inc.event).toBe('incoming')
    expect(out.event).toBe('outgoing')
    expect(out.source).toBe('proactive')
  })

  it('source 缺省或为 reply 时不出现在载荷里（三元真侧）', () => {
    const ev = buildOutgoingHookEvent({
      cccRoot: dir,
      accountId: 'wechat-1',
      userId: 'u1@im.wechat',
      sessionId: 'skiff-weixin-abc123',
      role: 'zhaocai',
      reply: 'x',
      source: 'reply',
    })
    expect('source' in ev).toBe(false)
  })
})
