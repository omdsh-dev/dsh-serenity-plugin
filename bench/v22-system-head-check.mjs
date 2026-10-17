#!/usr/bin/env node
/**
 * V22 探针 —— **会话日志的「可重放性」判据**（v1.61.0 事故的直接产物；v1.62 重写）
 *
 * ## 它回答什么问题
 *
 * 「这条会话的日志，**宿主重启后还能不能读回来**？」
 *
 * ## 为什么必须单独造一条判据（R↓，这不是"多一条检查"）
 *
 * v1.61.0 的事故里，**全部既有判据都是绿的**：
 *   · V5 查的是「ACC 横幅在不在会话日志里」—— 在；
 *   · V9 查的是「轮次是否收束」—— 收束了；
 *   · 2915 条单测 —— 全绿。
 * 而真实故障是：**首轮一切正常，用户重新进入会话时它被判 corrupt、界面空白**。
 *
 * 🔴🔴 **V22 初版自己就错了一次，这是本文件最该记住的一条**：
 *   初版判的是「surface 上 system 节点数与位置」，并且**自己复刻**了宿主的 fold 语义。
 *   实测下来：**故障态下那个 shape 其实是好的**（真正的 system 恰好在首位、恰为 1 个），
 *   于是初版**对真故障视而不见**，还会对"我复刻错的那条假想故障"报绿。
 *   ⇒ **判据两次教训**：
 *     ① **有宿主自带实现时，直接调用它，不要复刻**（`foldSurface()` / `assertReleasedV4Relationships()`）；
 *     ② **判据必须打在真故障的那一维上** —— 本例是「能否重放」，不是「surface 长什么样」。
 *
 * ## 判什么（三条，缺一不可）
 *
 *   V22   **日志能被宿主自己的 `foldSurface()` 完整折叠**（不抛）—— 这是"能重放"的核心
 *   V22b  **日志能过宿主自己的 `assertReleasedV4Relationships()`**（tear-down/关系校验）
 *   V22c  **surface 首节点是 system**（`protectedHead` 的显式断言；重放抛错时这里也会红）
 *
 * ## 已知的两类真实故障形态（都在容器里实测复现过）
 *
 * ① `system/message does not match an open turn and step`
 *    —— 代写了 `system/message`/`assistant/message`，而它们要求落在**已打开**的 turn+step 内。
 * ② `system/message requires a protected first surface head`
 *    —— 锚定 `user/message` 写在宿主提交 system **之前**，把 surface 首节点让给了 user。
 *
 * ⚠️ 与 V5 的分工：V5 判「内容进了会话」，本判据判「**这份日志还能被宿主读回来**」。
 *   两者互补：内容对但日志非法，用户重进会话时看到空白 —— 正是本次事故。
 */
import { readdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const SESSDIR = process.env.SESSDIR || '/root/.dsh/sessions'
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || '40')

let pass = 0
let fail = 0
const rows = []
const check = (id, label, ok, extra = '') => {
  rows.push(`${ok ? 'PASS' : 'FAIL'} ${id} ${label} ${extra}`)
  if (ok) pass += 1
  else fail += 1
}

/**
 * 解析宿主的 `dsh-session` 与 `dsh-session-format-v3-to-v4`。
 *
 * 🔴 依赖解析必须**自证**（判据纪律：读数器先自证它不瞎）：
 *   宿主的安装布局在不同容器/机器上不同（本机与容器不同、新旧版本不同）。
 *   ⇒ 用 `createRequire` 锚在**宿主自己的 package.json** 上，而不是硬写某个绝对路径。
 *   解析不到 ⇒ 报 FAIL 并**说清是解析失败**，不要让它以"日志坏了"的面目出现。
 */
function loadHostModules() {
  const candidates = [
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json',
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh/package.json',
  ]
  const errors = []
  for (const pkg of candidates) {
    if (!existsSync(pkg)) continue
    try {
      const req = createRequire(pkg)
      const session = req('@deepseek-ai/dsh-session')
      const fmt = req('@deepseek-ai/dsh-session-format-v3-to-v4')
      if (typeof session?.foldSurface === 'function' && typeof fmt?.assertReleasedV4Relationships === 'function') {
        return { foldSurface: session.foldSurface, assertRelations: fmt.assertReleasedV4Relationships, via: pkg }
      }
      errors.push(`${pkg}: 模块在、但导出面不符（foldSurface/assertReleasedV4Relationships 缺失）`)
    } catch (error) {
      errors.push(`${pkg}: ${String(error?.message ?? error)}`)
    }
  }
  return { error: errors.length > 0 ? errors.join(' | ') : `找不到宿主包（试过 ${candidates.join(', ')}）` }
}

/** 递归找所有会话日志 */
function findLogs(dir, acc = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) findLogs(p, acc)
    else if (/^session\.v\d+\.jsonl\.zstd$/.test(e.name)) acc.push(p)
  }
  return acc
}

/** zstd 解压（镜像里有 CLI；无它则判据无法成立，必须报 FAIL 而不是 PASS） */
function decompress(file) {
  try {
    return execFileSync('zstd', ['-dc', file], { encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 })
  } catch {
    return ''
  }
}

function main() {
  if (!existsSync(SESSDIR)) {
    check('V22', '日志可重放', false, `读数器找不到会话目录 ${SESSDIR}`)
    return finish()
  }
  const host = loadHostModules()
  if (host.error !== undefined) {
    // 🔴 读数器自身的失败必须**显式**报出，不能伪装成被测对象坏了
    check('V22', '日志可重放', false, `读数器不可用（宿主模块解析失败）：${host.error}`)
    return finish()
  }

  const logs = findLogs(SESSDIR).slice(-MAX_SESSIONS)
  if (logs.length === 0) {
    check('V22', '日志可重放', false, '无会话日志 ⇒ 先 bench-docker turn 造一条真实轮')
    return finish()
  }

  let examined = 0
  let foldOk = 0
  let relationsOk = 0
  let headOk = 0
  const offenders = []

  for (const file of logs) {
    const raw = decompress(file)
    if (!raw) continue
    const events = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const ev = JSON.parse(line)
        if (typeof ev.seq === 'number') events.push(ev)
      } catch {
        /* 坏行跳过（不是本判据的对象） */
      }
    }
    if (events.length === 0) continue
    // 只判"已经有模型可见消息"的会话（空会话无从谈重放）
    const hasMessages = events.some((e) => /^(system|user|assistant)\/message$/.test(e.type))
    if (!hasMessages) continue
    examined += 1

    const rel = file.split('/').slice(-2).join('/')
    let folded = null
    let foldError = ''
    try {
      folded = host.foldSurface(events, [])
      foldOk += 1
    } catch (error) {
      foldError = String(error?.message ?? error)
    }

    if (folded !== null) {
      // 关系校验：宿主读档时会跑这条；用**同一份 artifact 形状**
      try {
        host.assertRelations(
          { header: { id: 'probe', formatVersion: 4 }, inheritedEventCount: 0, events },
          new Set(events.map((e) => e.type)),
        )
        relationsOk += 1
      } catch (error) {
        foldError = foldError === '' ? String(error?.message ?? error) : `${foldError} | ${String(error?.message ?? error)}`
      }

      // surface 首节点必须是 system（`protectedHead` 语义的显式断言）
      const first = events.find((e) => e.seq === folded.nodes[0])
      const headIsSystem = first?.type === 'system/message'
      if (headIsSystem) headOk += 1
      if (!headIsSystem) {
        offenders.push({ file: rel, reason: `surface 首节点 = ${first?.type ?? '(none)'}（应为 system/message）` })
      }
    } else {
      offenders.push({ file: rel, reason: foldError })
    }
    if (folded !== null && foldError !== '') {
      offenders.push({ file: rel, reason: foldError })
    }
  }

  if (examined === 0) {
    check('V22', '日志可重放', false, '所有会话都还没有模型可见消息 ⇒ 先 turn')
    return finish()
  }

  check('V22', '日志能被宿主 foldSurface 完整折叠', foldOk === examined,
    `${foldOk}/${examined}${foldOk !== examined ? '（折叠抛错 = 重进会话即 corrupt，正是 v1.61.0 事故）' : ''}`)
  check('V22b', '日志能过宿主 assertReleasedV4Relationships', relationsOk === examined,
    `${relationsOk}/${examined}`)
  check('V22c', 'surface 首节点是 system（protectedHead）', headOk === examined,
    `${headOk}/${examined}`)

  if (offenders.length > 0) {
    console.log('── V22 反例样本（最多 5 条）──')
    for (const o of offenders.slice(0, 5)) console.log(`   ${o.file}: ${o.reason}`)
  }

  finish()
}

function finish() {
  for (const r of rows) console.log(r)
  console.log(`V22_PASS=${pass} V22_FAIL=${fail}`)
  process.exit(fail === 0 ? 0 : 1)
}

main()
