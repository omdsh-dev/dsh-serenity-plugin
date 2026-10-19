/**
 * B2 会话日志压缩（clean-rewrite）—— S142 / 2026-10-18
 *
 * 目标：把过大的 session.v4.jsonl.zstd 重写成一份**自洽、合法、显著更小**的日志。
 * 同一个会话 id、同一个文件位置，**不产生新会话**（这是它与方案 A 的本质区别）。
 *
 * ── 依据（全部取证于宿主源码，未复刻语义）──────────────────────────
 * ① rebuild 的 `surfaceOp: replace` 只**遮蔽**不删除 ⇒ 旧事件全部滞留；
 *    `foldSurface()` 给出**当前可见面**，那才是模型真正需要的历史。
 * ② 读取侧 `validateStoredEvents()` 不要求 seq 从 0 连续；但**写入侧**
 *    `assertContiguous()` 要求 `seq === cursor + index` ⇒ 重写后必须从 0 连续。
 * ③ `assertReleasedV4Relationships()` 是**状态机**：turn 从 1、step 从 1 步进，
 *    `tool/result` 必须匹配当前打开的 turn+step，`step/end` 前不得有未闭合 call
 *    ⇒ 重写必须重建完整 turn/step 骨架并保证 call/result 成对闭合（D140 同族）。
 *
 * ── 安全模型 ─────────────────────────────────────────────────────
 *  · 默认 **dry-run**：只测量、只自检，**不写任何字节**。
 *  · `--out <path>`：写到一个**新文件**（推荐第一刀这样交给 owner 验）。
 *  · `--in-place`：**必须同时给 `--apply`**，先备份再原子替换。
 *  · 写盘前**必过**宿主 `assertReleasedV4Relationships`；抛错即中止。
 *
 * 用法：
 *   node b2-log-compact.mjs --src <会话目录 或 .zstd 路径>
 *        [--out <新文件>] [--in-place --apply]
 *        [--max-tool-bytes 2000] [--no-truncate] [--verbose]
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, statSync, writeFileSync, renameSync, copyFileSync, readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import zlib from 'node:zlib'

/**
 * 宿主安装树的候选布局。
 * 🔴 **不写死家族目录**（那是本机的现场实证，不该进公开面 —— 隐私门对这种串是有意见的）：
 * 一律由 `homedir()` 拼出，两种常见全局前缀（用户级 ／ 系统级）就够了。
 */
const HOST_LAYOUTS = [
  join(homedir(), '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  join('/usr/local/lib/node_modules', '@deepseek-ai', 'dsh', 'package.json'),
]

const STRUCTURAL = new Set(['turn/start', 'turn/end', 'step/start', 'step/end'])
/** 会话级状态：只保留最后一次（保住当前策略），其余丢弃 */
const STATE_KEEP_LAST = new Set(['permission/preset', 'sandbox/mode', 'approval/policy'])
/** 只服务校验链/内部记账，不在模型可见面：始终丢弃 */
const DROP_ALWAYS = new Set([
  'request/header',
  'llm/retry',
  'compaction/start',
  'compaction/end',
  'compaction/summary',
  'compaction/prune',
  'developer/message',
  'agent/inbox/spliced',
  'agent/inbox/removed',
  'session/end-seed',
])

function fail(msg) {
  console.error(`\n[ABORT] ${msg}`)
  process.exit(1)
}
function info(verbose, flag, msg) {
  if (verbose) console.log(`  [${flag}] ${msg}`)
}

function parseArgs(argv) {
  const o = { maxToolBytes: 2000, truncate: true, inPlace: false, apply: false, verbose: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--src') o.src = argv[++i]
    else if (a === '--out') o.out = argv[++i]
    else if (a === '--in-place') o.inPlace = true
    else if (a === '--apply') o.apply = true
    else if (a === '--max-tool-bytes') o.maxToolBytes = Number(argv[++i])
    else if (a === '--no-truncate') o.truncate = false
    else if (a === '--verbose') o.verbose = true
    else if (a === '--help' || a === '-h') { console.log('用法见文件头注释'); process.exit(0) }
    else fail(`未知参数 ${a}`)
  }
  if (!o.src) fail('缺少 --src')
  if (o.inPlace && !o.apply) fail('--in-place 必须同时给 --apply（防手滑）')
  if (o.inPlace && o.out) fail('--in-place 与 --out 互斥')
  return o
}

function loadHost() {
  const errors = []
  for (const pkg of HOST_LAYOUTS) {
    if (!existsSync(pkg)) continue
    try {
      const req = createRequire(pkg)
      const session = req('@deepseek-ai/dsh-session')
      const fmt = req('@deepseek-ai/dsh-session-format-v3-to-v4')
      if (typeof session?.foldSurface === 'function' && typeof fmt?.assertReleasedV4Relationships === 'function') {
        return {
          foldSurface: session.foldSurface,
          assertRelations: fmt.assertReleasedV4Relationships,
          knownTypes: session.KNOWN_SESSION_EVENT_TYPES,
          via: pkg,
        }
      }
      errors.push(`${pkg}: foldSurface / assertReleasedV4Relationships 缺失`)
    } catch (e) {
      errors.push(`${pkg}: ${String(e?.message ?? e)}`)
    }
  }
  fail(`读数器不可用（宿主模块解析失败）：${errors.join(' | ') || HOST_LAYOUTS.join('，')}`)
}

function resolveLogPath(src) {
  if (statSync(src).isFile()) return src
  const entries = readdirSync(src).filter((n) => /^session\.v\d+\.jsonl\.zstd$/.test(n))
  if (entries.length === 0) fail(`目录下找不到 session.v*.jsonl.zstd：${src}`)
  // 取版本号最大的那一代
  entries.sort()
  return join(src, entries[entries.length - 1])
}

/** 取出模型可见面里那条事件的体积来源文本（用于截断判定） */
function toolResultBytes(ev) {
  const c = ev?.data?.message?.content
  if (!Array.isArray(c)) return 0
  return c.reduce((n, b) => n + (b?.type === 'text' ? Buffer.byteLength(String(b.text ?? '')) : 0), 0)
}

function truncateToolResult(ev, maxBytes) {
  const msg = ev?.data?.message
  if (!msg || !Array.isArray(msg.content)) return { changed: false }
  const before = toolResultBytes(ev)
  if (before <= maxBytes) return { changed: false }

  const headN = Math.floor(maxBytes * 0.7)
  const tailN = Math.max(0, maxBytes - headN)
  msg.content = msg.content.map((b) => {
    if (b?.type !== 'text') return b
    const buf = Buffer.from(String(b.text ?? ''), 'utf8')
    if (buf.length <= maxBytes) return b
    const head = buf.subarray(0, headN).toString('utf8')
    const tail = tailN > 0 ? buf.subarray(Math.max(0, buf.length - tailN)).toString('utf8') : ''
    return {
      ...b,
      text: `${head}\n\n…[B2 压缩：本条工具输出原有 ${before} 字节，现保留首尾约 ${maxBytes} 字节；其余未随之保留]…\n\n${tail}`,
    }
  })
  return { changed: true, before }
}

function main() {
  const opt = parseArgs(process.argv.slice(2))
  const host = loadHost()
  const logPath = resolveLogPath(opt.src)
  console.log(`读数器 via ${host.via}`)
  console.log(`源日志 ${logPath}`)

  const srcBytes = statSync(logPath).size
  const text = execFileSync('zstd', ['-dc', logPath], { maxBuffer: 2 * 1024 * 1024 * 1024 }).toString('utf8')
  const rawBytes = Buffer.byteLength(text, 'utf8')
  const rawLines = text.split('\n').filter((l) => l.length > 0)

  let header
  const all = []
  for (let i = 0; i < rawLines.length; i += 1) {
    let rec
    try {
      rec = JSON.parse(rawLines[i])
    } catch (e) {
      fail(`第 ${i + 1} 行不是合法 JSON（${String(e?.message ?? e)}）—— 拒绝处理`)
    }
    if (i === 0) {
      if (rec.type !== 'session') fail('首行不是 session 记录 —— 拒绝处理')
      header = rec
    } else all.push(rec)
  }
  console.log(`源：压缩 ${(srcBytes / 1048576).toFixed(1)} MiB ／ 解压 ${(rawBytes / 1048576).toFixed(2)} MiB ／ 事件 ${all.length}`)

  // ── ① 折叠：拿当前可见面（宿主自己的实现）────────────────────────
  let folded
  try {
    folded = host.foldSurface(all, [])
  } catch (e) {
    fail(`foldSurface 抛错（源日志本身已不可折叠，本工具无从压缩）：${String(e?.message ?? e)}`)
  }
  const seqs = folded?.entries ?? folded?.nodes ?? folded
  if (!Array.isArray(seqs)) {
    fail(`foldSurface 返回值形状非预期（顶层键: ${Object.keys(folded ?? {}).join(',')}）—— 不猜测，中止`)
  }
  if (seqs.length > 0 && typeof seqs[0] !== 'number') {
    fail(`foldSurface 条目不是 seq 数字（首个: ${JSON.stringify(seqs[0]).slice(0, 120)}）—— 不猜测，中止`)
  }
  const surfaceSet = new Set(seqs)
  console.log(`当前可见面 ${seqs.length} 条（占全量 ${(seqs.length / all.length * 100).toFixed(1)}%）`)

  // ── ② 会话级状态：只留最后一次 ───────────────────────────────────
  const lastState = new Map()
  for (const ev of all) if (STATE_KEEP_LAST.has(ev.type)) lastState.set(ev.type, ev)

  // ── ③ 按 turn 分块重建 ───────────────────────────────────────────
  const outTurns = []
  const preTurn = [] // turn 之外的会话级事件

  let cur = null // { start, steps: [ [ev...] ], curStep: null }
  let curStep = null
  const dangling = { droppedCalls: 0, emptySteps: 0, emptyTurns: 0, aux: 0, shadowed: 0 }

  const classifyAux = (ev) => {
    if (STATE_KEEP_LAST.has(ev.type)) return lastState.get(ev.type) === ev ? 'keep' : 'drop'
    if (DROP_ALWAYS.has(ev.type)) return 'drop'
    if (surfaceSet.has(ev.seq)) return 'keep'
    return 'shadowed'
  }

  for (const ev of all) {
    if (ev.type === 'turn/start') {
      cur = { start: ev, steps: [] }
      curStep = null
      continue
    }
    if (ev.type === 'turn/end') {
      if (cur) {
        if (curStep) { cur.steps.push(curStep); curStep = null }
        if (cur.steps.length === 0) { dangling.emptyTurns += 1; }
        else outTurns.push({ start: cur.start, end: ev, steps: cur.steps })
        cur = null
      }
      continue
    }
    if (ev.type === 'step/start') {
      if (curStep) { cur.steps.push(curStep); if (curStep.events.length === 0) dangling.emptySteps += 1 }
      curStep = { start: ev, events: [] }
      continue
    }
    if (ev.type === 'step/end') {
      if (curStep) {
        curStep.end = ev
        if (curStep.events.length === 0) { dangling.emptySteps += 1; curStep = null }
        else { cur.steps.push(curStep); curStep = null }
      }
      continue
    }

    const kind = classifyAux(ev)
    if (kind === 'drop') { dangling.aux += 1; continue }
    if (kind === 'shadowed') { dangling.shadowed += 1; continue }

    if (!cur) { preTurn.push(ev); continue }
    if (!curStep) { curStep = { start: null, events: [] } } // 容错：无 step/start 的游离事件
    curStep.events.push(ev)
  }
  if (cur) {
    if (curStep) cur.steps.push(curStep)
    if (cur.steps.length > 0) outTurns.push({ start: cur.start, end: null, steps: cur.steps })
  }

  // ── ④ 组装 + 重新编号（turn 从 1、step 从 1、seq 从 0）──────────────
  const rebuilt = []
  const push = (ev, turnNo, stepNo) => {
    const o = { ...ev, data: { ...(ev.data ?? {}) } }
    if (turnNo !== undefined && typeof o.data.turn === 'number') o.data.turn = turnNo
    if (stepNo !== undefined && typeof o.data.step === 'number') o.data.step = stepNo
    delete o.surfaceOp
    delete o.sourceEventSeqs
    rebuilt.push(o)
  }

  // 会话级状态先落（顺序无关关系校验）
  for (const t of ['permission/preset', 'sandbox/mode', 'approval/policy']) {
    for (const ev of preTurn) if (ev.type === t) push(ev)
  }
  for (const ev of preTurn) {
    if (!['permission/preset', 'sandbox/mode', 'approval/policy'].includes(ev.type)) push(ev)
  }

  let turnNo = 0
  for (const t of outTurns) {
    turnNo += 1
    push(t.start, turnNo)
    let stepNo = 0
    for (const s of t.steps) {
      if (!s.start || !s.end) { dangling.emptySteps += 1; continue }
      stepNo += 1
      push(s.start, turnNo, stepNo)
      // call/result 成对闭合
      const open = new Map()
      const kept = []
      for (const ev of s.events) {
        if (ev.type === 'tool/call') { open.set(ev.data?.callId, ev); kept.push(ev); continue }
        if (ev.type === 'tool/result') {
          const cid = ev.data?.toolCallId ?? ev.data?.message?.toolCallId
          if (!open.has(cid)) { dangling.droppedCalls += 1; continue }
          open.delete(cid); kept.push(ev); continue
        }
        kept.push(ev)
      }
      for (const [, orphanCall] of open) {
        const i = kept.indexOf(orphanCall)
        if (i >= 0) kept.splice(i, 1)
        dangling.droppedCalls += 1
      }
      for (const ev of kept) push(ev, turnNo, stepNo)
      push(s.end, turnNo, stepNo)
    }
    if (t.end) push(t.end, turnNo)
  }

  // ── ⑤ 截断超大 tool/result ───────────────────────────────────────
  let truncated = 0
  let saved = 0
  if (opt.truncate) {
    for (const ev of rebuilt) {
      if (ev.type !== 'tool/result') continue
      const r = truncateToolResult(ev, opt.maxToolBytes)
      if (r.changed) { truncated += 1; saved += r.before - opt.maxToolBytes }
    }
  }

  // ── ⑥ seq 重新从 0 连续编号 ──────────────────────────────────────
  rebuilt.forEach((ev, i) => { ev.seq = i })

  // ── ⑦ 自检：宿主关系校验器（不过则一个字节都不写）──────────────────
  const newHeader = {
    version: 4,
    id: header.id,
    createdAt: header.createdAt,
    ...(header.cwd !== undefined ? { cwd: header.cwd } : {}),
    isSeeded: false,
    delegationDepth: header.delegationDepth ?? 0,
    ...(header.agentPreset !== undefined ? { agentPreset: header.agentPreset } : {}),
  }
  try {
    host.assertRelations({ header: newHeader, events: rebuilt, inheritedEventCount: 0 }, host.knownTypes)
  } catch (e) {
    fail(`新日志未通过宿主关系校验（未写任何字节）：${String(e?.message ?? e)}`)
  }
  console.log('关系校验：PASS（宿主 assertReleasedV4Relationships）')

  // ── ⑧ 报告 ───────────────────────────────────────────────────────
  const newText = [JSON.stringify(newHeader), ...rebuilt.map((e) => JSON.stringify(e))].join('\n') + '\n'
  const newBytes = Buffer.byteLength(newText, 'utf8')
  console.log(`\n新日志：事件 ${rebuilt.length} ｜ turn ${turnNo} ｜ 解压 ${(newBytes / 1048576).toFixed(2)} MiB`)
  console.log(`丢弃：遮蔽旧事件 ${dangling.shadowed} ｜ 辅助事件 ${dangling.aux} ｜ 空 step ${dangling.emptySteps} ｜ 空 turn ${dangling.emptyTurns} ｜ 悬空 call ${dangling.droppedCalls}`)
  console.log(`截断 tool/result ${truncated} 条，约省 ${(saved / 1048576).toFixed(1)} MiB`)
  console.log(`⇒ 解压体积 ${(rawBytes / newBytes).toFixed(1)}× 缩小`)

  // ── ⑨ 写盘 ───────────────────────────────────────────────────────
  const writeTarget = opt.inPlace ? logPath : opt.out ? resolve(opt.out) : null
  if (writeTarget === null) {
    console.log('\n[dry-run] 未写盘。')
    console.log('  写成新文件：加 --out <path>')
    console.log('  原地替换： 加 --in-place --apply（会先备份）')
    return
  }
  if (typeof zlib.zstdCompressSync !== 'function') fail('本机 node 无 zlib.zstdCompressSync，无法写 zstd')

  const compressed = zlib.zstdCompressSync(Buffer.from(newText, 'utf8'))
  if (opt.inPlace) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backup = `${logPath}.bak-${stamp}`
    copyFileSync(logPath, backup)
    console.log(`备份 → ${backup}`)
  }
  const tmp = `${writeTarget}.tmp-${process.pid}`
  writeFileSync(tmp, compressed)
  renameSync(tmp, writeTarget)
  console.log(`已写出 ${writeTarget}（压缩 ${(compressed.length / 1048576).toFixed(1)} MiB）`)

  console.log('\n🔴 验收（D141：写通道与重放校验器是两套规则，单测证明不了）：')
  console.log('  1) 重启宿主（restart-web）—— 丢弃内存里的会话状态')
  console.log('  2) 重新进入该会话：历史应可见')
  console.log('  3) 再发起一轮：能正常回话')
  if (opt.inPlace) console.log('  若第 2 步为空/报 corrupt ⇒ 用旁边的 .bak-* 复原，把报错原文给我')
}

main()
