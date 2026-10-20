/**
 * trajectory/bind-file.ts — **当前载体绑定 = 认知轨迹目录里的自我交代**（判决 D172，owner 2026-10-20）
 *
 * ## owner 的原话（这是本模块的全部设计依据）
 *
 * > 「**认知轨迹自己交代永远是最好的交代**」
 * > 「绑定表是没有意义的，绑定关系必须**运行时按照规则探测**，绑定表本质就搞成**第二真相源**了」
 * > 「依赖文件系统，定义一个 `.dsh_session_bind` 后缀（加入 gitignore）；每个认知轨迹目录内放一个
 * >  `current.dsh_session_bind`，**以这个为绑定真相源**」
 *
 * ## 为什么这是对的（而不是又一张表）
 *
 * 旧的 `.bindings.json` ＋ 宿主存储域是**旁路索引**：它描述的对象（轨迹目录）与它自己**分离**，
 * ⇒ 一旦两者不一致就必须写代码去对账，而**对账失败没有任何机械信号**（本轨反复踩的形状）。
 *
 * 新形态把这条信息**放回它描述的对象的内部**：
 *
 * ```text
 * <轨迹目录>/
 *   SESSION.md                 ← 身体
 *   PROMPT.md                  ← 章程
 *   trajectory.json            ← 声明（约束面 / uid / cro.host）
 *   current.dsh_session_bind   ← 🆕 **此刻谁在承载它**（单个文件 ⇒ 结构上不可能有两个）
 * ```
 *
 * ## 🔴 两条不变量由**形态本身**保证，不靠记账
 *
 * | 不变量 | 保证方式 |
 * |---|---|
 * | 一条轨迹**至多一个**当前载体 | 它是**一个文件**，写入即整体覆盖（原子 rename） |
 * | 一个载体**至多一条**轨迹 | 写入前扫全部轨迹的 bind 文件，**该会话 id 已出现在别处 ⇒ 拒绝** |
 *
 * ⚠️ 旧形态靠 `supersededAt` 标记"退掉"，而**标记是可以忘的**；覆盖不会忘。
 *
 * ## 零依赖纪律（同 `policy/files.ts`）
 * 只用 `node:fs` / `node:path` ⇒ 谁 import 它都不会成环。每个读函数**永不抛**。
 *
 * ## 🔴 第三条不变量（owner 2026-10-20 追加）：「文件里写的 sessionId 可能已经不存在了
 * ——这个情况下就**视同没绑定**，就正确了」
 *
 * 这一条让整个设计**自洽**：**绑定的有效性由「那个会话真实存在」决定，不由「文件存在」决定。**
 *
 * ```text
 * 文件在 ＋ 会话在  ⇒ 有效绑定
 * 文件在 ＋ 会话没了 ⇒ **视同没绑定**（过期文件自动失效，不需要任何人来清理）
 * 文件不在         ⇒ 没绑定
 * ```
 *
 * ⇒ 因此**不需要**任何"清理陈旧绑定"的机制，也不需要 `reconcile` 去对账 —— 对账这件事本身消失。
 * 代价是**每次取用都要验一次会话是否还在**（`ctx.agents.get` 或 `sessionController.resolveAgent`
 * 或宿主会话清单），**这是运行时探测**，正是 owner 要的那种判据。
 *
 * ⚠️ 本模块**只负责读写文件**；"会话是否还在"必须由**调用方**（持有宿主上下文）来验 ——
 * 把那条判断放在这里会迫使本模块拿到 `ctx`，从而破坏零依赖与可单测性。
 * 调用方正确用法见 {@link isBindUsable}。
 *
 * ## 🔴 第四条：**完整生命周期**（owner 2026-10-20 追加：「调用 use 会覆盖掉这个文件，
 * 完整生命周期要实现，请注意」）
 *
 * 文件是**一个槽位**，不是追加日志。⇒ 每次改变归属都是一次**状态迁移**，
 * 四个动作必须**成对**出现，否则槽位会留下无法解释的残留：
 *
 * | 迁移 | 何时 | 必须做什么 |
 * |---|---|---|
 * | **acquire** | 会话首次认领轨迹 | 写槽位（该会话此前不持有任何轨迹） |
 * | **switch** | 会话从轨迹 A **改到** B | 🔴 **先清 A 的槽位，再写 B** —— 只写 B 会让 A 永远指着一个不再属于它的会话 |
 * | **release** | 会话主动解绑 / 会话将死 | **清掉槽位**（不是写空串，是删文件） |
 * | **takeover** | 载体换代（rebuild / 崩溃后重建） | 覆盖写：旧会话退位，新会话入位（**必须显式声明**） |
 *
 * 🔴 **最容易漏的是 switch 的"先清 A"**：旧实现（`.bindings.json`）天然支持"一个会话多条记录"，
 * 所以从来没暴露过这个问题；新形态是**单槽位**，不清 A 就会得到
 * 「A 与 B 都说这个会话属于自己」—— 正是 owner 要禁的"一个会话绑两条轨迹"，
 * 只不过这次是**残留**而不是**主动绑定**，更难发现。
 *
 * ⇒ 因此**不要**直接调 {@link writeBindDeclaration} 来改归属；一律走
 * {@link transitionBinding}（它把四条迁移的配对关系写死在一处）。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 绑定文件的固定名（**owner 指定**：`current.dsh_session_bind`） */
export const BIND_FILENAME = 'current.dsh_session_bind'

/**
 * 绑定文件的**族**（认族不认名，D167 通用纪律）。
 *
 * 目前只有一代。留成数组是**为了下一次改名不重演历史**：本仓已在
 * `skiff.json → trajectory-constraint.json → trajectory.json` 上栽过两次
 * （上游改名、下游写死旧名 ⇒ 症状与真因在读数上完全不像）。
 */
export const BIND_FILENAME_FAMILY = [BIND_FILENAME] as const

/** 轨迹归档区的目录名（**自持一份，不从 `core.ts` import**）。 */
export const ARCHIVED_DIR_NAME = '_archived'

/**
 * 绑定文件的内容（**自我交代**：不只是"谁"，还有"何时、为何、谁建的"）。
 *
 * 字段与旧的 `SessionBoundRecord` 同名 —— 迁移不需要映射表（降低出错面）。
 */
export interface BindDeclaration {
  /** 承载它的 dsh 会话 id（**硬锚**） */
  sessionId: string
  /** 绑定发生的时刻（epoch ms） */
  at: number
  /** 绑定动作：activate / switch / create / rebuild / reconcile / release */
  action: string
  /** 人类可读的一句话（**不是判据**，判据见 `createdAsUser`） */
  note?: string
  /** 这条载体是 ACC 以"用户开场白"形态建的（D170）。**布尔事实**，不从 note 文案推 */
  createdAsUser?: boolean
}

/** 校验一条声明（容忍手改 / 部分字段缺失） */
function asDeclaration(value: unknown): BindDeclaration | null {
  const d = value as Partial<BindDeclaration> | null | undefined
  if (!d || typeof d !== 'object') return null
  if (typeof d.sessionId !== 'string' || d.sessionId === '') return null
  return {
    sessionId: d.sessionId,
    at: typeof d.at === 'number' ? d.at : 0,
    action: typeof d.action === 'string' && d.action !== '' ? d.action : 'activate',
    ...(typeof d.note === 'string' && d.note !== '' ? { note: d.note } : {}),
    ...(d.createdAsUser === true ? { createdAsUser: true } : {}),
  }
}

/** 某轨迹目录里绑定文件的绝对路径 */
export function bindFilePath(trajectoryDir: string): string {
  return join(trajectoryDir, BIND_FILENAME)
}

/**
 * 读一条轨迹的**当前载体声明**。
 *
 * @param trajectoryDir 轨迹目录绝对路径
 * @returns 声明；文件不存在 / 坏 JSON / 形状不符 ⇒ `null`（**永不抛**）
 */
export function readBindDeclaration(trajectoryDir: string): BindDeclaration | null {
  for (const name of BIND_FILENAME_FAMILY) {
    const p = join(trajectoryDir, name)
    try {
      if (!existsSync(p)) continue
      return asDeclaration(JSON.parse(readFileSync(p, 'utf-8')))
    } catch {
      /* 坏文件按"没交代"处理，由调用方决定降级 */
    }
  }
  return null
}

/**
 * 写一条轨迹的**当前载体声明**（原子：同目录 tmp + rename）。
 *
 * 🔴 **不做唯一性检查** —— 那是 `claimBinding` 的职责。本函数只负责"这份文件长成什么样"。
 * 分开的理由：唯一性检查需要**扫全部轨迹**，而写只需要一个目录 ⇒ 让不扫盘的地方能便宜地写。
 */
export function writeBindDeclaration(trajectoryDir: string, decl: BindDeclaration): boolean {
  const path = bindFilePath(trajectoryDir)
  const tmp = `${path}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(tmp, `${JSON.stringify(decl, null, 2)}\n`, 'utf-8')
    renameSync(tmp, path)
    return true
  } catch {
    return false
  }
}

/**
 * 清掉一条轨迹的当前载体声明（解绑）。
 * @returns 文件原本存在且已删除 ⇒ true
 */
export function clearBindDeclaration(trajectoryDir: string): boolean {
  try {
    const path = bindFilePath(trajectoryDir)
    if (!existsSync(path)) return false
    // 用 rename 到一个不可能的临时名再删除，避免 Windows 式占用（本仓只跑 Linux，但保持对称）
    renameSync(path, `${path}.del`)
    return true
  } catch {
    return false
  }
}

/**
 * 列出某 CCC 下**全部轨迹的当前载体声明**（`dirName → 声明`）。
 *
 * 这是**反向查询**（会话 → 轨迹 / 轨迹 → 会话）的唯一入口，取代旧的旁路表扫描。
 * 跳过 `_` / `.` 前缀目录（归档区与运行时区不是轨迹，判据同 `activeTrajectoryDirNames`）。
 *
 * 🔴 **2026-10-20（owner 裁决「死包含归档判断」配套）：`_archived/` 必须**再扫一层**。**
 *
 * 修之前：归档目录整体被跳过 ⇒ **已归档轨迹的绑定声明对唯一性检查完全隐形**。
 * 后果：承载过它的 dsh 会话看起来"无归属"，可以被 `use` 到另一条轨迹上 ——
 * 这正是 IMMUTABLE 1「一个会话终身只属于一条轨迹」要禁的事，而且是**静默**发生的。
 *
 * 为什么只扫归档区、不扫别的 `_` 目录：归档区里的**确实是轨迹**（只是不再活跃），
 * 而 `_轨迹约束-logs` / `_weixin-logs` / `_corpus` 是日志与数据区，它们里面不会有
 * `current.dsh_session_bind`（真有一个也只是垃圾，读到会被 `asDeclaration` 挡掉）。
 * ⇒ 只多付一次 `_archived` 的 readdir，不改变"活跃清单"的语义（那是 `readAllSessions` 的事）。
 *
 * @param sessionsRoot `<CCC>/AGENT_SESSIONS`
 * @returns 有交代的轨迹；**永不抛**（目录读不到 ⇒ 空表）
 */
export function listBindDeclarations(sessionsRoot: string): Array<{ dirName: string; decl: BindDeclaration }> {
  const out: Array<{ dirName: string; decl: BindDeclaration }> = []
  const collect = (dir: string, into: (dirName: string, decl: BindDeclaration) => void): void => {
    let names: string[]
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
        .map((e) => e.name)
    } catch {
      return
    }
    for (const dirName of names) {
      const decl = readBindDeclaration(join(dir, dirName))
      if (decl) into(dirName, decl)
    }
  }
  collect(sessionsRoot, (dirName, decl) => out.push({ dirName, decl }))
  // 归档区：轨迹本体没变，只是不在活跃清单里 —— **它的会话仍然属于它**。
  collect(join(sessionsRoot, ARCHIVED_DIR_NAME), (dirName, decl) => {
    // 同 id 存活于活跃区时以活跃区为准（理论上不该并存；并存时不让归档区覆盖活跃区的读法）
    if (!out.some((r) => r.dirName === dirName)) out.push({ dirName, decl })
  })
  return out
}

/**
 * **这条绑定还作数吗**（第三条不变量的机械形态）。
 *
 * 判据（owner 原话：「文件里写的 sessionId 可能已经不存在了，这个情况下就视同没绑定」）：
 *
 * | 文件 | 会话存在？ | 结论 |
 * |---|---|---|
 * | 无 | — | `absent` |
 * | 有 | 是 | **`usable`** |
 * | 有 | 否 | **`stale`** ⇒ **视同没绑定** |
 *
 * 🔴 **为什么"会话存在"必须由调用方给**：判断它要问宿主（`ctx.agents.get` /
 * `sessionController.resolveAgent` / 会话清单），而本模块是零依赖层。
 * ⇒ 这里只收一个 **`alive: (sessionId) => boolean`** 探针，把判断留在外面，本函数仍是纯逻辑、可单测。
 *
 * ⚠️ **`stale` 不删文件**：删除是写操作，而"视同没绑定"已经足够。
 * 留着过期文件反而有用 —— 它记录了"这条轨迹上一次由谁承载"（沿革不丢，同旧 `supersededAt` 的意图）。
 *
 * @param decl {@link readBindDeclaration} 的结果
 * @param alive 探针：该会话 id 此刻是否真实存在（**由调用方用宿主事实实现**）
 * @returns `absent` ／ `usable` ／ `stale`，以及（usable 时的）声明
 */
export function isBindUsable(
  decl: BindDeclaration | null,
  alive: (sessionId: string) => boolean,
): { state: 'absent' } | { state: 'usable'; decl: BindDeclaration } | { state: 'stale'; decl: BindDeclaration } {
  if (decl === null) return { state: 'absent' }
  try {
    return alive(decl.sessionId) ? { state: 'usable', decl } : { state: 'stale', decl }
  } catch {
    // 探针自己炸了 ⇒ 保守判 stale（视同没绑定）：宁可当作没有，也不要拿一条不可验证的绑定去投递
    return { state: 'stale', decl }
  }
}

/**
 * **解绑**（生命周期的第四步）：把某条轨迹的槽位清空。
 *
 * ## 什么时候该调它（判据，不是"看情况"）
 *
 * | 场景 | 该不该 release |
 * |---|---|
 * | 会话主动离开这条轨迹（`use` 换到别的轨迹） | ✅ **必须**（否则旧轨迹永远指着一个不再属于它的会话） |
 * | 会话即将销毁 / 被用户关闭 | ✅ 该（但**不强制**：`isBindUsable` 会把它判成 `stale`，视同没绑定） |
 * | 想"删掉绑定让下一条消息重新建" | ⛔ **不该** —— 那会掩盖归属问题；用 `takeover` 换代 |
 *
 * 🔴 **为什么"会话死了可以不 release"仍然安全**：第四条不变量已经把这件事兜住了
 * （`stale` ⇒ 视同没绑定）。⇒ release 的价值**不是"让绑定失效"**（那有探针兜底），
 * 而是**"让沿革干净"** —— 不留一个指向已无关会话的槽位。
 *
 * @param sessionsRoot `<CCC>/AGENT_SESSIONS`
 * @param dirName 轨迹目录名
 * @param expectSessionId 只在这个槽位当前确实是该会话时才清（防误清别人的）
 * @returns 真的清掉了 ⇒ true（槽位本来空 / 不是那个会话 ⇒ false）
 */
export function releaseBinding(sessionsRoot: string, dirName: string, expectSessionId?: string): boolean {
  const decl = readBindDeclaration(join(sessionsRoot, dirName))
  if (decl === null) return false
  if (expectSessionId !== undefined && decl.sessionId !== expectSessionId) return false
  return clearBindDeclaration(join(sessionsRoot, dirName))
}

/**
 * 找出**已经占用**某个 dsh 会话 id 的那条轨迹（唯一性判据）。
 *
 * @param sessionsRoot `<CCC>/AGENT_SESSIONS`
 * @param sessionId 待检查的会话 id
 * @returns 占用它的轨迹目录名；无人占用 ⇒ `null`
 */
export function findTrajectoryHolding(sessionsRoot: string, sessionId: string): string | null {
  for (const { dirName, decl } of listBindDeclarations(sessionsRoot)) {
    if (decl.sessionId === sessionId) return dirName
  }
  return null
}

/**
 * **认领**：把某条轨迹的当前载体设成 `sessionId`，并**当场执行两条不变量**。
 *
 * 这是全仓**唯一**允许改变绑定关系的写入口：`appendBound` 与迁移脚本都走这里。
 * 集中成一处的理由 = 不变量只能有一个实现，否则迟早出现"某条路径忘了检查"（本仓已多次踩）。
 *
 * ## 判据（任一不成立即**拒绝**，不写）
 *
 * 1. **载体唯一**：`sessionId` 已安家在**另一条**轨迹 ⇒ 拒绝（一个会话不能绑两条轨迹）。
 *    ⚠️ 若它已安家在**本条**轨迹 ⇒ 幂等通过（重复 `use` 同一条轨迹是合法重入）。
 * 2. **轨迹唯一**：本条轨迹已由**另一个** `sessionId` 承载 ⇒ **拒绝**，除非 `takeover`。
 *    `takeover` = 载体换代（`rebuild` / 崩溃后新建），由调用方**显式**声明；
 *    绝不默认允许 —— 静默换代正是"一条轨迹长出两个载体"的成因。
 *
 * 🔴 **2026-10-20（owner 裁决，S196 实测逼出）：第 ② 条只在"旧载体还活着"时成立。**
 *
 * 修之前：`claimBinding` **完全不问存活**，只要文件里有别的 `sessionId` 就拒。
 * 而读侧（`listBoundSessionIds(…, alive)`）却按 IMMUTABLE 3 把过期声明当"没绑定"
 * ⇒ **同一条轨迹，两个函数给出相反的答案**。S196 就是撞上这一格：
 * 它的绑定文件指着 `session-52d680ae`（**已在宿主归档集里** = 死），
 * 而 `use` 被 `TRAJECTORY_OCCUPIED` 拒掉，回执还说"成功"（另有一条 D186 的静默问题）。
 *
 * ⇒ 判据（第三条不变量的**写侧形态**）：**旧载体会死 ⇒ 本条轨迹算空槽，直接写**。
 *    `alive` 不传时**沿用"文件在就算占用"**的旧语义（保守、向后兼容）——
 *    ⚠️ 那是"读不到宿主事实"的降级，**不是**"它一定活着"；
 *    生产调用点必须显式传 {@link hostAliveProbe}。
 *
 * @param sessionsRoot `<CCC>/AGENT_SESSIONS`
 * @param dirName 目标轨迹目录名
 * @param decl 要写入的声明
 * @param opts.takeover 允许顶掉本条轨迹现有的另一个载体
 * @param opts.alive 探针：**旧载体**是否还活着（缺省 ⇒ 一律当活 = 旧语义）
 * @returns `{ ok: true }` 或 `{ ok: false, code, detail }`（**不抛**，由调用方决定如何呈现）
 */
export function claimBinding(
  sessionsRoot: string,
  dirName: string,
  decl: BindDeclaration,
  opts: { takeover?: boolean; alive?: (sessionId: string) => boolean } = {},
): { ok: true; released?: string } | { ok: false; code: 'SESSION_TAKEN' | 'TRAJECTORY_OCCUPIED' | 'WRITE_FAILED'; detail: string } {
  // ① 载体唯一：这个会话 id 是否已在别的轨迹名下？
  const holder = findTrajectoryHolding(sessionsRoot, decl.sessionId)
  if (holder !== null && holder !== dirName) {
    return {
      ok: false,
      code: 'SESSION_TAKEN',
      detail:
        `会话 ${decl.sessionId} 已经承载轨迹「${holder}」，不能同时再承载「${dirName}」。` +
        `一个会话只能属于一条认知轨迹 —— 要给「${dirName}」开一个载体，请新建一条会话。`,
    }
  }
  // ② 轨迹唯一：本条轨迹是否已由**另一个**会话承载？
  const cur = readBindDeclaration(join(sessionsRoot, dirName))
  if (cur !== null && cur.sessionId !== decl.sessionId && opts.takeover !== true) {
    // 🔴 死载体不构成占用（owner 2026-10-20）：见函数头注 §判据。
    //    ⚠️ 探针缺省 = 当活（旧语义）——降级方向是"保守拒绝"，不是"静默顶掉"。
    const occupied = opts.alive === undefined ? true : opts.alive(cur.sessionId)
    if (occupied) {
      return {
        ok: false,
        code: 'TRAJECTORY_OCCUPIED',
        detail:
          `轨迹「${dirName}」当前已由会话 ${cur.sessionId} 承载（${cur.action}，${new Date(cur.at).toISOString()}）。` +
          `如需换代（rebuild / 重建载体），调用方必须显式声明 takeover —— ` +
          `静默换代会让一条轨迹出现两个载体。`,
      }
    }
  }
  // ③ 🔴 **生命周期配对（switch 的一半）**：写 B 之前先清 A。
  //
  // 为什么必须在这里、而不是指望调用方记得：旧形态（`.bindings.json`）一个会话可以有多条记录，
  // 所以"改了没清旧"从不暴露；新形态是**单槽位** ⇒ 不清 A 就会得到"两条轨迹都说这个会话属于自己"，
  // 而那是**残留**造成的，比主动绑定更难发现。
  //
  // ⚠️ 只在 A ≠ 本条轨迹时才清（`holder === dirName` 表示它本来就安家在本条，属幂等重入）。
  let released: string | undefined
  if (holder !== null && holder !== dirName) {
    // 正常情况不会走到这里（上面 ① 已拒），留作 takeover 语义扩张时的安全网
    if (clearBindDeclaration(join(sessionsRoot, holder))) released = holder
  }
  if (!writeBindDeclaration(join(sessionsRoot, dirName), decl)) {
    return { ok: false, code: 'WRITE_FAILED', detail: `写 ${BIND_FILENAME} 失败：${join(sessionsRoot, dirName)}` }
  }
  return released === undefined ? { ok: true } : { ok: true, released }
}
