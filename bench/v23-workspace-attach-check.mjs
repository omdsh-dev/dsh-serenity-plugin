#!/usr/bin/env node
/**
 * V23 探针 —— **`send-now` 冷建会话的「工作区归属」判据**（v1.62.1 缺陷的直接产物）
 *
 * ## 它回答什么问题
 *
 * 「`send-now` 给一条从未激活过的轨迹建的会话，**有没有被登记进它该在的工作区**？」
 *
 * ## 为什么必须单独造一条判据（R↓，这不是"多一条检查"）
 *
 * v1.62.1 修的那个缺陷，**单测是绿的**（我们补了 2 例），但单测用的是**替身 `ctx`**：
 *   替身的 `workspaceRegistry.list()` / `attachSession()` 都是我们自己写的假货。
 * ⇒ 它们能证明「我们**调用**了 attachSession」，**证明不了**：
 *     ① 真实宿主的 `create()` 与我们设想的分支一致；
 *     ② 真实 `attachSession()` 在**符号链接 / realpath 归一**下真的接受我们给的 id；
 *     ③ 会话建完之后，`workspace.json` 里**真的**多出那一条。
 *
 * 🔴 **这正是本轨 2026-10-18 记下的那条判据**：
 *   「**参数传对了 ≠ 效果达成了**」—— 断言入参是弱断言，必须断言**副作用**。
 *   而"副作用"的**最硬判据**是**宿主自己的持久化存储**（`workspace.json`），不是我们返回的字符串。
 *
 * ## 判什么（三条，缺一不可）
 *
 *   V23    **`workspace.json` 能被读到且结构合法**（读数器自证：解析不出就别谈后两条）
 *   V23b   **每个"cwd 落在某工作区"的会话，都在该工作区的 `sessionIds` 里**
 *          —— 这是缺陷的**一般形态**（不止 send-now；任何建完不挂的路径都会被抓到）
 *   V23c   🔴 **`send-now` 冷建的那种会话（绑定 note = `auto-created by send-now`）必须被挂上**
 *          —— 这是缺陷的**具体形态**（靶心；前两条绿而这条红，就是本条要抓的）
 *
 * ## 为什么 V23b 要"逐会话"判而不是"看总数"
 *
 * `sessionIds` 是数组，**"数量对不对"证明不了"该在的在"**（可能是别的会话凑数）。
 * ⇒ 判据必须**逐条点名**：对每个 `cwd` 解析到某工作区 `path` 的会话，断言它在那个数组里。
 *
 * ## 环境
 *
 *   DSH_HOME（缺省 `/root/.dsh`）⇒ 读 `$DSH_HOME/storages/workspace.json`
 *   SESSDIR（缺省 `$DSH_HOME/sessions`）⇒ 读会话 header 的 `cwd`
 *   BINDINGS：各 CCC 的 `.bindings.json`（用于 V23c 认 `auto-created by send-now`）
 *
 * ⚠️ **与 V22 的分工**：V22 判「日志能否被重放」（会话**能不能读**）；
 *   本判据判「会话**归不归那个工作区**」（UI 里它在不在该 CCC 下）。两者正交。
 */
import { readdirSync, existsSync, readFileSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME || '/root/.dsh'
const SESSDIR = process.env.SESSDIR || join(DSH_HOME, 'sessions')
const WORKSPACE_STORE = join(DSH_HOME, 'storages', 'workspace.json')

let pass = 0
let fail = 0
const rows = []
const check = (id, label, ok, extra = '') => {
  rows.push(`${ok ? 'PASS' : 'FAIL'} ${id} ${label}${extra ? ' ' + extra : ''}`)
  if (ok) pass += 1
  else fail += 1
}

/** realpath 归一（失败回落到原串）——与产品代码同判据 */
function canonical(p) {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/**
 * 读宿主的工作区存储。
 *
 * 🔴 读数器必须**自证**：`unit.name` 必须是 `workspace`（防读到别的域文件），
 *   `tables.workspaces` 必须存在。解析失败要说清是**读数器**失败，不要伪装成被测对象坏了。
 */
function loadWorkspaceStore() {
  if (!existsSync(WORKSPACE_STORE)) {
    return { error: `读数器找不到工作区存储：${WORKSPACE_STORE}` }
  }
  let doc
  try {
    doc = JSON.parse(readFileSync(WORKSPACE_STORE, 'utf-8'))
  } catch (error) {
    return { error: `工作区存储不是合法 JSON：${String(error?.message ?? error)}` }
  }
  if (doc?.unit?.name !== 'workspace') {
    return { error: `工作区存储的 unit.name = ${JSON.stringify(doc?.unit?.name)}（应为 "workspace"）` }
  }
  const table = doc?.tables?.workspaces
  if (!table || typeof table !== 'object') {
    return { error: '工作区存储里没有 tables.workspaces' }
  }
  const workspaces = Object.entries(table).map(([id, rec]) => ({
    id,
    path: typeof rec?.path === 'string' ? rec.path : '',
    sessionIds: Array.isArray(rec?.sessionIds) ? rec.sessionIds : [],
  }))
  return { workspaces }
}

/** 所有候选会话 header（id + cwd）。只读 header 首行，不解压整份。 */
function listSessionHeaders() {
  const out = []
  const walk = (dir, depth) => {
    if (depth > 3) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        walk(p, depth + 1)
        continue
      }
      if (!/^session\.v\d+\.jsonl\.zstd$/.test(e.name)) continue
      const header = readHeader(p)
      if (header) out.push(header)
    }
  }
  walk(SESSDIR, 0)
  return out
}

/** 解压首行取 header（失败返回 null —— 读数器自证：解不开就不是"会话坏了"） */
function readHeader(file) {
  let raw
  try {
    // 只取首行：zstd 全解压后截断到第一个换行
    raw = execFileSync('zstd', ['-dc', file], { encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 })
  } catch {
    return null
  }
  const nl = raw.indexOf('\n')
  const first = nl === -1 ? raw : raw.slice(0, nl)
  try {
    const header = JSON.parse(first)
    if (header?.type !== 'session' || typeof header.id !== 'string') return null
    return { id: header.id, cwd: typeof header.cwd === 'string' ? header.cwd : undefined }
  } catch {
    return null
  }
}

/**
 * 找出 `note === 'auto-created by send-now'` 的 sessionId。
 *
 * 🔴 **扫描域 = 工作区路径推导，不 walk 整个文件系统**（判据纪律：扫描域要写清并自证）：
 *   每个工作区的 `path` 就是一个 CCC 根 ⇒ 它的绑定表固定在
 *   `<path>/AGENT_SESSIONS/.bindings.json`。**"已知工作区"就是本判据关心的全集**
 *   （一条会话若连工作区都没有，V23b 已经把它算作"无法判定"，不该由这里兜）。
 *   ⛔ 原版 `walk('/')`：慢、且会把**无关 CCC** 的绑定也算进来 —— 扫描域溢出。
 *
 * 为什么这样认（而不是按 id 前缀）：那个 note 是产品代码**唯一**写入点
 * （`wake-scheduler.ts` 的 `createAndBindTarget`），它就是"这条是 send-now 冷建的"的**凭据**。
 */
function sendNowCreatedSessionIds(workspaces) {
  const ids = new Set()
  for (const ws of workspaces) {
    if (ws.path === '') continue
    const p = join(ws.path, 'AGENT_SESSIONS', '.bindings.json')
    if (!existsSync(p)) continue
    try {
      const doc = JSON.parse(readFileSync(p, 'utf-8'))
      for (const [sid, rec] of Object.entries(doc?.sessions ?? {})) {
        if (rec?.note === 'auto-created by send-now') ids.add(sid)
      }
    } catch {
      /* 单份坏文件不影响其余 */
    }
  }
  return ids
}

function main() {
  const store = loadWorkspaceStore()
  if (store.error !== undefined) {
    // 🔴 读数器自身的失败必须显式报出
    check('V23', '工作区存储可读且结构合法', false, `读数器不可用：${store.error}`)
    return finish()
  }
  check('V23', '工作区存储可读且结构合法', true, `${store.workspaces.length} 个工作区`)

  const byPath = new Map()
  for (const ws of store.workspaces) {
    if (ws.path !== '') byPath.set(canonical(ws.path), ws)
  }

  const sessions = listSessionHeaders()
  // 只判"cwd 落在某个已知工作区"的会话 —— 其余（工作区不存在）不在本判据范围内
  const relevant = sessions
    .filter((s) => typeof s.cwd === 'string' && byPath.has(canonical(s.cwd)))
    .map((s) => ({ ...s, ws: byPath.get(canonical(s.cwd)) }))

  if (relevant.length === 0) {
    check('V23b', 'cwd 落在工作区的会话都已登记', false,
      `没有可判定的会话（读到 ${sessions.length} 条 header，工作区 ${byPath.size} 个）—— 先 bench-docker turn 造一条`)
  } else {
    const orphans = relevant.filter((s) => !s.ws.sessionIds.includes(s.id))
    check('V23b', 'cwd 落在工作区的会话都已登记', orphans.length === 0,
      orphans.length === 0
        ? `${relevant.length} 条全部在册`
        : `漏挂 ${orphans.length}/${relevant.length}：${orphans.map((o) => `${o.id}→${o.ws.path}`).join(' , ')}`)
  }

  // V23c：靶心 —— send-now 冷建的那些必须挂上
  const sendNowIds = sendNowCreatedSessionIds(store.workspaces)
  if (sendNowIds.size === 0) {
    // 没造过就判不了；报 FAIL 并说清"缺前提"，不要伪装成通过
    check('V23c', 'send-now 冷建会话已挂工作区', false,
      '无 send-now 冷建会话（缺前提）—— 先在容器里对一条未激活轨迹执行 send-now')
  } else {
    const bad = []
    for (const s of relevant) {
      if (sendNowIds.has(s.id) && !s.ws.sessionIds.includes(s.id)) bad.push(`${s.id}→${s.ws.path}`)
    }
    // 也可能存在"发送后没出现在 relevant 里"（cwd 不在任何工作区）——那也是问题
    const accounted = new Set(relevant.map((s) => s.id))
    const missingCwd = [...sendNowIds].filter((id) => !accounted.has(id))
    check('V23c', 'send-now 冷建会话已挂工作区', bad.length === 0 && missingCwd.length === 0,
      bad.length === 0 && missingCwd.length === 0
        ? `${sendNowIds.size} 条全部在册`
        : `未挂 ${bad.length} 条${bad.length ? '：' + bad.join(' , ') : ''}` +
          (missingCwd.length ? `；另有 ${missingCwd.length} 条 cwd 不在任何工作区：${missingCwd.join(' , ')}` : ''))
  }

  return finish()
}

function finish() {
  for (const r of rows) console.log(r)
  console.log(`\nV23 汇总: ${pass} PASS / ${fail} FAIL`)
  // 与 verify.sh 同公约：0 = 全绿
  process.exit(fail === 0 ? 0 : 1)
}

main()
